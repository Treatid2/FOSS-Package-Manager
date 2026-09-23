# Phase 9 generation/runtime closure correction decision log

Status: experimental correction checkpoint  
Baseline: `27a2097579afed7b8d78d0071753036da9092dc9`  
Branch: `phase-9/generation-runtime-closure-correction`

## Decisions

1. The workspace impact planner remains advisory. `buildCandidate` now re-enters the established package resolver and, for executable profiles, the established handler, adapter, replacement, validator, artifact, and runtime-plan pipeline. Candidate and authoritative selection roots must match.
2. A complete build is a content-addressed durable record plus a content-addressed closure. The closure retains its effective profile, selected package trees, output/lock/provenance, artifact objects and action records, exact runtime plan, build summary, and public contracts.
3. Provider, adapter, replacement, and collection operations alter the effective complete profile. Collection inclusion means re-including a named member previously excluded by policy; exclusion adds that exact member to policy.
4. Derived packages execute a selected package-owned generator handler through the existing transactional artifact graph. Manager core assembles only the strict package envelope and provenance; it does not synthesize the domain payload.
5. Generation activation accepts a generation root and observational runtime options only. Profile, package, artifact, provider, or runtime-plan overrides are rejected before transition.
6. Distribution replay imports and verifies the exact package and complete-build closures before activation. It does not rebuild or re-curate.
7. A failed target activation retains a failed-attempt record and publishes a new rollback session for the reactivated prior generation. The old session identity is never reused.
8. Durable Phase 9 schemas are split by ownership and lifecycle rather than collected in one permissive schema.
9. The test runner executes test files serially. Concurrency behavior remains tested inside its dedicated fixtures, while fixed external-handler budgets are protected from unrelated integration-suite contention.

## Preserved boundaries

- No runtime-task contract redesign.
- No typed-artifact-provider experiment.
- No hot service swap, renderer integration, destructive GC, signing, remote publication, tag change, or release.
- No push, pull request, or remote branch mutation was performed.
