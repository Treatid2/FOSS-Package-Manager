<!-- SPDX-License-Identifier: MPL-2.0 -->

# Phase 8 baseline evidence

## Repository

- Baseline commit: `1061fa060d8a40a33a20bd5a267d9e7e01ec7e99`
- Preserved tag: `phase-7-prototype` at
  `cea2b57cfe777c8607358bea16661690343594e8`
- Correction branch: `phase-8/public-boundary-correction`
- Baseline implementation/package delta from the tag: none
- Baseline worktree state: clean
- Node: `v24.18.0`

## Baseline commands

```powershell
node --test --test-reporter=dot
npm run contracts:check
git diff --quiet cea2b57cfe777c8607358bea16661690343594e8 `
  1061fa060d8a40a33a20bd5a267d9e7e01ec7e99 -- src packages
```

## Results

- Existing tests: 57 passed, exit code `0`.
- Architecture contract check: passed, exit code `0`.
- Restricted implementation/package comparison: no differences, exit code `0`.

These results were recorded before Phase 8 behavior changes. The one-line workspace-path
wording correction in the repository README was temporarily removed for this exact baseline
and then restored on the correction branch.

