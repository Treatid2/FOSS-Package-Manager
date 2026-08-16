# Phase 7 findings: deterministic runtime concurrency

## Result

Phase 7 satisfies the proposed success condition at prototype scale.

A manager-selected Scheduler consumes a generic attributed task collection. Two independently packaged tasks receive the same immutable transform snapshot, run in real Node.js worker threads with deliberately varied delays and worker counts, and emit staged command buffers. Their completion order changes. Their declared commit order does not. Transform Authority applies `set-x` before `add-x` in one validated batch and advances the authoritative transform revision once.

Repeated runs produce byte-identical deterministic tick records, transform state, immutable scene snapshots, and SVG output. Worker count, completion order, affinity, and operating-system thread identity remain in a separate observational trace.

## Executable contracts

### Scheduler selection and task collection

`demo.deterministic-scheduler` is an ordinary exclusive runtime-service provider bound to `runtime.scheduler/1`; manager core does not schedule workers. The service requires the fixed `runtime.task` collection, clock, transform read/write provider bundle, and restore-ready barrier.

Each `fpm.runtime-task/1` member is fully declared before activation. The collection record attributes its package and service implementation, provider binding, member dependencies, opaque metadata, and policy exclusions. The Scheduler validates phase, snapshot grants, output channels, commit constraints, affinity, reentrancy, required status, and failure behaviour.

Task dependency cycles are rejected by the generic collection planner before the Scheduler or any worker starts.

### Immutable inputs and staged outputs

At tick N, both motion tasks receive the same `fpm.transform-snapshot/1` revision and `fpm.runtime-tick/1` checkpoint. Their worker context exposes only:

- the declared immutable snapshots;
- the declared command output channels;
- checkpoint and execution-affinity facts.

It exposes no mutable transform handle or general runtime capability lookup. Fixtures prove that undeclared snapshot access and direct transform-write acquisition abort the barrier with no state mutation.

A restored Scheduler resumes its clock from the saved world checkpoint. The first new record therefore advances N to N+1 instead of resetting the persistent checkpoint sequence for a fresh process generation.

Worker results become `fpm.runtime-command-buffer/1` values. Each buffer is attributed to its task and carries the checkpoint, channel, commands, and canonical content root. Buffers remain proposals until the authoritative batch commit.

### Explicit composition and atomic transform commit

The transform command channel is order-sensitive. `task:demo.motion/set-x/1` declares no predecessor. `task:demo.motion-offset/add-x/1` declares the set task as its commit predecessor. Execution remains concurrent because this is a commit-order edge, not an execution dependency.

The Scheduler requires complete pairwise ordering for every producer on an ordered channel. The unordered-producer fixture fails with both contributors and `runtime.transforms.commands`; it does not fall back to completion, discovery, activation, or lexical order.

Transform Authority clones its map, validates the batch/checkpoint/source revision, buffer roots/order, target instances, and domain operations, then swaps the validated state into authority and increments its revision once. Required task failure or timeout discards every successful sibling buffer. Stale output is rejected before mutation.

### Deterministic record versus observation

`fpm.deterministic-tick/1` records:

- checkpoint;
- selected tasks and implementation/metadata roots;
- policy exclusions and deterministic outcomes;
- snapshot revision and root;
- accepted buffer roots;
- composition law and commit order;
- authoritative input/output revisions and resulting state root.

The record identity excludes worker count, delay, completion order, and thread IDs. `fpm.runtime-tick-trace/1` records those as observations. Tests use one and two workers plus opposite injected delays, obtain opposite completion orders, and compare the deterministic tick log, transform snapshot, rendered scene, and SVG byte for byte.

### Affinity and reentrancy

`any-worker` tasks execute in Worker threads and report nonzero worker thread IDs. The Main Thread Audit task declares `main-thread`, executes through the Scheduler's main-thread path, and reports that affinity. A main-thread declaration without a main-thread implementation fails activation.

One runtime generation rejects overlapping host ticks. The Scheduler independently retains a non-reentrant in-flight guard and records each member's reentrancy declaration. This first prototype rejects rather than queues overlap.

### Optional exclusion

The existing exact-member collection policy can exclude the optional add-x task even though its package remains selected. The runtime plan and deterministic tick record carry the policy attribution. The remaining set-x task commits alone, producing the correspondingly different but deterministic transform.

## Manager and extension boundary

Manager core understands generic service selection, collection membership/dependencies, provider bindings, lifecycle, capability injection, and the non-overlapping host tick boundary. It records task metadata but does not interpret it.

Scheduler understands the generic task execution envelope and, for this narrow experiment, the available immutable transform snapshot and transform command channel. Task packages understand their own calculations. Transform Authority alone interprets and commits transform operations. Scene Extractor and the renderer observe only the committed immutable revision after the scheduler barrier.

## Issues retained for discussion

### The first scheduler has one commit domain

Only `runtime.transforms.commands` commits. Simultaneous transactions across transforms, inventory, physics, journals, or quests are deliberately absent. Cross-owner atomicity needs a separate use case and protocol.

### Worker creation is intentionally simple

The Scheduler creates short-lived Worker instances per task invocation and limits concurrent slots. It does not maintain a persistent pool, implement work stealing, optimize transfer lists, or benchmark large task graphs. The experiment tests semantics rather than throughput.

### Native workers are not a security sandbox

The task context enforces declared access for conforming modules, and workers do not receive runtime capability objects. A native task module still runs with the user's process authority and can import Node.js APIs. Worker isolation here is execution isolation, not hostile-code containment.

### Reentrancy is generation-wide

The runtime currently rejects overlapping ticks for the whole activation generation. It does not yet serialize only the affected non-reentrant members while overlapping reentrant work. The stronger global rule is deterministic but conservative.

### Composition support is deliberately narrow

The vocabulary names ordered, single-producer, commutative-reduce, and set-union forms. This prototype implements ordered and validates single-producer; the other forms fail explicitly. They should acquire implementations only with real domains and reducer identities.

### Tick-record files are not crash durability

The in-memory committed record is the semantic runtime evidence and the JSON log is a deterministic diagnostic artifact. Phase 7 does not add filesystem flush barriers or recover a process interrupted while writing the diagnostic log.

## Deferred work

Phase 7 does not include shared mutable task memory, package-visible mutexes, lock-order negotiation, cross-owner transactions, dynamic task registration, hot package replacement, GPU scheduling, streaming, networking, engine integration, or native-code containment.

This should be the last planned pure-kernel phase before an architectural review. The prototype now has executable evidence for build composition, transactional artifacts, runtime authority and lifetime, durable state/migration, open-ended package participation, and deterministic parallel work. The next experiment should be driven by a real external renderer/engine subsystem, larger content scale, or authoring tools used by another human contributor.
