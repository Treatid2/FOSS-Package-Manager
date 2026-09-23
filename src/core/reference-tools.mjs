// SPDX-License-Identifier: MPL-2.0

import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function json(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseChecksums(text) {
  return text.split(/\r?\n/u).filter(Boolean).map((line) => {
    const match = /^([0-9a-f]{64}) [ *](.+)$/u.exec(line);
    if (!match) throw new Error(`Malformed checksum line: ${line}`);
    return { hash: match[1], relativePath: match[2].replaceAll("/", path.sep) };
  });
}

async function verifyChecksumFile(root, checksumPath) {
  const entries = parseChecksums(await readFile(checksumPath, "utf8"));
  const failures = [];
  for (const entry of entries) {
    const target = path.resolve(root, entry.relativePath);
    const relation = path.relative(root, target);
    if (!relation || relation.startsWith("..") || path.isAbsolute(relation)) {
      failures.push({ path: entry.relativePath, reason: "path-escape" });
      continue;
    }
    try {
      const actual = sha256(await readFile(target));
      if (actual !== entry.hash) failures.push({ path: entry.relativePath, expected: entry.hash, actual });
    } catch (error) {
      failures.push({ path: entry.relativePath, reason: error.code ?? error.message });
    }
  }
  return { checked: entries.length, failures };
}

export async function referenceIdentity(projectRoot) {
  const distributionManifest = path.join(projectRoot, "manifests", "tool-distribution.json");
  if (await exists(distributionManifest)) return json(distributionManifest);
  const manager = await json(path.join(projectRoot, "manager.json"));
  return {
    schema: "fgpm.reference-tool-identity/1",
    manager: { id: manager.id, version: manager.version, buildIdentity: manager.buildIdentity },
    runtime: { implementationPayloadRoot: null, binaryRoot: null },
    distribution: { kind: "source-checkout", contentRoot: null },
    publicContracts: { root: null },
    fixture: { root: null },
    source: { commit: process.env.FGPM_SOURCE_COMMIT ?? "working-tree", correspondence: "repository checkout",
      correspondenceRoot: null },
    licensing: { root: null, sbom: null, noticeInventory: null },
    platform: { host: { os: process.platform, architecture: process.arch, nodeVersion: process.versions.node },
      target: null, bundledRuntime: false },
  };
}

export async function verifyReferenceContracts(projectRoot) {
  const checksumPath = path.join(projectRoot, "manifests", "public-contracts.sha256");
  const fallback = path.join(projectRoot, "authoring-kit", "runtime-task-v2", "PUBLIC-CONTRACTS.sha256");
  const selected = await exists(checksumPath) ? checksumPath : fallback;
  const verificationRoot = selected === fallback
    ? path.join(projectRoot, "authoring-kit", "runtime-task-v2", "public") : projectRoot;
  try {
    const result = await verifyChecksumFile(verificationRoot, selected);
    return {
      schema: "fgpm.reference-contract-verification/1",
      status: result.failures.length === 0 ? "pass" : "fail",
      checksumManifest: path.relative(projectRoot, selected).replaceAll(path.sep, "/"),
      ...result,
    };
  } catch (error) {
    return { schema: "fgpm.reference-contract-verification/1", status: "fail", checked: 0,
      failures: [{ reason: error.code ?? error.message }] };
  }
}

export async function referenceDoctor(projectRoot, options = {}) {
  const checks = [];
  const identity = await referenceIdentity(projectRoot);
  const filesManifest = path.join(projectRoot, "manifests", "files.sha256");
  if (await exists(filesManifest)) {
    const files = await verifyChecksumFile(projectRoot, filesManifest);
    checks.push({ name: "distribution-integrity", status: files.failures.length ? "fail" : "pass", ...files });
  } else {
    checks.push({ name: "distribution-integrity", status: "not-applicable", reason: "source-checkout" });
  }
  const contracts = await verifyReferenceContracts(projectRoot);
  checks.push({ name: "public-contracts", status: contracts.status, checked: contracts.checked,
    failures: contracts.failures });
  if (identity.distribution.contentRoot) {
    const roots = [identity.manager.buildIdentity, identity.runtime?.implementationPayloadRoot,
      identity.runtime?.binaryRoot, identity.distribution.contentRoot, identity.publicContracts.root,
      identity.fixture?.root, identity.source?.correspondenceRoot, identity.licensing?.root];
    const malformed = roots.filter((entry) => !/^sha256:[0-9a-f]{64}$/u.test(entry ?? ""));
    const substituted = identity.manager.buildIdentity === identity.runtime?.implementationPayloadRoot
      || identity.distribution.contentRoot === identity.publicContracts.root;
    checks.push({ name: "identity-semantics", status: malformed.length || substituted ? "fail" : "pass",
      managerBuildIdentity: identity.manager.buildIdentity,
      runtimePayloadRoot: identity.runtime?.implementationPayloadRoot,
      toolContentRoot: identity.distribution.contentRoot,
      publicContractRoot: identity.publicContracts.root,
      fixtureRoot: identity.fixture?.root,
      sourceCorrespondenceRoot: identity.source?.correspondenceRoot,
      licenceSbomRoot: identity.licensing?.root,
      malformed, substituted });
    try {
      const notices = await verifyChecksumFile(projectRoot,
        path.join(projectRoot, identity.licensing.noticeInventory));
      const sbom = await json(path.join(projectRoot, identity.licensing.sbom));
      const kinds = new Set(sbom.components?.map((entry) => entry.kind));
      const requiredKinds = ["implementation", "public-contracts", "runtime-distribution",
        "runtime-third-party-notices", "sealed-fixture"];
      const missingKinds = requiredKinds.filter((kind) => !kinds.has(kind));
      checks.push({ name: "licence-sbom", status: notices.failures.length || missingKinds.length ? "fail" : "pass",
        checked: notices.checked, failures: notices.failures, missingKinds });
    } catch (error) {
      checks.push({ name: "licence-sbom", status: "fail", reason: error.code ?? error.message });
    }
  }
  checks.push({ name: "runtime", status: Number(process.versions.node.split(".")[0]) >= 22 ? "pass" : "fail",
    node: process.versions.node, platform: process.platform, architecture: process.arch });
  if (options.managerRoot) {
    const candidate = path.resolve(options.managerRoot);
    const existing = await exists(candidate) ? candidate : path.dirname(candidate);
    try {
      await access(existing, constants.W_OK);
      checks.push({ name: "writable-manager-root", status: "pass", path: candidate });
    } catch (error) {
      checks.push({ name: "writable-manager-root", status: "fail", path: candidate, reason: error.code });
    }
  }
  checks.push({ name: "network-posture", status: "pass", automaticNetworkAccess: false,
    dependencyInstallation: false, updateChecks: false });
  return { schema: "fgpm.reference-doctor/1",
    status: checks.some((entry) => entry.status === "fail") ? "fail" : "pass", identity, checks };
}

export async function verifyReferenceFixture(fixturePath) {
  const document = await json(path.resolve(fixturePath));
  const failures = [];
  if (document?.schema !== "fgpm.reference-fixture/1" || !Array.isArray(document.files)) {
    failures.push({ reason: "fixture-schema-invalid" });
  } else {
    for (const entry of document.files) {
      try {
        const bytes = Buffer.from(entry.content, "base64");
        const actual = sha256(bytes);
        if (actual !== entry.sha256) failures.push({ path: entry.path, expected: entry.sha256, actual });
      } catch (error) {
        failures.push({ path: entry.path, reason: error.message });
      }
    }
    const root = sha256(document.files.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n") + "\n");
    if (root !== document.contentRoot) failures.push({ reason: "fixture-root-mismatch",
      expected: document.contentRoot, actual: root });
  }
  return { schema: "fgpm.reference-fixture-verification/1", status: failures.length ? "fail" : "pass",
    fixture: path.resolve(fixturePath), files: document?.files?.length ?? 0, contentRoot: document?.contentRoot ?? null,
    failures };
}

export async function materializeReferenceFixture(fixturePath, outputDirectory) {
  const verification = await verifyReferenceFixture(fixturePath);
  if (verification.status !== "pass") return verification;
  const destination = path.resolve(outputDirectory);
  try {
    if ((await readdir(destination)).length > 0) {
      return { ...verification, status: "fail", failures: [{ reason: "output-directory-not-empty", path: destination }] };
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const document = await json(path.resolve(fixturePath));
  for (const entry of document.files) {
    const target = path.resolve(destination, entry.path.replaceAll("/", path.sep));
    const relation = path.relative(destination, target);
    if (!relation || relation.startsWith("..") || path.isAbsolute(relation)) {
      return { ...verification, status: "fail", failures: [{ reason: "fixture-path-escape", path: entry.path }] };
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(entry.content, "base64"));
  }
  return { ...verification, materialized: destination, profile: path.join(destination, document.profile) };
}
