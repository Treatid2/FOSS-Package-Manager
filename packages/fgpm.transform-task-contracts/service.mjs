// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

const channel = "runtime.transforms.commands";
const vocabulary = "fgpm.transform-task-vocabulary/1";
const steward = "fgpm.transform-task-contracts@1.0.0";
const numericScale = 1_000_000;
const stages = Object.freeze([
  Object.freeze({ id: "set-axis", law: "exclusive-per-target" }),
  Object.freeze({ id: "add-axis", law: "deterministic-sum-per-target" }),
]);

function fail(code, message, details = {}) {
  throw Object.assign(new Error(message), { code, details: { vocabulary, steward, ...details } });
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

function microUnits(value, details) {
  const units = value * numericScale;
  if (!Number.isFinite(value) || !Number.isSafeInteger(units)) {
    fail("FGPM_RUNTIME_TRANSFORM_NUMERIC_INVALID",
      "A transform value is outside the exact six-decimal fixed-point model.", {
        ...details, value, scale: numericScale, mutationCommitted: false,
      });
  }
  return Object.is(units, -0) ? 0 : units;
}

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function declaration(contributor) {
  const output = contributor.metadata.outputs.find((entry) => entry.channel === channel);
  if (!output || output.vocabulary !== vocabulary) {
    fail("FGPM_TASK_CHANNEL_VOCABULARY_MISMATCH", "A transform contributor names the wrong channel vocabulary.", {
      task: contributor.id, channel, actualVocabulary: output?.vocabulary ?? null,
    });
  }
  const stage = stages.find((entry) => entry.id === output.stage);
  if (!stage || stage.law !== output.law) {
    fail("FGPM_TASK_COMPOSITION_STAGE_UNKNOWN", "A transform contributor names an unknown stage or law.", {
      task: contributor.id, channel, stage: output.stage, law: output.law,
      supported: stages,
    });
  }
  return { task: contributor.id, stage: stage.id, law: stage.law };
}

function planChannel(contributors) {
  const declared = contributors.map(declaration).sort((left, right) => {
    const stageOrder = stages.findIndex((entry) => entry.id === left.stage)
      - stages.findIndex((entry) => entry.id === right.stage);
    return stageOrder || left.task.localeCompare(right.task);
  });
  return freeze({
    schema: "fgpm.command-channel-plan/1",
    channel,
    vocabulary,
    steward,
    rule: "fgpm.transform.staged-axis-compose/1",
    stages: stages.map((entry) => ({ ...entry })),
    contributors: declared,
    prospectiveCommitOrder: declared.map((entry) => entry.task),
  });
}

function compose(plan, buffers) {
  if (plan?.schema !== "fgpm.command-channel-plan/1" || plan.vocabulary !== vocabulary
    || !Array.isArray(buffers)) {
    fail("FGPM_TASK_COMPOSITION_INPUT_INVALID", "The transform vocabulary received an invalid composition request.");
  }
  const declarations = new Map(plan.contributors.map((entry) => [entry.task, entry]));
  const byTask = new Map();
  const baseTargets = new Map();
  for (const buffer of buffers) {
    const declared = declarations.get(buffer.task);
    if (!declared || buffer.schema !== "fgpm.runtime-command-buffer/2" || buffer.channel !== channel
      || !Array.isArray(buffer.commands)) {
      fail("FGPM_TASK_COMPOSITION_BUFFER_INVALID", "A command buffer is outside the vocabulary plan.", {
        task: buffer?.task ?? null,
      });
    }
    const { root: declaredRoot, ...content } = buffer;
    if (declaredRoot !== root(content)) {
      fail("FGPM_TASK_COMPOSITION_BUFFER_INVALID", "A command buffer root does not match its content.", {
        task: buffer.task,
      });
    }
    for (const command of buffer.commands) {
      if (command?.schema !== "fgpm.transform-operation/1" || command.operation !== declared.stage
        || typeof command.instanceId !== "string" || !["x", "y", "z"].includes(command.axis)
        || !Number.isFinite(command.value)) {
        fail("FGPM_RUNTIME_TRANSFORM_COMMAND_INVALID", "A command does not conform to its declared transform stage.", {
          task: buffer.task, stage: declared.stage, command,
        });
      }
      microUnits(command.value, { task: buffer.task, command });
      if (declared.stage === "set-axis") {
        const target = `${command.instanceId}\u0000${command.axis}`;
        const contributors = baseTargets.get(target) ?? [];
        contributors.push(buffer.task);
        baseTargets.set(target, contributors);
      }
    }
    byTask.set(buffer.task, buffer);
  }
  const ambiguity = [...baseTargets.entries()].find(([, contributors]) => contributors.length > 1);
  if (ambiguity) {
    const [target, contributors] = ambiguity;
    const [instanceId, axis] = target.split("\u0000");
    fail("FGPM_TASK_COMMAND_COMPOSITION_AMBIGUOUS",
      "The exclusive base stage has several contributors for one transform target.", {
        channel, stage: "set-axis", law: "exclusive-per-target", instanceId, axis,
        contributors: contributors.sort(), mutationCommitted: false,
      });
  }
  const ordered = plan.prospectiveCommitOrder.filter((task) => byTask.has(task)).map((task) => byTask.get(task));
  const stagedUnits = new Map();
  for (const buffer of ordered) {
    for (const command of buffer.commands) {
      const target = `${command.instanceId}\u0000${command.axis}`;
      const units = microUnits(command.value, { task: buffer.task, command });
      const next = command.operation === "set-axis" ? units : (stagedUnits.get(target) ?? 0) + units;
      if (!Number.isSafeInteger(next)) {
        fail("FGPM_RUNTIME_TRANSFORM_NUMERIC_OVERFLOW",
          "Transform contributions overflow the exact six-decimal fixed-point model.", {
            task: buffer.task, command, scale: numericScale, mutationCommitted: false,
          });
      }
      stagedUnits.set(target, Object.is(next, -0) ? 0 : next);
    }
  }
  return freeze({
    buffers: ordered,
    record: {
      schema: "fgpm.command-channel-composition/1",
      channel,
      vocabulary,
      steward,
      rule: plan.rule,
      stages: plan.stages.map((stage) => ({
        ...stage,
        contributors: plan.contributors.filter((entry) => entry.stage === stage.id).map((entry) => entry.task),
      })),
      commitOrder: ordered.map((entry) => entry.task),
    },
  });
}

export function createService() {
  return {
    async activate() {
      return {
        protocol: "fgpm.runtime-service-response/2",
        capabilities: {
          "runtime.task-channel.transforms": freeze({
            protocol: "fgpm.command-channel-vocabulary/1",
            vocabulary,
            steward,
            channel,
            planChannel,
            compose,
          }),
        },
      };
    },
  };
}
