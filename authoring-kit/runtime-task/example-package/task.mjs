// SPDX-License-Identifier: Apache-2.0

const character = "world:demo/character-1";

export async function runTask(context) {
  const snapshot = context.snapshot("runtime.transforms.read");
  const target = snapshot.transforms.find((entry) => entry.instanceId === character);
  if (!target) {
    throw Object.assign(new Error("The example task target is absent from the immutable snapshot."), {
      code: "EXAMPLE_RUNTIME_TASK_TARGET_MISSING",
      details: { instanceId: character, revision: snapshot.revision },
    });
  }

  context.emit("runtime.transforms.commands", {
    schema: "fgpm.transform-operation/1",
    operation: "add-axis",
    instanceId: character,
    axis: "y",
    value: 0.125,
  });

  return { schema: "example.runtime-task-result/1", observedRevision: snapshot.revision };
}
