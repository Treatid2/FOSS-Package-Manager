// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

function fail(code, message, details = {}) {
  throw Object.assign(new Error(message), { code, details });
}

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function json(value) {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

function hash(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function writeAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, json(value), "utf8");
    await rm(filePath, { force: true });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

function ownerOrder(owners) {
  const bySchema = new Map(owners.map((owner) => [owner.semanticSchema, owner]));
  const ordered = [];
  const state = new Map();
  function visit(owner) {
    if (state.get(owner.semanticSchema) === "done") return;
    if (state.get(owner.semanticSchema) === "visiting") {
      fail("FPM_STATE_OWNER_CYCLE", "Persistent-state owner dependencies contain a cycle.", {
        schema: owner.semanticSchema,
      });
    }
    state.set(owner.semanticSchema, "visiting");
    for (const dependency of [...owner.dependsOn].sort()) {
      const selected = bySchema.get(dependency);
      if (selected) visit(selected);
    }
    state.set(owner.semanticSchema, "done");
    ordered.push(owner);
  }
  for (const owner of [...owners].sort((left, right) => left.semanticSchema.localeCompare(right.semanticSchema))) {
    visit(owner);
  }
  return ordered;
}

function validateOwner(owner) {
  if (owner?.protocol !== "fpm.state-owner/1" || typeof owner.semanticSchema !== "string"
    || !Number.isInteger(owner.schemaVersion) || typeof owner.required !== "boolean"
    || typeof owner.governingCapability !== "string" || typeof owner.provider !== "string"
    || !Array.isArray(owner.dependsOn) || typeof owner.capture !== "function"
    || typeof owner.restore !== "function") {
    fail("FPM_STATE_OWNER_INVALID", "A runtime state owner returned an invalid persistence contract.", {
      owner: owner?.semanticSchema ?? null,
    });
  }
  return owner;
}

function fragmentPath(index) {
  return `state/${String(index).padStart(3, "0")}/fragment.json`;
}

export function createService() {
  let store;
  let clock;
  let owners = [];
  let migration = null;
  let session;
  let options;

  async function save(saveId) {
    if (typeof saveId !== "string" || saveId.length === 0) {
      fail("FPM_SAVE_ID_INVALID", "A save requires a non-empty identity.", { saveId });
    }
    const checkpoint = clock.now();
    const files = {};
    const fragments = [];
    for (const [index, owner] of ownerOrder(owners).entries()) {
      const fragment = owner.capture(checkpoint);
      if (fragment?.protocol !== "fpm.state-fragment/1" || fragment.semanticSchema !== owner.semanticSchema
        || fragment.schemaVersion !== owner.schemaVersion
        || JSON.stringify(fragment.checkpoint) !== JSON.stringify(checkpoint)) {
        fail("FPM_STATE_CAPTURE_INCOHERENT", "A state owner returned an incompatible checkpoint fragment.", {
          owner: owner.semanticSchema,
          expectedCheckpoint: checkpoint,
          actualCheckpoint: fragment?.checkpoint ?? null,
        });
      }
      const relativePath = fragmentPath(index);
      const content = json(fragment);
      files[relativePath] = content;
      const providerRecord = options.runtimePlan.services.find((service) => service.id === owner.provider);
      fragments.push({
        semanticSchema: owner.semanticSchema,
        schemaVersion: owner.schemaVersion,
        required: owner.required,
        governingCapability: owner.governingCapability,
        provider: owner.provider,
        providerPackage: providerRecord?.package ?? null,
        providerImplementationHash: providerRecord?.packageContentHash ?? null,
        stateRevision: fragment.stateRevision,
        dependsOn: [...owner.dependsOn].sort(),
        references: fragment.references ?? {},
        path: relativePath,
        root: hash(content),
      });
    }
    const manifest = {
      schema: "fpm.world-save/1",
      save: { id: saveId, version: 1 },
      checkpoint,
      distributionIdentity: options.distributionIdentity,
      runtimePlanIdentity: options.runtimePlanIdentity,
      fragments,
      migrationHistory: [],
    };
    files["save-manifest.json"] = json(manifest);
    const reference = await store.publishTreeReference("world-saves", saveId, files, {
      schema: manifest.schema,
      checkpoint,
      distributionIdentity: options.distributionIdentity,
      runtimePlanIdentity: options.runtimePlanIdentity,
    }, { interruptBeforeReference: options.interruptSaveBeforePublication });
    return freeze({ schema: "fpm.world-save-commit/1", saveId, root: reference.root, manifest });
  }

  async function restore(saveId) {
    const loaded = await store.readTreeReference("world-saves", saveId);
    let manifest;
    try {
      manifest = JSON.parse(loaded.files["save-manifest.json"]);
    } catch (error) {
      fail("FPM_SAVE_MANIFEST_INVALID", "The save manifest is missing or malformed.", { saveId, cause: error.message });
    }
    if (manifest.schema !== "fpm.world-save/1" || manifest.save?.id !== saveId
      || !Array.isArray(manifest.fragments)) {
      fail("FPM_SAVE_MANIFEST_INVALID", "The selected save manifest has an unsupported shape.", { saveId });
    }
    const bySchema = new Map(owners.map((owner) => [owner.semanticSchema, owner]));
    const restoreFragments = new Map();
    const retainedOpaque = [];
    const migrations = [];
    for (const entry of manifest.fragments) {
      const owner = bySchema.get(entry.semanticSchema);
      if (!owner) {
        if (entry.required) {
          fail("FPM_STATE_OWNER_REQUIRED_MISSING", "A required saved state owner is unavailable.", {
            requiredStateSchema: entry.semanticSchema,
            schemaVersion: entry.schemaVersion,
            owningCapability: entry.governingCapability,
            lastKnownProvider: entry.provider,
            availableMigrationRoutes: migration ? [{ from: migration.from, to: migration.to,
              provider: migration.provider }] : [],
            reason: "no-current-provider-can-restore",
          });
        }
        retainedOpaque.push({ semanticSchema: entry.semanticSchema, schemaVersion: entry.schemaVersion,
          root: entry.root, provider: entry.provider, status: "retained-uninterpreted" });
        continue;
      }
      const content = loaded.files[entry.path];
      if (typeof content !== "string" || hash(content) !== entry.root) {
        fail("FPM_STATE_FRAGMENT_INVALID", "A saved state fragment does not match its declared root.", {
          semanticSchema: entry.semanticSchema,
          root: entry.root,
        });
      }
      let fragment = JSON.parse(content);
      if (entry.schemaVersion !== owner.schemaVersion) {
        if (!migration || migration.protocol !== "fpm.state-migration/1"
          || migration.from.semanticSchema !== entry.semanticSchema
          || migration.from.schemaVersion !== entry.schemaVersion
          || migration.to.semanticSchema !== owner.semanticSchema
          || migration.to.schemaVersion !== owner.schemaVersion) {
          fail("FPM_STATE_MIGRATION_MISSING", "No selected one-step migration can adapt a required state fragment.", {
            semanticSchema: entry.semanticSchema,
            savedVersion: entry.schemaVersion,
            requiredVersion: owner.schemaVersion,
            selectedMigration: migration?.provider ?? null,
          });
        }
        const migrated = migration.migrate(freeze(structuredClone(fragment)));
        if (migrated?.protocol !== "fpm.state-fragment/1"
          || migrated.semanticSchema !== owner.semanticSchema
          || migrated.schemaVersion !== owner.schemaVersion) {
          fail("FPM_STATE_MIGRATION_INVALID", "A selected migration returned an incompatible fragment.", {
            migration: migration.provider,
            expectedSchema: owner.semanticSchema,
            expectedVersion: owner.schemaVersion,
            actualSchema: migrated?.semanticSchema ?? null,
            actualVersion: migrated?.schemaVersion ?? null,
          });
        }
        const migratedContent = json(migrated);
        const migrationIdentity = `${saveId}:${entry.semanticSchema}:${entry.schemaVersion}-to-${owner.schemaVersion}`;
        const migrationReference = await store.publishTreeReference("state-migrations", migrationIdentity, {
          "fragment.json": migratedContent,
        }, {
          schema: "fpm.state-migration-record/1",
          package: migration.package,
          implementation: migration.provider,
          implementationHash: options.runtimePlan.services.find((service) => service.id === migration.provider)
            ?.packageContentHash ?? null,
          input: entry.root,
          output: hash(migratedContent),
          policy: options.runtimePlan.selections.find((selection) => selection.provider === migration.provider)
            ?.reason ?? "sole-compatible-provider",
        });
        fragment = migrated;
        migrations.push({
          semanticSchema: entry.semanticSchema,
          fromVersion: entry.schemaVersion,
          toVersion: owner.schemaVersion,
          package: migration.package,
          implementation: migration.provider,
          implementationHash: options.runtimePlan.services.find((service) => service.id === migration.provider)
            ?.packageContentHash ?? null,
          input: entry.root,
          output: hash(migratedContent),
          artifactRoot: migrationReference.root.hash,
          policy: options.runtimePlan.selections.find((selection) => selection.provider === migration.provider)
            ?.reason ?? "sole-compatible-provider",
        });
      }
      restoreFragments.set(owner.semanticSchema, fragment);
    }
    const missingCurrentRequired = owners.filter((owner) => owner.required && !restoreFragments.has(owner.semanticSchema));
    if (missingCurrentRequired.length > 0) {
      fail("FPM_STATE_FRAGMENT_REQUIRED_MISSING", "The save omits state required by the current runtime graph.", {
        schemas: missingCurrentRequired.map((owner) => owner.semanticSchema).sort(),
      });
    }
    const ordered = ownerOrder(owners.filter((owner) => restoreFragments.has(owner.semanticSchema)));
    for (const owner of [...ordered].reverse()) await owner.prepareRestore?.();
    const restored = [];
    for (const owner of ordered) restored.push(await owner.restore(restoreFragments.get(owner.semanticSchema)));
    return {
      schema: "fpm.runtime-session/1",
      state: "restored-pending-commit",
      saveId,
      saveRoot: loaded.record.root.hash,
      savedCheckpoint: manifest.checkpoint,
      distribution: {
        saved: manifest.distributionIdentity,
        current: options.distributionIdentity,
        compatible: manifest.distributionIdentity === options.distributionIdentity,
      },
      runtimePlan: {
        saved: manifest.runtimePlanIdentity,
        current: options.runtimePlanIdentity,
        compatible: manifest.runtimePlanIdentity === options.runtimePlanIdentity,
      },
      restored,
      retainedOpaque,
      migrations,
    };
  }

  return {
    async activate(context) {
      store = context.artifactStore;
      clock = context.require("runtime.clock.tick");
      options = context.options;
      owners = [
        context.require("runtime.instances.state"),
        context.require("runtime.transforms.state"),
        context.require("runtime.marker.state"),
        context.require("runtime.required-counter.state"),
      ].filter(Boolean).map(validateOwner);
      migration = context.require("runtime.transforms.migration");
      const duplicate = owners.map((owner) => owner.semanticSchema)
        .find((schema, index, entries) => entries.indexOf(schema) !== index);
      if (duplicate) fail("FPM_STATE_OWNER_AMBIGUOUS", "Two active services own the same persistent-state schema.", {
        semanticSchema: duplicate,
      });
      await rm(options.sessionRecordPath, { force: true });
      session = options.loadSaveId ? await restore(options.loadSaveId) : {
        schema: "fpm.runtime-session/1",
        state: "fresh-pending-commit",
        saveId: null,
        distribution: { current: options.distributionIdentity },
        runtimePlan: { current: options.runtimePlanIdentity },
        restored: [],
        retainedOpaque: [],
        migrations: [],
      };
      const ready = freeze({ report: () => freeze(structuredClone(session)) });
      return {
        protocol: "fpm.runtime-service-response/1",
        capabilities: {
          "runtime.persistence.world": freeze({ save, report: ready.report }),
          "runtime.restore.ready": ready,
        },
      };
    },
    async commit() {
      session.state = session.saveId ? "restored" : "fresh";
      session.committed = true;
      await writeAtomic(options.sessionRecordPath, session);
    },
    async deactivate() {
      owners = [];
      migration = null;
      store = null;
      clock = null;
    },
  };
}
