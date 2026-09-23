#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

import { brotliCompressSync, deflateRawSync, constants as zlibConstants } from "node:zlib";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ReferenceTargetError, verifyReferenceTarget } from "../src/core/reference-target.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" }).trim();
const fixedDate = new Date("2026-01-01T00:00:00Z");
let activeStagingRoot = null;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const stableJson = (value) => `${JSON.stringify(value, Object.keys(value).sort(), 2)}\n`;

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function transformBindings(clause) {
  const trimmed = clause.trim();
  if (trimmed.startsWith("{")) {
    return trimmed.replace(/\bas\b/gu, ":");
  }
  if (/^[A-Za-z_$][\w$]*$/u.test(trimmed)) return `{ default: ${trimmed} }`;
  throw new Error(`Unsupported import clause: ${clause}`);
}

async function createRuntimeBundle() {
  const modules = new Map();
  const entryPath = path.join(sourceRoot, "src", "cli.mjs");
  const portablePath = path.join(sourceRoot, "src", "core", "portable-wasm-runner.mjs");
  const importPattern = /(^|\n)\s*import\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];/gu;

  async function include(modulePath) {
    const absolute = path.resolve(modulePath);
    if (modules.has(absolute)) return modules.get(absolute).id;
    const record = { id: modules.size, absolute, relative: path.relative(path.join(sourceRoot, "src"), absolute)
      .replaceAll(path.sep, "/"), source: await readFile(absolute, "utf8"), dependencies: [] };
    modules.set(absolute, record);
    for (const match of record.source.matchAll(importPattern)) {
      if (!match[3].startsWith(".")) continue;
      const dependency = path.resolve(path.dirname(absolute), match[3]);
      record.dependencies.push({ specifier: match[3], id: await include(dependency) });
    }
    return record.id;
  }

  const entryId = await include(entryPath);
  const portableId = await include(portablePath);
  const byAbsolute = new Map([...modules.values()].map((record) => [record.absolute, record]));
  const factories = [];
  for (const record of modules.values()) {
    const exported = new Set();
    for (const pattern of [
      /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gu,
      /\bexport\s+class\s+([A-Za-z_$][\w$]*)/gu,
      /\bexport\s+const\s+([A-Za-z_$][\w$]*)/gu,
    ]) for (const match of record.source.matchAll(pattern)) exported.add(match[1]);

    let transformed = record.source.replace(/^#!.*\r?\n/u, "").replace(importPattern, (whole, prefix, clause, specifier) => {
      const bindings = transformBindings(clause);
      if (specifier.startsWith(".")) {
        const dependency = byAbsolute.get(path.resolve(path.dirname(record.absolute), specifier));
        return `${prefix}const ${bindings} = await __load(${dependency.id});`;
      }
      return `${prefix}const ${bindings} = await import(${JSON.stringify(specifier)});`;
    });
    transformed = transformed.replace(/\bimport\.meta\.url\b/gu, "__moduleUrl")
      .replace(/\bexport\s+(?=(?:async\s+)?function|class|const)/gu, "");
    if (record.absolute === entryPath) transformed = transformed.replace(/\nmain\(\)\.catch\(/u, "\nawait main().catch(");
    transformed += `\nreturn { ${[...exported].sort().join(", ")} };\n`;
    factories.push(`${record.id}: async (__load, __moduleUrl) => {\n${transformed}\n}`);
  }

  const virtualPaths = Object.fromEntries([...modules.values()].map((record) => [record.id, record.relative]));
  const program = `// FGPM compiled/bundled runtime payload; corresponding source is identified in manifests.\n`
    + `const path = (await import("node:path")).default;\n`
    + `const { pathToFileURL } = await import("node:url");\n`
    + `const root = process.env.FGPM_DISTRIBUTION_ROOT;\n`
    + `const loader = process.env.FGPM_DISTRIBUTION_LOADER;\n`
    + `if (!root || !loader) throw new Error("FGPM distribution launcher context is missing.");\n`
    + `process.env.FGPM_BUNDLED_RUNNER = JSON.stringify([loader, "__portable-runner"]);\n`
    + `const virtualPaths = ${JSON.stringify(virtualPaths)};\n`
    + `const factories = {${factories.join(",\n")}};\n`
    + `const cache = new Map();\n`
    + `async function load(id) {\n`
    + `  if (!cache.has(id)) cache.set(id, factories[id](load, pathToFileURL(path.join(root, "src", virtualPaths[id])).href));\n`
    + `  return cache.get(id);\n}\n`
    + `const portable = process.argv[2] === "__portable-runner";\n`
    + `if (portable) process.argv.splice(2, 1);\n`
    + `await load(portable ? ${portableId} : ${entryId});\n`;
  return brotliCompressSync(Buffer.from(program), {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11, [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT },
  });
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

function checksumText(entries) {
  return entries.map((entry) => `${entry.hash}  ${entry.relative}`).join("\n") + "\n";
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
  return { time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate() };
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

async function createReferenceFixture(destination) {
  const staging = [];
  const packageRoot = path.join(sourceRoot, "packages");
  for (const entry of await files(packageRoot)) staging.push({ absolute: entry.absolute, path: `packages/${entry.relative}` });
  const exampleRoot = path.join(sourceRoot, "authoring-kit", "runtime-task-v2", "example-package");
  for (const entry of await files(exampleRoot)) staging.push({ absolute: entry.absolute,
    path: `packages/example.runtime-task-v2/${entry.relative}` });
  const profile = JSON.parse(await readFile(path.join(sourceRoot, "authoring-kit", "runtime-task-v2", "self-check-profile.json"), "utf8"));
  profile.packageRoots = ["packages"];
  const profileBytes = Buffer.from(`${JSON.stringify(profile, null, 2)}\n`);
  const members = await Promise.all(staging.map(async (entry) => {
    const bytes = await readFile(entry.absolute);
    return { path: entry.path, sha256: sha256(bytes), content: bytes.toString("base64") };
  }));
  members.push({ path: "profile.json", sha256: sha256(profileBytes), content: profileBytes.toString("base64") });
  members.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const contentRoot = sha256(members.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n") + "\n");
  const fixture = { schema: "fgpm.reference-fixture/1", version: 1, contentRoot, profile: "profile.json",
    purpose: "source-independent runtime-task-v2 authoring and lifecycle exercise", files: members };
  await writeFile(destination, `${JSON.stringify(fixture)}\n`);
}

async function main() {
  const requiredRuntime = JSON.parse(await readFile(path.join(sourceRoot, "reference-runtime.json"), "utf8"));
  const managerManifest = JSON.parse(await readFile(path.join(sourceRoot, "manager.json"), "utf8"));
  const packageManifest = JSON.parse(await readFile(path.join(sourceRoot, "package.json"), "utf8"));
  if (packageManifest.version !== managerManifest.version) throw new Error("Manager/package version mismatch");
  const targetFacts = await verifyReferenceTarget({
    host: { os: process.platform, architecture: process.arch, nodeVersion: process.versions.node },
    runtimePath: process.execPath,
    nodeVersion: process.versions.node,
  }, requiredRuntime);
  const nodeLicencePath = path.join(sourceRoot, requiredRuntime.licence.localPath);
  const nodeLicence = await readFile(nodeLicencePath);
  if (sha256(nodeLicence) !== requiredRuntime.licence.sha256) {
    throw new ReferenceTargetError("The exact bundled Node licence/notice set is unavailable.", {
      field: "licence.sha256", expected: requiredRuntime.licence.sha256, actual: sha256(nodeLicence),
      path: nodeLicencePath,
    });
  }
  const outputRoot = path.resolve(argument("--out", path.join(sourceRoot, "build", "reference-tools")));
  const artifactName = `fgpm-reference-tools-${targetFacts.target.os}-${targetFacts.target.architecture}-v${managerManifest.version}`;
  const finalDistribution = path.join(outputRoot, artifactName);
  const finalZipPath = `${finalDistribution}.zip`;
  const stagingRoot = path.join(outputRoot, `.${artifactName}.staging-${process.pid}`);
  activeStagingRoot = stagingRoot;
  const distribution = path.join(stagingRoot, artifactName);
  const zipPath = path.join(stagingRoot, `${artifactName}.zip`);
  await rm(stagingRoot, { recursive: true, force: true });
  for (const directory of ["bin", "public", "guide", "fixtures", "manifests", "LICENSES", "contracts"]) {
    await mkdir(path.join(distribution, directory), { recursive: true });
  }

  const payload = await createRuntimeBundle();
  const payloadHash = sha256(payload);
  await writeFile(path.join(distribution, "bin", "fgpm-runtime.bundle"), payload);
  await cp(process.execPath, path.join(distribution, "bin", "node.exe"));
  const loader = `// Generic FGPM bundled-runtime loader.\nimport { readFile } from "node:fs/promises";\nimport { brotliDecompressSync } from "node:zlib";\nimport { createHash } from "node:crypto";\nimport path from "node:path";\nimport { fileURLToPath } from "node:url";\nconst here=path.dirname(fileURLToPath(import.meta.url));\nconst payload=await readFile(path.join(here,"fgpm-runtime.bundle"));\nconst actual=createHash("sha256").update(payload).digest("hex");\nif(actual!==${JSON.stringify(payloadHash)}){console.error(JSON.stringify({code:"FGPM_DISTRIBUTION_TAMPERED",message:"The bundled runtime hash does not match its build identity.",expected:${JSON.stringify(payloadHash)},actual}));process.exit(1);}\nprocess.env.FGPM_DISTRIBUTION_ROOT=path.resolve(here,"..");\nprocess.env.FGPM_DISTRIBUTION_LOADER=fileURLToPath(import.meta.url);\nconst program=brotliDecompressSync(payload);\nawait import(\`data:text/javascript;base64,\${program.toString("base64")}\`);\n`;
  await writeFile(path.join(distribution, "bin", "fgpm.mjs"), loader);
  await writeFile(path.join(distribution, "fgpm.cmd"), "@echo off\r\n\"%~dp0bin\\node.exe\" \"%~dp0bin\\fgpm.mjs\" %*\r\n");

  await cp(path.join(sourceRoot, "public"), path.join(distribution, "public"), { recursive: true });
  await cp(path.join(sourceRoot, "tools", "public-qualification"), path.join(distribution, "qualification"), { recursive: true });
  await cp(path.join(sourceRoot, "contracts", "phase-9"), path.join(distribution, "contracts", "phase-9"), { recursive: true });
  await cp(path.join(sourceRoot, "authoring-kit", "runtime-task-v2"), path.join(distribution, "guide", "runtime-task-v2"), { recursive: true });
  await cp(path.join(sourceRoot, "docs", "reference-authoring-guide.md"), path.join(distribution, "guide", "package-authoring-guide.md"));
  await cp(path.join(sourceRoot, "docs", "package-entrypoint-and-identity.md"), path.join(distribution, "guide", "package-entrypoint-and-identity.md"));
  await createReferenceFixture(path.join(distribution, "fixtures", "runtime-task-v2.fixture"));
  await cp(path.join(sourceRoot, "manager.json"), path.join(distribution, "manager.json"));
  await cp(path.join(sourceRoot, "LICENSE"), path.join(distribution, "LICENSES", "MPL-2.0.txt"));
  await cp(path.join(sourceRoot, "LICENSES", "Apache-2.0.txt"), path.join(distribution, "LICENSES", "Apache-2.0.txt"));
  await cp(nodeLicencePath, path.join(distribution, "LICENSES", "Node.js.txt"));
  await cp(path.join(sourceRoot, "docs", "reference-tools-readme.md"), path.join(distribution, "README.md"));
  await cp(path.join(sourceRoot, "docs", `release-notes-${managerManifest.version}.md`), path.join(distribution, "RELEASE-NOTES.md"));
  await cp(path.join(sourceRoot, "docs", "public-runtime-sessions.md"), path.join(distribution, "guide", "public-runtime-sessions.md"));
  await cp(path.join(sourceRoot, "docs", "package-variant-recovery.md"), path.join(distribution, "guide", "package-variant-recovery.md"));
  await cp(path.join(sourceRoot, "LICENSING.md"), path.join(distribution, "LICENSES", "SOURCE-LICENSING.md"));

  const publicEntries = (await files(path.join(distribution, "public"))).map(async (entry) => ({
    relative: `public/${entry.relative}`, hash: sha256(await readFile(entry.absolute)),
  }));
  const publicResolved = await Promise.all(publicEntries);
  await writeFile(path.join(distribution, "manifests", "public-contracts.sha256"), checksumText(publicResolved));
  const publicRoot = sha256(checksumText(publicResolved));
  const fixture = JSON.parse(await readFile(path.join(distribution, "fixtures", "runtime-task-v2.fixture"), "utf8"));
  const runtimeProvenance = {
    ...requiredRuntime,
    observed: { host: targetFacts.host, target: targetFacts.target },
  };
  await writeFile(path.join(distribution, "manifests", "runtime-provenance.json"),
    `${JSON.stringify(runtimeProvenance, null, 2)}\n`);
  const noticeEntries = [{ relative: "LICENSES/Node.js.txt", hash: sha256(nodeLicence) }];
  const noticeManifest = checksumText(noticeEntries);
  await writeFile(path.join(distribution, "manifests", "node-notices.sha256"), noticeManifest);
  const sbom = {
    schema: "fgpm.reference-sbom/2", components: [
      { kind: "implementation", name: "FOSS Package Manager reference runtime", version: managerManifest.version,
        license: "MPL-2.0", sourceCommit, bundled: "bin/fgpm-runtime.bundle" },
      { kind: "public-contracts", name: "FGPM public schemas, examples, and authoring kit",
        version: "experimental-v0", license: "Apache-2.0", root: `sha256:${publicRoot}` },
      { kind: "public-companion", name: "FGPM source-free public qualification kit and dungeon harness",
        version: "0.2.0", license: "Apache-2.0", path: "qualification",
        boundary: "15 additive public-interface cases; not original 137-case equivalence; dungeon consumes curator generation" },
      { kind: "runtime-distribution", name: "Node.js", version: requiredRuntime.target.nodeVersion,
        licenseEvidence: "LICENSES/Node.js.txt", bundled: "bin/node.exe",
        binarySha256: requiredRuntime.runtime.sha256, archive: requiredRuntime.release },
      { kind: "runtime-third-party-notices", name: "Node.js bundled third-party components and notices",
        version: requiredRuntime.target.nodeVersion, noticeInventory: "manifests/node-notices.sha256",
        completeUpstreamNoticeSet: "LICENSES/Node.js.txt", noticeSha256: requiredRuntime.licence.sha256 },
      { kind: "sealed-fixture", name: "FGPM runtime-task-v2 fixture", version: "experimental-v0",
        license: "Apache-2.0", root: `sha256:${fixture.contentRoot}` },
    ],
  };
  const sbomBytes = Buffer.from(`${JSON.stringify(sbom, null, 2)}\n`);
  await writeFile(path.join(distribution, "manifests", "SBOM.json"), sbomBytes);
  const correspondence = `# Source correspondence\n\nThe complete corresponding source is commit \`${sourceCommit}\` of\nhttps://github.com/Treatid2/FOSS-Package-Manager under MPL-2.0 and Apache-2.0 as described by the repository.\nThe response package also contains a complete Git bundle. Build on Windows x64 with the exact verified Node.js ${requiredRuntime.target.nodeVersion} runtime described by \`reference-runtime.json\`:\n\`node tools/build-reference-distribution.mjs --out <empty-directory>\`.\nThe builder rejects a host, executable format, architecture, version, runtime hash, or licence hash mismatch before publishing a Windows-labelled artifact.\n`;
  await writeFile(path.join(distribution, "manifests", "SOURCE-CORRESPONDENCE.md"), correspondence);
  const correspondenceRoot = sha256(Buffer.from(correspondence));
  const licenceEvidence = [
    { relative: "LICENSES/Node.js.txt", hash: requiredRuntime.licence.sha256 },
    { relative: "manifests/node-notices.sha256", hash: sha256(Buffer.from(noticeManifest)) },
    { relative: "manifests/runtime-provenance.json",
      hash: sha256(Buffer.from(`${JSON.stringify(runtimeProvenance, null, 2)}\n`)) },
    { relative: "manifests/SBOM.json", hash: sha256(sbomBytes) },
  ];
  const licenceSbomRoot = sha256(checksumText(licenceEvidence));
  const identity = {
    schema: "fgpm.reference-tool-identity/1",
    manager: { id: managerManifest.id, version: managerManifest.version,
      buildIdentity: managerManifest.buildIdentity },
    runtime: { implementationPayloadRoot: `sha256:${payloadHash}`,
      binaryRoot: `sha256:${requiredRuntime.runtime.sha256}` },
    distribution: { kind: "source-free-reference-authoring-v0", contentRoot: null },
    publicContracts: { root: `sha256:${publicRoot}` },
    fixture: { root: `sha256:${fixture.contentRoot}` },
    source: { commit: sourceCommit, correspondence: "manifests/SOURCE-CORRESPONDENCE.md",
      correspondenceRoot: `sha256:${correspondenceRoot}` },
    licensing: { root: `sha256:${licenceSbomRoot}`, sbom: "manifests/SBOM.json",
      noticeInventory: "manifests/node-notices.sha256" },
    platform: { host: targetFacts.host, target: targetFacts.target, bundledRuntime: true },
    supportedCommands: ["version", "help", "doctor", "contracts verify", "validate-package", "validate-profile", "migrate pre-public-package",
      "fixture verify", "fixture materialize", "build", "run", "conformance runtime-task", "explain", "store-report", "control", "package", "workspace",
      "candidate", "generation", "distribution", "package identity"],
    securityPosture: { automaticNetworkAccess: false, hostileCodeContainment: false },
  };
  const contentBeforeIdentity = await files(distribution);
  const contentEntries = await Promise.all(contentBeforeIdentity.map(async (entry) => ({
    relative: entry.relative, hash: sha256(await readFile(entry.absolute)),
  })));
  identity.distribution.contentRoot = `sha256:${sha256(checksumText(contentEntries))}`;
  await writeFile(path.join(distribution, "manifests", "tool-distribution.json"), `${JSON.stringify(identity, null, 2)}\n`);
  const allBeforeFilesManifest = await files(distribution);
  const fileEntries = await Promise.all(allBeforeFilesManifest.map(async (entry) => ({
    relative: entry.relative, hash: sha256(await readFile(entry.absolute)),
  })));
  await writeFile(path.join(distribution, "manifests", "files.sha256"), checksumText(fileEntries));
  await deterministicZip(distribution, zipPath);
  await rm(finalDistribution, { recursive: true, force: true });
  await rm(finalZipPath, { force: true });
  await rename(distribution, finalDistribution);
  await rename(zipPath, finalZipPath);
  await rm(stagingRoot, { recursive: true, force: true });
  activeStagingRoot = null;
  const result = { schema: "fgpm.reference-distribution-build/2", distribution: finalDistribution, zip: finalZipPath,
    zipBytes: (await stat(finalZipPath)).size, zipSha256: sha256(await readFile(finalZipPath)), sourceCommit,
    managerBuildIdentity: managerManifest.buildIdentity, runtimePayloadRoot: `sha256:${payloadHash}`,
    toolContentRoot: identity.distribution.contentRoot, publicContractRoot: `sha256:${publicRoot}`,
    fixtureRoot: identity.fixture.root, sourceCorrespondenceRoot: identity.source.correspondenceRoot,
    licenceSbomRoot: identity.licensing.root, target: targetFacts.target,
    files: (await files(finalDistribution)).length };
  console.log(JSON.stringify(result, null, 2));
}

try {
  await main();
} catch (error) {
  if (activeStagingRoot) await rm(activeStagingRoot, { recursive: true, force: true });
  console.error(JSON.stringify({
    schema: "fgpm.reference-distribution-build-error/1",
    code: error.code ?? "FGPM_REFERENCE_DISTRIBUTION_BUILD_FAILED",
    message: error.message,
    details: error.details ?? null,
  }));
  process.exitCode = 1;
}
