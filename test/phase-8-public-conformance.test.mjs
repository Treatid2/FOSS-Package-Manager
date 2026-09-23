// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildProfile } from "../src/core/build.mjs";
import { runRuntimeTaskConformance } from "../src/core/conformance.mjs";
import { formatDiagnostic } from "../src/core/errors.mjs";
import { startRuntime } from "../src/core/runtime.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(repository, "fixtures", "public-conformance");
const packages = path.join(repository, "packages");
const focus = "task:fresh.z-task/add-z/1";

async function workspace(context, label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `fgpm-phase8-public-${label}-`));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function oneTick(profile, output, storeDirectory) {
  const built = await buildProfile(profile, output, { storeDirectory, packageRoots: [packages] });
  const host = await startRuntime(built, { snapshotPath: path.join(output, "scene.svg") });
  try {
    await host.tick();
    return {
      outputTransformRoot: host.capability("runtime.scheduler.records").latest().result.stateRoot,
      selectedPackages: built.resolution.ordered.map((entry) => entry.id),
    };
  } finally {
    await host.shutdown();
  }
}

test("generic public conformance delays its focus and a non-ranked peer without changing deterministic output",
  async (context) => {
    const root = await workspace(context, "matrix");
    const { report } = await runRuntimeTaskConformance(path.join(fixture, "active-profile.json"),
      path.join(root, "out"), { packageRoots: [packages], focusMember: focus });

    assert.equal(report.status, "pass");
    assert.equal(report.selection.focus, focus);
    assert.ok(report.selection.selectedMembers.includes(focus));
    assert.ok(report.selection.contributors.includes(focus));
    assert.equal(report.selection.peerSelectionReason,
      "lexicographically-first-other-selected-channel-contributor");
    assert.deepEqual(report.runs.map((entry) => entry.configuration.id),
      ["single-worker", "focus-delayed", "peer-delayed"]);
    assert.equal(report.runs[1].configuration.memberDelays[focus], 40);
    assert.equal(report.runs[2].configuration.memberDelays[report.selection.peer], 40);
    assert.equal(report.runs[0].observational.workerCount, 1);
    assert.ok(report.runs[1].observational.workerCount > 1);
    assert.notDeepEqual(report.runs[1].observational.completionOrder,
      report.runs[2].observational.completionOrder);
    assert.equal(new Set(report.runs.map((entry) => entry.deterministicIdentity)).size, 1);
    assert.equal(new Set(report.runs.map((entry) => entry.outputTransformRoot)).size, 1);
    assert.equal(report.claims.focusDelayApplied, true);
    assert.equal(report.claims.peerDelayApplied, true);
    assert.equal(report.claims.completionOrderObservational, true);
    assert.equal(report.runs.some((entry) => Object.hasOwn(entry, "transformRoot")), false);

    const source = await readFile(path.join(repository, "src", "core", "conformance.mjs"), "utf8");
    assert.equal(source.includes("task:demo."), false);
  });

test("the public focus must be an exact selected member of the relevant task collection", async (context) => {
  const root = await workspace(context, "invalid-focus");
  await assert.rejects(() => runRuntimeTaskConformance(path.join(fixture, "active-profile.json"),
    path.join(root, "out"), { packageRoots: [packages], focusMember: "task:unknown.example/1" }), (error) => {
    assert.equal(error.code, "FGPM_RUNTIME_TASK_CONFORMANCE_FOCUS_NOT_SELECTED");
    assert.ok(error.details.selectedMembers.includes(focus));
    return true;
  });
});

test("active external output differs from baseline while exact exclusion restores the baseline root",
  async (context) => {
    const root = await workspace(context, "root-semantics");
    const store = path.join(root, "store");
    const active = await oneTick(path.join(fixture, "active-profile.json"), path.join(root, "active"), store);
    const excluded = await oneTick(path.join(fixture, "excluded-profile.json"), path.join(root, "excluded"), store);
    const baseline = await oneTick(path.join(fixture, "baseline-profile.json"), path.join(root, "baseline"), store);
    assert.notEqual(active.outputTransformRoot, baseline.outputTransformRoot);
    assert.equal(excluded.outputTransformRoot, baseline.outputTransformRoot);
    assert.ok(excluded.selectedPackages.includes("fresh.z-task"));
  });

test("a public ambiguity produces a structured pre-mutation failed-conformance report and no stack",
  async (context) => {
    const root = await workspace(context, "ambiguity");
    const output = path.join(root, "out");
    const result = spawnSync(process.execPath, [path.join(repository, "src", "cli.mjs"),
      "conformance", "runtime-task", path.join(fixture, "ambiguous-profile.json"),
      "--focus", focus, "--packages", packages, "--out", output], {
      cwd: repository, encoding: "utf8", timeout: 20_000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /FGPM_TASK_COMMAND_COMPOSITION_AMBIGUOUS/);
    assert.equal(result.stderr.includes("conformance.mjs:"), false);
    assert.equal(result.stderr.includes("service.mjs:"), false);
    assert.equal(result.stderr.includes("\n    at "), false);

    const report = JSON.parse(await readFile(path.join(output, "runtime-task-conformance.json"), "utf8"));
    assert.equal(report.schema, "fgpm.runtime-task-conformance-report/2");
    assert.equal(report.status, "fail");
    assert.equal(report.selection.focus, focus);
    assert.equal(report.configuration.id, "single-worker");
    assert.equal(report.configuration.workerCount, 1);
    assert.deepEqual(report.configuration.memberDelays, {});
    assert.equal(report.failure.code, "FGPM_TASK_COMMAND_COMPOSITION_AMBIGUOUS");
    assert.equal(report.failure.channel, "runtime.transforms.commands");
    assert.equal(report.failure.vocabulary, "fgpm.transform-task-vocabulary/1");
    assert.equal(report.failure.steward, "fgpm.transform-task-contracts@1.0.0");
    assert.equal(report.failure.stage, "set-axis");
    assert.equal(report.failure.law, "exclusive-per-target");
    assert.deepEqual(report.failure.target, {
      instanceId: "world:demo/character-1", axis: "x", key: "world:demo/character-1#x",
    });
    assert.deepEqual(report.failure.contributors, [
      "task:demo.motion-v2/set-x/1",
      focus,
    ]);
    assert.equal(report.failure.preAuthoritativeStateRoot, report.failure.postAuthoritativeStateRoot);
    assert.equal(report.failure.authoritativeStateUnchanged, true);
    assert.equal(report.failure.mutationCommitted, false);
    assert.equal(report.failure.successfulTickCommitted, false);
    assert.equal(report.coreBeforeAfterAudit.unchanged, true);
  });

test("public specialist diagnostics preserve structured errors and expose stacks only in debug mode", () => {
  const error = Object.assign(new Error("Structured specialist failure."), {
    code: "FGPM_SPECIALIST_EXAMPLE",
    details: { steward: "fixture.contracts@1.0.0", contributors: ["task:fixture/1"] },
  });
  const normal = formatDiagnostic(error);
  assert.match(normal, /^FGPM_SPECIALIST_EXAMPLE: Structured specialist failure\./);
  assert.match(normal, /steward:/);
  assert.equal(normal.includes("\n    at "), false);
  assert.match(formatDiagnostic(error, { debug: true }), /stack:/);
  assert.match(formatDiagnostic(new Error("unstructured")),
    /^FGPM_INTERNAL: An unexpected internal error occurred\.$/);
});

test("run --ticks is bounded without a snapshot liveness side effect", async (context) => {
  const root = await workspace(context, "bounded-run");
  const result = spawnSync(process.execPath, [path.join(repository, "src", "cli.mjs"),
    "run", path.join(fixture, "active-profile.json"), "--ticks", "1",
    "--packages", packages, "--out", path.join(root, "out")], {
      cwd: repository, encoding: "utf8", timeout: 20_000,
    });
  assert.equal(result.error?.code, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  const lifecycle = JSON.parse(await readFile(path.join(root, "out", "runtime-lifecycle.json"), "utf8"));
  assert.equal(lifecycle.state, "stopped");
  assert.equal(lifecycle.ticks, 1);
});
