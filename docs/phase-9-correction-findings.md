# Phase 9 correction findings and non-claims

## Major findings

- **demonstrated** — A committed generation is the same complete build exported, imported into an empty manager, activated, ticked, and rendered.
- **demonstrated** — Source and fresh-manager execution produce identical generation, runtime-plan, activation-artifact, deterministic-tick, authoritative-state, scene, and render roots.
- **demonstrated** — A profile supplied as an activation override is rejected before transition rather than ignored or attached.
- **demonstrated** — Distribution member corruption is rejected before import or activation.
- **demonstrated** — Target activation failure commits no target session and returns to the prior generation under a newly published rollback session.
- **demonstrated** — The specialist generator is selected from an immutable package root, runs through the artifact transaction boundary, emits domain bytes, and changes identity for generator, package input, parameter, or declared environment changes.
- **demonstrated** — Unrelated installed packages do not change candidate or runtime-plan identity.
- **demonstrated** — At 10, 100, and 1,000 packages, accepted candidates cross the authoritative build boundary; leaf changes remain local while central incompatibility attributes the entire dependent closure.
- **supported but limited** — Scale observations cover synthetic package-only complete builds. Their materialisation stage is explicitly a zero-artifact no-op and is not presented as executable asset-pipeline throughput.
- **supported but limited** — Runtime replay is demonstrated with the portable SVG demonstration runtime, not a production renderer or game engine.
- **inferred** — The split schema families should be easier to evolve independently than the former aggregate schema; compatibility policy remains experimental.

## Non-claims

- Production performance, asymptotic complexity, distributed operation, cryptographic signing, remote provenance, destructive collection, and hot service replacement are not claimed.
- The 10,000-package exploratory case was not run.
- The correction does not establish a typed-artifact provider abstraction.
- Public compatibility remains `experimental-no-compatibility-promise`.

## Unresolved items

No R1–R9 completion blocker remains. Future work may add JSON-Schema execution through an independent validator in addition to the in-process closed-field validator, broaden executable scale fixtures beyond package-only graphs, and decide the next feature phase. Those are follow-on decisions, not silent dependencies of this checkpoint.
