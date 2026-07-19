import { createHash } from "node:crypto";

export type JcsJsonValue =
  | null
  | boolean
  | number
  | string
  | JcsJsonValue[]
  | { [key: string]: JcsJsonValue };

export function normalizeJcsValue(value: unknown): JcsJsonValue {
  return normalize(value, "$root", false);
}

export function normalizeJcsValueOmittingUndefined(value: unknown): JcsJsonValue {
  return normalize(value, "$root", true);
}

export function canonicalizeJcs(value: unknown): string {
  return render(normalizeJcsValue(value), "$root");
}

export function jcsSha256Hex(value: unknown): string {
  return sha256Hex(canonicalizeJcs(value));
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function normalize(value: unknown, at: string, omitUndefinedObjectProperties: boolean): JcsJsonValue {
  if (value === null) return null;
  if (typeof value === "string") {
    assertValidUnicode(value, at);
    return value;
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`JCS rejects non-finite number at ${at}`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item, index) => normalize(item, `${at}[${index}]`, omitUndefinedObjectProperties));
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`JCS rejects non-plain object at ${at}`);
    }
    const output = Object.create(null) as Record<string, JcsJsonValue>;
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      assertValidUnicode(key, `${at} key`);
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) {
        if (omitUndefinedObjectProperties) continue;
        throw new Error(`JCS rejects undefined at ${at}.${key}`);
      }
      output[key] = normalize(child, `${at}.${key}`, omitUndefinedObjectProperties);
    }
    return output;
  }
  throw new Error(`JCS rejects ${typeof value} at ${at}`);
}

function render(value: JcsJsonValue, at: string): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => render(item, `${at}[${index}]`)).join(",")}]`;
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${render(value[key]!, `${at}.${key}`)}`).join(",")}}`;
}

function assertValidUnicode(value: string, at: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error(`JCS rejects lone surrogate at ${at}`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error(`JCS rejects lone surrogate at ${at}`);
    }
  }
}
