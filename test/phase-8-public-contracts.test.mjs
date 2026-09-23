// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  validatePackageIsolated,
  validatePublicPackageDocument,
  validateServiceActivationDocument,
} from "../src/core/public-contracts.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(repository, "fixtures", "public-contracts", "valid-task-package");

async function manifest() {
  return JSON.parse(await readFile(path.join(fixture, "fgpm-package.json"), "utf8"));
}

test("a corrected package validates in isolation without executing native modules", async () => {
  const report = await validatePackageIsolated(fixture);
  assert.deepEqual({ status: report.status, package: report.package, services: report.services, tasks: report.tasks }, {
    status: "valid", package: "fixture.public-task", services: 1, tasks: 1,
  });
});

test("strict package validation identifies an unknown field by exact JSON path and steward", async () => {
  const document = await manifest();
  document.runtimeServices[0].provides[0].metadata.phase = "simulation";
  assert.throws(() => validatePublicPackageDocument(document), (error) => {
    assert.equal(error.code, "FGPM_PUBLIC_FIELD_UNKNOWN");
    assert.equal(error.details.instancePath, "/runtimeServices/0/provides/0/metadata/phase");
    assert.equal(error.details.rule, "additionalProperties:false");
    assert.equal(error.details.steward, "fgpm.runtime-task-vocabulary/2");
    return true;
  });
});

test("participation and failure policy have separate closed vocabularies", async () => {
  const document = await manifest();
  const metadata = document.runtimeServices[0].provides[0].metadata;
  metadata.participation = "abort-tick";
  assert.throws(() => validatePublicPackageDocument(document), (error) => error.code === "FGPM_PUBLIC_VALUE_INVALID"
    && error.details.instancePath.endsWith("/participation") && error.details.rule === "enum");
});

test("a required member independently permits both public failure policies", async () => {
  for (const failurePolicy of ["abort-tick", "drop-task"]) {
    const document = await manifest();
    const metadata = document.runtimeServices[0].provides[0].metadata;
    metadata.participation = "required";
    metadata.failurePolicy = failurePolicy;
    assert.doesNotThrow(() => validatePublicPackageDocument(document));
  }
});

test("the generic task vocabulary is byte-identical to its real steward package copy", async () => {
  const publicVocabulary = await readFile(path.join(repository, "public", "vocabularies",
    "runtime-task-v2.json"), "utf8");
  const packageVocabulary = await readFile(path.join(repository, "packages", "fgpm.runtime-task-contracts",
    "runtime-task-v2.json"), "utf8");
  assert.equal(packageVocabulary, publicVocabulary);
});

test("an activation contract must identify its declaring service", async () => {
  const document = await manifest();
  const service = document.runtimeServices[0];
  const activation = JSON.parse(await readFile(path.join(fixture, "activation.json"), "utf8"));
  activation.capabilities["runtime.task"].provider = "service:somebody.else/1";
  assert.throws(() => validateServiceActivationDocument(activation, service), (error) => {
    assert.equal(error.code, "FGPM_RUNTIME_SERVICE_CONTRACT_INVALID");
    assert.equal(error.details.rule, "task-provider");
    assert.equal(error.details.expectedProvider, service.id);
    return true;
  });
});

test("host-grant requests are checked against the closed public vocabulary", async () => {
  const document = await manifest();
  document.runtimeServices[0].hostGrants = ["fgpm.host.unknown-example/1"];
  assert.throws(() => validatePublicPackageDocument(document), (error) => {
    assert.equal(error.code, "FGPM_HOST_GRANT_UNKNOWN");
    assert.equal(error.details.instancePath, "/runtimeServices/0/hostGrants/0");
    assert.equal(error.details.steward, "fgpm.host-grants-vocabulary/1");
    return true;
  });
});

test("the provisional validator reports Phase 7 duplicated and inert task fields", async () => {
  const report = await validatePackageIsolated(path.join(repository, "packages", "demo.motion"));
  assert.equal(report.status, "provisional-v1");
  assert.deepEqual(report.warnings.map((entry) => entry.field),
    ["exclusive", "phase", "reentrancy", "required", "failure"]);
});
