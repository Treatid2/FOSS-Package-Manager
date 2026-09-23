<!-- SPDX-License-Identifier: MPL-2.0 -->

# Phase 9 committed runtime-plan lifecycle-edge correction findings

## Outcome

- **demonstrated** — Committed runtime-plan hydration reconstructs the same canonical dependency
  edge projection as ordinary planning from exact immutable service requirements, capability
  selections, provider bindings, collection members, and collection member dependencies.
- **demonstrated** — Hydration validates the complete selected service closure and exact
  dependency-first activation order before any runtime controller activates.
- **demonstrated** — A generation-bound runtime rejects early deactivation of
  `service:demo.runtime-instance-store/1` while active dependants remain with
  `FPM_RUNTIME_DEPENDENTS_ACTIVE`.
- **demonstrated** — The rejected early deactivation changes no generation, runtime-session, or
  active-reference identity, and normal shutdown completes in exact reverse dependency order.
- **demonstrated** — A missing committed provider and a provider-after-dependant activation order
  are rejected before activation with structured generation-, plan-, service-, capability-, and
  reason-attributed diagnostics.
- **demonstrated** — Runtime factory registration is disabled by default and requires the explicit
  `allowTestFactories` internal fixture option. Public generation activation continues through the
  exact committed closure.
- **demonstrated** — Contract checking, the 102-test serial suite, the definitive export/import and
  rollback fixture, and integrated 10/100/1,000 package cases pass after the correction.

## Deterministic derivation rule

Edges are directed from dependant to provider. Exclusive requirements resolve to the one committed
compatible provider; collection requirements resolve to every committed member service; collection
member dependencies add cross-service edges. Optional unavailable requirements add no edge and
must retain an exact attributed null selection. Sorted service identities and sorted dependency
identities feed the shared depth-first dependency-order helper used by ordinary planning and
committed hydration. Lexical order is only a deterministic traversal tie-breaker and never creates
an edge.

## Scope and non-claims

- **supported but limited** — Runtime lifecycle evidence uses the portable SVG demonstration
  runtime, not a production renderer or game engine.
- **supported but limited** — Scale cases exercise synthetic package-only complete builds and do
  not claim production asset-pipeline throughput.
- **inferred** — Rejecting committed graph disagreement before controller activation should make
  future runtime-plan evolution safer; compatibility policy remains experimental.
- Production performance, distributed operation, remote repositories, signing/trust, destructive
  collection, per-service hot replacement, zero-downtime transitions, and version-one compatibility
  are not claimed.

No push, publication, pull request, release, merge, or tag mutation is part of this correction.

