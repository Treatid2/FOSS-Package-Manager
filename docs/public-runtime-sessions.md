<!-- SPDX-License-Identifier: Apache-2.0 -->
# Public package-owned runtime sessions (0.11.0-rc.6 candidate)

This additive control boundary is not present in rc.1. Do not use the candidate
downstream until it has been assessed. The legacy dungeon-v04 proof contract and
accepted v05 inputs remain unchanged.

Start one persistent `fgpm.cmd control --manager-root <isolated-store>` process.
All requests/responses are the public `fgpm.control-request/1` / `fgpm.control-response/1`
JSONL envelopes. Begin with control.describe. Import/plan/build/validate/commit
using normal public operations, then generation.activate the exact generation.
No caller imports manager/package implementation source.

Open a selected published capability's explicit createSession factory:

```json
{"schema":"fgpm.control-request/1","requestId":"open-1","operation":"runtime.session.open","parameters":{"generation":"sha256:<committed-generation>","capability":"<package-public-capability>","protocol":"<package-public-protocol>","provider":"<selected-service>","methods":["start","inspect","applyIntent","stop"]}}
```

The response is `fgpm.control-response/1`; its `result` is
`fgpm.public-runtime-session/1`: handle, generation, original runtimeSession,
capability/protocol/provider and exposed methods. Every pin must
match the live generation owned by this process. The factory must be an own
function-valued data property; methods must be own or immediate-prototype data
functions (no getter execution or Object.prototype methods). stop is required.
At most 32 handles, with at most 16 distinct methods each, may be open.

```json
{"schema":"fgpm.control-request/1","requestId":"call-1","operation":"runtime.session.call","parameters":{"generation":"sha256:<same-generation>","handle":"session:<returned-handle>","method":"start","arguments":[{"$bytes":"<canonical-base64>"},{"<package-start-contract>":"<values>"}]}}
```

Call accepts up to 16 JSON arguments. A single-member `$bytes` object denotes
canonical base64, decoded to a Buffer, up to 16 MiB; nested arguments have a
32-level bound. Ordinary objects are ordinary package-owned contract values.
The existing JSONL transport additionally limits the complete request line to
1 MiB, so external byte payloads must fit that smaller encoded envelope limit.
The method must have been explicitly exposed. The response is
`fgpm.control-response/1`; its `result` is
`fgpm.public-runtime-session-call/1` with the same identity links, method and value.
Package results must be JSON serializable; undefined becomes null. A package
operation may mutate before throwing or failing serialization. No generic
transactionality/rollback/safety claim is made. Invocation preserves the package's
own validation, sequence/replay and provider semantics.
The existing combined manager/runtime authority projection is not a package-domain
state hash; use returned package receipts and inspect methods to audit domain state.

```json
{"schema":"fgpm.control-request/1","requestId":"close-1","operation":"runtime.session.close","parameters":{"generation":"sha256:<same-generation>","handle":"session:<returned-handle>"}}
```

The close response is `fgpm.control-response/1`; its `result` is
`fgpm.public-runtime-session-close/1`. Close calls package stop before removing
its handle. A failed stop retains it.
Runtime shutdown/transition/EOF stop outstanding handles before host services
deactivate. A rejected transition precondition does not close them. Once the owned
runtime session changes, including reactivation of the same generation, old
handles cannot invoke anything. Handles are process-local, not persistent state.

For a concrete source-free verification of the placeholders above, use the
packaged public qualification kit. Its `qualification.public-session` fixture
binds capability `qualification.public-session`, protocol
`qualification.public-session/1`, provider
`service:qualification.public-session/1`, and methods `start`, `inspect`, and
`stop`. Case `PQ-007` opens the session, `PQ-008` calls `start` with canonical
base64 `AP8=` plus `{ "public": true }`, and `PQ-013` closes the returned handle.
The retained `requests.jsonl` and manager JSONL output are the authoritative
request/response evidence; illustrative angle-bracket values are not literal
inputs.

Human callers can send these JSONL requests directly; the companion harness
formats the same returned decisions and retains complete raw structured evidence.
All diagnostic codes/failure causes are surfaced by the public control envelope.
Wrong ownership/pins, missing factory, unexposed methods, unknown handles and
malformed byte arguments fail explicitly. Native package code retains invoking
user authority. Identity/pin checks are not hostile-code containment or execution
permission. Provider/domain contracts remain package/project-owned.
