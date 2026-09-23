#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(repository, "public");
const kit = path.join(repository, "authoring-kit", "runtime-task-v2");
const kitPublic = path.join(kit, "public");

function hash(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function files(root) {
  const result = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) result.push(absolute);
    }
  }
  await visit(root);
  return result.sort();
}

await mkdir(kitPublic, { recursive: true });
await cp(source, kitPublic, { recursive: true, force: true });
await cp(path.join(source, "vocabularies", "runtime-task-v2.json"),
  path.join(repository, "packages", "fgpm.runtime-task-contracts", "runtime-task-v2.json"), { force: true });

const manifest = [];
for (const file of await files(source)) {
  const relative = path.relative(source, file).replaceAll("\\", "/");
  manifest.push(`${hash(await readFile(file))}  ${relative}`);
}
await writeFile(path.join(kit, "PUBLIC-CONTRACTS.sha256"), `${manifest.join("\n")}\n`, "utf8");
console.log(JSON.stringify({ source, kit: kitPublic, contracts: manifest.length }, null, 2));
