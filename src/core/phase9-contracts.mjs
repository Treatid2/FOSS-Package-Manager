// SPDX-License-Identifier: Apache-2.0

import { invariant } from "./errors.mjs";

const RECORDS = new Map(Object.entries({
  "fgpm.installed-index/1": ["schema", "version", "packages"],
  "fgpm.installed-index/2": ["schema", "version", "packages", "audit"],
  "fgpm.package-root/1": ["schema", "version", "identity", "id", "packageVersion", "root", "manifest"],
  "fgpm.workspace-reference/1": ["schema", "version", "name", "workspaceIdentity", "revision", "baseGeneration", "updatedAt"],
  "fgpm.workspace-revision/1": ["schema", "version", "identity", "identityInputs", "workspaceIdentity", "parent", "baseGeneration", "operations", "attribution"],
  "fgpm.candidate/1": ["schema", "version", "identity", "identityInputs", "status", "workspace", "baseGeneration", "packages", "choices", "target", "policy", "generatedRequests", "runtimePlan", "buildIntent", "selectionRoot", "findings", "impact", "indexes"],
  "fgpm.candidate-build/1": ["schema", "version", "identity", "identityInputs", "status", "candidate", "derivedPackages", "completeBuild", "authority"],
  "fgpm.candidate-validation/1": ["schema", "version", "identity", "identityInputs", "status", "candidate", "build", "completeBuild", "authority", "acceptedFindings"],
  "fgpm.derived-package/1": ["schema", "version", "identity", "identityInputs", "key", "outputPackageRoot", "provenance", "generatorExecution"],
  "fgpm.complete-build/1": ["schema", "version", "identity", "identityInputs", "candidate", "mode", "selectionRoot", "authoritativeSelectionRoot", "authorityMatch", "profileRoot", "resolutionRoot", "lockRoot", "policyRoot", "validationRoot", "actionRoot", "artifactClosureRoot", "activationArtifactRoot", "runtimePlanRoot", "closureRoot", "contractRoot", "profile", "runtimePlan", "activationArtifact", "observations"],
  "fgpm.generation/1": ["schema", "version", "identity", "identityInputs", "parent", "workspaceRevision", "candidate", "packages", "derivedPackages", "choices", "target", "policy", "runtimePlan", "stateOwners", "activationArtifact", "completeBuild", "roots", "publicContract", "manager", "impact"],
  "fgpm.distribution/1": ["schema", "version", "identity", "identityInputs", "generation", "packages", "completeBuild", "publicContract", "manager", "files"],
  "fgpm.generation-transition-checkpoint/1": ["schema", "version", "identity", "identityInputs", "fromGeneration", "toGeneration", "saveId", "root", "fragments"],
  "fgpm.generation-transition-attempt/1": ["schema", "version", "identity", "identityInputs", "fromGeneration", "toGeneration", "checkpoint", "priorSession", "status", "cause"],
  "fgpm.runtime-generation-session/1": ["schema", "version", "identity", "identityInputs", "generation", "runtimePlanRoot", "checkpoint", "preflight", "committed", "priorSession", "failedAttempt", "reason"],
  "fgpm.active-generation-reference/1": ["schema", "version", "generation", "session", "movedAt"],
}));

const REQUIRED = new Map(Object.entries({
  "fgpm.installed-index/1": ["version", "packages"],
  "fgpm.installed-index/2": ["version", "packages", "audit"],
  "fgpm.package-root/1": ["version", "identity", "id", "packageVersion", "root", "manifest"],
  "fgpm.workspace-reference/1": ["version", "name", "workspaceIdentity", "revision", "baseGeneration", "updatedAt"],
  "fgpm.workspace-revision/1": ["version", "identity", "identityInputs", "workspaceIdentity", "parent", "baseGeneration", "operations", "attribution"],
  "fgpm.candidate/1": ["version", "identity", "identityInputs", "status", "workspace", "packages", "choices", "generatedRequests", "runtimePlan", "buildIntent", "selectionRoot", "findings", "impact", "indexes"],
  "fgpm.candidate-build/1": ["version", "identity", "identityInputs", "status", "candidate", "derivedPackages", "completeBuild", "authority"],
  "fgpm.candidate-validation/1": ["version", "identity", "identityInputs", "status", "candidate", "build", "completeBuild", "authority", "acceptedFindings"],
  "fgpm.derived-package/1": ["version", "identity", "identityInputs", "key", "outputPackageRoot", "provenance", "generatorExecution"],
  "fgpm.complete-build/1": ["version", "identity", "identityInputs", "candidate", "mode", "selectionRoot", "authoritativeSelectionRoot", "authorityMatch", "resolutionRoot", "lockRoot", "policyRoot", "validationRoot", "actionRoot", "artifactClosureRoot", "activationArtifactRoot", "runtimePlanRoot", "closureRoot", "contractRoot", "profile", "runtimePlan", "activationArtifact"],
  "fgpm.generation/1": ["version", "identity", "identityInputs", "parent", "candidate", "packages", "derivedPackages", "choices", "runtimePlan", "stateOwners", "activationArtifact", "completeBuild", "roots", "publicContract", "manager", "impact"],
  "fgpm.distribution/1": ["version", "identity", "identityInputs", "generation", "packages", "completeBuild"],
  "fgpm.generation-transition-checkpoint/1": ["version", "identity", "identityInputs", "fromGeneration", "toGeneration", "saveId", "fragments"],
  "fgpm.generation-transition-attempt/1": ["version", "identity", "identityInputs", "toGeneration", "status", "cause"],
  "fgpm.runtime-generation-session/1": ["version", "identity", "identityInputs", "generation", "runtimePlanRoot", "preflight", "committed", "reason"],
  "fgpm.active-generation-reference/1": ["version", "generation", "session", "movedAt"],
}));

export function validatePhase9Record(record, context = "<phase-9-record>") {
  invariant(record && typeof record === "object" && !Array.isArray(record), "FGPM_PHASE9_RECORD_INVALID",
    "A Phase 9 durable record must be an object.", { context });
  const allowed = RECORDS.get(record.schema);
  invariant(allowed, "FGPM_PHASE9_SCHEMA_UNSUPPORTED", "A Phase 9 durable record has an unsupported schema.", {
    context, schema: record.schema,
  });
  for (const key of Object.keys(record)) {
    invariant(allowed.includes(key), "FGPM_PHASE9_UNKNOWN_FIELD",
      "A Phase 9 durable record contains an unknown field.", { context, schema: record.schema, field: key });
  }
  for (const key of REQUIRED.get(record.schema) ?? []) {
    invariant(Object.hasOwn(record, key), "FGPM_PHASE9_REQUIRED_FIELD_MISSING",
      "A Phase 9 durable record omits a required field.", { context, schema: record.schema, field: key });
  }
  invariant(record.version === 1, "FGPM_PHASE9_VERSION_UNSUPPORTED",
    "A Phase 9 durable record has an unsupported version.", { context, schema: record.schema, version: record.version });
  return record;
}

export const PHASE9_DURABLE_SCHEMAS = Object.freeze([...RECORDS.keys()].sort());
