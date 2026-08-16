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
    fail("FPM_RUNTIME_TASK_INVALID", "A worker task module does not export runTask().", {
      task: workerData.member,
      module: workerData.module,
    });
  }
  const emitted = [];
  const context = freeze({
    checkpoint: structuredClone(workerData.checkpoint),
    execution: { threadKind: "worker", threadId },
    snapshot: (capability) => {
      if (!Object.hasOwn(workerData.snapshots, capability)) {
        fail("FPM_TASK_SNAPSHOT_AUTHORITY_DENIED", "A task requested an immutable snapshot it did not declare.", {
          task: workerData.member,
          capability,
          declared: Object.keys(workerData.snapshots).sort(),
        });
      }
      return freeze(structuredClone(workerData.snapshots[capability]));
    },
    emit: (channel, command) => {
      if (!workerData.channels.includes(channel)) {
        fail("FPM_TASK_COMMAND_AUTHORITY_DENIED", "A task emitted to a command channel it did not declare.", {
          task: workerData.member,
          channel,
          declared: [...workerData.channels].sort(),
        });
      }
      emitted.push({ channel, command: structuredClone(command) });
    },
    capability: (capability) => fail("FPM_TASK_DIRECT_AUTHORITY_DENIED",
      "A runtime task cannot acquire direct mutable capability authority.", {
        task: workerData.member,
        capability,
      }),
  });
  const result = await implementation.runTask(context);
  parentPort.postMessage({ ok: true, task: workerData.member, threadId, emitted, result: result ?? null });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    task: workerData.member,
    threadId,
    error: {
      code: typeof error?.code === "string" ? error.code : "FPM_RUNTIME_TASK_FAILED",
      message: error?.message ?? "A runtime task failed.",
      details: error?.details ?? {},
    },
  });
}
