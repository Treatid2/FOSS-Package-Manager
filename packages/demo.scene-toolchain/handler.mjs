// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, writeFile } from "node:fs/promises";
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
      analysis: { exports: [], hooks: [], activations: [manifest.activation], productions: [] },
    });
    return;
  }

  const exported = manifest.export;
  requireCondition(exported && typeof exported.id === "string" && typeof exported.semanticType === "string",
    "A scene-domain manifest must declare one typed export.");
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
        semanticRelation: hook.semanticRelation,
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
      throw Object.assign(new Error("The scene toolchain was asked to analyze an unsupported domain schema."), {
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
      productions: [],
    },
  });
}

function addVectors(left, right) {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

function plan(request) {
  const exportsById = new Map();
  for (const analysis of request.analyses) {
    requireCondition(analysis.handler === process.env.FPM_HANDLER_ID,
      "The scene planner received normalized analysis owned by another handler.", { handler: analysis.handler });
    for (const exported of analysis.exports) {
      exportsById.set(exported.id, {
        ...exported,
        source: { package: analysis.package, contribution: analysis.contribution, handler: analysis.handler },
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

  const inputs = [];
  const objects = [];
  for (const instance of world.payload.instances) {
    const assembly = exportsById.get(instance.definition);
    requireCondition(assembly?.semanticType === "visual.assembly/1",
      "A worldspace instance definition is missing or incompatible.", {
        instance: instance.id,
        definition: instance.definition,
      });
    for (const part of assembly.payload.parts) {
      const mesh = exportsById.get(part.mesh);
      const binding = bindings.get(part.textureHook);
      requireCondition(mesh?.semanticType === "mesh.box/1", "An assembly part mesh is missing or incompatible.", {
        instance: instance.id,
        part: part.id,
        mesh: part.mesh,
      });
      requireCondition(binding?.semanticType === "texture.runtime.rgba8-srgb/1",
        "An assembly part texture binding does not request the runtime texture artifact type.", {
          instance: instance.id,
          part: part.id,
          hook: part.textureHook,
        });
      const inputName = `texture:${instance.id}/${part.id}`;
      inputs.push({
        name: inputName,
        bindingTarget: binding.target,
        semanticRelation: binding.semanticRelation,
        sourceExport: binding.selected,
        type: binding.semanticType,
      });
      objects.push({
        id: `${instance.id}/${part.id}`,
        instance: instance.id,
        definition: instance.definition,
        part: part.id,
        primitive: mesh.payload.shape,
        size: mesh.payload.size,
        position: addVectors(instance.translation, part.translation),
        textureInput: inputName,
        sources: { assembly: assembly.source, mesh: mesh.source, textureBinding: binding },
      });
    }
  }
  objects.sort((a, b) => a.id.localeCompare(b.id));
  inputs.sort((a, b) => a.name.localeCompare(b.name));
  response({
    protocol: "fpm.handler-response/1",
    ok: true,
    plan: {
      id: `action:profile/${request.profile.name}/render-bundle`,
      action: "build-render-bundle",
      inputs,
      output: {
        id: `artifact:profile/${request.profile.name}/render-bundle`,
        type: "fpm.render-bundle/1",
        kind: "tree",
        fileName: "scene-bundle",
        entry: "scene.json"
      },
      parameters: {
        profile: request.profile.name,
        entryPoint: request.entryPoint,
        camera: camera.payload,
        objects,
      },
    },
  });
}

async function materialize(request) {
  requireCondition(request.proposal.kind === "build-render-bundle", "Unsupported scene materialization action.", {
    kind: request.proposal.kind,
  });
  const inputs = new Map(request.inputs.map((input) => [input.name, input]));
  const objects = [];
  for (const planned of request.proposal.parameters.objects) {
    const input = inputs.get(planned.textureInput);
    requireCondition(input?.type === "texture.runtime.rgba8-srgb/1",
      "The scene action did not receive one of its declared runtime texture inputs.", {
        input: planned.textureInput,
      });
    const texture = await readFile(input.path);
    requireCondition(texture.length === 4,
    "A runtime texture artifact is malformed.", { input: planned.textureInput });
    const { textureInput, ...object } = planned;
    objects.push({ ...object, colour: [...texture.subarray(0, 3)] });
  }
  const content = {
    schema: "fpm.render-scene/1",
    profile: request.proposal.parameters.profile,
    entryPoint: request.proposal.parameters.entryPoint,
    camera: request.proposal.parameters.camera,
    objects,
  };
  const output = request.transaction.outputs[0];
  requireCondition(output.kind === "tree", "The render bundle requires a tree output slot.");
  const treeDirectory = path.join(request.transaction.stagingDirectory, output.relativePath);
  await mkdir(treeDirectory, { recursive: true });
  const text = stableJson(content);
  const indexText = stableJson({
    schema: "fpm.render-bundle-index/1",
    scene: "scene.json",
    objects: objects.map((object) => ({ id: object.id, texture: object.sources.textureBinding.selected })),
  });
  await writeFile(path.join(treeDirectory, "scene.json"), text, "utf8");
  await writeFile(path.join(treeDirectory, "asset-index.json"), indexText, "utf8");
  response({
    protocol: "fpm.handler-response/1",
    ok: true,
    outputs: [{
      name: output.name,
      kind: "tree",
      type: output.type,
      relativePath: output.relativePath,
      inputs: request.inputs.map((input) => ({ name: input.name, hash: input.hash })),
    }],
  });
}

try {
  const request = await readRequest();
  requireCondition(request.protocol === "fpm.handler-request/1", "Unsupported handler request protocol.");
  if (request.action === "analyze") await analyze(request);
  else if (request.action === "plan") plan(request);
  else if (request.action === "materialize") await materialize(request);
  else fail("FPM_HANDLER_ACTION_UNSUPPORTED", "Unsupported handler action.", { action: request.action });
} catch (error) {
  fail(error.code ?? "FPM_HANDLER_INTERNAL", error.message, error.details ?? {});
}
