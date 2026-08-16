<!-- SPDX-License-Identifier: Apache-2.0 -->

# Prototype format notes

All formats are provisional and use exact versioned identifiers. Phase 4 preserves the Phase 3 build contracts and adds runtime-service declarations, capability selection, identity/lifetime distinctions, and lifecycle records. Lockfile and provenance documents remain version 3.

## Core package envelope

Every package contains `fpm-package.json` with `schema: "fpm.package/1"`. The manager understands only:

- package identity, semantic version, and SPDX licence identifier or expression;
- package dependencies and provided/required capabilities;
- contribution identity, manifest type, and manifest location;
- handler declarations and their accepted/buildable types;
- runtime service declarations, capability versions and requirements, artifact access, and lifecycle module;
- execution form, security-boundary claim, and requested powers;
- explicit one-step adapter declarations;
- public replacement intent.

The manager validates core paths before passing a domain manifest to a handler. Contributions and commands remain inside the owning package directory.

Native execution declarations are intentionally truthful rather than protective:

```json
{
  "form": "external-process",
  "securityBoundary": "none",
  "requestedPowers": [
    "read-declared-input-artifacts",
    "write-manager-staging"
  ]
}
```

The portable alternative declares `form: "portable-wasm"`, `securityBoundary: "wasm-capability-imports"`, byte capabilities, and explicit time/module/input/output/response/process limits. Requested powers remain declaration facts; action records separately preserve the powers actually granted and denied.

## Layered profiles

`fpm.profile/2` keeps four authorities distinct inside one physical document:

- `distribution` — roots, entry point, requested artifact/builder, and activation default;
- `target` — declared build target facts;
- `policy` — provider, handler, and adapter selections;
- `user` — optional roots, replacement choices, and activation override.

The effective package roots are the union of distribution and user roots. User replacement selections override a hook default only when a selected package actually proposes that replacement. Policy never silently ranks ambiguous handlers or adapters.

The reference manager still reads `fpm.profile/1` as a compatibility input and maps its flat fields into these conceptual layers. New examples use version 2.

## Handler protocol

For native handlers, the manager starts a command without a shell and writes one `fpm.handler-request/1` JSON document to stdin. The handler writes one `fpm.handler-response/1` JSON document to stdout. For `portable-wasm`, a manager-owned runner preserves that action contract while exposing only a small byte-capability import ABI to the package module.

The protocol currently implements four actions:

- `analyze` — read one opaque domain manifest and report normalized exports, hooks, activations, and artifact productions;
- `plan` — allow the selected final builder to propose one output action and its typed input requirements;
- `materialize` — write one declared output into a manager-owned staging transaction;
- `adapt` — represented as `materialize` with proposal kind `adapt`, consuming exactly one declared source artifact.

The scene planner receives only analyses produced by its own handler. A materializing handler receives no normalized report collection: it receives its proposal parameters, declared input artifact paths, and one staging output slot.

Handlers return structured negative responses as well as successful results. Process failure, invalid JSON, unsupported protocols, domain rejection, output verification failure, and transaction failure remain distinct diagnostics.

## Normalized manager-facing vocabulary

The shared intermediate representation now distinguishes declarations, handler findings/proposals, and manager decisions.

```text
export:
    public id
    semantic type
    opaque handler-owned payload

hook:
    public id
    required semantic type
    default export id

production proposal:
    action id and kind
    source export id
    output artifact id, type, and suggested file name
    opaque parameters

adapter declaration:
    adapter id
    exact source and target semantic types
    lossless, lossy, or interpretive classification
    implementing handler

manager decision:
    selected package/export/handler/adapter
    reason and responsible input layer
```

The manager compares nominal semantic-type identities and schedules the resulting relations. It does not interpret texture, mesh, scene, or other domain payloads.

## One-step adapter selection

Exact type equality remains the direct-match rule. If a production does not directly yield the required artifact type, the manager considers only a single declared adapter edge:

```text
texture.solid-colour/1
    -- adapter:demo.solid-colour-to-rgba8-srgb/1 -->
texture.runtime.rgba8-srgb/1
```

Arbitrary multi-hop search, structural subtyping, and negotiated compatibility are not implemented. Two equal adapter routes fail with `FPM_ADAPTER_AMBIGUOUS` unless the policy layer selects one by exact hook/requirement identity or governed semantic-relation identity. The selected route is recorded on the hook binding and as its own action.

## Generic action and artifact DAG

Domain handlers propose typed actions and dependencies; the manager owns the accepted graph. It:

- verifies unique action and artifact identities;
- resolves every input to exactly one producing action;
- detects artifact dependency cycles;
- schedules actions in deterministic topological order;
- supplies only resolved input artifacts;
- commits an action record only after verified materialisation.

The current planner proposes one final scene action, while the manager constructs direct source and selected one-step adapter actions for its inputs. The scheduler itself is not scene-specific.

## Manager-owned artifact transaction

For each cache miss:

1. The manager creates an unpredictable private staging directory and one or more named relative output slots.
2. Exact input artifacts are supplied by immutable content-addressed path.
3. The handler writes into staging and returns type, path, byte size, claimed hash, and input observations.
4. The manager validates the path, recomputes byte size and SHA-256, and rejects mismatches.
5. Each verified blob is published by create-if-absent hard link into the content-addressed object store; a tree root is a canonical manifest over already imported blobs.
6. The deterministic action-cache record is written atomically only after the object commit.
7. Whether the action succeeds or fails, its staging directory is removed.

All named roots publish through one immutable action record. Staging constrains the transaction convention but does not sandbox a native handler.

## Cache keys

The action build key covers:

- action identity, kind, and opaque parameters;
- handler package identity, version, and content hash;
- source package content hashes where applicable;
- exact input artifact identities, types, and hashes;
- declared output identity/type/file name;
- declared and policy-widened build-environment dimensions and their values;
- the selected execution form, capability boundary/runner identity, granted powers, and limits.

Absolute package and staging paths are transport context, not key inputs. A cache record is reused only when its object still exists and its hash verifies. Cache-hit status is observational and is not included in deterministic lockfiles.

## Phase 3A: blob and tree roots

Every action produces one or more named artifact roots. A root has kind `blob` or `tree`.

- A blob root addresses the exact bytes of one file.
- A tree root addresses a canonical `fpm.tree/1` manifest. Its entries have normalized slash-separated paths, stable lexical order, explicit `blob` kinds, hashes, and byte sizes.

The manager imports every child blob before importing the tree manifest. It publishes one immutable action record only after every named root verifies. Objects imported before an interrupted publication remain valid but unreferenced; their presence alone never represents a successful action.

## Phase 3A: leases, publication, and reachability

A build-key lease is acquired through atomic directory creation and records owner, action, timestamps, expiry, heartbeat, and current transaction. Other builders verify the action cache while waiting. Expired leases are atomically quarantined and removed before recovery.

Leases reduce duplicate work but do not establish correctness. Immutable object hashes and create-if-absent action-record publication do. If racing executions publish different roots for the same key, the manager emits `FPM_ACTION_NONDETERMINISTIC`; it does not apply first-writer or last-writer policy.

`store-report` performs a non-destructive mark-and-report traversal from retained version-2 action records through tree manifests. It reports invalid records and orphaned objects without deleting them.

## Phase 3A: attributed validation

Handler declarations may expose proposal or artifact validators with exact subject types and rule identities. Findings record subject, validator package/implementation hash, rule/version, phase, verdict, severity, evidence, scope, and conditions.

All findings coexist. The implemented validation policy requires named validators to produce a pass and rejects every unwaived `fail`. A waiver identifies the validator and rule, optionally narrowed to one subject. The finding set, waiver, accepting policy, and final decision are deterministic lockfile/provenance facts.

## Phase 3A: build environment contracts

Each handler declares build-affecting dimensions in `fpm.build-environment/1`. The manager selects those values from normalized runtime, host, and target facts. Policy may monotonically widen the dimension set but cannot remove a handler declaration.

The declaration, widening, values, and artifact transaction protocol are included in the action key and action record. Undeclared facts may remain observational provenance and do not alter that action's key.

## Phase 3A: governed semantic relations

A package may steward a semantic relation with identity, version, exact source and target types, and context roles. An adapter must name a selected relation whose types match its declaration. Adapter policy selects first by exact hook/requirement identity, then by governed relation identity; a raw type pair is diagnostic indexing only and no longer a reusable selection authority.

## Phase 3A: profile authority records

The reference `fpm.profile/2` schema assigns field-level authority and merge rules rather than applying a recursive merge:

- distribution roots and user roots use typed set union;
- entry point and artifact requirement are fixed distribution statements;
- activation is a user-selectable distribution default;
- provider, handler, adapter, and replacement maps are exact selections owned by their declared layers;
- environment-key policy can only widen dependencies;
- validation constraints are monotonic except for attributed waivers;
- target facts are immutable observations.

An unknown statement in a governed layer is unresolved and rejected. Lockfiles record every effective field's source layer, statement kind, merge law, and rule owner.

## Phase 3B: portable WebAssembly capability boundary

The `demo.solid-colour-adapter` is a pure WebAssembly byte transform. The module cannot receive paths or invoke Node APIs. Its only successful imports are:

- `input_length` and `read_input_byte`, backed by the one declared immutable input artifact;
- `write_output_byte`, backed by an in-memory output bounded by the action's declared limit.

After the module returns, the trusted manager runner writes those bytes only to the declared staging slot. No WASI, host-filesystem, package-store, child-process, clock, randomness, or network import is supplied. The child runner enforces a wall-clock timeout, module/input/output/response byte ceilings, and a Node heap limit. Execution identity and the complete requested/granted/denied power record participate in the action key and appear independently of the adapter's semantic role.

The deliberate violation module first reads three declared bytes and writes four staged bytes. It then calls denial-only host-read, host-write, and network probes. Those stubs perform no host operation, record the denied attempts, and force a structured failure. The manager removes staging and publishes neither that action record nor an orphan artifact root.

## Phase 4: runtime services and activation

A package runtime service uses `fpm.runtime-service/1` and declares:

- stable service identity;
- one or more versioned exclusive capabilities;
- required capability identities and semantic-version ranges;
- whether it reads the selected activation artifact;
- explicit `native-in-process` execution with no containment claim;
- a package-relative lifecycle module.

A domain activation report uses `fpm.runtime-activation/1` to name accepted artifact types, root runtime capability requirements, and a deterministic initial tick count. The manager resolves one provider for every requirement. Multiple compatible exclusive providers fail with `FPM_RUNTIME_PROVIDER_AMBIGUOUS` unless profile policy selects a provider package or exact service.

`fpm.runtime-plan/1` records artifact identity, provider selections and reasons, service implementation hashes and execution declarations, dependencies, and activation order. Dependencies activate first. A service context exposes the immutable activation artifact only when declared and resolves only capabilities listed in that service's requirements. An undeclared request fails with `FPM_RUNTIME_AUTHORITY_DENIED`.

`fpm.runtime-lifecycle/1` is committed only after complete activation. It records deterministic activate/tick/deactivate events. Activation failure deactivates the completed prefix in reverse order and leaves no lifecycle file. A provider cannot stop while an active dependent requires it; normal shutdown follows exact reverse activation order.

## Phase 4: live identity and state

The reference runtime fixtures distinguish these contracts:

- definition identity — the built package/world definition;
- persistent instance identity — the world object's semantic identity;
- `fpm.runtime-handle/1` — a slot and generation naming one live materialisation;
- `fpm.materialisation-lease/1` — strong access keeping that materialisation live;
- mutation authority — a separately selected write capability.

Releasing the final lease may reclaim the materialised slot but does not destroy persistent identity. Explicit destruction removes the persistent instance. Slot reuse increments its generation, so an old handle cannot resolve to a new occupant.

Transform Authority exposes separate read-snapshot and write-command capabilities. Scene Extractor receives only read capabilities and publishes a deeply immutable flat scene revision. The renderer depends on that snapshot capability and has no transform-write authority.

## Lockfile and provenance

`fpm.lock/3` records:

- manager identity and source-content hash;
- profile hash and all four input layers;
- build-affecting and observational environment facts;
- packages, dependency edges, licences, and content hashes;
- selected handlers and their execution declarations;
- hook bindings and direct/adapter routes;
- every action, input artifact, output artifact, hash, and build key;
- the final artifact identity, type, file, size, and hash.

It additionally records root kinds, named action outputs, per-action environment dependencies, governed semantic relations, validator findings/decisions, and resolved profile authority.

Each action also records execution separately from semantic action/adapter identity: form, boundary and runner, requested powers, actual grants, ambient powers denied by construction, and applied resource limits.

`fpm.provenance/3` is optimized for explanation. It links the original contribution and handler finding to the source production, governed relation and selected adapter when present, validation decision, final scene input, and render-bundle tree root. `explain` returns this action path for a public export or hook.
