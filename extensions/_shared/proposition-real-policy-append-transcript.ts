import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalizeJcs, jcsSha256Hex, sha256Hex } from "./jcs";

export const REAL_POLICY_APPEND_STAGE2_SESSION_ROOT = "/home/worker/.pi/agent/sessions" as const;
export const REAL_POLICY_APPEND_STAGE2_SESSION_ID = "019f569c-40d3-73f0-9a5f-666b395f6b9a" as const;
export const REAL_POLICY_APPEND_STAGE2_SESSION_RELATIVE = "--home-worker-.pi--/2026-07-12T13-55-08-627Z_019f569c-40d3-73f0-9a5f-666b395f6b9a.jsonl" as const;
export const REAL_POLICY_APPEND_STAGE2_SESSION_PATH = `${REAL_POLICY_APPEND_STAGE2_SESSION_ROOT}/${REAL_POLICY_APPEND_STAGE2_SESSION_RELATIVE}` as const;
export const REAL_POLICY_APPEND_STAGE2_MESSAGE_ID = "d1d44f44" as const;
export const REAL_POLICY_APPEND_STAGE2_PARENT_ID = "1bbb77fc" as const;
export const REAL_POLICY_APPEND_STAGE2_LINE = 457 as const;
export const REAL_POLICY_APPEND_STAGE2_TIMESTAMP = "2026-07-15T07:20:56.318Z" as const;
export const REAL_POLICY_APPEND_STAGE2_TEXT_BYTES = 5272 as const;
export const REAL_POLICY_APPEND_STAGE2_TEXT_SHA256 = "20c69a2684298d675fd3b6eeb53adeecaa380fd75139e1503e45255e91fa0c4d" as const;
export const REAL_POLICY_APPEND_STAGE2_PREFIX_BYTES = 6767698 as const;
export const REAL_POLICY_APPEND_STAGE2_PREFIX_SHA256 = "20ae9d8f258720f805a1b0550615180a645df716c87cfadddb603b3da84fbfaf" as const;
export const REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_HEADER = "ADR0040_REAL_POLICY_PROPOSITION_APPEND_STAGE3_AUTHORIZATION_V2" as const;
export const REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_SPEC_SCHEMA = "adr0040-real-policy-proposition-append-stage3-authorization-spec/v2" as const;
export const REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_CONTRACT_SCHEMA = "adr0040-real-policy-proposition-append-stage3-authorization-contract/v2" as const;
export const REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_RENDERER = "ASCII fixed header + LF + RFC8785-JCS(spec), no terminal LF/v2" as const;
export const REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_RENDERER_DEFINITION = `${REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_HEADER}\n<RFC8785-JCS(spec)>`;
export const REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_REQUIRED_SPEC_FIELDS = Object.freeze([
  "stage2_dossier",
  "complete_source_closure",
  "execution_closure_proofs",
  "fixed_tuple",
  "repo_evidence_paths",
  "abrain_mutation_inventory",
  "downstream_non_authority",
] as const);

export const REAL_POLICY_APPEND_RECOVERY_HUMAN_AUTHORIZATION_PHRASE = "确认执行当前 ADR0040 S2 恢复并完成到 S4。" as const;
export const REAL_POLICY_APPEND_RECOVERY_HUMAN_AUTHORIZATION_CONTRACT_SCHEMA = "adr0040-real-policy-proposition-append-s2-recovery-human-authorization-contract/v1" as const;
export const REAL_POLICY_APPEND_RECOVERY_HUMAN_AUTHORIZATION_MAXIMUM_AGE_MS = 2 * 60 * 60 * 1000;

const REQUIRED_BINDINGS = Object.freeze([
  "06a2915ecf88022e861295f9e844ae96b2ea3543b544e44ebe7426ac54d609a5",
  "1505659abc5a6ea56aa5c45bb5140b6ed8433a24e9d7410d34c0411042019478",
  "08cd956a1ba382c239ecd447159e510e8597a0d7cb6a0fd9dd4a2d4de7b347d9",
  "c6a1d9ae759b282b110ae55a9c6bc0fc65bf63c4d172ca62c20d1a3cc4b34ec1",
  "b53bc2692fc65f478301597756217a097bb2b2627a74c4c3ef5cd82ef1684a76",
  "f6f258c404b57703bc9e04e7aa34a61e5c22f37501a31b0ee97fba488b211f68",
  "861a1c5754c3445600feaf5aae2cceb4e63026c79e6b30ac6dec2979bd07b436",
  "b0cd7f17efb87bd3c3584999fce0e3ab464dd6e4ebce79e7db26f7e6c1b9e252",
  "fefb55b8db4be2bcb3a43916f20c6a452426d11a3ea2172d5498763fc2cfff3a",
  "d0b3e21a4af4cdb77b575d1272b08f5a72257fe31b27ef89a51b84bf24d352e1",
  "cde660f5517e650067b723a012ab642fcfb28a12a0c0ef7c24e722754be36088",
  "871dc9ad2efa44a68c5f94ad6dc9e64f6790ae957b6162d5b476d9f411b7cbb2",
  "5fc2566a879c26237a690bed16de7eb7a5585b89cf0efb76b3a7fafb6a67a6cf",
  "f7d8e0023477cd3ed218d34980725b5ff275132b47990f7e30982ef06f6a42dd",
  "8294bdb432e881de244470c5b14cafa8662bf08064ecefc192ea7e269186b91e",
  "e085a35d254db258b5fcd7ace9b1c981d1eff06c367956f23ab2fef5ba53699d",
  "021486e9f6b4662091192fe38f3d79a82da92d683c8349542c0a3259718cb68b",
]);

export interface VerifiedRealPolicyAppendStage2Authorization {
  session_jsonl_path: typeof REAL_POLICY_APPEND_STAGE2_SESSION_PATH;
  session_jsonl_relative_path: typeof REAL_POLICY_APPEND_STAGE2_SESSION_RELATIVE;
  session_id: typeof REAL_POLICY_APPEND_STAGE2_SESSION_ID;
  message_id: typeof REAL_POLICY_APPEND_STAGE2_MESSAGE_ID;
  message_parent_id: typeof REAL_POLICY_APPEND_STAGE2_PARENT_ID;
  message_line_number: typeof REAL_POLICY_APPEND_STAGE2_LINE;
  timestamp: typeof REAL_POLICY_APPEND_STAGE2_TIMESTAMP;
  role: "user";
  exact_full_text: string;
  text_utf8_bytes: typeof REAL_POLICY_APPEND_STAGE2_TEXT_BYTES;
  text_sha256: typeof REAL_POLICY_APPEND_STAGE2_TEXT_SHA256;
  transcript_prefix_bytes: typeof REAL_POLICY_APPEND_STAGE2_PREFIX_BYTES;
  transcript_prefix_sha256: typeof REAL_POLICY_APPEND_STAGE2_PREFIX_SHA256;
  content_parts: 1;
  continuous_parent_chain_verified: true;
  latest_role_user_message_verified: boolean;
  recorded_coordinate_and_prefix_verified: true;
  append_only_suffix_permitted: true;
  stage2_only: true;
  stage3_authorized: false;
  stage3_authorization_text_generated: false;
}

export interface RealPolicyAppendStage3AuthorizationSpec extends Record<string, unknown> {
  schema_version: typeof REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_SPEC_SCHEMA;
  authorization_kind: "exact_fresh_role_user_stage3_production_append";
  production_append_authorized: true;
}

export interface RealPolicyAppendStage3AuthorizationExpectation {
  authorization_spec_hash: string;
  renderer: typeof REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_RENDERER;
  renderer_definition_sha256: string;
  exact_text_utf8_bytes: number;
  exact_text_sha256: string;
  exact_text_not_emitted_by_stage2: true;
}

export interface RealPolicyAppendStage3AuthorizationBinding {
  authorization_spec: RealPolicyAppendStage3AuthorizationSpec;
  maximum_age_ms?: number;
}

export interface VerifiedRealPolicyAppendStage3Authorization {
  session_jsonl_path: typeof REAL_POLICY_APPEND_STAGE2_SESSION_PATH;
  session_id: typeof REAL_POLICY_APPEND_STAGE2_SESSION_ID;
  message_id: string;
  message_parent_id: string;
  message_line_number: number;
  timestamp: string;
  role: "user";
  text_utf8_bytes: number;
  text_sha256: string;
  transcript_prefix_bytes: number;
  transcript_prefix_sha256: string;
  continuous_parent_chain_verified: true;
  latest_role_user_message_verified: boolean;
  fresh_after_stage2_verified: true;
  fresh_verified: boolean;
  exact_full_text_verified: true;
  authorization_spec_hash: string;
  authorization_expectation: RealPolicyAppendStage3AuthorizationExpectation;
  caller_supplied_raw_text: false;
}

export interface RealPolicyAppendRecoveryHumanAuthorizationContract extends Record<string, unknown> {
  schema_version: typeof REAL_POLICY_APPEND_RECOVERY_HUMAN_AUTHORIZATION_CONTRACT_SCHEMA;
  required_phrase: typeof REAL_POLICY_APPEND_RECOVERY_HUMAN_AUTHORIZATION_PHRASE;
  required_phrase_utf8_bytes: number;
  required_phrase_sha256: string;
  exact_full_text_required: true;
  fresh_required: true;
  freshness_maximum_age_ms: typeof REAL_POLICY_APPEND_RECOVERY_HUMAN_AUTHORIZATION_MAXIMUM_AGE_MS;
  latest_role_user_message_required: true;
  standalone_single_text_part_role_user_required: true;
  goal_continuation_not_accepted: true;
  original_stage3_authorization_not_sufficient: true;
  machine_binding_generated_by_executor: true;
  caller_supplied_machine_payload_forbidden: true;
  contract_hash: string;
}

export interface RealPolicyAppendRecoveryHumanAuthorizationExpectation {
  human_authorization_contract_hash: string;
  required_phrase_utf8_bytes: number;
  required_phrase_sha256: string;
}

export interface RealPolicyAppendRecoveryAuthorizationBinding {
  human_authorization_contract: RealPolicyAppendRecoveryHumanAuthorizationContract;
  original_authorization: Readonly<{ message_line_number: number; timestamp: string }>;
  machine_authorization_binding: Readonly<Record<string, unknown>>;
}

export interface VerifiedRealPolicyAppendRecoveryAuthorization {
  session_jsonl_path: typeof REAL_POLICY_APPEND_STAGE2_SESSION_PATH;
  session_id: typeof REAL_POLICY_APPEND_STAGE2_SESSION_ID;
  message_id: string;
  message_parent_id: string;
  message_line_number: number;
  timestamp: string;
  role: "user";
  text_utf8_bytes: number;
  text_sha256: string;
  transcript_prefix_bytes: number;
  transcript_prefix_sha256: string;
  continuous_parent_chain_verified: true;
  latest_role_user_message_verified: true;
  fresh_after_original_authorization_verified: true;
  fresh_verified: true;
  exact_full_text_verified: true;
  human_authorization_contract_hash: string;
  human_authorization_expectation: RealPolicyAppendRecoveryHumanAuthorizationExpectation;
  caller_supplied_raw_text: false;
}

export class RealPolicyAppendTranscriptError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "RealPolicyAppendTranscriptError";
    this.code = code;
    this.detail = detail ? Object.freeze(detail) : undefined;
  }
}

export function verifyFreshRealPolicyAppendStage2Authorization(): VerifiedRealPolicyAppendStage2Authorization {
  const parsed = readTrustedSession();
  const target = parsed.messages.find((row) => row.id === REAL_POLICY_APPEND_STAGE2_MESSAGE_ID);
  if (!target || target.line !== REAL_POLICY_APPEND_STAGE2_LINE || target.parentId !== REAL_POLICY_APPEND_STAGE2_PARENT_ID
    || target.timestamp !== REAL_POLICY_APPEND_STAGE2_TIMESTAMP || target.role !== "user") {
    fail("REAL_POLICY_APPEND_TRANSCRIPT_TARGET", "Stage2 authorization coordinate differs");
  }
  const prefix = parsed.raw.subarray(0, target.end);
  if (prefix.length !== REAL_POLICY_APPEND_STAGE2_PREFIX_BYTES || sha256Hex(prefix) !== REAL_POLICY_APPEND_STAGE2_PREFIX_SHA256) fail("REAL_POLICY_APPEND_TRANSCRIPT_PREFIX", "Stage2 authorization prefix differs", { bytes: prefix.length, sha256: sha256Hex(prefix) });
  if (Buffer.byteLength(target.text) !== REAL_POLICY_APPEND_STAGE2_TEXT_BYTES || sha256Hex(target.text) !== REAL_POLICY_APPEND_STAGE2_TEXT_SHA256) fail("REAL_POLICY_APPEND_TRANSCRIPT_TEXT", "Stage2 authorization exact full text differs", { bytes: Buffer.byteLength(target.text), sha256: sha256Hex(target.text) });
  for (const required of REQUIRED_BINDINGS) if (!target.text.includes(required)) fail("REAL_POLICY_APPEND_TRANSCRIPT_BINDING", "Stage2 authorization omits an immutable design binding", { required });
  if (!target.text.startsWith("I authorize only ADR0040 real-policy-proposition-append Stage 2:")
    || !target.text.includes("This authorization does not authorize Stage 3 or any production append.")
    || !target.text.endsWith("do not infer, generate, or exercise Stage 3 authority from this message.")) fail("REAL_POLICY_APPEND_TRANSCRIPT_SCOPE", "Stage2-only authority boundary differs");
  return deepFreeze({
    session_jsonl_path: REAL_POLICY_APPEND_STAGE2_SESSION_PATH,
    session_jsonl_relative_path: REAL_POLICY_APPEND_STAGE2_SESSION_RELATIVE,
    session_id: REAL_POLICY_APPEND_STAGE2_SESSION_ID,
    message_id: REAL_POLICY_APPEND_STAGE2_MESSAGE_ID,
    message_parent_id: REAL_POLICY_APPEND_STAGE2_PARENT_ID,
    message_line_number: REAL_POLICY_APPEND_STAGE2_LINE,
    timestamp: REAL_POLICY_APPEND_STAGE2_TIMESTAMP,
    role: "user" as const,
    exact_full_text: target.text,
    text_utf8_bytes: REAL_POLICY_APPEND_STAGE2_TEXT_BYTES,
    text_sha256: REAL_POLICY_APPEND_STAGE2_TEXT_SHA256,
    transcript_prefix_bytes: REAL_POLICY_APPEND_STAGE2_PREFIX_BYTES,
    transcript_prefix_sha256: REAL_POLICY_APPEND_STAGE2_PREFIX_SHA256,
    content_parts: 1 as const,
    continuous_parent_chain_verified: true as const,
    latest_role_user_message_verified: parsed.latestUserId === REAL_POLICY_APPEND_STAGE2_MESSAGE_ID,
    recorded_coordinate_and_prefix_verified: true as const,
    append_only_suffix_permitted: true as const,
    stage2_only: true as const,
    stage3_authorized: false as const,
    stage3_authorization_text_generated: false as const,
  });
}

/** Returns only the deterministic authorization bytes identity, never the authorization text. */
export function realPolicyAppendStage3AuthorizationExpectation(spec: RealPolicyAppendStage3AuthorizationSpec): RealPolicyAppendStage3AuthorizationExpectation {
  validateAuthorizationSpec(spec);
  const rendered = renderRealPolicyAppendStage3Authorization(spec);
  return deepFreeze({
    authorization_spec_hash: jcsSha256Hex(spec),
    renderer: REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_RENDERER,
    renderer_definition_sha256: sha256Hex(REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_RENDERER_DEFINITION),
    exact_text_utf8_bytes: Buffer.byteLength(rendered),
    exact_text_sha256: sha256Hex(rendered),
    exact_text_not_emitted_by_stage2: true as const,
  });
}

/** Reads authority only from the latest trusted append-only session role=user message. */
export function verifyFreshRealPolicyAppendStage3Authorization(binding: RealPolicyAppendStage3AuthorizationBinding): VerifiedRealPolicyAppendStage3Authorization {
  const parsed = readTrustedSession();
  const latest = parsed.messages.filter((row) => row.role === "user").at(-1);
  if (!latest || latest.line <= REAL_POLICY_APPEND_STAGE2_LINE || latest.id === REAL_POLICY_APPEND_STAGE2_MESSAGE_ID) fail("REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_REQUIRED", "a later role=user Stage3 authorization is required");
  const expectation = realPolicyAppendStage3AuthorizationExpectation(binding.authorization_spec);
  verifyExactAuthorizationCandidate(latest, expectation, true);
  const stage2Ms = Date.parse(REAL_POLICY_APPEND_STAGE2_TIMESTAMP);
  const timestampMs = Date.parse(latest.timestamp);
  const maximumAge = binding.maximum_age_ms ?? 2 * 60 * 60 * 1000;
  const age = Date.now() - timestampMs;
  if (!Number.isFinite(timestampMs) || timestampMs <= stage2Ms) fail("REAL_POLICY_APPEND_STAGE3_FRESH_AFTER_STAGE2", "Stage3 authorization timestamp is not after Stage2", { timestamp: latest.timestamp });
  if (age < -5 * 60 * 1000 || age > maximumAge) fail("REAL_POLICY_APPEND_STAGE3_FRESHNESS", "Stage3 authorization is not fresh", { timestamp: latest.timestamp, age_ms: age, maximum_age_ms: maximumAge });
  return stage3Evidence(parsed, latest, expectation, true, true);
}

/** Recovery revalidates the exact recorded bytes/coordinate/prefix and permits only an append-only suffix. */
export function verifyRecordedRealPolicyAppendStage3Authorization(recordedInput: unknown, binding: RealPolicyAppendStage3AuthorizationBinding): VerifiedRealPolicyAppendStage3Authorization {
  if (!isRecord(recordedInput)) fail("REAL_POLICY_APPEND_STAGE3_RECORDED", "recorded Stage3 transcript evidence must be an object");
  const parsed = readTrustedSession();
  const messageId = nonempty(recordedInput.message_id, "recorded message_id");
  const target = parsed.messages.find((row) => row.id === messageId);
  if (!target || target.role !== "user" || target.line <= REAL_POLICY_APPEND_STAGE2_LINE || Date.parse(target.timestamp) <= Date.parse(REAL_POLICY_APPEND_STAGE2_TIMESTAMP)) fail("REAL_POLICY_APPEND_STAGE3_RECORDED", "recorded Stage3 role=user message is absent or not after Stage2", { messageId });
  const expectation = realPolicyAppendStage3AuthorizationExpectation(binding.authorization_spec);
  // This is historical evidence: its original latest/fresh facts are sealed in ratification.
  // A continuous append-only suffix must not invalidate the recorded authorization.
  verifyExactAuthorizationCandidate(target, expectation, parsed.latestUserId === target.id, false);
  const expected = {
    session_id: nonempty(recordedInput.session_id, "recorded session_id"),
    message_parent_id: nonempty(recordedInput.message_parent_id, "recorded message_parent_id"),
    message_line_number: integer(recordedInput.message_line_number, "recorded message_line_number"),
    timestamp: nonempty(recordedInput.timestamp, "recorded timestamp"),
    text_utf8_bytes: integer(recordedInput.text_utf8_bytes, "recorded text_utf8_bytes"),
    text_sha256: nonempty(recordedInput.text_sha256, "recorded text_sha256"),
    transcript_prefix_bytes: integer(recordedInput.transcript_prefix_bytes, "recorded transcript_prefix_bytes"),
    transcript_prefix_sha256: nonempty(recordedInput.transcript_prefix_sha256, "recorded transcript_prefix_sha256"),
    authorization_spec_hash: nonempty(recordedInput.authorization_spec_hash, "recorded authorization_spec_hash"),
  };
  if (expected.session_id !== REAL_POLICY_APPEND_STAGE2_SESSION_ID || expected.message_parent_id !== target.parentId
    || expected.message_line_number !== target.line || expected.timestamp !== target.timestamp
    || expected.text_utf8_bytes !== expectation.exact_text_utf8_bytes || expected.text_sha256 !== expectation.exact_text_sha256
    || expected.transcript_prefix_bytes !== target.end || expected.transcript_prefix_sha256 !== sha256Hex(parsed.raw.subarray(0, target.end))
    || expected.authorization_spec_hash !== expectation.authorization_spec_hash) fail("REAL_POLICY_APPEND_STAGE3_RECORDED", "recorded Stage3 coordinate, exact bytes, prefix, or spec differs");
  return stage3Evidence(parsed, target, expectation, parsed.latestUserId === target.id, false);
}

interface TrustedMessage { id: string; parentId: string; line: number; end: number; timestamp: string; role: string; content: unknown; text: string }

function readTrustedSession(): { raw: Buffer; messages: TrustedMessage[]; latestUserId: string | null } {
  assertExactSessionPath();
  const fd = fs.openSync(REAL_POLICY_APPEND_STAGE2_SESSION_PATH, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    const raw = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    const named = fs.lstatSync(REAL_POLICY_APPEND_STAGE2_SESSION_PATH);
    if (!before.isFile() || named.isSymbolicLink() || !sameIdentity(before, after) || !sameIdentity(before, named)) fail("REAL_POLICY_APPEND_TRANSCRIPT_RACE", "transcript identity changed while read");
    const seen = new Set<string>();
    let sessionId: string | null = null;
    let previousId: string | null = null;
    let latestUserId: string | null = null;
    const messages: TrustedMessage[] = [];
    for (const line of splitJsonl(raw)) {
      let value: unknown;
      try { value = JSON.parse(line.text); } catch (error) { fail("REAL_POLICY_APPEND_TRANSCRIPT_JSON", "transcript contains invalid JSON", { line: line.number, error: errorMessage(error) }); }
      if (!isRecord(value)) fail("REAL_POLICY_APPEND_TRANSCRIPT_JSON", "transcript row is not an object", { line: line.number });
      if (value.type === "session") {
        if (line.number !== 1 || sessionId !== null || typeof value.id !== "string") fail("REAL_POLICY_APPEND_TRANSCRIPT_HEADER", "session header is invalid");
        sessionId = value.id;
        seen.add(value.id);
        continue;
      }
      const id = nonempty(value.id, `line ${line.number} id`);
      if (seen.has(id)) fail("REAL_POLICY_APPEND_TRANSCRIPT_DUPLICATE", "transcript contains a duplicate ID", { id, line: line.number });
      seen.add(id);
      const parentId = value.parentId === null ? null : nonempty(value.parentId, `line ${line.number} parentId`);
      if (parentId !== previousId) fail("REAL_POLICY_APPEND_TRANSCRIPT_CHAIN", "transcript parent chain is not continuous", { line: line.number, expected: previousId, actual: parentId });
      previousId = id;
      const message = isRecord(value.message) ? value.message : null;
      if (message && typeof message.role === "string") {
        const text = message.role === "user" ? exactSingleText(message.content) : "";
        if (message.role === "user") latestUserId = id;
        messages.push({ id, parentId: parentId ?? "", line: line.number, end: line.end, timestamp: nonempty(value.timestamp, `line ${line.number} timestamp`), role: message.role, content: message.content, text });
      }
    }
    if (sessionId !== REAL_POLICY_APPEND_STAGE2_SESSION_ID) fail("REAL_POLICY_APPEND_TRANSCRIPT_SESSION", "session ID differs", { sessionId });
    return { raw, messages, latestUserId };
  } finally { fs.closeSync(fd); }
}

function stage3Evidence(parsed: ReturnType<typeof readTrustedSession>, target: TrustedMessage, expectation: RealPolicyAppendStage3AuthorizationExpectation, latest: boolean, fresh: boolean): VerifiedRealPolicyAppendStage3Authorization {
  return deepFreeze({
    session_jsonl_path: REAL_POLICY_APPEND_STAGE2_SESSION_PATH,
    session_id: REAL_POLICY_APPEND_STAGE2_SESSION_ID,
    message_id: target.id,
    message_parent_id: target.parentId,
    message_line_number: target.line,
    timestamp: target.timestamp,
    role: "user" as const,
    text_utf8_bytes: expectation.exact_text_utf8_bytes,
    text_sha256: expectation.exact_text_sha256,
    transcript_prefix_bytes: target.end,
    transcript_prefix_sha256: sha256Hex(parsed.raw.subarray(0, target.end)),
    continuous_parent_chain_verified: true as const,
    latest_role_user_message_verified: latest,
    fresh_after_stage2_verified: true as const,
    fresh_verified: fresh,
    exact_full_text_verified: true as const,
    authorization_spec_hash: expectation.authorization_spec_hash,
    authorization_expectation: expectation,
    caller_supplied_raw_text: false as const,
  });
}

function validateAuthorizationSpec(spec: RealPolicyAppendStage3AuthorizationSpec): void {
  if (!isRecord(spec) || spec.schema_version !== REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_SPEC_SCHEMA
    || spec.authorization_kind !== "exact_fresh_role_user_stage3_production_append" || spec.production_append_authorized !== true) fail("REAL_POLICY_APPEND_STAGE3_SPEC", "Stage3 authorization spec identity differs");
  for (const field of REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_REQUIRED_SPEC_FIELDS) if (!Object.prototype.hasOwnProperty.call(spec, field)) fail("REAL_POLICY_APPEND_STAGE3_SPEC", "Stage3 authorization spec omits a required field", { field });
}

/** Renders the exact two-line role=user transport; the JCS line has no terminal LF. */
export function renderRealPolicyAppendStage3Authorization(spec: RealPolicyAppendStage3AuthorizationSpec): string {
  validateAuthorizationSpec(spec);
  return `${REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_HEADER}\n${canonicalizeJcs(spec)}`;
}

export function realPolicyAppendRecoveryHumanAuthorizationExpectation(contract: RealPolicyAppendRecoveryHumanAuthorizationContract): RealPolicyAppendRecoveryHumanAuthorizationExpectation {
  validateRecoveryHumanAuthorizationContract(contract);
  return deepFreeze({
    human_authorization_contract_hash: contract.contract_hash,
    required_phrase_utf8_bytes: Buffer.byteLength(REAL_POLICY_APPEND_RECOVERY_HUMAN_AUTHORIZATION_PHRASE),
    required_phrase_sha256: sha256Hex(REAL_POLICY_APPEND_RECOVERY_HUMAN_AUTHORIZATION_PHRASE),
  });
}

/** The repair authorization is one standalone human phrase; all machine bindings stay inside the executor. */
export function verifyFreshRealPolicyAppendRecoveryAuthorization(binding: RealPolicyAppendRecoveryAuthorizationBinding): VerifiedRealPolicyAppendRecoveryAuthorization {
  const parsed = readTrustedSession();
  const latest = parsed.messages.filter((row) => row.role === "user").at(-1);
  if (!latest || latest.line <= binding.original_authorization.message_line_number) fail("REAL_POLICY_APPEND_RECOVERY_AUTHORIZATION_REQUIRED", "a later standalone role=user recovery authorization is required");
  const expectation = realPolicyAppendRecoveryHumanAuthorizationExpectation(binding.human_authorization_contract);
  verifyExactRecoveryAuthorizationCandidate(latest, expectation, true);
  verifyRecoveryAuthorizationFreshness(latest, binding.original_authorization, binding.human_authorization_contract.freshness_maximum_age_ms);
  return deepFreeze({
    session_jsonl_path: REAL_POLICY_APPEND_STAGE2_SESSION_PATH,
    session_id: REAL_POLICY_APPEND_STAGE2_SESSION_ID,
    message_id: latest.id,
    message_parent_id: latest.parentId,
    message_line_number: latest.line,
    timestamp: latest.timestamp,
    role: "user" as const,
    text_utf8_bytes: expectation.required_phrase_utf8_bytes,
    text_sha256: expectation.required_phrase_sha256,
    transcript_prefix_bytes: latest.end,
    transcript_prefix_sha256: sha256Hex(parsed.raw.subarray(0, latest.end)),
    continuous_parent_chain_verified: true as const,
    latest_role_user_message_verified: true as const,
    fresh_after_original_authorization_verified: true as const,
    fresh_verified: true as const,
    exact_full_text_verified: true as const,
    human_authorization_contract_hash: expectation.human_authorization_contract_hash,
    human_authorization_expectation: expectation,
    caller_supplied_raw_text: false as const,
  });
}

function validateRecoveryHumanAuthorizationContract(contract: RealPolicyAppendRecoveryHumanAuthorizationContract): void {
  const expectedKeys = ["schema_version", "required_phrase", "required_phrase_utf8_bytes", "required_phrase_sha256", "exact_full_text_required", "fresh_required", "freshness_maximum_age_ms", "latest_role_user_message_required", "standalone_single_text_part_role_user_required", "goal_continuation_not_accepted", "original_stage3_authorization_not_sufficient", "machine_binding_generated_by_executor", "caller_supplied_machine_payload_forbidden", "contract_hash"];
  if (!isRecord(contract) || canonicalizeJcs(Object.keys(contract).sort()) !== canonicalizeJcs(expectedKeys.sort())) fail("REAL_POLICY_APPEND_RECOVERY_CONTRACT", "recovery human authorization contract fields differ");
  const { contract_hash: _contractHash, ...base } = contract;
  if (contract.schema_version !== REAL_POLICY_APPEND_RECOVERY_HUMAN_AUTHORIZATION_CONTRACT_SCHEMA
    || contract.required_phrase !== REAL_POLICY_APPEND_RECOVERY_HUMAN_AUTHORIZATION_PHRASE
    || contract.required_phrase_utf8_bytes !== Buffer.byteLength(REAL_POLICY_APPEND_RECOVERY_HUMAN_AUTHORIZATION_PHRASE)
    || contract.required_phrase_sha256 !== sha256Hex(REAL_POLICY_APPEND_RECOVERY_HUMAN_AUTHORIZATION_PHRASE)
    || contract.exact_full_text_required !== true || contract.fresh_required !== true
    || contract.freshness_maximum_age_ms !== REAL_POLICY_APPEND_RECOVERY_HUMAN_AUTHORIZATION_MAXIMUM_AGE_MS
    || contract.latest_role_user_message_required !== true || contract.standalone_single_text_part_role_user_required !== true
    || contract.goal_continuation_not_accepted !== true || contract.original_stage3_authorization_not_sufficient !== true
    || contract.machine_binding_generated_by_executor !== true || contract.caller_supplied_machine_payload_forbidden !== true
    || contract.contract_hash !== jcsSha256Hex(base)) fail("REAL_POLICY_APPEND_RECOVERY_CONTRACT", "recovery human authorization contract differs");
}

function verifyExactAuthorizationCandidate(candidate: TrustedMessage, expectation: RealPolicyAppendStage3AuthorizationExpectation, latest: boolean, requireLatest = true): void {
  if (candidate.line <= REAL_POLICY_APPEND_STAGE2_LINE) fail("REAL_POLICY_APPEND_STAGE3_OLDER_MESSAGE", "Stage3 authorization candidate is not after Stage2", { line: candidate.line });
  if (requireLatest && !latest) fail("REAL_POLICY_APPEND_STAGE3_NOT_LATEST", "Stage3 authorization candidate is not the latest role=user message", { message_id: candidate.id });
  const bytes = Buffer.byteLength(candidate.text);
  const hash = sha256Hex(candidate.text);
  if (bytes !== expectation.exact_text_utf8_bytes || hash !== expectation.exact_text_sha256) fail("REAL_POLICY_APPEND_STAGE3_EXACT_TEXT", "Stage3 authorization full text bytes differ", { expected_bytes: expectation.exact_text_utf8_bytes, actual_bytes: bytes, expected_sha256: expectation.exact_text_sha256, actual_sha256: hash });
}

function verifyExactRecoveryAuthorizationCandidate(candidate: TrustedMessage, expectation: RealPolicyAppendRecoveryHumanAuthorizationExpectation, latest: boolean): void {
  if (candidate.role !== "user") fail("REAL_POLICY_APPEND_RECOVERY_ROLE", "recovery authorization must be a role=user message", { role: candidate.role });
  if (!latest) fail("REAL_POLICY_APPEND_RECOVERY_NOT_LATEST", "recovery authorization candidate is not the latest transcript message", { message_id: candidate.id });
  let text: string;
  try { text = exactSingleText(candidate.content); }
  catch { fail("REAL_POLICY_APPEND_RECOVERY_STANDALONE", "recovery authorization must contain exactly one text part"); }
  const bytes = Buffer.byteLength(text);
  const hash = sha256Hex(text);
  if (bytes !== expectation.required_phrase_utf8_bytes || hash !== expectation.required_phrase_sha256 || text !== REAL_POLICY_APPEND_RECOVERY_HUMAN_AUTHORIZATION_PHRASE) fail("REAL_POLICY_APPEND_RECOVERY_EXACT_TEXT", "recovery authorization must be the one exact standalone phrase", { expected_bytes: expectation.required_phrase_utf8_bytes, actual_bytes: bytes, expected_sha256: expectation.required_phrase_sha256, actual_sha256: hash });
}

function verifyRecoveryAuthorizationFreshness(candidate: TrustedMessage, original: Readonly<{ message_line_number: number; timestamp: string }>, maximumAge: number, now = Date.now()): void {
  const originalMs = Date.parse(original.timestamp);
  const timestampMs = Date.parse(candidate.timestamp);
  const age = now - timestampMs;
  if (!Number.isFinite(originalMs) || !Number.isFinite(timestampMs) || candidate.line <= original.message_line_number || timestampMs <= originalMs) fail("REAL_POLICY_APPEND_RECOVERY_FRESH_AFTER_ORIGINAL", "recovery authorization is not after the original Stage3 authorization", { line: candidate.line, timestamp: candidate.timestamp });
  if (age < -5 * 60 * 1000 || age > maximumAge) fail("REAL_POLICY_APPEND_RECOVERY_FRESHNESS", "recovery authorization is not fresh", { timestamp: candidate.timestamp, age_ms: age, maximum_age_ms: maximumAge });
}

function assertExactSessionPath(): void {
  const root = fs.realpathSync.native(REAL_POLICY_APPEND_STAGE2_SESSION_ROOT);
  if (root !== REAL_POLICY_APPEND_STAGE2_SESSION_ROOT) fail("REAL_POLICY_APPEND_TRANSCRIPT_UNSAFE", "session root realpath differs");
  let current = path.parse(root).root;
  for (const component of path.relative(current, REAL_POLICY_APPEND_STAGE2_SESSION_PATH).split(path.sep).slice(0, -1)) {
    if (!component) continue;
    current = path.join(current, component);
    const fd = fs.openSync(current, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { if (!fs.fstatSync(fd).isDirectory()) fail("REAL_POLICY_APPEND_TRANSCRIPT_UNSAFE", "session ancestor is not a directory", { current }); }
    finally { fs.closeSync(fd); }
  }
  const named = fs.lstatSync(REAL_POLICY_APPEND_STAGE2_SESSION_PATH);
  if (named.isSymbolicLink() || !named.isFile() || fs.realpathSync.native(REAL_POLICY_APPEND_STAGE2_SESSION_PATH) !== REAL_POLICY_APPEND_STAGE2_SESSION_PATH) fail("REAL_POLICY_APPEND_TRANSCRIPT_UNSAFE", "session file is not an exact regular file");
}

function splitJsonl(raw: Buffer): Array<{ number: number; text: string; end: number }> {
  const output: Array<{ number: number; text: string; end: number }> = [];
  let start = 0;
  let number = 1;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== 0x0a) continue;
    const end = index > start && raw[index - 1] === 0x0d ? index - 1 : index;
    const text = raw.subarray(start, end).toString("utf8");
    if (!text) fail("REAL_POLICY_APPEND_TRANSCRIPT_JSON", "transcript contains a blank row", { number });
    output.push({ number, text, end: index + 1 });
    start = index + 1;
    number += 1;
  }
  if (start < raw.length) output.push({ number, text: raw.subarray(start).toString("utf8"), end: raw.length });
  return output;
}

function exactSingleText(value: unknown): string { if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0]) || value[0].type !== "text" || typeof value[0].text !== "string") fail("REAL_POLICY_APPEND_TRANSCRIPT_TEXT", "authorization must contain exactly one text part"); return value[0].text; }
function sameIdentity(left: fs.Stats, right: fs.Stats): boolean { return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs; }
function nonempty(value: unknown, at: string): string { if (typeof value !== "string" || !value) fail("REAL_POLICY_APPEND_TRANSCRIPT_JSON", `${at} is invalid`); return value; }
function integer(value: unknown, at: string): number { if (!Number.isSafeInteger(value) || (value as number) < 1) fail("REAL_POLICY_APPEND_STAGE3_RECORDED", `${at} is invalid`); return value as number; }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function fail(code: string, message: string, detail?: Record<string, unknown>): never { throw new RealPolicyAppendTranscriptError(code, message, detail); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }

export const __STAGE2_TEST = Object.freeze({
  verifyExactCandidate(input: { text: string; expected_text_sha256: string; expected_text_utf8_bytes: number; line: number; latest: boolean }): void {
    verifyExactAuthorizationCandidate({ id: "test", parentId: "test-parent", line: input.line, end: 1, timestamp: new Date().toISOString(), role: "user", content: [{ type: "text", text: input.text }], text: input.text }, {
      authorization_spec_hash: "0".repeat(64), renderer: REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_RENDERER, renderer_definition_sha256: "0".repeat(64), exact_text_utf8_bytes: input.expected_text_utf8_bytes, exact_text_sha256: input.expected_text_sha256, exact_text_not_emitted_by_stage2: true,
    }, input.latest);
  },
  verifyRecordedExactCandidate(input: { text: string; expected_text_sha256: string; expected_text_utf8_bytes: number; line: number; latest: boolean }): void {
    verifyExactAuthorizationCandidate({ id: "recorded", parentId: "recorded-parent", line: input.line, end: 1, timestamp: new Date().toISOString(), role: "user", content: [{ type: "text", text: input.text }], text: input.text }, {
      authorization_spec_hash: "0".repeat(64), renderer: REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_RENDERER, renderer_definition_sha256: "0".repeat(64), exact_text_utf8_bytes: input.expected_text_utf8_bytes, exact_text_sha256: input.expected_text_sha256, exact_text_not_emitted_by_stage2: true,
    }, input.latest, false);
  },
  recoveryHumanAuthorizationContract(): RealPolicyAppendRecoveryHumanAuthorizationContract {
    const base = {
      schema_version: REAL_POLICY_APPEND_RECOVERY_HUMAN_AUTHORIZATION_CONTRACT_SCHEMA,
      required_phrase: REAL_POLICY_APPEND_RECOVERY_HUMAN_AUTHORIZATION_PHRASE,
      required_phrase_utf8_bytes: Buffer.byteLength(REAL_POLICY_APPEND_RECOVERY_HUMAN_AUTHORIZATION_PHRASE),
      required_phrase_sha256: sha256Hex(REAL_POLICY_APPEND_RECOVERY_HUMAN_AUTHORIZATION_PHRASE),
      exact_full_text_required: true as const,
      fresh_required: true as const,
      freshness_maximum_age_ms: REAL_POLICY_APPEND_RECOVERY_HUMAN_AUTHORIZATION_MAXIMUM_AGE_MS,
      latest_role_user_message_required: true as const,
      standalone_single_text_part_role_user_required: true as const,
      goal_continuation_not_accepted: true as const,
      original_stage3_authorization_not_sufficient: true as const,
      machine_binding_generated_by_executor: true as const,
      caller_supplied_machine_payload_forbidden: true as const,
    };
    return deepFreeze({ ...base, contract_hash: jcsSha256Hex(base) });
  },
  verifyRecoveryCandidate(input: { role: string; content: unknown; line: number; latest: boolean; timestamp: string; now_ms: number }): void {
    const contract = this.recoveryHumanAuthorizationContract();
    const expectation = realPolicyAppendRecoveryHumanAuthorizationExpectation(contract);
    const candidate: TrustedMessage = { id: "recovery", parentId: "recovery-parent", line: input.line, end: 1, timestamp: input.timestamp, role: input.role, content: input.content, text: "" };
    verifyExactRecoveryAuthorizationCandidate(candidate, expectation, input.latest);
    verifyRecoveryAuthorizationFreshness(candidate, { message_line_number: 533, timestamp: "2026-07-16T03:46:27.833Z" }, contract.freshness_maximum_age_ms, input.now_ms);
  },
});
