// SPDX-License-Identifier: Apache-2.0

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function createService() {
  const transforms = new Map();
  let revision = 0;
  return {
    async activate(context) {
      for (const instance of context.require("runtime.instances.read").list()) {
        transforms.set(instance.instanceId, { translation: [0, 0, 0], revision: 0 });
      }
      return {
        protocol: "fpm.runtime-service-response/1",
        capabilities: {
          "runtime.transforms.read": freeze({
            snapshot: () => freeze({
              schema: "fpm.transform-snapshot/1",
              revision,
              transforms: [...transforms.entries()].map(([instanceId, value]) => ({
                instanceId,
                translation: [...value.translation],
                revision: value.revision,
              })).sort((left, right) => left.instanceId.localeCompare(right.instanceId)),
            }),
          }),
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
          }),
        },
      };
    },
    async deactivate() {
      transforms.clear();
    },
  };
}
