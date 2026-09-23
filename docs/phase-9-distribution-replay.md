<!-- SPDX-License-Identifier: MPL-2.0 -->

# Phase 9 distribution replay

The first distribution format is a local self-contained directory bundle.

## Export

`CurationManager.exportDistribution()` writes:

- `distribution.json` with `fpm.distribution/1` identity inputs;
- the exact immutable `fpm.generation/1` record;
- every selected source and derived package tree;
- a sorted member inventory with byte count and SHA-256.

The distribution identity depends on the generation, package roots, public-contract requirement,
and manager requirement. Directory enumeration and manifest member order are not identity inputs.

## Import transaction

Import validates the complete member set and every declared byte/hash before it writes to the empty
manager store. It then imports each package through normal public package validation and verifies
that the reproduced content root matches the generation. Only then does it publish the immutable
generation and distribution records.

## Evidence

Focused tests demonstrate:

- exact generation identity in a fresh empty store;
- exact source and derived roots;
- exact runtime-plan, deterministic-tick, and visible-output roots;
- member-order independence;
- missing-member failure before import;
- corrupt-member failure before import;
- workspace fork without mutation of the imported distribution.

This does not implement an archive container, repository, download, update policy, signature,
publisher identity, or trust system.

