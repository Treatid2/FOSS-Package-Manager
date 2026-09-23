// SPDX-License-Identifier: MPL-2.0
import { invariant } from "./errors.mjs";
import { sha256, stableJson } from "./io.mjs";

export const registryRoot = (value) => `sha256:${sha256(stableJson(value))}`;
const ROOT = /^sha256:[a-f0-9]{64}$/u;

export function validateRegistry(index) {
  invariant(Array.isArray(index.packages), "FGPM_INSTALLED_INDEX_INVALID", "Registry packages must be an array.");
  const roots = new Set();
  for (const entry of index.packages) {
    invariant(typeof entry.id === "string" && typeof entry.version === "string" && ROOT.test(entry.root)
      && (entry.coordinate === undefined || (typeof entry.namespace === "string"
        && entry.coordinate === `${entry.namespace}/${entry.id}`))
      && !roots.has(entry.root), "FGPM_INSTALLED_INDEX_INVALID", "Registry entries require unique exact roots.");
    roots.add(entry.root);
  }
  if (index.schema === "fgpm.installed-index/1") return index;
  invariant(index.schema === "fgpm.installed-index/2" && Array.isArray(index.audit),
    "FGPM_INSTALLED_INDEX_INVALID", "Unsupported package registry.");
  let previous = null;
  for (const [ordinal, event] of index.audit.entries()) {
    const { identity, ...body } = event;
    invariant(body.sequence === ordinal + 1 && body.previous === previous && registryRoot(body) === identity,
      "FGPM_REGISTRY_AUDIT_INVALID", "Registry audit chain failed verification.", { ordinal });
    previous = identity;
  }
  invariant(index.audit.length > 0 && index.audit.at(-1).packagesRoot === registryRoot(index.packages),
    "FGPM_REGISTRY_AUDIT_INVALID", "Registry packages disagree with the committed audit head.");
  return index;
}

export function appendRegistryEvent(index, operation, details, clock) {
  const audit = [...(index.audit ?? [])];
  const body = { sequence: audit.length + 1, previous: audit.at(-1)?.identity ?? null,
    recordedAt: clock(), operation, ...details, packagesRoot: registryRoot(index.packages) };
  audit.push({ ...body, identity: registryRoot(body) });
  return { schema: "fgpm.installed-index/2", version: 1, packages: index.packages, audit };
}
