<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# FGPM 0.11.0-rc.3 candidate notes

This candidate supersedes `0.11.0-rc.2` after the first full external-owner
Stage B composition exposed a manager-owned workspace-planning defect. The rc.2
source, distribution, roots, and receipts remain immutable evidence; rc.3 has a
new source commit, build identity, and distribution archive.

## Qualified dependency correction

Workspace candidate planning now resolves a qualified package dependency only
against the selected package with the exact `namespace/name` coordinate. A
successful match contributes the selected package's readable ID to internal
dependency and reverse-dependency graph indexes. It does not fall back to a
same-named package in another namespace and does not combine a matching
namespace from one selected package with a matching name from another.

Unqualified dependencies continue to resolve against the selected readable ID,
preserving existing FGPM-owned package behavior. Version ranges are checked
after exact selector resolution. The current public dependency contract carries
`package` and `range`; it does not carry an exact content root, so rc.3 makes no
new root-pin claim for dependencies.

Focused tests cover exact cross-namespace satisfaction, wrong-namespace
rejection, conflicting namespace/name components, and retained unqualified
dependency behavior.

The permanent package identity boundary remains documented in
`guide/package-entrypoint-and-identity.md` in the source-free distribution.

## Upgrade and reconstruction

Keep the rc.2 archive, extracted tool, and qualification receipts as immutable
evidence. Extract rc.3 into a separate empty directory and verify its archive,
`--version`, `doctor`, and `contracts verify` receipts before use.

The public manager-state format is unchanged. A public-only rc.2 manager root
may be planned again with rc.3, but preserve or snapshot that root first. A
fully reconstructible alternative is to create a fresh manager root, import the
same sealed packages through `package import`, recreate the workspace stages at
their exact content roots, and rerun `workspace plan`. No package-owner source
edit, private-index edit, or pre-public state copy is required.

This candidate does not activate a generation, publish a GitHub release,
perform package-link discovery, claim downstream acceptance, or change any
external-owner package.
