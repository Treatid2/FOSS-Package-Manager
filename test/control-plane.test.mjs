// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { ManagerControlPlane, runControlPlane } from "../src/core/control-plane.mjs";
import { CONTROL_OPERATION_CAPABILITIES } from "../src/core/control-capabilities.mjs";
import { CurationManager, WORKSPACE_OPERATION_TYPES } from "../src/core/curation.mjs";
import { GenerationRuntimeCoordinator } from "../src/core/generation-runtime.mjs";

async function fixture(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fgpm-control-plane-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = await new CurationManager(directory).initialize();
  return new ManagerControlPlane(manager, new GenerationRuntimeCoordinator(manager));
}

async function request(control, requestId, operation, parameters = {}) {
  const emitted = [];
  const response = await control.handle({
    schema: "fgpm.control-request/1", requestId, operation, parameters,
  }, (entry) => emitted.push(entry));
  assert.equal(typeof response.authority.moved, "boolean");
  assert.equal(response.authority.projection, "combined-manager-runtime");
  assert.equal(typeof response.authority.managerMoved, "boolean");
  assert.equal(typeof response.authority.runtimeMoved, "boolean");
  const authority = response.authority;
  if (authority.before !== null && authority.after !== null) {
    assert.equal(authority.moved, authority.before !== authority.after);
  }
  if (authority.managerBefore !== null && authority.managerAfter !== null) {
    assert.equal(authority.managerMoved, authority.managerBefore !== authority.managerAfter);
  }
  if (authority.runtimeBefore !== null && authority.runtimeAfter !== null) {
    assert.equal(authority.runtimeMoved, authority.runtimeBefore !== authority.runtimeAfter);
  }
  return { response, emitted };
}

test("control plane separates original operation authority from transport replay", async (context) => {
  const control = await fixture(context);
  const first = await request(control, "request-1", "workspace.create", { name: "curation" });
  assert.deepEqual(first.emitted.map((entry) => entry.state), ["started", "completed"]);
  assert.equal(first.response.result.reference.name, "curation");
  assert.equal(first.response.authority.moved, true);

  const replay = await request(control, "request-1", "workspace.create", { name: "curation" });
  assert.equal(replay.emitted.length, 1);
  assert.equal(replay.response.replay, true);
  assert.deepEqual(replay.response.authority, first.response.authority);
  assert.deepEqual(replay.response.transportReplay, {
    replayed: true,
    dispatched: false,
    authorityMoved: false,
    originalRequestId: "request-1",
    canonicalRequestRoot: replay.response.transportReplay.canonicalRequestRoot,
  });
  assert.match(replay.response.transportReplay.canonicalRequestRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(replay.response.result.revision.identity, first.response.result.revision.identity);
  assert.equal((await control.manager.workspaceHistory("curation")).length, 1);

  const readOnly = await request(control, "request-list", "package.list");
  const readOnlyReplay = await request(control, "request-list", "package.list");
  assert.deepEqual(readOnlyReplay.response.authority, readOnly.response.authority);
  assert.equal(readOnlyReplay.response.transportReplay.dispatched, false);
  assert.equal(readOnlyReplay.response.transportReplay.authorityMoved, false);

  const conflict = await request(control, "request-1", "workspace.create", { name: "different" });
  assert.equal(conflict.response.ok, false);
  assert.equal(conflict.response.diagnostic.code, "FGPM_CONTROL_REQUEST_ID_CONFLICT");
  assert.deepEqual(conflict.emitted.map((entry) => entry.state), ["failed"]);
  assert.equal(conflict.response.authority.moved, false);
  assert.equal(conflict.response.authority.managerMoved, false);
  assert.equal(conflict.response.authority.runtimeMoved, false);
  assert.equal(Object.hasOwn(conflict.response, "transportReplay"), false);
  assert.equal((await control.manager.workspaceHistory("curation")).length, 1);
});

test("control plane returns public diagnostics and keeps inspection available", async (context) => {
  const control = await fixture(context);
  const unknown = await request(control, "request-unknown", "reference-world.secret", {});
  assert.equal(unknown.response.state, "failed");
  assert.equal(unknown.response.diagnostic.code, "FGPM_CONTROL_OPERATION_UNKNOWN");

  const inspection = await request(control, "request-inspect", "runtime.inspect");
  assert.equal(inspection.response.ok, true);
  assert.equal(inspection.response.result.live, false);
  assert.equal(inspection.response.result.active, null);
});

test("control description publishes truthful operation maturity and a guided-subset curator profile", async (context) => {
  const control = await fixture(context);
  const described = await request(control, "request-describe", "control.describe");
  assert.equal(described.response.ok, true);
  const description = described.response.result;
  assert.equal(description.operationCapabilities.length, description.operations.length);
  assert.deepEqual(description.operationCapabilities.map((entry) => entry.operation), description.operations);
  assert.deepEqual(description.operationContracts.map((entry) => entry.operation), description.operations);
  assert.match(description.transportReplay.authority, /original operation authority record is preserved/u);
  assert.match(description.transportReplay.checkpointDistinction, /checkpoint idempotent-reuse/u);
  for (const contract of description.operationContracts) {
    assert.equal(contract.parameterSchema.type, "object", contract.operation);
    assert.equal(typeof contract.resultSchema, "string", contract.operation);
    assert.equal(contract.minimalRequest.operation, contract.operation);
    assert.equal(typeof contract.sessionRequirement, "string", contract.operation);
    assert.equal(typeof contract.mutationBoundary, "string", contract.operation);
  }
  for (const capability of description.operationCapabilities) {
    assert.match(capability.category, /^(inspection|project-curation|build|generation|runtime-lifecycle|distribution|expert\/debug|internal\/lifecycle)$/);
    assert.match(capability.maturity, /^(experimental|guided-project-supported|expert-supported|internal)$/);
    assert.equal(typeof capability.guidedHuman, "boolean");
    assert.equal(typeof capability.headless, "boolean");
    assert.equal(typeof capability.agentAllowed, "boolean");
    assert.equal(typeof capability.authorityMoving, "boolean");
    assert.match(capability.confirmation, /^(none|explicit|typed-identity)$/);
    assert.ok(capability.failureCommitBoundary.length > 0);
  }
  const byOperation = new Map(description.operationCapabilities.map((entry) => [entry.operation, entry]));
  for (const operation of ["workspace.create", "workspace.fork", "workspace.export", "distribution.export",
    "distribution.verify"]) {
    assert.equal(byOperation.get(operation).guidedHuman, false, operation);
    assert.equal(byOperation.get(operation).agentAllowed, false, operation);
  }
  for (const operation of ["runtime.tick", "runtime.checkpoint", "runtime.resume", "runtime.shutdown"]) {
    assert.equal(byOperation.get(operation).guidedHuman, true, operation);
    assert.equal(byOperation.get(operation).agentAllowed, false, operation);
  }
  const guided = new Set(description.operationCapabilities
    .filter((entry) => entry.guidedHuman && entry.maturity === "guided-project-supported")
    .map((entry) => entry.operation));
  const agent = description.capabilityProfiles.initialCurator.operations;
  assert.ok(agent.length > 0);
  assert.deepEqual(agent.filter((operation) => !guided.has(operation)), []);
  const checkpoint = description.operationContracts.find((entry) => entry.operation === "runtime.checkpoint");
  assert.match(checkpoint.mutationBoundary, /first-publication/u);
  assert.match(checkpoint.mutationBoundary, /idempotent-reuse/u);
  const rollback = description.operationContracts.find((entry) => entry.operation === "generation.rollback");
  assert.ok(rollback.preconditions.includes("target is a different retained generation"));
  assert.ok(rollback.failureCodes.includes("FGPM_GENERATION_ROLLBACK_SESSION_REQUIRED"));
  assert.match(rollback.mutationBoundary, /before target construction/u);
});

test("published control catalogue covers every dispatched capability", async () => {
  const catalogue = JSON.parse(await readFile(new URL("../public/schemas/control-operation-catalogue-v1.json",
    import.meta.url), "utf8"));
  assert.equal(catalogue.schema, "fgpm.control-operation-catalogue/1");
  assert.deepEqual(catalogue.operations.map((entry) => entry.operation),
    CONTROL_OPERATION_CAPABILITIES.map((entry) => entry.operation));
  for (const operation of catalogue.operations) {
    assert.equal(catalogue.resultSchemas[operation.resultSchema].type, "object", operation.operation);
  }
});

test("published workspace operation union exactly covers accepted staging operations", async () => {
  const schema = JSON.parse(await readFile(new URL("../public/schemas/workspace-operation-v1.schema.json",
    import.meta.url), "utf8"));
  const published = schema.oneOf.map((entry) => schema.$defs[entry.$ref.split("/").at(-1)]
    .properties.type.const);
  assert.deepEqual(published, WORKSPACE_OPERATION_TYPES);
  for (const entry of schema.oneOf) {
    const operation = schema.$defs[entry.$ref.split("/").at(-1)];
    assert.equal(operation.additionalProperties, false);
    assert.ok(operation.required.includes("type"));
  }
});

test("control EOF invokes runtime cleanup exactly once", async () => {
  const input = new PassThrough();
  let output = "";
  const sink = new Writable({ write(chunk, encoding, callback) { output += chunk.toString(); callback(); } });
  let shutdowns = 0;
  const coordinator = { async shutdown() { shutdowns += 1; return null; } };
  input.end(`${JSON.stringify({ schema: "fgpm.control-request/1", requestId: "describe-eof",
    operation: "control.describe", parameters: {} })}\n`);
  await runControlPlane({}, coordinator, { input, output: sink });
  assert.equal(shutdowns, 1);
  assert.match(output, /"requestId":"describe-eof"/u);
});

test("stale active state is explicit, cannot tick, and requires exact-session recovery", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fgpm-control-stale-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = await new CurationManager(directory).initialize();
  const coordinator = new GenerationRuntimeCoordinator(manager);
  await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(coordinator.activeReferencePath()),
    { recursive: true }));
  const active = { schema: "fgpm.active-generation-reference/1", version: 1,
    generation: `sha256:${"1".repeat(64)}`, session: `sha256:${"2".repeat(64)}`,
    movedAt: "2026-01-01T00:00:00.000Z" };
  await writeFile(coordinator.activeReferencePath(), JSON.stringify(active));
  const control = new ManagerControlPlane(manager, coordinator);
  const status = await request(control, "stale-status", "generation.active");
  assert.equal(status.response.result.status, "stale");
  assert.equal(status.response.result.recoveryOperation, "generation.clear-stale");
  const tick = await request(control, "stale-tick", "runtime.tick", { count: 1 });
  assert.equal(tick.response.diagnostic.code, "FGPM_ACTIVE_RUNTIME_SESSION_UNAVAILABLE");
  const mismatch = await request(control, "stale-mismatch", "generation.clear-stale", { session: "wrong" });
  assert.equal(mismatch.response.diagnostic.code, "FGPM_STALE_SESSION_IDENTITY_MISMATCH");
  const cleared = await request(control, "stale-clear", "generation.clear-stale", { session: active.session });
  assert.equal(cleared.response.result.status, "cleared");
  assert.equal((await coordinator.activeState()).status, "stopped");
});
