# FOSS Package Manager

An executable language-laboratory prototype for a mod-native package system.

This repository now tests three related propositions:

> Can a small manager resolve declarative packages, dispatch specialised handlers, build deterministic artifacts, and explain exactly how each artifact was produced?

> Can independently implemented handler families compose through a manager-owned transactional artifact graph without one handler quietly becoming a monolithic engine?

> Can independently selected runtime services create, mutate, observe, render, and retire live state through explicit capabilities and lifecycle rules rather than shared global objects?

The visible result remains deliberately tiny: a field, a two-cube character, and a fixed camera. An optional Green Head package changes the character's head colour through a public typed hook without modifying the character package. Phase 4 now materialises the built world into distinct runtime services and moves the character sideways through an authoritative transform command before the unchanged renderer consumes an immutable scene snapshot.

## Quick start

Requirements: Node.js 22 or newer. There are no third-party dependencies and nothing is installed into `node_modules` or `K:\Mark\VS\extern`.

```powershell
npm test
npm run build
npm run build:green
npm run snapshot
npm run demo
```

`npm run demo` builds the Green Head profile, starts the disposable local runtime, and opens it in the default browser. Press Ctrl+C in the terminal to stop the runtime.

To ask why the head has its selected colour and see its action path:

```powershell
node src/cli.mjs explain build/green-head/provenance.json pkg:demo.character/appearance/head/base-colour
```

## What is implemented

- versioned JSON core manifests and layered `fpm.profile/2` inputs;
- recursive package discovery and semantic-version dependency/capability resolution;
- handler declarations that separate execution form from trust policy;
- out-of-process analysis over versioned JSON/stdin/stdout;
- package-owned public identifiers, typed hooks, defaults, and reversible replacements;
- exact nominal matching plus explicit, versioned, one-step adapters;
- package-governed semantic relation identities for adapter policy;
- handler-proposed actions validated and scheduled as a generic artifact DAG;
- dependency and artifact cycle detection;
- manager-owned staging transactions with hash and size verification;
- blob and canonical tree roots in a content-addressed artifact store;
- concurrent-safe build-key leases, stale recovery, and immutable action-record publication;
- deterministic action build keys and reuse of verified cached artifacts;
- handler-declared environment dependencies with monotonic policy widening;
- independently attributed validator findings and explicit acceptance/waiver decisions;
- field-level profile authority and merge records;
- a portable WebAssembly byte-transform ABI with no ambient filesystem, process, or network imports;
- per-action requested/granted/denied powers and bounded portable execution limits;
- exclusive runtime-service capability resolution and policy selection;
- dependency-ordered activation, rollback, lifecycle recording, and reverse shutdown;
- persistent instance identities, materialisation leases, and generational handles;
- authoritative transform commands and immutable revisioned scene extraction;
- rollback of failed handler actions without committing their output or action record;
- lockfiles and provenance linking contributions, handlers, source artifacts, adapters, final inputs, and output artifacts;
- a scene builder that receives only its own normalized scene analyses during planning and its declared texture artifacts during materialisation;
- a renderer service that consumes only immutable flat scene snapshots;
- structured diagnostics and conformance fixtures for planned failure cases.

The manager has no texture, mesh, assembly, camera, worldspace, transform, motion, or rendering rules. Those concepts remain in independent example packages.

## Phase 3 resolution and build flow

```text
layered profile + core package manifests
                  |
                  v
dependency/capability/handler resolution
                  |
                  v
handler-owned contribution analysis
                  |
                  v
typed hook and one-step adapter selection
                  |
                  v
scene planner proposes declared artifact inputs
                  |
                  v
manager validates and schedules the action/artifact DAG
                  |
       +----------+-----------+
       |                      |
       v                      v
file texture action     solid-colour action
       |                      |
       |                      v
       |            capability-contained
       |                Wasm adapter
       +----------+-----------+
                  |
                  v
runtime texture artifacts -> scene action
                  |
                  v
scene-bundle tree + fpm.lock.json + provenance.json
                  |
                  v
runtime instance store -> transform authority <- deterministic motion
                  |               |
                  +-------+-------+
                          v
              immutable scene revision
                          |
                          v
                   existing SVG renderer
```

Each action receives manager-supplied input paths and a private staging directory. The manager recomputes the output hash and size before importing it into the store and recording the graph mutation.

## Worked package graph

| Package | Role |
| --- | --- |
| `demo.scene-toolchain` | Analyzes scene-domain manifests, proposes the final action, and builds a two-file `fpm.render-bundle/1` tree from declared runtime textures |
| `demo.texture-toolchain` | Independently analyzes file and solid-colour texture declarations and materializes source artifacts |
| `demo.solid-colour-adapter` | Converts `texture.solid-colour/1` to `texture.runtime.rgba8-srgb/1` as a capability-contained Wasm action |
| `demo.texture-vocabulary` | Governs the reusable base-colour solid-to-runtime semantic relation |
| `demo.scene-validator` | Produces an attributed proposal finding before policy accepts the render action |
| `demo.primitives` | Box meshes, a file-backed field texture, and declarative body/head colours |
| `demo.field` | Field assembly and public runtime-texture hook |
| `demo.character` | Body/head assembly and public runtime-texture hooks |
| `demo.camera` | Fixed perspective camera |
| `demo.worldspace` | Persistent-looking instance IDs and scene composition |
| `demo.green-head` | Compatible solid-colour export and replacement intent |
| `demo.simple-runtime` | Browser/SVG activation for the flat scene artifact |
| `demo.runtime-instance-store` | Owns persistent instance identities, generational handles, materialisation leases, and explicit destruction |
| `demo.transform-authority` | Owns final world transforms and commits typed transform commands |
| `demo.runtime-clock` | Supplies deterministic single-threaded ticks |
| `demo.motion` | Moves the block character through the transform-write capability |
| `demo.scene-extractor` | Publishes immutable flat scene revisions from instance definitions and transform snapshots |

The two toolchains are not profile roots. Packages require their distinct capabilities, so the resolver selects them transitively. The adapter is a distribution root because choosing permitted conversion policy is not an intrinsic property of either toolchain.

## Outputs and cache

Building a profile creates:

- `scene-bundle/scene.json` and `asset-index.json` — one canonical multi-file tree root, with the existing scene as its selected runtime entry;
- `fpm.lock.json` — all resolution, authority, validation, environment, action, root, handler, and binding decisions;
- `provenance.json` — an explanation index for exports, hooks, action paths, adapters, and artifacts;
- `runtime-lifecycle.json` after `run` — selected runtime services, reasons, activation order, ticks, rollback-safe state, and reverse shutdown;
- a sibling `.fpm-store/` — verified content objects and deterministic action-cache records.

Generated outputs live under `build/` and are ignored by Git. Cache hits are deliberately observational and are not written into the lockfile, so a cold and warm build produce identical records.

## Failure fixtures

`fixtures/failures` contains executable examples for:

- missing dependency or contribution handler;
- duplicate public identity;
- unresolved semantic artifact route;
- missing or ambiguous adapter;
- ambiguous compatible replacement;
- cyclic package dependencies;
- malformed domain manifest or deliberate analysis failure;
- an action that writes to staging and then fails, exercising rollback;
- a portable action that successfully uses its declared byte capabilities, probes undeclared host read/write/network authority, and is denied without publication.
- stale runtime handles, release-versus-destruction, transform authority denial, ambiguous exclusive providers, activation rollback, and dependency-safe shutdown.

The test suite asserts diagnostic codes and relevant context. It also verifies deterministic discovery, cache reuse, explicit adapter policy, handler separation, reproducible outputs, and runtime consumption.

## Explicit non-goals

This is not yet a production package format, general native-code sandbox, repository client, distributed artifact store, general adapter search, cache garbage collector, parallel runtime scheduler, streaming world, or persistent save system. The renderer is intentionally disposable and the formats remain provisional.

See [docs/architecture-snapshot-v0.md](docs/architecture-snapshot-v0.md) for the generated experimental contract checkpoint, [docs/prototype-formats.md](docs/prototype-formats.md) for public protocol notes, and [docs/phase-4-findings.md](docs/phase-4-findings.md) for the live-state evidence and limitations.

## Security status

Native handlers still run as unsandboxed subprocesses with the authority of the user running the manager. Native runtime services run in-process with that authority. Staging and runtime capability injection are architectural authority boundaries, not containment against malicious native code.

The solid-colour adapter is different: package logic is pure WebAssembly instantiated by a manager-owned runner with only declared-input byte reads and declared-output byte writes. It has no host-filesystem, package-store, child-process, or network imports. Timeout, module/input/output/response byte limits, and a child-process heap limit bound the prototype where practical. This is one narrow portable execution class, not containment for native handlers or a production-grade resource governor. Only run native packages you trust.

## Licensing

This is a mixed-licence open-source repository:

- the reference manager and core implementation are licensed under MPL-2.0;
- the public package-language/specification material, conformance fixtures, profiles, tests, and example package/handler/runtime implementations are licensed under Apache-2.0;
- independently authored packages may declare other licences using SPDX identifiers or expressions.

See [LICENSING.md](LICENSING.md) for the authoritative path boundaries and the canonical licence texts in [LICENSE](LICENSE) and [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt).
