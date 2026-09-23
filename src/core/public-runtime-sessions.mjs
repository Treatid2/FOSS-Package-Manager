// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import { invariant } from "./errors.mjs";

const forbidden = new Set(["constructor", "__proto__", "prototype"]);
function parameters(value, keys) {
  invariant(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)),
  "FGPM_RUNTIME_SESSION_ARGUMENT_INVALID", "Session parameters must contain exactly the documented fields.");
  for (const key of keys.filter((entry) => !["arguments", "methods"].includes(entry))) {
    invariant(typeof value[key] === "string" && value[key].length > 0,
      "FGPM_RUNTIME_SESSION_ARGUMENT_INVALID", "Session identity and method fields must be non-empty strings.", { field: key });
  }
  return value;
}
function method(object, name) {
  invariant(typeof name === "string" && !forbidden.has(name), "FGPM_RUNTIME_SESSION_METHOD_INVALID", "Method name is forbidden.");
  invariant(object && (typeof object === "object" || typeof object === "function"),
    "FGPM_RUNTIME_SESSION_METHOD_INVALID", "A session factory must return an object with explicit methods.");
  const own = Object.getOwnPropertyDescriptor(object, name);
  const inherited = Object.getPrototypeOf(object) === Object.prototype ? null
    : Object.getOwnPropertyDescriptor(Object.getPrototypeOf(object) ?? {}, name);
  const descriptor = own ?? inherited;
  invariant(descriptor && typeof descriptor.value === "function", "FGPM_RUNTIME_SESSION_METHOD_INVALID",
    "Only explicit data-methods on a published session or its immediate prototype are callable.", { method: name });
  return descriptor.value;
}
function decode(value, depth = 0) {
  invariant(depth <= 32, "FGPM_RUNTIME_SESSION_ARGUMENT_INVALID", "Argument depth exceeds 32.");
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => decode(entry, depth + 1));
  if (Object.hasOwn(value, "$bytes")) {
    invariant(Object.keys(value).length === 1 && typeof value.$bytes === "string"
      && value.$bytes.length <= 22369624 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.$bytes),
    "FGPM_RUNTIME_SESSION_ARGUMENT_INVALID", "Byte arguments require canonical base64 up to 16 MiB.");
    const bytes = Buffer.from(value.$bytes, "base64");
    invariant(bytes.length <= 16777216 && bytes.toString("base64") === value.$bytes,
      "FGPM_RUNTIME_SESSION_ARGUMENT_INVALID", "Byte argument is oversized or not canonical base64.");
    return bytes;
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decode(entry, depth + 1)]));
}

/** Public transport for explicit package-owned sessions, not a domain interpreter. */
export class PublicRuntimeSessions {
  constructor(coordinator) { this.coordinator = coordinator; this.sessions = new Map(); }
  async owned(generation, runtimeSession = null) {
    const state = await this.coordinator.activeState();
    const current = this.coordinator.current;
    invariant(state.ownedByCurrentProcess && state.status === "live" && current?.generation === generation
      && (runtimeSession === null || current.session === runtimeSession),
    "FGPM_RUNTIME_SESSION_BINDING_MISMATCH", "Session operation requires the exact live generation owned by this process.",
    { expectedGeneration: generation, expectedSession: runtimeSession, active: state.active });
    return current;
  }
  async open(input) {
    const { generation, capability, protocol, provider, methods } = parameters(input,
      ["generation", "capability", "protocol", "provider", "methods"]);
    const current = await this.owned(generation);
    invariant(typeof capability === "string" && typeof protocol === "string" && typeof provider === "string"
      && Array.isArray(methods) && methods.length > 0 && methods.length <= 16
      && new Set(methods).size === methods.length && methods.includes("stop")
      && methods.every((name) => typeof name === "string" && name.length > 0 && !forbidden.has(name)),
    "FGPM_RUNTIME_SESSION_ARGUMENT_INVALID", "Open requires exact capability/protocol/provider and 1..16 distinct methods including stop.");
    invariant(this.sessions.size < 32, "FGPM_RUNTIME_SESSION_LIMIT", "At most 32 capability sessions may be open.");
    const published = current.controller.host.capability(capability);
    invariant(published?.protocol === protocol && published?.provider === provider,
      "FGPM_RUNTIME_SESSION_PROVIDER_MISMATCH", "Published capability does not match exact protocol/provider pins.", { capability, protocol, provider });
    const factory = Object.getOwnPropertyDescriptor(published, "createSession");
    invariant(typeof factory?.value === "function", "FGPM_RUNTIME_SESSION_FACTORY_UNAVAILABLE", "Capability has no explicit createSession factory.");
    const instance = await factory.value.call(published);
    try { for (const name of methods) method(instance, name); }
    catch (error) {
      let stop;
      try { stop = method(instance, "stop"); } catch {}
      if (stop) await stop.call(instance);
      throw error;
    }
    const handle = `session:${randomUUID()}`;
    const record = { generation, runtimeSession: current.session, capability, protocol, provider, methods: [...methods], instance };
    this.sessions.set(handle, record);
    return { schema: "fgpm.public-runtime-session/1", handle, generation, runtimeSession: current.session, capability, protocol, provider, methods };
  }
  async call(input) {
    const { generation, handle, method: name, arguments: args } = parameters(input,
      ["generation", "handle", "method", "arguments"]);
    const record = this.sessions.get(handle);
    invariant(record && record.generation === generation, "FGPM_RUNTIME_SESSION_HANDLE_UNKNOWN", "Capability session handle is unknown for this generation.", { handle, generation });
    await this.owned(generation, record.runtimeSession);
    invariant(record.methods.includes(name), "FGPM_RUNTIME_SESSION_METHOD_NOT_EXPOSED", "Method was not explicitly exposed when this session opened.", { method: name });
    invariant(Array.isArray(args) && args.length <= 16, "FGPM_RUNTIME_SESSION_ARGUMENT_INVALID", "Call requires an array of at most 16 JSON arguments.");
    const value = await method(record.instance, name).apply(record.instance, args.map((entry) => decode(entry)));
    // Serialization failures are operation errors, not successful partial responses.
    const encoded = value === undefined ? null : JSON.parse(JSON.stringify(value));
    return { schema: "fgpm.public-runtime-session-call/1", handle, generation, runtimeSession: record.runtimeSession,
      capability: record.capability, protocol: record.protocol, provider: record.provider, method: name, value: encoded };
  }
  async close(input) {
    const { generation, handle } = parameters(input, ["generation", "handle"]);
    const record = this.sessions.get(handle);
    invariant(record && record.generation === generation, "FGPM_RUNTIME_SESSION_HANDLE_UNKNOWN", "Capability session handle is unknown for this generation.", { handle, generation });
    await this.owned(generation, record.runtimeSession);
    const value = await method(record.instance, "stop").call(record.instance);
    const encoded = value === undefined ? null : JSON.parse(JSON.stringify(value));
    this.sessions.delete(handle);
    return { schema: "fgpm.public-runtime-session-close/1", handle, generation, runtimeSession: record.runtimeSession,
      capability: record.capability, protocol: record.protocol, provider: record.provider, value: encoded, closed: true };
  }
  async closeAll() {
    for (const [handle, record] of this.sessions) {
      await this.close({ generation: record.generation, handle });
    }
  }
}
