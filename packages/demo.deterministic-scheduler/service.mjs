// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
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

function json(value) {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

function root(value) {
  return `sha256:${createHash("sha256").update(json(value)).digest("hex")}`;
}

async function writeAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, json(value), "utf8");
    await rm(filePath, { force: true });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

function validateTask(member) {
  const metadata = member.metadata;
  const value = member.value;
  if (value?.protocol !== "fpm.runtime-task/1" || value.provider !== member.providerInstance
    || metadata?.phase !== "simulation" || !Array.isArray(metadata.snapshots)
    || !metadata.snapshots.every((entry) => typeof entry === "string")
    || !Array.isArray(metadata.outputs) || !metadata.outputs.every((entry) => typeof entry?.channel === "string"
      && ["ordered", "single-producer", "set-union", "commutative-reduce"].includes(entry.composition)
      && Array.isArray(entry.commitAfter) && entry.commitAfter.every((task) => typeof task === "string"))
    || !["main-thread", "any-worker"].includes(metadata.affinity)
    || !["reentrant", "non-reentrant"].includes(metadata.reentrancy)
    || typeof metadata.required !== "boolean" || !["abort-tick", "drop-task"].includes(metadata.failure)) {
    fail("FPM_RUNTIME_TASK_INVALID", "A task collection member has an invalid execution contract.", {
      task: member.id,
      provider: member.providerInstance,
      metadata,
    });
  }
  if (metadata.affinity === "any-worker" && typeof value.workerModule !== "string") {
    fail("FPM_TASK_AFFINITY_UNAVAILABLE", "An any-worker task has no worker module.", {
      task: member.id,
      affinity: metadata.affinity,
    });
  }
  if (metadata.affinity === "main-thread" && typeof value.run !== "function") {
    fail("FPM_TASK_AFFINITY_UNAVAILABLE", "A main-thread task has no main-thread implementation.", {
      task: member.id,
      affinity: metadata.affinity,
    });
  }
  return { ...member, metadata, value };
}

function orderedChannel(channel, producers) {
  if (producers.length <= 1) return producers.map((entry) => entry.id);
  const byId = new Map(producers.map((entry) => [entry.id, entry]));
  const edges = new Map(producers.map((entry) => [entry.id, new Set()]));
  for (const producer of producers) {
    const declaration = producer.metadata.outputs.find((entry) => entry.channel === channel);
    for (const predecessor of declaration.commitAfter) {
      if (!byId.has(predecessor)) {
        fail("FPM_TASK_COMMIT_ORDER_MISSING", "A task commit constraint names a task outside its channel.", {
          channel,
          task: producer.id,
          predecessor,
        });
      }
      edges.get(predecessor).add(producer.id);
    }
  }
  const reachable = (from, target, seen = new Set()) => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return [...edges.get(from)].some((next) => reachable(next, target, seen));
  };
  for (let left = 0; left < producers.length; left += 1) {
    for (let right = left + 1; right < producers.length; right += 1) {
      const a = producers[left].id;
      const b = producers[right].id;
      if (!reachable(a, b) && !reachable(b, a)) {
        fail("FPM_TASK_COMMAND_COMPOSITION_AMBIGUOUS",
          "Order-sensitive command producers lack a complete declared commit order.", {
            channel,
            contributors: [a, b].sort(),
          });
      }
    }
  }
  const order = [];
  const state = new Map();
  const stack = [];
  function visit(task) {
    if (state.get(task) === "done") return;
    if (state.get(task) === "visiting") {
      const start = stack.indexOf(task);
      fail("FPM_TASK_COMMIT_ORDER_CYCLE", "Task commit-order constraints contain a cycle.", {
        channel,
        cycle: [...stack.slice(start), task],
      });
    }
    state.set(task, "visiting");
    stack.push(task);
    const predecessors = producers.filter((entry) => edges.get(entry.id).has(task)).map((entry) => entry.id).sort();
    for (const predecessor of predecessors) visit(predecessor);
    stack.pop();
    state.set(task, "done");
    order.push(task);
  }
  for (const task of [...byId.keys()].sort()) visit(task);
  return order;
}

function planChannels(tasks) {
  const declarations = new Map();
  for (const task of tasks) {
    for (const output of task.metadata.outputs) {
      const entries = declarations.get(output.channel) ?? [];
      entries.push({ task, output });
      declarations.set(output.channel, entries);
    }
  }
  const plans = [];
  for (const channel of [...declarations.keys()].sort()) {
    const entries = declarations.get(channel);
    const forms = [...new Set(entries.map((entry) => entry.output.composition))];
    if (forms.length !== 1) {
      fail("FPM_TASK_COMMAND_COMPOSITION_CONFLICT", "Command producers disagree about their channel composition law.", {
        channel,
        contributors: entries.map((entry) => ({ task: entry.task.id, composition: entry.output.composition })),
      });
    }
    const form = forms[0];
    if (form === "single-producer" && entries.length !== 1) {
      fail("FPM_TASK_COMMAND_COMPOSITION_AMBIGUOUS", "A single-producer channel has several task producers.", {
        channel,
        contributors: entries.map((entry) => entry.task.id).sort(),
      });
    }
    if (form !== "ordered" && form !== "single-producer") {
      fail("FPM_TASK_COMPOSITION_UNIMPLEMENTED", "The prototype scheduler does not implement this declared law.", {
        channel,
        composition: form,
      });
    }
    plans.push({
      channel,
      composition: form,
      order: form === "ordered" ? orderedChannel(channel, entries.map((entry) => entry.task))
        : [entries[0].task.id],
    });
  }
  if (plans.some((entry) => entry.channel !== "runtime.transforms.commands")) {
    fail("FPM_TASK_COMMAND_CHANNEL_UNAVAILABLE", "The first concurrency prototype commits only transform commands.", {
      channels: plans.map((entry) => entry.channel),
    });
  }
  return plans;
}

function localContext(task, checkpoint, snapshots, emitted) {
  const granted = Object.fromEntries(task.metadata.snapshots.map((capability) => [capability, snapshots[capability]]));
  const channels = task.metadata.outputs.map((entry) => entry.channel);
  return freeze({
    checkpoint: structuredClone(checkpoint),
    execution: { threadKind: "main-thread", threadId: 0 },
    snapshot: (capability) => {
      if (!Object.hasOwn(granted, capability)) {
        fail("FPM_TASK_SNAPSHOT_AUTHORITY_DENIED", "A task requested an immutable snapshot it did not declare.", {
          task: task.id,
          capability,
          declared: Object.keys(granted).sort(),
        });
      }
      return freeze(structuredClone(granted[capability]));
    },
    emit: (channel, command) => {
      if (!channels.includes(channel)) {
        fail("FPM_TASK_COMMAND_AUTHORITY_DENIED", "A task emitted to a command channel it did not declare.", {
          task: task.id,
          channel,
          declared: [...channels].sort(),
        });
      }
      emitted.push({ channel, command: structuredClone(command) });
    },
    capability: (capability) => fail("FPM_TASK_DIRECT_AUTHORITY_DENIED",
      "A runtime task cannot acquire direct mutable capability authority.", {
        task: task.id,
        capability,
      }),
  });
}

function workerTask(task, checkpoint, snapshots, delayMs, timeoutMs) {
  const workerSnapshots = Object.fromEntries(task.metadata.snapshots.map((capability) => [capability, snapshots[capability]]));
  return new Promise((resolve) => {
    const worker = new Worker(new URL("./worker-runner.mjs", import.meta.url), {
      workerData: {
        member: task.id,
        module: task.value.workerModule,
        checkpoint,
        snapshots: workerSnapshots,
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
      finish({ ok: false, task: task.id, threadId: null, error: {
        code: "FPM_RUNTIME_TASK_TIMEOUT",
        message: "A runtime task exceeded its declared scheduler timeout.",
        details: { task: task.id, timeoutMs },
      } });
    }, timeoutMs);
    worker.once("message", finish);
    worker.once("error", (error) => finish({ ok: false, task: task.id, threadId: null, error: {
      code: "FPM_RUNTIME_TASK_FAILED", message: error.message, details: { task: task.id },
    } }));
    worker.once("exit", (code) => {
      if (code !== 0) finish({ ok: false, task: task.id, threadId: null, error: {
        code: "FPM_RUNTIME_TASK_FAILED", message: "A runtime task worker exited unsuccessfully.",
        details: { task: task.id, exitCode: code },
      } });
    });
  });
}

async function workerPool(tasks, workerCount, execute, completionOrder) {
  const results = [];
  let cursor = 0;
  async function workerSlot() {
    while (cursor < tasks.length) {
      const task = tasks[cursor];
      cursor += 1;
      const result = await execute(task);
      completionOrder.push(task.id);
      results.push(result);
    }
  }
  await Promise.all(Array.from({ length: Math.min(workerCount, tasks.length) }, () => workerSlot()));
  return results;
}

export function createService() {
  let clock;
  let transformsRead;
  let transformsWrite;
  let tasks = [];
  let channels = [];
  let taskPolicy = [];
  let options;
  let inFlight = false;
  let previousCheckpoint = null;
  const records = [];
  const traces = [];

  async function persistTrace() {
    await writeAtomic(options.tickTracePath, { schema: "fpm.runtime-tick-trace/1", observations: traces });
  }

  async function executeTick(next) {
    if (inFlight) {
      fail("FPM_SCHEDULER_NON_REENTRANT", "The scheduler rejected an overlapping runtime tick.", {
        tick: next,
        nonReentrantTasks: tasks.filter((entry) => entry.metadata.reentrancy === "non-reentrant")
          .map((entry) => entry.id).sort(),
      });
    }
    inFlight = true;
    const completionOrder = [];
    const executions = [];
    const checkpoint = clock.now();
    let stateCommitted = false;
    try {
      if (checkpoint.tick !== previousCheckpoint.tick + 1) {
        fail("FPM_SCHEDULER_CHECKPOINT_MISMATCH", "The scheduler clock did not advance by one world checkpoint.", {
          previous: previousCheckpoint,
          checkpoint,
        });
      }
      const transformSnapshot = transformsRead.snapshot();
      const snapshots = { "runtime.transforms.read": transformSnapshot };
      const pending = new Map(tasks.map((task) => [task.id, task]));
      const completed = new Set();
      const results = [];
      const workerCount = Math.max(1, Math.min(Number.isInteger(options.schedulerWorkerCount)
        ? options.schedulerWorkerCount : tasks.length, Math.max(1, tasks.length)));

      while (pending.size > 0) {
        const ready = [...pending.values()].filter((task) => task.dependencies.every((dependency) => completed.has(dependency)))
          .sort((left, right) => left.id.localeCompare(right.id));
        if (ready.length === 0) {
          fail("FPM_RUNTIME_TASK_DEPENDENCY_BLOCKED", "No task can run because its dependency wave is blocked.", {
            pending: [...pending.keys()].sort(),
          });
        }
        const mainTasks = ready.filter((task) => task.metadata.affinity === "main-thread");
        const workerTasks = ready.filter((task) => task.metadata.affinity === "any-worker");
        const mainPromise = (async () => {
          const output = [];
          for (const task of mainTasks) {
            const emitted = [];
            try {
              const result = await task.value.run(localContext(task, checkpoint, snapshots, emitted));
              completionOrder.push(task.id);
              output.push({ ok: true, task: task.id, threadId: 0, emitted, result: result ?? null });
            } catch (error) {
              completionOrder.push(task.id);
              output.push({ ok: false, task: task.id, threadId: 0, error: {
                code: error?.code ?? "FPM_RUNTIME_TASK_FAILED", message: error?.message ?? "A task failed.",
                details: error?.details ?? {},
              } });
            }
          }
          return output;
        })();
        const workerPromise = workerPool(workerTasks, workerCount, (task) => workerTask(task, checkpoint, snapshots,
          options.schedulerDelays[task.id] ?? 0, options.schedulerTimeoutMs), completionOrder);
        const wave = (await Promise.all([mainPromise, workerPromise])).flat();
        for (const result of wave) {
          results.push(result);
          executions.push({ task: result.task, affinity: pending.get(result.task).metadata.affinity,
            threadKind: result.threadId === 0 ? "main-thread" : "worker", threadId: result.threadId });
          completed.add(result.task);
          pending.delete(result.task);
        }
        const requiredFailure = wave.find((result) => !result.ok
          && tasks.find((task) => task.id === result.task).metadata.required);
        if (requiredFailure) {
          fail(requiredFailure.error.code, requiredFailure.error.message, {
            ...requiredFailure.error.details,
            task: requiredFailure.task,
            discardedBuffers: results.filter((entry) => entry.ok).map((entry) => entry.task).sort(),
          });
        }
      }

      const buffers = results.filter((entry) => entry.ok).flatMap((result) => {
        const byChannel = new Map();
        for (const emitted of result.emitted) {
          const commands = byChannel.get(emitted.channel) ?? [];
          commands.push(emitted.command);
          byChannel.set(emitted.channel, commands);
        }
        return [...byChannel.entries()].map(([channel, commands]) => {
          const buffer = { schema: "fpm.runtime-command-buffer/1", task: result.task,
            checkpoint: structuredClone(checkpoint), channel, commands };
          return { ...buffer, root: root(buffer) };
        });
      });
      let commit = null;
      for (const channel of channels) {
        const byTask = new Map(buffers.filter((entry) => entry.channel === channel.channel)
          .map((entry) => [entry.task, entry]));
        const accepted = channel.order.filter((task) => byTask.has(task)).map((task) => byTask.get(task));
        commit = transformsWrite.commitBatch({
          schema: "fpm.transform-command-batch/1",
          checkpoint: structuredClone(checkpoint),
          expectedRevision: transformSnapshot.revision,
          channel: channel.channel,
          composition: { form: channel.composition, order: channel.order },
          buffers: accepted,
        });
        stateCommitted = true;
      }
      const baseRecord = {
        schema: "fpm.deterministic-tick/1",
        checkpoint: structuredClone(checkpoint),
        tasks: tasks.map((task) => ({ member: task.id, providerInstance: task.providerInstance,
          package: task.package, implementationHash: task.packageContentHash, metadataRoot: task.metadataRoot })),
        taskPolicy: { exclusions: structuredClone(taskPolicy) },
        taskOutcomes: results.map((result) => ({ task: result.task,
          status: result.ok ? "completed" : "dropped-optional",
          error: result.ok ? null : result.error.code })).sort((left, right) => left.task.localeCompare(right.task)),
        snapshots: [{ capability: "runtime.transforms.read", revision: transformSnapshot.revision,
          root: root(transformSnapshot) }],
        commandBuffers: buffers.map((entry) => ({ task: entry.task, channel: entry.channel, root: entry.root }))
          .sort((left, right) => left.task.localeCompare(right.task) || left.channel.localeCompare(right.channel)),
        composition: channels.map((entry) => ({ channel: entry.channel, form: entry.composition,
          order: entry.order })),
        result: commit,
      };
      const record = freeze({ ...baseRecord, identity: root(baseRecord) });
      records.push(record);
      previousCheckpoint = structuredClone(checkpoint);
      traces.push({ tick: checkpoint.tick, workerCount, completionOrder, executions, committed: true });
      try {
        await writeAtomic(options.tickRecordPath, { schema: "fpm.deterministic-tick-log/1", records });
        await persistTrace();
      } catch (error) {
        traces.at(-1).recordWriteError = error?.code ?? "FPM_TICK_RECORD_WRITE_FAILED";
      }
      return record;
    } catch (error) {
      if (!stateCommitted) clock.abort(checkpoint);
      traces.push({ tick: checkpoint.tick, workerCount: options.schedulerWorkerCount ?? tasks.length,
        completionOrder, executions, committed: stateCommitted, error: error?.code ?? "FPM_RUNTIME_TASK_FAILED" });
      await persistTrace();
      throw error;
    } finally {
      inFlight = false;
    }
  }

  return {
    async activate(context) {
      if (!isMainThread) fail("FPM_SCHEDULER_AFFINITY_INVALID", "The scheduler service must activate on the main thread.");
      options = context.options;
      clock = context.require("runtime.clock.tick");
      transformsRead = context.require("runtime.transforms.read");
      transformsWrite = context.require("runtime.transforms.write");
      const restored = context.require("runtime.restore.ready").report();
      if (restored.savedCheckpoint) clock.resume(restored.savedCheckpoint);
      previousCheckpoint = structuredClone(clock.now());
      const collection = context.require("runtime.task");
      taskPolicy = collection.exclusions.map((entry) => ({ member: entry.member, policy: entry.policy,
        reason: entry.reason, providerInstance: entry.providerInstance, package: entry.package,
        implementationHash: entry.packageContentHash, metadataRoot: entry.metadataRoot }));
      for (const exclusion of collection.exclusions) {
        if (exclusion.metadata?.required === true) {
          fail("FPM_REQUIRED_TASK_EXCLUDED", "Policy cannot exclude a required runtime task.", {
            task: exclusion.member,
            policy: exclusion.policy,
          });
        }
      }
      tasks = collection.members.map(validateTask);
      channels = planChannels(tasks);
      if (typeof transformsWrite.commitBatch !== "function") {
        fail("FPM_TRANSFORM_BATCH_AUTHORITY_MISSING", "The selected transform provider lacks atomic batch commit.");
      }
      await rm(options.tickRecordPath, { force: true });
      await rm(options.tickTracePath, { force: true });
      const api = freeze({
        latest: () => records.at(-1) ?? null,
        list: () => freeze(structuredClone(records)),
        trace: () => freeze(structuredClone(traces)),
        executeTick,
      });
      return {
        protocol: "fpm.runtime-service-response/1",
        capabilities: {
          "runtime.scheduler.barrier": freeze({ latest: api.latest }),
          "runtime.scheduler.records": api,
        },
      };
    },
    async tick(next) {
      await executeTick(next);
    },
    async deactivate() {
      tasks = [];
      channels = [];
      taskPolicy = [];
      records.length = 0;
      traces.length = 0;
      clock = null;
      transformsRead = null;
      transformsWrite = null;
      options = null;
      previousCheckpoint = null;
    },
  };
}
