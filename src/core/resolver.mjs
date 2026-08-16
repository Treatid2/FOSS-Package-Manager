// SPDX-License-Identifier: MPL-2.0

import { FpmError, invariant } from "./errors.mjs";
import { compareVersions, satisfies } from "./semver.mjs";

function packageIndex(packages) {
  const index = new Map();
  for (const pkg of packages) {
    const versions = index.get(pkg.id) ?? [];
    versions.push(pkg);
    index.set(pkg.id, versions);
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
    const existing = selected.get(packageId);
    if (existing) {
      invariant(satisfies(existing.version, range), "FPM_VERSION_CONFLICT",
        "A selected package does not satisfy all requested version ranges.", {
          package: packageId,
          selected: existing.version,
          required: range,
          requestedBy,
        });
      return existing;
    }
    const candidates = (index.get(packageId) ?? []).filter((pkg) => satisfies(pkg.version, range));
    invariant(candidates.length > 0, "FPM_DEPENDENCY_MISSING", "No package satisfies a required dependency.", {
      package: packageId,
      required: range,
      requestedBy,
    });
    const chosen = candidates[0];
    selected.set(packageId, chosen);
    edges.set(packageId, new Set());
    queue.push(chosen);
    return chosen;
  }

  for (const root of [...profile.roots].sort()) {
    invariant(typeof root === "string", "FPM_PROFILE_INVALID", "Root package entries must be package identities.", { root });
    select(root);
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const pkg = queue[cursor];
    const dependencies = edges.get(pkg.id);
    for (const dependency of [...pkg.dependencies].sort((a, b) => a.package.localeCompare(b.package))) {
      const selectedDependency = select(dependency.package, dependency.range, pkg.id);
      dependencies.add(selectedDependency.id);
    }

    for (const requirement of [...pkg.requires].sort((a, b) => a.capability.localeCompare(b.capability))) {
      const explicit = profile.providers[requirement.capability];
      let candidates = providersFor(packages, requirement.capability, requirement.range);
      if (explicit) candidates = candidates.filter((entry) => entry.pkg.id === explicit);

      invariant(candidates.length > 0, "FPM_CAPABILITY_MISSING", "No package provides a required capability.", {
        package: pkg.id,
        capability: requirement.capability,
        required: requirement.range,
        selectedProvider: explicit ?? null,
      });

      const selectedCandidates = candidates.filter((entry) => selected.has(entry.pkg.id));
      let provider;
      if (explicit) {
        provider = candidates[0];
      } else if (selectedCandidates.length === 1) {
        provider = selectedCandidates[0];
      } else {
        const distinctIds = [...new Set(candidates.map((entry) => entry.pkg.id))];
        invariant(distinctIds.length === 1, "FPM_CAPABILITY_AMBIGUOUS",
          "Several packages can provide a required capability; the profile must select one.", {
            package: pkg.id,
            capability: requirement.capability,
            candidates: distinctIds,
          });
        provider = candidates[0];
      }
      const selectedProvider = select(provider.pkg.id, `=${provider.pkg.version}`, `capability:${requirement.capability}`);
      dependencies.add(selectedProvider.id);
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
      throw new FpmError("FPM_DEPENDENCY_CYCLE", "Package dependencies contain a cycle.", { cycle });
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
