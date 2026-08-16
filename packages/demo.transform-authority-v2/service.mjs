// SPDX-License-Identifier: Apache-2.0

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
const stateSchema = "fpm.demo.transform-state";
const vector = (value) => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);

export function createService() {
  const transforms = new Map();
  const leases = new Map();
  let revision = 0;
  let instances;
  let materialisations;

  function release(instanceId) {
    const lease = leases.get(instanceId);
    if (!lease) return;
    try {
      materialisations.release(lease.id);
    } catch (error) {
      if (error?.code !== "FPM_RUNTIME_LEASE_INVALID" && error?.code !== "FPM_RUNTIME_INSTANCE_MISSING") throw error;
    }
    leases.delete(instanceId);
  }

  function materialise(instanceId) {
    if (!instances.exists(instanceId)) fail("FPM_RUNTIME_INSTANCE_MISSING", "A transform target is absent.", { instanceId });
    if (!leases.has(instanceId)) leases.set(instanceId, materialisations.acquire(instanceId, serviceId));
    return leases.get(instanceId).handle;
  }

  function snapshot() {
    return freeze({
      schema: "fpm.transform-snapshot/1",
      revision,
      transforms: [...transforms.entries()].filter(([instanceId]) => instances.exists(instanceId))
        .map(([instanceId, entry]) => ({ instanceId, translation: [...entry.translation], revision: entry.revision }))
        .sort((left, right) => left.instanceId.localeCompare(right.instanceId)),
    });
  }

  function capture(checkpoint) {
    const current = snapshot();
    return freeze({
      protocol: "fpm.state-fragment/1",
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
    if (fragment?.protocol !== "fpm.state-fragment/1" || fragment.semanticSchema !== stateSchema
      || fragment.schemaVersion !== 2 || !Array.isArray(fragment.payload?.entries)) {
      fail("FPM_STATE_FRAGMENT_UNSUPPORTED", "Transform Authority v2 cannot restore the supplied fragment.");
    }
    transforms.clear();
    for (const entry of fragment.payload.entries) {
      const translation = [entry.offset?.x, entry.offset?.y, entry.offset?.z];
      if (!instances.exists(entry.instanceId) || !vector(translation) || !Number.isInteger(entry.revision)) {
        fail("FPM_STATE_FRAGMENT_INVALID", "A v2 transform-state entry is invalid.", { entry });
      }
      transforms.set(entry.instanceId, { translation, revision: entry.revision });
      materialise(entry.instanceId);
    }
    revision = fragment.stateRevision;
    return freeze({ semanticSchema: stateSchema, schemaVersion: 2, restoredRevision: revision });
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
        protocol: "fpm.runtime-service-response/1",
        capabilities: {
          "runtime.transforms.read": freeze({ snapshot }),
          "runtime.transforms.write": freeze({
            submit: (command) => {
              if (!vector(command?.translation) || !instances.exists(command.instanceId)) {
                fail("FPM_RUNTIME_TRANSFORM_COMMAND_INVALID", "A transform command is malformed.", { command });
              }
              revision += 1;
              transforms.set(command.instanceId, { translation: [...command.translation], revision });
              return freeze({ schema: "fpm.transform-commit/1", authority: serviceId,
                instanceId: command.instanceId, revision, translation: [...command.translation] });
            },
            materialise,
            releaseMaterialisation: (instanceId) => {
              const existed = leases.has(instanceId);
              release(instanceId);
              return existed;
            },
          }),
          "runtime.state.owner": freeze({
            protocol: "fpm.state-owner/1",
            semanticSchema: stateSchema,
            schemaVersion: 2,
            required: true,
            governingCapability: "runtime.transforms.write",
            provider: serviceId,
            dependsOn: ["fpm.demo.instance-state"],
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
    },
  };
}
