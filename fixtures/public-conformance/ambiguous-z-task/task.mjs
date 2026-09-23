// SPDX-License-Identifier: Apache-2.0

const TARGET = "world:demo/character-1";

export async function runTask(context) {
  const snapshot = context.snapshot("runtime.transforms.read");
  const target = snapshot.transforms.find((entry) => entry.instanceId === TARGET);
  context.emit("runtime.transforms.commands", {
    schema: "fgpm.transform-operation/1",
    operation: "set-axis",
    instanceId: target.instanceId,
    axis: "x",
    value: 1,
  });
  return { schema: "fresh.z-task-result/1", observedRevision: snapshot.revision };
}
