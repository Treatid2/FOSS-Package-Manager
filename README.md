# FOSS Package Manager

An executable language-laboratory prototype for a mod-native package system.

This repository tests one focused proposition:

> Can a small manager read declarative package manifests, resolve their relationships, dispatch specialised handlers, build a deterministic artifact, and explain exactly how that artifact was produced?

The prototype answers that question for a deliberately tiny scene: a field, a two-cube character, and a fixed camera. An optional Green Head package changes the character's head colour through a public typed hook without modifying the character package.

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

To ask why the head has its selected colour:

```powershell
node src/cli.mjs explain build/green-head/provenance.json pkg:demo.character/appearance/head/base-colour
```

## What is implemented

- versioned JSON core manifests and profiles;
- recursive package discovery from explicit package roots;
- semantic-version dependency selection;
- recorded package licence metadata using SPDX identifiers or expressions;
- capability-provider selection;
- dependency and capability cycle detection;
- handler selection by declared manifest type;
- out-of-process handler analysis over versioned JSON/stdin/stdout;
- package-owned public identifiers;
- typed public hooks, defaults, and reversible replacements;
- explicit rejection of ambiguous replacements;
- a separate materialisation phase producing a flat render-scene artifact;
- deterministic lockfiles with package content hashes;
- provenance for exports, bindings, handlers, and artifacts;
- a runtime that consumes the built artifact without reading packages;
- structured diagnostics for the planned failure cases.

The manager deliberately has no knowledge of meshes, textures, assemblies, cameras, worldspaces, or rendering. Those concepts live in `demo.prototype-toolchain`.

## Resolution and build flow

```text
profile + core package manifests
            |
            v
dependency/capability resolution
            |
            v
manifest-type -> selected handler
            |
            v
normalised exports, hooks, activations
            |
            v
typed replacement resolution
            |
            v
selected artifact builder
            |
            v
scene.json + fpm.lock.json + provenance.json
            |
            v
selected runtime activation
```

Domain manifests are not parsed during discovery or package resolution. A selected handler receives their paths only after the core graph has resolved.

## Worked package graph

| Package | Role |
| --- | --- |
| `demo.prototype-toolchain` | Analyzes all provisional demo dialects and builds `fpm.render-scene/1` |
| `demo.primitives` | Box mesh and base-colour texture declarations |
| `demo.field` | Field assembly and public colour hook |
| `demo.character` | Body/head assembly and public colour hooks |
| `demo.camera` | Fixed perspective camera |
| `demo.worldspace` | Persistent-looking instance IDs and scene composition |
| `demo.green-head` | Compatible head-colour export and replacement intent |
| `demo.simple-runtime` | Browser/SVG activation for the flat scene artifact |

The toolchain is not a profile root. Packages that use its provisional dialect require its capability, so the resolver selects it transitively.

## Outputs

Building a profile creates:

- `scene.json` — the disposable flat runtime artifact;
- `fpm.lock.json` — selected packages, hashes, dependency edges, handlers, bindings, and artifact hash;
- `provenance.json` — an explanation index for public exports, hook choices, and the final artifact;
- optionally `scene.svg` — a deterministic visual snapshot produced by the runtime.

Generated outputs live under `build/` and are ignored by Git.

## Failure fixtures

`fixtures/failures` contains executable examples for:

- missing dependency;
- no handler for a manifest type;
- duplicate public identifier;
- incompatible replacement semantic type;
- two equally valid replacements without a profile selection;
- cyclic dependencies;
- malformed domain manifest;
- deliberate handler analysis failure.

The test suite asserts the diagnostic code and relevant context for each case.

## Explicit non-goals

This is not yet a general game engine, production package format, security sandbox, repository client, binary artifact store, streaming world, persistence system, or runtime ABI. The renderer is intentionally disposable. The provisional formats are versioned because they are expected to change.

See [docs/implementation-notes.md](docs/implementation-notes.md) for decisions and discussion issues exposed by this implementation.

## Security status

Handlers run as subprocesses, but they are **not sandboxed**. A selected handler currently has the authority of the user running the manager. Only run packages you trust. Trust policy, signatures, permissions, and process isolation are future architectural work rather than properties this prototype pretends to provide.

## Licensing

This is a mixed-licence open-source repository:

- the reference manager and core implementation are licensed under MPL-2.0;
- the public package-language/specification material, conformance fixtures, profiles, tests, and example package/handler/runtime implementations are licensed under Apache-2.0;
- independently authored packages may declare other licences using SPDX identifiers or expressions.

See [LICENSING.md](LICENSING.md) for the authoritative path boundaries and the canonical licence texts in [LICENSE](LICENSE) and [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt).
