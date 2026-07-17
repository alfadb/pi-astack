import * as fs from "node:fs/promises";
import * as path from "node:path";
import { sha256Hex } from "./jcs";
import {
  PROPOSITION_P1B_FIXED_QUOTE_SHA256,
  PROPOSITION_P1B_FIXED_STATEMENT,
} from "./proposition-evidence-writer";

export const PROPOSITION_P1B_SESSION_ROOT = "/home/worker/.pi/agent/sessions" as const;
export const PROPOSITION_P1B_SESSION_ID = "019f569c-40d3-73f0-9a5f-666b395f6b9a" as const;
export const PROPOSITION_P1B_SESSION_RELATIVE_PATH = "--home-worker-.pi--/2026-07-12T13-55-08-627Z_019f569c-40d3-73f0-9a5f-666b395f6b9a.jsonl" as const;
export const PROPOSITION_P1B_SESSION_JSONL_PATH = `${PROPOSITION_P1B_SESSION_ROOT}/${PROPOSITION_P1B_SESSION_RELATIVE_PATH}` as const;
export const PROPOSITION_P1B_ATTESTATION_MESSAGE_ID = "e5b235e8" as const;
export const PROPOSITION_P1B_ATTESTATION_PARENT_ID = "9c56c7f4" as const;
export const PROPOSITION_P1B_ATTESTATION_LINE = 145 as const;
export const PROPOSITION_P1B_ATTESTATION_TIMESTAMP = "2026-07-13T09:49:06.627Z" as const;
export const PROPOSITION_P1B_FULL_ATTESTATION_TEXT = "我确认以下内容是我的持久架构主张：统一真相源、不同消费投影是第一要务。" as const;
export const PROPOSITION_P1B_FULL_ATTESTATION_TEXT_SHA256 = "1634963e1472039c00d260957afa05eb9f8b9d35f969ace6cead73fb1657b087" as const;
export const PROPOSITION_P1B_ATTESTATION_PREFIX_BYTES = 1697806 as const;
export const PROPOSITION_P1B_ATTESTATION_PREFIX_SHA256 = "d5b78fd92274c8dd0f7737d3ccc45072cafea95a758b16137fa694274e8ab7dd" as const;

export interface TranscriptMessageBinding {
  session_jsonl_path: string;
  session_jsonl_relative_path: string;
  session_id: string;
  message_id: string;
  message_parent_id: string | null;
  message_line_number: number;
  timestamp: string;
  role: "user";
  text_sha256: string;
  transcript_prefix_bytes: number;
  transcript_prefix_sha256: string;
}

export interface VerifiedTranscriptUserMessage extends TranscriptMessageBinding {
  text: string;
}

interface JsonlLine {
  line_number: number;
  text: string;
  end_including_newline: number;
}

export class PropositionP1bTranscriptError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "PropositionP1bTranscriptError";
    this.code = code;
    this.detail = detail ? Object.freeze(detail) : undefined;
  }
}

export async function verifyFixedP1bAttestation(): Promise<Readonly<Record<string, unknown>>> {
  const found = await verifyTrustedCurrentSessionUserMessage({
    session_jsonl_path: PROPOSITION_P1B_SESSION_JSONL_PATH,
    session_jsonl_relative_path: PROPOSITION_P1B_SESSION_RELATIVE_PATH,
    session_id: PROPOSITION_P1B_SESSION_ID,
    message_id: PROPOSITION_P1B_ATTESTATION_MESSAGE_ID,
    message_parent_id: PROPOSITION_P1B_ATTESTATION_PARENT_ID,
    message_line_number: PROPOSITION_P1B_ATTESTATION_LINE,
    timestamp: PROPOSITION_P1B_ATTESTATION_TIMESTAMP,
    role: "user",
    text_sha256: PROPOSITION_P1B_FULL_ATTESTATION_TEXT_SHA256,
    transcript_prefix_bytes: PROPOSITION_P1B_ATTESTATION_PREFIX_BYTES,
    transcript_prefix_sha256: PROPOSITION_P1B_ATTESTATION_PREFIX_SHA256,
  }, { requireFreshAfterAttestation: false });
  if (found.text !== PROPOSITION_P1B_FULL_ATTESTATION_TEXT) {
    throw failure("PROPOSITION_P1B_ATTESTATION_TEXT_MISMATCH", "trusted transcript does not contain the exact full attestation text");
  }
  if (!found.text.endsWith(PROPOSITION_P1B_FIXED_STATEMENT)) {
    throw failure("PROPOSITION_P1B_ATTESTATION_QUOTE_MISMATCH", "full attestation does not end with the frozen proposition statement");
  }
  if (sha256Hex(PROPOSITION_P1B_FIXED_STATEMENT) !== PROPOSITION_P1B_FIXED_QUOTE_SHA256) {
    throw failure("PROPOSITION_P1B_ATTESTATION_QUOTE_MISMATCH", "frozen statement quote SHA-256 is invalid");
  }
  const { text: _text, ...binding } = found;
  return deepFreeze({
    ...binding,
    exact_full_attestation_text: found.text,
    exact_full_attestation_text_sha256: PROPOSITION_P1B_FULL_ATTESTATION_TEXT_SHA256,
    quote_text: PROPOSITION_P1B_FIXED_STATEMENT,
    quote_sha256: PROPOSITION_P1B_FIXED_QUOTE_SHA256,
    source_event_id_policy: "null_transcript_id_is_trigger_ref_only",
  });
}

export async function verifyTrustedCurrentSessionUserMessage(
  binding: TranscriptMessageBinding,
  options: { requireFreshAfterAttestation: boolean },
): Promise<VerifiedTranscriptUserMessage> {
  assertExactBindingKeys(binding);
  const sessionPath = await assertTrustedCurrentSessionPath(binding.session_jsonl_path, binding.session_jsonl_relative_path);
  if (binding.session_id !== PROPOSITION_P1B_SESSION_ID) throw failure("PROPOSITION_P1B_TRANSCRIPT_SESSION_MISMATCH", "ratification session id is not the current trusted session");
  if (binding.role !== "user") throw failure("PROPOSITION_P1B_TRANSCRIPT_ROLE_MISMATCH", "ratification target role must be user");
  if (!Number.isSafeInteger(binding.message_line_number) || binding.message_line_number <= 1) throw failure("PROPOSITION_P1B_TRANSCRIPT_LINE_INVALID", "ratification message line must be a positive line after the header");
  if (!Number.isSafeInteger(binding.transcript_prefix_bytes) || binding.transcript_prefix_bytes <= 0) throw failure("PROPOSITION_P1B_TRANSCRIPT_PREFIX_INVALID", "transcript prefix byte length is invalid");
  assertSha(binding.text_sha256, "text_sha256");
  assertSha(binding.transcript_prefix_sha256, "transcript_prefix_sha256");

  const raw = await fs.readFile(sessionPath);
  const lines = splitJsonl(raw);
  let headerCount = 0;
  let headerSessionId: string | null = null;
  let previousId: string | null = null;
  let found: VerifiedTranscriptUserMessage | null = null;
  const seen = new Set<string>();

  for (const line of lines) {
    let value: unknown;
    try {
      value = JSON.parse(line.text);
    } catch (err) {
      throw failure("PROPOSITION_P1B_TRANSCRIPT_JSON_INVALID", "trusted session JSONL contains invalid JSON", { line: line.line_number, error: errorMessage(err) });
    }
    if (!isRecord(value)) throw failure("PROPOSITION_P1B_TRANSCRIPT_JSON_INVALID", "trusted session JSONL line is not an object", { line: line.line_number });
    if (value.type === "session") {
      headerCount += 1;
      if (line.line_number !== 1 || headerCount !== 1) throw failure("PROPOSITION_P1B_TRANSCRIPT_HEADER_INVALID", "trusted session must contain one first-line session header");
      const id = nonEmpty(value.id, "session.id");
      if (seen.has(id)) throw failure("PROPOSITION_P1B_TRANSCRIPT_DUPLICATE_ID", "trusted session contains a duplicate id", { id });
      seen.add(id);
      headerSessionId = id;
      continue;
    }
    if (headerSessionId === null) throw failure("PROPOSITION_P1B_TRANSCRIPT_HEADER_INVALID", "trusted session header is missing");
    const id = nonEmpty(value.id, `line ${line.line_number} id`);
    if (seen.has(id)) throw failure("PROPOSITION_P1B_TRANSCRIPT_DUPLICATE_ID", "trusted session contains a duplicate id", { id, line: line.line_number });
    seen.add(id);
    const parentId = value.parentId === null ? null : nonEmpty(value.parentId, `line ${line.line_number} parentId`);
    if (parentId !== previousId) {
      throw failure("PROPOSITION_P1B_TRANSCRIPT_PARENT_CHAIN_BROKEN", "trusted session parent chain is not continuous", { line: line.line_number, expected: previousId, actual: parentId });
    }
    previousId = id;
    if (id !== binding.message_id) continue;
    if (line.line_number !== binding.message_line_number || parentId !== binding.message_parent_id || value.timestamp !== binding.timestamp) {
      throw failure("PROPOSITION_P1B_TRANSCRIPT_TARGET_MISMATCH", "ratification target id does not match its bound line, parent, or timestamp", { line: line.line_number, parentId, timestamp: value.timestamp });
    }
    const message = record(value.message, "PROPOSITION_P1B_TRANSCRIPT_TARGET_MISMATCH", "target entry has no message object");
    if (message.role !== "user") throw failure("PROPOSITION_P1B_TRANSCRIPT_ROLE_MISMATCH", "ratification target is not a user message");
    const text = exactTextContent(message.content);
    const prefix = raw.subarray(0, line.end_including_newline);
    if (prefix.length !== binding.transcript_prefix_bytes || sha256Hex(prefix) !== binding.transcript_prefix_sha256) {
      throw failure("PROPOSITION_P1B_TRANSCRIPT_PREFIX_MISMATCH", "ratification transcript prefix bytes do not match", { actualBytes: prefix.length, actualSha256: sha256Hex(prefix) });
    }
    if (sha256Hex(text) !== binding.text_sha256) throw failure("PROPOSITION_P1B_TRANSCRIPT_TEXT_HASH_MISMATCH", "ratification user text hash does not match");
    found = deepFreeze({ ...binding, session_jsonl_path: sessionPath, text });
  }
  if (headerCount !== 1 || headerSessionId !== binding.session_id) throw failure("PROPOSITION_P1B_TRANSCRIPT_SESSION_MISMATCH", "session header id does not match the binding");
  if (!found) throw failure("PROPOSITION_P1B_TRANSCRIPT_TARGET_NOT_FOUND", "bound ratification user message was not found exactly once");
  if (options.requireFreshAfterAttestation) {
    if (found.message_line_number <= PROPOSITION_P1B_ATTESTATION_LINE || Date.parse(found.timestamp) <= Date.parse(PROPOSITION_P1B_ATTESTATION_TIMESTAMP)) {
      throw failure("PROPOSITION_P1B_RATIFICATION_NOT_FRESH", "production ratification must be later than the proposition attestation and preview binding");
    }
  }
  return found;
}

async function assertTrustedCurrentSessionPath(input: string, relativeInput: string): Promise<string> {
  if (input !== PROPOSITION_P1B_SESSION_JSONL_PATH || relativeInput !== PROPOSITION_P1B_SESSION_RELATIVE_PATH || !path.isAbsolute(input)) {
    throw failure("PROPOSITION_P1B_TRANSCRIPT_PATH_MISMATCH", "ratification must bind the exact trusted current session JSONL", { input, relativeInput });
  }
  const rootReal = await fs.realpath(PROPOSITION_P1B_SESSION_ROOT);
  const expected = path.resolve(rootReal, ...PROPOSITION_P1B_SESSION_RELATIVE_PATH.split("/"));
  if (expected !== input) throw failure("PROPOSITION_P1B_TRANSCRIPT_PATH_MISMATCH", "trusted current session path is not canonical");
  let current = rootReal;
  for (const part of PROPOSITION_P1B_SESSION_RELATIVE_PATH.split("/").slice(0, -1)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure("PROPOSITION_P1B_TRANSCRIPT_PATH_UNSAFE", "trusted session directory chain contains a symlink or non-directory", { path: current });
  }
  const stat = await fs.lstat(expected);
  if (stat.isSymbolicLink() || !stat.isFile()) throw failure("PROPOSITION_P1B_TRANSCRIPT_PATH_UNSAFE", "trusted current session JSONL is not a regular file");
  if (await fs.realpath(expected) !== expected) throw failure("PROPOSITION_P1B_TRANSCRIPT_PATH_UNSAFE", "trusted current session JSONL realpath drifted");
  return expected;
}

function splitJsonl(raw: Buffer): JsonlLine[] {
  const lines: JsonlLine[] = [];
  let start = 0;
  let lineNumber = 1;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== 0x0a) continue;
    const end = index > start && raw[index - 1] === 0x0d ? index - 1 : index;
    const text = raw.subarray(start, end).toString("utf-8");
    if (!text.trim()) throw failure("PROPOSITION_P1B_TRANSCRIPT_JSON_INVALID", "trusted session contains a blank JSONL line", { line: lineNumber });
    lines.push({ line_number: lineNumber, text, end_including_newline: index + 1 });
    start = index + 1;
    lineNumber += 1;
  }
  if (start < raw.length) {
    const text = raw.subarray(start).toString("utf-8");
    if (!text.trim()) throw failure("PROPOSITION_P1B_TRANSCRIPT_JSON_INVALID", "trusted session contains a blank trailing JSONL line", { line: lineNumber });
    lines.push({ line_number: lineNumber, text, end_including_newline: raw.length });
  }
  return lines;
}

function exactTextContent(input: unknown): string {
  if (!Array.isArray(input) || input.length !== 1 || !isRecord(input[0]) || input[0].type !== "text" || typeof input[0].text !== "string") {
    throw failure("PROPOSITION_P1B_TRANSCRIPT_TARGET_MISMATCH", "target user message must contain exactly one text content part");
  }
  return input[0].text;
}

function assertExactBindingKeys(binding: TranscriptMessageBinding): void {
  const expected = [
    "session_jsonl_path", "session_jsonl_relative_path", "session_id", "message_id", "message_parent_id",
    "message_line_number", "timestamp", "role", "text_sha256", "transcript_prefix_bytes", "transcript_prefix_sha256",
  ].sort();
  const actual = Object.keys(binding).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw failure("PROPOSITION_P1B_TRANSCRIPT_BINDING_INVALID", "transcript message binding has unexpected keys", { actual, expected });
}

function assertSha(value: unknown, at: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw failure("PROPOSITION_P1B_TRANSCRIPT_BINDING_INVALID", `${at} must be lowercase SHA-256`);
  return value;
}

function record(value: unknown, code: string, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw failure(code, message);
  return value;
}

function nonEmpty(value: unknown, at: string): string {
  if (typeof value !== "string" || !value) throw failure("PROPOSITION_P1B_TRANSCRIPT_JSON_INVALID", `${at} must be a non-empty string`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function failure(code: string, message: string, detail?: Record<string, unknown>): PropositionP1bTranscriptError {
  return new PropositionP1bTranscriptError(code, message, detail);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
