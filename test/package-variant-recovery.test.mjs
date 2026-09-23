// SPDX-License-Identifier: MPL-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { CurationManager } from "../src/core/curation.mjs";
import { hashDirectory } from "../src/core/io.mjs";
import { ManagerControlPlane } from "../src/core/control-plane.mjs";

async function fixture(context) {
  const root = await mkdtemp(path.join(process.env.FGPM_TEST_WORK_ROOT ?? os.tmpdir(), "fgpm-variant-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const manager = await new CurationManager(path.join(root, "manager")).initialize();
  async function pkg(name, body) {
    const directory = path.join(root, name); await mkdir(directory);
    await writeFile(path.join(directory, "fgpm-package.json"), JSON.stringify({ format: "fgpm.package/2",
      namespace: "258690c4-84c4-4eb4-af4f-8584ae81fc2b", name: "qualification.variant",
      version: "0.1.0", license: "Apache-2.0", dependencies: [], runtimeServices: [] }));
    await writeFile(path.join(directory, "payload.txt"), body);
    return { directory, root: `sha256:${await hashDirectory(directory)}` };
  }
  const predecessor = await pkg("predecessor", "baseline"), successor = await pkg("successor", "successor");
  await manager.importPackage(predecessor.directory, { source: "fixture:baseline" });
  return { root, manager, predecessor, successor, pkg };
}
const registration = (pkg, id, extra = {}) => ({ expectedRoot: pkg.root, registrationId: id,
  reason: "Explicit synthetic qualification", source: { commission: "owner-fixture" }, ...extra });

test("ordinary conflict rejects before publication and explicit variants preserve both roots and provenance", async (context) => {
  const { manager, predecessor, successor } = await fixture(context);
  const before = await hashDirectory(manager.directory);
  await assert.rejects(manager.importPackage(successor.directory), { code: "FGPM_PACKAGE_VERSION_CONFLICT" });
  assert.equal(await hashDirectory(manager.directory), before);
  await manager.registerVariant(successor.directory, registration(successor, "variant:1"));
  assert.deepEqual((await manager.listPackages()).map((entry) => entry.root).sort(), [predecessor.root, successor.root].sort());
  const inspected = await manager.inspectPackageRegistry();
  assert.ok(inspected.objects.every((entry) => entry.registered && entry.ambiguousIdVersion && entry.verified));
  assert.equal(inspected.audit.at(-1).operation, "variant-register");
  assert.deepEqual(inspected.audit.at(-1).source, { commission: "owner-fixture" });
  assert.equal(inspected.cleanup.supported, false);
});

test("durable variant idempotency survives restart; changed identity, head and provenance reject without movement", async (context) => {
  const { manager, successor } = await fixture(context);
  const head = (await manager.inspectPackageRegistry()).indexRoot;
  const options = registration(successor, "variant:restart", { expectedIndexRoot: head });
  await manager.registerVariant(successor.directory, options);
  const restarted = new CurationManager(manager.directory), before = await hashDirectory(manager.directory);
  const prior = await restarted.inspectPackageRegistry();
  assert.equal((await restarted.registerVariant(successor.directory, options)).status, "reused");
  assert.deepEqual(await restarted.inspectPackageRegistry(), prior);
  await assert.rejects(restarted.registerVariant(successor.directory, { ...options, reason: "changed" }), { code: "FGPM_VARIANT_IDEMPOTENCY_CONFLICT" });
  await assert.rejects(restarted.registerVariant(successor.directory, registration(successor, "variant:stale", { expectedIndexRoot: head })), { code: "FGPM_REGISTRY_HEAD_CONFLICT" });
  await assert.rejects(restarted.registerVariant(successor.directory, { ...options, expectedRoot: `sha256:${"0".repeat(64)}` }), { code: "FGPM_VARIANT_REGISTRATION_INVALID" });
  assert.equal(await hashDirectory(manager.directory), before);
});

async function legacyResidue(f) {
  // Owner-local rc.2-shaped partial fixture, never the real FGRW state.
  const donor = await new CurationManager(path.join(f.root, "donor")).initialize();
  await donor.importPackage(f.successor.directory);
  await mkdir(path.dirname(f.manager.packageTreePath(f.successor.root)), { recursive: true });
  await cp(donor.packageTreePath(f.successor.root), f.manager.packageTreePath(f.successor.root), { recursive: true });
  await cp(donor.immutablePath("package-store/records", f.successor.root), f.manager.immutablePath("package-store/records", f.successor.root));
  const packages = await f.manager.listPackages();
  await writeFile(f.manager.installedIndexPath(), JSON.stringify({ schema: "fgpm.installed-index/1", version: 1, packages }));
}

test("synthetic rc.2 conflict residue is inspectable, cannot be staged, and recovers only by explicit registration", async (context) => {
  const f = await fixture(context); await legacyResidue(f);
  const before = await hashDirectory(f.manager.directory);
  const inspection = await f.manager.inspectPackageRegistry();
  assert.equal(await hashDirectory(f.manager.directory), before);
  assert.equal(inspection.indexSchema, "fgpm.installed-index/1");
  assert.equal(inspection.objects.find((entry) => entry.root === f.successor.root).lifecycle, "unregistered-record");
  const workspace = await f.manager.createWorkspace("recovery");
  await assert.rejects(f.manager.stageOperation("recovery", { type: "add", packageRoot: f.successor.root }), { code: "FGPM_PACKAGE_ROOT_UNREGISTERED" });
  assert.equal((await f.manager.workspaceStatus("recovery")).revision.identity, workspace.revision.identity);
  const result = await f.manager.registerVariant(f.successor.directory, registration(f.successor, "variant:recover", { expectedIndexRoot: inspection.indexRoot }));
  assert.deepEqual(result.auditEvent.residueBefore, { treePresent: true, rootRecordPresent: true, registered: false });
  assert.equal(result.auditEvent.legacyObservation, true);
  assert.equal(result.auditEvent.priorIndexRoot, inspection.indexRoot);
  assert.equal((await f.manager.listPackages()).find((entry) => entry.root === f.predecessor.root).imports[0].source, "fixture:baseline");
  assert.equal((await f.manager.inspectPackageRegistry()).objects.find((entry) => entry.root === f.successor.root).lifecycle, "registered");
});

test("concurrent exact variants serialize and optional registry-head CAS commits one contender", async (context) => {
  const f = await fixture(context), third = await f.pkg("third", "third");
  const head = (await f.manager.inspectPackageRegistry()).indexRoot;
  const outcomes = await Promise.allSettled([
    f.manager.registerVariant(f.successor.directory, registration(f.successor, "concurrent:1", { expectedIndexRoot: head })),
    new CurationManager(f.manager.directory).registerVariant(third.directory, registration(third, "concurrent:2", { expectedIndexRoot: head })),
  ]);
  assert.equal(outcomes.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(outcomes.find((entry) => entry.status === "rejected").reason.code, "FGPM_REGISTRY_HEAD_CONFLICT");
  assert.equal((await f.manager.listPackages()).length, 2);
  const winner = outcomes.find((entry) => entry.status === "fulfilled").value.package.root;
  const same = winner === f.successor.root ? f.successor : third;
  await Promise.all([f.manager, new CurationManager(f.manager.directory)].map((manager) => manager.registerVariant(same.directory, registration(same, "concurrent:replay"))));
  assert.equal((await f.manager.inspectPackageRegistry()).audit.filter((entry) => entry.registrationId === "concurrent:replay").length, 1);
});

test("registration partial failure leaves classifiable unregistered content without an audit/index commit", async (context) => {
  const f = await fixture(context), before = await f.manager.installedIndex();
  // Deliberately inject a pre-existing bad immutable metadata object in this disposable fixture.
  await writeFile(f.manager.immutablePath("package-store/records", f.successor.root), JSON.stringify({ schema: "bad" }));
  await assert.rejects(f.manager.registerVariant(f.successor.directory, registration(f.successor, "partial:1")), { code: "FGPM_PACKAGE_ROOT_RECORD_CONFLICT" });
  assert.deepEqual(await f.manager.installedIndex(), before);
  const object = (await f.manager.inspectPackageRegistry()).objects.find((entry) => entry.root === f.successor.root);
  assert.equal(object.registered, false); assert.equal(object.verified, true); assert.ok(object.diagnostic);
  assert.equal(object.lifecycle, "unregistered-tree");
});

test("an aged live registry lease is protected and contention times out without stealing its writer", async (context) => {
  const f = await fixture(context);
  let signal;
  const acquired = new Promise((resolve) => { signal = resolve; });
  const held = f.manager.withLock("installed-index", async () => { signal(); await delay(120); });
  await acquired;
  const contender = new CurationManager(f.manager.directory, { lockStaleMs: 1, lockTimeoutMs: 25, lockPollMs: 5 });
  await assert.rejects(contender.inspectPackageRegistry(), { code: "FGPM_REFERENCE_LEASE_TIMEOUT" });
  await held;
  assert.equal((await contender.inspectPackageRegistry()).objects.length, 1);
});

test("exact-root candidate generations preserve immutable predecessor and restart selection without a latest-root rule", async (context) => {
  const f = await fixture(context);
  await f.manager.createWorkspace("baseline");
  await f.manager.stageOperation("baseline", { type: "add", packageRoot: f.predecessor.root });
  async function commit(name) {
    const planned = await f.manager.planCandidate(name); assert.equal(planned.status, "ready-to-build");
    const built = await f.manager.buildCandidate(planned.identity), valid = await f.manager.validateCandidate(built.identity);
    return (await f.manager.commitGeneration(valid.identity)).generation;
  }
  const baseline = await commit("baseline"), oldBytes = await readFile(f.manager.immutablePath("generations", baseline.identity));
  await f.manager.registerVariant(f.successor.directory, registration(f.successor, "candidate:1"));
  await f.manager.forkWorkspace(baseline.identity, "candidate");
  await f.manager.stageOperation("candidate", { type: "update", packageId: "qualification.variant", packageRoot: f.successor.root });
  const candidate = await commit("candidate");
  assert.deepEqual(candidate.packages, [{ id: "qualification.variant", root: f.successor.root }]);
  const restarted = new CurationManager(f.manager.directory);
  assert.deepEqual((await restarted.showGeneration(baseline.identity)).packages, [{ id: "qualification.variant", root: f.predecessor.root }]);
  assert.deepEqual(await readFile(f.manager.immutablePath("generations", baseline.identity)), oldBytes);
  assert.ok((await restarted.inspectPackageRegistry()).objects.every((entry) => entry.retainedByGenerations.length === 1));
  const plane = new ManagerControlPlane(restarted, { inspect: async () => null });
  const rejection = await plane.dispatch("package.registry.inspect", {}).then((result) => result.cleanup);
  assert.equal(rejection.destructive, false);
  await assert.rejects(plane.dispatch("package.variant-register", { directory: f.successor.directory, unexpected: true }), { code: "FGPM_CONTROL_REQUEST_INVALID" });
  await assert.rejects(plane.dispatch("package.discard", { root: f.predecessor.root }), { code: "FGPM_CONTROL_OPERATION_UNKNOWN" });
});
