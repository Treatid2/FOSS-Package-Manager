#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

import path from "node:path";
import { fileURLToPath } from "node:url";
import { ControlClient } from "./control-client.mjs";
import { loadWorkbenchProject, projectPath } from "./project.mjs";
import { replayPublicJournal } from "./journal.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
const managerRoot = path.resolve(moduleRoot, "../..");
const projectRoot = path.resolve(option("--project") ?? "");
if (!option("--project")) {
  process.stderr.write("Usage: node tools/curator-workbench/replay.mjs --project <project> [--manager-store <directory>]\n");
  process.exitCode = 1;
} else {
  const project = await loadWorkbenchProject(projectRoot);
  const managerStore = path.resolve(option("--manager-store")
    ?? projectPath(project.root, project.descriptor.paths.managerStore));
  const snapshot = projectPath(project.root, project.descriptor.paths.workbenchSnapshot);
  const control = new ControlClient(managerRoot, { managerStore, snapshotPath: snapshot });
  try {
    const result = await replayPublicJournal(control, project.root, project.journal);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await control.stop();
  }
}
