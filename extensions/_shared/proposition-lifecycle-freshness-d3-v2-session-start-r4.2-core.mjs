#!/usr/bin/env node
/**
 * ADR0040 D3-v2 session_start R4.2 closed data contracts.
 *
 * This module is intentionally self-contained and Node-stdlib-only. It does not
 * import or dispatch the R4/R4.1 publication implementation.
 */
import { isUtf8 } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const REVISION = "R4.2";
export const SETTINGS_KEY = "propositionLifecycleFreshnessD3V2SessionStartInjection";
export const MAX_OBJECT_BYTES = 1_048_576;
export const MAX_STATIC_BYTES = 4_194_304;
export const MAX_SESSION_BYTES = 67_108_864;
export const HASH64 = /^[0-9a-f]{64}$/;
export const GIT_COMMIT = /^[0-9a-f]{40}$/;
export const NONCE32 = /^[0-9a-f]{32}$/;
export const SOURCE_COMMIT_BINDING = "dynamic_preview_and_initial_phrase";
export const STAGE_STATE = "S2_NOT_AUTHORIZED";
export const STATIC_SENTINEL = Object.freeze({ $static: "static_contract_hash", encoding: "lowercase_hex", length: 64 });
export const DYNAMIC_SENTINEL = Object.freeze({ $dynamic: "commit_token", encoding: "lowercase_hex", length: 64 });

export const SCHEMAS = Object.freeze({
  static_contract: "adr0040-d3-v2-session-start-r4.2-static-contract/v1",
  static_dossier: "adr0040-d3-v2-session-start-r4.2-static-dossier/v1",
  static_preview_template: "adr0040-d3-v2-session-start-r4.2-static-preview-template/v1",
  initial_dynamic_preview: "adr0040-d3-v2-session-start-r4.2-initial-dynamic-preview/v1",
  dynamic_report: "adr0040-d3-v2-session-start-r4.2-dynamic-read-only-report/v1",
  conflict_report: "adr0040-d3-v2-session-start-r4.2-read-only-conflict-report/v1",
  incident_report: "adr0040-d3-v2-session-start-r4.2-read-only-incident-report/v1",
  source_manifest: "adr0040-d3-v2-session-start-source-manifest/r4.2-v1",
  adapter_manifest: "adr0040-d3-v2-session-start-adapter-manifest/r4.2-v1",
  operator_manifest: "adr0040-d3-v2-session-start-operator-manifest/r4.2-v1",
  staged_publish: "adr0040-d3-v2-session-start-r4.2-staged-publish/v1",
  link_final: "adr0040-d3-v2-session-start-r4.2-link-final-idempotent/v1",
  unlink_pending: "adr0040-d3-v2-session-start-r4.2-unlink-pending-idempotent/v1",
  staged_temp_path: "adr0040-d3-v2-session-start-r4.2-staged-temp-path/v1",
  staged_temp_disposition_preview: "adr0040-d3-v2-session-start-r4.2-staged-temp-disposition-preview/v1",
  staged_temp_disposition_authorization: "adr0040-d3-v2-session-start-r4.2-staged-temp-disposition-authorization-contract/v1",
  runtime_audit_temp_disposition_preview: "adr0040-d3-v2-session-start-r4.2-runtime-audit-temp-disposition-preview/v1",
  runtime_audit_temp_disposition_authorization: "adr0040-d3-v2-session-start-r4.2-runtime-audit-temp-disposition-authorization-contract/v1",
  runtime_audit_bootstrap: "adr0040-d3-v2-session-start-r4.2-runtime-audit-bootstrap/v1",
  runtime_enable_preview: "adr0040-d3-v2-session-start-r4.2-runtime-enable-preview/v1",
  activation_hash_inputs: "adr0040-d3-v2-session-start-r4.2-activation-hash-inputs/v1",
  operation_tuple: "adr0040-d3-v2-session-start-r4.2-operation-tuple/v1",
  intent: "adr0040-d3-v2-session-start-r4.2-create-bind-intent/v1",
  activation: "adr0040-d3-v2-session-start-r4.2-bound-activation/v1",
  settings_binding: "adr0040-d3-v2-session-start-r4.2-settings-binding/v1",
  receipt: "adr0040-d3-v2-session-start-r4.2-commit-receipt/v1",
  post_dossier: "adr0040-d3-v2-session-start-r4.2-post-dossier/v1",
  initial_authorization: "adr0040-d3-v2-session-start-r4.2-initial-authorization-contract/v1",
  continue_authorization: "adr0040-d3-v2-session-start-r4.2-continue-authorization-contract/v1",
  direct_recovery_authorization: "adr0040-d3-v2-session-start-r4.2-direct-pending-recovery-authorization-contract/v1",
  adoption_authorization: "adr0040-d3-v2-session-start-r4.2-ambient-state-adoption-authorization-contract/v1",
  adoption_recovery_authorization: "adr0040-d3-v2-session-start-r4.2-ambient-state-adoption-pending-recovery-authorization-contract/v1",
  runtime_enable_authorization: "adr0040-d3-v2-session-start-r4.2-runtime-enable-audit-authorization-contract/v1",
  adoption_preview: "adr0040-d3-v2-session-start-r4.2-ambient-state-adoption-preview/v1",
  runtime_audit_object: "adr0040-d3-v2-session-start-runtime-audit-object/r4.2-v1",
  rollback_authorization: "adr0040-d3-v2-session-start-r4.2-rollback-authorization/v1",
  production_target_authorization: "adr0040-d3-v2-session-start-r4.2-production-target-authorization/v1",
  transformer: "adr0040-d3-v2-session-start-r4.2-v2-only-transformer/v1",
  trusted_coordinate: "trusted-persisted-session-user-coordinate/v1",
});

export class R42Error extends Error {
  /** @type {number | undefined} */
  mutationCount;
  /** @type {string | undefined} */
  status;

  constructor(code, message, detail = undefined) {
    super(`${code}: ${message}`);
    this.name = "R42Error";
    this.code = code;
    this.detail = detail === undefined ? undefined : deepFreeze(structuredClone(detail));
  }
}

export function fail(code, message, detail = undefined) {
  throw new R42Error(code, message, detail);
}

export function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

export function jcsSha256(value) {
  return sha256(canonicalizeJcs(value));
}

export function canonicalizeJcs(value) {
  return renderJcs(normalizeJcs(value, "$"), "$");
}

function normalizeJcs(value, at) {
  if (value === null) return null;
  if (typeof value === "string") {
    assertValidUnicode(value, at);
    return value;
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("R42_JCS_NUMBER", `non-finite number at ${at}`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item, index) => normalizeJcs(item, `${at}[${index}]`));
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail("R42_JCS_OBJECT", `non-plain object at ${at}`);
    const output = Object.create(null);
    for (const key of Object.keys(value).sort(compareUtf16)) {
      assertValidUnicode(key, `${at} key`);
      const child = value[key];
      if (child === undefined) fail("R42_JCS_UNDEFINED", `undefined at ${at}.${key}`);
      output[key] = normalizeJcs(child, `${at}.${key}`);
    }
    return output;
  }
  fail("R42_JCS_TYPE", `unsupported ${typeof value} at ${at}`);
}

function renderJcs(value, at) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map((item, index) => renderJcs(item, `${at}[${index}]`)).join(",")}]`;
  return `{${Object.keys(value).sort(compareUtf16).map((key) => `${JSON.stringify(key)}:${renderJcs(value[key], `${at}.${key}`)}`).join(",")}}`;
}

function assertValidUnicode(value, at) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail("R42_JCS_UNICODE", `lone high surrogate at ${at}`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) fail("R42_JCS_UNICODE", `lone low surrogate at ${at}`);
  }
}

export function parseStrictJson(rawInput, options = {}) {
  const raw = Buffer.isBuffer(rawInput) ? rawInput : Buffer.from(rawInput, "utf8");
  const maxBytes = options.maxBytes ?? MAX_STATIC_BYTES;
  if (raw.length > maxBytes) fail("R42_JSON_OVERSIZE", `JSON exceeds ${maxBytes} bytes`, { bytes: raw.length });
  if (raw.length >= 2 && ((raw[0] === 0xff && raw[1] === 0xfe) || (raw[0] === 0xfe && raw[1] === 0xff))) fail("R42_JSON_ENCODING", "UTF-16 is forbidden");
  if (raw.length >= 4 && ((raw[0] === 0xff && raw[1] === 0xfe && raw[2] === 0 && raw[3] === 0) || (raw[0] === 0 && raw[1] === 0 && raw[2] === 0xfe && raw[3] === 0xff))) fail("R42_JSON_ENCODING", "UTF-32 is forbidden");
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) fail("R42_JSON_BOM", "UTF-8 BOM is forbidden");
  if (!isUtf8(raw)) fail("R42_JSON_UTF8", "input is not exact UTF-8");
  const parser = new StrictParser(raw.toString("utf8"));
  const value = parser.parseValue();
  parser.skipWhitespace();
  if (!parser.done()) parser.raise("R42_JSON_TRAILING", "trailing non-whitespace input");
  canonicalizeJcs(value);
  return value;
}

class StrictParser {
  constructor(text) { this.text = text; this.offset = 0; }
  done() { return this.offset >= this.text.length; }
  skipWhitespace() { while (!this.done() && /[\x20\x09\x0a\x0d]/.test(this.text[this.offset])) this.offset += 1; }
  parseValue() {
    this.skipWhitespace();
    const current = this.text[this.offset];
    if (current === "{") return this.parseObject();
    if (current === "[") return this.parseArray();
    if (current === "\"") return this.parseString();
    if (current === "t") return this.parseKeyword("true", true);
    if (current === "f") return this.parseKeyword("false", false);
    if (current === "n") return this.parseKeyword("null", null);
    if (current === "-" || (current >= "0" && current <= "9")) return this.parseNumber();
    this.raise("R42_JSON_VALUE", "expected JSON value");
  }
  parseObject() {
    this.offset += 1;
    const output = Object.create(null);
    const keys = new Set();
    this.skipWhitespace();
    if (this.consume("}")) return output;
    while (true) {
      this.skipWhitespace();
      if (this.text[this.offset] !== "\"") this.raise("R42_JSON_KEY", "expected quoted object key");
      const keyOffset = this.offset;
      const key = this.parseString();
      if (keys.has(key)) this.raiseAt("R42_JSON_DUPLICATE_KEY", `duplicate key ${JSON.stringify(key)}`, keyOffset);
      keys.add(key);
      this.skipWhitespace();
      if (!this.consume(":")) this.raise("R42_JSON_COLON", "expected ':'");
      output[key] = this.parseValue();
      this.skipWhitespace();
      if (this.consume("}")) return output;
      if (!this.consume(",")) this.raise("R42_JSON_OBJECT_SEPARATOR", "expected ',' or '}'");
    }
  }
  parseArray() {
    this.offset += 1;
    const output = [];
    this.skipWhitespace();
    if (this.consume("]")) return output;
    while (true) {
      output.push(this.parseValue());
      this.skipWhitespace();
      if (this.consume("]")) return output;
      if (!this.consume(",")) this.raise("R42_JSON_ARRAY_SEPARATOR", "expected ',' or ']'");
    }
  }
  parseString() {
    const start = this.offset;
    this.offset += 1;
    let escaped = false;
    while (!this.done()) {
      const code = this.text.charCodeAt(this.offset);
      if (!escaped && code === 0x22) {
        this.offset += 1;
        try {
          const value = JSON.parse(this.text.slice(start, this.offset));
          assertValidUnicode(value, "strict JSON string");
          return value;
        } catch (error) {
          if (error instanceof R42Error) throw error;
          this.raiseAt("R42_JSON_STRING", "invalid JSON string", start);
        }
      }
      if (!escaped && code < 0x20) this.raise("R42_JSON_STRING", "unescaped control character");
      if (!escaped && code === 0x5c) escaped = true;
      else escaped = false;
      this.offset += 1;
    }
    this.raiseAt("R42_JSON_STRING", "unterminated string", start);
  }
  parseNumber() {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.text.slice(this.offset));
    if (!match) this.raise("R42_JSON_NUMBER", "invalid JSON number");
    const start = this.offset;
    this.offset += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.raiseAt("R42_JSON_NUMBER", "non-finite number", start);
    if (Object.is(value, -0)) this.raiseAt("R42_JSON_NEGATIVE_ZERO", "negative zero is forbidden by closed numeric contracts", start);
    return value;
  }
  parseKeyword(keyword, value) {
    if (this.text.slice(this.offset, this.offset + keyword.length) !== keyword) this.raise("R42_JSON_KEYWORD", `expected ${keyword}`);
    this.offset += keyword.length;
    return value;
  }
  consume(value) { if (this.text[this.offset] !== value) return false; this.offset += 1; return true; }
  raise(code, message) { this.raiseAt(code, message, this.offset); }
  raiseAt(code, message, offset) { fail(code, `${message} at byte offset ${Buffer.byteLength(this.text.slice(0, offset), "utf8")}`); }
}

export function canonicalObjectBytes(value, hashField, options = {}) {
  const object = asObject(value, options.label ?? "object");
  if (hashField !== undefined) validateSelfHash(object, hashField, options.label ?? "object");
  const raw = Buffer.from(`${canonicalizeJcs(object)}\n`, "utf8");
  const maxBytes = options.maxBytes ?? MAX_OBJECT_BYTES;
  if (raw.length > maxBytes) fail("R42_OBJECT_OVERSIZE", `${options.label ?? "object"} exceeds ${maxBytes} bytes`, { bytes: raw.length });
  return raw;
}

export function addSelfHash(base, hashField) {
  if (Object.prototype.hasOwnProperty.call(base, hashField)) fail("R42_SELF_HASH_FIELD", `${hashField} already exists`);
  return deepFreeze({ ...base, [hashField]: jcsSha256(base) });
}

export function validateSelfHash(value, hashField, label = "object") {
  const object = asObject(value, label);
  assertHash(object[hashField], `${label}.${hashField}`);
  const preimage = { ...object };
  delete preimage[hashField];
  if (object[hashField] !== jcsSha256(preimage)) fail("R42_SELF_HASH", `${label}.${hashField} differs`);
  return object;
}

export function exactKeys(value, expected, label = "object") {
  const object = asObject(value, label);
  const actual = Object.keys(object).sort(compareUtf8);
  const wanted = [...expected].sort(compareUtf8);
  if (canonicalizeJcs(actual) !== canonicalizeJcs(wanted)) fail("R42_SCHEMA_KEYS", `${label} keys differ`, { actual, expected: wanted });
  return object;
}

export function asObject(value, label = "object") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("R42_SCHEMA_OBJECT", `${label} must be an object`);
  return value;
}

export function assertHash(value, label = "hash") {
  if (typeof value !== "string" || !HASH64.test(value)) fail("R42_HASH", `${label} must be 64 lowercase hex`);
  return value;
}

export function assertGitCommit(value, label = "source_commit") {
  if (typeof value !== "string" || !GIT_COMMIT.test(value)) fail("R42_GIT_COMMIT", `${label} must be exact 40 lowercase hex commit`);
  return value;
}

export function assertSafeInteger(value, label, options = {}) {
  if (!Number.isSafeInteger(value) || value < (options.min ?? 0) || value > (options.max ?? Number.MAX_SAFE_INTEGER)) fail("R42_SAFE_INTEGER", `${label} is outside the closed safe-integer range`);
  return value;
}

export function assertAbsolutePath(value, label = "path") {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value || value.length === 0) fail("R42_ABSOLUTE_PATH", `${label} must be normalized absolute`);
  return value;
}

export function assertRelativePath(value, label = "relative_path") {
  if (typeof value !== "string" || value.length === 0 || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value || value === "." || value === ".." || value.startsWith("../") || value.includes("\\")) fail("R42_RELATIVE_PATH", `${label} must be normalized relative POSIX path`);
  return value;
}

export function assertSafeSessionId(value, label = "session_id") {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value) || value === "." || value === "..") fail("R42_SESSION_ID", `${label} is not a safe component`);
  return value;
}

export function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function compareUtf16(left, right) { return left < right ? -1 : left > right ? 1 : 0; }

export function deepFreeze(value) {
  if (value && typeof value === "object" && !ArrayBuffer.isView(value) && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function cloneJson(value) {
  return parseStrictJson(Buffer.from(canonicalizeJcs(value), "utf8"));
}

export function randomNonce(seen = undefined) {
  for (;;) {
    const nonce = randomBytes(16).toString("hex");
    if (!NONCE32.test(nonce)) fail("R42_NONCE", "CSPRNG nonce representation failed");
    if (!seen || !seen.has(nonce)) { seen?.add(nonce); return nonce; }
  }
}

function nsParts(nsInput, label) {
  const ns = BigInt(nsInput);
  if (ns < 0n) fail("R42_IDENTITY_TIME", `${label} is negative`);
  const sec = ns / 1_000_000_000n;
  const nsec = ns % 1_000_000_000n;
  if (sec > BigInt(Number.MAX_SAFE_INTEGER) || nsec > BigInt(Number.MAX_SAFE_INTEGER)) fail("R42_IDENTITY_TIME", `${label} is not losslessly representable`);
  return [Number(sec), Number(nsec)];
}

function bigintToSafe(value, label) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) fail("R42_IDENTITY_INTEGER", `${label} is not a non-negative safe integer`);
  return Number(value);
}

export function fullIdentityFromBigintStat(stat, raw) {
  if (typeof stat.mtimeNs !== "bigint" || typeof stat.ctimeNs !== "bigint") fail("R42_IDENTITY_NS", "bigint stat nanoseconds are required");
  const [mtimeSec, mtimeNsec] = nsParts(stat.mtimeNs, "mtimeNs");
  const [ctimeSec, ctimeNsec] = nsParts(stat.ctimeNs, "ctimeNs");
  const identity = {
    dev: bigintToSafe(stat.dev, "dev"),
    ino: bigintToSafe(stat.ino, "ino"),
    mode: bigintToSafe(stat.mode & 0o7777n, "mode"),
    uid: bigintToSafe(stat.uid, "uid"),
    gid: bigintToSafe(stat.gid, "gid"),
    nlink: bigintToSafe(stat.nlink, "nlink"),
    size: bigintToSafe(stat.size, "size"),
    mtime_sec: mtimeSec,
    mtime_nsec: mtimeNsec,
    ctime_sec: ctimeSec,
    ctime_nsec: ctimeNsec,
    raw_sha256: sha256(raw),
  };
  validateFullIdentity(identity);
  return deepFreeze(identity);
}

export function validateFullIdentity(value, label = "full_identity") {
  const object = exactKeys(value, ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtime_sec", "mtime_nsec", "ctime_sec", "ctime_nsec", "raw_sha256"], label);
  for (const field of ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtime_sec", "ctime_sec"]) assertSafeInteger(object[field], `${label}.${field}`);
  assertSafeInteger(object.mtime_nsec, `${label}.mtime_nsec`, { max: 999_999_999 });
  assertSafeInteger(object.ctime_nsec, `${label}.ctime_nsec`, { max: 999_999_999 });
  assertHash(object.raw_sha256, `${label}.raw_sha256`);
  return object;
}

function sameIdentity(left, right) {
  return ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs"].every((field) => left[field] === right[field]);
}

function assertNoSymlinkAncestors(file) {
  const resolved = path.resolve(file);
  let current = path.parse(resolved).root;
  for (const part of path.relative(current, path.dirname(resolved)).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("R42_ANCESTOR", `unsafe ancestor ${current}`);
  }
}

const CLOEXEC = Number(Reflect.get(fs.constants, "O_CLOEXEC") ?? 0);

export function readBoundedRegular(fileInput, options = {}) {
  const file = assertAbsolutePath(path.resolve(fileInput), options.label ?? "file");
  assertNoSymlinkAncestors(file);
  const namedBefore = fs.lstatSync(file, { bigint: true });
  if (namedBefore.isSymbolicLink() || !namedBefore.isFile()) fail("R42_FILE_TYPE", `${options.label ?? file} is not a nofollow regular file`);
  const maxBytes = options.maxBytes ?? MAX_OBJECT_BYTES;
  if (namedBefore.size > BigInt(maxBytes)) fail("R42_FILE_OVERSIZE", `${options.label ?? file} exceeds ${maxBytes}`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | CLOEXEC);
  try {
    const heldBefore = fs.fstatSync(fd, { bigint: true });
    const raw = fs.readFileSync(fd);
    const heldAfter = fs.fstatSync(fd, { bigint: true });
    const namedAfter = fs.lstatSync(file, { bigint: true });
    if (!sameIdentity(namedBefore, heldBefore) || !sameIdentity(heldBefore, heldAfter) || !sameIdentity(heldAfter, namedAfter) || raw.length !== Number(heldBefore.size)) fail("R42_FILE_RACE", `${options.label ?? file} changed while read`);
    const identity = fullIdentityFromBigintStat(heldBefore, raw);
    if (options.mode !== undefined && identity.mode !== options.mode) fail("R42_FILE_MODE", `${options.label ?? file} mode differs`);
    if (options.nlink !== undefined && identity.nlink !== options.nlink) fail("R42_FILE_NLINK", `${options.label ?? file} nlink differs`);
    if (options.uid !== undefined && identity.uid !== options.uid) fail("R42_FILE_UID", `${options.label ?? file} uid differs`);
    if (options.gid !== undefined && identity.gid !== options.gid) fail("R42_FILE_GID", `${options.label ?? file} gid differs`);
    return deepFreeze({ path: file, raw, identity });
  } finally { fs.closeSync(fd); }
}

export function captureSettingsA(settingsPath, allowedMetadataPolicy) {
  validateSettingsMetadataPolicy(allowedMetadataPolicy);
  const captured = readBoundedRegular(path.resolve(settingsPath), { label: "settings A", maxBytes: MAX_OBJECT_BYTES });
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) fail("R42_SINGLE_USER", "effective uid/gid are required");
  const identity = captured.identity;
  const assertions = {
    regular_file: true,
    nlink_one: identity.nlink === 1,
    uid_effective: identity.uid === uid,
    gid_effective: identity.gid === gid,
    mode_allowed: allowedMetadataPolicy.allowed_modes.includes(identity.mode),
    fd_path_identity_equal: true,
    nofollow_open: true,
  };
  if (!Object.values(assertions).every((value) => value === true)) fail("R42_SETTINGS_METADATA", "settings A violates closed metadata policy", { identity, assertions });
  const parsed = asObject(parseStrictJson(captured.raw, { maxBytes: MAX_OBJECT_BYTES }), "settings root");
  const ruleInjector = asObject(parsed.ruleInjector, "settings.ruleInjector");
  const current = ruleInjector[SETTINGS_KEY];
  let allowedV2Prestate;
  if (current === undefined) allowedV2Prestate = "absent";
  else {
    const disabled = exactKeys(current, ["enabled", "selector"], "disabled v2 prestate");
    const selector = exactKeys(disabled.selector, ["session_ids"], "disabled v2 selector");
    if (disabled.enabled !== false || !Array.isArray(selector.session_ids) || selector.session_ids.length !== 0) fail("R42_SETTINGS_PRESTATE", "v2 prestate is not exact disabled-empty");
    allowedV2Prestate = "disabled_empty";
  }
  const nonV2 = nonV2Projection(parsed);
  return deepFreeze({
    raw: captured.raw,
    parsed,
    full_identity: identity,
    raw_sha256: identity.raw_sha256,
    allowed_v2_prestate: allowedV2Prestate,
    non_v2_jcs_hash: jcsSha256(nonV2),
    metadata_assertions: assertions,
  });
}

export function validateSettingsMetadataPolicy(value) {
  const object = exactKeys(value, ["file_type", "nlink", "uid_policy", "gid_policy", "allowed_modes", "nofollow_required"], "allowed_metadata_policy");
  if (object.file_type !== "regular" || object.nlink !== 1 || object.uid_policy !== "effective_uid" || object.gid_policy !== "effective_gid" || canonicalizeJcs(object.allowed_modes) !== "[384,420]" || object.nofollow_required !== true) fail("R42_METADATA_POLICY", "settings metadata policy differs");
  return object;
}

export function nonV2Projection(rootInput) {
  const root = cloneJson(asObject(rootInput, "settings root"));
  const rule = asObject(root.ruleInjector, "settings.ruleInjector");
  delete rule[SETTINGS_KEY];
  root.ruleInjector = rule;
  return root;
}

export function validateDesiredTemplate(templateInput) {
  const template = asObject(templateInput, "desired_v2_template");
  const binding = asObject(template.r4Binding, "desired_v2_template.r4Binding");
  if (canonicalizeJcs(binding.static_contract_hash) !== canonicalizeJcs(STATIC_SENTINEL)) fail("R42_STATIC_SENTINEL", "static sentinel is absent, filled, or malformed");
  if (canonicalizeJcs(binding.commit_token) !== canonicalizeJcs(DYNAMIC_SENTINEL)) fail("R42_DYNAMIC_SENTINEL", "dynamic sentinel is absent, filled, or malformed");
  let staticCount = 0;
  let dynamicCount = 0;
  walkJson(template, (value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (Object.prototype.hasOwnProperty.call(value, "$static")) staticCount += 1;
      if (Object.prototype.hasOwnProperty.call(value, "$dynamic")) dynamicCount += 1;
    }
  });
  if (staticCount !== 1 || dynamicCount !== 1) fail("R42_SENTINEL_COUNT", "template must contain exactly one fixed static and dynamic slot", { staticCount, dynamicCount });
  const shapeProbe = cloneJson(template);
  shapeProbe.r4Binding.static_contract_hash = "0".repeat(64);
  shapeProbe.r4Binding.commit_token = "1".repeat(64);
  validatePersistedDesiredSubtree(shapeProbe);
  return template;
}

function walkJson(value, visit) {
  visit(value);
  if (Array.isArray(value)) for (const child of value) walkJson(child, visit);
  else if (value && typeof value === "object") for (const child of Object.values(value)) walkJson(child, visit);
}

export function renderDesiredSubtree(templateInput, staticContractHash, commitToken) {
  assertHash(staticContractHash, "static_contract_hash");
  assertHash(commitToken, "commit_token");
  const template = cloneJson(validateDesiredTemplate(templateInput));
  template.r4Binding.static_contract_hash = staticContractHash;
  template.r4Binding.commit_token = commitToken;
  validatePersistedDesiredSubtree(template);
  return deepFreeze(template);
}

export function validatePersistedDesiredSubtree(value) {
  const object = exactKeys(value, ["enabled", "selector", "selectionHash", "headHash", "proofHash", "intentHash", "stableBundleHash", "p2aBundleHash", "generation", "selectionSeq", "adapterManifestHash", "maxReadBytes", "r4Binding"], "desired_v2_subtree");
  if (object.enabled !== true) fail("R42_DESIRED_ENABLED", "desired v2 must be enabled");
  const selector = exactKeys(object.selector, ["session_ids"], "desired selector");
  if (!Array.isArray(selector.session_ids) || selector.session_ids.length !== 1) fail("R42_DESIRED_SELECTOR", "desired selector must contain one target");
  assertSafeSessionId(selector.session_ids[0], "desired selector target");
  for (const field of ["selectionHash", "headHash", "proofHash", "intentHash", "stableBundleHash", "p2aBundleHash", "adapterManifestHash"]) assertHash(object[field], `desired.${field}`);
  assertSafeInteger(object.generation, "desired.generation");
  assertSafeInteger(object.selectionSeq, "desired.selectionSeq");
  assertSafeInteger(object.maxReadBytes, "desired.maxReadBytes", { min: 1024, max: 262_144 });
  const binding = exactKeys(object.r4Binding, ["schema_version", "controlRoot", "operatorManifestHash", "settingsPath", "static_contract_hash", "commit_token"], "desired.r4Binding");
  if (binding.schema_version !== SCHEMAS.settings_binding) fail("R42_SETTINGS_BINDING", "settings binding schema differs");
  assertAbsolutePath(binding.controlRoot, "r4Binding.controlRoot");
  assertAbsolutePath(binding.settingsPath, "r4Binding.settingsPath");
  assertHash(binding.operatorManifestHash, "r4Binding.operatorManifestHash");
  assertHash(binding.static_contract_hash, "r4Binding.static_contract_hash");
  assertHash(binding.commit_token, "r4Binding.commit_token");
  walkJson(object, (child) => {
    if (child && typeof child === "object" && !Array.isArray(child) && (Object.prototype.hasOwnProperty.call(child, "$static") || Object.prototype.hasOwnProperty.call(child, "$dynamic"))) fail("R42_PERSISTED_SENTINEL", "persisted desired subtree retains a sentinel");
  });
  return object;
}

export function computeCommitToken({ staticContractHash, coordinateHash, preRaw, sourceCommit, targetSessionId }) {
  assertHash(staticContractHash, "static_contract_hash");
  assertHash(coordinateHash, "coordinate_hash");
  if (!Buffer.isBuffer(preRaw)) fail("R42_TOKEN_PRE_RAW", "preRaw must be exact Buffer bytes");
  assertGitCommit(sourceCommit);
  assertSafeSessionId(targetSessionId);
  return sha256(Buffer.concat([
    Buffer.from("adr0040-d3-v2-session-start-r4.2-commit-token/v1\0", "utf8"),
    Buffer.from(staticContractHash, "ascii"), Buffer.from([0]),
    Buffer.from(coordinateHash, "ascii"), Buffer.from([0]),
    preRaw, Buffer.from([0]),
    Buffer.from(sourceCommit, "ascii"), Buffer.from([0]),
    Buffer.from(targetSessionId, "utf8"),
  ]));
}

export function renderSettingsB({ preParsed, desiredV2 }) {
  validatePersistedDesiredSubtree(desiredV2);
  const result = cloneJson(asObject(preParsed, "settings A"));
  const rule = asObject(result.ruleInjector, "settings A.ruleInjector");
  const beforeHash = jcsSha256(nonV2Projection(result));
  rule[SETTINGS_KEY] = cloneJson(desiredV2);
  result.ruleInjector = rule;
  const afterHash = jcsSha256(nonV2Projection(result));
  if (beforeHash !== afterHash) fail("R42_NON_V2_MUTATION", "transform changed non-v2 semantics");
  const raw = Buffer.from(`${canonicalizeJcs(result)}\n`, "utf8");
  if (raw.length > MAX_OBJECT_BYTES) fail("R42_SETTINGS_OVERSIZE", "rendered settings B exceeds 1 MiB");
  const parsed = asObject(parseStrictJson(raw, { maxBytes: MAX_OBJECT_BYTES }), "settings B");
  return deepFreeze({ raw, parsed, raw_sha256: sha256(raw), non_v2_jcs_hash: afterHash });
}

export function classifySettingsAgainstTuple(raw, tupleInput) {
  const tuple = validateOperationTuple(tupleInput);
  const parsed = asObject(parseStrictJson(raw, { maxBytes: MAX_OBJECT_BYTES }), "current settings");
  const currentHash = sha256(raw);
  const preRaw = decodeCanonicalBase64(tuple.prestate_A.raw_base64);
  if (currentHash === tuple.prestate_A.raw_sha256 && preRaw.equals(raw)) {
    return { state: "A", parsed, raw_sha256: currentHash, non_v2_jcs_hash: jcsSha256(nonV2Projection(parsed)) };
  }
  const expectedB = renderSettingsB({ preParsed: parseStrictJson(preRaw, { maxBytes: MAX_OBJECT_BYTES }), desiredV2: tuple.desired_v2_subtree });
  if (currentHash === tuple.expected_B_raw_sha256 && raw.equals(expectedB.raw)) {
    const nonV2Hash = jcsSha256(nonV2Projection(parsed));
    if (nonV2Hash !== tuple.prestate_A.non_v2_jcs_hash) fail("R42_CURRENT_B_NON_V2", "current exact B does not preserve tuple A non-v2 semantics");
    return { state: "B", parsed, raw_sha256: currentHash, non_v2_jcs_hash: nonV2Hash };
  }
  const rule = asObject(parsed.ruleInjector, "current settings.ruleInjector");
  if (canonicalizeJcs(rule[SETTINGS_KEY]) === canonicalizeJcs(tuple.desired_v2_subtree)) return { state: "C", parsed, raw_sha256: currentHash, non_v2_jcs_hash: jcsSha256(nonV2Projection(parsed)) };
  return { state: "X", parsed, raw_sha256: currentHash };
}

export function canonicalBase64(raw) {
  const encoded = raw.toString("base64");
  if (!Buffer.from(encoded, "base64").equals(raw)) fail("R42_BASE64", "base64 roundtrip failed");
  return encoded;
}

export function decodeCanonicalBase64(value, label = "raw_base64") {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail("R42_BASE64", `${label} is not canonical RFC4648 base64`);
  const raw = Buffer.from(value, "base64");
  if (raw.toString("base64") !== value) fail("R42_BASE64", `${label} does not re-encode exactly`);
  return raw;
}

export function buildOperationTuple(args) {
  const A = args.prestateA;
  const desired = validatePersistedDesiredSubtree(args.desiredV2);
  const tuple = {
    schema_version: SCHEMAS.operation_tuple,
    revision: REVISION,
    static_contract_hash: assertHash(args.staticContractHash),
    source_commit: assertGitCommit(args.sourceCommit),
    source_manifest_hash: assertHash(args.sourceManifestHash),
    source_closure_hash: assertHash(args.sourceClosureHash),
    initial_authorization_coordinate: validateTrustedCoordinate(args.coordinate),
    initial_coordinate_hash: args.coordinate.coordinate_hash,
    initial_preview_transcript_prefix_sha256: assertHash(args.initialPreviewTranscriptPrefixSha256, "initial_preview_transcript_prefix_sha256"),
    target_session_binding: cloneJson(args.targetSessionBinding),
    authorization_transcript_binding: cloneJson(args.authorizationTranscriptBinding),
    d3_identities: cloneJson(args.d3Identities),
    adapter_manifest_hash: assertHash(args.adapterManifestHash),
    operator_manifest_hash: assertHash(args.operatorManifestHash),
    settings_path: assertAbsolutePath(args.settingsPath),
    transformer_version: SCHEMAS.transformer,
    prestate_A: {
      full_identity: A.full_identity,
      raw_base64: canonicalBase64(A.raw),
      raw_bytes: A.raw.length,
      raw_sha256: A.raw_sha256,
      allowed_v2_prestate: A.allowed_v2_prestate,
      non_v2_jcs_hash: A.non_v2_jcs_hash,
      metadata_assertions: A.metadata_assertions,
    },
    desired_v2_subtree: desired,
    expected_B_raw_sha256: assertHash(args.expectedBRawSha256),
    commit_token: assertHash(args.commitToken),
    static_path_pins: cloneJson(args.staticPathPins),
    safety_contract: cloneJson(args.safetyContract),
  };
  validateOperationTuple(tuple);
  if (Buffer.byteLength(canonicalizeJcs(tuple)) > MAX_OBJECT_BYTES) fail("R42_TUPLE_OVERSIZE", "operation tuple exceeds 1 MiB before intent publication");
  return deepFreeze(tuple);
}

export function validateOperationTuple(value) {
  const tuple = exactKeys(value, ["schema_version", "revision", "static_contract_hash", "source_commit", "source_manifest_hash", "source_closure_hash", "initial_authorization_coordinate", "initial_coordinate_hash", "initial_preview_transcript_prefix_sha256", "target_session_binding", "authorization_transcript_binding", "d3_identities", "adapter_manifest_hash", "operator_manifest_hash", "settings_path", "transformer_version", "prestate_A", "desired_v2_subtree", "expected_B_raw_sha256", "commit_token", "static_path_pins", "safety_contract"], "operation_tuple");
  if (tuple.schema_version !== SCHEMAS.operation_tuple || tuple.revision !== REVISION || tuple.transformer_version !== SCHEMAS.transformer) fail("R42_TUPLE_SCHEMA", "operation tuple identity differs");
  for (const field of ["static_contract_hash", "source_manifest_hash", "source_closure_hash", "initial_coordinate_hash", "initial_preview_transcript_prefix_sha256", "adapter_manifest_hash", "operator_manifest_hash", "expected_B_raw_sha256", "commit_token"]) assertHash(tuple[field], `tuple.${field}`);
  assertGitCommit(tuple.source_commit);
  assertAbsolutePath(tuple.settings_path, "tuple.settings_path");
  const coordinate = validateTrustedCoordinate(tuple.initial_authorization_coordinate);
  if (coordinate.coordinate_hash !== tuple.initial_coordinate_hash) fail("R42_TUPLE_COORDINATE", "tuple coordinate hash differs");
  const target = validateSessionBinding(tuple.target_session_binding, "tuple.target_session_binding");
  const authorization = validateSessionBinding(tuple.authorization_transcript_binding, "tuple.authorization_transcript_binding");
  if (target.session_id === authorization.session_id || target.session_file.path === authorization.session_file.path || (target.session_file.dev === authorization.session_file.dev && target.session_file.ino === authorization.session_file.ino)) fail("R42_TUPLE_SESSION_ALIAS", "tuple target/auth bindings alias");
  if (coordinate.session_id !== authorization.session_id || coordinate.session_jsonl_path !== authorization.session_file.path || coordinate.session_dev !== authorization.session_file.dev || coordinate.session_ino !== authorization.session_file.ino || coordinate.transcript_prefix_bytes < authorization.session_file.prefix_bytes) fail("R42_TUPLE_COORDINATE_BINDING", "tuple initial coordinate does not bind the authorization transcript");
  const expectedInitialPhrase = initialPhrase({
    static_contract_hash: tuple.static_contract_hash,
    source_commit: tuple.source_commit,
    target_session_id: target.session_id,
    preview_transcript_prefix_sha256: tuple.initial_preview_transcript_prefix_sha256,
  });
  if (coordinate.text_sha256 !== sha256(expectedInitialPhrase) || coordinate.text_utf8_bytes !== Buffer.byteLength(expectedInitialPhrase)) fail("R42_TUPLE_INITIAL_PHRASE", "tuple initial coordinate does not bind the reconstructed exact initial phrase");
  const pre = exactKeys(tuple.prestate_A, ["full_identity", "raw_base64", "raw_bytes", "raw_sha256", "allowed_v2_prestate", "non_v2_jcs_hash", "metadata_assertions"], "tuple.prestate_A");
  const identity = validateFullIdentity(pre.full_identity, "tuple.prestate_A.full_identity");
  const raw = decodeCanonicalBase64(pre.raw_base64, "tuple.prestate_A.raw_base64");
  assertSafeInteger(pre.raw_bytes, "tuple.prestate_A.raw_bytes");
  if (raw.length !== pre.raw_bytes || raw.length !== identity.size || sha256(raw) !== pre.raw_sha256 || pre.raw_sha256 !== identity.raw_sha256) fail("R42_TUPLE_PREIMAGE", "tuple A bytes/count/hash/identity differ");
  const metadata = exactKeys(pre.metadata_assertions, ["regular_file", "nlink_one", "uid_effective", "gid_effective", "mode_allowed", "fd_path_identity_equal", "nofollow_open"], "tuple metadata assertions");
  const uid = process.getuid?.(); const gid = process.getgid?.();
  if (!Object.values(metadata).every((flag) => flag === true) || identity.nlink !== 1 || identity.uid !== uid || identity.gid !== gid || ![0o600, 0o644].includes(identity.mode)) fail("R42_TUPLE_METADATA", "tuple metadata assertions do not mechanically close identity/effective uid/gid/mode");
  const parsedA = asObject(parseStrictJson(raw, { maxBytes: MAX_OBJECT_BYTES }), "tuple A");
  const ruleA = asObject(parsedA.ruleInjector, "tuple A.ruleInjector");
  const v2A = ruleA[SETTINGS_KEY];
  const recomputedPrestate = v2A === undefined ? "absent" : (() => {
    const disabled = exactKeys(v2A, ["enabled", "selector"], "tuple A disabled v2 prestate");
    const selector = exactKeys(disabled.selector, ["session_ids"], "tuple A disabled v2 selector");
    if (disabled.enabled !== false || canonicalizeJcs(selector.session_ids) !== "[]") fail("R42_TUPLE_PRESTATE", "decoded tuple A is not an allowed v2 prestate");
    return "disabled_empty";
  })();
  if (pre.allowed_v2_prestate !== recomputedPrestate) fail("R42_TUPLE_PRESTATE", "tuple A allowed prestate was not recomputed from decoded bytes");
  assertHash(pre.non_v2_jcs_hash, "tuple.prestate_A.non_v2_jcs_hash");
  if (jcsSha256(nonV2Projection(parsedA)) !== pre.non_v2_jcs_hash) fail("R42_TUPLE_NON_V2", "tuple A non-v2 hash differs");
  const desired = validatePersistedDesiredSubtree(tuple.desired_v2_subtree);
  if (desired.r4Binding.static_contract_hash !== tuple.static_contract_hash || desired.r4Binding.commit_token !== tuple.commit_token || desired.r4Binding.settingsPath !== tuple.settings_path || desired.selector.session_ids[0] !== target.session_id || desired.adapterManifestHash !== tuple.adapter_manifest_hash) fail("R42_TUPLE_BINDING", "tuple desired binding differs");
  const d3 = exactKeys(tuple.d3_identities, ["selection_hash", "head_hash", "proof_hash", "intent_hash", "stable_bundle_hash", "p2a_bundle_hash", "generation", "selection_seq"], "tuple.d3_identities");
  for (const field of ["selection_hash", "head_hash", "proof_hash", "intent_hash", "stable_bundle_hash", "p2a_bundle_hash"]) assertHash(d3[field], `tuple.d3_identities.${field}`);
  assertSafeInteger(d3.generation, "tuple.d3_identities.generation"); assertSafeInteger(d3.selection_seq, "tuple.d3_identities.selection_seq");
  const desiredD3 = { selection_hash: desired.selectionHash, head_hash: desired.headHash, proof_hash: desired.proofHash, intent_hash: desired.intentHash, stable_bundle_hash: desired.stableBundleHash, p2a_bundle_hash: desired.p2aBundleHash, generation: desired.generation, selection_seq: desired.selectionSeq };
  if (canonicalizeJcs(d3) !== canonicalizeJcs(desiredD3)) fail("R42_TUPLE_D3", "tuple desired subtree does not close tuple D3 identities");
  const paths = exactKeys(tuple.static_path_pins, ["control_root", "rollback_root", "runtime_audit_root", "legacy_r4_1_audit_history", "operator_audit", "old_activation_root", "quarantine_target", "settings_path"], "tuple.static_path_pins");
  for (const [field, item] of Object.entries(paths)) assertAbsolutePath(item, `tuple.static_path_pins.${field}`);
  if (paths.settings_path !== tuple.settings_path || desired.r4Binding.controlRoot !== paths.control_root || desired.r4Binding.operatorManifestHash !== tuple.operator_manifest_hash) fail("R42_TUPLE_PATH_BINDING", "tuple static path/operator binding differs");
  validateSafetyContract(tuple.safety_contract);
  const expectedToken = computeCommitToken({ staticContractHash: tuple.static_contract_hash, coordinateHash: tuple.initial_coordinate_hash, preRaw: raw, sourceCommit: tuple.source_commit, targetSessionId: target.session_id });
  if (tuple.commit_token !== expectedToken) fail("R42_TUPLE_TOKEN", "tuple commit token was not recomputed from decoded A/static/coordinate/source/target");
  const expectedB = renderSettingsB({ preParsed: parsedA, desiredV2: desired });
  if (tuple.expected_B_raw_sha256 !== expectedB.raw_sha256 || expectedB.non_v2_jcs_hash !== pre.non_v2_jcs_hash) fail("R42_TUPLE_EXPECTED_B", "tuple expected B hash/non-v2 equality was not recomputed from decoded A");
  if (Buffer.byteLength(canonicalizeJcs(tuple)) > MAX_OBJECT_BYTES) fail("R42_TUPLE_OVERSIZE", "operation tuple exceeds 1 MiB");
  return tuple;
}

function validateSafetyContract(value) {
  const safety = exactKeys(value, ["bind_existing_only", "v2_only_write", "non_v2_jcs_carry_forward", "non_v2_raw_not_reviewed", "staged_create_only_authority", "intent_pending_publication_consumes_coordinate", "authority_pending_never_incrementally_written", "r4_2_primitive_only", "per_syscall_retained_auth_reverify", "per_mutating_syscall_source_guard", "bounded_drift_exit_no_auto_loop", "corrupt_authority_no_auto_delete", "compliant_temp_requires_exact_fresh_disposition", "rollback_root_absent_pre_s2", "rollback_not_pre_authorized", "accepted_residual_ids"], "tuple.safety_contract");
  for (const [key, flag] of Object.entries(safety)) if (key !== "accepted_residual_ids" && flag !== true) fail("R42_TUPLE_SAFETY", `${key} is not exact true`);
  if (!Array.isArray(safety.accepted_residual_ids) || safety.accepted_residual_ids.length === 0 || safety.accepted_residual_ids.some((item) => typeof item !== "string" || !item)) fail("R42_TUPLE_SAFETY", "accepted residual ids differ");
  const sorted = [...safety.accepted_residual_ids].sort(compareUtf8);
  if (new Set(sorted).size !== sorted.length || canonicalizeJcs(sorted) !== canonicalizeJcs(safety.accepted_residual_ids)) fail("R42_TUPLE_SAFETY", "accepted residual ids are not sorted unique");
  return safety;
}

export function operationId(tuple) {
  validateOperationTuple(tuple);
  return jcsSha256(tuple);
}

export function buildIntent({ tuple, controlPaths }) {
  const id = operationId(tuple);
  const base = {
    schema_version: SCHEMAS.intent,
    revision: REVISION,
    operation_id: id,
    source_commit: tuple.source_commit,
    operation_tuple: tuple,
    control_paths: cloneJson(controlPaths),
  };
  const intent = addSelfHash(base, "intent_hash");
  validateIntent(intent);
  return intent;
}

export function validateIntent(value) {
  const intent = exactKeys(value, ["schema_version", "revision", "operation_id", "source_commit", "operation_tuple", "control_paths", "intent_hash"], "intent");
  if (intent.schema_version !== SCHEMAS.intent || intent.revision !== REVISION) fail("R42_INTENT_SCHEMA", "intent identity differs");
  const tuple = validateOperationTuple(intent.operation_tuple);
  if (intent.operation_id !== operationId(tuple) || intent.source_commit !== tuple.source_commit) fail("R42_INTENT_BINDING", "intent operation/source binding differs");
  const paths = exactKeys(intent.control_paths, ["intent", "activation", "receipt", "operator_audit"], "intent.control_paths");
  const root = tuple.static_path_pins.control_root;
  const expected = { intent: path.join(root, "intents", `${intent.operation_id}.json`), activation: path.join(root, "activations", `${intent.operation_id}.json`), receipt: path.join(root, "receipts", `${intent.operation_id}.json`), operator_audit: path.join(root, "operator-audit.jsonl") };
  if (canonicalizeJcs(paths) !== canonicalizeJcs(expected)) fail("R42_INTENT_PATHS", "intent resolved control paths differ from tuple/static derivation");
  validateSelfHash(intent, "intent_hash", "intent");
  return intent;
}

export function validateOperationTupleAgainstStatic(value, staticContractInput) {
  const tuple = validateOperationTuple(value);
  const contract = asObject(staticContractInput, "static_contract");
  if (contract.schema_version !== SCHEMAS.static_contract || contract.revision !== REVISION || tuple.static_contract_hash !== contract.static_contract_hash) fail("R42_TUPLE_STATIC", "tuple does not bind the committed R4.2 static contract");
  const exact = {
    source_manifest_hash: contract.source_manifest?.self_hash,
    source_closure_hash: contract.source_manifest?.source_closure_hash,
    adapter_manifest_hash: contract.adapter_manifest?.self_hash,
    operator_manifest_hash: contract.operator_manifest?.self_hash,
    settings_path: contract.settings_contract?.settings_path,
    transformer_version: contract.settings_contract?.transformer_version,
  };
  for (const [field, expected] of Object.entries(exact)) if (tuple[field] !== expected) fail("R42_TUPLE_STATIC", `tuple.${field} differs from static contract`);
  for (const field of ["target_session_binding", "authorization_transcript_binding", "d3_identities"]) if (canonicalizeJcs(tuple[field]) !== canonicalizeJcs(contract[field])) fail("R42_TUPLE_STATIC", `tuple.${field} differs from static contract`);
  if (!contract.settings_contract.allowed_v2_prestate.includes(tuple.prestate_A.allowed_v2_prestate)) fail("R42_TUPLE_STATIC", "tuple A prestate is outside static allowed set");
  validateSettingsMetadataPolicy(contract.settings_contract.allowed_metadata_policy);
  const expectedDesired = renderDesiredSubtree(contract.settings_contract.desired_v2_template, contract.static_contract_hash, tuple.commit_token);
  if (canonicalizeJcs(tuple.desired_v2_subtree) !== canonicalizeJcs(expectedDesired)) fail("R42_TUPLE_STATIC", "tuple desired subtree was not rendered from static template");
  const expectedPaths = {
    control_root: contract.control_paths.control_root,
    rollback_root: contract.rollback_paths.rollback_root,
    runtime_audit_root: contract.runtime_audit_paths.runtime_audit_root,
    legacy_r4_1_audit_history: contract.runtime_audit_paths.legacy_r4_1_history_path,
    operator_audit: path.join(contract.control_paths.control_root, contract.control_paths.operator_audit_relative),
    old_activation_root: contract.rollback_paths.old_activation_root,
    quarantine_target: contract.rollback_paths.quarantine_target,
    settings_path: contract.settings_contract.settings_path,
  };
  if (canonicalizeJcs(tuple.static_path_pins) !== canonicalizeJcs(expectedPaths) || canonicalizeJcs(tuple.safety_contract.accepted_residual_ids) !== canonicalizeJcs(contract.residuals.accepted_residual_ids)) fail("R42_TUPLE_STATIC", "tuple path/safety pins differ from static contract");
  return tuple;
}

export function validateIntentAgainstStatic(value, staticContract) {
  const intent = validateIntent(value);
  validateOperationTupleAgainstStatic(intent.operation_tuple, staticContract);
  return intent;
}

export function activationNonce(operationIdInput, intentHash, staticContractHash) {
  for (const [value, label] of [[operationIdInput, "operation_id"], [intentHash, "intent_hash"], [staticContractHash, "static_contract_hash"]]) assertHash(value, label);
  return sha256(Buffer.concat([
    Buffer.from("adr0040-d3-v2-session-start-r4.2-activation-nonce/v1\0", "utf8"),
    Buffer.from(operationIdInput, "ascii"), Buffer.from([0]), Buffer.from(intentHash, "ascii"), Buffer.from([0]), Buffer.from(staticContractHash, "ascii"),
  ]));
}

export function buildActivationHashInputs({ intent, staticContract }) {
  validateIntent(intent);
  const tuple = intent.operation_tuple;
  const hashInputs = {
    schema_version: SCHEMAS.activation_hash_inputs,
    operation_id: intent.operation_id,
    intent_hash: intent.intent_hash,
    activation_nonce: activationNonce(intent.operation_id, intent.intent_hash, tuple.static_contract_hash),
    initial_coordinate_hash: tuple.initial_coordinate_hash,
    d3_identities_hash: jcsSha256(tuple.d3_identities),
    target_session_binding_hash: jcsSha256(tuple.target_session_binding),
    authorization_transcript_binding_hash: jcsSha256(tuple.authorization_transcript_binding),
    adapter_manifest_hash: tuple.adapter_manifest_hash,
    operator_manifest_hash: tuple.operator_manifest_hash,
    source_manifest_hash: tuple.source_manifest_hash,
    source_closure_hash: tuple.source_closure_hash,
    desired_v2_subtree_hash: jcsSha256(tuple.desired_v2_subtree),
    expected_B_raw_sha256: tuple.expected_B_raw_sha256,
    commit_token: tuple.commit_token,
    static_contract_hash: tuple.static_contract_hash,
    source_commit: tuple.source_commit,
    audit_target: staticContract.runtime_audit_paths.runtime_audit_root,
    rollback_target: staticContract.rollback_paths.rollback_root,
    quarantine_target: staticContract.rollback_paths.quarantine_target,
  };
  validateActivationHashInputs(hashInputs);
  return deepFreeze(hashInputs);
}

export function validateActivationHashInputs(value) {
  const inputs = exactKeys(value, ["schema_version", "operation_id", "intent_hash", "activation_nonce", "initial_coordinate_hash", "d3_identities_hash", "target_session_binding_hash", "authorization_transcript_binding_hash", "adapter_manifest_hash", "operator_manifest_hash", "source_manifest_hash", "source_closure_hash", "desired_v2_subtree_hash", "expected_B_raw_sha256", "commit_token", "static_contract_hash", "source_commit", "audit_target", "rollback_target", "quarantine_target"], "activation_hash_inputs");
  if (inputs.schema_version !== SCHEMAS.activation_hash_inputs) fail("R42_ACTIVATION_INPUTS_SCHEMA", "activation inputs schema differs");
  for (const [field, valueInput] of Object.entries(inputs)) if (field.endsWith("_hash") || field.endsWith("_sha256") || field === "operation_id" || field === "activation_nonce" || field === "commit_token") assertHash(valueInput, `activation inputs.${field}`);
  assertGitCommit(inputs.source_commit);
  for (const field of ["audit_target", "rollback_target", "quarantine_target"]) assertAbsolutePath(inputs[field], `activation inputs.${field}`);
  return inputs;
}

export function buildActivation({ intent, staticContract }) {
  const tuple = intent.operation_tuple;
  const inputs = buildActivationHashInputs({ intent, staticContract });
  const base = {
    schema_version: SCHEMAS.activation,
    revision: REVISION,
    mode: "bound",
    authorization_status: "AUTHORIZED",
    operation_id: intent.operation_id,
    intent_hash: intent.intent_hash,
    session_id: tuple.target_session_binding.session_id,
    activation_nonce: inputs.activation_nonce,
    initial_authorization_coordinate: tuple.initial_authorization_coordinate,
    initial_coordinate_hash: tuple.initial_coordinate_hash,
    d3_identities: tuple.d3_identities,
    d3_identities_hash: inputs.d3_identities_hash,
    target_session_binding_hash: inputs.target_session_binding_hash,
    authorization_transcript_binding_hash: inputs.authorization_transcript_binding_hash,
    adapter_manifest_hash: tuple.adapter_manifest_hash,
    operator_manifest_hash: tuple.operator_manifest_hash,
    source_manifest_hash: tuple.source_manifest_hash,
    static_contract_hash: tuple.static_contract_hash,
    source_commit: tuple.source_commit,
    source_closure_hash: tuple.source_closure_hash,
    activation_hash_inputs: inputs,
    activation_hash_inputs_hash: jcsSha256(inputs),
    desired_v2_subtree: tuple.desired_v2_subtree,
    v2_subtree_hash: inputs.desired_v2_subtree_hash,
    expected_B_raw_sha256: tuple.expected_B_raw_sha256,
    commit_token: tuple.commit_token,
    audit_target: inputs.audit_target,
    rollback_target: inputs.rollback_target,
    session_file: tuple.target_session_binding.session_file,
    quarantine_target: inputs.quarantine_target,
    executable: true,
  };
  return addSelfHash(base, "activation_object_hash");
}

export function validateActivation(value) {
  const activation = exactKeys(value, ["schema_version", "revision", "mode", "authorization_status", "operation_id", "intent_hash", "session_id", "activation_nonce", "initial_authorization_coordinate", "initial_coordinate_hash", "d3_identities", "d3_identities_hash", "target_session_binding_hash", "authorization_transcript_binding_hash", "adapter_manifest_hash", "operator_manifest_hash", "source_manifest_hash", "static_contract_hash", "source_commit", "source_closure_hash", "activation_hash_inputs", "activation_hash_inputs_hash", "desired_v2_subtree", "v2_subtree_hash", "expected_B_raw_sha256", "commit_token", "audit_target", "rollback_target", "session_file", "quarantine_target", "executable", "activation_object_hash"], "activation");
  if (activation.schema_version !== SCHEMAS.activation || activation.revision !== REVISION || activation.mode !== "bound" || activation.authorization_status !== "AUTHORIZED" || activation.executable !== true) fail("R42_ACTIVATION_SCHEMA", "activation identity differs");
  const inputs = validateActivationHashInputs(activation.activation_hash_inputs);
  const coordinate = validateTrustedCoordinate(activation.initial_authorization_coordinate);
  const desired = validatePersistedDesiredSubtree(activation.desired_v2_subtree);
  validateSessionFileBinding(activation.session_file, "activation.session_file");
  const recomputed = {
    operation_id: activation.operation_id,
    intent_hash: activation.intent_hash,
    activation_nonce: activationNonce(activation.operation_id, activation.intent_hash, activation.static_contract_hash),
    initial_coordinate_hash: coordinate.coordinate_hash,
    d3_identities_hash: jcsSha256(activation.d3_identities),
    adapter_manifest_hash: activation.adapter_manifest_hash,
    operator_manifest_hash: activation.operator_manifest_hash,
    source_manifest_hash: activation.source_manifest_hash,
    source_closure_hash: activation.source_closure_hash,
    desired_v2_subtree_hash: jcsSha256(desired),
    expected_B_raw_sha256: activation.expected_B_raw_sha256,
    commit_token: activation.commit_token,
    static_contract_hash: activation.static_contract_hash,
    source_commit: activation.source_commit,
    audit_target: activation.audit_target,
    rollback_target: activation.rollback_target,
    quarantine_target: activation.quarantine_target,
  };
  for (const [field, expected] of Object.entries(recomputed)) if (inputs[field] !== expected) fail("R42_ACTIVATION_INPUTS_CLOSURE", `activation ${field} does not close activation_hash_inputs`);
  for (const field of ["operation_id", "intent_hash", "activation_nonce", "initial_coordinate_hash", "d3_identities_hash", "target_session_binding_hash", "authorization_transcript_binding_hash", "adapter_manifest_hash", "operator_manifest_hash", "source_manifest_hash", "static_contract_hash", "source_commit", "source_closure_hash", "expected_B_raw_sha256", "commit_token", "audit_target", "rollback_target", "quarantine_target"]) {
    if (activation[field] !== inputs[field]) fail("R42_ACTIVATION_INPUTS_CLOSURE", `activation.${field} differs from activation_hash_inputs`);
  }
  if (activation.activation_hash_inputs_hash !== jcsSha256(inputs) || activation.v2_subtree_hash !== inputs.desired_v2_subtree_hash || desired.r4Binding.static_contract_hash !== activation.static_contract_hash || desired.r4Binding.commit_token !== activation.commit_token || desired.selector.session_ids[0] !== activation.session_id) fail("R42_ACTIVATION_CLOSURE", "activation hash/desired/session closure differs");
  validateSelfHash(activation, "activation_object_hash", "activation");
  return activation;
}

function validateSessionFileBinding(value, label) {
  const file = exactKeys(value, ["path", "dev", "ino", "prefix_bytes", "prefix_sha256", "header_sha256"], label);
  assertAbsolutePath(file.path, `${label}.path`);
  for (const field of ["dev", "ino", "prefix_bytes"]) assertSafeInteger(file[field], `${label}.${field}`, { min: 1 });
  assertHash(file.prefix_sha256, `${label}.prefix_sha256`); assertHash(file.header_sha256, `${label}.header_sha256`);
  return file;
}

export function buildReceipt(args) {
  const { intent, activation, completionAuthorization, mode, postWitness } = args;
  validateIntent(intent);
  validateActivation(activation);
  const tuple = intent.operation_tuple;
  const common = {
    schema_version: SCHEMAS.receipt,
    revision: REVISION,
    operation_id: intent.operation_id,
    intent_hash: intent.intent_hash,
    activation_object_hash: activation.activation_object_hash,
    static_contract_hash: tuple.static_contract_hash,
    source_commit: tuple.source_commit,
    source_manifest_hash: tuple.source_manifest_hash,
    source_closure_hash: tuple.source_closure_hash,
    target_session_binding: tuple.target_session_binding,
    authorization_transcript_binding: tuple.authorization_transcript_binding,
    d3_identities: tuple.d3_identities,
    adapter_manifest_hash: tuple.adapter_manifest_hash,
    operator_manifest_hash: tuple.operator_manifest_hash,
    initial_coordinate_hash: tuple.initial_coordinate_hash,
    completion_authorization: cloneJson(completionAuthorization),
    expected_B_raw_sha256: tuple.expected_B_raw_sha256,
    v2_subtree_hash: jcsSha256(tuple.desired_v2_subtree),
    commit_token: tuple.commit_token,
    control_paths: intent.control_paths,
    mode,
    post_witness: cloneJson(postWitness),
    durable_object_not_message: true,
    exactly_once: true,
    runtime_audit_required_before_first_injection: true,
  };
  const receipt = addSelfHash(common, "receipt_hash");
  validateReceipt(receipt);
  return receipt;
}

export function validateReceipt(value) {
  const receipt = exactKeys(value, ["schema_version", "revision", "operation_id", "intent_hash", "activation_object_hash", "static_contract_hash", "source_commit", "source_manifest_hash", "source_closure_hash", "target_session_binding", "authorization_transcript_binding", "d3_identities", "adapter_manifest_hash", "operator_manifest_hash", "initial_coordinate_hash", "completion_authorization", "expected_B_raw_sha256", "v2_subtree_hash", "commit_token", "control_paths", "mode", "post_witness", "durable_object_not_message", "exactly_once", "runtime_audit_required_before_first_injection", "receipt_hash"], "receipt");
  if (receipt.schema_version !== SCHEMAS.receipt || receipt.revision !== REVISION || !["direct", "ambient_state_adoption"].includes(receipt.mode) || receipt.durable_object_not_message !== true || receipt.exactly_once !== true || receipt.runtime_audit_required_before_first_injection !== true) fail("R42_RECEIPT_SCHEMA", "receipt identity differs");
  for (const field of ["operation_id", "intent_hash", "activation_object_hash", "static_contract_hash", "source_manifest_hash", "source_closure_hash", "adapter_manifest_hash", "operator_manifest_hash", "initial_coordinate_hash", "expected_B_raw_sha256", "v2_subtree_hash", "commit_token", "receipt_hash"]) assertHash(receipt[field], `receipt.${field}`);
  assertGitCommit(receipt.source_commit, "receipt.source_commit");
  validateSessionBinding(receipt.target_session_binding, "receipt.target_session_binding");
  validateSessionBinding(receipt.authorization_transcript_binding, "receipt.authorization_transcript_binding");
  const completion = exactKeys(receipt.completion_authorization, ["kind", "coordinate", "coordinate_hash"], "completion_authorization");
  const coordinate = validateTrustedCoordinate(completion.coordinate);
  if (completion.coordinate_hash !== coordinate.coordinate_hash) fail("R42_RECEIPT_COORDINATE", "completion coordinate hash differs");
  if (receipt.mode === "direct") {
    if (!["initial_execute", "fresh_continue"].includes(completion.kind)) fail("R42_RECEIPT_COMPLETION", "direct receipt completion kind differs");
    const witness = exactKeys(receipt.post_witness, ["actual_B_full_identity", "actual_B_full_identity_recoverable"], "direct post_witness");
    validateFullIdentity(witness.actual_B_full_identity, "actual_B_full_identity");
    if (witness.actual_B_full_identity_recoverable !== true || witness.actual_B_full_identity.raw_sha256 !== receipt.expected_B_raw_sha256 || witness.actual_B_full_identity.nlink !== 1) fail("R42_RECEIPT_WITNESS", "direct witness differs");
  } else {
    if (completion.kind !== "ambient_state_adoption") fail("R42_RECEIPT_COMPLETION", "adoption receipt completion kind differs");
    const witness = exactKeys(receipt.post_witness, ["current_C_full_identity", "current_C_raw_sha256", "current_C_non_v2_jcs_hash", "activation_absent_at_preview", "actual_B_full_identity_recoverable", "cas_A_to_B_history_proven", "reason"], "adoption post_witness");
    validateFullIdentity(witness.current_C_full_identity, "current_C_full_identity");
    if (witness.current_C_raw_sha256 !== witness.current_C_full_identity.raw_sha256 || witness.current_C_full_identity.nlink !== 1) fail("R42_RECEIPT_WITNESS", "adoption C raw hash differs");
    if (typeof witness.activation_absent_at_preview !== "boolean") fail("R42_RECEIPT_WITNESS", "adoption activation_absent_at_preview must be boolean");
    assertHash(witness.current_C_non_v2_jcs_hash, "current_C_non_v2_jcs_hash");
    if (witness.actual_B_full_identity_recoverable !== false || witness.cas_A_to_B_history_proven !== false || witness.reason !== "state_adoption_only_cas_A_to_B_history_not_proven") fail("R42_RECEIPT_WITNESS", "adoption historical boundary differs");
  }
  validateSelfHash(receipt, "receipt_hash", "receipt");
  return receipt;
}

export function validateActivationAgainstIntent(value, intentInput, staticContract) {
  const intent = validateIntentAgainstStatic(intentInput, staticContract);
  const activation = validateActivation(value);
  const expected = buildActivation({ intent, staticContract });
  if (canonicalizeJcs(activation) !== canonicalizeJcs(expected)) fail("R42_ACTIVATION_FOREIGN_AUTHORITY", "activation differs from independently rebuilt I/static authority");
  return activation;
}

export function validateReceiptAgainstClosure(value, intentInput, activationInput, staticContract) {
  const intent = validateIntentAgainstStatic(intentInput, staticContract);
  const activation = validateActivationAgainstIntent(activationInput, intent, staticContract);
  const receipt = validateReceipt(value);
  const tuple = intent.operation_tuple;
  const expectedCommon = {
    operation_id: intent.operation_id,
    intent_hash: intent.intent_hash,
    activation_object_hash: activation.activation_object_hash,
    static_contract_hash: tuple.static_contract_hash,
    source_commit: tuple.source_commit,
    source_manifest_hash: tuple.source_manifest_hash,
    source_closure_hash: tuple.source_closure_hash,
    target_session_binding: tuple.target_session_binding,
    authorization_transcript_binding: tuple.authorization_transcript_binding,
    d3_identities: tuple.d3_identities,
    adapter_manifest_hash: tuple.adapter_manifest_hash,
    operator_manifest_hash: tuple.operator_manifest_hash,
    initial_coordinate_hash: tuple.initial_coordinate_hash,
    expected_B_raw_sha256: tuple.expected_B_raw_sha256,
    v2_subtree_hash: jcsSha256(tuple.desired_v2_subtree),
    commit_token: tuple.commit_token,
    control_paths: intent.control_paths,
  };
  for (const [field, expected] of Object.entries(expectedCommon)) if (canonicalizeJcs(receipt[field]) !== canonicalizeJcs(expected)) fail("R42_RECEIPT_FOREIGN_AUTHORITY", `receipt.${field} does not close I/V/static authority`);
  const completion = receipt.completion_authorization;
  const coordinate = completion.coordinate;
  const auth = tuple.authorization_transcript_binding;
  if (coordinate.session_id !== auth.session_id || coordinate.session_jsonl_path !== auth.session_file.path || coordinate.session_dev !== auth.session_file.dev || coordinate.session_ino !== auth.session_file.ino) fail("R42_RECEIPT_COMPLETION_BINDING", "receipt completion coordinate is from a foreign transcript");
  const initial = tuple.initial_authorization_coordinate;
  if (completion.kind === "initial_execute") {
    if (receipt.mode !== "direct" || canonicalizeJcs(coordinate) !== canonicalizeJcs(initial)) fail("R42_RECEIPT_COMPLETION_BINDING", "initial completion is not exact initial direct coordinate");
  } else {
    const initialMs = Date.parse(initial.timestamp); const completionMs = Date.parse(coordinate.timestamp);
    if (coordinate.message_line_number <= initial.message_line_number || coordinate.transcript_prefix_bytes <= initial.transcript_prefix_bytes || !Number.isFinite(initialMs) || !Number.isFinite(completionMs) || completionMs <= initialMs) fail("R42_RECEIPT_COMPLETION_BINDING", "receipt completion coordinate is not later than initial");
    if (completion.kind === "fresh_continue") {
      const phrase = continuePhrase({ operation_id: intent.operation_id, static_contract_hash: tuple.static_contract_hash, source_commit: tuple.source_commit });
      if (coordinate.text_sha256 !== sha256(phrase) || coordinate.text_utf8_bytes !== Buffer.byteLength(phrase)) fail("R42_RECEIPT_COMPLETION_BINDING", "fresh continue coordinate does not bind exact operation phrase");
    } else if (completion.kind === "ambient_state_adoption") {
      const phrase = adoptionPhrase(buildAdoptionAuthorizationFields({
        intent,
        staticContract,
        currentCRawSha256: receipt.post_witness.current_C_raw_sha256,
        currentCNonV2JcsHash: receipt.post_witness.current_C_non_v2_jcs_hash,
        activationAbsent: receipt.post_witness.activation_absent_at_preview,
      }));
      if (coordinate.text_sha256 !== sha256(phrase) || coordinate.text_utf8_bytes !== Buffer.byteLength(phrase)) fail("R42_RECEIPT_COMPLETION_BINDING", "adoption coordinate does not bind the independently reconstructed exact adoption phrase");
    }
  }
  if (receipt.mode === "direct") {
    const expectedB = renderSettingsB({ preParsed: parseStrictJson(decodeCanonicalBase64(tuple.prestate_A.raw_base64), { maxBytes: MAX_OBJECT_BYTES }), desiredV2: tuple.desired_v2_subtree });
    const identity = receipt.post_witness.actual_B_full_identity;
    const A = tuple.prestate_A.full_identity;
    if (identity.mode !== A.mode || identity.uid !== A.uid || identity.gid !== A.gid || identity.nlink !== 1 || identity.size !== expectedB.raw.length || identity.raw_sha256 !== expectedB.raw_sha256 || expectedB.raw_sha256 !== tuple.expected_B_raw_sha256) fail("R42_RECEIPT_DIRECT_IDENTITY", "direct post identity metadata/size/hash do not exactly match tuple A metadata and reconstructed B bytes");
  }
  return receipt;
}

export function validateSessionBinding(value, label = "session_binding") {
  const binding = exactKeys(value, ["session_id", "sessions_root", "session_file"], label);
  assertSafeSessionId(binding.session_id, `${label}.session_id`);
  assertAbsolutePath(binding.sessions_root, `${label}.sessions_root`);
  const file = exactKeys(binding.session_file, ["path", "dev", "ino", "prefix_bytes", "prefix_sha256", "header_sha256"], `${label}.session_file`);
  assertAbsolutePath(file.path, `${label}.session_file.path`);
  for (const field of ["dev", "ino", "prefix_bytes"]) assertSafeInteger(file[field], `${label}.session_file.${field}`, { min: 1 });
  assertHash(file.prefix_sha256, `${label}.session_file.prefix_sha256`);
  assertHash(file.header_sha256, `${label}.session_file.header_sha256`);
  const relative = path.relative(binding.sessions_root, file.path);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !path.basename(file.path).endsWith(`_${binding.session_id}.jsonl`)) fail("R42_SESSION_PATH", `${label} session path differs from root/id`);
  return binding;
}

export function verifySessionPrefix(bindingInput) {
  const binding = validateSessionBinding(bindingInput);
  const file = binding.session_file.path;
  const captured = readBoundedRegular(file, { label: "session prefix", maxBytes: MAX_SESSION_BYTES });
  if (captured.identity.dev !== binding.session_file.dev || captured.identity.ino !== binding.session_file.ino || captured.raw.length < binding.session_file.prefix_bytes) fail("R42_SESSION_IDENTITY", "session file identity/extent differs");
  const prefix = captured.raw.subarray(0, binding.session_file.prefix_bytes);
  if (sha256(prefix) !== binding.session_file.prefix_sha256) fail("R42_SESSION_PREFIX", "session frozen prefix differs");
  const firstLf = prefix.indexOf(0x0a);
  if (firstLf < 0 || sha256(prefix.subarray(0, firstLf)) !== binding.session_file.header_sha256) fail("R42_SESSION_HEADER", "session header hash differs");
  const header = asObject(parseStrictJson(prefix.subarray(0, firstLf), { maxBytes: MAX_SESSION_BYTES }), "session header");
  if (header.type !== "session" || header.version !== 3 || header.id !== binding.session_id) fail("R42_SESSION_HEADER", "session header identity differs");
  return deepFreeze({ identity: captured.identity, prefix_sha256: sha256(prefix), header_sha256: sha256(prefix.subarray(0, firstLf)) });
}

export function validateTrustedCoordinate(value) {
  const coordinate = exactKeys(value, ["schema_version", "session_jsonl_path", "session_id", "session_dev", "session_ino", "message_id", "message_parent_id", "message_line_number", "timestamp", "role", "text_utf8_bytes", "text_sha256", "transcript_prefix_bytes", "transcript_prefix_sha256", "active_parent_chain_hash", "continuous_parent_chain_verified", "latest_role_user_message_verified", "standalone_single_text_part_verified", "fresh_verified", "caller_supplied_raw_text", "coordinate_hash"], "trusted_coordinate");
  if (coordinate.schema_version !== SCHEMAS.trusted_coordinate || coordinate.role !== "user" || coordinate.continuous_parent_chain_verified !== true || coordinate.latest_role_user_message_verified !== true || coordinate.standalone_single_text_part_verified !== true || coordinate.fresh_verified !== true || coordinate.caller_supplied_raw_text !== false) fail("R42_COORDINATE_FLAGS", "coordinate flags differ");
  assertAbsolutePath(coordinate.session_jsonl_path, "coordinate.session_jsonl_path");
  assertSafeSessionId(coordinate.session_id, "coordinate.session_id");
  for (const field of ["session_dev", "session_ino", "message_line_number", "text_utf8_bytes", "transcript_prefix_bytes"]) assertSafeInteger(coordinate[field], `coordinate.${field}`, { min: 1 });
  for (const field of ["text_sha256", "transcript_prefix_sha256", "active_parent_chain_hash", "coordinate_hash"]) assertHash(coordinate[field], `coordinate.${field}`);
  if (typeof coordinate.message_id !== "string" || !coordinate.message_id || (coordinate.message_parent_id !== null && (typeof coordinate.message_parent_id !== "string" || !coordinate.message_parent_id)) || !Number.isFinite(Date.parse(coordinate.timestamp))) fail("R42_COORDINATE_VALUE", "coordinate ids/timestamp differ");
  validateSelfHash(coordinate, "coordinate_hash", "trusted_coordinate");
  return coordinate;
}

function exactSingleText(content) {
  if (!Array.isArray(content) || content.length !== 1) fail("R42_TRANSCRIPT_STANDALONE", "authorization must have one content part");
  const part = exactKeys(content[0], ["type", "text"], "authorization content part");
  if (part.type !== "text" || typeof part.text !== "string") fail("R42_TRANSCRIPT_STANDALONE", "authorization content part must be text");
  return part.text;
}

const TRUSTED_ENTRY_TYPES = new Set(["message", "model_change", "thinking_level_change", "compaction", "branch_summary", "custom", "custom_message", "label", "session_info"]);

function exactAllowedKeys(value, required, optional, label) {
  const keys = Object.keys(asObject(value, label));
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  const extra = keys.filter((key) => !allowed.has(key));
  if (missing.length || extra.length) fail("R42_TRANSCRIPT_SCHEMA", `${label} keys differ`, { missing, extra });
}

function validateTrustedEntry(row, line) {
  const common = ["type", "id", "parentId", "timestamp"];
  if (!TRUSTED_ENTRY_TYPES.has(row.type)) fail("R42_TRANSCRIPT_ENTRY_TYPE", `unknown entry type at line ${line}`);
  if (row.type === "message") {
    exactAllowedKeys(row, [...common, "message"], [], `message line ${line}`);
    const message = asObject(row.message, `message line ${line}.message`);
    if (message.role === "user") exactAllowedKeys(message, ["role", "content", "timestamp"], [], `user message line ${line}`);
    else if (message.role === "assistant") exactAllowedKeys(message, ["role", "content", "timestamp", "api", "provider", "model", "usage", "stopReason"], ["responseId", "errorMessage"], `assistant message line ${line}`);
    else if (message.role === "toolResult") exactAllowedKeys(message, ["role", "content", "timestamp", "toolCallId", "toolName", "isError"], ["details"], `tool result line ${line}`);
    else fail("R42_TRANSCRIPT_ROLE", `unsupported message role at line ${line}`);
    if (!Array.isArray(message.content)) fail("R42_TRANSCRIPT_CONTENT", `message content is not an array at line ${line}`);
  } else if (row.type === "model_change") exactAllowedKeys(row, [...common, "provider", "modelId"], [], `model_change line ${line}`);
  else if (row.type === "thinking_level_change") exactAllowedKeys(row, [...common, "thinkingLevel"], [], `thinking_level_change line ${line}`);
  else if (row.type === "compaction") exactAllowedKeys(row, [...common, "summary", "firstKeptEntryId", "tokensBefore"], ["details", "fromHook"], `compaction line ${line}`);
  else if (row.type === "branch_summary") exactAllowedKeys(row, [...common, "summary", "fromId"], [], `branch_summary line ${line}`);
  else if (row.type === "custom") exactAllowedKeys(row, [...common, "customType", "data"], [], `custom line ${line}`);
  else if (row.type === "custom_message") exactAllowedKeys(row, [...common, "customType", "content", "display"], ["details"], `custom_message line ${line}`);
  else if (row.type === "label") exactAllowedKeys(row, [...common, "targetId", "label"], [], `label line ${line}`);
  else exactAllowedKeys(row, common, ["name"], `session_info line ${line}`);
}

export function parseTrustedTranscript(raw, bindingInput) {
  const binding = validateSessionBinding(bindingInput);
  if (raw.length > MAX_SESSION_BYTES) fail("R42_TRANSCRIPT_OVERSIZE", "session transcript exceeds 64 MiB");
  const rowsRaw = [];
  let start = 0;
  let line = 1;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== 0x0a) continue;
    if (index === start || (index === start + 1 && raw[start] === 0x0d)) fail("R42_TRANSCRIPT_BLANK", `blank transcript row ${line}`);
    rowsRaw.push({ line, start, end: index + 1, raw: raw.subarray(start, index > start && raw[index - 1] === 0x0d ? index - 1 : index) });
    start = index + 1;
    line += 1;
  }
  if (start < raw.length) rowsRaw.push({ line, start, end: raw.length, raw: raw.subarray(start) });
  if (rowsRaw.length < 2) fail("R42_TRANSCRIPT_EMPTY", "transcript lacks header/entry");
  const header = asObject(parseStrictJson(rowsRaw[0].raw, { maxBytes: MAX_SESSION_BYTES }), "session header");
  exactAllowedKeys(header, ["type", "version", "id", "timestamp", "cwd"], ["parentSession"], "session header");
  if (header.type !== "session" || header.version !== 3 || header.id !== binding.session_id || typeof header.timestamp !== "string" || !Number.isFinite(Date.parse(header.timestamp)) || typeof header.cwd !== "string" || !path.isAbsolute(header.cwd) || (header.parentSession !== undefined && (typeof header.parentSession !== "string" || !header.parentSession))) fail("R42_TRANSCRIPT_HEADER", "trusted pi v3 header differs");
  if (sha256(rowsRaw[0].raw) !== binding.session_file.header_sha256) fail("R42_TRANSCRIPT_HEADER", "trusted header hash differs");
  const seen = new Set([header.id]);
  const byId = new Map();
  const rows = [];
  for (const item of rowsRaw.slice(1)) {
    const row = asObject(parseStrictJson(item.raw, { maxBytes: MAX_SESSION_BYTES }), `transcript line ${item.line}`);
    validateTrustedEntry(row, item.line);
    if (typeof row.id !== "string" || !row.id || seen.has(row.id) || !(row.parentId === null || (typeof row.parentId === "string" && seen.has(row.parentId)))) fail("R42_TRANSCRIPT_CHAIN", `transcript line ${item.line} id/parent differs`);
    if (typeof row.timestamp !== "string" || !Number.isFinite(Date.parse(row.timestamp))) fail("R42_TRANSCRIPT_TIMESTAMP", `transcript line ${item.line} timestamp differs`);
    let role = null;
    let content = null;
    if (row.type === "message") { role = row.message.role; content = row.message.content; }
    const normalized = { id: row.id, parentId: row.parentId, line: item.line, start: item.start, end: item.end, timestamp: row.timestamp, role, content };
    seen.add(row.id);
    byId.set(row.id, normalized);
    rows.push(normalized);
  }
  if (rows.filter((row) => row.parentId === null).length !== 1) fail("R42_TRANSCRIPT_ROOT", "session tree must contain exactly one root entry");
  const leaf = rows.at(-1);
  const active = [];
  let cursor = leaf;
  while (cursor) {
    active.push(cursor);
    if (cursor.parentId === null) break;
    cursor = byId.get(cursor.parentId);
    if (!cursor) fail("R42_TRANSCRIPT_CHAIN", "active chain is broken");
  }
  active.reverse();
  return deepFreeze({ header, rows, active });
}

export function openRetainedTranscript(bindingInput) {
  const binding = validateSessionBinding(bindingInput);
  verifySessionPrefix(binding);
  const fd = fs.openSync(binding.session_file.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | CLOEXEC);
  let closed = false;
  function readCurrent() {
    if (closed) fail("R42_TRANSCRIPT_CLOSED", "retained transcript fd is closed");
    const before = fs.fstatSync(fd, { bigint: true });
    if (before.size > BigInt(MAX_SESSION_BYTES) || before.size > BigInt(Number.MAX_SAFE_INTEGER)) fail("R42_TRANSCRIPT_OVERSIZE", "retained transcript exceeds bounded size");
    const raw = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < raw.length) {
      const count = fs.readSync(fd, raw, offset, raw.length - offset, offset);
      if (count <= 0) fail("R42_TRANSCRIPT_RACE", "retained transcript read made no progress");
      offset += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(binding.session_file.path, { bigint: true });
    if (!sameIdentity(before, after) || before.dev !== named.dev || before.ino !== named.ino || bigintToSafe(before.dev, "session dev") !== binding.session_file.dev || bigintToSafe(before.ino, "session ino") !== binding.session_file.ino || raw.length > MAX_SESSION_BYTES) fail("R42_TRANSCRIPT_RACE", "retained transcript identity differs");
    if (sha256(raw.subarray(0, binding.session_file.prefix_bytes)) !== binding.session_file.prefix_sha256) fail("R42_TRANSCRIPT_PREFIX", "retained transcript frozen prefix differs");
    return { raw, parsed: parseTrustedTranscript(raw, binding) };
  }
  function coordinateFor(raw, parsed, row, text) {
    const base = {
      schema_version: SCHEMAS.trusted_coordinate,
      session_jsonl_path: binding.session_file.path,
      session_id: binding.session_id,
      session_dev: binding.session_file.dev,
      session_ino: binding.session_file.ino,
      message_id: row.id,
      message_parent_id: row.parentId,
      message_line_number: row.line,
      timestamp: row.timestamp,
      role: "user",
      text_utf8_bytes: Buffer.byteLength(text),
      text_sha256: sha256(text),
      transcript_prefix_bytes: row.end,
      transcript_prefix_sha256: sha256(raw.subarray(0, row.end)),
      active_parent_chain_hash: jcsSha256(parsed.active.filter((item) => item.line <= row.line).map((item) => ({ id: item.id, parent_id: item.parentId, line: item.line }))),
      continuous_parent_chain_verified: true,
      latest_role_user_message_verified: true,
      standalone_single_text_part_verified: true,
      fresh_verified: true,
      caller_supplied_raw_text: false,
    };
    return validateTrustedCoordinate({ ...base, coordinate_hash: jcsSha256(base) });
  }
  function latestCandidate(maximumAgeMs = 7_200_000, nowMs = Date.now()) {
    const { raw, parsed } = readCurrent();
    const latest = parsed.active.filter((row) => row.role === "user").at(-1);
    if (!latest) fail("R42_AUTH_REQUIRED", "active transcript has no role=user coordinate");
    const text = exactSingleText(latest.content);
    const timestampMs = Date.parse(latest.timestamp);
    const age = nowMs - timestampMs;
    if (age < 0 || age > maximumAgeMs) fail("R42_AUTH_FRESH", "authorization is outside the 2h capability window or future-dated", { age_ms: age });
    const previous = parsed.rows.filter((row) => row.end <= latest.start).at(-1);
    return deepFreeze({
      text,
      coordinate: coordinateFor(raw, parsed, latest, text),
      previous_boundary: {
        prefix_bytes: latest.start,
        prefix_sha256: sha256(raw.subarray(0, latest.start)),
        latest_line: previous?.line ?? 1,
        timestamp: previous?.timestamp ?? parsed.header.timestamp,
      },
    });
  }
  return Object.freeze({
    binding,
    boundary() {
      const { raw, parsed } = readCurrent();
      const last = parsed.rows.at(-1);
      return deepFreeze({ prefix_bytes: raw.length, prefix_sha256: sha256(raw), latest_line: last?.line ?? 1, timestamp: last?.timestamp ?? parsed.header.timestamp });
    },
    latestUserCandidate({ maximumAgeMs = 7_200_000, nowMs = Date.now() } = {}) {
      return latestCandidate(maximumAgeMs, nowMs);
    },
    verifyRecorded({ coordinate: coordinateInput, exactText }) {
      const expected = validateTrustedCoordinate(coordinateInput);
      const { raw, parsed } = readCurrent();
      const row = parsed.active.find((item) => item.role === "user" && item.id === expected.message_id && item.line === expected.message_line_number);
      if (!row) fail("R42_AUTH_RECORDED", "recorded coordinate is absent from the current active branch");
      const text = exactSingleText(row.content);
      if (text !== exactText) fail("R42_AUTH_RECORDED", "recorded coordinate text differs");
      const rebuilt = coordinateFor(raw, parsed, row, text);
      if (canonicalizeJcs(rebuilt) !== canonicalizeJcs(expected)) fail("R42_AUTH_RECORDED", "recorded coordinate fields/hash differ from retained transcript");
      return rebuilt;
    },
    verifyLatestExact({ exactText, maximumAgeMs = 7_200_000, nowMs = Date.now(), requiredAfter = null }) {
      const candidate = latestCandidate(maximumAgeMs, nowMs);
      const latest = candidate.coordinate;
      if (candidate.text !== exactText || latest.text_sha256 !== sha256(exactText)) fail("R42_AUTH_EXACT", "latest user message is not the exact phrase");
      const timestampMs = Date.parse(latest.timestamp);
      if (requiredAfter && (latest.message_line_number <= requiredAfter.line || timestampMs <= Date.parse(requiredAfter.timestamp) || latest.transcript_prefix_bytes <= requiredAfter.prefix_bytes)) fail("R42_AUTH_LATER", "authorization does not postdate required boundary");
      return latest;
    },
    close() { if (!closed) { closed = true; fs.closeSync(fd); } },
  });
}

export function initialPhrase(fields) {
  return `确认执行 ADR0040 D3-v2 session_start R4.2 S2 v2 transform；static_contract_hash=${assertHash(fields.static_contract_hash)}；source_commit=${assertGitCommit(fields.source_commit)}；target_session_id=${assertSafeSessionId(fields.target_session_id)}；preview_transcript_prefix_sha256=${assertHash(fields.preview_transcript_prefix_sha256)}；仅授权该 static contract 定义的 v2 transform；锁内 non-v2 settings 仅按 RFC8785-JCS 语义 carry-forward，其原始字节未由人审阅。`;
}

export function continuePhrase(fields) {
  return `确认继续 ADR0040 D3-v2 session_start R4.2 S2 operation；op_id=${assertHash(fields.operation_id)}；static_contract_hash=${assertHash(fields.static_contract_hash)}；source_commit=${assertGitCommit(fields.source_commit)}；仅授权从该 persisted tuple 恢复 exact A→B direct completion。`;
}

export function recoveryPhrase(fields) {
  const mode = fields.mode;
  if (mode !== "direct" && mode !== "ambient_state_adoption") fail("R42_RECOVERY_MODE", "receipt recovery mode differs");
  const prefix = mode === "direct" ? "确认恢复 ADR0040 D3-v2 session_start R4.2 direct receipt pending" : "确认恢复 ADR0040 D3-v2 session_start R4.2 ambient_state_adoption receipt pending";
  const suffix = mode === "direct"
    ? "仅授权对该exact receipt pending residue可选先unlink与pending same-inode/same-bytes的redundant non-authority temp，再执行link_final与unlink_pending幂等收敛步骤，不授权改写receipt、completion authorization、post witness、settings、I或V，也不授权其它operation、receipt、path、inode、mode或action。"
    : "仅授权对该exact receipt pending residue可选先unlink与pending same-inode/same-bytes的redundant non-authority temp，再执行link_final与unlink_pending幂等收敛步骤，不授权改写receipt、completion authorization、post witness、settings、I或V，也不授权采纳新状态或其它operation、receipt、path、inode、mode、action。";
  return `${prefix}；op_id=${assertHash(fields.operation_id)}；receipt_hash=${assertHash(fields.receipt_hash)}；pending_path=${assertAbsolutePath(fields.pending_path)}；pending_dev=${assertSafeInteger(fields.pending_dev, "pending_dev")}；pending_ino=${assertSafeInteger(fields.pending_ino, "pending_ino")}；mode=${mode}；static_contract_hash=${assertHash(fields.static_contract_hash)}；commit_token=${assertHash(fields.commit_token)}；target_session_id=${assertSafeSessionId(fields.target_session_id)}；source_commit=${assertGitCommit(fields.source_commit)}；action=converge_receipt_pending_to_terminal；${suffix}`;
}

export function buildAdoptionAuthorizationFields({ intent: intentInput, staticContract, currentCRawSha256, currentCNonV2JcsHash, activationAbsent }) {
  const intent = validateIntentAgainstStatic(intentInput, staticContract);
  const tuple = intent.operation_tuple;
  const inputs = buildActivationHashInputs({ intent, staticContract });
  const activation = buildActivation({ intent, staticContract });
  if (typeof activationAbsent !== "boolean") fail("R42_ADOPTION_BOOLEAN", "activationAbsent must be boolean");
  return deepFreeze({
    operation_id: intent.operation_id,
    intent_hash: intent.intent_hash,
    static_contract_hash: tuple.static_contract_hash,
    commit_token: tuple.commit_token,
    current_C_raw_sha256: assertHash(currentCRawSha256, "current_C_raw_sha256"),
    current_C_non_v2_jcs_hash: assertHash(currentCNonV2JcsHash, "current_C_non_v2_jcs_hash"),
    target_session_id: tuple.target_session_binding.session_id,
    source_commit: tuple.source_commit,
    activation_absent: activationAbsent,
    activation_nonce: inputs.activation_nonce,
    initial_coordinate_hash: tuple.initial_coordinate_hash,
    adapter_manifest_hash: tuple.adapter_manifest_hash,
    operator_manifest_hash: tuple.operator_manifest_hash,
    source_manifest_hash: tuple.source_manifest_hash,
    source_closure_hash: tuple.source_closure_hash,
    d3_identities_hash: inputs.d3_identities_hash,
    target_session_binding_hash: inputs.target_session_binding_hash,
    authorization_transcript_binding_hash: inputs.authorization_transcript_binding_hash,
    desired_v2_subtree_hash: inputs.desired_v2_subtree_hash,
    expected_B_raw_sha256: tuple.expected_B_raw_sha256,
    audit_target: inputs.audit_target,
    rollback_target: inputs.rollback_target,
    quarantine_target: inputs.quarantine_target,
    activation_hash_inputs_hash: jcsSha256(inputs),
    expected_activation_object_hash: activation.activation_object_hash,
  });
}

export function adoptionPhrase(fields) {
  const activationAbsent = fields.activation_absent === true ? "true" : fields.activation_absent === false ? "false" : fail("R42_ADOPTION_BOOLEAN", "activation_absent must be boolean");
  return `确认采纳 ADR0040 D3-v2 session_start R4.2 ambient_state_adoption；op_id=${assertHash(fields.operation_id)}；intent_hash=${assertHash(fields.intent_hash)}；static_contract_hash=${assertHash(fields.static_contract_hash)}；commit_token=${assertHash(fields.commit_token)}；current_C_raw_sha256=${assertHash(fields.current_C_raw_sha256)}；current_C_non_v2_jcs_hash=${assertHash(fields.current_C_non_v2_jcs_hash)}；target_session_id=${assertSafeSessionId(fields.target_session_id)}；source_commit=${assertGitCommit(fields.source_commit)}；activation_absent=${activationAbsent}；activation_nonce=${assertHash(fields.activation_nonce)}；initial_coordinate_hash=${assertHash(fields.initial_coordinate_hash)}；adapter_manifest_hash=${assertHash(fields.adapter_manifest_hash)}；operator_manifest_hash=${assertHash(fields.operator_manifest_hash)}；source_manifest_hash=${assertHash(fields.source_manifest_hash)}；source_closure_hash=${assertHash(fields.source_closure_hash)}；d3_identities_hash=${assertHash(fields.d3_identities_hash)}；target_session_binding_hash=${assertHash(fields.target_session_binding_hash)}；authorization_transcript_binding_hash=${assertHash(fields.authorization_transcript_binding_hash)}；desired_v2_subtree_hash=${assertHash(fields.desired_v2_subtree_hash)}；expected_B_raw_sha256=${assertHash(fields.expected_B_raw_sha256)}；audit_target=${assertAbsolutePath(fields.audit_target)}；rollback_target=${assertAbsolutePath(fields.rollback_target)}；quarantine_target=${assertAbsolutePath(fields.quarantine_target)}；activation_hash_inputs_hash=${assertHash(fields.activation_hash_inputs_hash)}；expected_activation_object_hash=${assertHash(fields.expected_activation_object_hash)}；CAS A→B历史未获证明，授权采纳当前exact v2/token状态；若activation_absent=true，仅授权B0从canonical I与static contract确定性渲染并以R4.2 staged primitive发布该expected exact V；若唯一existing exact V/p或V+V/p，仅授权B收敛同一expected V inode/bytes；两者完成后都必须完整重验且稳定才可进入A；不授权收敛I/p、改写既存V、改变receipt mode或写settings。`;
}

export function stagedTempDispositionPhrase(fields) {
  return `确认处置 ADR0040 D3-v2 session_start R4.2 staged temp；op_id=${assertHash(fields.operation_id)}；static_contract_hash=${assertHash(fields.static_contract_hash)}；source_commit=${assertGitCommit(fields.source_commit)}；target_session_id=${assertSafeSessionId(fields.target_session_id)}；control_inventory_hash=${assertHash(fields.control_inventory_hash)}；temp_kind=${fields.temp_kind}；temp_path=${assertAbsolutePath(fields.temp_path)}；temp_dev=${assertSafeInteger(fields.temp_dev, "temp_dev")}；temp_ino=${assertSafeInteger(fields.temp_ino, "temp_ino")}；temp_raw_sha256_or_unreadable_reason=${fields.temp_raw_sha256_or_unreadable_reason}；temp_size=${assertSafeInteger(fields.temp_size, "temp_size")}；temp_mode=${assertSafeInteger(fields.temp_mode, "temp_mode")}；temp_uid=${assertSafeInteger(fields.temp_uid, "temp_uid")}；temp_gid=${assertSafeInteger(fields.temp_gid, "temp_gid")}；temp_nlink=${assertSafeInteger(fields.temp_nlink, "temp_nlink")}；pending_relation=${fields.pending_relation}；final_relation=${fields.final_relation}；action=unlink_nonauthority_temp；仅授权删除该exact path/dev/ino绑定的non-authority temp并fsync其parent，不授权删除pending/final、推进operation、消费initial/adoption coordinate、写settings或执行其它action。`;
}

export function runtimeAuditIdempotencyKey(fields) {
  return sha256(Buffer.concat([
    Buffer.from("adr0040-d3-v2-session-start-r4.2-runtime-audit-idempotency/v1\0"),
    Buffer.from(assertHash(fields.operation_id), "ascii"), Buffer.from([0]),
    Buffer.from(assertHash(fields.receipt_hash), "ascii"), Buffer.from([0]),
    Buffer.from(assertHash(fields.activation_object_hash), "ascii"), Buffer.from([0]),
    Buffer.from(assertHash(fields.static_contract_hash), "ascii"), Buffer.from([0]),
    Buffer.from(assertHash(fields.commit_token), "ascii"), Buffer.from([0]),
    Buffer.from(assertSafeSessionId(fields.target_session_id), "utf8"), Buffer.from([0]),
    Buffer.from("allow_first_injection", "ascii"),
  ]));
}

export function buildRuntimeAuditObject(fields) {
  const base = {
    schema_version: SCHEMAS.runtime_audit_object,
    revision: REVISION,
    idempotency_key: assertHash(fields.idempotency_key),
    operation_id: assertHash(fields.operation_id),
    receipt_hash: assertHash(fields.receipt_hash),
    activation_object_hash: assertHash(fields.activation_object_hash),
    static_contract_hash: assertHash(fields.static_contract_hash),
    commit_token: assertHash(fields.commit_token),
    target_session_id: assertSafeSessionId(fields.target_session_id),
    injection_decision: "allow_first_injection",
  };
  return addSelfHash(base, "audit_object_hash");
}

export function validateRuntimeAuditObject(value) {
  const object = exactKeys(value, ["schema_version", "revision", "idempotency_key", "operation_id", "receipt_hash", "activation_object_hash", "static_contract_hash", "commit_token", "target_session_id", "injection_decision", "audit_object_hash"], "runtime_audit_object");
  if (object.schema_version !== SCHEMAS.runtime_audit_object || object.revision !== REVISION || object.injection_decision !== "allow_first_injection") fail("R42_RUNTIME_AUDIT_SCHEMA", "runtime audit object identity differs");
  for (const field of ["idempotency_key", "operation_id", "receipt_hash", "activation_object_hash", "static_contract_hash", "commit_token", "audit_object_hash"]) assertHash(object[field], `runtime audit.${field}`);
  assertSafeSessionId(object.target_session_id);
  validateSelfHash(object, "audit_object_hash", "runtime_audit_object");
  return object;
}

export function runtimeEnablePhrase(fields) {
  if (!NONCE32.test(fields.attempt_id)) fail("R42_ATTEMPT_ID", "attempt_id must be runtime-generated 128-bit lowercase hex");
  return `确认启用 ADR0040 D3-v2 session_start R4.2 runtime authority audit gate；attempt_id=${fields.attempt_id}；op_id=${assertHash(fields.operation_id)}；receipt_hash=${assertHash(fields.receipt_hash)}；activation_object_hash=${assertHash(fields.activation_object_hash)}；static_contract_hash=${assertHash(fields.static_contract_hash)}；commit_token=${assertHash(fields.commit_token)}；target_session_id=${assertSafeSessionId(fields.target_session_id)}；source_commit=${assertGitCommit(fields.source_commit)}；idempotency_key=${assertHash(fields.idempotency_key)}；final_path=${assertAbsolutePath(fields.final_path)}；audit_object_hash=${assertHash(fields.audit_object_hash)}；action=durably_materialize_or_confirm_runtime_audit_then_allow_one_first_injection；仅授权为该exact terminal receipt和该runtime-generated attempt完成per-receipt immutable audit object的staging/convergence或对existing exact object执行fdatasync、parent fsync与strict readback，并仅在完整全序成功后允许该runtime invocation的一次first-injection decision；不授权修改control/settings/session、创建第二audit object、持久化attempt或改变injection内容。`;
}

export function runtimeAuditTempDispositionPhrase(fields) {
  return `确认处置 ADR0040 D3-v2 session_start R4.2 runtime audit temp；idempotency_key=${assertHash(fields.idempotency_key)}；temp_path=${assertAbsolutePath(fields.temp_path)}；temp_dev=${assertSafeInteger(fields.temp_dev, "temp_dev")}；temp_ino=${assertSafeInteger(fields.temp_ino, "temp_ino")}；temp_raw_sha256_or_unreadable_reason=${fields.temp_raw_sha256_or_unreadable_reason}；temp_size=${assertSafeInteger(fields.temp_size, "temp_size")}；temp_mode=${assertSafeInteger(fields.temp_mode, "temp_mode")}；temp_uid=${assertSafeInteger(fields.temp_uid, "temp_uid")}；temp_gid=${assertSafeInteger(fields.temp_gid, "temp_gid")}；temp_nlink=${assertSafeInteger(fields.temp_nlink, "temp_nlink")}；final_relation=${fields.final_relation}；static_contract_hash=${assertHash(fields.static_contract_hash)}；receipt_hash=${assertHash(fields.receipt_hash)}；source_commit=${assertGitCommit(fields.source_commit)}；target_session_id=${assertSafeSessionId(fields.target_session_id)}；action=unlink_runtime_audit_temp；仅授权删除该exact non-authority runtime audit temp并fsync audit root，不授权删除或改写final audit object、写control/settings/session或执行injection。`;
}

export function buildAuthorizationContract({ schema_version, kind, phraseTemplate, requiredLaterThan, idempotentScope, authorizationSession }) {
  const allowedKinds = ["initial_execute", "fresh_continue", "direct_receipt_pending_convergence", "ambient_state_adoption", "ambient_state_adoption_pending_convergence", "staged_temp_disposition", "runtime_enable_audit", "runtime_audit_temp_disposition"];
  if (!allowedKinds.includes(kind)) fail("R42_AUTH_CONTRACT_KIND", "authorization contract kind differs");
  const base = {
    schema_version,
    revision: REVISION,
    kind,
    required_phrase_template: phraseTemplate,
    maximum_age_ms: 7_200_000,
    required_standalone_role: "user",
    required_later_than: [...requiredLaterThan],
    fresh_required_at_write: true,
    latest_required_at_write: true,
    per_mutating_syscall_reverify: true,
    per_mutating_syscall_source_guard: true,
    retained_transcript_fd_required: true,
    idempotent_scope: idempotentScope,
    bound_authorization_session: cloneJson(authorizationSession),
    caller_channels_forbidden: ["cli", "environment", "file", "stdin", "json_payload", "raw_text_argument"],
  };
  return addSelfHash(base, "contract_hash");
}

export function noConcreteSourceOid(value, label) {
  walkJson(value, (child) => {
    if (typeof child === "string" && GIT_COMMIT.test(child)) fail("R42_STATIC_SOURCE_OID", `${label} contains a concrete 40hex source OID`);
  });
}
