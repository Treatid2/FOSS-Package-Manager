// SPDX-License-Identifier: MPL-2.0

import { FgpmError, invariant } from "./errors.mjs";
import { compareVersions, satisfies } from "./semver.mjs";

function packageIndex(packages) {
  const index = new Map();
  for (const pkg of packages) {
    for (const selector of [pkg.id, pkg.coordinate]) {
      const versions = index.get(selector) ?? [];
      versions.push(pkg);
      index.set(selector, versions);
    }
  }
  for (const versions of index.values()) {
    versions.sort((a, b) => compareVersions(b.version, a.version));
  }
  return index;
}

function providersFor(packages, capability, range) {
  return packages
    .flatMap((pkg) => pkg.provides
      .filter((entry) => entry.capability === capability && satisfies(entry.version, range))
      .map((entry) => ({ pkg, providedVersion: entry.version })))
    .sort((a, b) => a.pkg.id.localeCompare(b.pkg.id) || compareVersions(b.pkg.version, a.pkg.version));
}

export function resolvePackages(packages, profile) {
  const index = packageIndex(packages);
  const selected = new Map();
  const edges = new Map();
  const queue = [];

  function select(packageId, range = "*", requestedBy = "profile") {
    const eligible = (index.get(packageId) ?? []).filter((pkg) => satisfies(pkg.version, range));
    const namespaces = [...new Set(eligible.map((pkg) => pkg.namespace))];
    invariant(packageId.includes("/") || namespaces.length <= 1, "FGPM_PACKAGE_NAME_AMBIGUOUS",
      "A local package name resolves to several publisher namespaces; use the exact namespace/name coordinate.", {
        package: packageId, required: range, requestedBy,
        candidates: eligible.map((pkg) => pkg.coordinate).sort(),
      });
    const existing = [...selected.values()].find((pkg) => pkg.coordinate === packageId || pkg.id === packageId);
    if (existing) {
      invariant(satisfies(existing.version, range), "FGPM_VERSION_CONFLICT",
        "A selected package does not satisfy all requested version ranges.", {
          package: packageId,
          selected: existing.version,
          required: range,
          requestedBy,
        });
      return existing;
    }
    const candidates = eligible;
    invariant(candidates.length > 0, "FGPM_DEPENDENCY_MISSING", "No package satisfies a required dependency.", {
      package: packageId,
      required: range,
      requestedBy,
    });
    const chosen = candidates[0];
    selected.set(chosen.coordinate, chosen);
    edges.set(chosen.coordinate, new Set());
    queue.push(chosen);
    return chosen;
  }

  for (const root of [...profile.roots].sort()) {
    invariant(typeof root === "string", "FGPM_PROFILE_INVALID", "Root package entries must be package identities.", { root });
    select(root);
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const pkg = queue[cursor];
    const dependencies = edges.get(pkg.coordinate);
    for (const dependency of [...pkg.dependencies].sort((a, b) => a.package.localeCompare(b.package))) {
      const selectedDependency = select(dependency.package, dependency.range, pkg.id);
      dependencies.add(selectedDependency.coordinate);
    }

    for (const requirement of [...pkg.requires].sort((a, b) => a.capability.localeCompare(b.capability))) {
      const explicit = profile.providers[requirement.capability];
      let candidates = providersFor(packages, requirement.capability, requirement.range);
      if (explicit) candidates = candidates.filter((entry) => entry.pkg.id === explicit || entry.pkg.coordinate === explicit);

      invariant(candidates.length > 0, "FGPM_CAPABILITY_MISSING", "No package provides a required capability.", {
        package: pkg.id,
        capability: requirement.capability,
        required: requirement.range,
        selectedProvider: explicit ?? null,
      });

      const selectedCandidates = candidates.filter((entry) => selected.has(entry.pkg.coordinate));
      let provider;
      if (explicit) {
        provider = candidates[0];
      } else if (selectedCandidates.length === 1) {
        provider = selectedCandidates[0];
      } else {
        const distinctIds = [...new Set(candidates.map((entry) => entry.pkg.id))];
        invariant(distinctIds.length === 1, "FGPM_CAPABILITY_AMBIGUOUS",
          "Several packages can provide a required capability; the profile must select one.", {
            package: pkg.id,
            capability: requirement.capability,
            candidates: distinctIds,
          });
        provider = candidates[0];
      }
      const selectedProvider = select(provider.pkg.coordinate, `=${provider.pkg.version}`, `capability:${requirement.capability}`);
      dependencies.add(selectedProvider.coordinate);
    }
  }

  const state = new Map();
  const ordered = [];
  const stack = [];
  function visit(packageId) {
    const current = state.get(packageId);
    if (current === "done") return;
    if (current === "visiting") {
      const start = stack.indexOf(packageId);
      const cycle = [...stack.slice(start), packageId];
      throw new FgpmError("FGPM_DEPENDENCY_CYCLE", "Package dependencies contain a cycle.", { cycle });
    }
    state.set(packageId, "visiting");
    stack.push(packageId);
    for (const dependency of [...(edges.get(packageId) ?? [])].sort()) visit(dependency);
    stack.pop();
    state.set(packageId, "done");
    ordered.push(selected.get(packageId));
  }
  for (const packageId of [...selected.keys()].sort()) visit(packageId);

  return { selected, edges, ordered };
}
