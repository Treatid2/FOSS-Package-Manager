# Reference World Workbench continuity correction map

This map precedes implementation of the bounded `FGPM-MSG-000021` correction.

## Preserved authority

- manager baseline: `c76cbc0960cb7e1f37c69942f99d9360320ae3d9`;
- Reference World baseline: `51f10edbef3c644f4e6ae731139373e3d7544e8d`;
- immutable G0/G1 generation and distribution roots remain fixtures;
- the public JSONL control schemas and curation operations remain authoritative;
- no Reference World package identity or presentation rule enters manager core.

## Ownership correction

The canonical generic Workbench moves to `tools/curator-workbench/` in this repository. It contains:

- a public JSONL control client;
- strict project-descriptor loading and relative-path confinement;
- deterministic public-operation journal replay;
- the local HTTP projection and guided browser UI;
- a headless replay entry point using the same journal and control client;
- generic fixtures and tests, including a second compatible project.

An external project supplies only a closed descriptor, portable journal, fixture labels/configuration, retained releases, tests, evidence, and optionally a thin launcher.

## Portable-state mechanism

The correction uses a project-owned, versioned deterministic journal. Each journal step names one public control operation and declarative parameters. Relative path parameters are resolved inside the project root before dispatch. Generic `workspace.export` and `workspace.import` operations preserve and verify immutable workspace identity/history, which a fresh random fork cannot reproduce. Replay never edits manager records directly.

Opening or verifying a project is read-only. Explicit initialisation replays the journal into an empty manager store, then verifies the declared workspace, release roots, and current generation.

`manager.json.buildIdentity` names the reviewed build-semantic identity used in
lockfiles. This correction changes manager control and Workbench facilities,
not package resolution, handlers, build output, or runtime semantics, so it
retains the accepted M2 build identity. A future build-semantic change must
review and change that identity explicitly.

## Guided surface

Ordinary controls cover project initialisation, distribution and package import, workspace creation/fork, known-versus-selected lifecycle, stage add/remove/update/abandon, planning, impact and Why, non-preselected choices, generated-package acceptance/result, build, validation, commit, activation, rollback, and reactivation. The JSON console remains an expert/debug surface.

Every consequential result is rendered from manager responses. Project fixture data labels the flow and supplies project-owned identities; generic code does not contain Reference World identities.

The native accessibility paths use semantic controls, a polite announcement
region, status focus after asynchronous completion, an alert role after failed
operations, `prefers-reduced-motion`, and `forced-colors`. Deterministic audit
routes are also available when a browser-control backend cannot toggle operating
system preferences: `?contrast=forced`, `?motion=reduced`, and `?scale=200`.
They change presentation only and never change control requests or durable state.

## Verification

- manager-owned fixture opens with a broken runtime;
- a second compatible fixture opens through the same Workbench;
- empty-store journal replay reconstructs a declared current workspace;
- headless and browser routes emit the same operation trace;
- keyboard, live-region, focus, reflow, contrast, forced-colour, and reduced-motion checks are retained;
- manager and external-project full regressions remain mandatory.
