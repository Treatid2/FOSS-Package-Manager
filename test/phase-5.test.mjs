// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ArtifactStore } from "../src/core/artifacts.mjs";
import { buildProfile } from "../src/core/build.mjs";
import { resolveRuntimePlan, startRuntime } from "../src/core/runtime.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const greenProfile = path.join(repository, "profiles", "green-head.json");
const baseProfile = path.join(repository, "profiles", "base.json");
const transformV2Profile = path.join(repository, "profiles", "green-head-transform-v2.json");
const failureProfiles = path.join(repository, "fixtures", "failures", "profiles");

async function temporaryDirectory(label) {
  return mkdtemp(path.join(os.tmpdir(), `fgpm-phase5-${label}-`));
}

function storeFor(directory) {
  return new ArtifactStore(directory, { protocol: "fgpm.artifact-transaction/2", facts: {}, widenedDimensions: [] });
}

async function jsonFile(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function buildShared(profile, root, name) {
  return buildProfile(profile, path.join(root, name), { storeDirectory: path.join(root, ".fgpm-store") });
}

test("save, full shutdown, and fresh activation preserve world identity, transform, and render", async (context) => {
  const root = await temporaryDirectory("reload");
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = await buildShared(greenProfile, root, "source");
  const sourceSvg = path.join(root, "source.svg");
  const first = await startRuntime(source, { snapshotPath: sourceSvg });
  await first.tick();
  await first.tick();
  const expectedTransform = first.capability("runtime.transforms.read").snapshot();
  const expectedInstances = first.capability("runtime.instances.read").list().map((entry) => entry.instanceId);
  const committed = await first.capability("runtime.persistence.world").save("save:phase-5/reload");
  assert.equal(committed.manifest.schema, "fgpm.world-save/1");
  assert.equal(committed.manifest.checkpoint.tick, 2);
  await first.shutdown();
  assert.equal(first.active.length, 0);

  const restoredBuild = await buildShared(greenProfile, root, "restored");
  const restoredSvg = path.join(root, "restored.svg");
  const restored = await startRuntime(restoredBuild, {
    loadSaveId: "save:phase-5/reload",
    snapshotPath: restoredSvg,
  });
  assert.deepEqual(restored.capability("runtime.transforms.read").snapshot(), expectedTransform);
  assert.deepEqual(restored.capability("runtime.instances.read").list().map((entry) => entry.instanceId),
    expectedInstances);
  assert.equal(await readFile(restoredSvg, "utf8"), await readFile(sourceSvg, "utf8"));
  const session = await jsonFile(path.join(restoredBuild.outputDirectory, "runtime-session.json"));
  assert.equal(session.state, "restored");
  assert.equal(session.committed, true);
  assert.equal(session.saveRoot, committed.root.hash);
  await restored.shutdown();
});

test("a save survives termination of the producing Node process", async (context) => {
  const root = await temporaryDirectory("process-restart");
  context.after(() => rm(root, { recursive: true, force: true }));
  const cli = path.join(repository, "src", "cli.mjs");
  const sourceSvg = path.join(root, "source.svg");
  const restoredSvg = path.join(root, "restored.svg");
  const first = spawnSync(process.execPath, [cli, "run", greenProfile, "--out", path.join(root, "source"),
    "--snapshot", sourceSvg, "--ticks", "2", "--save", "save:phase-5/process-restart"], {
    cwd: repository, encoding: "utf8", windowsHide: true,
  });
  assert.equal(first.status, 0, first.stderr);
  const second = spawnSync(process.execPath, [cli, "run", greenProfile, "--out", path.join(root, "restored"),
    "--snapshot", restoredSvg, "--ticks", "0", "--load", "save:phase-5/process-restart"], {
    cwd: repository, encoding: "utf8", windowsHide: true,
  });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(await readFile(restoredSvg, "utf8"), await readFile(sourceSvg, "utf8"));
  assert.equal((await jsonFile(path.join(root, "restored", "runtime-session.json"))).state, "restored");
});

test("explicit destruction persists while materialisation release does not", async (context) => {
  const root = await temporaryDirectory("destruction");
  context.after(() => rm(root, { recursive: true, force: true }));
  const built = await buildShared(baseProfile, root, "source");
  const host = await startRuntime(built, { snapshotPath: path.join(root, "source.svg") });
  const transforms = host.capability("runtime.transforms.write");
  const instances = host.capability("runtime.instances.read");
  assert.equal(transforms.releaseMaterialisation("world:demo/character-1"), true);
  assert.equal(instances.exists("world:demo/character-1"), true);
  await host.capability("runtime.persistence.world").save("save:phase-5/released");
  host.capability("runtime.instances.destroy").destroy("world:demo/field-1");
  await host.capability("runtime.persistence.world").save("save:phase-5/destroyed");
  await host.shutdown();

  const releasedBuild = await buildShared(baseProfile, root, "released");
  const released = await startRuntime(releasedBuild, { loadSaveId: "save:phase-5/released",
    snapshotPath: path.join(root, "released.svg") });
  assert.equal(released.capability("runtime.instances.read").exists("world:demo/character-1"), true);
  await released.shutdown();

  const destroyedBuild = await buildShared(baseProfile, root, "destroyed");
  const destroyed = await startRuntime(destroyedBuild, { loadSaveId: "save:phase-5/destroyed",
    snapshotPath: path.join(root, "destroyed.svg") });
  assert.equal(destroyed.capability("runtime.instances.read").exists("world:demo/field-1"), false);
  assert.equal(destroyed.capability("runtime.instances.read").exists("world:demo/character-1"), true);
  await destroyed.shutdown();
});

test("interrupted save leaves no committed reference and preserves the previous save", async (context) => {
  const root = await temporaryDirectory("interrupted");
  context.after(() => rm(root, { recursive: true, force: true }));
  const built = await buildShared(baseProfile, root, "valid");
  const valid = await startRuntime(built, { snapshotPath: path.join(root, "valid.svg") });
  await valid.capability("runtime.persistence.world").save("save:phase-5/previous");
  await valid.shutdown();

  const interruptedBuild = await buildShared(baseProfile, root, "interrupted");
  const interrupted = await startRuntime(interruptedBuild, {
    snapshotPath: path.join(root, "interrupted.svg"),
    interruptSaveBeforePublication: true,
  });
  await interrupted.tick();
  let importedRoots;
  await assert.rejects(() => interrupted.capability("runtime.persistence.world").save("save:phase-5/interrupted"),
    (error) => {
      assert.equal(error.code, "FGPM_SIMULATED_INTERRUPTION");
      importedRoots = error.details.importedRoots;
      return true;
    });
  await interrupted.shutdown();
  const store = storeFor(path.join(root, ".fgpm-store"));
  await assert.rejects(() => store.readTreeReference("world-saves", "save:phase-5/interrupted"),
    (error) => error.code === "FGPM_ARTIFACT_REFERENCE_MISSING");
  assert.equal((await store.readTreeReference("world-saves", "save:phase-5/previous")).record.identity,
    "save:phase-5/previous");
  const report = await store.reachabilityReport();
  assert.ok(importedRoots.every((entry) => report.orphaned.includes(entry)));
});

test("an attributed one-step migration restores v1 transform state through the v2 provider bundle", async (context) => {
  const root = await temporaryDirectory("migration");
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = await buildShared(greenProfile, root, "v1");
  const first = await startRuntime(source, { snapshotPath: path.join(root, "v1.svg") });
  await first.tick();
  await first.tick();
  const expected = first.capability("runtime.transforms.read").snapshot();
  await first.capability("runtime.persistence.world").save("save:phase-5/migrate");
  await first.shutdown();

  const v2 = await buildShared(transformV2Profile, root, "v2");
  const restored = await startRuntime(v2, { loadSaveId: "save:phase-5/migrate",
    snapshotPath: path.join(root, "v2.svg") });
  assert.deepEqual(restored.capability("runtime.transforms.read").snapshot(), expected);
  const transformSelections = restored.plan.record.selections
    .filter((entry) => entry.capability.startsWith("runtime.transforms.") && entry.provider?.includes("authority"));
  assert.ok(transformSelections.every((entry) => entry.provider === "service:demo.transform-authority-v2/1"));
  const session = await jsonFile(path.join(v2.outputDirectory, "runtime-session.json"));
  assert.equal(session.migrations.length, 1);
  assert.equal(session.migrations[0].implementation, "service:demo.transform-migration-v1-v2/1");
  assert.match(session.migrations[0].implementationHash, /^sha256:[0-9a-f]{64}$/);
  const original = await storeFor(path.join(root, ".fgpm-store"))
    .readTreeReference("world-saves", "save:phase-5/migrate");
  assert.equal(JSON.parse(original.files["save-manifest.json"]).migrationHistory.length, 0);
  await restored.shutdown();
});

test("optional package state remains opaque while absent and restores when the package returns", async (context) => {
  const root = await temporaryDirectory("optional");
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = await buildShared(greenProfile, root, "with-marker");
  const marked = await startRuntime(source, { snapshotPath: path.join(root, "marked.svg") });
  marked.capability("runtime.marker.write").set("remember-me", 42);
  await marked.capability("runtime.persistence.world").save("save:phase-5/optional-marker");
  await marked.shutdown();

  const absentBuild = await buildShared(baseProfile, root, "without-marker");
  const absent = await startRuntime(absentBuild, { loadSaveId: "save:phase-5/optional-marker",
    snapshotPath: path.join(root, "absent.svg") });
  assert.throws(() => absent.capability("runtime.marker.read"), (error) => error.code === "FGPM_RUNTIME_CAPABILITY_INACTIVE");
  assert.deepEqual(absent.capability("runtime.persistence.world").report().retainedOpaque
    .map((entry) => entry.semanticSchema), ["fgpm.demo.character-marker-state"]);
  await absent.shutdown();

  const returnedBuild = await buildShared(greenProfile, root, "marker-returned");
  const returned = await startRuntime(returnedBuild, { loadSaveId: "save:phase-5/optional-marker",
    snapshotPath: path.join(root, "returned.svg") });
  assert.deepEqual(returned.capability("runtime.marker.read").current(), {
    instanceId: "world:demo/character-1", label: "remember-me", counter: 42, revision: 1,
  });
  assert.deepEqual(returned.capability("runtime.persistence.world").report().retainedOpaque, []);
  await returned.shutdown();
});

test("missing required state owner prevents partial runtime activation", async (context) => {
  const root = await temporaryDirectory("required-owner");
  context.after(() => rm(root, { recursive: true, force: true }));
  const requiredProfile = path.join(failureProfiles, "required-state-owner.json");
  const source = await buildShared(requiredProfile, root, "source");
  const first = await startRuntime(source, { snapshotPath: path.join(root, "source.svg") });
  await first.capability("runtime.persistence.world").save("save:phase-5/required-owner");
  await first.shutdown();

  const missing = await buildShared(baseProfile, root, "missing");
  await assert.rejects(() => startRuntime(missing, { loadSaveId: "save:phase-5/required-owner",
    snapshotPath: path.join(root, "missing.svg") }), (error) => {
    assert.equal(error.code, "FGPM_STATE_OWNER_REQUIRED_MISSING");
    assert.equal(error.details.requiredStateSchema, "fgpm.demo.required-counter-state");
    assert.equal(error.details.requiredCollectionMember, "state-owner:fixture.required-counter/1");
    assert.equal(error.details.owningCapability, "runtime.required-counter.state");
    assert.equal(error.details.lifecycle.committed, false);
    return true;
  });
  await assert.rejects(() => access(path.join(missing.outputDirectory, "runtime-lifecycle.json")));
  await assert.rejects(() => access(path.join(missing.outputDirectory, "runtime-session.json")));
});

test("migration ambiguity requires exact policy and provider bindings co-select every transform facet", async (context) => {
  const root = await temporaryDirectory("migration-policy");
  context.after(() => rm(root, { recursive: true, force: true }));
  const ambiguous = await buildShared(path.join(failureProfiles, "ambiguous-migration.json"), root, "ambiguous");
  assert.throws(() => resolveRuntimePlan(ambiguous), (error) => {
    assert.equal(error.code, "FGPM_RUNTIME_PROVIDER_AMBIGUOUS");
    assert.equal(error.details.capability, "runtime.transforms.migration");
    assert.equal(error.details.candidates.length, 2);
    return true;
  });
  const selected = await buildShared(path.join(failureProfiles, "selected-migration.json"), root, "selected");
  const plan = resolveRuntimePlan(selected).record;
  assert.equal(plan.selections.find((entry) => entry.capability === "runtime.transforms.migration").reason,
    "profile-policy");
  assert.equal(plan.providerBindings.find((entry) => entry.binding === "runtime.transforms/1").providerInstance,
    "service:demo.transform-authority-v2/1");
  assert.ok(plan.selections.filter((entry) => ["runtime.transforms.read", "runtime.transforms.write"]
    .includes(entry.capability))
    .every((entry) => entry.provider === "service:demo.transform-authority-v2/1"));
  assert.equal(plan.collections.find((entry) => entry.capability === "runtime.state.owner").members
    .find((entry) => entry.id === "state-owner:demo.transforms/1").providerInstance,
    "service:demo.transform-authority-v2/1");
});

test("the interactive renderer streams subsequent immutable SVG frames without page refresh", async (context) => {
  const root = await temporaryDirectory("live-stream");
  context.after(() => rm(root, { recursive: true, force: true }));
  const built = await buildShared(baseProfile, root, "runtime");
  const host = await startRuntime(built, { interactive: true, openBrowser: false });
  const url = host.capability("runtime.renderer.window").url();
  const page = await (await fetch(url)).text();
  assert.match(page, /new EventSource\('\/events'\)/);
  const response = await fetch(`${url}events`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = decoder.decode((await reader.read()).value);
  await host.tick();
  for (let attempt = 0; attempt < 4 && !received.includes("transform revision 1"); attempt += 1) {
    received += decoder.decode((await reader.read()).value);
  }
  assert.match(received, /transform revision 1/);
  await reader.cancel();
  await host.shutdown();
});
