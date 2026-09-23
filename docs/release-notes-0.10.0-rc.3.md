<!-- SPDX-License-Identifier: Apache-2.0 -->
# FGPM 0.10.0-rc.3 — exact-root variant recovery candidate

Candidate-only manager correction for the retained G5 programme. Not accepted,
published or deployed. See `guide/package-variant-recovery.md` in the distribution.

New public operations `package.registry.inspect` and `package.variant-register`
classify rc.2 conflict residue and formally register opt-in exact-root variants.
Ordinary `package.import` still rejects an unknown conflicting ID/version root,
now before publishing content. Workspace staging/planning rejects unregistered
roots rather than exploiting a failed import. No Runtime provider pins are changed.

Successful registry writes preserve legacy installed entries and migrate the index
to `fpm.installed-index/2` (record version 1), with atomic hash-linked audit history.
Opening or inspecting an rc.2 registry does not migrate it. A migrated copy cannot
be reopened by rc.2; keep the original snapshot. Immutable baseline package and
generation records are neither rewritten nor relabelled.

Owner fixtures and source-free public qualification are not the real FGRW recovery
proof. Independently assessed manager and corrected Runtime candidates must precede
curator C4/C5/C6 application. G1 stays dual-layer, with public cases additive rather
than source-free137/146 equivalence. No persistent-world-state rollback is claimed.
