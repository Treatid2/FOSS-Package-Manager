<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# FGPM 0.11.0-rc.4 candidate notes

This candidate supersedes `0.11.0-rc.3` after the independently accepted
33-package Stage B composition exposed a manager-owned public dungeon
qualification defect. The rc.3 source, distribution, accepted generation, and
receipts remain immutable evidence.

## Qualified provider-pin correction

The public dungeon harness no longer compares a runtime-plan service's readable
package ID directly with a commissioned `namespace/name` provider coordinate.
Before activation it now verifies all of these independent facts:

- the provider pin is a syntactically exact qualified coordinate;
- the coordinate's readable-name component matches the selected service's
  readable package ID;
- the selected generation contains exactly that readable ID at the pinned root;
- the service record matches the pinned root, version, and service identity;
- the public installed-package registry contains exactly the pinned coordinate,
  namespace, readable ID, version, and root.

This accepts valid qualified pins without falling back by readable name and
rejects wrong-namespace or substituted-coordinate records even when their
readable ID, version, and root otherwise match. Package-owner inputs and runtime
semantics are unchanged.

Focused tests cover a valid qualified pin and both wrong-namespace pin and
wrong-coordinate registry substitutions. The permanent package identity
boundary remains documented in `guide/package-entrypoint-and-identity.md`.

## Upgrade and reconstruction

Keep the rc.3 archive, extracted tool, manager root, accepted generation
`sha256:0412b637af439ced4808474c6fa317b3e4d642e553928a99ea62b271e103f0d2`,
and its receipts as immutable evidence. Extract rc.4 separately and verify its
archive, `--version`, `doctor`, and `contracts verify` results.

Manager storage formats and package roots are unchanged, but generation records
are bound to the manager semantic version. Do not relabel or mutate the accepted
rc.3 generation. Re-plan, build, validate, and commit the same preserved
workspace under rc.4, or reconstruct a fresh public manager root from the sealed
package imports and exact workspace stages, before running the rc.4 dungeon
qualification. The resulting rc.4 generation identity must be recorded anew.

This candidate does not perform curator acceptance, activate a downstream
generation, publish a GitHub release, perform package-link discovery, or modify
any package-owner source.
