# Phase 5 findings: durable world state and package evolution

## Result

Phase 5 satisfies the proposed success condition at prototype scale.

A world can move for two deterministic ticks, publish one immutable tree of typed state fragments, shut every runtime service down, terminate the producing Node process, restore in a second process with fresh service instances, and render the identical moved scene before another simulation tick. The same mechanism preserves explicit destruction, does not mistake lease release for destruction, migrates transform state from schema version 1 to version 2 through an attributed package, retains absent optional package state without parsing it, and rejects an unavailable required owner before committing a runtime lifecycle or session.

The confirmed Phase 4 browser gap is also closed. The renderer now emits each immutable SVG snapshot over a loopback server-sent-event stream, so the already-loaded page moves without refresh. This is presentation transport only, not gameplay networking.

## Executable contracts

### Coherent provider instances

Runtime capability declarations can carry a generic binding identity. `runtime.transforms.read`, `runtime.transforms.write`, and `runtime.transforms.state` all bind to `runtime.transforms/1`. Once policy or sole-provider resolution selects that binding, every facet comes from the same service instance. The runtime plan records both individual selections and the binding-to-provider decision.

This closes the split-brain possibility identified after Phase 4 without teaching manager core what a transform is.

### Typed owner fragments

Instance Store and Transform Authority each expose one `fpm.state-owner/1`. Character Marker is an optional third owner; the required-counter failure fixture is a required third owner. Each declares:

- semantic state schema and version;
- required or optional reconstruction status;
- governing runtime capability and provider;
- state-owner dependencies;
- capture, prepare-for-restore, and restore operations.

Capture returns `fpm.state-fragment/1`. Every fragment carries the coordinator's exact clock checkpoint plus its owner's independent state revision. Payload meaning remains with the state owner.

### Atomic save publication

The coordinator serializes each fragment as an immutable blob and constructs `fpm.world-save/1` inside a canonical `fpm.tree/1`. The tree and all child blobs enter the existing content-addressed object store before a create-only `fpm.artifact-reference/1` is published under the save identity.

That reference is the commit point. The interruption fixture stops after object import and before reference publication. It proves:

- the interrupted save cannot be opened;
- the previous save remains valid;
- the newly unreachable objects appear in the non-destructive store report;
- object presence alone is not a committed save.

### Restore ordering and session commit

The coordinator reads and preflights the entire save manifest before mutating an owner. Selected owners prepare in reverse dependency order, allowing dependants to release materialisation leases, then restore in dependency order. Motion, scene extraction, and rendering depend on `runtime.restore.ready`, so they activate only after restore succeeds.

The runtime host invokes a post-activation commit hook only after every service has activated. The coordinator publishes `fpm.runtime-session/1` at that point. A failed compatibility check rolls back the activated prefix and leaves neither a successful lifecycle nor session record.

### Package absence and migration

When Character Marker is absent, its optional fragment remains addressed by the original immutable save and appears in the compatibility report as `retained-uninterpreted`. The coordinator does not parse its payload. Reintroducing the package allows the original label and counter to restore from the same save.

When a required-counter owner is absent, load fails with the required state schema, schema version, governing capability, last provider, migration evidence, and explicit reason.

Transform Authority v2 owns `fpm.demo.transform-state` version 2. The selected migration package consumes the immutable v1 fragment and publishes a separate immutable migrated-fragment tree. The session records package, service, implementation hash, input/output roots, derived artifact root, and selection policy. The original save remains version 1 with an empty migration history. Two available migration services remain ambiguous until exact profile policy selects one.

## Identity and lifetime evidence

The implementation now distinguishes:

```text
package definition identity
    != persistent world-instance identity
    != live materialisation handle
    != materialisation lease
    != state-owner schema identity/version
    != state-fragment blob root
    != committed world-save tree root
    != restored runtime session
```

Releasing Transform Authority's final character lease before saving does not remove the character from the instance fragment. Explicitly destroying the field does remove it and records a tombstone; the field remains absent after restart. Handles and leases are deliberately not serialized.

## Manager and extension boundary

Manager core now understands:

- optional versus required capability edges;
- provider-instance binding equality;
- dependency activation and post-activation commit;
- narrow read/read-write access to generic artifact-tree references;
- content hashes, tree roots, create-only reference publication, and reachability.

Manager core does not understand instance, transform, marker, migration-payload, or renderer semantics. Save Coordinator understands the generic fragment envelope and compatibility procedure but treats every owner payload as opaque. State owners alone interpret their payloads.

## Issues retained for discussion

### State-owner enumeration is explicit

The coordinator currently declares each optional state capability it knows (`instances`, `transforms`, `marker`, and the required-counter fixture). This gives precise authority and works for the experiment, but an open package ecosystem will need a generic non-exclusive capability collection or an attributed registry so a new state-owning package need not modify the coordinator.

### Atomic publication is not yet crash durability

Create-only reference publication gives a clear semantic commit point and survives the simulated interruption boundary. The prototype does not issue filesystem flush/barrier operations, validate storage-device guarantees, or recover a partially written reference after an operating-system or hardware power loss. Production save durability remains separate work.

### Distribution mismatch is reported, not globally ranked

Loading under a different lockfile or runtime-plan identity is allowed when every required schema is directly supported or explicitly migrated. The committed session records both identities and compatibility booleans. A future policy layer may choose stricter distribution matching; the prototype does not silently assert that every mismatch is safe or unsafe.

### Save identities are immutable

Publishing different bytes under an existing save identity fails. Mutable user-facing slots, generations, retention, deletion, and garbage collection are deferred. A caller currently chooses a new identity for each revision.

### Native services remain trusted

State-owner, coordinator, migration, and renderer modules are native in-process code with host-user authority. Capability injection records and tests intended authority but does not contain malicious native code.

## Deferred work

Phase 5 does not add multithreaded scheduling, lock negotiation, hot replacement, region streaming, remote/cloud saves, arbitrary migration chains, native-code containment, or a general editor. The shared checkpoint and prepare/restore dependency contracts are now available for a later concurrency experiment.
