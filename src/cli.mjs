#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ArtifactStore } from "./core/artifacts.mjs";
import { buildProfile, explainProvenance, prepareProfile } from "./core/build.mjs";
import { runRuntimeTaskConformance } from "./core/conformance.mjs";
import { runControlPlane } from "./core/control-plane.mjs";
import { CurationManager } from "./core/curation.mjs";
import { FgpmError, formatDiagnostic, invariant } from "./core/errors.mjs";
import { GenerationRuntimeCoordinator } from "./core/generation-runtime.mjs";
import { loadProfile } from "./core/profile.mjs";
import { packageIdentity, formatPackageIdentity } from "./core/package-identity.mjs";
import { inspectPrePublicMigration, migratePrePublicPackages } from "./core/migration.mjs";
import { validatePackageIsolated, validateProfileDocument } from "./core/public-contracts.mjs";
import { materializeReferenceFixture, referenceDoctor, referenceIdentity, verifyReferenceContracts,
  verifyReferenceFixture } from "./core/reference-tools.mjs";
import { explainRuntime, runRuntime } from "./core/runtime.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return `FOSS Package Manager reference prototype

Usage:
  fgpm --version [--json]
  fgpm help [--json]
  fgpm doctor [--json] [--manager-root <directory>]
  fgpm contracts verify [--json]
  fgpm fixture verify <fixture>
  fgpm fixture materialize <fixture> --out <empty-directory>
  fgpm validate-package <package-directory-or-fgpm-package.json>
  fgpm validate-profile <profile.json>
  fgpm validate <profile.json>
  fgpm migrate pre-public-package <source-directory> --namespace <uuid> [--apply --out <directory>]
  fgpm migrate pre-public-package status --out <directory>
  fgpm build <profile.json> [--out <directory>]
  fgpm run <profile.json> [--out <directory>] [--snapshot <file.svg>] [--ticks <count>]
                               [--load <save-id>] [--save <save-id>] [--workers <count>]
                               [--delay <exact-task-member>=<milliseconds>] [--packages <directory>]
                               [--interactive]
  fgpm conformance runtime-task <profile.json> --focus <exact-task-member>
                               [--out <directory>] [--packages <directory>]
  fgpm explain <provenance.json> <public-id>
  fgpm explain runtime <runtime-lifecycle.json> <service-capability-channel-or-task>
  fgpm explain-runtime <runtime-lifecycle.json> <service-or-capability>
  fgpm store-report <artifact-store-directory>
  fgpm control [--manager-root <directory>] [--snapshot <file.svg>]
  fgpm package import <package-directory> [--manager-root <directory>]
  fgpm package identity <directory> [--expected sha256:<64-lowercase-hex>] [--json]
  fgpm package list [--manager-root <directory>]
  fgpm package registry [--manager-root <directory>] [--json]
  fgpm package variant-register <directory> --expected <root> --registration-id <id> --reason <text> --source <text> [--if-index <root>] [--manager-root <directory>] [--json]
  fgpm workspace create <name> [--base <generation>] [--manager-root <directory>]
  fgpm workspace fork <generation> <name> [--manager-root <directory>]
  fgpm workspace status <name> [--manager-root <directory>]
  fgpm workspace stage <name> <operation-json-file> [--expected <revision>] [--actor <identity>]
  fgpm workspace choose <provider|adapter|replacement> <name> <requirement> <selection>
  fgpm workspace plan <name> [--profile <profile.json>] [--manager-root <directory>]
  fgpm candidate explain <candidate-root> [--manager-root <directory>]
  fgpm candidate build <candidate-root> [--manager-root <directory>]
  fgpm candidate validate <candidate-or-build-root> [--manager-root <directory>]
  fgpm generation commit <validation-root> [--manager-root <directory>]
  fgpm generation show <generation-root> [--manager-root <directory>]
  fgpm generation activate <generation-root> [--manager-root <directory>]  (control session required)
  fgpm generation rollback <generation-root> [--manager-root <directory>]  (control session required)
  fgpm distribution export <generation-root> --out <directory> [--manager-root <directory>]
  fgpm distribution import <directory> [--manager-root <directory>]
  fgpm distribution verify <directory> [--manager-root <directory>]

Global diagnostic option: --debug includes implementation stacks; stacks are suppressed by default.
`;
}

function commandUsage(command) {
  const help = {
    "validate-package": "validate-package <package-directory-or-fgpm-package.json>\n  Statically validates one package without executing package code.",
    "validate-profile": "validate-profile <profile.json>\n  Validates the public profile document and its complete package graph.",
    validate: "validate <profile.json>\n  Compatibility alias for validate-profile.",
    migrate: "migrate pre-public-package <source-directory> --namespace <uuid> [--apply --out <directory>]\n       migrate pre-public-package status --out <directory>\n  Previews or copy-migrates the finite pre-public fpm-package.json formats. Apply is restartable through a durable adjacent operation record; it never edits private manager indices or its source.",
    build: "build <profile.json> [--out <directory>]\n  Resolves and materializes the selected artifact.",
    run: "run <profile.json> [--out <directory>] [--snapshot <file.svg>] [--ticks <count>] [--interactive] [--load <save-id>] [--save <save-id>] [--workers <count>] [--delay <exact-task-member>=<milliseconds>] [--packages <directory>]\n  Builds and activates a disposable runtime. --ticks is bounded unless --interactive is explicit; --snapshot only selects output.",
    conformance: "conformance runtime-task <profile.json> --focus <exact-task-member> [--out <directory>] [--packages <directory>]\n  Delays the selected task and a recorded peer, then compares deterministic evidence.",
    explain: "explain <provenance.json> <public-id>\n       explain runtime <runtime-lifecycle.json> <service-capability-channel-or-task>\n  Explains build or runtime public evidence.",
    "explain-runtime": "explain-runtime <runtime-lifecycle.json> <service-or-capability>\n  Explains one runtime service, capability, or collection member.",
    "store-report": "store-report <artifact-store-directory>\n  Reports reachable and unreachable immutable objects.",
    control: "control [--manager-root <directory>] [--snapshot <file.svg>]\n  Runs the line-delimited JSON manager control process. Begin with control.describe; keep this process alive for activation, runtime work, transition, and shutdown.",
    package: "package identity <directory> [--expected sha256:<64-lowercase-hex>] [--json]\n  Computes content only, without execution/import/store access. Exit 0 computed/match, 1 mismatch, 2 error.\n  Links/non-regular entries rejected; .git, node_modules and build excluded at every depth.\n  Alternatively: package <import|list|registry|variant-register> ... [--manager-root <directory>].",
    workspace: "workspace <create|fork|status|stage|choose|plan> ... [--manager-root <directory>]\n  Edits persistent immutable workspace revisions. A JSON file is the normative portable input for workspace stage.",
    candidate: "candidate <explain|build|validate> <root> [--manager-root <directory>]\n  Inspects or advances immutable candidate stages.",
    generation: "generation <commit|show|activate|rollback> ... [--manager-root <directory>]\n  Commits or transitions complete immutable generations.",
    distribution: "distribution <export|import|verify> ... [--manager-root <directory>]\n  Replays self-contained local distributions.",
  };
  return help[command] ? `Usage: fgpm ${help[command]}\n` : null;
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  invariant(args[index + 1], "FGPM_CLI_USAGE", `Option ${name} requires a value.`);
  return args[index + 1];
}

function optionValues(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    invariant(args[index + 1], "FGPM_CLI_USAGE", `Option ${name} requires a value.`);
    values.push(args[index + 1]);
  }
  return values;
}

function supplementalPackageRoots(args) {
  return optionValues(args, "--packages").map((entry) => path.resolve(entry));
}

async function curationManager(args) {
  return new CurationManager(path.resolve(option(args, "--manager-root")
    ?? path.join(process.cwd(), ".fgpm-manager"))).initialize();
}

async function jsonArgument(value) {
  invariant(value, "FGPM_CLI_USAGE", "A JSON argument or JSON file is required.");
  if (value.trim().startsWith("{")) return JSON.parse(value);
  return JSON.parse(await readFile(path.resolve(value), "utf8"));
}

function memberDelays(args) {
  const delays = {};
  for (const declaration of optionValues(args, "--delay")) {
    const separator = declaration.lastIndexOf("=");
    const member = separator === -1 ? "" : declaration.slice(0, separator);
    const milliseconds = Number(separator === -1 ? NaN : declaration.slice(separator + 1));
    invariant(member.startsWith("task:") && Number.isInteger(milliseconds) && milliseconds >= 0,
      "FGPM_CLI_USAGE", "--delay requires <exact-task-member>=<non-negative-milliseconds>.", { declaration });
    delays[member] = milliseconds;
  }
  return delays;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "package" && args[0] === "identity") {
    if (["--help", "-h", "help"].includes(args[1])) {
      console.log(commandUsage("package"));
      return;
    }
    let result;
    try {
      invariant(args[1] && !args[1].startsWith("--"), "FGPM_CLI_USAGE", "package identity requires a directory.");
      const remaining = args.slice(2);
      let expected = null;
      let json = false;
      for (let index = 0; index < remaining.length; index += 1) {
        if (remaining[index] === "--json" && !json) json = true;
        else if (remaining[index] === "--expected" && expected === null) {
          invariant(remaining[index + 1] && !remaining[index + 1].startsWith("--"), "FGPM_CLI_USAGE", "--expected requires a value.");
          expected = remaining[++index];
        } else invariant(false, "FGPM_CLI_USAGE", "Unknown or duplicate identity option.", { option: remaining[index] });
      }
      result = await packageIdentity(args[1], expected);
    } catch (error) {
      result = { schema: "fgpm.package-identity/1", status: "error", input: args[1] ?? null,
        expected: null, observed: null, exitCode: 2, contentOnly: true,
        error: { code: error.code ?? "FGPM_CLI_USAGE", message: error.message, details: error.details ?? null } };
    }
    console.log(args.includes("--json") ? JSON.stringify(result, null, 2) : formatPackageIdentity(result));
    process.exitCode = result.exitCode;
    return;
  }
  if (command === "--version" || command === "version") {
    const identity = await referenceIdentity(projectRoot);
    console.log(args.includes("--json") ? JSON.stringify(identity, null, 2)
      : `${identity.manager.id} ${identity.manager.version} (${identity.source.commit})`);
    return;
  }
  if (!command || ["-h", "--help", "help"].includes(command)) {
    const identity = await referenceIdentity(projectRoot);
    if (args.includes("--json")) {
      console.log(JSON.stringify({
        schema: "fgpm.reference-help/1",
        manager: identity.manager,
        commands: ["version", "help", "doctor", "contracts verify", "validate-package", "validate-profile", "migrate pre-public-package",
          "fixture verify", "fixture materialize", "build", "run", "conformance runtime-task", "explain", "store-report", "control", "package",
          "workspace", "candidate", "generation", "distribution", "package identity"],
      }, null, 2));
      return;
    }
    console.log(`${identity.manager.id} ${identity.manager.version}\n${usage()}`);
    return;
  }
  if (command === "migrate" && args[0] === "pre-public-package"
      && ["-h", "--help", "help"].includes(args[1])) {
    console.log(commandUsage("migrate"));
    return;
  }
  if (["-h", "--help", "help"].includes(args[0])) {
    const help = commandUsage(command);
    invariant(help, "FGPM_CLI_USAGE", "Unknown command.", { command, usage: usage() });
    console.log(help);
    return;
  }
  if (command === "doctor") {
    const result = await referenceDoctor(projectRoot, { managerRoot: option(args, "--manager-root") });
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "pass") process.exitCode = 1;
    return;
  }
  if (command === "contracts") {
    invariant(args[0] === "verify", "FGPM_CLI_USAGE", "contracts requires the verify operation.");
    const result = await verifyReferenceContracts(projectRoot);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "pass") process.exitCode = 1;
    return;
  }
  if (command === "fixture") {
    invariant(args[1], "FGPM_CLI_USAGE", "fixture requires an operation and fixture path.");
    let result;
    if (args[0] === "verify") result = await verifyReferenceFixture(args[1]);
    else if (args[0] === "materialize") {
      invariant(option(args, "--out"), "FGPM_CLI_USAGE", "fixture materialize requires --out.");
      result = await materializeReferenceFixture(args[1], option(args, "--out"));
    } else throw new FgpmError("FGPM_CLI_USAGE", "Unknown fixture operation.", { operation: args[0] });
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "pass") process.exitCode = 1;
    return;
  }
  if (command === "validate-package") {
    invariant(args[0], "FGPM_CLI_USAGE", "validate-package requires a package directory or manifest path.");
    console.log(JSON.stringify(await validatePackageIsolated(args[0]), null, 2));
    return;
  }
  if (command === "migrate") {
    invariant(args[0] === "pre-public-package" && args[1], "FGPM_CLI_USAGE",
      "migrate requires 'pre-public-package' and a source directory.");
    if (args[1] === "status") {
      invariant(option(args, "--out"), "FGPM_CLI_USAGE", "migration status requires --out.");
      console.log(JSON.stringify(await inspectPrePublicMigration(option(args, "--out")), null, 2));
      return;
    }
    const result = await migratePrePublicPackages(args[1], {
      namespace: option(args, "--namespace"), apply: args.includes("--apply"), output: option(args, "--out"),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "control") {
    const manager = await curationManager(args);
    const coordinator = new GenerationRuntimeCoordinator(manager, {
      runtimeOptions: { snapshotPath: option(args, "--snapshot"), openBrowser: false },
    });
    await runControlPlane(manager, coordinator);
    return;
  }
  if (command === "package") {
    const manager = await curationManager(args);
    if (args[0] === "registry" || args[0] === "variant-register") {
      if (args[0] === "variant-register") invariant(args[1] && !args[1].startsWith("--"),
        "FGPM_CLI_USAGE", "package variant-register requires an exact package directory.");
      const result = args[0] === "registry" ? await manager.inspectPackageRegistry() : await manager.registerVariant(args[1], {
        expectedRoot: option(args, "--expected"), registrationId: option(args, "--registration-id"),
        reason: option(args, "--reason"), source: option(args, "--source") ?? undefined,
        expectedIndexRoot: option(args, "--if-index") ?? undefined,
      });
      console.log(args.includes("--json") ? JSON.stringify(result) : `Package registry ${args[0]} — complete decision and audit facts\n${JSON.stringify(result, null, 2)}`);
      return;
    }
    if (args[0] === "import") {
      invariant(args[1], "FGPM_CLI_USAGE", "package import requires a package directory.");
      console.log(JSON.stringify(await manager.importPackage(args[1]), null, 2));
      return;
    }
    if (args[0] === "list") {
      console.log(JSON.stringify({ schema: "fgpm.package-list/1", packages: await manager.listPackages() }, null, 2));
      return;
    }
    throw new FgpmError("FGPM_CLI_USAGE", "Unknown package operation.", { operation: args[0] });
  }
  if (command === "workspace") {
    const manager = await curationManager(args);
    const operation = args[0];
    if (operation === "create") {
      invariant(args[1], "FGPM_CLI_USAGE", "workspace create requires a name.");
      console.log(JSON.stringify(await manager.createWorkspace(args[1], { baseGeneration: option(args, "--base") }), null, 2));
      return;
    }
    if (operation === "fork") {
      invariant(args[1] && args[2], "FGPM_CLI_USAGE", "workspace fork requires a generation and name.");
      console.log(JSON.stringify(await manager.forkWorkspace(args[1], args[2]), null, 2));
      return;
    }
    if (operation === "status") {
      invariant(args[1], "FGPM_CLI_USAGE", "workspace status requires a name.");
      console.log(JSON.stringify(await manager.workspaceStatus(args[1]), null, 2));
      return;
    }
    if (operation === "stage") {
      invariant(args[1] && args[2], "FGPM_CLI_USAGE", "workspace stage requires a name and operation JSON.");
      console.log(JSON.stringify(await manager.stageOperation(args[1], await jsonArgument(args[2]), {
        expectedHead: option(args, "--expected"), actor: option(args, "--actor"),
      }), null, 2));
      return;
    }
    if (operation === "choose") {
      invariant(["provider", "adapter", "replacement"].includes(args[1]) && args[2] && args[3] && args[4],
        "FGPM_CLI_USAGE", "workspace choose requires a kind, workspace, requirement, and selection.");
      const field = args[1] === "provider" ? "requirement" : args[1] === "adapter" ? "relation" : "target";
      const selection = args[1] === "provider" ? "provider" : args[1] === "adapter" ? "adapter" : "replacement";
      console.log(JSON.stringify(await manager.stageOperation(args[2], {
        type: `select-${args[1]}`, [field]: args[3], [selection]: args[4],
      }), null, 2));
      return;
    }
    if (operation === "plan") {
      invariant(args[1], "FGPM_CLI_USAGE", "workspace plan requires a name.");
      console.log(JSON.stringify(await manager.planCandidate(args[1], { profilePath: option(args, "--profile") }), null, 2));
      return;
    }
    throw new FgpmError("FGPM_CLI_USAGE", "Unknown workspace operation.", { operation });
  }
  if (command === "candidate") {
    const manager = await curationManager(args);
    invariant(args[1], "FGPM_CLI_USAGE", "candidate operation requires a candidate root.");
    const result = args[0] === "explain" ? await manager.explainCandidate(args[1])
      : args[0] === "build" ? await manager.buildCandidate(args[1])
        : args[0] === "validate" ? await manager.validateCandidate(args[1]) : null;
    invariant(result, "FGPM_CLI_USAGE", "Unknown candidate operation.", { operation: args[0] });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "generation") {
    const manager = await curationManager(args);
    invariant(args[1], "FGPM_CLI_USAGE", "generation operation requires a root.");
    if (args[0] === "commit") {
      console.log(JSON.stringify(await manager.commitGeneration(args[1]), null, 2));
      return;
    }
    if (args[0] === "show") {
      console.log(JSON.stringify(await manager.showGeneration(args[1]), null, 2));
      return;
    }
    if (["activate", "rollback"].includes(args[0])) {
      invariant(!option(args, "--profile"), "FGPM_GENERATION_SEMANTIC_OVERRIDE_FORBIDDEN",
        "Generation activation does not accept an independent semantic profile.", { generation: args[1] });
      throw new FgpmError("FGPM_CONTROL_SESSION_REQUIRED",
        "Live generation activation and rollback require one persistent 'fgpm control' process.", {
          operation: `generation.${args[0]}`, generation: args[1],
          startWith: "control.describe", guide: "guide/package-authoring-guide.md#persistent-runtime-control",
        });
    }
    throw new FgpmError("FGPM_CLI_USAGE", "Unknown generation operation.", { operation: args[0] });
  }
  if (command === "distribution") {
    const manager = await curationManager(args);
    invariant(args[1], "FGPM_CLI_USAGE", "distribution operation requires a root or directory.");
    if (args[0] === "export") invariant(option(args, "--out"), "FGPM_CLI_USAGE", "distribution export requires --out.");
    const result = args[0] === "export" ? await manager.exportDistribution(args[1], option(args, "--out"))
      : args[0] === "import" ? await manager.importDistribution(args[1])
        : args[0] === "verify" ? await manager.verifyDistribution(args[1]) : null;
    invariant(result, "FGPM_CLI_USAGE", "Unknown distribution operation.", { operation: args[0] });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "validate" || command === "validate-profile") {
    invariant(args[0], "FGPM_CLI_USAGE", `${command} requires a profile path.`);
    const report = await validateProfileDocument(args[0]);
    const prepared = await prepareProfile(args[0], { packageRoots: supplementalPackageRoots(args) });
    console.log(JSON.stringify({
      ...report,
      status: report.status ?? "valid",
      selectedPackages: prepared.resolution.ordered.length,
      resolvedPublicHooks: prepared.bindings.length,
    }, null, 2));
    return;
  }
  if (command === "build" || command === "run") {
    invariant(args[0], "FGPM_CLI_USAGE", `${command} requires a profile path.`);
    const profilePath = path.resolve(args[0]);
    const packageRoots = supplementalPackageRoots(args);
    const profile = await loadProfile(profilePath, { packageRoots });
    const output = path.resolve(option(args, "--out") ?? path.join(process.cwd(), "build", profile.name));
    const result = await buildProfile(profilePath, output, { packageRoots });
    console.log(`Built ${result.artifact.type}`);
    console.log(`Scene: ${result.artifactPath}`);
    console.log(`Lockfile: ${path.join(result.outputDirectory, "fgpm.lock.json")}`);
    console.log(`Provenance: ${path.join(result.outputDirectory, "provenance.json")}`);
    console.log(`Artifact store: ${result.storeDirectory}`);
    console.log(`Cache: ${result.cache.hits} reused, ${result.cache.misses} materialized`);
    if (command === "run") {
      const ticksOption = option(args, "--ticks");
      const ticks = ticksOption === null ? undefined : Number(ticksOption);
      invariant(ticks === undefined || (Number.isInteger(ticks) && ticks >= 0), "FGPM_CLI_USAGE",
        "--ticks requires a non-negative integer.");
      const loadSaveId = option(args, "--load");
      const saveId = option(args, "--save");
      const workersOption = option(args, "--workers");
      const schedulerWorkerCount = workersOption === null ? undefined : Number(workersOption);
      invariant(schedulerWorkerCount === undefined || (Number.isInteger(schedulerWorkerCount)
        && schedulerWorkerCount > 0), "FGPM_CLI_USAGE", "--workers requires a positive integer.");
      await runRuntime(result, {
        snapshotPath: option(args, "--snapshot"), ticks, loadSaveId, saveId,
        schedulerWorkerCount, schedulerDelays: memberDelays(args),
        interactive: args.includes("--interactive") ? true : undefined,
      });
      if (loadSaveId) console.log(`Loaded world save: ${loadSaveId}`);
      if (saveId) console.log(`Published world save: ${saveId}`);
      console.log(`Runtime lifecycle: ${path.join(result.outputDirectory, "runtime-lifecycle.json")}`);
    }
    return;
  }
  if (command === "conformance") {
    invariant(args[0] === "runtime-task" && args[1], "FGPM_CLI_USAGE",
      "conformance requires 'runtime-task' and a profile path.");
    const profilePath = path.resolve(args[1]);
    const output = path.resolve(option(args, "--out") ?? path.join(process.cwd(), "build",
      `${path.basename(profilePath, path.extname(profilePath))}-conformance`));
    const result = await runRuntimeTaskConformance(profilePath, output, {
      packageRoots: supplementalPackageRoots(args),
      focusMember: option(args, "--focus"),
    });
    console.log(JSON.stringify({ status: result.report.status, report: result.reportPath,
      claims: result.report.claims }, null, 2));
    if (result.report.status === "fail") {
      console.error(formatDiagnostic(result.error, { debug: args.includes("--debug") }));
      process.exitCode = 1;
    }
    return;
  }
  if (command === "explain") {
    if (args[0] === "runtime") {
      invariant(args[1] && args[2], "FGPM_CLI_USAGE",
        "explain runtime requires a runtime lifecycle file and public target.");
      const lifecycle = JSON.parse(await readFile(path.resolve(args[1]), "utf8"));
      console.log(JSON.stringify(explainRuntime(lifecycle, args[2]), null, 2));
      return;
    }
    invariant(args[0] && args[1], "FGPM_CLI_USAGE", "explain requires a provenance file and public identity.");
    const provenance = JSON.parse(await readFile(path.resolve(args[0]), "utf8"));
    console.log(JSON.stringify(explainProvenance(provenance, args[1]), null, 2));
    return;
  }
  if (command === "explain-runtime") {
    invariant(args[0] && args[1], "FGPM_CLI_USAGE",
      "explain-runtime requires a runtime lifecycle file and service or capability identity.");
    const lifecycle = JSON.parse(await readFile(path.resolve(args[0]), "utf8"));
    console.log(JSON.stringify(explainRuntime(lifecycle, args[1]), null, 2));
    return;
  }
  if (command === "store-report") {
    invariant(args[0], "FGPM_CLI_USAGE", "store-report requires an artifact store directory.");
    const store = new ArtifactStore(path.resolve(args[0]), {
      protocol: "fgpm.artifact-transaction/2",
      facts: {},
      widenedDimensions: [],
    });
    console.log(JSON.stringify(await store.reachabilityReport(), null, 2));
    return;
  }
  throw new FgpmError("FGPM_CLI_USAGE", "Unknown command.", { command, usage: usage() });
}

main().catch((error) => {
  console.error(formatDiagnostic(error, { debug: process.argv.includes("--debug") }));
  process.exitCode = 1;
});
