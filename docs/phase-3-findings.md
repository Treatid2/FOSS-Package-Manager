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

Phase 3B is implemented and passes its normal and deliberate-violation fixtures.

### Boundary and action contract

The selected solid-colour adapter is a pure WebAssembly byte transform. A manager-owned runner translates the existing materialization request/response contract into three successful module imports: declared-input length/read and bounded output-byte write. The package module receives no paths, Node objects, WASI, or ambient host functions.

The runner reads exactly the immutable artifact named by the action and writes the completed byte buffer only to its declared staging slot. Package-store mutation, arbitrary host reads/writes, child processes, and network access are absent from the import surface. The generic runner understands bytes and transaction slots, not colours or texture semantics.

Execution is independent from semantic role in both the build key and action record. The record contains execution form, boundary and runner identity, requested powers, actual grants, denied ambient powers, and applied limits; the existing adapter identity and governed semantic relation remain unchanged.

### Successful portable action

Normal base and Green Head builds execute the Wasm adapter, read the declared three-byte solid-colour artifact, write a four-byte runtime texture into staging, and produce the same scene and renderer snapshot as before. Cold and warm builds preserve identical lockfiles, including the execution record.

### Deliberate violation

The violation module performs the same allowed input reads and staged output writes, then calls explicit denial-only probes for an undeclared host read, an out-of-staging host write, and network access. The runner supplies no authority for those operations; it records one denial in each category and returns `FPM_SANDBOX_VIOLATION_CONFIRMED`.

The test verifies three successful declared reads, four successful staged writes, all three denied ambient attempts, removal of the transaction directory, absence of the failed action record and final lockfile, and a reachability report with no orphan root from the failed action.

### Practical resource bounds

Portable declarations set wall-clock, module/input/output/response byte, and child-process heap limits. The runner executes in a separate process, validates the module import set before instantiation, and terminates on timeout. These bounds are included in action identity and provenance.

### Phase 3B limitations

- This is one deliberately narrow byte-transform ABI, not a general portable plugin SDK.
- The manager-owned runner is part of the trusted computing base; the security claim concerns package Wasm, not a compromised manager.
- Timeout and Node heap/byte ceilings are practical prototype controls, not OS-enforced CPU and resident-memory quotas.
- Native handlers remain explicitly unsandboxed and retain host-user authority.
- Denial probes demonstrate that the portable import boundary withholds each requested category; they are not a claim of native-code containment.
