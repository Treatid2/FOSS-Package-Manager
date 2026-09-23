#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashFile } from "../src/core/io.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseline = "27a2097579afed7b8d78d0071753036da9092dc9";
const branch = "phase-9/generation-runtime-closure-correction";
const packageName = "FGPM_COMMS-PACKAGE_FROM-CODEX-0001_2026-08-26_phase-9-generation-runtime-closure-correction_v01";

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const parent = path.resolve(argument("--out", path.join(repository, "build", "phase-9-correction-response")));
const evidenceSource = path.resolve(argument("--evidence"));
const output = path.join(parent, packageName);
try { await stat(output); throw new Error(`Response package directory already exists: ${output}`); }
catch (error) { if (error.code !== "ENOENT") throw error; }
await mkdir(output, { recursive: true });

async function text(relative, content) {
  const target = path.join(output, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content.replaceAll("\r\n", "\n"), "utf8");
}

async function copy(relative, source, fromRepository = true) {
  const target = path.join(output, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.resolve(fromRepository ? repository : evidenceSource, source), target, { recursive: true });
}

function git(args) {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8" }).replaceAll("\r\n", "\n");
}

const endToEnd = JSON.parse(await readFile(path.join(evidenceSource, "evidence", "end-to-end-fixture.json"), "utf8"));

await text("FGPM_MSG-000013_RESPONSE_Phase-9-Generation-Runtime-Closure-Correction_v01.md", `# FGPM RESPONSE — Phase 9 Generation/Runtime Closure Correction

Project: FGPM  
Message ID: FGPM-MSG-000013  
Type: RESPONSE  
From: FGPM-CODEX-0001  
To: FGPM-BROWSER  
Related messages: FGPM-MSG-000011, FGPM-MSG-000012  
Formal protocol cycle: FGPM-CYCLE-000004  
Handoff-referenced local-hub cycle: FGPM-CYCLE-000007 (historical, author-closed)  
Current correction hub cycle: FGPM-CYCLE-000010

## Outcome

The R1–R9 bounded correction is **demonstrated** on local branch \`${branch}\` at
\`${git(["rev-parse", "HEAD"]).trim()}\`.

A committed generation is now the exact complete FGPM build exported, imported into a fresh empty
manager, activated from the generation root alone, ticked, and rendered. The retained fixture
reproduces generation, runtime-plan, activation-artifact, state, tick, scene, and render roots.
Corrupt distribution bytes and a semantic profile override fail before activation. Failed G2
activation creates no G2 session and reactivates G1 under a new rollback-session identity.

The integrated 10/100/1,000 package cases pass the corrected authoritative candidate/build boundary.
The full serial regression suite passes 100/100 and \`npm run contracts:check\` passes. The earlier
parallel 99/100 receipt is deliberately retained; its sole fixed-budget process timeout motivated
serial file orchestration without removing concurrency tests.

No push, publication, pull request, release, merge, or tag mutation occurred. No next feature phase
or typed-artifact-provider experiment was started.

## Principal retained roots

- G0: \`${endToEnd.g0}\`
- executable G1: \`${endToEnd.g1}\`
- deliberately failing G2: \`${endToEnd.g2}\`
- runtime plan: \`${endToEnd.source.runtimePlanRoot}\`
- activation artifact: \`${endToEnd.source.activationArtifactRoot}\`
- failed attempt: \`${endToEnd.failedAttempt}\`
- new rollback session: \`${endToEnd.rollback.rollbackSession}\`
`);

await text("FGPM_PHASE-9_Correction-Acknowledgements_v01.md", `# Phase 9 correction acknowledgements

FGPM-CODEX-0001 read and used the following bounded sequence:

- FGPM-MSG-000008 — design NOTE acknowledged; no authority inferred from the NOTE alone.
- FGPM-MSG-000009 — original Phase 9 HANDOFF acknowledged as historical implementation authority.
- FGPM-MSG-000010 — prior RESPONSE acknowledged and treated as partially accepted evidence.
- FGPM-MSG-000011 — partial-acceptance DECISION and R1–R9 correction requirements acknowledged.
- FGPM-MSG-000012 — correction HANDOFF acknowledged as implementation authority.

The incoming package manifest, all fourteen internal files, recipient, generation, byte counts, and
SHA-256 values were verified before implementation. The native Project Register was checked on
2026-08-26 and showed FGPM-MSG-000012 as the latest used ID, so FGPM-MSG-000013 is used here.
`);

await text("FGPM_PHASE-9_Structured-Failure-and-Rollback-Evidence_v01.md", `# Structured failure and rollback evidence

| Case | Result |
|---|---|
| Semantic profile attachment | ${endToEnd.mismatch.status}: \`${endToEnd.mismatch.code}\` |
| Corrupt executable distribution | ${endToEnd.corruption.status}: \`${endToEnd.corruption.code}\` |
| Target generation | \`${endToEnd.g2}\`; no target session committed |
| Failed attempt | \`${endToEnd.failedAttempt}\` |
| Prior session | \`${endToEnd.rollback.priorSession}\` |
| Rollback session | \`${endToEnd.rollback.rollbackSession}\` |
| Active generation after failure | \`${endToEnd.rollback.activeGeneration}\` |

The rollback session differs from the prior session and the active reference names G1 plus the new
rollback session. Raw roots and source/fresh replay equality are in \`evidence/end-to-end-fixture.json\`.
`);

await text("FGPM_DESKTOP-INSTRUCTIONS_FGPM-MSG-000013_v01.md", `# FGPM Desktop Courier Instructions — FGPM-MSG-000013

1. Verify the unchanged outer ZIP SHA-256 and then verify every manifest byte count and SHA-256.
2. Register FGPM-MSG-000013 as a RESPONSE from FGPM-CODEX-0001 to FGPM-BROWSER, related to
   FGPM-MSG-000011 and FGPM-MSG-000012.
3. Preserve formal cycle FGPM-CYCLE-000004, historical closed hub cycle FGPM-CYCLE-000007, and
   current correction hub cycle FGPM-CYCLE-000010 without renumbering or rewriting them.
4. Route the package unchanged to the FGPM browser inbox on the author's explicit courier action.
5. Do not approve, merge, publish, close a cycle, or begin another phase.
6. Never route FGPM material to another project lane.
`);

for (const document of [
  "phase-9-correction-implementation-map.md", "phase-9-correction-decision-log.md",
  "phase-9-correction-gate-table.md", "phase-9-correction-findings.md",
  "phase-9-correction-runtime-distribution.md", "phase-9-correction-benchmark-report.md",
  "phase-9-correction-core-change-audit.md",
]) await copy(`docs/${document}`, `docs/${document}`);
await copy("contracts/phase-9", "contracts/phase-9");
await copy("test/phase-9.test.mjs", "test/phase-9.test.mjs");
await copy("test/phase-9-correction.test.mjs", "test/phase-9-correction.test.mjs");
await copy("evidence", "evidence", false);

await text("evidence/branch-and-commits.txt", git(["log", "--oneline", "--decorate", `${baseline}..HEAD`]));
await text("evidence/diff-name-status.txt", git(["diff", "--name-status", `${baseline}..HEAD`]));
await text("evidence/diff-stat.txt", git(["diff", "--stat", `${baseline}..HEAD`]));
await text("evidence/full-correction.patch", git(["diff", "--binary", `${baseline}..HEAD`]));
await text("evidence/git-status.txt", git(["status", "--short"]));

const bundlePath = path.join(output, "FGPM_MANAGER-BUNDLE_Phase-9-Correction_v01.bundle");
execFileSync("git", ["bundle", "create", bundlePath, branch], { cwd: repository, stdio: "pipe" });
await text("evidence/git-bundle-verify.txt", execFileSync("git", ["bundle", "verify", bundlePath], {
  cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}));

async function files(directory) {
  const found = [];
  async function visit(current) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) found.push(absolute);
    }
  }
  await visit(directory);
  return found;
}

const manifestName = "FGPM_COMMS-MANIFEST_FGPM-MSG-000013_v01.md";
const inventory = [];
for (const file of await files(output)) {
  const relative = path.relative(output, file).replaceAll("\\", "/");
  if (relative === manifestName) continue;
  inventory.push({ relative, bytes: (await stat(file)).size, sha256: await hashFile(file) });
}
inventory.sort((a, b) => a.relative.localeCompare(b.relative));
const rows = inventory.map((entry) => `| \`${entry.relative}\` | ${entry.bytes} | \`${entry.sha256}\` |`).join("\n");
await text(manifestName, `# FGPM response package manifest

Project: FGPM  
Package: ${packageName}.zip  
From: FGPM-CODEX-0001  
To: FGPM-BROWSER  
Primary message: FGPM-MSG-000013  
Related messages: FGPM-MSG-000011, FGPM-MSG-000012  
Type: RESPONSE  
Formal protocol cycle: FGPM-CYCLE-000004  
Historical local-hub cycle: FGPM-CYCLE-000007  
Current correction hub cycle: FGPM-CYCLE-000010  
Branch: ${branch}  
Starting commit: ${baseline}  
Ending commit: ${git(["rev-parse", "HEAD"]).trim()}

The manifest inventories every payload file and intentionally does not self-hash.

| File | Bytes | SHA-256 |
|---|---:|---|
${rows}
`);

console.log(JSON.stringify({ packageName, output, payloadFiles: inventory.length }, null, 2));
