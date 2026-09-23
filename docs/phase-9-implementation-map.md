<!-- SPDX-License-Identifier: MPL-2.0 -->

# Phase 9 implementation map

**Branch:** `phase-9/persistent-workspace-generations`  
**Starting commit:** `cf2a0c45ba8d41459c9771f873f2cc993897bc50`  
**Hub cycle:** `FGPM-CYCLE-000007`  
**Project package cycle:** `FGPM-CYCLE-000004`

Phase 9 adds a durable curation and generation layer above the accepted Phase 8 package,
artifact, runtime-service, persistence, collection, and task contracts. It does not reinterpret
those contracts. The central boundary is that workspace edits, candidate planning, generation
commit, and runtime activation are four different transactions.

## Reused facilities

| Existing facility | Reuse in Phase 9 | Boundary |
| --- | --- | --- |
| `hashDirectory`, `stableJson`, and `sha256` in `src/core/io.mjs` | Package-tree, record, and semantic identities | Observational fields are kept outside identity inputs. |
| `discoverPackages` and isolated public validation | Imported package envelope validation and normalized dependency/capability facts | Recursive discovery remains an import adapter, never the installed-state authority. |
| `ArtifactStore` immutable objects, tree references, leases, and reachability report | Package-tree publication, derived-package files, verification, and orphan evidence | Package roots and derived-package provenance receive their own public records and indexes. |
| `prepareProfile` / `buildProfile` | Existing package resolution, specialist analysis, artifact transaction, validators, and runtime-plan inputs | Candidate planning does not execute handlers or mutate artifact state. Materialisation is explicit. |
| `resolveRuntimePlan`, `startRuntime`, `RuntimeHost` | Activation of one already-built generation and immutable per-generation collections | A new coordinator owns the generation checkpoint, active reference, session commit, and rollback. |
| Phase 5 persistence and state-owner collections | Checkpoint creation/restore and optional/required owner evidence | The generation coordinator does not decode specialist state payloads. |

## Manager-core durable layout

The Phase 9 manager root is explicit and independent from the build artifact store:

```text
<manager-root>/
  package-store/objects/sha256/<prefix>/<root>/tree/...
  installed/index.json
  installed/identities/<package-id>/<version>.json
  workspaces/<encoded-name>/head.json
  workspace-revisions/<sha256>.json
  candidates/<sha256>.json
  candidate-validations/<sha256>.json
  generations/<sha256>.json
  distributions/<sha256>.json
  derived/<sha256>.json
  runtime/active.json
  runtime/sessions/<sha256>.json
  runtime/checkpoints/<sha256>.json
  events/*.json
  locks/<reference>.lock/
```

Immutable records are create-only and verified when reopened. Mutable references are replaced
atomically while their exact old value is held under a bounded filesystem lease. Package bytes
are retained; Phase 9 exposes no destructive collection operation.

## Gate A — package store and workspace transaction

### Import commit point

1. Validate one `fpm-package.json` through the public package path.
2. Hash the exact package tree and stage/copy it under its content root.
3. Verify the staged tree and create the immutable root record.
4. Under the installed-index lease, reject an existing ID/version with another root or merge
   provenance for an identical root.
5. Atomically replace `installed/index.json`.

The installed index is observational availability state. Import does not write any workspace,
candidate, generation, active-runtime reference, or build action.

### Workspace revision and compare-and-swap boundary

A mutable workspace name points to an immutable `fpm.workspace-revision/1` root. A revision records
its parent, base generation, accepted staged-operation vocabulary, explicit choices, and
attribution. To edit:

1. acquire the workspace-head lease;
2. compare the supplied expected head with `head.json`;
3. publish the new immutable revision;
4. atomically replace the head;
5. release the lease.

The workspace display name is a reference label and is excluded from candidate and generation
identity. No arbitrary JSON patch operation is accepted.

## Gate B — candidate and impact transaction

`fpm.candidate/1` is a deterministic, immutable plan from:

```text
base generation + selected package roots + explicit choices + target/policy roots
```

It contains no wall-clock, process, worker, cache, path, or display-name input. Planning applies
staged operations without changing the workspace or store and records `blocked` or
`ready-to-build`. Build and validation produce new immutable candidate-stage records rather than
mutating the plan.

The planner constructs deterministic forward and reverse indexes for package dependencies,
capability providers/consumers, public ownership/binding, adapters/relations, derived inputs,
artifact actions, runtime services, collection members, state owners/schemas, task/channel
participation, and retained generation/distribution references. Each impact entry contains a
causal path rooted in a changed package root or explicit choice. Unvisited roots are reported as
reusable.

## Gate C — derivation and generation commit

A requested generated integration result is materialised once into a normal package tree with
`fpm.derived-package-provenance/1`. Its key includes generator package/implementation root, exact
package and artifact inputs, parameters, and declared semantic environment. Identical inputs reuse
the root. A generated package may not request another generated package in Phase 9.

Generation commit is:

1. verify a validated candidate and all referenced roots;
2. verify the candidate still names the current workspace head and base;
3. publish create-only `fpm.generation/1`;
4. create the next immutable workspace revision with that generation as base and no staged edits;
5. compare-and-swap the workspace head under the same reference lease;
6. append the attributed commit event.

An interruption between steps 3 and 5 leaves the old head authoritative and the generation
reportable as an unreferenced immutable root. Two commits from one old head cannot both move the
reference.

## Gate D — self-contained distribution replay

Export writes a deterministic `fpm.distribution/1` manifest plus the exact generation, source
package, derived-package, and runtime/artifact roots into a self-contained directory bundle.
Import verifies hashes before publishing any installed/generation reference. Enumeration or member
order is excluded from identity. A fresh manager root must reopen the same generation and retain
the same runtime-plan, deterministic-tick, and visible-output roots.

## Gate E and X — runtime transition, rollback, and exit

The generation coordinator consumes an already committed generation and a specialist runtime
adapter. It does not perform package resolution during activation.

```text
preflight -> barrier -> one checkpoint -> stop G0 -> activate/restore G1
          -> commit G1 session -> move active reference
```

The active reference is the commit point. Before it moves, activation or required-state restore
failure invokes the old generation adapter against the same checkpoint and leaves G0 authoritative.
An explicit rollback is another full transition and creates a new runtime-session identity.

Removal planning uses the candidate reverse indexes. Required dependants/state owners block;
optional state remains an opaque checkpoint fragment; derived inputs invalidate their output; old
generations and distributions remain retention reasons for package bytes.

## Gate F — synthetic packages and benchmark evidence

`tools/phase-9-synthetic-graph.mjs` creates ordinary, strict public package manifests in seeded
forest, chain, star, diamond, fan-in, fan-out, subsystem, equal-provider, collection,
derived-fan-out, duplicate, and cycle families. The harness uses package import and workspace
planning APIs only.

`tools/run-phase-9-benchmarks.mjs` records deterministic facts separately from timings, memory,
machine, Node, filesystem, cold/warm, and worker observations. Acceptance runs cover 10, 100, and
1,000 packages. Ten thousand is exploratory. Reports count visited packages/actions and compare
them with the measured affected closure; they make no asymptotic or production-performance claim.

## Public formats and CLI

Phase 9 durable records use exact `.../1` schema identities, a closed unknown-field policy, stable
JSON, machine validators, and explicit identity-input documentation. Public JSON schemas and
examples accompany each durable boundary.

The CLI exposes distinct package, workspace, candidate, generation, distribution, and activation
commands. Inspection commands never activate a runtime, and committing a generation never
activates it.

## Specialist boundary

Manager core owns package/store identity, workspace/CAS mechanics, generic graph impact,
candidate/generation/distribution identities, retention, and generic transition commit points.
Specialist packages continue to own domain manifests, adapter meaning, integration generation,
validation, state encoding/migration, runtime-service behavior, task semantics, and rendering.

