// SPDX-License-Identifier: Apache-2.0

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

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

function response(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

let input = "";
for await (const chunk of process.stdin) input += chunk;

try {
  const request = JSON.parse(input);
  if (request.protocol !== "fgpm.handler-request/1" || request.action !== "materialize"
    || request.proposal?.kind !== "generate-derived-package-domain") {
    throw Object.assign(new Error("Unsupported scene-integration generator request."), {
      code: "FGPM_GENERATOR_REQUEST_UNSUPPORTED",
    });
  }
  const output = request.transaction?.outputs?.[0];
  if (output?.kind !== "tree" || output.type !== "fgpm.generated-scene-integration/1") {
    throw Object.assign(new Error("The generator requires one declared scene-integration tree output."), {
      code: "FGPM_GENERATOR_OUTPUT_INVALID",
    });
  }
  const directory = path.join(request.transaction.stagingDirectory, output.relativePath);
  await mkdir(directory, { recursive: true });
  const generated = {
    schema: "fgpm.generated-scene-integration/1",
    package: request.proposal.parameters.packageId,
    inputPackageRoots: request.proposal.parameters.inputPackageRoots,
    inputArtifactRoots: request.proposal.parameters.inputArtifactRoots,
    parameters: request.proposal.parameters.parameters,
    environment: request.proposal.parameters.environment,
  };
  await writeFile(path.join(directory, "scene-integration.json"), stableJson(generated), "utf8");
  response({
    protocol: "fgpm.handler-response/1",
    ok: true,
    outputs: [{
      name: output.name,
      kind: "tree",
      type: output.type,
      relativePath: output.relativePath,
      inputs: [],
    }],
  });
} catch (error) {
  response({
    protocol: "fgpm.handler-response/1",
    ok: false,
    diagnostic: {
      code: error.code ?? "FGPM_GENERATOR_INTERNAL",
      message: error.message,
      details: {},
    },
  });
}
