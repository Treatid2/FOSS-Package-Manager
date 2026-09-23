// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildProfile } from "../src/core/build.mjs";
import { CurationManager, phase9SemanticRoot } from "../src/core/curation.mjs";
import { discoverPackages } from "../src/core/discovery.mjs";
import { GenerationRuntimeCoordinator } from "../src/core/generation-runtime.mjs";
import { hashFile, writeJson } from "../src/core/io.mjs";
import { loadProfile } from "../src/core/profile.mjs";
import { resolvePackages } from "../src/core/resolver.mjs";
import { hydrateRuntimePlan, resolveRuntimePlan, runtimeEdgeProjection } from "../src/core/runtime.mjs";

async function temporary(context, label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `fgpm-phase-9-correction-${label}-`));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function importProfileSelection(manager, profilePath) {
  const profile = await loadProfile(path.resolve(profilePath));
  const packages = await discoverPackages(profile.resolvedPackageRoots);
  const resolution = resolvePackages(packages, profile);
  const imported = [];
  for (const pkg of resolution.ordered) {
    imported.push((await manager.importPackage(pkg.directory)).package);
  }
  return imported.sort((left, right) => left.id.localeCompare(right.id));
}

async function createSelectedWorkspace(manager, name, packages) {
  const workspace = await manager.createWorkspace(name);
  await manager.stageOperations(name, packages.map((entry) => ({ type: "add", packageRoot: entry.root })), {
    expectedHead: workspace.revision.identity,
  });
  return manager.workspaceStatus(name);
}

async function commitWorkspace(manager, name, profilePath) {
  const candidate = await manager.planCandidate(name, { profilePath: path.resolve(profilePath) });
  assert.equal(candidate.status, "ready-to-build", JSON.stringify(candidate.findings));
  const build = await manager.buildCandidate(candidate.identity);
  assert.equal(build.authority.match, true);
  assert.equal(build.authority.selectionRoot, build.authority.authoritativeSelectionRoot);
  const validation = await manager.validateCandidate(build.identity);
  return manager.commitGeneration(validation.identity);
}

async function runtimeEvidence(manager, coordinator, generationRoot, snapshotPath) {
  const transition = await coordinator.transition(generationRoot);
  const host = coordinator.current.controller.host;
  await host.tick();
  const generation = await manager.showGeneration(generationRoot);
  const completeBuild = await manager.completeBuildRecord(generation.completeBuild);
  const lockfile = JSON.parse(await readFile(path.join(manager.buildClosurePath(completeBuild.closureRoot),
    "output", "fgpm.lock.json"), "utf8"));
  const scenePath = path.join(manager.buildClosurePath(completeBuild.closureRoot), "output",
    lockfile.artifact.file, lockfile.artifact.entry);
  const instances = host.capability("runtime.instances.read").list()
    .map(({ instanceId, definitionId, materialized, transform }) => ({
      instanceId, definitionId, materialized, transform,
    }));
  return {
    generationRoot,
    runtimePlanRoot: generation.roots.runtimePlan,
    activationArtifactRoot: generation.roots.activationArtifact,
    deterministicTickRoot: phase9SemanticRoot({ ticks: host.lifecycle.ticks, instances }),
    authoritativeStateRoot: phase9SemanticRoot(instances),
    sceneRoot: `sha256:${await hashFile(scenePath)}`,
    renderRoot: `sha256:${await hashFile(snapshotPath)}`,
    session: transition.session,
  };
}

async function writeChoiceProfile(root, name, roots, options = {}) {
  const base = JSON.parse(await readFile(path.resolve("profiles/base.json"), "utf8"));
  const profile = {
    ...base,
    name,
    packageRoots: [path.resolve("packages"), path.resolve("fixtures/failures/packages")],
    distribution: { ...base.distribution, roots, activation: options.activation ?? base.distribution.activation },
    policy: { ...base.policy, providers: options.providers ?? {}, adapterSelections: {},
      collectionPolicy: options.collectionPolicy ?? {} },
    user: { roots: [], replacements: {} },
  };
  const profilePath = path.join(root, `${name}.json`);
  await writeJson(profilePath, profile);
  return profilePath;
}

test("a checkpoint can resume the durably active generation in a new control process", async (context) => {
  const root = await temporary(context, "resume");
  const manager = await new CurationManager(path.join(root, "manager")).initialize();
  const profile = path.resolve("profiles/runtime-task-v2.json");
  const selected = await importProfileSelection(manager, profile);
  await createSelectedWorkspace(manager, "resume", selected);
  const committed = await commitWorkspace(manager, "resume", profile);

  const first = new GenerationRuntimeCoordinator(manager, {
    runtimeOptions: { openBrowser: false, snapshotPath: path.join(root, "before.svg") },
  });
  const orphan = { schema: "fgpm.active-generation-reference/1", version: 1,
    generation: committed.generation.identity, session: phase9SemanticRoot({ orphan: true }),
    movedAt: "2026-08-31T00:00:00.000Z" };
  await writeJson(first.activeReferencePath(), orphan);
  assert.equal((await first.activeState()).status, "stale");
  await assert.rejects(() => first.tick(1), { code: "FGPM_ACTIVE_RUNTIME_SESSION_UNAVAILABLE" });
  await first.clearStale(orphan.session);
  assert.equal((await first.activeState()).status, "stopped");
  await first.transition(committed.generation.identity);
  await first.tick(1);
  const before = await first.inspect();
  const saved = await first.checkpoint("save:test/process-resume");
  await first.shutdown();

  const second = new GenerationRuntimeCoordinator(manager, {
    runtimeOptions: { openBrowser: false, snapshotPath: path.join(root, "after.svg") },
  });
  const resumed = await second.resume(committed.generation.identity, saved.checkpoint.identity);
  const after = await second.inspect();
  assert.equal(resumed.status, "committed");
  assert.equal(after.live, true);
  assert.equal(after.generation, committed.generation.identity);
  assert.deepEqual(after.instances, before.instances);
  const resumedTicks = after.lifecycle.ticks;
  await second.tick(1);
  assert.equal((await second.inspect()).lifecycle.ticks, resumedTicks + 1);
  await second.shutdown();
});

async function buildChoice(context, label, roots, operation, options = {}) {
  const root = await temporary(context, label);
  const profilePath = await writeChoiceProfile(root, label, roots, options);
  const manager = await new CurationManager(path.join(root, "manager")).initialize();
  const selection = await importProfileSelection(manager, profilePath);
  await createSelectedWorkspace(manager, "choices", selection);
  const status = await manager.workspaceStatus("choices");
  await manager.stageOperations("choices", Array.isArray(operation) ? operation : [operation], {
    expectedHead: status.revision.identity,
  });
  const candidate = await manager.planCandidate("choices", { profilePath });
  assert.equal(candidate.status, "ready-to-build", JSON.stringify(candidate.findings));
  const build = await manager.buildCandidate(candidate.identity);
  return { candidate, complete: await manager.completeBuildRecord(build.completeBuild) };
}

test("committed runtime edges preserve early-stop safety and exact reverse shutdown", async (context) => {
  const root = await temporary(context, "lifecycle-edges");
  const manager = await new CurationManager(path.join(root, "manager")).initialize();
  const profilePath = path.resolve("profiles/runtime-task-v2.json");
  const selected = await importProfileSelection(manager, profilePath);
  await createSelectedWorkspace(manager, "lifecycle", selected);
  const committed = await commitWorkspace(manager, "lifecycle", profilePath);
  const generationRoot = committed.generation.identity;
  const closure = await manager.generationRuntimeClosure(generationRoot);
  const plan = hydrateRuntimePlan(closure.runtimePlan, closure.packageOwners, {
    generation: generationRoot,
    runtimePlanRoot: closure.runtimePlanIdentity,
  });
  const edges = runtimeEdgeProjection(plan.edges);
  const ordinaryBuild = await buildProfile(profilePath, path.join(root, "ordinary-build"));
  const ordinaryPlan = resolveRuntimePlan(ordinaryBuild);
  const ordinaryEdges = runtimeEdgeProjection(ordinaryPlan.edges);
  assert.deepEqual(edges, ordinaryEdges);
  assert.deepEqual(plan.record.activationOrder, ordinaryPlan.record.activationOrder);
  const relation = {
    consumer: "service:demo.transform-authority/1",
    provider: "service:demo.runtime-instance-store/1",
    capability: "runtime.instances.read",
  };
  assert.ok(edges.length > 0);
  assert.ok(edges.some((edge) => edge.consumer === relation.consumer && edge.provider === relation.provider));

  const missingProvider = structuredClone(closure.runtimePlan);
  const missingSelection = missingProvider.selections.find((selection) => selection.capability === relation.capability);
  missingSelection.provider = "service:missing.committed-provider/1";
  await assert.rejects(async () => hydrateRuntimePlan(missingProvider, closure.packageOwners, {
    generation: generationRoot,
    runtimePlanRoot: closure.runtimePlanIdentity,
  }), (error) => {
    assert.equal(error.code, "FGPM_COMMITTED_RUNTIME_SERVICE_MISSING");
    assert.equal(error.details.generation, generationRoot);
    assert.equal(error.details.runtimePlanRoot, closure.runtimePlanIdentity);
    assert.equal(error.details.capability, relation.capability);
    assert.equal(error.details.reason, "selected-provider-absent");
    return true;
  });

  const invalidOrder = structuredClone(closure.runtimePlan);
  const consumerIndex = invalidOrder.activationOrder.indexOf(relation.consumer);
  const providerIndex = invalidOrder.activationOrder.indexOf(relation.provider);
  [invalidOrder.activationOrder[consumerIndex], invalidOrder.activationOrder[providerIndex]]
    = [invalidOrder.activationOrder[providerIndex], invalidOrder.activationOrder[consumerIndex]];
  const serviceRecords = new Map(invalidOrder.services.map((service) => [service.id, service]));
  invalidOrder.services = invalidOrder.activationOrder.map((service) => serviceRecords.get(service));
  await assert.rejects(async () => hydrateRuntimePlan(invalidOrder, closure.packageOwners, {
    generation: generationRoot,
    runtimePlanRoot: closure.runtimePlanIdentity,
  }), (error) => {
    assert.equal(error.code, "FGPM_COMMITTED_RUNTIME_GRAPH_INVALID");
    assert.equal(error.details.reason, "activation-order-mismatch");
    assert.equal(error.details.generation, generationRoot);
    return true;
  });

  const coordinator = new GenerationRuntimeCoordinator(manager, {
    runtimeOptions: { openBrowser: false, snapshotPath: path.join(root, "scene.svg") },
  });
  const transition = await coordinator.transition(generationRoot);
  const beforeEarlyStop = await coordinator.activeReference();
  const host = coordinator.current.controller.host;
  let earlyStop;
  await assert.rejects(() => host.deactivateService(relation.provider), (error) => {
    earlyStop = { code: error.code, details: structuredClone(error.details) };
    assert.equal(error.code, "FGPM_RUNTIME_DEPENDENTS_ACTIVE");
    assert.ok(error.details.dependents.includes(relation.consumer));
    return true;
  });
  const afterEarlyStop = await coordinator.activeReference();
  assert.deepEqual(afterEarlyStop, beforeEarlyStop);
  assert.equal(coordinator.current.generation, generationRoot);
  assert.equal(coordinator.current.session, transition.session);
  const lifecycle = await coordinator.shutdown();
  const shutdownOrder = lifecycle.events.filter((entry) => entry.event === "deactivate")
    .map((entry) => entry.service);
  assert.deepEqual(shutdownOrder, [...closure.runtimePlan.activationOrder].reverse());

  const evidence = {
    schema: "fgpm.phase-9-lifecycle-edge-evidence/1",
    status: "pass",
    generationRoot,
    runtimePlanRoot: closure.runtimePlanIdentity,
    canonicalEdgeProjection: edges,
    canonicalEdgeRoot: phase9SemanticRoot(edges),
    ordinaryEdgeRoot: phase9SemanticRoot(ordinaryEdges),
    ordinaryAndCommittedEdgesMatch: true,
    activationOrder: closure.runtimePlan.activationOrder,
    relation,
    earlyStop,
    shutdownOrder,
    references: {
      generationBefore: generationRoot,
      generationAfter: generationRoot,
      sessionBefore: transition.session,
      sessionAfter: transition.session,
      activeBefore: beforeEarlyStop,
      activeAfter: afterEarlyStop,
    },
    malformed: {
      missingProvider: "FGPM_COMMITTED_RUNTIME_SERVICE_MISSING",
      activationOrder: "FGPM_COMMITTED_RUNTIME_GRAPH_INVALID",
    },
  };
  if (process.env.FGPM_PHASE9_LIFECYCLE_EVIDENCE) {
    await mkdir(path.dirname(path.resolve(process.env.FGPM_PHASE9_LIFECYCLE_EVIDENCE)), { recursive: true });
    await writeJson(path.resolve(process.env.FGPM_PHASE9_LIFECYCLE_EVIDENCE), evidence);
  }
});

test("a committed generation is the exact exported, imported, activated, ticked, rendered, and rolled-back system", async (context) => {
  const root = await temporary(context, "e2e");
  const source = await new CurationManager(path.join(root, "source-manager")).initialize();
  const baseProfile = path.resolve("profiles/runtime-task-v2.json");
  const selected = await importProfileSelection(source, baseProfile);
  await createSelectedWorkspace(source, "release", selected);

  const g0 = await commitWorkspace(source, "release", baseProfile);
  assert.equal(g0.generation.activationArtifact.schema, "fgpm.typed-artifact-reference/1");

  const generator = (await source.importPackage(path.resolve("packages/fgpm.scene-integration-generator"))).package;
  let status = await source.workspaceStatus("release");
  await source.stageOperations("release", [
    { type: "add", packageRoot: generator.root },
    {
      type: "accept-generated",
      request: {
        generatorPackageRoot: generator.root,
        generatorAction: {
          handler: "handler:fgpm.scene-integration-generator/1",
          outputType: "fgpm.generated-scene-integration/1",
        },
        inputPackageRoots: [g0.generation.packages.find((entry) => entry.id === "demo.worldspace").root],
        inputArtifactRoots: [g0.generation.roots.activationArtifact],
        parameters: { integration: "scene-index" },
        environment: { target: "portable-demo" },
        packageId: "fgpm.generated.scene-integration",
      },
    },
  ], { expectedHead: status.revision.identity });
  const g1 = await commitWorkspace(source, "release", baseProfile);
  assert.equal(g1.generation.derivedPackages.length, 1);
  const generatedTree = source.packageTreePath(g1.generation.derivedPackages[0].root);
  assert.notEqual(await readFile(path.join(generatedTree, "generated", "scene-integration.json"), "utf8"), "");

  const bundle = path.join(root, "distribution-g1");
  const distribution = await source.exportDistribution(g1.generation.identity, bundle);
  const corruptBundle = path.join(root, "distribution-g1-corrupt");
  await cp(bundle, corruptBundle, { recursive: true });
  const corruptRuntimePlan = (await readdir(path.join(corruptBundle, "build-closure")))[0];
  await writeFile(path.join(corruptBundle, "build-closure", corruptRuntimePlan, "tree", "runtime-plan.json"),
    "{}\n", "utf8");
  const corrupt = await new CurationManager(path.join(root, "corrupt-manager")).initialize();
  let corruptionCode;
  await assert.rejects(async () => {
    try { await corrupt.importDistribution(corruptBundle); } catch (error) {
      corruptionCode = error.code;
      throw error;
    }
  }, { code: "FGPM_DISTRIBUTION_MEMBER_CORRUPT" });
  const fresh = await new CurationManager(path.join(root, "fresh-manager")).initialize();
  const imported = await fresh.importDistribution(bundle);
  assert.equal(imported.generation.identity, g1.generation.identity);
  assert.equal(imported.manifest.completeBuild, g1.generation.completeBuild);

  const sourceSnapshot = path.join(root, "source.svg");
  const sourceCoordinator = new GenerationRuntimeCoordinator(source, {
    runtimeOptions: { openBrowser: false, snapshotPath: sourceSnapshot },
  });
  const sourceEvidence = await runtimeEvidence(source, sourceCoordinator, g1.generation.identity, sourceSnapshot);
  let mismatchCode;
  await assert.rejects(async () => {
    try { await sourceCoordinator.transition(g1.generation.identity, { profilePath: baseProfile }); } catch (error) {
      mismatchCode = error.code;
      throw error;
    }
  }, { code: "FGPM_GENERATION_SEMANTIC_OVERRIDE_FORBIDDEN" });
  const freshSnapshot = path.join(root, "fresh.svg");
  const freshCoordinator = new GenerationRuntimeCoordinator(fresh, {
    runtimeOptions: { openBrowser: false, snapshotPath: freshSnapshot },
  });
  const freshEvidence = await runtimeEvidence(fresh, freshCoordinator, g1.generation.identity, freshSnapshot);
  assert.deepEqual(Object.fromEntries(Object.entries(freshEvidence).filter(([key]) => key !== "session")),
    Object.fromEntries(Object.entries(sourceEvidence).filter(([key]) => key !== "session")));
  await freshCoordinator.shutdown();

  const failingProfile = path.resolve("fixtures/failures/profiles/runtime-activation-failure.json");
  const failingSelection = await importProfileSelection(source, failingProfile);
  await createSelectedWorkspace(source, "failure", failingSelection);
  const g2 = await commitWorkspace(source, "failure", failingProfile);
  const activeBeforeFailure = await sourceCoordinator.activeReference();
  let failure;
  await assert.rejects(async () => {
    try {
      await sourceCoordinator.transition(g2.generation.identity);
    } catch (error) {
      failure = error;
      throw error;
    }
  }, { code: "FGPM_GENERATION_TRANSITION_FAILED" });
  const activeAfterFailure = await sourceCoordinator.activeReference();
  assert.equal(activeAfterFailure.generation, g1.generation.identity);
  assert.notEqual(activeAfterFailure.session, activeBeforeFailure.session);
  assert.equal(failure.details.rollback.session, activeAfterFailure.session);
  assert.equal(typeof failure.details.failedAttempt, "string");
  const sessions = [];
  for (const entry of await readdir(path.join(source.directory, "runtime", "sessions"))) {
    sessions.push(JSON.parse(await readFile(path.join(source.directory, "runtime", "sessions", entry), "utf8")));
  }
  assert.equal(sessions.some((entry) => entry.generation === g2.generation.identity), false);
  assert.equal(sessions.find((entry) => entry.identity === activeAfterFailure.session).reason, "automatic-rollback");

  const evidence = {
    schema: "fgpm.phase-9-correction-end-to-end-evidence/1",
    status: "pass",
    g0: g0.generation.identity,
    g1: g1.generation.identity,
    g2: g2.generation.identity,
    distribution: distribution.identity,
    mismatch: { status: "rejected-before-transition", code: mismatchCode },
    corruption: { status: "rejected-before-import-or-activation", code: corruptionCode },
    source: sourceEvidence,
    fresh: freshEvidence,
    failedAttempt: failure.details.failedAttempt,
    rollback: {
      priorSession: activeBeforeFailure.session,
      rollbackSession: activeAfterFailure.session,
      activeGeneration: activeAfterFailure.generation,
      targetSessionCommitted: false,
    },
  };
  if (process.env.FGPM_PHASE9_CORRECTION_EVIDENCE) {
    await mkdir(path.dirname(path.resolve(process.env.FGPM_PHASE9_CORRECTION_EVIDENCE)), { recursive: true });
    await writeJson(path.resolve(process.env.FGPM_PHASE9_CORRECTION_EVIDENCE), evidence);
  }
  await sourceCoordinator.shutdown();
});

test("generation activation rejects an unrelated semantic profile override", async () => {
  const source = await readFile(path.resolve("src/cli.mjs"), "utf8");
  assert.match(source, /FGPM_GENERATION_SEMANTIC_OVERRIDE_FORBIDDEN/);
  assert.doesNotMatch(source, /phase8RuntimeFactory\(build\)/);
});

test("every accepted staged semantic choice changes the authoritative complete build", async (context) => {
  const baseRoots = ["demo.simple-runtime", "demo.scene-validator", "demo.solid-colour-adapter", "demo.worldspace"];
  const provider = await buildChoice(context, "provider-choice", [...baseRoots, "bad.alternative-transform"], [
    { type: "select-provider", requirement: "runtime.transforms/1", provider: "demo.transform-authority" },
    { type: "select-provider", requirement: "runtime.transforms.read", provider: "demo.transform-authority" },
    { type: "select-provider", requirement: "runtime.transforms.write", provider: "demo.transform-authority" },
  ]);
  assert.equal(provider.candidate.choices.providers["runtime.transforms/1"], "demo.transform-authority");
  assert.equal(provider.complete.profile.policy.providers["runtime.transforms/1"], "demo.transform-authority");

  const adapter = await buildChoice(context, "adapter-choice", [...baseRoots, "bad.second-adapter"], {
    type: "select-adapter", relation: "relation:demo.texture/base-colour-solid-to-runtime/1",
    adapter: "adapter:demo.solid-colour-to-rgba8-srgb/1",
  });
  assert.equal(adapter.complete.profile.policy.adapterSelections[
    "relation:demo.texture/base-colour-solid-to-runtime/1"], "adapter:demo.solid-colour-to-rgba8-srgb/1");

  const replacement = await buildChoice(context, "replacement-choice", [...baseRoots, "demo.green-head", "bad.head-blue"], {
    type: "select-replacement", target: "pkg:demo.character/appearance/head/base-colour",
    replacement: "pkg:bad.head-blue/texture/head-blue",
  });
  assert.equal(replacement.complete.profile.user.replacements[
    "pkg:demo.character/appearance/head/base-colour"], "pkg:bad.head-blue/texture/head-blue");

  const taskRoots = JSON.parse(await readFile(path.resolve("profiles/runtime-task-v2.json"), "utf8"))
    .distribution.roots;
  const excluded = await buildChoice(context, "collection-exclude", taskRoots, {
    type: "exclude-member", collection: "runtime.task", member: "task:demo.external-nudge-v2/add-x/1",
  }, { providers: { "runtime.scene-snapshot": "demo.scene-extractor-v2" },
    activation: "runtime:demo.runtime-task-v2/browser-svg" });
  assert.deepEqual(excluded.complete.profile.policy.collectionPolicy["runtime.task"].exclude,
    ["task:demo.external-nudge-v2/add-x/1"]);

  const included = await buildChoice(context, "collection-include", taskRoots, {
    type: "include-member", collection: "runtime.task", member: "task:demo.external-nudge-v2/add-x/1",
  }, { providers: { "runtime.scene-snapshot": "demo.scene-extractor-v2" },
    activation: "runtime:demo.runtime-task-v2/browser-svg",
    collectionPolicy: { "runtime.task": { id: "policy:test/reinclude-nudge/1",
      exclude: ["task:demo.external-nudge-v2/add-x/1"] } } });
  assert.deepEqual(included.complete.profile.policy.collectionPolicy["runtime.task"].exclude, []);
});
