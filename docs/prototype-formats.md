<!-- SPDX-License-Identifier: Apache-2.0 -->

# Prototype format notes

All formats are provisional and use exact versioned identifiers. Phase 7 preserves the earlier build, runtime, durable-state, and collection contracts while adding declared runtime tasks, immutable snapshot grants, staged command buffers, authoritative batch commit, and deterministic tick records. Lockfile and provenance documents remain version 3.

## Core package envelope

Every package contains `fpm-package.json` with `schema: "fpm.package/1"`. The manager understands only:

- package identity, semantic version, and SPDX licence identifier or expression;
- package dependencies and provided/required capabilities;
- contribution identity, manifest type, and manifest location;
- handler declarations and their accepted/buildable types;
- runtime service declarations, capability versions and requirements, artifact access, and lifecycle module;
- runtime provider bindings, optional requirements, collection cardinality/member metadata, and declared content-store access;
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
- `policy` — provider, handler, adapter, and collection-exclusion selections;
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

`fpm.runtime-plan/2` records artifact identity, provider selections and reasons, service implementation hashes and execution declarations, dependencies, capability collections, and activation order. Dependencies activate first. A service context exposes the immutable activation artifact only when declared and resolves only capabilities listed in that service's requirements. An undeclared request fails with `FPM_RUNTIME_AUTHORITY_DENIED`.

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

## Phase 5: coherent provider bindings

A provided or required runtime capability may name a generic provider binding. Every selected facet carrying the same binding resolves to one service instance:

```text
runtime.transforms/1
    runtime.transforms.read
    runtime.transforms.write
    state-owner:demo.transforms/1 collection member
```

Policy may select by binding identity. The plan records the provider instance once and records every capability selection separately. This prevents a reader, writer, saver, and restorer from accidentally addressing different state domains. Optional requirements are explicit and return no capability when no compatible provider is present; they never apply an arbitrary fallback.

## Phase 5: durable state fragments and save trees

A state-owning service exposes `fpm.state-owner/1` as an attributed member of `runtime.state.owner`. Its contract declares a semantic schema identity and integer version, required/optional status, governing capability, provider, state-owner dependencies, capture, quiesce-before-restore, and restore operations.

Capture produces a deeply immutable `fpm.state-fragment/1` at a coordinator-supplied `fpm.runtime-tick/1` checkpoint. Domain revision is recorded separately from the shared checkpoint. The coordinator validates that every fragment names the same checkpoint but does not interpret owner payloads.

`fpm.world-save/1` is stored as an ordinary canonical `fpm.tree/1` containing `save-manifest.json` plus one JSON fragment blob per owner. The manifest records:

- immutable save identity and format version;
- shared checkpoint;
- distribution and runtime-plan identities;
- collection member and provider-binding identities, attributed metadata root, fragment schema/version, required status, governing capability, provider package and implementation hash;
- exact fragment blob root, owner revision, declared dependencies, and definition references;
- migration history.

Objects and the tree root are imported before one create-only `fpm.artifact-reference/1` is published. That reference is the semantic commit point. An interruption before it leaves reportable orphan objects and cannot replace an earlier valid save. Save identities are immutable rather than mutable slots.

## Phase 5: compatibility, restore, and migration

Restore reads the manifest first and builds a compatibility report before invoking state owners. Missing optional owners leave their fragment roots recorded as `retained-uninterpreted`; their payload is not parsed. A missing required owner fails activation with its schema, capability, last provider, available migration evidence, and reason. No runtime lifecycle or session record is committed.

Selected owners prepare for restore in reverse dependency order, then restore in dependency order. Ordinary motion, extraction, and rendering services require the coordinator's ready capability, so they activate only after restore succeeds. The coordinator publishes `fpm.runtime-session/1` only from the runtime host's post-activation commit hook.

Migration is one step and explicit. `fpm.state-migration/1` declares one exact schema/version input and output. Two compatible implementations fail as ambiguous unless profile policy selects one. A successful migration publishes a separate immutable derived fragment tree and records the package, implementation hash, input/output roots, and selection policy; the original save remains untouched.

## Phase 5: live browser updates

The loopback renderer still consumes only immutable scene snapshots. Its initial page opens one server-sent-event stream, and each renderer tick replaces only the displayed SVG with the newest snapshot. This closes the Phase 4 presentation gap without introducing general gameplay networking or giving the renderer mutation authority.

## Phase 6: generic capability collections

A runtime requirement with `cardinality: "collection"` selects every compatible contribution in the already-resolved package graph. Every provided member declares a stable identity, provider-instance binding, dependency identities, and opaque attributed metadata. The manager validates these generic relations; it does not interpret the metadata.

`fpm.capability-collection-plan/1` records the deterministic member order, package and implementation hashes, provider bindings, metadata roots, requesters, and explicit exclusions. `fpm.capability-collection/1` presents that fixed plan plus each activated member value as a deeply immutable capability view. Duplicate member identities fail with contributor attribution. Missing dependencies and dependency cycles fail before activation.

Collection policy is subtractive and explicit. A `collectionPolicy` entry names its policy identity and exact excluded members. The plan records the responsible policy and excluded provider. There is no ambient self-registration, implicit priority, or discovery-order tie-break.

The Save Coordinator now declares only one collection requirement. Instance, transform, Marker, Required Counter, and the later Character Journal package participate through the same contract. Its source contains no list of known owner packages or capabilities. Restore ordering derives from manager-validated member dependencies, while payload interpretation remains with each owner.

Membership means all compatible contributions from selected packages, not every package merely present on disk. Adding a package to the distribution/user graph is still an explicit package-resolution decision. Membership is fixed before activation; hot registration and removal are outside this prototype.

## Phase 7: runtime-task declarations

Runtime tasks are ordinary members of the generic `runtime.task` collection. Manager core records their member identity, provider binding, implementation hash, dependencies, and opaque metadata without interpreting task semantics. The selected Scheduler validates `fpm.runtime-task/1` values against metadata declaring:

- simulation phase and required/optional participation;
- immutable snapshot capabilities;
- emitted command channels and composition form;
- commit-order predecessors distinct from execution dependencies;
- `main-thread` or `any-worker` affinity;
- reentrant or non-reentrant execution;
- abort-tick or drop-task failure behaviour.

One service still publishes one member of a collection. `demo.motion` and `demo.motion-offset` are consequently separate task services and packages.

## Phase 7: snapshot, worker, and barrier protocol

At each tick the clock publishes `fpm.runtime-tick/1`, Transform Authority freezes `fpm.transform-snapshot/1`, and the Scheduler grants each task only the snapshots and output channels named by that member. `any-worker` tasks execute in actual Node.js worker threads. A `main-thread` task executes through a separately declared main-thread implementation.

On a restored session, the Scheduler resumes the clock from the save's world checkpoint before accepting new work. Host tick count remains a generation-local lifecycle observation; task records continue the persisted world-checkpoint sequence.

Workers cannot obtain runtime service capabilities through their task context. Undeclared snapshot access fails with `FPM_TASK_SNAPSHOT_AUTHORITY_DENIED`; direct mutable capability access fails with `FPM_TASK_DIRECT_AUTHORITY_DENIED`. These are architectural checks for trusted native code, not hostile-code containment.

Each successful worker returns staged commands. The Scheduler constructs immutable `fpm.runtime-command-buffer/1` values tagged with task, channel, checkpoint, and content root. No task receives Transform Authority's write capability.

The first channel is `runtime.transforms.commands` with an `ordered` composition law. All producers must have a complete declared commit order. Missing ordering fails scheduler planning before runtime commitment. Transform Authority validates the checkpoint, expected revision, buffer roots, order, and every opaque-to-the-scheduler transform operation against a cloned state map. Only after all validation succeeds does it publish one `fpm.transform-batch-commit/1` and increment the transform revision once.

The current scheduler also validates `single-producer`; other named forms are reserved but deliberately fail as unimplemented. Cross-owner atomic commit is outside this phase.

## Phase 7: deterministic and observational records

`fpm.deterministic-tick/1` records only deterministic facts:

- checkpoint and selected task member/provider/implementation/metadata roots;
- attributed task-policy exclusions and deterministic task outcomes;
- immutable snapshot roots and source revisions;
- accepted command-buffer roots;
- channel composition law and declared commit order;
- authoritative resulting revision and state root.

`fpm.deterministic-tick-log/1` contains successful records. A required task failure or timeout publishes no successful tick record and leaves Transform Authority unchanged. Stale expected revisions or checkpoints are rejected.

`fpm.runtime-tick-trace/1` is separate observational evidence. It may contain worker count, actual completion order, thread affinity, and thread IDs. None enters deterministic tick identity, save state, or rendering. Tests reverse completion order and vary the worker count while asserting byte-identical tick logs, state snapshots, and SVG output.

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
