<!-- SPDX-License-Identifier: Apache-2.0 -->
# Explicit exact-root variants and rc.2 recovery

> Historical rc.3 procedure. Do not apply this private-store copy workflow to
> the 0.11 public-contract candidate. Migrate owned package inputs with
> `fgpm migrate pre-public-package` and reconstruct state through public APIs.

This candidate uses the invoking user's local filesystem authority, not publisher
trust or hostile-code containment. Only operate on a verified copy of a quiescent,
manifest-backed original state. No original-state substitution or reconstruction.

## Inspect before and after

`fgpm package registry --manager-root <copy>` shows complete human-readable facts;
append `--json` for the same facts as one JSON record. Persistent control clients
use `package.registry.inspect` with empty parameters. It reports index identity,
every known content root, registration and provenance, verified-content status,
retained-generation and staged-workspace references, ambiguity, unreferenced
objects, available actions, audit history and cleanup policy. Live active-generation
and runtime facts use `generation.active` / `runtime.inspect` in the same control
process. Registry inspection is coordinated with registry writes but is not an
atomic snapshot of independent workspace/runtime writers. Quiesce for a full audit.
Both new operations are expert/headless public interfaces, not additions to the
guided workbench or its initial-curator agent allowlist. The human CLI is supported.
Workspace references conservatively include retained base/subsystem and operation
roots, including superseded or abandoned operations; they are not a current selection
or execution grant. Legacy unregistered staged roots remain inspectable but unusable.

`unregistered-record` means a tree/root record exists without installed registration;
`unregistered-tree` means no readable root record. rc.2 wrote immutable content
before rejecting a conflicting installed mapping. This can change manager bytes
without changing installed inventory/runtime. Inspection does not invent a missing
historical event or provenance. Record the original rejection separately.

## Register only the exact assessed variant

```powershell
fgpm package variant-register <exact-package-directory> --manager-root <copy> --expected sha256:<exact-root> --registration-id author:recovery-1 --reason "Assessed G5 candidate" --source "Exact author commission" --if-index sha256:<inspection-index-root>
```

Equivalent public control operation `package.variant-register` takes directory,
expectedRoot, registrationId, reason, source, and optional expectedIndexRoot.
The typed expectedRoot must match discovered/stored bytes. The operation validates
and reuses existing residue, or imports complete source, and registers its exact
root without overwriting a predecessor. Its audit records prior index identity,
observed tree/record/registration state, current provenance and reason. Source is
caller-attributed evidence, not authenticated original provenance.

Registration IDs are durable. Repeating identical root/reason/source/head inputs
after restart reuses the recorded registration without new audit or index writes;
changed inputs reject. Different concurrent IDs serialize. Optional head CAS rejects
stale competing edits. No automatic variant selection, latest-root preference or
ID/version-only lookup exists: workspace add/update and generation activation use
exact roots. One root per package ID is selected in each generation.

Ordinary import still rejects a new conflicting root; reimporting an already
registered root is allowed and idempotent for identical provenance. Successful
index mutation atomically publishes registration and audit together. Content/root
records are published earlier; a later I/O/process failure may leave unregistered
immutable residue. Inspect and explicitly register it; do not stage it unofficially.
This is atomic reference publication, not power-loss durability or a general
transaction across filesystem objects. Cooperative filesystem leases are local;
distributed/hostile concurrency is unsupported.
An aged registry lease is not reclaimed while its local owner PID is alive. Unknown
legacy owner metadata remains protected and causes a bounded lease timeout; inspect
and preserve it rather than force-unlocking. PID reuse can conservatively delay
recovery. This is not distributed ownership or hostile-concurrency containment.

## Compatibility, preservation and cleanup

Read-only opening accepts both index schemas. First successful mutation copies
legacy entries unchanged into schema 2, records the prior index hash and a
`legacyObservation` flag, and begins the audit chain. Unknown historical imports
are not fabricated. The schema change is one-way on the copy: rc.2 rejects schema 2.
Keep the verified original and generation records for recovery; do not downgrade
by editing the index. Hash linkage detects accidental inconsistency, not hostile
rewriting by an authorized local user.

All registered, retained, staged and unregistered objects remain stored. Automatic
GC, discard, unregister and destructive cleanup are deliberately unsupported; the
inspection output states this. Unreferenced does not mean disposable. No operation
can remove baseline roots/generations. Generation rollback selects retained
composition, not persistent-world-state rollback.

The maintained Runtime correction is separately owner-bound and assessed. This
manager neither changes provider pins nor bypasses package validators. Its fixture
proofs cannot certify real-state recovery, the amended four-root composition, the
28 unchanged roots, Landmark exclusion or final acceptance; those are curator gates.
