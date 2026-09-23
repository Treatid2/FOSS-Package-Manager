# Curator-agent authority boundary

This map records the pre-change Workbench authority problem and the correction contract. It is deliberately generic and does not bind the manager to a project identity.

## Pre-change boundary

`control.describe` publishes operation maturity and an `initial-curator` profile, but `/api/action` checks only a broad `SAFE_OPERATIONS` set. Request fields such as `surface`, `inputMethod` and `controlId` are retained as trace attribution; none is a credential. Consequently, labelling a request as agent-originated neither selects nor constrains authority.

## Required separation

Four concepts remain independent:

1. request attribution — observational caller-supplied provenance;
2. client authority profile — a server-owned fixed operation set;
3. operation maturity — guided, expert, inspection or lifecycle metadata;
4. manager result — the authoritative semantic outcome after dispatch.

The Workbench will bind fixed local action endpoints to these server-owned profiles:

| Endpoint | Server-owned profile | Intended caller | Permission rule |
|---|---|---|---|
| `/api/action` and `/api/action/guided` | `guided-human` | ordinary visible Workbench | `guidedHuman === true` |
| `/api/action/curator` | `initial-curator` | bounded curator client | generated `initialCuratorCapabilityProfile()` |
| `/api/action/expert` | `expert-debug` | explicit expert console | every non-internal Workbench operation |
| `/api/action/internal` | `internal-lifecycle` | explicit local lifecycle client | the complete locally exposed operation set |

Changing JSON body fields cannot change the route-bound profile. An absent profile uses the ordinary guided endpoint, never expert authority. Invalid routes are not profiles.

## Enforcement order

For every action request:

1. resolve the fixed route profile;
2. validate that the operation is exposed;
3. check profile permission;
4. on denial, record an inspectable denial with server profile and caller attribution;
5. only then evaluate manager-commit, target-environment, path, expected-generation and confirmation conditions;
6. only after all checks dispatch to the public manager control plane.

The denial diagnostic must name profile, operation, capability classification and reason. It must create no manager request and move no workspace, generation, runtime or store authority.

## Executable threats

Tests must prove:

- `initial-curator -> workspace.create` is denied before manager dispatch and creates no workspace;
- claiming `profile: expert-debug`, `surface: expert` or another attribution string in JSON does not promote a curator request;
- a permitted curator inspection succeeds through the same fixed profile boundary;
- the explicit expert endpoint can perform its intended expert operation;
- the default endpoint does not silently grant expert authority.
