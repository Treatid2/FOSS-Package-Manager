// SPDX-License-Identifier: MPL-2.0

import { randomUUID } from "node:crypto";
import {
  access, cp, link, mkdir, open, readFile, readdir, rename, rm, stat, writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ArtifactStore, executeArtifactGraph } from "./artifacts.mjs";
import { buildProfile } from "./build.mjs";
import { discoverPackages } from "./discovery.mjs";
import { FgpmError, invariant } from "./errors.mjs";
import { hashDirectory, hashFile, readJson, resolveInside, sha256, stableJson, writeJson } from "./io.mjs";
import { validatePhase9Record } from "./phase9-contracts.mjs";
import { loadProfile } from "./profile.mjs";
import { resolvePackages } from "./resolver.mjs";
import { resolveRuntimePlan } from "./runtime.mjs";
import { satisfies } from "./semver.mjs";
import { validateRegistry, appendRegistryEvent, registryRoot } from "./package-registry.mjs";
import { publishVerifiedDirectory } from "./immutable-publication.mjs";

const ROOT = /^sha256:([0-9a-f]{64})$/;
const PACKAGE_ID = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const WORKSPACE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const WORKSPACE_OPERATION_TYPES = Object.freeze([
  "add", "update", "remove", "select-provider", "select-adapter", "select-replacement",
  "include-member", "exclude-member", "include-subsystem", "remove-subsystem",
  "accept-generated", "abandon",
]);
const OPERATION_TYPES = new Set(WORKSPACE_OPERATION_TYPES);

const ignoredTreeEntry = (source) => ![".git", "node_modules", "build"].includes(path.basename(source));

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function publishImmutableDirectory(staging, target, expectedRoot, options = {}) {
  return publishVerifiedDirectory(staging, target, expectedRoot, {
    ...options,
    subject: "complete-build closure",
    codes: {
      unresolved: "FGPM_COMPLETE_BUILD_CLOSURE_PUBLICATION_UNRESOLVED",
      conflict: "FGPM_COMPLETE_BUILD_CLOSURE_CONFLICT",
      unstable: "FGPM_COMPLETE_BUILD_CLOSURE_PUBLICATION_UNSTABLE",
    },
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const TRANSIENT_REPLACE_ERRORS = new Set(["EACCES", "EBUSY", "EPERM"]);

async function replaceTemporary(temporary, filePath) {
  const maximumAttempts = 6;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      await rename(temporary, filePath);
      return;
    } catch (error) {
      if (!TRANSIENT_REPLACE_ERRORS.has(error.code) || attempt === maximumAttempts) {
        throw new FgpmError("FGPM_REFERENCE_PUBLICATION_FAILED",
          "A manager reference could not be published atomically.", {
            path: filePath, cause: error.code ?? error.message, attempts: attempt,
          });
      }
      await delay(10 * (2 ** (attempt - 1)));
    }
  }
}

function rootHash(root, label = "root") {
  const match = ROOT.exec(root ?? "");
  invariant(match, "FGPM_ROOT_INVALID", `A ${label} must be a SHA-256 root.`, { root });
  return match[1];
}

function semanticRoot(value) {
  return `sha256:${sha256(stableJson(value))}`;
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]));
  }
  return value;
}

async function writeReplace(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, stableJson(value), "utf8");
    await replaceTemporary(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeCreateOnly(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, stableJson(value), "utf8");
    try {
      await link(temporary, filePath);
      return true;
    } catch (error) {
      if (error.code === "EEXIST") return false;
      throw error;
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function listFiles(directory) {
  const files = [];
  async function visit(current) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(absolute);
      else throw new FgpmError("FGPM_PACKAGE_TREE_ENTRY_UNSUPPORTED", "A package tree contains a non-file entry.", {
        path: absolute,
      });
    }
  }
  await visit(directory);
  return files;
}

function normalizedOperation(input, actor) {
  invariant(input && typeof input === "object" && !Array.isArray(input)
    && OPERATION_TYPES.has(input.type), "FGPM_WORKSPACE_OPERATION_INVALID",
  "A workspace operation has an unsupported type.", { operation: input, supported: [...OPERATION_TYPES].sort() });
  const fields = {
    add: ["type", "packageRoot"],
    update: ["type", "packageId", "packageRoot"],
    remove: ["type", "packageId"],
    "select-provider": ["type", "requirement", "provider"],
    "select-adapter": ["type", "relation", "adapter"],
    "select-replacement": ["type", "target", "replacement"],
    "include-member": ["type", "collection", "member"],
    "exclude-member": ["type", "collection", "member"],
    "include-subsystem": ["type", "generationRoot"],
    "remove-subsystem": ["type", "generationRoot"],
    "accept-generated": ["type", "request"],
    abandon: ["type", "operationId"],
  }[input.type];
  invariant(Object.keys(input).every((key) => fields.includes(key)), "FGPM_WORKSPACE_OPERATION_UNKNOWN_FIELD",
    "A workspace operation contains an unknown field.", { type: input.type, fields: Object.keys(input), allowed: fields });
  for (const field of fields.filter((entry) => entry !== "type" && entry !== "request")) {
    invariant(typeof input[field] === "string" && input[field].length > 0, "FGPM_WORKSPACE_OPERATION_INVALID",
      "A workspace operation field must be a non-empty string.", { type: input.type, field, value: input[field] });
  }
  if (["add", "update"].includes(input.type)) rootHash(input.packageRoot, "package root");
  if (["include-subsystem", "remove-subsystem"].includes(input.type)) rootHash(input.generationRoot, "generation root");
  if (input.type === "accept-generated") {
    invariant(input.request && typeof input.request === "object" && !Array.isArray(input.request),
      "FGPM_DERIVED_REQUEST_INVALID", "A generated-package request must be an object.", { request: input.request });
  }
  const attribution = { actor: actor ?? "author:local-curator" };
  const payload = sortObject(structuredClone(input));
  return {
    schema: "fgpm.workspace-operation/1",
    id: semanticRoot({ schema: "fgpm.workspace-operation/1", payload, attribution }),
    ...payload,
    attribution,
  };
}

function mapRecord(map) {
  return Object.fromEntries([...map].sort(([left], [right]) => left.localeCompare(right)));
}

function addIndex(index, key, value) {
  const values = index.get(key) ?? new Set();
  values.add(value);
  index.set(key, values);
}

function packageCoordinate(record) {
  return `${record.manifest.namespace}/${record.id}`;
}

function indexRecord(index) {
  return Object.fromEntries([...index].sort(([left], [right]) => left.localeCompare(right))
    .map(([key, values]) => [key, [...values].sort()]));
}

function detectDependencyCycle(edges) {
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  function visit(node) {
    if (visiting.has(node)) return [...stack.slice(stack.indexOf(node)), node];
    if (visited.has(node)) return null;
    visiting.add(node);
    stack.push(node);
    for (const dependency of [...(edges.get(node) ?? [])].sort()) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
    return null;
  }
  for (const node of [...edges.keys()].sort()) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return null;
}

function runtimeFacts(packageRecords) {
  const services = [];
  const collections = [];
  const stateOwners = [];
  const tasks = [];
  for (const record of packageRecords) {
    for (const service of record.manifest.runtimeServices ?? []) {
      services.push({
        id: service.id,
        package: record.id,
        packageRoot: record.root,
        provides: (service.provides ?? []).map((entry) => ({
          capability: entry.capability,
          version: entry.version,
          cardinality: entry.cardinality ?? (entry.exclusive === false ? "collection" : "exclusive"),
          member: entry.member ?? null,
        })).sort((a, b) => a.capability.localeCompare(b.capability) || (a.member ?? "").localeCompare(b.member ?? "")),
        requires: (service.requires ?? []).map((entry) => ({
          capability: entry.capability, range: entry.range, optional: entry.optional === true,
        })).sort((a, b) => a.capability.localeCompare(b.capability)),
      });
      for (const provided of service.provides ?? []) {
        if ((provided.cardinality === "collection" || provided.exclusive === false) && provided.member) {
          collections.push({ capability: provided.capability, member: provided.member, service: service.id,
            package: record.id });
          if (provided.capability === "runtime.state.owner") {
            stateOwners.push({
              id: provided.member,
              package: record.id,
              semanticSchema: provided.metadata?.semanticSchema ?? null,
              schemaVersion: provided.metadata?.schemaVersion ?? null,
              required: provided.metadata?.required === true,
            });
          }
          if (provided.capability === "runtime.task") tasks.push({ id: provided.member, service: service.id,
            package: record.id, metadata: sortObject(provided.metadata ?? {}) });
        }
      }
    }
  }
  services.sort((a, b) => a.id.localeCompare(b.id));
  collections.sort((a, b) => a.capability.localeCompare(b.capability) || a.member.localeCompare(b.member));
  stateOwners.sort((a, b) => a.id.localeCompare(b.id));
  tasks.sort((a, b) => a.id.localeCompare(b.id));
  const semantic = { services, collections, stateOwners, tasks };
  return {
    schema: "fgpm.generation-runtime-plan/1",
    ...semantic,
    deterministicTickRoot: semanticRoot({ schema: "fgpm.deterministic-tick-set/1", tasks }),
    visibleOutputRoot: semanticRoot({ schema: "fgpm.visible-output-plan/1", services, collections }),
  };
}

function stateOwnersFromRuntimePlan(record) {
  return (record?.collections ?? []).find((entry) => entry.capability === "runtime.state.owner")?.members
    .map((entry) => ({
      id: entry.id, package: entry.package, required: entry.metadata?.required === true,
      semanticSchema: entry.metadata?.semanticSchema ?? null,
      schemaVersion: entry.metadata?.schemaVersion ?? null,
    })).sort((left, right) => left.id.localeCompare(right.id)) ?? [];
}

function typedActivationArtifact(build) {
  return {
    schema: "fgpm.typed-artifact-reference/1",
    id: build.lockfile.artifact.id,
    semanticType: build.artifact.type,
    root: sortObject(build.artifact.root),
    entry: build.lockfile.artifact.entry,
    provenance: {
      builder: build.provenance.artifact.builder,
      entryPoint: build.provenance.artifact.entryPoint,
      lockfile: semanticRoot(build.lockfile),
    },
  };
}

function packageSelectionRoot(packages, choices) {
  return semanticRoot({
    schema: "fgpm.authoritative-package-selection/1",
    packages: packages.map((entry) => ({ id: entry.id, root: entry.root }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    choices: sortObject(choices),
  });
}

export class CurationManager {
  constructor(directory, options = {}) {
    this.directory = path.resolve(directory);
    this.lockTimeoutMs = options.lockTimeoutMs ?? 120_000;
    this.lockStaleMs = options.lockStaleMs ?? 30_000;
    this.lockPollMs = options.lockPollMs ?? 20;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async initialize() {
    await Promise.all([
      "package-store/objects/sha256", "package-store/records", "installed/identities",
      "workspace-revisions", "workspaces", "candidates", "candidate-builds", "candidate-validations",
      "derived", "derived-artifacts", "complete-builds", "build-closures", "generations", "distributions",
      "runtime/sessions", "runtime/checkpoints", "runtime/attempts", "runtime/outputs", "runtime/store",
      "events", "locks", "staging",
    ].map((entry) => mkdir(path.join(this.directory, entry), { recursive: true })));
    const indexPath = this.installedIndexPath();
    if (!await exists(indexPath)) {
      await writeCreateOnly(indexPath, validatePhase9Record({
        schema: "fgpm.installed-index/1", version: 1, packages: [],
      }, indexPath));
    }
    return this;
  }

  installedIndexPath() {
    return path.join(this.directory, "installed", "index.json");
  }

  packageTreePath(root) {
    const hash = rootHash(root, "package root");
    return path.join(this.directory, "package-store", "objects", "sha256", hash.slice(0, 2), hash.slice(2), "tree");
  }

  buildClosurePath(root) {
    const hash = rootHash(root, "complete-build closure root");
    return path.join(this.directory, "build-closures", hash.slice(0, 2), hash.slice(2), "tree");
  }

  immutablePath(kind, root) {
    const hash = rootHash(root, `${kind} identity`);
    return path.join(this.directory, kind, `${hash}.json`);
  }

  workspaceReferencePath(name) {
    invariant(WORKSPACE_NAME.test(name ?? ""), "FGPM_WORKSPACE_NAME_INVALID", "A workspace name is invalid.", { name });
    return path.join(this.directory, "workspaces", `${Buffer.from(name).toString("base64url")}.json`);
  }

  async withLock(identity, callback) {
    const lock = path.join(this.directory, "locks", `${sha256(identity)}.lock`);
    const started = Date.now();
    const owner = randomUUID();
    while (true) {
      try {
        await mkdir(lock);
        await writeJson(path.join(lock, "owner.json"), {
          schema: "fgpm.reference-lease/1", identity, owner, pid: process.pid, acquiredAt: this.clock(),
        });
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        let stale = false;
        try { stale = (await stat(lock)).mtimeMs + this.lockStaleMs <= Date.now(); } catch {}
        // Registry publication can include a long copy/hash. Age alone must never
        // revoke its active writer. Unknown legacy owners remain protected.
        if (stale && identity === "installed-index") {
          stale = false;
          try {
            const held = await readJson(path.join(lock, "owner.json"));
            if (Number.isSafeInteger(held.pid) && held.pid > 0) {
              try { process.kill(held.pid, 0); }
              catch (probe) { stale = probe.code === "ESRCH"; }
            }
          } catch {}
        }
        if (stale) {
          const stalePath = `${lock}.stale-${randomUUID()}`;
          try {
            await rename(lock, stalePath);
            await rm(stalePath, { recursive: true, force: true });
          } catch (recovery) {
            if (!['ENOENT', 'EEXIST', 'EPERM'].includes(recovery.code)) throw recovery;
          }
          continue;
        }
        invariant(Date.now() - started < this.lockTimeoutMs, "FGPM_REFERENCE_LEASE_TIMEOUT",
          "Timed out waiting for a manager reference lease.", { identity, lock });
        await delay(this.lockPollMs);
      }
    }
    try {
      return await callback();
    } finally {
      const held = await readJson(path.join(lock, "owner.json")).catch(() => null);
      if (held?.owner === owner) await rm(lock, { recursive: true, force: true });
    }
  }

  async writeImmutable(kind, identityInputs, value) {
    const identity = semanticRoot(identityInputs);
    const record = { ...value, identity, identityInputs: sortObject(identityInputs) };
    validatePhase9Record(record, `${kind}:${identity}`);
    const recordPath = this.immutablePath(kind, identity);
    if (!await writeCreateOnly(recordPath, record)) {
      const existing = await readJson(recordPath, "FGPM_IMMUTABLE_RECORD_INVALID");
      invariant(stableJson(existing) === stableJson(record), "FGPM_IMMUTABLE_RECORD_CONFLICT",
        "An immutable record identity resolves to different content.", { kind, identity });
      return existing;
    }
    return record;
  }

  async readImmutable(kind, root, schema) {
    const record = await readJson(this.immutablePath(kind, root), "FGPM_IMMUTABLE_RECORD_MISSING");
    validatePhase9Record(record, `${kind}:${root}`);
    invariant(record.identity === root && (!schema || record.schema === schema)
      && semanticRoot(record.identityInputs) === root, "FGPM_IMMUTABLE_RECORD_INVALID",
    "An immutable manager record failed identity verification.", { kind, root, schema: record.schema });
    return record;
  }

  async installedIndex() {
    const index = await readJson(this.installedIndexPath(), "FGPM_INSTALLED_INDEX_INVALID");
    validatePhase9Record(index, this.installedIndexPath());
    invariant(["fgpm.installed-index/1", "fgpm.installed-index/2"].includes(index.schema) && index.version === 1 && Array.isArray(index.packages),
      "FGPM_INSTALLED_INDEX_INVALID", "The installed package index is malformed.", { path: this.installedIndexPath() });
    return validateRegistry(index);
  }

  async importPackage(sourceDirectory, options = {}) {
    await this.initialize();
    const source = path.resolve(sourceDirectory);
    const packages = await discoverPackages([source]);
    invariant(packages.length === 1 && path.resolve(packages[0].directory) === source,
      "FGPM_PACKAGE_IMPORT_SCOPE_INVALID", "Explicit import requires exactly one package rooted at the supplied directory.", {
        source, discovered: packages.map((entry) => entry.manifestPath),
      });
    const pkg = packages[0];
    const root = `sha256:${pkg.contentHash}`;
    if (options.variant) {
      invariant(options.expectedRoot === root && typeof options.reason === "string" && options.reason.trim().length > 0
        && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(options.registrationId ?? "") && options.source !== undefined,
      "FGPM_VARIANT_REGISTRATION_INVALID", "Variant registration requires exact expectedRoot, reason, source and registrationId.");
    }
    return this.withLock("installed-index", async () => {
    let index = await this.installedIndex();
    const priorIndexRoot = registryRoot(index);
    const request = options.variant ? { root, reason: options.reason, source: options.source,
      expectedIndexRoot: options.expectedIndexRoot ?? null } : null;
    const priorEvent = options.variant ? index.audit?.find((entry) => entry.registrationId === options.registrationId) : null;
    if (priorEvent) {
      invariant(stableJson(priorEvent.request) === stableJson(request), "FGPM_VARIANT_IDEMPOTENCY_CONFLICT",
        "A registrationId cannot be reused with different registration inputs.");
      const priorPackage = index.packages.find((entry) => entry.root === root);
      invariant(priorPackage && await this.verifyPackageRoot(root), "FGPM_PACKAGE_STORE_CORRUPT", "Registered package content is unavailable.");
      await this.packageRecord(root);
      return { schema: "fgpm.package-import-result/1", status: "reused", package: priorPackage, auditEvent: priorEvent };
    }
    if (options.expectedIndexRoot) invariant(options.expectedIndexRoot === priorIndexRoot,
      "FGPM_REGISTRY_HEAD_CONFLICT", "Package registry changed before exact variant registration.", { expected: options.expectedIndexRoot, actual: priorIndexRoot });
    const sameVersionEntries = index.packages.filter((entry) => (entry.coordinate ?? entry.id) === pkg.coordinate
      && entry.version === pkg.version);
    const sameRoot = sameVersionEntries.find((entry) => entry.root === root);
    invariant(options.variant || sameVersionEntries.length === 0 || sameRoot, "FGPM_PACKAGE_VERSION_CONFLICT",
      "The same package ID and version were imported with different immutable content.", {
        package: pkg.id, version: pkg.version, existingRoot: sameVersionEntries[0]?.root,
        proposedRoot: root, existingSources: sameVersionEntries.flatMap((entry) => entry.imports?.map((item) => item.source) ?? []), source,
      });
    const residueBefore = { treePresent: await exists(this.packageTreePath(root)),
      rootRecordPresent: await exists(this.immutablePath("package-store/records", root)), registered: Boolean(sameRoot) };
    const target = this.packageTreePath(root);
    if (!await exists(target)) {
      const staging = path.join(this.directory, "staging", `package-${randomUUID()}`);
      await mkdir(path.dirname(staging), { recursive: true });
      try {
        await cp(source, staging, { recursive: true, force: false, errorOnExist: true, filter: ignoredTreeEntry });
        invariant(`sha256:${await hashDirectory(staging)}` === root, "FGPM_PACKAGE_IMPORT_HASH_MISMATCH",
          "A staged package tree does not match its discovered content root.", { source, root });
        await mkdir(path.dirname(target), { recursive: true });
        try { await rename(staging, target); } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    }
    invariant(`sha256:${await hashDirectory(target)}` === root, "FGPM_PACKAGE_STORE_CORRUPT",
      "A stored package tree failed content-root verification.", { root, target });
    const packageRecord = {
      schema: "fgpm.package-root/1", version: 1, identity: root, id: pkg.id, packageVersion: pkg.version,
      root, manifest: sortObject(await readJson(path.join(target, "fgpm-package.json"),
        "FGPM_PACKAGE_MANIFEST_MALFORMED")),
    };
    validatePhase9Record(packageRecord, `package:${root}`);
    const packageRecordPath = this.immutablePath("package-store/records", root);
    if (!await writeCreateOnly(packageRecordPath, packageRecord)) {
      const existing = await readJson(packageRecordPath, "FGPM_PACKAGE_ROOT_RECORD_INVALID");
      invariant(stableJson(existing) === stableJson(packageRecord), "FGPM_PACKAGE_ROOT_RECORD_CONFLICT",
        "One package content root has conflicting package-root metadata.", { root });
    }

      const provenance = { source: options.source ?? source, importedAt: options.importedAt ?? this.clock() };
      let record;
      if (sameRoot) {
        sameRoot.imports ??= [];
        if (!options.variant && sameRoot.imports.some((entry) => stableJson(entry.source) === stableJson(provenance.source))) {
          return { schema: "fgpm.package-import-result/1", status: "reused", package: sameRoot };
        }
        if (!sameRoot.imports.some((entry) => stableJson(entry.source) === stableJson(provenance.source))) sameRoot.imports.push(provenance);
        sameRoot.imports.sort((a, b) => stableJson(a.source).localeCompare(stableJson(b.source)));
        record = sameRoot;
      } else {
        record = { namespace: pkg.namespace, id: pkg.id, coordinate: pkg.coordinate,
          version: pkg.version, root, license: pkg.license, imports: [provenance] };
        index.packages.push(record);
        index.packages.sort((a, b) => (a.coordinate ?? a.id).localeCompare(b.coordinate ?? b.id)
          || a.version.localeCompare(b.version) || a.root.localeCompare(b.root));
      }
      index = appendRegistryEvent(index, options.variant ? "variant-register" : "import", {
        priorIndexRoot, legacyObservation: index.schema === "fgpm.installed-index/1", root,
        residueBefore, source: provenance.source,
        ...(options.variant ? { registrationId: options.registrationId, request } : {}),
      }, this.clock);
      validatePhase9Record(index, this.installedIndexPath());
      validateRegistry(index);
      await writeReplace(this.installedIndexPath(), index);
      return { schema: "fgpm.package-import-result/1", status: sameRoot ? "reused" : "imported", package: record, auditEvent: index.audit.at(-1) };
    });
  }

  async registerVariant(directory, options) {
    return this.importPackage(directory, { ...options, variant: true });
  }

  async inspectPackageRegistry() {
    return this.withLock("installed-index", async () => {
      const index = await this.installedIndex();
      const generations = await this.retainedGenerationRoots();
      const retained = new Map();
      for (const generationRoot of generations) {
        const generation = await this.showGeneration(generationRoot);
        for (const entry of generation.packages) {
          const refs = retained.get(entry.root) ?? [];
          refs.push(generationRoot); retained.set(entry.root, refs);
        }
      }
      const staged = new Map();
      for (const filename of (await readdir(path.join(this.directory, "workspaces"))).filter((name) => name.endsWith(".json")).sort()) {
        const reference = await readJson(path.join(this.directory, "workspaces", filename));
        const revision = await this.readImmutable("workspace-revisions", reference.revision, "fgpm.workspace-revision/1");
        // Retained workspace references are inspection evidence, not permission
        // to select an unregistered legacy root. Do not execute applyWorkspace.
        const mentioned = new Set(revision.operations.filter((entry) => ["add", "update"].includes(entry.type))
          .map((entry) => entry.packageRoot));
        if (revision.baseGeneration) {
          const base = await this.readImmutable("generations", revision.baseGeneration, "fgpm.generation/1");
          for (const entry of base.packages) mentioned.add(entry.root);
        }
        for (const operation of revision.operations.filter((entry) => ["include-subsystem", "remove-subsystem"].includes(entry.type))) {
          const generation = await this.readImmutable("generations", operation.generationRoot, "fgpm.generation/1");
          for (const entry of generation.packages) mentioned.add(entry.root);
        }
        for (const root of mentioned) { const refs = staged.get(root) ?? []; refs.push(reference.name); staged.set(root, refs); }
      }
      const records = await readdir(path.join(this.directory, "package-store", "records"));
      const roots = new Set([...index.packages.map((entry) => entry.root),
        ...records.filter((name) => /^[a-f0-9]{64}\.json$/u.test(name)).map((name) => `sha256:${name.slice(0, -5)}`)]);
      const objectRoot = path.join(this.directory, "package-store", "objects", "sha256");
      for (const prefix of (await readdir(objectRoot)).filter((name) => /^[a-f0-9]{2}$/u.test(name))) {
        for (const suffix of (await readdir(path.join(objectRoot, prefix))).filter((name) => /^[a-f0-9]{62}$/u.test(name))) roots.add(`sha256:${prefix}${suffix}`);
      }
      const objects = [];
      for (const root of [...roots].sort()) {
        const registration = index.packages.find((entry) => entry.root === root) ?? null;
        const recordPath = this.immutablePath("package-store/records", root);
        let record = null, diagnostic = null;
        try {
          if (await exists(recordPath)) {
            record = validatePhase9Record(await readJson(recordPath), recordPath);
            invariant(record.schema === "fgpm.package-root/1" && record.identity === root && record.root === root
              && (!registration || (registration.id === record.id && registration.version === record.packageVersion)),
              "FGPM_PACKAGE_ROOT_RECORD_INVALID", "Root metadata disagrees with content/registration identity.");
          }
        }
        catch (error) { record = null; diagnostic = { code: error.code ?? null, message: error.message }; }
        const verified = await this.verifyPackageRoot(root);
        const peers = registration ? index.packages.filter((entry) => (entry.coordinate ?? entry.id)
          === (registration.coordinate ?? registration.id) && entry.version === registration.version)
          .map((entry) => entry.root) : [];
        objects.push({ root, id: registration?.id ?? record?.id ?? null, version: registration?.version ?? record?.packageVersion ?? null,
          lifecycle: registration ? "registered" : record ? "unregistered-record" : "unregistered-tree",
          registered: Boolean(registration), registration, verified, diagnostic,
          retainedByGenerations: retained.get(root) ?? [], stagedInWorkspaces: staged.get(root) ?? [],
          unreferenced: !retained.has(root) && !staged.has(root), ambiguousIdVersion: peers.length > 1,
          availableActions: diagnostic || !verified ? ["retain-for-diagnosis"] : registration ? ["select-exact-root", "retain"] : ["variant-register-exact-root", "retain-for-diagnosis"] });
      }
      return { schema: "fgpm.package-registry-inspection/1", indexSchema: index.schema, indexRoot: registryRoot(index),
        objects, audit: index.audit ?? [], retainedGenerations: generations,
        historicalObservation: "Unregistered content may be legacy rc.2 failed-import residue; inspection does not invent its earlier provenance or event time.",
        cleanup: { destructive: false, supported: false, policy: "Retain registered, generation-referenced and unregistered objects. No automatic GC/discard/unregister; no cleanup bypass is supported." } };
    });
  }

  async listPackages() {
    return (await this.installedIndex()).packages;
  }

  async packageRecord(root) {
    const registration = (await this.installedIndex()).packages.find((entry) => entry.root === root);
    invariant(registration,
      "FGPM_PACKAGE_ROOT_UNREGISTERED", "A package root must be formally registered before selection or use.", { root });
    const record = await readJson(this.immutablePath("package-store/records", root), "FGPM_PACKAGE_ROOT_RECORD_MISSING");
    validatePhase9Record(record, `package:${root}`);
    invariant(record.schema === "fgpm.package-root/1" && record.identity === root && record.root === root
      && record.id === registration.id && record.packageVersion === registration.version,
      "FGPM_PACKAGE_ROOT_RECORD_INVALID", "A package-root record is malformed.", { root });
    invariant(await this.verifyPackageRoot(root), "FGPM_PACKAGE_STORE_CORRUPT",
      "A referenced package root is missing or corrupt.", { root });
    return { ...record, root, manifest: record.manifest };
  }

  async verifyPackageRoot(root) {
    try {
      return `sha256:${await hashDirectory(this.packageTreePath(root))}` === root;
    } catch {
      return false;
    }
  }

  async createWorkspace(name, options = {}) {
    await this.initialize();
    if (options.baseGeneration) await this.readImmutable("generations", options.baseGeneration, "fgpm.generation/1");
    return this.withLock(`workspace:${name}`, async () => {
      const referencePath = this.workspaceReferencePath(name);
      invariant(!await exists(referencePath), "FGPM_WORKSPACE_EXISTS", "A workspace with this name already exists.", { name });
      const workspaceIdentity = `workspace:${randomUUID()}`;
      const attribution = { actor: options.actor ?? "author:local-curator" };
      const revision = await this.writeImmutable("workspace-revisions", {
        schema: "fgpm.workspace-revision/1", workspaceIdentity, parent: null,
        baseGeneration: options.baseGeneration ?? null, operations: [], attribution,
      }, {
        schema: "fgpm.workspace-revision/1", version: 1, workspaceIdentity, parent: null,
        baseGeneration: options.baseGeneration ?? null, operations: [], attribution,
      });
      const reference = {
        schema: "fgpm.workspace-reference/1", version: 1, name, workspaceIdentity,
        revision: revision.identity, baseGeneration: revision.baseGeneration, updatedAt: this.clock(),
      };
      validatePhase9Record(reference, `workspace:${name}`);
      await writeReplace(referencePath, reference);
      return { reference, revision };
    });
  }

  async forkWorkspace(generationRoot, name, options = {}) {
    return this.createWorkspace(name, { ...options, baseGeneration: generationRoot });
  }

  async workspaceStatus(name) {
    const reference = await readJson(this.workspaceReferencePath(name), "FGPM_WORKSPACE_MISSING");
    validatePhase9Record(reference, `workspace:${name}`);
    invariant(reference.schema === "fgpm.workspace-reference/1" && reference.name === name,
      "FGPM_WORKSPACE_REFERENCE_INVALID", "A workspace reference is malformed.", { name });
    const revision = await this.readImmutable("workspace-revisions", reference.revision, "fgpm.workspace-revision/1");
    return { reference, revision };
  }

  async workspaceHistory(name) {
    const history = [];
    let { revision } = await this.workspaceStatus(name);
    while (revision) {
      history.push(revision);
      revision = revision.parent
        ? await this.readImmutable("workspace-revisions", revision.parent, "fgpm.workspace-revision/1") : null;
    }
    return history;
  }

  async exportWorkspace(name, directory) {
    await this.initialize();
    const root = path.resolve(directory);
    invariant(!await exists(root), "FGPM_WORKSPACE_EXPORT_EXISTS",
      "A workspace export is create-only and the destination already exists.", { directory: root });
    const { reference } = await this.workspaceStatus(name);
    const revisions = (await this.workspaceHistory(name)).reverse();
    const staging = `${root}.staging-${randomUUID()}`;
    try {
      await mkdir(path.join(staging, "revisions"), { recursive: true });
      const entries = [];
      for (const revision of revisions) {
        const file = `revisions/${rootHash(revision.identity)}.json`;
        await writeJson(path.join(staging, file), revision);
        entries.push({ identity: revision.identity, file });
      }
      const portable = {
        schema: "fgpm.workspace-portable/1", version: 1, name: reference.name,
        workspaceIdentity: reference.workspaceIdentity, revision: reference.revision,
        baseGeneration: reference.baseGeneration, revisions: entries,
      };
      await writeJson(path.join(staging, "workspace.json"), portable);
      await mkdir(path.dirname(root), { recursive: true });
      await rename(staging, root);
      return { schema: "fgpm.workspace-export-result/1", directory: root, workspace: portable };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async importWorkspace(source) {
    await this.initialize();
    const resolved = path.resolve(source);
    const indexPath = resolved.toLowerCase().endsWith(".json") ? resolved : path.join(resolved, "workspace.json");
    const root = path.dirname(indexPath);
    const portable = await readJson(indexPath, "FGPM_WORKSPACE_PORTABLE_INVALID");
    const allowed = ["schema", "version", "name", "workspaceIdentity", "revision", "baseGeneration", "revisions"];
    invariant(portable && typeof portable === "object" && !Array.isArray(portable)
      && Object.keys(portable).every((key) => allowed.includes(key))
      && portable.schema === "fgpm.workspace-portable/1" && portable.version === 1
      && WORKSPACE_NAME.test(portable.name) && /^workspace:[0-9a-f-]+$/.test(portable.workspaceIdentity)
      && Array.isArray(portable.revisions) && portable.revisions.length > 0,
    "FGPM_WORKSPACE_PORTABLE_INVALID", "A portable workspace index is malformed.", { source: indexPath });
    return this.withLock(`workspace:${portable.name}`, async () => {
      const referencePath = this.workspaceReferencePath(portable.name);
      invariant(!await exists(referencePath), "FGPM_WORKSPACE_EXISTS",
        "A workspace with this name already exists.", { name: portable.name });
      let previous = null;
      for (const [index, entry] of portable.revisions.entries()) {
        invariant(entry && typeof entry === "object" && !Array.isArray(entry)
          && JSON.stringify(Object.keys(entry).sort()) === JSON.stringify(["file", "identity"])
          && ROOT.test(entry.identity), "FGPM_WORKSPACE_PORTABLE_INVALID",
        "A portable workspace revision entry is malformed.", { index });
        const revision = await readJson(resolveInside(root, entry.file, "workspace revision"),
          "FGPM_WORKSPACE_PORTABLE_INVALID");
        validatePhase9Record(revision, `portable-workspace:${entry.identity}`);
        invariant(revision.schema === "fgpm.workspace-revision/1" && revision.identity === entry.identity
          && semanticRoot(revision.identityInputs) === entry.identity
          && revision.workspaceIdentity === portable.workspaceIdentity
          && revision.parent === previous, "FGPM_WORKSPACE_PORTABLE_INVALID",
        "A portable workspace revision failed identity or history verification.", {
          index, expected: entry.identity, actual: revision.identity, expectedParent: previous,
          actualParent: revision.parent,
        });
        if (revision.baseGeneration) await this.readImmutable("generations", revision.baseGeneration, "fgpm.generation/1");
        const imported = await this.writeImmutable("workspace-revisions", revision.identityInputs,
          Object.fromEntries(Object.entries(revision).filter(([key]) => !["identity", "identityInputs"].includes(key))));
        invariant(imported.identity === entry.identity, "FGPM_WORKSPACE_PORTABLE_INVALID",
          "A portable workspace revision changed identity during import.", { index, expected: entry.identity,
            actual: imported.identity });
        previous = entry.identity;
      }
      invariant(portable.revision === previous, "FGPM_WORKSPACE_PORTABLE_INVALID",
        "The portable workspace head does not match its final history entry.", {
          expected: portable.revision, actual: previous,
        });
      const current = await this.readImmutable("workspace-revisions", portable.revision, "fgpm.workspace-revision/1");
      invariant(current.baseGeneration === portable.baseGeneration, "FGPM_WORKSPACE_PORTABLE_INVALID",
        "The portable workspace base generation does not match its head revision.", {
          expected: portable.baseGeneration, actual: current.baseGeneration,
        });
      const reference = {
        schema: "fgpm.workspace-reference/1", version: 1, name: portable.name,
        workspaceIdentity: portable.workspaceIdentity, revision: portable.revision,
        baseGeneration: portable.baseGeneration, updatedAt: this.clock(),
      };
      validatePhase9Record(reference, `workspace:${portable.name}`);
      await writeReplace(referencePath, reference);
      return { schema: "fgpm.workspace-import-result/1", status: "imported", reference, revision: current,
        history: portable.revisions.map((entry) => entry.identity) };
    });
  }

  async stageOperation(name, input, options = {}) {
    const operation = normalizedOperation(input, options.actor);
    if (["add", "update"].includes(operation.type)) await this.packageRecord(operation.packageRoot);
    return this.withLock(`workspace:${name}`, async () => {
      const referencePath = this.workspaceReferencePath(name);
      const reference = await readJson(referencePath, "FGPM_WORKSPACE_MISSING");
      if (options.expectedHead) {
        invariant(reference.revision === options.expectedHead, "FGPM_WORKSPACE_HEAD_CONFLICT",
          "The workspace head changed before the edit could commit.", {
            workspace: name, expected: options.expectedHead, current: reference.revision,
          });
      }
      const previous = await this.readImmutable("workspace-revisions", reference.revision, "fgpm.workspace-revision/1");
      const operations = [...previous.operations, operation];
      const revision = await this.writeImmutable("workspace-revisions", {
        schema: "fgpm.workspace-revision/1", workspaceIdentity: previous.workspaceIdentity,
        parent: previous.identity, baseGeneration: previous.baseGeneration, operations,
        attribution: operation.attribution,
      }, {
        schema: "fgpm.workspace-revision/1", version: 1, workspaceIdentity: previous.workspaceIdentity,
        parent: previous.identity, baseGeneration: previous.baseGeneration, operations,
        attribution: operation.attribution,
      });
      await writeReplace(referencePath, { ...reference, revision: revision.identity, updatedAt: this.clock() });
      return { operation, revision };
    });
  }

  async stageOperations(name, inputs, options = {}) {
    invariant(Array.isArray(inputs) && inputs.length > 0, "FGPM_WORKSPACE_OPERATION_INVALID",
      "A staged operation batch must contain at least one operation.", { count: inputs?.length });
    const operations = inputs.map((input) => normalizedOperation(input, options.actor));
    for (const operation of operations) if (["add", "update"].includes(operation.type)) await this.packageRecord(operation.packageRoot);
    return this.withLock(`workspace:${name}`, async () => {
      const referencePath = this.workspaceReferencePath(name);
      const reference = await readJson(referencePath, "FGPM_WORKSPACE_MISSING");
      if (options.expectedHead) {
        invariant(reference.revision === options.expectedHead, "FGPM_WORKSPACE_HEAD_CONFLICT",
          "The workspace head changed before the operation batch could commit.", {
            workspace: name, expected: options.expectedHead, current: reference.revision,
          });
      }
      const previous = await this.readImmutable("workspace-revisions", reference.revision, "fgpm.workspace-revision/1");
      const revision = await this.writeImmutable("workspace-revisions", {
        schema: "fgpm.workspace-revision/1", workspaceIdentity: previous.workspaceIdentity,
        parent: previous.identity, baseGeneration: previous.baseGeneration,
        operations: [...previous.operations, ...operations], attribution: operations.at(-1).attribution,
      }, {
        schema: "fgpm.workspace-revision/1", version: 1, workspaceIdentity: previous.workspaceIdentity,
        parent: previous.identity, baseGeneration: previous.baseGeneration,
        operations: [...previous.operations, ...operations], attribution: operations.at(-1).attribution,
      });
      await writeReplace(referencePath, { ...reference, revision: revision.identity, updatedAt: this.clock() });
      return { operations, revision };
    });
  }

  async applyWorkspace(revision) {
    const selected = new Map();
    const choices = { providers: {}, adapters: {}, replacements: {}, collections: {} };
    if (revision.baseGeneration) {
      const generation = await this.readImmutable("generations", revision.baseGeneration, "fgpm.generation/1");
      for (const entry of generation.packages) selected.set(entry.id, entry.root);
      Object.assign(choices.providers, generation.choices?.providers ?? {});
      Object.assign(choices.adapters, generation.choices?.adapters ?? {});
      Object.assign(choices.replacements, generation.choices?.replacements ?? {});
      Object.assign(choices.collections, generation.choices?.collections ?? {});
    }
    const abandoned = new Set(revision.operations.filter((entry) => entry.type === "abandon")
      .map((entry) => entry.operationId));
    const generatedRequests = [];
    for (const operation of revision.operations) {
      if (operation.type === "abandon" || abandoned.has(operation.id)) continue;
      if (["add", "update"].includes(operation.type)) {
        const record = await this.packageRecord(operation.packageRoot);
        if (operation.type === "update") {
          invariant(record.id === operation.packageId, "FGPM_WORKSPACE_UPDATE_ID_MISMATCH",
            "An update root does not own the selected package identity.", {
              expected: operation.packageId, actual: record.id, root: operation.packageRoot,
            });
        }
        selected.set(record.id, operation.packageRoot);
      } else if (operation.type === "remove") selected.delete(operation.packageId);
      else if (operation.type === "select-provider") choices.providers[operation.requirement] = operation.provider;
      else if (operation.type === "select-adapter") choices.adapters[operation.relation] = operation.adapter;
      else if (operation.type === "select-replacement") choices.replacements[operation.target] = operation.replacement;
      else if (["include-member", "exclude-member"].includes(operation.type)) {
        const collection = choices.collections[operation.collection] ?? { include: [], exclude: [] };
        const key = operation.type === "include-member" ? "include" : "exclude";
        if (!collection[key].includes(operation.member)) collection[key].push(operation.member);
        collection.include.sort(); collection.exclude.sort();
        choices.collections[operation.collection] = collection;
      } else if (["include-subsystem", "remove-subsystem"].includes(operation.type)) {
        const generation = await this.readImmutable("generations", operation.generationRoot, "fgpm.generation/1");
        for (const entry of generation.packages) {
          if (operation.type === "include-subsystem") selected.set(entry.id, entry.root);
          else if (selected.get(entry.id) === entry.root) selected.delete(entry.id);
        }
      } else if (operation.type === "accept-generated") generatedRequests.push(sortObject(operation.request));
    }
    return { selected, choices: sortObject(choices), generatedRequests };
  }

  async buildIntent(options = {}) {
    if (options.profilePath) {
      const profile = await loadProfile(options.profilePath);
      return sortObject({
        schema: "fgpm.complete-build-intent/1", mode: "complete-profile", profileSchema: "fgpm.profile/3",
        entryPoint: profile.entryPoint, artifact: profile.artifact, activation: profile.activation ?? null,
        target: profile.layers.target, policy: profile.layers.policy, user: profile.layers.user,
      });
    }
    if (options.buildIntent) {
      const intent = sortObject(structuredClone(options.buildIntent));
      invariant(intent.schema === "fgpm.complete-build-intent/1"
        && ["complete-profile", "package-only"].includes(intent.mode),
      "FGPM_COMPLETE_BUILD_INTENT_INVALID", "A candidate complete-build intent is malformed.", { intent });
      if (intent.mode === "complete-profile") {
        invariant(typeof intent.entryPoint === "string" && typeof intent.artifact?.type === "string",
          "FGPM_COMPLETE_BUILD_INTENT_INVALID",
          "An executable complete-build intent requires an entry point and artifact type.", { intent });
      }
      return intent;
    }
    return {
      schema: "fgpm.complete-build-intent/1", mode: "package-only", profileSchema: null,
      entryPoint: null, artifact: null, activation: null,
      target: sortObject(options.target ?? {}), policy: sortObject(options.policy ?? {}), user: {},
    };
  }

  async planCandidate(name, options = {}) {
    const { reference, revision } = await this.workspaceStatus(name);
    const { selected, choices, generatedRequests } = await this.applyWorkspace(revision);
    const buildIntent = await this.buildIntent(options);
    const packageRecords = [];
    for (const [id, root] of [...selected].sort(([left], [right]) => left.localeCompare(right))) {
      const record = await this.packageRecord(root);
      invariant(record.id === id, "FGPM_GENERATION_PACKAGE_ID_MISMATCH", "A selected package root has the wrong identity.", {
        selected: id, actual: record.id, root,
      });
      packageRecords.push(record);
    }
    const byId = new Map(packageRecords.map((entry) => [entry.id, entry]));
    const byCoordinate = new Map(packageRecords.map((entry) => [packageCoordinate(entry), entry]));
    const dependencyEdges = new Map(packageRecords.map((entry) => [entry.id, new Set()]));
    const reverseDependencies = new Map(packageRecords.map((entry) => [entry.id, new Set()]));
    const capabilityProviders = new Map();
    const capabilityConsumers = new Map();
    const publicOwners = new Map();
    const adapterConsumers = new Map();
    const artifactActions = new Map();
    const retainedReferences = new Map();
    const findings = [];

    for (const record of packageRecords) {
      for (const provided of record.manifest.provides ?? []) addIndex(capabilityProviders, provided.capability, record.id);
      for (const service of record.manifest.runtimeServices ?? []) {
        for (const provided of service.provides ?? []) addIndex(capabilityProviders, provided.capability, record.id);
      }
      for (const contribution of record.manifest.contributions ?? []) publicOwners.set(contribution.id, record.id);
      for (const replacement of record.manifest.replacements ?? []) addIndex(adapterConsumers, replacement.target, record.id);
      for (const handler of record.manifest.handlers ?? []) {
        for (const built of handler.builds ?? []) addIndex(artifactActions, built, record.id);
        for (const adapted of handler.adapts ?? []) addIndex(adapterConsumers, adapted.relation, record.id);
      }
    }

    const requirements = [];
    for (const record of packageRecords) {
      for (const dependency of record.manifest.dependencies ?? []) {
        const qualified = dependency.package.includes("/");
        const selectedDependency = (qualified ? byCoordinate : byId).get(dependency.package);
        if (!selectedDependency) {
          addIndex(reverseDependencies, dependency.package, record.id);
          findings.push({ code: "FGPM_CANDIDATE_DEPENDENCY_MISSING", severity: "error", package: record.id,
            dependency: dependency.package, range: dependency.range,
            causalPath: [`package:${record.id}`, `dependency:${dependency.package}@${dependency.range}`] });
        } else {
          dependencyEdges.get(record.id).add(selectedDependency.id);
          reverseDependencies.get(selectedDependency.id).add(record.id);
          if (!satisfies(selectedDependency.packageVersion, dependency.range)) {
            findings.push({ code: "FGPM_CANDIDATE_DEPENDENCY_VERSION_INCOMPATIBLE", severity: "error",
              package: record.id, dependency: dependency.package, range: dependency.range,
              selectedVersion: selectedDependency.packageVersion,
              causalPath: [`package:${record.id}`, `dependency:${dependency.package}@${dependency.range}`,
                `selected:${selectedDependency.packageVersion}`] });
          }
        }
      }
      for (const requirement of record.manifest.requires ?? []) requirements.push({ package: record.id, ...requirement });
      for (const service of record.manifest.runtimeServices ?? []) {
        for (const requirement of service.requires ?? []) {
          if (requirement.optional !== true) requirements.push({ package: record.id, service: service.id, ...requirement });
        }
      }
    }
    for (const requirement of requirements.sort((a, b) => a.package.localeCompare(b.package)
      || a.capability.localeCompare(b.capability))) {
      addIndex(capabilityConsumers, requirement.capability, requirement.package);
      const candidates = [...(capabilityProviders.get(requirement.capability) ?? [])]
        .filter((id) => {
          const provider = byId.get(id);
          const declarations = [...(provider.manifest.provides ?? []),
            ...(provider.manifest.runtimeServices ?? []).flatMap((service) => service.provides ?? [])];
          return declarations.some((entry) => entry.capability === requirement.capability
            && satisfies(entry.version, requirement.range));
        }).sort();
      const selectedProvider = choices.providers[requirement.capability]
        ?? buildIntent.policy?.providers?.[requirement.capability] ?? null;
      if (candidates.length === 0) {
        findings.push({ code: "FGPM_CANDIDATE_PROVIDER_MISSING", severity: "error", package: requirement.package,
          capability: requirement.capability, range: requirement.range,
          causalPath: [`package:${requirement.package}`, `capability:${requirement.capability}`] });
      } else if (requirement.cardinality === "collection") {
        for (const provider of candidates) {
          if (provider !== requirement.package) {
            dependencyEdges.get(requirement.package).add(provider);
            reverseDependencies.get(provider).add(requirement.package);
          }
        }
      } else if (candidates.length > 1 && !candidates.includes(selectedProvider)) {
        findings.push({ code: "FGPM_CANDIDATE_PROVIDER_AMBIGUOUS", severity: "error", package: requirement.package,
          capability: requirement.capability, candidates,
          causalPath: [`package:${requirement.package}`, `capability:${requirement.capability}`] });
      } else {
        const provider = selectedProvider && candidates.includes(selectedProvider) ? selectedProvider : candidates[0];
        if (provider !== requirement.package) {
          dependencyEdges.get(requirement.package).add(provider);
          reverseDependencies.get(provider).add(requirement.package);
        }
      }
    }
    const cycle = detectDependencyCycle(dependencyEdges);
    if (cycle) findings.push({ code: "FGPM_CANDIDATE_DEPENDENCY_CYCLE", severity: "error", cycle,
      causalPath: cycle.map((entry) => `package:${entry}`) });

    const basePackages = new Map();
    let baseDerivedPackages = [];
    if (revision.baseGeneration) {
      const base = await this.readImmutable("generations", revision.baseGeneration, "fgpm.generation/1");
      for (const entry of base.packages) basePackages.set(entry.id, entry.root);
      baseDerivedPackages = base.derivedPackages ?? [];
    }
    const changes = [];
    for (const id of [...new Set([...basePackages.keys(), ...selected.keys()])].sort()) {
      const before = basePackages.get(id) ?? null;
      const after = selected.get(id) ?? null;
      if (before !== after) changes.push({ package: id, kind: before === null ? "add" : after === null ? "remove" : "update",
        before, after });
    }
    const affected = new Map();
    const queue = changes.map((change) => ({ id: change.package, path: [`operation:${change.kind}:${change.package}`,
      `package:${change.package}`] }));
    while (queue.length > 0) {
      const current = queue.shift();
      if (affected.has(current.id)) continue;
      affected.set(current.id, current.path);
      for (const dependant of [...(reverseDependencies.get(current.id) ?? [])].sort()) {
        queue.push({ id: dependant, path: [...current.path, `dependant:${dependant}`] });
      }
    }
    const runtimePlan = sortObject(options.runtimePlan ?? runtimeFacts(packageRecords));
    const selectionRoot = packageSelectionRoot(packageRecords, choices);
    for (const generationRoot of await this.retainedGenerationRoots()) {
      const generation = await this.showGeneration(generationRoot);
      for (const pkg of generation.packages ?? []) addIndex(retainedReferences, pkg.root, `generation:${generation.identity}`);
    }
    for (const entry of await readdir(path.join(this.directory, "distributions"), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const distribution = await readJson(path.join(this.directory, "distributions", entry.name));
      for (const pkg of distribution.packages ?? []) addIndex(retainedReferences, pkg.root, `distribution:${distribution.identity}`);
    }
    const impact = {
      schema: "fgpm.impact-report/1",
      changes,
      affected: [...affected].sort(([left], [right]) => left.localeCompare(right))
        .map(([id, causalPath]) => ({ kind: "package", id, causalPath })),
      reusablePackageRoots: packageRecords.filter((entry) => !affected.has(entry.id)).map((entry) => entry.root).sort(),
      invalidatedDerived: [...new Set([
        ...baseDerivedPackages.filter((entry) => (entry.inputPackageRoots ?? [])
          .some((root) => changes.some((change) => change.before === root || change.after === root)))
          .map((entry) => entry.root),
        ...generatedRequests.filter((request) => (request.inputPackageRoots ?? [])
          .some((root) => changes.some((change) => change.before === root || change.after === root)))
          .map((request) => semanticRoot(request)),
      ])].sort(),
      transitionClass: "full-generation-restart",
    };
    const indexes = {
      dependencies: indexRecord(dependencyEdges),
      reverseDependencies: indexRecord(reverseDependencies),
      capabilityProviders: indexRecord(capabilityProviders),
      capabilityConsumers: indexRecord(capabilityConsumers),
      publicOwners: mapRecord(publicOwners),
      adapterConsumers: indexRecord(adapterConsumers),
      artifactActions: indexRecord(artifactActions),
      runtimeServices: Object.fromEntries(runtimePlan.services.map((entry) => [entry.id, entry.package])),
      collectionMembers: Object.fromEntries(runtimePlan.collections.map((entry) => [entry.member, entry.package])),
      stateOwners: Object.fromEntries(runtimePlan.stateOwners.map((entry) => [entry.id, entry.package])),
      taskParticipation: Object.fromEntries(runtimePlan.tasks.map((entry) => [entry.id, entry.package])),
      retainedReferences: indexRecord(retainedReferences),
    };
    const identityInputs = {
      schema: "fgpm.candidate/1", version: 1, workspaceRevision: reference.revision,
      baseGeneration: revision.baseGeneration, packages: packageRecords.map((entry) => ({ id: entry.id, root: entry.root })),
      choices, target: sortObject(options.target ?? buildIntent.target ?? {}),
      policy: sortObject(options.policy ?? buildIntent.policy ?? {}),
      generatedRequests: sortObject(generatedRequests), runtimePlan, buildIntent, selectionRoot,
      findings: sortObject(findings), impact, indexes,
    };
    return this.writeImmutable("candidates", identityInputs, {
      schema: "fgpm.candidate/1", version: 1, status: findings.some((entry) => entry.severity === "error")
        ? "blocked" : "ready-to-build",
      workspace: { name, revision: reference.revision }, baseGeneration: revision.baseGeneration,
      packages: identityInputs.packages, choices, target: identityInputs.target, policy: identityInputs.policy,
      generatedRequests: identityInputs.generatedRequests, runtimePlan, buildIntent, selectionRoot,
      findings, impact, indexes,
    });
  }

  async explainCandidate(candidateRoot) {
    const candidate = await this.readImmutable("candidates", candidateRoot, "fgpm.candidate/1");
    return { schema: "fgpm.candidate-explanation/1", candidate: candidateRoot, status: candidate.status,
      findings: candidate.findings, impact: candidate.impact, choices: candidate.choices };
  }

  async verifyArtifactInputRoot(root) {
    rootHash(root, "input artifact root");
    const prefixes = await readdir(path.join(this.directory, "build-closures"), { withFileTypes: true });
    for (const prefix of prefixes) {
      if (!prefix.isDirectory()) continue;
      const suffixes = await readdir(path.join(this.directory, "build-closures", prefix.name), { withFileTypes: true });
      for (const suffix of suffixes) {
        if (!suffix.isDirectory()) continue;
        const storeDirectory = path.join(this.directory, "build-closures", prefix.name, suffix.name, "tree", "artifact-store");
        if (!await exists(storeDirectory)) continue;
        const store = new ArtifactStore(storeDirectory, {
          protocol: "fgpm.artifact-transaction/2", facts: {}, widenedDimensions: [],
        });
        if (await store.verifyRoot({ kind: "blob", hash: root })) return storeDirectory;
      }
    }
    return null;
  }

  async materializeDerivedPackage(request) {
    invariant((request.depth ?? 1) === 1 && !request.generatedRequests,
      "FGPM_DERIVED_DEPTH_UNSUPPORTED", "Phase 9 permits one generated-package layer only.", { request });
    const generatorRoot = request.generatorPackageRoot;
    rootHash(generatorRoot, "generator package root");
    const generator = await this.packageRecord(generatorRoot);
    const inputPackageRoots = [...new Set(request.inputPackageRoots ?? [])].sort();
    for (const root of inputPackageRoots) {
      invariant(await this.verifyPackageRoot(root), "FGPM_DERIVED_INPUT_PACKAGE_MISSING",
        "A declared derived-package package input is absent or corrupt.", { root });
      await this.packageRecord(root);
    }
    const inputArtifactRoots = [...new Set(request.inputArtifactRoots ?? [])].sort();
    for (const root of inputArtifactRoots) {
      invariant(await this.verifyArtifactInputRoot(root), "FGPM_DERIVED_INPUT_ARTIFACT_MISSING",
        "A declared derived-package artifact input is absent from every retained complete-build closure.", { root });
    }
    const actionRequest = request.generatorAction;
    invariant(actionRequest && typeof actionRequest.handler === "string" && typeof actionRequest.outputType === "string",
      "FGPM_DERIVED_GENERATOR_ACTION_REQUIRED",
      "A derived-package request must select one specialist generator handler and output type.", { request });
    const declaration = (generator.manifest.handlers ?? []).find((entry) => entry.id === actionRequest.handler);
    invariant(declaration && (declaration.builds ?? []).includes(actionRequest.outputType),
      "FGPM_DERIVED_GENERATOR_ACTION_UNAVAILABLE",
      "The selected generator package does not declare the requested specialist action.", {
        generator: generator.id, handler: actionRequest.handler, outputType: actionRequest.outputType,
      });
    const generatorImplementationRoot = semanticRoot({
      packageRoot: generatorRoot, handler: sortObject(declaration), outputType: actionRequest.outputType,
    });
    if (request.generatorImplementationRoot) {
      invariant(request.generatorImplementationRoot === generatorImplementationRoot,
        "FGPM_DERIVED_GENERATOR_IMPLEMENTATION_MISMATCH",
        "A derived request cannot attach an unrelated generator implementation root.", {
          expected: generatorImplementationRoot, actual: request.generatorImplementationRoot,
        });
    }
    const keyInputs = {
      schema: "fgpm.derived-package-key/1", generatorPackageRoot: generatorRoot,
      generatorImplementationRoot,
      generatorAction: { handler: actionRequest.handler, outputType: actionRequest.outputType },
      inputPackageRoots, inputArtifactRoots, parameters: sortObject(request.parameters ?? {}),
      environment: sortObject(request.environment ?? {}),
    };
    const key = semanticRoot(keyInputs);
    const packageId = request.packageId ?? `derived.${rootHash(key).slice(0, 24)}`;
    invariant(PACKAGE_ID.test(packageId), "FGPM_DERIVED_PACKAGE_ID_INVALID", "A derived package ID is invalid.", { packageId });
    const dependencies = [];
    for (const root of inputPackageRoots) {
      const record = await this.packageRecord(root);
      dependencies.push({ package: record.id, range: `=${record.packageVersion}` });
    }
    dependencies.sort((a, b) => a.package.localeCompare(b.package));
    const provenance = {
      schema: "fgpm.derived-package-provenance/1", version: 1, key,
      generatorPackageRoot: generatorRoot,
      generatorImplementationRoot: keyInputs.generatorImplementationRoot,
      generatorAction: keyInputs.generatorAction,
      inputPackageRoots, inputArtifactRoots, parameters: keyInputs.parameters, environment: keyInputs.environment,
    };
    const manifest = {
      format: "fgpm.package/2", namespace: "6d7092e8-6f8a-4e25-bb6e-a0bf6588e5b4", name: packageId,
      version: request.version ?? `0.0.${Number.parseInt(rootHash(key).slice(0, 8), 16)}`,
      license: request.license ?? "MPL-2.0", dependencies, runtimeServices: [],
    };
    const staging = path.join(this.directory, "staging", `derived-${rootHash(key)}`);
    if (await exists(staging)) await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    try {
      const owner = {
        id: generator.id, version: generator.packageVersion, contentHash: rootHash(generatorRoot),
        directory: this.packageTreePath(generatorRoot),
      };
      const handler = { ...declaration, owner };
      const action = {
        id: `action:derived/${rootHash(key)}`,
        kind: "generate-derived-package-domain",
        handler: handler.id,
        sourcePackageHashes: [generatorRoot, ...inputPackageRoots],
        inputs: [],
        output: {
          id: `artifact:derived/${rootHash(key)}`,
          type: actionRequest.outputType,
          kind: "tree",
          fileName: "generated",
        },
        parameters: {
          packageId, inputPackageRoots, inputArtifactRoots,
          parameters: keyInputs.parameters, environment: keyInputs.environment,
        },
      };
      const artifactStore = new ArtifactStore(path.join(this.directory, "derived-artifacts"), {
        protocol: "fgpm.artifact-transaction/2",
        facts: { target: keyInputs.environment }, widenedDimensions: [],
      });
      const execution = await executeArtifactGraph([action], new Map([[handler.id, handler]]), artifactStore);
      const artifact = execution.artifacts.get(action.output.id);
      invariant(artifact, "FGPM_DERIVED_GENERATOR_OUTPUT_MISSING",
        "A specialist generator action did not publish its declared domain tree.", { action: action.id });
      await artifactStore.exportArtifact(artifact, path.join(staging, "generated"));
      await writeJson(path.join(staging, "fgpm-package.json"), manifest);
      const attributedProvenance = {
        ...provenance,
        generatedArtifact: { id: artifact.id, type: artifact.type, kind: artifact.kind, hash: artifact.hash },
        action: action.id,
      };
      await writeJson(path.join(staging, "derived-provenance.json"), attributedProvenance);
      const imported = await this.importPackage(staging, { source: `derived:${key}` });
      const record = await this.writeImmutable("derived", { ...keyInputs, outputPackageRoot: imported.package.root }, {
        schema: "fgpm.derived-package/1", version: 1, key, outputPackageRoot: imported.package.root,
        provenance: attributedProvenance,
        generatorExecution: {
          handler: handler.id, package: generator.id, action: action.id,
          form: handler.execution.form, buildKey: execution.records[0].buildKey,
          artifact: attributedProvenance.generatedArtifact,
        },
      });
      return record;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async selectedPackageImplementations(entries) {
    const packages = [];
    for (const entry of entries) {
      const discovered = await discoverPackages([this.packageTreePath(entry.root)]);
      invariant(discovered.length === 1 && discovered[0].id === entry.id
        && `sha256:${discovered[0].contentHash}` === entry.root,
      "FGPM_COMPLETE_BUILD_PACKAGE_MISMATCH",
      "An authoritative build package does not match its selected immutable package-root record.", { entry });
      packages.push(discovered[0]);
    }
    return packages;
  }

  effectiveProfile(candidate, packageRecords) {
    const intent = candidate.buildIntent;
    invariant(intent?.mode === "complete-profile", "FGPM_COMPLETE_BUILD_INTENT_INVALID",
      "An executable build requires a complete-profile intent.", { candidate: candidate.identity });
    const knownCollections = new Map();
    for (const record of packageRecords) {
      for (const service of record.manifest.runtimeServices ?? []) {
        for (const provided of service.provides ?? []) {
          if ((provided.cardinality === "collection" || provided.exclusive === false) && provided.member) {
            addIndex(knownCollections, provided.capability, provided.member);
          }
        }
      }
    }
    const collectionPolicy = structuredClone(intent.policy?.collectionPolicy ?? {});
    for (const [capability, choice] of Object.entries(candidate.choices.collections ?? {})) {
      const known = [...(knownCollections.get(capability) ?? [])].sort();
      const requested = [...new Set([...(choice.include ?? []), ...(choice.exclude ?? [])])];
      invariant(requested.every((member) => known.includes(member)), "FGPM_COLLECTION_MEMBER_CHOICE_UNAVAILABLE",
        "A staged collection choice names a member absent from the complete selected graph.", {
          capability, requested: requested.sort(), known,
        });
      const excluded = new Set(collectionPolicy[capability]?.exclude ?? []);
      for (const member of choice.exclude ?? []) excluded.add(member);
      for (const member of choice.include ?? []) excluded.delete(member);
      collectionPolicy[capability] = {
        id: collectionPolicy[capability]?.id ?? `policy:workspace.collection/${sha256(capability).slice(0, 16)}/1`,
        exclude: [...excluded].sort(),
      };
    }
    return sortObject({
      schema: "fgpm.profile/3",
      name: `candidate-${rootHash(candidate.identity).slice(0, 24)}`,
      packageRoots: ["./selected-packages"],
      distribution: {
        roots: packageRecords.map((entry) => entry.id).sort(),
        entryPoint: intent.entryPoint,
        artifact: intent.artifact,
        ...(intent.activation ? { activation: intent.activation } : {}),
      },
      target: intent.target ?? {},
      policy: {
        providers: { ...(intent.policy?.providers ?? {}), ...(candidate.choices.providers ?? {}) },
        handlerSelections: intent.policy?.handlerSelections ?? {},
        adapterSelections: { ...(intent.policy?.adapterSelections ?? {}), ...(candidate.choices.adapters ?? {}) },
        collectionPolicy,
        validation: intent.policy?.validation ?? {
          id: "policy:fgpm.validation/no-unwaived-failures/1", requiredValidators: [], waivers: [],
        },
        environmentKey: intent.policy?.environmentKey ?? { widen: [] },
      },
      user: {
        roots: [],
        replacements: { ...(intent.user?.replacements ?? {}), ...(candidate.choices.replacements ?? {}) },
      },
    });
  }

  async publishCompleteBuild(candidate, packageEntries) {
    const packageRecords = [];
    for (const entry of packageEntries) packageRecords.push(await this.packageRecord(entry.root));
    packageRecords.sort((left, right) => left.id.localeCompare(right.id));
    const implementations = await this.selectedPackageImplementations(packageRecords);
    const expectedSelectionRoot = packageSelectionRoot(packageRecords, candidate.choices);
    const resolverProfile = { roots: packageRecords.map((entry) => entry.id), providers: candidate.choices.providers ?? {} };
    const packageResolution = resolvePackages(implementations, resolverProfile);
    const authoritativePackages = packageResolution.ordered.map((entry) => ({
      id: entry.id, root: `sha256:${entry.contentHash}`,
    })).sort((left, right) => left.id.localeCompare(right.id));
    const authoritativeSelectionRoot = packageSelectionRoot(authoritativePackages, candidate.choices);
    const authorityMatch = expectedSelectionRoot === authoritativeSelectionRoot;

    let profile = null;
    let runtimePlan = candidate.runtimePlan;
    let activationArtifact = null;
    let closureRoot = null;
    let closurePublication = null;
    let profileRoot = null;
    let lockRoot;
    let policyRoot = semanticRoot(candidate.policy);
    let validationRoot = semanticRoot({ schema: "fgpm.package-only-validation/1", accepted: true });
    let actionRoot = semanticRoot({ schema: "fgpm.action-closure/1", actions: [] });
    let artifactClosureRoot = semanticRoot({ schema: "fgpm.artifact-closure/1", artifacts: [] });
    let activationArtifactRoot = null;
    let runtimePlanRoot = semanticRoot(runtimePlan);
    let contractRoot = semanticRoot({ publicContract: "fgpm.public-contract-bundle/phase-8" });
    const resolutionRoot = semanticRoot({
      schema: "fgpm.authoritative-resolution/1", packages: authoritativePackages,
      edges: Object.fromEntries([...packageResolution.edges].sort(([a], [b]) => a.localeCompare(b))
        .map(([id, dependencies]) => [id, [...dependencies].sort()])),
    });
    lockRoot = resolutionRoot;

    if (candidate.buildIntent.mode === "complete-profile") {
      profile = this.effectiveProfile(candidate, packageRecords);
      profileRoot = semanticRoot(profile);
      const staging = path.join(this.directory, "staging", `complete-build-${randomUUID()}`);
      const profilePath = path.join(staging, "profile.json");
      const outputDirectory = path.join(staging, "output");
      const artifactStoreDirectory = path.join(staging, "artifact-store");
      await mkdir(staging, { recursive: true });
      try {
        const selectedPackagesDirectory = path.join(staging, "selected-packages");
        await mkdir(selectedPackagesDirectory, { recursive: true });
        for (const entry of packageRecords) {
          await cp(this.packageTreePath(entry.root), path.join(selectedPackagesDirectory, entry.id), { recursive: true });
        }
        await writeJson(profilePath, profile);
        const build = await buildProfile(profilePath, outputDirectory, {
          storeDirectory: artifactStoreDirectory,
        });
        activationArtifact = typedActivationArtifact(build);
        runtimePlan = resolveRuntimePlan(build, { artifactReference: activationArtifact }).record;
        runtimePlanRoot = semanticRoot(runtimePlan);
        lockRoot = semanticRoot(build.lockfile);
        policyRoot = semanticRoot({
          authority: build.profile.authority, policy: build.profile.layers.policy, user: build.profile.layers.user,
        });
        validationRoot = semanticRoot(build.lockfile.validation);
        actionRoot = semanticRoot(build.lockfile.actions);
        artifactClosureRoot = semanticRoot(build.lockfile.artifacts);
        activationArtifactRoot = activationArtifact.root.hash;
        await writeJson(path.join(staging, "runtime-plan.json"), runtimePlan);
        await writeJson(path.join(staging, "build-summary.json"), {
          schema: "fgpm.complete-build-payload/1", candidate: candidate.identity, profileRoot,
          selectionRoot: expectedSelectionRoot, authoritativeSelectionRoot,
          resolutionRoot, lockRoot, policyRoot, validationRoot, actionRoot, artifactClosureRoot,
          activationArtifactRoot, runtimePlanRoot,
        });
        await mkdir(path.join(staging, "contracts"), { recursive: true });
        await cp(path.join(PROJECT_ROOT, "public"), path.join(staging, "contracts", "public"), { recursive: true });
        await cp(path.join(PROJECT_ROOT, "contracts", "phase-9"),
          path.join(staging, "contracts", "phase-9"), { recursive: true });
        contractRoot = `sha256:${await hashDirectory(path.join(staging, "contracts"))}`;
        closureRoot = `sha256:${await hashDirectory(staging)}`;
        const target = this.buildClosurePath(closureRoot);
        await mkdir(path.dirname(target), { recursive: true });
        closurePublication = await publishImmutableDirectory(staging, target, closureRoot);
      } catch (error) {
        if (!error?.preserveStaging) await rm(staging, { recursive: true, force: true });
        throw error;
      }
    }

    const identityInputs = {
      schema: "fgpm.complete-build/1", version: 1, candidate: candidate.identity,
      mode: candidate.buildIntent.mode, selectionRoot: expectedSelectionRoot,
      authoritativeSelectionRoot, authorityMatch, profileRoot, resolutionRoot, lockRoot, policyRoot,
      validationRoot, actionRoot, artifactClosureRoot, activationArtifactRoot, runtimePlanRoot,
      closureRoot, contractRoot, profile, runtimePlan, activationArtifact,
    };
    const record = await this.writeImmutable("complete-builds", identityInputs, {
      schema: "fgpm.complete-build/1", version: 1, candidate: candidate.identity,
      mode: candidate.buildIntent.mode, selectionRoot: expectedSelectionRoot,
      authoritativeSelectionRoot, authorityMatch, profileRoot, resolutionRoot, lockRoot, policyRoot,
      validationRoot, actionRoot, artifactClosureRoot, activationArtifactRoot, runtimePlanRoot,
      closureRoot, contractRoot, profile, runtimePlan, activationArtifact,
      observations: {},
    });
    return { ...record, observations: { ...record.observations, closurePublication } };
  }

  async buildCandidate(candidateRoot) {
    const candidate = await this.readImmutable("candidates", candidateRoot, "fgpm.candidate/1");
    invariant(candidate.status === "ready-to-build", "FGPM_CANDIDATE_NOT_BUILDABLE",
      "Only a ready candidate can materialise derived packages.", { candidate: candidateRoot, status: candidate.status });
    const derived = [];
    for (const request of candidate.generatedRequests) derived.push(await this.materializeDerivedPackage(request));
    const allPackages = [...candidate.packages];
    for (const entry of derived) {
      const record = await this.packageRecord(entry.outputPackageRoot);
      allPackages.push({ id: record.id, root: record.root });
    }
    allPackages.sort((left, right) => left.id.localeCompare(right.id));
    const completeBuild = await this.publishCompleteBuild(candidate, allPackages);
    invariant(completeBuild.authorityMatch, "FGPM_CANDIDATE_AUTHORITY_MISMATCH",
      "The incremental candidate selection disagrees with the authoritative complete resolver.", {
        candidate: candidate.identity, selectionRoot: completeBuild.selectionRoot,
        authoritativeSelectionRoot: completeBuild.authoritativeSelectionRoot,
      });
    const authority = {
      selectionRoot: completeBuild.selectionRoot,
      authoritativeSelectionRoot: completeBuild.authoritativeSelectionRoot,
      match: completeBuild.authorityMatch,
    };
    const identityInputs = {
      schema: "fgpm.candidate-build/1", version: 1, candidate: candidateRoot,
      derivedPackages: derived.map((entry) => ({
        key: entry.key, root: entry.outputPackageRoot, record: entry.identity,
        inputPackageRoots: entry.provenance.inputPackageRoots,
        inputArtifactRoots: entry.provenance.inputArtifactRoots,
      })).sort((a, b) => a.key.localeCompare(b.key)),
      completeBuild: completeBuild.identity, authority,
    };
    const build = await this.writeImmutable("candidate-builds", identityInputs, {
      schema: "fgpm.candidate-build/1", version: 1, status: "build-complete", candidate: candidateRoot,
      derivedPackages: identityInputs.derivedPackages, completeBuild: completeBuild.identity, authority,
    });
    return { ...build, publication: { completeBuildClosure: completeBuild.observations.closurePublication } };
  }

  async completeBuildRecord(root) {
    return this.readImmutable("complete-builds", root, "fgpm.complete-build/1");
  }

  async verifyCompleteBuild(root) {
    const record = await this.completeBuildRecord(root);
    invariant(record.authorityMatch && record.selectionRoot === record.authoritativeSelectionRoot,
      "FGPM_CANDIDATE_AUTHORITY_MISMATCH",
      "A complete-build record does not prove equality with the authoritative package selection.", {
        completeBuild: root, selectionRoot: record.selectionRoot,
        authoritativeSelectionRoot: record.authoritativeSelectionRoot,
      });
    invariant(semanticRoot(record.runtimePlan) === record.runtimePlanRoot,
      "FGPM_COMPLETE_BUILD_RUNTIME_PLAN_MISMATCH", "A complete-build runtime plan failed identity verification.", {
        completeBuild: root, expected: record.runtimePlanRoot, actual: semanticRoot(record.runtimePlan),
      });
    if (record.mode === "complete-profile") {
      invariant(record.closureRoot && record.activationArtifact && record.activationArtifactRoot,
        "FGPM_COMPLETE_BUILD_EXECUTABLE_CLOSURE_MISSING",
        "An executable complete build omits its activation closure.", { completeBuild: root });
      const closure = this.buildClosurePath(record.closureRoot);
      invariant(await exists(closure) && `sha256:${await hashDirectory(closure)}` === record.closureRoot,
        "FGPM_COMPLETE_BUILD_CLOSURE_CORRUPT", "A complete-build closure is missing or corrupt.", {
          completeBuild: root, closureRoot: record.closureRoot,
        });
      const runtimePlan = await readJson(path.join(closure, "runtime-plan.json"),
        "FGPM_COMPLETE_BUILD_RUNTIME_PLAN_MISSING");
      invariant(stableJson(runtimePlan) === stableJson(record.runtimePlan),
        "FGPM_COMPLETE_BUILD_RUNTIME_PLAN_MISMATCH",
        "The retained runtime-plan bytes differ from the committed complete-build record.", { completeBuild: root });
      const lockfile = await readJson(path.join(closure, "output", "fgpm.lock.json"),
        "FGPM_COMPLETE_BUILD_LOCK_MISSING");
      invariant(semanticRoot(lockfile) === record.lockRoot, "FGPM_COMPLETE_BUILD_LOCK_MISMATCH",
        "The retained complete-build lockfile failed identity verification.", { completeBuild: root });
      invariant(`sha256:${await hashDirectory(path.join(closure, "contracts"))}` === record.contractRoot,
        "FGPM_COMPLETE_BUILD_CONTRACT_MISMATCH",
        "The retained public contract closure failed identity verification.", { completeBuild: root });
      const store = new ArtifactStore(path.join(closure, "artifact-store"), {
        protocol: "fgpm.artifact-transaction/2", facts: {}, widenedDimensions: [],
      });
      invariant(await store.verifyRoot(record.activationArtifact.root), "FGPM_RUNTIME_ARTIFACT_ROOT_INVALID",
        "The generation-bound activation artifact is missing or corrupt.", {
          completeBuild: root, artifact: record.activationArtifact,
        });
    }
    return record;
  }

  async validateCandidate(candidateOrBuildRoot) {
    let build;
    try {
      build = await this.readImmutable("candidate-builds", candidateOrBuildRoot, "fgpm.candidate-build/1");
    } catch {
      const candidate = await this.readImmutable("candidates", candidateOrBuildRoot, "fgpm.candidate/1");
      invariant(candidate.generatedRequests.length === 0 && candidate.status === "ready-to-build",
        "FGPM_CANDIDATE_BUILD_REQUIRED", "A candidate with derivation requests must be built before validation.", {
          candidate: candidateOrBuildRoot,
        });
      build = await this.buildCandidate(candidateOrBuildRoot);
    }
    const candidate = await this.readImmutable("candidates", build.candidate, "fgpm.candidate/1");
    for (const entry of candidate.packages) invariant(await this.verifyPackageRoot(entry.root),
      "FGPM_CANDIDATE_PACKAGE_ROOT_INVALID", "Candidate validation found a missing or corrupt package root.", entry);
    for (const entry of build.derivedPackages) invariant(await this.verifyPackageRoot(entry.root),
      "FGPM_CANDIDATE_DERIVED_ROOT_INVALID", "Candidate validation found a missing or corrupt derived package root.", entry);
    const completeBuild = await this.verifyCompleteBuild(build.completeBuild);
    const identityInputs = {
      schema: "fgpm.candidate-validation/1", version: 1, candidate: candidate.identity,
      build: build.identity, completeBuild: completeBuild.identity, authority: build.authority,
      acceptedFindings: candidate.findings.filter((entry) => entry.severity !== "error"),
    };
    return this.writeImmutable("candidate-validations", identityInputs, {
      schema: "fgpm.candidate-validation/1", version: 1, status: "validated",
      candidate: candidate.identity, build: build.identity, completeBuild: completeBuild.identity,
      authority: build.authority, acceptedFindings: identityInputs.acceptedFindings,
    });
  }

  async commitGeneration(validationRoot, options = {}) {
    const validation = await this.readImmutable("candidate-validations", validationRoot, "fgpm.candidate-validation/1");
    const candidate = await this.readImmutable("candidates", validation.candidate, "fgpm.candidate/1");
    const build = await this.readImmutable("candidate-builds", validation.build, "fgpm.candidate-build/1");
    const completeBuild = await this.verifyCompleteBuild(validation.completeBuild);
    invariant(build.completeBuild === completeBuild.identity && validation.authority.match === true,
      "FGPM_GENERATION_COMPLETE_BUILD_AUTHORITY_MISSING",
      "Generation commit requires one verified authoritative complete-build record.", {
        build: build.identity, completeBuild: completeBuild.identity,
      });
    const name = candidate.workspace.name;
    return this.withLock(`workspace:${name}`, async () => {
      const referencePath = this.workspaceReferencePath(name);
      const reference = await readJson(referencePath, "FGPM_WORKSPACE_MISSING");
      invariant(reference.revision === candidate.workspace.revision, "FGPM_CANDIDATE_STALE",
        "A candidate based on an old workspace head cannot commit.", {
          candidate: candidate.identity, expectedWorkspaceRevision: candidate.workspace.revision,
          currentWorkspaceRevision: reference.revision,
        });
      for (const entry of [...candidate.packages, ...build.derivedPackages.map((item) => ({ root: item.root }))]) {
        invariant(await this.verifyPackageRoot(entry.root), "FGPM_GENERATION_ROOT_INVALID",
          "Generation commit found a missing or corrupt package root.", entry);
      }
      const allPackages = [...candidate.packages];
      for (const item of build.derivedPackages) {
        const record = await this.packageRecord(item.root);
        allPackages.push({ id: record.id, root: item.root });
      }
      allPackages.sort((a, b) => a.id.localeCompare(b.id));
      const identityInputs = {
        schema: "fgpm.generation/1", version: 1, parent: candidate.baseGeneration,
        candidate: candidate.identity, packages: allPackages, derivedPackages: build.derivedPackages,
        choices: candidate.choices, target: candidate.target, policy: candidate.policy,
        runtimePlan: completeBuild.runtimePlan,
        stateOwners: stateOwnersFromRuntimePlan(completeBuild.runtimePlan),
        activationArtifact: completeBuild.activationArtifact,
        completeBuild: completeBuild.identity,
        roots: {
          resolution: completeBuild.resolutionRoot, lock: completeBuild.lockRoot,
          policy: completeBuild.policyRoot, validation: completeBuild.validationRoot,
          actions: completeBuild.actionRoot, artifacts: completeBuild.artifactClosureRoot,
          activationArtifact: completeBuild.activationArtifactRoot,
          runtimePlan: completeBuild.runtimePlanRoot, buildClosure: completeBuild.closureRoot,
          contracts: completeBuild.contractRoot,
        },
        publicContract: options.publicContract ?? "fgpm.public-contract-bundle/phase-8",
        manager: options.manager ?? await readJson(path.join(PROJECT_ROOT, "manager.json"))
          .then((manifest) => `${manifest.id}@${manifest.version}`),
      };
      const predictedGenerationRoot = semanticRoot(identityInputs);
      if (options.expectedGenerationRoot !== undefined) {
        rootHash(options.expectedGenerationRoot, "expected generation root");
        invariant(predictedGenerationRoot === options.expectedGenerationRoot,
          "FGPM_GENERATION_ROOT_MISMATCH",
          "The predicted generation does not match the required generation root; no authoritative state moved.", {
            expectedGenerationRoot: options.expectedGenerationRoot,
            predictedGenerationRoot,
            validationRoot, candidate: candidate.identity, workspace: name,
            authoritativeRevision: reference.revision, authoritativeBaseGeneration: reference.baseGeneration,
          });
      }
      const generation = await this.writeImmutable("generations", identityInputs, {
        schema: "fgpm.generation/1", version: 1, parent: candidate.baseGeneration,
        workspaceRevision: candidate.workspace.revision, candidate: candidate.identity,
        packages: allPackages, derivedPackages: build.derivedPackages, choices: candidate.choices,
        target: candidate.target, policy: candidate.policy, runtimePlan: completeBuild.runtimePlan,
        stateOwners: identityInputs.stateOwners, activationArtifact: completeBuild.activationArtifact,
        completeBuild: completeBuild.identity, roots: identityInputs.roots,
        publicContract: identityInputs.publicContract, manager: identityInputs.manager,
        impact: candidate.impact,
      });
      if (options.interruptAfterGenerationPublish) {
        throw new FgpmError("FGPM_SIMULATED_GENERATION_INTERRUPTION",
          "The test interrupted generation commit after immutable publication and before the workspace reference move.", {
            generation: generation.identity, workspace: name, authoritativeRevision: reference.revision,
          });
      }
      const previous = await this.readImmutable("workspace-revisions", reference.revision, "fgpm.workspace-revision/1");
      const attribution = { actor: options.actor ?? "author:local-curator" };
      const revision = await this.writeImmutable("workspace-revisions", {
        schema: "fgpm.workspace-revision/1", workspaceIdentity: previous.workspaceIdentity,
        parent: previous.identity, baseGeneration: generation.identity, operations: [], attribution,
      }, {
        schema: "fgpm.workspace-revision/1", version: 1, workspaceIdentity: previous.workspaceIdentity,
        parent: previous.identity, baseGeneration: generation.identity, operations: [], attribution,
      });
      await writeReplace(referencePath, { ...reference, revision: revision.identity,
        baseGeneration: generation.identity, updatedAt: this.clock() });
      await writeJson(path.join(this.directory, "events", `${Date.now()}-${randomUUID()}.json`), {
        schema: "fgpm.generation-commit-event/1", generation: generation.identity,
        candidate: candidate.identity, previousRevision: reference.revision, revision: revision.identity,
        recordedAt: this.clock(), attribution,
      });
      return { generation, workspaceRevision: revision };
    });
  }

  async showGeneration(root) {
    return this.readImmutable("generations", root, "fgpm.generation/1");
  }

  async generationRuntimeClosure(generationRoot) {
    const generation = await this.showGeneration(generationRoot);
    const completeBuild = await this.verifyCompleteBuild(generation.completeBuild);
    invariant(completeBuild.mode === "complete-profile" && generation.activationArtifact
      && generation.roots.activationArtifact === completeBuild.activationArtifactRoot,
    "FGPM_GENERATION_NOT_EXECUTABLE",
    "Only a generation containing one exact complete executable closure can activate.", {
      generation: generationRoot, completeBuild: completeBuild.identity, mode: completeBuild.mode,
    });
    invariant(generation.roots.runtimePlan === completeBuild.runtimePlanRoot
      && semanticRoot(generation.runtimePlan) === completeBuild.runtimePlanRoot,
    "FGPM_GENERATION_RUNTIME_PLAN_MISMATCH",
    "A generation runtime plan does not match its committed complete-build root.", {
      generation: generationRoot, expected: completeBuild.runtimePlanRoot,
      actual: semanticRoot(generation.runtimePlan),
    });
    invariant(stableJson(generation.activationArtifact) === stableJson(completeBuild.activationArtifact),
      "FGPM_GENERATION_ACTIVATION_ARTIFACT_MISMATCH",
      "A generation cannot attach an unrelated activation artifact to its complete build.", {
        generation: generationRoot,
      });
    const packageOwners = await this.selectedPackageImplementations(generation.packages);
    const closure = this.buildClosurePath(completeBuild.closureRoot);
    const outputDirectory = path.join(this.directory, "runtime", "outputs", rootHash(generationRoot));
    await mkdir(outputDirectory, { recursive: true });
    return {
      generation: generationRoot,
      runtimePlan: generation.runtimePlan,
      runtimePlanIdentity: generation.roots.runtimePlan,
      artifact: generation.activationArtifact,
      packageOwners,
      artifactStoreDirectory: path.join(closure, "artifact-store"),
      storeDirectory: path.join(this.directory, "runtime", "store"),
      outputDirectory,
      distributionIdentity: generationRoot,
    };
  }

  async exportDistribution(generationRoot, destination) {
    const generation = await this.showGeneration(generationRoot);
    const completeBuild = await this.verifyCompleteBuild(generation.completeBuild);
    const output = path.resolve(destination);
    invariant(!await exists(output), "FGPM_DISTRIBUTION_DESTINATION_EXISTS",
      "A distribution export destination already exists.", { destination: output });
    await mkdir(output, { recursive: true });
    try {
      await writeJson(path.join(output, "generation.json"), generation);
      await writeJson(path.join(output, "complete-build.json"), completeBuild);
      for (const entry of generation.packages) {
        const target = path.join(output, "packages", rootHash(entry.root), "tree");
        await mkdir(path.dirname(target), { recursive: true });
        await cp(this.packageTreePath(entry.root), target, { recursive: true, errorOnExist: true, force: false });
      }
      if (completeBuild.closureRoot) {
        const target = path.join(output, "build-closure", rootHash(completeBuild.closureRoot), "tree");
        await mkdir(path.dirname(target), { recursive: true });
        await cp(this.buildClosurePath(completeBuild.closureRoot), target,
          { recursive: true, errorOnExist: true, force: false });
      }
      const files = [];
      for (const file of await listFiles(output)) {
        const relative = path.relative(output, file).replaceAll("\\", "/");
        const info = await stat(file);
        files.push({ path: relative, bytes: info.size, sha256: await hashFile(file) });
      }
      files.sort((a, b) => a.path.localeCompare(b.path));
      const identityInputs = {
        schema: "fgpm.distribution/1", version: 1, generation: generationRoot,
        packages: generation.packages, completeBuild: completeBuild.identity,
        publicContract: generation.publicContract, manager: generation.manager,
      };
      const manifest = { schema: "fgpm.distribution/1", version: 1,
        identity: semanticRoot(identityInputs), identityInputs, generation: generationRoot,
        packages: generation.packages, completeBuild: completeBuild.identity, files };
      await writeJson(path.join(output, "distribution.json"), manifest);
      await this.writeImmutable("distributions", identityInputs, {
        schema: "fgpm.distribution/1", version: 1, generation: generationRoot,
        packages: generation.packages, completeBuild: completeBuild.identity,
        publicContract: generation.publicContract, manager: generation.manager,
      });
      return manifest;
    } catch (error) {
      await rm(output, { recursive: true, force: true });
      throw error;
    }
  }

  async verifyDistribution(directory) {
    const root = path.resolve(directory);
    const manifest = await readJson(path.join(root, "distribution.json"), "FGPM_DISTRIBUTION_INVALID");
    validatePhase9Record(manifest, path.join(root, "distribution.json"));
    invariant(manifest.schema === "fgpm.distribution/1" && manifest.version === 1
      && manifest.identity === semanticRoot(manifest.identityInputs) && Array.isArray(manifest.files),
    "FGPM_DISTRIBUTION_INVALID", "A distribution manifest is malformed or has the wrong identity.", { root });
    const declared = new Set(["distribution.json", ...manifest.files.map((entry) => entry.path)]);
    const actual = (await listFiles(root)).map((entry) => path.relative(root, entry).replaceAll("\\", "/"));
    invariant(actual.every((entry) => declared.has(entry)) && actual.length === declared.size,
      "FGPM_DISTRIBUTION_MEMBER_SET_INVALID", "A distribution has missing or undeclared members.", {
        missing: [...declared].filter((entry) => !actual.includes(entry)).sort(),
        extra: actual.filter((entry) => !declared.has(entry)).sort(),
      });
    for (const entry of [...manifest.files].sort((a, b) => a.path.localeCompare(b.path))) {
      const absolute = path.resolve(root, entry.path);
      invariant(path.relative(root, absolute) && !path.relative(root, absolute).startsWith(".."),
        "FGPM_DISTRIBUTION_PATH_INVALID", "A distribution member escapes its root.", { path: entry.path });
      const info = await stat(absolute);
      const actualHash = await hashFile(absolute);
      invariant(info.size === entry.bytes && actualHash === entry.sha256, "FGPM_DISTRIBUTION_MEMBER_CORRUPT",
        "A distribution member failed byte-count or SHA-256 verification.", {
          path: entry.path, expectedBytes: entry.bytes, actualBytes: info.size,
          expectedSha256: entry.sha256, actualSha256: actualHash,
        });
    }
    const generation = JSON.parse(await readFile(path.join(root, "generation.json"), "utf8"));
    invariant(generation.identity === manifest.generation && semanticRoot(generation.identityInputs) === generation.identity,
      "FGPM_DISTRIBUTION_GENERATION_INVALID", "A distribution generation failed identity verification.", {
        expected: manifest.generation, actual: generation.identity,
      });
    const completeBuild = JSON.parse(await readFile(path.join(root, "complete-build.json"), "utf8"));
    validatePhase9Record(completeBuild, path.join(root, "complete-build.json"));
    invariant(completeBuild.schema === "fgpm.complete-build/1"
      && completeBuild.identity === manifest.completeBuild
      && generation.completeBuild === completeBuild.identity
      && semanticRoot(completeBuild.identityInputs) === completeBuild.identity,
    "FGPM_DISTRIBUTION_COMPLETE_BUILD_INVALID",
    "A distribution complete-build record failed identity or generation binding verification.", {
      manifest: manifest.completeBuild, generation: generation.completeBuild, actual: completeBuild.identity,
    });
    if (completeBuild.closureRoot) {
      const closure = path.join(root, "build-closure", rootHash(completeBuild.closureRoot), "tree");
      invariant(`sha256:${await hashDirectory(closure)}` === completeBuild.closureRoot,
        "FGPM_DISTRIBUTION_BUILD_CLOSURE_CORRUPT",
        "A distribution complete-build closure failed content-root verification.", {
          expected: completeBuild.closureRoot,
        });
      const store = new ArtifactStore(path.join(closure, "artifact-store"), {
        protocol: "fgpm.artifact-transaction/2", facts: {}, widenedDimensions: [],
      });
      invariant(await store.verifyRoot(completeBuild.activationArtifact.root), "FGPM_RUNTIME_ARTIFACT_ROOT_INVALID",
        "A distribution activation artifact is missing or corrupt.", {
          artifact: completeBuild.activationArtifact,
        });
    }
    return { manifest, generation, completeBuild };
  }

  async importDistribution(directory) {
    await this.initialize();
    const verified = await this.verifyDistribution(directory);
    const root = path.resolve(directory);
    for (const entry of verified.generation.packages) {
      const source = path.join(root, "packages", rootHash(entry.root), "tree");
      const imported = await this.importPackage(source, { source: `distribution:${verified.manifest.identity}` });
      invariant(imported.package.root === entry.root, "FGPM_DISTRIBUTION_PACKAGE_ROOT_MISMATCH",
        "An imported distribution package did not reproduce its declared root.", {
          package: entry.id, expected: entry.root, actual: imported.package.root,
      });
    }
    if (verified.completeBuild.closureRoot) {
      const source = path.join(root, "build-closure", rootHash(verified.completeBuild.closureRoot), "tree");
      const target = this.buildClosurePath(verified.completeBuild.closureRoot);
      if (!await exists(target)) {
        const staging = path.join(this.directory, "staging", `distribution-build-${randomUUID()}`);
        try {
          await cp(source, staging, { recursive: true, force: false, errorOnExist: true });
          invariant(`sha256:${await hashDirectory(staging)}` === verified.completeBuild.closureRoot,
            "FGPM_DISTRIBUTION_BUILD_CLOSURE_CORRUPT",
            "An imported complete-build closure failed content-root verification.", {
              expected: verified.completeBuild.closureRoot,
            });
          await mkdir(path.dirname(target), { recursive: true });
          await rename(staging, target);
        } finally {
          await rm(staging, { recursive: true, force: true });
        }
      }
      invariant(`sha256:${await hashDirectory(target)}` === verified.completeBuild.closureRoot,
        "FGPM_COMPLETE_BUILD_CLOSURE_CORRUPT", "The local complete-build closure failed verification.", {
          expected: verified.completeBuild.closureRoot,
        });
    }
    const completeBuild = await this.writeImmutable("complete-builds", verified.completeBuild.identityInputs,
      Object.fromEntries(Object.entries(verified.completeBuild)
        .filter(([key]) => !["identity", "identityInputs"].includes(key))));
    invariant(completeBuild.identity === verified.completeBuild.identity,
      "FGPM_DISTRIBUTION_COMPLETE_BUILD_IDENTITY_MISMATCH",
      "Distribution import did not reproduce the complete-build identity.", {
        expected: verified.completeBuild.identity, actual: completeBuild.identity,
      });
    const generation = await this.writeImmutable("generations", verified.generation.identityInputs,
      Object.fromEntries(Object.entries(verified.generation).filter(([key]) => !["identity", "identityInputs"].includes(key))));
    invariant(generation.identity === verified.generation.identity, "FGPM_DISTRIBUTION_GENERATION_IDENTITY_MISMATCH",
      "Distribution import did not reproduce the generation identity.", {
        expected: verified.generation.identity, actual: generation.identity,
      });
    await this.writeImmutable("distributions", verified.manifest.identityInputs, {
      schema: "fgpm.distribution/1", version: 1, generation: generation.identity,
      packages: generation.packages, completeBuild: completeBuild.identity,
      publicContract: generation.publicContract, manager: generation.manager,
    });
    return { manifest: verified.manifest, generation };
  }

  async retainedGenerationRoots() {
    const roots = new Set();
    for (const entry of await readdir(path.join(this.directory, "workspaces"), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const reference = await readJson(path.join(this.directory, "workspaces", entry.name));
      if (reference.baseGeneration) roots.add(reference.baseGeneration);
    }
    const activePath = path.join(this.directory, "runtime", "active.json");
    if (await exists(activePath)) {
      const active = await readJson(activePath);
      if (active.generation) roots.add(active.generation);
    }
    for (const entry of await readdir(path.join(this.directory, "distributions"), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const distribution = await readJson(path.join(this.directory, "distributions", entry.name));
      if (distribution.generation) roots.add(distribution.generation);
    }
    const queue = [...roots];
    while (queue.length > 0) {
      const generation = await this.showGeneration(queue.shift());
      if (generation.parent && !roots.has(generation.parent)) {
        roots.add(generation.parent);
        queue.push(generation.parent);
      }
    }
    return [...roots].sort();
  }

  async reachabilityReport() {
    const generationRoots = new Set(await this.retainedGenerationRoots());
    const retainedPackages = new Set();
    for (const generationRoot of generationRoots) {
      const generation = await this.showGeneration(generationRoot);
      for (const entry of generation.packages) retainedPackages.add(entry.root);
    }
    const installed = await this.installedIndex();
    return {
      schema: "fgpm.manager-reachability-report/1", destructive: false,
      generationRoots: [...generationRoots].sort(), retainedPackageRoots: [...retainedPackages].sort(),
      unreferencedInstalledPackageRoots: installed.packages.map((entry) => entry.root)
        .filter((root) => !retainedPackages.has(root)).sort(),
    };
  }
}

export function phase9SemanticRoot(value) {
  return semanticRoot(value);
}
