// SPDX-License-Identifier: MPL-2.0
// Bounded clean-extraction qualification; evidence written outside the candidate.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const distribution = path.resolve(arg("--distribution"));
const evidence = path.resolve(arg("--evidence"));
assert.ok(!evidence.startsWith(distribution + path.sep));
await mkdir(evidence, { recursive: true });
const cwd = path.join(evidence, "Unrelated cwd Ω");
await mkdir(cwd);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function inventory(root) {
  const records = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else records.push({ path: path.relative(root, full).replaceAll(path.sep, "/"), bytes: (await readFile(full)).length,
        sha256: sha(await readFile(full)) });
    }
  }
  await walk(root);
  return records.sort((a, b) => a.path.localeCompare(b.path, "en"));
}
const before = await inventory(distribution);
assert.ok(!before.some((f) => /(^|\/)(src|test|tools|\.git)\//u.test(f.path)));
const runs = [];
async function record(name, args, { expectedExit = 0, unreadableFile = null } = {}) {
  const node = path.join(distribution, "bin", "node.exe");
  const loader = path.join(distribution, "bin", "fgpm.mjs");
  // The same launcher executable/arguments, with no installed runtime or PATH dependency.
  let command = node, argv = [loader, ...args];
  if (unreadableFile) {
    const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
    command = process.env.FGPM_QUALIFY_PWSH;
    assert.ok(command, "Explicit PowerShell executable required for Windows exclusive-lock test");
    argv = ["-NoProfile", "-NonInteractive", "-Command",
      `$h=[IO.File]::Open(${quote(unreadableFile)},'Open','Read','None'); try { & ${quote(node)} ${[loader,...args].map(quote).join(" ")}; $r=$LASTEXITCODE } finally { $h.Dispose() }; exit $r`];
  }
  const run = spawnSync(command, argv, { cwd, encoding: "utf8", timeout: 30000,
    env: { ...process.env, PATH: "", Path: "" } });
  await writeFile(path.join(evidence, `${name}.stdout.txt`), run.stdout ?? "");
  await writeFile(path.join(evidence, `${name}.stderr.txt`), run.stderr ?? "");
  runs.push({ name, args, exitCode: run.status, error: run.error?.message ?? null });
  assert.equal(run.status, expectedExit, `${name}: ${run.stderr}`);
  return run.stdout;
}
const identity = JSON.parse(await record("version-json", ["--version", "--json"]));
const manager = JSON.parse(await readFile(path.join(source, "manager.json"), "utf8"));
assert.deepEqual(identity.manager, { id: manager.id, version: manager.version, buildIdentity: manager.buildIdentity });
assert.equal(identity.manager.version, manager.version);
assert.ok((await record("version-human", ["--version"])).includes(manager.version));
const help = JSON.parse(await record("help-json", ["help", "--json"]));
assert.deepEqual(help.manager, identity.manager);
assert.ok((await record("help-human", ["help"])).includes(manager.version));
assert.equal(JSON.parse(await record("doctor", ["doctor", "--json"])).status, "pass");
assert.equal(JSON.parse(await record("contracts", ["contracts", "verify", "--json"])).status, "pass");
assert.equal(JSON.parse(await record("fixture", ["fixture", "verify", path.join(distribution, "fixtures", "runtime-task-v2.fixture")])).status, "pass");
const sbom = JSON.parse(await readFile(path.join(distribution, "manifests", "SBOM.json"), "utf8"));
assert.equal(sbom.components.find((c) => c.kind === "implementation").version, manager.version);
for (const file of before.filter((f) => f.path.startsWith("public/"))) {
  assert.equal(file.sha256, sha(await readFile(path.join(source, file.path))), file.path);
}
const fixtureRoot = path.join(evidence, "Received packages Ω");
await cp(path.resolve(arg("--packages-dir")), fixtureRoot, { recursive: true });
const host = path.join(fixtureRoot, "fgpm.grid-dungeon-integration-runtime");
const runtime = path.join(fixtureRoot, "fgdungeon.reference-runtime");
const hostRoot = "sha256:2e0d44cdc4756a3962f133364616c7d57889f18801dc6b2cc4200e52f666f475";
const runtimeRoot = "sha256:114d063d41637944db7fa9c20347019ffb7b1f530b26b2ddcfb0e450ccbf899d";
const inputBefore = await inventory(fixtureRoot);
async function pair(name, input, suffix, status, exitCode, options = {}) {
  const args = ["package", "identity", input, ...suffix];
  const human = await record(`${name}-human`, args, { expectedExit: exitCode, ...options });
  const json = JSON.parse(await record(`${name}-json`, [...args, "--json"], { expectedExit: exitCode, ...options }));
  assert.equal(json.status, status); assert.equal(json.exitCode, exitCode);
  for (const value of [`identity: ${json.status}`, `Input: ${json.input}`, `Expected: ${json.expected ?? "(not supplied)"}`,
    `Observed: ${json.observed ?? "(unavailable)"}`, `Exit code: ${json.exitCode}`]) assert.ok(human.includes(value), value);
  if (json.error) assert.ok(human.includes(`Error: ${json.error.code}: ${json.error.message}`));
  return json;
}
assert.equal((await pair("compute-host", host, [], "computed", 0)).observed, hostRoot);
await pair("match-host", host, ["--expected", hostRoot], "match", 0);
await pair("match-runtime", runtime, ["--expected", runtimeRoot], "match", 0);
await pair("mismatch", host, ["--expected", `sha256:${"0".repeat(64)}`], "mismatch", 1);
await pair("invalid-expected", host, ["--expected", "sha256:INVALID"], "error", 2);
await pair("missing", path.join(fixtureRoot, "missing"), [], "error", 2);
await pair("file-root", path.join(host, "runtime.json"), [], "error", 2);
await pair("unreadable", host, [], "error", 2, { unreadableFile: path.join(host, "runtime.json") });
assert.deepEqual(await inventory(fixtureRoot), inputBefore, "Input paths/bytes unchanged");
const link = path.join(evidence, "root-link");
await symlink(host, link, "junction");
await pair("root-link", link, [], "error", 2);
await symlink(host, path.join(host, "nonregular-link"), "junction");
await pair("nonregular-entry", host, [], "error", 2);
assert.deepEqual(await inventory(distribution), before, "Install-root bytes/paths unchanged");
assert.deepEqual(await readdir(cwd), [], "No store/workspace/lock in unrelated cwd");
await writeFile(path.join(evidence, "distribution-inventory.json"), JSON.stringify(before, null, 2) + "\n");
const receipt = { schema: "fgpm.release-qualification/1", status: "pass", platform: process.platform,
  architecture: process.arch, node: process.versions.node, captureTime: new Date().toISOString(), identity,
  presentationsEquivalent: true, inputBytesAndPathsUnchanged: true, installBytesAndPathsUnchanged: true,
  sourceFreeCleanExtraction: true, publicContractSourceCorrespondence: true,
  testPairs: 10, invocations: runs.length, runs,
  boundaries: "Direct bundled-runtime execution; static member/source checks; no authenticity/safety/acceptance, no concurrent writers. Unique link cases created only in derived fixtures." };
await writeFile(path.join(evidence, "identity-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify(receipt, null, 2));
