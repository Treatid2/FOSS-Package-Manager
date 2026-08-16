// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

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

function root(value) {
  return `sha256:${createHash("sha256").update(`${JSON.stringify(stable(value), null, 2)}\n`).digest("hex")}`;
}

export function createService() {
  const transforms = new Map();
  let revision = 0;
  let lastCheckpoint = null;
  return {
    async activate(context) {
      const instances = context.require("runtime.instances.read");
      for (const instance of instances.list()) {
        transforms.set(instance.instanceId, { translation: [0, 0, 0], revision: 0 });
      }
      const snapshot = () => freeze({
        schema: "fpm.transform-snapshot/1",
        revision,
        transforms: [...transforms.entries()].map(([instanceId, value]) => ({
          instanceId,
          translation: [...value.translation],
          revision: value.revision,
        })).sort((left, right) => left.instanceId.localeCompare(right.instanceId)),
      });
      const commitBatch = (batch) => {
        if (batch?.schema !== "fpm.transform-command-batch/1" || batch.channel !== "runtime.transforms.commands"
          || batch.checkpoint?.schema !== "fpm.runtime-tick/1" || batch.expectedRevision !== revision
          || !Array.isArray(batch.buffers) || batch.composition?.form !== "ordered"
          || (lastCheckpoint && batch.checkpoint.tick <= lastCheckpoint.tick)) {
          throw Object.assign(new Error("Alternative Transform Authority rejected an invalid or stale batch."), {
            code: batch?.expectedRevision === revision ? "FPM_RUNTIME_TRANSFORM_BATCH_INVALID" : "FPM_TRANSFORM_BATCH_STALE",
            details: { expectedRevision: batch?.expectedRevision, currentRevision: revision },
          });
        }
        const position = new Map(batch.composition.order.map((task, index) => [task, index]));
        let previous = -1;
        const staged = new Map([...transforms.entries()].map(([id, entry]) => [id, {
          translation: [...entry.translation], revision: entry.revision,
        }]));
        const touched = new Set();
        for (const buffer of batch.buffers) {
          const { root: declaredRoot, ...content } = buffer;
          if (declaredRoot !== root(content) || !position.has(buffer.task) || position.get(buffer.task) <= previous
            || JSON.stringify(buffer.checkpoint) !== JSON.stringify(batch.checkpoint)) {
            throw Object.assign(new Error("Alternative Transform Authority rejected an incoherent buffer."), {
              code: "FPM_RUNTIME_TRANSFORM_BATCH_INVALID", details: { task: buffer.task },
            });
          }
          previous = position.get(buffer.task);
          for (const command of buffer.commands) {
            const axis = { x: 0, y: 1, z: 2 }[command.axis];
            const target = staged.get(command.instanceId);
            if (axis === undefined || !target || !Number.isFinite(command.value)
              || !["set-axis", "add-axis"].includes(command.operation)) {
              throw Object.assign(new Error("Alternative Transform Authority rejected a command."), {
                code: "FPM_RUNTIME_TRANSFORM_COMMAND_INVALID", details: { command },
              });
            }
            target.translation[axis] = command.operation === "set-axis"
              ? command.value : target.translation[axis] + command.value;
            touched.add(command.instanceId);
          }
        }
        const inputRevision = revision;
        revision += 1;
        for (const id of touched) staged.get(id).revision = revision;
        transforms.clear();
        for (const [id, entry] of staged) transforms.set(id, entry);
        lastCheckpoint = structuredClone(batch.checkpoint);
        return freeze({ schema: "fpm.transform-batch-commit/1",
          authority: "service:bad.alternative-transform/1", checkpoint: structuredClone(batch.checkpoint),
          inputRevision, revision, appliedBuffers: batch.buffers.map((entry) => entry.root), stateRoot: root(snapshot()) });
      };
      return {
        protocol: "fpm.runtime-service-response/1",
        capabilities: {
          "runtime.transforms.read": freeze({ snapshot }),
          "runtime.transforms.write": freeze({
            submit: (command) => {
              const selected = transforms.get(command.instanceId);
              if (!selected) throw new Error("Unknown instance.");
              revision += 1;
              selected.translation = [...command.translation];
              selected.revision = revision;
              return freeze({ schema: "fpm.transform-commit/1", authority: "service:bad.alternative-transform/1",
                instanceId: command.instanceId, revision, translation: [...selected.translation] });
            },
            commitBatch,
          }),
          "runtime.state.owner": freeze({
            protocol: "fpm.state-owner/1",
            semanticSchema: "fpm.demo.transform-state",
            schemaVersion: 1,
            required: true,
            governingCapability: "runtime.transforms.write",
            provider: "service:bad.alternative-transform/1",
            dependsOn: ["fpm.demo.instance-state"],
            capture: (checkpoint) => freeze({
              protocol: "fpm.state-fragment/1",
              semanticSchema: "fpm.demo.transform-state",
              schemaVersion: 1,
              checkpoint: structuredClone(checkpoint),
              stateRevision: revision,
              payload: {
                transforms: [...transforms.entries()].map(([instanceId, value]) => ({
                  instanceId, translation: [...value.translation], revision: value.revision,
                })).sort((left, right) => left.instanceId.localeCompare(right.instanceId)),
              },
            }),
            prepareRestore: () => {},
            restore: (fragment) => {
              transforms.clear();
              for (const entry of fragment.payload.transforms) transforms.set(entry.instanceId, {
                translation: [...entry.translation], revision: entry.revision,
              });
              revision = fragment.stateRevision;
              lastCheckpoint = null;
              return freeze({ semanticSchema: fragment.semanticSchema, schemaVersion: 1,
                restoredRevision: revision });
            },
          }),
        },
      };
    },
    async deactivate() {
      transforms.clear();
      lastCheckpoint = null;
    },
  };
}
