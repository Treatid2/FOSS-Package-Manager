<!-- SPDX-License-Identifier: Apache-2.0 -->
# Source-free public companion kit v0.2.1 (0.11 assessment candidate)

This kit invokes only the distribution's public executable and Node built-ins.
It does not import manager or Reference World package implementation modules.
It is included in the deterministic candidate archive under `qualification`.
It is not a substitute for the original 137 developer/source/build audit cases.
`qualify` contains 15 separately identified public-boundary cases. Their test-owned
package is a public fixture, not a Reference World package or hidden manager clone.

Use the pinned bundled runtime and a new output directory within an active managed
Kind=build allocation. Do not put writable output in the install directory.

```
<distribution>/bin/node.exe <distribution>/qualification/run.mjs qualify --input binding.json --out <managed-work>/public-qualification --json
<distribution>/bin/node.exe <distribution>/qualification/run.mjs dungeon --input binding.json --out <managed-work>/dungeon-qualification
```

Both presentations retain the same complete `report.json` and `report.txt` facts.
Human output includes every structured fact and failure, not a lossy pass/fail
summary. Raw requests, manager JSONL stdout, stderr, command invocations and actual
process exit are retained. Request/run/cleanup deadlines are 30/120/5 seconds;
only the kit-owned manager subprocess may be cancelled. No retry or network call.
The outer project supervisor should bound the entire kit invocation to 180 seconds.

Required binding JSON fields:

```json
{
  "distribution": "<clean extracted candidate directory>",
  "archive": "<exact candidate ZIP>",
  "expected": {
    "managerVersion": "0.11.0-rc.6",
    "runtimePayloadRoot": "sha256:<from measured candidate>",
    "distributionContentRoot": "sha256:<from measured candidate>",
    "publicContractRoot": "sha256:<from measured candidate>",
    "archiveSha256": "sha256:<independently measured archive hash>"
  }
}
```

For dungeon mode, additionally supply `managerRoot` containing an already committed
curator-supplied generation, and `dungeon`: id, generation, runtimePlanRoot,
packageRoots (exact 32 distinct roots), levelPath, intentsPath, intentsSha256, capability object
with capability/protocol/provider, and start (the exact public
fgdungeon.reference-runtime-start/0 object including provider pins).
The harness verifies the candidate/generation/plan/closure bindings before
activation; consumes exact initialization plus 18 intents through the public
session boundary; retains every receipt/snapshot link; checks the approved final
tick/revision/position/state/blob roots and 15-service reverse shutdown.
100 ms is simulated fixed-tick time, not a wall-clock sleep.

The curator must verify the complete closure, actual input identities and semantics
before use. This harness does not create a reconstructed predecessor baseline,
accept a composition, select the available landmark, deploy/install, or claim a
historical generation. Historical manager 0.9.0 proof remains unchanged.

The author-approved dual-layer G1 model keeps developer/source/build audit evidence
separate from source-free public-boundary qualification. No equivalent source-free
137/137 claim or coverage relaxation is made. This newly versioned candidate must
be independently assessed before downstream application.

## Historical rc.2-to-rc.3 variant qualification

The former `variants` mode copied an rc.2 private manager store into rc.3 and is
not a 0.11 public-contract qualification. Stage A deliberately rejects pre-public
package entrypoints in the normal reader and does not migrate private indices.
Use `fgpm migrate pre-public-package` on owned package inputs, then reconstruct
state through the current public manager APIs. The retained rc.3 evidence remains
historical evidence; it is not regenerated or relabelled for this candidate.
The versioned transition contract is `public/migrations/pre-public-package-v1.json`.
Apply state is durable beside its output and inspectable with
`fgpm migrate pre-public-package status --out <output>` after restart.
