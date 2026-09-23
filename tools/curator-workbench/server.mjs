// SPDX-License-Identifier: MPL-2.0

import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ControlClient, ControlError } from "./control-client.mjs";
import {
  authorizeClientOperation,
  clientProfileForPath,
  workbenchClientAuthorityDescription,
} from "./client-authority.mjs";
import { replayPublicJournal } from "./journal.mjs";
import { loadWorkbenchProject, optionalJson, projectPath, readJson } from "./project.mjs";

const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
const defaultManagerRoot = path.resolve(moduleRoot, "../..");
const publicRoot = path.join(moduleRoot, "public");
const CONFIRMED_OPERATIONS = new Set(["generation.activate", "generation.rollback", "runtime.resume"]);
const MUTATING_OPERATIONS = new Set([
  "package.import", "workspace.create", "workspace.fork", "workspace.export", "workspace.import", "workspace.stage", "workspace.plan",
  "candidate.build", "candidate.validate", "generation.commit", "generation.activate", "generation.rollback",
  "runtime.tick", "runtime.checkpoint", "runtime.resume", "runtime.shutdown", "distribution.export",
  "distribution.import",
]);

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function json(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function diagnostic(error) {
  return error instanceof ControlError
    ? { code: error.code, message: error.message, details: error.details }
    : { code: error.code ?? "FGPM_WORKBENCH_FAILED", message: error.message, details: error.details ?? {} };
}

async function body(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw Object.assign(new Error("Request body exceeds one megabyte."), {
      code: "FGPM_WORKBENCH_REQUEST_TOO_LARGE",
    });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch (error) {
    throw Object.assign(new Error("Request body must be valid JSON."), {
      code: "FGPM_WORKBENCH_REQUEST_MALFORMED", details: { cause: error.message },
    });
  }
}

async function staticFile(response, file, contentType) {
  try {
    const content = await readFile(file);
    response.writeHead(200, {
      "content-type": contentType, "cache-control": "no-store", "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    response.end(content);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
  }
}

async function listen(server, options) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve);
  });
  const address = server.address();
  return `http://${address.address}:${address.port}/`;
}

async function startBoundaryDiagnostic(options, error) {
  const failure = diagnostic(error);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/api/health") {
      json(response, 422, { schema: "fgpm.curator-workbench-health/1", status: "invalid-project",
        diagnostic: failure });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/overview") {
      json(response, 422, { ok: false, state: "failed", diagnostic: failure });
      return;
    }
    const staticRoutes = new Map([
      ["/", ["index.html", "text/html; charset=utf-8"]],
      ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
      ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
    ]);
    if (request.method === "GET" && staticRoutes.has(url.pathname)) {
      const [file, type] = staticRoutes.get(url.pathname);
      await staticFile(response, path.join(publicRoot, file), type); return;
    }
    json(response, 409, { ok: false, state: "failed", diagnostic: failure });
  });
  const url = await listen(server, options);
  return {
    url, server, control: null, project: null, diagnostic: failure,
    async close() { await new Promise((resolve) => server.close(resolve)); },
  };
}

function resolveRelativeParameters(projectRoot, parameters, relativePaths = []) {
  const resolved = structuredClone(parameters ?? {});
  for (const pointer of relativePaths) {
    const segments = pointer.split(".");
    let current = resolved;
    for (const segment of segments.slice(0, -1)) current = current?.[segment];
    const key = segments.at(-1);
    if (!current || typeof current[key] !== "string") {
      throw Object.assign(new Error(`Relative path parameter ${pointer} is missing.`), {
        code: "FGPM_WORKBENCH_REQUEST_INVALID", details: { pointer },
      });
    }
    current[key] = projectPath(projectRoot, current[key], `action parameter ${pointer}`);
  }
  return resolved;
}

export function compareExactBuildEnvironment(exactBuild, current) {
  if (!exactBuild) return null;
  const target = exactBuild.target;
  const dimensions = ["platform", "architecture", "node", "managerBuildIdentity", "protocol"];
  const mismatches = dimensions.filter((dimension) => target[dimension] !== current[dimension])
    .map((dimension) => ({ dimension, target: target[dimension], current: current[dimension] ?? null }));
  return {
    schema: "fgpm.workbench-exact-build-preflight/1", release: exactBuild.release,
    target, current, compatible: mismatches.length === 0, mismatches, expected: exactBuild.expected,
    availableActions: {
      importedReleaseActivation: true,
      exactSourceRebuild: mismatches.length === 0,
      deliberateNewGeneration: true,
    },
  };
}

export async function startWorkbench(options = {}) {
  if (!options.projectRoot) throw new Error("startWorkbench requires projectRoot.");
  const managerRoot = path.resolve(options.managerRoot ?? defaultManagerRoot);
  let project;
  try { project = await loadWorkbenchProject(path.resolve(options.projectRoot)); }
  catch (error) { return startBoundaryDiagnostic(options, error); }
  const { descriptor, fixture, journal, root: projectRoot } = project;
  const managerManifest = await readJson(path.join(managerRoot, "manager.json"));
  const currentEnvironment = {
    platform: process.platform, architecture: process.arch, node: process.version,
    managerBuildIdentity: managerManifest.buildIdentity,
    protocol: "fgpm.artifact-transaction/2",
    ...(options.currentEnvironment ?? {}),
  };
  const exactBuild = compareExactBuildEnvironment(descriptor.exactBuild, currentEnvironment);
  let managerCommit = null;
  try { managerCommit = execFileSync("git", ["-C", managerRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); }
  catch {}
  const managerMatches = managerCommit === descriptor.manager.preferred.commit;
  const managerStore = path.resolve(options.managerStore
    ?? projectPath(projectRoot, descriptor.paths.managerStore, "paths.managerStore"));
  const snapshot = projectPath(projectRoot, descriptor.paths.workbenchSnapshot, "paths.workbenchSnapshot");
  const progress = [];
  const actionTrace = [];
  const managerDispatches = [];
  const latest = {};
  const clientAuthority = workbenchClientAuthorityDescription();
  const control = new ControlClient(managerRoot, {
    managerStore, snapshotPath: snapshot,
    onProgress: (entry) => {
      progress.push(entry);
      if (progress.length > 200) progress.shift();
    },
  });
  const dispatch = async (operation, parameters = {}, requestId = null) => {
    managerDispatches.push({ at: new Date().toISOString(), operation, requestId });
    if (managerDispatches.length > 1000) managerDispatches.shift();
    return control.request(operation, parameters, requestId);
  };
  const safe = async (operation, parameters = {}) => {
    try { return { ok: true, value: await dispatch(operation, parameters) }; }
    catch (error) { return { ok: false, diagnostic: diagnostic(error) }; }
  };
  const recordAction = (entry) => {
    actionTrace.push({ at: new Date().toISOString(), ...entry });
    if (actionTrace.length > 500) actionTrace.shift();
  };
  const mutationMismatch = (response, operation) => {
    json(response, 409, { ok: false, diagnostic: {
      code: "FGPM_WORKBENCH_MANAGER_CONTRACT_MISMATCH",
      message: "Mutation is blocked because the configured manager does not match the project descriptor.",
      details: { expectedCommit: descriptor.manager.preferred.commit, actualCommit: managerCommit, operation },
    } });
  };
  const exactBuildMismatch = (response, operation) => {
    json(response, 409, { ok: false, diagnostic: {
      code: "FGPM_WORKBENCH_TARGET_ENVIRONMENT_MISMATCH",
      message: "Exact source rebuild is unavailable because the current host does not match the declared release target.",
      details: { operation, release: exactBuild.release, mismatches: exactBuild.mismatches,
        availableActions: exactBuild.availableActions },
    } });
  };
  const denyClientOperation = (response, input, authorization) => {
    const classification = authorization.capability ? {
      category: authorization.capability.category,
      maturity: authorization.capability.maturity,
      guidedHuman: authorization.capability.guidedHuman,
      agentAllowed: authorization.capability.agentAllowed,
      authorityMoving: authorization.capability.authorityMoving,
    } : null;
    const failure = {
      code: "FGPM_WORKBENCH_OPERATION_NOT_ALLOWED",
      message: "The server-bound client profile does not permit this operation.",
      details: {
        profile: authorization.profile?.id ?? null,
        operation: input.operation ?? null,
        classification,
        reason: authorization.reason,
      },
    };
    recordAction({ profile: authorization.profile?.id ?? null,
      surface: input.surface ?? null, controlId: input.controlId ?? null,
      inputMethod: input.inputMethod ?? null, requestedProfile: input.profile ?? null,
      operation: input.operation ?? null, state: "denied", diagnostic: failure });
    json(response, 403, { ok: false, state: "denied", operation: input.operation ?? null,
      profile: authorization.profile?.id ?? null, diagnostic: failure });
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        json(response, 200, { schema: "fgpm.curator-workbench-health/1", status: "ready" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/overview") {
        const workspace = await safe("workspace.status", { name: descriptor.workspace.name });
        const [packages, history, active, runtime, retained, reachability, currentGeneration] = await Promise.all([
          safe("package.list"), safe("workspace.history", { name: descriptor.workspace.name }),
          safe("generation.active"), safe("runtime.inspect"), safe("generation.retained"),
          safe("manager.reachability"), safe("generation.show", { root: descriptor.current.generation }),
        ]);
        const releases = Object.fromEntries(await Promise.all(descriptor.releases.map(async (release) => [
          release.name, await optionalJson(path.join(projectPath(projectRoot, release.directory), "release.json")),
        ])));
        json(response, 200, {
          schema: "fgpm.curator-workbench-overview/2", project: descriptor, fixture, journal,
          exactBuild, clientAuthority,
          manager: { configured: managerRoot, store: managerStore, commit: managerCommit,
            matchesDescriptor: managerMatches, expectedCommit: descriptor.manager.preferred.commit,
            control: await safe("control.describe") },
          packages, workspace, history, active, runtime, retained, reachability, currentGeneration, releases,
          tests: descriptor.paths.testSummary
            ? await optionalJson(projectPath(projectRoot, descriptor.paths.testSummary)) : null,
          progress, latest, trace: actionTrace,
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/trace") {
        json(response, 200, { schema: "fgpm.curator-workbench-trace/1", actions: actionTrace, progress });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/initialize") {
        if (!managerMatches) { mutationMismatch(response, "project.initialize"); return; }
        const input = await body(request);
        if (input.confirmation !== descriptor.id) {
          json(response, 409, { ok: false, diagnostic: {
            code: "FGPM_WORKBENCH_PROJECT_CONFIRMATION_REQUIRED",
            message: "Type the exact project identity to initialise its portable state.",
            details: { expected: descriptor.id },
          } });
          return;
        }
        for (const step of journal.steps) {
          const authorization = authorizeClientOperation("guided-human", step.operation);
          if (!authorization.ok) {
            denyClientOperation(response, { ...input, operation: step.operation }, authorization);
            return;
          }
        }
        try {
          const result = await replayPublicJournal({ request: dispatch }, projectRoot, journal, {
            onStep: (entry) => recordAction({ profile: "guided-human",
              surface: input.surface ?? "guided", controlId: input.controlId ?? null,
              inputMethod: input.inputMethod ?? null, journalStep: entry }),
          });
          latest["project.initialize"] = result;
          json(response, 200, { ok: true, state: "completed", operation: "project.initialize", result });
        } catch (error) {
          const failure = diagnostic(error);
          recordAction({ surface: input.surface ?? "guided", operation: "project.initialize", state: "failed",
            diagnostic: failure });
          json(response, 422, { ok: false, state: "failed", operation: "project.initialize", diagnostic: failure });
        }
        return;
      }
      const clientProfile = request.method === "POST" ? clientProfileForPath(url.pathname) : null;
      if (clientProfile) {
        const input = await body(request);
        const authorization = authorizeClientOperation(clientProfile.id, input.operation);
        if (!authorization.capability) {
          json(response, 400, { ok: false, diagnostic: {
            code: "FGPM_WORKBENCH_OPERATION_NOT_EXPOSED", message: "The workbench does not expose that operation.",
            details: { operation: input.operation ?? null },
          } });
          return;
        }
        if (!authorization.ok) {
          denyClientOperation(response, input, authorization);
          return;
        }
        if (MUTATING_OPERATIONS.has(input.operation) && !managerMatches) {
          mutationMismatch(response, input.operation); return;
        }
        if (input.expectation === "exact-build" && exactBuild && !exactBuild.compatible) {
          exactBuildMismatch(response, input.operation); return;
        }
        const parameters = resolveRelativeParameters(projectRoot, input.parameters, input.relativePaths);
        if (input.expectation === "exact-build" && input.operation === "generation.commit"
          && parameters.expectedGenerationRoot !== exactBuild?.expected?.generation) {
          json(response, 409, { ok: false, diagnostic: {
            code: "FGPM_WORKBENCH_EXPECTED_GENERATION_REQUIRED",
            message: "Exact generation commit requires the project-declared expected generation root.",
            details: { supplied: parameters.expectedGenerationRoot ?? null,
              expected: exactBuild?.expected?.generation ?? null },
          } });
          return;
        }
        if (CONFIRMED_OPERATIONS.has(input.operation)) {
          const expected = input.operation === "runtime.resume" ? parameters?.generation : parameters?.root;
          if (!expected || input.confirmation !== expected) {
            json(response, 409, { ok: false, diagnostic: {
              code: "FGPM_WORKBENCH_CONFIRMATION_REQUIRED",
              message: "Type the exact generation identity to confirm this authority-moving action.",
              details: { operation: input.operation, expected },
            } });
            return;
          }
        }
        const traceBase = { profile: clientProfile.id, surface: input.surface ?? null,
          controlId: input.controlId ?? null, inputMethod: input.inputMethod ?? null,
          requestedProfile: input.profile ?? null, operation: input.operation, parameters };
        recordAction({ ...traceBase, state: "started" });
        try {
          const result = await dispatch(input.operation, parameters, input.requestId ?? null);
          latest[input.operation] = result;
          recordAction({ ...traceBase, state: "completed", result });
          json(response, 200, { ok: true, state: "completed", operation: input.operation, result });
        } catch (error) {
          const failure = diagnostic(error);
          recordAction({ ...traceBase, state: "failed", diagnostic: failure });
          json(response, 422, { ok: false, state: "failed", operation: input.operation, diagnostic: failure });
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/runtime.svg") {
        await staticFile(response, snapshot, "image/svg+xml; charset=utf-8"); return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/scene/")) {
        const key = decodeURIComponent(url.pathname.split("/").at(-1));
        const relative = fixture.scenes?.[key]?.path;
        if (!relative) { response.writeHead(404); response.end(); return; }
        await staticFile(response, projectPath(projectRoot, relative, `fixture scene ${key}`),
          "image/svg+xml; charset=utf-8");
        return;
      }
      const staticRoutes = new Map([
        ["/", ["index.html", "text/html; charset=utf-8"]],
        ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
        ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
      ]);
      if (request.method === "GET" && staticRoutes.has(url.pathname)) {
        const [file, type] = staticRoutes.get(url.pathname);
        await staticFile(response, path.join(publicRoot, file), type); return;
      }
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found\n");
    } catch (error) {
      json(response, 500, { ok: false, diagnostic: diagnostic(error) });
    }
  });
  const url = await listen(server, options);
  return {
    url, server, control, project, dispatches: managerDispatches,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      try { await control.stop(); } catch {}
    },
  };
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const projectRoot = option("--project");
  if (!projectRoot) {
    process.stderr.write("Usage: node tools/curator-workbench/server.mjs --project <project> [--manager-store <directory>] [--port <port>]\n");
    process.exitCode = 1;
  } else {
    const workbench = await startWorkbench({ projectRoot, managerStore: option("--manager-store"),
      port: Number(option("--port") ?? 0) });
    process.stdout.write(`Curator workbench: ${workbench.url}\nPress Ctrl+C to stop.\n`);
    const stop = async () => { await workbench.close(); process.exit(0); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
  }
}
