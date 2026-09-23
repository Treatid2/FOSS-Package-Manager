<!-- SPDX-License-Identifier: MPL-2.0 -->

# Manager-hosted dungeon integration harness

This bounded harness is the evidence boundary for the corrected Grid Dungeon Traversal
integration. It does not adapt package code, accept constructor injection, or infer that a domain
experiment succeeded. It runs the selected graph through the real manager service loader and
records only mechanically verified facts.

Create a request whose three roots are the exact package directories received from the generator,
traversal, and runtime owners. Each root must contain `fgpm-package.json` directly, and its expected
version and directory content hash are mandatory:

```json
{
  "schema": "fgpm.manager-hosted-dungeon-integration/1",
  "id": "grid-dungeon-traversal-v04",
  "mode": "dungeon-v04",
  "manager": {
    "id": "org.foss-package-manager.reference",
    "version": "0.9.0",
    "contentHash": "sha256:f91fd8fb3623ab57ec7a9edbd360a916c8bc4fb7f4c8593a580fe757e44937f4"
  },
  "profile": "./grid-dungeon-v04.profile.json",
  "packageRoots": [
    {
      "role": "generator",
      "root": "./immutable/generator",
      "package": { "id": "example.generator", "version": "0.1.0", "contentHash": "sha256:<64 lowercase hex>" }
    },
    {
      "role": "traversal",
      "root": "./immutable/traversal",
      "package": { "id": "example.traversal", "version": "0.1.0", "contentHash": "sha256:<64 lowercase hex>" }
    },
    {
      "role": "runtime",
      "root": "./immutable/runtime",
      "package": { "id": "example.runtime", "version": "0.1.0", "contentHash": "sha256:<64 lowercase hex>" }
    }
  ],
  "ticks": 18,
  "runtime": {
    "workerCount": 1,
    "timeoutMs": 5000
  },
  "driver": {
    "capability": "fgdungeon.reference-runtime",
    "protocol": "fgdungeon.reference-runtime/0",
    "provider": "service:fgdungeon.reference-runtime/0",
    "level": {
      "packageRole": "runtime",
      "path": "fixtures/representative.level.json",
      "blobRoot": "sha256:<level bytes hash>",
      "identity": "sha256:<level semantic identity>"
    },
    "intents": {
      "packageRole": "runtime",
      "path": "fixtures/traversal-18-intents.json"
    },
    "actorId": "avatar-01",
    "policy": {
      "schema": "fgdungeon.traversal-policy/0",
      "radiusMillimetres": 200,
      "speedMillimetresPerSecond": 1000,
      "tickDurationMilliseconds": 100,
      "collisionResponse": "slide-x-then-y"
    }
  },
  "evidence": [
    { "kind": "domain-output", "path": "domain-final-state.json" },
    { "kind": "domain-trace", "path": "domain-trace.json" }
  ],
  "proof": {
    "tickMilliseconds": 100,
    "demonstrationSteps": 18,
    "requiredServices": [
      { "role": "generator", "service": "service:<from corrected generator descriptor>" },
      { "role": "traversal", "service": "service:<from corrected traversal descriptor>" },
      { "role": "runtime", "service": "service:<from corrected runtime descriptor>" }
    ],
    "providerBindings": [
      { "binding": "<from corrected descriptors>", "provider": "service:<from corrected descriptors>" }
    ],
    "observations": {
      "tickMilliseconds": { "path": "domain-trace.json", "pointer": "/<exact field>" },
      "demonstrationSteps": { "path": "domain-trace.json", "pointer": "/<exact field>" },
      "traceFinalState": { "path": "domain-trace.json", "pointer": "/<exact identity field>" },
      "outputFinalState": { "path": "domain-final-state.json", "pointer": "/<exact identity field>" }
    },
    "expectedFinalState": {
      "identity": "sha256:<shipped expected final-state identity>",
      "blobRoot": "sha256:<shipped expected final-state bytes hash>",
      "tick": 18,
      "revision": 18,
      "positionMillimetres": { "x": 19500, "y": 2200, "z": 0 }
    }
  }
}
```

The package, service, binding, evidence-field identities, versions, and hash placeholders are
illustrative and are not a runnable v04 claim. Populate them only from the corrected immutable
package descriptors. The reviewed manager identity shown above is exact.
Paths in the request are relative to the request file. Evidence paths and the optional snapshot
path must remain inside the empty output directory.

Run from the manager repository:

```powershell
npm run integration:dungeon -- .\path\request.json --out <managed-build-work-path>
```

Because the command creates a build tree, `<managed-build-work-path>` must be a current
`Kind=build` allocation from the configured Codex scratch manager. On success the harness retains
the lockfile, provenance, runtime plan, lifecycle, capability-publication evidence, declared
domain output and trace hashes, an integration receipt, and a final evidence manifest. The
manager-owned driver obtains the selected runtime capability from the active host, starts one
session with the pinned provider identities, applies one shipped intent and one manager tick per
step, retains every response receipt, stops the domain session, and then shuts the service graph
down in reverse activation order. A
`dungeon-v04` receipt is possible only after all three root hashes remain unchanged through the
run, all three packages are selected with those exact identities, the fixed 100 ms/18-step facts
are observed in domain evidence, each role's declared service is in the committed plan, actual
provider bindings match, trace and final output name the same final-state identity, activation and
all 18 ticks finish, the result equals the shipped expected final-state identity, blob root,
sequence, and position, shutdown is the reverse activation order, and every declared evidence
file exists. Manager bookkeeping cannot be substituted for domain output or trace evidence.

`mode: "fixture"` exists only for the manager's regression suite and reports `fixture-pass`; it
must not be presented as a successful Grid Dungeon Traversal integration.
