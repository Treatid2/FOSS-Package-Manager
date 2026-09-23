<!-- SPDX-License-Identifier: MPL-2.0 -->

# Phase 9 benchmark report

## Method

The retained harness generated strict public `fpm.package/2` trees and used normal import,
workspace, candidate, build, validation, and commit entry paths. The run used Node `v24.18.0` on
Windows x64, one worker, a managed NVMe scratch allocation for reconstructible package trees, and
an authoritative JSON result promoted to the retained evidence store.

Timings are observational. Package, candidate, generation, and runtime-plan identities exclude
timing, worker, process, temporary-path, and cache facts.

## Acceptance scale

| Packages | Import/index | Candidate plan | Candidate | Generation committed |
| ---: | ---: | ---: | --- | --- |
| 10 | 132.60 ms | 30.85 ms | ready-to-build | yes |
| 100 | 1,186.17 ms | 260.29 ms | ready-to-build | yes |
| 1,000 | 12,565.33 ms | 2,567.05 ms | ready-to-build | yes |

These three measurements do not establish an asymptotic class or production viability.

## Incremental closure

| Packages | Leaf affected | Central affected | Interpretation |
| ---: | ---: | ---: | --- |
| 10 | 1 | 10 | Work reports the measured dependency closure. |
| 100 | 1 | 100 | Leaf closure remains bounded. |
| 1,000 | 1 | 1,000 | Central update reaches the full controlled chain. |

The central candidates are deliberately blocked because downstream packages require the exact old
version. That is a compatibility diagnostic, not a benchmark failure; their impact paths still
cover exactly the measured closure.

## Selected versus installed

Growing the installed store from 100 to 1,000 packages while retaining the same 100-package
workspace produced the same candidate root and byte-identical runtime plan. Active service and task
counts remained zero in this graph.

## Diagnostic locality at 1,000 packages

- ambiguity: `FPM_CANDIDATE_PROVIDER_AMBIGUOUS`;
- duplicate immutable version: `FPM_PACKAGE_VERSION_CONFLICT`;
- missing dependency: `FPM_CANDIDATE_DEPENDENCY_MISSING`;
- cycle: `FPM_CANDIDATE_DEPENDENCY_CYCLE`, with an exact four-entry closed path for a local
  three-package cycle.

## Exploratory scale

The 10,000-package run was deferred. Phase 9 acceptance is through 1,000 packages, and a larger run
would not compensate for weak transaction semantics or diagnostics.

Raw result: `evidence/phase-9/benchmark-results.json`.
