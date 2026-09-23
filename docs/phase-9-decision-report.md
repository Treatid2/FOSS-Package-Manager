<!-- SPDX-License-Identifier: MPL-2.0 -->

# Phase 9 decision report

## Accepted design decisions implemented

1. Phase 9 is one named phase reported as 9A and 9B.
2. Mutable workspace names point to immutable revisions.
3. Package import is distinct from workspace selection.
4. Candidate, generation, active generation, and distribution are separate records.
5. Generation commit and runtime activation are separate transactions.
6. Generated integration outputs become package-shaped roots with provenance.
7. Derivation depth is limited to one.
8. The first distribution is self-contained and local.
9. Curated subsystems use ordinary imported generation roots.
10. Runtime change is a checkpoint/restart/rollback transaction.
11. Scale acceptance is 10, 100, and 1,000 packages; 10,000 is exploratory.
12. The accepted Phase 8 runtime-task contract is consumed unchanged.

## Gate disposition

| Gate | Disposition |
| --- | --- |
| 0 — baseline and safety | Demonstrated; exact checkpoint, clean branch, contracts and 83 baseline tests retained. |
| A — store/workspace | Demonstrated. |
| B — candidate/impact | Demonstrated. |
| C — derived/generation | Demonstrated. |
| D — distribution replay | Demonstrated. |
| E — runtime transition | Demonstrated with controlled and real Phase 8 runtimes. |
| X — package exit/state | Demonstrated. |
| F — scale | Demonstrated through 1,000; 10,000 deferred as permitted. |

## Review request

Review should focus on whether the directory distribution is an acceptable first bundle and
whether the filesystem reference lease is sufficient for the next curator-facing experiment.
Neither question blocks this bounded prototype. No continuation into remote repositories,
signatures, UI work, or the external typed-artifact-provider experiment is requested.

