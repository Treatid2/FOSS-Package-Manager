// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadWorkbenchProject } from "../tools/curator-workbench/project.mjs";
import { compareExactBuildEnvironment, startWorkbench } from "../tools/curator-workbench/server.mjs";
import { ControlClient } from "../tools/curator-workbench/control-client.mjs";
import {
  WORKBENCH_CLIENT_PROFILES,
  authorizeClientOperation,
  workbenchClientAuthorityDescription,
} from "../tools/curator-workbench/client-authority.mjs";
import { GUIDED_HUMAN_OPERATION_REGISTRY } from "../tools/curator-workbench/guided-operation-registry.mjs";

const managerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const commit = execFileSync("git", ["-C", managerRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const root = `sha256:${"0".repeat(64)}`;

function closedSchema(value, pointer = "$") {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    const item = closedSchema(value[0], `${pointer}[]`);
    if (pointer === "$.releases") item.properties.parent = {
      oneOf: [{ type: "null" }, { type: "string", pattern: "^sha256:[0-9a-f]{64}$" }],
    };
    return { type: "array", minItems: 1, items: item };
  }
  if (value && typeof value === "object") return {
    type: "object", additionalProperties: false, required: Object.keys(value),
    properties: Object.fromEntries(Object.entries(value).map(([key, entry]) =>
      [key, closedSchema(entry, `${pointer}.${key}`)])),
  };
  if (typeof value === "number") return pointer === "$.version" ? { const: 2 } : { type: "number" };
  if (typeof value === "string") {
    if (pointer === "$.$schema") return { const: "project.schema.json" };
    if (pointer === "$.schema") return { const: "fgpm.project/2" };
    if (pointer === "$.portableState.mechanism") return { const: "deterministic-public-operation-journal" };
    if (/^sha256:[0-9a-f]{64}$/.test(value)) return { type: "string", pattern: "^sha256:[0-9a-f]{64}$" };
    if (/^[0-9a-f]{40}$/.test(value)) return { type: "string", pattern: "^[0-9a-f]{40}$" };
    return { type: "string", minLength: 1 };
  }
  return { type: typeof value };
}

async function compatibleProject(context, mutate = () => {}) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "fgpm-workbench-compatible-"));
  context.after(() => rm(projectRoot, { recursive: true, force: true }));
  await mkdir(path.join(projectRoot, "config"), { recursive: true });
  await mkdir(path.join(projectRoot, "release"), { recursive: true });
  const descriptor = {
    $schema: "project.schema.json", schema: "fgpm.project/2", id: "compatible-fixture",
    name: "Compatible Fixture", version: 2,
    manager: {
      preferred: { commit, bundle: "fixture.bundle" },
      contracts: { root, directory: "contracts" }, history: {},
    },
    current: { release: "R0", generation: root, distribution: root, workspace: "fixture-main" },
    workspace: { name: "fixture-main", headPolicy: "Replay the public journal." },
    portableState: { mechanism: "deterministic-public-operation-journal", journal: "config/current.json" },
    paths: { managerStore: ".fgpm/manager", workbenchSnapshot: ".fgpm/runtime.svg" },
    releases: [{ name: "R0", directory: "release", generation: root, distribution: root, parent: null }],
    tests: { command: "node --test", managerArgument: "--manager <path>", managerEnvironment: "FGPM_MANAGER_ROOT" },
    licences: { inventory: "LICENCES.md", projectDefault: "CC0-1.0" },
    workbench: { fixture: "config/workbench.json", launcher: "launch.mjs" },
  };
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://example.invalid/compatible-project.schema.json",
    ...closedSchema(descriptor),
  };
  mutate(descriptor);
  await writeFile(path.join(projectRoot, "project.json"), `${JSON.stringify(descriptor, null, 2)}\n`);
  await writeFile(path.join(projectRoot, "project.schema.json"), `${JSON.stringify(schema, null, 2)}\n`);
  await writeFile(path.join(projectRoot, "config", "current.json"), `${JSON.stringify({
    schema: "fgpm.public-control-journal/1", id: "fixture-current", steps: [],
  }, null, 2)}\n`);
  await writeFile(path.join(projectRoot, "config", "workbench.json"), `${JSON.stringify({
    schema: "fgpm.curator-workbench-fixture/1", actor: "fixture", description: "A second compatible project.",
    baseline: { distribution: "release/distribution", generation: root }, target: { profile: "profile.json", generation: root },
    imports: [], primaryPackage: "fixture", choice: { type: "select-replacement", target: "fixture", options: [] },
    generated: { generatorPackage: "fixture", generatorAction: {}, inputPackages: [], inputArtifactRoots: [], parameters: {}, environment: {}, packageId: "fixture.generated" }, scenes: {},
  }, null, 2)}\n`);
  return projectRoot;
}

test("manager-owned Workbench opens a second compatible project with a broken runtime", async (context) => {
  const projectRoot = await compatibleProject(context);
  const managerStore = path.join(projectRoot, "blocked-manager");
  await writeFile(managerStore, "A file deliberately prevents manager-store directory creation.\n");
  const workbench = await startWorkbench({ projectRoot, managerRoot, managerStore });
  context.after(() => workbench.close());
  const html = await (await fetch(workbench.url)).text();
  const css = await (await fetch(new URL("styles.css", workbench.url))).text();
  const app = await (await fetch(new URL("app.js", workbench.url))).text();
  const overview = await (await fetch(new URL("api/overview", workbench.url))).json();
  assert.match(html, /FOSS Package Manager curator workbench/);
  assert.match(html, /Guided curation fixture/);
  assert.match(html, /Advanced JSON console/);
  assert.match(css, /@media \(max-width: 20rem\)/);
  assert.match(css, /forced-colors: active/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /data-forced-colour-preview/);
  assert.match(css, /data-text-scale="200"/);
  assert.match(css, /data-reduced-motion-preview/);
  assert.match(app, /failed \? "alert" : "status"/);
  assert.equal(overview.project.id, "compatible-fixture");
  assert.equal(overview.manager.matchesDescriptor, true);
  assert.equal(overview.runtime.ok, false);
  assert.ok(overview.runtime.diagnostic.message.length > 0);
});

test("server-bound client profiles reject forgery before dispatch and retain explicit expert authority", async (context) => {
  const projectRoot = await compatibleProject(context);
  const managerStore = path.join(projectRoot, "profile-manager");
  const workbench = await startWorkbench({ projectRoot, managerRoot, managerStore });
  context.after(() => workbench.close());
  const post = (route, value) => fetch(new URL(route, workbench.url), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
  });

  const beforeDispatches = workbench.dispatches.length;
  const denied = await post("api/action/curator", {
    operation: "workspace.create", parameters: { name: "agent-created" },
    profile: "expert-debug", surface: "expert", inputMethod: "forged", controlId: "forged-profile",
  });
  const denial = await denied.json();
  assert.equal(denied.status, 403);
  assert.equal(denial.diagnostic.code, "FGPM_WORKBENCH_OPERATION_NOT_ALLOWED");
  assert.equal(denial.diagnostic.details.profile, "initial-curator");
  assert.equal(denial.diagnostic.details.operation, "workspace.create");
  assert.equal(denial.diagnostic.details.classification.maturity, "expert-supported");
  assert.match(denial.diagnostic.details.reason, /not present in the initial-curator profile/);
  assert.equal(workbench.dispatches.length, beforeDispatches);
  await assert.rejects(access(managerStore), (error) => error.code === "ENOENT");
  await assert.rejects(workbench.control.request("workspace.status", { name: "agent-created" }),
    (error) => error.code === "FGPM_FILE_UNREADABLE");

  const trace = await (await fetch(new URL("api/trace", workbench.url))).json();
  assert.equal(trace.actions.at(-1).profile, "initial-curator");
  assert.equal(trace.actions.at(-1).requestedProfile, "expert-debug");
  assert.equal(trace.actions.at(-1).state, "denied");

  const allowed = await post("api/action/curator", {
    operation: "runtime.inspect", parameters: {}, surface: "agent", inputMethod: "headless",
  });
  assert.equal(allowed.status, 200, JSON.stringify(await allowed.clone().json()));
  assert.equal((await allowed.json()).result.schema, "fgpm.runtime-inspection/1");

  const defaultDenied = await post("api/action", {
    operation: "workspace.create", parameters: { name: "implicit-expert" }, profile: "expert-debug",
  });
  assert.equal(defaultDenied.status, 403);
  assert.equal((await defaultDenied.json()).diagnostic.details.profile, "guided-human");

  const expert = await post("api/action/expert", {
    operation: "workspace.create", parameters: { name: "expert-created", actor: "expert-test" },
    surface: "expert", inputMethod: "headless",
  });
  assert.equal(expert.status, 200, JSON.stringify(await expert.clone().json()));
  assert.equal((await expert.json()).result.reference.name, "expert-created");
});

test("enforced initial curator operations are a subset of actual ordinary visible registry entries", async () => {
  const authority = workbenchClientAuthorityDescription();
  const profile = authority.profiles["initial-curator"];
  assert.deepEqual(profile.operations, WORKBENCH_CLIENT_PROFILES["initial-curator"].operations);
  const visible = new Set(GUIDED_HUMAN_OPERATION_REGISTRY.map((entry) => entry.operation));
  assert.deepEqual(profile.operations.filter((operation) => !visible.has(operation)), []);
  const html = await readFile(path.join(managerRoot, "tools", "curator-workbench", "public", "index.html"), "utf8");
  for (const entry of GUIDED_HUMAN_OPERATION_REGISTRY) {
    assert.match(html, new RegExp(`id=["']${entry.elementId}["']`), entry.operation);
    assert.equal(authorizeClientOperation("initial-curator", entry.operation).ok, true, entry.operation);
  }
  assert.equal(authorizeClientOperation("initial-curator", "workspace.create").ok, false);
  assert.equal(authorizeClientOperation("expert-debug", "workspace.create").ok, true);
  assert.equal(authorizeClientOperation("expert-debug", "runtime.tick").ok, true);
});

test("complete project schema rejects every reviewed invalid mutation with an exact diagnostic", async (context) => {
  const mutations = [
    ["history-extra", (descriptor) => { descriptor.manager.history.secret = true; }, "$.manager.history.secret", "additionalProperties"],
    ["bad-root", (descriptor) => { descriptor.current.generation = "not-a-root"; }, "$.current.generation", "pattern"],
    ["bad-commit", (descriptor) => { descriptor.manager.preferred.commit = "bad"; }, "$.manager.preferred.commit", "pattern"],
    ["bad-mechanism", (descriptor) => { descriptor.portableState.mechanism = "raw-store-copy"; }, "$.portableState.mechanism", "const"],
    ["release-extra", (descriptor) => { descriptor.releases[0].secret = true; }, "$.releases[0].secret", "additionalProperties"],
    ["path-traversal", (descriptor) => { descriptor.paths.managerStore = "../outside"; }, "$.paths.managerStore", "relativePath"],
    ["current-release", (descriptor) => { descriptor.current.release = "missing"; }, "$.current.release", "release-reference"],
    ["current-distribution", (descriptor) => { descriptor.current.distribution = root.replace(/0$/, "1"); }, "$.current.distribution", "release-consistency"],
  ];
  for (const [label, mutate, expectedPath, expectedRule] of mutations) {
    const projectRoot = await compatibleProject(context, mutate);
    await assert.rejects(loadWorkbenchProject(projectRoot), (error) => {
      assert.equal(error.code, label === "path-traversal"
        ? "FGPM_WORKBENCH_PROJECT_PATH_INVALID" : "FGPM_WORKBENCH_PROJECT_INVALID", label);
      assert.equal(error.details.path, expectedPath, label);
      assert.equal(error.details.rule, expectedRule, label);
      assert.ok(Object.hasOwn(error.details, "supplied"), label);
      return true;
    });
  }
});

test("invalid descriptor starts only an accessible boundary diagnostic and no manager process", async (context) => {
  const projectRoot = await compatibleProject(context, (descriptor) => {
    descriptor.manager.preferred.commit = "bad";
  });
  const workbench = await startWorkbench({ projectRoot, managerRoot });
  context.after(() => workbench.close());
  assert.equal(workbench.control, null);
  assert.equal(workbench.project, null);
  assert.equal(workbench.diagnostic.code, "FGPM_WORKBENCH_PROJECT_INVALID");
  assert.equal(workbench.diagnostic.details.path, "$.manager.preferred.commit");
  assert.equal(workbench.diagnostic.details.rule, "pattern");
  const overview = await fetch(new URL("api/overview", workbench.url));
  assert.equal(overview.status, 422);
  const body = await overview.json();
  assert.equal(body.diagnostic.details.supplied, "bad");
  const [html, app] = await Promise.all([
    fetch(workbench.url).then((response) => response.text()),
    fetch(new URL("app.js", workbench.url)).then((response) => response.text()),
  ]);
  assert.match(html, /id="errors"[^>]+role="alert"[^>]+tabindex="-1"/);
  assert.match(app, /Project descriptor rejected before Workbench entry/);
  assert.match(app, /enterDiagnosticOnlyMode\(\)/);
  assert.match(app, /querySelectorAll\("button, input, select, textarea"\)/);
  assert.match(app, /error\.focus\(\)/);
});

test("exact-build preflight compares generic target facts without project identities", () => {
  const exactBuild = {
    release: "target-release",
    target: {
      platform: "win32", architecture: "x64", node: "v24.18.0",
      managerBuildIdentity: root, protocol: "fgpm.artifact-transaction/2", facts: [],
    },
    expected: { generation: root },
  };
  const matched = compareExactBuildEnvironment(exactBuild, exactBuild.target);
  assert.equal(matched.compatible, true);
  assert.equal(matched.availableActions.exactSourceRebuild, true);
  const mismatch = compareExactBuildEnvironment(exactBuild, { ...exactBuild.target, platform: "linux", node: "v22.16.0" });
  assert.equal(mismatch.compatible, false);
  assert.deepEqual(mismatch.mismatches.map((entry) => entry.dimension), ["platform", "node"]);
  assert.equal(mismatch.availableActions.importedReleaseActivation, true);
  assert.equal(mismatch.availableActions.deliberateNewGeneration, true);
  assert.equal(mismatch.availableActions.exactSourceRebuild, false);
});

test("portable workspace export/import preserves immutable identity and history through public operations", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fgpm-portable-workspace-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const first = new ControlClient(managerRoot, { managerStore: path.join(directory, "first") });
  context.after(() => first.stop());
  const created = await first.request("workspace.create", { name: "portable", actor: "portable-test" });
  const exported = await first.request("workspace.export", {
    name: "portable", directory: path.join(directory, "export"),
  });
  assert.equal(exported.workspace.revision, created.revision.identity);
  const second = new ControlClient(managerRoot, { managerStore: path.join(directory, "second") });
  context.after(() => second.stop());
  const imported = await second.request("workspace.import", { source: path.join(directory, "export") });
  assert.equal(imported.reference.workspaceIdentity, created.reference.workspaceIdentity);
  assert.equal(imported.revision.identity, created.revision.identity);
  assert.deepEqual(imported.history, [created.revision.identity]);
  assert.equal((await second.request("workspace.history", { name: "portable" })).revisions[0].identity,
    created.revision.identity);
});

test("generic Workbench source contains no Reference World identities or rules", async () => {
  const files = ["project.mjs", "journal.mjs", "replay.mjs", "server.mjs", "public/index.html", "public/app.js"];
  const contents = await Promise.all(files.map((file) => readFile(path.join(managerRoot, "tools", "curator-workbench", file), "utf8")));
  assert.doesNotMatch(contents.join("\n"), /reference-world|beacon-gold|landmark/i);
});
