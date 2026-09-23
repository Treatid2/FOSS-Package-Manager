// SPDX-License-Identifier: MPL-2.0

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { FgpmError, invariant } from "./errors.mjs";
import { sha256, stableJson, writeJson } from "./io.mjs";
import { validatePhase9Record } from "./phase9-contracts.mjs";
import { startCommittedRuntime, startRuntime } from "./runtime.mjs";

async function exists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeReplace(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, stableJson(value), "utf8");
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

function checkpointFragments(checkpoint) {
  return checkpoint?.fragments ?? checkpoint?.manifest?.fragments ?? [];
}

function ownerIdentity(fragment) {
  return fragment.member ?? fragment.owner ?? fragment.stateOwner ?? null;
}

export function phase8RuntimeFactory(buildResult, options = {}) {
  return async ({ checkpoint }) => {
    const host = await startRuntime(buildResult, {
      ...options,
      loadSaveId: checkpoint?.saveId ?? null,
    });
    return {
      schema: "fgpm.phase-8-runtime-adapter/1",
      host,
      async checkpoint(saveId) {
        return host.capability("runtime.persistence.world").save(saveId);
      },
      async commit() {
        return {
          lifecycleState: host.lifecycle.state,
          lifecycleCommitted: host.lifecycle.committed,
          ticks: host.lifecycle.ticks,
          runtimePlan: host.plan.record,
        };
      },
      async shutdown() {
        return host.shutdown();
      },
    };
  };
}

export function generationRuntimeFactory(manager, generationRoot, options = {}) {
  return async ({ checkpoint }) => {
    const committed = await manager.generationRuntimeClosure(generationRoot);
    const host = await startCommittedRuntime(committed, {
      ...options,
      loadSaveId: checkpoint?.saveId ?? null,
    });
    return {
      schema: "fgpm.generation-bound-runtime-adapter/1",
      host,
      async checkpoint(saveId) {
        return host.capability("runtime.persistence.world").save(saveId);
      },
      async commit() {
        return {
          lifecycleState: host.lifecycle.state,
          lifecycleCommitted: host.lifecycle.committed,
          ticks: host.lifecycle.ticks,
          runtimePlan: host.plan.record,
        };
      },
      async shutdown() {
        return host.shutdown();
      },
    };
  };
}

export class GenerationRuntimeCoordinator {
  constructor(manager, options = {}) {
    this.manager = manager;
    this.factories = new Map();
    this.current = null;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.runtimeOptions = options.runtimeOptions ?? {};
    this.allowTestFactories = options.allowTestFactories === true;
    this.checkpointSequence = 0;
  }

  register(generationRoot, factory) {
    invariant(this.allowTestFactories, "FGPM_RUNTIME_TEST_FACTORY_FORBIDDEN",
      "Runtime factory registration is an explicit internal/test-only fixture seam.", {
        generation: generationRoot, reason: "test-factory-option-required",
      });
    invariant(typeof factory === "function", "FGPM_RUNTIME_FACTORY_INVALID",
      "A generation runtime factory must be callable.", { generation: generationRoot });
    this.factories.set(generationRoot, factory);
    return this;
  }

  activeReferencePath() {
    return path.join(this.manager.directory, "runtime", "active.json");
  }

  async activeReference() {
    if (!await exists(this.activeReferencePath())) return null;
    const reference = JSON.parse(await readFile(this.activeReferencePath(), "utf8"));
    validatePhase9Record(reference, this.activeReferencePath());
    invariant(reference.schema === "fgpm.active-generation-reference/1"
      && typeof reference.generation === "string" && typeof reference.session === "string",
    "FGPM_ACTIVE_GENERATION_REFERENCE_INVALID", "The active-generation reference is malformed.", { reference });
    return reference;
  }

  async activeState() {
    const active = await this.activeReference();
    return {
      schema: "fgpm.active-generation-state/1",
      status: active === null ? "stopped" : this.current?.session === active.session ? "live" : "stale",
      ownedByCurrentProcess: active !== null && this.current?.session === active.session,
      active,
      recoveryOperation: active !== null && this.current?.session !== active.session
        ? "generation.clear-stale" : null,
    };
  }

  async clearStale(expectedSession) {
    invariant(!this.current, "FGPM_RUNTIME_SESSION_ALREADY_OWNED",
      "A live runtime owned by this control process cannot be cleared as stale.", {
        generation: this.current?.generation ?? null, session: this.current?.session ?? null,
      });
    const active = await this.activeReference();
    invariant(active, "FGPM_ACTIVE_GENERATION_REFERENCE_MISSING",
      "There is no stale active-generation reference to clear.", {});
    invariant(typeof expectedSession === "string" && expectedSession === active.session,
      "FGPM_STALE_SESSION_IDENTITY_MISMATCH",
      "Stale recovery requires the exact durable session identity.", {
        expectedSession: active.session, suppliedSession: expectedSession ?? null,
      });
    await rm(this.activeReferencePath(), { force: true });
    return {
      schema: "fgpm.stale-generation-clear-result/1", status: "cleared",
      generation: active.generation, session: active.session, active: null,
    };
  }

  preflight(generation, checkpoint) {
    const targetOwners = new Map((generation.stateOwners ?? generation.runtimePlan?.stateOwners ?? [])
      .map((entry) => [entry.id, entry]));
    const retainedOpaque = [];
    const missingRequired = [];
    for (const fragment of checkpointFragments(checkpoint)) {
      const owner = ownerIdentity(fragment);
      if (!owner || targetOwners.has(owner)) continue;
      if (fragment.required === true) missingRequired.push(owner);
      else retainedOpaque.push({ owner, semanticSchema: fragment.semanticSchema ?? null,
        schemaVersion: fragment.schemaVersion ?? null, root: fragment.root ?? null });
    }
    invariant(missingRequired.length === 0, "FGPM_GENERATION_REQUIRED_STATE_OWNER_MISSING",
      "A required state fragment has no owner in the replacement generation.", {
        generation: generation.identity, missingRequired: missingRequired.sort(),
      });
    return {
      schema: "fgpm.generation-transition-preflight/1",
      generation: generation.identity,
      stateOwners: [...targetOwners.keys()].sort(),
      retainedOpaque: retainedOpaque.sort((a, b) => a.owner.localeCompare(b.owner)),
      transitionClass: "unclassified-generation-activation",
    };
  }

  async transition(generationRoot, options = {}) {
    const semanticOverrides = Object.keys(options).filter((key) => !["checkpointId", "reason"].includes(key));
    invariant(semanticOverrides.length === 0, "FGPM_GENERATION_SEMANTIC_OVERRIDE_FORBIDDEN",
      "Generation activation accepts no independent package, profile, artifact, provider, or runtime-plan input.", {
        generation: generationRoot, fields: semanticOverrides.sort(),
      });
    const targetGeneration = await this.manager.showGeneration(generationRoot);
    const targetFactory = this.factories.get(generationRoot)
      ?? generationRuntimeFactory(this.manager, generationRoot, this.runtimeOptions);
    const before = await this.activeReference();
    invariant(!before || this.current?.session === before.session,
      "FGPM_ACTIVE_RUNTIME_SESSION_STALE",
      "The durable active generation is stale because this control process does not own its runtime session.", {
        active: before, status: "stale", recoveryOperation: "generation.clear-stale",
      });

    let checkpoint = null;
    let checkpointRecord = null;
    let preflight = this.preflight(targetGeneration, null);
    const previous = this.current;
    const transitionClass = previous === null
      ? "initial-activation"
      : previous.generation === generationRoot
        ? "same-generation-reactivation"
        : options.reason === "explicit-rollback"
          ? "distinct-generation-rollback"
          : "distinct-generation-transition";
    preflight.transitionClass = transitionClass;
    if (previous) {
      const saveId = options.checkpointId ?? `save:phase-9/${sha256(`${previous.generation}\0${generationRoot}\0${this.checkpointSequence += 1}`).slice(0, 24)}`;
      checkpoint = await previous.controller.checkpoint(saveId);
      preflight = this.preflight(targetGeneration, checkpoint);
      preflight.transitionClass = transitionClass;
      checkpointRecord = await this.manager.writeImmutable("runtime/checkpoints", {
        schema: "fgpm.generation-transition-checkpoint/1", version: 1,
        fromGeneration: previous.generation, toGeneration: generationRoot,
        saveId: checkpoint.saveId, root: checkpoint.root ?? null,
        fragments: checkpointFragments(checkpoint),
      }, {
        schema: "fgpm.generation-transition-checkpoint/1", version: 1,
        fromGeneration: previous.generation, toGeneration: generationRoot,
        saveId: checkpoint.saveId, root: checkpoint.root ?? null,
        fragments: checkpointFragments(checkpoint),
      });
      await this.beforeOwnedShutdown?.();
      await previous.controller.shutdown();
    }

    let targetController;
    try {
      targetController = await targetFactory({ generation: targetGeneration, checkpoint, preflight });
      const committed = await targetController.commit();
      const sessionNonce = randomUUID();
      const session = await this.manager.writeImmutable("runtime/sessions", {
        schema: "fgpm.runtime-generation-session/1", version: 1, generation: generationRoot,
        runtimePlanRoot: targetGeneration.roots?.runtimePlan
          ?? `sha256:${sha256(stableJson(targetGeneration.runtimePlan))}`,
        checkpoint: checkpointRecord?.identity ?? null, nonce: sessionNonce,
        reason: options.reason ?? (before ? "generation-transition" : "initial-activation"),
      }, {
        schema: "fgpm.runtime-generation-session/1", version: 1, generation: generationRoot,
        runtimePlanRoot: targetGeneration.roots?.runtimePlan
          ?? `sha256:${sha256(stableJson(targetGeneration.runtimePlan))}`,
        checkpoint: checkpointRecord?.identity ?? null, preflight, committed,
        priorSession: before?.session ?? null, failedAttempt: null,
        reason: options.reason ?? (before ? "generation-transition" : "initial-activation"),
      });
      const reference = {
        schema: "fgpm.active-generation-reference/1", version: 1,
        generation: generationRoot, session: session.identity, movedAt: this.clock(),
      };
      validatePhase9Record(reference, this.activeReferencePath());
      await writeReplace(this.activeReferencePath(), reference);
      this.current = { generation: generationRoot, controller: targetController, factory: targetFactory,
        session: session.identity };
      return { schema: "fgpm.generation-transition/1", status: "committed", from: before?.generation ?? null,
        to: generationRoot, checkpoint: checkpointRecord?.identity ?? null, session: session.identity,
        transitionClass, active: reference, preflight };
    } catch (error) {
      if (targetController) {
        try { await targetController.shutdown(); } catch {}
      }
      let rollback = null;
      const failedAttempt = await this.manager.writeImmutable("runtime/attempts", {
        schema: "fgpm.generation-transition-attempt/1", version: 1,
        fromGeneration: before?.generation ?? null, toGeneration: generationRoot,
        checkpoint: checkpointRecord?.identity ?? null, priorSession: before?.session ?? null,
        status: "failed", cause: error.message,
      }, {
        schema: "fgpm.generation-transition-attempt/1", version: 1,
        fromGeneration: before?.generation ?? null, toGeneration: generationRoot,
        checkpoint: checkpointRecord?.identity ?? null, priorSession: before?.session ?? null,
        status: "failed", cause: error.message,
      });
      if (previous) {
        try {
          const priorGeneration = await this.manager.showGeneration(previous.generation);
          const rollbackPreflight = this.preflight(priorGeneration, checkpoint);
          const restored = await previous.factory({
            generation: priorGeneration, checkpoint, preflight: rollbackPreflight,
          });
          const committed = await restored.commit();
          const rollbackSession = await this.manager.writeImmutable("runtime/sessions", {
            schema: "fgpm.runtime-generation-session/1", version: 1, generation: previous.generation,
            runtimePlanRoot: priorGeneration.roots?.runtimePlan
              ?? `sha256:${sha256(stableJson(priorGeneration.runtimePlan))}`,
            checkpoint: checkpointRecord?.identity ?? null, priorSession: before?.session ?? previous.session,
            failedAttempt: failedAttempt.identity, reason: "automatic-rollback", nonce: randomUUID(),
          }, {
            schema: "fgpm.runtime-generation-session/1", version: 1, generation: previous.generation,
            runtimePlanRoot: priorGeneration.roots?.runtimePlan
              ?? `sha256:${sha256(stableJson(priorGeneration.runtimePlan))}`,
            checkpoint: checkpointRecord?.identity ?? null, preflight: rollbackPreflight, committed,
            priorSession: before?.session ?? previous.session, failedAttempt: failedAttempt.identity,
            reason: "automatic-rollback",
          });
          const rollbackReference = {
            schema: "fgpm.active-generation-reference/1", version: 1,
            generation: previous.generation, session: rollbackSession.identity, movedAt: this.clock(),
          };
          validatePhase9Record(rollbackReference, this.activeReferencePath());
          await writeReplace(this.activeReferencePath(), rollbackReference);
          this.current = { ...previous, controller: restored, session: rollbackSession.identity };
          rollback = { status: "restored", generation: previous.generation, committed,
            session: rollbackSession.identity, active: rollbackReference };
        } catch (rollbackError) {
          this.current = null;
          rollback = { status: "failed", generation: previous.generation, error: rollbackError.message };
        }
      }
      const activeAfter = await this.activeReference();
      const details = {
        from: before?.generation ?? null, attempted: generationRoot,
        checkpoint: checkpointRecord?.identity ?? null, rollback, active: activeAfter,
        failedAttempt: failedAttempt.identity, cause: error.message,
      };
      await writeJson(path.join(this.manager.directory, "events", `${Date.now()}-${randomUUID()}.json`), {
        schema: "fgpm.generation-transition-failure/1", ...details, recordedAt: this.clock(),
      });
      throw new FgpmError("FGPM_GENERATION_TRANSITION_FAILED",
        "The replacement generation did not commit; rollback evidence was retained.", details);
    }
  }

  async rollback(generationRoot, options = {}) {
    const active = await this.activeReference();
    const ownsActive = Boolean(active && this.current?.session === active.session
      && this.current?.generation === active.generation);
    invariant(!active || ownsActive,
      "FGPM_ACTIVE_RUNTIME_SESSION_STALE",
      "The durable active generation is stale because this control process does not own its runtime session.", {
        active, status: "stale", recoveryOperation: "generation.clear-stale",
      });
    invariant(ownsActive,
      "FGPM_GENERATION_ROLLBACK_SESSION_REQUIRED",
      "Generation rollback requires a live runtime session owned by this control process; use generation.activate to start a stopped runtime.", {
        active, currentGeneration: this.current?.generation ?? null,
        currentSession: this.current?.session ?? null,
      });
    invariant(this.current.generation !== generationRoot,
      "FGPM_GENERATION_ROLLBACK_TARGET_UNCHANGED",
      "Generation rollback requires a different retained generation; reactivate the same generation with generation.activate.",
      { current: this.current.generation, target: generationRoot });
    return this.transition(generationRoot, { ...options, reason: "explicit-rollback" });
  }

  async inspect() {
    const active = await this.activeReference();
    const host = this.current?.controller?.host ?? null;
    const instances = host
      ? host.capability("runtime.instances.read").list()
        .map(({ instanceId, definitionId, materialized, transform }) => ({
          instanceId, definitionId, materialized, transform,
        }))
      : [];
    return {
      schema: "fgpm.runtime-inspection/1",
      active,
      live: Boolean(this.current),
      ownership: active === null ? "stopped" : this.current?.session === active.session ? "live" : "stale",
      recoveryOperation: active !== null && this.current?.session !== active.session
        ? "generation.clear-stale" : null,
      generation: this.current?.generation ?? active?.generation ?? null,
      session: this.current?.session ?? active?.session ?? null,
      lifecycle: host ? structuredClone(host.lifecycle) : null,
      instances,
    };
  }

  async tick(count = 1) {
    invariant(this.current, "FGPM_ACTIVE_RUNTIME_SESSION_UNAVAILABLE",
      "No live runtime session is owned by this control process.", { active: await this.activeReference() });
    invariant(Number.isInteger(count) && count > 0 && count <= 10_000, "FGPM_RUNTIME_TICK_COUNT_INVALID",
      "A runtime tick request requires an integer from 1 through 10000.", { count });
    for (let index = 0; index < count; index += 1) await this.current.controller.host.tick();
    return this.inspect();
  }

  async checkpoint(saveId) {
    invariant(this.current, "FGPM_ACTIVE_RUNTIME_SESSION_UNAVAILABLE",
      "No live runtime session is owned by this control process.", { active: await this.activeReference() });
    invariant(typeof saveId === "string" && saveId.length > 0, "FGPM_RUNTIME_SAVE_ID_INVALID",
      "A runtime checkpoint requires a non-empty save identity.", { saveId });
    const checkpoint = await this.current.controller.checkpoint(saveId);
    const identityInputs = {
      schema: "fgpm.generation-transition-checkpoint/1", version: 1,
      fromGeneration: this.current.generation, toGeneration: this.current.generation,
      saveId: checkpoint.saveId,
      root: checkpoint.root ?? null, fragments: checkpointFragments(checkpoint),
    };
    const checkpointIdentity = `sha256:${sha256(stableJson(identityInputs))}`;
    const alreadyPublished = await exists(this.manager.immutablePath("runtime/checkpoints", checkpointIdentity));
    const record = await this.manager.writeImmutable("runtime/checkpoints", identityInputs, {
      schema: "fgpm.generation-transition-checkpoint/1", version: 1,
      fromGeneration: this.current.generation, toGeneration: this.current.generation,
      saveId: checkpoint.saveId,
      root: checkpoint.root ?? null, fragments: checkpointFragments(checkpoint),
    });
    return {
      schema: "fgpm.generation-runtime-checkpoint-result/1",
      checkpoint: record,
      publication: {
        class: alreadyPublished ? "idempotent-reuse" : "first-publication",
        saveId: checkpoint.saveId,
        checkpointIdentity: record.identity,
        contentRoot: checkpoint.root ?? null,
      },
    };
  }

  async resume(generationRoot, checkpointRoot) {
    invariant(!this.current, "FGPM_RUNTIME_SESSION_ALREADY_OWNED",
      "This control process already owns a live runtime session.", { generation: this.current?.generation });
    const before = await this.activeReference();
    invariant(before === null || before.generation === generationRoot, "FGPM_RUNTIME_RESUME_GENERATION_MISMATCH",
      "Runtime resume cannot replace a different durable active generation.", {
        requested: generationRoot, active: before?.generation ?? null,
      });
    const checkpointRecord = await this.manager.readImmutable(
      "runtime/checkpoints", checkpointRoot, "fgpm.generation-transition-checkpoint/1");
    invariant(checkpointRecord.fromGeneration === generationRoot
      && checkpointRecord.toGeneration === generationRoot, "FGPM_RUNTIME_RESUME_CHECKPOINT_MISMATCH",
      "The checkpoint does not belong to the requested generation.", {
        requested: generationRoot, checkpointFrom: checkpointRecord.fromGeneration,
        checkpointTo: checkpointRecord.toGeneration,
      });
    const generation = await this.manager.showGeneration(generationRoot);
    const factory = this.factories.get(generationRoot)
      ?? generationRuntimeFactory(this.manager, generationRoot, this.runtimeOptions);
    const checkpoint = {
      saveId: checkpointRecord.saveId,
      root: checkpointRecord.root,
      fragments: checkpointRecord.fragments,
    };
    const preflight = this.preflight(generation, checkpoint);
    let controller;
    try {
      controller = await factory({ generation, checkpoint, preflight });
      const committed = await controller.commit();
      const session = await this.manager.writeImmutable("runtime/sessions", {
        schema: "fgpm.runtime-generation-session/1", version: 1, generation: generationRoot,
        runtimePlanRoot: generation.roots?.runtimePlan
          ?? `sha256:${sha256(stableJson(generation.runtimePlan))}`,
        checkpoint: checkpointRoot, priorSession: before?.session ?? null, failedAttempt: null,
        reason: "process-resume", nonce: randomUUID(),
      }, {
        schema: "fgpm.runtime-generation-session/1", version: 1, generation: generationRoot,
        runtimePlanRoot: generation.roots?.runtimePlan
          ?? `sha256:${sha256(stableJson(generation.runtimePlan))}`,
        checkpoint: checkpointRoot, preflight, committed, priorSession: before?.session ?? null,
        failedAttempt: null, reason: "process-resume",
      });
      const reference = {
        schema: "fgpm.active-generation-reference/1", version: 1,
        generation: generationRoot, session: session.identity, movedAt: this.clock(),
      };
      validatePhase9Record(reference, this.activeReferencePath());
      await writeReplace(this.activeReferencePath(), reference);
      this.current = { generation: generationRoot, controller, factory, session: session.identity };
      return {
        schema: "fgpm.generation-resume/1", status: "committed", generation: generationRoot,
        checkpoint: checkpointRoot, session: session.identity, active: reference, preflight,
      };
    } catch (error) {
      if (controller) {
        try { await controller.shutdown(); } catch {}
      }
      throw error;
    }
  }

  async shutdown() {
    if (!this.current) return null;
    const owned = this.current;
    await this.beforeOwnedShutdown?.();
    const lifecycle = await owned.controller.shutdown();
    const active = await this.activeReference();
    if (active?.session === owned.session) await rm(this.activeReferencePath(), { force: true });
    this.current = null;
    return lifecycle;
  }
}
