<!-- SPDX-License-Identifier: Apache-2.0 -->

# Prototype format notes

All formats are provisional and use exact versioned identifiers. Phase 2 preserves the `fpm.package/1` envelope and `fpm.handler-stdio/1` transport while adding layered profiles, normalized artifact productions, explicit adapters, and transaction actions. Lockfile and provenance documents advance to version 2.

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

## Lockfile and provenance

`fpm.lock/2` records:

- manager identity and source-content hash;
- profile hash and all four input layers;
- build-affecting and observational environment facts;
- packages, dependency edges, licences, and content hashes;
- selected handlers and their execution declarations;
- hook bindings and direct/adapter routes;
- every action, input artifact, output artifact, hash, and build key;
- the final artifact identity, type, file, size, and hash.

`fpm.provenance/2` is optimized for explanation. It links the original contribution and handler finding to the source production, selected adapter when present, final scene input, and render-scene action. `explain` returns this action path for a public export or hook.
