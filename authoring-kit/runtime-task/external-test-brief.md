<!-- SPDX-License-Identifier: Apache-2.0 -->

# Fresh-author evaluation brief

This exercise is for a contributor who did not invent the manager and has not read its
source. The architecture reviewer must not perform the exercise on their behalf.

## Material supplied

Supply only:

- this `authoring-kit/runtime-task/` directory;
- the Phase 7 CLI executable context and the command needed to run it;
- a writable external package directory;
- the preserved demo distribution needed to execute a tick.

Do not direct the contributor to `src/`, existing `packages/demo.*` implementations, or test
source. If the kit is insufficient, record that insufficiency rather than revealing an
implementation answer during the attempt.

## Task

Create a new package under a new identity which:

1. joins the fixed `runtime.task` collection as an optional native worker task;
2. reads the immutable transform snapshot;
3. emits one deterministic transform command for `world:demo/character-1`;
4. declares an unambiguous commit relation with the selected producers;
5. validates, activates, completes one tick, and appears in both the runtime plan and the
   deterministic tick record;
6. does not derive state from completion timing or thread observations.

The contributor may copy the example, but should rename every public identity and change
the calculation or axis so accidental dependence on the supplied package is visible.

## Evidence to retain

Record, in order:

- elapsed time to first valid profile;
- every question the contributor needed to ask;
- every diagnostic and the change it prompted;
- terms or identities they found ambiguous;
- whether they understood discovery versus selection, execution dependency versus commit
  order, and architectural authority versus containment;
- whether they needed manager or existing package source despite the restriction;
- final package files, runtime-plan member record, deterministic tick record, and trace;
- requested changes to the kit or language.

Do not smooth over uncertainty. A failed or partially successful attempt is useful evidence.

## Success criterion

Success means the contributor completes the task using the kit and CLI diagnostics without
implementation archaeology. It does not mean the language is stable or production-ready.
