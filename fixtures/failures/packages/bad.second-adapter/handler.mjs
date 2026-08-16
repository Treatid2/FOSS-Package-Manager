// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const sourceInput = request.inputs.find((entry) => entry.name === "source");
const source = JSON.parse(await readFile(sourceInput.path, "utf8"));
const content = `${JSON.stringify({
  height: 1,
  pixels: [...source.colour, 255],
  schema: "fpm.texture.runtime.rgba8-srgb/1",
  width: 1,
}, null, 2)}\n`;
const output = request.transaction.outputs[0];
await writeFile(path.join(request.transaction.stagingDirectory, output.relativePath), content, "utf8");
process.stdout.write(`${JSON.stringify({
  protocol: "fpm.handler-response/1",
  ok: true,
  output: {
    type: output.type,
    relativePath: output.relativePath,
    size: Buffer.byteLength(content),
    hash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
  },
})}\n`);
