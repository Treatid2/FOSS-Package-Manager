// SPDX-License-Identifier: MPL-2.0

import path from "node:path";
import { projectPath } from "./project.mjs";

function clone(value) { return structuredClone(value); }

function at(value, pointer) {
  return pointer.split(".").filter(Boolean).reduce((current, key) => current?.[key], value);
}

function resolvePaths(projectRoot, parameters, pathParameters = []) {
  const output = clone(parameters ?? {});
  for (const pointer of pathParameters) {
    const segments = pointer.split(".");
    let current = output;
    for (const segment of segments.slice(0, -1)) current = current[segment];
    const key = segments.at(-1);
    current[key] = projectPath(projectRoot, current[key], `journal parameter ${pointer}`);
  }
  return output;
}

export async function replayPublicJournal(control, projectRoot, journal, options = {}) {
  if (journal?.schema !== "fgpm.public-control-journal/1" || !Array.isArray(journal.steps)) {
    throw Object.assign(new Error("The portable project journal is invalid."), {
      code: "FGPM_WORKBENCH_JOURNAL_INVALID",
    });
  }
  const trace = [];
  for (const step of journal.steps) {
    const parameters = resolvePaths(projectRoot, step.parameters, step.pathParameters);
    options.onStep?.({ state: "started", id: step.id, operation: step.operation, parameters });
    const result = await control.request(step.operation, parameters, `journal:${journal.id}:${step.id}`);
    for (const assertion of step.assertions ?? []) {
      const actual = at(result, assertion.path);
      if (actual !== assertion.equals) {
        throw Object.assign(new Error(`Portable journal assertion failed at ${step.id}:${assertion.path}.`), {
          code: "FGPM_WORKBENCH_JOURNAL_ASSERTION_FAILED",
          details: { step: step.id, path: assertion.path, expected: assertion.equals, actual },
        });
      }
    }
    const entry = { id: step.id, label: step.label, operation: step.operation, parameters, result };
    trace.push(entry);
    options.onStep?.({ state: "completed", ...entry });
  }
  return { schema: "fgpm.public-control-journal-result/1", journal: journal.id, steps: trace };
}
