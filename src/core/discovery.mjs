// SPDX-License-Identifier: MPL-2.0

import { readdir } from "node:fs/promises";
import path from "node:path";
import { invariant, FgpmError } from "./errors.mjs";
import { hashDirectory, readJson, resolveInside } from "./io.mjs";
import {
  PUBLIC_CONTRACT, validatePackageEntrypoints, validatePackageIsolated, validatePublicPackageDocument,
} from "./public-contracts.mjs";
import { parseVersion } from "./semver.mjs";

const PACKAGE_ID = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const NAMESPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PACKAGE_SELECTOR = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;
const PUBLIC_ID = /^pkg:[a-z0-9][a-z0-9.-]*\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/;

async function findManifests(root) {
  const found = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw new FgpmError("FGPM_PACKAGE_ROOT_UNREADABLE", "A package root could not be read.", {
        root,
        cause: error.message,
      });
    }
    validatePackageEntrypoints(entries.filter((entry) => entry.isFile()).map((entry) => entry.name), directory);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || ["build", "node_modules"].includes(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && entry.name === "fgpm-package.json") found.push(absolute);
    }
  }
  await visit(root);
  return found;
}

function array(value, field, packageId) {
  invariant(value === undefined || Array.isArray(value), "FGPM_MANIFEST_INVALID",
    `Package field '${field}' must be an array.`, { package: packageId });
  return value ?? [];
}

function validateManifest(manifest, manifestPath) {
  invariant(["fgpm.package/1", PUBLIC_CONTRACT.packageFormat].includes(manifest?.format),
    "FGPM_MANIFEST_SCHEMA_UNSUPPORTED",
    "Unsupported or missing package format.", { path: manifestPath, format: manifest?.format });
  const corrected = manifest.format === PUBLIC_CONTRACT.packageFormat;
  if (corrected) validatePublicPackageDocument(manifest, manifestPath);
  invariant(NAMESPACE_ID.test(manifest.namespace ?? "") && PACKAGE_ID.test(manifest.name ?? ""),
    "FGPM_PACKAGE_ID_INVALID", "Package namespace or immutable local name is invalid.", {
      path: manifestPath, namespace: manifest.namespace, name: manifest.name,
    });
  const packageId = manifest.name;
  const coordinate = `${manifest.namespace}/${manifest.name}`;
  parseVersion(manifest.version, "package version");
  invariant(typeof manifest.license === "string" && manifest.license.trim().length > 0,
    "FGPM_PACKAGE_LICENSE_MISSING", "A package must declare an SPDX licence identifier or expression.", {
      path: manifestPath,
      package: packageId,
    });

  const dependencies = array(manifest.dependencies, "dependencies", packageId);
  for (const dependency of dependencies) {
    invariant(PACKAGE_SELECTOR.test(dependency?.package ?? "") && typeof dependency.range === "string",
      "FGPM_MANIFEST_INVALID", "A dependency must declare a package and version range.", {
        package: packageId,
        dependency,
      });
  }

  const provides = array(manifest.provides, "provides", packageId);
  for (const provided of provides) {
    invariant(typeof provided?.capability === "string" && typeof provided.version === "string",
      "FGPM_MANIFEST_INVALID", "A provided capability is malformed.", { package: packageId, provided });
    parseVersion(provided.version, "capability version");
  }

  const requires = array(manifest.requires, "requires", packageId);
  for (const requirement of requires) {
    invariant(typeof requirement?.capability === "string" && typeof requirement.range === "string",
      "FGPM_MANIFEST_INVALID", "A capability requirement is malformed.", { package: packageId, requirement });
  }

  const semanticRelations = array(manifest.semanticRelations, "semanticRelations", packageId);
  for (const relation of semanticRelations) {
    invariant(typeof relation?.id === "string" && relation.id.startsWith("relation:")
      && typeof relation.version === "string" && typeof relation.source === "string"
      && typeof relation.target === "string" && Array.isArray(relation.roles), "FGPM_MANIFEST_INVALID",
    "A governed semantic relation declaration is malformed.", { package: packageId, relation });
    parseVersion(relation.version, "semantic relation version");
  }

  const contributions = array(manifest.contributions, "contributions", packageId);
  for (const contribution of contributions) {
    invariant(PUBLIC_ID.test(contribution?.id ?? "") && contribution.id.startsWith(`pkg:${packageId}/`),
      "FGPM_PUBLIC_ID_INVALID", "Contribution identity must be public and owned by its package.", {
        package: packageId,
        contribution: contribution?.id,
      });
    invariant(typeof contribution.manifestType === "string" && typeof contribution.manifest === "string",
      "FGPM_MANIFEST_INVALID", "A contribution declaration is malformed.", {
        package: packageId,
        contribution,
      });
  }

  const handlers = array(manifest.handlers, "handlers", packageId).map((handler) => ({
    ...handler,
    handles: handler?.handles ?? [],
    builds: handler?.builds ?? [],
    adapts: handler?.adapts ?? [],
    validates: handler?.validates ?? [],
    buildEnvironment: handler?.buildEnvironment ?? { schema: "fgpm.build-environment/1", dimensions: [] },
    execution: handler?.execution ?? {
      form: "external-process",
      securityBoundary: "none",
      requestedPowers: ["host-user-authority"],
    },
  }));
  for (const handler of handlers) {
    invariant(typeof handler?.id === "string" && handler.protocol === "fgpm.handler-stdio/1"
      && Array.isArray(handler.handles) && Array.isArray(handler.builds) && Array.isArray(handler.adapts)
      && Array.isArray(handler.validates)
      && Array.isArray(handler.command),
    "FGPM_MANIFEST_INVALID", "A handler declaration is malformed.", { package: packageId, handler });
    invariant(["external-process", "portable-wasm"].includes(handler.execution?.form)
      && ["none", "wasm-capability-imports"].includes(handler.execution.securityBoundary)
      && Array.isArray(handler.execution.requestedPowers)
      && handler.execution.requestedPowers.every((entry) => typeof entry === "string"), "FGPM_MANIFEST_INVALID",
    "A handler execution declaration is malformed.", { package: packageId, handler: handler.id });
    invariant((handler.execution.form === "external-process" && handler.execution.securityBoundary === "none")
      || (handler.execution.form === "portable-wasm"
        && handler.execution.securityBoundary === "wasm-capability-imports"), "FGPM_MANIFEST_INVALID",
    "A handler execution form and security boundary are inconsistent.", { package: packageId, handler: handler.id });
    if (handler.execution.form === "portable-wasm") {
      const limits = handler.execution.limits;
      invariant(limits && Number.isInteger(limits.timeoutMs) && limits.timeoutMs >= 100 && limits.timeoutMs <= 60_000
        && Number.isInteger(limits.maxModuleBytes) && limits.maxModuleBytes >= 64 && limits.maxModuleBytes <= 16 * 1024 * 1024
        && Number.isInteger(limits.maxInputBytes) && limits.maxInputBytes >= 1 && limits.maxInputBytes <= 64 * 1024 * 1024
        && Number.isInteger(limits.maxOutputBytes) && limits.maxOutputBytes >= 1 && limits.maxOutputBytes <= 64 * 1024 * 1024
        && Number.isInteger(limits.maxResponseBytes) && limits.maxResponseBytes >= 1024 && limits.maxResponseBytes <= 16 * 1024 * 1024
        && Number.isInteger(limits.maxProcessMemoryMiB) && limits.maxProcessMemoryMiB >= 16
        && limits.maxProcessMemoryMiB <= 512, "FGPM_MANIFEST_INVALID",
      "A portable WebAssembly handler must declare bounded execution limits.", {
        package: packageId,
        handler: handler.id,
        limits,
      });
    }
    invariant(handler.buildEnvironment?.schema === "fgpm.build-environment/1"
      && Array.isArray(handler.buildEnvironment.dimensions)
      && handler.buildEnvironment.dimensions.every((entry) => typeof entry === "string"), "FGPM_MANIFEST_INVALID",
    "A handler build-environment declaration is malformed.", { package: packageId, handler: handler.id });
    for (const adapter of handler.adapts) {
      invariant(typeof adapter?.id === "string" && typeof adapter.from === "string" && typeof adapter.to === "string"
        && typeof adapter.relation === "string"
        && ["lossless", "lossy", "interpretive"].includes(adapter.conversion), "FGPM_MANIFEST_INVALID",
      "A handler adapter declaration is malformed.", { package: packageId, handler: handler.id, adapter });
    }
    for (const validator of handler.validates) {
      invariant(typeof validator?.id === "string" && ["proposal", "artifact"].includes(validator.phase)
        && Array.isArray(validator.subjects) && Array.isArray(validator.rules), "FGPM_MANIFEST_INVALID",
      "A handler validator declaration is malformed.", { package: packageId, handler: handler.id, validator });
    }
  }

  const runtimeServices = array(manifest.runtimeServices, "runtimeServices", packageId).map((service) => ({
    ...service,
    provides: (service?.provides ?? []).map((provided) => ({
      ...provided,
      cardinality: provided?.cardinality ?? "exclusive",
      memberDependencies: provided?.memberDependencies ?? [],
      metadata: provided?.metadata ?? {},
    })),
    requires: (service?.requires ?? []).map((requirement) => ({
      ...requirement,
      cardinality: requirement?.cardinality ?? "exclusive",
    })),
    artifactAccess: service?.artifactAccess ?? "none",
    artifactStoreAccess: service?.artifactStoreAccess ?? "none",
    hostGrants: service?.hostGrants ?? [],
    activationContract: service?.activationContract ?? null,
    execution: service?.execution ?? {
      form: "native-in-process",
      securityBoundary: "none",
      requestedPowers: ["host-user-authority"],
    },
  }));
  for (const service of runtimeServices) {
    invariant(typeof service?.id === "string" && service.id.startsWith("service:")
      && service.protocol === (corrected ? PUBLIC_CONTRACT.serviceProtocol : "fgpm.runtime-service/1")
      && typeof service.module === "string"
      && ["none", "read"].includes(service.artifactAccess)
      && ["none", "read", "read-write"].includes(service.artifactStoreAccess)
      && Array.isArray(service.hostGrants)
      && Array.isArray(service.provides) && service.provides.length > 0 && Array.isArray(service.requires),
    "FGPM_MANIFEST_INVALID", "A runtime service declaration is malformed.", { package: packageId, service });
    invariant(service.execution?.form === "native-in-process" && service.execution.securityBoundary === "none"
      && Array.isArray(service.execution.requestedPowers), "FGPM_MANIFEST_INVALID",
    "A runtime service execution declaration is malformed.", { package: packageId, service: service.id });
    const collectionCapabilities = new Set();
    for (const provided of service.provides) {
      invariant(typeof provided?.capability === "string" && typeof provided.version === "string"
        && ["exclusive", "collection"].includes(provided.cardinality)
        && (provided.binding === undefined || (typeof provided.binding === "string" && provided.binding.length > 0))
        && (corrected
          ? (provided.cardinality === "exclusive"
            || (provided.cardinality === "collection"
              && typeof provided.member === "string" && provided.member.length > 0
              && typeof provided.binding === "string" && provided.binding.length > 0
              && Array.isArray(provided.memberDependencies)
              && provided.memberDependencies.every((entry) => typeof entry === "string" && entry.length > 0)
              && provided.metadata && typeof provided.metadata === "object" && !Array.isArray(provided.metadata)))
          : ((provided.cardinality === "exclusive" && provided.exclusive === true)
            || (provided.cardinality === "collection" && provided.exclusive === false
            && typeof provided.member === "string" && provided.member.length > 0
            && typeof provided.binding === "string" && provided.binding.length > 0
            && Array.isArray(provided.memberDependencies)
            && provided.memberDependencies.every((entry) => typeof entry === "string" && entry.length > 0)
            && provided.metadata && typeof provided.metadata === "object" && !Array.isArray(provided.metadata)))),
      "FGPM_MANIFEST_INVALID",
      "A runtime service capability declaration is malformed.", { package: packageId, service: service.id, provided });
      parseVersion(provided.version, "runtime service capability version");
      if (provided.cardinality === "collection") {
        invariant(!collectionCapabilities.has(provided.capability), "FGPM_MANIFEST_INVALID",
          "One runtime service cannot publish several values for the same collection capability.", {
            package: packageId, service: service.id, capability: provided.capability,
          });
        collectionCapabilities.add(provided.capability);
      }
    }
    for (const requirement of service.requires) {
      invariant(typeof requirement?.capability === "string" && typeof requirement.range === "string"
        && ["exclusive", "collection"].includes(requirement.cardinality)
        && (requirement.optional === undefined || typeof requirement.optional === "boolean")
        && (requirement.binding === undefined
          || (typeof requirement.binding === "string" && requirement.binding.length > 0))
        && (requirement.cardinality !== "collection"
          || (requirement.optional !== true && requirement.binding === undefined)),
        "FGPM_MANIFEST_INVALID", "A runtime service requirement is malformed.", {
          package: packageId,
          service: service.id,
          requirement,
        });
    }
  }

  const replacements = array(manifest.replacements, "replacements", packageId);
  for (const replacement of replacements) {
    invariant(PUBLIC_ID.test(replacement?.target ?? "") && PUBLIC_ID.test(replacement?.with ?? ""),
      "FGPM_MANIFEST_INVALID", "A replacement declaration is malformed.", {
        package: packageId,
        replacement,
      });
  }

  return { id: packageId, coordinate, dependencies, provides, requires, semanticRelations, contributions, handlers,
    runtimeServices, replacements };
}

export async function discoverPackages(packageRoots) {
  const manifests = [];
  for (const root of [...new Set(packageRoots.map((entry) => path.resolve(entry)))].sort()) {
    manifests.push(...await findManifests(root));
  }

  const packages = [];
  const seen = new Map();
  for (const manifestPath of manifests.sort()) {
    const manifest = await readJson(manifestPath, "FGPM_PACKAGE_MANIFEST_MALFORMED");
    if (manifest.format === PUBLIC_CONTRACT.packageFormat) await validatePackageIsolated(manifestPath);
    const normalized = validateManifest(manifest, manifestPath);
    const key = `${normalized.coordinate}@${manifest.version}`;
    invariant(!seen.has(key), "FGPM_PACKAGE_DUPLICATE", "The same package identity and version was discovered twice.", {
      package: key,
      paths: [seen.get(key), manifestPath],
    });
    seen.set(key, manifestPath);
    const directory = path.dirname(manifestPath);
    for (const contribution of normalized.contributions) {
      resolveInside(directory, contribution.manifest, "contribution manifest");
    }
    packages.push({
      ...manifest,
      ...normalized,
      directory,
      manifestPath,
      contentHash: await hashDirectory(directory),
    });
  }
  return packages;
}
