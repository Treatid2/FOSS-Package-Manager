// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildProfile, prepareProfile } from "../src/core/build.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseProfile = path.join(repository, "profiles", "base.json");
const greenProfile = path.join(repository, "profiles", "green-head.json");

async function temporaryDirectory(name) {
  return mkdtemp(path.join(tmpdir(), `fpm-${name}-`));
}

async function json(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

test("base and Green Head profiles build through the same package graph", async (context) => {
  const root = await temporaryDirectory("vertical-slice");
  context.after(() => rm(root, { recursive: true, force: true }));
  const base = await buildProfile(baseProfile, path.join(root, "base"));
  const green = await buildProfile(greenProfile, path.join(root, "green"));
  const baseScene = await json(base.artifactPath);
  const greenScene = await json(green.artifactPath);

  assert.equal(baseScene.schema, "fpm.render-scene/1");
  assert.equal(baseScene.objects.length, 3);
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
});

test("lockfile and scene artifacts are reproducible across output directories", async (context) => {
  const root = await temporaryDirectory("reproducible");
  context.after(() => rm(root, { recursive: true, force: true }));
  const first = await buildProfile(greenProfile, path.join(root, "first"));
  const second = await buildProfile(greenProfile, path.join(root, "second"));
  assert.deepEqual(first.lockfile, second.lockfile);
  assert.equal(await readFile(first.artifactPath, "utf8"), await readFile(second.artifactPath, "utf8"));
});

test("the selected runtime consumes the flat scene and emits a deterministic SVG snapshot", async (context) => {
  const root = await temporaryDirectory("runtime");
  context.after(() => rm(root, { recursive: true, force: true }));
  const result = await buildProfile(greenProfile, root);
  const snapshot = path.join(root, "scene.svg");
  const runtime = path.join(repository, "packages", "demo.simple-runtime", "runtime.mjs");
  const execution = spawnSync(process.execPath, [runtime, result.artifactPath, "--snapshot", snapshot], {
    cwd: repository,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(execution.status, 0, execution.stderr);
  const svg = await readFile(snapshot, "utf8");
  assert.match(svg, /Resolved FOSS Package Manager demo scene/);
  assert.match(svg, /pkg:demo\.green-head\/texture\/head-green/);
  assert.match(svg, /world:demo\/character-1\/head/);
});

const failures = [
  ["missing dependency", "missing-dependency.json", "FPM_DEPENDENCY_MISSING"],
  ["missing handler", "no-handler.json", "FPM_HANDLER_MISSING"],
  ["duplicate public identity", "duplicate-public.json", "FPM_PUBLIC_ID_DUPLICATE"],
  ["incompatible semantic type", "incompatible-semantic.json", "FPM_SEMANTIC_TYPE_INCOMPATIBLE"],
  ["ambiguous compatible replacements", "ambiguous-replacement.json", "FPM_REPLACEMENT_AMBIGUOUS"],
  ["cyclic dependencies", "cyclic-dependency.json", "FPM_DEPENDENCY_CYCLE"],
  ["malformed domain manifest", "malformed-domain.json", "FPM_DOMAIN_MANIFEST_MALFORMED"],
  ["handler analysis failure", "handler-failure.json", "FPM_HANDLER_ANALYSIS_FAILED"],
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
  assert.match(execution.stderr, /FPM_SEMANTIC_TYPE_INCOMPATIBLE/);
  assert.match(execution.stderr, /requiredSemanticType/);
  assert.match(execution.stderr, /providedSemanticType/);
  assert.match(execution.stderr, /pkg:demo\.character\/appearance\/head\/base-colour/);
});
