// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function response(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(code, message, details = {}) {
  response({ protocol: "fpm.handler-response/1", ok: false, diagnostic: { code, message, details } });
}

function requireCondition(condition, message, details = {}) {
  if (!condition) {
    const error = new Error(message);
    error.code = "FPM_ADAPTER_INPUT_INVALID";
    error.details = details;
    throw error;
  }
}

function stableJson(value) {
  const normalize = (entry) => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, normalize(entry[key])]));
    }
    return entry;
  };
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

try {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const request = JSON.parse(input);
  requireCondition(request.protocol === "fpm.handler-request/1" && request.action === "materialize"
    && request.proposal.kind === "adapt", "Unsupported adapter request.");
  const sourceInput = request.inputs.find((entry) => entry.name === "source");
  requireCondition(sourceInput?.type === "texture.solid-colour/1", "The adapter requires a solid-colour input artifact.");
  const source = JSON.parse(await readFile(sourceInput.path, "utf8"));
  requireCondition(source.schema === "fpm.texture.solid-colour/1" && Array.isArray(source.colour)
    && source.colour.length === 3, "The solid-colour source artifact is malformed.");
  const content = {
    schema: "fpm.texture.runtime.rgba8-srgb/1",
    width: 1,
    height: 1,
    pixels: [...source.colour, 255],
  };
  const output = request.transaction.outputs[0];
  const text = stableJson(content);
  await writeFile(path.join(request.transaction.stagingDirectory, output.relativePath), text, "utf8");
  response({
    protocol: "fpm.handler-response/1",
    ok: true,
    output: {
      type: output.type,
      relativePath: output.relativePath,
      size: Buffer.byteLength(text),
      hash: `sha256:${createHash("sha256").update(text).digest("hex")}`,
      inputs: [{ name: sourceInput.name, hash: sourceInput.hash }],
    },
  });
} catch (error) {
  fail(error.code ?? "FPM_HANDLER_INTERNAL", error.message, error.details ?? {});
}
