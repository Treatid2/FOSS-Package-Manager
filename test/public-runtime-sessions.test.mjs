// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { PublicRuntimeSessions } from "../src/core/public-runtime-sessions.mjs";
function fixture() {
  const calls = [];
  class Session {
    start(bytes, input) { calls.push([bytes, input]); return { tick: 0, revision: 0 }; }
    inspect() { return { tick: calls.length }; }
    stop() { calls.push("stop"); return { stopped: true }; }
  }
  const published = { protocol: "test/1", provider: "service:test/1", createSession: () => new Session() };
  const current = { generation: "generation:G0", session: "runtime:R0", controller: { host: { capability: (name) => {
    assert.equal(name, "test"); return published;
  } } } };
  const coordinator = { current, activeState: async () => ({ ownedByCurrentProcess: true, status: "live", active: coordinator.current }) };
  return { sessions: new PublicRuntimeSessions(coordinator), coordinator, calls,
    params: { generation: current.generation, capability: "test", protocol: published.protocol, provider: published.provider,
      methods: ["start", "inspect", "stop"] } };
}
test("public runtime sessions bind generation/provider, decode bytes and call actual package-owned methods", async () => {
  const { sessions, calls, params } = fixture();
  const open = await sessions.open(params);
  const result = await sessions.call({ generation: params.generation, handle: open.handle, method: "start", arguments: [{ $bytes: "AP8=" }, { actor: "test" }] });
  assert.deepEqual(result.value, { tick: 0, revision: 0 });
  assert.deepEqual(calls[0][0], Buffer.from([0, 255]));
  assert.deepEqual(calls[0][1], { actor: "test" });
  assert.equal((await sessions.close({ generation: params.generation, handle: open.handle })).closed, true);
  assert.equal(calls.at(-1), "stop");
});
test("public runtime sessions reject wrong pins, unexposed/prototype methods and invalid bytes before invocation", async () => {
  const { sessions, calls, params } = fixture();
  await assert.rejects(sessions.open({ ...params, provider: "wrong" }), { code: "FGPM_RUNTIME_SESSION_PROVIDER_MISMATCH" });
  const open = await sessions.open(params);
  for (const [name, args, code] of [["constructor", [], "FGPM_RUNTIME_SESSION_METHOD_NOT_EXPOSED"],
    ["start", [{ $bytes: "invalid" }], "FGPM_RUNTIME_SESSION_ARGUMENT_INVALID"]]) {
    await assert.rejects(sessions.call({ generation: params.generation, handle: open.handle, method: name, arguments: args }), { code });
  }
  assert.equal(calls.length, 0);
  await sessions.closeAll();
  assert.equal(calls.length, 1);
});
test("public runtime sessions reject handles from replaced runtime sessions even with the same generation", async () => {
  const { sessions, coordinator, params, calls } = fixture();
  const open = await sessions.open(params);
  coordinator.current = { ...coordinator.current, session: "runtime:R1" };
  await assert.rejects(sessions.call({ generation: params.generation, handle: open.handle, method: "inspect", arguments: [] }), { code: "FGPM_RUNTIME_SESSION_BINDING_MISMATCH" });
  assert.equal(calls.length, 0);
});
test("public runtime sessions reject closed-parameter and forbidden-method input before factory execution", async () => {
  const { sessions, coordinator, params } = fixture();
  let factories = 0;
  coordinator.current.controller.host.capability = () => ({ protocol: params.protocol, provider: params.provider,
    createSession() { factories++; return null; } });
  for (const input of [{ ...params, unknown: true }, { ...params, methods: ["constructor", "stop"] },
    { ...params, methods: [42, "stop"] }, { ...params, protocol: "" }]) {
    await assert.rejects(sessions.open(input), { code: "FGPM_RUNTIME_SESSION_ARGUMENT_INVALID" });
  }
  assert.equal(factories, 0);
});
test("public runtime sessions do not execute method getters, including cleanup getters", async () => {
  const { sessions, coordinator, params } = fixture();
  let getters = 0;
  coordinator.current.controller.host.capability = () => ({ protocol: params.protocol, provider: params.provider,
    createSession: () => ({ get start() { getters++; return () => {}; }, get stop() { getters++; return () => {}; } }) });
  await assert.rejects(sessions.open(params), { code: "FGPM_RUNTIME_SESSION_METHOD_INVALID" });
  assert.equal(getters, 0); assert.equal(sessions.sessions.size, 0);
});
test("public runtime session close retains handles after stop or result-serialization failure", async () => {
  const { sessions, coordinator, params } = fixture();
  let attempts = 0;
  coordinator.current.controller.host.capability = () => ({ protocol: params.protocol, provider: params.provider,
    createSession: () => ({ start() {}, inspect() {}, stop() {
      attempts++; if (attempts === 1) throw new Error("package stop failed");
      if (attempts === 2) return { cannotSerialize: 1n }; return { stopped: true };
    } }) });
  const opened = await sessions.open(params);
  const close = { generation: params.generation, handle: opened.handle };
  await assert.rejects(sessions.close(close), /package stop failed/u);
  assert.equal(sessions.sessions.size, 1);
  await assert.rejects(sessions.close(close), /BigInt/u);
  assert.equal(sessions.sessions.size, 1);
  assert.equal((await sessions.close(close)).closed, true);
  assert.equal(sessions.sessions.size, 0);
});
