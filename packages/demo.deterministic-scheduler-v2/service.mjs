// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { Worker, isMainThread } from "node:worker_threads";

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

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function root(value) {
  const text = `${JSON.stringify(stable(value), null, 2)}\n`;
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function validateTask(member) {
  const metadata = member.metadata;
  const value = member.value;
  if (metadata?.schema !== "fgpm.runtime-task-member/2"
    || metadata.vocabulary !== "fgpm.runtime-task-vocabulary/2"
    || !["required", "optional"].includes(metadata.participation)
    || !["abort-tick", "drop-task"].includes(metadata.failurePolicy)
    || !["main-thread", "any-worker"].includes(metadata.affinity)
    || !Array.isArray(metadata.snapshots) || !Array.isArray(metadata.outputs)
    || value?.protocol !== "fgpm.runtime-task/2" || value.provider !== member.providerInstance) {
    fail("FGPM_RUNTIME_TASK_INVALID", "A corrected task member has an invalid execution contract.", {
      task: member.id, provider: member.providerInstance, metadata,
    });
  }
  if (metadata.affinity !== "any-worker" || typeof value.workerModule !== "string") {
    fail("FGPM_TASK_AFFINITY_UNAVAILABLE", "The corrected prototype currently requires a worker module.", {
      task: member.id, affinity: metadata.affinity,
    });
  }
  return { ...member, metadata, value };
}

function invokeWorker(task, checkpoint, snapshots, delayMs = 0, timeoutMs = 5_000) {
  const granted = Object.fromEntries(task.metadata.snapshots.map((entry) => [entry.capability, snapshots[entry.capability]]));
  return new Promise((resolve) => {
    const worker = new Worker(new URL("./worker-runner.mjs", import.meta.url), {
      workerData: {
        member: task.id,
        module: task.value.workerModule,
        checkpoint,
        snapshots: granted,
        channels: task.metadata.outputs.map((entry) => entry.channel),
        delayMs,
      },
    });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(async () => {
      await worker.terminate();
      finish({ schema: "fgpm.runtime-task-worker-response/2", task: task.id, outcome: "failed", threadId: null,
        emissions: [], error: { code: "FGPM_RUNTIME_TASK_TIMEOUT", message: "A runtime task timed out.",
          details: { task: task.id, timeoutMs } } });
    }, timeoutMs);
    worker.once("message", finish);
    worker.once("error", (error) => finish({ schema: "fgpm.runtime-task-worker-response/2", task: task.id,
      outcome: "failed", threadId: null, emissions: [], error: { code: "FGPM_RUNTIME_TASK_FAILED",
        message: error.message, details: { task: task.id } } }));
  });
}

async function workerPool(tasks, count, execute, completionOrder) {
  const results = [];
  let cursor = 0;
  async function slot() {
    while (cursor < tasks.length) {
      const task = tasks[cursor];
      cursor += 1;
      const result = await execute(task);
      completionOrder.push(task.id);
      results.push(result);
    }
  }
  await Promise.all(Array.from({ length: Math.min(count, tasks.length) }, () => slot()));
  return results;
}

export function createService() {
  let clock;
  let transformsRead;
  let transformsWrite;
  let vocabulary;
  let tasks = [];
  let taskPolicy = [];
  let channelPlan;
  let previousCheckpoint;
  let conformance;
  let inFlight = false;
  const records = [];
  const traces = [];

  async function executeTick() {
    if (inFlight) fail("FGPM_SCHEDULER_NON_REENTRANT", "The scheduler rejected an overlapping tick.");
    inFlight = true;
    const checkpoint = clock.now();
    const completionOrder = [];
    const executions = [];
    let stateCommitted = false;
    try {
      if (checkpoint.tick !== previousCheckpoint.tick + 1) {
        fail("FGPM_SCHEDULER_CHECKPOINT_MISMATCH", "The scheduler clock did not advance exactly once.", {
          previous: previousCheckpoint, checkpoint,
        });
      }
      const transformSnapshot = transformsRead.snapshot();
      const snapshots = { "runtime.transforms.read": transformSnapshot };
      const pending = new Map(tasks.map((task) => [task.id, task]));
      const completed = new Set();
      const results = [];
      const workerCount = Math.max(1, Math.min(tasks.length,
        Number.isInteger(conformance.workerCount) ? conformance.workerCount : 4));
      while (pending.size > 0) {
        const ready = [...pending.values()].filter((task) => task.dependencies.every((id) => completed.has(id)))
          .sort((left, right) => left.id.localeCompare(right.id));
        if (ready.length === 0) {
          fail("FGPM_RUNTIME_TASK_DEPENDENCY_BLOCKED", "No corrected task can run in the current dependency wave.", {
            pending: [...pending.keys()].sort(),
          });
        }
        const wave = await workerPool(ready, workerCount,
          (task) => invokeWorker(task, checkpoint, snapshots,
            conformance.memberDelays[task.id] ?? 0, conformance.timeoutMs), completionOrder);
        for (const result of wave) {
          const task = pending.get(result.task);
          if (result.schema !== "fgpm.runtime-task-worker-response/2") {
            fail("FGPM_RUNTIME_TASK_INVALID", "A worker returned an invalid corrected response.", { task: result.task });
          }
          results.push(result);
          executions.push({ task: result.task, affinity: task.metadata.affinity,
            threadKind: "worker", threadId: result.threadId });
          completed.add(result.task);
          pending.delete(result.task);
        }
        const abort = wave.find((result) => result.outcome === "failed"
          && tasks.find((task) => task.id === result.task).metadata.failurePolicy === "abort-tick");
        if (abort) {
          fail(abort.error.code, abort.error.message, {
            ...abort.error.details, task: abort.task,
            discardedBuffers: results.filter((entry) => entry.outcome === "completed").map((entry) => entry.task).sort(),
          });
        }
      }
      const buffers = results.filter((entry) => entry.outcome === "completed").flatMap((result) => {
        const commands = result.emissions.filter((entry) => entry.channel === vocabulary.channel)
          .map((entry) => entry.operation);
        if (commands.length === 0) return [];
        const buffer = { schema: "fgpm.runtime-command-buffer/2", task: result.task,
          checkpoint: structuredClone(checkpoint), channel: vocabulary.channel, commands };
        return [{ ...buffer, root: root(buffer) }];
      });
      const composed = vocabulary.compose(channelPlan, buffers);
      const commit = transformsWrite.commitBatch({
        schema: "fgpm.transform-command-batch/2",
        checkpoint: structuredClone(checkpoint),
        expectedRevision: transformSnapshot.revision,
        channel: vocabulary.channel,
        composition: { form: "ordered", order: composed.record.commitOrder,
          vocabulary: composed.record.vocabulary, rule: composed.record.rule },
        buffers: composed.buffers,
      });
      stateCommitted = true;
      const body = {
        schema: "fgpm.deterministic-tick/2",
        checkpoint: structuredClone(checkpoint),
        tasks: tasks.map((task) => ({ member: task.id, providerInstance: task.providerInstance,
          package: task.package, implementationHash: task.packageContentHash, metadataRoot: task.metadataRoot })),
        taskPolicy: { exclusions: structuredClone(taskPolicy) },
        taskOutcomes: results.map((result) => ({ task: result.task,
          status: result.outcome === "completed" ? "completed" : "dropped-by-failure-policy",
          error: result.outcome === "completed" ? null : result.error.code }))
          .sort((left, right) => left.task.localeCompare(right.task)),
        snapshots: [{ capability: "runtime.transforms.read", schema: transformSnapshot.schema,
          revision: transformSnapshot.revision, root: root(transformSnapshot) }],
        commandBuffers: buffers.map((entry) => ({ task: entry.task, channel: entry.channel, root: entry.root }))
          .sort((left, right) => left.task.localeCompare(right.task)),
        composition: [structuredClone(composed.record)],
        result: commit,
      };
      const record = freeze({ ...body, identity: root(body) });
      records.push(record);
      traces.push({ tick: checkpoint.tick, workerCount, completionOrder, executions, committed: true });
      previousCheckpoint = structuredClone(checkpoint);
      return record;
    } catch (error) {
      if (!stateCommitted) clock.abort(checkpoint);
      traces.push({ tick: checkpoint.tick, workerCount: Math.max(1, Math.min(tasks.length,
        Number.isInteger(conformance.workerCount) ? conformance.workerCount : 4)),
        completionOrder, executions, committed: stateCommitted, error: error?.code ?? "FGPM_RUNTIME_TASK_FAILED" });
      throw error;
    } finally {
      inFlight = false;
    }
  }

  return {
    async activate(context) {
      if (!isMainThread) fail("FGPM_SCHEDULER_AFFINITY_INVALID", "The scheduler must activate on the main thread.");
      clock = context.require("runtime.clock.tick");
      transformsRead = context.require("runtime.transforms.read");
      transformsWrite = context.require("runtime.transforms.write");
      vocabulary = context.require("runtime.task-channel.transforms");
      context.grant("fgpm.host.scheduler-records/1");
      conformance = context.grant("fgpm.host.scheduler-conformance/1");
      const restored = context.require("runtime.restore.ready").report();
      if (restored.savedCheckpoint) clock.resume(restored.savedCheckpoint);
      previousCheckpoint = structuredClone(clock.now());
      const collection = context.require("runtime.task");
      taskPolicy = collection.exclusions.map((entry) => ({ member: entry.member, policy: entry.policy,
        reason: entry.reason, participation: entry.metadata?.participation ?? null }));
      for (const exclusion of collection.exclusions) {
        if (exclusion.metadata?.participation === "required") {
          fail("FGPM_REQUIRED_TASK_EXCLUDED", "Policy cannot exclude a required corrected task.", {
            task: exclusion.member, policy: exclusion.policy,
          });
        }
      }
      tasks = collection.members.map(validateTask);
      channelPlan = vocabulary.planChannel(tasks);
      const api = freeze({
        latest: () => records.at(-1) ?? null,
        list: () => freeze(structuredClone(records)),
        trace: () => freeze(structuredClone(traces)),
        channelPlan: () => channelPlan,
        executeTick,
      });
      return {
        protocol: "fgpm.runtime-service-response/2",
        capabilities: {
          "runtime.scheduler.barrier": freeze({ latest: api.latest }),
          "runtime.scheduler.records": api,
        },
      };
    },
    async tick() {
      await executeTick();
    },
    async deactivate() {
      tasks = [];
      taskPolicy = [];
      records.length = 0;
      traces.length = 0;
      clock = null;
      transformsRead = null;
      transformsWrite = null;
      vocabulary = null;
      channelPlan = null;
      previousCheckpoint = null;
      conformance = null;
    },
  };
}
