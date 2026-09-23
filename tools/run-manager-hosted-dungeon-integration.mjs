#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

import path from "node:path";
import { FgpmError, formatDiagnostic, invariant } from "../src/core/errors.mjs";
import { runManagerHostedDungeonIntegration } from "../src/core/integration.mjs";

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? null;
}

try {
  const args = process.argv.slice(2);
  const request = args.find((entry) => !entry.startsWith("--"));
  const out = option(args, "--out");
  invariant(request && out, "FGPM_CLI_USAGE",
    "Usage: node tools/run-manager-hosted-dungeon-integration.mjs <request.json> --out <empty-directory>");
  const result = await runManagerHostedDungeonIntegration(path.resolve(request), path.resolve(out));
  process.stdout.write(`${JSON.stringify({
    status: result.receipt.status,
    integration: result.receipt.id,
    outputDirectory: result.outputDirectory,
    manifest: path.join(result.outputDirectory, "evidence-manifest.json"),
  }, null, 2)}\n`);
} catch (error) {
  const failure = error instanceof FgpmError ? error : new FgpmError("FGPM_INTERNAL", error.message, {});
  process.stderr.write(`${formatDiagnostic(failure)}\n`);
  process.exitCode = 1;
}
