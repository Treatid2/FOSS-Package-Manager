// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { json, sha256, requireFact } from "./public-client.mjs";

const NAMESPACE = /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PACKAGE_ID = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;

function qualifiedPackageId(value) {
  const parts = typeof value === "string" ? value.split("/") : [];
  requireFact(parts.length === 2 && NAMESPACE.test(parts[0]) && PACKAGE_ID.test(parts[1]),
    `Provider packageId must be an exact namespace/name coordinate: ${value}`);
  return { namespace: parts[0], id: parts[1] };
}

export function verifyDungeonProviderPins(generation, installedPackages, input) {
  const activation = generation.runtimePlan.activationOrder;
  for (const role of ["generator", "traversal"]) {
    const pin = input.start.providers[role];
    const coordinate = qualifiedPackageId(pin.packageId);
    requireFact(input.packageRoots.includes(pin.packageRoot), `Missing ${role} root`);
    requireFact(activation.includes(pin.service), `Missing ${role} service`);
    const selected = generation.packages.filter((entry) => entry.id === coordinate.id && entry.root === pin.packageRoot);
    requireFact(selected.length === 1, `Selected ${role} package identity/root mismatch`);
    const service = generation.runtimePlan.services.find((entry) => entry.id === pin.service);
    requireFact(service, `Missing ${role} service record`);
    assert.equal(service.package, coordinate.id);
    assert.equal(service.packageVersion, pin.packageVersion);
    assert.equal(service.packageContentHash, pin.packageRoot);
    const registered = installedPackages.filter((entry) => entry.coordinate === pin.packageId
      && entry.namespace === coordinate.namespace && entry.id === coordinate.id
      && entry.version === pin.packageVersion && entry.root === pin.packageRoot);
    requireFact(registered.length === 1, `Registered ${role} package coordinate/root/version mismatch`);
  }
}

// This consumes an existing, curator-supplied generation. It never creates a baseline.
export async function dungeon(client, input, identity) {
  const generation = await client.ok("generation.show", { root: input.generation });
  assert.equal(generation.identity, input.generation);
  assert.equal(generation.manager, `${identity.manager.id}@${identity.manager.version}`);
  assert.equal(generation.roots.runtimePlan, input.runtimePlanRoot);
  assert.deepEqual(generation.packages.map((entry) => entry.root).sort(), [...input.packageRoots].sort());
  requireFact(input.packageRoots.length === 32 && new Set(input.packageRoots).size === 32, "Exact 32-root closure required");
  const activation = generation.runtimePlan.activationOrder;
  requireFact(activation.length === 15, "Dungeon scenario requires 15 selected services");
  const installed = await client.ok("package.list");
  requireFact(installed.schema === "fgpm.package-list/1" && Array.isArray(installed.packages),
    "Public package registry response is malformed");
  verifyDungeonProviderPins(generation, installed.packages, input);
  const level = await readFile(input.levelPath);
  assert.equal(`sha256:${sha256(level)}`, input.start.levelBlobRoot);
  const intentBytes = await readFile(input.intentsPath);
  assert.equal(`sha256:${sha256(intentBytes)}`, input.intentsSha256);
  const route = await json(input.intentsPath);
  assert.equal(route.schema, "fgdungeon.traversal-trace/0");
  assert.equal(route.intents.length, 18);
  assert.equal(input.start.policy.tickDurationMilliseconds, 100);
  for (const key of ["actorId", "levelBlobRoot", "levelIdentity", "policy"]) assert.deepEqual(route.initialize[key], input.start[key]);
  const transition = await client.ok("generation.activate", { root: input.generation });
  const before = await client.ok("runtime.inspect");
  assert.equal(before.session, transition.session);
  assert.deepEqual(before.lifecycle.events.filter((entry) => entry.event === "activate").map((entry) => entry.service), activation);
  const opened = await client.ok("runtime.session.open", { generation: input.generation, ...input.capability,
    methods: ["start", "inspect", "applyIntent", "stop"] });
  assert.equal(opened.runtimeSession, transition.session);
  const call = async (method, args) => {
    const result = await client.ok("runtime.session.call", { generation: input.generation, handle: opened.handle, method, arguments: args });
    for (const key of ["generation", "runtimeSession", "capability", "protocol", "provider"]) assert.equal(result[key], opened[key]);
    return result.value;
  };
  let snapshot = await call("start", [{ $bytes: level.toString("base64") }, input.start]);
  assert.equal(snapshot.tick, 0); assert.equal(snapshot.revision, 0);
  assert.equal(snapshot.actorId, input.start.actorId); assert.equal(snapshot.levelBlobRoot, input.start.levelBlobRoot);
  assert.deepEqual(snapshot.providers, input.start.providers);
  const initialSnapshot = snapshot, steps = [];
  for (let index = 0; index < 18; index++) {
    const intent = { schema: "fgdungeon.reference-runtime-intent/0", requestId: `${input.id}:step-${index + 1}`,
      actorId: snapshot.actorId, levelBlobRoot: snapshot.levelBlobRoot, tick: snapshot.tick + 1,
      expectedRevision: snapshot.revision, previousTraversalStateIdentity: snapshot.traversalStateIdentity, intent: route.intents[index] };
    const response = await call("applyIntent", [intent]);
    requireFact(response.receipt?.snapshot, "Domain receipt must retain its snapshot");
    assert.equal(response.disposition, "committed");
    snapshot = response.receipt.snapshot;
    assert.equal(snapshot.tick, index + 1); assert.equal(snapshot.revision, index + 1);
    steps.push({ sequence: index + 1, input: intent, response });
    await client.ok("runtime.tick", { count: 1 });
  }
  const inspected = await call("inspect", []);
  assert.deepEqual(inspected, snapshot);
  assert.equal(snapshot.tick, 18); assert.equal(snapshot.revision, 18);
  assert.deepEqual(snapshot.traversalState.positionMillimetres, { x: 19500, y: 2200, z: 0 });
  assert.equal(snapshot.traversalStateIdentity, "sha256:e02fd3719802422c036818b8621239fb9fbd3c93807cbf9dd70a0af5158fe915");
  assert.equal(snapshot.traversalStateBlobRoot, "sha256:5e6bed6be264dcc60148f55f6f1c33c35d34e91dc9af19a431894c97d7de70ad");
  const closed = await client.ok("runtime.session.close", { generation: input.generation, handle: opened.handle });
  const shutdown = await client.ok("runtime.shutdown");
  const reverse = shutdown.lifecycle.events.filter((entry) => entry.event === "deactivate").map((entry) => entry.service);
  assert.deepEqual(reverse, [...activation].reverse());
  assert.equal(shutdown.active.status, "stopped");
  assert.equal(`sha256:${sha256(await readFile(input.levelPath))}`, input.start.levelBlobRoot);
  assert.equal(`sha256:${sha256(await readFile(input.intentsPath))}`, input.intentsSha256);
  return { schema: "fgpm.public-dungeon-qualification/1", status: "pass", identity, generation,
    transition, opened, initialSnapshot, steps, finalSnapshot: snapshot, inspected, closed, shutdown,
    fixedTickMilliseconds: 100, simulatedTimeOnly: true, demonstrationSteps: 18,
    serviceCount: activation.length, reverseShutdownVerified: true, inputBytesPreserved: true,
    inputs: { levelPath: input.levelPath, levelSha256: input.start.levelBlobRoot,
      intentsPath: input.intentsPath, intentsSha256: input.intentsSha256 }, historicalProofUnchanged: true };
}
