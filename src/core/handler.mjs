// SPDX-License-Identifier: MPL-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { FpmError, invariant } from "./errors.mjs";
import { resolveInside, stableJson } from "./io.mjs";

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

export function invokeHandler(handler, request) {
  const command = resolvePackageCommand(handler.owner, handler.command);
  const result = spawnSync(command.executable, command.arguments, {
    cwd: handler.owner.directory,
    input: stableJson(request),
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      FPM_PACKAGE_DIR: handler.owner.directory,
      FPM_HANDLER_ID: handler.id,
    },
  });

  if (result.error || result.status !== 0) {
    throw new FpmError("FPM_HANDLER_PROCESS_FAILED", "A package handler process failed.", {
      handler: handler.id,
      package: handler.owner.id,
      exitCode: result.status,
      cause: result.error?.message ?? null,
      stderr: result.stderr?.trim() || null,
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
        ...(diagnostic.details ?? {}),
      });
  }
  return response;
}
