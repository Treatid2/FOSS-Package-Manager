// SPDX-License-Identifier: MPL-2.0

const entry = (operation, elementId, kind, label) => Object.freeze({
  schema: "fgpm.guided-operation-view/1", operation, elementId, kind, label,
});

export const GUIDED_HUMAN_OPERATION_REGISTRY = Object.freeze([
  entry("control.describe", "effective-profile", "view", "Effective client authority"),
  entry("package.import", "import-packages", "control", "Import configured packages"),
  entry("package.list", "package-rows", "view", "Package lifecycle"),
  entry("workspace.import", "fork-workspace", "control", "Open portable workspace"),
  entry("workspace.status", "summary", "view", "Authoritative workspace overview"),
  entry("workspace.history", "workspace-history", "view", "Workspace history"),
  entry("workspace.stage", "stage-root-form", "control", "Workspace staging controls"),
  entry("workspace.plan", "plan-candidate", "control", "Plan candidate"),
  entry("candidate.explain", "why-content", "view", "Impact and Why"),
  entry("candidate.build", "build-candidate", "control", "Build candidate"),
  entry("candidate.validate", "validate-candidate", "control", "Validate candidate"),
  entry("generation.commit", "commit-generation", "control", "Commit generation"),
  entry("generation.show", "summary", "view", "Current generation overview"),
  entry("generation.retained", "retained-generations", "view", "Retained generations"),
  entry("generation.active", "summary", "view", "Active generation overview"),
  entry("generation.activate", "activate-target", "control", "Activate generation"),
  entry("generation.rollback", "rollback-baseline", "control", "Roll back generation"),
  entry("runtime.inspect", "summary", "view", "Runtime overview"),
  entry("distribution.import", "import-baseline", "control", "Import retained distribution"),
  entry("manager.reachability", "manager-reachability", "view", "Manager reachability"),
]);

export const GUIDED_HUMAN_OPERATION_SET = Object.freeze(
  GUIDED_HUMAN_OPERATION_REGISTRY.map((item) => item.operation),
);
