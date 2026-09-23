<!-- SPDX-License-Identifier: Apache-2.0 -->
# FGPM reference authoring tools 0.11.0-rc.6

This is the source-free Windows x86-64 authoring distribution for the experimental FOSS Package
Manager contracts. It contains a bundled reference runtime, public contracts, the runtime-task-v2
authoring kit, and a sealed self-check fixture. It does not contain the manager repository, private
review material, or an unpacked implementation-package tree.

Run `fgpm.cmd --version --json`, `fgpm.cmd doctor --json`, and
`fgpm.cmd contracts verify --json` first. Commands never install dependencies, check for updates, or
open the network. Put mutable state outside this directory with `--manager-root`; `--out` similarly
selects build output. Several versions of this directory can coexist.

The bundled runtime is not a security sandbox. Native package code executes with the invoking
user's authority. Debug stacks are opt-in with `--debug`.

See `guide/package-authoring-guide.md`, then materialize
`fixtures/runtime-task-v2.fixture` into a new writable directory for the guided lifecycle exercise.
For persistent runtime work, begin with `control.describe` and use the packaged
`guide/runtime-task-v2/control-lifecycle.jsonl` in one long-lived `fgpm control` process. Resolve it
against a fresh manager root, a unique save identity, and two distinct retained generation roots;
the paired expected-response file checks checkpoint first-publication/reuse and the generation/session
transition rather than serving as an illustrative transcript only.
The version and doctor records distinguish the manager semantic build identity, runtime
implementation payload root, distribution content root, public-contract root, sealed-fixture root,
source correspondence root, and licence/SBOM root. Licences, the complete exact bundled Node
third-party notice set, SBOM, runtime provenance, hashes, and source correspondence are under
`manifests/` and `LICENSES/`.
# Public package content identity

From any directory, with no project/store or checkout, use the extracted tool:

```powershell
& 'C:\Tools\FGPM\fgpm.cmd' package identity 'C:\Received packages\fgdungeon.reference-runtime' --expected sha256:114d063d41637944db7fa9c20347019ffb7b1f530b26b2ddcfb0e450ccbf899d
& 'C:\Tools\FGPM\fgpm.cmd' package identity 'C:\Received packages\fgpm.grid-dungeon-integration-runtime' --expected sha256:2e0d44cdc4756a3962f133364616c7d57889f18801dc6b2cc4200e52f666f475 --json
```

Omit `--expected` to compute only. Exit 0 means computed/match; 1 means mismatch;
2 means verification could not complete. Both presentations expose input, expected,
observed, status and exit code; errors include code and cause. JSON is
`fgpm.package-identity/1`, described in `public/package-identity.schema.json`.
Discover with `fgpm package identity --help` or `fgpm package --help`.

This reuses `src/core/io.mjs hashDirectory`: recursively sort siblings with the
bundled Node's default `name.localeCompare`, depth-first; exclude exact names
`.git`, `node_modules`, `build` at every depth; hash each regular file's relative
path (slash separators, UTF-8), NUL, raw bytes, NUL with SHA-256. Empty directories
are not identity-significant. No byte/newline/Unicode normalization is applied.
The public strict mode rejects root links and links/non-regular entries encountered
in traversed directories (even when their own name is excluded), rather than accepting
a partially supported tree. Excluded directory contents are not traversed.
This does not alter identity bytes for supported trees or existing internal callers.
The supplied package roots remain unchanged.

Tested platform: Windows x64 with bundled Node 24.18.0. Ordering is locale/runtime
bound, not a claimed cross-platform canonicalization. Use a quiescent directory:
no atomic filesystem snapshot or concurrent-writer guarantee is provided. Read errors
fail verification; no partial observed root is returned. Access-time metadata effects
are outside byte/path non-mutation claims. Very large trees have no streaming-memory
guarantee (the authoritative routine reads each file into memory).

This command reads directory metadata and file bytes only: no package entry points,
hooks, schema resolution, registry/network, manager store/index, workspace, lock or
generation operations. Receipts go only to stdout, never inside the input tree.
A content match is not schema conformance, authenticity, safety, compatibility,
acceptance or permission to run. Run `validate-package` separately if desired;
the retained runtime is valid `fgpm.package/2`, whereas the retained host is
`provisional-v1`. Identity does not promote that status.

## Release candidate verification (no checkout or LLM required)

This is a release candidate, not an accepted or published manager release. See
`RELEASE-NOTES.md` for version rationale and preserved source lineage.
Extract `fgpm-reference-tools-win32-x64-v0.11.0-rc.6.zip` into an empty directory.
First compare `Get-FileHash <archive> -Algorithm SHA256` with the independently
received qualification receipt. Then run the three checks above from any working
directory, followed by `fgpm.cmd package identity <quiescent-package>`.
The launcher uses only `bin/node.exe`; no Node installation, npm, developer
checkout, LLM, network or manager store is needed. `doctor` verifies member
checksums; these establish consistency, not independent authenticity.
Use the documented authoring guide and sealed fixture for manager operations;
put writable state/output outside the extracted distribution. Do not repin an
accepted project merely because the candidate passes these checks.

## Explicit exact-root variants and recovery

This section describes the retained rc.3 recovery surface. It is historical for
the 0.11 public-contract candidate: do not copy an rc.2 private manager store into
0.11. Migrate owned packages with `fgpm migrate pre-public-package` and reconstruct
state through current public APIs.

`fgpm package registry --manager-root <copy>` inspects registration, retained
references, residue, ambiguity and audit history. `--json` carries the same facts.
`package.variant-register` is an explicit expert operation, never an ordinary
import override or automatic selection rule. See `guide/package-variant-recovery.md`
for exact expected-root, durable registration-ID, provenance and optional index-head
inputs. Ordinary conflicting imports still reject. No destructive cleanup exists.
The first successful registry mutation upgrades the copied index; rc.2 cannot read
the new index schema. Preserve the verified original and assess rc.3 before use.
