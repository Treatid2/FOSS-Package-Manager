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

const stateSchema = "fgpm.demo.character-marker-state";
const character = "world:demo/character-1";

export function createService() {
  let instances;
  let label = "green-head-demo";
  let counter = 0;
  let revision = 0;
  return {
    async activate(context) {
      instances = context.require("runtime.instances.read");
      const state = freeze({
        protocol: "fgpm.state-owner/1",
        semanticSchema: stateSchema,
        schemaVersion: 1,
        required: false,
        governingCapability: "runtime.marker.read",
        provider: "service:demo.character-marker/1",
        dependsOn: ["fgpm.demo.instance-state"],
        capture: (checkpoint) => freeze({
          protocol: "fgpm.state-fragment/1",
          semanticSchema: stateSchema,
          schemaVersion: 1,
          checkpoint: structuredClone(checkpoint),
          stateRevision: revision,
          payload: { instanceId: character, label, counter },
        }),
        prepareRestore: () => {},
        restore: (fragment) => {
          if (fragment?.protocol !== "fgpm.state-fragment/1" || fragment.semanticSchema !== stateSchema
            || fragment.schemaVersion !== 1 || fragment.payload?.instanceId !== character
            || typeof fragment.payload.label !== "string" || !Number.isInteger(fragment.payload.counter)
            || !instances.exists(character)) {
            fail("FGPM_STATE_FRAGMENT_UNSUPPORTED", "Character Marker cannot restore the supplied state fragment.", {
              semanticSchema: fragment?.semanticSchema ?? null,
              schemaVersion: fragment?.schemaVersion ?? null,
            });
          }
          label = fragment.payload.label;
          counter = fragment.payload.counter;
          revision = fragment.stateRevision;
          return freeze({ semanticSchema: stateSchema, schemaVersion: 1, restoredRevision: revision });
        },
      });
      return {
        protocol: "fgpm.runtime-service-response/1",
        capabilities: {
          "runtime.marker.read": freeze({ current: () => freeze({ instanceId: character, label, counter, revision }) }),
          "runtime.marker.write": freeze({ set: (nextLabel, nextCounter) => {
            if (typeof nextLabel !== "string" || !Number.isInteger(nextCounter)) {
              fail("FGPM_MARKER_COMMAND_INVALID", "A marker command is malformed.", { nextLabel, nextCounter });
            }
            label = nextLabel;
            counter = nextCounter;
            revision += 1;
            return freeze({ label, counter, revision });
          } }),
          "runtime.state.owner": state,
        },
      };
    },
    async deactivate() {
      instances = null;
      label = "green-head-demo";
      counter = 0;
      revision = 0;
    },
  };
}
