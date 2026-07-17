/// <reference types="node" />
import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalizeJcs, jcsSha256Hex, sha256Hex } from "./jcs";

export const D3_PUB_GRANT_PHRASE = "确认发布当前 ADR0040 D3-PUB 冻结 dossier。" as const;
export const D3_PUB_TRANSCRIPT_AUTHORIZATION_SCHEMA = "adr0040-d3-pub-transcript-ratification/v1" as const;
export const D3_PUB_SESSION_ROOT = "/home/worker/.pi/agent/sessions" as const;

const HASH = /^[0-9a-f]{64}$/;
const DOSSIER_MARKER = "ADR0040_D3_PUB_DOSSIER";
const REVOCATION = /^(撤销|停止|不要执行|取消)/u;

export interface D3PubDossierIdentity {
  session_id: string;
  dossier_relative_path: string;
  dossier_raw_sha256: string;
  dossier_self_hash: string;
}

export interface D3PubAuthorizationCoordinate extends Record<string, unknown> {
  schema_version: typeof D3_PUB_TRANSCRIPT_AUTHORIZATION_SCHEMA;
  session_id: string;
  dossier_assistant_message_id: string;
  dossier_assistant_parent_id: string | null;
  dossier_assistant_turn_ordinal: number;
  dossier_assistant_native_turn_id: string | number | null;
  dossier_assistant_raw_sha256: string;
  dossier_raw_sha256: string;
  dossier_self_hash: string;
  grant_user_message_id: string;
  grant_user_parent_id: string | null;
  grant_user_turn_ordinal: number;
  grant_user_native_turn_id: string | number | null;
  grant_user_raw_sha256: string;
  grant_text_sha256: string;
  transcript_prefix_bytes: number;
  transcript_prefix_hash: string;
  message_parent_chain_hash: string;
  latest_user_grant_verified: boolean;
  dossier_is_immediately_preceding_latest_valid_verified: boolean;
  standalone_natural_language_verified: boolean;
  explicit_revocation_absent: boolean;
  coordinate_hash: string;
}

interface ParsedRow {
  type: string;
  id: string;
  parent_id: string | null;
  role: string | null;
  text: string | null;
  line: number;
  end: number;
  turn_ordinal: number | null;
  native_turn_id: string | number | null;
  raw_line: Buffer;
}

interface ParsedTranscript {
  raw: Buffer;
  session_id: string;
  all_rows: readonly ParsedRow[];
  rows: readonly ParsedRow[];
  messages: readonly ParsedRow[];
  active_leaf_id: string;
}

export class D3PubTranscriptError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "D3PubTranscriptError";
    this.code = code;
    this.detail = detail ? deepFreeze(detail) : undefined;
  }
}

export function dossierTranscriptMarker(identity: D3PubDossierIdentity): string {
  validateDossierIdentity(identity);
  return `${DOSSIER_MARKER} path=${identity.dossier_relative_path} raw_sha256=${identity.dossier_raw_sha256} self_hash=${identity.dossier_self_hash}`;
}

export function inspectTrustedD3PubSession(options: {
  sessionPath: string;
  expectedSessionId: string;
}): Readonly<Record<string, unknown>> {
  const parsed = readTrustedTranscript(options.sessionPath, options.expectedSessionId);
  return deepFreeze({
    schema_version: "adr0040-d3-pub-session-parser-smoke/v1",
    session_id: parsed.session_id,
    entry_count: parsed.all_rows.length,
    active_branch_entry_count: parsed.rows.length,
    active_leaf_id: parsed.active_leaf_id,
    active_leaf_type: parsed.rows.at(-1)!.type,
    parsed: true,
  });
}

export function verifyFreshD3PubRatification(options: {
  sessionPath: string;
  dossier: D3PubDossierIdentity;
}): D3PubAuthorizationCoordinate {
  const parsed = readTrustedTranscript(options.sessionPath, options.dossier.session_id);
  return verifyFreshParsed(parsed, options.dossier);
}

export function verifyRecordedD3PubRatification(options: {
  sessionPath: string;
  dossier: D3PubDossierIdentity;
  recorded: unknown;
}): D3PubAuthorizationCoordinate {
  const parsed = readTrustedTranscript(options.sessionPath, options.dossier.session_id);
  const recorded = asRecord(options.recorded, "recorded authorization coordinate") as D3PubAuthorizationCoordinate;
  validateCoordinate(recorded);
  if (recorded.session_id !== options.dossier.session_id
    || recorded.dossier_raw_sha256 !== options.dossier.dossier_raw_sha256
    || recorded.dossier_self_hash !== options.dossier.dossier_self_hash) {
    fail("D3_PUB_RECORDED_AUTHORIZATION_MISMATCH", "recorded authorization is bound to another dossier");
  }
  const dossier = parsed.messages.find((row) => row.id === recorded.dossier_assistant_message_id);
  const grant = parsed.messages.find((row) => row.id === recorded.grant_user_message_id);
  if (!dossier || !grant || dossier.role !== "assistant" || grant.role !== "user" || dossier.line >= grant.line) {
    fail("D3_PUB_RECORDED_AUTHORIZATION_MISSING", "recorded dossier or grant coordinate is absent");
  }
  const rebuilt = buildCoordinate(parsed, dossier, grant, options.dossier, false);
  if (canonicalizeJcs(coordinateHistoricalFields(rebuilt)) !== canonicalizeJcs(coordinateHistoricalFields(recorded))) {
    fail("D3_PUB_RECORDED_AUTHORIZATION_MISMATCH", "recorded transcript bytes, turn coordinates, prefix, or parent chain differ");
  }
  for (const row of parsed.messages) {
    if (row.line <= grant.line || row.role !== "user" || row.text === null) continue;
    if (REVOCATION.test(row.text.trim())) fail("D3_PUB_AUTHORIZATION_REVOKED", "a later explicit user revocation blocks recovery", { message_id: row.id });
  }
  return deepFreeze(recorded);
}

export function verifySyntheticD3PubRatification(options: {
  transcriptRaw: string | Buffer;
  dossier: D3PubDossierIdentity;
  recorded?: unknown;
}): D3PubAuthorizationCoordinate {
  const raw = Buffer.isBuffer(options.transcriptRaw) ? options.transcriptRaw : Buffer.from(options.transcriptRaw);
  const parsed = parseTranscript(raw, options.dossier.session_id);
  if (options.recorded !== undefined) {
    const recorded = asRecord(options.recorded, "synthetic recorded coordinate") as D3PubAuthorizationCoordinate;
    validateCoordinate(recorded);
    const dossier = parsed.messages.find((row) => row.id === recorded.dossier_assistant_message_id);
    const grant = parsed.messages.find((row) => row.id === recorded.grant_user_message_id);
    if (!dossier || !grant) fail("D3_PUB_RECORDED_AUTHORIZATION_MISSING", "synthetic recorded coordinate is absent");
    const rebuilt = buildCoordinate(parsed, dossier, grant, options.dossier, false);
    if (canonicalizeJcs(coordinateHistoricalFields(rebuilt)) !== canonicalizeJcs(coordinateHistoricalFields(recorded))) fail("D3_PUB_RECORDED_AUTHORIZATION_MISMATCH", "synthetic recorded coordinate differs");
    for (const row of parsed.messages) if (row.line > grant.line && row.role === "user" && row.text && REVOCATION.test(row.text.trim())) fail("D3_PUB_AUTHORIZATION_REVOKED", "synthetic authorization was revoked");
    return deepFreeze(recorded);
  }
  return verifyFreshParsed(parsed, options.dossier);
}

export function buildSyntheticD3PubTranscript(options: {
  dossier: D3PubDossierIdentity;
  grantText?: string;
  extraRows?: readonly Readonly<Record<string, unknown>>[];
}): string {
  validateDossierIdentity(options.dossier);
  const rows: Record<string, unknown>[] = [
    { type: "session", version: 3, id: options.dossier.session_id, timestamp: "2030-01-01T00:00:00.000Z" },
    { type: "message", id: "dossier-assistant", parentId: null, timestamp: "2030-01-01T00:00:01.000Z", turn_id: 7, message: { role: "assistant", content: [{ type: "text", text: dossierTranscriptMarker(options.dossier) }] } },
    { type: "message", id: "grant-user", parentId: "dossier-assistant", timestamp: "2030-01-01T00:00:02.000Z", turn_id: 8, message: { role: "user", content: [{ type: "text", text: options.grantText ?? D3_PUB_GRANT_PHRASE }] } },
    ...(options.extraRows ?? []),
  ];
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function verifyFreshParsed(parsed: ParsedTranscript, identity: D3PubDossierIdentity): D3PubAuthorizationCoordinate {
  validateDossierIdentity(identity);
  const users = parsed.messages.filter((row) => row.role === "user");
  const grant = users.at(-1);
  if (!grant || grant.text !== D3_PUB_GRANT_PHRASE) {
    if (grant?.text && REVOCATION.test(grant.text.trim())) fail("D3_PUB_AUTHORIZATION_REVOKED", "latest user message explicitly revokes publication", { message_id: grant.id });
    fail("D3_PUB_FRESH_RATIFICATION_REQUIRED", "latest user message must be the standalone D3-PUB grant phrase");
  }
  const preceding = parsed.messages.filter((row) => row.line < grant.line && row.role === "assistant");
  const dossier = preceding.at(-1);
  if (!dossier || dossier.text === null) fail("D3_PUB_DOSSIER_MESSAGE_REQUIRED", "grant has no immediately preceding assistant dossier message");
  const laterDossier = parsed.messages.find((row) => row.line > grant.line && row.role === "assistant" && row.text?.includes(DOSSIER_MARKER));
  if (laterDossier) fail("D3_PUB_AUTHORIZATION_STALE_AFTER_DOSSIER", "a dossier assistant message after the grant makes the undurable authorization stale", { message_id: laterDossier.id });
  const marker = dossierTranscriptMarker(identity);
  if (dossier.text.split(marker).length !== 2) fail("D3_PUB_DOSSIER_MESSAGE_MISMATCH", "immediately preceding assistant message does not uniquely bind the frozen dossier");
  const validCandidates = preceding.filter((row) => row.text?.includes(marker));
  if (validCandidates.length !== 1 || validCandidates[0]!.id !== dossier.id) fail("D3_PUB_DOSSIER_MESSAGE_AMBIGUOUS", "dossier message is not the latest unique valid assistant binding");
  return buildCoordinate(parsed, dossier, grant, identity, true);
}

function buildCoordinate(parsed: ParsedTranscript, dossier: ParsedRow, grant: ParsedRow, identity: D3PubDossierIdentity, latest: boolean): D3PubAuthorizationCoordinate {
  if (grant.text !== D3_PUB_GRANT_PHRASE || grant.turn_ordinal === null || dossier.turn_ordinal === null) fail("D3_PUB_AUTHORIZATION_COORDINATE_INVALID", "dossier/grant role or turn coordinate differs");
  const base = {
    schema_version: D3_PUB_TRANSCRIPT_AUTHORIZATION_SCHEMA,
    session_id: parsed.session_id,
    dossier_assistant_message_id: dossier.id,
    dossier_assistant_parent_id: dossier.parent_id,
    dossier_assistant_turn_ordinal: dossier.turn_ordinal,
    dossier_assistant_native_turn_id: dossier.native_turn_id,
    dossier_assistant_raw_sha256: sha256Hex(dossier.raw_line),
    dossier_raw_sha256: identity.dossier_raw_sha256,
    dossier_self_hash: identity.dossier_self_hash,
    grant_user_message_id: grant.id,
    grant_user_parent_id: grant.parent_id,
    grant_user_turn_ordinal: grant.turn_ordinal,
    grant_user_native_turn_id: grant.native_turn_id,
    grant_user_raw_sha256: sha256Hex(grant.raw_line),
    grant_text_sha256: sha256Hex(grant.text),
    transcript_prefix_bytes: grant.end,
    transcript_prefix_hash: sha256Hex(parsed.raw.subarray(0, grant.end)),
    message_parent_chain_hash: jcsSha256Hex(parsed.rows.filter((row) => row.line <= grant.line).map((row) => ({ id: row.id, parent_id: row.parent_id, line: row.line }))),
    latest_user_grant_verified: latest,
    dossier_is_immediately_preceding_latest_valid_verified: true,
    standalone_natural_language_verified: true,
    explicit_revocation_absent: true,
  };
  const coordinate = deepFreeze({ ...base, coordinate_hash: jcsSha256Hex(base) });
  validateCoordinate(coordinate);
  return coordinate;
}

function readTrustedTranscript(sessionPathInput: string, expectedSessionId: string): ParsedTranscript {
  const sessionPath = path.resolve(sessionPathInput);
  const root = fs.realpathSync.native(D3_PUB_SESSION_ROOT);
  if (root !== D3_PUB_SESSION_ROOT || !inside(root, sessionPath) || !path.basename(sessionPath).includes(expectedSessionId)) fail("D3_PUB_TRANSCRIPT_PATH_INVALID", "session path is outside the trusted session root or does not bind session_id");
  assertNoSymlinkAncestors(sessionPath);
  const named = fs.lstatSync(sessionPath);
  if (named.isSymbolicLink() || !named.isFile() || fs.realpathSync.native(sessionPath) !== sessionPath) fail("D3_PUB_TRANSCRIPT_PATH_UNSAFE", "session JSONL is not an exact regular file");
  const fd = fs.openSync(sessionPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    const raw = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    const namedAfter = fs.lstatSync(sessionPath);
    if (!sameIdentity(before, after) || !sameIdentity(after, namedAfter) || raw.length !== before.size) fail("D3_PUB_TRANSCRIPT_RACE", "session JSONL changed while read");
    return parseTranscript(raw, expectedSessionId);
  } finally { fs.closeSync(fd); }
}

function parseTranscript(raw: Buffer, expectedSessionId: string): ParsedTranscript {
  const lines = splitJsonl(raw);
  if (lines.length === 0) fail("D3_PUB_TRANSCRIPT_EMPTY", "session transcript is empty");
  let sessionId: string | null = null;
  const seen = new Set<string>();
  const byId = new Map<string, ParsedRow>();
  const allRows: ParsedRow[] = [];
  const knownTypes = new Set(["message", "model_change", "thinking_level_change", "compaction", "branch_summary", "custom", "custom_message", "label", "session_info"]);
  for (const line of lines) {
    let value: Record<string, unknown>;
    try { value = asRecord(JSON.parse(line.raw.toString("utf8")), `transcript line ${line.line}`); }
    catch (error) { fail("D3_PUB_TRANSCRIPT_JSON_INVALID", "session transcript contains invalid JSON", { line: line.line, error: errorMessage(error) }); }
    if (value.type === "session") {
      if (line.line !== 1 || sessionId !== null || typeof value.id !== "string" || !value.id) fail("D3_PUB_TRANSCRIPT_HEADER_INVALID", "session header differs");
      sessionId = value.id;
      continue;
    }
    if (typeof value.type !== "string" || !knownTypes.has(value.type)) fail("D3_PUB_TRANSCRIPT_ENTRY_TYPE_INVALID", "session transcript contains an unknown entry type", { line: line.line, type: value.type });
    const id = nonempty(value.id, `line ${line.line} id`);
    if (seen.has(id)) fail("D3_PUB_TRANSCRIPT_DUPLICATE_ID", "session transcript contains a duplicate entry ID", { id });
    const parentId = value.parentId === null ? null : nonempty(value.parentId, `line ${line.line} parentId`);
    if (parentId !== null && !seen.has(parentId)) fail("D3_PUB_TRANSCRIPT_PARENT_MISSING", "entry parent must name an earlier tree entry", { line: line.line, id, parent_id: parentId });
    const message = value.type === "message" && isRecord(value.message) ? value.message : null;
    if (value.type === "message" && !message) fail("D3_PUB_TRANSCRIPT_MESSAGE_INVALID", "message entry lacks a message object", { line: line.line });
    const role = message && typeof message.role === "string" ? message.role : null;
    const text = role === "assistant" || role === "user" ? visibleText(message!.content) : null;
    const native = nativeTurnId(value, message);
    const row: ParsedRow = { type: value.type, id, parent_id: parentId, role, text, line: line.line, end: line.end, turn_ordinal: null, native_turn_id: native, raw_line: line.raw };
    seen.add(id);
    byId.set(id, row);
    allRows.push(row);
  }
  if (sessionId !== expectedSessionId) fail("D3_PUB_TRANSCRIPT_SESSION_MISMATCH", "session header ID differs", { expectedSessionId, sessionId });
  if (allRows.filter((row) => row.parent_id === null).length !== 1) fail("D3_PUB_TRANSCRIPT_TREE_INVALID", "session tree must have exactly one root entry");
  const leaf = allRows.at(-1);
  if (!leaf) fail("D3_PUB_TRANSCRIPT_EMPTY", "session transcript has no tree entries");
  const reversed: ParsedRow[] = [];
  let cursor: ParsedRow | undefined = leaf;
  while (cursor) {
    reversed.push(cursor);
    if (cursor.parent_id === null) break;
    cursor = byId.get(cursor.parent_id);
    if (!cursor) fail("D3_PUB_TRANSCRIPT_PARENT_MISSING", "active leaf parent chain is broken");
  }
  const activeBase = reversed.reverse();
  let turnOrdinal = 0;
  const rows = activeBase.map((row) => {
    if (row.role !== "assistant" && row.role !== "user") return row;
    turnOrdinal += 1;
    return { ...row, turn_ordinal: turnOrdinal };
  });
  const messages = rows.filter((row) => row.role !== null);
  return deepFreeze({ raw, session_id: sessionId, all_rows: allRows, rows, messages, active_leaf_id: leaf.id });
}

function coordinateHistoricalFields(value: D3PubAuthorizationCoordinate): Record<string, unknown> {
  const fields = { ...value } as Record<string, unknown>;
  delete fields.coordinate_hash;
  delete fields.latest_user_grant_verified;
  return fields;
}

function validateCoordinate(value: D3PubAuthorizationCoordinate): void {
  const base = { ...value } as Record<string, unknown>; delete base.coordinate_hash;
  if (value.schema_version !== D3_PUB_TRANSCRIPT_AUTHORIZATION_SCHEMA || value.coordinate_hash !== jcsSha256Hex(base)) fail("D3_PUB_AUTHORIZATION_COORDINATE_INVALID", "authorization coordinate identity differs");
  for (const field of ["dossier_assistant_raw_sha256", "dossier_raw_sha256", "dossier_self_hash", "grant_user_raw_sha256", "grant_text_sha256", "transcript_prefix_hash", "message_parent_chain_hash", "coordinate_hash"] as const) assertHash(value[field], field);
  if (value.grant_text_sha256 !== sha256Hex(D3_PUB_GRANT_PHRASE) || value.dossier_is_immediately_preceding_latest_valid_verified !== true || value.standalone_natural_language_verified !== true || value.explicit_revocation_absent !== true) fail("D3_PUB_AUTHORIZATION_COORDINATE_INVALID", "authorization semantic flags differ");
}

function validateDossierIdentity(value: D3PubDossierIdentity): void {
  if (!value || typeof value.session_id !== "string" || !value.session_id || typeof value.dossier_relative_path !== "string" || !value.dossier_relative_path || path.isAbsolute(value.dossier_relative_path) || value.dossier_relative_path.split("/").includes("..")) fail("D3_PUB_DOSSIER_IDENTITY_INVALID", "dossier identity path/session differs");
  assertHash(value.dossier_raw_sha256, "dossier raw SHA-256"); assertHash(value.dossier_self_hash, "dossier self hash");
}

function visibleText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const part of content) if (isRecord(part) && part.type === "text" && typeof part.text === "string") texts.push(part.text);
  return texts.length === 0 ? null : texts.join("\n");
}

function nativeTurnId(row: Record<string, unknown>, message: Record<string, unknown> | null): string | number | null {
  const candidates = [row.turn_id, row.turnId, message?.turn_id, message?.turnId];
  const found = candidates.filter((value) => typeof value === "string" || Number.isSafeInteger(value));
  if (found.length === 0) return null;
  if (found.some((value) => value !== found[0])) fail("D3_PUB_TRANSCRIPT_TURN_ID_INVALID", "native turn ID fields disagree");
  return found[0] as string | number;
}

function splitJsonl(raw: Buffer): Array<{ line: number; raw: Buffer; end: number }> {
  const output: Array<{ line: number; raw: Buffer; end: number }> = [];
  let start = 0; let line = 1;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== 0x0a) continue;
    const end = index > start && raw[index - 1] === 0x0d ? index - 1 : index;
    if (end === start) fail("D3_PUB_TRANSCRIPT_JSON_INVALID", "session transcript contains a blank row", { line });
    output.push({ line, raw: raw.subarray(start, end), end: index + 1 });
    start = index + 1; line += 1;
  }
  if (start < raw.length) output.push({ line, raw: raw.subarray(start), end: raw.length });
  return output;
}

function assertNoSymlinkAncestors(file: string): void {
  let current = path.parse(file).root;
  for (const component of path.relative(current, path.dirname(file)).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("D3_PUB_TRANSCRIPT_PATH_UNSAFE", "session ancestor is a symlink or non-directory", { current });
  }
}
function sameIdentity(left: fs.Stats, right: fs.Stats): boolean { return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs; }
function inside(parent: string, child: string): boolean { const relative = path.relative(parent, child); return relative !== "" && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
function assertHash(value: unknown, label: string): asserts value is string { if (typeof value !== "string" || !HASH.test(value)) fail("D3_PUB_HASH_INVALID", `${label} must be lowercase SHA-256`); }
function nonempty(value: unknown, label: string): string { if (typeof value !== "string" || !value) fail("D3_PUB_TRANSCRIPT_JSON_INVALID", `${label} must be non-empty`); return value; }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function asRecord(value: unknown, label: string): Record<string, unknown> { if (!isRecord(value)) fail("D3_PUB_TRANSCRIPT_JSON_INVALID", `${label} must be an object`); return value; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function fail(code: string, message: string, detail?: Record<string, unknown>): never { throw new D3PubTranscriptError(code, message, detail); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && ArrayBuffer.isView(value)) return value; if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }
