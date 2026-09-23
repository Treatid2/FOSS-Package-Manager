// SPDX-License-Identifier: MPL-2.0
import path from "node:path";
import { hashDirectory } from "./io.mjs";
import { invariant } from "./errors.mjs";

export async function packageIdentity(directory, expected = null) {
  const result = { schema: "fgpm.package-identity/1", status: "error", input: directory ?? null,
    expected, observed: null, exitCode: 2, contentOnly: true, error: null };
  try {
    invariant(typeof directory === "string" && directory.length > 0, "FGPM_CLI_USAGE",
      "package identity requires a directory.");
    result.input = path.resolve(directory);
    invariant(expected === null || (typeof expected === "string" && /^sha256:[0-9a-f]{64}$/u.test(expected)),
      "FGPM_IDENTITY_EXPECTED_INVALID", "Expected identity must be sha256: followed by 64 lowercase hexadecimal digits.");
    result.observed = `sha256:${await hashDirectory(result.input, { strict: true })}`;
    result.status = expected === null ? "computed" : expected === result.observed ? "match" : "mismatch";
    result.exitCode = result.status === "mismatch" ? 1 : 0;
  } catch (error) {
    result.error = { code: error.code ?? "FGPM_IDENTITY_READ_FAILED", message: error.message,
      details: error.details ?? null };
  }
  return result;
}

export function verifyPackageSidecar(sidecar, observedRoot) {
  invariant(sidecar && typeof sidecar === "object" && !Array.isArray(sidecar)
    && sidecar.schema === "fgpm.package-sidecar/1"
    && /^sha256:[0-9a-f]{64}$/u.test(sidecar.root ?? ""), "FGPM_PACKAGE_SIDECAR_INVALID",
  "A package sidecar must declare its schema and exact lower-case SHA-256 root.", { sidecar });
  invariant(sidecar.root === observedRoot, "FGPM_PACKAGE_SIDECAR_MISMATCH",
    "A supplied package sidecar does not describe the observed package root.", {
      declared: sidecar.root, observed: observedRoot,
    });
  return { schema: "fgpm.package-sidecar-verification/1", status: "match", root: observedRoot };
}

export function formatPackageIdentity(result) {
  return [`Package content identity: ${result.status}`, `Input: ${result.input ?? "(missing)"}`,
    `Expected: ${result.expected ?? "(not supplied)"}`, `Observed: ${result.observed ?? "(unavailable)"}`,
    ...(result.error ? [`Error: ${result.error.code}: ${result.error.message}`] : []),
    "Content only: no schema, authenticity, safety, compatibility or execution-authority claim.",
    `Exit code: ${result.exitCode}`].join("\n");
}
