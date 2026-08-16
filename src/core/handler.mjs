// SPDX-License-Identifier: MPL-2.0

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FpmError, invariant } from "./errors.mjs";
import { resolveInside, stableJson } from "./io.mjs";

const PORTABLE_RUNNER = fileURLToPath(new URL("./portable-wasm-runner.mjs", import.meta.url));
const PORTABLE_RUNNER_VERSION = "fpm.wasm-byte-transform/1";
const DEFAULT_LIMITS = Object.freeze({
  timeoutMs: 2_000,
  maxModuleBytes: 64 * 1024,
  maxInputBytes: 1024 * 1024,
  maxOutputBytes: 1024 * 1024,
  maxResponseBytes: 1024 * 1024,
  maxProcessMemoryMiB: 64,
});

export function resolvePackageCommand(owner, declaration) {
  invariant(Array.isArray(declaration) && declaration.length > 0 && declaration.every((entry) => typeof entry === "string"),
    "FPM_COMMAND_INVALID", "A package command must be a non-empty string array.", { package: owner.id, command: declaration });
  const [declaredExecutable, ...declaredArguments] = declaration;
  const executable = declaredExecutable === "node" ? process.execPath : declaredExecutable;
  const argumentsList = declaredArguments.map((argument) => {
    if (argument.startsWith("./") || argument.startsWith(".\\")) {
      return resolveInside(owner.directory, argument, "command argument");
    }
    return argument;
  });
  return { executable, arguments: argumentsList };
}

function limitsFor(handler) {
  return handler.execution.form === "portable-wasm"
    ? { ...DEFAULT_LIMITS, ...(handler.execution.limits ?? {}) }
    : { maxResponseBytes: 16 * 1024 * 1024 };
}

export function handlerExecutionRecord(handler) {
  if (handler.execution.form === "portable-wasm") {
    return {
      form: "portable-wasm",
      boundary: "wasm-capability-imports",
      runner: PORTABLE_RUNNER_VERSION,
      requestedPowers: [...handler.execution.requestedPowers].sort(),
      grantedPowers: ["read-declared-input-bytes", "write-declared-output-bytes"],
      deniedAmbientPowers: [
        "arbitrary-host-filesystem-read",
        "arbitrary-host-filesystem-write",
        "child-process",
        "network",
        "package-store-mutation",
      ],
      limits: limitsFor(handler),
    };
  }
  return {
    form: handler.execution.form,
    boundary: handler.execution.securityBoundary,
    runner: null,
    requestedPowers: [...handler.execution.requestedPowers].sort(),
    grantedPowers: ["host-user-authority"],
    deniedAmbientPowers: [],
    limits: { maxResponseBytes: limitsFor(handler).maxResponseBytes },
  };
}

function invocationFor(handler) {
  if (handler.execution.form !== "portable-wasm") {
    return resolvePackageCommand(handler.owner, handler.command);
  }
  invariant(handler.command.length === 1 && (handler.command[0].startsWith("./") || handler.command[0].startsWith(".\\")),
    "FPM_COMMAND_INVALID", "A portable WebAssembly handler must name one package-relative module.", {
      handler: handler.id,
      command: handler.command,
    });
  const modulePath = resolveInside(handler.owner.directory, handler.command[0], "portable module");
  const limits = limitsFor(handler);
  return {
    executable: process.execPath,
    arguments: [`--max-old-space-size=${limits.maxProcessMemoryMiB}`, PORTABLE_RUNNER, modulePath],
  };
}

export function invokeHandler(handler, request) {
  const command = invocationFor(handler);
  const execution = handlerExecutionRecord(handler);
  const limits = limitsFor(handler);
  const result = spawnSync(command.executable, command.arguments, {
    cwd: handler.owner.directory,
    input: stableJson(request),
    encoding: "utf8",
    windowsHide: true,
    timeout: handler.execution.form === "portable-wasm" ? limits.timeoutMs : undefined,
    killSignal: "SIGKILL",
    maxBuffer: limits.maxResponseBytes,
    env: {
      ...process.env,
      FPM_PACKAGE_DIR: handler.owner.directory,
      FPM_HANDLER_ID: handler.id,
      FPM_PORTABLE_LIMITS: stableJson(limits).trim(),
    },
  });

  if (result.error?.code === "ETIMEDOUT") {
    throw new FpmError("FPM_HANDLER_RESOURCE_LIMIT", "A portable handler exceeded its execution-time limit.", {
      handler: handler.id,
      package: handler.owner.id,
      execution,
      cause: result.error.message,
    });
  }
  if (result.error || result.status !== 0) {
    throw new FpmError("FPM_HANDLER_PROCESS_FAILED", "A package handler process failed.", {
      handler: handler.id,
      package: handler.owner.id,
      exitCode: result.status,
      cause: result.error?.message ?? null,
      stderr: result.stderr?.trim() || null,
      execution,
    });
  }

  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch (error) {
    throw new FpmError("FPM_HANDLER_RESPONSE_INVALID", "A handler did not return one valid JSON response.", {
      handler: handler.id,
      cause: error.message,
      stdout: result.stdout.slice(0, 1000),
      stderr: result.stderr?.trim() || null,
      execution,
    });
  }

  invariant(response?.protocol === "fpm.handler-response/1", "FPM_HANDLER_RESPONSE_INVALID",
    "A handler returned an unsupported response protocol.", { handler: handler.id, protocol: response?.protocol });
  if (!response.ok) {
    const diagnostic = response.diagnostic ?? {};
    throw new FpmError(diagnostic.code ?? "FPM_HANDLER_ANALYSIS_FAILED",
      diagnostic.message ?? "A handler rejected its input.", {
        handler: handler.id,
        package: handler.owner.id,
        execution,
        ...(diagnostic.details ?? {}),
      });
  }
  return { ...response, managerExecution: execution };
}
