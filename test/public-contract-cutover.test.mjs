// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverPackages } from "../src/core/discovery.mjs";
import { hashDirectory, parseStrictJson, readJson } from "../src/core/io.mjs";
import { inspectPrePublicMigration, migratePrePublicPackages, migrationOperationPath,
  validatePackageArchiveEntries } from "../src/core/migration.mjs";
import { verifyPackageSidecar } from "../src/core/package-identity.mjs";
import { resolvePackages } from "../src/core/resolver.mjs";
import { validatePackageIsolated } from "../src/core/public-contracts.mjs";

const NAMESPACE = "6d7092e8-6f8a-4e25-bb6e-a0bf6588e5b4";
const OTHER_NAMESPACE = "258690c4-84c4-4eb4-af4f-8584ae81fc2b";

async function temporary(context, prefix = "fgpm-cutover-") {
  const root = await mkdtemp(path.join(process.env.FGPM_TEST_WORK_ROOT ?? os.tmpdir(), prefix));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("strict JSON accepts member reordering and rejects duplicate names", () => {
  assert.deepEqual(parseStrictJson('{"b":2,"a":1}'), { b: 2, a: 1 });
  assert.throws(() => parseStrictJson('{"format":"fgpm.package/1","format":"fgpm.package/2"}'), {
    code: "FGPM_JSON_DUPLICATE_MEMBER",
  });
});

test("JSON files with malformed UTF-8 fail before package interpretation", async (context) => {
  const root = await temporary(context);
  const file = path.join(root, "bad.json");
  await writeFile(file, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]));
  await assert.rejects(readJson(file), (error) => error.code === "FGPM_JSON_MALFORMED"
    && error.details.rule === "utf-8");
});

test("normal discovery rejects pre-public, competing, and case-mangled entrypoints", async (context) => {
  const root = await temporary(context);
  const packageRoot = path.join(root, "package");
  await mkdir(packageRoot);
  await writeFile(path.join(packageRoot, "fpm-package.json"), "{}");
  await assert.rejects(discoverPackages([root]), { code: "FGPM_PRE_PUBLIC_ENTRYPOINT_UNSUPPORTED" });
  await writeFile(path.join(packageRoot, "fgpm-package.json"), "{}");
  await assert.rejects(discoverPackages([root]), { code: "FGPM_PACKAGE_ENTRYPOINT_COMPETING" });
  await rm(path.join(packageRoot, "fpm-package.json"));
  await rm(path.join(packageRoot, "fgpm-package.json"));
  await writeFile(path.join(packageRoot, "FGPM-PACKAGE.JSON"), "{}");
  await assert.rejects(discoverPackages([root]), { code: "FGPM_PACKAGE_ENTRYPOINT_AMBIGUOUS" });
});

test("isolated validation enforces the same package entrypoint boundary", async (context) => {
  const root = await temporary(context);
  const manifest = JSON.stringify({ format: "fgpm.package/1", namespace: NAMESPACE,
    name: "example.entrypoint", version: "1.0.0", license: "MIT" });
  await writeFile(path.join(root, "fgpm-package.json"), manifest);
  await writeFile(path.join(root, "fpm-package.json"), manifest);
  await assert.rejects(validatePackageIsolated(root), { code: "FGPM_PACKAGE_ENTRYPOINT_COMPETING" });
  await assert.rejects(validatePackageIsolated(path.join(root, "fgpm-package.json")), {
    code: "FGPM_PACKAGE_ENTRYPOINT_COMPETING",
  });
});

test("package validation rejects missing, unknown, and duplicate format declarations", async (context) => {
  const root = await temporary(context);
  const manifest = path.join(root, "fgpm-package.json");
  await writeFile(manifest, JSON.stringify({ namespace: NAMESPACE, name: "example.invalid",
    version: "1.0.0", license: "MIT" }));
  await assert.rejects(discoverPackages([root]), { code: "FGPM_MANIFEST_SCHEMA_UNSUPPORTED" });
  await writeFile(manifest, JSON.stringify({ format: "example.unknown/9", namespace: NAMESPACE,
    name: "example.invalid", version: "1.0.0", license: "MIT" }));
  await assert.rejects(discoverPackages([root]), { code: "FGPM_MANIFEST_SCHEMA_UNSUPPORTED" });
  await writeFile(manifest, `{"format":"fgpm.package/1","format":"fgpm.package/2",` +
    `"namespace":"${NAMESPACE}","name":"example.invalid","version":"1.0.0","license":"MIT"}`);
  await assert.rejects(validatePackageIsolated(root), { code: "FGPM_JSON_DUPLICATE_MEMBER" });
});

test("archive inventories reject duplicates, case ambiguity, and entrypoint mangling", () => {
  assert.equal(validatePackageArchiveEntries(["fgpm-package.json", "payload.bin"]).status, "valid");
  assert.throws(() => validatePackageArchiveEntries(["fgpm-package.json", "FGPM-PACKAGE.JSON"]), {
    code: "FGPM_ARCHIVE_ENTRY_DUPLICATE",
  });
  assert.throws(() => validatePackageArchiveEntries(["wrapper/fgpm-package.json"]), {
    code: "FGPM_ARCHIVE_PACKAGE_ROOT_INVALID",
  });
});

test("sidecars are optional and an elected sidecar must match the exact root", () => {
  const root = `sha256:${"a".repeat(64)}`;
  assert.equal(verifyPackageSidecar({ schema: "fgpm.package-sidecar/1", root }, root).status, "match");
  assert.throws(() => verifyPackageSidecar({ schema: "fgpm.package-sidecar/1",
    root: `sha256:${"b".repeat(64)}` }, root), { code: "FGPM_PACKAGE_SIDECAR_MISMATCH" });
});

test("finite migration previews, copy-applies, preserves source, and is idempotent", async (context) => {
  const root = await temporary(context);
  const source = path.join(root, "source");
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  await mkdir(source);
  const legacy = { schema: "fpm.package/1", id: "example.old", version: "1.0.0", license: "MIT",
    dependencies: [], contributions: [] };
  await writeFile(path.join(source, "fpm-package.json"), `${JSON.stringify(legacy, null, 2)}\n`);
  await writeFile(path.join(source, "payload.txt"), "unchanged");
  const sourceHash = await hashDirectory(source);
  const preview = await migratePrePublicPackages(source, { namespace: NAMESPACE });
  assert.equal(preview.status, "preview");
  assert.equal(preview.privateIndexMutation, false);
  const applied = await migratePrePublicPackages(source, { namespace: NAMESPACE, apply: true, output: first });
  assert.equal(applied.status, "applied");
  assert.equal(await hashDirectory(source), sourceHash);
  await assert.rejects(readFile(path.join(first, "fpm-package.json")), { code: "ENOENT" });
  const manifest = await readJson(path.join(first, "fgpm-package.json"));
  assert.deepEqual({ format: manifest.format, namespace: manifest.namespace, name: manifest.name }, {
    format: "fgpm.package/1", namespace: NAMESPACE, name: "example.old",
  });
  const replay = await migratePrePublicPackages(first, { namespace: OTHER_NAMESPACE, apply: true, output: second });
  assert.equal(replay.status, "applied");
  assert.equal(await hashDirectory(second), await hashDirectory(first));
});

async function legacyPackage(root, name = "example.restartable") {
  const source = path.join(root, "source");
  await mkdir(source);
  await writeFile(path.join(source, "fpm-package.json"), `${JSON.stringify({
    schema: "fpm.package/1", id: name, version: "1.0.0", license: "MIT",
    dependencies: [], contributions: [],
  }, null, 2)}\n`);
  await writeFile(path.join(source, "payload.txt"), "retained source\n");
  return source;
}

test("migration repeats after restart and recovers both durable-change and lost-response boundaries", async (context) => {
  const root = await temporary(context, "fgpm-migration-recovery-");
  const source = await legacyPackage(root);
  const sourceRoot = await hashDirectory(source);
  const interruptedOutput = path.join(root, "interrupted-output");
  await assert.rejects(migratePrePublicPackages(source, {
    namespace: NAMESPACE, apply: true, output: interruptedOutput, interruptAfter: "durable-change",
  }), { code: "FGPM_MIGRATION_TEST_INTERRUPTION" });
  const pending = await inspectPrePublicMigration(interruptedOutput);
  assert.equal(pending.status, "ready-to-commit");
  assert.equal(pending.target.status, "verified");
  const recovered = await migratePrePublicPackages(source, {
    namespace: NAMESPACE, apply: true, output: interruptedOutput,
  });
  assert.equal(recovered.status, "applied");
  assert.equal(recovered.recoveredAfterRestart, true);
  assert.equal((await inspectPrePublicMigration(interruptedOutput)).status, "committed");
  const repeated = await migratePrePublicPackages(source, {
    namespace: NAMESPACE, apply: true, output: interruptedOutput,
  });
  assert.equal(repeated.status, "reused");
  assert.equal(repeated.outputHash, recovered.outputHash);

  const lostResponseOutput = path.join(root, "lost-response-output");
  await assert.rejects(migratePrePublicPackages(source, {
    namespace: NAMESPACE, apply: true, output: lostResponseOutput, interruptAfter: "committed",
  }), { code: "FGPM_MIGRATION_TEST_INTERRUPTION" });
  const recoveredResponse = await migratePrePublicPackages(source, {
    namespace: NAMESPACE, apply: true, output: lostResponseOutput,
  });
  assert.equal(recoveredResponse.status, "reused");
  assert.equal(await hashDirectory(source), sourceRoot);
  assert.equal((await readJson(migrationOperationPath(lostResponseOutput))).phase, "committed");
});

test("migration preserves wrong and inaccessible targets and reports restart continuation", async (context) => {
  const root = await temporary(context, "fgpm-migration-conflict-");
  const source = await legacyPackage(root);
  const output = path.join(root, "output");
  await assert.rejects(migratePrePublicPackages(source, {
    namespace: NAMESPACE, apply: true, output, interruptAfter: "ready-to-commit",
  }), { code: "FGPM_MIGRATION_TEST_INTERRUPTION" });
  await mkdir(output);
  await writeFile(path.join(output, "foreign.txt"), "do not replace\n");
  const foreignRoot = await hashDirectory(output);
  await assert.rejects(migratePrePublicPackages(source, {
    namespace: NAMESPACE, apply: true, output,
  }), (error) => error.code === "FGPM_MIGRATION_OUTPUT_CONFLICT"
    && error.details.recoveryAction.includes("Preserve"));
  assert.equal(await hashDirectory(output), foreignRoot);
  const conflict = await inspectPrePublicMigration(output);
  assert.equal(conflict.status, "unresolved");
  assert.equal(conflict.operation.continuation.action, "resolve-target-and-repeat");

  const inaccessibleOutput = path.join(root, "inaccessible-output");
  await assert.rejects(migratePrePublicPackages(source, {
    namespace: NAMESPACE, apply: true, output: inaccessibleOutput, interruptAfter: "durable-change",
  }), { code: "FGPM_MIGRATION_TEST_INTERRUPTION" });
  await assert.rejects(migratePrePublicPackages(source, {
    namespace: NAMESPACE, apply: true, output: inaccessibleOutput,
    hashDirectory: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
  }), { code: "FGPM_MIGRATION_OUTPUT_UNRESOLVED" });
  assert.equal((await inspectPrePublicMigration(inaccessibleOutput)).target.status, "verified");
});

test("migration detects a concurrently changing target and rejects unsupported input", async (context) => {
  const root = await temporary(context, "fgpm-migration-unstable-");
  const source = await legacyPackage(root);
  const output = path.join(root, "output");
  const applied = await migratePrePublicPackages(source, { namespace: NAMESPACE, apply: true, output });
  const actual = applied.outputHash.slice("sha256:".length);
  let calls = 0;
  await assert.rejects(migratePrePublicPackages(source, {
    namespace: NAMESPACE, apply: true, output,
    hashDirectory: async () => (++calls === 1 ? actual : "f".repeat(64)),
  }), { code: "FGPM_MIGRATION_OUTPUT_UNSTABLE" });

  const unsupported = path.join(root, "unsupported");
  await mkdir(unsupported);
  await writeFile(path.join(unsupported, "fpm-package.json"), JSON.stringify({
    schema: "fpm.package/99", id: "example.unsupported", version: "1.0.0",
  }));
  await assert.rejects(migratePrePublicPackages(unsupported, { namespace: NAMESPACE }), {
    code: "FGPM_MIGRATION_FORMAT_UNSUPPORTED",
  });
});

test("namespace/name ambiguity requires an exact coordinate", () => {
  const base = { version: "1.0.0", dependencies: [], provides: [], requires: [] };
  const packages = [
    { ...base, namespace: NAMESPACE, id: "same.name", coordinate: `${NAMESPACE}/same.name` },
    { ...base, namespace: OTHER_NAMESPACE, id: "same.name", coordinate: `${OTHER_NAMESPACE}/same.name` },
  ];
  assert.throws(() => resolvePackages(packages, { roots: ["same.name"], providers: {} }), {
    code: "FGPM_PACKAGE_NAME_AMBIGUOUS",
  });
  const result = resolvePackages(packages, { roots: [`${NAMESPACE}/same.name`], providers: {} });
  assert.equal(result.ordered[0].namespace, NAMESPACE);
});
