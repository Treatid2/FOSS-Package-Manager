// SPDX-License-Identifier: Apache-2.0
// Public test-owned package, not manager or Reference World implementation code.
export function createService() {
  let outstanding = 0;
  class Session {
    constructor() { this.calls = 0; this.stopped = false; outstanding++; }
    start(bytes, input) { this.calls++; return { bytes: [...bytes], input, calls: this.calls }; }
    inspect() { return { calls: this.calls, stopped: this.stopped }; }
    stop() { if (!this.stopped) outstanding--; this.stopped = true; return this.inspect(); }
  }
  return {
    async activate() {
      return { protocol: "fgpm.runtime-service-response/2", capabilities: {
        "qualification.public-session": { protocol: "qualification.public-session/1",
          provider: "service:qualification.public-session/1", createSession: () => new Session() }
      } };
    },
    async deactivate() { if (outstanding !== 0) throw new Error("Outstanding public sessions were not stopped before service deactivation"); }
  };
}
