// SPDX-License-Identifier: Apache-2.0

const TARGET = "world:demo/character-1";

export async function runTask(context) {
  const snapshot = context.snapshot("runtime.transforms.read");
  const target = snapshot.transforms.find((entry) => entry.instanceId === TARGET);

  if (!target) {
    throw Object.assign(new Error("The fresh Z-task target is missing."), {
      code: "FRESH_Z_TARGET_MISSING",
      details: { target: TARGET },
    });
  }

  context.emit("runtime.transforms.commands", {
    schema: "fgpm.transform-operation/1",
    operation: "add-axis",
    instanceId: target.instanceId,
    axis: "z",
    value: 0.375,
  });

  return {
    schema: "fresh.z-task-result/1",
    observedRevision: snapshot.revision,
  };
}
