<!-- SPDX-License-Identifier: MPL-2.0 -->

# Post-Phase-7 architecture review

- **Review subject:** `phase-7-prototype`
- **Commit:** `cea2b57cfe777c8607358bea16661690343594e8`
- **Review branch:** `review/post-phase-7-architecture` (local only)
- **Compatibility status:** experimental; this review does not create a version 1 promise.

## Review controls and evidence

The Phase 7 implementation was preserved before this review as the annotated, published
`phase-7-prototype` tag. The review branch resolves to the same commit. No implementation
was refactored or repaired during evidence gathering.

The supplied review packet refers to an included `source-basis/` directory.
**[contradicted by implementation]** No such directory exists at the checkpoint. The repository instead
contains the historical findings as `docs/phase-2-findings.md` through
`docs/phase-7-findings.md`, plus `docs/implementation-notes.md`. Those files were used as
claims to test, not as proof.

The evidence pass covered:

- the package, profile, manager, architecture-snapshot, and prototype-format declarations;
- discovery, resolution, profile authority, handler invocation, build planning, artifact
  transactions, runtime planning, lifecycle, persistence, collections, and scheduling code;
- successful example packages and deliberate failure fixtures;
- all four test files and their exercised records and diagnostics;
- a clean baseline run of `npm test` (56 passed, 0 failed) and
  `npm run contracts:check` at the checkpoint.

The labels used below are deliberately strict:

- **[demonstrated]** — an executable fixture directly exercises the conclusion;
- **[supported but limited]** — code and fixtures support the conclusion inside a stated
  boundary, but not at production or ecosystem scale;
- **[inferred]** — the conclusion follows from inspected structure but lacks a focused test;
- **[assumed]** — the design depends on it without implementation evidence;
- **[contradicted by implementation]** — prose or public language says something the code
  does not do.

## Decision in one paragraph

**[supported but limited]** The prototype advances the founding proposition at laboratory
scale. It demonstrates that packages can declare attributed relations, specialist handlers
can propose work without sharing domain implementations, the manager can make explicit
generic decisions, and specialist runtime authorities can compose through immutable
snapshots, capability collections, staged commands, and durable typed fragments. It does
not yet demonstrate an independently authored ecosystem. The current public language is a
set of prose notes and examples whose complete operational meaning still depends on source
archaeology, especially at the runtime-service and task boundary. Several mechanisms
described as selectable manager authorities are hard-wired, and several accepted
declarations are not enforced. Phase 7 is therefore a successful experimental checkpoint,
not an externally stable package platform.

## Architecture without phase chronology

### 1. Selection and resolution

**[demonstrated]** A governed profile supplies package roots, distribution roots, an entry
point, a requested artifact, target facts, policy selections, and user additions. The
manager recursively discovers package manifests below the named filesystem roots, hashes
each package directory, chooses one version per selected package identity, expands package
dependencies and package-level capability requirements, rejects ambiguity, and produces a
dependency-first package order.

**[supported but limited]** Discovery means “present under a configured directory.” There is
no repository client, installation transaction, installed-package database, signature
verification, or lockfile replay. The resolver chooses the highest compatible discovered
version using a deliberately small semantic-version implementation.

### 2. Declaration analysis and public relations

**[demonstrated]** Selected contribution declarations are dispatched to selected handlers.
Handlers interpret domain manifests and return normalized exports, hooks, activations, and
artifact-production proposals. The manager validates package ownership of public export and
hook identities, retains handler/package attribution, resolves hook defaults and selected
replacements, and either accepts an exact artifact type or selects one explicit governed
one-step adapter.

**[supported but limited]** The common normalized report is real, but it has no complete
machine-readable schema. Validation covers the fields needed by the examples, not a closed
public envelope. Unknown package-manifest fields are not rejected.

### 3. Build decisions and artifact publication

**[demonstrated]** A specialist builder proposes a final action and typed inputs. Independent
validators emit findings; policy records the findings, waivers, and acceptance consequence.
The manager constructs and validates the accepted action/artifact DAG, executes actions in a
deterministic dependency order, supplies exact immutable inputs and private staging slots,
verifies output roots, and publishes immutable action records only after every named root is
present.

**[demonstrated]** Blob and flat-tree identities, cold/warm record stability, concurrent
cross-process publication, stale-lease recovery, rollback after handler failure, orphan
reporting after interruption, and rejection of divergent results for one build key all have
focused fixtures.

**[supported but limited]** The store is local-filesystem infrastructure embedded in the
reference manager. It has no flush barriers, deletion, quota, remote coordination, retained
lockfile index, or production recovery procedure. Native handler execution is synchronous
in the manager process; because `spawnSync` blocks the event loop, a lease heartbeat cannot
renew during a native action. An action longer than the lease duration can therefore be
mistaken for a stale lease by another process. Immutable publication still protects the
result, but duplicate-work avoidance is weaker than the prose suggests.

### 4. Runtime planning and lifecycle

**[demonstrated]** The selected activation declares root runtime requirements. The manager
selects exclusive capability providers, co-selects facets sharing one provider binding,
constructs fixed capability collections from the selected package graph, validates member
identity/dependency rules, activates services dependency-first, injects declared
capabilities, calls post-activation commit hooks, records the lifecycle, and shuts down in
reverse dependency order. Ambiguity, missing authority, cycles, activation rollback, and
unsafe early shutdown have executable failures.

**[supported but limited]** `context.require()` is an architectural interface boundary for
cooperating native services. It is not containment: every native module retains host-user
authority. The runtime host also gives every service the same `context.options` object,
including paths and controls not declared as capabilities. That options bag is an ambient
architectural channel even though the process is already fully trusted.

### 5. Runtime state, tasks, and rendering

**[demonstrated]** Instance Store owns persistent world identities, generational materialized
handles, and leases. Transform Authority owns final transform state. A selected scheduler
consumes a fixed task collection, gives tasks one immutable snapshot and staged output
channels, runs worker-affinity tasks on Node worker threads, and submits buffers to Transform
Authority in a complete declared commit order. Scene extraction and rendering observe the
committed immutable revision.

**[demonstrated]** Worker count and completion order can vary while deterministic tick
records, committed transform state, rendered scene, and SVG bytes remain identical.

**[supported but limited]** The task dialect is transform-specific: one simulation phase,
one available snapshot family, one implemented ordered command channel, and one authoritative
commit domain. The scheduler is a specialist package, but no separately selected vocabulary
package governs the task metadata, command-channel identity, or transform-operation dialect.

### 6. Persistence and evolution

**[demonstrated]** State owners join a generic attributed collection. Save Coordinator
captures typed fragments at one checkpoint, stores an immutable world-save tree, publishes
one create-only reference as the commit point, preflights restore, retains absent optional
state without parsing it, rejects missing required state, restores owners in dependency
order, and commits a session only after runtime activation succeeds.

**[demonstrated]** A new Journal owner joins without manager or coordinator name knowledge;
save/reload across process termination, release-versus-destruction, optional state
reintroduction, provider binding, and a transform-state v1-to-v2 migration all have focused
fixtures.

**[contradicted by implementation]** Migration selection is not generic across state-owner
schemas. Save Coordinator explicitly requests `runtime.transforms.migration` and holds one
transform-specific migration value. A new state-owner family cannot add its own migration
path without changing the coordinator or reusing that transform-specific capability.

## Founding proposition audit

| Proposition | Conclusion | Evidence boundary |
| --- | --- | --- |
| Packages declare externally relevant structure in a common inspectable language. | **[supported but limited]** | Core manifests and profiles are inspectable JSON, and normalized reports are recorded. Complete handler/runtime/task contracts are prose-plus-examples, not machine schemas. |
| The manager resolves selected-package relations without domain meaning. | **[demonstrated]** | Package edges, nominal types, governed relations, action dependencies, service bindings, and collection membership are handled generically. |
| Specialist packages interpret domain declarations and provide implementations. | **[demonstrated]** | Texture, scene, transforms, persistence coordination, scheduling, extraction, and rendering live outside `src/core`. |
| Build, activation, change, save, and diagnosis use explicit attributable relations. | **[supported but limited]** | Records and fixtures cover every listed stage, but runtime service options and some ordering defaults remain implicit. |
| The result supports robust independent modification. | **[supported but limited]** | Green Head, Character Journal, adapters, validators, migrations, and two task packages vary independently inside the repository. No genuinely fresh external author has yet succeeded without source access. |

## Central distinctions

| Distinction | Review conclusion |
| --- | --- |
| declaration != implementation | **[demonstrated]** Manifests name handlers/services and records retain package implementation hashes separately. |
| proposal != decision | **[demonstrated]** Handler plans, production proposals, findings, route choices, accepted DAGs, and committed records are distinct objects. |
| finding != policy consequence | **[demonstrated]** Conflicting findings coexist; exact waiver or rejection is separately recorded. |
| available != installed | **[contradicted by implementation]** “Available” is discoverable on disk; “installed” has no representation or operation. |
| installed != selected | **[assumed]** Selection exists, installation does not. |
| selected != resolved | **[supported but limited]** Roots and transitive selections are distinguishable in memory, but the public lockfile presents one resolved package list and no separate selected-state record. |
| resolved != collected | **[demonstrated]** Only resolved packages can contribute; collection plans separately record included and excluded members. |
| collected != activated | **[demonstrated]** Collection planning precedes service activation, and failed activation commits no lifecycle. |
| definition identity != world-instance identity | **[demonstrated]** Built definitions and persistent instance IDs are separate in Instance Store and saved fragments. |
| world-instance identity != runtime handle | **[demonstrated]** Handles contain slot/generation while persistent instance IDs survive rematerialization. |
| runtime handle != materialisation lease | **[demonstrated]** Several leases can retain one handle; releasing the last lease reclaims only materialization. |
| release != semantic destruction | **[demonstrated]** Release preserves persistent identity; `destroy()` creates lasting semantic absence. |
| persistent state != runtime materialisation | **[demonstrated]** Handles/leases are not serialized and fresh services restore typed fragments. |
| execution order != completion order | **[demonstrated]** Worker traces vary independently from deterministic records. |
| completion order != declared commit order | **[demonstrated]** Opposite worker completions produce the same declared transform buffer order. |
| deterministic fact != observational trace | **[demonstrated]** Tick records exclude worker count, delay, completion order, and thread IDs; cache hits are excluded from lockfiles. |
| architectural authority != hostile-code containment | **[demonstrated]** Documentation and execution records state the distinction; native escape remains possible, while one narrow Wasm ABI withholds ambient imports. |

### Distinctions that are currently duplicative or inert

- **[contradicted by implementation]** Runtime capability `exclusive` and `cardinality`
  encode the same choice and must agree (`true`/`exclusive`, `false`/`collection`). One
  discriminant is sufficient.
- **[contradicted by implementation]** Task `failure` is validated and recorded but never
  controls behavior. The scheduler aborts when `required` is true and drops when it is false,
  regardless of `failure`. The two fields are currently duplicate, potentially contradictory
  policy statements.
- **[supported but limited]** Task `reentrancy` is recorded, but every overlapping tick is
  rejected generation-wide. `reentrant` has no permissive effect yet.
- **[supported but limited]** Task `phase` must be exactly `simulation`; it distinguishes no
  implemented phases.
- **[contradicted by implementation]** Profile `policy.permissions` is accepted by the
  profile parser but is not represented in the authority record and affects no execution
  decision.

## Manager responsibility classification

“Manager core” below means a generic semantic responsibility, not a requirement that the
reference implementation remain one monolith. “Manager-authorized infrastructure” means
the manager must choose and attest the mechanism, but a provider can implement it.

| Responsibility actually present | Current location | Classification | Review |
| --- | --- | --- | --- |
| Package identity, version, licence field, core paths, content hash | `discovery.mjs` | Manager core | **[supported but limited]** Correct generic responsibility; licence syntax is only checked as non-empty, not parsed as SPDX. |
| Recursive filesystem discovery | `discovery.mjs` | Repository/install adapter | **[supported but limited]** Suitable laboratory adapter, not an installation model. |
| Package dependency and package-capability resolution | `resolver.mjs` | Manager core | **[demonstrated]** Ambiguity and cycles fail; one global version per identity is a current policy. |
| Profile layering and merge laws | `profile.mjs` | Manager core contract plus policy provider | **[supported but limited]** Field authority is explicit, but its implementation and default validation policy are hard-wired. |
| Handler selection and normalized report validation | `build.mjs` | Manager core | **[demonstrated]** Keeps domain payloads opaque; public validation is incomplete and not schema-driven. |
| Native subprocess and portable-Wasm invocation | `handler.mjs`, portable runner | Manager-authorized infrastructure | **[supported but limited]** Execution form belongs at the boundary; runner selection is hard-coded. |
| Public hooks, replacements, semantic relation, adapter routing | `build.mjs` | Manager core relation mechanics | **[demonstrated]** Exact nominal and one-step policy are intentionally narrow. |
| Validator finding preservation | `build.mjs` | Manager core | **[demonstrated]** Evidence remains attributed. |
| “No unwaived failures” acceptance rule | `build.mjs`, profile policy | Policy package/provider | **[inferred]** A useful default, but not an invariant of every package system. It is hard-wired today. |
| Action/artifact graph validation and deterministic scheduling | `build.mjs`, `artifacts.mjs` | Manager core | **[demonstrated]** Generic and domain-neutral. |
| Content-addressed objects, leases, action records, references, reachability | `artifacts.mjs` | Manager-authorized store infrastructure | **[supported but limited]** Directly constructed by core rather than selected as a provider. |
| Lockfile, provenance, and explanation | `build.mjs` | Manager core | **[demonstrated]** Attribution is strong; lockfile is output only, not a replay input. |
| Activation selection, capability resolution, bindings, collections | `runtime.mjs` | Manager core | **[demonstrated]** Generic and domain-neutral. |
| Native module loading, capability context, activation/rollback/shutdown | `runtime.mjs` | Manager core contract plus host provider | **[supported but limited]** Lifecycle semantics are useful, but host transport and ambient options are prototype-specific. |
| Host tick boundary and service-controller iteration | `runtime.mjs` | Runtime host policy | **[supported but limited]** Non-overlap is explicit; semantic order among unrelated ticking controllers is not a public composition law. |
| Task validation, worker execution, buffer staging, commit planning | `demo.deterministic-scheduler` | Specialist scheduler package | **[demonstrated]** Correctly outside manager core; currently transform-specific. |
| Task/channel metadata vocabulary | Scheduler and example manifests | Specialist vocabulary package | **[assumed]** No package explicitly owns or versions the dialect interpreted by the scheduler. |
| Transform operation validation and authoritative commit | `demo.transform-authority*` | Specialist state authority | **[demonstrated]** Correctly outside manager core. |
| Instance identity, handles, leases, destruction | `demo.runtime-instance-store` | Specialist runtime authority | **[demonstrated]** Correctly outside manager core. |
| Fragment capture/restore and payload interpretation | Each state owner | Specialist state authority | **[demonstrated]** Correctly outside manager core. |
| Save manifest coordination and compatibility | `demo.save-coordinator` | Specialist generic coordinator | **[supported but limited]** Generic owner enumeration works; migration discovery remains transform-specific. |
| Scene extraction and SVG/browser presentation | Example packages | Specialist packages | **[demonstrated]** Correctly outside manager core. |
| CLI output paths, “Scene” terminology, interactive defaults | `cli.mjs` | Prototype convenience | **[inferred]** Useful demonstration shell, not package language. |

### Snapshot claim that does not match responsibility placement

The generated architecture snapshot says the manager “selects and authorises active
providers for store, scheduling, portable execution, policy, profile authority, and runtime
lifecycle.” **[contradicted by implementation]** Only scheduling is selected as a runtime
provider in this list. `ArtifactStore`, the portable runner, profile authority, validation
policy mechanics, and `RuntimeHost` are directly instantiated or called from manager core.
The “could later be replaceable” intention is reasonable, but it is not demonstrated.

## Semantic ordering audit

| Ordered activity | Actual rule | Status |
| --- | --- | --- |
| Package discovery | Configured roots and directory entries are sorted by path. | **[demonstrated]** Reversing root order retains package order. |
| Package version choice | Highest compatible discovered version; limited SemVer comparison. | **[supported but limited]** Deterministic, but the policy is implicit rather than an attributed profile decision. |
| Package graph | Dependency-first topological order; lexical package identity breaks independent ties. | **[inferred]** Stable in code; not described as a public composition law. |
| Contribution analysis | Dependency-ordered packages, then lexical contribution identity. | **[inferred]** Deterministic transport order; handlers should not infer semantic priority from it. |
| Artifact actions | Dependency-first topological order; lexical action identity breaks independent ties; execution is sequential. | **[demonstrated]** Records are stable. Independent-action order is not declared package semantics. |
| Tree entries | Normalized relative paths sorted lexically. | **[demonstrated]** Part of content identity. |
| Runtime services | Dependency-first topological activation; lexical service identity breaks unrelated ties. | **[demonstrated]** Dependencies are semantic; unrelated lexical order is a host convenience. |
| Runtime commit hooks | Activation order. | **[inferred]** No separate commit-dependency or composition language exists. |
| Runtime controller ticks | Current active/activation order, awaited sequentially. | **[contradicted by implementation]** The public language does not state that unrelated service ID order may affect tick semantics. |
| Shutdown | Reverse dependency/activation order. | **[demonstrated]** Explicit and tested. |
| Collection members | Member dependencies topologically ordered; lexical member identity breaks ties. | **[demonstrated]** Plan records the order. |
| State capture and restore | Member dependency order; prepare in reverse, restore forward; lexical tie break. | **[demonstrated]** Documented and tested. |
| Task execution waves | Collection-member dependencies gate waves; ready tasks sorted lexically; workers complete observationally. | **[demonstrated]** Dependency order is distinct from commit order. |
| Task command buffers across producers | Every ordered-channel producer pair must be transitively comparable through `commitAfter`. | **[demonstrated]** Ambiguity and cycles fail. |
| Commands inside one task buffer | Array/program emission order. | **[inferred]** Transform Authority applies that order, but the public notes do not name it as a composition rule. |
| Multiple command channels | Channel identity sorted lexically and committed sequentially. | **[supported but limited]** Only one channel is accepted, so cross-channel semantics are not demonstrated. |

The most important independent-modification concern is the ordered task channel. **[supported
but limited]** Adding a third producer requires it to name enough existing producer identities
to establish a total order. That is explicit and deterministic, but not open-ended: an
independent package must know the selected distribution’s other producers. No policy-owned
ordering relation or domain-vocabulary rule composes these constraints yet.

## Trust and containment audit

- **[demonstrated]** Native handlers are subprocess-separated but retain the invoking
  user’s authority. Staging protects publication semantics, not the host.
- **[demonstrated]** Native runtime services run in-process with user authority.
  `context.require()` detects unauthorized use through the cooperative interface but cannot
  stop imports, filesystem access, process access, or shared-memory behavior.
- **[demonstrated]** Native worker tasks receive a reduced context and no runtime capability
  objects, but they can import Node APIs. Worker isolation is not hostile-code containment.
- **[demonstrated]** The portable Wasm byte-transform receives only declared byte operations
  and bounded output, with the manager runner in the trusted computing base. This evidence
  does not extend to native code or a general Wasm component model.
- **[supported but limited]** Content hashes and create-only records detect inconsistent or
  corrupted content when verified. There are no signatures, publisher identities,
  transparency records, or hostile-store guarantees.
- **[assumed]** Package declarations, handler reports, and native service responses are
  truthful unless a manager check happens to reject them. Requested-power strings are
  provenance, not enforcement for native code.
- **[contradicted by implementation]** A profile may contain `policy.permissions`, but no
  permission decision consumes it. It must not be described as a granted-power policy.

## Public language coherence and authorability

### Coherent parts

- **[demonstrated]** Stable identities and attribution are used consistently for packages,
  public exports/hooks, actions/artifacts, services/capabilities, provider bindings,
  collection members, state schemas/fragments, tasks/buffers, and saved references.
- **[demonstrated]** Ambiguity generally fails instead of inheriting load order.
- **[demonstrated]** Exact versioned discriminants make experimental record evolution
  visible.
- **[supported but limited]** `schema` generally marks serializable data and `protocol`
  generally marks executable interface messages, but the rule is not stated and has
  exceptions such as serializable state fragments using `protocol`.

### Authoring gaps

- **[contradicted by implementation]** There are no JSON Schemas or equivalent normative
  field definitions for `fpm.package/1`, profiles, handler messages, runtime service
  responses, task metadata, state owners, or deterministic records.
- **[supported but limited]** `docs/prototype-formats.md` explains intent but omits exact
  required/optional fields, regexes, cross-field constraints, controller method shapes,
  task-context methods, and many diagnostic conditions.
- **[inferred]** Top-level package `provides`/`requires` and runtime-service
  `provides`/`requires` reuse the same terms for two distinct resolution stages. The examples
  reveal the distinction, but the public notes do not lead with it.
- **[inferred]** Several global-looking `fpm.*` and `runtime.*` dialect identities are
  interpreted by demo specialist packages without a declared vocabulary steward.
- **[contradicted by implementation]** Unknown profile statements fail, while unknown
  package-manifest and nested declaration fields can be silently ignored. Forward-extension
  policy is therefore inconsistent.
- **[supported but limited]** The CLI validates a complete profile, not a package in
  isolation. An author cannot ask the manager which manifest field, task declaration, or
  runtime method is unsupported without constructing a distribution context.

The companion `authoring-kit/runtime-task/` closes enough documentation gap for a separate
person to attempt one external task package against this exact checkpoint. It is explicitly
not evidence that the public language is already self-sufficient, and this review does not
perform the fresh-author test.

## Prototype conveniences versus intended contracts

| Convenience at this checkpoint | Intended-contract treatment |
| --- | --- |
| Recursive local directory discovery | Keep behind an install/repository boundary; do not define “installed” as “found recursively.” |
| Highest compatible discovered version | Make resolver policy attributable and make lockfiles consumable as replay inputs. |
| Native `spawnSync` JSON/stdin/stdout handlers | Preserve the message boundary; allow asynchronous/streaming transports and renewable leases. |
| One flat file/tree store implementation | Preserve immutable root/reference semantics; select or inject store infrastructure. |
| Runtime artifact is parsed as JSON by manager core | Pass a typed immutable artifact reference/reader; let the selected specialist runtime decode it. |
| One shared runtime `options` bag | Replace with versioned, declared host grants or capabilities per service. |
| JavaScript module URL inside `fpm.runtime-task/1` | Treat as the native Node execution adapter, not the universal task implementation contract. |
| One transform snapshot/channel/authority | Keep as a specialist demonstration dialect, not core task vocabulary. |
| Short-lived workers and global tick non-overlap | Scheduler policy, explicitly outside package-language guarantees. |
| One-step adapters and one-step transform migration | Retain as honest limits until a real use case supplies path-composition policy. |
| Tick/session JSON files | Diagnostic projections, not crash-durable semantic commits. |
| “Scene” CLI labels and browser opening | Demo shell behavior only. |

## What has actually been demonstrated

1. **[demonstrated]** Independent declarative replacement through typed hooks without
   modifying the package that owns the hook.
2. **[demonstrated]** Two specialist build-handler families composing through an attributed
   manager-owned action graph.
3. **[demonstrated]** Transactional blob/tree publication, deterministic records, cache
   reuse, and local cross-process convergence.
4. **[demonstrated]** Findings preserved separately from explicit policy consequences.
5. **[demonstrated]** A narrow portable Wasm capability boundary distinct from native trust.
6. **[demonstrated]** Runtime provider selection, coherent facets, dependency lifecycle,
   immutable extraction, and release/destruction identity semantics.
7. **[demonstrated]** Durable typed fragments, immutable save publication, opaque optional
   retention, fresh-process restoration, and one transform migration.
8. **[demonstrated]** A new state owner joining through a generic fixed collection without
   coordinator name knowledge.
9. **[demonstrated]** Real worker timing varying independently from declared command commit
   and authoritative deterministic state.

## What remains assumption or extrapolation

1. **[assumed]** A contributor unfamiliar with the implementation can author a correct
   package without reading source. The authoring kit enables, but does not prove, this.
2. **[assumed]** The vocabulary remains intelligible at hundreds or thousands of packages,
   capabilities, tasks, and artifacts.
3. **[assumed]** A real renderer or engine can fit the runtime boundary without core changes.
   Manager-side JSON artifact decoding and the options bag are counter-evidence.
4. **[assumed]** Current identity namespaces can be governed across independent publishers.
5. **[assumed]** Native packages accurately declare build inputs, powers, and deterministic
   behavior.
6. **[assumed]** Local filesystem publication semantics are sufficient for actual crash
   durability.
7. **[assumed]** Ordered-channel declarations remain independently composable as producer
   count grows.

## Issues to resolve before a real external subsystem

### First: make the runtime/task boundary a public, enforced contract

**[supported but limited]** This is the highest-priority issue. Before integrating a real
external renderer, engine, or independently authored task family, define a versioned public
runtime-service/task contract with machine-checkable envelopes and explicit host grants.
The first contract exercise should:

1. remove manager-side JSON interpretation of the activation artifact;
2. replace the shared service-options bag with individually declared grants;
3. give task/channel metadata an explicit vocabulary steward and version;
4. define how independent ordered producers compose without naming every existing producer;
5. reconcile `required` with `failure`, and either implement or remove inert declarations;
6. add package-isolated validation and conformance fixtures.

This is one boundary problem, not a request for Phase 8 features. Integrating a real
subsystem before resolving it would turn current Node/demo conveniences into accidental
ecosystem architecture.

### Then

- **[inferred]** Make manager-authorized infrastructure claims honest: either implement
  selection for store/runner/policy/host providers or describe them as embedded reference
  components.
- **[inferred]** Define discovery, installation, trust, and lockfile replay before calling the
  result a package manager for public use.
- **[inferred]** Generalize migration discovery only when a second independent state schema
  requires evolution.
- **[inferred]** Repair long-running native-action lease renewal before using the shared
  store for expensive external toolchains.

## Completion assessment

- End-to-end explanation without phase chronology: **complete**.
- Manager responsibilities classified: **complete**.
- Semantic ordering decisions identified: **complete**, including explicit ambiguities.
- Trust guarantees stated without native-code overclaim: **complete**.
- Prototype conveniences separated from intended contracts: **complete**.
- Public task authoring kit prepared: **complete; its mechanical internal self-check passes**.
- Fresh independent-author test: **deliberately not performed by this review**.
