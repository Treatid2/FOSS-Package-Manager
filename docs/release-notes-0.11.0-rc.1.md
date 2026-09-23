<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# FGPM 0.11.0-rc.1 candidate notes

This candidate is the Stage A public-contract boundary after the accepted
`0.10.0-rc.3` checkpoint. It is a new candidate, not a relabelled copy of rc3.
The rc3 source, distribution, manager state, roots, and receipts remain
historical evidence.

The reviewed build-semantic identity is
`sha256:5f27b0637610f852159cba0ea9b68fd62eed6aba532ad0c78a97efa3f35f731a`,
derived from the candidate version and the exact `src`, `public`, and `contracts`
tree roots by `tools/compute-manager-build-identity.mjs`. It is intentionally
distinct from the bundled runtime payload root.

## Public cutover

- The permanent package entrypoint is `fgpm-package.json`.
- The top-level package selector is `format`, not `schema`.
- Package lineage is the publisher UUID `namespace` plus immutable local `name`.
- FGPM's self-issued namespace is
  `6d7092e8-6f8a-4e25-bb6e-a0bf6588e5b4`.
- Active manager schemas, protocols, diagnostics, store paths, lockfiles, help,
  examples, packages, and receipts use the `fgpm`/`FGPM` label.
- `fgdungeon.*` remains an independent identity and was not renamed.
- Normal discovery rejects the pre-public entrypoint. The finite
  `migrate pre-public-package` command is the only old-format reader.

The normative details are in
[package entrypoint and identity](guide/package-entrypoint-and-identity.md). The
machine-readable mapping and exception allowlist are in
`public/public-label-cutover.json`.

## Reader hardening

The manager now decodes JSON as strict UTF-8, rejects duplicate object member
names, diagnoses case-mangled or competing package entrypoints, and rejects
unknown package formats without fetching or executing a reader. The archive
entry contract rejects duplicate/case-ambiguous names and wrapper-directory
entrypoint mangling.

## Migration

The migration command previews by default. Apply mode copies to an explicit
output, promotes atomically, never edits the source or private manager indices,
and is idempotent when applied to current input in a new output. Existing state
is reconstructed through migrated package inputs and public manager APIs, not
by rewriting private indices.

The rc.2-to-rc.3 synthetic private-store `variants` qualification is therefore
retained only as historical evidence and is not callable or rerun by the 0.11
source-free qualification kit.

## Scope and gates

This is Stage A only. It does not publish a GitHub release, mutate the public
repository, perform package-link discovery, or claim the Stage A/B gate has
passed. Stage B remains independently owned and must consume the exact Stage A
manager/package contract before the joint gate can be assessed.
