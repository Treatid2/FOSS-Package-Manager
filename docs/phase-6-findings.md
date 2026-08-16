# Phase 6 findings: open-ended capability collections

## Result

Phase 6 satisfies the proposed success condition at prototype scale.

`demo.character-journal` was added after the persistence coordinator was complete. The package owns a note and visit counter, activates through ordinary package resolution, appears automatically in the manager-built state-owner collection, saves and restores its fragment, can be absent or explicitly excluded while its state remains uninterpreted, and recovers the same state when reintroduced. Manager core, Save Coordinator, Restore Coordinator, and existing packages contain no Journal-specific name or capability.

The mechanism is generic. Persistence is its first consumer, but manager core understands only collection identity, member identity, provider binding, dependencies, opaque metadata, selection policy, and deterministic order.

## Executable contracts

### Fixed attributed membership

A provided runtime capability may declare `cardinality: "collection"`, a stable member identity, a provider-instance binding, member dependencies, and opaque metadata. A collection requirement selects all compatible contributions from packages already present in the resolved graph.

The runtime plan now uses `fpm.runtime-plan/2` and embeds `fpm.capability-collection-plan/1`. Each member record includes:

- stable member and collection identities;
- provider service, binding, package, version, and implementation hash;
- capability version and member dependencies;
- opaque declaration metadata and its content root.

The activated consumer receives `fpm.capability-collection/1`, an immutable view combining those records with their attributed runtime values. No package mutates a global registry and membership cannot change after activation.

### Determinism and dependency order

Provider candidates, binding groups, member identities, dependencies, requests, and collection records are sorted by stable identifiers. Member activation edges derive from the declared dependency graph. Reversing package discovery order produces an identical runtime plan, world-save manifest/root, and committed session record.

Two selected packages declaring the same member fail with `FPM_RUNTIME_COLLECTION_MEMBER_DUPLICATE` and both contributors. Cyclic member dependencies fail with `FPM_RUNTIME_COLLECTION_DEPENDENCY_CYCLE` before any service activates or restore mutation begins. A missing or policy-excluded dependency is a separate attributed failure.

### Explicit exclusion

Profile policy may subtract exact optional members from a collection. The policy statement has its own identity, and the runtime plan records the excluded member, package, provider, policy, and reason. Unknown exclusions and exclusion of every member fail rather than silently changing meaning.

Excluding Character Journal keeps its package in the selected package graph but prevents its service from activating through the collection. Loading an earlier save retains the Journal fragment as opaque state. The original save tree is not rewritten.

### Generic persistence participation

Save Coordinator now requires only `runtime.state.owner` with collection cardinality. It does not name instance, transform, Marker, Journal, or fixture capabilities. It verifies that every activated `fpm.state-owner/1` value matches the manager-attributed member metadata and provider binding, then records those identities and roots in the save manifest.

Restore matches modern saves by stable collection member. A semantic-schema fallback reads the Phase 5 save shape, preserving prototype checkpoint compatibility. Required absent members fail compatibility before lifecycle/session commitment; optional absent members remain `retained-uninterpreted`. Restore order derives from collection member dependencies.

### Coherent provider facets

Journal read, write, and state-owner contribution share `runtime.journal/1`. The collection member and ordinary facets therefore resolve to the same provider service. The runtime plan and save fragment record that binding, implementation hash, and metadata root. The existing Transform Authority v1/v2 fixtures exercise the same rule across provider substitution and migration.

## Identity evidence

Phase 6 adds another explicit distinction:

```text
collection capability identity
    != collection member identity
    != provider-instance binding
    != package or service implementation identity
    != semantic state schema identity/version
    != captured fragment root
```

The stable member identifies participation in a governed collection. The binding requires coherent facets. The metadata root attributes the declaration. The semantic schema governs payload compatibility. None is silently substituted for another.

## Issues retained for discussion

### Selection still precedes collection

Collections include contributions from selected packages, not every manifest found on disk. A distribution or user layer must still place a package in the resolved graph. This preserves authority and avoids turning discovery into ambient activation, but future repository/user experience must make that selection intelligible.

### Membership is static

The collection is fixed before activation. Hot plug-in registration, runtime package removal, and live collection rebinding are deliberately absent. Those features would need transactional lifecycle and state rules rather than mutation of this immutable view.

### One service publishes one value per collection capability

The current service response is keyed by capability, so a single service cannot publish several independently identified members of the same collection. Separate services or a later member-keyed response envelope would be required. The present fixtures need only one member per service.

### Policy supports explicit subtraction only

Policy can exclude exact members and select providers for a binding. It does not rank members, impose quotas, or synthesize optional defaults. More expressive collection policy should be added only with an explicit merge law and provenance.

### Native services remain trusted

Manager-built attribution and capability injection expose incoherence and unauthorized interface use, but native in-process services retain host-user authority. Collection membership is governance, not containment.

## Deferred work

Phase 6 does not introduce multithreaded scheduling, dynamic registries, arbitrary migration paths, crash-durable storage, mutable save slots, garbage collection, or native-code containment.

The next useful experiment is deterministic concurrency. The same generic mechanism can collect task contributions while a scheduler reasons about immutable snapshot reads, command outputs, authoritative commit barriers, thread affinity, and reentrancy without exposing internal mutexes as package language.
