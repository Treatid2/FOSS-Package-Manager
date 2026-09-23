// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { humanReport } from "../tools/public-qualification/public-client.mjs";
import { dungeon, verifyDungeonProviderPins } from "../tools/public-qualification/dungeon.mjs";

const GENERATOR_NAMESPACE = "4c3f55e5-6045-49ae-bce5-714ff77938f4";
const TRAVERSAL_NAMESPACE = "d8514207-1567-4f2f-9f50-34977002edd3";
const OTHER_NAMESPACE = "258690c4-84c4-4eb4-af4f-8584ae81fc2b";
const GENERATOR_ROOT = `sha256:${"a".repeat(64)}`;
const TRAVERSAL_ROOT = `sha256:${"b".repeat(64)}`;

function providerFixture() {
  const providers = {
    generator: { packageId: `${GENERATOR_NAMESPACE}/fgdungeon.grid-generator`, packageVersion: "0.1.0",
      packageRoot: GENERATOR_ROOT, service: "service:fgdungeon.grid-generator/0" },
    traversal: { packageId: `${TRAVERSAL_NAMESPACE}/fgdungeon.grid-traversal`, packageVersion: "0.1.0",
      packageRoot: TRAVERSAL_ROOT, service: "service:fgdungeon.grid-traversal/0" },
  };
  const generation = {
    packages: [
      { id: "fgdungeon.grid-generator", root: GENERATOR_ROOT },
      { id: "fgdungeon.grid-traversal", root: TRAVERSAL_ROOT },
    ],
    runtimePlan: {
      activationOrder: [providers.generator.service, providers.traversal.service],
      services: [
        { id: providers.generator.service, package: "fgdungeon.grid-generator",
          packageVersion: "0.1.0", packageContentHash: GENERATOR_ROOT },
        { id: providers.traversal.service, package: "fgdungeon.grid-traversal",
          packageVersion: "0.1.0", packageContentHash: TRAVERSAL_ROOT },
      ],
    },
  };
  const installed = [
    { namespace: GENERATOR_NAMESPACE, id: "fgdungeon.grid-generator",
      coordinate: providers.generator.packageId, version: "0.1.0", root: GENERATOR_ROOT },
    { namespace: TRAVERSAL_NAMESPACE, id: "fgdungeon.grid-traversal",
      coordinate: providers.traversal.packageId, version: "0.1.0", root: TRAVERSAL_ROOT },
  ];
  return { generation, installed, input: { packageRoots: [GENERATOR_ROOT, TRAVERSAL_ROOT], start: { providers } } };
}

test("public qualification human presentation preserves every structured success and failure fact", () => {
  for (const report of [{ status: "pass", cases: [{ id: "PQ-001", evidence: { exact: "sha256:abc" } }], original137Equivalent: false },
    { status: "fail", error: { code: "EXACT_CODE", message: "Exact failure cause" } }]) {
    assert.equal(humanReport(report), `FGPM public qualification: ${report.status}\n${JSON.stringify(report, null, 2)}\n`);
  }
});
test("dungeon companion rejects wrong manager binding before any activation", async () => {
  const requests = [];
  const client = { async ok(operation) { requests.push(operation); return { identity: "G", manager: "other@1" }; } };
  await assert.rejects(dungeon(client, { generation: "G" }, { manager: { id: "FGPM", version: "rc2" } }));
  assert.deepEqual(requests, ["generation.show"]);
});
test("dungeon companion rejects an incomplete exact closure before any activation", async () => {
  const requests = [];
  const client = { async ok(operation) { requests.push(operation); return { identity: "G", manager: "FGPM@rc2",
    roots: { runtimePlan: "P" }, packages: [{ root: "R" }] }; } };
  await assert.rejects(dungeon(client, { generation: "G", runtimePlanRoot: "P", packageRoots: ["R"] },
    { manager: { id: "FGPM", version: "rc2" } }), /Exact 32-root closure required/u);
  assert.deepEqual(requests, ["generation.show"]);
});

test("dungeon provider verification accepts qualified pins while binding the selected readable identity", () => {
  const fixture = providerFixture();
  assert.doesNotThrow(() => verifyDungeonProviderPins(fixture.generation, fixture.installed, fixture.input));
});

test("dungeon provider verification rejects wrong namespace and registry-coordinate substitutions", () => {
  const wrongPin = providerFixture();
  wrongPin.input.start.providers.generator.packageId = `${OTHER_NAMESPACE}/fgdungeon.grid-generator`;
  assert.throws(() => verifyDungeonProviderPins(wrongPin.generation, wrongPin.installed, wrongPin.input),
    /Registered generator package coordinate\/root\/version mismatch/u);

  const wrongRegistry = providerFixture();
  wrongRegistry.installed[0] = { ...wrongRegistry.installed[0], namespace: OTHER_NAMESPACE,
    coordinate: `${OTHER_NAMESPACE}/fgdungeon.grid-generator` };
  assert.throws(() => verifyDungeonProviderPins(wrongRegistry.generation, wrongRegistry.installed, wrongRegistry.input),
    /Registered generator package coordinate\/root\/version mismatch/u);
});
