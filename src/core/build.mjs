// SPDX-License-Identifier: MPL-2.0

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { discoverPackages } from "./discovery.mjs";
import { FpmError, invariant } from "./errors.mjs";
import { invokeHandler } from "./handler.mjs";
import { sha256, stableJson, writeJson } from "./io.mjs";
import { loadProfile } from "./profile.mjs";
import { resolvePackages } from "./resolver.mjs";

const PUBLIC_ID = /^pkg:[a-z0-9][a-z0-9.-]*\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/;

function collectHandlers(resolution) {
  const byId = new Map();
  for (const owner of resolution.ordered) {
    for (const declaration of owner.handlers) {
      invariant(!byId.has(declaration.id), "FPM_HANDLER_ID_DUPLICATE",
        "Two selected packages declare the same handler identity.", {
          handler: declaration.id,
          packages: [byId.get(declaration.id)?.owner.id, owner.id],
        });
      byId.set(declaration.id, { ...declaration, owner });
    }
  }
  return byId;
}

function selectHandler(handlers, profile, manifestType) {
  let candidates = [...handlers.values()].filter((handler) => handler.handles.includes(manifestType));
  const explicit = profile.handlerSelections[manifestType];
  if (explicit) candidates = candidates.filter((handler) => handler.id === explicit);
  invariant(candidates.length > 0, "FPM_HANDLER_MISSING", "No selected handler accepts a contribution manifest type.", {
    manifestType,
    selectedHandler: explicit ?? null,
  });
  invariant(candidates.length === 1, "FPM_HANDLER_AMBIGUOUS",
    "Several selected handlers accept a contribution manifest type; the profile must select one.", {
      manifestType,
      candidates: candidates.map((handler) => handler.id).sort(),
    });
  return candidates[0];
}

function validateAnalysis(analysis, pkg, contribution, handler) {
  invariant(analysis && typeof analysis === "object", "FPM_HANDLER_RESPONSE_INVALID",
    "A handler response omitted its analysis.", { handler: handler.id, contribution: contribution.id });
  for (const field of ["exports", "hooks", "activations"]) {
    invariant(analysis[field] === undefined || Array.isArray(analysis[field]), "FPM_HANDLER_RESPONSE_INVALID",
      `Handler analysis field '${field}' must be an array.`, { handler: handler.id, contribution: contribution.id });
  }
  for (const entry of [...(analysis.exports ?? []), ...(analysis.hooks ?? [])]) {
    invariant(PUBLIC_ID.test(entry?.id ?? "") && entry.id.startsWith(`pkg:${pkg.id}/`),
      "FPM_HANDLER_RESPONSE_INVALID", "A handler reported a public identity not owned by the contribution package.", {
        handler: handler.id,
        package: pkg.id,
        publicId: entry?.id,
      });
    invariant(typeof entry.semanticType === "string", "FPM_HANDLER_RESPONSE_INVALID",
      "A handler-reported public entry omitted its semantic type.", { publicId: entry.id });
  }
}

function resolveBindings(resolution, profile, exportsById, hooksById) {
  const candidatesByTarget = new Map();
  for (const pkg of resolution.ordered) {
    for (const replacement of pkg.replacements) {
      const candidates = candidatesByTarget.get(replacement.target) ?? [];
      candidates.push({ ...replacement, package: pkg.id });
      candidatesByTarget.set(replacement.target, candidates);
    }
  }

  for (const target of candidatesByTarget.keys()) {
    invariant(hooksById.has(target), "FPM_REPLACEMENT_TARGET_MISSING",
      "A replacement targets a public hook that does not exist.", { target });
  }

  const bindings = [];
  for (const hook of [...hooksById.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const defaultExport = exportsById.get(hook.default);
    invariant(defaultExport, "FPM_HOOK_DEFAULT_MISSING", "A public hook's default export does not exist.", {
      target: hook.id,
      default: hook.default,
    });
    invariant(defaultExport.semanticType === hook.semanticType, "FPM_SEMANTIC_TYPE_INCOMPATIBLE",
      "A public hook default has an incompatible semantic type.", {
        target: hook.id,
        requiredSemanticType: hook.semanticType,
        providedSemanticType: defaultExport.semanticType,
        providedBy: hook.default,
      });

    const candidates = candidatesByTarget.get(hook.id) ?? [];
    for (const candidate of candidates) {
      const provided = exportsById.get(candidate.with);
      invariant(provided, "FPM_REPLACEMENT_EXPORT_MISSING", "A replacement refers to an export that does not exist.", {
        target: hook.id,
        providedBy: candidate.with,
        package: candidate.package,
      });
      invariant(provided.semanticType === hook.semanticType, "FPM_SEMANTIC_TYPE_INCOMPATIBLE",
        "A replacement export has an incompatible semantic type.", {
          target: hook.id,
          requiredSemanticType: hook.semanticType,
          providedSemanticType: provided.semanticType,
          providedBy: candidate.with,
          package: candidate.package,
        });
    }

    const explicit = profile.replacements[hook.id];
    let selected;
    let reason;
    if (explicit) {
      selected = candidates.find((candidate) => candidate.with === explicit);
      invariant(selected, "FPM_REPLACEMENT_SELECTION_INVALID",
        "The profile selects a replacement that no selected package proposes.", {
          target: hook.id,
          selection: explicit,
          candidates: candidates.map((candidate) => candidate.with),
        });
      reason = "profile-selection";
    } else if (candidates.length === 0) {
      selected = { with: hook.default, package: defaultExport.package };
      reason = "hook-default";
    } else {
      invariant(candidates.length === 1, "FPM_REPLACEMENT_AMBIGUOUS",
        "Several compatible replacements target one public hook; the profile must select one.", {
          target: hook.id,
          candidates: candidates.map((candidate) => ({ export: candidate.with, package: candidate.package })),
        });
      [selected] = candidates;
      reason = "single-compatible-replacement";
    }
    bindings.push({
      target: hook.id,
      semanticType: hook.semanticType,
      default: hook.default,
      selected: selected.with,
      selectedPackage: selected.package,
      reason,
    });
  }
  return bindings;
}

export async function prepareProfile(profilePath) {
  const profile = await loadProfile(profilePath);
  const packages = await discoverPackages(profile.resolvedPackageRoots);
  const resolution = resolvePackages(packages, profile);
  const handlers = collectHandlers(resolution);
  const analyses = [];
  const exportsById = new Map();
  const hooksById = new Map();
  const activations = [];
  const publicOwners = new Map();
  const usedHandlers = new Set();

  for (const pkg of resolution.ordered) {
    for (const contribution of [...pkg.contributions].sort((a, b) => a.id.localeCompare(b.id))) {
      const handler = selectHandler(handlers, profile, contribution.manifestType);
      usedHandlers.add(handler.id);
      const response = invokeHandler(handler, {
        protocol: "fpm.handler-request/1",
        action: "analyze",
        package: { id: pkg.id, version: pkg.version },
        contribution: {
          id: contribution.id,
          manifestType: contribution.manifestType,
          manifestPath: path.resolve(pkg.directory, contribution.manifest),
        },
      });
      const analysis = response.analysis;
      validateAnalysis(analysis, pkg, contribution, handler);
      const record = {
        package: pkg.id,
        packageVersion: pkg.version,
        contribution: contribution.id,
        manifestType: contribution.manifestType,
        handler: handler.id,
        exports: analysis.exports ?? [],
        hooks: analysis.hooks ?? [],
        activations: analysis.activations ?? [],
      };
      analyses.push(record);

      for (const entry of [...record.exports, ...record.hooks]) {
        invariant(!publicOwners.has(entry.id), "FPM_PUBLIC_ID_DUPLICATE",
          "Two selected contributions claim the same public identity.", {
            publicId: entry.id,
            first: publicOwners.get(entry.id),
            second: { package: pkg.id, contribution: contribution.id },
          });
        publicOwners.set(entry.id, { package: pkg.id, contribution: contribution.id });
        const enriched = { ...entry, package: pkg.id, contribution: contribution.id, handler: handler.id };
        if (record.exports.includes(entry)) exportsById.set(entry.id, enriched);
        else hooksById.set(entry.id, enriched);
      }
      for (const activation of record.activations) {
        invariant(typeof activation?.id === "string" && Array.isArray(activation.accepts)
          && Array.isArray(activation.command), "FPM_HANDLER_RESPONSE_INVALID",
        "A handler-reported activation is malformed.", { handler: handler.id, activation });
        activations.push({ ...activation, package: pkg.id, owner: pkg });
      }
    }
  }

  invariant(exportsById.has(profile.entryPoint), "FPM_ENTRY_POINT_MISSING",
    "The profile entry point was not exported by the selected graph.", { entryPoint: profile.entryPoint });
  const bindings = resolveBindings(resolution, profile, exportsById, hooksById);
  return { profile, packages, resolution, handlers, analyses, exportsById, hooksById, bindings, activations, usedHandlers };
}

export async function buildProfile(profilePath, outputDirectory) {
  const prepared = await prepareProfile(profilePath);
  const { profile, resolution, handlers, analyses, bindings, activations, usedHandlers } = prepared;
  let builders = [...handlers.values()].filter((handler) => (handler.builds ?? []).includes(profile.artifact.type));
  const explicitBuilder = profile.artifact.builder;
  if (explicitBuilder) builders = builders.filter((handler) => handler.id === explicitBuilder);
  invariant(builders.length > 0, "FPM_ARTIFACT_BUILDER_MISSING", "No selected handler can build the requested artifact type.", {
    artifactType: profile.artifact.type,
    selectedBuilder: explicitBuilder ?? null,
  });
  invariant(builders.length === 1, "FPM_ARTIFACT_BUILDER_AMBIGUOUS",
    "Several handlers can build the requested artifact; the profile must select one.", {
      artifactType: profile.artifact.type,
      candidates: builders.map((handler) => handler.id),
    });
  const builder = builders[0];
  usedHandlers.add(builder.id);
  const response = invokeHandler(builder, {
    protocol: "fpm.handler-request/1",
    action: "build",
    artifactType: profile.artifact.type,
    entryPoint: profile.entryPoint,
    profile: { name: profile.name },
    analyses,
    bindings,
  });
  const artifact = response.artifact;
  invariant(artifact?.type === profile.artifact.type && typeof artifact.fileName === "string"
    && artifact.content && typeof artifact.content === "object", "FPM_HANDLER_RESPONSE_INVALID",
  "The artifact builder returned a malformed artifact.", { handler: builder.id });
  invariant(path.basename(artifact.fileName) === artifact.fileName, "FPM_ARTIFACT_PATH_INVALID",
    "An artifact builder attempted to write outside the output directory.", { fileName: artifact.fileName });

  const out = path.resolve(outputDirectory);
  await mkdir(out, { recursive: true });
  const artifactText = stableJson(artifact.content);
  const artifactPath = path.join(out, artifact.fileName);
  await writeFile(artifactPath, artifactText, "utf8");

  const packageLocks = resolution.ordered
    .map((pkg) => ({
      id: pkg.id,
      version: pkg.version,
      license: pkg.license,
      contentHash: `sha256:${pkg.contentHash}`,
      dependencies: [...(resolution.edges.get(pkg.id) ?? [])].sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const lockfile = {
    schema: "fpm.lock/1",
    manager: { id: "org.foss-package-manager.reference", version: "0.1.0" },
    profile: { name: profile.name, entryPoint: profile.entryPoint, artifactType: profile.artifact.type },
    packages: packageLocks,
    handlers: [...usedHandlers].sort(),
    bindings,
    artifact: { type: artifact.type, file: artifact.fileName, hash: `sha256:${sha256(artifactText)}` },
  };

  const provenance = {
    schema: "fpm.provenance/1",
    profile: profile.name,
    exports: analyses.flatMap((analysis) => analysis.exports.map((entry) => ({
      id: entry.id,
      semanticType: entry.semanticType,
      package: analysis.package,
      contribution: analysis.contribution,
      handler: analysis.handler,
    }))).sort((a, b) => a.id.localeCompare(b.id)),
    hooks: bindings,
    artifact: {
      type: artifact.type,
      file: artifact.fileName,
      builder: builder.id,
      entryPoint: profile.entryPoint,
      sourceExports: analyses.flatMap((analysis) => analysis.exports.map((entry) => entry.id)).sort(),
    },
  };
  await writeJson(path.join(out, "fpm.lock.json"), lockfile);
  await writeJson(path.join(out, "provenance.json"), provenance);

  return { ...prepared, outputDirectory: out, artifactPath, artifact, lockfile, provenance, activations };
}

export function explainProvenance(provenance, publicId) {
  const exported = provenance.exports.find((entry) => entry.id === publicId);
  const hook = provenance.hooks.find((entry) => entry.target === publicId);
  if (!exported && !hook && provenance.artifact.entryPoint !== publicId) {
    throw new FpmError("FPM_PROVENANCE_TARGET_MISSING", "No provenance entry matches the requested identity.", { publicId });
  }
  return {
    publicId,
    export: exported ?? null,
    hook: hook ?? null,
    isArtifactEntryPoint: provenance.artifact.entryPoint === publicId,
    artifact: provenance.artifact,
  };
}
