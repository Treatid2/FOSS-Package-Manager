// SPDX-License-Identifier: MPL-2.0

export class FpmError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "FpmError";
    this.code = code;
    this.details = details;
  }
}

export function invariant(condition, code, message, details = {}) {
  if (!condition) {
    throw new FpmError(code, message, details);
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

export function formatDiagnostic(error) {
  if (!(error instanceof FpmError)) {
    return `FPM_INTERNAL\n${error?.stack ?? String(error)}`;
  }

  const sections = [`${error.code}: ${error.message}`];
  for (const [key, value] of Object.entries(error.details ?? {})) {
    sections.push(`${key}:\n${renderValue(value)}`);
  }
  return sections.join("\n\n");
}
