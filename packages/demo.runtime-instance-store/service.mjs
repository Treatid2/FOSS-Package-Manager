// SPDX-License-Identifier: Apache-2.0

function fail(code, message, details = {}) {
  throw Object.assign(new Error(message), { code, details });
}

function clone(value) {
  return structuredClone(value);
}

function frozen(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

const serviceId = "service:demo.runtime-instance-store/1";
const stateSchema = "fpm.demo.instance-state";

export function createService() {
  const persistent = new Map();
  const definitions = new Map();
  const destroyed = new Set();
  const slots = [];
  const generations = [];
  const leases = new Map();
  let nextLease = 1;
  let stateRevision = 0;

  function record(instanceId) {
    const selected = persistent.get(instanceId);
    if (!selected) fail("FPM_RUNTIME_INSTANCE_MISSING", "A persistent runtime instance does not exist.", { instanceId });
    return selected;
  }

  function clearMaterialisations() {
    leases.clear();
    slots.length = 0;
    for (const selected of persistent.values()) selected.materialization = null;
  }

  function resolve(handle) {
    if (!handle || handle.schema !== "fpm.runtime-handle/1" || !Number.isInteger(handle.slot)
      || !Number.isInteger(handle.generation)) {
      fail("FPM_RUNTIME_HANDLE_INVALID", "A runtime handle is malformed.", { handle });
    }
    const slot = slots[handle.slot];
    if (!slot || slot.generation !== handle.generation) {
      fail("FPM_RUNTIME_HANDLE_STALE", "A generational runtime handle no longer names a live materialisation.", {
        handle,
        currentGeneration: slot?.generation ?? generations[handle.slot] ?? null,
      });
    }
    return frozen({ instanceId: slot.instanceId, definitionId: record(slot.instanceId).definitionId });
  }

  function acquire(instanceId, holder = "anonymous") {
    const selected = record(instanceId);
    if (!selected.materialization) {
      let slot = slots.findIndex((entry) => entry === null);
      if (slot === -1) slot = slots.length;
      const generation = (generations[slot] ?? 0) + 1;
      generations[slot] = generation;
      slots[slot] = { instanceId, generation };
      selected.materialization = { handle: frozen({ schema: "fpm.runtime-handle/1", slot, generation }), leases: new Set() };
    }
    const leaseId = `lease:runtime/${nextLease}`;
    nextLease += 1;
    const lease = frozen({
      schema: "fpm.materialisation-lease/1",
      id: leaseId,
      instanceId,
      holder,
      handle: selected.materialization.handle,
    });
    selected.materialization.leases.add(leaseId);
    leases.set(leaseId, { instanceId });
    return lease;
  }

  function release(leaseId) {
    const lease = leases.get(leaseId);
    if (!lease) fail("FPM_RUNTIME_LEASE_INVALID", "A materialisation lease is not live.", { lease: leaseId });
    const selected = record(lease.instanceId);
    selected.materialization.leases.delete(leaseId);
    leases.delete(leaseId);
    if (selected.materialization.leases.size === 0) {
      slots[selected.materialization.handle.slot] = null;
      selected.materialization = null;
    }
  }

  function destroy(instanceId) {
    const selected = record(instanceId);
    if (selected.materialization) {
      for (const leaseId of selected.materialization.leases) leases.delete(leaseId);
      slots[selected.materialization.handle.slot] = null;
    }
    persistent.delete(instanceId);
    destroyed.add(instanceId);
    stateRevision += 1;
    return frozen({ schema: "fpm.runtime-destruction/1", instanceId, destroyed: true, revision: stateRevision });
  }

  function capture(checkpoint) {
    return frozen({
      protocol: "fpm.state-fragment/1",
      semanticSchema: stateSchema,
      schemaVersion: 1,
      checkpoint: clone(checkpoint),
      stateRevision,
      references: {
        definitions: [...persistent.values()].map((entry) => entry.definitionId).sort(),
      },
      payload: {
        instances: [...persistent.values()].map((entry) => ({
          instanceId: entry.instanceId,
          definitionId: entry.definitionId,
        })).sort((left, right) => left.instanceId.localeCompare(right.instanceId)),
        destroyed: [...destroyed].sort(),
      },
    });
  }

  function prepareRestore() {
    clearMaterialisations();
  }

  function restore(fragment) {
    if (fragment?.protocol !== "fpm.state-fragment/1" || fragment.semanticSchema !== stateSchema
      || fragment.schemaVersion !== 1 || !Array.isArray(fragment.payload?.instances)
      || !Array.isArray(fragment.payload?.destroyed)) {
      fail("FPM_STATE_FRAGMENT_UNSUPPORTED", "Instance Store cannot restore the supplied state fragment.", {
        expectedSchema: stateSchema,
        expectedVersion: 1,
        actualSchema: fragment?.semanticSchema ?? null,
        actualVersion: fragment?.schemaVersion ?? null,
      });
    }
    clearMaterialisations();
    persistent.clear();
    destroyed.clear();
    for (const saved of fragment.payload.instances) {
      const definition = definitions.get(saved.instanceId);
      if (!definition || definition.definitionId !== saved.definitionId) {
        fail("FPM_STATE_DEFINITION_MISSING", "A saved world instance references an unavailable definition.", {
          instanceId: saved.instanceId,
          definitionId: saved.definitionId,
        });
      }
      persistent.set(saved.instanceId, { ...clone(definition), materialization: null });
    }
    for (const instanceId of fragment.payload.destroyed) destroyed.add(instanceId);
    stateRevision = fragment.stateRevision;
    return frozen({ semanticSchema: stateSchema, schemaVersion: 1, restoredRevision: stateRevision });
  }

  return {
    async activate(context) {
      if (context.artifact?.schema !== "fpm.render-scene/1" || !Array.isArray(context.artifact.objects)) {
        fail("FPM_RUNTIME_WORLD_INVALID", "The instance store requires a built render-scene world definition.");
      }
      for (const object of context.artifact.objects) {
        if (!definitions.has(object.instance)) {
          definitions.set(object.instance, { instanceId: object.instance, definitionId: object.definition, objects: [] });
        }
        definitions.get(object.instance).objects.push(clone(object));
      }
      for (const definition of definitions.values()) {
        persistent.set(definition.instanceId, { ...clone(definition), materialization: null });
      }
      const read = frozen({
        list: () => [...persistent.values()].map((entry) => frozen({
          instanceId: entry.instanceId,
          definitionId: entry.definitionId,
          materialized: entry.materialization !== null,
          handle: entry.materialization?.handle ?? null,
        })).sort((left, right) => left.instanceId.localeCompare(right.instanceId)),
        definition: (instanceId) => {
          const selected = record(instanceId);
          return frozen({ instanceId: selected.instanceId, definitionId: selected.definitionId,
            objects: clone(selected.objects) });
        },
        resolve,
        exists: (instanceId) => persistent.has(instanceId),
      });
      const stateOwner = frozen({
        protocol: "fpm.state-owner/1",
        semanticSchema: stateSchema,
        schemaVersion: 1,
        required: true,
        governingCapability: "runtime.instances.read",
        provider: serviceId,
        dependsOn: [],
        capture,
        prepareRestore,
        restore,
      });
      return {
        protocol: "fpm.runtime-service-response/1",
        capabilities: {
          "runtime.instances.read": read,
          "runtime.instances.materialize": frozen({ acquire, release }),
          "runtime.instances.destroy": frozen({ destroy }),
          "runtime.state.owner": stateOwner,
        },
      };
    },
    async deactivate() {
      persistent.clear();
      definitions.clear();
      destroyed.clear();
      leases.clear();
      slots.length = 0;
      stateRevision = 0;
    },
  };
}
