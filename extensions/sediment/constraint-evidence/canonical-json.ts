import type { ConstraintEvidenceJsonValue } from "./types";

export function canonicalJson(value: ConstraintEvidenceJsonValue): string {
  return renderCanonicalJson(value, "$root");
}

export function canonicalJsonValue(value: unknown): ConstraintEvidenceJsonValue {
  return normalizeJsonValue(value, "$root");
}

function normalizeJsonValue(value: unknown, path: string): ConstraintEvidenceJsonValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`non-finite number at ${path}`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item, index) => normalizeJsonValue(item, `${path}[${index}]`));
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`non-plain object at ${path}`);
    }
    const output: Record<string, ConstraintEvidenceJsonValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) throw new Error(`undefined value at ${path}.${key}`);
      output[key] = normalizeJsonValue(child, `${path}.${key}`);
    }
    return output;
  }
  throw new Error(`unsupported JSON value at ${path}: ${typeof value}`);
}

function renderCanonicalJson(value: ConstraintEvidenceJsonValue, path: string): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`non-finite number at ${path}`);
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => renderCanonicalJson(item, `${path}[${index}]`)).join(",")}]`;
  }
  const entries = Object.keys(value).sort().map((key) => {
    const child = value[key];
    if (child === undefined) throw new Error(`undefined value at ${path}.${key}`);
    return `${JSON.stringify(key)}:${renderCanonicalJson(child, `${path}.${key}`)}`;
  });
  return `{${entries.join(",")}}`;
}
