// SPDX-License-Identifier: MPL-2.0

import { readFile } from "node:fs/promises";
import path from "node:path";
import { JsonSchemaValidationError, validateJsonSchema } from "./schema-validator.mjs";

export class WorkbenchProjectError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "WorkbenchProjectError";
    this.code = code;
    this.details = details;
  }
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkbenchProjectError("FGPM_WORKBENCH_PROJECT_INVALID", `${label} must be an object.`, { label });
  }
  return value;
}

function text(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkbenchProjectError("FGPM_WORKBENCH_PROJECT_INVALID", `${label} must be a non-empty string.`, { label });
  }
  return value;
}

function invalid(path, rule, supplied, message, details = {}) {
  throw new WorkbenchProjectError("FGPM_WORKBENCH_PROJECT_INVALID", message, {
    path, rule, supplied: supplied ?? null, ...details,
  });
}

export function projectPath(projectRoot, relative, label = "project path") {
  if (typeof relative !== "string" || relative.length === 0) {
    invalid(label, "relativePath", relative, `${label} must be a non-empty project-relative path.`);
  }
  if (path.isAbsolute(relative)) {
    throw new WorkbenchProjectError("FGPM_WORKBENCH_PROJECT_PATH_INVALID", `${label} must be relative.`, {
      path: label, rule: "relativePath", supplied: relative,
    });
  }
  const absolute = path.resolve(projectRoot, relative);
  const relation = path.relative(projectRoot, absolute);
  if (!relation || relation.startsWith("..") || path.isAbsolute(relation)) {
    throw new WorkbenchProjectError("FGPM_WORKBENCH_PROJECT_PATH_INVALID", `${label} escapes the project root.`, {
      path: label, rule: "relativePath", supplied: relative,
    });
  }
  return absolute;
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export async function optionalJson(file) {
  try { return { ok: true, value: await readJson(file) }; }
  catch (error) {
    return { ok: false, diagnostic: {
      code: error.code ?? "FGPM_WORKBENCH_FILE_UNAVAILABLE", message: error.message, details: { file },
    } };
  }
}

export async function loadWorkbenchProject(projectRoot) {
  const root = path.resolve(projectRoot);
  const descriptor = await readJson(path.join(root, "project.json"));
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    invalid("$", "type", descriptor, "The project descriptor must be an object.");
  }
  const schemaRelative = descriptor.$schema;
  if (typeof schemaRelative !== "string" || schemaRelative.length === 0) {
    invalid("$.$schema", "required", schemaRelative, "The project descriptor must name its local JSON Schema.");
  }
  const schema = await readJson(projectPath(root, schemaRelative, "$.$schema"));
  if (schema?.$schema !== "https://json-schema.org/draft/2020-12/schema"
    || schema?.type !== "object" || schema?.additionalProperties !== false
    || schema?.properties?.schema?.const !== "fgpm.project/2" || schema?.properties?.version?.const !== 2) {
    invalid("$.$schema", "contract", schemaRelative,
      "The project schema must define the closed fgpm.project/2 contract using JSON Schema 2020-12.", {
        schemaDialect: schema?.$schema ?? null, descriptorSchema: schema?.properties?.schema?.const ?? null,
        descriptorVersion: schema?.properties?.version?.const ?? null,
      });
  }
  try { validateJsonSchema(descriptor, schema); }
  catch (error) {
    if (error instanceof JsonSchemaValidationError) {
      throw new WorkbenchProjectError(error.code, error.message, error.details);
    }
    throw error;
  }
  if (descriptor.current.workspace !== descriptor.workspace.name) {
    invalid("$.current.workspace", "workspace-consistency", descriptor.current.workspace,
      "current.workspace and workspace.name must identify the same workspace.", {
        expected: descriptor.workspace.name,
      });
  }
  for (const [key, relative] of Object.entries(descriptor.paths)) projectPath(root, relative, `$.paths.${key}`);
  for (const [label, relative] of [
    ["$.manager.preferred.bundle", descriptor.manager.preferred.bundle],
    ["$.manager.contracts.directory", descriptor.manager.contracts.directory],
    ["$.portableState.journal", descriptor.portableState.journal],
    ["$.licences.inventory", descriptor.licences.inventory],
    ["$.workbench.fixture", descriptor.workbench.fixture],
    ["$.workbench.launcher", descriptor.workbench.launcher],
  ]) projectPath(root, relative, label);
  const names = new Map();
  const generations = new Map();
  for (const [index, release] of descriptor.releases.entries()) {
    projectPath(root, release.directory, `$.releases[${index}].directory`);
    if (names.has(release.name)) invalid(`$.releases[${index}].name`, "unique", release.name,
      "Release names must be unique.", { firstIndex: names.get(release.name) });
    if (generations.has(release.generation)) invalid(`$.releases[${index}].generation`, "unique", release.generation,
      "Release generation roots must be unique.", { firstIndex: generations.get(release.generation) });
    names.set(release.name, index); generations.set(release.generation, index);
  }
  for (const [index, release] of descriptor.releases.entries()) {
    if (release.parent !== null && (!generations.has(release.parent) || release.parent === release.generation)) {
      invalid(`$.releases[${index}].parent`, "release-parent", release.parent,
        "A release parent must identify a different declared release generation.");
    }
    const seen = new Set([release.generation]);
    let parent = release.parent;
    while (parent !== null) {
      if (seen.has(parent)) invalid(`$.releases[${index}].parent`, "acyclic", release.parent,
        "Release parent relationships must not contain a cycle.");
      seen.add(parent);
      parent = descriptor.releases[generations.get(parent)].parent;
    }
  }
  const currentIndex = names.get(descriptor.current.release);
  if (currentIndex === undefined) invalid("$.current.release", "release-reference", descriptor.current.release,
    "current.release must name a declared release.");
  const currentRelease = descriptor.releases[currentIndex];
  if (descriptor.current.generation !== currentRelease.generation) {
    invalid("$.current.generation", "release-consistency", descriptor.current.generation,
      "current.generation must equal the selected release generation.", { expected: currentRelease.generation });
  }
  if (descriptor.current.distribution !== currentRelease.distribution) {
    invalid("$.current.distribution", "release-consistency", descriptor.current.distribution,
      "current.distribution must equal the selected release distribution.", { expected: currentRelease.distribution });
  }
  if (descriptor.exactBuild) {
    const exactIndex = names.get(descriptor.exactBuild.release);
    if (exactIndex === undefined) invalid("$.exactBuild.release", "release-reference", descriptor.exactBuild.release,
      "exactBuild.release must name a declared release.");
    const exactRelease = descriptor.releases[exactIndex];
    if (descriptor.exactBuild.expected.generation !== exactRelease.generation) {
      invalid("$.exactBuild.expected.generation", "release-consistency",
        descriptor.exactBuild.expected.generation,
        "The exact-build expected generation must equal its declared release generation.", {
          expected: exactRelease.generation,
        });
    }
  }
  const fixture = await readJson(projectPath(root, descriptor.workbench.fixture, "$.workbench.fixture"));
  const journal = await readJson(projectPath(root, descriptor.portableState.journal, "$.portableState.journal"));
  return { root, descriptor, schema, fixture, journal };
}
