# Implementation findings and discussion issues

The prototype is useful precisely because it forced several attractive abstractions to become concrete. These are the issues worth discussing before broadening the implementation.

## 1. The normalized handler report is becoming the real common language

The universal envelope can remain small only because handlers return a shared report containing exports, hooks, semantic types, defaults, activations, diagnostics, and artifact proposals. That report is more consequential than the JSON encoding of package manifests.

Question: which of these concepts belong to a stable core vocabulary, and which should themselves be extensible dialects?

Current bias: keep identity, ownership, semantic compatibility, requirements, artifact claims, and diagnostics in the core; keep domain payloads opaque.

## 2. Subprocess separation is not a security boundary

JSON over stdio gives clean failure and evolution boundaries, but the handler still has normal user authority. A production manager needs an explicit trust model covering signatures, granted permissions, filesystem views, network access, CPU/memory/time limits, and native-code policy.

Question: should trusted native handlers and sandboxed portable handlers be different package/activation classes from the outset?

## 3. Package-owned IDs simplify conflicts but narrow shared-name semantics

Requiring `pkg:<owner>/...` prevents two unrelated packages from accidentally claiming the same definition. The duplicate-ID fixture therefore represents a broken package/handler reporting the same owned ID twice, not two packages naturally colliding on a global name.

Question: do we need separately governed identities for standards, shared semantic vocabularies, or intentionally co-owned extension points?

## 4. Exact semantic-type equality is deliberately crude

The manager currently accepts a replacement only when its semantic-type string exactly matches the hook. This makes the first incompatibility diagnostic honest and deterministic, but it does not express subtyping, parameterized qualities, negotiated variants, or adapters.

Question: should compatibility be declared by versioned adapters, by a semantic-type registry, or by handler-provided proofs/proposals that policy then selects?

## 5. Ambiguity is surfaced, not ranked away

Two compatible head replacements fail unless the profile explicitly selects one. There is no priority, load order, popularity score, or arbitrary lexical winner.

Question: which choices may policy make automatically, and which must remain explicit user/distribution decisions recorded in the lockfile?

## 6. The build protocol will not scale to large artifacts as written

Returning a small JSON scene through stdout is excellent for the experiment. Textures, compiled modules, shader caches, and world data need staged files, content-addressed storage, streaming, or artifact leases. Handlers should probably propose outputs and hashes into a manager-controlled staging area rather than returning bulk data.

Question: what is the minimal artifact transaction protocol that preserves isolation, reproducibility, cacheability, and provenance?

## 7. One builder currently sees every normalized export

The prototype toolchain performs the entire domain build in one call. A real graph needs multiple handlers producing intermediate artifacts without granting one builder omniscient domain authority.

Question: should the manager schedule a declared artifact DAG, or should a higher-level build-planner package construct that DAG?

## 8. Reproducibility still omits important environment inputs

The lockfile hashes packages and artifacts, but the manager identity is a declared constant and the target environment is not captured. It does not yet hash the manager executable/source, Node runtime, OS/architecture, policy implementation, or external toolchains.

Question: which environment facts affect resolution, which affect build output, and which belong only in observational provenance?

## 9. Profiles currently combine distribution policy and user selection

The profile names roots, entry points, builders, runtime activation, and conflict selections. This is effective for the prototype but conflates a curated distribution, machine/environment policy, and one user's choices.

Question: should these become layered inputs with a recorded precedence model rather than one document?

## 10. Licensing is architectural policy, not housekeeping

The initial repository applies MPL-2.0 to the reference manager and core implementation, preserving a file-level repairable commons. Public package-language/specification material, conformance fixtures, profiles, tests, and example package/handler/runtime implementations use Apache-2.0 so independent implementations can adopt them permissively.

Independent package authors may declare other licences through SPDX identifiers or expressions. The manager will eventually need to report redistribution and repairability properties without pretending that installation compatibility implies licence compatibility. The canonical open distribution should avoid closed packages at structural articulation points.

## Suggested next prototype

The most informative next slice is not more rendering. It is a second independent handler family and an intermediate artifact boundary—for example, a texture analyzer/builder separate from the scene toolchain—plus one explicit adapter. That would test whether normalized reports and artifact provenance compose without quietly recreating a monolithic engine inside one handler.
