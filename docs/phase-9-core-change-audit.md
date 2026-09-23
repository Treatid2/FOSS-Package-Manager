<!-- SPDX-License-Identifier: MPL-2.0 -->

# Phase 9 package and core-change audit

## Manager-core changes

- `src/core/curation.mjs` adds package import/index, immutable workspace revisions, candidate and
  impact planning, one-layer derived packages, generation commit, distribution replay, and
  retention reporting.
- `src/core/generation-runtime.mjs` adds the full-generation checkpoint/session/active-reference
  coordinator and a real adapter for the accepted Phase 8 runtime.
- `src/core/phase9-contracts.mjs` enforces closed top-level durable-record vocabularies.
- `src/core/synthetic.mjs` generates strict public package fixtures and records observational
  benchmark data separately from deterministic identities.
- `src/cli.mjs` exposes distinct package, workspace, candidate, generation, and distribution
  operations. Inspection and commit do not activate a runtime.
- `src/core/build.mjs` reads the manager version from `manager.json` instead of retaining the prior
  hard-coded value.

## Contract changes

- `contracts/phase-9/` is a new experimental manager-contract bundle with closed unknown-field
  policy and an example workspace reference.
- The Phase 8 `public/` tree and `authoring-kit/runtime-task-v2/public` tree are unchanged.
- `npm run contracts:check` and the external authoring-kit verification pass.

## Package changes

No existing domain, handler, runtime-service, state-owner, task, renderer, or fixture package was
modified. Derived packages are produced dynamically through the normal strict public import path.

## Domain-neutrality audit

The new manager code contains no texture, mesh, character, field, camera, worldspace, transform,
motion, journal, scene, renderer, or game-specific selection rule. Runtime-plan indexing reads
generic declared capabilities, collections, state owners, and task members. Specialist packages
continue to own payload meaning, build behavior, validation, state encoding/migration, and runtime
activation.

## Prohibited changes checked

- no remote repository, download, update, signature, publisher, or trust implementation;
- no destructive package deletion or garbage collection;
- no recursive generated-package fixed point;
- no mutable live collection or per-service hot replacement;
- no renderer/engine integration;
- no typed-artifact-provider follow-on experiment;
- no push, pull request, release, merge, or tag mutation.

