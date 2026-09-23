// SPDX-License-Identifier: MPL-2.0

import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { CurationManager } from "./curation.mjs";
import { invariant } from "./errors.mjs";
import { stableJson, writeJson } from "./io.mjs";

const FAMILIES = new Set([
  "forest", "chain", "star", "diamonds", "fan-in", "fan-out", "curated-subsystem",
  "equal-providers", "large-collections", "derived-fan-out", "duplicates", "cycles",
]);

function packageId(index) {
  return `synthetic.package-${String(index).padStart(5, "0")}`;
}

function dependencyIndexes(index, count, family, seed) {
  if (count <= 1) return [];
  if (family === "chain") return index === 0 ? [] : [index - 1];
  if (["star", "fan-out", "derived-fan-out"].includes(family)) return index === 0 ? [] : [0];
  if (family === "fan-in") return index === count - 1 ? Array.from({ length: count - 1 }, (_, value) => value) : [];
  if (family === "diamonds") {
    const base = Math.floor(index / 4) * 4;
    const offset = index - base;
    if (offset === 1 || offset === 2) return [base];
    if (offset === 3) return [base + 1, base + 2].filter((value) => value < count);
    return [];
  }
  if (family === "curated-subsystem") {
    const base = Math.floor(index / 10) * 10;
    return index === base ? [] : [index - 1];
  }
  if (family === "cycles") return [index === count - 1 ? 0 : index + 1];
  if (family === "forest") {
    if (index % 7 === 0) return [];
    return [Math.max(0, Math.floor((index - 1 + (seed % 3)) / 2))].filter((value) => value < index);
  }
  return [];
}

function serviceDeclaration(id, index, family) {
  if (family === "equal-providers" && index < 2) {
    return [{
      id: `service:${id}/provider`, protocol: "fgpm.runtime-service/2",
      provides: [{ capability: "synthetic.shared", version: "1.0.0", cardinality: "exclusive" }],
      requires: [], artifactAccess: "none", artifactStoreAccess: "none", hostGrants: [], activationContract: "activation.json",
      execution: { form: "native-in-process", securityBoundary: "none", requestedPowers: ["host-user-authority"] },
      module: "./service.mjs",
    }];
  }
  if (family === "equal-providers" && index >= 2) {
    return [{
      id: `service:${id}/consumer`, protocol: "fgpm.runtime-service/2",
      provides: [{ capability: `synthetic.consumer.${index}`, version: "1.0.0", cardinality: "exclusive" }],
      requires: [{ capability: "synthetic.shared", range: "^1.0.0", cardinality: "exclusive" }],
      artifactAccess: "none", artifactStoreAccess: "none", hostGrants: [], activationContract: "activation.json",
      execution: { form: "native-in-process", securityBoundary: "none", requestedPowers: ["host-user-authority"] },
      module: "./service.mjs",
    }];
  }
  if (family === "large-collections") {
    return [{
      id: `service:${id}/member`, protocol: "fgpm.runtime-service/2",
      provides: [{
        capability: "synthetic.collection", version: "1.0.0", cardinality: "collection",
        member: `member:${id}`, binding: `synthetic.binding/${index}`, memberDependencies: [], metadata: {},
      }],
      requires: [], artifactAccess: "none", artifactStoreAccess: "none", hostGrants: [], activationContract: "activation.json",
      execution: { form: "native-in-process", securityBoundary: "none", requestedPowers: ["host-user-authority"] },
      module: "./service.mjs",
    }];
  }
  return [];
}

const serviceModule = `// SPDX-License-Identifier: Apache-2.0
export function createService() {
  return { async activate() { return { protocol: "fgpm.runtime-service-response/2", capabilities: {} }; } };
}
`;

export async function generateSyntheticPackages(directory, options = {}) {
  const count = options.count ?? 10;
  const family = options.family ?? "chain";
  const seed = options.seed ?? 9;
  invariant(Number.isInteger(count) && count >= 2, "FGPM_SYNTHETIC_COUNT_INVALID",
    "A synthetic graph requires at least two packages.", { count });
  invariant(FAMILIES.has(family), "FGPM_SYNTHETIC_FAMILY_INVALID",
    "A synthetic graph family is unsupported.", { family, supported: [...FAMILIES].sort() });
  const root = path.resolve(directory);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const packages = [];
  const physicalCount = family === "duplicates" ? count + 1 : count;
  for (let index = 0; index < physicalCount; index += 1) {
    const duplicate = family === "duplicates" && index === count;
    const identityIndex = duplicate ? 0 : index;
    const id = packageId(identityIndex);
    const packageDirectory = path.join(root, duplicate ? "duplicate-conflict" : id);
    await mkdir(packageDirectory, { recursive: true });
    const dependencies = dependencyIndexes(identityIndex, count, family, seed)
      .map((dependency) => ({ package: packageId(dependency), range: "=1.0.0" }));
    const runtimeServices = serviceDeclaration(id, identityIndex, family);
    const manifest = {
      format: "fgpm.package/2", namespace: "258690c4-84c4-4eb4-af4f-8584ae81fc2b", name: id,
      version: "1.0.0", license: "Apache-2.0",
      dependencies, runtimeServices,
    };
    await writeJson(path.join(packageDirectory, "fgpm-package.json"), manifest);
    if (runtimeServices.length > 0) {
      await writeFile(path.join(packageDirectory, "service.mjs"), serviceModule, "utf8");
      await writeJson(path.join(packageDirectory, "activation.json"), {
        schema: "fgpm.runtime-service-activation/2", service: runtimeServices[0].id,
        capabilities: Object.fromEntries(runtimeServices[0].provides.map((entry) => [entry.capability, {}])),
      });
    }
    if (duplicate) await writeFile(path.join(packageDirectory, "conflict.txt"), "different immutable bytes\n", "utf8");
    packages.push({ id, directory: packageDirectory, dependencies: dependencies.map((entry) => entry.package), duplicate });
  }
  const descriptor = {
    schema: "fgpm.synthetic-graph/1", version: 1, generator: "fgpm.phase-9-synthetic/1",
    seed, family, requestedPackageCount: count, physicalPackageCount: physicalCount,
    packages: packages.map((entry) => ({ id: entry.id, dependencies: entry.dependencies, duplicate: entry.duplicate })),
  };
  await writeJson(path.join(root, "synthetic-graph.json"), descriptor);
  return { root, packages, descriptor };
}

export async function benchmarkSyntheticGraph(directory, options = {}) {
  const count = options.count ?? 10;
  const family = options.family ?? "chain";
  const seed = options.seed ?? 9;
  const root = path.resolve(directory);
  const fixtures = path.join(root, "packages");
  const managerRoot = path.join(root, "manager");
  const generated = await generateSyntheticPackages(fixtures, { count, family, seed });
  const manager = await new CurationManager(managerRoot).initialize();
  const observations = {};
  let started = performance.now();
  const imported = [];
  for (const pkg of generated.packages.filter((entry) => !entry.duplicate)) {
    imported.push((await manager.importPackage(pkg.directory)).package);
  }
  observations.importIndexMs = performance.now() - started;
  started = performance.now();
  const workspace = await manager.createWorkspace(`benchmark-${family}-${count}`);
  observations.workspaceCreateMs = performance.now() - started;
  started = performance.now();
  await manager.stageOperations(workspace.reference.name,
    imported.map((entry) => ({ type: "add", packageRoot: entry.root })),
    { expectedHead: workspace.revision.identity, actor: "tool:fgpm.phase-9-benchmark/1" });
  observations.stageMs = performance.now() - started;
  started = performance.now();
  const candidate = await manager.planCandidate(workspace.reference.name);
  observations.candidatePlanMs = performance.now() - started;
  let generation = null;
  if (candidate.status === "ready-to-build") {
    started = performance.now();
    const build = await manager.buildCandidate(candidate.identity);
    observations.authoritativeResolutionBuildMs = performance.now() - started;
    observations.materialisation = {
      durationMs: 0, required: false, artifactCount: 0,
      reason: "synthetic package-only graph has no derived or executable artifact request",
    };
    started = performance.now();
    const validation = await manager.validateCandidate(build.identity);
    observations.authoritativeValidationMs = performance.now() - started;
    started = performance.now();
    const committed = await manager.commitGeneration(validation.identity, { actor: "tool:fgpm.phase-9-benchmark/1" });
    observations.generationCommitMs = performance.now() - started;
    generation = committed.generation;
  }
  return {
    schema: "fgpm.phase-9-benchmark-result/1", version: 1,
    deterministic: {
      generator: generated.descriptor.generator, seed, family, packageCount: count,
      candidate: candidate.identity, candidateStatus: candidate.status,
      generation: generation?.identity ?? null,
      affectedCount: candidate.impact.affected.length,
      reusableCount: candidate.impact.reusablePackageRoots.length,
      packagesVisited: candidate.packages.length,
    },
    observational: {
      ...observations,
      peakResidentBytes: process.resourceUsage().maxRSS * 1024,
      node: process.version, platform: process.platform, architecture: process.arch,
      cpu: os.cpus()[0]?.model ?? null, logicalCores: os.cpus().length,
      memoryBytes: os.totalmem(), filesystemPath: root, cold: true, workerCount: 1,
    },
  };
}

export const SYNTHETIC_FAMILIES = Object.freeze([...FAMILIES].sort());
