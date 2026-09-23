// SPDX-License-Identifier: Apache-2.0

import { parentPort, threadId, workerData } from "node:worker_threads";

function fail(code, message, details = {}) {
  throw Object.assign(new Error(message), { code, details });
}

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

if (workerData.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, workerData.delayMs));

try {
  const implementation = await import(workerData.module);
  if (typeof implementation.runTask !== "function") {
    fail("FGPM_RUNTIME_TASK_INVALID", "A worker task module does not export runTask().", {
      task: workerData.member, module: workerData.module,
    });
  }
  const emissions = [];
  const context = freeze({
    checkpoint: structuredClone(workerData.checkpoint),
    execution: { threadKind: "worker", threadId },
    snapshot: (capability) => {
      if (!Object.hasOwn(workerData.snapshots, capability)) {
        fail("FGPM_TASK_SNAPSHOT_AUTHORITY_DENIED", "A task requested an undeclared immutable snapshot.", {
          task: workerData.member, capability, declared: Object.keys(workerData.snapshots).sort(),
        });
      }
      return freeze(structuredClone(workerData.snapshots[capability]));
    },
    emit: (channel, operation) => {
      if (!workerData.channels.includes(channel)) {
        fail("FGPM_TASK_COMMAND_AUTHORITY_DENIED", "A task emitted to an undeclared command channel.", {
          task: workerData.member, channel, declared: [...workerData.channels].sort(),
        });
      }
      emissions.push({ channel, operation: structuredClone(operation) });
    },
    capability: (capability) => fail("FGPM_TASK_DIRECT_AUTHORITY_DENIED",
      "A runtime task cannot acquire direct mutable capability authority.", {
        task: workerData.member, capability,
      }),
  });
  const result = await implementation.runTask(context);
  parentPort.postMessage({
    schema: "fgpm.runtime-task-worker-response/2",
    task: workerData.member,
    outcome: "completed",
    threadId,
    emissions,
    result: result ?? null,
  });
} catch (error) {
  parentPort.postMessage({
    schema: "fgpm.runtime-task-worker-response/2",
    task: workerData.member,
    outcome: "failed",
    threadId,
    emissions: [],
    error: {
      code: typeof error?.code === "string" ? error.code : "FGPM_RUNTIME_TASK_FAILED",
      message: error?.message ?? "A task failed.",
      details: error?.details ?? {},
    },
  });
}
