// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function response(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(code, message, details = {}) {
  response({ protocol: "fgpm.handler-response/1", ok: false, diagnostic: { code, message, details } });
}

function requireCondition(condition, message, details = {}) {
  if (!condition) {
    const error = new Error(message);
    error.code = "FGPM_DOMAIN_MANIFEST_INVALID";
    error.details = details;
    throw error;
  }
}

async function readRequest() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return JSON.parse(input);
}

function validateColour(colour) {
  requireCondition(Array.isArray(colour) && colour.length === 3
    && colour.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255),
  "Texture colour channels must be three integers from 0 to 255.", { colour });
}

function packagePath(manifestPath, relativePath) {
  const root = path.dirname(manifestPath);
  const absolute = path.resolve(root, relativePath);
  const relation = path.relative(root, absolute);
  requireCondition(relation && !relation.startsWith("..") && !path.isAbsolute(relation),
    "A texture source file escapes its contribution directory.", { relativePath });
  return absolute;
}

function parsePpm(text) {
  const tokens = text.replace(/#[^\r\n]*/g, " ").trim().split(/\s+/);
  requireCondition(tokens[0] === "P3" && tokens[1] === "1" && tokens[2] === "1" && tokens[3] === "255",
    "The prototype texture handler accepts only one-pixel P3 PPM files with max value 255.");
  const colour = tokens.slice(4, 7).map(Number);
  validateColour(colour);
  return colour;
}

async function analyze(request) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(request.contribution.manifestPath, "utf8"));
  } catch (error) {
    fail("FGPM_DOMAIN_MANIFEST_MALFORMED", "A texture manifest could not be parsed.", {
      contribution: request.contribution.id,
      path: request.contribution.manifestPath,
      cause: error.message,
    });
    return;
  }
  requireCondition(manifest.schema === request.contribution.manifestType,
    "The texture manifest schema does not match its declared manifest type.", {
      declared: request.contribution.manifestType,
      actual: manifest.schema,
    });
  const exported = manifest.export;
  requireCondition(exported && typeof exported.id === "string" && typeof exported.semanticType === "string",
    "A texture manifest must declare one typed export.");

  let action;
  let outputType;
  let parameters;
  if (manifest.schema === "fgpm.demo.texture-file/1") {
    requireCondition(typeof exported.file === "string", "A file-backed texture must declare a source file.");
    parsePpm(await readFile(packagePath(request.contribution.manifestPath, exported.file), "utf8"));
    action = "materialize-texture-file";
    outputType = "texture.runtime.rgba8-srgb/1";
    parameters = { file: exported.file };
  } else if (manifest.schema === "fgpm.demo.solid-colour/1") {
    validateColour(exported.colour);
    action = "materialize-solid-colour";
    outputType = exported.semanticType;
    parameters = { colour: exported.colour };
  } else if (manifest.schema === "fgpm.demo.environment-colour/1") {
    requireCondition(exported.variants && typeof exported.variants === "object",
      "An environment-controlled colour must declare variants.");
    for (const colour of Object.values(exported.variants)) validateColour(colour);
    action = "materialize-environment-colour";
    outputType = "texture.runtime.rgba8-srgb/1";
    parameters = { variants: exported.variants };
  } else if (manifest.schema === "fgpm.demo.slow-colour/1") {
    validateColour(exported.colour);
    requireCondition(Number.isInteger(exported.delayMs) && exported.delayMs >= 50 && exported.delayMs <= 2000,
      "A slow-colour fixture delay must be an integer from 50 to 2000 milliseconds.");
    action = "materialize-slow-colour";
    outputType = "texture.runtime.rgba8-srgb/1";
    parameters = { colour: exported.colour, delayMs: exported.delayMs };
  } else if (manifest.schema === "fgpm.demo.transaction-fail/1") {
    validateColour(exported.colour);
    action = "fail-after-write";
    outputType = "texture.runtime.rgba8-srgb/1";
    parameters = { colour: exported.colour };
  } else {
    throw Object.assign(new Error("The texture toolchain was asked to analyze an unsupported domain schema."), {
      code: "FGPM_DOMAIN_MANIFEST_UNSUPPORTED",
      details: { schema: manifest.schema },
    });
  }
  response({
    protocol: "fgpm.handler-response/1",
    ok: true,
    analysis: {
      exports: [{ id: exported.id, semanticType: exported.semanticType, payload: { sourceKind: manifest.schema } }],
      hooks: [],
      activations: [],
      productions: [{
        id: `action:${exported.id}/source`,
        source: exported.id,
        action,
        output: {
          id: `artifact:${exported.id}/source`,
          type: outputType,
          fileName: "texture.bin"
        },
        parameters,
      }],
    },
  });
}

async function materialize(request) {
  const kind = request.proposal.kind;
  const parameters = request.proposal.parameters;
  const output = request.transaction.outputs[0];
  let content;
  if (kind === "materialize-texture-file") {
    const source = path.resolve(request.proposal.context.packageDirectory, parameters.file);
    const colour = parsePpm(await readFile(source, "utf8"));
    content = Buffer.from([...colour, 255]);
  } else if (kind === "materialize-solid-colour") {
    validateColour(parameters.colour);
    content = Buffer.from(parameters.colour);
  } else if (kind === "materialize-environment-colour") {
    const variant = request.environment?.values?.["target.colourVariant"];
    const colour = parameters.variants[variant];
    validateColour(colour);
    content = Buffer.from([...colour, 255]);
  } else if (kind === "materialize-slow-colour") {
    await new Promise((resolve) => setTimeout(resolve, parameters.delayMs));
    validateColour(parameters.colour);
    content = Buffer.from([...parameters.colour, 255]);
  } else if (kind === "fail-after-write") {
    await writeFile(path.join(request.transaction.stagingDirectory, output.relativePath), "partial", "utf8");
    fail("FGPM_HANDLER_MATERIALIZATION_FAILED", "The failure fixture stopped after writing an uncommitted output.", {
      transaction: request.transaction.id,
    });
    return;
  } else {
    fail("FGPM_HANDLER_ACTION_UNSUPPORTED", "Unsupported texture materialization action.", { kind });
    return;
  }
  await writeFile(path.join(request.transaction.stagingDirectory, output.relativePath), content);
  response({
    protocol: "fgpm.handler-response/1",
    ok: true,
    output: {
      type: output.type,
      relativePath: output.relativePath,
      size: content.length,
      hash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      inputs: [],
    },
  });
}

try {
  const request = await readRequest();
  requireCondition(request.protocol === "fgpm.handler-request/1", "Unsupported handler request protocol.");
  if (request.action === "analyze") await analyze(request);
  else if (request.action === "materialize") await materialize(request);
  else fail("FGPM_HANDLER_ACTION_UNSUPPORTED", "Unsupported handler action.", { action: request.action });
} catch (error) {
  fail(error.code ?? "FGPM_HANDLER_INTERNAL", error.message, error.details ?? {});
}
