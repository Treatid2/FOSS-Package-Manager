<!-- SPDX-License-Identifier: Apache-2.0 -->

# Corrected runtime-task v2 authoring kit

This kit is the Phase 8 public authoring surface for one native worker task. It is sufficient
to author and mechanically check a package without reading manager source or existing producer
implementations. The contract is experimental and makes no compatibility promise.

## Contents

- `contract.md` — identities, strict fields, runtime envelopes, composition, policy, CLI,
  diagnostics, and trust limits;
- `example-package/` — a complete Apache-2.0 package which contributes `+0.1` on the demo
  character's Y axis;
- `public/` — the Apache-2.0 machine-readable schemas and stewarded vocabularies used by this
  checkpoint;
- `PUBLIC-CONTRACTS.sha256` and `verify-public-contracts.mjs` — the exact local contract
  manifest and a standalone verifier for the kit and installed manager;
- `self-check-profile.json` — a relocatable profile which declares only this kit's local
  package root;
- `external-test-brief.md` — the brief for a later second fresh-author retest. Do not treat
  the repository's mechanical test as that retest.

The kit carries checkpoint copies of the machine-readable definitions in `public/schemas/`
and `public/vocabularies/`. Verify their exact file set and hashes against the installed
distribution before a retest:

```powershell
node .\verify-public-contracts.mjs "<fgpm>\public"
```

The required identities are:

- `fgpm.package/2`;
- `fgpm.profile/3`;
- `fgpm.runtime-service/2` and `fgpm.runtime-service-response/2`;
- `fgpm.runtime-task-member/2`, `fgpm.runtime-task/2`, and
  `fgpm.runtime-task-worker-response/2`;
- `fgpm.runtime-task-vocabulary/2`;
- `fgpm.transform-task-vocabulary/1`.

Every package uses the exact `fgpm-package.json` entrypoint and declares `format`,
publisher `namespace`, immutable local `name`, package `version`, and licence. See
`docs/package-entrypoint-and-identity.md` in the manager source for the boundary and
finite pre-public migration rules.

## Mechanical self-check

PowerShell, from this directory:

```powershell
$Fgpm = Resolve-Path "..\.."
node .\verify-public-contracts.mjs "$Fgpm\public"
node "$Fgpm\src\cli.mjs" validate-package example-package
node "$Fgpm\src\cli.mjs" validate-profile self-check-profile.json `
  --packages "$Fgpm\packages"
node "$Fgpm\src\cli.mjs" conformance runtime-task self-check-profile.json `
  --focus "task:example.runtime-task-v2/add-y/1" `
  --packages "$Fgpm\packages" --out .\out
```

Expected results are `status: valid` for package/profile validation and `status: pass` for
conformance. `--focus` must name an exact selected `runtime.task` member which contributes to
the relevant channel. The generic matrix uses one worker, four workers with the focus delayed,
and four workers with a recorded peer delayed. The report identifies that peer and its
non-semantic selection reason. It must show deterministic record, authoritative output-transform,
and SVG invariance; worker counts, delays, threads, and completion order are observational.

For retained evidence, this command explains the channel without reading source:

```powershell
node "$Fgpm\src\cli.mjs" explain runtime `
  .\out\single-worker\runtime-lifecycle.json runtime.transforms.commands
```

The result names `fgpm.transform-task-vocabulary/1`, steward
`fgpm.transform-task-contracts@1.0.0`, both stages/laws, and every contributor. A task member
identity instead returns its collection membership and any exact-member exclusion/policy.

To relocate the kit, copy this directory anywhere and replace `$Fgpm` with the manager/tool
installation path. No authored JSON document needs that installation path: `--packages`
supplies the separately installed demonstration distribution root.

## Start your own package

1. Copy `example-package/` and change the package, service, binding, and task member
   identities consistently.
2. Keep the dependencies on `fgpm.runtime-task-contracts` and
   `fgpm.transform-task-contracts`; do not add a scheduler dependency.
3. Choose the vocabulary-owned `set-axis` or `add-axis` stage and its exact law.
4. Change `task.mjs`, retaining the reduced snapshot/emit interface.
5. Run `validate-package` before adding the package to a profile.
6. Add its package ID to distribution roots or `user.roots`, then run `validate-profile` and
   `conformance runtime-task --focus <your-exact-task-member>`.

The example's metadata contains no `commitAfter`, producer identity, discovery-order rule,
or package-specific environment variable.
