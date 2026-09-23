// SPDX-License-Identifier: Apache-2.0

const serviceId = "service:example.runtime-task/1";

export function createService() {
  return {
    async activate() {
      return {
        protocol: "fgpm.runtime-service-response/1",
        capabilities: {
          "runtime.task": Object.freeze({
            protocol: "fgpm.runtime-task/1",
            provider: serviceId,
            workerModule: new URL("./task.mjs", import.meta.url).href,
          }),
        },
      };
    },
  };
}
