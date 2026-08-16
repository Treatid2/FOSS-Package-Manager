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

function validVector(value) {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}

const serviceId = "service:demo.transform-authority/1";
const stateSchema = "fpm.demo.transform-state";

export function createService() {
  const transforms = new Map();
  const leases = new Map();
  let revision = 0;
  let instances;
  let materialisations;

  function state(instanceId) {
    const selected = transforms.get(instanceId);
    if (!selected || !instances.exists(instanceId)) {
      fail("FPM_RUNTIME_INSTANCE_MISSING", "Transform authority has no state for an instance.", { instanceId });
    }
    return selected;
  }

  function materialise(instanceId) {
    state(instanceId);
    if (!leases.has(instanceId)) leases.set(instanceId, materialisations.acquire(instanceId, serviceId));
    return leases.get(instanceId).handle;
  }

  function releaseMaterialisation(instanceId) {
    const lease = leases.get(instanceId);
    if (!lease) return false;
    try {
      materialisations.release(lease.id);
    } catch (error) {
      if (error?.code !== "FPM_RUNTIME_LEASE_INVALID" && error?.code !== "FPM_RUNTIME_INSTANCE_MISSING") throw error;
    }
    leases.delete(instanceId);
    return true;
  }

  function snapshot() {
    return freeze({
      schema: "fpm.transform-snapshot/1",
      revision,
      transforms: [...transforms.entries()].filter(([instanceId]) => instances.exists(instanceId))
        .map(([instanceId, transform]) => ({
          instanceId,
          translation: [...transform.translation],
          revision: transform.revision,
        })).sort((left, right) => left.instanceId.localeCompare(right.instanceId)),
    });
  }

  function capture(checkpoint) {
    const current = snapshot();
    return freeze({
      protocol: "fpm.state-fragment/1",
      semanticSchema: stateSchema,
      schemaVersion: 1,
      checkpoint: structuredClone(checkpoint),
      stateRevision: current.revision,
      payload: { transforms: current.transforms.map((entry) => structuredClone(entry)) },
    });
  }

  function prepareRestore() {
    for (const instanceId of [...leases.keys()]) releaseMaterialisation(instanceId);
  }

  function restore(fragment) {
    if (fragment?.protocol !== "fpm.state-fragment/1" || fragment.semanticSchema !== stateSchema
      || fragment.schemaVersion !== 1 || !Array.isArray(fragment.payload?.transforms)) {
      fail("FPM_STATE_FRAGMENT_UNSUPPORTED", "Transform Authority cannot restore the supplied state fragment.", {
        expectedSchema: stateSchema,
        expectedVersion: 1,
        actualSchema: fragment?.semanticSchema ?? null,
        actualVersion: fragment?.schemaVersion ?? null,
      });
    }
    transforms.clear();
    for (const entry of fragment.payload.transforms) {
      if (!instances.exists(entry.instanceId) || !validVector(entry.translation)
        || !Number.isInteger(entry.revision)) {
        fail("FPM_STATE_FRAGMENT_INVALID", "A transform-state entry is invalid for the restored world.", { entry });
      }
      transforms.set(entry.instanceId, { translation: [...entry.translation], revision: entry.revision });
    }
    const missing = instances.list().map((entry) => entry.instanceId)
      .filter((instanceId) => !transforms.has(instanceId));
    if (missing.length > 0) {
      fail("FPM_STATE_FRAGMENT_INCOMPLETE", "The transform-state fragment omits live world instances.", { missing });
    }
    revision = fragment.stateRevision;
    for (const instanceId of transforms.keys()) materialise(instanceId);
    return freeze({ semanticSchema: stateSchema, schemaVersion: 1, restoredRevision: revision });
  }

  return {
    async activate(context) {
      instances = context.require("runtime.instances.read");
      materialisations = context.require("runtime.instances.materialize");
      for (const instance of instances.list()) {
        transforms.set(instance.instanceId, { translation: [0, 0, 0], revision: 0 });
        materialise(instance.instanceId);
      }
      const read = freeze({ snapshot });
      const write = freeze({
        submit: (command) => {
          if (command?.schema !== "fpm.transform-command/1" || typeof command.instanceId !== "string"
            || !validVector(command.translation)) {
            fail("FPM_RUNTIME_TRANSFORM_COMMAND_INVALID", "A transform command is malformed.", { command });
          }
          const selected = state(command.instanceId);
          revision += 1;
          selected.translation = [...command.translation];
          selected.revision = revision;
          return freeze({
            schema: "fpm.transform-commit/1",
            authority: serviceId,
            instanceId: command.instanceId,
            revision,
            translation: [...selected.translation],
          });
        },
        materialise,
        releaseMaterialisation,
      });
      const stateOwner = freeze({
        protocol: "fpm.state-owner/1",
        semanticSchema: stateSchema,
        schemaVersion: 1,
        required: true,
        governingCapability: "runtime.transforms.write",
        provider: serviceId,
        dependsOn: ["fpm.demo.instance-state"],
        capture,
        prepareRestore,
        restore,
      });
      return {
        protocol: "fpm.runtime-service-response/1",
        capabilities: {
          "runtime.transforms.read": read,
          "runtime.transforms.write": write,
          "runtime.transforms.state": stateOwner,
        },
      };
    },
    async deactivate() {
      for (const instanceId of [...leases.keys()]) releaseMaterialisation(instanceId);
      transforms.clear();
      revision = 0;
    },
  };
}
