#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = process.argv[2] ? path.resolve(process.argv[2]) : null;
const externalConformance = process.argv[3] ? path.resolve(process.argv[3]) : null;
if (!destination || !externalConformance) {
  throw new Error("Usage: node tools/create-phase-8-handoff.mjs <new-empty-destination> <exact-commit-external-conformance.json>");
}
try {
  await stat(destination);
  throw new Error(`Handoff destination already exists: ${destination}`);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

function git(...args) {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
}

const status = git("status", "--porcelain=v1");
if (status) throw new Error(`Repository must be clean before handoff generation:\n${status}`);
const commit = git("rev-parse", "HEAD");
const branch = git("branch", "--show-current");
const phase7Commit = git("rev-parse", "phase-7-prototype^{commit}");
const phase7TagObject = git("rev-parse", "phase-7-prototype");
const remote = git("remote", "get-url", "origin");
const start = "1061fa060d8a40a33a20bd5a267d9e7e01ec7e99";

await mkdir(destination, { recursive: true });
execFileSync(process.execPath, [path.join(repository, "authoring-kit", "runtime-task-v2",
  "verify-public-contracts.mjs"), path.join(repository, "public")], { cwd: repository, stdio: "pipe" });
const managerDirectory = path.join(destination, "manager");
await mkdir(managerDirectory, { recursive: true });
const managerBundleName = `FGPM-Phase-8-${commit.slice(0, 7)}.bundle`;
const managerBundle = path.join(managerDirectory, managerBundleName);
git("bundle", "create", managerBundle, branch, "phase-7-prototype");
const bundleVerification = git("bundle", "verify", managerBundle);
const managerBundleHash = createHash("sha256").update(await readFile(managerBundle)).digest("hex");
const copies = [
  ["authoring-kit/runtime-task-v2", "authoring-kit/runtime-task-v2"],
  ["examples/external-runtime-task-v2", "public-test-fixture/external-runtime-task-v2"],
  ["profiles/runtime-task-v2.json", "public-test-fixture/profiles/runtime-task-v2.json"],
  ["profiles/runtime-task-v2-baseline.json", "public-test-fixture/profiles/runtime-task-v2-baseline.json"],
  ["profiles/runtime-task-v2-nudge-excluded.json", "public-test-fixture/profiles/runtime-task-v2-nudge-excluded.json"],
  ["fixtures/failures/packages/bad.task-base-v2", "public-test-fixture/failures/bad.task-base-v2"],
  ["fixtures/failures/profiles/task-v2-ambiguous.json", "public-test-fixture/failures/task-v2-ambiguous.json"],
  ["docs/phase-8-implementation-map.md", "docs/phase-8-implementation-map.md"],
  ["docs/phase-8-decision-log.md", "docs/phase-8-decision-log.md"],
  ["docs/phase-8-findings.md", "docs/phase-8-findings.md"],
  ["docs/phase-8-decision-report.md", "docs/phase-8-decision-report.md"],
  ["docs/phase-8-conformance-report.md", "docs/phase-8-conformance-report.md"],
  ["docs/phase-8-test-summary.md", "docs/phase-8-test-summary.md"],
  ["docs/phase-8-external-conformance.md", "docs/phase-8-external-conformance.md"],
  ["docs/phase-8-handoff-correction.md", "docs/phase-8-handoff-correction.md"],
  ["docs/review/post-phase-8-public-boundary-review.md", "docs/post-phase-8-public-boundary-review.md"],
  ["evidence/phase-8", "evidence"],
];
for (const [source, target] of copies) {
  await mkdir(path.dirname(path.join(destination, target)), { recursive: true });
  await cp(path.join(repository, source), path.join(destination, target), { recursive: true });
}
const externalReport = JSON.parse(await readFile(externalConformance, "utf8"));
if (externalReport.status !== "pass" || externalReport.environment?.manager?.git?.commit !== commit
  || externalReport.environment?.manager?.git?.coreDirty !== false
  || externalReport.coreBeforeAfterAudit?.unchanged !== true) {
  throw new Error("External conformance must pass at the exact clean handoff commit with an unchanged core audit.");
}
const retainedExternalReport = path.join(destination, "evidence", "external-runtime-task-conformance.json");
await cp(externalConformance, retainedExternalReport, { force: true });
const externalReportHash = createHash("sha256").update(await readFile(retainedExternalReport)).digest("hex");
const exactExternalDocument = `# Exact-checkpoint external conformance

This report was generated outside the manager repository at the exact handoff checkpoint. It is
not the second fresh-author test.

- Manager commit: \`${externalReport.environment.manager.git.commit}\`
- Manager branch: \`${externalReport.environment.manager.git.branch}\`
- Manager CLI: \`${externalReport.environment.manager.cli.sha256}\`
- Node: \`${externalReport.environment.node.version}\`
- Process working directory: \`${externalReport.environment.invocation.workingDirectory}\`
- Profile: \`${externalReport.inputs.profile.sha256}\`
- Public contracts: \`${externalReport.inputs.publicContracts.root}\`
- Installed distribution: \`${externalReport.inputs.installedDistribution.identity}\`
- Core before: \`${externalReport.coreBeforeAfterAudit.before.root}\`
- Core after: \`${externalReport.coreBeforeAfterAudit.after.root}\`
- Core unchanged: \`${externalReport.coreBeforeAfterAudit.unchanged}\`
- Report SHA-256: \`${externalReportHash}\`

Claims: deterministic record, transform, and SVG invariance passed; completion order varied only
observationally; manager core remained unchanged. The complete machine-readable report is
\`evidence/external-runtime-task-conformance.json\`.
`;
await writeFile(path.join(destination, "docs", "exact-checkpoint-external-conformance.md"),
  exactExternalDocument, "utf8");

const checkpoint = {
  schema: "fgpm.phase-8-handoff-checkpoint/1",
  repository: remote,
  branch,
  commit,
  correctionStart: start,
  phase7Prototype: { tagObject: phase7TagObject, commit: phase7Commit },
  node: process.version,
  generatedAtUtc: new Date().toISOString(),
  publication: { pushed: false, pullRequest: false, released: false },
  managerBundle: {
    path: `manager/${managerBundleName}`,
    sha256: `sha256:${managerBundleHash}`,
    verification: "passed",
    verificationOutput: bundleVerification || "git bundle verify exited successfully",
    includes: [branch, "phase-7-prototype"],
  },
  externalConformance: {
    path: "evidence/external-runtime-task-conformance.json",
    sha256: `sha256:${externalReportHash}`,
    managerCommit: externalReport.environment.manager.git.commit,
    coreUnchanged: true,
  },
};
await writeFile(path.join(destination, "CHECKPOINT.json"), `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
await writeFile(path.join(destination, "COMMITS.txt"),
  `${git("log", "--reverse", "--format=%H %s", `${start}..HEAD`)}\n`, "utf8");
await writeFile(path.join(destination, "NAME-STATUS.txt"),
  `${git("diff", "--name-status", `${start}..HEAD`)}\n`, "utf8");

const index = `# FGPM Phase 8 public-boundary handoff

This bundle is usable without the originating conversation. It contains the corrected public
authoring kit, relocatable public fixtures, fresh-author retest brief, findings/review, retained
conformance and failure evidence, exact manager checkpoint, commit/name-status lists, and hashes.

## Required manager installation

The exact unpublished manager checkpoint is carried in
\`manager/${managerBundleName}\` (SHA-256 \`${managerBundleHash}\`). Install it without GitHub:

\`git clone --branch ${branch} manager/${managerBundleName} FOSS-Package-Manager\`

\`git -C FOSS-Package-Manager checkout --detach ${commit}\`

\`git -C FOSS-Package-Manager rev-parse HEAD\`

The final command must print \`${commit}\`. The bundle contains branch \`${branch}\` and the
\`phase-7-prototype\` annotated tag. Use Node.js 22 or newer (bundle generated with
\`${process.version}\`). Do not infer a stable compatibility promise from the v2 identity.

\`${remote}\` remains provenance only: \`CHECKPOINT.json\` records that this exact correction
commit was not pushed. For a blind fresh-author exercise, the coordinator should install the
manager from the bundle and give the author only the CLI path, installed package root, public kit,
and test brief—not manager source.

## Start here

Read \`authoring-kit/runtime-task-v2/README.md\`, then
\`authoring-kit/runtime-task-v2/contract.md\`. For the independent test, follow only
\`authoring-kit/runtime-task-v2/external-test-brief.md\` and do not provide manager source.

The kit carries checkpoint copies of every public schema/vocabulary. Verify
\`CHECKSUMS.sha256\`, then run the kit's \`verify-public-contracts.mjs\` against the installed
manager's \`public\` directory before use.

## Installed-checkpoint commands

From a new external project copied from the kit:

\`node <fgpm>/src/cli.mjs validate-package <package>\`

\`node <fgpm>/src/cli.mjs validate-profile <profile> --packages <fgpm>/packages\`

\`node <fgpm>/src/cli.mjs conformance runtime-task <profile> --focus <exact-task-member> --packages <fgpm>/packages --out <out>\`

\`node <fgpm>/src/cli.mjs explain runtime <lifecycle.json> <channel-or-task>\`

## Evidence and limits

Gate A and Gate B passed within the documented experimental scope. The exact verification ledger
is in \`docs/phase-8-test-summary.md\`. The second fresh-author retest was prepared but was not run.
Native code remains trusted; the mixed v1/v2 distribution boundary and scale remain explicit
limits. Nothing was pushed, published, released, or opened as a pull request in this cycle.
`;
await writeFile(path.join(destination, "INDEX.md"), index, "utf8");

async function files(root) {
  const result = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) result.push(absolute);
    }
  }
  await visit(root);
  return result.sort();
}

const checksums = [];
for (const file of await files(destination)) {
  if (path.basename(file) === "CHECKSUMS.sha256") continue;
  const hash = createHash("sha256").update(await readFile(file)).digest("hex");
  checksums.push(`${hash}  ${path.relative(destination, file).replaceAll("\\", "/")}`);
}
await writeFile(path.join(destination, "CHECKSUMS.sha256"), `${checksums.join("\n")}\n`, "utf8");
console.log(JSON.stringify({ destination, branch, commit, phase7Commit,
  managerBundle: { path: managerBundle, sha256: `sha256:${managerBundleHash}` },
  files: checksums.length + 1 }, null, 2));
