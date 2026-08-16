// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildProfile, prepareProfile } from "../src/core/build.mjs";
import { ArtifactStore } from "../src/core/artifacts.mjs";
import { discoverPackages } from "../src/core/discovery.mjs";
import { explainRuntime, resolveRuntimePlan, startRuntime } from "../src/core/runtime.mjs";
import { createService as createInstanceStoreService } from "../packages/demo.runtime-instance-store/service.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseProfile = path.join(repository, "profiles", "base.json");
const greenProfile = path.join(repository, "profiles", "green-head.json");

async function temporaryDirectory(name) {
  return mkdtemp(path.join(tmpdir(), `fpm-${name}-`));
}

async function json(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function storeFor(directory, options = {}) {
  return new ArtifactStore(directory, {
    protocol: "fpm.artifact-transaction/2",
    facts: { runtime: { node: process.version }, host: {}, target: {} },
    widenedDimensions: [],
  }, options);
}

function runBuildProcess(profile, output) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repository, "src", "cli.mjs"), "build", profile, "--out", output], {
      cwd: repository,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("the experimental architecture snapshot matches its source registry", () => {
  const execution = spawnSync(process.execPath,
    [path.join(repository, "tools", "render-architecture-snapshot.mjs"), "--check"], {
      cwd: repository,
      encoding: "utf8",
      windowsHide: true,
    });
  assert.equal(execution.status, 0, execution.stderr);
});

test("base and Green Head profiles build through the same package graph", async (context) => {
  const root = await temporaryDirectory("vertical-slice");
  context.after(() => rm(root, { recursive: true, force: true }));
  const base = await buildProfile(baseProfile, path.join(root, "base"));
  const green = await buildProfile(greenProfile, path.join(root, "green"));
  const baseScene = await json(base.artifactPath);
  const greenScene = await json(green.artifactPath);

  assert.equal(baseScene.schema, "fpm.render-scene/1");
  assert.equal(baseScene.objects.length, 3);
  assert.equal(base.lockfile.schema, "fpm.lock/3");
  assert.equal(base.lockfile.artifact.kind, "tree");
  assert.equal(base.lockfile.artifact.entry, "scene.json");
  const bundleIndex = await json(path.join(path.dirname(base.artifactPath), "asset-index.json"));
  assert.equal(bundleIndex.schema, "fpm.render-bundle-index/1");
  assert.equal(bundleIndex.objects.length, 3);
  assert.ok(base.lockfile.packages.every((entry) => entry.license === "Apache-2.0"));
  assert.deepEqual(baseScene.objects.find((entry) => entry.part === "head").colour, [217, 146, 91]);
  assert.deepEqual(greenScene.objects.find((entry) => entry.part === "head").colour, [72, 183, 104]);

  const baseBinding = base.lockfile.bindings.find((entry) => entry.target.endsWith("head/base-colour"));
  const greenBinding = green.lockfile.bindings.find((entry) => entry.target.endsWith("head/base-colour"));
  assert.equal(baseBinding.selected, "pkg:demo.primitives/texture/head");
  assert.equal(baseBinding.selectedPackage, "demo.primitives");
  assert.equal(baseBinding.reason, "hook-default");
  assert.equal(greenBinding.selected, "pkg:demo.green-head/texture/head-green");
  assert.equal(greenBinding.reason, "single-compatible-replacement");
  assert.equal(greenBinding.artifactRoute.kind, "one-step-adapter");
  assert.equal(greenBinding.artifactRoute.adapter, "adapter:demo.solid-colour-to-rgba8-srgb/1");
  assert.equal(greenBinding.artifactRoute.semanticRelation,
    "relation:demo.texture/base-colour-solid-to-runtime/1");

  const fieldBinding = base.lockfile.bindings.find((entry) => entry.target.endsWith("field/appearance/base-colour"));
  assert.equal(fieldBinding.artifactRoute.kind, "direct-production");
  assert.equal(fieldBinding.artifactRoute.sourceSemanticType, "texture.file.ppm-p3-srgb/1");

  const handlerPackages = new Set(green.lockfile.handlers.map((entry) => entry.package));
  assert.ok(handlerPackages.has("demo.texture-toolchain"));
  assert.ok(handlerPackages.has("demo.scene-toolchain"));
  assert.ok(handlerPackages.has("demo.solid-colour-adapter"));
  assert.ok(handlerPackages.has("demo.scene-validator"));

  assert.equal(green.lockfile.semanticRelations.length, 1);
  assert.equal(green.lockfile.validation.decision.accepted, true);
  assert.equal(green.lockfile.validation.findings[0].verdict, "pass");
  assert.ok(green.lockfile.profile.authority.some((entry) => entry.field === "artifact"
    && entry.sourceLayer === "distribution" && entry.mergeRule === "immutable"));

  const finalAction = green.lockfile.actions.find((entry) => entry.kind === "build-render-bundle");
  assert.equal(finalAction.handler, "handler:demo.scene-toolchain/1");
  assert.ok(finalAction.inputs.length > 0);
  assert.ok(finalAction.inputs.every((entry) => entry.type === "texture.runtime.rgba8-srgb/1"));
  assert.ok(finalAction.inputs.every((entry) => !entry.artifact.includes("solid-colour/source")));
  assert.equal(finalAction.outputs.length, 1);
  assert.equal(finalAction.outputs[0].kind, "tree");

  const portableAction = green.lockfile.actions.find((entry) => entry.kind === "adapt");
  assert.equal(portableAction.execution.form, "portable-wasm");
  assert.equal(portableAction.execution.boundary, "wasm-capability-imports");
  assert.deepEqual(portableAction.execution.grantedPowers,
    ["read-declared-input-bytes", "write-declared-output-bytes"]);
  assert.ok(portableAction.execution.deniedAmbientPowers.includes("network"));
  const portableRecord = await json(path.join(green.storeDirectory, "actions",
    `${portableAction.buildKey.replace("sha256:", "")}.json`));
  assert.deepEqual(portableRecord.execution, portableAction.execution);
});

test("lockfile and scene artifacts are reproducible across output directories", async (context) => {
  const root = await temporaryDirectory("reproducible");
  context.after(() => rm(root, { recursive: true, force: true }));
  const storeDirectory = path.join(root, "store");
  const first = await buildProfile(greenProfile, path.join(root, "first"), { storeDirectory });
  const second = await buildProfile(greenProfile, path.join(root, "second"), { storeDirectory });
  assert.equal(first.cache.hits, 0);
  assert.equal(first.cache.misses, first.lockfile.actions.length);
  assert.equal(second.cache.hits, second.lockfile.actions.length);
  assert.equal(second.cache.misses, 0);
  assert.deepEqual(first.lockfile, second.lockfile);
  assert.equal(await readFile(first.artifactPath, "utf8"), await readFile(second.artifactPath, "utf8"));
});

test("an interruption after tree import leaves reportable orphans and no successful action record", async (context) => {
  const root = await temporaryDirectory("interruption-recovery");
  context.after(() => rm(root, { recursive: true, force: true }));
  const storeDirectory = path.join(root, "store");
  let failure;
  await assert.rejects(() => buildProfile(greenProfile, path.join(root, "interrupted"), {
    storeDirectory,
    storeOptions: { interruptAfterImportAction: "action:profile/green-head/render-bundle" },
  }), (error) => {
    failure = error;
    assert.equal(error.code, "FPM_SIMULATED_INTERRUPTION");
    return true;
  });
  const record = path.join(storeDirectory, "actions", `${failure.details.buildKey.replace("sha256:", "")}.json`);
  await assert.rejects(() => access(record));
  const before = await storeFor(storeDirectory).reachabilityReport();
  assert.ok(before.orphaned.length >= 3);
  assert.ok(failure.details.importedRoots.every((hash) => before.orphaned.includes(hash)));

  await buildProfile(greenProfile, path.join(root, "recovered"), { storeDirectory });
  const after = await storeFor(storeDirectory).reachabilityReport();
  assert.deepEqual(after.orphaned, []);
});

test("stale build-key leases are recovered without treating them as valid outputs", async (context) => {
  const root = await temporaryDirectory("stale-lease");
  context.after(() => rm(root, { recursive: true, force: true }));
  const buildKey = "a".repeat(64);
  const leaseDirectory = path.join(root, "leases", buildKey);
  await mkdir(leaseDirectory, { recursive: true });
  await writeFile(path.join(leaseDirectory, "lease.json"), JSON.stringify({
    schema: "fpm.build-lease/1",
    buildKey: `sha256:${buildKey}`,
    action: "action:stale",
    owner: "dead-owner",
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  }), "utf8");
  const store = storeFor(root, { leaseDurationMs: 1000 });
  assert.equal(await store.tryAcquireLease(buildKey, "action:replacement"), null);
  const lease = await store.tryAcquireLease(buildKey, "action:replacement");
  assert.ok(lease?.owner);
  assert.equal((await store.readLease(buildKey)).owner, lease.owner);
  await store.releaseLease(lease);
});

test("immutable action-record publication rejects divergent roots for one build key", async (context) => {
  const root = await temporaryDirectory("nondeterministic-record");
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = storeFor(root);
  const buildKey = "b".repeat(64);
  const action = { id: "action:test/nondeterminism" };
  const rootA = [{ name: "primary", id: "artifact:test/root", kind: "blob", type: "test/1",
    fileName: "test.bin", hash: `sha256:${"1".repeat(64)}`, size: 1 }];
  const rootB = [{ ...rootA[0], hash: `sha256:${"2".repeat(64)}` }];
  await store.publishActionRecord(buildKey, action, rootA);
  await assert.rejects(() => store.publishActionRecord(buildKey, action, rootB), (error) => {
    assert.equal(error.code, "FPM_ACTION_NONDETERMINISTIC");
    return true;
  });
});

test("two manager processes converge through one concurrent-safe store", async (context) => {
  const root = await temporaryDirectory("concurrent-build");
  context.after(() => rm(root, { recursive: true, force: true }));
  const profile = path.join(repository, "fixtures", "failures", "profiles", "concurrent-build.json");
  const [first, second] = await Promise.all([
    runBuildProcess(profile, path.join(root, "first")),
    runBuildProcess(profile, path.join(root, "second")),
  ]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(await json(path.join(root, "first", "fpm.lock.json")),
    await json(path.join(root, "second", "fpm.lock.json")));
  const actions = await readdir(path.join(root, ".fpm-store", "actions"));
  const lockfile = await json(path.join(root, "first", "fpm.lock.json"));
  assert.equal(actions.filter((entry) => entry.endsWith(".json")).length, lockfile.actions.length);
  assert.deepEqual(await readdir(path.join(root, ".fpm-store", "leases")), []);
});

test("declared and manager-widened environment dimensions control action keys", async (context) => {
  const root = await temporaryDirectory("environment-keys");
  context.after(() => rm(root, { recursive: true, force: true }));
  const storeDirectory = path.join(root, "store");
  const profiles = Object.fromEntries(await Promise.all([
    "environment-light", "environment-dark", "environment-observation", "environment-widened",
  ].map(async (name) => [name, await buildProfile(path.join(repository, "profiles", `${name}.json`),
    path.join(root, name), { storeDirectory })])));
  const action = (result) => result.lockfile.actions.find((entry) => entry.id
    === "action:pkg:demo.environment-head/texture/head/source");
  assert.notEqual(action(profiles["environment-light"]).buildKey, action(profiles["environment-dark"]).buildKey);
  assert.equal(action(profiles["environment-light"]).buildKey,
    action(profiles["environment-observation"]).buildKey);
  assert.notEqual(action(profiles["environment-light"]).buildKey,
    action(profiles["environment-widened"]).buildKey);
  assert.deepEqual((await json(profiles["environment-light"].artifactPath)).objects
    .find((entry) => entry.part === "head").colour, [235, 220, 150]);
  assert.deepEqual((await json(profiles["environment-dark"].artifactPath)).objects
    .find((entry) => entry.part === "head").colour, [55, 45, 80]);
  assert.deepEqual(action(profiles["environment-widened"]).environment.declaration.widened,
    ["host.architecture", "host.platform", "target.observation"]);
});

test("conflicting validator findings coexist and policy explicitly waives or rejects them", async (context) => {
  const root = await temporaryDirectory("validator-policy");
  context.after(() => rm(root, { recursive: true, force: true }));
  const conflict = path.join(repository, "fixtures", "failures", "profiles", "validator-conflict.json");
  await assert.rejects(() => buildProfile(conflict, path.join(root, "rejected")), (error) => {
    assert.equal(error.code, "FPM_VALIDATION_REJECTED");
    assert.deepEqual(error.details.findings.map((entry) => entry.verdict).sort(), ["fail", "pass"]);
    assert.equal(error.details.decision.accepted, false);
    return true;
  });
  const waived = path.join(repository, "fixtures", "failures", "profiles", "validator-waived.json");
  const result = await buildProfile(waived, path.join(root, "accepted"));
  assert.deepEqual(result.lockfile.validation.findings.map((entry) => entry.verdict).sort(), ["fail", "pass"]);
  assert.equal(result.lockfile.validation.decision.accepted, true);
  assert.equal(result.lockfile.validation.decision.waived.length, 1);
});

test("package-root order does not change discovery order", async () => {
  const normal = await discoverPackages([
    path.join(repository, "packages"),
    path.join(repository, "fixtures", "failures", "packages"),
  ]);
  const reversed = await discoverPackages([
    path.join(repository, "fixtures", "failures", "packages"),
    path.join(repository, "packages"),
  ]);
  assert.deepEqual(
    normal.map((entry) => `${entry.id}@${entry.version}`),
    reversed.map((entry) => `${entry.id}@${entry.version}`),
  );
});

test("explicit policy selects one of two equal adapter routes", async (context) => {
  const root = await temporaryDirectory("selected-adapter");
  context.after(() => rm(root, { recursive: true, force: true }));
  const profile = path.join(repository, "fixtures", "failures", "profiles", "selected-adapter.json");
  const result = await buildProfile(profile, path.join(root, "out"), { storeDirectory: path.join(root, "store") });
  const adapted = result.lockfile.bindings.filter((entry) => entry.artifactRoute.adapter);
  assert.ok(adapted.length > 0);
  assert.ok(adapted.every((entry) => entry.artifactRoute.adapter
    === "adapter:demo.solid-colour-to-rgba8-srgb/1"));
});

test("a failed materialization rolls back its staging output and action record", async (context) => {
  const root = await temporaryDirectory("transaction-rollback");
  context.after(() => rm(root, { recursive: true, force: true }));
  const storeDirectory = path.join(root, "store");
  const profile = path.join(repository, "fixtures", "failures", "profiles", "transaction-failure.json");
  let failure;
  await assert.rejects(() => buildProfile(profile, path.join(root, "out"), { storeDirectory }), (error) => {
    failure = error;
    assert.equal(error.code, "FPM_HANDLER_MATERIALIZATION_FAILED");
    assert.match(error.details.action, /bad\.transaction-failure/);
    return true;
  });
  const actionRecord = path.join(storeDirectory, "actions", `${failure.details.buildKey.replace("sha256:", "")}.json`);
  await assert.rejects(() => access(actionRecord));
  const staging = path.join(storeDirectory, "staging");
  assert.deepEqual(await readdir(staging), []);
});

test("portable capability violations preserve evidence and publish no root", async (context) => {
  const root = await temporaryDirectory("sandbox-violation");
  context.after(() => rm(root, { recursive: true, force: true }));
  const storeDirectory = path.join(root, "store");
  const profile = path.join(repository, "fixtures", "failures", "profiles", "sandbox-violation.json");
  let failure;
  await assert.rejects(() => buildProfile(profile, path.join(root, "out"), { storeDirectory }), (error) => {
    failure = error;
    assert.equal(error.code, "FPM_SANDBOX_VIOLATION_CONFIRMED");
    assert.equal(error.details.execution.boundary, "wasm-capability-imports");
    assert.equal(error.details.evidence.allowedInputReads, 3);
    assert.equal(error.details.evidence.allowedOutputWrites, 4);
    assert.equal(error.details.evidence.deniedHostReads, 1);
    assert.equal(error.details.evidence.deniedHostWrites, 1);
    assert.equal(error.details.evidence.deniedNetworkAttempts, 1);
    assert.equal(error.details.committed, false);
    return true;
  });
  const actionRecord = path.join(storeDirectory, "actions", `${failure.details.buildKey.replace("sha256:", "")}.json`);
  await assert.rejects(() => access(actionRecord));
  await assert.rejects(() => access(path.join(root, "out", "fpm.lock.json")));
  assert.deepEqual(await readdir(path.join(storeDirectory, "staging")), []);
  assert.deepEqual((await storeFor(storeDirectory).reachabilityReport()).orphaned, []);
});

test("runtime services move an instance, extract an immutable scene, and shut down dependency-first", async (context) => {
  const root = await temporaryDirectory("runtime");
  context.after(() => rm(root, { recursive: true, force: true }));
  const result = await buildProfile(greenProfile, root);
  const snapshot = path.join(root, "scene.svg");
  const builtScene = await json(result.artifactPath);
  const builtHead = builtScene.objects.find((entry) => entry.id.endsWith("/head"));
  const host = await startRuntime(result, { snapshotPath: snapshot });
  assert.equal(host.lifecycle.state, "active");
  assert.equal((await json(path.join(root, "runtime-lifecycle.json"))).committed, true);
  await host.tick();
  await host.tick();
  const liveScene = host.capability("runtime.renderer.window").scene();
  const liveHead = liveScene.objects.find((entry) => entry.id.endsWith("/head"));
  assert.notEqual(liveHead.position[0], builtHead.position[0]);
  assert.equal(liveScene.runtime.transformRevision, 2);
  assert.equal(Object.isFrozen(liveScene), true);
  assert.equal(Object.isFrozen(liveScene.objects[0]), true);
  await assert.rejects(() => host.deactivateService("service:demo.runtime-instance-store/1"), (error) => {
    assert.equal(error.code, "FPM_RUNTIME_DEPENDENTS_ACTIVE");
    assert.ok(error.details.dependents.includes("service:demo.transform-authority/1"));
    return true;
  });
  const activationOrder = host.plan.record.activationOrder;
  const lifecycle = await host.shutdown();
  const deactivationOrder = lifecycle.events.filter((entry) => entry.event === "deactivate")
    .map((entry) => entry.service);
  assert.deepEqual(deactivationOrder, [...activationOrder].reverse());
  assert.equal(lifecycle.state, "stopped");
  const explanation = explainRuntime(lifecycle, "runtime.transforms.write");
  assert.equal(explanation.selections[0].provider, "service:demo.transform-authority/1");
  const svg = await readFile(snapshot, "utf8");
  assert.match(svg, /Resolved FOSS Package Manager demo scene/);
  assert.match(svg, /pkg:demo\.green-head\/texture\/head-green/);
  assert.match(svg, /world:demo\/character-1\/head/);
});

test("generational handles distinguish release from explicit destruction", async () => {
  const controller = createInstanceStoreService();
  const activation = await controller.activate({
    artifact: {
      schema: "fpm.render-scene/1",
      objects: [
        { id: "character/body", instance: "world:test/character", definition: "definition:character" },
        { id: "field", instance: "world:test/field", definition: "definition:field" },
      ],
    },
  });
  const read = activation.capabilities["runtime.instances.read"];
  const materialise = activation.capabilities["runtime.instances.materialize"];
  const destroy = activation.capabilities["runtime.instances.destroy"];
  const first = materialise.acquire("world:test/character", "test");
  const retainedDefinition = read.definition("world:test/character");
  materialise.release(first.id);
  assert.equal(read.exists("world:test/character"), true);
  assert.deepEqual(read.definition("world:test/character"), retainedDefinition);
  const rematerialised = materialise.acquire("world:test/character", "test-rematerialised");
  assert.equal(read.resolve(rematerialised.handle).instanceId, "world:test/character");
  assert.notEqual(rematerialised.handle.generation, first.handle.generation);
  destroy.destroy("world:test/character");
  const replacement = materialise.acquire("world:test/field", "test-reuse");
  assert.equal(replacement.handle.slot, rematerialised.handle.slot);
  assert.notEqual(replacement.handle.generation, rematerialised.handle.generation);
  assert.throws(() => read.resolve(rematerialised.handle), (error) => error.code === "FPM_RUNTIME_HANDLE_STALE");
  await controller.deactivate();
});

test("releasing the final materialisation lease retains authoritative transform state", async (context) => {
  const root = await temporaryDirectory("runtime-release-state");
  context.after(() => rm(root, { recursive: true, force: true }));
  const result = await buildProfile(baseProfile, root);
  const host = await startRuntime(result, { snapshotPath: path.join(root, "scene.svg") });
  const transforms = host.capability("runtime.transforms.write");
  const instances = host.capability("runtime.instances.read");
  transforms.submit({
    schema: "fpm.transform-command/1",
    instanceId: "world:demo/character-1",
    translation: [1.25, 0, 0],
  });
  assert.equal(transforms.releaseMaterialisation("world:demo/character-1"), true);
  assert.equal(instances.list().find((entry) => entry.instanceId === "world:demo/character-1").materialized, false);
  const handle = transforms.materialise("world:demo/character-1");
  assert.equal(instances.resolve(handle).instanceId, "world:demo/character-1");
  const retained = host.capability("runtime.transforms.read").snapshot().transforms
    .find((entry) => entry.instanceId === "world:demo/character-1");
  assert.deepEqual(retained.translation, [1.25, 0, 0]);
  await host.shutdown();
});

test("an observer cannot acquire undeclared transform-write authority", async (context) => {
  const root = await temporaryDirectory("runtime-authority");
  context.after(() => rm(root, { recursive: true, force: true }));
  const profile = path.join(repository, "fixtures", "failures", "profiles", "runtime-authority-violation.json");
  const result = await buildProfile(profile, path.join(root, "out"));
  await assert.rejects(() => startRuntime(result), (error) => {
    assert.equal(error.code, "FPM_RUNTIME_AUTHORITY_DENIED");
    assert.equal(error.details.capability, "runtime.transforms.write");
    assert.equal(error.details.lifecycle.committed, false);
    assert.ok(error.details.lifecycle.activated.includes("service:demo.transform-authority/1"));
    return true;
  });
  await assert.rejects(() => access(path.join(root, "out", "runtime-lifecycle.json")));
});

test("ambiguous exclusive runtime providers require explicit policy", async (context) => {
  const root = await temporaryDirectory("runtime-provider-policy");
  context.after(() => rm(root, { recursive: true, force: true }));
  const ambiguousProfile = path.join(repository, "fixtures", "failures", "profiles", "ambiguous-runtime-provider.json");
  const ambiguous = await buildProfile(ambiguousProfile, path.join(root, "ambiguous"));
  assert.throws(() => resolveRuntimePlan(ambiguous), (error) => {
    assert.equal(error.code, "FPM_RUNTIME_PROVIDER_AMBIGUOUS");
    assert.equal(error.details.capability, "runtime.state.owner");
    assert.equal(error.details.binding, "runtime.transforms/1");
    assert.equal(error.details.candidates.length, 2);
    return true;
  });
  const selectedProfile = path.join(repository, "fixtures", "failures", "profiles", "selected-runtime-provider.json");
  const selected = await buildProfile(selectedProfile, path.join(root, "selected"));
  const host = await startRuntime(selected, { snapshotPath: path.join(root, "selected.svg") });
  const choices = host.plan.record.selections.filter((entry) => entry.capability.startsWith("runtime.transforms.")
    && entry.provider);
  assert.ok(choices.every((entry) => entry.package === "demo.transform-authority"
    && entry.reason === "profile-policy"));
  await host.shutdown();
});

test("activation failure rolls back active dependencies and commits no lifecycle", async (context) => {
  const root = await temporaryDirectory("runtime-rollback");
  context.after(() => rm(root, { recursive: true, force: true }));
  const profile = path.join(repository, "fixtures", "failures", "profiles", "runtime-activation-failure.json");
  const result = await buildProfile(profile, path.join(root, "out"));
  await assert.rejects(() => startRuntime(result), (error) => {
    assert.equal(error.code, "FPM_RUNTIME_ACTIVATION_FAILED");
    assert.equal(error.details.lifecycle.committed, false);
    assert.ok(error.details.lifecycle.activated.includes("service:demo.simple-runtime/browser-svg/1"));
    assert.deepEqual(error.details.lifecycle.rolledBack, [...error.details.lifecycle.activated].reverse());
    return true;
  });
  await assert.rejects(() => access(path.join(root, "out", "runtime-lifecycle.json")));
});

const failures = [
  ["missing dependency", "missing-dependency.json", "FPM_DEPENDENCY_MISSING"],
  ["missing handler", "no-handler.json", "FPM_HANDLER_MISSING"],
  ["duplicate public identity", "duplicate-public.json", "FPM_PUBLIC_ID_DUPLICATE"],
  ["unresolved semantic artifact route", "incompatible-semantic.json", "FPM_ARTIFACT_ROUTE_MISSING"],
  ["ambiguous compatible replacements", "ambiguous-replacement.json", "FPM_REPLACEMENT_AMBIGUOUS"],
  ["missing adapter", "missing-adapter.json", "FPM_ARTIFACT_ROUTE_MISSING"],
  ["ambiguous adapters", "ambiguous-adapter.json", "FPM_ADAPTER_AMBIGUOUS"],
  ["cyclic dependencies", "cyclic-dependency.json", "FPM_DEPENDENCY_CYCLE"],
  ["malformed domain manifest", "malformed-domain.json", "FPM_DOMAIN_MANIFEST_MALFORMED"],
  ["handler analysis failure", "handler-failure.json", "FPM_HANDLER_ANALYSIS_FAILED"],
  ["profile authority violation", "authority-violation.json", "FPM_PROFILE_AUTHORITY_UNRESOLVED"],
];

for (const [label, profileName, expectedCode] of failures) {
  test(`diagnoses ${label}`, async () => {
    const profile = path.join(repository, "fixtures", "failures", "profiles", profileName);
    await assert.rejects(() => prepareProfile(profile), (error) => {
      assert.equal(error.code, expectedCode);
      assert.ok(error.message.length > 0);
      return true;
    });
  });
}

test("CLI failure output is structured and actionable", () => {
  const profile = path.join(repository, "fixtures", "failures", "profiles", "incompatible-semantic.json");
  const execution = spawnSync(process.execPath, [path.join(repository, "src", "cli.mjs"), "validate", profile], {
    cwd: repository,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(execution.status, 1);
  assert.match(execution.stderr, /FPM_ARTIFACT_ROUTE_MISSING/);
  assert.match(execution.stderr, /requiredSemanticType/);
  assert.match(execution.stderr, /producedTypes/);
  assert.match(execution.stderr, /pkg:demo\.character\/appearance\/head\/base-colour/);
});
