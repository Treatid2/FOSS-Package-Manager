// SPDX-License-Identifier: Apache-2.0

export function createService() {
  let tick = 0;
  const clock = Object.freeze({
    now: () => Object.freeze({ schema: "fpm.runtime-tick/1", tick, seconds: tick / 4 }),
  });
  return {
    async activate() {
      return {
        protocol: "fpm.runtime-service-response/1",
        capabilities: { "runtime.clock.tick": clock },
      };
    },
    async tick(next) {
      tick = next;
    },
    async deactivate() {
      tick = 0;
    },
  };
}
