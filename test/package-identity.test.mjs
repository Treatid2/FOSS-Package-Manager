// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rename, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { hashDirectory } from "../src/core/io.mjs";
import { packageIdentity } from "../src/core/package-identity.mjs";

test("public identity preserves authoritative bytes/order/exclusions and detects byte/path changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fgpm identity spaces "));
  try {
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "nested", "A"), Buffer.from([0, 255, 13, 10]));
    await writeFile(path.join(root, "z"), "unchanged");
    const expected = `sha256:${await hashDirectory(root)}`;
    assert.equal((await packageIdentity(root, expected)).status, "match");
    await mkdir(path.join(root, "build"));
    await writeFile(path.join(root, "build", "excluded"), "ignored");
    assert.equal((await packageIdentity(root, expected)).status, "match");
    await writeFile(path.join(root, "z"), "changed");
    assert.equal((await packageIdentity(root, expected)).status, "mismatch");
    await writeFile(path.join(root, "z"), "unchanged");
    await rename(path.join(root, "z"), path.join(root, "renamed"));
    assert.equal((await packageIdentity(root, expected)).status, "mismatch");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("identity computes the Stage A integration-host successor root without descriptor execution", async () => {
  for (const [name, root] of [
    ["fgpm.grid-dungeon-integration-runtime", "9679949b723e7067ffac0650f237afb6c40c22304e660db8f8b32aca72ba7d0a"],
  ]) {
    const result = await packageIdentity(path.resolve("fixtures/integration/grid-dungeon-v04/packages", name), `sha256:${root}`);
    assert.equal(result.status, "match");
    assert.equal(result.exitCode, 0);
  }
});

test("invalid expected identities, missing input and regular-file roots fail without partial observations", async () => {
  for (const expected of ["SHA256:" + "0".repeat(64), "sha256:" + "A".repeat(64), "sha256:0", ""]) {
    const result = await packageIdentity(path.resolve("packages"), expected);
    assert.equal(result.error.code, "FGPM_IDENTITY_EXPECTED_INVALID");
    assert.equal(result.observed, null); assert.equal(result.exitCode, 2);
  }
  for (const input of [path.resolve("no-such-identity-input"), path.resolve("manager.json")]) {
    const result = await packageIdentity(input);
    assert.equal(result.observed, null); assert.equal(result.exitCode, 2);
  }
});

test("CLI human/JSON decisions agree and do not execute package code or create state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fgpm identity public "));
  try {
    const input = path.join(root, "Input package");
    await mkdir(input);
    await writeFile(path.join(input, "fgpm-package.json"), '{"entry":"hook.mjs"}');
    await writeFile(path.join(input, "hook.mjs"), 'throw new Error("MUST NOT EXECUTE");');
    const expected = `sha256:${await hashDirectory(input)}`;
    const cli = path.resolve("src/cli.mjs");
    for (const [suffix, status, exit] of [
      [[], "computed", 0], [["--expected", expected], "match", 0],
      [["--expected", `sha256:${"0".repeat(64)}`], "mismatch", 1],
      [["--expected", "invalid"], "error", 2],
      [["--expected"], "error", 2], [["--unknown"], "error", 2],
    ]) {
      const args = [cli, "package", "identity", input, ...suffix];
      const human = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
      const machine = spawnSync(process.execPath, [...args, "--json"], { cwd: root, encoding: "utf8" });
      const result = JSON.parse(machine.stdout);
      assert.equal(human.status, exit); assert.equal(machine.status, exit);
      assert.equal(result.status, status); assert.equal(result.exitCode, exit);
      assert.ok(human.stdout.includes(`identity: ${status}`));
      if (result.observed) assert.ok(human.stdout.includes(result.observed));
      if (result.expected) assert.ok(human.stdout.includes(result.expected));
    }
    assert.equal(`sha256:${await hashDirectory(input)}`, expected);
    assert.equal(await readFile(path.join(input, "hook.mjs"), "utf8"), 'throw new Error("MUST NOT EXECUTE");');
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(root), ["Input package"]);
    assert.equal((await packageIdentity(path.join(root, "missing"))).exitCode, 2);
    assert.equal((await packageIdentity(path.join(input, "hook.mjs"))).exitCode, 2);
    await symlink(input, path.join(root, "link"), "junction");
    assert.equal((await packageIdentity(path.join(root, "link"))).error.code, "FGPM_IDENTITY_INPUT_INVALID");
    await symlink(input, path.join(input, "cycle"), "junction");
    assert.equal((await packageIdentity(input, expected)).error.code, "FGPM_IDENTITY_ENTRY_UNSUPPORTED");
  } finally { await rm(root, { recursive: true, force: true }); }
});
