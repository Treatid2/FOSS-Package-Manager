// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildProfile } from "../src/core/build.mjs";
import { startRuntime } from "../src/core/runtime.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profile = path.join(repository, "authoring-kit", "runtime-task", "self-check-profile.json");
const exampleTask = "task:example.runtime-task/add-y/1";

test("the public runtime-task authoring kit conforms to the Phase 7 checkpoint", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fgpm-authoring-kit-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const built = await buildProfile(profile, path.join(root, "out"), {
    storeDirectory: path.join(root, ".fgpm-store"),
  });
  const host = await startRuntime(built, { snapshotPath: path.join(root, "scene.svg"), schedulerWorkerCount: 3 });
  try {
    const collection = host.plan.record.collections.find((entry) => entry.capability === "runtime.task");
    assert.ok(collection.members.some((entry) => entry.id === exampleTask
      && entry.providerInstance === "service:example.runtime-task/1"));

    await host.tick();
    const record = host.capability("runtime.scheduler.records").latest();
    assert.deepEqual(record.composition[0].order, [
      "task:demo.motion/set-x/1",
      "task:demo.motion-offset/add-x/1",
      exampleTask,
    ]);
    assert.ok(record.commandBuffers.some((entry) => entry.task === exampleTask));

    const character = host.capability("runtime.transforms.read").snapshot().transforms
      .find((entry) => entry.instanceId === "world:demo/character-1");
    assert.equal(character.translation[1], 0.125);
    assert.equal(host.capability("runtime.scheduler.records").trace()[0].executions
      .find((entry) => entry.task === exampleTask).threadKind, "worker");
  } finally {
    await host.shutdown();
  }
});
