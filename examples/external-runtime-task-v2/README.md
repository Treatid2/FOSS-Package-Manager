<!-- SPDX-License-Identifier: Apache-2.0 -->

# External corrected runtime-task example

This directory is intentionally relocatable. Its profile names only the local `packages`
directory; it does not contain the FGPM repository path. Supply an installed demonstration
distribution package root at invocation time:

```text
node <fgpm-install>/src/cli.mjs conformance runtime-task profile.json \
  --packages <fgpm-demo-distribution>/packages --out ./out
```

The example task depends on the generic runtime-task and transform-vocabulary steward packages,
not on a scheduler package or another task producer.
