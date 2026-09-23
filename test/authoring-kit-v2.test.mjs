// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildProfile } from "../src/core/build.mjs";
import { validatePackageIsolated } from "../src/core/public-contracts.mjs";
import { startRuntime } from "../src/core/runtime.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const kit = path.join(repository, "authoring-kit", "runtime-task-v2");
const profile = path.join(kit, "self-check-profile.json");
const examplePackage = path.join(kit, "example-package");
const task = "task:example.runtime-task-v2/add-y/1";

test("the corrected public-only authoring kit validates and composes without producer identities", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fgpm-authoring-kit-v2-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const validation = await validatePackageIsolated(examplePackage);
  assert.equal(validation.status, "valid");
  assert.equal(validation.tasks, 1);
  const contract = await readFile(path.join(kit, "contract.md"), "utf8");
  assert.match(contract, /calls `createService\(\)` with exactly zero arguments/);
  assert.match(contract, /`activate\(context\)`/);
  assert.match(contract, /`context\.require\(capability\)`/);
  assert.doesNotMatch(contract, /createService\((?:context|dependencies|options)\)/);
  const verification = JSON.parse(execFileSync(process.execPath,
    [path.join(kit, "verify-public-contracts.mjs"), path.join(repository, "public")], { encoding: "utf8" }));
  assert.equal(verification.status, "valid");
  assert.equal(verification.verified.length, 2);
  const manifestText = await readFile(path.join(examplePackage, "fgpm-package.json"), "utf8");
  assert.equal(manifestText.includes("commitAfter"), false);
  assert.equal(manifestText.includes("demo.motion"), false);
  assert.equal(manifestText.includes("deterministic-scheduler"), false);
  const built = await buildProfile(profile, path.join(root, "out"), {
    storeDirectory: path.join(root, "store"),
    packageRoots: [path.join(repository, "packages")],
  });
  const host = await startRuntime(built, { snapshotPath: path.join(root, "scene.svg"), schedulerWorkerCount: 3 });
  try {
    const collection = host.plan.record.collections.find((entry) => entry.capability === "runtime.task");
    assert.ok(built.resolution.ordered.some((pkg) => pkg.id === "fgpm.runtime-task-contracts"));
    const member = collection.members.find((entry) => entry.id === task);
    assert.equal(member.metadata.participation, "optional");
    assert.equal(member.metadata.failurePolicy, "drop-task");
    assert.equal(member.metadata.outputs[0].stage, "add-axis");
    await host.tick();
    const record = host.capability("runtime.scheduler.records").latest();
    assert.ok(record.composition[0].commitOrder.includes(task));
    assert.equal(record.composition[0].steward, "fgpm.transform-task-contracts@1.0.0");
    const character = host.capability("runtime.transforms.read").snapshot().transforms
      .find((entry) => entry.instanceId === "world:demo/character-1");
    assert.equal(character.translation[1], 0.1);
  } finally {
    await host.shutdown();
  }
});
