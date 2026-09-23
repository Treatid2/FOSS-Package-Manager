# Final human-boundary correction map

This map precedes implementation of the bounded `FGPM-MSG-000024` correction.

## Preserved baseline

- manager: `7e902ccdd176edc56f4f0bfbb461108284b3f894`;
- Reference World: `7498b334c218789805e2a245e06054fc1a6f01ba`;
- G0 generation/distribution: `sha256:b98dc76ccc3d51d3f7568ac826c526178f65bf23ff03a8bab7181cd26e1cd9f2` / `sha256:e9edf01473bad14ac379d8b5886c94835a1d4d763fa8e312b9277b644c02bca9`;
- G1 generation/distribution: `sha256:75e91cca0a4174fa7f58dee8506f8bdcbfb9875c83c3ef1f165fcf8fa221e646` / `sha256:804c087f11de0d245240e617f0df48264c7dc808c658b138c5804047a96de649`;
- accepted target complete build: `sha256:1244b6b6bbd584122a9e0e5697545d28cc51b78c1bb8551aed39bc9129df1ad9`.

The manager-owned Workbench, JSONL protocol, portable workspace journal, retained releases, and project package semantics remain unchanged except where the H1-H4 public boundaries require a generic correction.

## H1: descriptor entry boundary

`loadWorkbenchProject()` must run the complete closed `fgpm.project/2` contract before returning a project. The validator must reject unknown fields, identity-format errors, unsupported mechanisms, unsafe relative paths, descriptor/schema disagreement, and inconsistent release/current/workspace relationships with a structured JSON path, rule, and supplied value. No manager process or semantic operation starts before this succeeds.

## H2-H3: target facts and atomic commit

Project-owned fixture data declares exact-build target facts and expected identities. Generic Workbench code compares those facts with the current manager host and presents compatible exact rebuild, portable retained-release activation, or deliberate new-generation choices. `generation.commit` gains an optional expected-generation precondition which is checked before any workspace/base authority moves.

## H4: truthful operation authority

`control.describe` publishes machine-readable category, maturity, guided-human, headless, agent, authority-moving, confirmation, and failure-boundary metadata. An initial curator capability profile is derived locally from that metadata. Its semantic set is tested as a subset of the ordinary guided project-supported human set; expert JSON access is excluded from that proof.

## Evidence boundary

Focused evidence must include descriptor mutations, target/mismatch comparison, atomic no-movement, operation-set parity, keyboard G0-to-G1 flow, focus/live regions, responsive/contrast/motion audits, complete regressions, root preservation, generic-source scan, and the FGRW/package/publication non-contact audit.

