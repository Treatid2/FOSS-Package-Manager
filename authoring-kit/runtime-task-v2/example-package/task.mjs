// SPDX-License-Identifier: Apache-2.0

export async function runTask(context) {
  const snapshot = context.snapshot("runtime.transforms.read");
  const target = snapshot.transforms.find((entry) => entry.instanceId === "world:demo/character-1");
  if (!target) throw Object.assign(new Error("The example target is missing."), {
    code: "EXAMPLE_TARGET_MISSING", details: { target: "world:demo/character-1" },
  });
  context.emit("runtime.transforms.commands", {
    schema: "fgpm.transform-operation/1", operation: "add-axis",
    instanceId: target.instanceId, axis: "y", value: 0.1,
  });
  return { schema: "example.runtime-task-result/1", observedRevision: snapshot.revision };
}
