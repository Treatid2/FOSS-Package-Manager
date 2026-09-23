// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { buildProfile } from "../src/core/build.mjs";
import { runControlPlane } from "../src/core/control-plane.mjs";
import { CurationManager, phase9SemanticRoot } from "../src/core/curation.mjs";
import { GenerationRuntimeCoordinator, phase8RuntimeFactory } from "../src/core/generation-runtime.mjs";
import { PHASE9_DURABLE_SCHEMAS, validatePhase9Record } from "../src/core/phase9-contracts.mjs";
import { benchmarkSyntheticGraph, generateSyntheticPackages } from "../src/core/synthetic.mjs";
import { resolveRuntimePlan } from "../src/core/runtime.mjs";
import { writeJson } from "../src/core/io.mjs";

async function temporary(context, label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `fgpm-phase-9-${label}-`));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function service(id, options = {}) {
  return {
    id: `service:${id}/1`, protocol: "fgpm.runtime-service/2",
    provides: (options.provides ?? []).map((entry) => ({ cardinality: "exclusive", ...entry })),
    requires: (options.requires ?? []).map((entry) => ({ cardinality: "exclusive", ...entry })),
    artifactAccess: "none", artifactStoreAccess: "none", hostGrants: [], activationContract: "activation.json",
    execution: { form: "native-in-process", securityBoundary: "none", requestedPowers: ["host-user-authority"] },
    module: "./service.mjs",
  };
}

async function packageFixture(root, id, options = {}) {
  const directory = path.join(root, `${id}-${options.directorySuffix ?? options.version ?? "1.0.0"}`);
  const runtimeServices = options.runtimeServices ?? [];
  await writeJson(path.join(directory, "fgpm-package.json"), {
    format: "fgpm.package/2", namespace: options.namespace ?? "258690c4-84c4-4eb4-af4f-8584ae81fc2b", name: id,
    version: options.version ?? "1.0.0", license: "Apache-2.0",
    dependencies: options.dependencies ?? [], runtimeServices,
  });
  if (runtimeServices.length > 0) {
    await writeFile(path.join(directory, "service.mjs"),
      "export function createService(){return {async activate(){return {protocol:'fgpm.runtime-service-response/2',capabilities:{}};}}}\n",
      "utf8");
    await writeJson(path.join(directory, "activation.json"), {
      schema: "fgpm.runtime-service-activation/2", service: runtimeServices[0].id,
      capabilities: Object.fromEntries(runtimeServices[0].provides.map((entry) => [entry.capability, {}])),
    });
  }
  if (options.extra) await writeFile(path.join(directory, "extra.txt"), options.extra, "utf8");
  return directory;
}

async function commitCandidate(manager, workspace, runtimePlan = undefined) {
  const candidate = await manager.planCandidate(workspace, { runtimePlan });
  assert.equal(candidate.status, "ready-to-build", JSON.stringify(candidate.findings));
  const build = await manager.buildCandidate(candidate.identity);
  const validation = await manager.validateCandidate(build.identity);
  return manager.commitGeneration(validation.identity);
}

test("explicit package import is immutable, inert, idempotent, and rejects a conflicting ID/version", async (context) => {
  const root = await temporary(context, "import");
  const packages = path.join(root, "packages");
  const manager = await new CurationManager(path.join(root, "manager"), { clock: () => "2026-08-25T00:00:00Z" }).initialize();
  const firstPath = await packageFixture(packages, "phase9.alpha", { extra: "alpha\n" });
  const first = await manager.importPackage(firstPath);
  assert.equal(first.status, "imported");
  assert.equal((await manager.listPackages()).length, 1);
  assert.equal((await manager.reachabilityReport()).generationRoots.length, 0);
  assert.equal((await manager.importPackage(firstPath)).status, "reused");
  assert.equal((await manager.listPackages()).length, 1);

  const conflict = await packageFixture(packages, "phase9.alpha", { directorySuffix: "conflict", extra: "other\n" });
  await assert.rejects(() => manager.importPackage(conflict), { code: "FGPM_PACKAGE_VERSION_CONFLICT" });
  assert.equal((await manager.listPackages()).length, 1);
});

test("workspace revisions survive restart and compare-and-swap prevents a lost concurrent edit", async (context) => {
  const root = await temporary(context, "workspace");
  const packages = path.join(root, "packages");
  const managerRoot = path.join(root, "manager");
  const manager = await new CurationManager(managerRoot, { clock: () => "2026-08-25T00:00:00Z" }).initialize();
  const alpha = (await manager.importPackage(await packageFixture(packages, "phase9.alpha"))).package;
  const beta = (await manager.importPackage(await packageFixture(packages, "phase9.beta"))).package;
  const created = await manager.createWorkspace("curation-next");
  const staged = await manager.stageOperation("curation-next", { type: "add", packageRoot: alpha.root }, {
    expectedHead: created.revision.identity, actor: "author:test",
  });
  const reopened = new CurationManager(managerRoot, { clock: () => "2026-08-25T00:00:00Z" });
  assert.equal((await reopened.workspaceStatus("curation-next")).revision.identity, staged.revision.identity);
  assert.equal((await reopened.workspaceHistory("curation-next")).length, 2);

  const attempts = await Promise.allSettled([
    manager.stageOperation("curation-next", { type: "add", packageRoot: beta.root }, { expectedHead: staged.revision.identity }),
    reopened.stageOperation("curation-next", { type: "remove", packageId: "phase9.alpha" }, { expectedHead: staged.revision.identity }),
  ]);
  assert.equal(attempts.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((entry) => entry.status === "rejected")[0].reason.code, "FGPM_WORKSPACE_HEAD_CONFLICT");
});

test("candidate identity is deterministic and impact follows leaf and central causal closures", async (context) => {
  const root = await temporary(context, "candidate");
  const packages = path.join(root, "packages");
  const manager = await new CurationManager(path.join(root, "manager"), { clock: () => "2026-08-25T00:00:00Z" }).initialize();
  const core = (await manager.importPackage(await packageFixture(packages, "phase9.core"))).package;
  const leaf = (await manager.importPackage(await packageFixture(packages, "phase9.leaf", {
    dependencies: [{ package: "phase9.core", range: "=1.0.0" }],
  }))).package;
  const unrelated = (await manager.importPackage(await packageFixture(packages, "phase9.unrelated"))).package;
  const workspace = await manager.createWorkspace("impact");
  await manager.stageOperations("impact", [core, leaf, unrelated].reverse()
    .map((entry) => ({ type: "add", packageRoot: entry.root })), { expectedHead: workspace.revision.identity });
  const first = await manager.planCandidate("impact");
  const repeated = await manager.planCandidate("impact");
  assert.equal(first.identity, repeated.identity);
  assert.equal(first.status, "ready-to-build");
  const committed = await commitCandidate(manager, "impact");

  const leafV2 = (await manager.importPackage(await packageFixture(packages, "phase9.leaf", {
    version: "2.0.0", dependencies: [{ package: "phase9.core", range: "=1.0.0" }], extra: "v2\n",
  }))).package;
  let status = await manager.workspaceStatus("impact");
  await manager.stageOperation("impact", { type: "update", packageId: "phase9.leaf", packageRoot: leafV2.root },
    { expectedHead: status.revision.identity });
  const leafCandidate = await manager.planCandidate("impact");
  assert.deepEqual(leafCandidate.impact.affected.map((entry) => entry.id), ["phase9.leaf"]);
  await commitCandidate(manager, "impact");

  const coreV2 = (await manager.importPackage(await packageFixture(packages, "phase9.core", {
    version: "2.0.0", extra: "v2\n",
  }))).package;
  status = await manager.workspaceStatus("impact");
  await manager.stageOperation("impact", { type: "update", packageId: "phase9.core", packageRoot: coreV2.root },
    { expectedHead: status.revision.identity });
  const centralCandidate = await manager.planCandidate("impact");
  assert.deepEqual(centralCandidate.impact.affected.map((entry) => entry.id), ["phase9.core", "phase9.leaf"]);
  assert.ok(centralCandidate.impact.affected.find((entry) => entry.id === "phase9.leaf").causalPath
    .includes("dependant:phase9.leaf"));
  assert.equal(committed.generation.packages.length, 3);
});

test("candidate planning satisfies exact cross-namespace coordinates and retains unqualified dependencies", async (context) => {
  const root = await temporary(context, "qualified-dependencies");
  const packages = path.join(root, "packages");
  const manager = await new CurationManager(path.join(root, "manager")).initialize();
  const providerNamespace = "4c3f55e5-6045-49ae-bce5-714ff77938f4";
  const provider = (await manager.importPackage(await packageFixture(packages, "phase9.qualified-provider", {
    namespace: providerNamespace,
  }))).package;
  const unqualified = (await manager.importPackage(await packageFixture(packages, "phase9.unqualified-provider"))).package;
  const consumer = (await manager.importPackage(await packageFixture(packages, "phase9.qualified-consumer", {
    dependencies: [
      { package: `${providerNamespace}/phase9.qualified-provider`, range: "=1.0.0" },
      { package: "phase9.unqualified-provider", range: "=1.0.0" },
    ],
  }))).package;
  const workspace = await manager.createWorkspace("qualified-dependencies");
  await manager.stageOperations("qualified-dependencies", [provider, unqualified, consumer]
    .map((entry) => ({ type: "add", packageRoot: entry.root })), { expectedHead: workspace.revision.identity });

  const candidate = await manager.planCandidate("qualified-dependencies");
  assert.equal(candidate.status, "ready-to-build", JSON.stringify(candidate.findings));
  assert.deepEqual(candidate.indexes.dependencies["phase9.qualified-consumer"],
    ["phase9.qualified-provider", "phase9.unqualified-provider"]);
  assert.deepEqual(candidate.indexes.reverseDependencies["phase9.qualified-provider"],
    ["phase9.qualified-consumer"]);
  assert.equal(candidate.indexes.reverseDependencies[`${providerNamespace}/phase9.qualified-provider`], undefined);
});

test("qualified dependencies reject the right readable ID under the wrong namespace", async (context) => {
  const root = await temporary(context, "qualified-wrong-namespace");
  const packages = path.join(root, "packages");
  const manager = await new CurationManager(path.join(root, "manager")).initialize();
  const requiredNamespace = "4c3f55e5-6045-49ae-bce5-714ff77938f4";
  const wrongNamespace = "258690c4-84c4-4eb4-af4f-8584ae81fc2b";
  const provider = (await manager.importPackage(await packageFixture(packages, "phase9.namespace-target", {
    namespace: wrongNamespace,
  }))).package;
  const consumer = (await manager.importPackage(await packageFixture(packages, "phase9.namespace-consumer", {
    dependencies: [{ package: `${requiredNamespace}/phase9.namespace-target`, range: "=1.0.0" }],
  }))).package;
  const workspace = await manager.createWorkspace("qualified-wrong-namespace");
  await manager.stageOperations("qualified-wrong-namespace", [provider, consumer]
    .map((entry) => ({ type: "add", packageRoot: entry.root })), { expectedHead: workspace.revision.identity });

  const candidate = await manager.planCandidate("qualified-wrong-namespace");
  assert.equal(candidate.status, "blocked");
  assert.deepEqual(candidate.findings.map((entry) => ({ code: entry.code, dependency: entry.dependency })), [{
    code: "FGPM_CANDIDATE_DEPENDENCY_MISSING",
    dependency: `${requiredNamespace}/phase9.namespace-target`,
  }]);
});

test("qualified dependencies do not combine a matching namespace with a separately matching readable ID", async (context) => {
  const root = await temporary(context, "qualified-conflicting-components");
  const packages = path.join(root, "packages");
  const manager = await new CurationManager(path.join(root, "manager")).initialize();
  const requiredNamespace = "4c3f55e5-6045-49ae-bce5-714ff77938f4";
  const otherNamespace = "258690c4-84c4-4eb4-af4f-8584ae81fc2b";
  const matchingNamespace = (await manager.importPackage(await packageFixture(packages, "phase9.other-name", {
    namespace: requiredNamespace,
  }))).package;
  const matchingId = (await manager.importPackage(await packageFixture(packages, "phase9.component-target", {
    namespace: otherNamespace,
  }))).package;
  const consumer = (await manager.importPackage(await packageFixture(packages, "phase9.component-consumer", {
    dependencies: [{ package: `${requiredNamespace}/phase9.component-target`, range: "=1.0.0" }],
  }))).package;
  const workspace = await manager.createWorkspace("qualified-conflicting-components");
  await manager.stageOperations("qualified-conflicting-components", [matchingNamespace, matchingId, consumer]
    .map((entry) => ({ type: "add", packageRoot: entry.root })), { expectedHead: workspace.revision.identity });

  const candidate = await manager.planCandidate("qualified-conflicting-components");
  assert.equal(candidate.status, "blocked");
  assert.equal(candidate.findings.length, 1);
  assert.equal(candidate.findings[0].code, "FGPM_CANDIDATE_DEPENDENCY_MISSING");
  assert.equal(candidate.findings[0].dependency, `${requiredNamespace}/phase9.component-target`);
});

test("provider ambiguity blocks until an explicit attributed choice is persisted", async (context) => {
  const root = await temporary(context, "ambiguity");
  const packages = path.join(root, "packages");
  const manager = await new CurationManager(path.join(root, "manager")).initialize();
  const provider = (id) => service(id, { provides: [{ capability: "phase9.shared", version: "1.0.0" }] });
  const consumer = service("phase9.consumer", { provides: [{ capability: "phase9.consumer", version: "1.0.0" }],
    requires: [{ capability: "phase9.shared", range: "^1.0.0" }] });
  const records = [];
  records.push((await manager.importPackage(await packageFixture(packages, "phase9.provider-a", {
    runtimeServices: [provider("phase9.provider-a")],
  }))).package);
  records.push((await manager.importPackage(await packageFixture(packages, "phase9.provider-b", {
    runtimeServices: [provider("phase9.provider-b")],
  }))).package);
  records.push((await manager.importPackage(await packageFixture(packages, "phase9.consumer", {
    runtimeServices: [consumer],
  }))).package);
  const workspace = await manager.createWorkspace("providers");
  await manager.stageOperations("providers", records.map((entry) => ({ type: "add", packageRoot: entry.root })),
    { expectedHead: workspace.revision.identity });
  assert.equal((await manager.planCandidate("providers")).findings[0].code, "FGPM_CANDIDATE_PROVIDER_AMBIGUOUS");
  const current = await manager.workspaceStatus("providers");
  await manager.stageOperation("providers", {
    type: "select-provider", requirement: "phase9.shared", provider: "phase9.provider-a",
  }, { expectedHead: current.revision.identity, actor: "author:test-choice" });
  const resolved = await manager.planCandidate("providers");
  assert.equal(resolved.status, "ready-to-build");
  assert.equal(resolved.choices.providers["phase9.shared"], "phase9.provider-a");
});

test("derived packages reuse exact inputs, invalidate changed inputs, and reject recursion", async (context) => {
  const root = await temporary(context, "derived");
  const packages = path.join(root, "packages");
  const manager = await new CurationManager(path.join(root, "manager"), { clock: () => "2026-08-25T00:00:00Z" }).initialize();
  const generator = (await manager.importPackage(path.resolve("packages/fgpm.scene-integration-generator"))).package;
  const input = (await manager.importPackage(await packageFixture(packages, "phase9.input"))).package;
  const request = {
    generatorPackageRoot: generator.root,
    generatorAction: {
      handler: "handler:fgpm.scene-integration-generator/1",
      outputType: "fgpm.generated-scene-integration/1",
    },
    inputPackageRoots: [input.root],
    inputArtifactRoots: [], parameters: { mode: "merge" },
    environment: { target: "portable" }, packageId: "phase9.derived-integration",
  };
  const first = await manager.materializeDerivedPackage(request);
  const repeated = await manager.materializeDerivedPackage(request);
  assert.equal(first.identity, repeated.identity);
  assert.equal(first.outputPackageRoot, repeated.outputPackageRoot);
  const inputV2 = (await manager.importPackage(await packageFixture(packages, "phase9.input", {
    version: "2.0.0", extra: "changed\n",
  }))).package;
  const changed = await manager.materializeDerivedPackage({ ...request, inputPackageRoots: [inputV2.root] });
  assert.notEqual(first.outputPackageRoot, changed.outputPackageRoot);
  const parameterChanged = await manager.materializeDerivedPackage({ ...request, parameters: { mode: "index" } });
  assert.notEqual(first.outputPackageRoot, parameterChanged.outputPackageRoot);
  const environmentChanged = await manager.materializeDerivedPackage({ ...request,
    environment: { target: "different-portable-target" } });
  assert.notEqual(first.outputPackageRoot, environmentChanged.outputPackageRoot);
  await manager.importPackage(await packageFixture(packages, "phase9.unrelated"));
  assert.equal((await manager.materializeDerivedPackage(request)).outputPackageRoot, first.outputPackageRoot);
  const generatorV2Path = path.join(root, "generator-v2");
  await cp(path.resolve("packages/fgpm.scene-integration-generator"), generatorV2Path, { recursive: true });
  const generatorManifest = JSON.parse(await readFile(path.join(generatorV2Path, "fgpm-package.json"), "utf8"));
  await writeJson(path.join(generatorV2Path, "fgpm-package.json"), { ...generatorManifest, version: "0.1.1" });
  const generatorV2 = (await manager.importPackage(generatorV2Path)).package;
  const generatorChanged = await manager.materializeDerivedPackage({ ...request,
    generatorPackageRoot: generatorV2.root });
  assert.notEqual(first.outputPackageRoot, generatorChanged.outputPackageRoot);
  assert.notEqual(await readFile(path.join(manager.packageTreePath(first.outputPackageRoot),
    "generated", "scene-integration.json"), "utf8"), "");
  await assert.rejects(() => manager.materializeDerivedPackage({ ...request,
    inputPackageRoots: [`sha256:${"0".repeat(64)}`] }), { code: "FGPM_DERIVED_INPUT_PACKAGE_MISSING" });
  await assert.rejects(() => manager.materializeDerivedPackage({ ...request, generatedRequests: [{}] }),
    { code: "FGPM_DERIVED_DEPTH_UNSUPPORTED" });

  const workspace = await manager.createWorkspace("derived");
  await manager.stageOperations("derived", [
    { type: "add", packageRoot: generator.root }, { type: "add", packageRoot: input.root },
    { type: "accept-generated", request },
  ], { expectedHead: workspace.revision.identity });
  const committed = await commitCandidate(manager, "derived");
  const derivedRoot = committed.generation.derivedPackages[0].root;
  const status = await manager.workspaceStatus("derived");
  await manager.stageOperation("derived", { type: "update", packageId: "phase9.input", packageRoot: inputV2.root },
    { expectedHead: status.revision.identity });
  const invalidated = await manager.planCandidate("derived");
  assert.ok(invalidated.impact.invalidatedDerived.includes(derivedRoot));
});

test("generation publication is atomic, stale commits fail, and concurrent commits have one winner", async (context) => {
  const root = await temporary(context, "commit");
  const packages = path.join(root, "packages");
  const manager = await new CurationManager(path.join(root, "manager"), { clock: () => "2026-08-25T00:00:00Z" }).initialize();
  const alpha = (await manager.importPackage(await packageFixture(packages, "phase9.alpha"))).package;
  const workspace = await manager.createWorkspace("commit");
  await manager.stageOperation("commit", { type: "add", packageRoot: alpha.root }, { expectedHead: workspace.revision.identity });
  const candidate = await manager.planCandidate("commit");
  const validation = await manager.validateCandidate((await manager.buildCandidate(candidate.identity)).identity);
  const before = (await manager.workspaceStatus("commit")).revision.identity;
  await assert.rejects(() => manager.commitGeneration(validation.identity, { interruptAfterGenerationPublish: true }),
    { code: "FGPM_SIMULATED_GENERATION_INTERRUPTION" });
  assert.equal((await manager.workspaceStatus("commit")).revision.identity, before);
  const outcomes = await Promise.allSettled([
    manager.commitGeneration(validation.identity), manager.commitGeneration(validation.identity),
  ]);
  assert.equal(outcomes.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((entry) => entry.status === "rejected")[0].reason.code, "FGPM_CANDIDATE_STALE");
});

test("expected generation mismatch fails before immutable publication or workspace authority moves", async (context) => {
  const root = await temporary(context, "expected-generation");
  const packages = path.join(root, "packages");
  const manager = await new CurationManager(path.join(root, "manager"), {
    clock: () => "2026-08-25T00:00:00Z",
  }).initialize();
  const alpha = (await manager.importPackage(await packageFixture(packages, "phase9.alpha"))).package;
  const workspace = await manager.createWorkspace("expected-generation");
  await manager.stageOperation("expected-generation", { type: "add", packageRoot: alpha.root }, {
    expectedHead: workspace.revision.identity,
  });
  const candidate = await manager.planCandidate("expected-generation");
  const validation = await manager.validateCandidate((await manager.buildCandidate(candidate.identity)).identity);
  const before = await manager.workspaceStatus("expected-generation");
  const wrong = `sha256:${"f".repeat(64)}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(() => manager.commitGeneration(validation.identity, { expectedGenerationRoot: wrong }),
      (error) => {
        assert.equal(error.code, "FGPM_GENERATION_ROOT_MISMATCH");
        assert.equal(error.details.expectedGenerationRoot, wrong);
        assert.equal(error.details.authoritativeRevision, before.reference.revision);
        assert.equal(error.details.authoritativeBaseGeneration, before.reference.baseGeneration);
        assert.match(error.details.predictedGenerationRoot, /^sha256:[0-9a-f]{64}$/);
        return true;
      });
    const after = await manager.workspaceStatus("expected-generation");
    assert.equal(after.reference.revision, before.reference.revision);
    assert.equal(after.reference.baseGeneration, before.reference.baseGeneration);
    assert.equal(after.revision.identity, before.revision.identity);
  }
  assert.deepEqual(await manager.retainedGenerationRoots(), []);
  const committed = await manager.commitGeneration(validation.identity, {
    expectedGenerationRoot: phase9SemanticRoot({
      schema: "unused-for-prediction-test",
    }),
  }).catch((error) => error);
  assert.equal(committed.code, "FGPM_GENERATION_ROOT_MISMATCH");
  const predicted = committed.details.predictedGenerationRoot;
  const success = await manager.commitGeneration(validation.identity, { expectedGenerationRoot: predicted });
  assert.equal(success.generation.identity, predicted);
});

test("self-contained distribution replay reproduces identity and rejects corruption or omission", async (context) => {
  const root = await temporary(context, "distribution");
  const packages = path.join(root, "packages");
  const manager = await new CurationManager(path.join(root, "manager")).initialize();
  const alpha = (await manager.importPackage(await packageFixture(packages, "phase9.alpha"))).package;
  const workspace = await manager.createWorkspace("release");
  await manager.stageOperation("release", { type: "add", packageRoot: alpha.root }, { expectedHead: workspace.revision.identity });
  const committed = await commitCandidate(manager, "release");
  const bundle = path.join(root, "distribution");
  const manifest = await manager.exportDistribution(committed.generation.identity, bundle);
  const fresh = await new CurationManager(path.join(root, "fresh-manager")).initialize();
  const imported = await fresh.importDistribution(bundle);
  assert.equal(imported.generation.identity, committed.generation.identity);
  assert.deepEqual(imported.generation.runtimePlan, committed.generation.runtimePlan);
  assert.equal(imported.generation.runtimePlan.deterministicTickRoot,
    committed.generation.runtimePlan.deterministicTickRoot);
  assert.equal(imported.generation.runtimePlan.visibleOutputRoot,
    committed.generation.runtimePlan.visibleOutputRoot);

  const shuffled = JSON.parse(await readFile(path.join(bundle, "distribution.json"), "utf8"));
  shuffled.files.reverse();
  await writeJson(path.join(bundle, "distribution.json"), shuffled);
  assert.equal((await fresh.verifyDistribution(bundle)).manifest.identity, manifest.identity);

  const missingBundle = path.join(root, "distribution-missing");
  const missingManifest = await manager.exportDistribution(committed.generation.identity, missingBundle);
  await rm(path.join(missingBundle, missingManifest.files[0].path), { force: true });
  await assert.rejects(() => fresh.verifyDistribution(missingBundle), { code: "FGPM_DISTRIBUTION_MEMBER_SET_INVALID" });

  const member = manifest.files.find((entry) => entry.path !== "generation.json");
  await writeFile(path.join(bundle, member.path), "corrupt\n", "utf8");
  await assert.rejects(() => fresh.verifyDistribution(bundle), { code: "FGPM_DISTRIBUTION_MEMBER_CORRUPT" });
});

test("package exit blocks depended-on removal and retains parent-generation package roots", async (context) => {
  const root = await temporary(context, "exit");
  const packages = path.join(root, "packages");
  const manager = await new CurationManager(path.join(root, "manager")).initialize();
  const core = (await manager.importPackage(await packageFixture(packages, "phase9.exit-core"))).package;
  const dependant = (await manager.importPackage(await packageFixture(packages, "phase9.exit-dependant", {
    dependencies: [{ package: "phase9.exit-core", range: "=1.0.0" }],
  }))).package;
  const workspace = await manager.createWorkspace("exit");
  await manager.stageOperations("exit", [core, dependant].map((entry) => ({ type: "add", packageRoot: entry.root })),
    { expectedHead: workspace.revision.identity });
  const g0 = await commitCandidate(manager, "exit");
  let status = await manager.workspaceStatus("exit");
  await manager.stageOperation("exit", { type: "remove", packageId: "phase9.exit-core" },
    { expectedHead: status.revision.identity });
  const blocked = await manager.planCandidate("exit");
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.findings.find((entry) => entry.code === "FGPM_CANDIDATE_DEPENDENCY_MISSING").package,
    "phase9.exit-dependant");
  assert.deepEqual(blocked.impact.affected.map((entry) => entry.id), ["phase9.exit-core", "phase9.exit-dependant"]);

  const clean = await manager.forkWorkspace(g0.generation.identity, "exit-leaf");
  await manager.stageOperation("exit-leaf", { type: "remove", packageId: "phase9.exit-dependant" },
    { expectedHead: clean.revision.identity });
  const next = await commitCandidate(manager, "exit-leaf");
  assert.equal(next.generation.packages.some((entry) => entry.id === "phase9.exit-dependant"), false);
  const reachability = await manager.reachabilityReport();
  assert.ok(reachability.generationRoots.includes(g0.generation.identity));
  assert.ok(reachability.retainedPackageRoots.includes(dependant.root));
  assert.equal(reachability.destructive, false);
});

function fakeRuntimeFactory(label, events, options = {}) {
  return async ({ checkpoint }) => {
    events.push(`${label}:activate${checkpoint ? ":restore" : ""}`);
    if (options.failActivation) throw new Error(`${label} activation failed`);
    if (checkpoint && options.failRestore) throw new Error(`${label} restore failed`);
    return {
      async checkpoint(saveId) {
        events.push(`${label}:checkpoint`);
        return { schema: "fgpm.world-save-commit/1", saveId,
          root: phase9SemanticRoot({ label, saveId }), fragments: options.fragments ?? [] };
      },
      async commit() { events.push(`${label}:commit`); return { label, restored: Boolean(checkpoint) }; },
      async shutdown() { events.push(`${label}:shutdown`); return { label, state: "stopped" }; },
    };
  };
}

async function syntheticGeneration(manager, label, owners = []) {
  const candidate = phase9SemanticRoot({ candidate: label });
  const runtimePlan = { schema: "fgpm.generation-runtime-plan/1", services: [], collections: [],
    stateOwners: owners, tasks: [], deterministicTickRoot: phase9SemanticRoot({ tick: label }),
    visibleOutputRoot: phase9SemanticRoot({ visible: label }) };
  const identityInputs = { schema: "fgpm.generation/1", version: 1, parent: null, candidate,
    packages: [], derivedPackages: [], choices: {}, target: {}, policy: {}, runtimePlan,
    stateOwners: owners, activationArtifact: null,
    completeBuild: phase9SemanticRoot({ completeBuild: label }),
    roots: { runtimePlan: phase9SemanticRoot(runtimePlan) },
    publicContract: "fgpm.public-contract-bundle/phase-8", manager: "test" };
  return manager.writeImmutable("generations", identityInputs, {
    schema: "fgpm.generation/1", version: 1, parent: null, workspaceRevision: phase9SemanticRoot({ workspace: label }),
    candidate, packages: [], derivedPackages: [], choices: {}, target: {}, policy: {}, runtimePlan,
    stateOwners: owners, activationArtifact: null, completeBuild: identityInputs.completeBuild,
    roots: identityInputs.roots,
    publicContract: identityInputs.publicContract, manager: "test",
    impact: { schema: "fgpm.impact-report/1", changes: [], affected: [], reusablePackageRoots: [],
      invalidatedDerived: [], transitionClass: "full-generation-restart" },
  });
}

test("the exact shipped JSONL lifecycle proves checkpoint publication, replay, and distinct-generation rollback", async (context) => {
  const root = await temporary(context, "persistent-control");
  const manager = await new CurationManager(path.join(root, "manager")).initialize();
  const g0 = await syntheticGeneration(manager, "control-g0");
  const g1 = await syntheticGeneration(manager, "control-g1");
  const events = [];
  const runtimeFactory = (label) => async () => {
    const lifecycle = { schema: "fgpm.test-runtime-lifecycle/1", state: "live", ticks: 0 };
    const host = {
      lifecycle,
      async tick() { lifecycle.ticks += 1; events.push(`${label}:tick`); },
      capability(name) {
        assert.equal(name, "runtime.instances.read");
        return { list: () => [] };
      },
    };
    return {
      host,
      async checkpoint(saveId) {
        events.push(`${label}:checkpoint`);
        return { schema: "fgpm.world-save-commit/1", saveId,
          root: phase9SemanticRoot({ label, saveId }), fragments: [] };
      },
      async commit() { events.push(`${label}:commit`); return { label }; },
      async shutdown() { lifecycle.state = "stopped"; events.push(`${label}:shutdown`); return lifecycle; },
    };
  };
  const coordinator = new GenerationRuntimeCoordinator(manager, { allowTestFactories: true });
  coordinator.register(g0.identity, runtimeFactory("g0"));
  coordinator.register(g1.identity, runtimeFactory("g1"));
  assert.notEqual(g0.identity, g1.identity);
  const requestTemplate = await readFile(path.resolve(
    "authoring-kit/runtime-task-v2/control-lifecycle.jsonl"), "utf8");
  const uniqueSaveId = `control-${path.basename(root)}`;
  const requests = requestTemplate
    .replaceAll("sha256:<generation-root>", g0.identity)
    .replaceAll("sha256:<previous-generation-root>", g1.identity)
    .replaceAll("<unique-checkpoint-save-id>", uniqueSaveId)
    .trim();
  const expected = JSON.parse(await readFile(path.resolve(
    "authoring-kit/runtime-task-v2/control-lifecycle-expected.json"), "utf8"));
  const resolvedRequests = requests.split(/\r?\n/u).map((line) => JSON.parse(line));
  const input = new PassThrough();
  let output = "";
  const sink = new Writable({ write(chunk, encoding, callback) { output += chunk.toString(); callback(); } });
  input.end(`${requests}\n`);
  await runControlPlane(manager, coordinator, { input, output: sink });
  const responses = output.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line))
    .filter((entry) => entry.schema === "fgpm.control-response/1");
  assert.equal(responses.length, resolvedRequests.length);
  assert.equal(expected.responses.length, resolvedRequests.length);
  const mismatches = [];
  let session = null;
  for (let index = 0; index < expected.responses.length; index += 1) {
    const wanted = expected.responses[index];
    const actualRequest = resolvedRequests[index];
    const actual = responses[index];
    const compare = (field, expectedValue, actualValue) => {
      try {
        assert.deepEqual(actualValue, expectedValue);
      } catch {
        mismatches.push({ requestId: wanted.requestId, field,
          expected: expectedValue, actual: actualValue });
      }
    };
    compare("request.requestId", wanted.requestId, actualRequest.requestId);
    compare("request.operation", wanted.operation, actualRequest.operation);
    compare("response.requestId", wanted.requestId, actual.requestId);
    compare("response.operation", wanted.operation, actual.operation);
    compare("response.ok", wanted.ok, actual.ok);
    compare("result.schema", wanted.resultSchema, actual.result?.schema);
    compare("authority.projection", "combined-manager-runtime", actual.authority?.projection);
    compare("authority.moved", wanted.authorityMoved, actual.authority?.moved);
    compare("authority.managerMoved", wanted.managerMoved, actual.authority?.managerMoved);
    compare("authority.runtimeMoved", wanted.runtimeMoved, actual.authority?.runtimeMoved);
    if (wanted.publicationClass) {
      compare("result.publication.class", wanted.publicationClass, actual.result?.publication?.class);
      compare("result.publication.saveId", `save:author/${uniqueSaveId}`,
        actual.result?.publication?.saveId);
      compare("result.publication.checkpointIdentity", actual.result?.checkpoint?.identity,
        actual.result?.publication?.checkpointIdentity);
      compare("result.publication.contentRoot", actual.result?.checkpoint?.root,
        actual.result?.publication?.contentRoot);
    }
    if (wanted.transitionClass) {
      compare("result.transitionClass", wanted.transitionClass, actual.result?.transitionClass);
      compare("result.preflight.transitionClass", wanted.transitionClass,
        actual.result?.preflight?.transitionClass);
    }
    if (wanted.sessionExpectation === "established") {
      if (typeof actual.result?.session !== "string") mismatches.push({ requestId: wanted.requestId,
        field: "result.session", expected: "new string", actual: actual.result?.session });
      session = actual.result?.session;
    } else if (wanted.sessionExpectation === "replaced") {
      if (typeof actual.result?.session !== "string" || actual.result.session === session) {
        mismatches.push({ requestId: wanted.requestId, field: "result.session",
          expected: "different session", actual: actual.result?.session });
      }
      session = actual.result?.session;
    } else if (wanted.sessionExpectation === "preserved") {
      if (actual.result?.session !== undefined) compare("result.session", session, actual.result.session);
      else compare("authority.runtimeMoved for preserved session", false, actual.authority.runtimeMoved);
    } else if (wanted.sessionExpectation === "stopped") {
      compare("result active status", "stopped", actual.result?.status ?? actual.result?.active?.status);
      session = null;
    }
  }
  assert.deepEqual(mismatches, [], `lifecycle expectation mismatches:\n${JSON.stringify(mismatches, null, 2)}`);
  const activation = responses.find((entry) => entry.requestId === "03-activate").result;
  const rollback = responses.find((entry) => entry.requestId === "08-rollback").result;
  assert.equal(activation.to, g0.identity);
  assert.equal(rollback.from, g0.identity);
  assert.equal(rollback.to, g1.identity);
  assert.notEqual(activation.session, rollback.session);
  assert.equal((await coordinator.activeState()).status, "stopped");
  assert.deepEqual(events, ["g0:commit", "g0:tick", "g0:checkpoint", "g0:checkpoint", "g0:checkpoint", "g0:shutdown",
    "g1:commit", "g1:shutdown"]);
});

test("same-generation activation is named reactivation and is not misreported as rollback", async (context) => {
  const root = await temporary(context, "same-generation-reactivation");
  const manager = await new CurationManager(path.join(root, "manager")).initialize();
  const generation = await syntheticGeneration(manager, "reactivation");
  const events = [];
  const coordinator = new GenerationRuntimeCoordinator(manager, { allowTestFactories: true });
  coordinator.register(generation.identity, fakeRuntimeFactory("reactivation", events));
  const first = await coordinator.transition(generation.identity);
  const second = await coordinator.transition(generation.identity);
  assert.equal(second.from, generation.identity);
  assert.equal(second.to, generation.identity);
  assert.equal(second.transitionClass, "same-generation-reactivation");
  assert.equal(second.preflight.transitionClass, "same-generation-reactivation");
  assert.notEqual(first.session, second.session);
  await assert.rejects(() => coordinator.rollback(generation.identity), {
    code: "FGPM_GENERATION_ROLLBACK_TARGET_UNCHANGED",
  });
  await coordinator.shutdown();
  assert.deepEqual(events, ["reactivation:activate", "reactivation:commit", "reactivation:checkpoint",
    "reactivation:shutdown", "reactivation:activate:restore", "reactivation:commit",
    "reactivation:shutdown"]);
});

test("rollback requires an owned live session before target construction", async (context) => {
  const root = await temporary(context, "rollback-owned-live-session");
  const manager = await new CurationManager(path.join(root, "manager")).initialize();
  const g0 = await syntheticGeneration(manager, "rollback-owned-g0");
  const g1 = await syntheticGeneration(manager, "rollback-owned-g1");
  const events = [];
  const coordinator = new GenerationRuntimeCoordinator(manager, { allowTestFactories: true });
  coordinator.register(g0.identity, fakeRuntimeFactory("owned-g0", events));
  coordinator.register(g1.identity, fakeRuntimeFactory("owned-g1", events));

  await assert.rejects(() => coordinator.rollback(g0.identity), {
    code: "FGPM_GENERATION_ROLLBACK_SESSION_REQUIRED",
  });
  assert.deepEqual(events, [], "a stopped-state rollback must not construct the target runtime");
  assert.equal(await coordinator.activeReference(), null);

  await coordinator.transition(g0.identity);
  const active = await coordinator.activeReference();
  const staleCoordinator = new GenerationRuntimeCoordinator(manager, { allowTestFactories: true });
  staleCoordinator.register(g1.identity, fakeRuntimeFactory("stale-g1", events));
  await assert.rejects(() => staleCoordinator.rollback(g1.identity), {
    code: "FGPM_ACTIVE_RUNTIME_SESSION_STALE",
  });
  assert.deepEqual(await staleCoordinator.activeReference(), active);
  assert.equal(events.includes("stale-g1:activate"), false);

  await assert.rejects(() => coordinator.rollback(g0.identity), {
    code: "FGPM_GENERATION_ROLLBACK_TARGET_UNCHANGED",
  });
  const rolledBack = await coordinator.rollback(g1.identity);
  assert.equal(rolledBack.transitionClass, "distinct-generation-rollback");
  assert.equal(rolledBack.from, g0.identity);
  assert.equal(rolledBack.to, g1.identity);
  await coordinator.shutdown();

  const eventsAfterShutdown = [...events];
  await assert.rejects(() => coordinator.rollback(g0.identity), {
    code: "FGPM_GENERATION_ROLLBACK_SESSION_REQUIRED",
  });
  assert.deepEqual(events, eventsAfterShutdown,
    "rollback after runtime.shutdown must not construct the target runtime");
  assert.equal(await coordinator.activeReference(), null);
});

test("runtime factory registration is an explicit internal test-only seam", async (context) => {
  const root = await temporary(context, "runtime-factory-boundary");
  const manager = await new CurationManager(path.join(root, "manager")).initialize();
  const generation = await syntheticGeneration(manager, "factory-boundary");
  const factory = fakeRuntimeFactory("fixture", []);
  assert.throws(() => new GenerationRuntimeCoordinator(manager).register(generation.identity, factory), {
    code: "FGPM_RUNTIME_TEST_FACTORY_FORBIDDEN",
  });
  const internal = new GenerationRuntimeCoordinator(manager, { allowTestFactories: true });
  assert.equal(internal.register(generation.identity, factory), internal);
});

test("runtime generation handover commits the active reference last and restores the old generation on failure", async (context) => {
  const root = await temporary(context, "runtime");
  const manager = await new CurationManager(path.join(root, "manager"), { clock: () => "2026-08-25T00:00:00Z" }).initialize();
  const owner = { id: "state-owner:required/1", required: true, semanticSchema: "phase9.required", schemaVersion: 1 };
  const g0 = await syntheticGeneration(manager, "g0", [owner]);
  const g1 = await syntheticGeneration(manager, "g1", [owner]);
  const bad = await syntheticGeneration(manager, "bad", [owner]);
  const restoreBad = await syntheticGeneration(manager, "restore-bad", [owner]);
  const events = [];
  const fragments = [{ member: owner.id, required: true, semanticSchema: owner.semanticSchema,
    schemaVersion: 1, root: phase9SemanticRoot({ fragment: "required" }) }];
  const coordinator = new GenerationRuntimeCoordinator(manager, {
    clock: () => "2026-08-25T00:00:00Z",
    allowTestFactories: true,
  });
  coordinator.register(g0.identity, fakeRuntimeFactory("g0", events, { fragments }));
  coordinator.register(g1.identity, fakeRuntimeFactory("g1", events));
  coordinator.register(bad.identity, fakeRuntimeFactory("bad", events, { failActivation: true }));
  coordinator.register(restoreBad.identity, fakeRuntimeFactory("restore-bad", events, { failRestore: true }));
  const initial = await coordinator.transition(g0.identity);
  assert.equal(initial.active.generation, g0.identity);
  const beforeFailure = await coordinator.activeReference();
  await assert.rejects(() => coordinator.transition(restoreBad.identity), { code: "FGPM_GENERATION_TRANSITION_FAILED" });
  const afterRestoreFailure = await coordinator.activeReference();
  assert.equal(afterRestoreFailure.generation, beforeFailure.generation);
  assert.notEqual(afterRestoreFailure.session, beforeFailure.session);
  await assert.rejects(() => coordinator.transition(bad.identity), { code: "FGPM_GENERATION_TRANSITION_FAILED" });
  const afterFailure = await coordinator.activeReference();
  assert.equal(afterFailure.generation, beforeFailure.generation);
  assert.notEqual(afterFailure.session, afterRestoreFailure.session);
  assert.ok(events.indexOf("g0:checkpoint") < events.indexOf("g0:shutdown"));
  assert.ok(events.includes("g0:activate:restore"));
  const moved = await coordinator.transition(g1.identity);
  assert.equal(moved.active.generation, g1.identity);
  const rolledBack = await coordinator.rollback(g0.identity);
  assert.equal(rolledBack.active.generation, g0.identity);
  assert.notEqual(rolledBack.active.session, initial.active.session);
  await coordinator.shutdown();
});

test("required owner removal blocks before shutdown while optional state is retained opaquely", async (context) => {
  const root = await temporary(context, "state-exit");
  const manager = await new CurationManager(path.join(root, "manager")).initialize();
  const required = { id: "state-owner:required/1", required: true };
  const optional = { id: "state-owner:optional/1", required: false };
  const g0 = await syntheticGeneration(manager, "g0-state", [required, optional]);
  const noRequired = await syntheticGeneration(manager, "no-required", []);
  const optionalOnlyRemoval = await syntheticGeneration(manager, "optional-removal", [required]);
  const events = [];
  const fragments = [
    { member: required.id, required: true, root: phase9SemanticRoot({ required: true }) },
    { member: optional.id, required: false, root: phase9SemanticRoot({ optional: true }) },
  ];
  const coordinator = new GenerationRuntimeCoordinator(manager, { allowTestFactories: true });
  coordinator.register(g0.identity, fakeRuntimeFactory("g0", events, { fragments }));
  coordinator.register(noRequired.identity, fakeRuntimeFactory("no-required", events));
  coordinator.register(optionalOnlyRemoval.identity, fakeRuntimeFactory("optional-removal", events));
  await coordinator.transition(g0.identity);
  await assert.rejects(() => coordinator.transition(noRequired.identity), { code: "FGPM_GENERATION_REQUIRED_STATE_OWNER_MISSING" });
  assert.equal(events.filter((entry) => entry === "g0:shutdown").length, 0);
  const transition = await coordinator.transition(optionalOnlyRemoval.identity);
  assert.deepEqual(transition.preflight.retainedOpaque.map((entry) => entry.owner), [optional.id]);
  await coordinator.shutdown();
});

async function generationForBuild(manager, label, build) {
  const plan = resolveRuntimePlan(build).record;
  const stateOwners = (plan.collections.find((entry) => entry.capability === "runtime.state.owner")?.members ?? [])
    .map((entry) => ({
      id: entry.id, package: entry.package, required: entry.metadata?.required === true,
      semanticSchema: entry.metadata?.semanticSchema ?? null, schemaVersion: entry.metadata?.schemaVersion ?? null,
    }));
  const runtimePlan = {
    schema: "fgpm.generation-runtime-plan/1", services: plan.services, collections: plan.collections,
    stateOwners, tasks: plan.collections.find((entry) => entry.capability === "runtime.task")?.members ?? [],
    deterministicTickRoot: phase9SemanticRoot({ label, plan, kind: "tick" }),
    visibleOutputRoot: phase9SemanticRoot({ label, artifact: build.lockfile.artifact, kind: "visible" }),
  };
  const candidate = phase9SemanticRoot({ label, candidate: build.lockfile.artifact.hash });
  const identityInputs = { schema: "fgpm.generation/1", version: 1, parent: null, candidate,
    packages: [], derivedPackages: [], choices: {}, target: build.profile.layers.target, policy: {}, runtimePlan,
    stateOwners, activationArtifact: null,
    completeBuild: phase9SemanticRoot({ completeBuild: label, artifact: build.lockfile.artifact.hash }),
    roots: { runtimePlan: phase9SemanticRoot(runtimePlan) },
    publicContract: "fgpm.public-contract-bundle/phase-8", manager: "org.foss-package-manager.reference@0.9.0" };
  return manager.writeImmutable("generations", identityInputs, {
    schema: "fgpm.generation/1", version: 1, parent: null,
    workspaceRevision: phase9SemanticRoot({ label, workspace: true }), candidate,
    packages: [], derivedPackages: [], choices: {}, target: identityInputs.target, policy: {}, runtimePlan,
    stateOwners, activationArtifact: null, completeBuild: identityInputs.completeBuild, roots: identityInputs.roots,
    publicContract: identityInputs.publicContract, manager: identityInputs.manager,
    impact: { schema: "fgpm.impact-report/1", changes: [], affected: [], reusablePackageRoots: [],
      invalidatedDerived: [], transitionClass: "full-generation-restart" },
  });
}

test("the generation coordinator performs a real Phase 8 runtime checkpoint, restore, and failed-activation rollback", async (context) => {
  const root = await temporary(context, "runtime-integration");
  const storeDirectory = path.join(root, "artifact-store");
  const base = await buildProfile(path.resolve("profiles/base.json"), path.join(root, "base"), { storeDirectory });
  const green = await buildProfile(path.resolve("profiles/green-head.json"), path.join(root, "green"), { storeDirectory });
  const failing = await buildProfile(path.resolve("fixtures/failures/profiles/runtime-activation-failure.json"),
    path.join(root, "failing"), { storeDirectory });
  const manager = await new CurationManager(path.join(root, "manager")).initialize();
  const g0 = await generationForBuild(manager, "base", base);
  const g1 = await generationForBuild(manager, "green", green);
  const bad = await generationForBuild(manager, "failing", failing);
  const coordinator = new GenerationRuntimeCoordinator(manager, { allowTestFactories: true });
  coordinator.register(g0.identity, phase8RuntimeFactory(base, { openBrowser: false,
    snapshotPath: path.join(root, "base.svg") }));
  coordinator.register(g1.identity, phase8RuntimeFactory(green, { openBrowser: false,
    snapshotPath: path.join(root, "green.svg") }));
  coordinator.register(bad.identity, phase8RuntimeFactory(failing, { openBrowser: false }));
  await coordinator.transition(g0.identity);
  await coordinator.current.controller.host.tick();
  await coordinator.current.controller.host.tick();
  const before = coordinator.current.controller.host.capability("runtime.instances.read").list();
  const semanticInstances = (entries) => entries.map(({ instanceId, definitionId, materialized }) => ({
    instanceId, definitionId, materialized,
  }));
  const moved = await coordinator.transition(g1.identity);
  const restored = coordinator.current.controller.host.capability("runtime.instances.read").list();
  assert.deepEqual(semanticInstances(restored), semanticInstances(before));
  assert.equal(moved.active.generation, g1.identity);
  const activeBeforeFailure = await coordinator.activeReference();
  await assert.rejects(() => coordinator.transition(bad.identity), { code: "FGPM_GENERATION_TRANSITION_FAILED" });
  const activeAfterFailure = await coordinator.activeReference();
  assert.equal(activeAfterFailure.generation, activeBeforeFailure.generation);
  assert.notEqual(activeAfterFailure.session, activeBeforeFailure.session);
  assert.deepEqual(semanticInstances(coordinator.current.controller.host.capability("runtime.instances.read").list()),
    semanticInstances(before));
  await coordinator.shutdown();
  assert.notEqual(await readFile(path.join(root, "base.svg"), "utf8"), "");
  assert.notEqual(await readFile(path.join(root, "green.svg"), "utf8"), "");
});

test("synthetic graphs enter through public package imports and retain bounded scale observations", async (context) => {
  const root = await temporary(context, "synthetic");
  const generated = await generateSyntheticPackages(path.join(root, "fixture"), { count: 10, family: "diamonds", seed: 42 });
  assert.equal(generated.descriptor.packages.length, 10);
  const result = await benchmarkSyntheticGraph(path.join(root, "benchmark"), { count: 10, family: "chain", seed: 42 });
  assert.equal(result.deterministic.packageCount, 10);
  assert.equal(result.deterministic.candidateStatus, "ready-to-build");
  assert.equal(result.deterministic.packagesVisited, 10);
  assert.ok(result.observational.importIndexMs >= 0);
});

test("Phase 9 durable contracts validate the public example and reject unknown fields", async () => {
  const example = JSON.parse(await readFile(path.resolve("contracts/phase-9/examples/workspace-reference.json"), "utf8"));
  assert.equal(validatePhase9Record(example).schema, "fgpm.workspace-reference/1");
  assert.throws(() => validatePhase9Record({
    schema: "fgpm.installed-index/1", version: 1, packages: [], ambientWinner: "load-order",
  }), { code: "FGPM_PHASE9_UNKNOWN_FIELD" });
});

test("Phase 9 contract index covers every durable identity with split closed schemas", async () => {
  const root = path.resolve("contracts/phase-9");
  const index = JSON.parse(await readFile(path.join(root, "index.json"), "utf8"));
  assert.equal(index.unknownFieldPolicy, "closed");
  const indexed = [];
  for (const entry of index.schemas) {
    assert.equal(entry.classification, "public-cross-process");
    assert.match(entry.steward, /^fgpm\./);
    const schema = JSON.parse(await readFile(path.join(root, entry.file), "utf8"));
    assert.equal(schema["x-fgpm-classification"], "public-cross-process");
    assert.match(schema["x-fgpm-identity-rule"], /identity|reference/i);
    for (const reference of schema.oneOf) {
      const definition = schema.$defs[reference.$ref.split("/").at(-1)];
      assert.equal(definition.additionalProperties, false);
    }
    indexed.push(...entry.identities);
  }
  assert.deepEqual(indexed.sort(), [...PHASE9_DURABLE_SCHEMAS]);
});
