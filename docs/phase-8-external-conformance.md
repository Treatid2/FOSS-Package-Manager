<!-- SPDX-License-Identifier: MPL-2.0 -->

# Phase 8 external path-independence evidence

Date: 2026-08-21  
Evidence label: **demonstrated**

This document records the original Phase 8 external run. The bounded handoff correction adds a
new exact-commit report at packet-generation time. The generator refuses a report whose manager
commit differs from the clean handoff commit or whose manager-core before/after roots differ; the
packet records that report and hash in `CHECKPOINT.json` and
`docs/exact-checkpoint-external-conformance.md`.

The relocatable `examples/external-runtime-task-v2/` directory was copied to a managed,
non-authoritative NVMe allocation outside the repository. The authored profile retained only
`"packageRoots": ["packages"]`; the separately installed demonstration distribution was
supplied by the public repeatable `--packages` option.

## Execution boundary

- Allocation: `20260821T154506461Z-foss-package-manager-81cff7ef`
- Working directory:
  a clean, disposable external-author workspace
- CLI implementation: invoked by absolute installed-tool path while the process working
  directory remained the external directory.
- External package validation: `valid`, `fpm.package/2`, one service and one task.
- Runtime-task conformance: `pass`.
- Deterministic record, transform, and SVG invariance: `true`.
- Observational completion-order difference: `true`.
- Exact manager checkpoint before and after: `df06593d291af102a7b634f05e295c82e525ee89`.
- `git status --porcelain=v1` was empty before and after; no core source or existing package
  changed during the external run.

The generated report was copied to
`evidence/phase-8/external-runtime-task-conformance.json`. Source and retained copies both
had SHA-256:

`6a1c41114c2a34ec4d1b3eaf415e01fa4c7ed2979fdb526496b02e75a7f105ef`

The general scratch allocation was then released as `reclaimable`; the retained evidence on
`L:` is authoritative.

## Claim boundary

This demonstrates path-independent authoring, static validation, resolution, activation,
vocabulary-owned composition, and the conformance matrix for the public example. It does not
claim a package registry, a stable compatibility promise, hostile-native-code containment, or
a second independent fresh-author usability retest.
