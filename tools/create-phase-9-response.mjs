#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashFile } from "../src/core/io.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageName = "FGPM_COMMS-PACKAGE_FROM-CODEX-0001_2026-08-25_phase-9-persistent-workspace-generation-implementation_v01";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

const parent = path.resolve(argument("--out") ?? path.join(repository, "build", "phase-9-response"));
const output = path.join(parent, packageName);
try {
  await stat(output);
  throw new Error(`Response package directory already exists: ${output}`);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await mkdir(output, { recursive: true });

async function text(relative, content) {
  const target = path.join(output, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content.replaceAll("\r\n", "\n"), "utf8");
}

async function copy(relative, source) {
  const target = path.join(output, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.resolve(repository, source), target, { recursive: true });
}

function git(args) {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8" }).replaceAll("\r\n", "\n");
}

await text("FGPM_MSG-000010_RESPONSE_Phase-9-Persistent-Workspace-and-Generation-Implementation_v01.md", `# FGPM RESPONSE — Phase 9 Persistent Workspace and Generation Implementation

Project: FGPM  
Message ID: FGPM-MSG-000010  
Type: RESPONSE  
From: FGPM-CODEX-0001  
To: FGPM-BROWSER  
Related messages: FGPM-MSG-000008, FGPM-MSG-000009  
Project package cycle: FGPM-CYCLE-000004  
Authoritative local hub cycle: FGPM-CYCLE-000007

## Outcome

The bounded Phase 9 implementation is complete on local branch
\`phase-9/persistent-workspace-generations\`. Phase 9A Gates A–D and Phase 9B Gates E, X, and F
are demonstrated. Acceptance scale through 1,000 packages is retained. The complete regression
boundary passes 96 tests with zero failures, and the Phase 8 public authoring-kit checkpoint remains
byte-valid.

No push, publication, pull request, release, merge, or tag mutation occurred. No automatic
continuation is requested.

## Local commits

- \`69a036c\` — Implement persistent workspace and generation transactions.
- \`b15805b\` — Add Phase 9 acceptance evidence and reports.
- \`a1bc0fb\` — Retain final Phase 9 verification evidence.
- response-packaging commit: see \`evidence/branch-and-commits.txt\`.

## Unresolved

No implementation gate is blocked. The optional 10,000-package exploratory run was deferred as
permitted. Remote transport, signatures, destructive collection, hot service replacement,
renderer/engine integration, and the typed-artifact-provider follow-on remain explicit non-goals.
`);

await text("FGPM_PHASE-9_Gate-Completion-Table_v01.md", `# Phase 9 gate completion

| Gate | Result | Primary evidence |
| --- | --- | --- |
| 0 — baseline/safety | PASS | Exact \`cf2a0c45...\`, clean branch, 83 baseline tests, contracts pass. |
| A — package store/workspace | PASS | Import inertness/idempotence/conflict, restart, history, CAS tests. |
| B — candidate/impact | PASS | Determinism, causal leaf/central closure, ambiguity/choice, staleness. |
| C — derivation/generation | PASS | Reuse/invalidation/depth, interruption, concurrent commit. |
| D — distribution replay | PASS | Empty-store exact replay, reorder, missing/corrupt rejection. |
| E — runtime transition | PASS | Controlled and real Phase 8 checkpoint/restore/failure rollback. |
| X — package exit/state | PASS | Dependency blocking, retention, optional/required owner cases. |
| F — scale | PASS | 10/100/1,000; local diagnostics at 1,000; 10,000 deferred. |
| Regression boundary | PASS | 96/96 tests, contracts and frozen public kit pass. |
`);

await text("FGPM_PHASE-9_Focused-Failure-Diagnostics_v01.md", `# Focused Phase 9 failure diagnostics

The retained suite demonstrates these pre-commit failures with structured codes and causal data:

- \`FGPM_PACKAGE_VERSION_CONFLICT\` — same package ID/version with different content roots;
- \`FGPM_WORKSPACE_HEAD_CONFLICT\` — compare-and-swap edit loser;
- \`FGPM_CANDIDATE_DEPENDENCY_MISSING\` and
  \`FGPM_CANDIDATE_DEPENDENCY_VERSION_INCOMPATIBLE\`;
- \`FGPM_CANDIDATE_PROVIDER_AMBIGUOUS\` until an explicit provider choice;
- \`FGPM_CANDIDATE_DEPENDENCY_CYCLE\` with an exact local cycle path;
- \`FGPM_DERIVED_DEPTH_UNSUPPORTED\` for recursive generation;
- \`FGPM_SIMULATED_GENERATION_INTERRUPTION\` before workspace-reference movement;
- \`FGPM_CANDIDATE_STALE\` after another head commits;
- \`FGPM_DISTRIBUTION_MEMBER_SET_INVALID\` and \`FGPM_DISTRIBUTION_MEMBER_CORRUPT\`;
- \`FGPM_GENERATION_REQUIRED_STATE_OWNER_MISSING\` before old-runtime shutdown;
- \`FGPM_GENERATION_TRANSITION_FAILED\` with checkpoint, rollback, and unchanged active reference.

The raw 1,000-package diagnostic records are in \`evidence/benchmark-results.json\`; executable
assertions are in \`evidence/phase-9.test.mjs\`.
`);

await text("FGPM_PHASE-9_Unresolved-and-Non-Claims_v01.md", `# Phase 9 unresolved items and non-claims

## Unresolved

- No required gate is incomplete.
- The exploratory 10,000-package run is deferred; it is not an acceptance requirement.
- A later review may choose an archive container for the verified directory distribution.
- A later environment test may evaluate filesystem-lease behavior on network storage.

## Non-claims

The result does not claim a remote package repository, publisher trust, signatures, automatic
compatibility, destructive garbage collection, recursive generated-package fixed points,
per-service hot replacement, zero-downtime multiplayer upgrade, renderer/engine integration,
production performance, or version-one compatibility.
`);

await text("FGPM_DESKTOP-INSTRUCTIONS_FGPM-MSG-000010_v01.md", `# FGPM Desktop Courier Instructions — FGPM-MSG-000010

1. Verify the unchanged outer ZIP SHA-256 and open its manifest.
2. Verify every manifest byte count and SHA-256 before routing.
3. Register \`FGPM-MSG-000010\` as a RESPONSE from FGPM-CODEX-0001 to FGPM-BROWSER, related to
   \`FGPM-MSG-000009\` and acknowledging \`FGPM-MSG-000008\`.
4. Preserve the project-package cycle \`FGPM-CYCLE-000004\` and the authoritative local-hub mapping
   \`FGPM-CYCLE-000007\`.
5. Route the package unchanged to the FGPM browser manager on the author's next explicit poke.
6. Do not approve, merge, publish, or close either cycle. Author review and explicit closure remain
   separate.
7. Never route FGPM material to TRW or Graph Evolution.
`);

for (const document of [
  "phase-9-implementation-map.md", "phase-9-decision-log.md", "phase-9-findings.md",
  "phase-9-benchmark-report.md", "phase-9-distribution-replay.md", "phase-9-runtime-transition.md",
  "phase-9-decision-report.md", "phase-9-core-change-audit.md", "phase-9-test-summary.md",
]) await copy(`docs/${document}`, `docs/${document}`);
await copy("contracts/phase-9", "contracts/phase-9");
await copy("evidence", "evidence/phase-9");
await copy("evidence/phase-9.test.mjs", "test/phase-9.test.mjs");

await text("evidence/branch-and-commits.txt", git(["log", "--oneline", "--decorate",
  "cf2a0c45ba8d41459c9771f873f2cc993897bc50..HEAD"]));
await text("evidence/diff-name-status.txt", git(["diff", "--name-status",
  "cf2a0c45ba8d41459c9771f873f2cc993897bc50..HEAD"]));
await text("evidence/git-status.txt", git(["status", "--short"]));

const bundlePath = path.join(output, "FGPM_MANAGER-BUNDLE_Phase-9_v01.bundle");
execFileSync("git", ["bundle", "create", bundlePath, "phase-9/persistent-workspace-generations"], {
  cwd: repository, stdio: "pipe",
});
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

const inventory = [];
for (const file of await files(output)) {
  const relative = path.relative(output, file).replaceAll("\\", "/");
  if (relative === "FGPM_COMMS-MANIFEST_FGPM-MSG-000010_v01.md") continue;
  inventory.push({ relative, bytes: (await stat(file)).size, sha256: await hashFile(file) });
}
inventory.sort((a, b) => a.relative.localeCompare(b.relative));
const rows = inventory.map((entry) => `| \`${entry.relative}\` | ${entry.bytes} | \`${entry.sha256}\` |`).join("\n");
await text("FGPM_COMMS-MANIFEST_FGPM-MSG-000010_v01.md", `# FGPM response package manifest

Project: FGPM  
Package: ${packageName}.zip  
From: FGPM-CODEX-0001  
To: FGPM-BROWSER  
Primary message: FGPM-MSG-000010  
Related message: FGPM-MSG-000009  
Acknowledged design note: FGPM-MSG-000008  
Type: RESPONSE  
Project package cycle: FGPM-CYCLE-000004  
Authoritative local hub cycle: FGPM-CYCLE-000007  
Branch: phase-9/persistent-workspace-generations  
Starting commit: cf2a0c45ba8d41459c9771f873f2cc993897bc50

The manifest inventories every payload file and does not self-hash.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
${rows}
`);

console.log(JSON.stringify({ packageName, output, payloadFiles: inventory.length }, null, 2));

