// SPDX-License-Identifier: Apache-2.0

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function createService() {
  let counter = 7;
  return {
    async activate() {
      return {
        protocol: "fgpm.runtime-service-response/1",
        capabilities: {
          "runtime.state.owner": freeze({
            protocol: "fgpm.state-owner/1",
            semanticSchema: "fgpm.demo.required-counter-state",
            schemaVersion: 1,
            required: true,
            governingCapability: "runtime.required-counter.state",
            provider: "service:bad.required-counter/1",
            dependsOn: [],
            capture: (checkpoint) => freeze({
              protocol: "fgpm.state-fragment/1",
              semanticSchema: "fgpm.demo.required-counter-state",
              schemaVersion: 1,
              checkpoint: structuredClone(checkpoint),
              stateRevision: counter,
              payload: { counter },
            }),
            prepareRestore: () => {},
            restore: (fragment) => {
              counter = fragment.payload.counter;
              return freeze({ semanticSchema: fragment.semanticSchema, schemaVersion: 1,
                restoredRevision: counter });
            },
          }),
        },
      };
    },
    async deactivate() {
      counter = 7;
    },
  };
}
