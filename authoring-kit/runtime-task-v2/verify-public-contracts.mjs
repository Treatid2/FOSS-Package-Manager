#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const kit = path.dirname(fileURLToPath(import.meta.url));
const bundled = path.join(kit, "public");
const installed = process.argv[2] ? path.resolve(process.argv[2]) : null;

function hash(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function inventory(root) {
  const result = new Map();
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        result.set(path.relative(root, absolute).replaceAll("\\", "/"), hash(await readFile(absolute)));
      }
    }
  }
  await visit(root);
  return result;
}

const lines = (await readFile(path.join(kit, "PUBLIC-CONTRACTS.sha256"), "utf8"))
  .trim().split(/\r?\n/).filter(Boolean);
const expected = new Map(lines.map((line) => {
  const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
  if (!match) throw new Error(`Malformed PUBLIC-CONTRACTS.sha256 line: ${line}`);
  return [match[2], match[1]];
}));

async function verify(label, root, options = {}) {
  const actual = await inventory(root);
  const expectedPaths = [...expected.keys()].sort();
  const actualPaths = [...actual.keys()].sort();
  const requiredPaths = options.allowAdditions
    ? expectedPaths.filter((entry) => entry !== "schemas/index.json") : expectedPaths;
  if (options.allowAdditions
    ? requiredPaths.some((entry) => !actual.has(entry))
    : JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(`${label} public-contract file set differs from the checkpoint manifest.`);
  }
  for (const [file, expectedHash] of expected) {
    if (options.allowAdditions && file === "schemas/index.json") continue;
    if (actual.get(file) !== expectedHash) {
      throw new Error(`${label} public contract hash mismatch: ${file}`);
    }
  }
  if (options.allowAdditions) {
    const bundledIndex = JSON.parse(await readFile(path.join(bundled, "schemas", "index.json"), "utf8"));
    const installedIndex = JSON.parse(await readFile(path.join(root, "schemas", "index.json"), "utf8"));
    const installedEntries = new Map(installedIndex.schemas.map((entry) => [entry.identity, entry]));
    for (const entry of bundledIndex.schemas) {
      if (JSON.stringify(installedEntries.get(entry.identity)) !== JSON.stringify(entry)) {
        throw new Error(`${label} public schema index changed or omitted the bundled identity ${entry.identity}.`);
      }
    }
  }
  return { label, root, contracts: actual.size,
    additions: options.allowAdditions ? actualPaths.filter((entry) => !expected.has(entry)) : [] };
}

const verified = [await verify("bundled", bundled)];
if (installed) verified.push(await verify("installed", installed, { allowAdditions: true }));
console.log(JSON.stringify({ status: "valid", manifest: "PUBLIC-CONTRACTS.sha256", verified }, null, 2));
