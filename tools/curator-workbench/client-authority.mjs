// SPDX-License-Identifier: MPL-2.0

import {
  CONTROL_OPERATION_CAPABILITIES,
  initialCuratorCapabilityProfile,
} from "../../src/core/control-capabilities.mjs";
import { GUIDED_HUMAN_OPERATION_REGISTRY } from "./guided-operation-registry.mjs";

const exposedCapabilities = CONTROL_OPERATION_CAPABILITIES
  .filter((item) => item.operation !== "control.stop");
const capabilityByOperation = new Map(exposedCapabilities.map((item) => [item.operation, item]));

const profile = (id, endpoint, rule, operations) => Object.freeze({
  schema: "fgpm.workbench-client-profile/1", id, endpoint, rule,
  operations: Object.freeze([...operations]),
});

const guidedOperations = GUIDED_HUMAN_OPERATION_REGISTRY.map((item) => item.operation);
const curatorOperations = initialCuratorCapabilityProfile().operations;
const expertOperations = exposedCapabilities
  .filter((item) => item.maturity !== "internal")
  .map((item) => item.operation);
const internalOperations = exposedCapabilities
  .filter((item) => item.maturity === "internal")
  .map((item) => item.operation);

export const WORKBENCH_CLIENT_PROFILES = Object.freeze({
  "guided-human": profile("guided-human", "/api/action/guided",
    "ordinary visible Workbench operations only", guidedOperations),
  "initial-curator": profile("initial-curator", "/api/action/curator",
    "generated agentAllowed and guided-project-supported operation set", curatorOperations),
  "expert-debug": profile("expert-debug", "/api/action/expert",
    "explicit non-internal expert console authority", expertOperations),
  "internal-lifecycle": profile("internal-lifecycle", "/api/action/internal",
    "explicit local lifecycle authority", internalOperations),
});

export const ACTION_PROFILE_BY_PATH = Object.freeze({
  "/api/action": "guided-human",
  "/api/action/guided": "guided-human",
  "/api/action/curator": "initial-curator",
  "/api/action/expert": "expert-debug",
  "/api/action/internal": "internal-lifecycle",
});

export function clientProfileForPath(pathname) {
  const id = ACTION_PROFILE_BY_PATH[pathname];
  return id ? WORKBENCH_CLIENT_PROFILES[id] : null;
}

export function authorizeClientOperation(profileId, operation) {
  const selected = WORKBENCH_CLIENT_PROFILES[profileId] ?? null;
  const capability = capabilityByOperation.get(operation) ?? null;
  if (!selected) return {
    ok: false, profile: null, capability,
    reason: "No server-owned client profile is bound to this endpoint.",
  };
  if (!capability) return {
    ok: false, profile: selected, capability: null,
    reason: "The operation is not exposed by the Workbench.",
  };
  if (!selected.operations.includes(operation)) return {
    ok: false, profile: selected, capability,
    reason: `The operation is ${capability.maturity} and is not present in the ${selected.id} profile.`,
  };
  return { ok: true, profile: selected, capability, reason: null };
}

export function workbenchClientAuthorityDescription() {
  return {
    schema: "fgpm.workbench-client-authority/1",
    defaultProfile: "guided-human",
    requestAttributionIsAuthority: false,
    profiles: WORKBENCH_CLIENT_PROFILES,
    guidedHumanRegistry: GUIDED_HUMAN_OPERATION_REGISTRY,
  };
}
