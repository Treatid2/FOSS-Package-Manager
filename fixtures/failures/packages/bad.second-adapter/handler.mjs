// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const sourceInput = request.inputs.find((entry) => entry.name === "source");
const source = await readFile(sourceInput.path);
const content = Buffer.from([...source, 255]);
const output = request.transaction.outputs[0];
await writeFile(path.join(request.transaction.stagingDirectory, output.relativePath), content);
process.stdout.write(`${JSON.stringify({
  protocol: "fpm.handler-response/1",
  ok: true,
  output: {
    type: output.type,
    relativePath: output.relativePath,
    size: content.length,
    hash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
  },
})}\n`);
