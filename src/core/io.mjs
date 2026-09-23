// SPDX-License-Identifier: MPL-2.0

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile, mkdir, lstat } from "node:fs/promises";
import path from "node:path";
import { FgpmError, invariant } from "./errors.mjs";

export async function readJson(filePath, code = "FGPM_JSON_MALFORMED") {
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    throw new FgpmError("FGPM_FILE_UNREADABLE", "Could not read a required file.", {
      path: filePath,
      cause: error.message,
    });
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new FgpmError(code, "A JSON document is not valid UTF-8.", {
      path: filePath,
      cause: error.message,
      rule: "utf-8",
    });
  }
  try {
    return parseStrictJson(text.replace(/^\uFEFF/u, ""), filePath);
  } catch (error) {
    if (error?.code === "FGPM_JSON_DUPLICATE_MEMBER") throw error;
    if (error instanceof FgpmError) {
      throw new FgpmError(code, "A JSON document is malformed.", {
        path: filePath, cause: error.message, offset: error.details?.offset,
      });
    }
    throw new FgpmError(code, "A JSON document is malformed.", {
      path: filePath,
      cause: error.message,
    });
  }
}

export function parseStrictJson(text, filePath = "<json>") {
  let cursor = 0;
  const whitespace = /\s/u;
  const skip = () => { while (cursor < text.length && whitespace.test(text[cursor])) cursor += 1; };
  const malformed = (message) => new FgpmError("FGPM_JSON_MALFORMED", message, {
    path: filePath, offset: cursor,
  });
  const stringValue = () => {
    const start = cursor;
    cursor += 1;
    let escaped = false;
    while (cursor < text.length) {
      const character = text[cursor++];
      if (!escaped && character === '"') return JSON.parse(text.slice(start, cursor));
      if (!escaped && character === "\\") escaped = true;
      else escaped = false;
      if (character.charCodeAt(0) < 0x20) throw malformed("A JSON string contains an unescaped control character.");
    }
    throw malformed("A JSON string is unterminated.");
  };
  const value = () => {
    skip();
    if (text[cursor] === '"') return stringValue();
    if (text[cursor] === "{") {
      cursor += 1;
      const result = {};
      const names = new Set();
      skip();
      if (text[cursor] === "}") { cursor += 1; return result; }
      while (cursor < text.length) {
        skip();
        if (text[cursor] !== '"') throw malformed("A JSON object member name must be a string.");
        const name = stringValue();
        if (names.has(name)) throw new FgpmError("FGPM_JSON_DUPLICATE_MEMBER",
          "A JSON object contains a duplicate member.", { path: filePath, member: name, offset: cursor });
        names.add(name);
        skip();
        if (text[cursor++] !== ":") throw malformed("A JSON object member requires a colon.");
        result[name] = value();
        skip();
        const delimiter = text[cursor++];
        if (delimiter === "}") return result;
        if (delimiter !== ",") throw malformed("A JSON object requires a comma or closing brace.");
      }
      throw malformed("A JSON object is unterminated.");
    }
    if (text[cursor] === "[") {
      cursor += 1;
      const result = [];
      skip();
      if (text[cursor] === "]") { cursor += 1; return result; }
      while (cursor < text.length) {
        result.push(value());
        skip();
        const delimiter = text[cursor++];
        if (delimiter === "]") return result;
        if (delimiter !== ",") throw malformed("A JSON array requires a comma or closing bracket.");
      }
      throw malformed("A JSON array is unterminated.");
    }
    const remainder = text.slice(cursor);
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(remainder)?.[0];
    if (!token) throw malformed("A JSON value is malformed.");
    cursor += token.length;
    return JSON.parse(token);
  };
  const result = value();
  skip();
  if (cursor !== text.length) throw malformed("A JSON document has trailing content.");
  return result;
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

export async function hashDirectory(root, { strict = false } = {}) {
  if (strict) {
    const entry = await lstat(root);
    invariant(entry.isDirectory() && !entry.isSymbolicLink(), "FGPM_IDENTITY_INPUT_INVALID",
      "Identity input must be a real directory, not a file or link.", { path: root });
  }
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (strict) invariant(entry.isDirectory() || entry.isFile(), "FGPM_IDENTITY_ENTRY_UNSUPPORTED",
        "Identity verification does not support links or non-regular entries.", { path: path.join(directory, entry.name) });
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
    "FGPM_PATH_INVALID", `A package ${description} must be a non-empty relative path.`, { relativePath });
  const absolute = path.resolve(root, relativePath);
  const relation = path.relative(root, absolute);
  invariant(relation !== "" && !relation.startsWith("..") && !path.isAbsolute(relation),
    "FGPM_PATH_ESCAPE", `A package ${description} escapes its package directory.`, { root, relativePath });
  return absolute;
}

export async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, stableJson(value), "utf8");
}
