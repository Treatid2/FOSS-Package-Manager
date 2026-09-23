// SPDX-License-Identifier: Apache-2.0

export async function runTask(context) {
  const target = context.snapshot("runtime.transforms.read").transforms
    .find((entry) => entry.instanceId === "world:demo/character-1");
  if (!target) throw Object.assign(new Error("The motion target is absent."), {
    code: "FGPM_RUNTIME_MOTION_TARGET_MISSING", details: { instanceId: "world:demo/character-1" },
  });
  context.emit("runtime.transforms.commands", {
    schema: "fgpm.transform-operation/1", operation: "set-axis", instanceId: target.instanceId, axis: "x",
    value: Number((Math.sin(context.checkpoint.tick * Math.PI / 4) * 0.75).toFixed(6)),
  });
  return { schema: "fgpm.task-result/2", observedRevision: target.revision };
}
