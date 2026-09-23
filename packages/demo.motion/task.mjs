// SPDX-License-Identifier: Apache-2.0

const character = "world:demo/character-1";

export async function runTask(context) {
  const snapshot = context.snapshot("runtime.transforms.read");
  const target = snapshot.transforms.find((entry) => entry.instanceId === character);
  if (!target) {
    throw Object.assign(new Error("The demo motion target does not exist in the immutable snapshot."), {
      code: "FGPM_RUNTIME_MOTION_TARGET_MISSING",
      details: { instanceId: character, revision: snapshot.revision },
    });
  }
  const x = Number((Math.sin(context.checkpoint.tick * Math.PI / 4) * 0.75).toFixed(6));
  context.emit("runtime.transforms.commands", {
    schema: "fgpm.transform-operation/1",
    operation: "set-axis",
    instanceId: character,
    axis: "x",
    value: x,
  });
  return { schema: "fgpm.task-result/1", observedRevision: snapshot.revision };
}
