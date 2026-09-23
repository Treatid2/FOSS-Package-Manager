// SPDX-License-Identifier: MPL-2.0

export class FgpmError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "FgpmError";
    this.code = code;
    this.details = details;
  }
}

export function invariant(condition, code, message, details = {}) {
  if (!condition) {
    throw new FgpmError(code, message, details);
  }
}

function renderValue(value, indent = "    ") {
  if (Array.isArray(value)) {
    return value.map((entry) => `${indent}- ${typeof entry === "object" ? JSON.stringify(entry) : entry}`).join("\n");
  }
  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([key, entry]) => `${indent}${key}: ${typeof entry === "object" ? JSON.stringify(entry) : entry}`)
      .join("\n");
  }
  return `${indent}${value}`;
}

function isStructuredValue(value, seen = new Set()) {
  if (value === null || ["string", "boolean"].includes(typeof value)) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  seen.add(value);
  const valid = (Array.isArray(value) ? value : Object.values(value))
    .every((entry) => isStructuredValue(entry, seen));
  seen.delete(value);
  return valid;
}

export function isPublicFgpmError(error) {
  return error instanceof FgpmError || (typeof error?.code === "string"
    && /^FGPM_[A-Z0-9_]+$/.test(error.code)
    && typeof error.message === "string"
    && isStructuredValue(error.details ?? {}));
}

export function publicErrorRecord(error) {
  if (isPublicFgpmError(error)) {
    return {
      code: error.code,
      message: error.message,
      details: structuredClone(error.details ?? {}),
    };
  }
  return { code: "FGPM_INTERNAL", message: "An unexpected internal error occurred.", details: {} };
}

export function formatDiagnostic(error, options = {}) {
  const diagnostic = publicErrorRecord(error);
  const sections = [`${diagnostic.code}: ${diagnostic.message}`];
  for (const [key, value] of Object.entries(diagnostic.details)) {
    sections.push(`${key}:\n${renderValue(value)}`);
  }
  if (options.debug === true) sections.push(`stack:\n${error?.stack ?? String(error)}`);
  return sections.join("\n\n");
}
