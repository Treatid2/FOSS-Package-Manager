// SPDX-License-Identifier: MPL-2.0

import { cp, lstat, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { FgpmError, invariant } from "./errors.mjs";
import { hashDirectory, readJson, sha256, stableJson, writeJson } from "./io.mjs";
import { publishVerifiedDirectory, verifyPublishedDirectory } from "./immutable-publication.mjs";

const NAMESPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function validatePackageArchiveEntries(entries) {
  invariant(Array.isArray(entries) && entries.every((entry) => typeof entry === "string"),
    "FGPM_ARCHIVE_ENTRY_INVALID", "Archive entry inventory must be an array of names.");
  const normalized = entries.map((entry) => entry.replaceAll("\\", "/"));
  invariant(normalized.every((entry) => entry.length > 0 && !entry.startsWith("/")
    && !entry.split("/").includes("..")), "FGPM_ARCHIVE_ENTRY_INVALID",
  "Archive entries must be relative, non-empty, and traversal-free.", { entries: normalized });
  const folded = new Map();
  for (const entry of normalized) {
    const key = entry.toLowerCase();
    invariant(!folded.has(key), "FGPM_ARCHIVE_ENTRY_DUPLICATE",
      "An archive contains duplicate or case-ambiguous entries.", { first: folded.get(key), second: entry });
    folded.set(key, entry);
  }
  const descriptors = normalized.filter((entry) => entry.toLowerCase().endsWith("fgpm-package.json"));
  invariant(descriptors.length === 1 && descriptors[0] === "fgpm-package.json",
    "FGPM_ARCHIVE_PACKAGE_ROOT_INVALID",
    "A single-package archive must preserve exactly one canonical entrypoint at its archive root.", { descriptors });
  return { schema: "fgpm.package-archive-entry-report/1", status: "valid", entries: normalized.length,
    entrypoint: descriptors[0] };
}

const rewriteLabels = (value) => {
  if (Array.isArray(value)) return value.map(rewriteLabels);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewriteLabels(entry)]));
  }
  return typeof value === "string" ? value.replaceAll("FPM", "FGPM").replaceAll("fpm", "fgpm") : value;
};

async function descriptorInventory(root) {
  const descriptors = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const names = entries.filter((entry) => entry.isFile()
      && ["fpm-package.json", "fgpm-package.json"].includes(entry.name.toLowerCase())).map((entry) => entry.name);
    const legacy = names.filter((name) => name.toLowerCase() === "fpm-package.json");
    const current = names.filter((name) => name.toLowerCase() === "fgpm-package.json");
    invariant(legacy.length <= 1 && current.length <= 1, "FGPM_MIGRATION_ENTRYPOINT_AMBIGUOUS",
      "A source directory contains duplicate or case-ambiguous package entrypoints.", { directory, entries: names.sort() });
    invariant(!(legacy.length && current.length), "FGPM_MIGRATION_ENTRYPOINT_COMPETING",
      "A source directory contains competing pre-public and current package descriptors.", { directory, entries: names.sort() });
    if (legacy.length) {
      invariant(legacy[0] === "fpm-package.json", "FGPM_MIGRATION_ENTRYPOINT_AMBIGUOUS",
        "A pre-public entrypoint has an ambiguous case spelling.", { directory, actual: legacy[0] });
      descriptors.push({ directory, kind: "pre-public", file: legacy[0] });
    }
    if (current.length) {
      invariant(current[0] === "fgpm-package.json", "FGPM_MIGRATION_ENTRYPOINT_AMBIGUOUS",
        "A current entrypoint has an ambiguous case spelling.", { directory, actual: current[0] });
      descriptors.push({ directory, kind: "current", file: current[0] });
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isDirectory() && ![".git", "node_modules", "build"].includes(entry.name)) {
        await visit(path.join(directory, entry.name));
      }
    }
  }
  await visit(root);
  return descriptors.sort((left, right) => left.directory.localeCompare(right.directory));
}

export async function migrationPlan(source, namespace) {
  invariant(NAMESPACE_ID.test(namespace ?? ""), "FGPM_MIGRATION_NAMESPACE_INVALID",
    "Migration requires one lower-case RFC 9562 UUID publisher namespace.", { namespace });
  const descriptors = await descriptorInventory(source);
  invariant(descriptors.length > 0, "FGPM_MIGRATION_PACKAGE_MISSING",
    "The migration source contains no package entrypoint.", { source });
  const packages = [];
  for (const descriptor of descriptors) {
    const manifestPath = path.join(descriptor.directory, descriptor.file);
    const manifest = await readJson(manifestPath, "FGPM_MIGRATION_DESCRIPTOR_MALFORMED");
    if (descriptor.kind === "pre-public") {
      invariant(["fpm.package/1", "fpm.package/2"].includes(manifest.schema)
        && typeof manifest.id === "string", "FGPM_MIGRATION_FORMAT_UNSUPPORTED",
      "The finite migration utility accepts only the two explicitly released pre-public package schemas.", {
        path: manifestPath, schema: manifest.schema,
      });
      packages.push({ path: path.relative(source, descriptor.directory).replaceAll("\\", "/") || ".",
        action: "migrate", predecessor: `${manifest.id}@${manifest.version}`,
        successor: `${namespace}/${manifest.id}@${manifest.version}` });
    } else {
      invariant(["fgpm.package/1", "fgpm.package/2"].includes(manifest.format)
        && NAMESPACE_ID.test(manifest.namespace ?? "") && typeof manifest.name === "string",
      "FGPM_MIGRATION_FORMAT_UNSUPPORTED", "A current package descriptor is malformed or unsupported.", {
        path: manifestPath, format: manifest.format,
      });
      packages.push({ path: path.relative(source, descriptor.directory).replaceAll("\\", "/") || ".",
        action: "retain", successor: `${manifest.namespace}/${manifest.name}@${manifest.version}` });
    }
  }
  return { schema: "fgpm.pre-public-migration-plan/1", mode: "copy-only", source,
    namespace, packages, packageCount: packages.length, executableContentLoaded: false, networkAccess: false,
    privateIndexMutation: false };
}

const MIGRATION_PUBLICATION_CODES = Object.freeze({
  unresolved: "FGPM_MIGRATION_OUTPUT_UNRESOLVED",
  conflict: "FGPM_MIGRATION_OUTPUT_CONFLICT",
  unstable: "FGPM_MIGRATION_OUTPUT_UNSTABLE",
});

export const migrationOperationPath = (outputPath) => `${path.resolve(outputPath)}.fgpm-migration-operation.json`;

async function readOperation(filePath) {
  try {
    const entry = await lstat(filePath);
    invariant(entry.isFile() && !entry.isSymbolicLink(), "FGPM_MIGRATION_OPERATION_INVALID",
      "Migration operation state must be a regular file.", { path: filePath });
    const operation = await readJson(filePath, "FGPM_MIGRATION_OPERATION_INVALID");
    invariant(operation.schema === "fgpm.pre-public-migration-operation/1" && operation.version === 1,
      "FGPM_MIGRATION_OPERATION_INVALID", "Migration operation state has an unsupported format.", {
        path: filePath, schema: operation.schema ?? null, version: operation.version ?? null,
      });
    return operation;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error?.code === "FGPM_FILE_UNREADABLE" && error.details?.cause?.includes("ENOENT")) return null;
    throw error;
  }
}

async function writeOperation(filePath, operation) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, stableJson(operation), "utf8");
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function pathState(filePath) {
  try {
    const entry = await lstat(filePath);
    return { exists: true, directory: entry.isDirectory(), symbolicLink: entry.isSymbolicLink() };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false };
    throw error;
  }
}

function operationIdentity(request) {
  return `sha256:${sha256(stableJson(request))}`;
}

function diagnostic(error) {
  return { code: error?.code ?? "FGPM_MIGRATION_APPLY_FAILED", message: error?.message ?? String(error),
    details: error?.details ?? {} };
}

function interrupted(point) {
  return new FgpmError("FGPM_MIGRATION_TEST_INTERRUPTION", "The migration qualification interrupted at a controlled boundary.", { point });
}

async function verifyMigrationTarget(output, expectedRoot, options = {}) {
  let observed;
  try {
    observed = await pathState(output);
  } catch (error) {
    throw new FgpmError("FGPM_MIGRATION_OUTPUT_UNRESOLVED",
      "The migration output target cannot be inspected.", {
        output, expected: expectedRoot, cause: error.code ?? error.message,
        recoveryAction: "Restore access or quiesce the target, then inspect and repeat.",
      });
  }
  invariant(observed.exists && observed.directory && !observed.symbolicLink,
    "FGPM_MIGRATION_OUTPUT_CONFLICT", "The migration output target is absent or not a real directory.", {
      output, expected: expectedRoot, observed,
      recoveryAction: "Preserve and assess any conflicting path, then repeat with the recorded output.",
    });
  return verifyPublishedDirectory(output, expectedRoot, {
    subject: "migration output", codes: MIGRATION_PUBLICATION_CODES,
    hashDirectory: options.hashDirectory,
  });
}

export async function inspectPrePublicMigration(outputPath, options = {}) {
  const output = path.resolve(outputPath);
  const statePath = migrationOperationPath(output);
  const operation = await readOperation(statePath);
  if (!operation) return { schema: "fgpm.pre-public-migration-status/1", status: "absent", output, statePath };
  let target;
  if (operation.commit?.outputRoot) {
    try {
      const verification = await verifyMigrationTarget(output, operation.commit.outputRoot, options);
      target = { status: "verified", root: operation.commit.outputRoot, verification };
    } catch (error) {
      target = { status: "unresolved", diagnostic: diagnostic(error) };
    }
  } else {
    const observed = await pathState(output);
    target = { status: observed.exists ? "uncommitted-target-present" : "not-published", observed };
  }
  return { schema: "fgpm.pre-public-migration-status/1", status: operation.phase,
    output, statePath, operation, target };
}

async function migrateDescriptors(source, staging, namespace) {
  for (const descriptor of await descriptorInventory(staging)) {
    if (descriptor.kind === "current") continue;
    const oldPath = path.join(descriptor.directory, descriptor.file);
    const manifest = rewriteLabels(await readJson(oldPath, "FGPM_MIGRATION_DESCRIPTOR_MALFORMED"));
    const migrated = {
      format: manifest.schema,
      namespace,
      name: manifest.id,
      ...Object.fromEntries(Object.entries(manifest).filter(([key]) => !["schema", "id"].includes(key))),
    };
    await writeJson(path.join(descriptor.directory, "fgpm-package.json"), migrated);
    await rm(oldPath);
  }
  return hashDirectory(staging, { strict: true });
}

export async function migratePrePublicPackages(sourcePath, options = {}) {
  const source = path.resolve(sourcePath);
  invariant((await stat(source)).isDirectory(), "FGPM_MIGRATION_SOURCE_INVALID",
    "Migration source must be a directory.", { source });
  const plan = await migrationPlan(source, options.namespace);
  const sourceRoot = `sha256:${await hashDirectory(source, { strict: true })}`;
  if (!options.apply) return { ...plan, sourceRoot, status: "preview" };
  invariant(options.output, "FGPM_MIGRATION_OUTPUT_REQUIRED", "Apply mode requires an explicit output directory.");
  const output = path.resolve(options.output);
  invariant(output !== source, "FGPM_MIGRATION_IN_PLACE_FORBIDDEN",
    "The finite migration utility never edits its source in place.", { source, output });
  const sourceToOutput = path.relative(source, output);
  const outputToSource = path.relative(output, source);
  invariant(sourceToOutput.startsWith("..") || path.isAbsolute(sourceToOutput), "FGPM_MIGRATION_OUTPUT_NESTED",
    "Migration output cannot be inside its source tree.", { source, output });
  invariant(outputToSource.startsWith("..") || path.isAbsolute(outputToSource), "FGPM_MIGRATION_SOURCE_NESTED",
    "Migration source cannot be inside its output tree.", { source, output });
  const request = { schema: "fgpm.pre-public-migration-request/1", source, sourceRoot,
    namespace: options.namespace, output };
  const identity = operationIdentity(request);
  const statePath = migrationOperationPath(output);
  const staging = `${output}.fgpm-migration-${identity.slice("sha256:".length, "sha256:".length + 16)}`;
  const clock = options.clock ?? (() => new Date().toISOString());
  let operation = await readOperation(statePath);
  if (operation) {
    invariant(operation.identity === identity && stableJson(operation.request) === stableJson(request),
      "FGPM_MIGRATION_OPERATION_CONFLICT",
      "The migration state path belongs to a different source, namespace, or output request.", {
        statePath, expected: identity, actual: operation.identity,
        recoveryAction: "Use the recorded request or choose a different output path.",
      });
    if (operation.phase === "committed") {
      const verification = await verifyMigrationTarget(output, operation.commit.outputRoot, options);
      return { ...plan, sourceRoot, ...operation.result, status: "reused", recoveredAfterRestart: true,
        operation: { identity, statePath, phase: operation.phase, continuation: operation.continuation }, verification };
    }
  } else {
    operation = {
      schema: "fgpm.pre-public-migration-operation/1", version: 1, identity, request, plan,
      phase: "prepared", commit: null, result: null,
      continuation: { action: "build-and-publish", staging },
      createdAt: clock(), updatedAt: clock(), diagnostic: null,
    };
    await writeOperation(statePath, operation);
    if (options.interruptAfter === "prepared") throw interrupted("prepared");
  }

  await mkdir(path.dirname(output), { recursive: true });
  const finalizeCommitted = async (publication, recovery) => {
    const result = { status: "applied", output, outputHash: operation.commit.outputRoot,
      publication, recovery: "Source unchanged; the exact output is verified and restart-discoverable." };
    operation = { ...operation, phase: "committed", result,
      continuation: { action: "none" }, diagnostic: null, updatedAt: clock() };
    await writeOperation(statePath, operation);
    if (options.interruptAfter === "committed") throw interrupted("committed-response-unavailable");
    return { ...plan, sourceRoot, ...result, recoveredAfterRestart: recovery,
      operation: { identity, statePath, phase: operation.phase, continuation: operation.continuation } };
  };

  if (operation.commit?.outputRoot) {
    const observed = await pathState(output);
    if (observed.exists) {
      try {
        const verification = await verifyMigrationTarget(output, operation.commit.outputRoot, options);
        return { ...(await finalizeCommitted("recovered-existing-target", true)), verification };
      } catch (error) {
        operation = { ...operation, phase: "unresolved", diagnostic: diagnostic(error),
          continuation: { action: "resolve-target-and-repeat", staging }, updatedAt: clock() };
        await writeOperation(statePath, operation);
        throw error;
      }
    }
    const staged = await pathState(staging);
    if (staged.exists) {
      try {
        await verifyMigrationTarget(staging, operation.commit.outputRoot, options);
        const publication = await publishVerifiedDirectory(staging, output, operation.commit.outputRoot, {
          subject: "migration output", codes: MIGRATION_PUBLICATION_CODES,
          hashDirectory: options.hashDirectory,
          afterDurableChange: options.interruptAfter === "durable-change"
            ? async () => { throw interrupted("durable-change-before-result"); } : undefined,
        });
        return finalizeCommitted(publication.status, true);
      } catch (error) {
        if (error.code === "FGPM_MIGRATION_TEST_INTERRUPTION") throw error;
        operation = { ...operation, phase: "unresolved", diagnostic: diagnostic(error),
          continuation: { action: "resolve-target-and-repeat", staging }, updatedAt: clock() };
        await writeOperation(statePath, operation);
        throw error;
      }
    }
  }

  await rm(staging, { recursive: true, force: true });
  try {
    await cp(source, staging, { recursive: true, errorOnExist: true, force: false,
      filter: (entry) => ![".git", "node_modules", "build"].includes(path.basename(entry)) });
    const afterCopySourceRoot = `sha256:${await hashDirectory(source, { strict: true })}`;
    invariant(afterCopySourceRoot === sourceRoot, "FGPM_MIGRATION_SOURCE_CHANGED",
      "The migration source changed while it was being copied.", {
        expected: sourceRoot, actual: afterCopySourceRoot, source,
        recoveryAction: "Quiesce source writers and repeat the same operation.",
      });
    const outputHash = `sha256:${await migrateDescriptors(source, staging, options.namespace)}`;
    operation = { ...operation, phase: "ready-to-commit", commit: { outputRoot: outputHash },
      continuation: { action: "publish-or-recover", staging }, diagnostic: null, updatedAt: clock() };
    await writeOperation(statePath, operation);
    if (options.interruptAfter === "ready-to-commit") throw interrupted("ready-to-commit");
    const publication = await publishVerifiedDirectory(staging, output, outputHash, {
      subject: "migration output", codes: MIGRATION_PUBLICATION_CODES,
      hashDirectory: options.hashDirectory,
      afterDurableChange: options.interruptAfter === "durable-change"
        ? async () => { throw interrupted("durable-change-before-result"); } : undefined,
    });
    return finalizeCommitted(publication.status, false);
  } catch (error) {
    if (error.code === "FGPM_MIGRATION_TEST_INTERRUPTION") throw error;
    operation = { ...operation, phase: "unresolved", diagnostic: diagnostic(error),
      continuation: { action: operation.commit ? "resolve-target-and-repeat" : "rebuild-staging", staging },
      updatedAt: clock() };
    await writeOperation(statePath, operation);
    if (error instanceof FgpmError) throw error;
    throw new FgpmError("FGPM_MIGRATION_APPLY_FAILED", "Migration failed without claiming a published result.", {
      source, output, cause: error.message, staging, statePath,
      recoveryAction: "Inspect the durable operation state and repeat after resolving the reported cause.",
    });
  }
}
