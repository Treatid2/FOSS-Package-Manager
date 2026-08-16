// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildProfile } from "../src/core/build.mjs";
import { explainRuntime, resolveRuntimePlan, startRuntime } from "../src/core/runtime.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseProfile = path.join(repository, "profiles", "base.json");
const mainThreadProfile = path.join(repository, "profiles", "main-thread-task.json");
const excludedProfile = path.join(repository, "profiles", "task-offset-excluded.json");
const failureProfiles = path.join(repository, "fixtures", "failures", "profiles");
const setTask = "task:demo.motion/set-x/1";
const addTask = "task:demo.motion-offset/add-x/1";

async function temporaryDirectory(label) {
  return mkdtemp(path.join(os.tmpdir(), `fpm-phase7-${label}-`));
}

async function jsonFile(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function buildShared(profile, root, name) {
  return buildProfile(profile, path.join(root, name), { storeDirectory: path.join(root, ".fpm-store") });
}

function characterTransform(host) {
  return host.capability("runtime.transforms.read").snapshot().transforms
    .find((entry) => entry.instanceId === "world:demo/character-1");
}

test("worker timing and worker count change observation but not committed ticks, state, or rendering", async (context) => {
  const root = await temporaryDirectory("determinism");
  context.after(() => rm(root, { recursive: true, force: true }));
  const configurations = [
    { workerCount: 1, delays: { [setTask]: 0, [addTask]: 0 } },
    { workerCount: 2, delays: { [setTask]: 40, [addTask]: 0 } },
    { workerCount: 2, delays: { [setTask]: 0, [addTask]: 40 } },
  ];
  const outcomes = [];
  for (const [index, configuration] of configurations.entries()) {
    const built = await buildShared(baseProfile, root, `run-${index}`);
    const svg = path.join(root, `run-${index}.svg`);
    const host = await startRuntime(built, { snapshotPath: svg,
      schedulerWorkerCount: configuration.workerCount, schedulerDelays: configuration.delays });
    await host.tick();
    const tasks = host.plan.record.collections.find((entry) => entry.capability === "runtime.task");
    assert.deepEqual(tasks.memberOrder, [addTask, setTask]);
    assert.deepEqual(tasks.members.find((entry) => entry.id === addTask).metadata.outputs[0].commitAfter, [setTask]);
    assert.equal(host.plan.record.selections.find((entry) => entry.capability === "runtime.scheduler.barrier").provider,
      "service:demo.deterministic-scheduler/1");
    assert.deepEqual(host.plan.record.services.find((entry) => entry.id === "service:demo.motion/1").requires, []);
    assert.ok(host.plan.record.services.find((entry) => entry.id === "service:demo.deterministic-scheduler/1").requires
      .some((entry) => entry.capability === "runtime.transforms.write"));
    const record = host.capability("runtime.scheduler.records").latest();
    const trace = host.capability("runtime.scheduler.records").trace()[0];
    outcomes.push({
      record,
      transform: characterTransform(host),
      scene: host.capability("runtime.renderer.window").scene(),
      svg: await readFile(svg, "utf8"),
      tickFile: await readFile(path.join(built.outputDirectory, "runtime-ticks.json"), "utf8"),
      trace,
      explanation: explainRuntime(host.lifecycle, setTask),
    });
    await host.shutdown();
  }
  for (const outcome of outcomes.slice(1)) {
    assert.deepEqual(outcome.record, outcomes[0].record);
    assert.deepEqual(outcome.transform, outcomes[0].transform);
    assert.deepEqual(outcome.scene, outcomes[0].scene);
    assert.equal(outcome.svg, outcomes[0].svg);
    assert.equal(outcome.tickFile, outcomes[0].tickFile);
  }
  assert.equal(outcomes[0].record.result.revision, 1);
  assert.deepEqual(outcomes[0].record.composition[0].order, [setTask, addTask]);
  assert.equal(outcomes[0].transform.translation[0], Number((Math.sin(Math.PI / 4) * 0.75 + 0.25).toFixed(6)));
  assert.equal(outcomes[0].trace.workerCount, 1);
  assert.equal(outcomes[1].trace.workerCount, 2);
  assert.notDeepEqual(outcomes[1].trace.completionOrder, outcomes[2].trace.completionOrder);
  assert.ok(outcomes.slice(1).every((outcome) => outcome.trace.executions
    .every((entry) => entry.threadKind === "worker" && entry.threadId > 0)));
  assert.equal(outcomes[0].explanation.collections[0].capability, "runtime.task");
});

test("ambiguous ordered producers fail during scheduler planning before runtime commitment", async (context) => {
  const root = await temporaryDirectory("ambiguous");
  context.after(() => rm(root, { recursive: true, force: true }));
  const built = await buildShared(path.join(failureProfiles, "task-unordered.json"), root, "out");
  await assert.rejects(() => startRuntime(built, { snapshotPath: path.join(root, "scene.svg") }), (error) => {
    assert.equal(error.code, "FPM_TASK_COMMAND_COMPOSITION_AMBIGUOUS");
    assert.equal(error.details.channel, "runtime.transforms.commands");
    assert.ok(error.details.contributors.includes("task:fixture.unordered/1"));
    assert.equal(error.details.lifecycle.committed, false);
    return true;
  });
  await assert.rejects(() => access(path.join(built.outputDirectory, "runtime-ticks.json")));
  await assert.rejects(() => access(path.join(built.outputDirectory, "runtime-lifecycle.json")));
});

test("a required task failure discards successful buffers and leaves checkpoint state unmodified", async (context) => {
  const root = await temporaryDirectory("failure");
  context.after(() => rm(root, { recursive: true, force: true }));
  const built = await buildShared(path.join(failureProfiles, "task-failure.json"), root, "out");
  const host = await startRuntime(built, { snapshotPath: path.join(root, "scene.svg"),
    schedulerWorkerCount: 3, schedulerDelays: { "task:fixture.failure/1": 30 } });
  const before = host.capability("runtime.transforms.read").snapshot();
  await assert.rejects(() => host.tick(), (error) => {
    assert.equal(error.code, "FPM_FIXTURE_TASK_FAILED");
    assert.equal(error.details.task, "task:fixture.failure/1");
    assert.ok(error.details.discardedBuffers.includes(setTask));
    return true;
  });
  assert.deepEqual(host.capability("runtime.transforms.read").snapshot(), before);
  assert.equal(host.capability("runtime.clock.tick").now().tick, 0);
  assert.deepEqual(host.capability("runtime.scheduler.records").list(), []);
  assert.equal(host.capability("runtime.scheduler.records").trace()[0].committed, false);
  await assert.rejects(() => access(path.join(built.outputDirectory, "runtime-ticks.json")));
  await host.shutdown();
});

test("a required task timeout aborts the barrier without publishing a tick", async (context) => {
  const root = await temporaryDirectory("timeout");
  context.after(() => rm(root, { recursive: true, force: true }));
  const built = await buildShared(baseProfile, root, "out");
  const host = await startRuntime(built, { snapshotPath: path.join(root, "scene.svg"), schedulerWorkerCount: 2,
    schedulerTimeoutMs: 10, schedulerDelays: { [setTask]: 100, [addTask]: 0 } });
  await assert.rejects(() => host.tick(), (error) => error.code === "FPM_RUNTIME_TASK_TIMEOUT"
    && error.details.task === setTask);
  assert.equal(host.capability("runtime.transforms.read").snapshot().revision, 0);
  assert.deepEqual(host.capability("runtime.scheduler.records").list(), []);
  await assert.rejects(() => access(path.join(built.outputDirectory, "runtime-ticks.json")));
  await host.shutdown();
});

for (const [name, profile, code] of [
  ["undeclared immutable snapshot access", "task-snapshot-authority.json", "FPM_TASK_SNAPSHOT_AUTHORITY_DENIED"],
  ["direct mutable authority", "task-direct-mutation.json", "FPM_TASK_DIRECT_AUTHORITY_DENIED"],
]) {
  test(`tasks are denied ${name} without partial mutation`, async (context) => {
    const root = await temporaryDirectory(profile.replace(".json", ""));
    context.after(() => rm(root, { recursive: true, force: true }));
    const built = await buildShared(path.join(failureProfiles, profile), root, "out");
    const host = await startRuntime(built, { snapshotPath: path.join(root, "scene.svg") });
    await assert.rejects(() => host.tick(), (error) => error.code === code);
    assert.equal(host.capability("runtime.transforms.read").snapshot().revision, 0);
    assert.deepEqual(host.capability("runtime.scheduler.records").list(), []);
    await host.shutdown();
  });
}

test("task dependency cycles fail in the generic collection plan before workers exist", async (context) => {
  const root = await temporaryDirectory("cycle");
  context.after(() => rm(root, { recursive: true, force: true }));
  const built = await buildShared(path.join(failureProfiles, "task-cycle.json"), root, "out");
  assert.throws(() => resolveRuntimePlan(built), (error) => {
    assert.equal(error.code, "FPM_RUNTIME_COLLECTION_DEPENDENCY_CYCLE");
    assert.equal(error.details.capability, "runtime.task");
    assert.deepEqual([...new Set(error.details.cycle)].sort(), ["task:fixture.cycle-a/1", "task:fixture.cycle-b/1"]);
    return true;
  });
});

test("main-thread affinity is enforced and an unavailable affinity implementation fails activation", async (context) => {
  const root = await temporaryDirectory("affinity");
  context.after(() => rm(root, { recursive: true, force: true }));
  const built = await buildShared(mainThreadProfile, root, "valid");
  const host = await startRuntime(built, { snapshotPath: path.join(root, "valid.svg"), schedulerWorkerCount: 2 });
  await host.tick();
  const executions = host.capability("runtime.scheduler.records").trace()[0].executions;
  assert.deepEqual(executions.find((entry) => entry.task === "task:demo.main-thread-audit/1"), {
    task: "task:demo.main-thread-audit/1",
    affinity: "main-thread",
    threadKind: "main-thread",
    threadId: 0,
  });
  assert.ok(executions.filter((entry) => [setTask, addTask].includes(entry.task))
    .every((entry) => entry.threadKind === "worker" && entry.threadId > 0));
  await host.shutdown();

  const invalid = await buildShared(path.join(failureProfiles, "task-affinity.json"), root, "invalid");
  await assert.rejects(() => startRuntime(invalid, { snapshotPath: path.join(root, "invalid.svg") }),
    (error) => error.code === "FPM_TASK_AFFINITY_UNAVAILABLE" && error.details.lifecycle.committed === false);
});

test("overlapping ticks are rejected for one runtime generation", async (context) => {
  const root = await temporaryDirectory("reentrancy");
  context.after(() => rm(root, { recursive: true, force: true }));
  const built = await buildShared(baseProfile, root, "out");
  const host = await startRuntime(built, { snapshotPath: path.join(root, "scene.svg"), schedulerWorkerCount: 2,
    schedulerDelays: { [setTask]: 60, [addTask]: 60 } });
  const first = host.tick();
  await assert.rejects(() => host.tick(), (error) => error.code === "FPM_RUNTIME_TICK_OVERLAP");
  await first;
  assert.equal(host.ticks, 1);
  assert.equal(host.capability("runtime.scheduler.records").list().length, 1);
  await host.shutdown();
});

test("optional task exclusion is attributed and changes only the declared composition", async (context) => {
  const root = await temporaryDirectory("exclusion");
  context.after(() => rm(root, { recursive: true, force: true }));
  const built = await buildShared(excludedProfile, root, "out");
  const host = await startRuntime(built, { snapshotPath: path.join(root, "scene.svg") });
  await host.tick();
  const taskPlan = host.plan.record.collections.find((entry) => entry.capability === "runtime.task");
  assert.equal(taskPlan.exclusions[0].member, addTask);
  assert.equal(taskPlan.exclusions[0].policy, "policy:demo.exclude-motion-offset/1");
  const record = host.capability("runtime.scheduler.records").latest();
  assert.deepEqual(record.composition[0].order, [setTask]);
  assert.equal(record.taskPolicy.exclusions[0].policy, "policy:demo.exclude-motion-offset/1");
  assert.equal(characterTransform(host).translation[0], Number((Math.sin(Math.PI / 4) * 0.75).toFixed(6)));
  assert.equal(explainRuntime(host.lifecycle, addTask).collections[0].exclusions[0].policy,
    "policy:demo.exclude-motion-offset/1");
  await host.shutdown();
});

test("Transform Authority rejects a buffer from a stale checkpoint", async (context) => {
  const root = await temporaryDirectory("stale");
  context.after(() => rm(root, { recursive: true, force: true }));
  const built = await buildShared(baseProfile, root, "out");
  const host = await startRuntime(built, { snapshotPath: path.join(root, "scene.svg") });
  await host.tick();
  const committed = host.capability("runtime.transforms.read").snapshot();
  assert.throws(() => host.capability("runtime.transforms.write").commitBatch({
    schema: "fpm.transform-command-batch/1",
    checkpoint: { schema: "fpm.runtime-tick/1", tick: 1, seconds: 0.25 },
    expectedRevision: 0,
    channel: "runtime.transforms.commands",
    composition: { form: "ordered", order: [] },
    buffers: [],
  }), (error) => error.code === "FPM_TRANSFORM_BATCH_STALE");
  assert.deepEqual(host.capability("runtime.transforms.read").snapshot(), committed);
  await host.shutdown();
});

test("a restored scheduler resumes the saved world checkpoint before new work", async (context) => {
  const root = await temporaryDirectory("resume");
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = await buildShared(baseProfile, root, "source");
  const first = await startRuntime(source, { snapshotPath: path.join(root, "source.svg") });
  await first.tick();
  await first.tick();
  await first.capability("runtime.persistence.world").save("save:phase-7/resume");
  await first.shutdown();

  const restoredBuild = await buildShared(baseProfile, root, "restored");
  const restored = await startRuntime(restoredBuild, { loadSaveId: "save:phase-7/resume",
    snapshotPath: path.join(root, "restored.svg") });
  assert.equal(restored.capability("runtime.clock.tick").now().tick, 2);
  await restored.tick();
  assert.equal(restored.capability("runtime.scheduler.records").latest().checkpoint.tick, 3);
  assert.equal(restored.capability("runtime.transforms.read").snapshot().revision, 3);
  await restored.shutdown();
});
