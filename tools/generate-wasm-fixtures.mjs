// SPDX-License-Identifier: MPL-2.0

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function unsigned(value) {
  const encoded = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value) byte |= 0x80;
    encoded.push(byte);
  } while (value);
  return encoded;
}

function signed(value) {
  const encoded = [];
  let more = true;
  while (more) {
    let byte = value & 0x7f;
    value >>= 7;
    const sign = (byte & 0x40) !== 0;
    more = !((value === 0 && !sign) || (value === -1 && sign));
    if (more) byte |= 0x80;
    encoded.push(byte);
  }
  return encoded;
}

function vector(entries) {
  return [...unsigned(entries.length), ...entries.flat()];
}

function string(value) {
  const bytes = [...Buffer.from(value, "utf8")];
  return [...unsigned(bytes.length), ...bytes];
}

function section(id, payload) {
  return [id, ...unsigned(payload.length), ...payload];
}

function functionType(parameters, results) {
  return [0x60, ...vector(parameters.map((entry) => [entry])), ...vector(results.map((entry) => [entry]))];
}

function functionImport(name, typeIndex) {
  return [...string("fpm"), ...string(name), 0x00, ...unsigned(typeIndex)];
}

function call(index) {
  return [0x10, ...unsigned(index)];
}

function constant(value) {
  return [0x41, ...signed(value)];
}

function adapterModule(includeDeniedProbes) {
  const imports = [
    functionImport("input_length", 0),
    functionImport("read_input_byte", 1),
    functionImport("write_output_byte", 2),
  ];
  if (includeDeniedProbes) {
    imports.push(
      functionImport("denied_host_read", 0),
      functionImport("denied_host_write", 0),
      functionImport("denied_network", 0),
    );
  }
  const instructions = [...call(0), 0x1a];
  for (const index of [0, 1, 2]) instructions.push(...constant(index), ...call(1), ...call(2));
  instructions.push(...constant(255), ...call(2));
  if (includeDeniedProbes) {
    instructions.push(...call(3), 0x1a, ...call(4), 0x1a, ...call(5), 0x1a);
  }
  instructions.push(0x0b);
  const body = [0x00, ...instructions];
  return Buffer.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, vector([
      functionType([], [0x7f]),
      functionType([0x7f], [0x7f]),
      functionType([0x7f], []),
      functionType([], []),
    ])),
    ...section(2, vector(imports)),
    ...section(3, vector([[...unsigned(3)]])),
    ...section(7, vector([[...string("transform"), 0x00, ...unsigned(imports.length)]])),
    ...section(10, vector([[...unsigned(body.length), ...body]])),
  ]);
}

const outputs = [
  [path.join(repository, "packages", "demo.solid-colour-adapter", "adapter.wasm.b64"), adapterModule(false)],
  [path.join(repository, "fixtures", "failures", "packages", "bad.sandbox-violation-adapter", "violation.wasm.b64"),
    adapterModule(true)],
];
for (const [filePath, module] of outputs) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${module.toString("base64")}\n`, "utf8");
}
