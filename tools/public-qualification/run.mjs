// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
import { PublicClient, inventory, sha256, json, requireFact, humanReport } from "./public-client.mjs";
import { qualify } from "./qualify.mjs";
import { dungeon } from "./dungeon.mjs";

const args = process.argv.slice(2);
const mode = args[0];
const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : null;
if (args.includes("--help") || args.length === 0) {
  console.log("Usage: bin/node.exe qualification/run.mjs <qualify|dungeon> --input <binding.json> --out <new-managed-scratch-directory> [--json]\n"
    + "All candidate identity pins are mandatory. Dungeon mode requires a curator-supplied generation/store; it never creates a baseline.\n"
    + "qualify runs 15 distinct public-interface cases, NOT an equivalent source-free original 137-case suite.");
  process.exit(0);
}
let client, output, before, report, exit, outputCreated = false;
try {
  requireFact(["qualify", "dungeon"].includes(mode) && option("--input") && option("--out"), "Exact mode, --input and --out required");
  const input = await json(path.resolve(option("--input")));
  output = path.resolve(option("--out"));
  const distribution = path.resolve(input.distribution);
  const managerRoot = mode === "dungeon" ? path.resolve(input.managerRoot) : path.join(output, "manager-store");
  requireFact(output !== distribution && !output.startsWith(distribution + path.sep)
    && !distribution.startsWith(output + path.sep), "Evidence and distribution must be disjoint");
  await mkdir(output, { recursive: false });
  outputCreated = true;
  before = await inventory(distribution);
  requireFact(!before.some((entry) => /(^|\/)(src|test|tools|\.git)\//u.test(entry.path)), "Candidate is not a clean source-free extraction");
  const identity = await json(path.join(distribution, "manifests", "tool-distribution.json"));
  const expected = input.expected;
  requireFact(expected && identity.manager.version === expected.managerVersion
    && identity.runtime.implementationPayloadRoot === expected.runtimePayloadRoot
    && identity.distribution.contentRoot === expected.distributionContentRoot
    && identity.publicContracts.root === expected.publicContractRoot, "Exact candidate identity pins mismatch");
  const archive = path.resolve(input.archive);
  requireFact((await lstat(archive)).isFile(), "Candidate archive must be a regular file");
  requireFact(`sha256:${sha256(await readFile(archive))}` === expected.archiveSha256, "Candidate archive hash mismatch");
  requireFact(`sha256:${sha256(await readFile(path.join(distribution, "bin", "node.exe")))}` === identity.runtime.binaryRoot,
    "Bundled executable hash mismatch before invocation");
  const content = before.filter((entry) => !["manifests/files.sha256", "manifests/tool-distribution.json"].includes(entry.path))
    .sort((a, b) => a.path.localeCompare(b.path, "en"));
  requireFact(`sha256:${sha256(content.map((entry) => `${entry.sha256}  ${entry.path}\n`).join(""))}` === expected.distributionContentRoot,
    "Extracted distribution bytes do not match pinned content root");
  const invocations = [];
  async function invoke(name, argv) {
    const result = spawnSync(path.join(distribution, "bin", "node.exe"), [path.join(distribution, "bin", "fgpm.mjs"), ...argv],
      { cwd: output, env: { ...process.env, PATH: "", Path: "" }, timeout: 30000, windowsHide: true, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    await writeFile(path.join(output, `${name}.stdout.txt`), result.stdout ?? "");
    await writeFile(path.join(output, `${name}.stderr.txt`), result.stderr ?? "");
    invocations.push({ name, arguments: argv, exitCode: result.status, error: result.error?.message ?? null });
    requireFact(result.status === 0, `${name}: ${result.error?.message ?? result.stderr}`);
    return JSON.parse(result.stdout);
  }
  const observedIdentity = await invoke("version", ["--version", "--json"]);
  assert.deepEqual(observedIdentity, identity, "Public version response differs from pinned manifest");
  if (mode === "qualify") await invoke("materialize", ["fixture", "materialize", path.join(distribution, "fixtures", "runtime-task-v2.fixture"),
    "--out", path.join(output, "public-fixture")]);
  client = new PublicClient(distribution, managerRoot, output);
  report = mode === "qualify" ? await qualify(client, distribution, output, identity) : await dungeon(client, input.dungeon, identity);
  exit = await client.finish(output); client = null;
  requireFact(exit.code === 0, "Public manager did not exit cleanly");
  report.invocations = invocations;
  const after = await inventory(distribution);
  requireFact(JSON.stringify(before) === JSON.stringify(after), "Candidate bytes or paths changed during qualification");
  report.candidatePreserved = true; report.archiveSha256 = expected.archiveSha256;
  report.captureTime = new Date().toISOString(); report.processExit = exit;
  report.sourceFree = true; report.automaticNetworkAccess = false;
  report.downstreamUseRequiresAssessment = true;
  await writeFile(path.join(output, "distribution-before.json"), JSON.stringify(before, null, 2) + "\n");
  await writeFile(path.join(output, "distribution-after.json"), JSON.stringify(after, null, 2) + "\n");
} catch (error) {
  if (client) { exit = await client.finish(output); client = null; }
  report = { schema: "fgpm.public-qualification-failure/1", status: "fail", mode,
    error: { code: error.code ?? null, message: error.message }, processExit: exit ?? null,
    original137Equivalent: false, downstreamUseRequiresAssessment: true };
  process.exitCode = 1;
}
if (outputCreated) {
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(path.join(output, "report.txt"), humanReport(report));
}
console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : humanReport(report));
