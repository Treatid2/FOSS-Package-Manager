<!-- SPDX-License-Identifier: MPL-2.0 -->

# Phase 9 decision log

## D01 — keep curation state separate from the artifact cache

**Decision:** A caller supplies an explicit Phase 9 manager root. Package roots, installed state,
workspace revisions, candidates, generations, distributions, sessions, and active references live
there. Phase 8's `.fpm-store` remains the artifact/action store.

**Reason:** Package availability and curator intent are authoritative state; build cache entries are
reconstructible. Combining them would obscure retention and commit boundaries.

## D02 — immutable records expose their identity inputs

**Decision:** Every immutable manager record carries a `sha256:` identity and the stable
`identityInputs` from which it was calculated. Observational timestamps are confined to mutable
references, events, and benchmark records.

**Reason:** Tests and external tools can verify identities without private source lookup.

## D03 — filesystem leases protect compare-and-swap references

**Decision:** Installed-index and workspace-head changes use bounded create-directory leases,
expected-head comparison, create-only immutable publication, and atomic reference replacement.

**Reason:** This is the smallest cross-process mechanism already consistent with Phase 6 artifact
transactions. It prevents lost edits and permits deterministic stale-candidate diagnostics without
introducing a database.

## D04 — candidate stages are separate immutable records

**Decision:** Planning produces `fpm.candidate/1`; materialisation produces
`fpm.candidate-build/1`; validation produces `fpm.candidate-validation/1`.

**Reason:** A candidate does not mutate from blocked to validated. Each later record points back to
the exact plan and is independently attributable.

## D05 — derived output is a normal package tree

**Decision:** One accepted generation request writes a strict `fpm.package/2` tree containing
`fpm.derived-package-provenance/1`, then imports it through the same public package path. The
generated semantic version is derived from the derivation key unless explicitly supplied.

**Reason:** Exact generator, package/artifact inputs, parameters, environment, and output bytes
determine reuse. A second derivation layer is rejected.

## D06 — the first distribution is a verified directory bundle

**Decision:** Phase 9 exports a self-contained local directory with a deterministic distribution
manifest, exact generation record, package trees, byte counts, and SHA-256 values.

**Reason:** It proves self-contained replay and member-order independence without choosing an
archive container or remote transport. A later packaging layer may archive the directory without
changing its semantic identity.

## D07 — generation activation is adapter-driven but executable

**Decision:** `GenerationRuntimeCoordinator` owns checkpoint, shutdown, activation/restore,
session publication, active-reference movement, and rollback. `phase8RuntimeFactory` adapts the
accepted Phase 8 `RuntimeHost` and world-save service.

**Reason:** Manager core controls transaction boundaries while specialist services continue to own
state payloads and activation behavior. Tests exercise both deliberate adapters and the real Phase
8 runtime.

## D08 — preserve the frozen Phase 8 authoring kit

**Decision:** New schemas are published in `contracts/phase-9/`, which explicitly consumes the
Phase 8 public-contract bundle. They are not added to the byte-locked
`authoring-kit/runtime-task-v2/public` file set.

**Reason:** An initial attempt to add the curation schema to `public/schemas` correctly failed the
external authoring-kit checksum. Separating the manager contract preserves the accepted clean-room
boundary while making Phase 9 durable formats public and machine-readable.

## D09 — scale evidence uses public entry paths

**Decision:** The seeded synthetic generator writes strict `fpm.package/2` trees. Benchmarks call
package import, workspace staging, candidate planning, validation, and generation commit rather
than private graph routines.

**Reason:** The results include real validation, hashing, copying, indexing, and durable-record
costs. Ten, 100, and 1,000 are acceptance sizes; 10,000 remains explicitly deferred exploration.

