// SPDX-License-Identifier: Apache-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ReferenceTargetError, verifyReferenceTarget } from "../src/core/reference-target.mjs";
import { hashDirectory, stableJson } from "../src/core/io.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildScript = path.join(root, "tools", "build-reference-distribution.mjs");
const testWorkRoot = process.env.FGPM_TEST_WORK_ROOT ?? os.tmpdir();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const managerBuildInput = { schema: "fgpm.manager-build-identity-input/1", version: "0.11.0-rc.6", trees: {
  contracts: `sha256:${await hashDirectory(path.join(root, "contracts"))}`,
  public: `sha256:${await hashDirectory(path.join(root, "public"))}`,
  src: `sha256:${await hashDirectory(path.join(root, "src"))}`,
} };
const managerBuildIdentity = `sha256:${sha256(stableJson(managerBuildInput))}`;
assert.equal(managerBuildIdentity, JSON.parse(await readFile(path.join(root, "manager.json"), "utf8")).buildIdentity,
  "manager build identity must match the versioned src/public/contracts semantic input");

function run(launcher, args, cwd, options = {}) {
  const bin = path.join(path.dirname(launcher), "bin");
  return execFileSync(path.join(bin, "node.exe"), [path.join(bin, "fgpm.mjs"), ...args],
    { cwd, encoding: "utf8", ...options });
}

function runResult(launcher, args, cwd) {
  const bin = path.join(path.dirname(launcher), "bin");
  return spawnSync(path.join(bin, "node.exe"), [path.join(bin, "fgpm.mjs"), ...args],
    { cwd, encoding: "utf8" });
}

async function tree(rootPath) {
  const result = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else result.push({ absolute, relative: path.relative(rootPath, absolute).replaceAll(path.sep, "/") });
    }
  }
  await visit(rootPath);
  return result.sort((left, right) => left.relative.localeCompare(right.relative, "en"));
}

async function treeIdentity(rootPath) {
  const entries = await tree(rootPath);
  return sha256(Buffer.from((await Promise.all(entries.map(async (entry) =>
    `${sha256(await readFile(entry.absolute))}  ${entry.relative}`))).join("\n")));
}

test("source-free reference distribution is deterministic, clean, relocatable, and self-verifying", async () => {
  const temporary = await mkdtemp(path.join(testWorkRoot, "fgpm reference Ω "));
  try {
    const first = JSON.parse(execFileSync(process.execPath, [buildScript, "--out", path.join(temporary, "first")],
      { cwd: root, encoding: "utf8" }));
    const second = JSON.parse(execFileSync(process.execPath, [buildScript, "--out", path.join(temporary, "second")],
      { cwd: root, encoding: "utf8" }));
    assert.equal(first.zipSha256, second.zipSha256);
    const distribution = first.distribution;
    const names = (await tree(distribution)).map((entry) => entry.relative);
    assert.equal(names.some((name) => /(^|\/)(?:\.git|src|test|tools)(\/|$)/u.test(name)), false);
    assert.equal(names.some((name) => /(^|\/)packages\/demo\./u.test(name)), false);
    assert.equal(names.some((name) => /\.map$/u.test(name)), false);
    assert.ok(names.includes("guide/package-entrypoint-and-identity.md"));
    assert.match(await readFile(path.join(distribution, "RELEASE-NOTES.md"), "utf8"),
      /guide\/package-entrypoint-and-identity\.md/u);
    assert.match(await readFile(path.join(distribution, "guide", "package-authoring-guide.md"), "utf8"),
      /migrate pre-public-package <source> --namespace <publisher-uuid> --apply --out <new-output>/u);
    const sessionGuide = await readFile(path.join(distribution, "guide", "public-runtime-sessions.md"), "utf8");
    assert.match(sessionGuide, /Public package-owned runtime sessions \(0\.11\.0-rc\.6 candidate\)/u);
    assert.doesNotMatch(sessionGuide, /(?<!g)fpm\.control-(?:request|response)\/1/u);
    const guideRequests = [...sessionGuide.matchAll(/```json\r?\n([^`]+)\r?\n```/gu)]
      .map((match) => JSON.parse(match[1]));
    assert.deepEqual(guideRequests.map((request) => request.schema), [
      "fgpm.control-request/1", "fgpm.control-request/1", "fgpm.control-request/1",
    ]);
    assert.deepEqual(guideRequests.map((request) => request.operation), [
      "runtime.session.open", "runtime.session.call", "runtime.session.close",
    ]);
    for (const resultSchema of ["fgpm.public-runtime-session/1", "fgpm.public-runtime-session-call/1",
      "fgpm.public-runtime-session-close/1"]) {
      assert.match(sessionGuide, new RegExp(resultSchema.replaceAll(".", "\\."), "u"));
    }
    for (const entry of await tree(distribution)) {
      if (/\.(?:exe|bundle|fixture)$/u.test(entry.relative)) continue;
      const text = await readFile(entry.absolute, "utf8");
      assert.equal(text.includes(`${root}${path.sep}`), false, entry.relative);
    }

    const launcher = path.join(distribution, "fgpm.cmd");
    const unrelatedCwd = path.join(temporary, "Unrelated CWD Ω");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(unrelatedCwd));
    const before = await treeIdentity(distribution);
    const identity = JSON.parse(run(launcher, ["--version", "--json"], unrelatedCwd));
    const manager = JSON.parse(await readFile(path.join(root, "manager.json"), "utf8"));
    const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    assert.equal(identity.manager.version, manager.version);
    assert.equal(manager.version, metadata.version);
    assert.equal(identity.source.commit, execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
    const sbom = JSON.parse(await readFile(path.join(distribution, "manifests", "SBOM.json"), "utf8"));
    assert.equal(sbom.components.find((item) => item.kind === "implementation").version, manager.version);
    assert.match(run(launcher, ["help"], unrelatedCwd), new RegExp(manager.version.replaceAll(".", "\\."), "u"));
    assert.equal(identity.distribution.kind, "source-free-reference-authoring-v0");
    assert.equal(identity.manager.buildIdentity, managerBuildIdentity);
    assert.match(identity.runtime.implementationPayloadRoot, /^sha256:[0-9a-f]{64}$/u);
    assert.notEqual(identity.runtime.implementationPayloadRoot, identity.manager.buildIdentity);
    assert.match(identity.runtime.binaryRoot, /^sha256:[0-9a-f]{64}$/u);
    assert.match(identity.distribution.contentRoot, /^sha256:[0-9a-f]{64}$/u);
    assert.match(identity.publicContracts.root, /^sha256:[0-9a-f]{64}$/u);
    assert.notEqual(identity.distribution.contentRoot, identity.publicContracts.root);
    assert.match(identity.fixture.root, /^sha256:[0-9a-f]{64}$/u);
    assert.match(identity.source.correspondenceRoot, /^sha256:[0-9a-f]{64}$/u);
    assert.match(identity.licensing.root, /^sha256:[0-9a-f]{64}$/u);
    assert.deepEqual(identity.platform.target.os, "win32");
    assert.deepEqual(identity.platform.target.architecture, "x64");
    assert.deepEqual(identity.platform.target.executableFormat, "PE32+");
    assert.equal(identity.platform.target.nodeVersion, "24.18.0");
    const contracts = JSON.parse(run(launcher, ["contracts", "verify", "--json"], unrelatedCwd));
    assert.equal(contracts.status, "pass");
    const doctor = JSON.parse(run(launcher, ["doctor", "--json", "--manager-root",
      path.join(temporary, "Writable State")], unrelatedCwd));
    assert.equal(doctor.status, "pass");
    assert.equal(doctor.checks.find((entry) => entry.name === "identity-semantics").status, "pass");
    assert.equal(doctor.checks.find((entry) => entry.name === "licence-sbom").status, "pass");
    assert.equal(doctor.checks.find((entry) => entry.name === "network-posture").automaticNetworkAccess, false);
    const externalPackage = path.join(unrelatedCwd, "External Owner Ω", "example.external");
    await mkdir(externalPackage, { recursive: true });
    await writeFile(path.join(externalPackage, "fgpm-package.json"), JSON.stringify({
      format: "fgpm.package/1", namespace: "7c338fc7-3784-43f7-a92e-bad26437f3e2",
      name: "example.external", version: "1.0.0", license: "MIT",
      dependencies: [], contributions: [],
    }, null, 2));
    const cleanManager = path.join(temporary, "Clean External Manager Ω");
    const imported = JSON.parse(run(launcher, ["package", "import", externalPackage,
      "--manager-root", cleanManager], unrelatedCwd));
    assert.equal(imported.status, "imported");
    assert.equal(imported.package.coordinate,
      "7c338fc7-3784-43f7-a92e-bad26437f3e2/example.external");
    const listed = JSON.parse(run(launcher, ["package", "list", "--manager-root", cleanManager], unrelatedCwd));
    assert.equal(listed.packages.length, 1);
    assert.equal(listed.packages[0].root, imported.package.root);
    assert.equal(JSON.parse(run(launcher, ["package", "import", externalPackage,
      "--manager-root", cleanManager], unrelatedCwd)).package.root, imported.package.root);
    await writeFile(path.join(externalPackage, "fpm-package.json"),
      await readFile(path.join(externalPackage, "fgpm-package.json")));
    const competing = runResult(launcher, ["validate-package", externalPackage], unrelatedCwd);
    assert.equal(competing.status, 1);
    assert.match(competing.stderr, /^FGPM_PACKAGE_ENTRYPOINT_COMPETING:/u);
    assert.equal(await treeIdentity(distribution), before, "tool execution must not mutate its install root");

    const binding = path.join(temporary, "public-qualification-binding.json");
    await writeFile(binding, JSON.stringify({ distribution, archive: first.zip, expected: {
      managerVersion: manager.version, runtimePayloadRoot: first.runtimePayloadRoot,
      distributionContentRoot: first.toolContentRoot, publicContractRoot: first.publicContractRoot,
      archiveSha256: `sha256:${first.zipSha256}`
    } }));
    const qualified = JSON.parse(execFileSync(path.join(distribution, "bin", "node.exe"),
      [path.join(distribution, "qualification", "run.mjs"), "qualify", "--input", binding,
        "--out", path.join(temporary, "Public qualification Ω"), "--json"],
      { cwd: unrelatedCwd, encoding: "utf8", timeout: 180000, maxBuffer: 8 * 1024 * 1024 }));
    assert.equal(qualified.status, "pass"); assert.equal(qualified.passed, 15);
    assert.equal(qualified.sourceFree, true); assert.equal(qualified.original137Equivalent, false);
    assert.equal(await treeIdentity(distribution), before, "public kit preserves candidate bytes");

    const help = JSON.parse(run(launcher, ["help", "--json"], unrelatedCwd));
    assert.deepEqual(help.manager, identity.manager);
    for (const command of identity.supportedCommands) assert.ok(help.commands.includes(command), command);
    assert.ok(identity.supportedCommands.includes("migrate pre-public-package"));
    assert.match(run(launcher, ["migrate", "pre-public-package", "--help"], unrelatedCwd),
      /^Usage: fgpm migrate pre-public-package <source-directory> --namespace <uuid>/u);
    const controlHelp = run(launcher, ["control", "--help"], unrelatedCwd);
    assert.match(controlHelp, /^Usage: fgpm control/u);
    assert.equal(controlHelp.includes("src/cli.mjs"), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("sealed fixture verifies, materializes once, and runs without the source checkout", async () => {
  const temporary = await mkdtemp(path.join(testWorkRoot, "fgpm fixture Ω "));
  try {
    const built = JSON.parse(execFileSync(process.execPath, [buildScript, "--out", path.join(temporary, "candidate")],
      { cwd: root, encoding: "utf8" }));
    const launcher = path.join(built.distribution, "fgpm.cmd");
    const fixture = path.join(built.distribution, "fixtures", "runtime-task-v2.fixture");
    assert.equal(JSON.parse(run(launcher, ["fixture", "verify", fixture], temporary)).status, "pass");
    const workspace = path.join(temporary, "Fresh Author Ω");
    const materialized = JSON.parse(run(launcher, ["fixture", "materialize", fixture, "--out", workspace], temporary));
    assert.equal(materialized.status, "pass");
    const validated = JSON.parse(run(launcher, ["validate-profile", materialized.profile], temporary));
    assert.equal(validated.status, "valid");
    const baseSnapshot = path.join(temporary, "Base Snapshot Ω.svg");
    const runtime = run(launcher, ["run", materialized.profile, "--out", path.join(temporary, "Output Ω"),
      "--ticks", "1", "--snapshot", baseSnapshot], temporary);
    assert.match(runtime, /Runtime lifecycle:/u);
    const lock = await readFile(path.join(temporary, "Output Ω", "fgpm.lock.json"), "utf8");
    const lifecycle = await readFile(path.join(temporary, "Output Ω", "runtime-lifecycle.json"), "utf8");
    assert.match(lock, new RegExp(managerBuildIdentity.slice("sha256:".length), "u"));
    assert.match(lifecycle, new RegExp(managerBuildIdentity.slice("sha256:".length), "u"));

    const focus = "task:evaluation.fresh-z-offset/add-z/1";
    const profile = JSON.parse(await readFile(materialized.profile, "utf8"));
    profile.packageRoots = [path.join(workspace, "packages"), path.join(temporary, "Authored Packages Ω")];
    profile.distribution.roots.push("evaluation.fresh-z-offset");
    const authored = path.join(temporary, "Authored Packages Ω", "evaluation.fresh-z-offset");
    await cp(path.join(root, "fixtures", "class-c-correction", "evaluation.fresh-z-offset"), authored,
      { recursive: true });
    const validProfile = path.join(temporary, "profile-valid.json");
    await writeFile(validProfile, `${JSON.stringify(profile, null, 2)}\n`);
    const validOutput = path.join(temporary, "Conformance Valid Ω");
    const valid = JSON.parse(run(launcher, ["conformance", "runtime-task", validProfile,
      "--focus", focus, "--out", validOutput], temporary, {
      env: { ...process.env, PATH: "", Path: "" },
    }));
    assert.equal(valid.status, "pass");
    const validReport = JSON.parse(await readFile(valid.report, "utf8"));
    assert.equal(validReport.environment.manager.distributionKind, "source-free-reference-authoring-v0");
    assert.equal(validReport.environment.manager.buildIdentity, managerBuildIdentity);
    assert.equal(validReport.environment.manager.sourceRoot, undefined);
    const version = JSON.parse(await readFile(path.join(root, "manager.json"), "utf8")).version;
    assert.ok(validReport.environment.manager.installationRoot.endsWith(`fgpm-reference-tools-win32-x64-v${version}`));
    assert.match(validReport.inputs.identities.runtimeImplementationPayload, /^sha256:[0-9a-f]{64}$/u);
    assert.match(validReport.inputs.identities.toolDistributionContent, /^sha256:[0-9a-f]{64}$/u);
    assert.match(validReport.inputs.identities.publicContractSet, /^sha256:[0-9a-f]{64}$/u);
    assert.match(validReport.inputs.identities.sealedFixture, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(validReport.toolBeforeAfterAudit.unchanged, true);
    assert.notEqual(await readFile(path.join(validOutput, "single-worker", "scene.svg"), "utf8"),
      await readFile(baseSnapshot, "utf8"));

    const excludedProfile = path.join(temporary, "profile-excluded.json");
    const excluded = structuredClone(profile);
    excluded.policy.collectionPolicy["runtime.task"] = {
      id: "policy:evaluation.fresh-z-offset/exclude-add-z/1", exclude: [focus],
    };
    await writeFile(excludedProfile, `${JSON.stringify(excluded, null, 2)}\n`);
    const excludedSnapshot = path.join(temporary, "Excluded Snapshot Ω.svg");
    run(launcher, ["run", excludedProfile, "--out", path.join(temporary, "Excluded Output Ω"),
      "--ticks", "1", "--snapshot", excludedSnapshot], temporary);
    assert.equal(await readFile(excludedSnapshot, "utf8"), await readFile(baseSnapshot, "utf8"));

    const invalidRoot = path.join(temporary, "Invalid Packages Ω");
    await cp(path.join(root, "fixtures", "class-c-correction", "evaluation.fresh-z-offset-invalid"),
      path.join(invalidRoot, "evaluation.fresh-z-offset"), { recursive: true });
    const invalidProfile = path.join(temporary, "profile-invalid.json");
    await writeFile(invalidProfile, `${JSON.stringify({ ...profile,
      packageRoots: [path.join(workspace, "packages"), invalidRoot] }, null, 2)}\n`);
    const invalidOutput = path.join(temporary, "Conformance Invalid Ω");
    const invalid = runResult(launcher, ["conformance", "runtime-task", invalidProfile,
      "--focus", focus, "--out", invalidOutput], temporary);
    assert.equal(invalid.status, 1, invalid.stderr);
    const invalidReport = JSON.parse(await readFile(path.join(invalidOutput,
      "runtime-task-conformance.json"), "utf8"));
    assert.equal(invalidReport.failure.code, "FGPM_TASK_COMMAND_COMPOSITION_AMBIGUOUS");
    assert.equal(invalidReport.failure.focus, focus);
    assert.equal(invalidReport.failure.authoritativeStateUnchanged, true);
    assert.equal(invalidReport.failure.mutationCommitted, false);
    assert.equal(invalidReport.failure.successfulTickCommitted, false);
    assert.equal(invalidReport.toolBeforeAfterAudit.unchanged, true);

    const malformedProfile = path.join(temporary, "profile-malformed.json");
    await writeFile(malformedProfile, "{\"schema\":\"fgpm.profile/3\"}\n");
    const malformedOutput = path.join(temporary, "Conformance Malformed Ω");
    const malformed = runResult(launcher, ["conformance", "runtime-task", malformedProfile,
      "--focus", focus, "--out", malformedOutput], temporary);
    assert.equal(malformed.status, 1);
    assert.equal(malformed.stderr.includes("\n    at "), false);
    const malformedReport = JSON.parse(await readFile(path.join(malformedOutput,
      "runtime-task-conformance.json"), "utf8"));
    assert.match(malformedReport.failure.code, /^FGPM_(?:PROFILE|PUBLIC)_/u);
    assert.equal(malformedReport.toolBeforeAfterAudit.unchanged, true);

    const managerRoot = path.join(temporary, "Persistent Manager Ω");
    const imported = JSON.parse(run(launcher, ["package", "import", authored,
      "--manager-root", managerRoot], temporary));
    const created = JSON.parse(run(launcher, ["workspace", "create", "external-author",
      "--manager-root", managerRoot], temporary));
    const operationFile = path.join(temporary, "workspace-operation Ω.json");
    await writeFile(operationFile, `${JSON.stringify({ type: "add", packageRoot: imported.package.root }, null, 2)}\n`);
    const staged = JSON.parse(run(launcher, ["workspace", "stage", "external-author", operationFile,
      "--expected", created.revision.identity, "--actor", "author:source-free-test",
      "--manager-root", managerRoot], temporary));
    assert.equal(staged.operation.type, "add");
    assert.equal(staged.operation.attribution.actor, "author:source-free-test");
    assert.notEqual(staged.revision.identity, created.revision.identity);

    for (const operation of ["activate", "rollback"]) {
      const rejected = runResult(launcher, ["generation", operation, `sha256:${"0".repeat(64)}`,
        "--manager-root", path.join(temporary, `Manager ${operation}`)], temporary);
      assert.equal(rejected.status, 1);
      assert.match(rejected.stderr, /FGPM_CONTROL_SESSION_REQUIRED/u);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("target verifier rejects non-Windows, wrong-version, non-PE, and wrong-architecture runtimes", async () => {
  const required = JSON.parse(await readFile(path.join(root, "reference-runtime.json"), "utf8"));
  const valid = { host: { os: process.platform, architecture: process.arch, nodeVersion: process.versions.node },
    runtimePath: process.execPath, nodeVersion: process.versions.node };
  assert.equal((await verifyReferenceTarget(valid, required)).target.executableFormat, "PE32+");
  for (const observed of [
    { ...valid, host: { ...valid.host, os: "linux" } },
    { ...valid, nodeVersion: "24.17.0" },
  ]) {
    await assert.rejects(() => verifyReferenceTarget(observed, required),
      (error) => error instanceof ReferenceTargetError && error.code === "FGPM_REFERENCE_TARGET_MISMATCH");
  }
  const temporary = await mkdtemp(path.join(testWorkRoot, "fgpm target rejection "));
  try {
    const nonPe = path.join(temporary, "node.exe");
    await writeFile(nonPe, "not a PE runtime");
    await assert.rejects(() => verifyReferenceTarget({ ...valid, runtimePath: nonPe }, required),
      (error) => error.details.failures.some((entry) => entry.reason === "not-pe"));
    const wrongArchitecture = Buffer.from(await readFile(process.execPath));
    const peOffset = wrongArchitecture.readUInt32LE(0x3c);
    wrongArchitecture.writeUInt16LE(0xaa64, peOffset + 4);
    const armRuntime = path.join(temporary, "node-arm64.exe");
    await writeFile(armRuntime, wrongArchitecture);
    await assert.rejects(() => verifyReferenceTarget({ ...valid, runtimePath: armRuntime }, required),
      (error) => error.details.failures.some((entry) => entry.field === "runtime.machine"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("tool, runtime, public-contract, and fixture tampering fail before conformance", async () => {
  const temporary = await mkdtemp(path.join(testWorkRoot, "fgpm tamper "));
  try {
    const built = JSON.parse(execFileSync(process.execPath, [buildScript, "--out", temporary], { cwd: root, encoding: "utf8" }));
    const launcher = path.join(built.distribution, "fgpm.cmd");
    const payload = path.join(built.distribution, "bin", "fgpm-runtime.bundle");
    const originalPayload = await readFile(payload);
    const bytes = Buffer.from(originalPayload);
    bytes[0] ^= 0xff;
    await writeFile(payload, bytes);
    assert.throws(() => run(launcher, ["--version", "--json"], temporary), /FGPM_DISTRIBUTION_TAMPERED/u);
    await writeFile(payload, originalPayload);

    const missingProfile = path.join(temporary, "not-needed-because-tamper.json");
    const readme = path.join(built.distribution, "README.md");
    const originalReadme = await readFile(readme);
    await writeFile(readme, Buffer.concat([originalReadme, Buffer.from("tampered")]));
    let invocation = runResult(launcher, ["conformance", "runtime-task", missingProfile,
      "--focus", "task:not-reached/1", "--out", path.join(temporary, "tool-tamper")], temporary);
    assert.equal(invocation.status, 1);
    assert.match(invocation.stderr, /FGPM_DISTRIBUTION_TAMPERED/u);
    await writeFile(readme, originalReadme);

    const publicSchema = path.join(built.distribution, "public", "schemas", "profile-v3.schema.json");
    const originalSchema = await readFile(publicSchema);
    await writeFile(publicSchema, Buffer.concat([originalSchema, Buffer.from("tampered")]));
    invocation = runResult(launcher, ["conformance", "runtime-task", missingProfile,
      "--focus", "task:not-reached/1", "--out", path.join(temporary, "contract-tamper")], temporary);
    assert.equal(invocation.status, 1);
    assert.match(invocation.stderr, /FGPM_DISTRIBUTION_TAMPERED/u);
    await writeFile(publicSchema, originalSchema);

    const fixture = path.join(built.distribution, "fixtures", "runtime-task-v2.fixture");
    const document = JSON.parse(await readFile(fixture, "utf8"));
    document.files[0].content = Buffer.from("tampered").toString("base64");
    await writeFile(fixture, JSON.stringify(document));
    invocation = runResult(launcher, ["conformance", "runtime-task", missingProfile,
      "--focus", "task:not-reached/1", "--out", path.join(temporary, "fixture-tamper")], temporary);
    assert.equal(invocation.status, 1);
    assert.match(invocation.stderr, /FGPM_DISTRIBUTION_TAMPERED/u);
    const sourceCli = path.join(root, "src", "cli.mjs");
    invocation = spawnSync(process.execPath, [sourceCli, "fixture", "verify", fixture],
      { cwd: temporary, encoding: "utf8" });
    assert.equal(invocation.status, 1);
    const result = JSON.parse(invocation.stdout);
    assert.equal(result.status, "fail");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
