// SPDX-License-Identifier: Apache-2.0

export function createService() {
  return {
    async activate() {
      return {
        protocol: "fpm.runtime-service-response/1",
        capabilities: {
          "runtime.task": Object.freeze({
            protocol: "fpm.runtime-task/1",
            provider: "service:demo.main-thread-audit/1",
            run: async (context) => {
              if (context.execution.threadKind !== "main-thread") {
                throw Object.assign(new Error("The audit task ran away from its declared affinity."), {
                  code: "FPM_TASK_AFFINITY_VIOLATION",
                  details: { observed: context.execution },
                });
              }
              const snapshot = context.snapshot("runtime.transforms.read");
              return { schema: "fpm.task-result/1", observedRevision: snapshot.revision,
                threadKind: context.execution.threadKind };
            },
          }),
        },
      };
    },
  };
}
