<!-- SPDX-License-Identifier: MPL-2.0 -->

# Phase 9 findings

## Summary

The prototype demonstrates both Phase 9 internal acceptance units: persistent curation and
generation transactions (9A), followed by full runtime-generation transition, package exit, and
incremental scale evidence (9B). It remains a local experimental reference implementation.

## Demonstrated

- **Demonstrated:** Importing a package creates an immutable verified package root and installed
  record but does not change a workspace, candidate, generation, runtime plan, or active runtime.
- **Demonstrated:** Named workspaces reopen after a new manager instance is constructed; immutable
  revision history and explicit operations survive without rescanning curator intent.
- **Demonstrated:** Two edits or commits from one old workspace head yield exactly one successful
  compare-and-swap reference move.
- **Demonstrated:** Candidate roots are deterministic for the same revision, and ambiguity remains
  blocked until an explicit provider choice is recorded.
- **Demonstrated:** Impact reports distinguish one-package leaf closure from controlled central
  closure and retain causal paths.
- **Demonstrated:** Identical derivation inputs reuse one package root; changed inputs invalidate
  it; unrelated inputs do not participate; recursive generation is rejected.
- **Demonstrated:** Interrupted generation publication leaves the previous workspace reference
  authoritative and a stale candidate cannot commit.
- **Demonstrated:** A self-contained distribution replays the exact generation, runtime-plan,
  deterministic-tick, and visible-output roots into an empty manager store. Missing and corrupt
  members fail before import.
- **Demonstrated:** The coordinator uses the real Phase 8 world-save service to checkpoint G0,
  restore G1, commit a new session, and leave G1 active only after success.
- **Demonstrated:** Deliberate activation and restore failures leave the previous active-generation
  reference unchanged and reactivate the previous generation from the same checkpoint.
- **Demonstrated:** Optional absent state is retained opaquely; required absent state blocks before
  shutdown.
- **Demonstrated:** Package exit blocks selected dependants, reports causal impact, retains parent
  generation roots, and exposes no destructive deletion.
- **Demonstrated:** Acceptance runs at 10, 100, and 1,000 strict public packages completed, with
  local ambiguity, duplicate, missing-dependency, and three-node cycle diagnostics at 1,000.

## Supported but limited

- **Supported but limited:** The filesystem lease/CAS design is tested with concurrent Node
  callers and processes, not a distributed filesystem or hostile lease owner.
- **Supported but limited:** Distribution replay uses a self-contained directory bundle. Archive
  compression, remote transport, signatures, and publisher trust are deliberately absent.
- **Supported but limited:** Generation transition is a full restart with downtime. The adapter
  can run real Phase 8 services, but it intentionally does not hot-swap one service.
- **Supported but limited:** The impact index covers generic package dependencies, capabilities,
  public ownership, adapters, artifact actions, services, collections, state owners, tasks, and
  retained generation/distribution references. Specialist semantic desirability still belongs to
  validators, policies, and integration packages.
- **Supported but limited:** The benchmark demonstrates measured affected closures and store-size
  independence of the selected runtime plan. It is not a production performance study.

## Inferred

- **Inferred:** Content-addressed local packages plus immutable generations are sufficient to make
  a later remote transport layer non-authoritative with respect to generation identity.
- **Inferred:** The explicit impact product is a viable curator-facing boundary because the same
  causal records support planning, removal diagnostics, rebuild explanation, and retention.

## Assumed

- **Assumed:** The local filesystem provides the create-directory and rename behavior used by the
  bounded reference lease. Network shares require separate validation.
- **Assumed:** Native Phase 8 services cooperate with the declared authority model; this is not a
  hostile native-code sandbox.

## Contradicted by implementation

- **Contradicted by implementation:** New manager schemas cannot simply join the frozen Phase 8
  `public/` authoring-kit file set without changing that accepted checkpoint. Phase 9 therefore
  has a separate versioned contract bundle which consumes Phase 8.

## Non-claims

No claim is made for remote repositories, signatures, arbitrary compatibility inference,
destructive garbage collection, recursive derived-package fixed points, per-service live
replacement, zero-downtime multiplayer change, renderer/engine integration, production
performance, or version-one compatibility.

