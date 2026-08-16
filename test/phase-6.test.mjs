// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildProfile } from "../src/core/build.mjs";
import { explainRuntime, resolveRuntimePlan, startRuntime } from "../src/core/runtime.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const journalProfile = path.join(repository, "profiles", "journal.json");
const excludedProfile = path.join(repository, "profiles", "journal-excluded.json");
const baseProfile = path.join(repository, "profiles", "base.json");
const failureProfiles = path.join(repository, "fixtures", "failures", "profiles");

async function temporaryDirectory(label) {
  return mkdtemp(path.join(os.tmpdir(), `fpm-phase6-${label}-`));
}

async function jsonFile(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function buildShared(profile, root, name) {
  return buildProfile(profile, path.join(root, name), { storeDirectory: path.join(root, ".fpm-store") });
}

test("a new Journal package joins persistence through one generic collection declaration", async (context) => {
  const root = await temporaryDirectory("journal");
  context.after(() => rm(root, { recursive: true, force: true }));
  const genericSources = await Promise.all([
    readFile(path.join(repository, "src", "core", "runtime.mjs"), "utf8"),
    readFile(path.join(repository, "packages", "demo.save-coordinator", "fpm-package.json"), "utf8"),
    readFile(path.join(repository, "packages", "demo.save-coordinator", "service.mjs"), "utf8"),
  ]);
  assert.ok(genericSources.every((source) => !/character-journal|runtime\.journal/.test(source)));

  const built = await buildShared(journalProfile, root, "source");
  const host = await startRuntime(built, { snapshotPath: path.join(root, "source.svg") });
  const collection = host.capability("runtime.state.owner");
  assert.deepEqual(collection.memberOrder, [
    "state-owner:demo.instances/1",
    "state-owner:demo.character-journal/1",
    "state-owner:demo.transforms/1",
  ]);
  const journalMember = collection.members.find((entry) => entry.id === "state-owner:demo.character-journal/1");
  assert.equal(journalMember.providerInstance, "service:demo.character-journal/1");
  assert.equal(journalMember.providerBinding, "runtime.journal/1");
  assert.match(journalMember.packageContentHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(journalMember.metadataRoot, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(host.plan.record.providerBindings.find((entry) => entry.binding === "runtime.journal/1"), {
    binding: "runtime.journal/1",
    providerInstance: "service:demo.character-journal/1",
    package: "demo.character-journal",
    reason: "capability-selection",
  });

  host.capability("runtime.journal.write").record("Met the package manager.", 3);
  const committed = await host.capability("runtime.persistence.world").save("save:phase-6/journal");
  const fragment = committed.manifest.fragments.find((entry) => entry.member === journalMember.id);
  assert.equal(fragment.provider, journalMember.providerInstance);
  assert.equal(fragment.providerBinding, journalMember.providerBinding);
  assert.equal(fragment.providerImplementationHash, journalMember.packageContentHash);
  assert.equal(fragment.metadataRoot, journalMember.metadataRoot);
  await host.shutdown();

  const explanation = explainRuntime(host.lifecycle, journalMember.id);
  assert.equal(explanation.collections[0].capability, "runtime.state.owner");
  assert.ok(explanation.collections[0].members.some((entry) => entry.id === journalMember.id));

  const returnedBuild = await buildShared(journalProfile, root, "returned");
  const returned = await startRuntime(returnedBuild, { loadSaveId: "save:phase-6/journal",
    snapshotPath: path.join(root, "returned.svg") });
  assert.deepEqual(returned.capability("runtime.journal.read").current(), {
    instanceId: "world:demo/character-1",
    note: "Met the package manager.",
    visits: 3,
    revision: 1,
  });
  await returned.shutdown();
});

test("collection plans, save manifests, and sessions ignore package discovery order", async (context) => {
  const root = await temporaryDirectory("order");
  context.after(() => rm(root, { recursive: true, force: true }));
  const built = await buildProfile(journalProfile, path.join(root, "build"), {
    storeDirectory: path.join(root, "build-store"),
  });
  const reversed = {
    ...built,
    resolution: { ...built.resolution, ordered: [...built.resolution.ordered].reverse() },
  };
  assert.deepEqual(resolveRuntimePlan(reversed).record, resolveRuntimePlan(built).record);

  const firstResult = { ...built, outputDirectory: path.join(root, "first"),
    storeDirectory: path.join(root, "first-store") };
  const secondResult = { ...reversed, outputDirectory: path.join(root, "second"),
    storeDirectory: path.join(root, "second-store") };
  const first = await startRuntime(firstResult, { snapshotPath: path.join(root, "first.svg") });
  const second = await startRuntime(secondResult, { snapshotPath: path.join(root, "second.svg") });
  first.capability("runtime.journal.write").record("Order independent", 7);
  second.capability("runtime.journal.write").record("Order independent", 7);
  const firstSave = await first.capability("runtime.persistence.world").save("save:phase-6/order");
  const secondSave = await second.capability("runtime.persistence.world").save("save:phase-6/order");
  assert.deepEqual(secondSave.manifest, firstSave.manifest);
  assert.equal(secondSave.root.hash, firstSave.root.hash);
  assert.deepEqual(await jsonFile(path.join(root, "second", "runtime-session.json")),
    await jsonFile(path.join(root, "first", "runtime-session.json")));
  await first.shutdown();
  await second.shutdown();
});

test("duplicate collection identities and member dependency cycles fail with attributed diagnostics", async (context) => {
  const root = await temporaryDirectory("invalid");
  context.after(() => rm(root, { recursive: true, force: true }));
  const duplicate = await buildShared(path.join(failureProfiles, "collection-duplicate.json"), root, "duplicate");
  assert.throws(() => resolveRuntimePlan(duplicate), (error) => {
    assert.equal(error.code, "FPM_RUNTIME_COLLECTION_MEMBER_DUPLICATE");
    assert.equal(error.details.member, "state-owner:fixture.duplicate/1");
    assert.deepEqual(error.details.contributors.map((entry) => entry.package).sort(),
      ["bad.collection-duplicate-a", "bad.collection-duplicate-b"]);
    return true;
  });

  const cycle = await buildShared(path.join(failureProfiles, "collection-cycle.json"), root, "cycle");
  assert.throws(() => resolveRuntimePlan(cycle), (error) => {
    assert.equal(error.code, "FPM_RUNTIME_COLLECTION_DEPENDENCY_CYCLE");
    assert.deepEqual([...new Set(error.details.cycle)].sort(),
      ["state-owner:fixture.cycle-a/1", "state-owner:fixture.cycle-b/1"]);
    return true;
  });
});

test("explicit policy exclusion and package absence retain optional state until reintroduction", async (context) => {
  const root = await temporaryDirectory("retention");
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = await buildShared(journalProfile, root, "source");
  const first = await startRuntime(source, { snapshotPath: path.join(root, "source.svg") });
  first.capability("runtime.journal.write").record("Retain me", 11);
  await first.capability("runtime.persistence.world").save("save:phase-6/retention");
  await first.shutdown();

  const absentBuild = await buildShared(baseProfile, root, "absent");
  const absent = await startRuntime(absentBuild, { loadSaveId: "save:phase-6/retention",
    snapshotPath: path.join(root, "absent.svg") });
  assert.deepEqual(absent.capability("runtime.persistence.world").report().retainedOpaque
    .map((entry) => entry.member), ["state-owner:demo.character-journal/1"]);
  await absent.shutdown();

  const excludedBuild = await buildShared(excludedProfile, root, "excluded");
  const excluded = await startRuntime(excludedBuild, { loadSaveId: "save:phase-6/retention",
    snapshotPath: path.join(root, "excluded.svg") });
  assert.throws(() => excluded.capability("runtime.journal.read"),
    (error) => error.code === "FPM_RUNTIME_CAPABILITY_INACTIVE");
  const collection = excluded.plan.record.collections.find((entry) => entry.capability === "runtime.state.owner");
  assert.deepEqual(collection.exclusions, [{
    member: "state-owner:demo.character-journal/1",
    providerInstance: "service:demo.character-journal/1",
    package: "demo.character-journal",
    policy: "policy:demo.exclude-journal-state/1",
    reason: "profile-policy-exclusion",
  }]);
  assert.deepEqual(excluded.capability("runtime.persistence.world").report().retainedOpaque
    .map((entry) => entry.member), ["state-owner:demo.character-journal/1"]);
  assert.equal(explainRuntime(excluded.lifecycle, "state-owner:demo.character-journal/1")
    .collections[0].exclusions[0].policy, "policy:demo.exclude-journal-state/1");
  await excluded.shutdown();

  const returnedBuild = await buildShared(journalProfile, root, "returned");
  const returned = await startRuntime(returnedBuild, { loadSaveId: "save:phase-6/retention",
    snapshotPath: path.join(root, "returned.svg") });
  assert.equal(returned.capability("runtime.journal.read").current().note, "Retain me");
  assert.equal(returned.capability("runtime.journal.read").current().visits, 11);
  assert.deepEqual(returned.capability("runtime.persistence.world").report().retainedOpaque, []);
  await returned.shutdown();
});
