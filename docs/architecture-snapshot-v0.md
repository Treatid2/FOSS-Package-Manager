<!-- SPDX-License-Identifier: Apache-2.0 -->

# FOSS Package Manager prototype architecture snapshot v0

**Status:** experimental; no compatibility promise.

Record the executable distinctions established through Phase 4 without freezing them as a public compatibility promise.

This file is generated from `contracts/architecture-v0.json` by `tools/render-architecture-snapshot.mjs`.

## Universal envelope and core vocabulary

**Classification:** manager-core.

The manager owns package identity, versions, licences, dependency/capability edges, contributions, handlers, semantic relations, runtime services, replacements, and execution declarations; domain payloads remain opaque.

- `fpm.package/1`
- `fpm.profile/1 compatibility input`
- `fpm.profile/2 governed input`

## Normalized manager-facing report

**Classification:** manager-core.

Handlers translate extension manifests into attributed exports, hooks, activations, productions, findings, and plans. The manager compares identities and types but does not interpret domain payloads.

- `fpm.handler-request/1`
- `fpm.handler-response/1`
- `public export and hook identities`
- `typed production proposals`

## Action proposals and committed action records

**Classification:** manager-core.

A proposal describes work and declared roots. The manager validates and schedules the accepted DAG. An immutable action record is the semantic commit point and is published only after every named root verifies.

- `fpm.action-key/2`
- `fpm.action-cache/2`
- `fpm.artifact-transaction/2`

## Blob and tree artifact identity

**Classification:** manager-core.

A blob is identified by its exact bytes. A tree is identified by a canonical manifest over sorted normalized blob entries. Object presence alone never represents a successful action.

- `sha256 blob identity`
- `fpm.tree/1`
- `named blob-or-tree roots`

## Findings and policy decisions

**Classification:** manager-core.

Independent attributed findings coexist. Policy records required passes, unwaived failures, exact waivers, and the rule responsible for acceptance without voting or overwriting evidence.

- `fpm.validation-finding/1`
- `fpm.validation-decision/1`

## Governed semantic relation identity

**Classification:** manager-core.

A vocabulary package stewards a versioned relation identity. Hooks reference it, adapters implement it, and policy may select by exact requirement or relation identity. Conversion remains one step.

- `relation:<vocabulary>/<name>/<version>`
- `exact nominal source and target types`

## Profile statement authority

**Classification:** manager-core.

Every implemented profile field has a statement kind, owning layer, and merge law. Unknown statements fail; lower-authority layers cannot silently redefine fixed distribution facts.

- `fpm.profile/2`
- `fpm.profile-authority-record/1`

## Execution forms and powers

**Classification:** manager-core.

Semantic role is distinct from execution form. Declarations record requested powers; action records separately preserve actual grants, denied ambient powers, runner identity, environment dimensions, and limits.

- `external-process with host-user authority`
- `portable-wasm with byte-capability imports`
- `data-only declarations`
- `native-in-process runtime service`

## Runtime service identity and lifecycle

**Classification:** manager-core.

The manager selects exclusive service capabilities, activates providers dependency-first, injects only declared capabilities, commits a lifecycle record after complete activation, and shuts down in reverse dependency order. Definition, persistent instance, generational handle, materialisation lease, and mutation authority are distinct identities.

- `fpm.runtime-service/1`
- `fpm.runtime-activation/1`
- `fpm.runtime-plan/1`
- `fpm.runtime-lifecycle/1`
- `fpm.runtime-handle/1`
- `fpm.materialisation-lease/1`

## Manager core concepts and extension dialects

**Classification:** boundary.

The manager selects and authorises active providers for store, scheduling, portable execution, policy, profile authority, and runtime lifecycle. Texture, scene, worldspace, motion, and rendering schemas are independently implemented extension dialects.

- `core authority does not imply permanent monolithic implementation`
- `extension payload meaning remains outside the manager`

## Deliberate boundary

This snapshot records the current experiment. It is not a compatibility guarantee, a registry reservation, or a claim that the reference manager must forever contain the only implementation of a manager-authorised responsibility.
