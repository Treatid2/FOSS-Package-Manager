<!-- SPDX-License-Identifier: MPL-2.0 -->
# Grid Dungeon integration host — portable maintenance successor

This experimental descriptor-only package selects the dungeon-v04 activation contract
for a manager-owned integration driver. It contains no executable service or package hook.
It is NOT `fgdungeon.reference-runtime` and does not own dungeon simulation code.

Package: `6d7092e8-6f8a-4e25-bb6e-a0bf6588e5b4/fgpm.grid-dungeon-integration-runtime@0.2.2`, MPL-2.0.
Required packages: `demo.runtime-task-v2-distribution` exactly `0.8.0` and
`fgdungeon.reference-runtime` exactly `0.1.0`. The single contribution is
`pkg:fgpm.grid-dungeon-integration-runtime/runtime/dungeon-v04`, type
`fgpm.demo.runtime/1`, manifest `runtime.json`.

Activation `runtime:fgpm.grid-dungeon-integration/dungeon-v04` uses
`fgpm.runtime-activation/1`, accepts `fgpm.render-bundle/1`, and declares 18 ticks.
Requirements (these are declarations, not evidence of an available composition):

| Capability | Range | Explicit binding |
|---|---|---|
| fgdungeon.reference-runtime | 0.1.0 | none |
| runtime.scheduler.barrier | ^2.0.0 | runtime.scheduler/2 |
| runtime.renderer.window | ^1.0.0 | none |
| runtime.persistence.world | ^1.0.0 | runtime.persistence/1 |

## Independent inert checks

Use the accepted FGPM tool with archive SHA256
`b396a7675af15b2252737a41311742f178ceb4e9d83703b20960ed7fbba09701`.
Extract the tool and this package into separate directories, with no project/store.
From this package directory:

```powershell
& 'C:\Tools\FGPM\bin\node.exe' --test tests/maintenance.test.mjs
& 'C:\Tools\FGPM\fgpm.cmd' package identity 'C:\Received packages\fgpm.grid-dungeon-integration-runtime' --json
& 'C:\Tools\FGPM\fgpm.cmd' package identity 'C:\Received packages\fgpm.grid-dungeon-integration-runtime' --expected 'sha256:<root from enclosing return receipt>'
& 'C:\Tools\FGPM\fgpm.cmd' validate-package 'C:\Received packages\fgpm.grid-dungeon-integration-runtime' --json
```

The candidate root is in the enclosing return receipt, not self-referential package
metadata. Identity exit codes: 0 computed/match, 1 mismatch, 2 error.
The focused test command is `node --test tests/maintenance.test.mjs` when an equivalent
supported Node runtime is already installed; the bundled executable example above
avoids that installation requirement. The tests parse and compare declarations,
documentation and original-file digests; they never resolve
a project, activate a host or load dependency code. Public schema validation returns
`provisional-v1`, NOT strict-v2 conformance. See `descriptor-equivalence.json`.

## Predecessor, custody and limits

The unchanged two-file predecessor has root
`sha256:2e0d44cdc4756a3962f133364616c7d57889f18801dc6b2cc4200e52f666f475`,
introduced by source commit `e37daa7e4940fdc2e9c0f3c65bc4e8e44ed973a9`.
The historical `fpm-package.json` digest remains recorded in `maintenance.json`.
This successor uses the permanent `fgpm-package.json` entrypoint, `format`, publisher
namespace, and immutable local name; its package version is `0.2.2`. `runtime.json`
retains the same role while its public labels cross the same boundary. The accepted v05 integration continues to identify
the old object; no selection or integration claim attaches to this successor.

The immediate `0.2.1` predecessor has exact root
`sha256:df991de127867422ae60bc041b02efb503a93748cfc696af5d324c4b7d5e8090`.
Version `0.2.2` removes private coordination identifiers from public documentation
and maintenance metadata. It does not change the runtime declaration, dependencies,
contribution, licence, namespace, or local name.

Implementation custodian: FGPM package owner.
Maintained source: `maintained-packages/fgpm.grid-dungeon-integration-runtime` in
FOSS-Package-Manager. Do not edit retained integration fixtures/releases in place.
`maintenance.json` mirrors the human declarations and records provenance; `NOTICE.md`
and the full `LICENSE` provide portable MPL-2.0 terms. Exact source revision is supplied
by the enclosing response, avoiding self-referential source/content identities.

The manager prototype has no compatibility or hostile-code containment guarantee.
The public identity operation is tested on Windows x64 / bundled Node24.18.0, uses
inherited locale/runtime ordering and whole-file reads, requires quiescent trees and
does not guarantee atomic snapshots/concurrent-writer consistency. It excludes exact
`.git`, `node_modules`, `build` names and rejects encountered links/nonregular entries.
Content identity is not schema validity, authenticity, safety, compatibility,
acceptance or permission to execute. No import, stage/plan, generation, activation,
replay, integration rerun, publication or deployment is part of these checks.
