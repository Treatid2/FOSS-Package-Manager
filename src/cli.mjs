#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ArtifactStore } from "./core/artifacts.mjs";
import { buildProfile, explainProvenance, prepareProfile } from "./core/build.mjs";
import { formatDiagnostic, invariant } from "./core/errors.mjs";
import { loadProfile } from "./core/profile.mjs";
import { explainRuntime, runRuntime } from "./core/runtime.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return `FOSS Package Manager reference prototype

Usage:
  node src/cli.mjs validate <profile.json>
  node src/cli.mjs build <profile.json> [--out <directory>]
  node src/cli.mjs run <profile.json> [--out <directory>] [--snapshot <file.svg>]
  node src/cli.mjs explain <provenance.json> <public-id>
  node src/cli.mjs explain-runtime <runtime-lifecycle.json> <service-or-capability>
  node src/cli.mjs store-report <artifact-store-directory>
`;
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  invariant(args[index + 1], "FPM_CLI_USAGE", `Option ${name} requires a value.`);
  return args[index + 1];
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ["-h", "--help", "help"].includes(command)) {
    console.log(usage());
    return;
  }
  if (command === "validate") {
    invariant(args[0], "FPM_CLI_USAGE", "validate requires a profile path.");
    const prepared = await prepareProfile(args[0]);
    console.log(`Valid: ${prepared.profile.name}`);
    console.log(`Selected packages: ${prepared.resolution.ordered.length}`);
    console.log(`Resolved public hooks: ${prepared.bindings.length}`);
    return;
  }
  if (command === "build" || command === "run") {
    invariant(args[0], "FPM_CLI_USAGE", `${command} requires a profile path.`);
    const profilePath = path.resolve(args[0]);
    const profile = await loadProfile(profilePath);
    const output = path.resolve(option(args, "--out") ?? path.join(projectRoot, "build", profile.name));
    const result = await buildProfile(profilePath, output);
    console.log(`Built ${result.artifact.type}`);
    console.log(`Scene: ${result.artifactPath}`);
    console.log(`Lockfile: ${path.join(result.outputDirectory, "fpm.lock.json")}`);
    console.log(`Provenance: ${path.join(result.outputDirectory, "provenance.json")}`);
    console.log(`Artifact store: ${result.storeDirectory}`);
    console.log(`Cache: ${result.cache.hits} reused, ${result.cache.misses} materialized`);
    if (command === "run") {
      await runRuntime(result, { snapshotPath: option(args, "--snapshot") });
      console.log(`Runtime lifecycle: ${path.join(result.outputDirectory, "runtime-lifecycle.json")}`);
    }
    return;
  }
  if (command === "explain") {
    invariant(args[0] && args[1], "FPM_CLI_USAGE", "explain requires a provenance file and public identity.");
    const provenance = JSON.parse(await readFile(path.resolve(args[0]), "utf8"));
    console.log(JSON.stringify(explainProvenance(provenance, args[1]), null, 2));
    return;
  }
  if (command === "explain-runtime") {
    invariant(args[0] && args[1], "FPM_CLI_USAGE",
      "explain-runtime requires a runtime lifecycle file and service or capability identity.");
    const lifecycle = JSON.parse(await readFile(path.resolve(args[0]), "utf8"));
    console.log(JSON.stringify(explainRuntime(lifecycle, args[1]), null, 2));
    return;
  }
  if (command === "store-report") {
    invariant(args[0], "FPM_CLI_USAGE", "store-report requires an artifact store directory.");
    const store = new ArtifactStore(path.resolve(args[0]), {
      protocol: "fpm.artifact-transaction/2",
      facts: {},
      widenedDimensions: [],
    });
    console.log(JSON.stringify(await store.reachabilityReport(), null, 2));
    return;
  }
  throw new FpmError("FPM_CLI_USAGE", "Unknown command.", { command, usage: usage() });
}

main().catch((error) => {
  console.error(formatDiagnostic(error));
  process.exitCode = 1;
});
