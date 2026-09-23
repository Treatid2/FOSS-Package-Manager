<!-- SPDX-License-Identifier: MPL-2.0 -->

# Phase 8 implementation map

**Branch:** `phase-8/public-boundary-correction`  
**Starting commit:** `1061fa060d8a40a33a20bd5a267d9e7e01ec7e99`  
**Preserved checkpoint:** `phase-7-prototype` at
`cea2b57cfe777c8607358bea16661690343594e8`

Phase 8 corrects the public boundary without rewriting the provisional Phase 7 task path.
The old path remains executable evidence; the corrected path is explicitly versioned and
uses separate vocabulary and demonstration packages.

## Gate 0 — preservation and baseline

| Concern | Location | Evidence |
| --- | --- | --- |
| Checkpoint preservation | Git branch/tag graph | Both required objects resolve as commits; the Phase 7 tag remains at `cea2b57...`. |
| Review basis | Branch parent | The correction branch was created directly from `1061fa...`. |
| Implementation delta before Phase 8 | `src/`, `packages/` | `git diff --quiet cea2b57 1061fa -- src packages` returned `0`. |
| Baseline behavior | Existing test suite | 57 tests passed on Node `v24.18.0`. |
| Generated architecture contract | `contracts/architecture-v0.json` | `npm run contracts:check` passed. |

## Gate A1 — public schemas and isolated validation

- `public/schemas/` contains Apache-2.0 machine-readable definitions for corrected
  package, profile, service, task, transform, plan, tick, trace, artifact, and grant objects.
- `public/vocabularies/` names each steward, version, identity, and unknown-field rule.
- `src/core/public-contracts.mjs` implements the manager-side static conformance checks
  and exact JSON-path diagnostics used by `validate-package` and `validate-profile`.
- `src/core/discovery.mjs` and `src/core/profile.mjs` invoke the corrected validators
  while retaining explicit provisional-v1 handling.

## Gate A2 — clean task declaration

- The corrected task member contract uses `fpm.runtime-task-member/2` and
  `fpm.runtime-task/2`.
- `fpm.runtime-task-contracts` is a real selected data-only package which owns the generic
  task vocabulary; corrected tasks and the scheduler depend on it.
- `participation` controls whether exact-member policy may exclude the member.
- `failurePolicy` independently controls tick failure.
- `phase`, `reentrancy`, duplicate `exclusive`, `required`, and `failure` are rejected in
  the v2 declaration.
- The v1 scheduler and fixtures remain executable as provisional compatibility evidence,
  and `validate-package` reports their duplicated/inert fields without reinterpreting them.

## Gate A3 — vocabulary-owned composition

- The public runtime-task vocabulary owns task execution envelopes.
- `fpm.transform-task-contracts` owns the immutable snapshot, operation, command
  channel, semantic stages, reducers, validation, and explanation record.
- `demo.deterministic-scheduler-v2` consumes those vocabularies and delegates channel planning and
  composition to the selected transform vocabulary provider.
- Corrected built-in motion, offset, External Nudge, and a second independent additive
  producer name stages/laws, never one another.
- `test/phase-8.test.mjs` proves the resolved four-producer order and proves that two
  exclusive base producers fail before Transform Authority mutation.

## Gate A4 — CLI, conformance, and explanation

- `src/cli.mjs` provides subcommand help and public `validate-package`,
  `validate-profile`, `conformance runtime-task`, and structured `explain runtime ...`
  commands.
- Runtime plans retain vocabulary, steward, stage, reducer, and contributor facts; tick
  records retain the vocabulary-derived commit order, so `explain runtime` requires no
  source lookup.
- The pre-activation explanation calls unordered declarations `stageSet`; deterministic tick
  composition records emit structured stages in vocabulary `commitOrder`.
- `--workers` and repeatable `--delay <exact-member>=<milliseconds>` expose conformance
  controls without package-specific environment variables. `conformance runtime-task`
  compares three configurations and retains deterministic and observational evidence.
- The conformance JSON directly retains manager/CLI, Node, CWD, profile/contracts/packages,
  installed-distribution, and core-before/after identities.

## Gate A5 — external path independence

- Profile package roots remain relative to the declaring profile; repeatable `--packages`
  supplies separately installed distribution roots without placing them in authored files.
- CLI implementation resources resolve from `import.meta.url`, not the process working
  directory.
- `examples/external-runtime-task-v2/` is relocatable and embeds no manager repository path.
- The retained conformance run executed from managed allocation
  `20260821T154506461Z-foss-package-manager-81cff7ef` on `D:` with the external directory as
  the process working directory; its report was hash-verified on promotion to `evidence/phase-8/`.

## Gate B1 — typed activation artifact

- `src/core/artifacts.mjs` exposes a generic verified immutable root/entry byte reader.
- `src/core/runtime.mjs` constructs and records `fpm.typed-artifact-reference/1` without
  parsing domain payload bytes.
- The instance/world specialist decodes the render artifact and publishes the world metadata
  and scene definitions needed by downstream services.
- Unsupported type and mismatched/corrupt root tests fail before committed activation.

## Gate B2 — declared host grants

- `public/vocabularies/host-grants-v1.json` owns deterministic, observational, and conformance
  grant classifications.
- Persistence separately requests deterministic input, observational record-location, and
  conformance fault-injection grants.
- Runtime service manifests request exact grant identities.
- `RuntimeHost` exposes `context.grant(identity)` only for requested and supplied grants;
  `context.options` has been removed from both executable paths.
- The runtime plan/lifecycle records requests, grants, absences/denials, provider,
  policy, and classification.
- The trust claim is an architectural boundary for cooperating native services, not a
  hostile-native-code sandbox.

## Gate C and Gate D — kit, evidence, and review

- `authoring-kit/runtime-task-v2/` is the corrected public-only handoff surface, with a
  relocatable profile, statically checkable example, exact policy/CLI syntax, and a prepared
  independent-test brief.
- The kit has an exact `PUBLIC-CONTRACTS.sha256` and standalone verifier. The handoff carries a
  verified Git bundle containing the otherwise-unpublished exact manager branch and Phase 7 tag.
- `test/phase-8.test.mjs` and `test/authoring-kit-v2.test.mjs` provide internal mechanical
  coverage; neither is the second
  fresh-author retest.
- Phase 8 findings, decision report, implementation-aware review, conformance report,
  hashes, test summary, and the final indexed ZIP will be retained locally.
- No push, pull request, publication, or second fresh-author retest belongs to this cycle.
