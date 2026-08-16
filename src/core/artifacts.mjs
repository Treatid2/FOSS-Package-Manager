// SPDX-License-Identifier: MPL-2.0

import { randomUUID } from "node:crypto";
import {
  access, copyFile, link, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile,
} from "node:fs/promises";
import path from "node:path";
import { FpmError, invariant } from "./errors.mjs";
import { handlerExecutionRecord, invokeHandler } from "./handler.mjs";
import { hashFile, resolveInside, sha256, stableJson } from "./io.mjs";

const HASH = /^sha256:([0-9a-f]{64})$/;

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function writeReplace(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeCreateOnly(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, "utf8");
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

function normalizedOutputs(action) {
  const outputs = action.outputs ?? (action.output ? [{ name: "primary", ...action.output }] : []);
  invariant(outputs.length > 0, "FPM_ACTION_OUTPUT_MISSING", "An artifact action declares no outputs.", {
    action: action.id,
  });
  const names = new Set();
  const ids = new Set();
  return outputs.map((output) => {
    const normalized = { kind: "blob", ...output };
    invariant(typeof normalized.name === "string" && typeof normalized.id === "string"
      && typeof normalized.type === "string" && typeof normalized.fileName === "string"
      && ["blob", "tree"].includes(normalized.kind), "FPM_ACTION_OUTPUT_INVALID",
    "An artifact action output declaration is malformed.", { action: action.id, output });
    invariant(path.basename(normalized.fileName) === normalized.fileName, "FPM_ARTIFACT_PATH_INVALID",
      "An artifact output must use one plain file or directory name.", {
        action: action.id,
        fileName: normalized.fileName,
      });
    invariant(!names.has(normalized.name) && !ids.has(normalized.id), "FPM_ACTION_OUTPUT_DUPLICATE",
      "An action repeats an output name or artifact identity.", { action: action.id, output: normalized });
    names.add(normalized.name);
    ids.add(normalized.id);
    return normalized;
  });
}

function lookup(object, dottedPath) {
  return dottedPath.split(".").reduce((value, key) => value?.[key], object);
}

function actionEnvironment(handler, environmentContext) {
  const declared = [...new Set(handler.buildEnvironment?.dimensions ?? [])].sort();
  const widened = [...new Set(environmentContext.widenedDimensions ?? [])].sort();
  const dimensions = [...new Set([...declared, ...widened])].sort();
  return {
    declaration: {
      schema: "fpm.build-environment/1",
      declared,
      widened,
      protocol: environmentContext.protocol,
    },
    values: Object.fromEntries(dimensions.map((dimension) => [dimension, lookup(environmentContext.facts, dimension) ?? null])),
  };
}

function portableAction(action, handler, inputs, outputs, environment, execution) {
  return {
    schema: "fpm.action-key/2",
    id: action.id,
    kind: action.kind,
    handler: {
      id: handler.id,
      package: handler.owner.id,
      packageVersion: handler.owner.version,
      packageContentHash: `sha256:${handler.owner.contentHash}`,
      execution,
    },
    sourcePackageHashes: [...(action.sourcePackageHashes ?? [])].sort(),
    parameters: action.parameters ?? {},
    inputs: inputs.map((input) => ({
      name: input.name,
      artifact: input.artifact,
      kind: input.resolved.kind,
      type: input.resolved.type,
      hash: input.resolved.hash,
    })),
    outputs,
    environment,
  };
}

async function listFiles(root) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const information = await lstat(absolute);
      invariant(!information.isSymbolicLink(), "FPM_TREE_ENTRY_UNSUPPORTED",
        "Tree artifacts cannot contain symbolic links or junctions.", { path: absolute });
      if (entry.isDirectory()) await visit(absolute);
      else {
        invariant(entry.isFile(), "FPM_TREE_ENTRY_UNSUPPORTED",
          "Tree artifacts currently accept only regular files and directories.", { path: absolute });
        files.push(absolute);
      }
    }
  }
  await visit(root);
  return files;
}

export class ArtifactStore {
  constructor(directory, environmentContext, options = {}) {
    this.directory = path.resolve(directory);
    this.environmentContext = environmentContext;
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.leasePollMs = options.leasePollMs ?? 25;
    this.leaseTimeoutMs = options.leaseTimeoutMs ?? 120_000;
    this.interruptAfterImportAction = options.interruptAfterImportAction ?? null;
  }

  actionRecordPath(buildKey) {
    return path.join(this.directory, "actions", `${buildKey}.json`);
  }

  objectPath(hash) {
    return path.join(this.directory, "objects", hash.slice(0, 2), hash.slice(2));
  }

  leaseDirectory(buildKey) {
    return path.join(this.directory, "leases", buildKey);
  }

  referencePath(namespace, identity) {
    invariant(/^[a-z0-9][a-z0-9.-]*$/.test(namespace ?? "") && typeof identity === "string"
      && identity.length > 0, "FPM_ARTIFACT_REFERENCE_INVALID",
    "An artifact reference namespace or identity is invalid.", { namespace, identity });
    return path.join(this.directory, "references", namespace, `${sha256(identity)}.json`);
  }

  async verifyRoot(root) {
    const match = HASH.exec(root.hash ?? "");
    if (!match) return false;
    const objectPath = this.objectPath(match[1]);
    if (!await exists(objectPath) || await hashFile(objectPath) !== match[1]) return false;
    if (root.kind === "blob") return true;
    if (root.kind !== "tree") return false;
    try {
      const manifest = JSON.parse(await readFile(objectPath, "utf8"));
      if (manifest.schema !== "fpm.tree/1" || !Array.isArray(manifest.entries)) return false;
      for (const entry of manifest.entries) {
        const entryMatch = HASH.exec(entry.hash ?? "");
        if (entry.kind !== "blob" || !entryMatch) return false;
        const child = this.objectPath(entryMatch[1]);
        if (!await exists(child) || await hashFile(child) !== entryMatch[1]) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  async cached(buildKey, action) {
    const recordPath = this.actionRecordPath(buildKey);
    if (!await exists(recordPath)) return null;
    try {
      const record = JSON.parse(await readFile(recordPath, "utf8"));
      const expectedOutputs = normalizedOutputs(action);
      if (record.schema !== "fpm.action-cache/2" || record.buildKey !== `sha256:${buildKey}`
        || record.action !== action.id || !Array.isArray(record.outputs)
        || record.outputs.length !== expectedOutputs.length) return null;
      for (const expected of expectedOutputs) {
        const root = record.outputs.find((entry) => entry.name === expected.name);
        if (!root || root.id !== expected.id || root.type !== expected.type || root.kind !== expected.kind
          || root.fileName !== expected.fileName || !await this.verifyRoot(root)) return null;
      }
      return record.outputs.map((root) => ({
        ...root,
        storePath: this.objectPath(HASH.exec(root.hash)[1]),
        producedBy: action.id,
      }));
    } catch {
      return null;
    }
  }

  async readLease(buildKey) {
    try {
      return JSON.parse(await readFile(path.join(this.leaseDirectory(buildKey), "lease.json"), "utf8"));
    } catch {
      return null;
    }
  }

  async tryAcquireLease(buildKey, actionId) {
    const parent = path.join(this.directory, "leases");
    await mkdir(parent, { recursive: true });
    const directory = this.leaseDirectory(buildKey);
    const now = Date.now();
    const owner = randomUUID();
    try {
      await mkdir(directory);
      const lease = {
        schema: "fpm.build-lease/1",
        buildKey: `sha256:${buildKey}`,
        action: actionId,
        owner,
        createdAt: new Date(now).toISOString(),
        heartbeatAt: new Date(now).toISOString(),
        expiresAt: new Date(now + this.leaseDurationMs).toISOString(),
        transaction: null,
      };
      await writeReplace(path.join(directory, "lease.json"), stableJson(lease));
      return { buildKey, owner, directory, heartbeat: null, renewal: Promise.resolve(true) };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await this.readLease(buildKey);
      let expired = existing && Date.parse(existing.expiresAt) <= now;
      if (!existing) {
        try {
          expired = (await stat(path.join(directory, "lease.json"))).mtimeMs + this.leaseDurationMs <= now;
        } catch {
          try {
            expired = (await stat(directory)).mtimeMs + this.leaseDurationMs <= now;
          } catch {
            expired = false;
          }
        }
      }
      if (expired) {
        const stale = `${directory}.stale-${randomUUID()}`;
        try {
          await rename(directory, stale);
          await rm(stale, { recursive: true, force: true });
        } catch (recoveryError) {
          if (!["ENOENT", "EEXIST", "EPERM"].includes(recoveryError.code)) throw recoveryError;
        }
      }
      return null;
    }
  }

  async renewLease(lease, transaction = undefined) {
    const update = async () => {
      const current = await this.readLease(lease.buildKey);
      if (!current || current.owner !== lease.owner) return false;
      const now = Date.now();
      const renewed = {
        ...current,
        heartbeatAt: new Date(now).toISOString(),
        expiresAt: new Date(now + this.leaseDurationMs).toISOString(),
        transaction: transaction === undefined ? current.transaction : transaction,
      };
      // This directory has one owner. In-place renewal avoids Windows rename-over-existing
      // failures; readers treat a transient partial document as a fresh, unexpired lease.
      await writeFile(path.join(lease.directory, "lease.json"), stableJson(renewed), "utf8");
      return true;
    };
    lease.renewal = (lease.renewal ?? Promise.resolve()).then(update, update);
    return lease.renewal;
  }

  startHeartbeat(lease) {
    lease.heartbeat = setInterval(() => {
      this.renewLease(lease).catch(() => {});
    }, Math.max(50, Math.floor(this.leaseDurationMs / 3)));
    lease.heartbeat.unref();
  }

  async releaseLease(lease) {
    if (!lease) return;
    if (lease.heartbeat) clearInterval(lease.heartbeat);
    await lease.renewal?.catch(() => {});
    const current = await this.readLease(lease.buildKey);
    if (current?.owner === lease.owner) await rm(lease.directory, { recursive: true, force: true });
  }

  async importFile(filePath, expectedHash = null) {
    const hash = await hashFile(filePath);
    invariant(!expectedHash || expectedHash === `sha256:${hash}`, "FPM_ARTIFACT_VERIFICATION_FAILED",
      "A staged artifact hash does not match the handler claim.", {
        claimedHash: expectedHash,
        actualHash: `sha256:${hash}`,
      });
    const objectPath = this.objectPath(hash);
    await mkdir(path.dirname(objectPath), { recursive: true });
    let created = false;
    try {
      await link(filePath, objectPath);
      created = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    if (!created) {
      invariant(await hashFile(objectPath) === hash, "FPM_STORE_OBJECT_CORRUPT",
        "An immutable store object exists at its hash path with different content.", {
          object: `sha256:${hash}`,
          path: objectPath,
        });
    }
    await rm(filePath, { force: true });
    return { hash: `sha256:${hash}`, storePath: objectPath };
  }

  async importContent(content, stagingDirectory) {
    const filePath = path.join(stagingDirectory, `.root-${randomUUID()}`);
    await writeFile(filePath, content);
    return this.importFile(filePath);
  }

  async publishTreeReference(namespace, identity, files, metadata = {}, options = {}) {
    invariant(files && typeof files === "object" && !Array.isArray(files)
      && Object.keys(files).length > 0, "FPM_TREE_EMPTY",
    "A referenced tree must contain at least one file.", { namespace, identity });
    const stagingDirectory = path.join(this.directory, "staging", randomUUID());
    await mkdir(stagingDirectory, { recursive: true });
    const entries = [];
    try {
      for (const relative of Object.keys(files).sort()) {
        invariant(relative.length > 0 && relative === relative.replaceAll("\\", "/")
          && !relative.startsWith("../") && !path.posix.isAbsolute(relative), "FPM_TREE_PATH_INVALID",
        "A referenced tree entry has an invalid relative path.", { namespace, identity, relative });
        const stagedPath = resolveInside(stagingDirectory, relative, "referenced tree entry");
        await mkdir(path.dirname(stagedPath), { recursive: true });
        const content = typeof files[relative] === "string" || Buffer.isBuffer(files[relative])
          ? files[relative] : stableJson(files[relative]);
        await writeFile(stagedPath, content);
        const size = (await stat(stagedPath)).size;
        const imported = await this.importFile(stagedPath);
        entries.push({ path: relative, kind: "blob", hash: imported.hash, size });
      }
      const manifestText = stableJson({ schema: "fpm.tree/1", entries });
      const importedRoot = await this.importContent(manifestText, stagingDirectory);
      const importedRoots = [...entries.map((entry) => entry.hash), importedRoot.hash];
      if (options.interruptBeforeReference) {
        throw new FpmError("FPM_SIMULATED_INTERRUPTION",
          "The test fixture interrupted publication after object import and before reference commit.", {
            namespace,
            identity,
            importedRoots,
          });
      }
      const record = {
        schema: "fpm.artifact-reference/1",
        namespace,
        identity,
        root: {
          kind: "tree",
          hash: importedRoot.hash,
          size: Buffer.byteLength(manifestText),
          totalSize: entries.reduce((sum, entry) => sum + entry.size, 0),
        },
        metadata,
      };
      const recordPath = this.referencePath(namespace, identity);
      if (await writeCreateOnly(recordPath, stableJson(record))) return record;
      let existing;
      try {
        existing = JSON.parse(await readFile(recordPath, "utf8"));
      } catch (error) {
        throw new FpmError("FPM_ARTIFACT_REFERENCE_INVALID", "An existing artifact reference is unreadable.", {
          namespace, identity, cause: error.message,
        });
      }
      invariant(existing.schema === "fpm.artifact-reference/1" && existing.namespace === namespace
        && existing.identity === identity && existing.root?.hash === record.root.hash,
      "FPM_ARTIFACT_REFERENCE_CONFLICT",
      "One immutable artifact reference identity cannot publish two different roots.", {
        namespace,
        identity,
        existingRoot: existing.root?.hash ?? null,
        proposedRoot: record.root.hash,
      });
      return existing;
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  }

  async readTreeReference(namespace, identity) {
    const recordPath = this.referencePath(namespace, identity);
    let record;
    try {
      record = JSON.parse(await readFile(recordPath, "utf8"));
    } catch (error) {
      throw new FpmError("FPM_ARTIFACT_REFERENCE_MISSING", "A requested artifact reference does not exist.", {
        namespace, identity, cause: error.message,
      });
    }
    invariant(record.schema === "fpm.artifact-reference/1" && record.namespace === namespace
      && record.identity === identity && record.root?.kind === "tree" && await this.verifyRoot(record.root),
    "FPM_ARTIFACT_REFERENCE_INVALID", "A requested artifact reference or its tree is invalid.", {
      namespace, identity,
    });
    const rootHash = HASH.exec(record.root.hash)?.[1];
    const manifest = JSON.parse(await readFile(this.objectPath(rootHash), "utf8"));
    const files = {};
    for (const entry of manifest.entries) {
      const hash = HASH.exec(entry.hash)?.[1];
      invariant(hash, "FPM_TREE_MANIFEST_INVALID", "A referenced tree entry has an invalid hash.", { entry });
      files[entry.path] = await readFile(this.objectPath(hash), "utf8");
    }
    return { record, files };
  }

  async commitBlob(action, declaration, reported, stagingDirectory) {
    invariant(reported?.kind === "blob" && reported.type === declaration.type
      && reported.relativePath === declaration.fileName && Number.isInteger(reported.size)
      && typeof reported.hash === "string", "FPM_HANDLER_RESPONSE_INVALID",
    "An artifact action returned a malformed blob output manifest.", {
      action: action.id,
      output: declaration.name,
      reported,
    });
    const stagedPath = resolveInside(stagingDirectory, reported.relativePath, "staged artifact");
    let information;
    try {
      information = await stat(stagedPath);
    } catch (error) {
      throw new FpmError("FPM_ARTIFACT_VERIFICATION_FAILED", "A handler did not create its declared blob.", {
        action: action.id,
        output: declaration.name,
        cause: error.message,
      });
    }
    invariant(information.isFile() && information.size === reported.size, "FPM_ARTIFACT_VERIFICATION_FAILED",
      "A staged blob size does not match the handler claim.", {
        action: action.id,
        output: declaration.name,
        claimedSize: reported.size,
        actualSize: information.size,
      });
    const imported = await this.importFile(stagedPath, reported.hash);
    return {
      ...declaration,
      hash: imported.hash,
      size: information.size,
      storePath: imported.storePath,
      producedBy: action.id,
    };
  }

  async commitTree(action, declaration, reported, stagingDirectory) {
    invariant(reported?.kind === "tree" && reported.type === declaration.type
      && reported.relativePath === declaration.fileName, "FPM_HANDLER_RESPONSE_INVALID",
    "An artifact action returned a malformed tree output manifest.", {
      action: action.id,
      output: declaration.name,
      reported,
    });
    const treeDirectory = resolveInside(stagingDirectory, reported.relativePath, "staged tree");
    let information;
    try {
      information = await stat(treeDirectory);
    } catch (error) {
      throw new FpmError("FPM_ARTIFACT_VERIFICATION_FAILED", "A handler did not create its declared tree.", {
        action: action.id,
        output: declaration.name,
        cause: error.message,
      });
    }
    invariant(information.isDirectory(), "FPM_ARTIFACT_VERIFICATION_FAILED",
      "A declared tree artifact is not a directory.", { action: action.id, output: declaration.name });

    const entries = [];
    for (const filePath of await listFiles(treeDirectory)) {
      const relative = path.relative(treeDirectory, filePath).replaceAll("\\", "/");
      invariant(relative && !relative.startsWith("../") && !path.posix.isAbsolute(relative),
        "FPM_TREE_PATH_INVALID", "A tree entry has an invalid relative path.", { action: action.id, relative });
      const size = (await stat(filePath)).size;
      const imported = await this.importFile(filePath);
      entries.push({ path: relative, kind: "blob", hash: imported.hash, size });
    }
    invariant(entries.length > 0, "FPM_TREE_EMPTY", "A tree artifact must contain at least one file.", {
      action: action.id,
      output: declaration.name,
    });
    entries.sort((left, right) => left.path.localeCompare(right.path));
    const manifestText = stableJson({ schema: "fpm.tree/1", entries });
    const importedRoot = await this.importContent(manifestText, stagingDirectory);
    if (reported.hash) {
      invariant(reported.hash === importedRoot.hash, "FPM_ARTIFACT_VERIFICATION_FAILED",
        "A staged tree root hash does not match the handler claim.", {
          action: action.id,
          output: declaration.name,
          claimedHash: reported.hash,
          actualHash: importedRoot.hash,
        });
    }
    return {
      ...declaration,
      hash: importedRoot.hash,
      size: Buffer.byteLength(manifestText),
      totalSize: entries.reduce((sum, entry) => sum + entry.size, 0),
      entries,
      storePath: importedRoot.storePath,
      producedBy: action.id,
    };
  }

  async publishActionRecord(buildKey, action, roots, execution = null) {
    const record = {
      schema: "fpm.action-cache/2",
      buildKey: `sha256:${buildKey}`,
      action: action.id,
      execution,
      outputs: roots.map((root) => Object.fromEntries(
        Object.entries(root).filter(([key]) => !["storePath", "producedBy", "entries"].includes(key)),
      )),
    };
    const recordPath = this.actionRecordPath(buildKey);
    if (await writeCreateOnly(recordPath, stableJson(record))) return record;
    let existing;
    try {
      existing = JSON.parse(await readFile(recordPath, "utf8"));
    } catch (error) {
      throw new FpmError("FPM_ACTION_RECORD_INVALID", "An existing action record is unreadable.", {
        action: action.id,
        buildKey: `sha256:${buildKey}`,
        cause: error.message,
      });
    }
    invariant(existing.schema === "fpm.action-cache/2" && existing.buildKey === `sha256:${buildKey}`
      && existing.action === action.id && Array.isArray(existing.outputs), "FPM_ACTION_RECORD_INVALID",
    "An existing action record does not match its immutable build-key identity.", {
      action: action.id,
      buildKey: `sha256:${buildKey}`,
      existing,
    });
    const existingRoots = (existing.outputs ?? []).map((root) => ({ name: root.name, hash: root.hash })).sort((a, b) => a.name.localeCompare(b.name));
    const proposedRoots = record.outputs.map((root) => ({ name: root.name, hash: root.hash })).sort((a, b) => a.name.localeCompare(b.name));
    invariant(stableJson(existingRoots) === stableJson(proposedRoots), "FPM_ACTION_NONDETERMINISTIC",
      "Two executions produced different roots for the same build key.", {
        action: action.id,
        buildKey: `sha256:${buildKey}`,
        existing: existingRoots,
        proposed: proposedRoots,
      });
    return existing;
  }

  async execute(action, handler, inputs) {
    const outputs = normalizedOutputs(action);
    const environment = actionEnvironment(handler, this.environmentContext);
    const executionRecord = handlerExecutionRecord(handler);
    const keyDocument = portableAction(action, handler, inputs, outputs, environment, executionRecord);
    const buildKey = sha256(stableJson(keyDocument));
    const started = Date.now();
    let lease;
    while (!lease) {
      const cached = await this.cached(buildKey, action);
      if (cached) {
        return {
          artifacts: cached, buildKey: `sha256:${buildKey}`, cacheHit: true, environment, execution: executionRecord,
        };
      }
      lease = await this.tryAcquireLease(buildKey, action.id);
      if (!lease) {
        invariant(Date.now() - started < this.leaseTimeoutMs, "FPM_BUILD_LEASE_TIMEOUT",
          "Timed out waiting for another builder's build-key lease.", {
            action: action.id,
            buildKey: `sha256:${buildKey}`,
          });
        await wait(this.leasePollMs);
      }
    }
    this.startHeartbeat(lease);

    const afterLeaseCache = await this.cached(buildKey, action);
    if (afterLeaseCache) {
      await this.releaseLease(lease);
      return {
        artifacts: afterLeaseCache,
        buildKey: `sha256:${buildKey}`,
        cacheHit: true,
        environment,
        execution: executionRecord,
      };
    }

    const transactionId = randomUUID();
    const stagingDirectory = path.join(this.directory, "staging", transactionId);
    await mkdir(stagingDirectory, { recursive: true });
    await this.renewLease(lease, transactionId);
    try {
      const response = invokeHandler(handler, {
        protocol: "fpm.handler-request/1",
        action: "materialize",
        transaction: {
          id: transactionId,
          stagingDirectory,
          outputs: outputs.map((output) => ({
            name: output.name,
            kind: output.kind,
            relativePath: output.fileName,
            type: output.type,
          })),
        },
        inputs: inputs.map((input) => ({
          name: input.name,
          artifact: input.artifact,
          kind: input.resolved.kind,
          type: input.resolved.type,
          hash: input.resolved.hash,
          path: input.resolved.storePath,
        })),
        environment,
        proposal: {
          id: action.id,
          kind: action.kind,
          parameters: action.parameters ?? {},
          context: action.context ?? {},
        },
      });
      const reportedOutputs = response.outputs ?? (response.output ? [{ name: "primary", kind: "blob", ...response.output }] : []);
      invariant(reportedOutputs.length === outputs.length, "FPM_HANDLER_RESPONSE_INVALID",
        "An artifact action did not report every declared output root.", {
          action: action.id,
          declared: outputs.map((output) => output.name),
          reported: reportedOutputs.map((output) => output.name),
        });
      const roots = [];
      for (const declaration of outputs) {
        const reported = reportedOutputs.find((entry) => entry.name === declaration.name);
        roots.push(declaration.kind === "tree"
          ? await this.commitTree(action, declaration, reported, stagingDirectory)
          : await this.commitBlob(action, declaration, reported, stagingDirectory));
      }
      if (this.interruptAfterImportAction === action.id) {
        throw new FpmError("FPM_SIMULATED_INTERRUPTION",
          "The test fixture interrupted the build after object import and before action-record publication.", {
            action: action.id,
            buildKey: `sha256:${buildKey}`,
            importedRoots: roots.map((root) => root.hash),
          });
      }
      await this.publishActionRecord(buildKey, action, roots, response.managerExecution);
      return {
        artifacts: roots,
        buildKey: `sha256:${buildKey}`,
        cacheHit: false,
        environment,
        execution: response.managerExecution,
      };
    } catch (error) {
      if (error instanceof FpmError) {
        error.details = { ...error.details, action: action.id, buildKey: `sha256:${buildKey}` };
      }
      throw error;
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true });
      await this.releaseLease(lease);
    }
  }

  async exportArtifact(artifact, destination) {
    if (artifact.kind === "blob") {
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(artifact.storePath, destination);
      return;
    }
    invariant(artifact.kind === "tree", "FPM_ARTIFACT_KIND_UNSUPPORTED",
      "Cannot export an unsupported artifact root kind.", { artifact: artifact.id, kind: artifact.kind });
    const manifest = JSON.parse(await readFile(artifact.storePath, "utf8"));
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });
    for (const entry of manifest.entries) {
      const target = resolveInside(destination, entry.path, "tree export entry");
      await mkdir(path.dirname(target), { recursive: true });
      const hash = HASH.exec(entry.hash)?.[1];
      invariant(hash, "FPM_TREE_MANIFEST_INVALID", "A tree manifest entry has an invalid hash.", { entry });
      await copyFile(this.objectPath(hash), target);
    }
  }

  async reachabilityReport(pinnedHashes = []) {
    const roots = new Set(pinnedHashes.map((hash) => hash.replace(/^sha256:/, "")));
    const invalidActionRecords = [];
    const invalidReferences = [];
    const actionsDirectory = path.join(this.directory, "actions");
    if (await exists(actionsDirectory)) {
      for (const entry of await readdir(actionsDirectory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        try {
          const record = JSON.parse(await readFile(path.join(actionsDirectory, entry.name), "utf8"));
          if (record.schema !== "fpm.action-cache/2" || !Array.isArray(record.outputs)) throw new Error("unsupported record");
          for (const output of record.outputs) {
            const hash = HASH.exec(output.hash ?? "")?.[1];
            if (hash) roots.add(hash);
          }
        } catch {
          invalidActionRecords.push(entry.name);
        }
      }
    }

    const referencesDirectory = path.join(this.directory, "references");
    if (await exists(referencesDirectory)) {
      for (const namespace of await readdir(referencesDirectory, { withFileTypes: true })) {
        if (!namespace.isDirectory()) continue;
        for (const entry of await readdir(path.join(referencesDirectory, namespace.name), { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
          try {
            const record = JSON.parse(await readFile(path.join(referencesDirectory, namespace.name, entry.name), "utf8"));
            const hash = HASH.exec(record.root?.hash ?? "")?.[1];
            if (record.schema !== "fpm.artifact-reference/1" || record.namespace !== namespace.name || !hash) {
              throw new Error("unsupported reference");
            }
            roots.add(hash);
          } catch {
            invalidReferences.push(`${namespace.name}/${entry.name}`);
          }
        }
      }
    }

    const reachable = new Set();
    const queue = [...roots];
    while (queue.length > 0) {
      const hash = queue.shift();
      if (reachable.has(hash)) continue;
      reachable.add(hash);
      const objectPath = this.objectPath(hash);
      if (!await exists(objectPath)) continue;
      try {
        const manifest = JSON.parse(await readFile(objectPath, "utf8"));
        if (manifest.schema === "fpm.tree/1" && Array.isArray(manifest.entries)) {
          for (const entry of manifest.entries) {
            const child = HASH.exec(entry.hash ?? "")?.[1];
            if (child) queue.push(child);
          }
        }
      } catch {
        // Blob roots are expected not to parse as tree manifests.
      }
    }

    const objects = [];
    const objectsDirectory = path.join(this.directory, "objects");
    if (await exists(objectsDirectory)) {
      for (const prefix of await readdir(objectsDirectory, { withFileTypes: true })) {
        if (!prefix.isDirectory() || !/^[0-9a-f]{2}$/.test(prefix.name)) continue;
        for (const object of await readdir(path.join(objectsDirectory, prefix.name), { withFileTypes: true })) {
          if (object.isFile() && /^[0-9a-f]{62}$/.test(object.name)) objects.push(`${prefix.name}${object.name}`);
        }
      }
    }
    objects.sort();
    const orphaned = objects.filter((hash) => !reachable.has(hash));
    return {
      schema: "fpm.reachability-report/1",
      store: this.directory,
      roots: [...roots].sort().map((hash) => `sha256:${hash}`),
      objectCount: objects.length,
      reachableCount: objects.length - orphaned.length,
      orphaned: orphaned.map((hash) => `sha256:${hash}`),
      invalidActionRecords: invalidActionRecords.sort(),
      invalidReferences: invalidReferences.sort(),
      destructive: false,
    };
  }
}

export async function executeArtifactGraph(actions, handlers, store) {
  const actionById = new Map();
  const producerByArtifact = new Map();
  for (const action of actions) {
    invariant(!actionById.has(action.id), "FPM_ACTION_ID_DUPLICATE", "Two artifact actions share an identity.", {
      action: action.id,
    });
    actionById.set(action.id, action);
    for (const output of normalizedOutputs(action)) {
      invariant(!producerByArtifact.has(output.id), "FPM_ARTIFACT_ID_DUPLICATE",
        "Two artifact actions produce the same artifact identity.", { artifact: output.id });
      producerByArtifact.set(output.id, action);
    }
  }

  const state = new Map();
  const ordered = [];
  const stack = [];
  function visit(action) {
    const current = state.get(action.id);
    if (current === "done") return;
    if (current === "visiting") {
      const start = stack.indexOf(action.id);
      throw new FpmError("FPM_ARTIFACT_CYCLE", "Artifact actions contain a dependency cycle.", {
        cycle: [...stack.slice(start), action.id],
      });
    }
    state.set(action.id, "visiting");
    stack.push(action.id);
    for (const input of action.inputs ?? []) {
      const producer = producerByArtifact.get(input.artifact);
      invariant(producer, "FPM_ARTIFACT_INPUT_MISSING", "An artifact action input has no producer.", {
        action: action.id,
        input: input.name,
        artifact: input.artifact,
      });
      visit(producer);
    }
    stack.pop();
    state.set(action.id, "done");
    ordered.push(action);
  }
  for (const action of [...actions].sort((left, right) => left.id.localeCompare(right.id))) visit(action);

  const artifacts = new Map();
  const records = [];
  let cacheHits = 0;
  let cacheMisses = 0;
  for (const action of ordered) {
    const handler = handlers.get(action.handler);
    invariant(handler, "FPM_ACTION_HANDLER_MISSING", "An artifact action names an unavailable handler.", {
      action: action.id,
      handler: action.handler,
    });
    const resolvedInputs = (action.inputs ?? []).map((input) => ({ ...input, resolved: artifacts.get(input.artifact) }));
    const execution = await store.execute(action, handler, resolvedInputs);
    for (const artifact of execution.artifacts) artifacts.set(artifact.id, artifact);
    if (execution.cacheHit) cacheHits += 1;
    else cacheMisses += 1;
    records.push({
      id: action.id,
      kind: action.kind,
      handler: action.handler,
      adapter: action.adapter ?? null,
      inputs: resolvedInputs.map((input) => ({
        name: input.name,
        artifact: input.artifact,
        kind: input.resolved.kind,
        type: input.resolved.type,
        hash: input.resolved.hash,
      })),
      outputs: execution.artifacts.map((artifact) => ({
        name: artifact.name,
        id: artifact.id,
        kind: artifact.kind,
        type: artifact.type,
        hash: artifact.hash,
        size: artifact.size,
        totalSize: artifact.totalSize,
      })),
      environment: execution.environment,
      execution: execution.execution,
      buildKey: execution.buildKey,
    });
  }
  return { artifacts, records, cacheHits, cacheMisses };
}
