<!-- SPDX-License-Identifier: Apache-2.0 -->

# Runtime-task v2 public contract

Status: **experimental; no compatibility promise**  
Evidence label: **supported by schemas and demonstrated by the Phase 8 prototype**

## 1. Package and static activation

The exact package entrypoint is `fgpm-package.json`. Its `format` is strict
`fgpm.package/2`, and its publisher `namespace` plus immutable local `name` identify
the package lineage. Unknown fields are errors with a schema
identity, exact JSON instance path, violated rule, and steward. A service uses
`fgpm.runtime-service/2`, declares `artifactAccess`, `artifactStoreAccess`, `hostGrants`, its
trusted native execution form, a service module, and an `activationContract` JSON file.

`validate-package` checks the manifest, service module, activation contract, provider identity,
and worker module path without importing or executing native code. For a task provider the
static capability value is exactly:

```json
{
  "protocol": "fgpm.runtime-task/2",
  "provider": "service:your.package/1",
  "workerModule": "task.mjs"
}
```

The native service returns the corresponding absolute worker URL at activation time in a
`fgpm.runtime-service-response/2` envelope. The runtime provider must equal the selected service
instance.

### Runtime service module ABI

The service module exports a zero-argument factory. Runtime dependencies are not constructor
arguments and are not passed to the factory:

```js
export function createService() {
  let transforms;
  return {
    async activate(context) {
      transforms = context.require("runtime.transforms.read");
      return {
        protocol: "fgpm.runtime-service-response/2",
        capabilities: {
          "runtime.task": Object.freeze({
            protocol: "fgpm.runtime-task/2",
            provider: "service:your.package/1",
            workerModule: new URL("./task.mjs", import.meta.url).href,
          }),
        },
      };
    },
    async deactivate(context) {
      transforms = null;
    },
  };
}
```

The manager calls `createService()` with exactly zero arguments and requires it to return a
fresh controller with `activate(context)`. The deeply frozen activation context is the only
manager-supplied dependency interface. A service acquires each runtime dependency with
`context.require(capability)`, and only capabilities declared in that service's manifest may be
requested. An undeclared request fails with `FGPM_RUNTIME_AUTHORITY_DENIED`; a declared optional
requirement which has no selected provider returns `null`.

Activation follows the resolved dependency graph: providers activate before their consumers.
The activation response protocol must match the service protocol, and its `capabilities` object
must publish every selected capability declared by the service. After all activations succeed,
the manager calls optional `commit(context)` hooks in activation order. On shutdown it calls
optional `deactivate(context)` hooks in exact reverse activation order. A failed activation is
uncommitted and rolls back the already-active prefix in reverse order.

## 2. Task member declaration

A `runtime.task` collection contribution uses capability version `2.0.0`, a stable exact member
identity, a unique provider binding, and `fgpm.runtime-task-member/2` metadata:

```json
{
  "schema": "fgpm.runtime-task-member/2",
  "vocabulary": "fgpm.runtime-task-vocabulary/2",
  "participation": "optional",
  "failurePolicy": "drop-task",
  "affinity": "any-worker",
  "snapshots": [{
    "capability": "runtime.transforms.read",
    "schema": "fgpm.transform-snapshot/1",
    "vocabulary": "fgpm.transform-task-vocabulary/1"
  }],
  "outputs": [{
    "channel": "runtime.transforms.commands",
    "vocabulary": "fgpm.transform-task-vocabulary/1",
    "stage": "add-axis",
    "law": "deterministic-sum-per-target"
  }]
}
```

`participation` controls excludability only:

- `required` — exact-member policy cannot exclude the task;
- `optional` — an identified policy may exclude it before activation.

Either participation value may be combined with either failure policy. In particular,
`required`/`drop-task` means the selected member cannot be removed by policy, but an attributed
invocation failure may still be dropped. Presence and invocation failure remain separate axes.

`failurePolicy` independently controls invocation failure:

- `abort-tick` — discard all uncommitted buffers and abort the tick;
- `drop-task` — attribute the failure and omit that task's buffer.

The corrected declaration rejects Phase 7's duplicate/inert `exclusive`, `phase`, `reentrancy`,
`required`, and `failure` fields. Runtime-generation overlap is enforced by the host rather than
being an accepted-but-inert per-task declaration.

## 3. Worker envelope and authority

The worker exports `runTask(context)`. It receives:

- `context.checkpoint` — immutable `fgpm.runtime-tick/1`;
- `context.execution` — observational worker lane/thread facts;
- `context.snapshot(capability)` — an immutable clone, only for declared snapshot capabilities;
- `context.emit(channel, operation)` — buffered output, only for declared channels.

Direct runtime capability lookup/mutation is denied. The worker response is
`fgpm.runtime-task-worker-response/2`, with task identity, `completed` or `failed` outcome, and
emissions. A successful worker never commits state directly.

## 4. Transform composition

The contributor depends on the real selected `fgpm.runtime-task-contracts` package, steward of
`fgpm.runtime-task-vocabulary/2`, and `fgpm.transform-task-contracts`, steward of
`fgpm.transform-task-vocabulary/1`; it does not depend on a scheduler. The scheduler delegates
channel planning and composition to the selected vocabulary provider.

The implemented stages are:

1. `set-axis` / `exclusive-per-target` — zero or one base contribution for each
   `(instanceId, axis)`;
2. `add-axis` / `deterministic-sum-per-target` — all additions ordered by stable public task
   member identity and applied through the exact six-decimal fixed-point model below.

The numeric model parses worker JSON numbers as IEEE-754 binary64 using ECMAScript `JSON.parse`
semantics (including JSON exponent notation) and has scale `1,000,000`. Every finite parsed value
must produce a safe integer when multiplied by that scale; otherwise the complete batch is
rejected before mutation. No rounding is performed. The staged current value and each operation
are converted to signed integer micro-units, each sum must remain a safe integer, and the result
is divided by the scale after each operation. Negative zero is canonicalized to positive zero.
Overflow rejects the complete batch before mutation. Stable task identity order is retained as
public provenance; integer addition itself introduces no order-dependent rounding.

Stage order is vocabulary-owned. A second base producer for the same target fails with
`FGPM_TASK_COMMAND_COMPOSITION_AMBIGUOUS` before Transform Authority mutation. Producers never
name one another. Discovery, activation, worker start, and worker completion order have no
semantic priority.

The deterministic tick record preserves vocabulary, steward, rule, stages, contributors,
command-buffer roots, and vocabulary-derived commit order. The trace preserves worker count,
thread facts, and completion order as observations.

## 5. Exact-member exclusion

Only an `optional` member may be excluded. The documented profile syntax is:

```json
{
  "policy": {
    "collectionPolicy": {
      "runtime.task": {
        "id": "policy:your.distribution/exclude-example/1",
        "exclude": ["task:example.runtime-task-v2/add-y/1"]
      }
    }
  }
}
```

The member must exist in the selected graph, the exclusion list must contain unique exact
identities, and the policy identity is retained in the plan and tick record.

## 6. Public CLI and conformance controls

```text
validate-package <package-directory-or-manifest>
validate-profile <profile> [--packages <distribution-root>]
run <profile> [--ticks <non-negative-count>] [--interactive] --workers <positive-count> \
  --delay <exact-task-member>=<non-negative-ms> [--packages <distribution-root>]
conformance runtime-task <profile> --focus <exact-task-member> \
  [--packages <distribution-root>] [--out <directory>]
explain runtime <runtime-lifecycle.json> <service-capability-channel-vocabulary-or-task>
```

`--packages` is repeatable. Package roots in the profile remain relative to that profile;
separately installed distribution roots belong to invocation/configuration, not authored JSON.
`--delay` is repeatable and exact-member keyed. `run --ticks N` completes exactly N initial ticks
and then stops unless `--interactive` is explicit. Without `--ticks`, `run` is interactive by
default. `--snapshot` selects SVG output only and never controls liveness.

The conformance command verifies that `--focus` is a selected `runtime.task` member and a
contributor to the relevant channel. It runs one worker, four workers with that exact focus
delayed 40 ms, and four workers with a peer delayed 40 ms. The peer is the lexicographically first
other selected channel contributor; this is a reproducible test choice, not semantic ranking.
The retained report records the focus, peer and reason, requested delays, effective worker counts,
and completion order. These controls and observations are excluded from deterministic tick
identity. The report requires deterministic record, output transform, and SVG equality and also
identifies the manager commit and CLI hash, Node/runtime and working directory, profile and
contract hashes, selected package content hashes, installed distribution identity, and a
manager-core before/after tree audit.

Positive report roots are unambiguous: `inputTransformRoot` is the immutable pre-tick snapshot;
`outputTransformRoot` is `record.result.stateRoot` after authoritative commit. There is no generic
`transformRoot` alias.

A trusted specialist may throw the public structured FGPM error shape `{ code, message, details }`,
where `code` begins `FGPM_`, `message` is a string, and `details` is structured JSON data. It does
not import the manager-private error class. The manager preserves all three fields. CLI diagnostics
suppress stacks by default; explicit `--debug` may include one. Unstructured failures are reported
as `FGPM_INTERNAL`.

If a conformance tick fails, the CLI writes `fgpm.runtime-task-conformance-report/2` with `status:
fail` before returning non-zero. The report retains configuration/focus/peer facts, the structured
public error and composition details, pre/post authoritative roots and equality, mutation status,
successful-tick status, observational trace, and the manager-core audit. A rejected pre-mutation
batch has no successful deterministic tick record.

## 7. Artifact and host boundary

Manager core verifies a `fgpm.typed-artifact-reference/1` root and offers a generic entry byte
reader. Domain specialists, not core, decode scene/world JSON. Native runtime services request
exact `fgpm.host.* /1` grants and use `context.grant(identity)`; there is no shared
`context.options` bag. Plans record grant, status, classification, provider, and policy.

Persistence uses three separate grants: `fgpm.host.persistence-input/1` is deterministic,
`fgpm.host.persistence-records/1` is observational, and
`fgpm.host.persistence-conformance/1` is conformance-only. A service must request and retrieve
each classification independently.

These are architectural authority boundaries for cooperating trusted native code. JavaScript
services and workers execute with the user's operating-system authority and are not a hostile
code sandbox.

## 8. Scope

Demonstrated: strict task package validation, clean semantics, independent additive producers,
pre-mutation ambiguity failure, exact exclusion, typed activation, exact grants, explanations,
and deterministic concurrency across the provided matrix.

Limited/not claimed: registry/distribution service, general algebra framework, arbitrary command
channels, native-code containment, stable v2 compatibility, engine integration, or the later
second fresh-author retest.
