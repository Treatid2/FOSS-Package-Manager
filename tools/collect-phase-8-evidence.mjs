#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildProfile } from "../src/core/build.mjs";
import { sha256, stableJson, writeJson } from "../src/core/io.mjs";
import { explainRuntime, startRuntime } from "../src/core/runtime.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.resolve(process.argv[2] ?? path.join(repository, "evidence", "phase-8"));
const staging = path.join(repository, "build", "phase-8-evidence");
const storeDirectory = path.join(staging, ".fgpm-store");
const task = "task:demo.external-nudge-v2/add-x/1";

function root(value) {
  return `sha256:${sha256(stableJson(value))}`;
}

function diagnostic(error) {
  return { code: error?.code ?? "FGPM_INTERNAL", message: error?.message ?? String(error),
    details: error?.details ?? {} };
}

function optionalExplanation(lifecycle, target) {
  try {
    return explainRuntime(lifecycle, target);
  } catch (error) {
    if (error?.code === "FGPM_RUNTIME_EXPLANATION_MISSING") return null;
    throw error;
  }
}

async function successfulRun(id, profileFile) {
  const output = path.join(staging, id);
  const snapshotPath = path.join(output, "scene.svg");
  const built = await buildProfile(path.join(repository, "profiles", profileFile), output, { storeDirectory });
  const host = await startRuntime(built, { snapshotPath, schedulerWorkerCount: 3 });
  await host.tick();
  const transform = host.capability("runtime.transforms.read").snapshot();
  const scene = host.capability("runtime.renderer.window").scene();
  const record = host.capability("runtime.scheduler.records").latest();
  const trace = host.capability("runtime.scheduler.records").trace().at(-1);
  const svg = await readFile(snapshotPath, "utf8");
  const result = {
    profile: profileFile,
    selectedPackages: built.resolution.ordered.map((pkg) => pkg.id).sort(),
    artifact: host.plan.record.artifact,
    taskCollection: host.plan.record.collections.find((entry) => entry.capability === "runtime.task"),
    hostGrants: host.plan.record.hostGrants,
    deterministic: {
      tickIdentity: record.identity,
      tickRoot: root(record),
      transformRoot: root(transform),
      sceneRoot: root(scene),
      svgHash: `sha256:${sha256(svg)}`,
      composition: record.composition,
      taskPolicy: record.taskPolicy,
    },
    observational: trace,
    explanations: {
      channel: explainRuntime(host.lifecycle, "runtime.transforms.commands"),
      externalNudge: optionalExplanation(host.lifecycle, task),
    },
  };
  await host.shutdown();
  return result;
}

async function ambiguityFailure() {
  const profilePath = path.join(repository, "fixtures", "failures", "profiles", "task-v2-ambiguous.json");
  const output = path.join(staging, "ambiguity");
  const built = await buildProfile(profilePath, output, { storeDirectory });
  const host = await startRuntime(built, { snapshotPath: path.join(output, "scene.svg") });
  const before = host.capability("runtime.transforms.read").snapshot();
  let failure;
  try {
    await host.tick();
  } catch (error) {
    failure = diagnostic(error);
  }
  const after = host.capability("runtime.transforms.read").snapshot();
  const trace = host.capability("runtime.scheduler.records").trace().at(-1);
  await host.shutdown();
  return { failure, beforeRoot: root(before), afterRoot: root(after), unchanged: root(before) === root(after), trace };
}

async function grantFailure() {
  const output = path.join(staging, "grant-denied");
  const built = await buildProfile(path.join(repository, "profiles", "runtime-task-v2.json"), output, { storeDirectory });
  try {
    await startRuntime(built, { deniedHostGrants: ["fgpm.host.scheduler-conformance/1"] });
  } catch (error) {
    return diagnostic(error);
  }
  throw new Error("Expected denied grant activation to fail.");
}

const baseline = await successfulRun("baseline", "runtime-task-v2-baseline.json");
const active = await successfulRun("active", "runtime-task-v2.json");
const excluded = await successfulRun("excluded", "runtime-task-v2-nudge-excluded.json");
const report = {
  schema: "fgpm.phase-8-runtime-boundary-evidence/1",
  generatedBy: "tools/collect-phase-8-evidence.mjs",
  evidenceLabels: {
    runtimeTaskPath: "demonstrated",
    nativeContainment: "limited-not-claimed",
    compatibility: "experimental-no-promise",
  },
  baseline,
  active,
  excluded,
  exclusionEquivalence: {
    packageRemainsSelected: excluded.selectedPackages.includes("demo.external-nudge-v2"),
    policy: excluded.taskCollection.exclusions[0]?.policy ?? null,
    transformEqual: excluded.deterministic.transformRoot === baseline.deterministic.transformRoot,
    sceneEqual: excluded.deterministic.sceneRoot === baseline.deterministic.sceneRoot,
    svgEqual: excluded.deterministic.svgHash === baseline.deterministic.svgHash,
  },
  ambiguityFailure: await ambiguityFailure(),
  grantFailure: await grantFailure(),
};
await writeJson(path.join(destination, "runtime-boundary-evidence.json"), report);
console.log(JSON.stringify({ destination, exclusionEquivalence: report.exclusionEquivalence,
  ambiguity: report.ambiguityFailure.failure.code, grant: report.grantFailure.code }, null, 2));
