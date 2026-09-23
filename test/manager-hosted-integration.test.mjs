// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runManagerHostedDungeonIntegration } from "../src/core/integration.mjs";
import { hashDirectory } from "../src/core/io.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function packageDeclaration(role, directoryName) {
  const root = path.join(repository, "packages", directoryName);
  const manifest = JSON.parse(await readFile(path.join(root, "fgpm-package.json"), "utf8"));
  return {
    role,
    root,
    package: { id: manifest.name, namespace: manifest.namespace, version: manifest.version,
      contentHash: `sha256:${await hashDirectory(root)}` },
  };
}

test("the manager-hosted integration harness retains a manifest-backed fixture receipt", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fgpm-manager-integration-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const requestPath = path.join(root, "request.json");
  const request = {
    schema: "fgpm.manager-hosted-dungeon-integration/1",
    id: "fixture:manager-hosted-integration/1",
    mode: "fixture",
    profile: path.join(repository, "profiles", "runtime-task-v2.json"),
    packageRoots: [
      await packageDeclaration("generator", "demo.worldspace"),
      await packageDeclaration("traversal", "demo.motion-v2"),
      await packageDeclaration("runtime", "demo.runtime-task-v2-distribution"),
    ],
    ticks: 1,
    runtime: { snapshotPath: "domain-output.svg", workerCount: 2, timeoutMs: 2_000 },
    evidence: [
      { kind: "domain-output", path: "domain-output.svg" },
      { kind: "domain-trace", path: "runtime-lifecycle.json" },
    ],
  };
  await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
  const result = await runManagerHostedDungeonIntegration(requestPath, path.join(root, "out"));
  assert.equal(result.receipt.status, "fixture-pass");
  assert.equal(result.receipt.execution.managerHosted, true);
  assert.equal(result.receipt.execution.ticksCompleted, 1);
  assert.equal(result.receipt.claims.orderlyShutdown, true);
  assert.equal(result.receipt.claims.immutablePackageIdentitiesVerified, true);
  assert.deepEqual(result.receipt.domainEvidence.map((entry) => entry.kind),
    ["domain-output", "domain-trace"]);
  assert.ok(result.manifest.files.some((entry) => entry.path === "runtime-plan.json"));
  assert.ok(result.manifest.files.some((entry) => entry.path === "runtime-lifecycle.json"));
  assert.ok(result.manifest.files.some((entry) => entry.path === "service-publications.json"));
  assert.ok(result.manifest.files.every((entry) => /^sha256:[0-9a-f]{64}$/.test(entry.sha256)));
  const publications = JSON.parse(await readFile(path.join(result.outputDirectory, "service-publications.json"), "utf8"));
  assert.ok(publications.services.length > 0);
  assert.ok(publications.services.every((entry) => entry.responseAccepted === true));
  assert.ok(publications.services.some((entry) => entry.responseProtocol === "fgpm.runtime-service-response/2"));

  const mismatched = structuredClone(request);
  mismatched.id = "fixture:manager-hosted-integration/mismatched-root";
  mismatched.packageRoots[0].package.contentHash = `sha256:${"0".repeat(64)}`;
  const mismatchedPath = path.join(root, "mismatched-request.json");
  await writeFile(mismatchedPath, `${JSON.stringify(mismatched, null, 2)}\n`, "utf8");
  await assert.rejects(() => runManagerHostedDungeonIntegration(mismatchedPath, path.join(root, "mismatch-out")),
    (error) => {
      assert.equal(error.code, "FGPM_INTEGRATION_PACKAGE_IDENTITY_MISMATCH");
      assert.equal(error.details.role, "generator");
      return true;
    });
});
