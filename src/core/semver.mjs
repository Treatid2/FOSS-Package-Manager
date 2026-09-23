// SPDX-License-Identifier: MPL-2.0

import { FgpmError } from "./errors.mjs";

export function parseVersion(value, context = "version") {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(value ?? "");
  if (!match) {
    throw new FgpmError("FGPM_VERSION_INVALID", `Invalid semantic ${context}.`, { value });
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
    raw: value,
  };
}

export function compareVersions(left, right) {
  const a = typeof left === "string" ? parseVersion(left) : left;
  const b = typeof right === "string" ? parseVersion(right) : right;
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

function comparatorSatisfied(version, comparator) {
  const match = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(comparator);
  if (!match) {
    throw new FgpmError("FGPM_VERSION_RANGE_INVALID", "Unsupported version range comparator.", { comparator });
  }
  const comparison = compareVersions(version, match[2]);
  switch (match[1] ?? "=") {
    case ">=": return comparison >= 0;
    case "<=": return comparison <= 0;
    case ">": return comparison > 0;
    case "<": return comparison < 0;
    default: return comparison === 0;
  }
}

export function satisfies(versionValue, rangeValue = "*") {
  const version = parseVersion(versionValue);
  const range = rangeValue.trim();
  if (range === "" || range === "*") return true;

  if (range.startsWith("^")) {
    const floor = parseVersion(range.slice(1), "version range");
    const ceiling = floor.major > 0
      ? { ...floor, major: floor.major + 1, minor: 0, patch: 0, prerelease: null }
      : floor.minor > 0
        ? { ...floor, minor: floor.minor + 1, patch: 0, prerelease: null }
        : { ...floor, patch: floor.patch + 1, prerelease: null };
    return compareVersions(version, floor) >= 0 && compareVersions(version, ceiling) < 0;
  }

  if (range.startsWith("~")) {
    const floor = parseVersion(range.slice(1), "version range");
    const ceiling = { ...floor, minor: floor.minor + 1, patch: 0, prerelease: null };
    return compareVersions(version, floor) >= 0 && compareVersions(version, ceiling) < 0;
  }

  return range.split(/\s+/).every((comparator) => comparatorSatisfied(version, comparator));
}
