<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# FGPM 0.11.0-rc.2 candidate notes

This candidate supersedes `0.11.0-rc.1` after the first external-owner Stage B
qualification exposed two manager-owned public-boundary defects. The rc.1
source, distribution, package, roots, and receipts remain immutable historical
evidence; rc.2 has a new build identity and distribution archive.

The reviewed build-semantic identity is
`sha256:34ff1aab25c2c63be7e27490e2df7b94f5d24c810385835b1bfbacf423edc6a6`,
derived from the candidate version and exact `src`, `public`, and `contracts`
tree roots by `tools/compute-manager-build-identity.mjs`. It is intentionally
distinct from the bundled runtime payload root.

## R3 corrections

- `validate-package` now applies the same directory-entrypoint guard as normal
  discovery, including rejection of a current `fgpm-package.json` beside the
  retired `fpm-package.json`.
- Atomic manager-reference replacement now tolerates a bounded sequence of
  Windows sharing/access transients and reports a public
  `FGPM_REFERENCE_PUBLICATION_FAILED` diagnostic if publication still cannot
  complete.
- Clean-manager qualification now imports, lists, and idempotently reimports a
  package rooted in an external owner workspace containing spaces and Unicode.

The permanent package entrypoint, namespace/name identity, strict JSON reader,
finite migration path, and Stage A scope remain as documented in rc.1 and the
[package entrypoint and identity](guide/package-entrypoint-and-identity.md)
chapter. This candidate does not perform Stage B/C/D work, publish a GitHub
release, or imply acceptance by an external owner.
