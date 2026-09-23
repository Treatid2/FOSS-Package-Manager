<!-- SPDX-License-Identifier: Apache-2.0 -->

# FOSS Package Manager prototype architecture snapshot v0

**Status:** experimental; no compatibility promise.

Record the executable distinctions established through Phase 7 without freezing them as a public compatibility promise.

This file is generated from `contracts/architecture-v0.json` by `tools/render-architecture-snapshot.mjs`.

## Universal envelope and core vocabulary

**Classification:** manager-core.

The manager owns package identity, versions, licences, dependency/capability edges, contributions, handlers, semantic relations, runtime services, replacements, and execution declarations; domain payloads remain opaque.

- `fgpm.package/1`
- `fgpm.profile/1 compatibility input`
- `fgpm.profile/2 governed input`

## Normalized manager-facing report

**Classification:** manager-core.

Handlers translate extension manifests into attributed exports, hooks, activations, productions, findings, and plans. The manager compares identities and types but does not interpret domain payloads.

- `fgpm.handler-request/1`
- `fgpm.handler-response/1`
- `public export and hook identities`
- `typed production proposals`

## Action proposals and committed action records

**Classification:** manager-core.

A proposal describes work and declared roots. The manager validates and schedules the accepted DAG. An immutable action record is the semantic commit point and is published only after every named root verifies.

- `fgpm.action-key/2`
- `fgpm.action-cache/2`
- `fgpm.artifact-transaction/2`

## Blob and tree artifact identity

**Classification:** manager-core.

A blob is identified by its exact bytes. A tree is identified by a canonical manifest over sorted normalized blob entries. Object presence alone never represents a successful action.

- `sha256 blob identity`
- `fgpm.tree/1`
- `named blob-or-tree roots`

## Findings and policy decisions

**Classification:** manager-core.

Independent attributed findings coexist. Policy records required passes, unwaived failures, exact waivers, and the rule responsible for acceptance without voting or overwriting evidence.

- `fgpm.validation-finding/1`
- `fgpm.validation-decision/1`

## Governed semantic relation identity

**Classification:** manager-core.

A vocabulary package stewards a versioned relation identity. Hooks reference it, adapters implement it, and policy may select by exact requirement or relation identity. Conversion remains one step.

- `relation:<vocabulary>/<name>/<version>`
- `exact nominal source and target types`

## Profile statement authority

**Classification:** manager-core.

Every implemented profile field has a statement kind, owning layer, and merge law. Unknown statements fail; lower-authority layers cannot silently redefine fixed distribution facts.

- `fgpm.profile/2`
- `fgpm.profile-authority-record/1`

## Execution forms and powers

**Classification:** manager-core.

Semantic role is distinct from execution form. Declarations record requested powers; action records separately preserve actual grants, denied ambient powers, runner identity, environment dimensions, and limits.

- `external-process with host-user authority`
- `portable-wasm with byte-capability imports`
- `data-only declarations`
- `native-in-process runtime service`

## Runtime service identity and lifecycle

**Classification:** manager-core.

The manager selects exclusive service capabilities, resolves fixed non-exclusive collections, co-selects bound facets from one provider instance, activates providers dependency-first, injects only declared capabilities, commits after complete activation, and shuts down in reverse dependency order. Definition, persistent instance, generational handle, materialisation lease, mutation authority, state fragment, and saved tree are distinct identities.

- `fgpm.runtime-service/1`
- `fgpm.runtime-activation/1`
- `fgpm.runtime-plan/2`
- `fgpm.runtime-lifecycle/1`
- `provider-instance bindings and optional requirements`
- `fgpm.runtime-handle/1`
- `fgpm.materialisation-lease/1`

## Open-ended capability collections

**Classification:** manager-core.

A collection requirement selects every compatible contribution in the resolved package graph. Stable member identities, provider bindings, dependency edges, metadata roots, and explicit exclusions form one deterministic immutable plan; duplicates and cycles fail before activation. Member metadata remains opaque to manager core.

- `collection capability cardinality`
- `fgpm.capability-collection-plan/1`
- `fgpm.capability-collection/1`
- `explicit keyed-member policy subtraction`

## Deterministic runtime concurrency

**Classification:** boundary.

A manager-selected scheduler consumes a fixed attributed task collection, grants immutable snapshots and staged output channels, runs eligible tasks on worker threads or their declared main-thread affinity, and submits buffers to one authoritative commit barrier. Worker timing remains observational; explicit channel composition determines committed state.

- `fgpm.runtime-task/1`
- `fgpm.runtime-command-buffer/1`
- `fgpm.transform-command-batch/1`
- `fgpm.transform-batch-commit/1`
- `fgpm.deterministic-tick/1`
- `fgpm.deterministic-tick-log/1`
- `fgpm.runtime-tick-trace/1`

## Durable typed world state and evolution

**Classification:** boundary.

Selected runtime authorities join one generic state-owner collection and capture opaque typed fragments at one checkpoint. A coordinator consumes the fixed attributed collection, publishes one immutable content-addressed save tree, preflights restore, retains absent optional state, rejects missing required owners, and records explicit one-step migration without manager-core interpretation of domain payloads.

- `fgpm.state-owner/1`
- `fgpm.state-fragment/1`
- `fgpm.world-save/1`
- `fgpm.artifact-reference/1`
- `fgpm.state-migration/1`
- `fgpm.runtime-session/1`

## Manager core concepts and extension dialects

**Classification:** boundary.

The manager selects and authorises active providers for store, scheduling, portable execution, policy, profile authority, and runtime lifecycle. Texture, scene, worldspace, motion, and rendering schemas are independently implemented extension dialects.

- `core authority does not imply permanent monolithic implementation`
- `extension payload meaning remains outside the manager`

## Deliberate boundary

This snapshot records the current experiment. It is not a compatibility guarantee, a registry reservation, or a claim that the reference manager must forever contain the only implementation of a manager-authorised responsibility.
