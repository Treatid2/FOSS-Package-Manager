// SPDX-License-Identifier: Apache-2.0

export function createService() {
  return {
    async activate(context) {
      context.require("runtime.transforms.read");
      context.require("runtime.transforms.write");
      return {
        protocol: "fpm.runtime-service-response/1",
        capabilities: { "runtime.fixture.authority": {} },
      };
    },
  };
}
