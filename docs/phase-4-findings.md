# Phase 4 findings

Phase 4 shifts the experiment from build-time correctness to the smallest useful live runtime graph. It is single-threaded and deliberately keeps the existing SVG renderer and crude scene.

## Runtime service resolution and lifecycle

Selected packages may declare `fpm.runtime-service/1` providers with versioned exclusive capabilities, capability requirements, explicit artifact access, and an execution class. A selected `fpm.runtime-activation/1` names root requirements. The manager resolves the resulting service graph, rejects ambiguity, records every selection, activates dependencies first, and injects only capabilities declared by each consumer.

The successful activation record is `fpm.runtime-lifecycle/1`. It contains the artifact root, selected providers and reasons, service declarations and implementation hashes, requested and actual powers, activation order, deterministic ticks, and lifecycle events. It is written only after every service activates. Shutdown is the reverse of dependency activation.

The CLI can explain either a service or capability:

```powershell
node src/cli.mjs explain-runtime build/green-head/runtime-lifecycle.json runtime.transforms.write
```

## Identity and lifetime

The Runtime Instance Store distinguishes:

- built definition identity;
- persistent world instance identity;
- a generational runtime handle naming one materialisation;
- a strong materialisation lease;
- explicit semantic destruction.

Releasing the last lease reclaims the materialised slot but retains the persistent record and definition. Rematerialisation preserves the world identity while advancing the slot generation. `destroy(instance_id)` removes persistent identity and invalidates every lease and handle. Reusing the slot cannot make an old handle name the new occupant.

The store, not the manager, owns slots, generations, lease counts, and persistent instance records.

## Authoritative movement and immutable extraction

Transform Authority is the only selected ordinary writer of final transform state. Demo Motion receives the write capability and submits one typed transform command per deterministic clock tick. Scene Extractor receives instance-read and transform-read capabilities, combines a frozen transform revision with built definitions, and returns a deeply immutable `fpm.render-scene/1` snapshot. The unchanged SVG projection renders that snapshot.

The normal fixture moves `world:demo/character-1` sideways for two ticks, verifies revision 2, and renders the moved head and body. Releasing Transform Authority's final materialisation lease does not remove its persistent transform; rematerialising the instance retains the moved state.

## Deliberate fixtures

### Stale handle

The fixture destroys one instance, reuses its slot for another, and verifies that the old generation fails with `FPM_RUNTIME_HANDLE_STALE`.

### Release is not destruction

The final lease is released. Persistent identity and definition remain, rematerialisation succeeds with a new generation, and Transform Authority retains the committed translation.

### Authority violation

An observer declares only `runtime.transforms.read` and then requests `runtime.transforms.write`. The host rejects it with `FPM_RUNTIME_AUTHORITY_DENIED`, rolls back the already active dependencies, and writes no lifecycle record.

### Ambiguous exclusive provider

A second transform service makes both read and write capabilities ambiguous. Runtime planning fails until profile policy selects `demo.transform-authority`; the reason and responsible policy choice are recorded per capability.

### Activation rollback

A provider fails after its renderer dependency chain activates. Every active service deactivates in exact reverse order and no live lifecycle record is committed.

### Dependency-safe shutdown

Stopping Instance Store while Transform Authority remains active fails with `FPM_RUNTIME_DEPENDENTS_ACTIVE`. Normal shutdown records the exact reverse activation order.

## Phase 4 limitations and deferrals

- Runtime service modules are trusted native in-process code with host-user authority; capability injection is an architectural authority boundary, not memory-safe containment against malicious native code.
- The manager-owned runtime host remains part of the trusted computing base. Its internal boundary is kept separate so a future authorised provider could replace it without changing domain schemas.
- The loop is intentionally single-threaded. Call affinity, reentrancy, state-domain access declarations, scheduling, locks, and synchronization are deferred.
- Persistent state is retained only for the process lifetime. Save/reload and schema migration are deferred to a later phase.
- Hot replacement, streaming, networking, and engine integration remain out of scope.
- Renderer and browser-window responsibilities remain physically combined in one service, although their root capability and dependencies are explicit.
