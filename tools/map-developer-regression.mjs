// SPDX-License-Identifier: Apache-2.0
// Owner development provenance, not a source-free qualification implementation.
import { execFileSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
const option = (name) => process.argv[process.argv.indexOf(name) + 1];
const root = path.resolve(option("--repository"));
const output = path.resolve(option("--out"));
const logPath = path.resolve(option("--original-log"));
const commit = "b783e15f924c909332c38d2357930bd707f5a043";
const git = (args) => execFileSync("git", args, { cwd: root });
const sha = (value) => createHash("sha256").update(value).digest("hex");
const log = await readFile(logPath);
const names = [...log.toString("utf8").matchAll(/^✔ (.+) \([\d.]+ms\)$/gmu)].map((entry) => entry[1]);
if (names.length !== 137) throw new Error(`Original raw log must contain exactly 137 cases, got ${names.length}`);
const files = git(["ls-tree", "-r", "--name-only", commit, "--", "test", "maintained-packages/fgpm.grid-dungeon-integration-runtime/tests"])
  .toString("utf8").trim().split("\n").filter((name) => name.endsWith(".test.mjs"));
const declarations = [], sources = [];
await mkdir(output, { recursive: false });
await mkdir(path.join(output, "original-case-bodies"));
for (const file of files) {
  const bytes = git(["show", `${commit}:${file}`]);
  const text = bytes.toString("utf8");
  const matches = [...text.matchAll(/(?:^|\n)\s*test\(("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]+`)/gu)];
  const destination = file.replaceAll("/", "__");
  await writeFile(path.join(output, "original-case-bodies", destination), bytes);
  sources.push({ path: file, retainedPath: `original-case-bodies/${destination}`, bytes: bytes.length, sha256: sha(bytes) });
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    const start = match.index + match[0].indexOf("test(");
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
    declarations.push({ name: match[1].startsWith('"') ? JSON.parse(match[1])
      : match[1].slice(1, -1).replaceAll("\\'", "'"), file,
      line: text.slice(0, start).split("\n").length, endLineExclusive: text.slice(0, end).split("\n").length,
      body: text.slice(start, end), sourceSha256: sha(bytes) });
  }
}
const cases = names.map((name, index) => {
  const matches = declarations.filter((entry) => entry.name === name
    || (name.startsWith("diagnoses ") && entry.name === "diagnoses ${label}")
    || (name.startsWith("tasks are denied ") && name.endsWith(" without partial mutation")
      && entry.name === "tasks are denied ${name} without partial mutation"));
  if (matches.length !== 1) throw new Error(`Ambiguous/unmapped original case: ${name}, ${matches.length}`);
  const declaration = matches[0];
  const staticAudit = /genericSources|conformance\.mjs|const html =|generic Workbench source|buildScript|execFileSync\("git"/u.test(declaration.body);
  return { id: `DEV-ORIGINAL-${String(index + 1).padStart(3, "0")}`, name,
    source: { path: declaration.file, line: declaration.line, endLineExclusive: declaration.endLineExclusive, sha256: declaration.sourceSha256 },
    declarationName: declaration.name, retainedOriginalBody: true,
    disposition: "original developer case retained; not ported or claimed source-free equivalent",
    includesStaticSourceOrBuilderAudit: staticAudit,
    dependencyAssessment: "Original case requires owner checkout/imports; flag is a bounded lexical observation, not an exhaustive portability audit",
    portableReplacement: null };
});
const report = { schema: "fgpm.original-developer-regression-map/1", sourceCommit: commit,
  captureTime: new Date().toISOString(), originalLog: { path: logPath, bytes: log.length, sha256: sha(log) },
  originalCases: 137, mappedCases: cases.length, sourceFiles: sources,
  sourceFreeEquivalentCases: 0, qualificationClaim: "No source-free original-137 equivalence claimed; 15 separately named PQ cases are additive boundary evidence",
  cases };
await writeFile(path.join(output, "original137-case-map.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ status: "pass", mappedCases: cases.length, output }, null, 2));
