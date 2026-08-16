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

const character = "world:demo/character-1";
const stateSchema = "fpm.demo.character-journal-state";
const serviceId = "service:demo.character-journal/1";

export function createService() {
  let instances;
  let note = "No entries yet.";
  let visits = 0;
  let revision = 0;

  function current() {
    return freeze({ instanceId: character, note, visits, revision });
  }

  return {
    async activate(context) {
      instances = context.require("runtime.instances.read");
      if (!instances.exists(character)) {
        fail("FPM_JOURNAL_TARGET_MISSING", "Character Journal requires its declared world instance.", {
          instanceId: character,
        });
      }
      const owner = freeze({
        protocol: "fpm.state-owner/1",
        semanticSchema: stateSchema,
        schemaVersion: 1,
        required: false,
        governingCapability: "runtime.journal.read",
        provider: serviceId,
        dependsOn: ["fpm.demo.instance-state"],
        capture: (checkpoint) => freeze({
          protocol: "fpm.state-fragment/1",
          semanticSchema: stateSchema,
          schemaVersion: 1,
          checkpoint: structuredClone(checkpoint),
          stateRevision: revision,
          payload: { instanceId: character, note, visits },
        }),
        prepareRestore: () => {},
        restore: (fragment) => {
          if (fragment?.protocol !== "fpm.state-fragment/1" || fragment.semanticSchema !== stateSchema
            || fragment.schemaVersion !== 1 || fragment.payload?.instanceId !== character
            || typeof fragment.payload.note !== "string" || !Number.isInteger(fragment.payload.visits)
            || !instances.exists(character)) {
            fail("FPM_STATE_FRAGMENT_UNSUPPORTED", "Character Journal cannot restore the supplied state fragment.", {
              semanticSchema: fragment?.semanticSchema ?? null,
              schemaVersion: fragment?.schemaVersion ?? null,
            });
          }
          note = fragment.payload.note;
          visits = fragment.payload.visits;
          revision = fragment.stateRevision;
          return freeze({ semanticSchema: stateSchema, schemaVersion: 1, restoredRevision: revision });
        },
      });
      return {
        protocol: "fpm.runtime-service-response/1",
        capabilities: {
          "runtime.journal.read": freeze({ current }),
          "runtime.journal.write": freeze({ record: (nextNote, nextVisits) => {
            if (typeof nextNote !== "string" || !Number.isInteger(nextVisits) || nextVisits < 0) {
              fail("FPM_JOURNAL_COMMAND_INVALID", "A journal command is malformed.", { nextNote, nextVisits });
            }
            note = nextNote;
            visits = nextVisits;
            revision += 1;
            return current();
          } }),
          "runtime.state.owner": owner,
        },
      };
    },
    async deactivate() {
      instances = null;
      note = "No entries yet.";
      visits = 0;
      revision = 0;
    },
  };
}
