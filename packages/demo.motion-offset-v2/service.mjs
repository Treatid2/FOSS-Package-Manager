// SPDX-License-Identifier: Apache-2.0

export function createService() {
  return { async activate() { return { protocol: "fgpm.runtime-service-response/2", capabilities: {
    "runtime.task": Object.freeze({ protocol: "fgpm.runtime-task/2", provider: "service:demo.motion-offset-v2/1",
      workerModule: new URL("./task.mjs", import.meta.url).href }),
  } }; } };
}
