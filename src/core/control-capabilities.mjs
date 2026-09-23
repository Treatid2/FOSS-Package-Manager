// SPDX-License-Identifier: MPL-2.0

const guided = (operation, category, options = {}) => ({
  schema: "fgpm.control-operation-capability/1", operation, category,
  maturity: "guided-project-supported", guidedHuman: true, headless: true, agentAllowed: true,
  authorityMoving: false, confirmation: "none",
  failureCommitBoundary: "Failure returns before any authoritative reference is changed.",
  ...options,
});

const expert = (operation, category, options = {}) => ({
  schema: "fgpm.control-operation-capability/1", operation, category,
  maturity: "expert-supported", guidedHuman: false, headless: true, agentAllowed: false,
  authorityMoving: false, confirmation: "none",
  failureCommitBoundary: "Expert callers receive the public diagnostic at the operation boundary.",
  ...options,
});

export const CONTROL_OPERATION_CAPABILITIES = Object.freeze([
  guided("control.describe", "inspection"),
  guided("control.stop", "runtime-lifecycle", { authorityMoving: true, agentAllowed: false }),
  guided("package.import", "project-curation", {
    authorityMoving: true,
    failureCommitBoundary: "Package content is verified before the installed identity index is extended.",
  }),
  expert("package.registry.inspect", "inspection"),
  expert("package.variant-register", "project-curation", { authorityMoving: true, confirmation: "typed-identity",
    failureCommitBoundary: "Exact-root opt-in and registry head checks precede publication. Immutable tree/record residue may remain on later failure; registration and audit commit in one index replacement." }),
  guided("package.list", "inspection"),
  expert("workspace.create", "expert/debug", { authorityMoving: true }),
  expert("workspace.fork", "expert/debug", { authorityMoving: true }),
  expert("workspace.export", "expert/debug"),
  guided("workspace.import", "project-curation", {
    authorityMoving: true,
    failureCommitBoundary: "The complete portable history is verified before a mutable workspace reference is created.",
  }),
  guided("workspace.status", "inspection"),
  guided("workspace.history", "inspection"),
  guided("workspace.stage", "project-curation", {
    authorityMoving: true,
    failureCommitBoundary: "Expected-head comparison succeeds before the workspace reference is replaced.",
  }),
  guided("workspace.plan", "project-curation", { authorityMoving: true }),
  guided("candidate.explain", "inspection"),
  guided("candidate.build", "build", {
    authorityMoving: true,
    failureCommitBoundary: "Build outputs remain immutable and unselected until validation and generation commit.",
  }),
  guided("candidate.validate", "build", { authorityMoving: true }),
  guided("generation.commit", "generation", {
    authorityMoving: true,
    failureCommitBoundary: "Expected generation and workspace head are checked before the workspace base reference moves.",
  }),
  guided("generation.show", "inspection"),
  guided("generation.retained", "inspection"),
  guided("generation.active", "inspection"),
  guided("generation.activate", "generation", {
    authorityMoving: true, confirmation: "typed-identity",
    failureCommitBoundary: "The durable active-generation reference moves only after successful activation.",
  }),
  guided("generation.rollback", "generation", {
    authorityMoving: true, confirmation: "typed-identity",
    failureCommitBoundary: "Rollback uses the same activation transaction and commits the active reference last.",
  }),
  guided("generation.clear-stale", "generation", {
    authorityMoving: true, confirmation: "typed-identity", agentAllowed: false,
    failureCommitBoundary: "The durable active reference is removed only after the exact stale session identity matches.",
  }),
  guided("runtime.inspect", "inspection"),
  expert("runtime.session.open", "runtime-lifecycle", { authorityMoving: true,
    failureCommitBoundary: "Factory executes only after live generation/provider checks; package factory effects are not transactional." }),
  expert("runtime.session.call", "runtime-lifecycle", { authorityMoving: true,
    failureCommitBoundary: "Live-generation/method/argument checks precede package invocation; package errors or serialization failure may follow package state effects." }),
  expert("runtime.session.close", "runtime-lifecycle", { authorityMoving: true,
    failureCommitBoundary: "Package stop completes before the handle is removed; failed stop retains the handle." }),
  guided("runtime.tick", "runtime-lifecycle", { authorityMoving: true, agentAllowed: false }),
  guided("runtime.checkpoint", "runtime-lifecycle", { authorityMoving: true, agentAllowed: false }),
  guided("runtime.resume", "runtime-lifecycle", {
    authorityMoving: true, confirmation: "typed-identity", agentAllowed: false,
  }),
  guided("runtime.shutdown", "runtime-lifecycle", { authorityMoving: true, agentAllowed: false }),
  expert("distribution.export", "expert/debug"),
  guided("distribution.import", "distribution", {
    authorityMoving: true,
    failureCommitBoundary: "The self-contained distribution verifies completely before its immutable records are accepted.",
  }),
  expert("distribution.verify", "inspection"),
  guided("manager.reachability", "inspection"),
]);

export function initialCuratorCapabilityProfile() {
  const operations = CONTROL_OPERATION_CAPABILITIES
    .filter((entry) => entry.agentAllowed)
    .map((entry) => entry.operation);
  return {
    schema: "fgpm.client-capability-profile/1", id: "initial-curator", version: 1,
    rule: "agentAllowed operations are a subset of ordinary guided-project-supported human operations",
    operations,
  };
}
