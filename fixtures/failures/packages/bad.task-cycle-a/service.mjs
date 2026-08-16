// SPDX-License-Identifier: Apache-2.0

export function createService() {
  return { async activate() { return { protocol: "fpm.runtime-service-response/1", capabilities: {
    "runtime.task": Object.freeze({ protocol: "fpm.runtime-task/1", provider: "service:bad.task-cycle-a/1",
      workerModule: new URL("./task.mjs", import.meta.url).href }),
  } }; } };
}
