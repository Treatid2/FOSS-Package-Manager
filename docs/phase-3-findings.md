# Phase 3 findings

Phase 3 has two independent acceptance gates. This document records each gate separately so artifact/store results do not depend on the outcome of the containment experiment.

## Phase 3A — artifact/store and decision semantics

Phase 3A is implemented and passes its focused fixtures.

### Blob-or-tree artifact roots

Actions may publish one or more named roots. Single-file artifacts remain blobs. The final render result is now a canonical tree containing `scene.json` and `asset-index.json`; the existing renderer consumes the selected scene entry unchanged.

Tree identity is the SHA-256 of a canonical manifest whose stable, normalized entries reference immutable child blobs. Action-record publication happens only after all roots import and verify.

### Concurrent builds and recovery

Per-build-key lease directories provide atomic ownership, heartbeat/expiry metadata, stale recovery, and duplicate-work avoidance. Correctness remains based on immutable objects and create-if-absent action records. A divergent second root for one key is a nondeterminism error.

The concurrent fixture launches two independent manager processes against one store and verifies identical records, one record per action, and no surviving lease. The interruption fixture stops after tree import but before record publication; the dry-run reachability report identifies the orphaned tree and children, and a subsequent normal build publishes them safely.

The reachability command is intentionally non-destructive:

```powershell
node src/cli.mjs store-report build/.fpm-store
```

### Independent validation findings

The selected Scene Validator emits an attributed proposal finding. A contradictory validator fixture emits an independent failure. Both findings survive unchanged; unwaived policy rejects the proposal, while an exact policy waiver accepts it and records the responsible rule.

This demonstrates evidence preservation and explicit policy. It does not introduce voting, validator priority, or a universal trust hierarchy.

### Environment-dependent keys

The Texture Handler declares `target.colourVariant`; changing it changes both the action key and produced texture. An unrelated target observation leaves that action key unchanged. Policy widening to include the observation changes the key without modifying the handler declaration.

This distinguishes handler dependency claims, manager conservatism, and observational provenance. It does not prove that a handler's declaration is complete.

### Governed semantic relations

The texture vocabulary package now owns the solid-colour-to-runtime base-colour relation. Adapters implement that relation, hooks reference it, and reusable policy selects by relation identity. Exact-hook policy remains more precise. Raw source/target pairs no longer act as selection authority.

### Field-level profile authority

The effective profile records the source layer, statement kind, merge rule, and governing schema for each implemented field. Unknown statements are rejected rather than recursively merged. The deliberate user-layer attempt to replace the fixed distribution artifact requirement fails with an authority diagnostic.

### Phase 3A limitations

- Tree manifests currently contain regular-file blob entries; nested tree nodes, symlinks, and permissions remain out of scope.
- Leases coordinate local filesystem processes only; there is no remote consensus.
- Reachability treats retained action records and explicit pins as roots; retained lockfile indexing, quotas, and deletion remain future store-service work.
- Action-cache format 2 is the trusted root format. Records from the Phase 2 cache format are reported as invalid and their former objects may appear orphaned; the report does not delete or rewrite them.
- Validator policy is deliberately small: named required passes, unwaived failures, and exact waivers.
- Environment declarations remain claims whose completeness requires policy, sandboxing, or reproducibility evidence.

## Phase 3B — enforced portable containment

Phase 3B is a separate implementation unit. Its acceptance result will be recorded here without revising the Phase 3A conclusions.
