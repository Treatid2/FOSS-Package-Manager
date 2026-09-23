#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { hashDirectory } from "../src/core/io.mjs";

const current = path.resolve(process.argv[2] ?? ".");
const predecessor = process.argv[3] ? path.resolve(process.argv[3]) : null;
const namespace = process.argv[4] ?? "6d7092e8-6f8a-4e25-bb6e-a0bf6588e5b4";
const output = process.argv[5] ? path.resolve(process.argv[5]) : null;
if (!predecessor) throw new Error("Usage: map-public-package-cutover <current-root> <predecessor-root> [namespace]");

async function exists(file) {
  try { return (await stat(file)).isFile(); } catch { return false; }
}

const packages = [];
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".git", "build", "evidence", "node_modules"].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await visit(absolute);
    else if (entry.isFile() && entry.name === "fgpm-package.json") {
      const manifest = JSON.parse(await readFile(absolute, "utf8"));
      if (manifest.namespace !== namespace) continue;
      const relative = path.relative(current, directory);
      const renamed = relative.split(path.sep)
        .map((segment) => segment.startsWith("fgpm.") ? `fpm.${segment.slice(5)}` : segment).join(path.sep);
      let prior = null;
      for (const candidate of [...new Set([relative, renamed])]) {
        const manifestPath = path.join(predecessor, candidate, "fpm-package.json");
        if (await exists(manifestPath)) { prior = { candidate, manifestPath }; break; }
      }
      const oldManifest = prior ? JSON.parse(await readFile(prior.manifestPath, "utf8")) : null;
      packages.push({
        name: manifest.name,
        namespace,
        predecessor: prior ? {
          path: prior.candidate.replaceAll("\\", "/"),
          root: `sha256:${await hashDirectory(path.join(predecessor, prior.candidate))}`,
          version: oldManifest.version,
          entrypoint: "fpm-package.json",
          format: oldManifest.schema,
        } : null,
        successor: {
          path: relative.replaceAll("\\", "/"),
          root: `sha256:${await hashDirectory(directory)}`,
          version: manifest.version,
          entrypoint: "fgpm-package.json",
          format: manifest.format,
        },
      });
    }
  }
}

await visit(current);
packages.sort((left, right) => left.name.localeCompare(right.name)
  || left.successor.path.localeCompare(right.successor.path));
const document = `${JSON.stringify({ schema: "fgpm.package-cutover-map/1",
  inventoryScope: "fgpm-owned", namespace, externalOwnerSuccessorsAssigned: false, packages }, null, 2)}\n`;
if (output) await writeFile(output, document, "utf8");
else console.log(document);
