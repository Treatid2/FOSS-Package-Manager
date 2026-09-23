# Phase 9 corrected runtime and distribution path

```text
workspace revision
  -> incremental candidate and impact report
  -> authoritative package resolution
  -> established complete build and validation
  -> immutable complete-build record + closure
  -> committed generation bound to exact closure roots
  -> self-contained distribution export/import verification
  -> generation-only runtime activation
  -> checkpointed transition
  -> committed target session OR failed attempt + new rollback session
```

An executable complete-build closure contains the effective profile, selected immutable package trees, build output and lockfile, provenance, artifact-store objects and action records, runtime plan, build summary, and public contracts. The generation repeats the exact semantic runtime plan and activation-artifact references and records their roots. Verification rejects any disagreement among the generation, complete-build record, retained closure, lock, contracts, or artifact store.

The public semantic activation input is the generation root. Output directory, browser opening, and snapshot destination remain observational options. An independent profile or runtime plan is not accepted.

Distribution import verifies its closed member set, byte counts, file hashes, package roots, generation identity, complete-build identity, closure root, and activation artifact before installing the records. Fresh activation reads only the imported committed closure.

On transition failure, the target controller is shut down, a failed-attempt record is retained, and the checkpoint is applied while recreating the prior generation. The recreation publishes a new runtime-session identity and moves the active reference to the prior generation plus that new session.
