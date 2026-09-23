// SPDX-License-Identifier: Apache-2.0

export async function runTask(context) {
  context.snapshot("runtime.transforms.read");
  context.emit("runtime.transforms.commands", {
    schema: "fgpm.transform-operation/1", operation: "add-axis",
    instanceId: "world:demo/character-1", axis: "y", value: 0.1,
  });
  return { schema: "fgpm.task-result/2", packageRole: "external-example" };
}
