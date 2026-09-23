// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { json, requireFact } from "./public-client.mjs";

export async function qualify(client, distribution, work, identity) {
  const cases = [];
  async function check(id, action) {
    try { const evidence = await action(); cases.push({ id, status: "pass", evidence: evidence ?? null }); }
    catch (error) { cases.push({ id, status: "fail", error: { message: error.message, code: error.code ?? null } }); throw error; }
  }
  async function reject(operation, parameters, code) {
    const response = await client.request(operation, parameters);
    assert.equal(response.ok, false); assert.equal(response.diagnostic.code, code); return response;
  }
  const description = await client.ok("control.describe");
  await check("PQ-001-public-catalogue", async () => {
    for (const operation of ["runtime.session.open", "runtime.session.call", "runtime.session.close"]) assert.ok(description.operations.includes(operation));
    return description;
  });
  const materialized = path.join(work, "public-fixture");
  // Fixture creation uses the public executable, never a checkout import.
  // Handled by the runner before starting the control client.
  const profilePath = path.join(materialized, "profile.json");
  const profile = await json(profilePath);
  const testPackage = path.join(work, "authored-packages", "qualification.public-session");
  const testHost = path.join(work, "authored-packages", "qualification.public-session-host");
  await cp(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "test-session"), testPackage, { recursive: true });
  await cp(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "test-host"), testHost, { recursive: true });
  profile.packageRoots = [path.join(materialized, "packages"), path.dirname(testPackage)];
  profile.distribution.roots[0] = "qualification.public-session-host";
  profile.distribution.activation = "runtime:qualification.public-session/test";
  await writeFile(profilePath, JSON.stringify(profile, null, 2) + "\n");
  const imported = [];
  for (const entry of await readdir(path.join(materialized, "packages"), { withFileTypes: true })) {
    if (entry.isDirectory()) imported.push(await client.ok("package.import", { directory: path.join(materialized, "packages", entry.name) }));
  }
  imported.push(await client.ok("package.import", { directory: testPackage }));
  imported.push(await client.ok("package.import", { directory: testHost }));
  const publicBuild = spawnSync(path.join(distribution, "bin", "node.exe"),
    [path.join(distribution, "bin", "fgpm.mjs"), "build", profilePath, "--out", path.join(work, "selection-build")],
    { cwd: work, env: { ...process.env, PATH: "", Path: "" }, timeout: 30000, windowsHide: true, encoding: "utf8" });
  await writeFile(path.join(work, "selection-build.stdout.txt"), publicBuild.stdout ?? "");
  await writeFile(path.join(work, "selection-build.stderr.txt"), publicBuild.stderr ?? "");
  requireFact(publicBuild.status === 0, `Public selection build failed: ${publicBuild.error?.message ?? publicBuild.stderr}`);
  const selected = new Set((await json(path.join(work, "selection-build", "fgpm.lock.json"))).packages.map((entry) => entry.id));
  const created = await client.ok("workspace.create", { name: "public-session-qualification" });
  await client.ok("workspace.stage", { name: "public-session-qualification", expectedHead: created.revision.identity,
    operations: imported.filter((item) => selected.has(item.package.id)).map((item) => ({ type: "add", packageRoot: item.package.root })) });
  const candidate = await client.ok("workspace.plan", { name: "public-session-qualification", profilePath });
  requireFact(candidate.status === "ready-to-build", `Public candidate plan is blocked: ${JSON.stringify(candidate.findings)}`);
  const built = await client.ok("candidate.build", { root: candidate.identity });
  const validation = await client.ok("candidate.validate", { root: built.identity });
  const committed = await client.ok("generation.commit", { validationRoot: validation.identity });
  const generation = committed.generation.identity;
  await check("PQ-002-public-generation-build", async () => {
    const shown = await client.ok("generation.show", { root: generation });
    assert.equal(shown.manager, `${identity.manager.id}@${identity.manager.version}`); return { candidate, built, validation, committed, shown };
  });
  const pins = { generation, capability: "qualification.public-session", protocol: "qualification.public-session/1",
    provider: "service:qualification.public-session/1", methods: ["start", "inspect", "stop"] };
  await check("PQ-003-stopped-ownership-rejection", () => reject("runtime.session.open", pins, "FGPM_RUNTIME_SESSION_BINDING_MISMATCH"));
  const activation = await client.ok("generation.activate", { root: generation });
  await check("PQ-004-provider-pin-rejection", () => reject("runtime.session.open", { ...pins, provider: "wrong" }, "FGPM_RUNTIME_SESSION_PROVIDER_MISMATCH"));
  await check("PQ-005-closed-parameter-rejection", () => reject("runtime.session.open", { ...pins, unexpected: true }, "FGPM_RUNTIME_SESSION_ARGUMENT_INVALID"));
  await check("PQ-006-forbidden-method-rejection", () => reject("runtime.session.open", { ...pins, methods: ["constructor", "stop"] }, "FGPM_RUNTIME_SESSION_ARGUMENT_INVALID"));
  let opened;
  await check("PQ-007-open-exact-binding", async () => {
    opened = await client.ok("runtime.session.open", pins); assert.equal(opened.runtimeSession, activation.session); return opened;
  });
  const call = (method, args) => ({ generation, handle: opened.handle, method, arguments: args });
  await check("PQ-008-byte-transport-actual-package", async () => {
    const response = await client.ok("runtime.session.call", call("start", [{ $bytes: "AP8=" }, { public: true }]));
    assert.deepEqual(response.value, { bytes: [0, 255], input: { public: true }, calls: 1 }); return response;
  });
  await check("PQ-009-invalid-byte-before-invocation", async () => {
    const rejected = await reject("runtime.session.call", call("start", [{ $bytes: "invalid" }]), "FGPM_RUNTIME_SESSION_ARGUMENT_INVALID");
    const state = await client.ok("runtime.session.call", call("inspect", [])); assert.equal(state.value.calls, 1); return { rejected, state };
  });
  await check("PQ-010-unexposed-method-rejection", () => reject("runtime.session.call", call("constructor", []), "FGPM_RUNTIME_SESSION_METHOD_NOT_EXPOSED"));
  await check("PQ-011-rollback-precondition-preserves-handle", async () => {
    const rejected = await reject("generation.rollback", { root: generation }, "FGPM_GENERATION_ROLLBACK_TARGET_UNCHANGED");
    const state = await client.ok("runtime.session.call", call("inspect", [])); assert.equal(state.value.stopped, false); return { rejected, state };
  });
  await check("PQ-012-transport-replay-no-second-call", async () => {
    const params = call("start", [{ $bytes: "AA==" }, {}]);
    const original = await client.request("runtime.session.call", params, "public-replay");
    const replay = await client.request("runtime.session.call", params, "public-replay");
    assert.equal(original.ok, true); assert.equal(replay.replay, true); assert.deepEqual(replay.result, original.result);
    const state = await client.ok("runtime.session.call", call("inspect", [])); assert.equal(state.value.calls, 2); return { original, replay, state };
  });
  await check("PQ-013-explicit-close-revokes-handle", async () => {
    const close = await client.ok("runtime.session.close", { generation, handle: opened.handle }); assert.equal(close.closed, true);
    const rejected = await reject("runtime.session.call", call("inspect", []), "FGPM_RUNTIME_SESSION_HANDLE_UNKNOWN"); return { close, rejected };
  });
  await client.ok("runtime.session.open", pins);
  await check("PQ-014-shutdown-stops-before-service-deactivation", async () => {
    const before = await client.ok("runtime.inspect"); const shutdown = await client.ok("runtime.shutdown");
    assert.equal(shutdown.active.status, "stopped");
    assert.deepEqual(shutdown.lifecycle.events.filter((entry) => entry.event === "deactivate").map((entry) => entry.service),
      before.lifecycle.events.filter((entry) => entry.event === "activate").map((entry) => entry.service).reverse());
    return { before, shutdown };
  });
  await client.ok("generation.activate", { root: generation });
  opened = await client.ok("runtime.session.open", pins);
  await check("PQ-015-reactivation-revokes-old-handle", async () => {
    const reactivation = await client.ok("generation.activate", { root: generation });
    const rejected = await reject("runtime.session.call", call("inspect", []), "FGPM_RUNTIME_SESSION_HANDLE_UNKNOWN");
    assert.equal(reactivation.transitionClass, "same-generation-reactivation"); return { reactivation, rejected };
  });
  await client.ok("runtime.shutdown");
  return { schema: "fgpm.public-behaviour-qualification/1", status: "pass", identity, cases,
    passed: cases.length, failed: 0, original137Equivalent: false,
    boundary: "15 new public-interface cases; not the original 137 source/developer regression cases and not the exact Reference World dungeon proof" };
}
