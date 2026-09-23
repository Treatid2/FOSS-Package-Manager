#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CurationManager } from "../src/core/curation.mjs";
import { benchmarkSyntheticGraph, generateSyntheticPackages } from "../src/core/synthetic.mjs";
import { readJson, writeJson } from "../src/core/io.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const output = path.resolve(argument("--out", path.join(repository, "evidence", "phase-9", "benchmark-results.json")));
const work = path.resolve(argument("--work", path.join(repository, "build", "phase-9-benchmarks")));
const seed = Number(argument("--seed", "9009"));
const sizes = argument("--sizes", "10,100,1000").split(",").map(Number);

async function incrementalEvidence(runRoot, count) {
  const manager = new CurationManager(path.join(runRoot, "manager"));
  const workspace = `benchmark-chain-${count}`;
  const packagesRoot = path.join(runRoot, "packages");
  const leafId = `synthetic.package-${String(count - 1).padStart(5, "0")}`;
  const leafPath = path.join(runRoot, "updates", `${leafId}-v2`);
  await mkdir(leafPath, { recursive: true });
  const leafManifest = await readJson(path.join(packagesRoot, leafId, "fgpm-package.json"));
  await writeJson(path.join(leafPath, "fgpm-package.json"), { ...leafManifest, version: "2.0.0" });
  await writeFile(path.join(leafPath, "changed.txt"), "leaf update\n", "utf8");
  const leaf = (await manager.importPackage(leafPath)).package;
  let status = await manager.workspaceStatus(workspace);
  await manager.stageOperation(workspace, { type: "update", packageId: leafId, packageRoot: leaf.root },
    { expectedHead: status.revision.identity, actor: "tool:fgpm.phase-9-benchmark/1" });
  const leafCandidate = await manager.planCandidate(workspace);
  let leafAuthority = null;
  if (leafCandidate.status === "ready-to-build") {
    const build = await manager.buildCandidate(leafCandidate.identity);
    const validation = await manager.validateCandidate(build.identity);
    await manager.commitGeneration(validation.identity, { actor: "tool:fgpm.phase-9-benchmark/1" });
    leafAuthority = build.authority;
  }

  const centralId = "synthetic.package-00000";
  const centralPath = path.join(runRoot, "updates", `${centralId}-v2`);
  await mkdir(centralPath, { recursive: true });
  const centralManifest = await readJson(path.join(packagesRoot, centralId, "fgpm-package.json"));
  await writeJson(path.join(centralPath, "fgpm-package.json"), { ...centralManifest, version: "2.0.0" });
  await writeFile(path.join(centralPath, "changed.txt"), "central update\n", "utf8");
  const central = (await manager.importPackage(centralPath)).package;
  status = await manager.workspaceStatus(workspace);
  await manager.stageOperation(workspace, { type: "update", packageId: centralId, packageRoot: central.root },
    { expectedHead: status.revision.identity, actor: "tool:fgpm.phase-9-benchmark/1" });
  const centralCandidate = await manager.planCandidate(workspace);
  return {
    packageCount: count,
    leaf: { candidate: leafCandidate.identity, affectedCount: leafCandidate.impact.affected.length,
      packagesVisited: leafCandidate.packages.length, reusableCount: leafCandidate.impact.reusablePackageRoots.length,
      status: leafCandidate.status, authority: leafAuthority },
    central: { candidate: centralCandidate.identity, affectedCount: centralCandidate.impact.affected.length,
      packagesVisited: centralCandidate.packages.length, reusableCount: centralCandidate.impact.reusablePackageRoots.length,
      status: centralCandidate.status, findings: centralCandidate.findings.map((entry) => entry.code) },
  };
}

async function selectedVersusInstalled(root) {
  const generated = await generateSyntheticPackages(path.join(root, "packages"), { count: 1000, family: "chain", seed });
  const manager = await new CurationManager(path.join(root, "manager")).initialize();
  const selected = [];
  for (const pkg of generated.packages.slice(0, 100)) selected.push((await manager.importPackage(pkg.directory)).package);
  const workspace = await manager.createWorkspace("selected-100");
  await manager.stageOperations("selected-100", selected.map((entry) => ({ type: "add", packageRoot: entry.root })),
    { expectedHead: workspace.revision.identity, actor: "tool:fgpm.phase-9-benchmark/1" });
  const before = await manager.planCandidate("selected-100");
  for (const pkg of generated.packages.slice(100)) await manager.importPackage(pkg.directory);
  const after = await manager.planCandidate("selected-100");
  return {
    selectedPackages: 100, installedBefore: 100, installedAfter: (await manager.listPackages()).length,
    candidateBefore: before.identity, candidateAfter: after.identity,
    identicalCandidate: before.identity === after.identity,
    runtimePlanBefore: before.runtimePlan, runtimePlanAfter: after.runtimePlan,
    identicalRuntimePlan: JSON.stringify(before.runtimePlan) === JSON.stringify(after.runtimePlan),
  };
}

function diagnosticService(id, provided, required = []) {
  return {
    id: `service:${id}/diagnostic`, protocol: "fgpm.runtime-service/2",
    provides: provided.map((capability) => ({ capability, version: "1.0.0", cardinality: "exclusive" })),
    requires: required.map((capability) => ({ capability, range: "^1.0.0", cardinality: "exclusive" })),
    artifactAccess: "none", artifactStoreAccess: "none", hostGrants: [],
    execution: { form: "native-in-process", securityBoundary: "none", requestedPowers: ["host-user-authority"] },
    module: "./service.mjs", activationContract: "activation.json",
  };
}

async function addDiagnosticService(directory, service) {
  const manifestPath = path.join(directory, "fgpm-package.json");
  const manifest = await readJson(manifestPath);
  manifest.runtimeServices = [service];
  await writeJson(manifestPath, manifest);
  await writeFile(path.join(directory, "service.mjs"),
    "export function createService(){return {async activate(){return {protocol:'fgpm.runtime-service-response/2',capabilities:{}};}}}\n", "utf8");
  await writeJson(path.join(directory, "activation.json"), {
    schema: "fgpm.runtime-service-activation/2", service: service.id,
    capabilities: Object.fromEntries(service.provides.map((entry) => [entry.capability, {}])),
  });
}

async function diagnosticLocality(root) {
  const generated = await generateSyntheticPackages(path.join(root, "packages"), { count: 1000, family: "chain", seed });
  const byIndex = (index) => generated.packages[index].directory;
  const missingManifest = await readJson(path.join(byIndex(500), "fgpm-package.json"));
  missingManifest.dependencies.push({ package: "synthetic.missing", range: "=1.0.0" });
  await writeJson(path.join(byIndex(500), "fgpm-package.json"), missingManifest);
  const localCycle = await readJson(path.join(byIndex(997), "fgpm-package.json"));
  localCycle.dependencies = [{ package: "synthetic.package-00999", range: "=1.0.0" }];
  await writeJson(path.join(byIndex(997), "fgpm-package.json"), localCycle);
  await addDiagnosticService(byIndex(0), diagnosticService("synthetic.package-00000", ["synthetic.ambiguous"]));
  await addDiagnosticService(byIndex(1), diagnosticService("synthetic.package-00001", ["synthetic.ambiguous"]));
  await addDiagnosticService(byIndex(2), diagnosticService("synthetic.package-00002", ["synthetic.consumer"], ["synthetic.ambiguous"]));

  const manager = await new CurationManager(path.join(root, "manager")).initialize();
  const imported = [];
  for (const pkg of generated.packages) imported.push((await manager.importPackage(pkg.directory)).package);
  const duplicatePath = path.join(root, "duplicate-conflict");
  await cp(byIndex(10), duplicatePath, { recursive: true });
  await writeFile(path.join(duplicatePath, "different.txt"), "different immutable bytes\n", "utf8");
  let duplicateDiagnostic;
  try { await manager.importPackage(duplicatePath); } catch (error) {
    duplicateDiagnostic = { code: error.code, details: error.details };
  }
  const workspace = await manager.createWorkspace("diagnostics-1000");
  await manager.stageOperations("diagnostics-1000", imported.map((entry) => ({ type: "add", packageRoot: entry.root })),
    { expectedHead: workspace.revision.identity, actor: "tool:fgpm.phase-9-benchmark/1" });
  const candidate = await manager.planCandidate("diagnostics-1000");
  const select = (code) => candidate.findings.find((entry) => entry.code === code) ?? null;
  return {
    packageCount: 1000, candidate: candidate.identity, status: candidate.status,
    ambiguity: select("FGPM_CANDIDATE_PROVIDER_AMBIGUOUS"),
    missingDependency: select("FGPM_CANDIDATE_DEPENDENCY_MISSING"),
    cycle: select("FGPM_CANDIDATE_DEPENDENCY_CYCLE"), duplicate: duplicateDiagnostic,
  };
}

await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });
const scale = [];
const incremental = [];
for (const count of sizes) {
  const runRoot = path.join(work, `chain-${count}`);
  scale.push(await benchmarkSyntheticGraph(runRoot, { count, family: "chain", seed }));
  incremental.push(await incrementalEvidence(runRoot, count));
}
const report = {
  schema: "fgpm.phase-9-benchmark-report/1", version: 1,
  scope: { acceptanceSizes: sizes, exploratory10000: "deferred: acceptance is through 1,000 packages" },
  scale, incremental,
  selectedVersusInstalled: await selectedVersusInstalled(path.join(work, "selected-vs-installed")),
  diagnosticLocality: await diagnosticLocality(path.join(work, "diagnostics")),
  claims: {
    complexityClass: "not-claimed",
    productionPerformance: "not-claimed",
    interpretation: "impact planning, authoritative resolution/build, validation, no-op package-only materialisation, and generation commit are reported separately",
    priorSimplifiedPlannerTimingsRelabelled: false,
  },
};
await mkdir(path.dirname(output), { recursive: true });
await writeJson(output, report);
console.log(JSON.stringify({ output, sizes, status: "complete" }, null, 2));
