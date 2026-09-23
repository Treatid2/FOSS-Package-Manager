// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CurationManager, publishImmutableDirectory } from "../src/core/curation.mjs";
import { discoverPackages } from "../src/core/discovery.mjs";
import { hashDirectory } from "../src/core/io.mjs";
import { loadProfile } from "../src/core/profile.mjs";
import { resolvePackages } from "../src/core/resolver.mjs";

async function temporary(context, label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `fgpm-immutable-closure-${label}-`));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function tree(directory, content) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "member.txt"), content, "utf8");
  return `sha256:${await hashDirectory(directory)}`;
}

const windowsCollision = () => Object.assign(new Error("operation not permitted"), {
  code: "EPERM", syscall: "rename",
});

test("Windows EPERM reuses an exact existing immutable closure and removes staging", async (context) => {
  const root = await temporary(context, "exact");
  const staging = path.join(root, "staging");
  const target = path.join(root, "target");
  const expected = await tree(target, "same\n");
  await tree(staging, "same\n");
  const result = await publishImmutableDirectory(staging, target, expected, {
    rename: async () => { throw windowsCollision(); },
  });
  assert.equal(result.status, "reused");
  assert.equal(result.root, expected);
  assert.equal(result.publicationError, "EPERM");
  assert.equal(result.verification.stable, true);
  await assert.rejects(() => readFile(path.join(staging, "member.txt")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(target, "member.txt"), "utf8"), "same\n");
});

test("Windows EPERM without an existing target is an explicit unresolved publication", async (context) => {
  const root = await temporary(context, "missing");
  const staging = path.join(root, "staging");
  await tree(staging, "content\n");
  await assert.rejects(() => publishImmutableDirectory(staging, path.join(root, "missing"),
    `sha256:${"0".repeat(64)}`, { rename: async () => { throw windowsCollision(); } }), (error) => {
    assert.equal(error.code, "FGPM_COMPLETE_BUILD_CLOSURE_PUBLICATION_UNRESOLVED");
    assert.equal(error.details.publicationError, "EPERM");
    assert.equal(error.preserveStaging, true);
    return true;
  });
});

test("Windows EPERM rejects mismatched and unverifiable existing targets", async (context) => {
  const root = await temporary(context, "rejected");
  const staging = path.join(root, "staging");
  const target = path.join(root, "target");
  const expected = await tree(staging, "expected\n");
  await tree(target, "different\n");
  await assert.rejects(() => publishImmutableDirectory(staging, target, expected, {
    rename: async () => { throw windowsCollision(); },
  }), { code: "FGPM_COMPLETE_BUILD_CLOSURE_CONFLICT" });
  await assert.rejects(() => publishImmutableDirectory(staging, target, expected, {
    rename: async () => { throw windowsCollision(); },
    hashDirectory: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
  }), (error) => {
    assert.equal(error.code, "FGPM_COMPLETE_BUILD_CLOSURE_PUBLICATION_UNRESOLVED");
    assert.equal(error.details.publicationError, "EPERM");
    assert.equal(error.details.verificationError, "EACCES");
    return true;
  });
  assert.equal(await readFile(path.join(target, "member.txt"), "utf8"), "different\n");
});

test("new immutable closure publication verifies the durable target twice", async (context) => {
  const root = await temporary(context, "published");
  const staging = path.join(root, "staging");
  const target = path.join(root, "target");
  const expected = await tree(staging, "published\n");
  let observations = 0;
  const result = await publishImmutableDirectory(staging, target, expected, {
    hashDirectory: async (directory, options) => {
      observations += 1;
      return hashDirectory(directory, options);
    },
  });
  assert.equal(result.status, "published");
  assert.equal(observations, 2);
  assert.deepEqual(result.verification.observations, [expected, expected]);
});

test("a complete-profile candidate build is byte-identical when repeated", async (context) => {
  const root = await temporary(context, "repeat-build");
  const managerRoot = path.join(root, "manager");
  const manager = await new CurationManager(managerRoot).initialize();
  const profilePath = path.resolve("profiles/runtime-task-v2.json");
  const profile = await loadProfile(profilePath);
  const packages = await discoverPackages(profile.resolvedPackageRoots);
  const resolution = resolvePackages(packages, profile);
  const imported = [];
  for (const pkg of resolution.ordered) imported.push((await manager.importPackage(pkg.directory)).package);
  const workspace = await manager.createWorkspace("repeat-complete-build");
  await manager.stageOperations(workspace.reference.name,
    imported.map((entry) => ({ type: "add", packageRoot: entry.root })), {
      expectedHead: workspace.revision.identity,
    });
  const candidate = await manager.planCandidate(workspace.reference.name, { profilePath });
  assert.equal(candidate.status, "ready-to-build", JSON.stringify(candidate.findings));
  const first = await manager.buildCandidate(candidate.identity);
  assert.equal(first.publication.completeBuildClosure.status, "published");
  const before = await hashDirectory(managerRoot);
  const second = await manager.buildCandidate(candidate.identity);
  assert.equal(second.publication.completeBuildClosure.status, "reused");
  assert.equal(second.identity, first.identity);
  assert.equal(second.completeBuild, first.completeBuild);
  assert.equal(await hashDirectory(managerRoot), before);
});
