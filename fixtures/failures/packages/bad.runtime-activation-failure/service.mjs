// SPDX-License-Identifier: Apache-2.0

export function createService() {
  return {
    async activate(context) {
      context.require("runtime.renderer.window");
      throw new Error("The activation rollback fixture failed after its dependencies activated.");
    },
  };
}
