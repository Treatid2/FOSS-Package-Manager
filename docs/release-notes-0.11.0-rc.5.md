<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# FGPM 0.11.0-rc.5 candidate notes

This candidate supersedes `0.11.0-rc.4` after a retained Stage B manager root
showed that repeating an already-completed candidate build fails on Windows
while publishing its content-addressed complete-build closure. The rc.4 source,
distribution, manager state, generation, and diagnostic receipts remain
immutable evidence.

## Guarded Windows immutable-closure reuse

Complete-build publication still uses an atomic rename for a new closure. Every
new or reused target is now hashed twice after that durable boundary before the
operation reports success. If
that rename reports `EEXIST`, `ENOTEMPTY`, or Windows `EPERM`, rc.5 treats the
event as possible immutable reuse rather than proof of success. Reuse occurs
only after all of these checks pass:

- the content-addressed target directory exists;
- the complete target tree can be hashed;
- its observed SHA-256 root equals the expected closure root exactly.

An `EPERM` without an existing target is an explicit unresolved publication.
A mismatched or incomplete target fails with
`FGPM_COMPLETE_BUILD_CLOSURE_CONFLICT`; an inaccessible target fails with
`FGPM_COMPLETE_BUILD_CLOSURE_PUBLICATION_UNRESOLVED`; and a target that changes
between observations fails with
`FGPM_COMPLETE_BUILD_CLOSURE_PUBLICATION_UNSTABLE`. Known-good staging is
retained on collision failures and identified in the recovery diagnostic.

Focused controls cover exact Windows reuse, missing targets, mismatched bytes,
unverifiable targets, and a real complete-profile candidate build repeated
against byte-identical durable manager state. The normal serial regression and
source-free distribution qualification remain required for this candidate.
The finite package migration is now a restartable public operation. Its adjacent
`fgpm.pre-public-migration-operation/1` record preserves exact request/input,
prepared/ready/unresolved/committed phase, commit root, result, diagnostic and
continuation. Exact repeats verify/reuse a committed target, including recovery
after durable change or an unavailable response. Wrong, inaccessible and
concurrently changing targets never become success. The transition contract is
`public/migrations/pre-public-package-v1.json`; this tool still never mutates
private manager state or performs a curator's project-state transition.

The permanent public identity boundary remains documented in
`guide/package-entrypoint-and-identity.md`.

## Continuity boundary

This correction does not reconstruct the lost historical chain between the
retained accepted rc.3 generation and the later Stage B generation. Any
prospective migration qualification from that retained snapshot is new forward
evidence only and must remain labelled as such.

This candidate does not perform curator acceptance, publish a release, deploy a
runtime, begin Stage C or D, or close the Stage B cycle.
