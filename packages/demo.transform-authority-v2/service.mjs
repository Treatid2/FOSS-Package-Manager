// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

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

const serviceId = "service:demo.transform-authority-v2/1";
const stateSchema = "fgpm.demo.transform-state";
const vector = (value) => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
const numericScale = 1_000_000;

function microUnits(value, details) {
  const units = value * numericScale;
  if (!Number.isFinite(value) || !Number.isSafeInteger(units)) {
    fail("FGPM_RUNTIME_TRANSFORM_NUMERIC_INVALID",
      "A transform value is outside the exact six-decimal fixed-point model.", {
        ...details, value, scale: numericScale, mutationCommitted: false,
      });
  }
  return Object.is(units, -0) ? 0 : units;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function root(value) {
  return `sha256:${createHash("sha256").update(`${JSON.stringify(stable(value), null, 2)}\n`).digest("hex")}`;
}

export function createService() {
  const transforms = new Map();
  const leases = new Map();
  let revision = 0;
  let lastCheckpoint = null;
  let instances;
  let materialisations;

  function release(instanceId) {
    const lease = leases.get(instanceId);
    if (!lease) return;
    try {
      materialisations.release(lease.id);
    } catch (error) {
      if (error?.code !== "FGPM_RUNTIME_LEASE_INVALID" && error?.code !== "FGPM_RUNTIME_INSTANCE_MISSING") throw error;
    }
    leases.delete(instanceId);
  }

  function materialise(instanceId) {
    if (!instances.exists(instanceId)) fail("FGPM_RUNTIME_INSTANCE_MISSING", "A transform target is absent.", { instanceId });
    if (!leases.has(instanceId)) leases.set(instanceId, materialisations.acquire(instanceId, serviceId));
    return leases.get(instanceId).handle;
  }

  function snapshot() {
    return freeze({
      schema: "fgpm.transform-snapshot/1",
      revision,
      transforms: [...transforms.entries()].filter(([instanceId]) => instances.exists(instanceId))
        .map(([instanceId, entry]) => ({ instanceId, translation: [...entry.translation], revision: entry.revision }))
        .sort((left, right) => left.instanceId.localeCompare(right.instanceId)),
    });
  }

  function capture(checkpoint) {
    const current = snapshot();
    return freeze({
      protocol: "fgpm.state-fragment/1",
      semanticSchema: stateSchema,
      schemaVersion: 2,
      checkpoint: structuredClone(checkpoint),
      stateRevision: current.revision,
      payload: {
        entries: current.transforms.map((entry) => ({
          instanceId: entry.instanceId,
          offset: { x: entry.translation[0], y: entry.translation[1], z: entry.translation[2] },
          revision: entry.revision,
        })),
      },
    });
  }

  function restore(fragment) {
    if (fragment?.protocol !== "fgpm.state-fragment/1" || fragment.semanticSchema !== stateSchema
      || fragment.schemaVersion !== 2 || !Array.isArray(fragment.payload?.entries)) {
      fail("FGPM_STATE_FRAGMENT_UNSUPPORTED", "Transform Authority v2 cannot restore the supplied fragment.");
    }
    transforms.clear();
    for (const entry of fragment.payload.entries) {
      const translation = [entry.offset?.x, entry.offset?.y, entry.offset?.z];
      if (!instances.exists(entry.instanceId) || !vector(translation) || !Number.isInteger(entry.revision)) {
        fail("FGPM_STATE_FRAGMENT_INVALID", "A v2 transform-state entry is invalid.", { entry });
      }
      transforms.set(entry.instanceId, { translation, revision: entry.revision });
      materialise(entry.instanceId);
    }
    revision = fragment.stateRevision;
    lastCheckpoint = null;
    return freeze({ semanticSchema: stateSchema, schemaVersion: 2, restoredRevision: revision });
  }

  function commitBatch(batch) {
    if (batch?.schema !== "fgpm.transform-command-batch/1" || batch.channel !== "runtime.transforms.commands"
      || batch.checkpoint?.schema !== "fgpm.runtime-tick/1" || !Number.isInteger(batch.expectedRevision)
      || !Array.isArray(batch.buffers) || batch.composition?.form !== "ordered"
      || !Array.isArray(batch.composition.order)) {
      fail("FGPM_RUNTIME_TRANSFORM_BATCH_INVALID", "A transform command batch is malformed.", { batch });
    }
    if (batch.expectedRevision !== revision || (lastCheckpoint && batch.checkpoint.tick <= lastCheckpoint.tick)) {
      fail("FGPM_TRANSFORM_BATCH_STALE", "Transform Authority v2 rejected output for a stale checkpoint.", {
        checkpoint: batch.checkpoint,
        lastCheckpoint,
        expectedRevision: batch.expectedRevision,
        currentRevision: revision,
      });
    }
    const position = new Map(batch.composition.order.map((task, index) => [task, index]));
    let previous = -1;
    const staged = new Map([...transforms.entries()].map(([instanceId, entry]) => [instanceId, {
      translation: [...entry.translation], revision: entry.revision,
    }]));
    const touched = new Set();
    for (const buffer of batch.buffers) {
      const { root: declaredRoot, ...content } = buffer;
      if (buffer?.schema !== "fgpm.runtime-command-buffer/1" || buffer.channel !== batch.channel
        || JSON.stringify(buffer.checkpoint) !== JSON.stringify(batch.checkpoint)
        || !position.has(buffer.task) || position.get(buffer.task) <= previous
        || declaredRoot !== root(content) || !Array.isArray(buffer.commands)) {
        fail("FGPM_RUNTIME_TRANSFORM_BATCH_INVALID", "A staged transform command buffer is incoherent.", {
          task: buffer?.task ?? null,
        });
      }
      previous = position.get(buffer.task);
      for (const command of buffer.commands) {
        const axis = { x: 0, y: 1, z: 2 }[command?.axis];
        const target = staged.get(command?.instanceId);
        if (command?.schema !== "fgpm.transform-operation/1" || !["set-axis", "add-axis"].includes(command.operation)
          || axis === undefined || !Number.isFinite(command.value) || !target || !instances.exists(command.instanceId)) {
          fail("FGPM_RUNTIME_TRANSFORM_COMMAND_INVALID", "A staged transform operation is malformed.", {
            task: buffer.task,
            command,
          });
        }
        const operationUnits = microUnits(command.value, { task: buffer.task, command });
        const currentUnits = microUnits(target.translation[axis], { task: buffer.task,
          instanceId: command.instanceId, axis: command.axis, current: true });
        const nextUnits = command.operation === "set-axis" ? operationUnits : currentUnits + operationUnits;
        if (!Number.isSafeInteger(nextUnits)) {
          fail("FGPM_RUNTIME_TRANSFORM_NUMERIC_OVERFLOW",
            "A transform operation overflows the exact six-decimal fixed-point model.", {
              task: buffer.task, command, scale: numericScale, mutationCommitted: false,
            });
        }
        const normalized = nextUnits / numericScale;
        target.translation[axis] = Object.is(normalized, -0) ? 0 : normalized;
        touched.add(command.instanceId);
      }
    }
    const inputRevision = revision;
    revision += 1;
    for (const instanceId of touched) staged.get(instanceId).revision = revision;
    transforms.clear();
    for (const [instanceId, entry] of staged) transforms.set(instanceId, entry);
    lastCheckpoint = structuredClone(batch.checkpoint);
    const current = snapshot();
    return freeze({ schema: "fgpm.transform-batch-commit/1", authority: serviceId,
      checkpoint: structuredClone(batch.checkpoint), inputRevision, revision,
      appliedBuffers: batch.buffers.map((entry) => entry.root), stateRoot: root(current) });
  }

  return {
    async activate(context) {
      instances = context.require("runtime.instances.read");
      materialisations = context.require("runtime.instances.materialize");
      for (const instance of instances.list()) {
        transforms.set(instance.instanceId, { translation: [0, 0, 0], revision: 0 });
        materialise(instance.instanceId);
      }
      return {
        protocol: "fgpm.runtime-service-response/1",
        capabilities: {
          "runtime.transforms.read": freeze({ snapshot }),
          "runtime.transforms.write": freeze({
            submit: (command) => {
              if (!vector(command?.translation) || !instances.exists(command.instanceId)) {
                fail("FGPM_RUNTIME_TRANSFORM_COMMAND_INVALID", "A transform command is malformed.", { command });
              }
              revision += 1;
              transforms.set(command.instanceId, { translation: [...command.translation], revision });
              return freeze({ schema: "fgpm.transform-commit/1", authority: serviceId,
                instanceId: command.instanceId, revision, translation: [...command.translation] });
            },
            commitBatch,
            materialise,
            releaseMaterialisation: (instanceId) => {
              const existed = leases.has(instanceId);
              release(instanceId);
              return existed;
            },
          }),
          "runtime.state.owner": freeze({
            protocol: "fgpm.state-owner/1",
            semanticSchema: stateSchema,
            schemaVersion: 2,
            required: true,
            governingCapability: "runtime.transforms.write",
            provider: serviceId,
            dependsOn: ["fgpm.demo.instance-state"],
            capture,
            prepareRestore: () => {
              for (const instanceId of [...leases.keys()]) release(instanceId);
            },
            restore,
          }),
        },
      };
    },
    async deactivate() {
      for (const instanceId of [...leases.keys()]) release(instanceId);
      transforms.clear();
      revision = 0;
      lastCheckpoint = null;
    },
  };
}
