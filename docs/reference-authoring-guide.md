<!-- SPDX-License-Identifier: Apache-2.0 -->
# FGPM package authoring guide — current experimental v0

This guide describes the currently demonstrated reference-manager surface. It is not a stability
promise. An author should not need the manager repository or an existing producer implementation to
discover the public contract.

## 1. Verify the tool and contracts

From any current directory, including a path containing spaces or non-ASCII characters, run:

```powershell
<tool>\fgpm.cmd --version --json
<tool>\fgpm.cmd doctor --json --manager-root <writable-manager-root>
<tool>\fgpm.cmd contracts verify --json
<tool>\fgpm.cmd help --json
```

Keep the tool directory read-only. Choose unrelated writable directories for the manager root,
build output, author workspace, and fixture extraction.

## 2. Start from the public runtime-task-v2 kit

Copy `guide/runtime-task-v2/example-package` to the author workspace. Retain or issue a publisher
namespace, then rename the immutable local package name, service,
task member, and binding. Change the deterministic transform in `task.mjs`. The normative public
schemas and closed vocabularies are in `public/`; the kit's checksum verifier detects accidental
contract drift.

Validate without executing package code:

```powershell
fgpm.cmd validate-package <author-package>
```

For an owned pre-public package tree, use the separately bounded migration path.
Preview is the default; apply mode writes only to a new explicit output:

```powershell
fgpm.cmd migrate pre-public-package <source> --namespace <publisher-uuid>
fgpm.cmd migrate pre-public-package <source> --namespace <publisher-uuid> --apply --out <new-output>
fgpm.cmd migrate pre-public-package status --out <new-output>
```

Apply is restartable. The adjacent operation record exposes its exact input
root, plan, commit root, result, diagnostic and continuation; repeating the
same request verifies/reuses a committed target rather than overwriting it.

Do not use FGPM's own namespace for an independently maintained package. Each
maintainer issues and persists its own lower-case UUID namespace. See
`guide/package-entrypoint-and-identity.md` for the complete identity, discovery,
archive, sidecar, migration, and recovery boundary.

Unknown fields, invalid vocabulary values, wrong stewards, undeclared host grants, and malformed
entry-point paths fail with structured public diagnostics. Stacks remain suppressed unless
`--debug` is explicit.

## 3. Exercise the sealed reference fixture

The fixture is an immutable, source-independent container used to prove that the tool does not rely
on the manager checkout:

```powershell
fgpm.cmd fixture verify <tool>\fixtures\runtime-task-v2.fixture
fgpm.cmd fixture materialize <tool>\fixtures\runtime-task-v2.fixture --out <empty-workspace>
fgpm.cmd validate-profile <empty-workspace>\profile.json
fgpm.cmd run <empty-workspace>\profile.json --out <writable-output> --ticks 1
```

Changing a fixture byte or declared hash must fail verification before materialization or
activation.

## 4. Persistent authoring lifecycle

Use one explicit `--manager-root` for every persistent command:

```text
package import <package-directory>
package list
workspace create <name>
workspace stage <name> <operation-json-file> --expected <workspace-head>
workspace choose <provider|adapter|replacement> ...
workspace plan <name> [--profile <profile>]
candidate explain <candidate-root>
candidate build <candidate-root>
candidate validate <candidate-or-build-root>
generation commit <validation-root>
generation show <generation-root>
distribution export <generation-root> --out <directory>
distribution verify <directory>
distribution import <directory>
```

The manager imports package trees immutably and inertly. Workspace edits use immutable revisions;
candidate and generation identities are content-addressed. Activation consumes the committed
generation rather than an unrelated profile override. Distribution verification is non-mutating;
import is explicit. On Windows, a JSON file is the normative portable input for `workspace stage`;
do not depend on shell-specific inline JSON quoting. Copy
`guide/runtime-task-v2/workspace-stage-add.json`, replace `packageRoot` with the exact root returned
by `package import`, pass the current workspace revision with `--expected`, and use `--actor` through
the CLI or the control operation when provenance must be explicit. The complete versioned operation
union is `public/schemas/workspace-operation-v1.schema.json`. Replaying one request ID with the same
canonical request in the same control process returns the original response without a second
dispatch. Its original `authority` remains unchanged and internally coherent; the separate
`transportReplay` record states `dispatched: false` and `authorityMoved: false` for the later
transport event. Reusing a request ID for different content fails before dispatch. Repeating an
operation under a new request ID creates explicit new history. A stale expected head returns a
structured diagnostic without moving the workspace head.

### Persistent runtime control

Activation, runtime inspection/tick/checkpoint, transition or rollback, and shutdown are one live
coordinator-owned lifecycle. Standalone `generation activate` and `generation rollback` therefore
return `FGPM_CONTROL_SESSION_REQUIRED`; they cannot publish a durable reference and abandon its only
controller.

Start one process and keep it alive:

```powershell
Get-Content -LiteralPath <requests.jsonl> | <tool>\fgpm.cmd control --manager-root <writable-manager-root>
```

Begin with `control.describe`. It returns every operation's parameter/result contract, preconditions,
failure codes, process-lifetime rule, minimal request, and commit boundary. Copy
`guide/runtime-task-v2/control-lifecycle.jsonl`, replace both generation placeholders with two
distinct retained generation roots, replace the checkpoint placeholder with a fresh save identity,
and preserve the correlated request IDs and responses. The example deliberately publishes the same
completed checkpoint twice under different request IDs: the first result is `first-publication` and
moves manager authority, while the identical second publication is `idempotent-reuse` and moves no
authority. Expected result classes, session effects, and authority projections are in
`guide/runtime-task-v2/control-lifecycle-expected.json`. The normative catalogue is
`public/schemas/control-operation-catalogue-v1.json`.

Every response labels `authority.projection` as `combined-manager-runtime`, exposes its combined
`moved` value, and separately reports `managerMoved` and `runtimeMoved` with before/after roots for
all three views. A new request ID that republishes identical checkpoint content therefore differs
from transport replay: it executes capture, returns `publication.class = idempotent-reuse`, and
leaves both authority components unchanged.

Activating the currently active generation creates a new session and is classified as
`same-generation-reactivation`. `generation.rollback` requires a live session owned by the same
persistent control process and a different retained generation. With no owned live session it
returns `FGPM_GENERATION_ROLLBACK_SESSION_REQUIRED` before target construction; a stale durable
reference remains the distinct `FGPM_ACTIVE_RUNTIME_SESSION_STALE` recovery case. Successful rollback
evidence identifies both generation roots and distinct sessions. The old runtime shuts down before
the target generation commits and becomes authoritative.

Normal `runtime.shutdown`, `control.stop`, and control-input EOF shut down an owned runtime before
clearing its active reference. If an unexpected process death leaves a durable reference, a new
control process reports it as `stale`; it will not tick or adopt it. Inspect with
`generation.active`, then call `generation.clear-stale` with the exact reported session identity
before a clean activation.

## 5. Runtime task v2 boundary

A task member declares its stewarded schema and vocabulary, participation, failure policy, affinity,
immutable snapshots, output channels, stage, and composition law. The service declares its module,
activation contract, artifact access, host grants, and execution form. Declaration is not authority:
the cooperative host exposes only declared snapshots and buffers outputs until the required-task
barrier commits.

Native in-process modules are not hostile-code containment. They have the user's process authority.
The portable WebAssembly handler form has a narrower capability ABI, but executable packaging and
process separation do not make arbitrary native packages safe.

## 6. Evidence and explanation

Use `conformance runtime-task` to compare deterministic evidence under delayed scheduling. The clean
command audits only the installed distribution identities, public contracts, fixture, profile, and
selected package roots; it requires no repository source, Git metadata, or source CLI. Success and
failure both retain `runtime-task-conformance.json`, including pre/post authority roots and scheduler
observations when a tick aborts. Use
`explain`, `explain runtime`, `candidate explain`, `generation show`, and `store-report` to inspect
public provenance and immutable-store reachability. Preserve the exact tool identity, contract root,
fixture root, package root, manager root, output root, commands, exit codes, and generated reports.

The supplied fresh-author evaluation brief is a handoff packet, not a self-certification. Its clean
room evaluation must be performed by an independent instance that receives only this distribution.
