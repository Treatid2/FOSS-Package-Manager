// SPDX-License-Identifier: MPL-2.0

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function respond(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function failure(code, message, details = {}) {
  respond({ protocol: "fgpm.handler-response/1", ok: false, diagnostic: { code, message, details } });
}

function check(condition, code, message, details = {}) {
  if (!condition) throw Object.assign(new Error(message), { code, details });
}

async function readRequest() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return JSON.parse(text);
}

function inside(root, relativePath) {
  check(typeof relativePath === "string" && relativePath.length > 0,
    "FGPM_PORTABLE_OUTPUT_INVALID", "A portable action output path is missing.");
  const target = path.resolve(root, relativePath);
  const relation = path.relative(root, target);
  check(relation !== "" && !relation.startsWith("..") && !path.isAbsolute(relation),
    "FGPM_PORTABLE_OUTPUT_INVALID", "A portable action output escapes its staging transaction.", { relativePath });
  return target;
}

const allowedImports = new Set([
  "input_length",
  "read_input_byte",
  "write_output_byte",
  "denied_host_read",
  "denied_host_write",
  "denied_network",
]);

try {
  const limits = JSON.parse(process.env.FGPM_PORTABLE_LIMITS ?? "{}");
  const request = await readRequest();
  check(request.protocol === "fgpm.handler-request/1" && request.action === "materialize",
    "FGPM_PORTABLE_CONTRACT_INVALID", "The portable byte-transform runner accepts materialization actions only.");
  check(request.inputs?.length === 1 && request.transaction?.outputs?.length === 1,
    "FGPM_PORTABLE_CONTRACT_INVALID", "The portable byte-transform ABI requires exactly one input and one output.");
  const inputDeclaration = request.inputs[0];
  const outputDeclaration = request.transaction.outputs[0];
  check(inputDeclaration.kind === "blob" && outputDeclaration.kind === "blob",
    "FGPM_PORTABLE_CONTRACT_INVALID", "The portable byte-transform ABI currently accepts blob roots only.");

  const moduleText = await readFile(process.argv[2], "utf8");
  const moduleBytes = Buffer.from(moduleText.trim(), "base64");
  check(moduleBytes.length > 0 && moduleBytes.length <= limits.maxModuleBytes,
    "FGPM_HANDLER_RESOURCE_LIMIT", "A portable module exceeds its byte limit.", {
      actualBytes: moduleBytes.length,
      maximumBytes: limits.maxModuleBytes,
    });
  const input = await readFile(inputDeclaration.path);
  check(input.length <= limits.maxInputBytes, "FGPM_HANDLER_RESOURCE_LIMIT",
    "A declared portable input exceeds its byte limit.", {
      actualBytes: input.length,
      maximumBytes: limits.maxInputBytes,
    });

  const compiled = await WebAssembly.compile(moduleBytes);
  const imports = WebAssembly.Module.imports(compiled);
  check(imports.every((entry) => entry.module === "fgpm" && entry.kind === "function" && allowedImports.has(entry.name)),
    "FGPM_PORTABLE_IMPORT_DENIED", "A portable module requested an import outside the capability ABI.", { imports });

  const output = [];
  const evidence = {
    allowedInputReads: 0,
    allowedOutputWrites: 0,
    deniedHostReads: 0,
    deniedHostWrites: 0,
    deniedNetworkAttempts: 0,
  };
  const capabilities = {
    input_length: () => input.length,
    read_input_byte: (index) => {
      check(Number.isInteger(index) && index >= 0 && index < input.length,
        "FGPM_PORTABLE_INPUT_BOUNDS", "A portable module read outside its declared input.", { index, length: input.length });
      evidence.allowedInputReads += 1;
      return input[index];
    },
    write_output_byte: (value) => {
      check(Number.isInteger(value) && value >= 0 && value <= 255,
        "FGPM_PORTABLE_OUTPUT_INVALID", "A portable module emitted a non-byte output value.", { value });
      check(output.length < limits.maxOutputBytes, "FGPM_HANDLER_RESOURCE_LIMIT",
        "A portable module exceeded its output byte limit.", { maximumBytes: limits.maxOutputBytes });
      output.push(value);
      evidence.allowedOutputWrites += 1;
    },
    denied_host_read: () => {
      evidence.deniedHostReads += 1;
      return -1;
    },
    denied_host_write: () => {
      evidence.deniedHostWrites += 1;
      return -1;
    },
    denied_network: () => {
      evidence.deniedNetworkAttempts += 1;
      return -1;
    },
  };
  const instance = await WebAssembly.instantiate(compiled, { fgpm: capabilities });
  check(typeof instance.exports.transform === "function", "FGPM_PORTABLE_CONTRACT_INVALID",
    "A portable byte-transform module must export transform().");
  instance.exports.transform();
  check(output.length > 0, "FGPM_PORTABLE_OUTPUT_INVALID", "A portable module produced an empty output.");

  const bytes = Buffer.from(output);
  const target = inside(request.transaction.stagingDirectory, outputDeclaration.relativePath);
  await writeFile(target, bytes);
  if (evidence.deniedHostReads || evidence.deniedHostWrites || evidence.deniedNetworkAttempts) {
    failure("FGPM_SANDBOX_VIOLATION_CONFIRMED",
      "The portable violation fixture exercised allowed capabilities and was denied ambient authority.", {
        boundary: "wasm-capability-imports",
        evidence,
        committed: false,
      });
  } else {
    respond({
      protocol: "fgpm.handler-response/1",
      ok: true,
      output: {
        type: outputDeclaration.type,
        relativePath: outputDeclaration.relativePath,
        size: bytes.length,
        hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        inputs: [{ name: inputDeclaration.name, hash: inputDeclaration.hash }],
      },
    });
  }
} catch (error) {
  failure(error.code ?? "FGPM_PORTABLE_EXECUTION_FAILED", error.message, error.details ?? {});
}
