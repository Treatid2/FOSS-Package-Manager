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

export function createService() {
  const transforms = new Map();
  const leases = new Map();
  let revision = 0;
  let instances;
  let materialisations;

  function state(instanceId) {
    const selected = transforms.get(instanceId);
    if (!selected) fail("FPM_RUNTIME_INSTANCE_MISSING", "Transform authority has no state for an instance.", { instanceId });
    return selected;
  }

  function materialise(instanceId) {
    state(instanceId);
    if (!leases.has(instanceId)) {
      leases.set(instanceId, materialisations.acquire(instanceId, "service:demo.transform-authority/1"));
    }
    return leases.get(instanceId).handle;
  }

  function releaseMaterialisation(instanceId) {
    const lease = leases.get(instanceId);
    if (!lease) return false;
    materialisations.release(lease.id);
    leases.delete(instanceId);
    return true;
  }

  return {
    async activate(context) {
      instances = context.require("runtime.instances.read");
      materialisations = context.require("runtime.instances.materialize");
      for (const instance of instances.list()) {
        transforms.set(instance.instanceId, { translation: [0, 0, 0], revision: 0 });
        materialise(instance.instanceId);
      }
      const read = freeze({
        snapshot: () => freeze({
          schema: "fpm.transform-snapshot/1",
          revision,
          transforms: [...transforms.entries()].map(([instanceId, transform]) => ({
            instanceId,
            translation: [...transform.translation],
            revision: transform.revision,
          })).sort((left, right) => left.instanceId.localeCompare(right.instanceId)),
        }),
      });
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
            authority: "service:demo.transform-authority/1",
            instanceId: command.instanceId,
            revision,
            translation: [...selected.translation],
          });
        },
        materialise,
        releaseMaterialisation,
      });
      return {
        protocol: "fpm.runtime-service-response/1",
        capabilities: {
          "runtime.transforms.read": read,
          "runtime.transforms.write": write,
        },
      };
    },
    async deactivate() {
      for (const instanceId of [...leases.keys()]) releaseMaterialisation(instanceId);
      transforms.clear();
    },
  };
}
