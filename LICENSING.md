# Licensing

This repository deliberately uses two open-source licences with explicit file boundaries.

## MPL-2.0: reference manager and core

Unless a file or path is listed under the Apache-2.0 boundary below, it is licensed under the Mozilla Public License 2.0 (`MPL-2.0`). This includes:

- `src/**`;
- `manager.json` and the root `package.json`;
- the project overview and architectural design notes;
- future reference-manager implementation files not explicitly assigned another licence.

The canonical MPL-2.0 text is in [LICENSE](LICENSE).

## Apache-2.0: public language and independently implementable material

The following paths are licensed under the Apache License 2.0 (`Apache-2.0`):

- `docs/prototype-formats.md` and future public package-language specifications or schemas that carry the same SPDX identifier;
- `contracts/**` experimental public architecture/schema registries;
- `packages/**` example packages, handlers, and runtime implementations;
- `profiles/**` distribution and user-profile examples;
- `fixtures/**` conformance and diagnostic fixtures;
- `test/**` conformance-oriented tests.
- `authoring-kit/**` public package-authoring contracts, examples, and evaluation material.
- `tools/generate-wasm-fixtures.mjs`, which generates the portable example and conformance modules.
- `tools/render-architecture-snapshot.mjs`, which renders the experimental architecture snapshot.
- `docs/reference-authoring-guide.md` and `docs/reference-tools-readme.md`, which form the public
  source-free authoring documentation.

`tools/build-reference-distribution.mjs` is manager build tooling and is licensed under MPL-2.0.
The generated distribution preserves the source licences recorded by its SBOM and source
correspondence manifest. `LICENSES/Node.js.txt` is the exact complete root licence and third-party
notice set supplied with the pinned official Node.js runtime distribution; its provenance and hashes
are declared in `reference-runtime.json` and projected into the generated SBOM.

The canonical Apache-2.0 text is in [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt).

## Package licences

Independently authored packages are not required to adopt either repository licence. Package manifests should declare an SPDX licence identifier or expression. Open licences are strongly encouraged, and canonical open distributions should not depend on closed packages at structural articulation points.

Licence metadata describes legal terms; it is not a trust, security, compatibility, or quality conclusion.

Generated artifacts under `build/` are reproducible outputs of their inputs and are not committed to the repository. Their licensing must be derived from the contributing packages and build rules rather than assumed from this repository's default.
