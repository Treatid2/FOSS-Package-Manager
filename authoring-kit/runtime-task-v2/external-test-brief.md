<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 8 follow-up fresh-author retest brief

Status: **prepared, deliberately not executed in Phase 8**

Give a fresh author only this `runtime-task-v2` kit, the installed public schema/vocabulary
directory, the FGPM CLI path, and an installed demonstration package-root path. Do not provide
manager source, existing producer implementations, Phase 7 findings, or Phase 8 implementation
notes.

Ask the author to:

1. create a new package and task identity outside the manager repository;
2. contribute exactly `+0.375` to the demo character's Z axis without naming any existing
   producer identity or depending on the scheduler package;
3. statically validate the package;
4. add it through a relocatable `fgpm.profile/3` profile and validate that profile;
5. run `conformance runtime-task --focus <new-exact-task-member>` and verify the retained
   one-worker, focus-delayed, and recorded-peer-delayed configurations;
6. explain both `runtime.transforms.commands` and the new exact task identity from retained
   lifecycle evidence;
7. exclude the new optional member with an identified exact-member policy, rerun it, and retain
   the explanation and baseline-equivalent roots;
8. create a reversible non-composable variant by changing the new task to a second `set-axis`
   base producer for the same target as the demonstration base task;
9. prove the deliberate variant fails before mutation by retaining equal authoritative
   transform roots immediately before and after the failed tick, then restore the valid variant;
10. retain a before/after audit proving that manager `src/`, `public/`, and installed package
    files were not changed to obtain success;
11. report every ambiguity, source-code lookup, undocumented guess, and failed command.

## Evidence to retain

- authored files and hashes;
- exact commands, process working directory, manager commit, and Node version;
- package content hashes, profile hash, public-contract bundle hash, and installed distribution
  identity;
- package/profile validation output;
- one-worker and multi-worker/delay conformance report and deterministic/observational comparison;
- required exact-member exclusion evidence;
- deliberate non-composable failure, equal pre/post authoritative roots, and restored valid files;
- runtime explanation output;
- manager-core before/after audit;
- time to first successful validation and first successful tick;
- classification: Class A (public-only success), Class B (minor documentation repair), or
  Class C (tooling/source coupling), or Class D (the public contract architecture prevents the
  task without changing manager core or an established public boundary).

The repository mechanical self-check and the Phase 8 internal external-example run are not this
independent retest and must not be reported as one.
