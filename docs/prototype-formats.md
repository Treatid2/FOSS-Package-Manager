<!-- SPDX-License-Identifier: Apache-2.0 -->

# Prototype format notes

All formats are provisional and use exact versioned identifiers. Phase 3A preserves the `fpm.package/1` envelope and `fpm.handler-stdio/1` transport while extending artifact roots, decisions, environment contracts, semantic relations, and profile authority. Lockfile and provenance documents advance to version 3.

## Core package envelope

Every package contains `fpm-package.json` with `schema: "fpm.package/1"`. The manager understands only:

- package identity, semantic version, and SPDX licence identifier or expression;
- package dependencies and provided/required capabilities;
- contribution identity, manifest type, and manifest location;
- handler declarations and their accepted/buildable types;
- execution form, security-boundary claim, and requested powers;
- explicit one-step adapter declarations;
- public replacement intent.

The manager validates core paths before passing a domain manifest to a handler. Contributions and commands remain inside the owning package directory.

The implemented execution declaration is intentionally truthful rather than protective:

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

Trust is a future policy conclusion; it is not inferred from execution form.

## Layered profiles

`fpm.profile/2` keeps four authorities distinct inside one physical document:

- `distribution` — roots, entry point, requested artifact/builder, and activation default;
- `target` — declared build target facts;
- `policy` — provider, handler, and adapter selections;
- `user` — optional roots, replacement choices, and activation override.

The effective package roots are the union of distribution and user roots. User replacement selections override a hook default only when a selected package actually proposes that replacement. Policy never silently ranks ambiguous handlers or adapters.

The reference manager still reads `fpm.profile/1` as a compatibility input and maps its flat fields into these conceptual layers. New examples use version 2.

## Handler protocol

The manager starts a handler command without a shell and writes one `fpm.handler-request/1` JSON document to stdin. The handler writes one `fpm.handler-response/1` JSON document to stdout.

Phase 2 implements four actions:

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

Arbitrary multi-hop search, structural subtyping, and negotiated compatibility are not implemented. Two equal adapter routes fail with `FPM_ADAPTER_AMBIGUOUS` unless the policy layer selects one by target identity or exact `source=>target` pair. The selected route is recorded on the hook binding and as its own action.

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

1. The manager creates an unpredictable private staging directory and one relative output slot.
2. Exact input artifacts are supplied by immutable content-addressed path.
3. The handler writes into staging and returns type, path, byte size, claimed hash, and input observations.
4. The manager validates the path, recomputes byte size and SHA-256, and rejects mismatches.
5. The verified file is atomically renamed into the content-addressed object store.
6. The deterministic action-cache record is written atomically only after the object commit.
7. Whether the action succeeds or fails, its staging directory is removed.

The prototype permits one file output per action. Staging constrains the transaction convention but does not sandbox a hostile handler.

## Cache keys

The action build key covers:

- action identity, kind, and opaque parameters;
- handler package identity, version, and content hash;
- source package content hashes where applicable;
- exact input artifact identities, types, and hashes;
- declared output identity/type/file name;
- Node version, host platform/architecture, and declared target layer.

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

`fpm.provenance/3` is optimized for explanation. It links the original contribution and handler finding to the source production, governed relation and selected adapter when present, validation decision, final scene input, and render-bundle tree root. `explain` returns this action path for a public export or hook.
