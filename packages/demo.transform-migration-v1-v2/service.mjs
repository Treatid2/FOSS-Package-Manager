// SPDX-License-Identifier: Apache-2.0

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function createService() {
  return {
    async activate() {
      return {
        protocol: "fgpm.runtime-service-response/1",
        capabilities: {
          "runtime.transforms.migration": freeze({
            protocol: "fgpm.state-migration/1",
            package: "demo.transform-migration-v1-v2",
            provider: "service:demo.transform-migration-v1-v2/1",
            from: { semanticSchema: "fgpm.demo.transform-state", schemaVersion: 1 },
            to: { semanticSchema: "fgpm.demo.transform-state", schemaVersion: 2 },
            migrate: (fragment) => freeze({
              protocol: "fgpm.state-fragment/1",
              semanticSchema: "fgpm.demo.transform-state",
              schemaVersion: 2,
              checkpoint: structuredClone(fragment.checkpoint),
              stateRevision: fragment.stateRevision,
              payload: {
                entries: fragment.payload.transforms.map((entry) => ({
                  instanceId: entry.instanceId,
                  offset: { x: entry.translation[0], y: entry.translation[1], z: entry.translation[2] },
                  revision: entry.revision,
                })),
              },
            }),
          }),
        },
      };
    },
  };
}
