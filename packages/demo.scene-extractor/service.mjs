// SPDX-License-Identifier: Apache-2.0

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function add(left, right) {
  return left.map((value, index) => value + right[index]);
}

export function createService() {
  let artifact;
  let instances;
  let transforms;
  return {
    async activate(context) {
      artifact = context.artifact;
      instances = context.require("runtime.instances.read");
      transforms = context.require("runtime.transforms.read");
      context.require("runtime.scheduler.barrier");
      const snapshots = freeze({
        current: () => {
          const transformSnapshot = transforms.snapshot();
          const byInstance = new Map(transformSnapshot.transforms.map((entry) => [entry.instanceId, entry]));
          const objects = [];
          for (const instance of instances.list()) {
            const definition = instances.definition(instance.instanceId);
            const transform = byInstance.get(instance.instanceId);
            for (const object of definition.objects) {
              objects.push({ ...object, position: add(object.position, transform?.translation ?? [0, 0, 0]) });
            }
          }
          objects.sort((left, right) => left.id.localeCompare(right.id));
          return freeze({
            schema: "fpm.render-scene/1",
            profile: artifact.profile,
            entryPoint: artifact.entryPoint,
            camera: structuredClone(artifact.camera),
            objects,
            runtime: {
              schema: "fpm.runtime-scene-revision/1",
              transformRevision: transformSnapshot.revision,
            },
          });
        },
      });
      return {
        protocol: "fpm.runtime-service-response/1",
        capabilities: { "runtime.scene-snapshot": snapshots },
      };
    },
    async deactivate() {
      artifact = null;
      instances = null;
      transforms = null;
    },
  };
}
