// SPDX-License-Identifier: Apache-2.0

const character = "world:demo/character-1";

export function createService() {
  let clock;
  let transforms;
  let lastCommit = null;
  const status = Object.freeze({ latest: () => lastCommit });
  return {
    async activate(context) {
      clock = context.require("runtime.clock.tick");
      const instances = context.require("runtime.instances.read");
      if (!instances.exists(character)) {
        throw Object.assign(new Error("The demo motion target does not exist."), {
          code: "FPM_RUNTIME_MOTION_TARGET_MISSING",
          details: { instanceId: character },
        });
      }
      transforms = context.require("runtime.transforms.write");
      return {
        protocol: "fpm.runtime-service-response/1",
        capabilities: { "runtime.motion.demo": status },
      };
    },
    async tick() {
      const time = clock.now();
      const x = Number((Math.sin(time.tick * Math.PI / 4) * 0.75).toFixed(6));
      lastCommit = transforms.submit({
        schema: "fpm.transform-command/1",
        instanceId: character,
        translation: [x, 0, 0],
      });
    },
    async deactivate() {
      lastCommit = null;
    },
  };
}
