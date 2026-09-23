// SPDX-License-Identifier: MPL-2.0

import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FgpmError, invariant, publicErrorRecord } from "./errors.mjs";
import { hashDirectory, sha256, stableJson } from "./io.mjs";
import { CONTROL_OPERATION_CAPABILITIES, initialCuratorCapabilityProfile } from "./control-capabilities.mjs";
import { PublicRuntimeSessions } from "./public-runtime-sessions.mjs";

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function operationCatalogue() {
  return JSON.parse(await readFile(path.join(projectRoot, "public", "schemas",
    "control-operation-catalogue-v1.json"), "utf8"));
}

function object(value, name = "parameters") {
  invariant(value && typeof value === "object" && !Array.isArray(value), "FGPM_CONTROL_REQUEST_INVALID",
    `Control ${name} must be a JSON object.`, { name });
  return value;
}

function text(value, name) {
  invariant(typeof value === "string" && value.length > 0, "FGPM_CONTROL_REQUEST_INVALID",
    `Control parameter ${name} must be a non-empty string.`, { name });
  return value;
}

function validateRequest(request) {
  object(request, "request");
  invariant(request.schema === "fgpm.control-request/1" && REQUEST_ID.test(request.requestId ?? "")
    && typeof request.operation === "string", "FGPM_CONTROL_REQUEST_INVALID",
  "A control request must declare schema, requestId, operation, and object parameters.", {
    schema: request.schema ?? null, requestId: request.requestId ?? null,
    operation: request.operation ?? null,
  });
  object(request.parameters ?? {});
  return { ...request, parameters: request.parameters ?? {} };
}

function authorityRecord(before, after, basis, movement = null) {
  const managerBefore = before?.managerRoot ?? null;
  const managerAfter = after?.managerRoot ?? null;
  const runtimeBefore = before?.runtimeRoot ?? null;
  const runtimeAfter = after?.runtimeRoot ?? null;
  const managerMoved = movement?.managerMoved ?? managerBefore !== managerAfter;
  const runtimeMoved = movement?.runtimeMoved ?? runtimeBefore !== runtimeAfter;
  return {
    projection: "combined-manager-runtime",
    moved: movement?.moved ?? before?.root !== after?.root,
    managerMoved,
    runtimeMoved,
    before: before?.root ?? null,
    after: after?.root ?? null,
    managerBefore,
    managerAfter,
    runtimeBefore,
    runtimeAfter,
    basis,
  };
}

export class ManagerControlPlane {
  constructor(manager, coordinator) {
    this.manager = manager;
    this.coordinator = coordinator;
    this.responses = new Map();
    this.publicSessions = new PublicRuntimeSessions(coordinator);
    coordinator.beforeOwnedShutdown = () => this.publicSessions.closeAll();
  }

  async authoritySnapshot() {
    let manager = null;
    let runtime = null;
    try {
      if (typeof this.manager?.directory === "string") manager = `sha256:${await hashDirectory(this.manager.directory)}`;
      else if (typeof this.manager?.reachabilityReport === "function") manager = await this.manager.reachabilityReport();
    } catch {}
    try {
      if (typeof this.coordinator?.inspect === "function") runtime = await this.coordinator.inspect();
    } catch {}
    const managerRoot = manager === null ? null : typeof manager === "string"
      ? manager : `sha256:${sha256(stableJson(manager))}`;
    const runtimeRoot = runtime === null ? null : `sha256:${sha256(stableJson(runtime))}`;
    return { managerRoot, runtimeRoot, root: `sha256:${sha256(stableJson({ managerRoot, runtimeRoot }))}` };
  }

  async dispatch(operation, parameters) {
    switch (operation) {
      case "control.describe":
        {
          const catalogue = await operationCatalogue();
        return {
          schema: "fgpm.control-description/1", protocol: "fgpm.control-request/1",
          response: "fgpm.control-response/1", progress: "fgpm.control-event/1",
          operations: CONTROL_OPERATION_CAPABILITIES.map((entry) => entry.operation),
          operationCapabilities: CONTROL_OPERATION_CAPABILITIES,
          operationContracts: catalogue.operations,
          transportReplay: catalogue.transportReplay,
          contractReferences: {
            catalogue: "public/schemas/control-operation-catalogue-v1.json",
            requestEnvelope: "contracts/phase-9/control-v1.schema.json",
            workspaceOperations: "public/schemas/workspace-operation-v1.schema.json",
            lifecycleExample: "guide/runtime-task-v2/control-lifecycle.jsonl",
            lifecycleExpectedResponses: "guide/runtime-task-v2/control-lifecycle-expected.json",
          },
          capabilityProfiles: { initialCurator: initialCuratorCapabilityProfile() },
        };
        }
      case "package.import":
        return this.manager.importPackage(text(parameters.directory, "directory"), {
          source: parameters.source,
        });
      case "package.list": return { schema: "fgpm.package-list/1", packages: await this.manager.listPackages() };
      case "package.registry.inspect":
        invariant(Object.keys(parameters).length === 0, "FGPM_CONTROL_REQUEST_INVALID", "Registry inspection takes no parameters.");
        return this.manager.inspectPackageRegistry();
      case "package.variant-register":
        invariant(Object.keys(parameters).every((key) => ["directory", "expectedRoot", "expectedIndexRoot", "registrationId", "reason", "source"].includes(key)),
          "FGPM_CONTROL_REQUEST_INVALID", "Unknown exact-root registration parameter.");
        return this.manager.registerVariant(text(parameters.directory, "directory"), {
          expectedRoot: text(parameters.expectedRoot, "expectedRoot"),
          registrationId: text(parameters.registrationId, "registrationId"), reason: text(parameters.reason, "reason"),
          source: parameters.source, expectedIndexRoot: parameters.expectedIndexRoot,
        });
      case "workspace.create":
        return this.manager.createWorkspace(text(parameters.name, "name"), {
          baseGeneration: parameters.baseGeneration ?? null, actor: parameters.actor,
        });
      case "workspace.fork":
        return this.manager.forkWorkspace(text(parameters.generation, "generation"),
          text(parameters.name, "name"), { actor: parameters.actor });
      case "workspace.export":
        return this.manager.exportWorkspace(text(parameters.name, "name"), text(parameters.directory, "directory"));
      case "workspace.import":
        return this.manager.importWorkspace(text(parameters.source, "source"));
      case "workspace.status": return this.manager.workspaceStatus(text(parameters.name, "name"));
      case "workspace.history": return {
        schema: "fgpm.workspace-history/1", name: text(parameters.name, "name"),
        revisions: await this.manager.workspaceHistory(parameters.name),
      };
      case "workspace.stage": {
        const operations = parameters.operations ?? (parameters.operation ? [parameters.operation] : null);
        invariant(Array.isArray(operations) && operations.length > 0, "FGPM_CONTROL_REQUEST_INVALID",
          "workspace.stage requires operation or operations.", {});
        return operations.length === 1
          ? this.manager.stageOperation(text(parameters.name, "name"), operations[0], {
            expectedHead: parameters.expectedHead, actor: parameters.actor,
          })
          : this.manager.stageOperations(text(parameters.name, "name"), operations, {
            expectedHead: parameters.expectedHead, actor: parameters.actor,
          });
      }
      case "workspace.plan":
        return this.manager.planCandidate(text(parameters.name, "name"), {
          profilePath: parameters.profilePath, buildIntent: parameters.buildIntent,
          runtimePlan: parameters.runtimePlan,
        });
      case "candidate.explain": return this.manager.explainCandidate(text(parameters.root, "root"));
      case "candidate.build": return this.manager.buildCandidate(text(parameters.root, "root"));
      case "candidate.validate": return this.manager.validateCandidate(text(parameters.root, "root"));
      case "generation.commit":
        return this.manager.commitGeneration(text(parameters.validationRoot, "validationRoot"), {
          name: parameters.name, expectedGenerationRoot: parameters.expectedGenerationRoot,
        });
      case "generation.show": return this.manager.showGeneration(text(parameters.root, "root"));
      case "generation.retained": return {
        schema: "fgpm.retained-generation-list/1", generations: await this.manager.retainedGenerationRoots(),
      };
      case "generation.active": return this.coordinator.activeState();
      case "generation.activate":
        return this.coordinator.transition(text(parameters.root, "root"));
      case "generation.rollback":
        return this.coordinator.rollback(text(parameters.root, "root"));
      case "generation.clear-stale":
        return this.coordinator.clearStale(text(parameters.session, "session"));
      case "runtime.inspect": return this.coordinator.inspect();
      case "runtime.session.open": return this.publicSessions.open(parameters);
      case "runtime.session.call": return this.publicSessions.call(parameters);
      case "runtime.session.close": return this.publicSessions.close(parameters);
      case "runtime.tick": return this.coordinator.tick(parameters.count ?? 1);
      case "runtime.checkpoint": return this.coordinator.checkpoint(text(parameters.saveId, "saveId"));
      case "runtime.resume":
        return this.coordinator.resume(text(parameters.generation, "generation"),
          text(parameters.checkpoint, "checkpoint"));
      case "runtime.shutdown": {
        const lifecycle = await this.coordinator.shutdown();
        return { schema: "fgpm.runtime-shutdown-result/1", lifecycle,
          active: await this.coordinator.activeState() };
      }
      case "distribution.export":
        return this.manager.exportDistribution(text(parameters.generation, "generation"),
          text(parameters.directory, "directory"));
      case "distribution.import":
        return this.manager.importDistribution(text(parameters.directory, "directory"));
      case "distribution.verify":
        return this.manager.verifyDistribution(text(parameters.directory, "directory"));
      case "manager.reachability": return this.manager.reachabilityReport();
      case "control.stop": {
        const lifecycle = await this.coordinator.shutdown();
        return { schema: "fgpm.control-stop-result/1", lifecycle,
          active: await this.coordinator.activeState(), stop: true };
      }
      default:
        throw new FgpmError("FGPM_CONTROL_OPERATION_UNKNOWN", "The control operation is unknown.", { operation });
    }
  }

  async handle(input, emit) {
    let request;
    try {
      request = validateRequest(input);
    } catch (error) {
      const response = {
        schema: "fgpm.control-response/1", requestId: input?.requestId ?? null,
        operation: input?.operation ?? null, state: "failed", ok: false,
        authority: authorityRecord(null, null, "request-rejected-before-dispatch",
          { moved: false, managerMoved: false, runtimeMoved: false }),
        diagnostic: publicErrorRecord(error),
      };
      emit(response);
      return response;
    }
    const fingerprint = sha256(stableJson(request));
    const prior = this.responses.get(request.requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        const current = await this.authoritySnapshot();
        const response = {
          schema: "fgpm.control-response/1", requestId: request.requestId,
          operation: request.operation, state: "failed", ok: false,
          authority: authorityRecord(current, current, "request-id-conflict-before-dispatch",
            { moved: false, managerMoved: false, runtimeMoved: false }),
          diagnostic: publicErrorRecord(new FgpmError("FGPM_CONTROL_REQUEST_ID_CONFLICT",
            "A request identity was reused for different content.", { requestId: request.requestId })),
        };
        emit(response);
        return response;
      }
      const replay = {
        ...prior.response,
        replay: true,
        transportReplay: {
          replayed: true,
          dispatched: false,
          authorityMoved: false,
          originalRequestId: prior.response.requestId,
          canonicalRequestRoot: `sha256:${fingerprint}`,
        },
      };
      emit(replay);
      return replay;
    }
    emit({
      schema: "fgpm.control-event/1", requestId: request.requestId,
      operation: request.operation, state: "started", current: request.operation,
    });
    const before = await this.authoritySnapshot();
    let response;
    try {
      const result = await this.dispatch(request.operation, request.parameters);
      const after = await this.authoritySnapshot();
      response = {
        schema: "fgpm.control-response/1", requestId: request.requestId,
        operation: request.operation, state: "completed", ok: true,
        authority: authorityRecord(before, after, "before-after-authority-snapshot"),
        result,
      };
    } catch (error) {
      const after = await this.authoritySnapshot();
      response = {
        schema: "fgpm.control-response/1", requestId: request.requestId,
        operation: request.operation, state: "failed", ok: false,
        authority: authorityRecord(before, after, "before-after-authority-snapshot"),
        diagnostic: publicErrorRecord(error),
      };
    }
    this.responses.set(request.requestId, { fingerprint, response });
    emit(response);
    return response;
  }
}

export async function runControlPlane(manager, coordinator, options = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const emit = (value) => output.write(`${JSON.stringify(value)}\n`);
  const control = new ManagerControlPlane(manager, coordinator);
  const lines = createInterface({ input, crlfDelay: Infinity });
  let stopped = false;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let request;
      try {
        invariant(Buffer.byteLength(line, "utf8") <= 1024 * 1024, "FGPM_CONTROL_REQUEST_TOO_LARGE",
          "A control request exceeds the one-megabyte input limit.", {});
        request = JSON.parse(line);
      } catch (error) {
        emit({
          schema: "fgpm.control-response/1", requestId: null, operation: null,
          state: "failed", ok: false,
          authority: authorityRecord(null, null, "request-rejected-before-dispatch",
            { moved: false, managerMoved: false, runtimeMoved: false }),
          diagnostic: publicErrorRecord(error instanceof SyntaxError
            ? new FgpmError("FGPM_CONTROL_JSON_MALFORMED", "A control request is not valid JSON.", {}) : error),
        });
        continue;
      }
      const response = await control.handle(request, emit);
      if (response.ok && response.result?.stop === true) {
        stopped = true;
        break;
      }
    }
  } finally {
    if (!stopped) await coordinator.shutdown();
  }
  return control;
}
