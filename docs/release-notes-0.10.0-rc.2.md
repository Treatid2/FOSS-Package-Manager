<!-- SPDX-License-Identifier: MPL-2.0 -->
# FGPM 0.10.0-rc.2 — public execution enablement candidate

This is a new candidate, not accepted/released/published/deployed/installed.
The exact assessed rc.1 archive remains byte-for-byte retained and unchanged.
Public execution requires new manager bytes; this candidate must be assessed
before any downstream FGRW composition use. It is not a relabelled rc.1.

Source lineage includes rc.1 b783e15 and both earlier accepted identity and
inert host-maintenance commits. This change adds generic package-owned runtime
session transport through public control operations runtime.session.open,
runtime.session.call and runtime.session.close. No dungeon method, identity,
scenario, package pin or behavior is encoded in manager core. Consumers supply
exact live generation, capability, protocol, provider and explicit methods.
Buffers cross the public boundary only as canonical base64 argument wrappers.
Handles are bound to the original owned runtime session, including same-generation
reactivation, and are stopped before owned host shutdown/transition/EOF cleanup.
Rejected transition preconditions do not revoke handles. This does not claim
transactional package operations or persistent-world-state rollback.

The published control catalogue changes additively and therefore has a new root.
The package-identity schema and supported-tree content hashing remain unchanged.
The reviewed manager build-semantic identity remains unchanged because these are
public execution/control facilities, not resolution/build-semantic changes.
Runtime payload, distribution, public-contract, source and licensing/SBOM identities
are computed separately. Node remains pinned official Windows x64 24.18.0.

See guide/public-runtime-sessions.md for the public contract, limits, exact
commands and failure semantics. The API is expert-supported, not enabled for
the initial guided curator agent profile, and is not a security sandbox.

Qualification reports must distinguish the original source-executed complete
manager regression from any source-free public behavior subset. Source inspection,
Git/build correspondence and Workbench implementation tests in the original
137-case suite are not silently substituted by a black-box smoke suite. A source-free
complete-regression resource requires explicit case-by-case coverage, not a count
manufactured by reusing names. No FGRW baseline construction or historical proof
rewriting is part of this manager change. Historical dungeon-v04 proof stays pinned
to its reviewed 0.9.0 contract.

Manager/core/build tooling MPL-2.0; public contract/documentation/conformance
material Apache-2.0; bundled Node preserves complete upstream licence/notices.
