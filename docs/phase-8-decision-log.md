<!-- SPDX-License-Identifier: MPL-2.0 -->

# Phase 8 decision log

## P8-001 — Preserve the provisional v1 path beside a corrected v2 path

### Problem

The Phase 7 task path is useful evidence but accepts duplicated and inert declarations.
Changing it in place would erase the checkpoint's meaning and create an accidental version
1 compatibility promise.

### Chosen mechanism

Keep the Phase 7 packages, profiles, tests, and authoring kit executable. Introduce explicit
v2 task/service vocabulary packages and a corrected demonstration distribution.

### Rejected alternatives

- Silently reinterpret every v1 manifest as corrected semantics: rejected because old
  deterministic records would no longer describe the declarations that produced them.
- Upgrade the existing packages in place: rejected because the preserved regression path
  would select new behavior through ordinary version resolution.

### Compatibility and tests

The old suite remains a required regression. New conformance uses only the v2 path and
reports its schema/vocabulary versions.

## P8-002 — Use vocabulary-owned semantic stages and reducers

### Problem

`commitAfter` forces a new producer to name existing producer identities.

### Chosen mechanism

The transform vocabulary owns a staged axis-composition law. Base `set-axis` contributions
use an exclusive-per-target-axis stage; independent `add-axis` contributions use a
deterministic sum stage. The vocabulary provider validates and derives the complete
composition. Contributors name only the channel vocabulary, stage, and law.

### Deterministic semantics

Stage order and per-stage composition are vocabulary facts. Any remaining stable contributor
ordering used for byte-level reduction is named and recorded; worker completion is only an
observation.

### Rejected alternatives

- More exact-member edges: rejected because it preserves distribution knowledge.
- Discovery, activation, or completion order: rejected because those are transport or
  observation facts.
- General partial-order or algebra framework: rejected as broader than the demonstrated
  transform need.

## P8-003 — Publish JSON schemas and enforce a documented subset

### Problem

Public objects currently lack standalone definitions and unknown package fields may be
silently ignored.

### Chosen mechanism

Publish JSON Schema documents with `additionalProperties: false` for strict public objects.
Use a dependency-free manager validator for the documented schema subset plus explicit
cross-field semantic checks. Diagnostics include schema identity, instance path, rule, and
steward.

### Rejected alternatives

- Add a third-party JSON Schema dependency: rejected because the prototype currently has no
  dependencies and needs only a bounded public slice.
- Prose-only validation: rejected because it is not machine-readable.

## P8-004 — Pass an immutable typed reference and generic reader

### Problem

Manager core parses the selected activation artifact as scene JSON.

### Chosen mechanism

Core verifies generic type/root/entry facts and passes a frozen typed reference plus a
narrow immutable byte reader. The selected world/scene specialist parses the bytes and
publishes domain capabilities.

### Rejected alternatives

- Continue passing the decoded object: rejected because domain meaning remains in core.
- Pass an unrestricted filesystem path: rejected because it weakens root verification and
  leaks materialization layout.

## P8-005 — Replace ambient options with exact host grants

### Problem

Every native service receives one shared options object, including values it never declared.

### Chosen mechanism

Services request versioned grant identities. `context.grant()` checks the request and actual
host supply. Plans record the request, result, provider, policy, and deterministic or
observational classification.

### Trust limit

This is an architectural authority boundary for cooperating native services, not hostile
native-code containment.

### Rejected alternatives

- Filtered per-service option bags: rejected because field ownership and denial remain
  implicit.
- Turn host values into ordinary runtime capabilities: rejected for this focused cycle
  because output paths and conformance observations are host inputs, not selectable package
  providers.

## P8-006 — Correct the task boundary inside a mixed-version demonstration graph

### Problem

Scene building, persistence, instance ownership, rendering, and activation contributions are
outside the task-boundary correction. Re-versioning them merely to make every selected package
say `fpm.package/2` would enlarge the phase and conceal which boundary was actually corrected.

### Chosen mechanism

The `fpm.profile/3` demonstration selects v2 task, scheduler, vocabulary, and scene-extractor
services while retaining the executable v1 build and state services. The small distribution
package remains provisional `fpm.package/1` because the current strict v2 package slice is for
runtime services; it supplies only the activation contribution and dependencies.

### Evidence label

The corrected task path is demonstrated. A wholly v2 general package/build ecosystem is not
claimed and remains outside Phase 8.
