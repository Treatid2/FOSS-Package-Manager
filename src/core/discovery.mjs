// SPDX-License-Identifier: MPL-2.0

import { readdir } from "node:fs/promises";
import path from "node:path";
import { invariant, FpmError } from "./errors.mjs";
import { hashDirectory, readJson, resolveInside } from "./io.mjs";
import { parseVersion } from "./semver.mjs";

const PACKAGE_ID = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const PUBLIC_ID = /^pkg:[a-z0-9][a-z0-9.-]*\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/;

async function findManifests(root) {
  const found = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw new FpmError("FPM_PACKAGE_ROOT_UNREADABLE", "A package root could not be read.", {
        root,
        cause: error.message,
      });
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || ["build", "node_modules"].includes(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && entry.name === "fpm-package.json") found.push(absolute);
    }
  }
  await visit(root);
  return found;
}

function array(value, field, packageId) {
  invariant(value === undefined || Array.isArray(value), "FPM_MANIFEST_INVALID",
    `Package field '${field}' must be an array.`, { package: packageId });
  return value ?? [];
}

function validateManifest(manifest, manifestPath) {
  invariant(manifest?.schema === "fpm.package/1", "FPM_MANIFEST_SCHEMA_UNSUPPORTED",
    "Unsupported or missing core package schema.", { path: manifestPath, schema: manifest?.schema });
  invariant(PACKAGE_ID.test(manifest.id ?? ""), "FPM_PACKAGE_ID_INVALID",
    "Package identity is invalid.", { path: manifestPath, package: manifest.id });
  parseVersion(manifest.version, "package version");
  invariant(typeof manifest.license === "string" && manifest.license.trim().length > 0,
    "FPM_PACKAGE_LICENSE_MISSING", "A package must declare an SPDX licence identifier or expression.", {
      path: manifestPath,
      package: manifest.id,
    });

  const dependencies = array(manifest.dependencies, "dependencies", manifest.id);
  for (const dependency of dependencies) {
    invariant(PACKAGE_ID.test(dependency?.package ?? "") && typeof dependency.range === "string",
      "FPM_MANIFEST_INVALID", "A dependency must declare a package and version range.", {
        package: manifest.id,
        dependency,
      });
  }

  const provides = array(manifest.provides, "provides", manifest.id);
  for (const provided of provides) {
    invariant(typeof provided?.capability === "string" && typeof provided.version === "string",
      "FPM_MANIFEST_INVALID", "A provided capability is malformed.", { package: manifest.id, provided });
    parseVersion(provided.version, "capability version");
  }

  const requires = array(manifest.requires, "requires", manifest.id);
  for (const requirement of requires) {
    invariant(typeof requirement?.capability === "string" && typeof requirement.range === "string",
      "FPM_MANIFEST_INVALID", "A capability requirement is malformed.", { package: manifest.id, requirement });
  }

  const semanticRelations = array(manifest.semanticRelations, "semanticRelations", manifest.id);
  for (const relation of semanticRelations) {
    invariant(typeof relation?.id === "string" && relation.id.startsWith("relation:")
      && typeof relation.version === "string" && typeof relation.source === "string"
      && typeof relation.target === "string" && Array.isArray(relation.roles), "FPM_MANIFEST_INVALID",
    "A governed semantic relation declaration is malformed.", { package: manifest.id, relation });
    parseVersion(relation.version, "semantic relation version");
  }

  const contributions = array(manifest.contributions, "contributions", manifest.id);
  for (const contribution of contributions) {
    invariant(PUBLIC_ID.test(contribution?.id ?? "") && contribution.id.startsWith(`pkg:${manifest.id}/`),
      "FPM_PUBLIC_ID_INVALID", "Contribution identity must be public and owned by its package.", {
        package: manifest.id,
        contribution: contribution?.id,
      });
    invariant(typeof contribution.manifestType === "string" && typeof contribution.manifest === "string",
      "FPM_MANIFEST_INVALID", "A contribution declaration is malformed.", {
        package: manifest.id,
        contribution,
      });
  }

  const handlers = array(manifest.handlers, "handlers", manifest.id).map((handler) => ({
    ...handler,
    handles: handler?.handles ?? [],
    builds: handler?.builds ?? [],
    adapts: handler?.adapts ?? [],
    validates: handler?.validates ?? [],
    buildEnvironment: handler?.buildEnvironment ?? { schema: "fpm.build-environment/1", dimensions: [] },
    execution: handler?.execution ?? {
      form: "external-process",
      securityBoundary: "none",
      requestedPowers: ["host-user-authority"],
    },
  }));
  for (const handler of handlers) {
    invariant(typeof handler?.id === "string" && handler.protocol === "fpm.handler-stdio/1"
      && Array.isArray(handler.handles) && Array.isArray(handler.builds) && Array.isArray(handler.adapts)
      && Array.isArray(handler.validates)
      && Array.isArray(handler.command),
    "FPM_MANIFEST_INVALID", "A handler declaration is malformed.", { package: manifest.id, handler });
    invariant(["external-process", "portable-wasm"].includes(handler.execution?.form)
      && ["none", "wasm-capability-imports"].includes(handler.execution.securityBoundary)
      && Array.isArray(handler.execution.requestedPowers)
      && handler.execution.requestedPowers.every((entry) => typeof entry === "string"), "FPM_MANIFEST_INVALID",
    "A handler execution declaration is malformed.", { package: manifest.id, handler: handler.id });
    invariant((handler.execution.form === "external-process" && handler.execution.securityBoundary === "none")
      || (handler.execution.form === "portable-wasm"
        && handler.execution.securityBoundary === "wasm-capability-imports"), "FPM_MANIFEST_INVALID",
    "A handler execution form and security boundary are inconsistent.", { package: manifest.id, handler: handler.id });
    if (handler.execution.form === "portable-wasm") {
      const limits = handler.execution.limits;
      invariant(limits && Number.isInteger(limits.timeoutMs) && limits.timeoutMs >= 100 && limits.timeoutMs <= 60_000
        && Number.isInteger(limits.maxModuleBytes) && limits.maxModuleBytes >= 64 && limits.maxModuleBytes <= 16 * 1024 * 1024
        && Number.isInteger(limits.maxInputBytes) && limits.maxInputBytes >= 1 && limits.maxInputBytes <= 64 * 1024 * 1024
        && Number.isInteger(limits.maxOutputBytes) && limits.maxOutputBytes >= 1 && limits.maxOutputBytes <= 64 * 1024 * 1024
        && Number.isInteger(limits.maxResponseBytes) && limits.maxResponseBytes >= 1024 && limits.maxResponseBytes <= 16 * 1024 * 1024
        && Number.isInteger(limits.maxProcessMemoryMiB) && limits.maxProcessMemoryMiB >= 16
        && limits.maxProcessMemoryMiB <= 512, "FPM_MANIFEST_INVALID",
      "A portable WebAssembly handler must declare bounded execution limits.", {
        package: manifest.id,
        handler: handler.id,
        limits,
      });
    }
    invariant(handler.buildEnvironment?.schema === "fpm.build-environment/1"
      && Array.isArray(handler.buildEnvironment.dimensions)
      && handler.buildEnvironment.dimensions.every((entry) => typeof entry === "string"), "FPM_MANIFEST_INVALID",
    "A handler build-environment declaration is malformed.", { package: manifest.id, handler: handler.id });
    for (const adapter of handler.adapts) {
      invariant(typeof adapter?.id === "string" && typeof adapter.from === "string" && typeof adapter.to === "string"
        && typeof adapter.relation === "string"
        && ["lossless", "lossy", "interpretive"].includes(adapter.conversion), "FPM_MANIFEST_INVALID",
      "A handler adapter declaration is malformed.", { package: manifest.id, handler: handler.id, adapter });
    }
    for (const validator of handler.validates) {
      invariant(typeof validator?.id === "string" && ["proposal", "artifact"].includes(validator.phase)
        && Array.isArray(validator.subjects) && Array.isArray(validator.rules), "FPM_MANIFEST_INVALID",
      "A handler validator declaration is malformed.", { package: manifest.id, handler: handler.id, validator });
    }
  }

  const runtimeServices = array(manifest.runtimeServices, "runtimeServices", manifest.id).map((service) => ({
    ...service,
    provides: service?.provides ?? [],
    requires: service?.requires ?? [],
    artifactAccess: service?.artifactAccess ?? "none",
    artifactStoreAccess: service?.artifactStoreAccess ?? "none",
    execution: service?.execution ?? {
      form: "native-in-process",
      securityBoundary: "none",
      requestedPowers: ["host-user-authority"],
    },
  }));
  for (const service of runtimeServices) {
    invariant(typeof service?.id === "string" && service.id.startsWith("service:")
      && service.protocol === "fpm.runtime-service/1" && typeof service.module === "string"
      && ["none", "read"].includes(service.artifactAccess)
      && ["none", "read", "read-write"].includes(service.artifactStoreAccess)
      && Array.isArray(service.provides) && service.provides.length > 0 && Array.isArray(service.requires),
    "FPM_MANIFEST_INVALID", "A runtime service declaration is malformed.", { package: manifest.id, service });
    invariant(service.execution?.form === "native-in-process" && service.execution.securityBoundary === "none"
      && Array.isArray(service.execution.requestedPowers), "FPM_MANIFEST_INVALID",
    "A runtime service execution declaration is malformed.", { package: manifest.id, service: service.id });
    for (const provided of service.provides) {
      invariant(typeof provided?.capability === "string" && typeof provided.version === "string"
        && provided.exclusive === true && (provided.binding === undefined
          || (typeof provided.binding === "string" && provided.binding.length > 0)), "FPM_MANIFEST_INVALID",
      "A runtime service capability declaration is malformed.", { package: manifest.id, service: service.id, provided });
      parseVersion(provided.version, "runtime service capability version");
    }
    for (const requirement of service.requires) {
      invariant(typeof requirement?.capability === "string" && typeof requirement.range === "string"
        && (requirement.optional === undefined || typeof requirement.optional === "boolean")
        && (requirement.binding === undefined
          || (typeof requirement.binding === "string" && requirement.binding.length > 0)),
        "FPM_MANIFEST_INVALID", "A runtime service requirement is malformed.", {
          package: manifest.id,
          service: service.id,
          requirement,
        });
    }
  }

  const replacements = array(manifest.replacements, "replacements", manifest.id);
  for (const replacement of replacements) {
    invariant(PUBLIC_ID.test(replacement?.target ?? "") && PUBLIC_ID.test(replacement?.with ?? ""),
      "FPM_MANIFEST_INVALID", "A replacement declaration is malformed.", {
        package: manifest.id,
        replacement,
      });
  }

  return { dependencies, provides, requires, semanticRelations, contributions, handlers, runtimeServices, replacements };
}

export async function discoverPackages(packageRoots) {
  const manifests = [];
  for (const root of [...new Set(packageRoots.map((entry) => path.resolve(entry)))].sort()) {
    manifests.push(...await findManifests(root));
  }

  const packages = [];
  const seen = new Map();
  for (const manifestPath of manifests.sort()) {
    const manifest = await readJson(manifestPath, "FPM_PACKAGE_MANIFEST_MALFORMED");
    const normalized = validateManifest(manifest, manifestPath);
    const key = `${manifest.id}@${manifest.version}`;
    invariant(!seen.has(key), "FPM_PACKAGE_DUPLICATE", "The same package identity and version was discovered twice.", {
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
