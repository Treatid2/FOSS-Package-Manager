// SPDX-License-Identifier: MPL-2.0

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function segment(path, key) {
  if (typeof key === "number") return `${path}[${key}]`;
  return /^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function supplied(value) {
  if (value === undefined) return null;
  try { return structuredClone(value); } catch { return String(value); }
}

export class JsonSchemaValidationError extends Error {
  constructor(path, rule, value, message, details = {}) {
    super(message);
    this.name = "JsonSchemaValidationError";
    this.code = "FGPM_WORKBENCH_PROJECT_INVALID";
    this.details = { path, rule, supplied: supplied(value), ...details };
  }
}

function fail(path, rule, value, message, details) {
  throw new JsonSchemaValidationError(path, rule, value, message, details);
}

function resolvePointer(document, reference) {
  if (!reference.startsWith("#/")) throw new Error(`Only local JSON Schema references are supported: ${reference}`);
  return reference.slice(2).split("/").reduce((current, part) =>
    current?.[part.replaceAll("~1", "/").replaceAll("~0", "~")], document);
}

function matchesType(value, expected) {
  if (expected === "number") return typeof value === "number" && Number.isFinite(value);
  if (expected === "integer") return Number.isInteger(value);
  return typeOf(value) === expected;
}

function validateNode(value, schema, document, path) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    fail(path, "schema", value, "The project schema contains a non-object validation node.");
  }
  if (schema.$ref) {
    const target = resolvePointer(document, schema.$ref);
    if (!target) fail(path, "$ref", value, `The project schema reference ${schema.$ref} does not resolve.`);
    validateNode(value, target, document, path);
  }
  if (schema.oneOf) {
    const successes = [];
    for (const option of schema.oneOf) {
      try { validateNode(value, option, document, path); successes.push(option); } catch (error) {
        if (!(error instanceof JsonSchemaValidationError)) throw error;
      }
    }
    if (successes.length !== 1) fail(path, "oneOf", value,
      `The value at ${path} must match exactly one allowed schema.`, { matches: successes.length });
    return;
  }
  if (schema.not) {
    let matched = true;
    try { validateNode(value, schema.not, document, path); } catch (error) {
      if (!(error instanceof JsonSchemaValidationError)) throw error;
      matched = false;
    }
    if (matched) fail(path, "not", value, `The value at ${path} matches a forbidden schema.`);
  }
  if (Object.hasOwn(schema, "const") && !Object.is(value, schema.const)) {
    fail(path, "const", value, `The value at ${path} must equal ${JSON.stringify(schema.const)}.`,
      { expected: schema.const });
  }
  if (schema.enum && !schema.enum.some((entry) => Object.is(entry, value))) {
    fail(path, "enum", value, `The value at ${path} is not in the allowed vocabulary.`, { allowed: schema.enum });
  }
  if (schema.type && !matchesType(value, schema.type)) {
    fail(path, "type", value, `The value at ${path} must have type ${schema.type}.`,
      { expected: schema.type, actual: typeOf(value) });
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      fail(path, "minLength", value, `The string at ${path} is shorter than ${schema.minLength}.`,
        { minimum: schema.minLength });
    }
    if (schema.pattern !== undefined && !(new RegExp(schema.pattern, "u")).test(value)) {
      fail(path, "pattern", value, `The string at ${path} does not match the required pattern.`,
        { pattern: schema.pattern });
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      fail(path, "minItems", value, `The array at ${path} contains fewer than ${schema.minItems} items.`,
        { minimum: schema.minItems });
    }
    if (schema.items) value.forEach((entry, index) => validateNode(entry, schema.items, document, segment(path, index)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) fail(segment(path, key), "required", undefined,
        `The required value ${segment(path, key)} is missing.`, { required: key });
    }
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      const unexpected = Object.keys(value).find((key) => !Object.hasOwn(properties, key));
      if (unexpected !== undefined) fail(segment(path, unexpected), "additionalProperties", value[unexpected],
        `The property ${segment(path, unexpected)} is not allowed.`, { property: unexpected });
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) validateNode(value[key], child, document, segment(path, key));
    }
  }
}

export function validateJsonSchema(value, schema) {
  validateNode(value, schema, schema, "$");
  return value;
}
