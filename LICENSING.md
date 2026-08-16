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
- `packages/**` example packages, handlers, and runtime implementations;
- `profiles/**` distribution and user-profile examples;
- `fixtures/**` conformance and diagnostic fixtures;
- `test/**` conformance-oriented tests.

The canonical Apache-2.0 text is in [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt).

## Package licences

Independently authored packages are not required to adopt either repository licence. Package manifests should declare an SPDX licence identifier or expression. Open licences are strongly encouraged, and canonical open distributions should not depend on closed packages at structural articulation points.

Licence metadata describes legal terms; it is not a trust, security, compatibility, or quality conclusion.

Generated artifacts under `build/` are reproducible outputs of their inputs and are not committed to the repository. Their licensing must be derived from the contributing packages and build rules rather than assumed from this repository's default.
