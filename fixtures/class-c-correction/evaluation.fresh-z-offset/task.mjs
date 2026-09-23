// SPDX-License-Identifier: Apache-2.0

export async function runTask(context) {
  const snapshot = context.snapshot("runtime.transforms.read");
  const target = snapshot.transforms.find((entry) => entry.instanceId === "world:demo/character-1");
  if (!target) throw Object.assign(new Error("The evaluation target is missing."), {
    code: "FGPM_EVALUATION_TARGET_MISSING", details: { target: "world:demo/character-1" },
  });
  context.emit("runtime.transforms.commands", {
    schema: "fgpm.transform-operation/1", operation: "add-axis",
    instanceId: target.instanceId, axis: "z", value: 0.375,
  });
  return { schema: "evaluation.fresh-z-offset-result/1", observedRevision: snapshot.revision };
}
