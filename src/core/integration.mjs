// SPDX-License-Identifier: MPL-2.0

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { buildProfile } from "./build.mjs";
import { FgpmError, invariant } from "./errors.mjs";
import { hashDirectory, hashFile, readJson, resolveInside, stableJson, writeJson } from "./io.mjs";
import { startRuntime } from "./runtime.mjs";

const ROLES = ["generator", "runtime", "traversal"];
const HASH = /^sha256:[0-9a-f]{64}$/;

function exactKeys(value, allowed, description) {
  invariant(value && typeof value === "object" && !Array.isArray(value), "FGPM_INTEGRATION_REQUEST_INVALID",
    `${description} must be an object.`, { description });
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
  invariant(unknown.length === 0, "FGPM_INTEGRATION_REQUEST_INVALID",
    `${description} contains unknown fields.`, { description, unknown });
}

async function validatePackageRoot(baseDirectory, declaration) {
  exactKeys(declaration, ["role", "root", "package"], "A package-root declaration");
  invariant(ROLES.includes(declaration.role) && typeof declaration.root === "string",
    "FGPM_INTEGRATION_REQUEST_INVALID", "A package-root declaration has an invalid role or root.", {
      role: declaration.role, root: declaration.root,
    });
  exactKeys(declaration.package, ["namespace", "id", "version", "contentHash"], "An expected package identity");
  invariant(typeof declaration.package.namespace === "string" && typeof declaration.package.id === "string"
    && typeof declaration.package.version === "string"
    && HASH.test(declaration.package.contentHash ?? ""), "FGPM_INTEGRATION_REQUEST_INVALID",
  "An expected package identity must include namespace, id, version, and sha256 contentHash.", {
    role: declaration.role, package: declaration.package,
  });
  const root = path.resolve(baseDirectory, declaration.root);
  let rootStat;
  try {
    rootStat = await stat(root);
  } catch (error) {
    throw new FgpmError("FGPM_INTEGRATION_PACKAGE_ROOT_INVALID", "An immutable package root is unreadable.", {
      role: declaration.role, root, cause: error.message,
    });
  }
  invariant(rootStat.isDirectory(), "FGPM_INTEGRATION_PACKAGE_ROOT_INVALID",
    "An immutable package root is not a directory.", { role: declaration.role, root });
  const manifest = await readJson(path.join(root, "fgpm-package.json"), "FGPM_INTEGRATION_PACKAGE_ROOT_INVALID");
  const actualHash = `sha256:${await hashDirectory(root)}`;
  invariant(manifest.namespace === declaration.package.namespace && manifest.name === declaration.package.id
    && manifest.version === declaration.package.version
    && actualHash === declaration.package.contentHash, "FGPM_INTEGRATION_PACKAGE_IDENTITY_MISMATCH",
  "An immutable package root does not match its declared identity.", {
    role: declaration.role, root, expected: declaration.package,
    actual: { id: manifest.name, namespace: manifest.namespace, version: manifest.version, contentHash: actualHash },
  });
  return { ...declaration, root, actualHash };
}

async function requireEmptyOutput(outputDirectory) {
  try {
    const entries = await readdir(outputDirectory);
    invariant(entries.length === 0, "FGPM_INTEGRATION_OUTPUT_NOT_EMPTY",
      "The integration evidence output directory must be absent or empty.", { outputDirectory, entries });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function serviceResponseEvidence(host) {
  const exclusive = [...host.capabilities.entries()].map(([capability, selected]) => ({
    capability,
    cardinality: "exclusive",
    service: selected.service.id,
    package: selected.service.owner.id,
    published: true,
    valueType: typeof selected.value,
  }));
  const collections = [...host.collectionValues.entries()].flatMap(([capability, values]) =>
    [...values.entries()].map(([member, value]) => {
      const selected = host.plan.selectedCollections.get(capability)?.members
        .find((entry) => entry.provided.member === member);
      return {
        capability,
        cardinality: "collection",
        member,
        service: selected?.service.id ?? null,
        package: selected?.service.owner.id ?? null,
        published: true,
        valueType: typeof value,
      };
    }));
  const publications = [...exclusive, ...collections].sort((left, right) => left.capability.localeCompare(right.capability)
    || (left.member ?? "").localeCompare(right.member ?? "") || left.service.localeCompare(right.service));
  return {
    services: host.plan.ordered.map((service) => ({
      service: service.id,
      package: service.owner.id,
      serviceProtocol: service.protocol,
      responseProtocol: service.protocol === "fgpm.runtime-service/2"
        ? "fgpm.runtime-service-response/2" : "fgpm.runtime-service-response/1",
      responseAccepted: true,
      publishedCapabilities: publications.filter((entry) => entry.service === service.id)
        .map((entry) => ({ capability: entry.capability, cardinality: entry.cardinality,
          ...(entry.member ? { member: entry.member } : {}) })),
    })),
    publications,
  };
}

function pathContains(parent, candidate) {
  const relation = path.relative(parent, candidate);
  return relation === "" || (!relation.startsWith("..") && !path.isAbsolute(relation));
}

async function retainDomainEvidence(outputDirectory, declarations) {
  const retained = [];
  for (const declaration of declarations) {
    exactKeys(declaration, ["kind", "path"], "A domain-evidence declaration");
    invariant(["domain-output", "domain-trace"].includes(declaration.kind)
      && typeof declaration.path === "string", "FGPM_INTEGRATION_REQUEST_INVALID",
    "A domain-evidence declaration must name a supported kind and relative path.", { declaration });
    const absolute = resolveInside(outputDirectory, declaration.path, "domain evidence path");
    let evidenceStat;
    try {
      evidenceStat = await stat(absolute);
    } catch (error) {
      throw new FgpmError("FGPM_INTEGRATION_EVIDENCE_MISSING", "Declared domain evidence was not produced.", {
        kind: declaration.kind, path: declaration.path, cause: error.message,
      });
    }
    invariant(evidenceStat.isFile(), "FGPM_INTEGRATION_EVIDENCE_MISSING",
      "Declared domain evidence is not a file.", { kind: declaration.kind, path: declaration.path });
    retained.push({
      kind: declaration.kind,
      path: declaration.path.replaceAll("\\", "/"),
      bytes: evidenceStat.size,
      sha256: `sha256:${await hashFile(absolute)}`,
    });
  }
  return retained.sort((left, right) => left.kind.localeCompare(right.kind) || left.path.localeCompare(right.path));
}

async function verifyPackageRoots(packages, phase) {
  for (const declaration of packages) {
    const actual = `sha256:${await hashDirectory(declaration.root)}`;
    invariant(actual === declaration.package.contentHash, "FGPM_INTEGRATION_PACKAGE_IDENTITY_MISMATCH",
      "An immutable package root changed during the manager-hosted integration.", {
        phase, role: declaration.role, root: declaration.root,
        expected: declaration.package.contentHash, actual,
      });
  }
}

function packageByRole(packages, role) {
  return packages.find((entry) => entry.role === role);
}

function validateDungeonDriver(driver) {
  exactKeys(driver, ["capability", "protocol", "provider", "level", "intents", "actorId", "policy"],
    "The dungeon driver");
  invariant(typeof driver.capability === "string" && typeof driver.protocol === "string"
    && typeof driver.provider === "string" && typeof driver.actorId === "string",
  "FGPM_INTEGRATION_REQUEST_INVALID", "The dungeon driver identities are malformed.", { driver });
  exactKeys(driver.level, ["packageRole", "path", "blobRoot", "identity"], "The dungeon level input");
  exactKeys(driver.intents, ["packageRole", "path"], "The dungeon intent input");
  invariant(ROLES.includes(driver.level.packageRole) && typeof driver.level.path === "string"
    && HASH.test(driver.level.blobRoot ?? "") && HASH.test(driver.level.identity ?? "")
    && ROLES.includes(driver.intents.packageRole) && typeof driver.intents.path === "string",
  "FGPM_INTEGRATION_REQUEST_INVALID", "The dungeon driver input declarations are malformed.", {
    level: driver.level, intents: driver.intents,
  });
  exactKeys(driver.policy, ["schema", "radiusMillimetres", "speedMillimetresPerSecond",
    "tickDurationMilliseconds", "collisionResponse"], "The dungeon traversal policy");
  invariant(driver.policy.schema === "fgdungeon.traversal-policy/0"
    && driver.policy.tickDurationMilliseconds === 100,
  "FGPM_INTEGRATION_REQUEST_INVALID", "The dungeon driver must use the fixed 100 ms traversal policy.", {
    policy: driver.policy,
  });
}

async function runDungeonDriver(request, outputDirectory, packages, host) {
  const driver = request.driver;
  validateDungeonDriver(driver);
  const runtimeCapability = host.capability(driver.capability);
  invariant(runtimeCapability?.protocol === driver.protocol && runtimeCapability?.provider === driver.provider
    && typeof runtimeCapability.createSession === "function", "FGPM_INTEGRATION_DOMAIN_CAPABILITY_INVALID",
  "The selected runtime did not publish the exact dungeon capability requested by the driver.", {
    capability: driver.capability,
    expected: { protocol: driver.protocol, provider: driver.provider },
    actual: { protocol: runtimeCapability?.protocol ?? null, provider: runtimeCapability?.provider ?? null },
  });

  const levelPackage = packageByRole(packages, driver.level.packageRole);
  const intentPackage = packageByRole(packages, driver.intents.packageRole);
  const levelPath = resolveInside(levelPackage.root, driver.level.path, "dungeon level input");
  const intentsPath = resolveInside(intentPackage.root, driver.intents.path, "dungeon intent input");
  const [levelBytes, route] = await Promise.all([
    readFile(levelPath),
    readJson(intentsPath, "FGPM_INTEGRATION_DOMAIN_INPUT_INVALID"),
  ]);
  exactKeys(route, ["schema", "initialize", "intents"], "The dungeon intent fixture");
  invariant(route.schema === "fgdungeon.traversal-trace/0" && Array.isArray(route.intents)
    && route.intents.length === request.ticks && route.intents.length === request.proof.demonstrationSteps,
  "FGPM_INTEGRATION_DOMAIN_INPUT_INVALID", "The dungeon intent fixture does not match the bounded run.", {
    schema: route.schema, intents: route.intents?.length ?? null, ticks: request.ticks,
  });
  invariant(`sha256:${await hashFile(levelPath)}` === driver.level.blobRoot
    && route.initialize?.levelBlobRoot === driver.level.blobRoot
    && route.initialize?.levelIdentity === driver.level.identity
    && route.initialize?.actorId === driver.actorId
    && stableJson(route.initialize?.policy) === stableJson(driver.policy),
  "FGPM_INTEGRATION_DOMAIN_INPUT_INVALID", "The dungeon fixtures do not match their declared bindings.", {
    levelPath, intentsPath,
  });

  const providers = Object.fromEntries(ROLES.filter((role) => role !== "runtime").map((role) => {
    const pkg = packageByRole(packages, role);
    const service = request.proof.requiredServices.find((entry) => entry.role === role)?.service;
    return [role, {
      packageId: pkg.package.id,
      packageVersion: pkg.package.version,
      packageRoot: pkg.package.contentHash,
      protocol: `fgdungeon.grid-${role}/0`,
      service,
    }];
  }));
  const session = runtimeCapability.createSession();
  let finalSnapshot;
  let stopResult;
  const steps = [];
  try {
    let snapshot = await session.start(levelBytes, {
      schema: "fgdungeon.reference-runtime-start/0",
      actorId: driver.actorId,
      levelBlobRoot: driver.level.blobRoot,
      levelIdentity: driver.level.identity,
      policy: driver.policy,
      providers,
    });
    const initialSnapshot = snapshot;
    for (let index = 0; index < route.intents.length; index += 1) {
      const input = {
        schema: "fgdungeon.reference-runtime-intent/0",
        requestId: `${request.id}:step-${index + 1}`,
        actorId: snapshot.actorId,
        levelBlobRoot: snapshot.levelBlobRoot,
        tick: snapshot.tick + 1,
        expectedRevision: snapshot.revision,
        previousTraversalStateIdentity: snapshot.traversalStateIdentity,
        intent: route.intents[index],
      };
      const response = await session.applyIntent(input);
      snapshot = response.receipt.snapshot;
      await host.tick();
      steps.push({ sequence: index + 1, input, response });
    }
    finalSnapshot = snapshot;
    const trace = {
      schema: "fgpm.grid-dungeon-integration-trace/1",
      integration: request.id,
      runtime: { capability: driver.capability, protocol: runtimeCapability.protocol,
        provider: runtimeCapability.provider },
      providers,
      tickMilliseconds: driver.policy.tickDurationMilliseconds,
      demonstrationSteps: steps.length,
      initialSnapshot,
      steps,
      finalStateIdentity: finalSnapshot.traversalStateIdentity,
      finalStateBlobRoot: finalSnapshot.traversalStateBlobRoot,
      finalSnapshotIdentity: finalSnapshot.snapshotIdentity,
    };
    await writeJson(path.join(outputDirectory, "domain-trace.json"), trace);
    await writeJson(path.join(outputDirectory, "domain-final-state.json"), finalSnapshot);
  } finally {
    stopResult = session.stop();
  }
  return { finalSnapshot, stopResult, steps: steps.length };
}

function pointerValue(document, pointer, attribution) {
  invariant(typeof pointer === "string" && (pointer === "" || pointer.startsWith("/")),
    "FGPM_INTEGRATION_REQUEST_INVALID", "A proof observation must use a JSON Pointer.", {
      ...attribution, pointer,
    });
  let current = document;
  for (const encoded of pointer === "" ? [] : pointer.slice(1).split("/")) {
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    invariant(current !== null && typeof current === "object" && Object.hasOwn(current, key),
      "FGPM_INTEGRATION_PROOF_FAILED", "A proof observation JSON Pointer does not exist.", {
        ...attribution, pointer, missingSegment: key,
      });
    current = current[key];
  }
  return current;
}

async function verifyDungeonProof(request, outputDirectory, packages, host) {
  const proof = request.proof;
  exactKeys(proof, ["tickMilliseconds", "demonstrationSteps", "requiredServices", "providerBindings",
    "observations", "expectedFinalState"], "The dungeon proof");
  invariant(proof.tickMilliseconds === 100 && proof.demonstrationSteps === 18 && request.ticks === 18
    && Array.isArray(proof.requiredServices) && proof.requiredServices.length === 3
    && Array.isArray(proof.providerBindings) && proof.providerBindings.length > 0,
  "FGPM_INTEGRATION_REQUEST_INVALID",
  "A dungeon-v04 proof requires the fixed 100 ms tick, 18 ticks/steps, three services, and provider bindings.", {
    tickMilliseconds: proof.tickMilliseconds,
    demonstrationSteps: proof.demonstrationSteps,
    ticks: request.ticks,
  });
  const packagesByRole = new Map(packages.map((entry) => [entry.role, entry.package]));
  const expectedServices = new Set();
  for (const declaration of proof.requiredServices) {
    exactKeys(declaration, ["role", "service"], "A required dungeon service");
    invariant(ROLES.includes(declaration.role) && typeof declaration.service === "string"
      && !expectedServices.has(declaration.service), "FGPM_INTEGRATION_REQUEST_INVALID",
    "A required dungeon service must have one role and unique service identity.", { declaration });
    expectedServices.add(declaration.service);
    const selected = host.plan.ordered.find((entry) => entry.id === declaration.service);
    invariant(selected && selected.owner.id === packagesByRole.get(declaration.role)?.id,
      "FGPM_INTEGRATION_PROOF_FAILED", "A required role service is absent from the committed runtime plan.", {
        role: declaration.role,
        service: declaration.service,
        expectedPackage: packagesByRole.get(declaration.role)?.id ?? null,
        selectedPackage: selected?.owner.id ?? null,
      });
  }
  invariant(new Set(proof.requiredServices.map((entry) => entry.role)).size === ROLES.length,
    "FGPM_INTEGRATION_REQUEST_INVALID", "The dungeon proof must bind one required service to each package role.", {});

  for (const binding of proof.providerBindings) {
    exactKeys(binding, ["binding", "provider"], "A required provider binding");
    const selected = host.plan.record.providerBindings.find((entry) => entry.binding === binding.binding);
    invariant(selected?.providerInstance === binding.provider, "FGPM_INTEGRATION_PROOF_FAILED",
      "A required provider binding does not match the committed runtime plan.", {
        binding: binding.binding, expectedProvider: binding.provider,
        selectedProvider: selected?.providerInstance ?? null,
      });
  }

  exactKeys(proof.observations, ["tickMilliseconds", "demonstrationSteps", "traceFinalState",
    "outputFinalState"], "Dungeon proof observations");
  const declaredEvidence = new Set(request.evidence.map((entry) => entry.path.replaceAll("\\", "/")));
  const cache = new Map();
  async function observe(name, declaration) {
    exactKeys(declaration, ["path", "pointer"], `The ${name} proof observation`);
    const relative = declaration.path.replaceAll("\\", "/");
    invariant(declaredEvidence.has(relative), "FGPM_INTEGRATION_REQUEST_INVALID",
      "A proof observation must refer to declared domain evidence.", { name, path: relative });
    if (!cache.has(relative)) {
      cache.set(relative, await readJson(resolveInside(outputDirectory, relative, "dungeon proof evidence"),
        "FGPM_INTEGRATION_PROOF_FAILED"));
    }
    return pointerValue(cache.get(relative), declaration.pointer, { name, path: relative });
  }
  const observedTickMilliseconds = await observe("tickMilliseconds", proof.observations.tickMilliseconds);
  const observedSteps = await observe("demonstrationSteps", proof.observations.demonstrationSteps);
  const traceFinalState = await observe("traceFinalState", proof.observations.traceFinalState);
  const outputFinalState = await observe("outputFinalState", proof.observations.outputFinalState);
  invariant(observedTickMilliseconds === 100 && observedSteps === 18,
    "FGPM_INTEGRATION_PROOF_FAILED", "Domain evidence does not record the fixed dungeon demonstration bounds.", {
      observedTickMilliseconds, observedSteps,
    });
  invariant(traceFinalState !== null && traceFinalState !== undefined
    && stableJson(traceFinalState) === stableJson(outputFinalState), "FGPM_INTEGRATION_PROOF_FAILED",
  "The dungeon trace and final output do not identify the same final state.", {
    traceFinalState, outputFinalState,
  });
  exactKeys(proof.expectedFinalState, ["identity", "blobRoot", "tick", "revision", "positionMillimetres"],
    "The expected dungeon final state");
  exactKeys(proof.expectedFinalState.positionMillimetres, ["x", "y", "z"],
    "The expected dungeon final position");
  const finalOutput = cache.get(proof.observations.outputFinalState.path.replaceAll("\\", "/"));
  invariant(traceFinalState === proof.expectedFinalState.identity
    && finalOutput.traversalStateBlobRoot === proof.expectedFinalState.blobRoot
    && finalOutput.tick === proof.expectedFinalState.tick
    && finalOutput.revision === proof.expectedFinalState.revision
    && stableJson(finalOutput.traversalState?.positionMillimetres)
      === stableJson(proof.expectedFinalState.positionMillimetres),
  "FGPM_INTEGRATION_PROOF_FAILED", "The dungeon run does not match the shipped expected final state.", {
    expected: proof.expectedFinalState,
    actual: {
      identity: traceFinalState,
      blobRoot: finalOutput.traversalStateBlobRoot,
      tick: finalOutput.tick,
      revision: finalOutput.revision,
      positionMillimetres: finalOutput.traversalState?.positionMillimetres ?? null,
    },
  });
  return {
    tickMilliseconds: observedTickMilliseconds,
    demonstrationSteps: observedSteps,
    requiredServices: proof.requiredServices,
    providerBindings: proof.providerBindings,
    traceFinalState,
    outputFinalState,
    traceAndFinalStateMatch: true,
    expectedFinalState: proof.expectedFinalState,
    expectedFinalStateMatch: true,
  };
}

export async function runManagerHostedDungeonIntegration(requestPath, outputDirectory) {
  const absoluteRequest = path.resolve(requestPath);
  const request = await readJson(absoluteRequest, "FGPM_INTEGRATION_REQUEST_INVALID");
  exactKeys(request, ["schema", "id", "mode", "manager", "profile", "packageRoots", "ticks", "runtime",
    "driver", "evidence", "proof"],
    "The integration request");
  invariant(request.schema === "fgpm.manager-hosted-dungeon-integration/1"
    && typeof request.id === "string" && request.id.length > 0
    && ["dungeon-v04", "fixture"].includes(request.mode)
    && typeof request.profile === "string"
    && Number.isInteger(request.ticks) && request.ticks > 0
    && Array.isArray(request.packageRoots) && request.packageRoots.length === ROLES.length
    && Array.isArray(request.evidence) && request.evidence.length > 0,
  "FGPM_INTEGRATION_REQUEST_INVALID", "The manager-hosted integration request is malformed.", {
    schema: request.schema, id: request.id, mode: request.mode,
  });
  exactKeys(request.runtime ?? {}, ["snapshotPath", "workerCount", "timeoutMs"], "Runtime options");
  const roles = request.packageRoots.map((entry) => entry.role).sort();
  invariant(stableJson(roles) === stableJson(ROLES), "FGPM_INTEGRATION_REQUEST_INVALID",
    "The integration request must declare exactly generator, traversal, and runtime package roots.", { roles });
  const kinds = request.evidence.map((entry) => entry.kind).sort();
  invariant(kinds.includes("domain-output") && kinds.includes("domain-trace"),
    "FGPM_INTEGRATION_REQUEST_INVALID", "The integration request must retain domain output and trace evidence.", {
      kinds,
    });
  if (request.mode === "dungeon-v04") {
    exactKeys(request.manager, ["id", "version", "contentHash"], "The expected manager identity");
    invariant(request.manager.id === "org.foss-package-manager.reference"
      && request.manager.version === "0.9.0" && HASH.test(request.manager.contentHash ?? "")
      && request.proof && typeof request.proof === "object", "FGPM_INTEGRATION_REQUEST_INVALID",
    "A dungeon-v04 request must bind the exact reviewed FGPM 0.9.0 manager and proof.", {
      manager: request.manager,
    });
    validateDungeonDriver(request.driver);
    const managerEvidence = new Set([
      "fgpm.lock.json", "provenance.json", "runtime-plan.json", "runtime-lifecycle.json",
      "service-publications.json", "domain-evidence.json", "integration-receipt.json", "evidence-manifest.json",
    ]);
    const substituted = request.evidence.map((entry) => entry.path?.replaceAll("\\", "/"))
      .filter((entry) => managerEvidence.has(entry));
    invariant(substituted.length === 0, "FGPM_INTEGRATION_REQUEST_INVALID",
      "A real dungeon run cannot substitute manager bookkeeping for domain output or trace evidence.", {
        substituted,
      });
  }

  const requestDirectory = path.dirname(absoluteRequest);
  const packages = [];
  for (const declaration of request.packageRoots) {
    packages.push(await validatePackageRoot(requestDirectory, declaration));
  }
  invariant(new Set(packages.map((entry) => entry.root.toLowerCase())).size === packages.length,
    "FGPM_INTEGRATION_REQUEST_INVALID", "Each integration role must use a distinct immutable package root.", {});

  const out = path.resolve(outputDirectory);
  await requireEmptyOutput(out);
  const profilePath = path.resolve(requestDirectory, request.profile);
  const profileDocument = await readJson(profilePath, "FGPM_INTEGRATION_REQUEST_INVALID");
  const profileDirectory = path.dirname(profilePath);
  const authoredPackageRoots = (profileDocument.packageRoots ?? [])
    .map((entry) => path.resolve(profileDirectory, entry));
  const supplementalRoots = packages.map((entry) => entry.root)
    .filter((root) => !authoredPackageRoots.some((authored) => pathContains(authored, root)));
  const built = await buildProfile(profilePath, out, {
    packageRoots: supplementalRoots,
    storeDirectory: path.join(out, ".fgpm-store"),
  });
  if (request.mode === "dungeon-v04") {
    invariant(built.lockfile.manager.id === request.manager.id
      && built.lockfile.manager.version === request.manager.version
      && built.lockfile.manager.contentHash === request.manager.contentHash,
    "FGPM_INTEGRATION_MANAGER_IDENTITY_MISMATCH",
    "The running manager does not match the dungeon integration's reviewed identity.", {
      expected: request.manager, actual: built.lockfile.manager,
    });
  }
  for (const declaration of packages) {
    const selected = built.lockfile.packages.find((entry) => entry.id === declaration.package.id);
    invariant(selected && selected.version === declaration.package.version
      && selected.contentHash === declaration.package.contentHash, "FGPM_INTEGRATION_PACKAGE_NOT_SELECTED",
    "A declared immutable integration package was not selected with its exact identity.", {
      role: declaration.role, expected: declaration.package, selected: selected ?? null,
    });
  }
  await verifyPackageRoots(packages, "before-activation");

  const runtimeOptions = request.runtime ?? {};
  if (runtimeOptions.snapshotPath !== undefined) {
    invariant(typeof runtimeOptions.snapshotPath === "string", "FGPM_INTEGRATION_REQUEST_INVALID",
      "runtime.snapshotPath must be a relative path.", { snapshotPath: runtimeOptions.snapshotPath });
  }
  if (runtimeOptions.workerCount !== undefined) {
    invariant(Number.isInteger(runtimeOptions.workerCount) && runtimeOptions.workerCount > 0,
      "FGPM_INTEGRATION_REQUEST_INVALID", "runtime.workerCount must be a positive integer.", {});
  }
  if (runtimeOptions.timeoutMs !== undefined) {
    invariant(Number.isInteger(runtimeOptions.timeoutMs) && runtimeOptions.timeoutMs > 0,
      "FGPM_INTEGRATION_REQUEST_INVALID", "runtime.timeoutMs must be a positive integer.", {});
  }
  const snapshotPath = runtimeOptions.snapshotPath === undefined ? undefined
    : resolveInside(out, runtimeOptions.snapshotPath, "runtime snapshot path");

  let host;
  let responseEvidence;
  let domainExecution = null;
  try {
    host = await startRuntime(built, {
      interactive: false,
      openBrowser: false,
      snapshotPath,
      schedulerWorkerCount: runtimeOptions.workerCount,
      schedulerTimeoutMs: runtimeOptions.timeoutMs,
    });
    await writeJson(path.join(out, "runtime-plan.json"), host.plan.record);
    responseEvidence = serviceResponseEvidence(host);
    await writeJson(path.join(out, "service-publications.json"), {
      schema: "fgpm.runtime-service-publication-evidence/1",
      activationOrder: host.plan.record.activationOrder,
      services: responseEvidence.services,
      publications: responseEvidence.publications,
    });
    if (request.mode === "dungeon-v04") {
      domainExecution = await runDungeonDriver(request, out, packages, host);
    } else {
      for (let tick = 0; tick < request.ticks; tick += 1) await host.tick();
    }
    await host.shutdown();
  } catch (error) {
    if (host?.lifecycle.state === "active") {
      try { await host.shutdown(); } catch { /* retain the primary failure */ }
    }
    throw error;
  }
  await verifyPackageRoots(packages, "after-shutdown");

  const domainEvidence = await retainDomainEvidence(out, request.evidence);
  const dungeonProof = request.mode === "dungeon-v04"
    ? await verifyDungeonProof(request, out, packages, host) : null;
  await writeJson(path.join(out, "domain-evidence.json"), {
    schema: "fgpm.manager-hosted-domain-evidence/1",
    integration: request.id,
    entries: domainEvidence,
  });
  const receipt = {
    schema: "fgpm.manager-hosted-dungeon-integration-receipt/1",
    id: request.id,
    mode: request.mode,
    status: request.mode === "fixture" ? "fixture-pass" : "pass",
    manager: built.lockfile.manager,
    request: { path: absoluteRequest, sha256: `sha256:${await hashFile(absoluteRequest)}` },
    profile: { path: profilePath, sha256: built.lockfile.profile.hash },
    packages: packages.map((entry) => ({
      role: entry.role,
      root: entry.root,
      ...entry.package,
      selected: true,
    })).sort((left, right) => left.role.localeCompare(right.role)),
    execution: {
      managerHosted: true,
      ticksRequested: request.ticks,
      ticksCompleted: host.lifecycle.ticks,
      activationOrder: host.plan.record.activationOrder,
      shutdownOrder: host.lifecycle.events.filter((entry) => entry.event === "deactivate")
        .map((entry) => entry.service),
      lifecycleState: host.lifecycle.state,
      serviceResponsesAccepted: responseEvidence.services.length,
      servicePublications: responseEvidence.publications.length,
      ...(domainExecution ? {
        domainStepsCompleted: domainExecution.steps,
        domainFinalStateIdentity: domainExecution.finalSnapshot.traversalStateIdentity,
        domainSessionStopStatus: domainExecution.stopResult.status,
      } : {}),
    },
    domainEvidence,
    dungeonProof,
    claims: {
      immutablePackageIdentitiesVerified: true,
      selectedPackageIdentitiesVerified: true,
      activationCommitted: host.lifecycle.committed,
      orderlyShutdown: stableJson(host.lifecycle.events.filter((entry) => entry.event === "deactivate")
        .map((entry) => entry.service)) === stableJson([...host.plan.record.activationOrder].reverse()),
      domainEvidenceRetained: true,
      ...(dungeonProof ? {
        fixedTickAndDemonstrationVerified: true,
        allRoleServicesInCommittedPlan: true,
        providerBindingsVerified: true,
        traceAndFinalStateIdentityMatch: true,
        shippedExpectedFinalStateMatch: true,
      } : {}),
    },
  };
  await writeJson(path.join(out, "integration-receipt.json"), receipt);

  const evidenceFiles = [
    "fgpm.lock.json", "provenance.json", "runtime-plan.json", "runtime-lifecycle.json",
    "service-publications.json", "domain-evidence.json", "integration-receipt.json",
    ...domainEvidence.map((entry) => entry.path),
  ];
  const uniqueFiles = [...new Set(evidenceFiles)].sort();
  const manifest = {
    schema: "fgpm.manager-hosted-integration-evidence-manifest/1",
    integration: request.id,
    files: [],
  };
  for (const relative of uniqueFiles) {
    const absolute = resolveInside(out, relative, "integration evidence manifest entry");
    const fileStat = await stat(absolute);
    manifest.files.push({ path: relative.replaceAll("\\", "/"), bytes: fileStat.size,
      sha256: `sha256:${await hashFile(absolute)}` });
  }
  await writeJson(path.join(out, "evidence-manifest.json"), manifest);
  return { receipt, manifest, outputDirectory: out };
}
