/// <reference types="node" />
import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalizeJcs, jcsSha256Hex, sha256Hex } from "./jcs";
import { parseJsonRejectDuplicateKeys } from "./strict-json";

export const TRUSTED_SESSION_COORDINATE_SCHEMA = "trusted-persisted-session-user-coordinate/v1" as const;
const KNOWN_ENTRY_TYPES = new Set([
  "message", "model_change", "thinking_level_change", "compaction", "branch_summary",
  "custom", "custom_message", "label", "session_info",
]);

export interface TrustedSessionUserCoordinate extends Record<string, unknown> {
  schema_version: typeof TRUSTED_SESSION_COORDINATE_SCHEMA;
  session_jsonl_path: string;
  session_id: string;
  session_dev: number;
  session_ino: number;
  message_id: string;
  message_parent_id: string | null;
  message_line_number: number;
  timestamp: string;
  role: "user";
  text_utf8_bytes: number;
  text_sha256: string;
  transcript_prefix_bytes: number;
  transcript_prefix_sha256: string;
  active_parent_chain_hash: string;
  continuous_parent_chain_verified: true;
  latest_role_user_message_verified: true;
  standalone_single_text_part_verified: true;
  fresh_verified: true;
  caller_supplied_raw_text: false;
  coordinate_hash: string;
}

interface ParsedRow {
  type: string;
  id: string;
  parentId: string | null;
  line: number;
  end: number;
  timestamp: string | null;
  role: string | null;
  content: unknown;
}

interface ParsedTrustedSession {
  raw: Buffer;
  sessionId: string;
  dev: number;
  ino: number;
  rows: readonly ParsedRow[];
  activeRows: readonly ParsedRow[];
}

export class TrustedSessionTranscriptError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "TrustedSessionTranscriptError";
    this.code = code;
    this.detail = detail ? Object.freeze({ ...detail }) : undefined;
  }
}

export function verifyFreshLatestStandaloneUserAuthorization(args: {
  sessionsRoot: string;
  sessionPath: string;
  expectedSessionId: string;
  exactText: string;
  maximumAgeMs: number;
  nowMs?: number;
  requiredAfter?: { line: number; timestamp: string } | null;
  maxBytes?: number;
}): TrustedSessionUserCoordinate {
  const parsed = readTrustedPersistedSession(args);
  const latest = parsed.activeRows.filter((row) => row.role === "user").at(-1);
  if (!latest) fail("TRUSTED_TRANSCRIPT_USER_REQUIRED", "active session branch has no role=user message");
  const text = exactSingleText(latest.content);
  if (text !== args.exactText || Buffer.byteLength(text) !== Buffer.byteLength(args.exactText)
    || sha256Hex(text) !== sha256Hex(args.exactText)) {
    fail("TRUSTED_TRANSCRIPT_EXACT_TEXT", "latest role=user message is not the exact standalone authorization", {
      expected_sha256: sha256Hex(args.exactText),
      actual_sha256: sha256Hex(text),
    });
  }
  const timestampMs = Date.parse(requireNonempty(latest.timestamp, "authorization timestamp"));
  const now = args.nowMs ?? Date.now();
  const age = now - timestampMs;
  if (!Number.isFinite(timestampMs) || age < -5 * 60 * 1000 || age > args.maximumAgeMs) {
    fail("TRUSTED_TRANSCRIPT_FRESHNESS", "latest role=user authorization is not fresh", {
      timestamp: latest.timestamp, age_ms: age, maximum_age_ms: args.maximumAgeMs,
    });
  }
  if (args.requiredAfter) {
    const priorMs = Date.parse(args.requiredAfter.timestamp);
    if (!Number.isFinite(priorMs) || latest.line <= args.requiredAfter.line || timestampMs <= priorMs) {
      fail("TRUSTED_TRANSCRIPT_NOT_AFTER", "authorization is not after the required earlier coordinate");
    }
  }
  return buildCoordinate(parsed, path.resolve(args.sessionPath), latest, text);
}

export function verifyRecordedTrustedSessionCoordinate(args: {
  sessionsRoot: string;
  sessionPath: string;
  expectedSessionId: string;
  coordinate: unknown;
  exactText: string;
  maxBytes?: number;
}): TrustedSessionUserCoordinate {
  const coordinate = validateTrustedSessionUserCoordinate(args.coordinate);
  const parsed = readTrustedPersistedSession(args);
  const target = parsed.activeRows.find((row) => row.id === coordinate.message_id);
  if (!target || target.role !== "user") fail("TRUSTED_TRANSCRIPT_RECORDED_MISSING", "recorded role=user coordinate is absent from the active branch");
  const text = exactSingleText(target.content);
  const rebuilt = buildCoordinate(parsed, path.resolve(args.sessionPath), target, text, false);
  const historical = (value: TrustedSessionUserCoordinate): Record<string, unknown> => {
    const copy = { ...value } as Record<string, unknown>;
    delete copy.coordinate_hash;
    delete copy.latest_role_user_message_verified;
    delete copy.fresh_verified;
    return copy;
  };
  if (text !== args.exactText || canonicalizeJcs(historical(rebuilt)) !== canonicalizeJcs(historical(coordinate))) {
    fail("TRUSTED_TRANSCRIPT_RECORDED_MISMATCH", "recorded transcript coordinate, prefix, chain, or exact text differs");
  }
  return coordinate;
}

export function captureTrustedSessionPrefixBinding(args: {
  sessionsRoot: string;
  sessionPath: string;
  expectedSessionId: string;
  prefixBytes?: number;
  maxBytes?: number;
}): Readonly<{ path: string; dev: number; ino: number; prefix_bytes: number; prefix_sha256: string }> {
  const parsed = readTrustedPersistedSession(args);
  const prefixBytes = args.prefixBytes ?? parsed.raw.length;
  if (!Number.isSafeInteger(prefixBytes) || prefixBytes < 1 || prefixBytes > parsed.raw.length) {
    fail("TRUSTED_TRANSCRIPT_PREFIX", "requested session prefix is outside the trusted file");
  }
  return Object.freeze({
    path: path.resolve(args.sessionPath),
    dev: parsed.dev,
    ino: parsed.ino,
    prefix_bytes: prefixBytes,
    prefix_sha256: sha256Hex(parsed.raw.subarray(0, prefixBytes)),
  });
}

export function validateTrustedSessionUserCoordinate(value: unknown): TrustedSessionUserCoordinate {
  const row = asRecord(value, "trusted transcript coordinate") as unknown as TrustedSessionUserCoordinate;
  const expected = [
    "schema_version", "session_jsonl_path", "session_id", "session_dev", "session_ino",
    "message_id", "message_parent_id", "message_line_number", "timestamp", "role",
    "text_utf8_bytes", "text_sha256", "transcript_prefix_bytes", "transcript_prefix_sha256",
    "active_parent_chain_hash", "continuous_parent_chain_verified", "latest_role_user_message_verified",
    "standalone_single_text_part_verified", "fresh_verified", "caller_supplied_raw_text", "coordinate_hash",
  ];
  exactKeys(row, expected, "trusted transcript coordinate");
  if (row.schema_version !== TRUSTED_SESSION_COORDINATE_SCHEMA || row.role !== "user"
    || row.continuous_parent_chain_verified !== true || row.latest_role_user_message_verified !== true
    || row.standalone_single_text_part_verified !== true || row.fresh_verified !== true
    || row.caller_supplied_raw_text !== false || !path.isAbsolute(row.session_jsonl_path)
    || path.resolve(row.session_jsonl_path) !== row.session_jsonl_path) {
    fail("TRUSTED_TRANSCRIPT_COORDINATE", "trusted transcript coordinate flags or path differ");
  }
  for (const field of ["session_id", "message_id", "timestamp"] as const) requireNonempty(row[field], field);
  if (row.message_parent_id !== null && (typeof row.message_parent_id !== "string" || !row.message_parent_id)) {
    fail("TRUSTED_TRANSCRIPT_COORDINATE", "message_parent_id must be null or non-empty");
  }
  if (!Number.isFinite(Date.parse(row.timestamp))) fail("TRUSTED_TRANSCRIPT_COORDINATE", "timestamp is invalid");
  for (const field of ["text_sha256", "transcript_prefix_sha256", "active_parent_chain_hash", "coordinate_hash"] as const) assertHash(row[field], field);
  for (const field of ["session_dev", "session_ino", "message_line_number", "text_utf8_bytes", "transcript_prefix_bytes"] as const) {
    if (!Number.isSafeInteger(row[field]) || Number(row[field]) < 1) fail("TRUSTED_TRANSCRIPT_COORDINATE", `${field} is invalid`);
  }
  const base = { ...row } as Record<string, unknown>;
  delete base.coordinate_hash;
  if (row.coordinate_hash !== jcsSha256Hex(base)) fail("TRUSTED_TRANSCRIPT_COORDINATE", "coordinate self-hash differs");
  return deepFreeze(row);
}

function readTrustedPersistedSession(args: {
  sessionsRoot: string;
  sessionPath: string;
  expectedSessionId: string;
  maxBytes?: number;
}): ParsedTrustedSession {
  const root = path.resolve(args.sessionsRoot);
  const sessionPath = path.resolve(args.sessionPath);
  assertNoSymlinkDirectoryTree(root);
  const rootReal = fs.realpathSync.native(root);
  if (rootReal !== root || !inside(root, sessionPath) || !path.basename(sessionPath).includes(args.expectedSessionId)) {
    fail("TRUSTED_TRANSCRIPT_PATH", "session path is outside the exact trusted sessions root or filename does not bind session_id");
  }
  assertNoSymlinkAncestors(sessionPath);
  const named = fs.lstatSync(sessionPath);
  if (named.isSymbolicLink() || !named.isFile() || fs.realpathSync.native(sessionPath) !== sessionPath) {
    fail("TRUSTED_TRANSCRIPT_PATH", "session JSONL is not an exact regular file");
  }
  const maxBytes = args.maxBytes ?? 64 * 1024 * 1024;
  if (named.size > maxBytes) fail("TRUSTED_TRANSCRIPT_OVERSIZE", "session JSONL exceeds bounded maximum", { size: named.size, maxBytes });
  const fd = fs.openSync(sessionPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    const raw = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    const namedAfter = fs.lstatSync(sessionPath);
    if (!sameIdentity(before, after) || !sameIdentity(after, namedAfter) || raw.length !== before.size) {
      fail("TRUSTED_TRANSCRIPT_RACE", "session JSONL changed while reading");
    }
    return parseTrustedSession(raw, args.expectedSessionId, before.dev, before.ino);
  } finally { fs.closeSync(fd); }
}

function parseTrustedSession(raw: Buffer, expectedSessionId: string, dev: number, ino: number): ParsedTrustedSession {
  const lines = splitJsonl(raw);
  if (lines.length === 0) fail("TRUSTED_TRANSCRIPT_EMPTY", "session JSONL is empty");
  let sessionId: string | null = null;
  const rows: ParsedRow[] = [];
  const byId = new Map<string, ParsedRow>();
  const seen = new Set<string>();
  for (const line of lines) {
    let value: Record<string, unknown>;
    try { value = asRecord(parseJsonRejectDuplicateKeys(line.raw), `transcript line ${line.line}`); }
    catch (error) { fail("TRUSTED_TRANSCRIPT_JSON", "session JSONL contains invalid or duplicate-key JSON", { line: line.line, error: message(error) }); }
    if (value.type === "session") {
      if (line.line !== 1 || sessionId !== null || typeof value.id !== "string" || !value.id) fail("TRUSTED_TRANSCRIPT_HEADER", "session header is invalid");
      sessionId = value.id;
      seen.add(value.id);
      continue;
    }
    if (typeof value.type !== "string" || !KNOWN_ENTRY_TYPES.has(value.type)) {
      fail("TRUSTED_TRANSCRIPT_ENTRY_TYPE", "session JSONL contains an unknown entry type", { line: line.line, type: value.type });
    }
    const id = requireNonempty(value.id, `line ${line.line} id`);
    if (seen.has(id)) fail("TRUSTED_TRANSCRIPT_DUPLICATE_ID", "session JSONL contains a duplicate entry id", { id, line: line.line });
    const parentId = value.parentId === null ? null : requireNonempty(value.parentId, `line ${line.line} parentId`);
    if (parentId !== null && !seen.has(parentId)) fail("TRUSTED_TRANSCRIPT_CHAIN", "entry parent does not name an earlier entry", { line: line.line, parentId });
    const messageValue = value.type === "message" ? asRecord(value.message, `line ${line.line} message`) : null;
    const role = messageValue && typeof messageValue.role === "string" ? messageValue.role : null;
    const row: ParsedRow = {
      type: value.type, id, parentId, line: line.line, end: line.end,
      timestamp: typeof value.timestamp === "string" ? value.timestamp : null,
      role, content: messageValue?.content,
    };
    seen.add(id);
    rows.push(row);
    byId.set(id, row);
  }
  if (sessionId !== expectedSessionId) fail("TRUSTED_TRANSCRIPT_SESSION", "session header id differs", { expectedSessionId, sessionId });
  if (rows.filter((row) => row.parentId === null).length !== 1) fail("TRUSTED_TRANSCRIPT_TREE", "session tree must have exactly one root entry");
  const leaf = rows.at(-1);
  if (!leaf) fail("TRUSTED_TRANSCRIPT_EMPTY", "session JSONL has no entries after its header");
  const reversed: ParsedRow[] = [];
  let cursor: ParsedRow | undefined = leaf;
  while (cursor) {
    reversed.push(cursor);
    if (cursor.parentId === null) break;
    cursor = byId.get(cursor.parentId);
    if (!cursor) fail("TRUSTED_TRANSCRIPT_CHAIN", "active parent chain is broken");
  }
  return deepFreeze({ raw, sessionId, dev, ino, rows, activeRows: reversed.reverse() });
}

function buildCoordinate(parsed: ParsedTrustedSession, sessionPath: string, target: ParsedRow, text: string, current = true): TrustedSessionUserCoordinate {
  const activeUsers = parsed.activeRows.filter((row) => row.role === "user");
  if (current && activeUsers.at(-1)?.id !== target.id) fail("TRUSTED_TRANSCRIPT_NOT_LATEST", "authorization is not the latest active role=user message");
  const base = {
    schema_version: TRUSTED_SESSION_COORDINATE_SCHEMA,
    session_jsonl_path: sessionPath,
    session_id: parsed.sessionId,
    session_dev: parsed.dev,
    session_ino: parsed.ino,
    message_id: target.id,
    message_parent_id: target.parentId,
    message_line_number: target.line,
    timestamp: requireNonempty(target.timestamp, "authorization timestamp"),
    role: "user" as const,
    text_utf8_bytes: Buffer.byteLength(text),
    text_sha256: sha256Hex(text),
    transcript_prefix_bytes: target.end,
    transcript_prefix_sha256: sha256Hex(parsed.raw.subarray(0, target.end)),
    active_parent_chain_hash: jcsSha256Hex(parsed.activeRows.filter((row) => row.line <= target.line).map((row) => ({ id: row.id, parent_id: row.parentId, line: row.line }))),
    continuous_parent_chain_verified: true as const,
    latest_role_user_message_verified: true as const,
    standalone_single_text_part_verified: true as const,
    fresh_verified: true as const,
    caller_supplied_raw_text: false as const,
  };
  return validateTrustedSessionUserCoordinate({ ...base, coordinate_hash: jcsSha256Hex(base) });
}

function exactSingleText(content: unknown): string {
  if (!Array.isArray(content) || content.length !== 1 || !content[0] || typeof content[0] !== "object" || Array.isArray(content[0])) {
    fail("TRUSTED_TRANSCRIPT_STANDALONE", "authorization message must contain exactly one text part");
  }
  const part = content[0] as Record<string, unknown>;
  if (part.type !== "text" || typeof part.text !== "string" || Object.keys(part).some((key) => key !== "type" && key !== "text")) {
    fail("TRUSTED_TRANSCRIPT_STANDALONE", "authorization message must be one closed text part");
  }
  return part.text;
}

function splitJsonl(raw: Buffer): Array<{ line: number; raw: Buffer; end: number }> {
  const output: Array<{ line: number; raw: Buffer; end: number }> = [];
  let start = 0;
  let line = 1;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== 0x0a) continue;
    if (index === start || (index === start + 1 && raw[start] === 0x0d)) fail("TRUSTED_TRANSCRIPT_JSON", "session JSONL contains a blank row", { line });
    const end = index > start && raw[index - 1] === 0x0d ? index - 1 : index;
    output.push({ line, raw: raw.subarray(start, end), end: index + 1 });
    start = index + 1;
    line += 1;
  }
  if (start < raw.length) output.push({ line, raw: raw.subarray(start), end: raw.length });
  return output;
}

function assertNoSymlinkDirectoryTree(directory: string): void {
  let current = path.parse(directory).root;
  for (const component of path.relative(current, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("TRUSTED_TRANSCRIPT_PATH", "trusted sessions root has a symlink or non-directory ancestor", { current });
  }
}
function assertNoSymlinkAncestors(file: string): void {
  let current = path.parse(file).root;
  for (const component of path.relative(current, path.dirname(file)).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("TRUSTED_TRANSCRIPT_PATH", "session path has a symlink or non-directory ancestor", { current });
  }
}
function sameIdentity(left: fs.Stats, right: fs.Stats): boolean { return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs; }
function inside(parent: string, child: string): boolean { const relative = path.relative(parent, child); return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void { const actual = Object.keys(value).sort(); const wanted = [...expected].sort(); if (canonicalizeJcs(actual) !== canonicalizeJcs(wanted)) fail("TRUSTED_TRANSCRIPT_COORDINATE", `${label} keys differ`, { actual, expected: wanted }); }
function asRecord(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) fail("TRUSTED_TRANSCRIPT_JSON", `${label} must be an object`); return value as Record<string, unknown>; }
function requireNonempty(value: unknown, label: string): string { if (typeof value !== "string" || !value) fail("TRUSTED_TRANSCRIPT_JSON", `${label} must be non-empty`); return value; }
function assertHash(value: unknown, label: string): asserts value is string { if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) fail("TRUSTED_TRANSCRIPT_COORDINATE", `${label} must be lowercase SHA-256`); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function fail(code: string, text: string, detail?: Record<string, unknown>): never { throw new TrustedSessionTranscriptError(code, text, detail); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !ArrayBuffer.isView(value) && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }
