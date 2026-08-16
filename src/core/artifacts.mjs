// SPDX-License-Identifier: MPL-2.0

import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { FpmError, invariant } from "./errors.mjs";
import { invokeHandler } from "./handler.mjs";
import { hashFile, resolveInside, sha256, stableJson } from "./io.mjs";

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

function portableAction(action, handler, inputs, environmentKey) {
  return {
    schema: "fpm.action-key/1",
    id: action.id,
    kind: action.kind,
    handler: {
      id: handler.id,
      package: handler.owner.id,
      packageVersion: handler.owner.version,
      packageContentHash: `sha256:${handler.owner.contentHash}`,
    },
    sourcePackageHashes: [...(action.sourcePackageHashes ?? [])].sort(),
    parameters: action.parameters ?? {},
    inputs: inputs.map((input) => ({
      name: input.name,
      artifact: input.artifact,
      type: input.resolved.type,
      hash: input.resolved.hash,
    })),
    output: action.output,
    environmentKey,
  };
}

export class ArtifactStore {
  constructor(directory, environmentKey) {
    this.directory = path.resolve(directory);
    this.environmentKey = environmentKey;
  }

  actionRecordPath(buildKey) {
    return path.join(this.directory, "actions", `${buildKey}.json`);
  }

  objectPath(hash) {
    return path.join(this.directory, "objects", hash.slice(0, 2), hash.slice(2));
  }

  async cached(buildKey, action) {
    const recordPath = this.actionRecordPath(buildKey);
    if (!await exists(recordPath)) return null;
    try {
      const record = JSON.parse(await readFile(recordPath, "utf8"));
      if (record.schema !== "fpm.action-cache/1" || record.buildKey !== `sha256:${buildKey}`
        || record.action !== action.id || record.output?.id !== action.output.id
        || record.output.type !== action.output.type || record.output.fileName !== action.output.fileName
        || !/^sha256:[0-9a-f]{64}$/.test(record.output.hash ?? "")) return null;
      const hash = record.output.hash.replace(/^sha256:/, "");
      const storePath = this.objectPath(hash);
      if (!await exists(storePath) || await hashFile(storePath) !== hash) return null;
      return { ...record.output, storePath, producedBy: action.id };
    } catch {
      return null;
    }
  }

  async execute(action, handler, inputs) {
    const keyDocument = portableAction(action, handler, inputs, this.environmentKey);
    const buildKey = sha256(stableJson(keyDocument));
    const cached = await this.cached(buildKey, action);
    if (cached) return { artifact: cached, buildKey: `sha256:${buildKey}`, cacheHit: true };

    const transactionId = randomUUID();
    const stagingDirectory = path.join(this.directory, "staging", transactionId);
    await mkdir(stagingDirectory, { recursive: true });
    const relativePath = action.output.fileName;
    invariant(path.basename(relativePath) === relativePath, "FPM_ARTIFACT_PATH_INVALID",
      "An artifact action output must use a plain file name.", { action: action.id, fileName: relativePath });

    try {
      const response = invokeHandler(handler, {
        protocol: "fpm.handler-request/1",
        action: "materialize",
        transaction: {
          id: transactionId,
          stagingDirectory,
          outputs: [{ name: "primary", relativePath, type: action.output.type }],
        },
        inputs: inputs.map((input) => ({
          name: input.name,
          artifact: input.artifact,
          type: input.resolved.type,
          hash: input.resolved.hash,
          path: input.resolved.storePath,
        })),
        proposal: {
          id: action.id,
          kind: action.kind,
          parameters: action.parameters ?? {},
          context: action.context ?? {},
        },
      });
      const output = response.output;
      invariant(output?.type === action.output.type && output.relativePath === relativePath
        && typeof output.hash === "string" && Number.isInteger(output.size), "FPM_HANDLER_RESPONSE_INVALID",
      "An artifact action returned a malformed output manifest.", { action: action.id, handler: handler.id, output });

      const stagedPath = resolveInside(stagingDirectory, output.relativePath, "staged artifact");
      let information;
      try {
        information = await stat(stagedPath);
      } catch (error) {
        throw new FpmError("FPM_ARTIFACT_VERIFICATION_FAILED",
          "A handler did not create its declared staged artifact.", {
            action: action.id,
            relativePath: output.relativePath,
            cause: error.message,
          });
      }
      invariant(information.isFile() && information.size === output.size, "FPM_ARTIFACT_VERIFICATION_FAILED",
        "A staged artifact size does not match the handler claim.", {
          action: action.id,
          claimedSize: output.size,
          actualSize: information.size,
        });
      const actualHash = await hashFile(stagedPath);
      invariant(output.hash === `sha256:${actualHash}`, "FPM_ARTIFACT_VERIFICATION_FAILED",
        "A staged artifact hash does not match the handler claim.", {
          action: action.id,
          claimedHash: output.hash,
          actualHash: `sha256:${actualHash}`,
        });

      const objectPath = this.objectPath(actualHash);
      if (await exists(objectPath) && await hashFile(objectPath) !== actualHash) {
        await rm(objectPath, { force: true });
      }
      if (!await exists(objectPath)) {
        await mkdir(path.dirname(objectPath), { recursive: true });
        await rename(stagedPath, objectPath);
      }
      const artifact = {
        id: action.output.id,
        type: action.output.type,
        fileName: action.output.fileName,
        hash: `sha256:${actualHash}`,
        size: information.size,
        storePath: objectPath,
        producedBy: action.id,
      };
      const cacheRecord = {
        schema: "fpm.action-cache/1",
        buildKey: `sha256:${buildKey}`,
        action: action.id,
        output: Object.fromEntries(Object.entries(artifact).filter(([key]) => key !== "storePath")),
      };
      await writeAtomic(this.actionRecordPath(buildKey), stableJson(cacheRecord));
      return { artifact, buildKey: `sha256:${buildKey}`, cacheHit: false };
    } catch (error) {
      if (error instanceof FpmError) {
        error.details = { ...error.details, action: action.id, buildKey: `sha256:${buildKey}` };
      }
      throw error;
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  }
}

export async function executeArtifactGraph(actions, handlers, store) {
  const actionById = new Map();
  const producerByArtifact = new Map();
  for (const action of actions) {
    invariant(!actionById.has(action.id), "FPM_ACTION_ID_DUPLICATE", "Two artifact actions share an identity.", {
      action: action.id,
    });
    invariant(!producerByArtifact.has(action.output.id), "FPM_ARTIFACT_ID_DUPLICATE",
      "Two artifact actions produce the same artifact identity.", { artifact: action.output.id });
    actionById.set(action.id, action);
    producerByArtifact.set(action.output.id, action);
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
  for (const action of [...actions].sort((a, b) => a.id.localeCompare(b.id))) visit(action);

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
    const resolvedInputs = (action.inputs ?? []).map((input) => ({
      ...input,
      resolved: artifacts.get(input.artifact),
    }));
    const execution = await store.execute(action, handler, resolvedInputs);
    artifacts.set(execution.artifact.id, execution.artifact);
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
        type: input.resolved.type,
        hash: input.resolved.hash,
      })),
      output: {
        id: execution.artifact.id,
        type: execution.artifact.type,
        hash: execution.artifact.hash,
        size: execution.artifact.size,
      },
      buildKey: execution.buildKey,
    });
  }
  return { artifacts, records, cacheHits, cacheMisses };
}
