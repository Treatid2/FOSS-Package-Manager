// SPDX-License-Identifier: MPL-2.0

import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ArtifactStore } from "./artifacts.mjs";
import { FpmError, invariant } from "./errors.mjs";
import { resolveInside, sha256, stableJson, writeJson } from "./io.mjs";
import { satisfies } from "./semver.mjs";

function immutable(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

function publicService(service) {
  return {
    id: service.id,
    package: service.owner.id,
    packageVersion: service.owner.version,
    packageContentHash: `sha256:${service.owner.contentHash}`,
    protocol: service.protocol,
    artifactAccess: service.artifactAccess,
    artifactStoreAccess: service.artifactStoreAccess,
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
      invariant(!services.has(declaration.id), "FPM_RUNTIME_SERVICE_ID_DUPLICATE",
        "Two selected packages declare the same runtime service identity.", {
          service: declaration.id,
          packages: [services.get(declaration.id)?.owner.id, owner.id],
        });
      services.set(declaration.id, { ...declaration, owner });
    }
  }
  return services;
}

export function resolveRuntimePlan(result) {
  let activations = result.activations.filter((activation) => activation.accepts.includes(result.artifact.type));
  if (result.profile.activation) activations = activations.filter((activation) => activation.id === result.profile.activation);
  invariant(activations.length > 0, "FPM_ACTIVATION_MISSING", "No selected runtime accepts the built artifact.", {
    artifactType: result.artifact.type,
    selectedActivation: result.profile.activation ?? null,
  });
  invariant(activations.length === 1, "FPM_ACTIVATION_AMBIGUOUS",
    "Several selected runtimes accept the built artifact; the profile must select one.", {
      candidates: activations.map((entry) => entry.id).sort(),
    });
  const activation = activations[0];
  invariant(activation.protocol === "fpm.runtime-activation/1" && Array.isArray(activation.requires)
    && activation.requires.length > 0, "FPM_RUNTIME_ACTIVATION_INVALID",
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
    invariant(!previous || previous.service.id === entry.service.id, "FPM_RUNTIME_PROVIDER_BINDING_CONFLICT",
      "Capabilities bound to one provider instance resolved to different services.", {
        binding,
        existingProvider: previous?.service.id ?? null,
        proposedProvider: entry.service.id,
        capability,
        requestedBy,
      });
    invariant(matchesExplicit(entry, explicit), "FPM_RUNTIME_PROVIDER_BINDING_CONFLICT",
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
      invariant(satisfies(previous.provided.version, requirement.range), "FPM_RUNTIME_VERSION_CONFLICT",
        "A selected runtime service does not satisfy every required capability version.", {
          capability: requirement.capability,
          selected: previous.provided.version,
          required: requirement.range,
          requestedBy,
        });
      invariant(!requirement.binding || (previous.provided.binding === requirement.binding
        && selectedBindings.get(requirement.binding)?.service.id === previous.service.id),
      "FPM_RUNTIME_PROVIDER_BINDING_CONFLICT",
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
    invariant(candidates.length > 0, "FPM_RUNTIME_CAPABILITY_MISSING",
      "No selected runtime service provides a required capability.", {
        capability: requirement.capability,
        required: requirement.range,
        requestedBy,
        selectedProvider: explicit ?? null,
      });
    invariant(candidates.length === 1, "FPM_RUNTIME_PROVIDER_AMBIGUOUS",
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
        "FPM_RUNTIME_COLLECTION_RANGE_CONFLICT",
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
    invariant(compatible.length > 0, "FPM_RUNTIME_COLLECTION_EMPTY",
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
      invariant(candidates.length > 0, "FPM_RUNTIME_COLLECTION_BINDING_MISSING",
        "No collection member matches its selected provider-instance binding.", {
          capability: requirement.capability, binding, requestedBy,
          selectedProvider: explicit ?? alreadyBound?.service.id ?? null,
        });
      invariant(candidates.length === 1, "FPM_RUNTIME_PROVIDER_AMBIGUOUS",
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
    invariant(!duplicate, "FPM_RUNTIME_COLLECTION_MEMBER_DUPLICATE",
      "Two selected packages contribute the same collection-member identity.", {
        capability: requirement.capability,
        member: duplicate?.[0] ?? null,
        contributors: (duplicate?.[1] ?? []).map((entry) => ({ service: entry.service.id,
          package: entry.service.owner.id, binding: entry.provided.binding })),
      });

    const policy = result.profile.collectionPolicy[requirement.capability] ?? null;
    const excludedIds = new Set(policy?.exclude ?? []);
    for (const member of excludedIds) {
      invariant(identities.has(member), "FPM_RUNTIME_COLLECTION_EXCLUSION_UNKNOWN",
        "Collection policy excludes a member which is not available in the selected graph.", {
          capability: requirement.capability, member, policy: policy.id,
        });
    }
    const members = boundMembers.filter((entry) => !excludedIds.has(entry.provided.member))
      .sort((left, right) => left.provided.member.localeCompare(right.provided.member));
    invariant(members.length > 0, "FPM_RUNTIME_COLLECTION_EMPTY",
      "Collection policy excluded every compatible member.", {
        capability: requirement.capability, policy: policy?.id ?? null,
      });
    const memberById = new Map(members.map((entry) => [entry.provided.member, entry]));
    for (const entry of members) {
      for (const dependency of entry.provided.memberDependencies) {
        invariant(memberById.has(dependency), "FPM_RUNTIME_COLLECTION_DEPENDENCY_MISSING",
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
        throw new FpmError("FPM_RUNTIME_COLLECTION_DEPENDENCY_CYCLE",
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

  const ordered = [];
  const state = new Map();
  const stack = [];
  function visit(serviceId) {
    if (state.get(serviceId) === "done") return;
    if (state.get(serviceId) === "visiting") {
      const start = stack.indexOf(serviceId);
      throw new FpmError("FPM_RUNTIME_DEPENDENCY_CYCLE", "Runtime service requirements contain a cycle.", {
        cycle: [...stack.slice(start), serviceId],
      });
    }
    state.set(serviceId, "visiting");
    stack.push(serviceId);
    for (const dependency of [...(edges.get(serviceId) ?? [])].sort()) visit(dependency);
    stack.pop();
    state.set(serviceId, "done");
    ordered.push(selectedServices.get(serviceId));
  }
  for (const serviceId of [...selectedServices.keys()].sort()) visit(serviceId);

  const record = {
    schema: "fpm.runtime-plan/2",
    activation: {
      id: activation.id,
      package: activation.package,
      accepts: activation.accepts,
      requiredCapabilities: activation.requires,
      deterministicTicks: activation.ticks,
    },
    artifact: {
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
      schema: "fpm.capability-collection-plan/1",
      capability: collection.capability,
      requests: collection.requests.sort((left, right) => left.requestedBy.localeCompare(right.requestedBy)
        || left.required.localeCompare(right.required)),
      memberOrder: collection.memberOrder,
      members: collection.publicMembers,
      exclusions: collection.exclusions,
    })).sort((left, right) => left.capability.localeCompare(right.capability)),
    activationOrder: ordered.map((service) => service.id),
    services: ordered.map(publicService),
  };
  return { activation, ordered, edges, selectedCapabilities, selectedCollections, selectedBindings, record };
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
    this.lifecycle = {
      schema: "fpm.runtime-lifecycle/1",
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
      invariant(values.size === collection.members.length, "FPM_RUNTIME_COLLECTION_INCOMPLETE",
        "A capability collection was requested before every selected member activated.", {
          capability,
          expected: collection.members.map((entry) => entry.provided.member),
          active: [...values.keys()].sort(),
        });
      return immutable({
        schema: "fpm.capability-collection/1",
        capability,
        memberOrder: [...collection.memberOrder],
        members: collection.publicMembers.map((member) => ({
          ...structuredClone(member),
          value: values.get(member.id),
        })),
      });
    }
    const selected = this.capabilities.get(capability);
    invariant(selected, "FPM_RUNTIME_CAPABILITY_INACTIVE", "A runtime capability is not active.", { capability });
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
    return immutable({
      service: { id: service.id, package: service.owner.id },
      artifact: service.artifactAccess === "read" ? this.artifact : null,
      artifactStore,
      options: this.options.serviceOptions ?? {},
      require: (capability) => {
        invariant(declared.has(capability), "FPM_RUNTIME_AUTHORITY_DENIED",
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
        invariant(typeof implementation.createService === "function", "FPM_RUNTIME_SERVICE_INVALID",
          "A runtime service module does not export createService().", { service: service.id, module: service.module });
        const controller = implementation.createService();
        invariant(controller && typeof controller.activate === "function", "FPM_RUNTIME_SERVICE_INVALID",
          "A runtime service controller does not implement activate().", { service: service.id });
        const context = this.contextFor(service);
        const response = await controller.activate(context);
        invariant(response?.protocol === "fpm.runtime-service-response/1"
          && response.capabilities && typeof response.capabilities === "object", "FPM_RUNTIME_SERVICE_INVALID",
        "A runtime service returned an invalid activation response.", { service: service.id });
        for (const provided of service.provides) {
          if (provided.cardinality === "collection") {
            const collection = this.plan.selectedCollections.get(provided.capability);
            const selectedMember = collection?.members.find((entry) => entry.service.id === service.id
              && entry.provided.member === provided.member);
            if (!selectedMember) continue;
            invariant(Object.hasOwn(response.capabilities, provided.capability), "FPM_RUNTIME_SERVICE_INVALID",
              "A runtime service did not publish its selected collection-member capability.", {
                service: service.id,
                capability: provided.capability,
                member: provided.member,
              });
            const values = this.collectionValues.get(provided.capability) ?? new Map();
            invariant(!values.has(provided.member), "FPM_RUNTIME_COLLECTION_MEMBER_DUPLICATE",
              "Two active services attempted to publish one collection-member identity.", {
                capability: provided.capability, member: provided.member, service: service.id,
              });
            values.set(provided.member, response.capabilities[provided.capability]);
            this.collectionValues.set(provided.capability, values);
            continue;
          }
          invariant(Object.hasOwn(response.capabilities, provided.capability), "FPM_RUNTIME_SERVICE_INVALID",
            "A runtime service did not publish a declared capability.", {
              service: service.id,
              capability: provided.capability,
            });
          invariant(!this.capabilities.has(provided.capability), "FPM_RUNTIME_PROVIDER_AMBIGUOUS",
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
      if (error instanceof FpmError) {
        error.details = { ...error.details, lifecycle: { committed: false, activated, rolledBack } };
        throw error;
      }
      if (typeof error?.code === "string") {
        throw new FpmError(error.code, error.message, {
          ...(error.details ?? {}),
          lifecycle: { committed: false, activated, rolledBack },
        });
      }
      throw new FpmError("FPM_RUNTIME_ACTIVATION_FAILED", "A runtime service failed during activation.", {
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
    invariant(options.cascade || dependents.length === 0, "FPM_RUNTIME_DEPENDENTS_ACTIVE",
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
    invariant(this.lifecycle.state === "active", "FPM_RUNTIME_NOT_ACTIVE", "The runtime is not active.");
    const next = this.ticks + 1;
    for (const entry of this.active) {
      if (typeof entry.controller.tick === "function") await entry.controller.tick(next, entry.context);
    }
    this.ticks = next;
    this.lifecycle.ticks = next;
    this.lifecycle.events.push({ event: "tick", tick: next });
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

export async function startRuntime(result, options = {}) {
  const plan = resolveRuntimePlan(result);
  const artifact = JSON.parse(await readFile(result.artifactPath, "utf8"));
  const recordPath = options.recordPath ?? path.join(result.outputDirectory, "runtime-lifecycle.json");
  const artifactStore = new ArtifactStore(result.storeDirectory, {
    protocol: "fpm.artifact-transaction/2",
    facts: {},
    widenedDimensions: [],
  });
  const host = new RuntimeHost(plan, artifact, {
    recordPath,
    artifactStore,
    serviceOptions: {
      snapshotPath: options.snapshotPath ? path.resolve(options.snapshotPath) : null,
      interactive: options.interactive === true,
      openBrowser: options.openBrowser !== false,
      loadSaveId: options.loadSaveId ?? null,
      sessionRecordPath: path.join(result.outputDirectory, "runtime-session.json"),
      interruptSaveBeforePublication: options.interruptSaveBeforePublication === true,
      distributionIdentity: `sha256:${sha256(stableJson(result.lockfile))}`,
      runtimePlanIdentity: `sha256:${sha256(stableJson(plan.record))}`,
      runtimePlan: plan.record,
    },
  });
  await host.activate();
  return host;
}

export async function runRuntime(result, options = {}) {
  const interactive = !options.snapshotPath;
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
  invariant(service || selections.length > 0 || collections.length > 0, "FPM_RUNTIME_EXPLANATION_MISSING",
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
    lifecycle: lifecycle.events.filter((entry) => entry.service === undefined || serviceIds.has(entry.service)),
    state: lifecycle.state,
    committed: lifecycle.committed,
  };
}
