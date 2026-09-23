// SPDX-License-Identifier: MPL-2.0

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildProfile } from "./build.mjs";
import { invariant, publicErrorRecord } from "./errors.mjs";
import { stableJson, writeJson } from "./io.mjs";
import { referenceDoctor, referenceIdentity } from "./reference-tools.mjs";
import { startRuntime } from "./runtime.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const installedRoot = path.resolve(process.env.FGPM_DISTRIBUTION_ROOT ?? repository);
const focusDelayMs = 40;

function digest(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function valueIdentity(value) {
  return digest(stableJson(value));
}

async function fileIdentity(file) {
  return digest(await readFile(file));
}

async function treeIdentity(base, relativeRoots) {
  const entries = [];
  async function visit(absolute, relative) {
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      const childAbsolute = path.join(absolute, entry.name);
      const childRelative = path.join(relative, entry.name).replaceAll("\\", "/");
      if (entry.isDirectory()) await visit(childAbsolute, childRelative);
      else if (entry.isFile()) entries.push({ path: childRelative, sha256: await fileIdentity(childAbsolute) });
    }
  }
  for (const relative of relativeRoots) await visit(path.join(base, relative), relative);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return { root: digest(stableJson(entries)), files: entries.length };
}

function gitIdentity() {
  try {
    const safeDirectory = repository.replaceAll("\\", "/");
    const run = (...args) => execFileSync("git", ["-c", `safe.directory=${safeDirectory}`, ...args], {
      cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const status = run("status", "--porcelain=v1", "--untracked-files=all", "--", "src", "public", "packages");
    return {
      available: true,
      commit: run("rev-parse", "HEAD"),
      branch: run("branch", "--show-current") || null,
      coreDirty: status.length > 0,
      coreStatusRoot: digest(status),
    };
  } catch (error) {
    return { available: false, commit: null, branch: null, coreDirty: null,
      coreStatusRoot: null, reason: error.message };
  }
}

function conformanceSelection(host, focusMember) {
  const collection = host.plan.record.collections.find((entry) => entry.capability === "runtime.task");
  invariant(collection, "FGPM_RUNTIME_TASK_CONFORMANCE_COLLECTION_MISSING",
    "The selected runtime does not expose the runtime.task collection required for conformance.");
  const members = collection.members.map((entry) => entry.id).sort();
  invariant(members.includes(focusMember), "FGPM_RUNTIME_TASK_CONFORMANCE_FOCUS_NOT_SELECTED",
    "The conformance focus is not a selected runtime.task collection member.", {
      focus: focusMember, collection: "runtime.task", selectedMembers: members,
    });

  const channelPlan = host.capability("runtime.scheduler.records").channelPlan();
  const contributors = channelPlan.contributors.map((entry) => entry.task).sort();
  invariant(contributors.includes(focusMember), "FGPM_RUNTIME_TASK_CONFORMANCE_FOCUS_NOT_RELEVANT",
    "The conformance focus does not contribute to the scheduler's relevant command channel.", {
      focus: focusMember, collection: "runtime.task", channel: channelPlan.channel, contributors,
    });
  const peers = contributors.filter((member) => member !== focusMember);
  invariant(peers.length > 0, "FGPM_RUNTIME_TASK_CONFORMANCE_PEER_MISSING",
    "Runtime-task conformance requires another selected channel contributor for the peer-delay case.", {
      focus: focusMember, channel: channelPlan.channel, contributors,
    });
  return {
    collection: "runtime.task",
    channel: channelPlan.channel,
    focus: focusMember,
    peer: peers[0],
    peerSelectionReason: "lexicographically-first-other-selected-channel-contributor",
    selectedMembers: members,
    contributors,
  };
}

function configurations(selection) {
  return [
    { id: "single-worker", workerCount: 1, memberDelays: {} },
    { id: "focus-delayed", workerCount: 4,
      memberDelays: { [selection.focus]: focusDelayMs } },
    { id: "peer-delayed", workerCount: 4,
      memberDelays: { [selection.peer]: focusDelayMs } },
  ];
}

export async function runRuntimeTaskConformance(profilePath, outputDirectory, options = {}) {
  invariant(typeof options.focusMember === "string" && options.focusMember.startsWith("task:"),
    "FGPM_RUNTIME_TASK_CONFORMANCE_FOCUS_REQUIRED",
    "Runtime-task conformance requires --focus <exact-task-member>.", {
      focus: options.focusMember ?? null,
    });
  const root = path.resolve(outputDirectory);
  await mkdir(root, { recursive: true });
  const storeDirectory = path.join(root, ".fgpm-store");
  const profile = path.resolve(profilePath);
  const toolIdentity = await referenceIdentity(installedRoot);
  const distributed = toolIdentity.distribution?.contentRoot !== null;
  if (distributed) {
    const doctor = await referenceDoctor(installedRoot);
    invariant(doctor.status === "pass", "FGPM_DISTRIBUTION_TAMPERED",
      "The installed reference distribution failed integrity verification before conformance.", {
        failures: doctor.checks.filter((entry) => entry.status === "fail"),
      });
  }
  const publicContracts = distributed
    ? { root: toolIdentity.publicContracts.root,
      files: (await readdir(path.join(installedRoot, "public"), { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile()).length }
    : await treeIdentity(repository, ["public"]);
  const auditRoots = distributed ? ["."] : ["src", "public", "packages"];
  const toolBefore = await treeIdentity(installedRoot, auditRoots);
  const managerPackage = distributed
    ? { name: toolIdentity.manager.id, version: toolIdentity.manager.version }
    : JSON.parse(await readFile(path.join(repository, "package.json"), "utf8"));
  const managerGit = distributed ? null : gitIdentity();
  const outcomes = [];
  let installedDistribution = null;
  let selection = null;

  async function commonEvidence(toolAfter) {
    const unchanged = stableJson(toolBefore) === stableJson(toolAfter);
    return {
      environment: {
        manager: {
          identity: `${managerPackage.name}@${managerPackage.version}`,
          buildIdentity: toolIdentity.manager.buildIdentity,
          distributionKind: toolIdentity.distribution.kind,
          sourceCommit: toolIdentity.source.commit,
          ...(distributed ? { installationRoot: installedRoot } : {
            sourceRoot: repository,
            git: managerGit,
            cli: { entry: path.join(repository, "src", "cli.mjs"),
              sha256: await fileIdentity(path.join(repository, "src", "cli.mjs")) },
          }),
        },
        node: { version: process.version, executable: process.execPath, platform: process.platform,
          architecture: process.arch },
        invocation: { workingDirectory: process.cwd(),
          packageRoots: (options.packageRoots ?? []).map((rootPath) => path.resolve(rootPath)) },
      },
      inputs: {
        profile: { path: profile, root: await fileIdentity(profile),
          sha256: await fileIdentity(profile) },
        identities: {
          managerSemanticBuild: toolIdentity.manager.buildIdentity,
          runtimeImplementationPayload: toolIdentity.runtime?.implementationPayloadRoot,
          toolDistributionContent: toolIdentity.distribution?.contentRoot,
          publicContractSet: toolIdentity.publicContracts?.root ?? publicContracts.root,
          sealedFixture: toolIdentity.fixture?.root,
        },
        publicContracts: { path: path.join(installedRoot, "public"), ...publicContracts },
        installedDistribution,
      },
      toolBeforeAfterAudit: {
        scope: distributed ? "installed-source-free-distribution" : "internal-source-checkout",
        roots: auditRoots,
        before: toolBefore,
        after: toolAfter,
        unchanged,
      },
      coreBeforeAfterAudit: { scope: auditRoots, before: toolBefore, after: toolAfter, unchanged },
    };
  }

  async function runConfiguration(configuration) {
    const runDirectory = path.join(root, configuration.id);
    const snapshotPath = path.join(runDirectory, "scene.svg");
    let built;
    try {
      built = await buildProfile(profilePath, runDirectory, {
        storeDirectory,
        packageRoots: options.packageRoots ?? [],
      });
    } catch (error) {
      return {
        status: "fail", configuration, publicError: publicErrorRecord(error),
        inputTransformRoot: null, postTransformRoot: null, authoritativeStateUnchanged: true,
        mutationCommitted: false, successfulTickCommitted: false, observational: null, error,
      };
    }
    const distribution = {
      identity: digest(stableJson(built.lockfile)),
      packages: built.resolution.ordered.map((pkg) => ({ id: pkg.id, version: pkg.version,
        contentHash: `sha256:${pkg.contentHash}` })).sort((left, right) => left.id.localeCompare(right.id)),
    };
    if (installedDistribution === null) installedDistribution = distribution;
    else invariant(stableJson(distribution) === stableJson(installedDistribution),
      "FGPM_RUNTIME_TASK_CONFORMANCE_DISTRIBUTION_CHANGED",
      "Conformance configurations did not resolve one installed distribution identity.", {
        expected: installedDistribution.identity, actual: distribution.identity, configuration: configuration.id,
      });

    const host = await startRuntime(built, {
      snapshotPath,
      schedulerWorkerCount: configuration.workerCount,
      schedulerDelays: configuration.memberDelays,
    });
    try {
      const selected = conformanceSelection(host, options.focusMember);
      if (selection === null) selection = selected;
      else invariant(stableJson(selected) === stableJson(selection),
        "FGPM_RUNTIME_TASK_CONFORMANCE_SELECTION_CHANGED",
        "Conformance configurations did not retain the same focus and peer selection.", {
          configuration: configuration.id, expected: selection, actual: selected,
        });
      const before = host.capability("runtime.transforms.read").snapshot();
      const inputTransformRoot = valueIdentity(before);
      try {
        await host.tick();
      } catch (error) {
        const records = host.capability("runtime.scheduler.records");
        const after = host.capability("runtime.transforms.read").snapshot();
        const postRoot = valueIdentity(after);
        const trace = records.trace().at(-1) ?? null;
        const publicError = publicErrorRecord(error);
        return {
          status: "fail",
          configuration,
          publicError,
          inputTransformRoot,
          inputTransformRevision: before.revision ?? null,
          postTransformRoot: postRoot,
          postTransformRevision: after.revision ?? null,
          authoritativeStateUnchanged: inputTransformRoot === postRoot,
          mutationCommitted: publicError.details.mutationCommitted ?? trace?.committed ?? false,
          successfulTickCommitted: records.latest() !== null,
          observational: trace,
          error,
        };
      }
      const records = host.capability("runtime.scheduler.records");
      const record = records.latest();
      const trace = records.trace().at(-1);
      const transform = host.capability("runtime.transforms.read").snapshot();
      const outputTransformRoot = record.result.stateRoot;
      invariant(record.snapshots.at(-1)?.root === inputTransformRoot,
        "FGPM_RUNTIME_TASK_CONFORMANCE_INPUT_ROOT_MISMATCH",
        "The deterministic record input root does not match the pre-tick authoritative snapshot.", {
          configuration: configuration.id, record: record.snapshots.at(-1)?.root, actual: inputTransformRoot,
        });
      invariant(outputTransformRoot === valueIdentity(transform),
        "FGPM_RUNTIME_TASK_CONFORMANCE_OUTPUT_ROOT_MISMATCH",
        "The deterministic record output root does not match post-commit authoritative state.", {
          configuration: configuration.id, record: outputTransformRoot, actual: valueIdentity(transform),
        });
      const svg = await readFile(snapshotPath, "utf8");
      return {
        status: "pass",
        configuration,
        deterministic: { identity: record.identity, record, transform, svg },
        inputTransformRoot,
        outputTransformRoot,
        observational: { completionOrder: trace.completionOrder, executions: trace.executions,
          workerCount: trace.workerCount },
      };
    } finally {
      await host.shutdown();
    }
  }

  const first = await runConfiguration({ id: "single-worker", workerCount: 1, memberDelays: {} });
  if (first.status === "fail") {
    const toolAfter = await treeIdentity(installedRoot, auditRoots);
    const report = await failedReport(first, toolAfter);
    const reportPath = path.join(root, "runtime-task-conformance.json");
    await writeJson(reportPath, report);
    return { report, reportPath, error: first.error };
  }

  outcomes.push(first);
  const matrix = configurations(selection);
  for (const configuration of matrix.slice(1)) {
    const outcome = await runConfiguration(configuration);
    if (outcome.status === "fail") {
      const toolAfter = await treeIdentity(installedRoot, auditRoots);
      const report = await failedReport(outcome, toolAfter, outcomes.map((entry) => entry.configuration.id));
      const reportPath = path.join(root, "runtime-task-conformance.json");
      await writeJson(reportPath, report);
      return { report, reportPath, error: outcome.error };
    }
    outcomes.push(outcome);
  }

  async function failedReport(outcome, toolAfter, completedRuns = []) {
    const details = outcome.publicError.details ?? {};
    return {
      schema: "fgpm.runtime-task-conformance-report/2",
      status: "fail",
      generatedAtUtc: new Date().toISOString(),
      ...await commonEvidence(toolAfter),
      selection,
      configuration: outcome.configuration,
      failure: {
        code: outcome.publicError.code,
        message: outcome.publicError.message,
        details,
        channel: details.channel ?? selection?.channel ?? null,
        vocabulary: details.vocabulary ?? null,
        steward: details.steward ?? null,
        stage: details.stage ?? null,
        law: details.law ?? null,
        target: { instanceId: details.instanceId ?? null, axis: details.axis ?? null,
          key: details.instanceId && details.axis ? `${details.instanceId}#${details.axis}` : null },
        contributors: details.contributors ?? [],
        focus: selection?.focus ?? options.focusMember,
        peer: selection?.peer ?? null,
        preAuthoritativeStateRoot: outcome.inputTransformRoot,
        postAuthoritativeStateRoot: outcome.postTransformRoot,
        preAuthoritativeStateRevision: outcome.inputTransformRevision ?? null,
        postAuthoritativeStateRevision: outcome.postTransformRevision ?? null,
        authoritativeStateUnchanged: outcome.authoritativeStateUnchanged,
        authoritativeStateObserved: outcome.inputTransformRoot !== null,
        mutationCommitted: outcome.mutationCommitted,
        successfulTickCommitted: outcome.successfulTickCommitted,
      },
      claims: {
        authoritativeStateUnchanged: outcome.authoritativeStateUnchanged,
        authoritativeStateObserved: outcome.inputTransformRoot !== null,
        mutationNotCommitted: outcome.mutationCommitted === false,
        successfulTickNotCommitted: outcome.successfulTickCommitted === false,
        managerCoreUnchanged: stableJson(toolBefore) === stableJson(toolAfter),
        toolDistributionUnchanged: stableJson(toolBefore) === stableJson(toolAfter),
      },
      completedRuns,
      observational: outcome.observational,
    };
  }

  const baseline = outcomes[0].deterministic;
  const deterministicInvariant = outcomes.every((outcome) => stableJson(outcome.deterministic) === stableJson(baseline));
  const observedOrders = new Set(outcomes.map((outcome) => JSON.stringify(outcome.observational.completionOrder)));
  const focusOrder = stableJson(outcomes.find((outcome) => outcome.configuration.id === "focus-delayed")
    .observational.completionOrder);
  const peerOrder = stableJson(outcomes.find((outcome) => outcome.configuration.id === "peer-delayed")
    .observational.completionOrder);
  invariant(deterministicInvariant, "FGPM_RUNTIME_TASK_CONFORMANCE_FAILED",
    "Worker conformance configurations changed deterministic runtime evidence.", {
      identities: outcomes.map((outcome) => ({ configuration: outcome.configuration.id,
        identity: outcome.deterministic.identity, outputTransformRoot: outcome.outputTransformRoot })),
    });
  invariant(focusOrder !== peerOrder, "FGPM_RUNTIME_TASK_CONFORMANCE_ORDER_UNCHANGED",
    "Delaying the focus and peer contributors did not produce distinct observational completion orders.", {
      focus: selection.focus, peer: selection.peer,
    });
  const toolAfter = await treeIdentity(installedRoot, auditRoots);
  const report = {
    schema: "fgpm.runtime-task-conformance-report/2",
    status: "pass",
    generatedAtUtc: new Date().toISOString(),
    ...await commonEvidence(toolAfter),
    selection,
    claims: {
      deterministicRecordInvariant: true,
      outputTransformInvariant: true,
      svgInvariant: true,
      completionOrderObservational: observedOrders.size > 1,
      focusDelayApplied: matrix[1].memberDelays[selection.focus] === focusDelayMs,
      peerDelayApplied: matrix[2].memberDelays[selection.peer] === focusDelayMs,
      managerCoreUnchanged: stableJson(toolBefore) === stableJson(toolAfter),
      toolDistributionUnchanged: stableJson(toolBefore) === stableJson(toolAfter),
    },
    composition: baseline.record.composition,
    runs: outcomes.map((outcome) => ({
      configuration: outcome.configuration,
      deterministicIdentity: outcome.deterministic.identity,
      inputTransformRoot: outcome.inputTransformRoot,
      outputTransformRoot: outcome.outputTransformRoot,
      observational: outcome.observational,
    })),
  };
  const reportPath = path.join(root, "runtime-task-conformance.json");
  await writeJson(reportPath, report);
  return { report, reportPath };
}
