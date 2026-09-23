<!-- SPDX-License-Identifier: MPL-2.0 -->

# Post-Phase-7 decision report

**Checkpoint:** `phase-7-prototype` at `cea2b57cfe777c8607358bea16661690343594e8`

**Decision:** preserve the checkpoint; do not declare the language version 1 and do not begin
a new kernel feature phase from it automatically.

## Ready

- **[demonstrated]** Internal experiments with declarative package selection, typed hooks,
  attributed build graphs, immutable artifacts, runtime capability graphs, fixed
  collections, durable state fragments, and deterministic worker-command composition.
- **[demonstrated]** Reproduction and diagnosis of the repository’s supported examples and
  deliberate failures: 56 tests pass at the checkpoint, and the review branch adds one
  passing mechanical authoring-kit self-check.
- **[supported but limited]** A separate contributor can now be given the provisional
  `authoring-kit/runtime-task/` and asked to attempt one task package against this exact
  distribution.

## Not ready

- **[contradicted by implementation]** A production package manager: install state,
  repositories, signatures, lockfile replay, updates, deletion, and trust policy do not
  exist.
- **[supported but limited]** A stable public package language: complete machine-readable
  schemas and isolated conformance validation do not exist.
- **[supported but limited]** A general runtime/engine boundary: manager core parses the
  activation artifact as JSON and every native service receives one ambient options bag.
- **[supported but limited]** General deterministic concurrency: only one transform command
  domain is implemented, and a new ordered producer must know existing producer identities.
- **[contradicted by implementation]** Generic state migration: Save Coordinator explicitly
  requests one transform migration capability.
- **[demonstrated]** Hostile native-code containment: deliberately not provided.

## Issue to address first

Formalize and enforce the public runtime-service/task boundary before integrating a real
external renderer, engine, or task subsystem. Give activation artifacts, host grants,
service responses, task metadata, channel vocabulary, failure policy, and ordering
composition machine-checkable contracts owned at the correct manager/specialist boundary.

The external-author exercise should happen next as an evaluation, not as a hidden Phase 8:
give the kit to someone who has not read manager source, preserve their questions and failed
attempts as evidence, and change no contract until that evidence is reviewed.
