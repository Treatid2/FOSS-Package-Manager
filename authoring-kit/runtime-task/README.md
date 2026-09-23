<!-- SPDX-License-Identifier: Apache-2.0 -->

# Runtime-task authoring kit

This kit is sufficient to attempt one independently authored native worker task against the
preserved `phase-7-prototype` checkpoint. It documents the contract needed by an author
without requiring access to `src/` or the existing demo package implementations.

It is provisional. It does not reserve a public namespace, promise compatibility, or turn
`fgpm.runtime-task/1` into a stable version 1 standard.

## Included files

- `contract.md` — the exact task, service, context, command, selection, and trust contract
  implemented at the checkpoint;
- `example-package/` — a complete Apache-2.0 example which adds `0.125` to the demo
  character’s Y coordinate once per world tick;
- `self-check-profile.json` — selects the example package alongside the preserved demo
  distribution;
- `external-test-brief.md` — instructions and evidence prompts for a separate fresh author.

## Requirements

- the repository checked out at `phase-7-prototype` or the local review branch derived from
  it;
- Node.js 22 or newer;
- no third-party packages.

## Run the supplied example

From the repository root:

```powershell
node src/cli.mjs validate authoring-kit/runtime-task/self-check-profile.json
node src/cli.mjs run authoring-kit/runtime-task/self-check-profile.json `
  --out build/runtime-task-kit `
  --snapshot build/runtime-task-kit.svg `
  --ticks 1
```

Expected validation summary:

```text
Valid: runtime-task-kit
```

The run should complete one deterministic tick. The runtime task collection contains
`task:example.runtime-task/add-y/1`, and the transform commit order is:

```text
task:demo.motion/set-x/1
task:demo.motion-offset/add-x/1
task:example.runtime-task/add-y/1
```

The repository test suite contains a mechanical self-check for those facts. That test is
not a fresh-author evaluation.

## Create a package from the example

1. Copy `example-package/` outside the repository or into another configured package root.
2. Choose your own package, service, binding, and task member identities. Keep them stable.
3. Update every occurrence consistently in `fgpm-package.json` and `service.mjs`.
4. Replace the calculation and emitted command in `task.mjs`.
5. Add the directory to a profile’s `packageRoots` and the package ID to `user.roots` (or to
   an authorized distribution root).
6. On the current ordered transform channel, declare a `commitAfter` relation that makes
   your producer comparable with every other selected producer.
7. Run `validate`, then a one-tick non-interactive `run`, then inspect
   `runtime-lifecycle.json`, `runtime-ticks.json`, and `runtime-tick-trace.json`.

Do not infer semantic priority from package discovery, activation, worker start, or worker
completion order. Only the declared channel composition and `commitAfter` graph control
transform buffer commit order.

## Scope and warning

The example is native JavaScript loaded into a Node worker. It has the authority of the
user running the manager and can import Node APIs. The reduced task context is an
architectural interface for cooperating packages, not hostile-code containment. Only run
native packages you trust.

The current scheduler implements one `simulation` phase, one immutable transform snapshot,
and one transform command channel. See `contract.md` for the exact limits and for declaration
fields which are accepted but not yet behaviorally independent.
