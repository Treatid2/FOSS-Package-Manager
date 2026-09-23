# Reference World public control-plane map

This map records the public-boundary review performed before implementing the
Reference World project. It is deliberately generic: the manager must not know
about Reference World concepts.

## Accepted public surface

The Phase 9 CLI exposes package import/list, workspace create/fork/status/stage,
candidate plan/explain/build/validate, generation commit/show, and distribution
export/import/verify as structured JSON. Those operations are sufficient for
durable curation and immutable release construction.

## Corrected gap

The original standalone `generation activate` and `generation rollback`
commands created a runtime coordinator inside a short-lived CLI process, then
left a durable reference without a live owner. Those standalone live-session
commands now reject with `FPM_CONTROL_SESSION_REQUIRED`.

The public JSONL `control` command now owns one coordinator for activation,
tick, save/checkpoint, transition, rollback, inspection, and shutdown. Normal
shutdown, stop, and EOF clear the owned active reference. A later process
reports an unexpectedly retained reference as `stale` and requires an explicit
exact-session clear before activation.

## Correction

The line-delimited JSON control process owns one
`CurationManager` and one `GenerationRuntimeCoordinator` for its lifetime and
dispatches only named, generic public operations. Requests and replies carry
stable schemas, request identities, explicit started/completed/failed states,
and structured diagnostics. Runtime tick, checkpoint, inspect, and shutdown
operate only on the coordinator-owned live session.

The boundary:

- accepts no project-specific semantics;
- accepts no activation-time semantic profile or package override;
- retains Phase 9 immutable records as authority;
- serializes requests and rejects duplicate request identities with different
  content;
- uses standard input/output only, so a caller never imports manager internals;
- leaves all project descriptors, history, releases, and explanations in the
  external project.

## Non-changes

No manager-owned GUI, project format, game/editor model, repository operation,
network service, or automatic semantic choice is introduced. Existing CLI
commands and Phase 9 records remain valid.
