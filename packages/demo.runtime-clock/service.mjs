// SPDX-License-Identifier: Apache-2.0

export function createService() {
  let tick = 0;
  let base = 0;
  const clock = Object.freeze({
    now: () => Object.freeze({ schema: "fgpm.runtime-tick/1", tick, seconds: tick / 4 }),
    resume: (checkpoint) => {
      if (tick !== 0 || checkpoint?.schema !== "fgpm.runtime-tick/1"
        || !Number.isInteger(checkpoint.tick) || checkpoint.tick < 0) {
        throw Object.assign(new Error("The runtime clock cannot resume from this checkpoint."), {
          code: "FGPM_RUNTIME_CLOCK_RESUME_INVALID",
          details: { current: tick, checkpoint },
        });
      }
      base = checkpoint.tick;
      tick = base;
      return clock.now();
    },
    abort: (checkpoint) => {
      if (checkpoint?.schema === "fgpm.runtime-tick/1" && checkpoint.tick === tick && tick > base) tick -= 1;
      return Object.freeze({ schema: "fgpm.runtime-tick/1", tick, seconds: tick / 4 });
    },
  });
  return {
    async activate() {
      return {
        protocol: "fgpm.runtime-service-response/1",
        capabilities: { "runtime.clock.tick": clock },
      };
    },
    async tick(next) {
      tick = base + next;
    },
    async deactivate() {
      tick = 0;
      base = 0;
    },
  };
}
