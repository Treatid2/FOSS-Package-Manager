# Human, agent, headless, and expert operation authority

The sole semantic transport is the manager JSONL protocol:

```text
fgpm.control-request/1
    -> fgpm.control-event/1
    -> fgpm.control-response/1
```

Transport reach is not authority. `control.describe` publishes one `fgpm.control-operation-capability/1` record per operation and the derived `initial-curator` client profile.

The Workbench enforces that description through server-bound endpoint profiles. `/api/action` and
`/api/action/guided` are ordinary guided-human authority; `/api/action/curator` is the exact derived
initial-curator profile; `/api/action/expert` is explicit non-internal expert authority; and
`/api/action/internal` is the separate lifecycle boundary. Caller-supplied `surface`, `inputMethod`,
`controlId` and `profile` values remain observational and cannot select or promote authority.

## Ordinary guided and initially agent-allowed

The initial curator profile contains exactly the operations below. Each has an equivalent ordinary guided project control or inspection view:

| Category | Operations |
|---|---|
| control/inspection | `control.describe` |
| package | `package.import`, `package.list` |
| workspace | `workspace.import`, `workspace.status`, `workspace.history`, `workspace.stage`, `workspace.plan` |
| candidate/build | `candidate.explain`, `candidate.build`, `candidate.validate` |
| generation | `generation.commit`, `generation.show`, `generation.retained`, `generation.active`, `generation.activate`, `generation.rollback` |
| runtime inspection | `runtime.inspect` |
| retained distribution | `distribution.import` |
| reachability inspection | `manager.reachability` |

`generation.activate` and `generation.rollback` require typed exact-generation confirmation. `generation.commit` accepts the project-declared `expectedGenerationRoot` and rejects a mismatch before the workspace base moves.

## Expert/debug but not initially agent-allowed

The advanced JSON console can expose these public operations, but no ordinary guided control is claimed and the initial curator profile withholds them:

```text
workspace.create
workspace.fork
workspace.export
distribution.export
distribution.verify
```

## Persistent runtime lifecycle and not initially agent-allowed

```text
control.stop
runtime.tick
runtime.checkpoint
runtime.resume
runtime.shutdown
```

These are guided through one persistent `fgpm control` process, not through standalone lifecycle
commands or the initial curator agent profile. The Workbench expert JSON endpoint can reach the
non-internal runtime operations, but that transport reach is not counted as ordinary visible UI
support. The ordinary Authority and inspection
section visibly exposes effective profile, workspace history, manager reachability, retained
generations and the operation-to-DOM registry. Tests fail if any enforced initial-curator operation
is absent from that actual visible registry. Project configuration supplies identities and target
facts but cannot bypass the manager protocol or capability profile.
