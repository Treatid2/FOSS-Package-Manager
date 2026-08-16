// SPDX-License-Identifier: MPL-2.0

import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ArtifactStore, executeArtifactGraph } from "./artifacts.mjs";
import { discoverPackages } from "./discovery.mjs";
import { FpmError, invariant } from "./errors.mjs";
import { invokeHandler } from "./handler.mjs";
import { hashDirectory, hashFile, sha256, writeJson } from "./io.mjs";
import { loadProfile } from "./profile.mjs";
import { resolvePackages } from "./resolver.mjs";

const PUBLIC_ID = /^pkg:[a-z0-9][a-z0-9.-]*\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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

function collectRelations(resolution) {
  const relations = new Map();
  for (const owner of resolution.ordered) {
    for (const declaration of owner.semanticRelations ?? []) {
      invariant(!relations.has(declaration.id), "FPM_SEMANTIC_RELATION_DUPLICATE",
        "Two selected packages govern the same semantic relation identity.", {
          relation: declaration.id,
          packages: [relations.get(declaration.id)?.owner.id, owner.id],
        });
      relations.set(declaration.id, { ...declaration, owner });
    }
  }
  return relations;
}

function collectAdapters(handlers, relations) {
  const adapters = [];
  const ids = new Map();
  for (const handler of handlers.values()) {
    for (const declaration of handler.adapts ?? []) {
      invariant(!ids.has(declaration.id), "FPM_ADAPTER_ID_DUPLICATE",
        "Two selected handlers declare the same adapter identity.", {
          adapter: declaration.id,
          handlers: [ids.get(declaration.id), handler.id],
        });
      ids.set(declaration.id, handler.id);
      const relation = relations.get(declaration.relation);
      invariant(relation, "FPM_SEMANTIC_RELATION_MISSING",
        "An adapter implements a semantic relation that is not governed by the selected package graph.", {
          adapter: declaration.id,
          relation: declaration.relation,
        });
      invariant(relation.source === declaration.from && relation.target === declaration.to,
        "FPM_SEMANTIC_RELATION_MISMATCH",
        "An adapter's source and target types do not match its governed semantic relation.", {
          adapter: declaration.id,
          relation: declaration.relation,
          declared: { from: declaration.from, to: declaration.to },
          governed: { from: relation.source, to: relation.target },
        });
      adapters.push({ ...declaration, relationDeclaration: relation, handler });
    }
  }
  return adapters.sort((a, b) => a.id.localeCompare(b.id));
}

function collectValidators(handlers) {
  const validators = [];
  const ids = new Map();
  for (const handler of handlers.values()) {
    for (const declaration of handler.validates ?? []) {
      invariant(!ids.has(declaration.id), "FPM_VALIDATOR_ID_DUPLICATE",
        "Two selected handlers declare the same validator identity.", {
          validator: declaration.id,
          handlers: [ids.get(declaration.id), handler.id],
        });
      ids.set(declaration.id, handler.id);
      validators.push({ ...declaration, handler });
    }
  }
  return validators.sort((left, right) => left.id.localeCompare(right.id));
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
    "Several selected handlers accept a contribution manifest type; policy must select one.", {
      manifestType,
      candidates: candidates.map((handler) => handler.id).sort(),
    });
  return candidates[0];
}

function validateAnalysis(analysis, pkg, contribution, handler) {
  invariant(analysis && typeof analysis === "object", "FPM_HANDLER_RESPONSE_INVALID",
    "A handler response omitted its analysis.", { handler: handler.id, contribution: contribution.id });
  for (const field of ["exports", "hooks", "activations", "productions"]) {
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
  for (const hook of analysis.hooks ?? []) {
    invariant(hook.semanticRelation === undefined || (typeof hook.semanticRelation === "string"
      && hook.semanticRelation.startsWith("relation:")), "FPM_HANDLER_RESPONSE_INVALID",
    "A handler-reported hook semantic relation is malformed.", { publicId: hook.id });
  }
  const exportIds = new Set((analysis.exports ?? []).map((entry) => entry.id));
  for (const production of analysis.productions ?? []) {
    invariant(typeof production?.id === "string" && exportIds.has(production.source)
      && typeof production.action === "string" && typeof production.output?.id === "string"
      && typeof production.output.type === "string" && typeof production.output.fileName === "string",
    "FPM_HANDLER_RESPONSE_INVALID", "A handler-reported artifact production is malformed.", {
      handler: handler.id,
      contribution: contribution.id,
      production,
    });
  }
}

function selectArtifactRoute(exported, requiredType, adapters, profile, target, relationIdentity = null) {
  const productions = exported.productions ?? [];
  const direct = productions.filter((production) => production.output.type === requiredType);
  invariant(direct.length <= 1, "FPM_ARTIFACT_ROUTE_AMBIGUOUS",
    "An export has several direct productions for one required artifact type.", {
      export: exported.id,
      requiredType,
      productions: direct.map((entry) => entry.id),
    });
  if (direct.length === 1) {
    return {
      kind: "direct-production",
      sourceSemanticType: exported.semanticType,
      sourceAction: direct[0].id,
      sourceArtifact: direct[0].output.id,
      producedType: direct[0].output.type,
      requiredType,
      semanticRelation: relationIdentity,
      adapter: null,
      adapterAction: null,
    };
  }

  let candidates = productions.flatMap((production) => adapters
    .filter((adapter) => adapter.from === production.output.type && adapter.to === requiredType
      && adapter.relation === relationIdentity)
    .map((adapter) => ({ production, adapter })));
  const explicit = profile.adapterSelections[target]
    ?? (relationIdentity ? profile.adapterSelections[relationIdentity] : null);
  if (explicit) candidates = candidates.filter(({ adapter }) => adapter.id === explicit);

  invariant(candidates.length > 0, "FPM_ARTIFACT_ROUTE_MISSING",
    "No direct artifact production or selected one-step adapter satisfies a required semantic type.", {
      target,
      export: exported.id,
      sourceSemanticType: exported.semanticType,
      producedTypes: productions.map((entry) => entry.output.type).sort(),
      requiredSemanticType: requiredType,
      semanticRelation: relationIdentity,
      selectedAdapter: explicit ?? null,
    });
  invariant(candidates.length === 1, "FPM_ADAPTER_AMBIGUOUS",
    "Several one-step adapters satisfy an artifact requirement; policy must select one.", {
      target,
      export: exported.id,
      requiredSemanticType: requiredType,
      semanticRelation: relationIdentity,
      candidates: candidates.map(({ adapter }) => adapter.id).sort(),
    });

  const { production, adapter } = candidates[0];
  const suffix = sha256(`${production.output.id}\0${adapter.id}\0${requiredType}`).slice(0, 16);
  return {
    kind: "one-step-adapter",
    sourceSemanticType: exported.semanticType,
    sourceAction: production.id,
    sourceArtifact: production.output.id,
    producedType: production.output.type,
    requiredType,
    adapter: adapter.id,
    semanticRelation: adapter.relation,
    adapterHandler: adapter.handler.id,
    adapterConversion: adapter.conversion,
    adapterAction: `action:${adapter.id}/${suffix}`,
    adaptedArtifact: `artifact:${adapter.id}/${suffix}`,
  };
}

function resolveBindings(resolution, profile, exportsById, hooksById, adapters, relations) {
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
    if (hook.semanticRelation) {
      const relation = relations.get(hook.semanticRelation);
      invariant(relation, "FPM_SEMANTIC_RELATION_MISSING",
        "A public hook references an ungoverned semantic relation.", {
          target: hook.id,
          relation: hook.semanticRelation,
        });
      invariant(relation.target === hook.semanticType, "FPM_SEMANTIC_RELATION_MISMATCH",
        "A hook's required type does not match its governed semantic relation target.", {
          target: hook.id,
          relation: hook.semanticRelation,
          requiredType: hook.semanticType,
          relationTarget: relation.target,
        });
    }
    const defaultExport = exportsById.get(hook.default);
    invariant(defaultExport, "FPM_HOOK_DEFAULT_MISSING", "A public hook's default export does not exist.", {
      target: hook.id,
      default: hook.default,
    });
    const defaultRoute = selectArtifactRoute(
      defaultExport, hook.semanticType, adapters, profile, hook.id, hook.semanticRelation ?? null,
    );
    const candidates = candidatesByTarget.get(hook.id) ?? [];
    const candidateRoutes = new Map();
    for (const candidate of candidates) {
      const provided = exportsById.get(candidate.with);
      invariant(provided, "FPM_REPLACEMENT_EXPORT_MISSING", "A replacement refers to an export that does not exist.", {
        target: hook.id,
        providedBy: candidate.with,
        package: candidate.package,
      });
      candidateRoutes.set(candidate.with, selectArtifactRoute(
        provided, hook.semanticType, adapters, profile, hook.id, hook.semanticRelation ?? null,
      ));
    }

    const explicit = profile.replacements[hook.id];
    let selected;
    let reason;
    let route;
    if (explicit) {
      selected = candidates.find((candidate) => candidate.with === explicit);
      invariant(selected, "FPM_REPLACEMENT_SELECTION_INVALID",
        "The user layer selects a replacement that no selected package proposes.", {
          target: hook.id,
          selection: explicit,
          candidates: candidates.map((candidate) => candidate.with),
        });
      reason = "user-selection";
      route = candidateRoutes.get(selected.with);
    } else if (candidates.length === 0) {
      selected = { with: hook.default, package: defaultExport.package };
      reason = "hook-default";
      route = defaultRoute;
    } else {
      invariant(candidates.length === 1, "FPM_REPLACEMENT_AMBIGUOUS",
        "Several compatible replacements target one public hook; the user layer must select one.", {
          target: hook.id,
          candidates: candidates.map((candidate) => ({ export: candidate.with, package: candidate.package })),
        });
      [selected] = candidates;
      reason = "single-compatible-replacement";
      route = candidateRoutes.get(selected.with);
    }
    bindings.push({
      target: hook.id,
      semanticType: hook.semanticType,
      semanticRelation: hook.semanticRelation ?? null,
      default: hook.default,
      selected: selected.with,
      selectedPackage: selected.package,
      reason,
      artifactRoute: route,
    });
  }
  return bindings;
}

export async function prepareProfile(profilePath) {
  const profile = await loadProfile(profilePath);
  const packages = await discoverPackages(profile.resolvedPackageRoots);
  const resolution = resolvePackages(packages, profile);
  const handlers = collectHandlers(resolution);
  const relations = collectRelations(resolution);
  const adapters = collectAdapters(handlers, relations);
  const validators = collectValidators(handlers);
  const analyses = [];
  const exportsById = new Map();
  const hooksById = new Map();
  const activations = [];
  const publicOwners = new Map();
  const productionOwners = new Map();
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
      const productions = (analysis.productions ?? []).map((production) => ({
        ...production,
        package: pkg.id,
        packageDirectory: pkg.directory,
        packageContentHash: `sha256:${pkg.contentHash}`,
        contribution: contribution.id,
        handler: handler.id,
      }));
      const record = {
        package: pkg.id,
        packageVersion: pkg.version,
        packageContentHash: `sha256:${pkg.contentHash}`,
        contribution: contribution.id,
        manifestType: contribution.manifestType,
        handler: handler.id,
        exports: analysis.exports ?? [],
        hooks: analysis.hooks ?? [],
        activations: analysis.activations ?? [],
        productions,
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
        const enriched = {
          ...entry,
          package: pkg.id,
          contribution: contribution.id,
          handler: handler.id,
          productions: productions.filter((production) => production.source === entry.id),
        };
        if (record.exports.includes(entry)) exportsById.set(entry.id, enriched);
        else hooksById.set(entry.id, enriched);
      }
      for (const production of productions) {
        invariant(!productionOwners.has(production.id), "FPM_ACTION_ID_DUPLICATE",
          "Two selected contributions propose the same artifact action identity.", {
            action: production.id,
            first: productionOwners.get(production.id),
            second: { package: pkg.id, contribution: contribution.id },
          });
        productionOwners.set(production.id, { package: pkg.id, contribution: contribution.id });
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
  const bindings = resolveBindings(resolution, profile, exportsById, hooksById, adapters, relations);
  return {
    profile, packages, resolution, handlers, relations, adapters, validators, analyses, exportsById, hooksById,
    bindings, activations, usedHandlers,
  };
}

function productionAction(production) {
  return {
    id: production.id,
    kind: production.action,
    handler: production.handler,
    sourcePackageHashes: [production.packageContentHash],
    inputs: [],
    output: production.output,
    parameters: {
      source: production.source,
      contribution: production.contribution,
      ...(production.parameters ?? {}),
    },
    context: { packageDirectory: production.packageDirectory },
  };
}

function adapterAction(route, production, adapters) {
  const adapter = adapters.find((candidate) => candidate.id === route.adapter);
  invariant(adapter, "FPM_ADAPTER_MISSING", "A selected adapter is unavailable.", { adapter: route.adapter });
  return {
    id: route.adapterAction,
    kind: "adapt",
    handler: adapter.handler.id,
    adapter: adapter.id,
    inputs: [{ name: "source", artifact: production.output.id }],
    output: { id: route.adaptedArtifact, type: route.requiredType, fileName: production.output.fileName },
    parameters: {
      adapter: { id: adapter.id, from: adapter.from, to: adapter.to, conversion: adapter.conversion },
    },
  };
}

function addInputRoute(actionsById, exported, requiredType, route, adapters) {
  const production = exported.productions.find((candidate) => candidate.id === route.sourceAction);
  invariant(production, "FPM_ARTIFACT_ROUTE_INVALID", "An artifact route names an unavailable source production.", {
    export: exported.id,
    sourceAction: route.sourceAction,
  });
  actionsById.set(production.id, productionAction(production));
  if (route.adapter) {
    const action = adapterAction(route, production, adapters);
    actionsById.set(action.id, action);
    return action.output.id;
  }
  invariant(production.output.type === requiredType, "FPM_ARTIFACT_ROUTE_INVALID",
    "A direct artifact route does not satisfy its requested type.", { export: exported.id, requiredType });
  return production.output.id;
}

async function managerIdentity() {
  const sourceHash = await hashDirectory(path.join(projectRoot, "src"));
  const manifestHash = await hashFile(path.join(projectRoot, "manager.json"));
  return {
    id: "org.foss-package-manager.reference",
    version: "0.3.0",
    contentHash: `sha256:${sha256(`${sourceHash}\0${manifestHash}`)}`,
  };
}

async function runProposalValidation(validators, profile, plan, usedHandlers) {
  const applicable = validators.filter((validator) => validator.phase === "proposal"
    && validator.subjects.includes(plan.output.type));
  const findings = [];
  for (const validator of applicable) {
    usedHandlers.add(validator.handler.id);
    const response = invokeHandler(validator.handler, {
      protocol: "fpm.handler-request/1",
      action: "validate",
      phase: "proposal",
      validator: validator.id,
      subject: { id: plan.id, type: plan.output.type, proposal: plan },
    });
    invariant(Array.isArray(response.findings), "FPM_HANDLER_RESPONSE_INVALID",
      "A validator response omitted its findings array.", { validator: validator.id });
    for (const finding of response.findings) {
      invariant(typeof finding?.id === "string" && validator.rules.includes(finding.rule)
        && finding.phase === "proposal" && finding.subject === plan.id
        && ["pass", "fail", "warning", "unknown", "not-applicable"].includes(finding.verdict)
        && typeof finding.severity === "string", "FPM_HANDLER_RESPONSE_INVALID",
      "A validator returned a malformed or undeclared finding.", { validator: validator.id, finding });
      findings.push({
        ...finding,
        validator: validator.id,
        validatorPackage: validator.handler.owner.id,
        validatorImplementationHash: `sha256:${validator.handler.owner.contentHash}`,
      });
    }
  }
  findings.sort((left, right) => left.id.localeCompare(right.id));

  const policy = profile.validationPolicy;
  for (const required of policy.requiredValidators ?? []) {
    const declaration = validators.find((validator) => validator.id === required);
    invariant(declaration, "FPM_VALIDATOR_REQUIRED_MISSING",
      "Validation policy requires a validator that is not selected.", { policy: policy.id, validator: required });
    invariant(findings.some((finding) => finding.validator === required && finding.verdict === "pass"),
      "FPM_VALIDATOR_REQUIRED_NO_PASS", "A required validator did not produce a passing finding.", {
        policy: policy.id,
        validator: required,
        findings: findings.filter((finding) => finding.validator === required),
      });
  }

  const waived = [];
  const rejected = [];
  for (const finding of findings.filter((entry) => entry.verdict === "fail")) {
    const waiver = (policy.waivers ?? []).find((entry) => entry.validator === finding.validator
      && entry.rule === finding.rule && (entry.subject === undefined || entry.subject === finding.subject));
    if (waiver) waived.push({ finding: finding.id, waiver });
    else rejected.push(finding.id);
  }
  const decision = {
    schema: "fpm.validation-decision/1",
    policy: policy.id,
    subject: plan.id,
    phase: "proposal",
    consideredFindings: findings.map((finding) => finding.id),
    requiredValidators: [...(policy.requiredValidators ?? [])].sort(),
    waived,
    rejected,
    accepted: rejected.length === 0,
  };
  invariant(decision.accepted, "FPM_VALIDATION_REJECTED",
    "Validation policy rejected an action proposal after preserving all attributed findings.", {
      policy: policy.id,
      subject: plan.id,
      findings,
      decision,
    });
  return { findings, decision };
}

export async function buildProfile(profilePath, outputDirectory, options = {}) {
  const prepared = await prepareProfile(profilePath);
  const {
    profile, resolution, handlers, adapters, validators, analyses, bindings, activations, usedHandlers, exportsById,
  } = prepared;
  let builders = [...handlers.values()].filter((handler) => (handler.builds ?? []).includes(profile.artifact.type));
  const explicitBuilder = profile.artifact.builder;
  if (explicitBuilder) builders = builders.filter((handler) => handler.id === explicitBuilder);
  invariant(builders.length > 0, "FPM_ARTIFACT_BUILDER_MISSING", "No selected handler can build the requested artifact type.", {
    artifactType: profile.artifact.type,
    selectedBuilder: explicitBuilder ?? null,
  });
  invariant(builders.length === 1, "FPM_ARTIFACT_BUILDER_AMBIGUOUS",
    "Several handlers can build the requested artifact; distribution policy must select one.", {
      artifactType: profile.artifact.type,
      candidates: builders.map((handler) => handler.id),
    });
  const builder = builders[0];
  usedHandlers.add(builder.id);

  const response = invokeHandler(builder, {
    protocol: "fpm.handler-request/1",
    action: "plan",
    artifactType: profile.artifact.type,
    entryPoint: profile.entryPoint,
    profile: { name: profile.name, target: profile.layers.target },
    analyses: analyses.filter((analysis) => analysis.handler === builder.id),
    bindings,
  });
  const plan = response.plan;
  invariant(plan && typeof plan.id === "string" && typeof plan.action === "string"
    && Array.isArray(plan.inputs) && plan.output?.type === profile.artifact.type
    && typeof plan.output.id === "string" && typeof plan.output.fileName === "string",
  "FPM_HANDLER_RESPONSE_INVALID", "The artifact builder returned a malformed action plan.", { handler: builder.id });
  if (plan.output.kind === "tree") {
    invariant(typeof plan.output.entry === "string" && plan.output.entry.length > 0
      && !path.isAbsolute(plan.output.entry) && !plan.output.entry.startsWith(".."),
    "FPM_HANDLER_RESPONSE_INVALID", "A tree artifact plan must declare a safe entry path.", {
      handler: builder.id,
      output: plan.output,
    });
  }
  const validation = await runProposalValidation(validators, profile, plan, usedHandlers);

  const actionsById = new Map();
  const finalInputs = [];
  const finalInputNames = new Set();
  for (const input of plan.inputs) {
    invariant(typeof input?.name === "string" && typeof input.sourceExport === "string"
      && typeof input.type === "string", "FPM_HANDLER_RESPONSE_INVALID",
    "The artifact builder declared a malformed input requirement.", { handler: builder.id, input });
    invariant(!finalInputNames.has(input.name), "FPM_HANDLER_RESPONSE_INVALID",
      "The artifact builder declared the same input name more than once.", { handler: builder.id, input: input.name });
    finalInputNames.add(input.name);
    const exported = exportsById.get(input.sourceExport);
    invariant(exported, "FPM_ARTIFACT_INPUT_EXPORT_MISSING", "A planned artifact input names an unavailable export.", {
      action: plan.id,
      input: input.name,
      export: input.sourceExport,
    });
    const binding = bindings.find((entry) => entry.target === input.bindingTarget
      && entry.selected === input.sourceExport && entry.semanticType === input.type);
    const route = binding?.artifactRoute ?? selectArtifactRoute(
      exported, input.type, adapters, profile, input.name, input.semanticRelation ?? null,
    );
    const artifactId = addInputRoute(actionsById, exported, input.type, route, adapters);
    finalInputs.push({ name: input.name, artifact: artifactId });
  }
  actionsById.set(plan.id, {
    id: plan.id,
    kind: plan.action,
    handler: builder.id,
    inputs: finalInputs,
    output: plan.output,
    parameters: plan.parameters ?? {},
  });

  const manager = await managerIdentity();
  const environment = {
    build: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      target: profile.layers.target,
      protocol: "fpm.artifact-transaction/2",
    },
    observational: { processSecurityBoundary: "handler-declared" },
  };
  const environmentContext = {
    protocol: environment.build.protocol,
    facts: {
      runtime: { node: environment.build.node },
      host: { platform: environment.build.platform, architecture: environment.build.architecture },
      target: environment.build.target,
    },
    widenedDimensions: profile.environmentKeyWidening,
  };
  const out = path.resolve(outputDirectory);
  const storeDirectory = path.resolve(options.storeDirectory ?? path.join(path.dirname(out), ".fpm-store"));
  const store = new ArtifactStore(storeDirectory, environmentContext, options.storeOptions ?? {});
  const execution = await executeArtifactGraph([...actionsById.values()], handlers, store);
  const finalArtifact = execution.artifacts.get(plan.output.id);
  invariant(finalArtifact, "FPM_ARTIFACT_MISSING", "The completed action graph did not produce its requested artifact.", {
    artifact: plan.output.id,
  });

  const artifactRootPath = path.join(out, plan.output.fileName);
  try {
    const previous = JSON.parse(await readFile(path.join(out, "fpm.lock.json"), "utf8"));
    const previousName = previous.artifact?.file;
    if (typeof previousName === "string" && path.basename(previousName) === previousName
      && previousName !== plan.output.fileName) {
      await rm(path.join(out, previousName), { recursive: true, force: true });
    }
  } catch {
    // A missing or unreadable previous lockfile does not authorize broader output cleanup.
  }
  await store.exportArtifact(finalArtifact, artifactRootPath);
  const artifactPath = finalArtifact.kind === "tree"
    ? path.join(artifactRootPath, plan.output.entry)
    : artifactRootPath;
  const artifact = {
    type: plan.output.type,
    kind: finalArtifact.kind,
    fileName: plan.output.fileName,
    entry: plan.output.entry ?? null,
  };

  const packageLocks = resolution.ordered.map((pkg) => ({
    id: pkg.id,
    version: pkg.version,
    license: pkg.license,
    contentHash: `sha256:${pkg.contentHash}`,
    dependencies: [...(resolution.edges.get(pkg.id) ?? [])].sort(),
  })).sort((a, b) => a.id.localeCompare(b.id));
  const selectedHandlers = [...usedHandlers]
    .map((id) => handlers.get(id))
    .concat(execution.records.map((record) => handlers.get(record.handler)))
    .filter(Boolean)
    .filter((handler, index, entries) => entries.findIndex((entry) => entry.id === handler.id) === index)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((handler) => ({
      id: handler.id,
      package: handler.owner.id,
      packageContentHash: `sha256:${handler.owner.contentHash}`,
      execution: handler.execution,
      buildEnvironment: handler.buildEnvironment,
    }));
  const profileHash = `sha256:${await hashFile(profile.path)}`;
  const artifactRecords = execution.records.flatMap((record) => record.outputs.map((output) => ({
    ...output,
    producedBy: record.id,
  })));
  const lockfile = {
    schema: "fpm.lock/3",
    manager,
    profile: {
      schema: profile.schema,
      name: profile.name,
      hash: profileHash,
      layers: profile.layers,
      authority: profile.authority,
      entryPoint: profile.entryPoint,
      artifactType: profile.artifact.type,
    },
    environment,
    packages: packageLocks,
    handlers: selectedHandlers,
    semanticRelations: [...prepared.relations.values()].map((relation) => ({
      id: relation.id,
      version: relation.version,
      source: relation.source,
      target: relation.target,
      roles: relation.roles,
      stewardPackage: relation.owner.id,
      stewardPackageHash: `sha256:${relation.owner.contentHash}`,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    validation,
    bindings,
    actions: execution.records,
    artifacts: artifactRecords,
    artifact: {
      id: finalArtifact.id,
      type: finalArtifact.type,
      kind: finalArtifact.kind,
      file: plan.output.fileName,
      entry: plan.output.entry ?? null,
      hash: finalArtifact.hash,
      size: finalArtifact.size,
      totalSize: finalArtifact.totalSize,
    },
  };

  const provenance = {
    schema: "fpm.provenance/3",
    profile: profile.name,
    profileHash,
    exports: analyses.flatMap((analysis) => analysis.exports.map((entry) => ({
      id: entry.id,
      semanticType: entry.semanticType,
      package: analysis.package,
      contribution: analysis.contribution,
      handler: analysis.handler,
      productions: analysis.productions.filter((production) => production.source === entry.id)
        .map((production) => production.id),
    }))).sort((a, b) => a.id.localeCompare(b.id)),
    hooks: bindings,
    profileAuthority: profile.authority,
    validation,
    actions: execution.records,
    artifacts: artifactRecords,
    artifact: {
      id: finalArtifact.id,
      type: finalArtifact.type,
      kind: finalArtifact.kind,
      file: plan.output.fileName,
      entry: plan.output.entry ?? null,
      builder: builder.id,
      entryPoint: profile.entryPoint,
      sourceArtifacts: finalInputs.map((input) => input.artifact).sort(),
      hash: finalArtifact.hash,
    },
  };
  await writeJson(path.join(out, "fpm.lock.json"), lockfile);
  await writeJson(path.join(out, "provenance.json"), provenance);

  return {
    ...prepared,
    outputDirectory: out,
    storeDirectory,
    artifactPath,
    artifact,
    lockfile,
    provenance,
    activations,
    cache: { hits: execution.cacheHits, misses: execution.cacheMisses },
  };
}

export function explainProvenance(provenance, publicId) {
  const exported = provenance.exports.find((entry) => entry.id === publicId);
  const hook = provenance.hooks.find((entry) => entry.target === publicId);
  if (!exported && !hook && provenance.artifact.entryPoint !== publicId) {
    throw new FpmError("FPM_PROVENANCE_TARGET_MISSING", "No provenance entry matches the requested identity.", { publicId });
  }
  const actionIds = new Set(exported?.productions ?? []);
  if (hook?.artifactRoute?.sourceAction) actionIds.add(hook.artifactRoute.sourceAction);
  if (hook?.artifactRoute?.adapterAction) actionIds.add(hook.artifactRoute.adapterAction);
  actionIds.add(provenance.actions.at(-1)?.id);
  return {
    publicId,
    export: exported ?? null,
    hook: hook ?? null,
    isArtifactEntryPoint: provenance.artifact.entryPoint === publicId,
    actionPath: provenance.actions.filter((action) => actionIds.has(action.id)),
    artifact: provenance.artifact,
  };
}
