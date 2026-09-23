// SPDX-License-Identifier: Apache-2.0

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(repository, "contracts", "architecture-v0.json");
const outputPath = path.join(repository, "docs", "architecture-snapshot-v0.md");
const snapshot = JSON.parse(await readFile(sourcePath, "utf8"));

function render(value) {
  const lines = [
    "<!-- SPDX-License-Identifier: Apache-2.0 -->",
    "",
    `# ${value.title}`,
    "",
    `**Status:** ${value.status}; no compatibility promise.`,
    "",
    value.purpose,
    "",
    `This file is generated from \`contracts/architecture-v0.json\` by \`tools/render-architecture-snapshot.mjs\`.`,
    "",
  ];
  for (const section of value.sections) {
    lines.push(`## ${section.title}`, "", `**Classification:** ${section.classification}.`, "", section.summary, "");
    for (const contract of section.contracts) lines.push(`- \`${contract}\``);
    lines.push("");
  }
  lines.push("## Deliberate boundary", "",
    "This snapshot records the current experiment. It is not a compatibility guarantee, a registry reservation, or a claim that the reference manager must forever contain the only implementation of a manager-authorised responsibility.", "");
  return lines.join("\n");
}

if (snapshot.schema !== "fgpm.architecture-snapshot/0" || snapshot.status !== "experimental"
  || snapshot.compatibilityPromise !== false || !Array.isArray(snapshot.sections)) {
  throw new Error("The architecture snapshot source is malformed or overstates compatibility.");
}
const expected = render(snapshot);
if (process.argv.includes("--check")) {
  const existing = await readFile(outputPath, "utf8");
  if (existing.replaceAll("\r\n", "\n") !== expected) {
    throw new Error("docs/architecture-snapshot-v0.md is out of date; run npm run contracts:generate.");
  }
} else {
  await writeFile(outputPath, expected, "utf8");
}
