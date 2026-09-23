<!-- SPDX-License-Identifier: MPL-2.0 -->

# Phase 8 conformance report

## Public matrix

Command:

```text
node src/cli.mjs conformance runtime-task profiles/runtime-task-v2.json \
  --focus task:demo.external-nudge-v2/add-x/1 --out <output>
```

The corrected generic matrix runs:

1. one worker, no delay;
2. four workers, the exact public focus delayed 40 ms;
3. four workers, the lexicographically first other selected channel contributor delayed 40 ms.

Result: **pass** for the retained Phase 8 fixture. Deterministic tick record, authoritative output
transform state, and SVG were byte-identical across the matrix. Observational completion order
differed. The public report now directly identifies
manager commit/branch and CLI hash, Node/runtime and CWD, profile and public-contract hashes,
selected package hashes, installed distribution, and equal core before/after roots.

Report version 2 names the pre-tick `inputTransformRoot` and post-commit
`outputTransformRoot` separately. A failed tick produces the same versioned report with the public
specialist error, target/contributors, equal pre/post roots where rejection is pre-mutation, and
explicit mutation and successful-tick booleans.

The corrected handoff generator requires a new external-workspace report from the exact clean
handoff commit, verifies those fields, and records its SHA-256 in `CHECKPOINT.json`. It also emits
`docs/exact-checkpoint-external-conformance.md` inside the packet. The older in-repository report
remains historical Phase 8 evidence rather than the corrected packet's final exact-checkpoint run.

## Baseline, active, and exclusion

`tools/collect-phase-8-evidence.mjs` retained corrected-path baseline, active External Nudge, and
exact-member exclusion runs. The excluded graph still selects `demo.external-nudge-v2` and
attributes policy `policy:demo.exclude-external-nudge-v2/1`. Baseline and excluded transform,
scene, and SVG roots are equal.

## Ordering and composition

- Reversing discovered package order changes neither runtime plan nor deterministic outcome.
- Vocabulary stage order is `set-axis`, then `add-axis`.
- Additive contributor commit order is stable public member identity; completion order is not
  used for semantics.
- A duplicate `set-axis` target reports channel, stage, law, steward, and contributors before
  mutation; before/after transform roots match.

## Explanation

`explain runtime` resolves task membership/exclusion and transform channel vocabulary, steward,
stages, laws, contributors, and selected provider from retained lifecycle data without source
lookup. Ambiguity diagnostics carry the derived rule and pre-mutation status directly.

## Scope label

Demonstrated for the provided small trusted-native transform task path. Performance, arbitrary
channels, stable compatibility, and hostile-code containment are not claimed.
