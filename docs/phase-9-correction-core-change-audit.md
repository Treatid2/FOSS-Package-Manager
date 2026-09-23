# Phase 9 correction core-change audit

| Area | Change | Boundary preserved |
|---|---|---|
| `src/core/curation.mjs` | Complete-build intent, authoritative resolver comparison, effective staged choices, real generator dispatch, closure export/import/verification, generation roots. | Impact planner remains advisory; established build semantics remain authoritative. |
| `src/core/runtime.mjs` | Hydrates and starts an exact committed runtime plan/artifact closure. | Existing profile-based runtime entry remains for non-generation workflows. |
| `src/core/generation-runtime.mjs` | Generation-bound factory, semantic override rejection, failed-attempt retention, new rollback session. | Full restart/checkpoint model preserved; no hot swap. |
| `src/cli.mjs` | Complete-profile workspace planning and generation-only activate/rollback. | Observational output options remain; semantic profile override is forbidden. |
| `src/core/phase9-contracts.mjs` and `contracts/phase-9` | Closed-field validation and split durable schema coverage. | Phase 8 public contract bundle remains consumed unchanged. |
| `packages/fpm.scene-integration-generator` | Specialist package-owned generator handler. | Domain payload is not hard-coded in manager core. |
| `src/core/synthetic.mjs`, benchmark tool | Integrated stage timings and authoritative leaf comparison. | No production-performance or complexity claim. |
| tests | Definitive replay/rollback fixture, staged-choice fixtures, expanded generator invalidation, contract coverage. | Existing Phase 8/9 tests retained; test files serialized only to protect fixed handler budgets. |

No remote, tag, release, signing, destructive-GC, renderer/engine, runtime-task-contract, or typed-artifact-provider code was introduced.
