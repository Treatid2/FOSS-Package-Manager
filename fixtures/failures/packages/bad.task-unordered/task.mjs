// SPDX-License-Identifier: Apache-2.0

export async function runTask(context) {
  context.emit("runtime.transforms.commands", { schema: "fgpm.transform-operation/1", operation: "add-axis",
    instanceId: "world:demo/character-1", axis: "x", value: 99 });
}
