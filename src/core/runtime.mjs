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
  const selectedCapabilities = new Map();
  const selectedBindings = new Map();
  const selectedServices = new Map();
  const edges = new Map();
  const selections = [];

  function select(requirement, requestedBy) {
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
      return previous.service;
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
      return null;
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
    if (requirement.binding) {
      const bound = selectedBindings.get(requirement.binding);
      invariant(!bound || bound.service.id === selected.service.id, "FPM_RUNTIME_PROVIDER_BINDING_CONFLICT",
        "Capabilities bound to one provider instance resolved to different services.", {
          binding: requirement.binding,
          existingProvider: bound?.service.id ?? null,
          proposedProvider: selected.service.id,
          capability: requirement.capability,
          requestedBy,
        });
      selectedBindings.set(requirement.binding, selected);
    }
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
    if (!selectedServices.has(selected.service.id)) {
      selectedServices.set(selected.service.id, selected.service);
      edges.set(selected.service.id, new Set());
      for (const dependency of [...selected.service.requires]
        .sort((left, right) => left.capability.localeCompare(right.capability))) {
        const provider = select(dependency, selected.service.id);
        if (provider) edges.get(selected.service.id).add(provider.id);
      }
    }
    return selected.service;
  }

  for (const requirement of [...activation.requires]
    .sort((left, right) => left.capability.localeCompare(right.capability))) {
    select(requirement, activation.id);
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
    schema: "fpm.runtime-plan/1",
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
    activationOrder: ordered.map((service) => service.id),
    services: ordered.map(publicService),
  };
  return { activation, ordered, edges, selectedCapabilities, selectedBindings, record };
}

export class RuntimeHost {
  constructor(plan, artifact, options = {}) {
    this.plan = plan;
    this.artifact = immutable(structuredClone(artifact));
    this.options = options;
    this.capabilities = new Map();
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
  invariant(service || selections.length > 0, "FPM_RUNTIME_EXPLANATION_MISSING",
    "No runtime service or capability matches the requested explanation target.", { target });
  const serviceIds = new Set([service?.id, ...selections.map((entry) => entry.provider)].filter(Boolean));
  return {
    target,
    service: service ?? null,
    selections,
    lifecycle: lifecycle.events.filter((entry) => entry.service === undefined || serviceIds.has(entry.service)),
    state: lifecycle.state,
    committed: lifecycle.committed,
  };
}
