<!-- SPDX-License-Identifier: MPL-2.0 -->

# Phase 9 runtime-generation transition

Phase 9 implements one conservative transition: full generation restart with one persistent
checkpoint and rollback.

## Commit boundary

```text
verify committed G1
  -> capture one G0 checkpoint
  -> preflight required/optional owners
  -> stop G0
  -> activate and restore G1
  -> commit G1 runtime session
  -> move active-generation reference
```

The last step is the externally authoritative commit. Generation commit remains separate and does
not activate anything.

## Failure

If G1 activation or restore fails, no G1 session or active reference is published. The coordinator
reactivates G0 from the same checkpoint, retains an attributed failure event, and verifies that the
old active reference remains authoritative. A required absent state owner blocks before G0 stops;
an optional absent fragment is retained opaquely.

## Executable evidence

Tests cover deliberately controlled runtime factories and the actual Phase 8 runtime:

- build and activate the base generation;
- advance deterministic ticks and capture a real `fpm.world-save/1` checkpoint;
- stop base, activate Green Head, and restore persistent instances;
- commit the Green Head session and then move the active reference;
- deliberately fail replacement activation and restore the Green Head generation from the same
  checkpoint while leaving its active reference unchanged;
- explicitly transition back to an earlier generation and receive a new session identity.

Within each runtime generation the capability collections remain fixed. There is no live member
registration, individual service replacement, dual-running generation, zero-downtime handover, or
multiplayer coordination.

