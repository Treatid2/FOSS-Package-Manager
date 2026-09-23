<!-- SPDX-License-Identifier: MPL-2.0 -->

# Phase 8 public conformance correction

This bounded correction responds to the fresh-author Class C result. It changes public tooling
and diagnostic evidence only; it does not begin a new architecture phase.

## Implementation decisions

1. **Focus mechanism.** `conformance runtime-task` requires `--focus <exact-task-member>`. The
   manager validates both selected `runtime.task` membership and contribution to the relevant
   channel before executing the public three-run matrix. This is the smallest author-controlled
   mechanism and contains no demonstration task identities.
2. **Peer choice.** The peer is the lexicographically first other selected channel contributor.
   The report records the identity and reason. Lexical selection is reproducible test setup, not
   semantic priority or producer ranking.
3. **Bounded run.** `run --ticks N` stops after N initial ticks unless `--interactive` is explicit.
   Without `--ticks`, the default remains interactive. `--snapshot` only selects output.
4. **Public specialist error.** Trusted packages may throw `{ code, message, details }` where code
   matches `FPM_*` and details is structured JSON data. No private class import is required.
   Default diagnostics preserve the envelope and suppress stacks; `--debug` is explicit.
5. **Deterministic versus observational.** Tick records, input/output state, and render output are
   deterministic. Requested worker count/delays, effective worker count, worker/thread facts, and
   completion order are observational and remain outside tick identity.
6. **Failed-conformance commit point.** The manager snapshots authoritative transform state
   immediately before the tick and again after rejection. A structured failure report is written
   only after capturing scheduler trace and confirming whether a deterministic tick record exists.
7. **Authoritative output field.** `outputTransformRoot` is exactly
   `record.result.stateRoot`; `inputTransformRoot` is the immutable pre-tick snapshot root. The
   misleading generic `transformRoot` field is removed.
8. **Remaining limitations.** The matrix targets the selected runtime-task transform channel and
   requires at least one peer contributor. Forty milliseconds is a prototype observation control,
   not a performance guarantee. Native services remain trusted in-process code, the v2 surface is
   experimental, and arbitrary channels, registry service, engine integration, and hostile-code
   containment are not claimed.

## Failure evidence

`fpm.runtime-task-conformance-report/2` records a failing configuration, focus/peer selection,
public error envelope, channel/vocabulary/steward/stage/law, target and contributors, pre/post
authoritative roots, equality, `mutationCommitted`, `successfulTickCommitted`, observational
trace, and the manager-core before/after audit. The CLI writes this report before returning
non-zero.
