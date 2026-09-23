<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 7 native runtime-task contract

**Applies to:** `phase-7-prototype` at
`cea2b57cfe777c8607358bea16661690343594e8`

**Status:** provisional authoring contract; no compatibility promise.

This document describes the complete supported path for one native worker task on the
checkpoint’s transform command channel. Fields not described here should not be assumed to
work.

## Selection model

A package is not active merely because its manifest is found on disk.

1. A profile `packageRoots` entry makes the manifest discoverable.
2. A distribution/user root, dependency, or package-capability requirement selects the
   package into the resolved graph.
3. The selected scheduler requires the `runtime.task` collection.
4. That collection includes every compatible, non-excluded `runtime.task` member from the
   resolved graph.
5. The manager activates the task’s service before the scheduler consumes the complete
   immutable collection.

There is no install operation or dynamic task registration at this checkpoint. Membership
is fixed for one runtime activation generation.

## Package manifest

The example’s `fgpm-package.json` is a complete minimal manifest. Its relevant core fields are:

| Field | Requirement |
| --- | --- |
| `schema` | Exactly `fgpm.package/1`. |
| `id` | Lowercase alphanumeric identity; internal dots and hyphens are accepted. |
| `version` | Three-part semantic version such as `0.1.0`. |
| `license` | Non-empty SPDX identifier or expression supplied by the author. |
| `dependencies` | The example names the checkpoint scheduler explicitly because no separate task-vocabulary package exists. |
| `runtimeServices` | One service is sufficient for one collection member. |

One service cannot publish two members of the same collection at this checkpoint. Use
separate services if a package genuinely needs two task members.

## Runtime service declaration

The task service has:

- a stable `service:` identity;
- `protocol: "fgpm.runtime-service/1"`;
- one `runtime.task` provided capability;
- no runtime capability requirements for the worker itself;
- `native-in-process` execution with `securityBoundary: "none"`;
- one package-relative JavaScript module exporting `createService()`.

The provided task member fields are:

| Field | Current meaning |
| --- | --- |
| `capability` | Exactly `runtime.task`. |
| `version` | A strict semantic version satisfying the scheduler’s `^1.0.0` request. |
| `cardinality` | Exactly `collection`. |
| `exclusive` | Exactly `false`; this duplicates the cardinality fact at this checkpoint. |
| `member` | Stable task identity. Duplicate selected identities fail. |
| `binding` | Stable provider-instance binding for this service/member. |
| `memberDependencies` | Task member identities that must be present and complete in earlier execution waves. This is not command commit order. |
| `metadata` | Scheduler-interpreted task declaration described below. |

### Metadata

| Field | Supported values and behavior |
| --- | --- |
| `phase` | Exactly `simulation`. Other phases are rejected. |
| `snapshots` | For this slice, use `['runtime.transforms.read']`. It grants only the immutable transform snapshot accessor. |
| `outputs` | One entry for `runtime.transforms.commands`. |
| `outputs[].composition` | Use `ordered` in the supplied distribution. `single-producer` is implemented only when no other producer exists. `set-union` and `commutative-reduce` are named but rejected as unimplemented. |
| `outputs[].commitAfter` | Predecessor task identities on the same channel. The transitive graph must compare every pair of ordered producers and must be acyclic. It does not delay task execution. |
| `affinity` | `any-worker` requires `workerModule`; `main-thread` requires an in-process `run` function. This kit covers `any-worker`. |
| `reentrancy` | `reentrant` or `non-reentrant` is accepted and recorded. The current host/scheduler rejects all overlapping ticks, so `reentrant` grants no concurrency yet. |
| `required` | `true` aborts the whole tick when the task fails; `false` drops the failed task and allows siblings to commit. |
| `failure` | Must be `abort-tick` or `drop-task`, but the current scheduler does not consult it. Keep it consistent with `required`: `true`/`abort-tick` or `false`/`drop-task`. |

### Ordering versus dependency

These declarations are distinct:

```text
memberDependencies  -> execution waves and collection activation edges
commitAfter         -> deterministic command-buffer commit order only
worker completion   -> observation only
```

For an `ordered` channel, a new producer cannot rely on lexical identity or discovery order.
It must be transitively before or after every other selected producer. The example declares
itself after `task:demo.motion-offset/add-x/1`, which is already after
`task:demo.motion/set-x/1`.

This exact-identity coupling is a known architectural limitation, not a recommended final
ecosystem policy.

## Service module contract

The module exports:

```js
export function createService() {
  return {
    async activate(context) {
      return {
        protocol: "fgpm.runtime-service-response/1",
        capabilities: {
          "runtime.task": Object.freeze({
            protocol: "fgpm.runtime-task/1",
            provider: "service:your.package/1",
            workerModule: new URL("./task.mjs", import.meta.url).href,
          }),
        },
      };
    },
  };
}
```

`provider` must equal the service identity attributed to the collection member.
`workerModule` must be a string URL loadable by a Node worker. The activation response must
publish a property named exactly `runtime.task`.

The manager may call `deactivate(context)` if supplied. A simple stateless task service does
not need it.

## Worker module contract

The worker module exports one asynchronous or synchronous function:

```js
export async function runTask(context) {
  // Read immutable snapshots and emit staged commands.
}
```

The context has:

| Member | Contract |
| --- | --- |
| `checkpoint` | Immutable `fgpm.runtime-tick/1` with integer `tick` and deterministic clock data. |
| `execution` | Observational thread data; do not use it to determine state. |
| `snapshot(capability)` | Returns a fresh deeply frozen clone when the capability was declared; otherwise throws `FGPM_TASK_SNAPSHOT_AUTHORITY_DENIED`. |
| `emit(channel, command)` | Stages a structured-cloneable command for a declared channel; otherwise throws `FGPM_TASK_COMMAND_AUTHORITY_DENIED`. |
| `capability(name)` | Always throws `FGPM_TASK_DIRECT_AUTHORITY_DENIED`; tasks cannot acquire mutable runtime services through this interface. |

The worker’s return value is observational at this checkpoint. It must be structured-cloneable
if supplied. It does not enter deterministic tick identity. Authoritative changes occur only
through accepted command buffers.

## Transform snapshot

`context.snapshot('runtime.transforms.read')` returns:

```json
{
  "schema": "fgpm.transform-snapshot/1",
  "revision": 0,
  "transforms": [
    {
      "instanceId": "world:demo/character-1",
      "translation": [0, 0, 0],
      "revision": 0
    }
  ]
}
```

Treat all values as immutable. Locate instances by `instanceId`, not array position.

## Transform command

The only accepted operation shape for this kit is:

```json
{
  "schema": "fgpm.transform-operation/1",
  "operation": "add-axis",
  "instanceId": "world:demo/character-1",
  "axis": "y",
  "value": 0.125
}
```

`operation` is `set-axis` or `add-axis`; `axis` is `x`, `y`, or `z`; `value` is finite; and
the target instance must exist at commit. Commands within one task buffer are applied in
emission order. Buffers are applied in the declared task commit order. Any invalid command
rejects the batch before Transform Authority swaps staged state into authority.

The task does not create the `fgpm.runtime-command-buffer/1` envelope. The scheduler creates
and hashes that envelope from emitted commands.

## Failure and diagnostics

Common author-facing codes are:

| Code | Meaning |
| --- | --- |
| `FGPM_RUNTIME_COLLECTION_MEMBER_DUPLICATE` | Another selected service declared the same task member. |
| `FGPM_RUNTIME_COLLECTION_DEPENDENCY_MISSING` | A `memberDependencies` identity is absent or excluded. |
| `FGPM_RUNTIME_COLLECTION_DEPENDENCY_CYCLE` | Execution dependencies contain a cycle. |
| `FGPM_RUNTIME_TASK_INVALID` | Runtime task value or metadata does not match the supported envelope. |
| `FGPM_TASK_AFFINITY_UNAVAILABLE` | The required worker/main-thread implementation is missing. |
| `FGPM_TASK_COMMIT_ORDER_MISSING` | `commitAfter` names a task outside the selected channel. |
| `FGPM_TASK_COMMAND_COMPOSITION_AMBIGUOUS` | Two ordered producers are not transitively comparable. |
| `FGPM_TASK_COMMIT_ORDER_CYCLE` | Command commit constraints contain a cycle. |
| `FGPM_TASK_SNAPSHOT_AUTHORITY_DENIED` | Code requested an undeclared snapshot. |
| `FGPM_TASK_COMMAND_AUTHORITY_DENIED` | Code emitted to an undeclared channel. |
| `FGPM_TASK_DIRECT_AUTHORITY_DENIED` | Code attempted direct runtime capability acquisition. |
| `FGPM_RUNTIME_TASK_TIMEOUT` | Worker exceeded the scheduler’s host-selected timeout. |
| `FGPM_RUNTIME_TRANSFORM_COMMAND_INVALID` | An emitted transform operation failed authoritative validation. |

A failed required task commits no transform mutation or deterministic tick record. A failed
optional task is represented as `dropped-optional`; successful siblings may still commit.
Worker completion and thread data belong in `runtime-tick-trace.json`, not deterministic
logic.

## Native-code trust statement

The worker context enforces the intended API for conforming code. It does not contain a
malicious module. A native task can import filesystem, process, child-process, or network
APIs available to the user. The package’s `requestedPowers` field is provenance, not a
sandbox grant. Use only trusted native task packages.

## Pre-handoff checklist

- [ ] Package, service, binding, and member identities are unique and stable.
- [ ] Package is both discoverable and selected.
- [ ] Service response provider matches its manifest service ID.
- [ ] Worker module exports `runTask` and returns structured-cloneable data.
- [ ] Snapshot and channel declarations exactly match code use.
- [ ] Every ordered producer pair is transitively comparable.
- [ ] `required` and `failure` are consistent despite the current duplicate semantics.
- [ ] Deterministic output does not depend on thread ID, worker count, delay, or completion order.
- [ ] Package licence and native trust expectations are explicit.
