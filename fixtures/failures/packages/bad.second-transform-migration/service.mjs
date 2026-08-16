// SPDX-License-Identifier: Apache-2.0

export function createService() {
  return {
    async activate() {
      return {
        protocol: "fpm.runtime-service-response/1",
        capabilities: {
          "runtime.transforms.migration": Object.freeze({
            protocol: "fpm.state-migration/1",
            package: "bad.second-transform-migration",
            provider: "service:bad.second-transform-migration/1",
            from: Object.freeze({ semanticSchema: "fpm.demo.transform-state", schemaVersion: 1 }),
            to: Object.freeze({ semanticSchema: "fpm.demo.transform-state", schemaVersion: 2 }),
            migrate: (fragment) => fragment,
          }),
        },
      };
    },
  };
}
