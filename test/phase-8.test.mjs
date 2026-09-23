// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildProfile } from "../src/core/build.mjs";
import { ArtifactStore } from "../src/core/artifacts.mjs";
import { runRuntimeTaskConformance } from "../src/core/conformance.mjs";
import { sha256, stableJson } from "../src/core/io.mjs";
import { explainRuntime, RuntimeHost, startRuntime } from "../src/core/runtime.mjs";
import { createService as createTransformVocabulary } from "../packages/fgpm.transform-task-contracts/service.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profile = path.join(repository, "profiles", "runtime-task-v2.json");
const baselineProfile = path.join(repository, "profiles", "runtime-task-v2-baseline.json");
const excludedProfile = path.join(repository, "profiles", "runtime-task-v2-nudge-excluded.json");
const ambiguous = path.join(repository, "fixtures", "failures", "profiles", "task-v2-ambiguous.json");

async function workspace(context, label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `fgpm-phase8-${label}-`));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function characterX(host) {
  return host.capability("runtime.transforms.read").snapshot().transforms
    .find((entry) => entry.instanceId === "world:demo/character-1").translation[0];
}

test("the corrected scheduler delegates transform composition to its vocabulary steward", async (context) => {
  const root = await workspace(context, "composition");
  const built = await buildProfile(profile, path.join(root, "out"), { storeDirectory: path.join(root, "store") });
  const host = await startRuntime(built, { snapshotPath: path.join(root, "scene.svg") });
  await host.tick();
  const record = host.capability("runtime.scheduler.records").latest();
  const composition = record.composition[0];
  const transformVocabulary = JSON.parse(await readFile(path.join(repository, "public", "vocabularies",
    "transform-task-v1.json"), "utf8"));
  assert.equal(host.plan.record.artifact.schema, "fgpm.typed-artifact-reference/1");
  assert.equal(host.plan.record.artifact.semanticType, "fgpm.render-bundle/1");
  assert.equal(Object.hasOwn(host.plan.record.artifact, "camera"), false);
  assert.equal(composition.vocabulary, "fgpm.transform-task-vocabulary/1");
  assert.equal(composition.steward, "fgpm.transform-task-contracts@1.0.0");
  assert.equal(composition.rule, "fgpm.transform.staged-axis-compose/1");
  assert.deepEqual(composition.stages.map((entry) => entry.id), transformVocabulary.commitOrder);
  assert.deepEqual(composition.stages.map((entry) => [entry.id, entry.law]), [
    ["set-axis", "exclusive-per-target"],
    ["add-axis", "deterministic-sum-per-target"],
  ]);
  assert.deepEqual(composition.commitOrder, [
    "task:demo.motion-v2/set-x/1",
    "task:demo.external-nudge-v2/add-x/1",
    "task:demo.motion-offset-v2/add-x/1",
    "task:demo.wind-offset-v2/add-x/1",
  ]);
  assert.equal(characterX(host), 0.85533);
  const channelExplanation = explainRuntime(host.lifecycle, "runtime.transforms.commands");
  assert.equal(channelExplanation.channelCompositions[0].steward, "fgpm.transform-task-contracts@1.0.0");
  assert.equal(channelExplanation.channelCompositions[0].contributors.length, 4);
  assert.equal(Object.hasOwn(channelExplanation.channelCompositions[0], "stages"), false);
  assert.deepEqual(channelExplanation.channelCompositions[0].stageSet, [
    { id: "add-axis", law: "deterministic-sum-per-target" },
    { id: "set-axis", law: "exclusive-per-target" },
  ]);
  assert.ok(built.resolution.ordered.some((pkg) => pkg.id === "fgpm.runtime-task-contracts"));
  const persistenceGrants = host.plan.record.hostGrants
    .filter((entry) => entry.service === "service:demo.save-coordinator/1")
    .map((entry) => [entry.grant, entry.classification]);
  assert.deepEqual(persistenceGrants, [
    ["fgpm.host.persistence-conformance/1", "conformance"],
    ["fgpm.host.persistence-input/1", "deterministic"],
    ["fgpm.host.persistence-records/1", "observational"],
  ]);
  assert.ok(host.plan.record.hostGrants.some((entry) => entry.service === "service:demo.deterministic-scheduler-v2/1"
    && entry.grant === "fgpm.host.scheduler-conformance/1" && entry.status === "granted"
    && entry.classification === "conformance"));
  const taskCollection = host.plan.record.collections.find((entry) => entry.capability === "runtime.task");
  for (const member of taskCollection.members) {
    const encoded = JSON.stringify(member.metadata);
    assert.equal(encoded.includes("commitAfter"), false);
    assert.equal(encoded.includes("task:demo."), false);
  }
  await host.shutdown();
});

test("a typed artifact whose root contradicts the lockfile fails before activation", async (context) => {
  const root = await workspace(context, "root-mismatch");
  const built = await buildProfile(profile, path.join(root, "out"), { storeDirectory: path.join(root, "store") });
  built.artifact.root.hash = `sha256:${"0".repeat(64)}`;
  await assert.rejects(() => startRuntime(built), (error) => {
    assert.equal(error.code, "FGPM_TYPED_ARTIFACT_REFERENCE_INVALID");
    return true;
  });
});

test("an unsupported typed artifact semantic type fails before activation", async (context) => {
  const root = await workspace(context, "type-unsupported");
  const built = await buildProfile(profile, path.join(root, "out"), { storeDirectory: path.join(root, "store") });
  built.artifact.type = "fgpm.unsupported-example/1";
  built.lockfile.artifact.type = "fgpm.unsupported-example/1";
  await assert.rejects(() => startRuntime(built), (error) => {
    assert.equal(error.code, "FGPM_ACTIVATION_MISSING");
    assert.equal(error.details.artifactType, "fgpm.unsupported-example/1");
    return true;
  });
});

test("a corrupt immutable artifact root fails verification before service activation", async (context) => {
  const root = await workspace(context, "root-corrupt");
  const built = await buildProfile(profile, path.join(root, "out"), { storeDirectory: path.join(root, "store") });
  const store = new ArtifactStore(built.storeDirectory, { protocol: "fgpm.artifact-transaction/2",
    facts: {}, widenedDimensions: [] });
  await writeFile(store.objectPath(built.artifact.root.hash.slice("sha256:".length)), "corrupt\n", "utf8");
  await assert.rejects(() => startRuntime(built), (error) => {
    assert.equal(error.code, "FGPM_RUNTIME_ARTIFACT_ROOT_INVALID");
    return true;
  });
});

test("a denied declared host grant is attributed and activation remains uncommitted", async (context) => {
  const root = await workspace(context, "grant-denied");
  const built = await buildProfile(profile, path.join(root, "out"), { storeDirectory: path.join(root, "store") });
  await assert.rejects(() => startRuntime(built, {
    deniedHostGrants: ["fgpm.host.scheduler-conformance/1"],
  }), (error) => {
    assert.equal(error.code, "FGPM_HOST_GRANT_UNAVAILABLE");
    assert.equal(error.details.service, "service:demo.deterministic-scheduler-v2/1");
    assert.equal(error.details.record.status, "denied");
    assert.equal(error.details.lifecycle.committed, false);
    return true;
  });
});

test("undeclared host-grant access is rejected by the cooperative service context", () => {
  const service = { id: "service:fixture.undeclared-grant/1", owner: { id: "fixture.undeclared-grant" },
    requires: [], hostGrants: [], artifactAccess: "none", artifactStoreAccess: "none" };
  const plan = { record: { hostGrants: [] }, selectedCollections: new Map() };
  const artifact = { schema: "fgpm.typed-artifact-reference/1", id: "artifact:fixture/1",
    semanticType: "fixture.type/1", root: { kind: "blob", hash: `sha256:${"0".repeat(64)}`,
      size: 0, totalSize: null }, entry: null, provenance: {} };
  const host = new RuntimeHost(plan, artifact, { hostGrantValues: {} });
  assert.throws(() => host.contextFor(service).grant("fgpm.host.scheduler-conformance/1"), (error) => {
    assert.equal(error.code, "FGPM_HOST_GRANT_UNDECLARED");
    assert.deepEqual(error.details.declared, []);
    return true;
  });
});

test("exact optional-member exclusion keeps the package selected and returns baseline state and render", async (context) => {
  const root = await workspace(context, "exclusion-equivalence");
  const storeDirectory = path.join(root, "store");
  const baselineBuild = await buildProfile(baselineProfile, path.join(root, "baseline"), { storeDirectory });
  const excludedBuild = await buildProfile(excludedProfile, path.join(root, "excluded"), { storeDirectory });
  const baselineSvg = path.join(root, "baseline.svg");
  const excludedSvg = path.join(root, "excluded.svg");
  const baselineHost = await startRuntime(baselineBuild, { snapshotPath: baselineSvg });
  const excludedHost = await startRuntime(excludedBuild, { snapshotPath: excludedSvg });
  await baselineHost.tick();
  await excludedHost.tick();
  assert.ok(excludedBuild.resolution.ordered.some((pkg) => pkg.id === "demo.external-nudge-v2"));
  const collection = excludedHost.plan.record.collections.find((entry) => entry.capability === "runtime.task");
  assert.equal(collection.exclusions[0].member, "task:demo.external-nudge-v2/add-x/1");
  assert.equal(collection.exclusions[0].policy, "policy:demo.exclude-external-nudge-v2/1");
  const explanation = explainRuntime(excludedHost.lifecycle, "task:demo.external-nudge-v2/add-x/1");
  assert.equal(explanation.collections[0].exclusions[0].reason, "profile-policy-exclusion");
  assert.deepEqual(excludedHost.capability("runtime.transforms.read").snapshot(),
    baselineHost.capability("runtime.transforms.read").snapshot());
  assert.equal(await readFile(excludedSvg, "utf8"), await readFile(baselineSvg, "utf8"));
  await excludedHost.shutdown();
  await baselineHost.shutdown();
});

test("package discovery order reversal changes neither plan nor corrected deterministic outcome", async (context) => {
  const root = await workspace(context, "discovery-order");
  const built = await buildProfile(profile, path.join(root, "build"), { storeDirectory: path.join(root, "build-store") });
  const reversed = { ...built, resolution: { ...built.resolution, ordered: [...built.resolution.ordered].reverse() },
    outputDirectory: path.join(root, "reversed"), storeDirectory: path.join(root, "reversed-store") };
  const normal = { ...built, outputDirectory: path.join(root, "normal"), storeDirectory: path.join(root, "normal-store") };
  const normalSvg = path.join(root, "normal.svg");
  const reversedSvg = path.join(root, "reversed.svg");
  const normalHost = await startRuntime(normal, { snapshotPath: normalSvg });
  const reversedHost = await startRuntime(reversed, { snapshotPath: reversedSvg });
  assert.deepEqual(reversedHost.plan.record, normalHost.plan.record);
  await normalHost.tick();
  await reversedHost.tick();
  assert.deepEqual(reversedHost.capability("runtime.scheduler.records").latest(),
    normalHost.capability("runtime.scheduler.records").latest());
  assert.deepEqual(reversedHost.capability("runtime.transforms.read").snapshot(),
    normalHost.capability("runtime.transforms.read").snapshot());
  assert.equal(await readFile(reversedSvg, "utf8"), await readFile(normalSvg, "utf8"));
  await reversedHost.shutdown();
  await normalHost.shutdown();
});

test("two exclusive base producers fail before transform mutation", async (context) => {
  const root = await workspace(context, "ambiguous");
  const built = await buildProfile(ambiguous, path.join(root, "out"), { storeDirectory: path.join(root, "store") });
  const host = await startRuntime(built, { snapshotPath: path.join(root, "scene.svg") });
  const before = host.capability("runtime.transforms.read").snapshot();
  await assert.rejects(() => host.tick(), (error) => {
    assert.equal(error.code, "FGPM_TASK_COMMAND_COMPOSITION_AMBIGUOUS");
    assert.equal(error.details.steward, "fgpm.transform-task-contracts@1.0.0");
    assert.equal(error.details.mutationCommitted, false);
    return true;
  });
  assert.deepEqual(host.capability("runtime.transforms.read").snapshot(), before);
  await host.shutdown();
});

test("the transform vocabulary rejects non-quantized values before mutation", async () => {
  const service = createTransformVocabulary();
  const response = await service.activate();
  const vocabulary = response.capabilities["runtime.task-channel.transforms"];
  const task = "task:fixture.numeric/add-x/1";
  const plan = vocabulary.planChannel([{ id: task, metadata: { outputs: [{
    channel: "runtime.transforms.commands",
    vocabulary: "fgpm.transform-task-vocabulary/1",
    stage: "add-axis",
    law: "deterministic-sum-per-target",
  }] } }]);
  const content = {
    schema: "fgpm.runtime-command-buffer/2",
    task,
    checkpoint: { schema: "fgpm.runtime-tick/1", tick: 1 },
    channel: "runtime.transforms.commands",
    commands: [{ schema: "fgpm.transform-operation/1", operation: "add-axis",
      instanceId: "world:demo/character-1", axis: "x", value: 0.0000001 }],
  };
  const buffer = { ...content, root: `sha256:${sha256(stableJson(content))}` };
  assert.throws(() => vocabulary.compose(plan, [buffer]), (error) => {
    assert.equal(error.code, "FGPM_RUNTIME_TRANSFORM_NUMERIC_INVALID");
    assert.equal(error.details.scale, 1_000_000);
    assert.equal(error.details.mutationCommitted, false);
    return true;
  });
});

test("the public conformance report is self-identifying and audits manager core", async (context) => {
  const root = await workspace(context, "self-identifying-conformance");
  const { report } = await runRuntimeTaskConformance(profile, path.join(root, "conformance"), {
    focusMember: "task:demo.external-nudge-v2/add-x/1",
  });
  assert.equal(report.status, "pass");
  assert.match(report.environment.manager.identity, /^foss-package-manager@/);
  assert.match(report.environment.manager.cli.sha256, /^sha256:[0-9a-f]{64}$/);
  assert.match(report.environment.manager.git.commit, /^[0-9a-f]{40}$/);
  assert.equal(report.environment.node.version, process.version);
  assert.equal(report.environment.invocation.workingDirectory, process.cwd());
  assert.match(report.inputs.profile.sha256, /^sha256:[0-9a-f]{64}$/);
  assert.match(report.inputs.publicContracts.root, /^sha256:[0-9a-f]{64}$/);
  assert.match(report.inputs.installedDistribution.identity, /^sha256:[0-9a-f]{64}$/);
  assert.ok(report.inputs.installedDistribution.packages.some((pkg) => pkg.id === "fgpm.runtime-task-contracts"));
  assert.equal(report.coreBeforeAfterAudit.unchanged, true);
  assert.equal(report.claims.managerCoreUnchanged, true);
  assert.equal(report.schema, "fgpm.runtime-task-conformance-report/2");
  assert.equal(report.runs[0].outputTransformRoot, report.runs[1].outputTransformRoot);
  assert.equal(Object.hasOwn(report.runs[0], "transformRoot"), false);
});
