<!-- SPDX-License-Identifier: MPL-2.0 -->

# Phase 9 test summary

## Baseline

- exact starting commit: `cf2a0c45ba8d41459c9771f873f2cc993897bc50`;
- baseline `npm run contracts:check`: pass;
- baseline `npm test`: 83 passed, 0 failed;
- working tree was clean before branch creation.

## Final

- branch: `phase-9/persistent-workspace-generations`;
- final `npm run contracts:check`: pass;
- focused Phase 9 tests: 13 passed, 0 failed;
- complete `node --test`: 96 passed, 0 failed in 34.91 seconds;
- corrected Phase 8 public-only authoring-kit verification: pass;
- managed 10/100/1,000-package benchmark: exit 0, 51.99 seconds;
- 1,000-package ambiguity, duplicate, missing-dependency, and local-cycle diagnostics: present.

## Retained evidence

- `evidence/phase-9/baseline-contracts-check.log`;
- `evidence/phase-9/baseline-tests.log`;
- `evidence/phase-9/final-tests.log`;
- `evidence/phase-9/final-tests-receipt.json`;
- `evidence/phase-9/benchmark-results.json`;
- `evidence/phase-9/benchmark-receipt.json`;
- `evidence/phase-9/gate-summary.json`.

The final run includes every accepted Phase 8 test plus Phase 9 import, persistence, concurrency,
impact, derivation, commit, replay, runtime-transition, exit, schema, and synthetic-entry-path tests.

