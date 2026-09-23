<!-- SPDX-License-Identifier: MPL-2.0 -->

# Phase 8 handoff/public-contract correction

This is a bounded repair to the Phase 8 checkpoint, not Phase 9 and not a task-architecture
redesign. It responds to the independent handoff review while preserving all demonstrated Phase 8
mechanisms and the executable Phase 7 path.

## Required corrections

| Review finding | Resolution | Verification |
| --- | --- | --- |
| Exact unpublished manager checkpoint unobtainable | The handoff generator creates and verifies a Git bundle containing the correction branch and annotated `phase-7-prototype` tag. `CHECKPOINT.json` records its path and SHA-256. | Extracted-packet clone, exact `HEAD`, tag dereference, and checksum audit. |
| `participation.required` implied failure semantics | The vocabulary now states only presence/non-excludability and delegates every invocation failure to `failurePolicy`. | Both `required`/`abort-tick` and `required`/`drop-task` validate. |
| Generic task steward was documentary | Real selected Apache-2.0 data package `fpm.runtime-task-contracts@2.0.0` owns the byte-identical vocabulary; corrected tasks, transform steward, and scheduler depend on it. | Graph-selection and byte-identity tests. |
| Explanation showed an apparently reversed stage order | Unordered pre-activation declarations are now structured `stageSet`; semantic composition records retain stages in vocabulary `commitOrder`. | Explanation and composition-order assertions. |
| Fresh-author brief was weaker than the intended test | The brief requires `+0.375` on Z, exact exclusion, delayed concurrency, explanation, a reversible non-composable variant, equal pre/post roots, core audit, and A/B/C/D classification. | Packet inspection; the implementation instance still does not perform the fresh-author test. |
| Persistence grant mixed classifications | It is split into deterministic `persistence-input`, observational `persistence-records`, and conformance `persistence-conformance`. | Plan-record classification and requested-grant tests. |

## Evidence improvements

- Public conformance JSON identifies manager commit/branch, CLI hash, Node/runtime, CWD, profile
  hash, public-contract tree root, selected package content hashes, installed distribution
  identity, and manager-core before/after roots.
- The kit contains `PUBLIC-CONTRACTS.sha256` and a manager-independent verifier.
- The transform vocabulary specifies an exact integer-micro-unit model: no rounding,
  six-decimal quantization, safe-integer inputs/sums, positive-zero canonicalization, and
  reject-before-mutation overflow behavior.
- The Phase 8 implementation map was editorially cleaned.

## Decision boundary

After verification and handoff regeneration, the next decisive action remains the genuinely fresh
author test. Do not begin a new architecture phase, external provider experiment, renderer, engine
adapter, or registry before reviewing that result.
