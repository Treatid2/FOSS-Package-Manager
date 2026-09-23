# Phase 9 integrated benchmark report

The retained machine-readable report is `integrated-benchmark-results.json` in the response evidence directory.

| Packages | Candidate | Impact planning (ms) | Authoritative build (ms) | Validation (ms) | Materialisation | Commit |
|---:|---|---:|---:|---:|---|---:|
| 10 | ready-to-build | 28.12 | 31.93 | 9.17 | no artifact requested | 14.39 ms |
| 100 | ready-to-build | 219.01 | 282.94 | 61.37 | no artifact requested | 67.37 ms |
| 1,000 | ready-to-build | 2,145.63 | 2,695.40 | 566.82 | no artifact requested | 583.07 ms |

The JSON report is authoritative for the unrounded commit timings, environment facts, identities, and roots.

For all three sizes, the accepted base and leaf-update candidates passed the authoritative selection-root comparison. Leaf impact remained one package. A deliberately incompatible central version change attributed 10, 100, and 1,000 affected packages respectively and remained blocked. Importing 900 additional but unselected packages left the 100-package candidate and runtime-plan identities unchanged. At 1,000 packages, ambiguity, missing dependency, cycle, and duplicate-version diagnostics retained their attributed local codes.

These observations are **supported but limited** synthetic evidence. The materialisation field is deliberately a no-op for package-only graphs, and earlier simplified-planner timings are not relabelled as full-pipeline timings.
