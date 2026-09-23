<!-- SPDX-License-Identifier: MPL-2.0 -->

# Phase 9 committed runtime-plan lifecycle-edge implementation map

**Branch:** `phase-9/committed-plan-lifecycle-edges`  
**Authorized baseline:** `04e5aade414f4e2143d8abe2be86945bb8423d2b`  
**Handoff:** `FGPM-MSG-000015` / `FGPM-C2C-000012` / `FGPM-CYCLE-000010`

This bounded correction preserves the accepted Phase 9 generation and executable-closure design.
It restores lifecycle dependency facts that ordinary planning already enforces but committed-plan
hydration currently discards.

## Edge construction comparison

| Runtime fact | Ordinary `resolveRuntimePlan` | Committed `hydrateRuntimePlan` before correction | Required committed rule |
| --- | --- | --- | --- |
| Exclusive service requirement | Resolves the selected compatible provider and adds `consumer -> provider`. | Rehydrates the provider selection but adds no edge. | Match every selected service requirement to the committed exclusive selection, validate its range/binding, and add the same edge. |
| Optional unavailable requirement | Records `provider: null` and adds no edge. | Rehydrates no explicit absence semantics into the graph. | Require the attributed null selection when unavailable and add no edge. |
| Collection requirement | Selects every committed member and adds `consumer -> member service`. | Rehydrates members but adds no edge. | Validate the committed request attribution/range and add every member service edge. |
| Collection member dependency | Adds `member service -> dependency member service` when services differ. | Rehydrates member order/declarations but adds no edge. | Validate member attribution/dependencies and add the identical cross-service edge. |
| Activation requirement | Selects the provider closure; the activation is not a service graph node. | Rehydrates selections without validating the complete activation closure. | Validate each committed activation request against the selected exclusive provider or collection and use it to establish the selected service closure. |
| Lifecycle/restore safety | `RuntimeHost.activeDependents` reads the graph; shutdown traverses reverse activation order. | Empty graph permits unsafe early provider stop. | Supply the reconstructed graph before activation; retain reverse-order shutdown unchanged. |

Edges are directed from dependant to provider. They are derived only from immutable committed
service declarations and the committed selections, bindings, collections, and activation facts.
Lexical order is never a dependency inference rule.

## Shared deterministic boundary

Both ordinary planning and committed hydration use one dependency-first ordering helper. The helper
performs deterministic depth-first traversal over sorted service identities and sorted provider
edges and rejects cycles. Hydration compares its reconstructed order with the exact committed
`activationOrder`; a provider appearing after its dependant, an incomplete order, or any other
graph/order disagreement fails before a controller can activate.

## Committed validation boundary

`hydrateRuntimePlan` is the pre-activation semantic validation boundary. It validates:

- exact, unique service membership and public package/content identity;
- selected provider presence, declared capability, compatible version, and binding;
- collection request attribution, member attribution, member dependency facts, and member order;
- complete exclusive, collection, and optional-unavailable requirement evidence;
- complete graph membership and exact deterministic activation order.

Failures use committed-runtime diagnostics and include the generation root and runtime-plan root
when called from `startCommittedRuntime`, plus the relevant service, capability, binding, member,
provider, and reason.

## Lifecycle and coordinator boundaries

`startCommittedRuntime` must finish hydration and graph validation before `RuntimeHost.activate`.
`RuntimeHost.deactivateService` remains the enforcement point for
`FPM_RUNTIME_DEPENDENTS_ACTIVE`; normal shutdown remains exact reverse committed dependency order.

`GenerationRuntimeCoordinator.register` is retained solely as explicit internal/test fixture
injection. Public generation activation continues to use `generationRuntimeFactory` and the exact
closure returned by `CurationManager.generationRuntimeClosure`. A registration is rejected unless
the coordinator was constructed with the explicit internal test-factory option, so unrelated
runtime semantics cannot be attached through the public generation path.

## Verification map

- A focused real-generation fixture commits and activates the existing runtime-task-v2 closure,
  retains canonical edge evidence, rejects early provider deactivation, and proves reverse shutdown.
- Malformed committed fixtures reject a missing selected provider and a dependency-order violation
  before activation.
- A coordinator seam fixture proves registration is opt-in internal/test-only while ordinary public
  generation activation remains exact-closure-bound.
- Contract, full regression, definitive end-to-end, fresh replay/rollback, and integrated scale
  receipts remain required before the correction response is packaged.

