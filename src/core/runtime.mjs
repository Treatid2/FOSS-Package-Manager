// SPDX-License-Identifier: MPL-2.0

import { rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ArtifactStore } from "./artifacts.mjs";
import { FgpmError, invariant } from "./errors.mjs";
import { resolveInside, sha256, stableJson, writeJson } from "./io.mjs";
import { satisfies } from "./semver.mjs";

function immutable(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

const HOST_GRANTS = Object.freeze({
  "fgpm.host.renderer-output/1": Object.freeze({ classification: "observational" }),
  "fgpm.host.runtime-interaction/1": Object.freeze({ classification: "observational" }),
  "fgpm.host.persistence-input/1": Object.freeze({ classification: "deterministic" }),
  "fgpm.host.persistence-records/1": Object.freeze({ classification: "observational" }),
  "fgpm.host.persistence-conformance/1": Object.freeze({ classification: "conformance" }),
  "fgpm.host.scheduler-records/1": Object.freeze({ classification: "observational" }),
  "fgpm.host.scheduler-conformance/1": Object.freeze({ classification: "conformance" }),
});

function publicService(service) {
  return {
    id: service.id,
    package: service.owner.id,
    packageVersion: service.owner.version,
    packageContentHash: `sha256:${service.owner.contentHash}`,
    protocol: service.protocol,
    artifactAccess: service.artifactAccess,
    artifactStoreAccess: service.artifactStoreAccess,
    hostGrants: [...service.hostGrants].sort(),
    provides: service.provides,
    requires: service.requires,
    execution: {
      form: service.execution.form,
      boundary: service.execution.securityBoundary,
      requestedPowers: [...service.execution.requestedPowers].sort(),
      grantedPowers: ["host-user-authority"],
      deniedAmbientPowers: [],
    },
  };
}

function collectServices(resolution) {
  const services = new Map();
  for (const owner of resolution.ordered) {
    for (const declaration of owner.runtimeServices ?? []) {
      invariant(!services.has(declaration.id), "FGPM_RUNTIME_SERVICE_ID_DUPLICATE",
        "Two selected packages declare the same runtime service identity.", {
          service: declaration.id,
          packages: [services.get(declaration.id)?.owner.id, owner.id],
        });
      services.set(declaration.id, { ...declaration, owner });
    }
  }
  return services;
}

function serviceOwners(packageOwners) {
  const services = new Map();
  for (const owner of packageOwners) {
    for (const declaration of owner.runtimeServices ?? []) {
      invariant(!services.has(declaration.id), "FGPM_RUNTIME_SERVICE_ID_DUPLICATE",
        "Two committed package roots declare the same runtime service identity.", {
          service: declaration.id,
          packages: [services.get(declaration.id)?.owner.id, owner.id],
        });
      services.set(declaration.id, { ...declaration, owner });
    }
  }
  return services;
}

function dependencyOrder(selectedServices, edges, options = {}) {
  const ordered = [];
  const state = new Map();
  const stack = [];
  function visit(serviceId) {
    if (state.get(serviceId) === "done") return;
    if (state.get(serviceId) === "visiting") {
      const start = stack.indexOf(serviceId);
      throw new FgpmError(options.cycleCode ?? "FGPM_RUNTIME_DEPENDENCY_CYCLE",
        options.cycleMessage ?? "Runtime service requirements contain a cycle.", {
          ...(options.details ?? {}),
          reason: "dependency-cycle",
          cycle: [...stack.slice(start), serviceId],
        });
    }
    invariant(selectedServices.has(serviceId), options.missingCode ?? "FGPM_RUNTIME_CAPABILITY_MISSING",
      options.missingMessage ?? "A runtime dependency names an unavailable selected service.", {
        ...(options.details ?? {}), reason: "dependency-service-absent", service: serviceId,
      });
    state.set(serviceId, "visiting");
    stack.push(serviceId);
    for (const dependency of [...(edges.get(serviceId) ?? [])].sort()) visit(dependency);
    stack.pop();
    state.set(serviceId, "done");
    ordered.push(selectedServices.get(serviceId));
  }
  for (const serviceId of [...selectedServices.keys()].sort()) visit(serviceId);
  return ordered;
}

export function runtimeEdgeProjection(edges) {
  return [...edges.entries()].flatMap(([consumer, providers]) => [...providers]
    .map((provider) => ({ consumer, provider })))
    .sort((left, right) => left.consumer.localeCompare(right.consumer)
      || left.provider.localeCompare(right.provider));
}

export function hydrateRuntimePlan(record, packageOwners, context = {}) {
  const attribution = {
    generation: context.generation ?? null,
    runtimePlanRoot: context.runtimePlanRoot ?? null,
  };
  invariant(record && ["fgpm.runtime-plan/2", "fgpm.runtime-plan/3"].includes(record.schema)
    && Array.isArray(record.activationOrder) && Array.isArray(record.services)
    && Array.isArray(record.selections) && Array.isArray(record.collections)
    && record.activation && Array.isArray(record.activation.requiredCapabilities)
    && Array.isArray(record.hostGrants),
  "FGPM_COMMITTED_RUNTIME_PLAN_INVALID", "A committed runtime plan is malformed.", {
    ...attribution, schema: record?.schema, reason: "malformed-plan",
  });
  const services = serviceOwners(packageOwners);
  invariant(new Set(record.activationOrder).size === record.activationOrder.length,
    "FGPM_COMMITTED_RUNTIME_GRAPH_INVALID",
    "A committed runtime activation order contains a duplicate service.", {
      ...attribution, reason: "duplicate-activation-service", activationOrder: record.activationOrder,
    });
  const ordered = record.activationOrder.map((id) => {
    const service = services.get(id);
    invariant(service, "FGPM_COMMITTED_RUNTIME_SERVICE_MISSING",
      "A committed runtime plan names a service absent from its exact package roots.", {
        ...attribution, service: id, reason: "activation-service-absent",
      });
    const publicRecord = record.services.find((entry) => entry.id === id);
    invariant(publicRecord && publicRecord.package === service.owner.id
      && publicRecord.packageContentHash === `sha256:${service.owner.contentHash}`,
    "FGPM_COMMITTED_RUNTIME_SERVICE_MISMATCH",
    "A committed runtime service no longer matches its exact package root.", {
      ...attribution, reason: "service-package-mismatch",
      service: id, package: service.owner.id, expected: publicRecord?.packageContentHash,
      actual: `sha256:${service.owner.contentHash}`,
    });
    return service;
  });
  invariant(record.services.length === ordered.length
    && stableJson(record.services) === stableJson(ordered.map(publicService)),
  "FGPM_COMMITTED_RUNTIME_SERVICE_MISMATCH",
  "Committed runtime services do not exactly match the activation service closure.", {
    ...attribution, reason: "service-closure-mismatch",
    activationServices: ordered.map((service) => service.id),
    recordedServices: record.services.map((service) => service.id),
  });
  const selectedServices = new Map(ordered.map((service) => [service.id, service]));
  const edges = new Map(ordered.map((service) => [service.id, new Set()]));
  const selectedCapabilities = new Map();
  const unavailableSelections = [];
  for (const selection of record.selections) {
    if (!selection.provider) {
      unavailableSelections.push(selection);
      continue;
    }
    const service = services.get(selection.provider);
    invariant(service, "FGPM_COMMITTED_RUNTIME_SERVICE_MISSING",
      "A committed capability selection names an unavailable service.", {
        ...attribution, reason: "selected-provider-absent", capability: selection.capability,
        service: selection.requestedBy, provider: selection.provider, selection,
      });
    invariant(selectedServices.has(service.id), "FGPM_COMMITTED_RUNTIME_GRAPH_INVALID",
      "A committed capability provider is absent from the activation service closure.", {
        ...attribution, reason: "selected-provider-not-activated", capability: selection.capability,
        service: selection.requestedBy, provider: selection.provider,
      });
    const provided = service.provides.find((entry) => entry.capability === selection.capability
      && (!selection.binding || entry.binding === selection.binding));
    invariant(provided && satisfies(provided.version, selection.required)
      && provided.version === selection.providedVersion && service.owner.id === selection.package
      && (provided.cardinality ?? (provided.exclusive === false ? "collection" : "exclusive")) === "exclusive",
    "FGPM_COMMITTED_RUNTIME_SELECTION_MISMATCH",
    "A committed capability selection is absent or incompatible with its selected service.", {
      ...attribution, reason: "selected-capability-mismatch", capability: selection.capability,
      service: selection.requestedBy, provider: selection.provider, selection,
    });
    if ((provided.cardinality ?? (provided.exclusive === false ? "collection" : "exclusive")) === "exclusive") {
      const previous = selectedCapabilities.get(selection.capability);
      invariant(!previous || previous.service.id === service.id,
        "FGPM_COMMITTED_RUNTIME_SELECTION_MISMATCH",
        "A committed exclusive capability names more than one provider.", {
          ...attribution, reason: "multiple-exclusive-providers", capability: selection.capability,
          provider: service.id, previousProvider: previous?.service.id ?? null,
        });
      selectedCapabilities.set(selection.capability, { service, provided });
    }
  }
  const selectedBindings = new Map();
  for (const binding of record.providerBindings ?? []) {
    const service = services.get(binding.providerInstance);
    invariant(service, "FGPM_COMMITTED_RUNTIME_SERVICE_MISSING",
      "A committed provider binding names an unavailable service.", {
        ...attribution, reason: "binding-provider-absent", binding: binding.binding,
        provider: binding.providerInstance,
      });
    const provided = service.provides.find((entry) => entry.binding === binding.binding);
    invariant(provided && service.owner.id === binding.package,
      "FGPM_COMMITTED_RUNTIME_SELECTION_MISMATCH",
      "A committed provider binding is absent or mismatched in its exact package roots.", {
        ...attribution, reason: "binding-provider-mismatch", binding: binding.binding,
        provider: binding.providerInstance,
      });
    selectedBindings.set(binding.binding, { service, provided });
  }
  const selectedCollections = new Map();
  for (const publicCollection of record.collections) {
    const members = publicCollection.members.map((member) => {
      const service = services.get(member.providerInstance);
      invariant(service, "FGPM_COMMITTED_RUNTIME_SERVICE_MISSING",
        "A committed collection member names an unavailable service.", {
          ...attribution, reason: "collection-provider-absent", capability: publicCollection.capability,
          member: member.id, provider: member.providerInstance,
        });
      const provided = service.provides.find((entry) => entry.capability === publicCollection.capability
        && entry.member === member.id);
      invariant(provided && selectedServices.has(service.id) && provided.cardinality === "collection"
        && provided.binding === member.providerBinding && provided.version === member.capabilityVersion
        && service.owner.id === member.package && service.owner.version === member.packageVersion
        && `sha256:${service.owner.contentHash}` === member.packageContentHash
        && stableJson([...provided.memberDependencies].sort()) === stableJson(member.dependencies)
        && `sha256:${sha256(stableJson(provided.metadata))}` === member.metadataRoot,
      "FGPM_COMMITTED_RUNTIME_COLLECTION_MISMATCH",
      "A committed collection member is absent or mismatched in its selected service.", {
          ...attribution, reason: "collection-member-mismatch", capability: publicCollection.capability,
          member: member.id, provider: member.providerInstance,
        });
      return { service, provided };
    });
    for (const member of members) {
      invariant(selectedBindings.get(member.provided.binding)?.service.id === member.service.id,
        "FGPM_COMMITTED_RUNTIME_COLLECTION_MISMATCH",
        "A committed collection member disagrees with its provider-instance binding.", {
          ...attribution, reason: "collection-binding-mismatch", capability: publicCollection.capability,
          member: member.provided.member, binding: member.provided.binding, provider: member.service.id,
        });
    }
    for (const exclusion of publicCollection.exclusions) {
      const service = services.get(exclusion.providerInstance);
      const provided = service?.provides.find((entry) => entry.capability === publicCollection.capability
        && entry.member === exclusion.member);
      invariant(service && provided && !members.some((entry) => entry.provided.member === exclusion.member)
        && service.owner.id === exclusion.package
        && `sha256:${service.owner.contentHash}` === exclusion.packageContentHash
        && `sha256:${sha256(stableJson(provided.metadata))}` === exclusion.metadataRoot,
      "FGPM_COMMITTED_RUNTIME_COLLECTION_MISMATCH",
      "A committed collection exclusion is not attributed to an exact available member.", {
        ...attribution, reason: "collection-exclusion-mismatch", capability: publicCollection.capability,
        member: exclusion.member, provider: exclusion.providerInstance,
      });
    }
    selectedCollections.set(publicCollection.capability, {
      capability: publicCollection.capability,
      requests: structuredClone(publicCollection.requests),
      members,
      publicMembers: structuredClone(publicCollection.members),
      memberOrder: [...publicCollection.memberOrder],
      exclusions: [...publicCollection.exclusions],
    });
  }
  const collectionRequests = new Map([...selectedCollections.keys()].map((capability) => [capability, []]));
  const usedCapabilities = new Set();
  const usedCollections = new Set();
  const usedUnavailable = new Set();
  const declaredRequirements = new Map([
    [record.activation.id, record.activation.requiredCapabilities],
    ...ordered.map((service) => [service.id, service.requires]),
  ]);
  for (const selection of record.selections) {
    const declaration = declaredRequirements.get(selection.requestedBy)?.find((requirement) =>
      requirement.capability === selection.capability && requirement.range === selection.required
      && (requirement.binding ?? null) === (selection.binding ?? null)
      && (requirement.cardinality ?? "exclusive") === "exclusive");
    invariant(declaration, "FGPM_COMMITTED_RUNTIME_SELECTION_MISMATCH",
      "A committed capability selection has no matching attributed runtime requirement.", {
        ...attribution, reason: "selection-attribution-mismatch", capability: selection.capability,
        service: selection.requestedBy, provider: selection.provider,
      });
  }

  function requirementSelection(requirement, requestedBy, consumer = null) {
    const cardinality = requirement.cardinality ?? "exclusive";
    if (cardinality === "collection") {
      const collection = selectedCollections.get(requirement.capability);
      invariant(collection && collection.members.length > 0,
        "FGPM_COMMITTED_RUNTIME_COLLECTION_MISMATCH",
        "A committed collection requirement has no selected member closure.", {
          ...attribution, reason: "required-collection-absent", capability: requirement.capability,
          service: requestedBy,
        });
      for (const member of collection.members) {
        invariant(satisfies(member.provided.version, requirement.range),
          "FGPM_COMMITTED_RUNTIME_COLLECTION_MISMATCH",
          "A committed collection member does not satisfy a required range.", {
            ...attribution, reason: "collection-range-mismatch", capability: requirement.capability,
            service: requestedBy, member: member.provided.member, provider: member.service.id,
            required: requirement.range, provided: member.provided.version,
          });
        if (consumer && member.service.id !== consumer) edges.get(consumer).add(member.service.id);
      }
      collectionRequests.get(requirement.capability).push({ requestedBy, required: requirement.range });
      usedCollections.add(requirement.capability);
      return;
    }
    const selected = selectedCapabilities.get(requirement.capability);
    if (!selected) {
      const unavailableIndex = unavailableSelections.findIndex((selection, index) => !usedUnavailable.has(index)
        && selection.capability === requirement.capability && selection.requestedBy === requestedBy
        && selection.required === requirement.range && selection.provider === null
        && (selection.binding ?? null) === (requirement.binding ?? null));
      invariant(requirement.optional === true && unavailableIndex >= 0,
        "FGPM_COMMITTED_RUNTIME_REQUIREMENT_MISMATCH",
        "A committed runtime requirement has no selected compatible provider.", {
          ...attribution, reason: "required-provider-absent", capability: requirement.capability,
          service: requestedBy, binding: requirement.binding ?? null, required: requirement.range,
        });
      usedUnavailable.add(unavailableIndex);
      return;
    }
    invariant(satisfies(selected.provided.version, requirement.range)
      && (!requirement.binding || (selected.provided.binding === requirement.binding
        && selectedBindings.get(requirement.binding)?.service.id === selected.service.id)),
    "FGPM_COMMITTED_RUNTIME_REQUIREMENT_MISMATCH",
    "A committed selected provider does not satisfy a runtime requirement.", {
      ...attribution, reason: "required-provider-mismatch", capability: requirement.capability,
      service: requestedBy, binding: requirement.binding ?? null, provider: selected.service.id,
      required: requirement.range, provided: selected.provided.version,
    });
    usedCapabilities.add(requirement.capability);
    if (consumer && selected.service.id !== consumer) edges.get(consumer).add(selected.service.id);
  }

  for (const requirement of [...record.activation.requiredCapabilities]
    .sort((left, right) => left.capability.localeCompare(right.capability))) {
    requirementSelection(requirement, record.activation.id);
  }
  for (const service of ordered) {
    for (const requirement of [...service.requires].sort((left, right) => left.capability.localeCompare(right.capability)
      || (left.cardinality ?? "exclusive").localeCompare(right.cardinality ?? "exclusive"))) {
      requirementSelection(requirement, service.id, service.id);
    }
  }
  invariant([...selectedCapabilities.keys()].every((capability) => usedCapabilities.has(capability))
    && [...selectedCollections.keys()].every((capability) => usedCollections.has(capability))
    && unavailableSelections.every((selection, index) => usedUnavailable.has(index)),
  "FGPM_COMMITTED_RUNTIME_GRAPH_INVALID",
  "Committed runtime selections contain facts outside the reconstructed requirement closure.", {
    ...attribution, reason: "unattributed-selection",
    unusedCapabilities: [...selectedCapabilities.keys()].filter((capability) => !usedCapabilities.has(capability)).sort(),
    unusedCollections: [...selectedCollections.keys()].filter((capability) => !usedCollections.has(capability)).sort(),
    unusedUnavailableSelections: unavailableSelections.filter((selection, index) => !usedUnavailable.has(index)),
  });

  for (const [capability, collection] of selectedCollections) {
    const memberById = new Map(collection.members.map((entry) => [entry.provided.member, entry]));
    const memberServices = new Map(collection.members.map((entry) => [entry.provided.member, entry]));
    const memberEdges = new Map(collection.members.map((entry) => [entry.provided.member,
      new Set(entry.provided.memberDependencies)]));
    for (const entry of collection.members) {
      for (const dependency of entry.provided.memberDependencies) {
        const dependencyEntry = memberById.get(dependency);
        invariant(dependencyEntry, "FGPM_COMMITTED_RUNTIME_COLLECTION_MISMATCH",
          "A committed collection member dependency is absent.", {
            ...attribution, reason: "collection-dependency-absent", capability,
            member: entry.provided.member, dependency,
          });
        if (dependencyEntry.service.id !== entry.service.id) {
          edges.get(entry.service.id).add(dependencyEntry.service.id);
        }
      }
    }
    const derivedMemberOrder = dependencyOrder(memberServices, memberEdges, {
      cycleCode: "FGPM_COMMITTED_RUNTIME_COLLECTION_MISMATCH",
      cycleMessage: "Committed collection member dependencies contain a cycle.",
      missingCode: "FGPM_COMMITTED_RUNTIME_COLLECTION_MISMATCH",
      details: { ...attribution, capability },
    }).map((entry) => entry.provided.member);
    invariant(stableJson(derivedMemberOrder) === stableJson(collection.memberOrder),
      "FGPM_COMMITTED_RUNTIME_COLLECTION_MISMATCH",
      "A committed collection member order disagrees with its dependency facts.", {
        ...attribution, reason: "collection-order-mismatch", capability,
        expected: derivedMemberOrder, actual: collection.memberOrder,
      });
    const expectedRequests = collectionRequests.get(capability)
      .sort((left, right) => left.requestedBy.localeCompare(right.requestedBy)
        || left.required.localeCompare(right.required));
    invariant(stableJson(expectedRequests) === stableJson(collection.requests),
      "FGPM_COMMITTED_RUNTIME_COLLECTION_MISMATCH",
      "Committed collection request attribution disagrees with the selected service closure.", {
        ...attribution, reason: "collection-request-mismatch", capability,
        expected: expectedRequests, actual: collection.requests,
      });
  }

  const derivedOrder = dependencyOrder(selectedServices, edges, {
    cycleCode: "FGPM_COMMITTED_RUNTIME_GRAPH_INVALID",
    cycleMessage: "Committed runtime service requirements contain a cycle.",
    missingCode: "FGPM_COMMITTED_RUNTIME_GRAPH_INVALID",
    details: attribution,
  }).map((service) => service.id);
  invariant(stableJson(derivedOrder) === stableJson(record.activationOrder),
    "FGPM_COMMITTED_RUNTIME_GRAPH_INVALID",
    "The committed activation order disagrees with its reconstructed dependency graph.", {
      ...attribution, reason: "activation-order-mismatch",
      expected: derivedOrder, actual: record.activationOrder,
      edges: runtimeEdgeProjection(edges),
    });
  return {
    activation: structuredClone(record.activation), ordered, edges, selectedCapabilities,
    selectedCollections, selectedBindings, record: immutable(structuredClone(record)),
  };
}

function typedArtifactReference(result) {
  const declared = result.lockfile.artifact;
  const root = result.artifact.root;
  invariant(result.artifact.type === declared.type && root?.kind === declared.kind
    && root.hash === declared.hash && ["blob", "tree"].includes(root.kind)
    && Number.isInteger(root.size) && (root.totalSize === null || Number.isInteger(root.totalSize)),
  "FGPM_TYPED_ARTIFACT_REFERENCE_INVALID",
  "The build result cannot be represented as a coherent typed activation artifact.", {
    artifact: result.artifact,
    lockfileArtifact: declared,
  });
  return immutable({
    schema: "fgpm.typed-artifact-reference/1",
    id: declared.id,
    semanticType: declared.type,
    root: structuredClone(root),
    entry: declared.entry,
    provenance: {
      builder: declared.builder,
      entryPoint: declared.entryPoint,
      lockfile: `sha256:${sha256(stableJson(result.lockfile))}`,
    },
  });
}

export function resolveRuntimePlan(result, options = {}) {
  let activations = result.activations.filter((activation) => activation.accepts.includes(result.artifact.type));
  if (result.profile.activation) activations = activations.filter((activation) => activation.id === result.profile.activation);
  invariant(activations.length > 0, "FGPM_ACTIVATION_MISSING", "No selected runtime accepts the built artifact.", {
    artifactType: result.artifact.type,
    selectedActivation: result.profile.activation ?? null,
  });
  invariant(activations.length === 1, "FGPM_ACTIVATION_AMBIGUOUS",
    "Several selected runtimes accept the built artifact; the profile must select one.", {
      candidates: activations.map((entry) => entry.id).sort(),
    });
  const activation = activations[0];
  invariant(activation.protocol === "fgpm.runtime-activation/1" && Array.isArray(activation.requires)
    && activation.requires.length > 0, "FGPM_RUNTIME_ACTIVATION_INVALID",
  "The selected runtime activation does not declare its required service capabilities.", {
    activation: activation.id,
  });

  const services = collectServices(result.resolution);
  const providers = new Map();
  for (const service of services.values()) {
    for (const provided of service.provides) {
      const candidates = providers.get(provided.capability) ?? [];
      candidates.push({ service, provided });
      providers.set(provided.capability, candidates);
    }
  }
  for (const candidates of providers.values()) {
    candidates.sort((left, right) => (left.provided.member ?? "").localeCompare(right.provided.member ?? "")
      || left.service.id.localeCompare(right.service.id));
  }
  const selectedCapabilities = new Map();
  const selectedCollections = new Map();
  const selectedBindings = new Map();
  const selectedServices = new Map();
  const edges = new Map();
  const selections = [];

  function matchesExplicit(entry, explicit) {
    return !explicit || entry.service.owner.id === explicit || entry.service.id === explicit;
  }

  function bind(entry, binding, capability, requestedBy, explicit = null) {
    if (!binding) return;
    const previous = selectedBindings.get(binding);
    invariant(!previous || previous.service.id === entry.service.id, "FGPM_RUNTIME_PROVIDER_BINDING_CONFLICT",
      "Capabilities bound to one provider instance resolved to different services.", {
        binding,
        existingProvider: previous?.service.id ?? null,
        proposedProvider: entry.service.id,
        capability,
        requestedBy,
      });
    invariant(matchesExplicit(entry, explicit), "FGPM_RUNTIME_PROVIDER_BINDING_CONFLICT",
      "A provider-instance binding conflicts with explicit profile policy.", {
        binding, capability, requestedBy, selectedProvider: explicit, proposedProvider: entry.service.id,
      });
    selectedBindings.set(binding, entry);
  }

  function ensureService(service) {
    if (selectedServices.has(service.id)) return service;
    selectedServices.set(service.id, service);
    edges.set(service.id, new Set());
    for (const dependency of [...service.requires]
      .sort((left, right) => left.capability.localeCompare(right.capability)
        || left.cardinality.localeCompare(right.cardinality))) {
      for (const provider of selectRequirement(dependency, service.id)) edges.get(service.id).add(provider.id);
    }
    return service;
  }

  function selectExclusive(requirement, requestedBy) {
    const previous = selectedCapabilities.get(requirement.capability);
    if (previous) {
      invariant(satisfies(previous.provided.version, requirement.range), "FGPM_RUNTIME_VERSION_CONFLICT",
        "A selected runtime service does not satisfy every required capability version.", {
          capability: requirement.capability,
          selected: previous.provided.version,
          required: requirement.range,
          requestedBy,
        });
      invariant(!requirement.binding || (previous.provided.binding === requirement.binding
        && selectedBindings.get(requirement.binding)?.service.id === previous.service.id),
      "FGPM_RUNTIME_PROVIDER_BINDING_CONFLICT",
      "Capabilities bound to one provider instance resolved to different services.", {
        binding: requirement.binding,
        capability: requirement.capability,
        selectedProvider: previous.service.id,
        requestedBy,
      });
      return [previous.service];
    }
    const explicit = result.profile.providers[requirement.binding] ?? result.profile.providers[requirement.capability];
    let candidates = (providers.get(requirement.capability) ?? [])
      .filter((entry) => satisfies(entry.provided.version, requirement.range));
    if (requirement.binding) {
      candidates = candidates.filter((entry) => entry.provided.binding === requirement.binding);
      const bound = selectedBindings.get(requirement.binding);
      if (bound) candidates = candidates.filter((entry) => entry.service.id === bound.service.id);
    }
    if (explicit) candidates = candidates.filter((entry) => entry.service.owner.id === explicit
      || entry.service.id === explicit);
    if (candidates.length === 0 && requirement.optional === true) {
      selections.push({
        capability: requirement.capability,
        binding: requirement.binding ?? null,
        required: requirement.range,
        requestedBy,
        provider: null,
        package: null,
        providedVersion: null,
        reason: "optional-unavailable",
      });
      return [];
    }
    invariant(candidates.length > 0, "FGPM_RUNTIME_CAPABILITY_MISSING",
      "No selected runtime service provides a required capability.", {
        capability: requirement.capability,
        required: requirement.range,
        requestedBy,
        selectedProvider: explicit ?? null,
      });
    invariant(candidates.length === 1, "FGPM_RUNTIME_PROVIDER_AMBIGUOUS",
      "Several exclusive runtime services provide one capability; policy must select one.", {
        capability: requirement.capability,
        required: requirement.range,
        requestedBy,
        candidates: candidates.map((entry) => ({
          service: entry.service.id,
          package: entry.service.owner.id,
          version: entry.provided.version,
        })).sort((left, right) => left.service.localeCompare(right.service)),
      });
    const selected = candidates[0];
    bind(selected, requirement.binding, requirement.capability, requestedBy, explicit);
    selectedCapabilities.set(requirement.capability, selected);
    selections.push({
      capability: requirement.capability,
      binding: requirement.binding ?? null,
      required: requirement.range,
      requestedBy,
      provider: selected.service.id,
      package: selected.service.owner.id,
      providedVersion: selected.provided.version,
      reason: explicit ? "profile-policy" : "sole-compatible-provider",
    });
    ensureService(selected.service);
    return [selected.service];
  }

  function selectCollection(requirement, requestedBy) {
    const previous = selectedCollections.get(requirement.capability);
    if (previous) {
      invariant(previous.members.every((entry) => satisfies(entry.provided.version, requirement.range)),
        "FGPM_RUNTIME_COLLECTION_RANGE_CONFLICT",
        "A capability collection cannot satisfy every requested version range.", {
          capability: requirement.capability,
          required: requirement.range,
          requestedBy,
          members: previous.members.map((entry) => ({ member: entry.provided.member,
            version: entry.provided.version })),
        });
      previous.requests.push({ requestedBy, required: requirement.range });
      return previous.members.map((entry) => entry.service);
    }
    const compatible = (providers.get(requirement.capability) ?? [])
      .filter((entry) => entry.provided.cardinality === "collection"
        && satisfies(entry.provided.version, requirement.range));
    invariant(compatible.length > 0, "FGPM_RUNTIME_COLLECTION_EMPTY",
      "No selected runtime service contributes to a required capability collection.", {
        capability: requirement.capability,
        required: requirement.range,
        requestedBy,
      });

    const byBinding = new Map();
    for (const entry of compatible) {
      const candidates = byBinding.get(entry.provided.binding) ?? [];
      candidates.push(entry);
      byBinding.set(entry.provided.binding, candidates);
    }
    const boundMembers = [];
    for (const binding of [...byBinding.keys()].sort()) {
      const explicit = result.profile.providers[binding];
      const alreadyBound = selectedBindings.get(binding);
      let candidates = byBinding.get(binding);
      if (alreadyBound) candidates = candidates.filter((entry) => entry.service.id === alreadyBound.service.id);
      if (explicit) candidates = candidates.filter((entry) => matchesExplicit(entry, explicit));
      invariant(candidates.length > 0, "FGPM_RUNTIME_COLLECTION_BINDING_MISSING",
        "No collection member matches its selected provider-instance binding.", {
          capability: requirement.capability, binding, requestedBy,
          selectedProvider: explicit ?? alreadyBound?.service.id ?? null,
        });
      invariant(candidates.length === 1, "FGPM_RUNTIME_PROVIDER_AMBIGUOUS",
        "Several services contribute one provider-bound collection member; policy must select one.", {
          capability: requirement.capability,
          binding,
          requestedBy,
          candidates: candidates.map((entry) => ({ member: entry.provided.member,
            service: entry.service.id, package: entry.service.owner.id, version: entry.provided.version })),
        });
      bind(candidates[0], binding, requirement.capability, requestedBy, explicit);
      boundMembers.push(candidates[0]);
    }

    const identities = new Map();
    for (const entry of boundMembers) {
      const duplicates = identities.get(entry.provided.member) ?? [];
      duplicates.push(entry);
      identities.set(entry.provided.member, duplicates);
    }
    const duplicate = [...identities.entries()].find(([, entries]) => entries.length > 1);
    invariant(!duplicate, "FGPM_RUNTIME_COLLECTION_MEMBER_DUPLICATE",
      "Two selected packages contribute the same collection-member identity.", {
        capability: requirement.capability,
        member: duplicate?.[0] ?? null,
        contributors: (duplicate?.[1] ?? []).map((entry) => ({ service: entry.service.id,
          package: entry.service.owner.id, binding: entry.provided.binding })),
      });

    const policy = result.profile.collectionPolicy[requirement.capability] ?? null;
    const excludedIds = new Set(policy?.exclude ?? []);
    for (const member of excludedIds) {
      invariant(identities.has(member), "FGPM_RUNTIME_COLLECTION_EXCLUSION_UNKNOWN",
        "Collection policy excludes a member which is not available in the selected graph.", {
          capability: requirement.capability, member, policy: policy.id,
        });
    }
    const members = boundMembers.filter((entry) => !excludedIds.has(entry.provided.member))
      .sort((left, right) => left.provided.member.localeCompare(right.provided.member));
    invariant(members.length > 0, "FGPM_RUNTIME_COLLECTION_EMPTY",
      "Collection policy excluded every compatible member.", {
        capability: requirement.capability, policy: policy?.id ?? null,
      });
    const memberById = new Map(members.map((entry) => [entry.provided.member, entry]));
    for (const entry of members) {
      for (const dependency of entry.provided.memberDependencies) {
        invariant(memberById.has(dependency), "FGPM_RUNTIME_COLLECTION_DEPENDENCY_MISSING",
          "A selected collection member depends on an absent or excluded member.", {
            capability: requirement.capability,
            member: entry.provided.member,
            dependency,
            excluded: excludedIds.has(dependency),
            policy: policy?.id ?? null,
          });
      }
    }
    const memberOrder = [];
    const memberState = new Map();
    const memberStack = [];
    function visitMember(memberId) {
      if (memberState.get(memberId) === "done") return;
      if (memberState.get(memberId) === "visiting") {
        const start = memberStack.indexOf(memberId);
        throw new FgpmError("FGPM_RUNTIME_COLLECTION_DEPENDENCY_CYCLE",
          "Capability collection member dependencies contain a cycle.", {
            capability: requirement.capability,
            cycle: [...memberStack.slice(start), memberId],
          });
      }
      memberState.set(memberId, "visiting");
      memberStack.push(memberId);
      for (const dependency of [...memberById.get(memberId).provided.memberDependencies].sort()) {
        visitMember(dependency);
      }
      memberStack.pop();
      memberState.set(memberId, "done");
      memberOrder.push(memberId);
    }
    for (const memberId of [...memberById.keys()].sort()) visitMember(memberId);

    const publicMember = (entry) => ({
      id: entry.provided.member,
      providerInstance: entry.service.id,
      providerBinding: entry.provided.binding,
      package: entry.service.owner.id,
      packageVersion: entry.service.owner.version,
      packageContentHash: `sha256:${entry.service.owner.contentHash}`,
      capabilityVersion: entry.provided.version,
      dependencies: [...entry.provided.memberDependencies].sort(),
      metadata: entry.provided.metadata,
      metadataRoot: `sha256:${sha256(stableJson(entry.provided.metadata))}`,
    });
    const collection = {
      capability: requirement.capability,
      requests: [{ requestedBy, required: requirement.range }],
      members,
      memberOrder,
      publicMembers: memberOrder.map((memberId) => publicMember(memberById.get(memberId))),
      exclusions: boundMembers.filter((entry) => excludedIds.has(entry.provided.member)).map((entry) => ({
        member: entry.provided.member,
        providerInstance: entry.service.id,
        package: entry.service.owner.id,
        packageContentHash: `sha256:${entry.service.owner.contentHash}`,
        metadata: entry.provided.metadata,
        metadataRoot: `sha256:${sha256(stableJson(entry.provided.metadata))}`,
        policy: policy.id,
        reason: "profile-policy-exclusion",
      })).sort((left, right) => left.member.localeCompare(right.member)),
    };
    selectedCollections.set(requirement.capability, collection);
    for (const entry of members) ensureService(entry.service);
    for (const entry of members) {
      for (const dependency of entry.provided.memberDependencies) {
        const dependencyService = memberById.get(dependency).service;
        if (dependencyService.id !== entry.service.id) edges.get(entry.service.id).add(dependencyService.id);
      }
    }
    return members.map((entry) => entry.service);
  }

  function selectRequirement(requirement, requestedBy) {
    return requirement.cardinality === "collection"
      ? selectCollection(requirement, requestedBy)
      : selectExclusive(requirement, requestedBy);
  }

  for (const requirement of [...activation.requires]
    .sort((left, right) => left.capability.localeCompare(right.capability))) {
    selectRequirement({ ...requirement, cardinality: requirement.cardinality ?? "exclusive" }, activation.id);
  }

  const ordered = dependencyOrder(selectedServices, edges);

  const channelDeclarations = new Map();
  for (const member of selectedCollections.get("runtime.task")?.publicMembers ?? []) {
    for (const output of member.metadata?.outputs ?? []) {
      if (typeof output?.channel !== "string" || typeof output?.vocabulary !== "string") continue;
      const entries = channelDeclarations.get(output.channel) ?? [];
      entries.push({ task: member.id, vocabulary: output.vocabulary,
        stage: output.stage ?? null, law: output.law ?? output.composition ?? null });
      channelDeclarations.set(output.channel, entries);
    }
  }
  const channelProvider = selectedCapabilities.get("runtime.task-channel.transforms")?.service ?? null;
  const channelCompositions = [...channelDeclarations.entries()].map(([channel, contributors]) => ({
    schema: "fgpm.command-channel-plan/1",
    channel,
    vocabulary: [...new Set(contributors.map((entry) => entry.vocabulary))].sort(),
    steward: channelProvider ? `${channelProvider.owner.id}@${channelProvider.owner.version}` : null,
    provider: channelProvider?.id ?? null,
    stageSet: [...new Map(contributors.map((entry) => [`${entry.stage}\u0000${entry.law}`,
      { id: entry.stage, law: entry.law }])).values()]
      .sort((left, right) => left.id.localeCompare(right.id) || left.law.localeCompare(right.law)),
    contributors: contributors.sort((left, right) => left.task.localeCompare(right.task)),
  })).sort((left, right) => left.channel.localeCompare(right.channel));

  const record = {
    schema: result.profile.schema === "fgpm.profile/3" ? "fgpm.runtime-plan/3" : "fgpm.runtime-plan/2",
    activation: {
      id: activation.id,
      package: activation.package,
      accepts: activation.accepts,
      requiredCapabilities: activation.requires,
      deterministicTicks: activation.ticks,
    },
    artifact: options.artifactReference ?? {
      id: result.lockfile.artifact.id,
      type: result.artifact.type,
      hash: result.lockfile.artifact.hash,
    },
    selections: selections.sort((left, right) => left.capability.localeCompare(right.capability)
      || left.requestedBy.localeCompare(right.requestedBy)),
    providerBindings: [...selectedBindings.entries()].map(([binding, selected]) => ({
      binding,
      providerInstance: selected.service.id,
      package: selected.service.owner.id,
      reason: result.profile.providers[binding] ? "profile-policy" : "capability-selection",
    })).sort((left, right) => left.binding.localeCompare(right.binding)),
    collections: [...selectedCollections.values()].map((collection) => ({
      schema: "fgpm.capability-collection-plan/1",
      capability: collection.capability,
      requests: collection.requests.sort((left, right) => left.requestedBy.localeCompare(right.requestedBy)
        || left.required.localeCompare(right.required)),
      memberOrder: collection.memberOrder,
      members: collection.publicMembers,
      exclusions: collection.exclusions,
    })).sort((left, right) => left.capability.localeCompare(right.capability)),
    activationOrder: ordered.map((service) => service.id),
    services: ordered.map(publicService),
    hostGrants: ordered.flatMap((service) => service.hostGrants.map((grant) => {
      const definition = HOST_GRANTS[grant];
      const status = options.deniedHostGrants?.includes(grant) ? "denied"
        : options.absentHostGrants?.includes(grant) || !definition ? "absent" : "granted";
      return {
        schema: "fgpm.host-grant-record/1",
        service: service.id,
        grant,
        status,
        classification: definition?.classification ?? "observational",
        provider: "fgpm.manager-host/1",
        policy: status === "granted" ? "host-user-authority" : `host-user-authority:${status}`,
      };
    })).sort((left, right) => left.service.localeCompare(right.service) || left.grant.localeCompare(right.grant)),
    ...(result.profile.schema === "fgpm.profile/3" ? { channelCompositions } : {}),
  };
  return { activation, ordered, edges, selectedCapabilities, selectedCollections, selectedBindings, record,
    manager: structuredClone(result.lockfile.manager) };
}

export class RuntimeHost {
  constructor(plan, artifact, options = {}) {
    this.plan = plan;
    this.artifact = immutable(structuredClone(artifact));
    this.options = options;
    this.capabilities = new Map();
    this.collectionValues = new Map();
    this.active = [];
    this.ticks = 0;
    this.tickInFlight = false;
    this.lifecycle = {
      schema: "fgpm.runtime-lifecycle/1",
      manager: plan.manager ?? null,
      plan: plan.record,
      state: "planned",
      committed: false,
      ticks: 0,
      events: [],
    };
  }

  capability(capability) {
    const collection = this.plan.selectedCollections.get(capability);
    if (collection) {
      const values = this.collectionValues.get(capability) ?? new Map();
      invariant(values.size === collection.members.length, "FGPM_RUNTIME_COLLECTION_INCOMPLETE",
        "A capability collection was requested before every selected member activated.", {
          capability,
          expected: collection.members.map((entry) => entry.provided.member),
          active: [...values.keys()].sort(),
        });
      return immutable({
        schema: "fgpm.capability-collection/1",
        capability,
        memberOrder: [...collection.memberOrder],
        exclusions: structuredClone(collection.exclusions),
        members: collection.publicMembers.map((member) => ({
          ...structuredClone(member),
          value: values.get(member.id),
        })),
      });
    }
    const selected = this.capabilities.get(capability);
    invariant(selected, "FGPM_RUNTIME_CAPABILITY_INACTIVE", "A runtime capability is not active.", { capability });
    return selected.value;
  }

  async writeLifecycle() {
    if (this.options.recordPath) await writeJson(this.options.recordPath, this.lifecycle);
  }

  contextFor(service) {
    const declared = new Map(service.requires.map((entry) => [entry.capability, entry]));
    const artifactStore = service.artifactStoreAccess === "none" ? null : {
      readTreeReference: (namespace, identity) => this.options.artifactStore.readTreeReference(namespace, identity),
      ...(service.artifactStoreAccess === "read-write" ? {
        publishTreeReference: (namespace, identity, files, metadata, publishOptions) => this.options.artifactStore
          .publishTreeReference(namespace, identity, files, metadata, publishOptions),
      } : {}),
    };
    const artifact = service.artifactAccess === "read" ? {
      reference: this.artifact,
      readEntry: (entry = this.artifact.entry) => this.options.activationArtifactStore
        .readArtifactEntry(this.artifact, entry),
    } : null;
    const requestedGrants = new Set(service.hostGrants);
    return immutable({
      service: { id: service.id, package: service.owner.id },
      artifact,
      artifactStore,
      grant: (identity) => {
        invariant(requestedGrants.has(identity), "FGPM_HOST_GRANT_UNDECLARED",
          "A runtime service requested a host grant it did not declare.", {
            service: service.id, grant: identity, declared: [...requestedGrants].sort(),
          });
        const record = this.plan.record.hostGrants.find((entry) => entry.service === service.id
          && entry.grant === identity);
        invariant(record?.status === "granted" && Object.hasOwn(this.options.hostGrantValues, identity),
          "FGPM_HOST_GRANT_UNAVAILABLE", "A declared host grant is absent or denied.", {
            service: service.id, grant: identity, record,
          });
        return immutable(structuredClone(this.options.hostGrantValues[identity]));
      },
      require: (capability) => {
        invariant(declared.has(capability), "FGPM_RUNTIME_AUTHORITY_DENIED",
          "A runtime service requested a capability outside its declared authority.", {
            service: service.id,
            capability,
            declared: [...declared.keys()].sort(),
          });
        if (declared.get(capability).optional === true && !this.capabilities.has(capability)) return null;
        return this.capability(capability);
      },
    });
  }

  async activate() {
    try {
      for (const service of this.plan.ordered) {
        const modulePath = resolveInside(service.owner.directory, service.module, "runtime service module");
        const implementation = await import(pathToFileURL(modulePath).href);
        invariant(typeof implementation.createService === "function", "FGPM_RUNTIME_SERVICE_INVALID",
          "A runtime service module does not export createService().", { service: service.id, module: service.module });
        const controller = implementation.createService();
        invariant(controller && typeof controller.activate === "function", "FGPM_RUNTIME_SERVICE_INVALID",
          "A runtime service controller does not implement activate().", { service: service.id });
        const context = this.contextFor(service);
        const response = await controller.activate(context);
        const responseProtocol = service.protocol === "fgpm.runtime-service/2"
          ? "fgpm.runtime-service-response/2" : "fgpm.runtime-service-response/1";
        invariant(response?.protocol === responseProtocol
          && response.capabilities && typeof response.capabilities === "object", "FGPM_RUNTIME_SERVICE_INVALID",
        "A runtime service returned an invalid activation response.", {
          service: service.id, expectedProtocol: responseProtocol, actualProtocol: response?.protocol,
        });
        for (const provided of service.provides) {
          if (provided.cardinality === "collection") {
            const collection = this.plan.selectedCollections.get(provided.capability);
            const selectedMember = collection?.members.find((entry) => entry.service.id === service.id
              && entry.provided.member === provided.member);
            if (!selectedMember) continue;
            invariant(Object.hasOwn(response.capabilities, provided.capability), "FGPM_RUNTIME_SERVICE_INVALID",
              "A runtime service did not publish its selected collection-member capability.", {
                service: service.id,
                capability: provided.capability,
                member: provided.member,
              });
            const values = this.collectionValues.get(provided.capability) ?? new Map();
            invariant(!values.has(provided.member), "FGPM_RUNTIME_COLLECTION_MEMBER_DUPLICATE",
              "Two active services attempted to publish one collection-member identity.", {
                capability: provided.capability, member: provided.member, service: service.id,
              });
            values.set(provided.member, response.capabilities[provided.capability]);
            this.collectionValues.set(provided.capability, values);
            continue;
          }
          invariant(Object.hasOwn(response.capabilities, provided.capability), "FGPM_RUNTIME_SERVICE_INVALID",
            "A runtime service did not publish a declared capability.", {
              service: service.id,
              capability: provided.capability,
            });
          invariant(!this.capabilities.has(provided.capability), "FGPM_RUNTIME_PROVIDER_AMBIGUOUS",
            "Two active services attempted to publish one exclusive capability.", {
              capability: provided.capability,
              services: [this.capabilities.get(provided.capability)?.service.id, service.id],
            });
          this.capabilities.set(provided.capability, { service, value: response.capabilities[provided.capability] });
        }
        this.active.push({ service, controller, context });
        this.lifecycle.events.push({ event: "activate", service: service.id });
      }
      for (const entry of this.active) {
        if (typeof entry.controller.commit === "function") {
          await entry.controller.commit(entry.context);
          this.lifecycle.events.push({ event: "commit", service: entry.service.id });
        }
      }
      this.lifecycle.state = "active";
      this.lifecycle.committed = true;
      await this.writeLifecycle();
      return this;
    } catch (error) {
      const activated = this.active.map((entry) => entry.service.id);
      const rolledBack = [];
      for (const entry of [...this.active].reverse()) {
        try {
          if (typeof entry.controller.deactivate === "function") await entry.controller.deactivate(entry.context);
          rolledBack.push(entry.service.id);
        } catch {
          rolledBack.push(`${entry.service.id}:deactivation-failed`);
        }
      }
      this.active = [];
      this.capabilities.clear();
      this.collectionValues.clear();
      if (this.options.recordPath) await rm(this.options.recordPath, { force: true });
      if (error instanceof FgpmError) {
        error.details = { ...error.details, lifecycle: { committed: false, activated, rolledBack } };
        throw error;
      }
      if (typeof error?.code === "string") {
        throw new FgpmError(error.code, error.message, {
          ...(error.details ?? {}),
          lifecycle: { committed: false, activated, rolledBack },
        });
      }
      throw new FgpmError("FGPM_RUNTIME_ACTIVATION_FAILED", "A runtime service failed during activation.", {
        cause: error.message,
        lifecycle: { committed: false, activated, rolledBack },
      });
    }
  }

  activeDependents(serviceId) {
    return this.active.filter((entry) => this.plan.edges.get(entry.service.id)?.has(serviceId));
  }

  async deactivateService(serviceId, options = {}) {
    const entry = this.active.find((candidate) => candidate.service.id === serviceId);
    if (!entry) return;
    const dependents = this.activeDependents(serviceId);
    invariant(options.cascade || dependents.length === 0, "FGPM_RUNTIME_DEPENDENTS_ACTIVE",
      "A runtime service cannot stop while active dependants still require it.", {
        service: serviceId,
        dependents: dependents.map((candidate) => candidate.service.id).sort(),
      });
    if (options.cascade) {
      const reverseOrder = [...this.plan.ordered].reverse().map((service) => service.id);
      for (const dependent of dependents.sort((left, right) => reverseOrder.indexOf(left.service.id)
        - reverseOrder.indexOf(right.service.id))) {
        await this.deactivateService(dependent.service.id, { cascade: true });
      }
    }
    if (typeof entry.controller.deactivate === "function") await entry.controller.deactivate(entry.context);
    for (const [capability, selected] of this.capabilities) {
      if (selected.service.id === serviceId) this.capabilities.delete(capability);
    }
    for (const collection of this.plan.selectedCollections.values()) {
      const values = this.collectionValues.get(collection.capability);
      for (const member of collection.members.filter((candidate) => candidate.service.id === serviceId)) {
        values?.delete(member.provided.member);
      }
    }
    this.active = this.active.filter((candidate) => candidate !== entry);
    this.lifecycle.events.push({ event: "deactivate", service: serviceId });
  }

  async tick() {
    invariant(this.lifecycle.state === "active", "FGPM_RUNTIME_NOT_ACTIVE", "The runtime is not active.");
    invariant(!this.tickInFlight, "FGPM_RUNTIME_TICK_OVERLAP",
      "A runtime generation cannot begin another tick before its current barrier completes.", {
        activeTick: this.ticks + 1,
      });
    this.tickInFlight = true;
    const next = this.ticks + 1;
    try {
      for (const entry of this.active) {
        if (typeof entry.controller.tick === "function") await entry.controller.tick(next, entry.context);
      }
      this.ticks = next;
      this.lifecycle.ticks = next;
      this.lifecycle.events.push({ event: "tick", tick: next });
    } finally {
      this.tickInFlight = false;
    }
  }

  async shutdown() {
    for (const service of [...this.plan.ordered].reverse()) {
      await this.deactivateService(service.id);
    }
    this.lifecycle.state = "stopped";
    this.lifecycle.ticks = this.ticks;
    await this.writeLifecycle();
    return this.lifecycle;
  }
}

async function startResolvedRuntime(plan, artifact, directories, identities, options = {}) {
  const recordPath = options.recordPath ?? path.join(directories.outputDirectory, "runtime-lifecycle.json");
  const artifactStore = new ArtifactStore(directories.storeDirectory, {
    protocol: "fgpm.artifact-transaction/2",
    facts: {},
    widenedDimensions: [],
  });
  const activationArtifactStore = directories.artifactStoreDirectory === undefined
    || path.resolve(directories.artifactStoreDirectory) === path.resolve(directories.storeDirectory)
    ? artifactStore
    : new ArtifactStore(directories.artifactStoreDirectory, {
      protocol: "fgpm.artifact-transaction/2", facts: {}, widenedDimensions: [],
    });
  invariant(await activationArtifactStore.verifyRoot(artifact.root), "FGPM_RUNTIME_ARTIFACT_ROOT_INVALID",
    "The selected typed activation artifact root is absent, mismatched, or corrupt.", {
      artifact: artifact.id, semanticType: artifact.semanticType, root: artifact.root,
    });
  const distributionIdentity = identities.distributionIdentity;
  const runtimePlanIdentity = `sha256:${sha256(stableJson(plan.record))}`;
  if (identities.runtimePlanIdentity) {
    invariant(runtimePlanIdentity === identities.runtimePlanIdentity, "FGPM_COMMITTED_RUNTIME_PLAN_MISMATCH",
      "The hydrated runtime plan does not match the committed generation root.", {
        expected: identities.runtimePlanIdentity, actual: runtimePlanIdentity,
      });
  }
  const allGrantValues = {
    "fgpm.host.renderer-output/1": {
      snapshotPath: options.snapshotPath ? path.resolve(options.snapshotPath) : null,
    },
    "fgpm.host.runtime-interaction/1": {
      interactive: options.interactive === true,
      openBrowser: options.openBrowser !== false,
    },
    "fgpm.host.persistence-input/1": {
      loadSaveId: options.loadSaveId ?? null,
      distributionIdentity,
      runtimePlanIdentity,
      runtimePlan: plan.record,
    },
    "fgpm.host.persistence-records/1": {
      sessionRecordPath: path.join(directories.outputDirectory, "runtime-session.json"),
    },
    "fgpm.host.persistence-conformance/1": {
      interruptSaveBeforePublication: options.interruptSaveBeforePublication === true,
    },
    "fgpm.host.scheduler-records/1": {
      tickRecordPath: path.join(directories.outputDirectory, "runtime-ticks.json"),
      tickTracePath: path.join(directories.outputDirectory, "runtime-tick-trace.json"),
    },
    "fgpm.host.scheduler-conformance/1": {
      workerCount: options.schedulerWorkerCount ?? null,
      memberDelays: options.schedulerDelays ?? {},
      timeoutMs: options.schedulerTimeoutMs ?? 2_000,
    },
  };
  const granted = new Set(plan.record.hostGrants.filter((entry) => entry.status === "granted")
    .map((entry) => entry.grant));
  const hostGrantValues = Object.fromEntries(Object.entries(allGrantValues).filter(([identity]) => granted.has(identity)));
  const host = new RuntimeHost(plan, artifact, {
    recordPath,
    artifactStore,
    activationArtifactStore,
    hostGrantValues,
  });
  await host.activate();
  return host;
}

export async function startRuntime(result, options = {}) {
  const artifact = typedArtifactReference(result);
  const plan = resolveRuntimePlan(result, {
    artifactReference: artifact,
    deniedHostGrants: options.deniedHostGrants ?? [],
    absentHostGrants: options.absentHostGrants ?? [],
  });
  return startResolvedRuntime(plan, artifact, {
    outputDirectory: result.outputDirectory,
    storeDirectory: result.storeDirectory,
    artifactStoreDirectory: result.artifactStoreDirectory,
  }, {
    distributionIdentity: `sha256:${sha256(stableJson(result.lockfile))}`,
  }, options);
}

export async function startCommittedRuntime(committed, options = {}) {
  invariant(committed && committed.runtimePlan && committed.artifact && Array.isArray(committed.packageOwners),
    "FGPM_COMMITTED_RUNTIME_INVALID", "A generation-bound runtime closure is malformed.", {});
  const plan = hydrateRuntimePlan(committed.runtimePlan, committed.packageOwners, {
    generation: committed.generation,
    runtimePlanRoot: committed.runtimePlanIdentity,
  });
  const artifact = immutable(structuredClone(committed.artifact));
  return startResolvedRuntime(plan, artifact, {
    outputDirectory: committed.outputDirectory,
    storeDirectory: committed.storeDirectory,
    artifactStoreDirectory: committed.artifactStoreDirectory,
  }, {
    distributionIdentity: committed.distributionIdentity,
    runtimePlanIdentity: committed.runtimePlanIdentity,
  }, options);
}

export async function runRuntime(result, options = {}) {
  const interactive = options.interactive ?? options.ticks === undefined;
  const host = await startRuntime(result, { ...options, interactive });
  const ticks = options.ticks ?? host.plan.activation.ticks ?? 8;
  for (let tick = 0; tick < ticks; tick += 1) await host.tick();
  if (options.saveId) await host.capability("runtime.persistence.world").save(options.saveId);
  if (!interactive) {
    await host.shutdown();
    return host.lifecycle;
  }
  await new Promise((resolve, reject) => {
    let ticking = false;
    const interval = setInterval(async () => {
      if (ticking) return;
      ticking = true;
      try {
        await host.tick();
      } catch (error) {
        clearInterval(interval);
        reject(error);
      } finally {
        ticking = false;
      }
    }, 250);
    const stop = () => {
      clearInterval(interval);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await host.shutdown();
  return host.lifecycle;
}

export function explainRuntime(lifecycle, target) {
  const service = lifecycle.plan.services.find((entry) => entry.id === target || entry.package === target);
  const selections = lifecycle.plan.selections.filter((entry) => entry.capability === target
    || entry.provider === target || entry.package === target);
  const collections = (lifecycle.plan.collections ?? []).filter((collection) => collection.capability === target
    || collection.members.some((member) => member.id === target || member.providerInstance === target
      || member.package === target)
    || collection.exclusions.some((member) => member.member === target || member.providerInstance === target
      || member.package === target));
  const channelCompositions = (lifecycle.plan.channelCompositions ?? []).filter((composition) =>
    composition.channel === target || composition.provider === target || composition.steward === target
    || (Array.isArray(composition.vocabulary) ? composition.vocabulary.includes(target)
      : composition.vocabulary === target)
    || composition.contributors?.some((entry) => entry.task === target));
  invariant(service || selections.length > 0 || collections.length > 0 || channelCompositions.length > 0,
    "FGPM_RUNTIME_EXPLANATION_MISSING",
    "No runtime service or capability matches the requested explanation target.", { target });
  const serviceIds = new Set([service?.id, ...selections.map((entry) => entry.provider),
    ...collections.flatMap((collection) => collection.members.map((member) => member.providerInstance)),
    ...collections.flatMap((collection) => collection.exclusions.map((member) => member.providerInstance)),
    ...collections.flatMap((collection) => collection.requests.map((request) => request.requestedBy))].filter(Boolean));
  return {
    target,
    service: service ?? null,
    selections,
    collections,
    channelCompositions,
    lifecycle: lifecycle.events.filter((entry) => entry.service === undefined || serviceIds.has(entry.service)),
    state: lifecycle.state,
    committed: lifecycle.committed,
  };
}
