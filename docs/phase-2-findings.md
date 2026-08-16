# Phase 2 findings and discussion issues

Phase 2 meets its narrow success condition: two independent handler families and one explicit adapter produce a deterministic transactional artifact graph which the manager can explain. The renderer and visible scene did not need to change.

## What the prototype established

### 1. The normalized report can support composition

Adding artifact-production proposals was enough for the manager to connect handler-owned domain analysis to generic scheduling. The Texture Handler reports source productions; the Scene Builder reports required typed inputs; the adapter supplies an attributed conversion edge. None of those packages needs the other's domain implementation.

The distinction between a handler proposal and a manager decision is now visible in the records. This is more important than the choice of JSON transport.

### 2. A generic manager-owned DAG is viable at this scale

The manager can validate identities and inputs, detect cycles, topologically schedule actions, and retain complete provenance without knowing what a texture or scene means. That supports the proposed division in which domain planners propose graph structure and the manager accepts and owns it.

The current graph constructor supports direct production and one adapter step only. This is a deliberate policy boundary, not a scheduler limitation.

### 3. Handler independence needs two different boundaries

During planning, the Scene Builder needs its own scene-domain normalized analyses plus binding decisions. It does not receive Texture Handler payloads. During materialisation, it receives only the three declared runtime texture artifacts and its previously proposed scene parameters.

This is a meaningful capability reduction, although not a sandbox. A stricter future planner interface may replace the remaining batch of same-handler analyses with individually referenced inputs.

### 4. Transactionality and security remain orthogonal

The deliberate failure fixture writes a partial staged file and then rejects the action. The manager removes staging and does not create the failed action's cache record or output object. This demonstrates transactional integrity.

The handler process can still access anything allowed to the host user. The staging convention therefore provides rollback, verification, and provenance—not containment.

### 5. Explicit adapters preserve attribution and ambiguity

The solid-colour conversion is a package and a recorded action, not hidden compatibility knowledge in the manager. Removing it creates an unresolved-route diagnostic. Adding an equal second adapter creates ambiguity. A policy selection makes that same graph build deterministically.

This validates explicit adapters as the first richer mechanism beyond nominal equality. It does not yet justify a general subtype system or arbitrary conversion search.

### 6. Content-addressed reuse works without weakening deterministic records

A repeated identical build reuses all action outputs after verifying their stored hashes. The warm build produces byte-identical lockfile, provenance, and scene output because cache-hit observations are not resolution or build facts.

## Issues raised for the next discussion

### Store concurrency, recovery, and garbage collection

The store is robust enough for a single manager process, but it has no cross-process leases, action-record locking, reachability index, quota policy, or garbage collection. Multi-process builds could duplicate work or race on the same record. Recovery from interruption between object import and action-record commit is safe but may leave an unreferenced valid object.

Question: should the next store model use per-build-key leases plus mark-and-sweep reachability from retained lockfiles, or should cache lifecycle be delegated to a separate service?

### Transaction scope

Transactions currently commit one file and one action at a time. This keeps atomicity honest. A future action producing several inseparable files will need a manifest object or directory/tree artifact so the store can commit one content-addressed root rather than pretending several renames are atomic.

Question: should every artifact be a Merkle tree from the outset, even when the common case is one file?

### Planner authority and validation

The Scene Builder still turns all of its own normalized scene exports into one final action proposal. The manager checks generic graph structure but cannot validate domain completeness beyond handler diagnostics.

Question: should independent validator packages be able to attest to planner proposals before policy accepts them, and how should conflicting findings be represented?

### Cache-key responsibility

The reference key includes handler/source package hashes, exact inputs, parameters, target, Node, OS, and architecture. It does not automatically include every policy or manager hash because those facts do not necessarily affect a handler's output bytes.

Question: should handlers declare their build-affecting environment dimensions, with conservative manager policy able to widen—but never narrow—the key?

### Adapter selection granularity

Policy can select an adapter for one hook identity or for an exact source/target pair. The former is precise but repetitive; the latter may be too broad when two domain contexts attach different meaning to the same nominal types.

Question: should adapter policy target a governed semantic relation identity rather than a string pair?

### Layer precedence is represented but not fully governed

`fpm.profile/2` separates distribution, target, policy, and user data. The implemented merge deliberately covers only roots, activation, replacements, and explicit selection maps. It is not yet a general override language and has no fixed-distribution constraints.

Question: which fields are selectable, overridable, or immutable, and which authority owns each rule?

## Recommended next slice

The most useful Phase 3 is probably not more domain content. A focused slice could combine:

1. a multi-file tree artifact committed through one manifest root;
2. concurrent-safe build-key leasing and interruption recovery;
3. a separately attributed validator finding on one proposed action;
4. handler-declared build-environment dimensions;
5. one enforced permission boundary, likely a portable sandboxed action rather than a native handler.

That would test the weakest remaining claims—transaction scale, concurrent store correctness, proposal validation, reproducibility scope, and actual containment—without expanding the renderer.
