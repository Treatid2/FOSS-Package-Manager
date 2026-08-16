<!-- SPDX-License-Identifier: Apache-2.0 -->

# Prototype format notes

All formats are provisional and use exact versioned identifiers.

## Core package envelope

Every package contains `fpm-package.json` with `schema: "fpm.package/1"`. The manager understands only:

- package identity and semantic version;
- SPDX licence identifier or expression;
- package dependencies and version ranges;
- provided and required capabilities;
- contribution identity, manifest type, and manifest location;
- handler declarations and their accepted/buildable types;
- public replacement intent.

The manager validates paths before passing a domain manifest to a handler. Contribution and handler code remain inside the owning package directory.

## Profiles

A `fpm.profile/1` document supplies the inputs that are not intrinsic to packages:

- package roots available for discovery;
- root packages requested by the distribution/user;
- explicit capability providers where more than one is valid;
- explicit handler selections where more than one accepts a dialect;
- explicit replacement choices where more than one proposal is valid;
- the requested entry point, artifact type, builder, and runtime activation.

This makes determinism relative to the package set, manager, policy/profile, target environment, and explicit selections.

## Handler protocol

Handlers declare `fpm.handler-stdio/1` in the core manifest. The manager starts the command without a shell and writes one `fpm.handler-request/1` JSON document to stdin. The handler writes one `fpm.handler-response/1` JSON document to stdout.

The implemented actions are:

- `analyze`: read one opaque domain manifest and report typed exports, hooks, and runtime activations;
- `build`: consume the resolved normalized reports and bindings and return one JSON artifact.

Handlers return structured negative responses as well as successful results. Process failure, invalid JSON, unsupported protocols, and domain rejection remain distinguishable diagnostics.

## Normalized analysis vocabulary

The currently shared vocabulary is intentionally small:

```text
export:
    public id
    semantic type
    opaque handler-owned payload

hook:
    public id
    required semantic type
    default export id

activation:
    id
    accepted artifact types
    command
```

The manager understands identity, type compatibility, ownership, and selection. It does not interpret export payloads.

## Lockfile and provenance

`fpm.lock/1` records reproducibility inputs and decisions. Package hashes cover every file in the package directory. The output artifact is separately hashed.

`fpm.provenance/1` is optimized for explanation: which package and handler produced each public export, why each hook selected its current binding, and which builder materialized the artifact.
