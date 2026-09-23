<!-- SPDX-License-Identifier: MPL-2.0 -->

# Phase 8 findings — public boundary correction

Date: 2026-08-21  
Branch: `phase-8/public-boundary-correction`  
Starting point: `1061fa060d8a40a33a20bd5a267d9e7e01ec7e99`

## Gate A result

**Demonstrated.** The corrected runtime-task path has strict Apache-2.0 schemas, stewarded
vocabularies, package-isolated validation, clean v2 task semantics, vocabulary-owned transform
composition, public CLI/help/conformance/explanation, and a relocatable external example.

- `participation` controls exact-member exclusion; `failurePolicy` controls invocation failure.
- The generic task vocabulary is owned by a real selected `fpm.runtime-task-contracts` package;
  required participation validates independently with both permitted failure policies.
- Corrected declarations reject duplicate `exclusive` and Phase 7's inert/duplicated `phase`,
  `reentrancy`, `required`, and `failure` fields.
- External Nudge and two other additive producers name only the transform vocabulary, stage, and
  law. None names another producer or the scheduler.
- The transform vocabulary provider derives `set-axis` before `add-axis`; stable task identity is
  the recorded byte-level order within a reducer stage, never a hidden winner.
- Worker count, exact-member delay, completion order, and discovery order do not change the
  deterministic tick, transform, scene, or SVG.
- A second base producer fails with `FPM_TASK_COMMAND_COMPOSITION_AMBIGUOUS` before mutation.
- Transform arithmetic uses exact integer micro-units with no rounding; non-quantized values and
  unsafe sums fail before authoritative mutation.

## Gate B result

**Demonstrated.** Manager core no longer reads or parses the selected scene JSON. It verifies and
records `fpm.typed-artifact-reference/1`, then offers an exact immutable-root entry byte reader.
The instance-store specialist owns domain decoding and publishes world metadata for the scene
extractor. Unsupported semantic type, root mismatch, and corrupt root all fail before committed
activation.

**Demonstrated.** The shared `context.options` object is removed from both executable paths.
Services declare closed-vocabulary `fpm.host.* /1` grants and receive values only through
`context.grant(identity)`. Plans record service, grant, status, classification, provider, and
policy. Declared denial and undeclared access both fail with attributed diagnostics.
Persistence inputs, record locations, and fault-injection controls are separate deterministic,
observational, and conformance grants.

## External-workspace evidence

**Demonstrated.** `examples/external-runtime-task-v2/` was copied to managed `D:` scratch and run
with that external directory as process CWD. Its authored profile contains only a local package
root. The installed distribution root was supplied with repeatable `--packages`; no authored file
contains an absolute manager path. Static package validation and the three-run conformance matrix
passed.

The audit ran at `df06593d291af102a7b634f05e295c82e525ee89`. Git status was clean and the
checkpoint identical before and after. The promoted report is
`evidence/phase-8/external-runtime-task-conformance.json`.

## Acceptance evidence

**Demonstrated.** `evidence/phase-8/runtime-boundary-evidence.json` retains:

- baseline, active, and exact-member-excluded runs;
- deterministic tick/transform/scene/SVG roots and observational traces;
- proof that External Nudge remains selected while exclusion produces baseline-equivalent state
  and byte-identical rendering;
- channel and task explanations;
- the pre-mutation composition failure with equal before/after roots;
- the denied host-grant activation record.

**Demonstrated.** The corrected mechanical suite reports 77 tests passed and zero failed;
`npm run contracts:check` passes. The old Phase 7 authoring kit and scheduler path remain covered.

## Remaining public gaps

**Limited.** `fpm.package/2` is deliberately a strict runtime-service slice. The demonstration's
activation contribution and general build packages remain provisional `fpm.package/1`; a wholly
v2 package/build/distribution ecosystem is not claimed.

**Limited.** External profiles no longer embed manager paths, but the caller must supply an
installed distribution package root. There is no registry, installer, version negotiation
service, or signed distribution bundle.

**Limited.** The dependency-free validator enforces the published subset and cross-field rules;
it is not a general JSON Schema engine.

**Limited.** Runtime explanation covers selected services, capabilities, collections, exact
exclusions, tasks, channels, vocabularies, stages, laws, contributors, and failure diagnostics.
It is not a general counterfactual planner.

**Not yet independently demonstrated.** The corrected kit has internal and external-workspace
mechanical evidence, but the specified second fresh-author retest was deliberately not performed
by this implementation instance. Phase 7's earlier public-sufficiency claim remains
**contradicted** by its Class C fresh-author result; Phase 8 corrects the identified mechanisms but
does not relabel usability as Class A without the new independent test.

## Embedded manager infrastructure

**Limited.** The corrected task path still composes with provisional v1 builder, renderer,
persistence, instance, clock, and Transform Authority services. Their behavior remains regression
tested, but they are implementation infrastructure rather than a complete corrected public
ecosystem.

**Assumed within this prototype.** Host-grant supply and policy are owned by the manager host.
There is no pluggable administrator policy engine or operating-system sandbox broker.

## Trust limits

**Explicitly limited.** Native JavaScript services and workers run with the user's process
authority. Typed artifacts, declared capabilities, reduced task contexts, and host grants are
cooperative architectural boundaries, not hostile-native-code containment.

## Performance and scale limits

**Limited and unbenchmarked.** The scheduler creates worker threads per invocation rather than
maintaining a durable pool. Evidence covers small task sets, three worker configurations, one
transform channel, one immutable snapshot family, two composition stages, and short runs. No
claim is made for high task counts, large buffers, long sessions, NUMA behavior, memory pressure,
or engine frame budgets.

## Publication state

**Demonstrated.** All work is local. No push, pull request, release, registry publication, or
second fresh-author retest occurred in Phase 8.
