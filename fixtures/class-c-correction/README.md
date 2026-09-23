<!-- SPDX-License-Identifier: Apache-2.0 -->
# Class C fresh-author regression fixture

`evaluation.fresh-z-offset` is the byte-exact package returned by the independent Class C
fresh-author evaluation. Its retained SHA-256 identities are:

| File | SHA-256 |
|---|---|
| `activation.json` | `100ea84a271583b52e555ad8a724654ec10908d93e03df2385bc97999f71e9a2` |
| `fgpm-package.json` | `f8fbeb44c7b7ea245884786efb9602a235cdb6038a89f6af2c2762d8a98b3f82` |
| `service.mjs` | `c786f1d87c886e8ff2336caa1915e3be5a1db3b6109fa6ed6491dea95cf27808` |
| `task.mjs` | `01701ae580e2a4b9d2a7145a85fd71adb1baa30358e7af34976cd3daad26fafa` |

`evaluation.fresh-z-offset-invalid` applies the evaluator's exact deliberate-invalid change: its
declared/output operation becomes the second exclusive `set-axis` producer for character X. It is
kept separately so tests never mutate or restore the accepted package in place.

These packages are regression inputs, not accepted ecosystem packages.
