// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildProfile, prepareProfile } from "../src/core/build.mjs";
import { discoverPackages } from "../src/core/discovery.mjs";

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
  assert.equal(base.lockfile.schema, "fpm.lock/2");
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

  const fieldBinding = base.lockfile.bindings.find((entry) => entry.target.endsWith("field/appearance/base-colour"));
  assert.equal(fieldBinding.artifactRoute.kind, "direct-production");
  assert.equal(fieldBinding.artifactRoute.sourceSemanticType, "texture.file.ppm-p3-srgb/1");

  const handlerPackages = new Set(green.lockfile.handlers.map((entry) => entry.package));
  assert.ok(handlerPackages.has("demo.texture-toolchain"));
  assert.ok(handlerPackages.has("demo.scene-toolchain"));
  assert.ok(handlerPackages.has("demo.solid-colour-adapter"));

  const finalAction = green.lockfile.actions.find((entry) => entry.kind === "build-render-scene");
  assert.equal(finalAction.handler, "handler:demo.scene-toolchain/1");
  assert.ok(finalAction.inputs.length > 0);
  assert.ok(finalAction.inputs.every((entry) => entry.type === "texture.runtime.rgba8-srgb/1"));
  assert.ok(finalAction.inputs.every((entry) => !entry.artifact.includes("solid-colour/source")));
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
  ["unresolved semantic artifact route", "incompatible-semantic.json", "FPM_ARTIFACT_ROUTE_MISSING"],
  ["ambiguous compatible replacements", "ambiguous-replacement.json", "FPM_REPLACEMENT_AMBIGUOUS"],
  ["missing adapter", "missing-adapter.json", "FPM_ARTIFACT_ROUTE_MISSING"],
  ["ambiguous adapters", "ambiguous-adapter.json", "FPM_ADAPTER_AMBIGUOUS"],
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
  assert.match(execution.stderr, /FPM_ARTIFACT_ROUTE_MISSING/);
  assert.match(execution.stderr, /requiredSemanticType/);
  assert.match(execution.stderr, /producedTypes/);
  assert.match(execution.stderr, /pkg:demo\.character\/appearance\/head\/base-colour/);
});
