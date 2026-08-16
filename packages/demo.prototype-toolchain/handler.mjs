// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";

function response(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(code, message, details = {}) {
  response({
    protocol: "fpm.handler-response/1",
    ok: false,
    diagnostic: { code, message, details },
  });
}

function requireCondition(condition, message, details = {}) {
  if (!condition) {
    const error = new Error(message);
    error.code = "FPM_DOMAIN_MANIFEST_INVALID";
    error.details = details;
    throw error;
  }
}

async function readRequest() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return JSON.parse(input);
}

function validateVector(value, length, field) {
  requireCondition(Array.isArray(value) && value.length === length && value.every(Number.isFinite),
    `${field} must contain ${length} finite numbers.`, { field, value });
}

async function analyze(request) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(request.contribution.manifestPath, "utf8"));
  } catch (error) {
    fail("FPM_DOMAIN_MANIFEST_MALFORMED", "A domain manifest could not be parsed.", {
      contribution: request.contribution.id,
      path: request.contribution.manifestPath,
      cause: error.message,
    });
    return;
  }

  requireCondition(manifest.schema === request.contribution.manifestType,
    "The domain manifest schema does not match its declared manifest type.", {
      declared: request.contribution.manifestType,
      actual: manifest.schema,
    });

  if (manifest.schema === "fpm.demo.fail/1") {
    fail("FPM_HANDLER_ANALYSIS_FAILED", manifest.message ?? "The failure fixture requested a handler failure.", {
      contribution: request.contribution.id,
    });
    return;
  }

  if (manifest.schema === "fpm.demo.runtime/1") {
    requireCondition(typeof manifest.activation?.id === "string"
      && Array.isArray(manifest.activation.accepts)
      && Array.isArray(manifest.activation.command), "Runtime activation declaration is malformed.");
    response({
      protocol: "fpm.handler-response/1",
      ok: true,
      analysis: { exports: [], hooks: [], activations: [manifest.activation] },
    });
    return;
  }

  const exported = manifest.export;
  requireCondition(exported && typeof exported.id === "string" && typeof exported.semanticType === "string",
    "A demo domain manifest must declare one typed export.");
  let payload;
  let hooks = [];

  switch (manifest.schema) {
    case "fpm.demo.mesh/1":
      requireCondition(exported.shape === "box", "The prototype mesh handler only accepts box primitives.", {
        shape: exported.shape,
      });
      validateVector(exported.size, 3, "export.size");
      payload = { shape: exported.shape, size: exported.size };
      break;
    case "fpm.demo.texture/1":
      validateVector(exported.colour, 3, "export.colour");
      requireCondition(exported.colour.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255),
        "Texture colour channels must be integers from 0 to 255.");
      payload = { colour: exported.colour };
      break;
    case "fpm.demo.visual-assembly/1":
      requireCondition(Array.isArray(exported.parts) && exported.parts.length > 0,
        "A visual assembly must contain at least one part.");
      for (const part of exported.parts) {
        requireCondition(typeof part.id === "string" && typeof part.mesh === "string"
          && typeof part.textureHook === "string", "A visual assembly part is malformed.", { part });
        validateVector(part.translation, 3, `part.${part.id}.translation`);
      }
      requireCondition(Array.isArray(exported.hooks), "A visual assembly must declare its hooks array.");
      hooks = exported.hooks.map((hook) => ({
        id: hook.id,
        semanticType: hook.semanticType,
        default: hook.default,
      }));
      payload = { parts: exported.parts };
      break;
    case "fpm.demo.camera/1":
      validateVector(exported.position, 3, "export.position");
      validateVector(exported.target, 3, "export.target");
      requireCondition(Number.isFinite(exported.fieldOfViewDegrees), "Camera field of view must be numeric.");
      payload = {
        position: exported.position,
        target: exported.target,
        fieldOfViewDegrees: exported.fieldOfViewDegrees,
      };
      break;
    case "fpm.demo.worldspace/1":
      requireCondition(Array.isArray(exported.instances) && typeof exported.camera === "string",
        "A worldspace must declare instances and a camera.");
      for (const instance of exported.instances) {
        requireCondition(typeof instance.id === "string" && typeof instance.definition === "string",
          "A worldspace instance is malformed.", { instance });
        validateVector(instance.translation, 3, `instance.${instance.id}.translation`);
      }
      payload = { instances: exported.instances, camera: exported.camera };
      break;
    default:
      throw Object.assign(new Error("The toolchain was asked to analyze an unsupported domain schema."), {
        code: "FPM_DOMAIN_MANIFEST_UNSUPPORTED",
        details: { schema: manifest.schema },
      });
  }

  response({
    protocol: "fpm.handler-response/1",
    ok: true,
    analysis: {
      exports: [{ id: exported.id, semanticType: exported.semanticType, payload }],
      hooks,
      activations: [],
    },
  });
}

function addVectors(left, right) {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

function build(request) {
  const exportsById = new Map();
  for (const analysis of request.analyses) {
    for (const exported of analysis.exports) {
      exportsById.set(exported.id, {
        ...exported,
        source: {
          package: analysis.package,
          contribution: analysis.contribution,
          handler: analysis.handler,
        },
      });
    }
  }
  const bindings = new Map(request.bindings.map((binding) => [binding.target, binding]));
  const world = exportsById.get(request.entryPoint);
  requireCondition(world?.semanticType === "worldspace.scene/1", "The build entry point is not a demo worldspace.", {
    entryPoint: request.entryPoint,
    semanticType: world?.semanticType,
  });
  const camera = exportsById.get(world.payload.camera);
  requireCondition(camera?.semanticType === "camera.perspective/1", "The worldspace camera is missing or incompatible.", {
    camera: world.payload.camera,
  });

  const objects = [];
  for (const instance of world.payload.instances) {
    const assembly = exportsById.get(instance.definition);
    requireCondition(assembly?.semanticType === "visual.assembly/1", "A worldspace instance definition is missing or incompatible.", {
      instance: instance.id,
      definition: instance.definition,
    });
    for (const part of assembly.payload.parts) {
      const mesh = exportsById.get(part.mesh);
      const binding = bindings.get(part.textureHook);
      const texture = exportsById.get(binding?.selected);
      requireCondition(mesh?.semanticType === "mesh.box/1", "An assembly part mesh is missing or incompatible.", {
        instance: instance.id,
        part: part.id,
        mesh: part.mesh,
      });
      requireCondition(texture?.semanticType === "texture.base-colour-srgb/1",
        "An assembly part texture binding is missing or incompatible.", {
          instance: instance.id,
          part: part.id,
          hook: part.textureHook,
          selected: binding?.selected,
        });
      objects.push({
        id: `${instance.id}/${part.id}`,
        instance: instance.id,
        definition: instance.definition,
        part: part.id,
        primitive: mesh.payload.shape,
        size: mesh.payload.size,
        position: addVectors(instance.translation, part.translation),
        colour: texture.payload.colour,
        sources: {
          assembly: assembly.source,
          mesh: mesh.source,
          texture: texture.source,
          textureBinding: binding,
        },
      });
    }
  }
  objects.sort((a, b) => a.id.localeCompare(b.id));
  const content = {
    schema: "fpm.render-scene/1",
    profile: request.profile.name,
    entryPoint: request.entryPoint,
    camera: camera.payload,
    objects,
  };
  response({
    protocol: "fpm.handler-response/1",
    ok: true,
    artifact: { type: "fpm.render-scene/1", fileName: "scene.json", content },
  });
}

try {
  const request = await readRequest();
  requireCondition(request.protocol === "fpm.handler-request/1", "Unsupported handler request protocol.");
  if (request.action === "analyze") await analyze(request);
  else if (request.action === "build") build(request);
  else fail("FPM_HANDLER_ACTION_UNSUPPORTED", "Unsupported handler action.", { action: request.action });
} catch (error) {
  fail(error.code ?? "FPM_HANDLER_INTERNAL", error.message, error.details ?? {});
}
