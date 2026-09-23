// SPDX-License-Identifier: Apache-2.0

export function createService() {
  return {
    async activate() {
      return {
        protocol: "fgpm.runtime-service-response/1",
        capabilities: {
          "runtime.transforms.migration": Object.freeze({
            protocol: "fgpm.state-migration/1",
            package: "bad.second-transform-migration",
            provider: "service:bad.second-transform-migration/1",
            from: Object.freeze({ semanticSchema: "fgpm.demo.transform-state", schemaVersion: 1 }),
            to: Object.freeze({ semanticSchema: "fgpm.demo.transform-state", schemaVersion: 2 }),
            migrate: (fragment) => fragment,
          }),
        },
      };
    },
  };
}
