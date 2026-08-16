// SPDX-License-Identifier: MPL-2.0

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { FpmError, invariant } from "./errors.mjs";

export async function readJson(filePath, code = "FPM_JSON_MALFORMED") {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    throw new FpmError("FPM_FILE_UNREADABLE", "Could not read a required file.", {
      path: filePath,
      cause: error.message,
    });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new FpmError(code, "A JSON document is malformed.", {
      path: filePath,
      cause: error.message,
    });
  }
}

export function stableJson(value) {
  const normalize = (entry) => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, normalize(entry[key])]));
    }
    return entry;
  };
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

export async function hashFile(filePath) {
  return sha256(await readFile(filePath));
}

export async function hashDirectory(root) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "build") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  await visit(root);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(root, file).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function resolveInside(root, relativePath, description = "path") {
  invariant(typeof relativePath === "string" && relativePath.length > 0,
    "FPM_PATH_INVALID", `A package ${description} must be a non-empty relative path.`, { relativePath });
  const absolute = path.resolve(root, relativePath);
  const relation = path.relative(root, absolute);
  invariant(relation !== "" && !relation.startsWith("..") && !path.isAbsolute(relation),
    "FPM_PATH_ESCAPE", `A package ${description} escapes its package directory.`, { root, relativePath });
  return absolute;
}

export async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, stableJson(value), "utf8");
}
