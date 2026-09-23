#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, stat, writeFile } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixedDate = new Date("2026-09-23T00:00:00Z");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) throw new Error(`Missing required ${name}`);
  return path.resolve(process.argv[index + 1]);
}

async function files(root) {
  const result = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else result.push({ absolute, relative: path.relative(root, absolute).replaceAll(path.sep, "/") });
    }
  }
  await visit(root);
  return result.sort((left, right) => left.relative.localeCompare(right.relative, "en"));
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipDate(date) {
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

async function deterministicZip(root, destination) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const dos = zipDate(fixedDate);
  for (const entry of await files(root)) {
    const name = Buffer.from(entry.relative, "utf8");
    const source = await readFile(entry.absolute);
    const compressed = deflateRawSync(source, { level: 9 });
    const crc = crc32(source);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(dos.time, 10); local.writeUInt16LE(dos.date, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(source.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, compressed);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8); header.writeUInt16LE(8, 10); header.writeUInt16LE(dos.time, 12);
    header.writeUInt16LE(dos.date, 14); header.writeUInt32LE(crc, 16); header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(source.length, 24); header.writeUInt16LE(name.length, 28); header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
  const count = central.length / 2;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  await writeFile(destination, Buffer.concat([...chunks, ...central, end]));
}

function publicSourcePath(id) {
  return id === "fgpm.grid-dungeon-integration-runtime"
    ? `maintained-packages/${id}`
    : `packages/${id}`;
}

async function memberMap(root) {
  return Object.fromEntries(await Promise.all((await files(root)).map(async (entry) => {
    const content = await readFile(entry.absolute);
    return [entry.relative, { bytes: content.length, sha256: sha256(content) }];
  })));
}

async function privateCoordinationMatches(root) {
  const patterns = [/PON-[A-Z0-9-]+/gu, /(?:FGPM|FGRW)-MBX-[0-9]+/gu, /ENDPOINT-[a-f0-9]+/gu];
  const matches = [];
  for (const entry of await files(root)) {
    const content = await readFile(entry.absolute, "utf8");
    for (const pattern of patterns) {
      for (const match of content.matchAll(pattern)) matches.push({ path: entry.relative, value: match[0] });
    }
  }
  return matches;
}

async function main() {
  const objectsRoot = argument("--objects");
  const inventoryPath = argument("--inventory");
  const objectIndexPath = argument("--object-index");
  const output = argument("--out");
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  const objectIndex = JSON.parse(await readFile(objectIndexPath, "utf8"));
  const acceptedObjects = new Map(objectIndex.objects.map((entry) => [entry.id, entry]));
  const selected = inventory.objects
    .filter((entry) => entry.selected && entry.sourceOwnership === "existing FGPM owner")
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  await mkdir(output, { recursive: true });
  const packages = [];
  const blockedPackages = [];

  for (const entry of selected) {
    const accepted = acceptedObjects.get(entry.id);
    if (!accepted) throw new Error(`Missing accepted object metadata for ${entry.id}`);
    for (const field of ["contentHash", "namespace", "name", "version", "format", "license"])
      if (accepted[field] !== entry[field]) throw new Error(`${entry.id} ${field} mismatch`);
    const objectRoot = path.join(objectsRoot, entry.id);
    const privateMatches = await privateCoordinationMatches(objectRoot);
    if (privateMatches.length > 0) {
      blockedPackages.push({
        id: entry.id,
        contentRoot: entry.contentHash,
        status: "BLOCKED_PRIVATE_COORDINATION_IDENTIFIER",
        reason: "The accepted package tree contains an internal coordination identifier and cannot be published unchanged.",
        affectedPaths: [...new Set(privateMatches.map((match) => match.path))],
      });
      continue;
    }
    const sourcePath = publicSourcePath(entry.id);
    const sourceRoot = path.join(repository, ...sourcePath.split("/"));
    const acceptedMembers = await memberMap(objectRoot);
    const sourceMembers = await memberMap(sourceRoot);
    if (JSON.stringify(acceptedMembers) !== JSON.stringify(sourceMembers))
      throw new Error(`${entry.id} public source tree differs from accepted object tree`);
    const stem = `fgpm-package-${entry.id.replaceAll(".", "-")}-v${entry.version}`;
    const archiveName = `${stem}.zip`;
    const archivePath = path.join(output, archiveName);
    await deterministicZip(objectRoot, archivePath);
    const archive = await readFile(archivePath);
    const archiveSha256 = sha256(archive);
    const checksumName = `${archiveName}.sha256`;
    await writeFile(path.join(output, checksumName), `${archiveSha256}  ${archiveName}\n`);
    packages.push({
      id: entry.id,
      namespace: entry.namespace,
      name: entry.name,
      version: entry.version,
      format: entry.format,
      licence: entry.license,
      contentRoot: entry.contentHash,
      sourcePath,
      sourceTreeEquivalent: true,
      archive: { filename: archiveName, bytes: archive.length, sha256: archiveSha256 },
      checksum: checksumName,
    });
  }

  const index = {
    schema: "fgpm.publication-assets/1",
    managerVersion: "0.11.0-rc.6",
    acceptedBuildSource: "0ace04c117ffe21d310dddd5a8e96a06f860cfb3",
    expectedFgpmOwnedCount: selected.length,
    packageCount: packages.length,
    blockedPackageCount: blockedPackages.length,
    blockedPackages,
    packages,
  };
  const indexName = "fgpm-owned-package-index-v0.11.0-rc.6.json";
  await writeFile(path.join(output, indexName), `${JSON.stringify(index, null, 2)}\n`);
  const checksums = [];
  for (const entry of await files(output)) {
    if (entry.relative.endsWith(".sha256") || entry.relative === "SHA256SUMS.txt") continue;
    checksums.push(`${sha256(await readFile(entry.absolute))}  ${entry.relative}`);
  }
  await writeFile(path.join(output, "SHA256SUMS.txt"), `${checksums.join("\n")}\n`);
  console.log(JSON.stringify({ ok: true, output, packageCount: packages.length, index: indexName }, null, 2));
}

await main();
