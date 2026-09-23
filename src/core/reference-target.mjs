// SPDX-License-Identifier: MPL-2.0

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export class ReferenceTargetError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ReferenceTargetError";
    this.code = "FGPM_REFERENCE_TARGET_MISMATCH";
    this.details = details;
  }
}

export function inspectPeRuntime(bytes) {
  if (bytes.length < 0x100 || bytes.toString("ascii", 0, 2) !== "MZ") {
    throw new ReferenceTargetError("The target runtime is not a PE executable.", { reason: "not-pe" });
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset + 26 > bytes.length || bytes.toString("ascii", peOffset, peOffset + 4) !== "PE\u0000\u0000") {
    throw new ReferenceTargetError("The target runtime has no valid PE header.", { reason: "invalid-pe-header" });
  }
  const machine = bytes.readUInt16LE(peOffset + 4);
  const optionalMagic = bytes.readUInt16LE(peOffset + 24);
  return {
    executableFormat: optionalMagic === 0x20b ? "PE32+" : optionalMagic === 0x10b ? "PE32" : "unknown",
    machine,
    architecture: machine === 0x8664 ? "x64" : machine === 0xaa64 ? "arm64" : "unknown",
  };
}

export async function verifyReferenceTarget(observed, required) {
  const failures = [];
  if (observed.host.os !== required.target.os) failures.push({ field: "host.os", expected: required.target.os,
    actual: observed.host.os });
  if (observed.host.architecture !== required.target.architecture) failures.push({ field: "host.architecture",
    expected: required.target.architecture, actual: observed.host.architecture });
  if (observed.nodeVersion !== required.target.nodeVersion) failures.push({ field: "nodeVersion",
    expected: required.target.nodeVersion, actual: observed.nodeVersion });
  const runtimeBytes = await readFile(observed.runtimePath);
  let executable;
  try {
    executable = inspectPeRuntime(runtimeBytes);
  } catch (error) {
    if (error instanceof ReferenceTargetError) failures.push({ field: "runtime", ...error.details });
    else throw error;
  }
  if (executable && executable.executableFormat !== required.target.executableFormat) {
    failures.push({ field: "runtime.executableFormat", expected: required.target.executableFormat,
      actual: executable.executableFormat });
  }
  if (executable && executable.machine !== required.target.machine) {
    failures.push({ field: "runtime.machine", expected: required.target.machine, actual: executable.machine });
  }
  const runtimeSha256 = sha256(runtimeBytes);
  if (runtimeSha256 !== required.runtime.sha256) failures.push({ field: "runtime.sha256",
    expected: required.runtime.sha256, actual: runtimeSha256 });
  if (failures.length) {
    throw new ReferenceTargetError("The current process cannot publish the declared reference-tools target.", {
      host: observed.host,
      target: required.target,
      runtimePath: observed.runtimePath,
      failures,
    });
  }
  return {
    host: observed.host,
    target: { os: required.target.os, architecture: executable.architecture,
      executableFormat: executable.executableFormat, machine: executable.machine,
      nodeVersion: required.target.nodeVersion, runtimeSha256 },
  };
}
