// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveRuntimePlan, RuntimeHost } from "../src/core/runtime.mjs";

async function workspace(context, label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `fgpm-service-abi-${label}-`));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function service(owner, id, capability, options = {}) {
  return {
    id,
    protocol: "fgpm.runtime-service/2",
    provides: [{ capability, version: "1.0.0", cardinality: "exclusive",
      memberDependencies: [], metadata: {} }],
    requires: options.requires ?? [],
    artifactAccess: "none",
    artifactStoreAccess: "none",
    hostGrants: [],
    execution: { form: "native-in-process", securityBoundary: "none", requestedPowers: [] },
    module: "service.mjs",
    activationContract: null,
    owner,
  };
}

function owner(id, directory, declarations) {
  return { id, version: "1.0.0", contentHash: id.padEnd(64, "0").slice(0, 64), directory,
    runtimeServices: declarations };
}

function build(packages, providers = {}) {
  return {
    artifact: { type: "fixture.runtime-artifact/1" },
    profile: { schema: "fgpm.profile/3", activation: "runtime:fixture/1", providers, collectionPolicy: {} },
    activations: [{
      id: "runtime:fixture/1",
      package: "fixture.activation",
      accepts: ["fixture.runtime-artifact/1"],
      protocol: "fgpm.runtime-activation/1",
      requires: [{ capability: "fixture.result", range: "^1.0.0", cardinality: "exclusive" }],
      ticks: 1,
    }],
    resolution: { ordered: packages },
    lockfile: {
      manager: { name: "foss-package-manager", version: "test" },
      artifact: { id: "artifact:fixture/1", type: "fixture.runtime-artifact/1",
        hash: `sha256:${"0".repeat(64)}` },
    },
  };
}

function artifact() {
  return {
    schema: "fgpm.typed-artifact-reference/1",
    id: "artifact:fixture/1",
    semanticType: "fixture.runtime-artifact/1",
    root: { kind: "blob", hash: `sha256:${"0".repeat(64)}`, size: 0, totalSize: null },
    entry: null,
    provenance: {},
  };
}

async function writeProvider(directory, eventKey, name) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "service.mjs"), `
export function createService(...factoryArguments) {
  globalThis[${JSON.stringify(eventKey)}].push([${JSON.stringify(name)}, "create", factoryArguments.length]);
  if (factoryArguments.length !== 0) throw new Error("factory arguments are forbidden");
  return {
    async activate(context) {
      globalThis[${JSON.stringify(eventKey)}].push([${JSON.stringify(name)}, "activate", Object.isFrozen(context)]);
      return { protocol: "fgpm.runtime-service-response/2",
        capabilities: { "fixture.provider": Object.freeze({ name: ${JSON.stringify(name)} }) } };
    },
    async deactivate(context) {
      globalThis[${JSON.stringify(eventKey)}].push([${JSON.stringify(name)}, "deactivate", Object.isFrozen(context)]);
    },
  };
}
`, "utf8");
}

async function writeConsumer(directory, eventKey, options = {}) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "service.mjs"), `
export function createService(...factoryArguments) {
  globalThis[${JSON.stringify(eventKey)}].push(["consumer", "create", factoryArguments.length]);
  if (factoryArguments.length !== 0) throw new Error("factory arguments are forbidden");
  return {
    async activate(context) {
      const provider = context.require("fixture.provider");
      let denied;
      try { context.require("fixture.undeclared"); } catch (error) { denied = error.code; }
      globalThis[${JSON.stringify(eventKey)}].push(["consumer", "activate", provider.name, denied,
        Object.isFrozen(context)]);
      return { protocol: "fgpm.runtime-service-response/2", capabilities: {
        ${options.omitPublication ? "" : `"fixture.result": Object.freeze({ provider: provider.name })`}
      } };
    },
    async deactivate(context) {
      globalThis[${JSON.stringify(eventKey)}].push(["consumer", "deactivate", Object.isFrozen(context)]);
    },
  };
}
`, "utf8");
}

async function fixturePackages(context, label, options = {}) {
  const root = await workspace(context, label);
  const eventKey = `__fgpm_runtime_service_abi_${label}_${Date.now()}_${Math.random()}`;
  globalThis[eventKey] = [];
  context.after(() => { delete globalThis[eventKey]; });
  const providerADirectory = path.join(root, "provider-a");
  const providerBDirectory = path.join(root, "provider-b");
  const consumerDirectory = path.join(root, "consumer");
  await writeProvider(providerADirectory, eventKey, "provider-a");
  await writeProvider(providerBDirectory, eventKey, "provider-b");
  await writeConsumer(consumerDirectory, eventKey, options);
  const providerA = owner("fixture.provider-a", providerADirectory, []);
  providerA.runtimeServices = [service(providerA, "service:fixture.provider-a/1", "fixture.provider")];
  const providerB = owner("fixture.provider-b", providerBDirectory, []);
  providerB.runtimeServices = [service(providerB, "service:fixture.provider-b/1", "fixture.provider")];
  const consumer = owner("fixture.consumer", consumerDirectory, []);
  consumer.runtimeServices = [service(consumer, "service:fixture.consumer/1", "fixture.result", {
    requires: [{ capability: "fixture.provider", range: "^1.0.0", cardinality: "exclusive" }],
  })];
  return { eventKey, providerA, providerB, consumer };
}

test("runtime-service v2 uses the zero-argument factory and declared activate(context) dependency ABI", async (context) => {
  const fixture = await fixturePackages(context, "success");
  const plan = resolveRuntimePlan(build([fixture.providerB, fixture.consumer, fixture.providerA], {
    "fixture.provider": "fixture.provider-a",
  }));
  assert.deepEqual(plan.record.activationOrder,
    ["service:fixture.provider-a/1", "service:fixture.consumer/1"]);
  assert.equal(plan.record.selections.find((entry) => entry.capability === "fixture.provider").provider,
    "service:fixture.provider-a/1");
  const host = new RuntimeHost(plan, artifact(), { hostGrantValues: {} });
  await host.activate();
  assert.deepEqual(host.capability("fixture.result"), { provider: "provider-a" });
  assert.deepEqual(globalThis[fixture.eventKey].slice(0, 4), [
    ["provider-a", "create", 0],
    ["provider-a", "activate", true],
    ["consumer", "create", 0],
    ["consumer", "activate", "provider-a", "FGPM_RUNTIME_AUTHORITY_DENIED", true],
  ]);
  const lifecycle = await host.shutdown();
  assert.deepEqual(lifecycle.events.filter((entry) => entry.event === "deactivate")
    .map((entry) => entry.service), ["service:fixture.consumer/1", "service:fixture.provider-a/1"]);
  assert.deepEqual(globalThis[fixture.eventKey].slice(-2), [
    ["consumer", "deactivate", true],
    ["provider-a", "deactivate", true],
  ]);
});

test("runtime-service provider resolution rejects missing and ambiguous declared dependencies", async (context) => {
  const fixture = await fixturePackages(context, "resolution");
  assert.throws(() => resolveRuntimePlan(build([fixture.consumer])), (error) => {
    assert.equal(error.code, "FGPM_RUNTIME_CAPABILITY_MISSING");
    assert.equal(error.details.capability, "fixture.provider");
    assert.equal(error.details.requestedBy, "service:fixture.consumer/1");
    return true;
  });
  assert.throws(() => resolveRuntimePlan(build([fixture.providerA, fixture.providerB, fixture.consumer])), (error) => {
    assert.equal(error.code, "FGPM_RUNTIME_PROVIDER_AMBIGUOUS");
    assert.equal(error.details.capability, "fixture.provider");
    assert.deepEqual(error.details.candidates.map((entry) => entry.service),
      ["service:fixture.provider-a/1", "service:fixture.provider-b/1"]);
    return true;
  });
});

test("runtime-service activation rejects missing declared response capabilities and rolls back dependencies", async (context) => {
  const fixture = await fixturePackages(context, "publication", { omitPublication: true });
  const plan = resolveRuntimePlan(build([fixture.providerA, fixture.consumer]));
  const host = new RuntimeHost(plan, artifact(), { hostGrantValues: {} });
  await assert.rejects(() => host.activate(), (error) => {
    assert.equal(error.code, "FGPM_RUNTIME_SERVICE_INVALID");
    assert.equal(error.details.capability, "fixture.result");
    assert.deepEqual(error.details.lifecycle.activated, ["service:fixture.provider-a/1"]);
    assert.deepEqual(error.details.lifecycle.rolledBack, ["service:fixture.provider-a/1"]);
    return true;
  });
  assert.deepEqual(globalThis[fixture.eventKey].slice(-1), [["provider-a", "deactivate", true]]);
  assert.equal(host.capabilities.size, 0);
});
