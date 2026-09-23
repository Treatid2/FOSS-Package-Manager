<!-- SPDX-License-Identifier: MPL-2.0 -->

# Phase 8 test summary

Environment: Node `v24.18.0`, Windows, 2026-08-21.

## Baseline

At `1061fa060d8a40a33a20bd5a267d9e7e01ec7e99`:

- `npm run contracts:check`: pass;
- `node --test --test-reporter=dot`: 57 passed, 0 failed;
- `git diff --quiet cea2b57 1061fa -- src packages`: exit 0.

## Corrected checkpoint verification

- `npm run contracts:check`: pass;
- `node --test --test-reporter=dot`: 77 passed, 0 failed, exit 0;
- public kit package validation: valid;
- public kit profile validation: valid, 28 selected packages;
- public kit conformance matrix: pass;
- external relocated package validation: valid;
- external relocated conformance matrix: pass;
- `git diff --check`: pass.

Test ledger:

| File | Tests |
| --- | ---: |
| `test/authoring-kit.test.mjs` | 1 |
| `test/authoring-kit-v2.test.mjs` | 1 |
| `test/phase-5.test.mjs` | 9 |
| `test/phase-6.test.mjs` | 4 |
| `test/phase-7.test.mjs` | 12 |
| `test/phase-8-public-contracts.test.mjs` | 8 |
| `test/phase-8.test.mjs` | 11 |
| `test/prototype.test.mjs` | 31 |
| **Total** | **77** |

Post-handoff correction checks additionally cover both required-member failure-policy
combinations, package-real generic-vocabulary stewardship, semantic composition order versus the
unordered explanation `stageSet`, exact split persistence-grant classifications, fixed-point
numeric rejection before mutation, exact public-contract hash verification, and self-identifying
conformance/core audit fields.

During implementation, the typed artifact split exposed one real Phase 6 regression: a test
uses a new persistence store while retaining the original immutable build root. The result now
records `artifactStoreDirectory` separately from runtime `storeDirectory`; the corrected Phase 6
test file passes all four tests.
