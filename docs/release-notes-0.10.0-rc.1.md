<!-- SPDX-License-Identifier: MPL-2.0 -->
# FGPM 0.10.0-rc.1 release candidate

Version choice: the existing semantic-version grammar supports prereleases.
The additive public package-identity capability warrants the next pre-1.0 minor
version; `rc.1` explicitly distinguishes qualification from release acceptance.
This is greater than 0.9.0 and is not a relabelled unchanged 0.9.0 distribution.

## Included source lineage

- `e37daa7e4940fdc2e9c0f3c65bc4e8e44ed973a9`: corrected manager-hosted dungeon integration.
- `3e9552b5303fe9573d18969f17187ea2d18a11b1`: accepted public non-mutating package identity,
  its schema, docs/tests and managed candidate-build wrapper.
- `ea40f71ebb2d3244d7536a6cd9c1fac4d0f48aee`: accepted inert portable-maintenance
  successor for the integration-host package. This remains outside manager
  resolution roots and is not bundled or activated as manager runtime behavior.
- The release commit named by `manifests/tool-distribution.json`: coherent manager,
  help, generation provenance, packaging and SBOM versioning; release/verification
  documentation; expanded identity qualification and clean-extraction evidence.

## Identities and compatibility

`manager.json.buildIdentity` remains the reviewed build-semantic identity
`sha256:f91fd8fb3623ab57ec7a9edbd360a916c8bc4fb7f4c8593a580fe757e44937f4`.
It is not a binary identity. Resolution, handler dispatch and package-content
hashing semantics have not changed. Runtime payload, source correspondence,
licensing/SBOM and distribution identities are freshly computed separately.
New builds record the new manager version; newly committed generations default
to that version rather than a hardcoded 0.9.0 provenance label. Existing immutable
generations, profiles, package roots and accepted v05 composition remain untouched.
Explicit historical generation-manager labels remain caller-controlled.
The dungeon-v04 integration proof contract deliberately still requires its reviewed
0.9.0 manager; this candidate does not claim to satisfy or rewrite that historical
exact-version proof. Adoption/repinning is a separate project-owned qualification.

Public contract schemas, including `fpm.package-identity/1`, remain unchanged.
The JSON help adds manager metadata; human help includes the same version.
The artifact filename now identifies the exact manager version rather than `v0`.
The distribution kind stays `source-free-reference-authoring-v0` (format identity,
not manager version). Node remains the pinned official Windows x64 24.18.0 runtime.

## Verification, licensing and limitations

Use the standalone README verification path. Member checksums, source commit,
complete corresponding-source bundle/diff, SBOM and full upstream Node notices
accompany the qualification. Manager/runtime tooling is MPL-2.0; public contracts,
authoring material and conformance tests are Apache-2.0; Node carries its complete
upstream licence/third-party notices. SOURCE-LICENSING.md records source boundaries.

Identity reads only quiescent supported trees, rejects root/entry links and
non-regular entries, uses locale/runtime-bound sibling ordering and whole-file
reads, and provides no concurrent-writer snapshot guarantee or hostile-code
containment. Content equality is not schema validity, authenticity, safety,
compatibility, acceptance or permission to execute. No install, publish, deploy,
activation, composition change, release acceptance or cycle closure is performed.
