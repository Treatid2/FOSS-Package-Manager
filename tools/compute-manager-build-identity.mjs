// SPDX-License-Identifier: MPL-2.0
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashDirectory, sha256, stableJson } from "../src/core/io.mjs";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2] ?? "0.11.0-rc.6";
const trees = {
  contracts: `sha256:${await hashDirectory(path.join(source, "contracts"))}`,
  public: `sha256:${await hashDirectory(path.join(source, "public"))}`,
  src: `sha256:${await hashDirectory(path.join(source, "src"))}`,
};
const input = { schema: "fgpm.manager-build-identity-input/1", version, trees };
console.log(JSON.stringify({ input, buildIdentity: `sha256:${sha256(stableJson(input))}` }, null, 2));
