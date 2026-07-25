/**
 * ADR 0044 Stage A0 frozen-contract read-only adapter (default-off).
 *
 * Sole formal contract source:
 *   pi-router commit e26f669 + proto/pi/memory/v1/memory.fds
 *
 * Descriptor-driven: after fail-closed FDS sha256 verification, loads
 * pi.memory.v1.EdgeShadowJournalRecord from the binary FileDescriptorSet and
 * uses protobufjs reflection for field / oneof / enum number·name validation
 * plus protobuf wire + canonical proto-JSON (preserving_proto_field_name).
 *
 * Flat producer input parsing and field transforms stay local; formal message
 * fields, enums, and oneofs are never hand-authored as a second schema.
 *
 * Non-goals (hard): no second journal write, no ConsumerAck / retention /
 * source delete / local_primary change, no daemon / worker spawn.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import protobuf from "protobufjs";
import descriptor from "protobufjs/ext/descriptor/index.js";
import {
  EDGE_JOURNAL_SCHEMA,
  EDGE_JOURNAL_SCHEMA_VERSION,
  EDGE_PROTOCOL_SHADOW_ROOT_NAME,
  parseEdgeRecordFilename,
  recomputeEdgeJournalRecordId,
  verifyEdgeSourceEnvelopeBytes,
  type EdgeJournalRecord,
} from "./edge-protocol-shadow";

/** Absolute git for env_clear child (no PATH). */
const GIT_BIN = "/usr/bin/git";

/** Full commit hash for pi-router Stage A0 contract freeze. */
export const FROZEN_MEMORY_CONTRACT_COMMIT =
  "e26f669e51966efb05a0a23894356e262b897ed6" as const;
export const FROZEN_MEMORY_CONTRACT_COMMIT_SHORT = "e26f669" as const;

/** sha256 of proto/pi/memory/v1/memory.fds at the frozen commit. */
export const FROZEN_MEMORY_FDS_SHA256 =
  "0076de46d54705f509082963d91068e9b99cc5740473c5c7ab772fb9fddb1f66" as const;

export const FROZEN_MEMORY_FDS_RELATIVE_PATH = "proto/pi/memory/v1/memory.fds" as const;
export const FORMAL_EDGE_SHADOW_PACKAGE = "pi.memory.v1" as const;
export const FORMAL_EDGE_SHADOW_MESSAGE = "EdgeShadowJournalRecord" as const;
export const FORMAL_EDGE_SHADOW_FQN =
  `${FORMAL_EDGE_SHADOW_PACKAGE}.${FORMAL_EDGE_SHADOW_MESSAGE}` as const;

const HEX64_RE = /^[0-9a-f]{64}$/;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;

export type ProducerIdentityClass = "shadow_only_producer_process_identity";

export interface FrozenContractIdentity {
  contract_commit: typeof FROZEN_MEMORY_CONTRACT_COMMIT;
  contract_commit_short: typeof FROZEN_MEMORY_CONTRACT_COMMIT_SHORT;
  fds_sha256: typeof FROZEN_MEMORY_FDS_SHA256;
  fds_relative_path: typeof FROZEN_MEMORY_FDS_RELATIVE_PATH;
  formal_package: typeof FORMAL_EDGE_SHADOW_PACKAGE;
  formal_message: typeof FORMAL_EDGE_SHADOW_MESSAGE;
  fds_status: "verified" | "missing" | "mismatch" | "unreadable" | "skipped";
  observed_fds_sha256?: string;
  pi_router_head_matches_contract?: boolean;
  pi_router_head_short?: string;
}

/** Descriptor-driven projection result (no second formal schema types). */
export interface EdgeShadowProjectionResult {
  /** Canonical proto-JSON with preserving_proto_field_name (snake_case). */
  proto_json: Record<string, unknown>;
  /** Protobuf wire encoding of EdgeShadowJournalRecord. */
  wire: Uint8Array;
  /** Identity metadata only — no body / path / content. */
  identity: {
    record_id: string;
    session_id: string;
    producer_seq: number;
    payload_digest: string;
    producer_process_identity: string;
    body: "candidate_capture" | "terminal_witness";
    temporary_run_generation: number;
  };
}

export class EdgeShadowProjectionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EdgeShadowProjectionError";
    this.code = code;
  }
}

export class FrozenContractIdentityError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FrozenContractIdentityError";
    this.code = code;
  }
}

interface LoadedFdsContract {
  root: protobuf.Root;
  type: protobuf.Type;
  settlementEnum: protobuf.Enum;
  missingCoreEnum: protobuf.Enum;
  fdsSha256: string;
}

let cachedContract: LoadedFdsContract | null = null;
let cachedContractKey: string | null = null;

/** Default-off gate: adapter projection/scan only when explicitly enabled. */
export function isFrozenContractAdapterEnabled(raw?: unknown): boolean {
  const env = process.env.PI_ASTACK_EDGE_SHADOW_FROZEN_CONTRACT_ADAPTER?.trim().toLowerCase();
  if (env === "1" || env === "true" || env === "on" || env === "yes") return true;
  if (env === "0" || env === "false" || env === "off" || env === "no") return false;
  if (typeof raw === "boolean") return raw;
  return false;
}

/**
 * Resolve pi-router root for local/dev helpers.
 * Conformance CLI main path must pass an explicit absolute `--pi-router-root`
 * argv (see parsePiRouterRootArgv); do not rely on PI_ROUTER_ROOT there.
 */
export function resolvePiRouterRoot(override?: string): string {
  const fromArg = override?.trim();
  if (fromArg) return path.resolve(fromArg);
  const fromEnv = process.env.PI_ROUTER_ROOT?.trim() || process.env.PI_MEMORY_CONTRACT_ROOT?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve("/home/worker/work/components/pi-router");
}

/**
 * Strict argv parser for conformance CLI: exactly `--pi-router-root <abs>`.
 * Rejects missing/unknown flags, relative paths, empty, and embedded NUL.
 */
export function parsePiRouterRootArgv(argv: readonly string[] = process.argv.slice(2)): string {
  let root: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === "--pi-router-root") {
      const val = argv[i + 1];
      if (val === undefined) {
        throw new FrozenContractIdentityError("pi_router_root_missing", "--pi-router-root requires a value");
      }
      if (val.length === 0 || val.includes("\0")) {
        throw new FrozenContractIdentityError("pi_router_root_invalid", "--pi-router-root value empty or contains NUL");
      }
      if (!path.isAbsolute(val)) {
        throw new FrozenContractIdentityError("pi_router_root_relative", "--pi-router-root must be absolute");
      }
      if (root !== undefined) {
        throw new FrozenContractIdentityError("pi_router_root_duplicate", "--pi-router-root specified more than once");
      }
      root = val;
      i += 1;
      continue;
    }
    throw new FrozenContractIdentityError("argv_unknown", `unknown argv: ${tok}`);
  }
  if (root === undefined) {
    throw new FrozenContractIdentityError("pi_router_root_missing", "--pi-router-root is required");
  }
  return root;
}

export function resolveFrozenFdsPath(piRouterRoot?: string): string {
  return path.join(resolvePiRouterRoot(piRouterRoot), FROZEN_MEMORY_FDS_RELATIVE_PATH);
}

export function sha256FileHex(filePath: string): string {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(filePath));
  return h.digest("hex");
}

/**
 * Fail-closed identity verification against the frozen pi-router contract.
 * Does not print paths. Throws FrozenContractIdentityError on mismatch when require=true.
 */
export function verifyFrozenContractIdentity(options?: {
  piRouterRoot?: string;
  require?: boolean;
  checkGitHead?: boolean;
}): FrozenContractIdentity {
  const require = options?.require !== false;
  const checkGitHead = options?.checkGitHead !== false;
  const root = resolvePiRouterRoot(options?.piRouterRoot);
  const fdsPath = resolveFrozenFdsPath(root);

  const base: FrozenContractIdentity = {
    contract_commit: FROZEN_MEMORY_CONTRACT_COMMIT,
    contract_commit_short: FROZEN_MEMORY_CONTRACT_COMMIT_SHORT,
    fds_sha256: FROZEN_MEMORY_FDS_SHA256,
    fds_relative_path: FROZEN_MEMORY_FDS_RELATIVE_PATH,
    formal_package: FORMAL_EDGE_SHADOW_PACKAGE,
    formal_message: FORMAL_EDGE_SHADOW_MESSAGE,
    fds_status: "skipped",
  };

  let observed: string | undefined;
  try {
    if (!fs.existsSync(fdsPath)) {
      base.fds_status = "missing";
      if (require) {
        throw new FrozenContractIdentityError(
          "fds_missing",
          "frozen memory.fds missing under resolved pi-router root",
        );
      }
      return base;
    }
    observed = sha256FileHex(fdsPath);
    base.observed_fds_sha256 = observed;
    if (observed !== FROZEN_MEMORY_FDS_SHA256) {
      base.fds_status = "mismatch";
      if (require) {
        throw new FrozenContractIdentityError(
          "fds_digest_mismatch",
          `frozen FDS sha256 mismatch: expected ${FROZEN_MEMORY_FDS_SHA256}`,
        );
      }
      return base;
    }
    base.fds_status = "verified";
  } catch (err) {
    if (err instanceof FrozenContractIdentityError) throw err;
    base.fds_status = "unreadable";
    if (require) {
      throw new FrozenContractIdentityError(
        "fds_unreadable",
        "frozen memory.fds unreadable",
      );
    }
    return base;
  }

  if (checkGitHead) {
    try {
      // Exact full-hash resolution of the frozen contract commit (no short-prefix match).
      // Harness commits may sit after the freeze; identity is the freeze object + FDS pin.
      const resolved = execFileSync(
        GIT_BIN,
        ["rev-parse", "--verify", `${FROZEN_MEMORY_CONTRACT_COMMIT}^{commit}`],
        {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          env: { PATH: "/usr/bin:/bin" },
        },
      ).trim();
      if (resolved !== FROZEN_MEMORY_CONTRACT_COMMIT) {
        base.pi_router_head_matches_contract = false;
        if (require) {
          throw new FrozenContractIdentityError(
            "head_mismatch",
            `frozen contract commit must resolve exactly to ${FROZEN_MEMORY_CONTRACT_COMMIT}`,
          );
        }
        return base;
      }
      // Working-tree HEAD for diagnostics (may be ahead of freeze; FDS already verified).
      const head = execFileSync(GIT_BIN, ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: { PATH: "/usr/bin:/bin" },
      }).trim();
      base.pi_router_head_short = head.slice(0, 7);
      // Contract identity match = exact freeze commit present (not working-tree HEAD equality).
      base.pi_router_head_matches_contract = true;
    } catch (err) {
      if (err instanceof FrozenContractIdentityError) throw err;
      base.pi_router_head_matches_contract = false;
      if (require) {
        throw new FrozenContractIdentityError(
          "head_mismatch",
          "frozen contract commit HEAD identity check failed",
        );
      }
    }
  }

  return base;
}

/**
 * Load EdgeShadowJournalRecord type from verified binary memory.fds.
 * Fail closed if digest mismatches or the formal message is absent.
 */
export function loadFrozenEdgeShadowContract(options?: {
  piRouterRoot?: string;
  forceReload?: boolean;
}): LoadedFdsContract {
  const identity = verifyFrozenContractIdentity({
    piRouterRoot: options?.piRouterRoot,
    require: true,
    checkGitHead: false,
  });
  const fdsPath = resolveFrozenFdsPath(options?.piRouterRoot);
  const key = `${fdsPath}::${identity.observed_fds_sha256 ?? identity.fds_sha256}`;
  if (!options?.forceReload && cachedContract && cachedContractKey === key) {
    return cachedContract;
  }

  const bytes = fs.readFileSync(fdsPath);
  const observed = crypto.createHash("sha256").update(bytes).digest("hex");
  if (observed !== FROZEN_MEMORY_FDS_SHA256) {
    throw new FrozenContractIdentityError(
      "fds_digest_mismatch",
      `frozen FDS sha256 mismatch: expected ${FROZEN_MEMORY_FDS_SHA256}`,
    );
  }

  // protobufjs ext/descriptor: decode FileDescriptorSet then Root.fromDescriptor.
  const FileDescriptorSet = (descriptor as { FileDescriptorSet: protobuf.Type }).FileDescriptorSet;
  const decoded = FileDescriptorSet.decode(bytes) as protobuf.Message;
  // fromDescriptor is provided by protobufjs/ext/descriptor (not in base typings).
  const RootWithDescriptor = protobuf.Root as typeof protobuf.Root & {
    fromDescriptor(desc: unknown): protobuf.Root;
  };
  const root = RootWithDescriptor.fromDescriptor(decoded);
  root.resolveAll();

  const type = root.lookupType(FORMAL_EDGE_SHADOW_FQN);
  if (!type) {
    throw new FrozenContractIdentityError(
      "fds_message_missing",
      "EdgeShadowJournalRecord missing from frozen FDS",
    );
  }
  const settlementEnum = root.lookupEnum(
    `${FORMAL_EDGE_SHADOW_PACKAGE}.EdgeShadowSettlementStatus`,
  );
  const missingCoreEnum = root.lookupEnum(
    `${FORMAL_EDGE_SHADOW_PACKAGE}.EdgeShadowMissingCoreCapability`,
  );
  if (!settlementEnum || !missingCoreEnum) {
    throw new FrozenContractIdentityError(
      "fds_enum_missing",
      "EdgeShadow enums missing from frozen FDS",
    );
  }

  // Fail closed: body oneof must exist with candidate_capture + terminal_witness.
  const bodyOneof = type.oneofsArray?.find((o: { name: string }) => o.name === "body");
  if (
    !bodyOneof ||
    !bodyOneof.oneof.includes("candidate_capture") ||
    !bodyOneof.oneof.includes("terminal_witness")
  ) {
    throw new FrozenContractIdentityError(
      "fds_oneof_missing",
      "EdgeShadowJournalRecord.body oneof incomplete in frozen FDS",
    );
  }

  cachedContract = {
    root,
    type,
    settlementEnum,
    missingCoreEnum,
    fdsSha256: observed,
  };
  cachedContractKey = key;
  return cachedContract;
}

export function classifyProducerProcessIdentity(_raw: string): ProducerIdentityClass {
  return "shadow_only_producer_process_identity";
}

/** Hard fence: never parse/coerce producer process identity into formal writer epoch. */
export function refuseCoerceProducerIdentityToWriterEpoch(raw: string): never {
  classifyProducerProcessIdentity(raw);
  throw new EdgeShadowProjectionError(
    "producer_identity_not_writer_epoch",
    "producer_process_identity must not be parsed or coerced into formal session_writer_epoch",
  );
}

export function is64LowercaseHex(s: string): boolean {
  return HEX64_RE.test(s);
}

export function isSafeRelativePath(p: string): boolean {
  if (!p || p.startsWith("/") || p.includes("\\") || p.includes("\0")) return false;
  const parts = p.split("/");
  if (parts.length === 0) return false;
  for (const part of parts) {
    if (!part || part === "." || part === "..") return false;
  }
  return true;
}

function fail(code: string, message: string): never {
  throw new EdgeShadowProjectionError(code, message);
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("not_object", `${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requireNonemptyString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    fail("string_required", `${key} must be a non-empty string`);
  }
  return v;
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") fail("string_required", `${key} must be a string when present`);
  return v;
}

function requireHex64(obj: Record<string, unknown>, key: string): string {
  const s = requireNonemptyString(obj, key);
  if (!is64LowercaseHex(s)) fail("hex64_required", `${key} must be 64 lowercase hex`);
  return s;
}

function requireU64(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || !Number.isSafeInteger(v)) {
    fail("u64_required", `${key} must be a non-negative integer`);
  }
  return v;
}

function requireU32(obj: Record<string, unknown>, key: string): number {
  const v = requireU64(obj, key);
  if (v > 0xffff_ffff) fail("u32_range", `${key} exceeds u32 range`);
  return v;
}

function requireBool(obj: Record<string, unknown>, key: string): boolean {
  const v = obj[key];
  if (typeof v !== "boolean") fail("bool_required", `${key} must be a boolean`);
  return v;
}

function projectScalar(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = obj[key];
  if (typeof v === "string" && v.length > 0) return { string_value: v };
  if (typeof v === "number") {
    if (!Number.isInteger(v) || !Number.isSafeInteger(v)) {
      fail("scalar_not_integer", `${key} must be an integer (non-integer number rejected)`);
    }
    return { integer_value: v };
  }
  fail("scalar_required", `${key} must be a nonempty string or integer`);
}

function optionalScalar(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  if (obj[key] === undefined || obj[key] === null) return undefined;
  return projectScalar(obj, key);
}

function resolveEnumNumber(enm: protobuf.Enum, name: string, label: string): number {
  const n = enm.values[name];
  if (typeof n !== "number") {
    fail("enum_unknown", `unknown ${label} enum: ${name}`);
  }
  if (n === 0) {
    fail("enum_unspecified", `${label} must not be UNSPECIFIED`);
  }
  return n;
}

function projectCapabilities(obj: Record<string, unknown>): Record<string, unknown> {
  return {
    authority: requireNonemptyString(obj, "authority"),
    local_primary_authority: requireNonemptyString(obj, "local_primary_authority"),
    session_transaction: requireBool(obj, "session_transaction"),
    launch_broker: requireBool(obj, "launch_broker"),
    terminal_seal: requireBool(obj, "terminal_seal"),
    link_open_close: requireBool(obj, "link_open_close"),
    stage_a_complete: requireBool(obj, "stage_a_complete"),
  };
}

function projectLeafTip(value: unknown): Record<string, unknown> {
  const obj = asObject(value, "leaf_tip");
  const parentRaw =
    optionalString(obj, "parent_id") !== undefined
      ? optionalString(obj, "parent_id")
      : optionalString(obj, "parentId");
  const tsRaw =
    optionalString(obj, "timestamp_utc") !== undefined
      ? optionalString(obj, "timestamp_utc")
      : optionalString(obj, "timestampUtc");
  const tip: Record<string, unknown> = {
    id: requireNonemptyString(obj, "id"),
    type: requireNonemptyString(obj, "type"),
  };
  if (parentRaw !== undefined && parentRaw !== null && obj.parentId !== null && obj.parent_id !== null) {
    tip.parent_id = parentRaw;
  }
  if (obj.parentId === null || obj.parent_id === null) {
    delete tip.parent_id;
  }
  if (tsRaw) tip.timestamp_utc = tsRaw;
  return tip;
}

function projectDeferred(
  obj: Record<string, unknown>,
  missingCoreEnum: protobuf.Enum,
): number[] {
  const raw = obj.deferred_by_missing_core;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail("deferred_array", "deferred_by_missing_core must be an array");
  const out: number[] = [];
  for (const item of raw) {
    if (typeof item !== "string") fail("deferred_entry", "deferred_by_missing_core entries must be strings");
    let formalName: string;
    switch (item) {
      case "session_transaction":
        formalName = "EDGE_SHADOW_MISSING_CORE_CAPABILITY_SESSION_TRANSACTION";
        break;
      case "launch_broker":
        formalName = "EDGE_SHADOW_MISSING_CORE_CAPABILITY_LAUNCH_BROKER";
        break;
      case "terminal_seal":
        formalName = "EDGE_SHADOW_MISSING_CORE_CAPABILITY_TERMINAL_SEAL";
        break;
      case "link_open_close":
        formalName = "EDGE_SHADOW_MISSING_CORE_CAPABILITY_LINK_OPEN_CLOSE";
        break;
      default:
        fail("deferred_unknown", `unknown deferred_by_missing_core: ${item}`);
    }
    out.push(resolveEnumNumber(missingCoreEnum, formalName, "deferred_missing_core"));
  }
  return out;
}

function projectRawSidecar(value: unknown): Record<string, unknown> {
  const obj = asObject(value, "source_ref");
  const kind = requireNonemptyString(obj, "kind");
  if (kind !== "raw_sidecar") fail("source_kind", `unsupported source_ref.kind: ${kind}`);
  const relative_path = requireNonemptyString(obj, "relative_path");
  if (!isSafeRelativePath(relative_path)) {
    fail("source_path", "source_ref.relative_path must be a safe relative path without empty/./.. components");
  }
  return {
    content_id: requireHex64(obj, "content_id"),
    relative_path,
    byte_length: requireU64(obj, "byte_length"),
  };
}

function projectCandidateRef(value: unknown): Record<string, unknown> {
  const obj = asObject(value, "candidate_ref");
  const producer_seq = requireU64(obj, "producer_seq");
  if (producer_seq < 1) fail("candidate_seq", "candidate_ref.producer_seq must be >= 1");
  return {
    record_id: requireHex64(obj, "record_id"),
    producer_seq,
    payload_digest: requireHex64(obj, "payload_digest"),
    temporary_run_generation: requireU64(obj, "run_generation"),
  };
}

function projectC6(obj: Record<string, unknown>): Record<string, unknown> {
  const c6: Record<string, unknown> = {
    session_id: requireNonemptyString(obj, "session_id"),
    turn_id: projectScalar(obj, "turn_id"),
  };
  const sub = optionalScalar(obj, "subturn");
  if (sub) c6.subturn = sub;
  const label = optionalString(obj, "sub_agent_label");
  if (label !== undefined) c6.sub_agent_label = label;
  if (obj.parent !== undefined && obj.parent !== null) {
    c6.parent_json = JSON.stringify(obj.parent);
  }
  return c6;
}

/**
 * Project flat TS edge-journal/v1 → formal EdgeShadowJournalRecord via FDS reflection.
 * Returns proto-JSON (snake_case) + protobuf wire. Enums/oneof/fields come from FDS.
 */
export function projectEdgeShadowToFormal(
  value: unknown,
  options?: { piRouterRoot?: string },
): EdgeShadowProjectionResult {
  const contract = loadFrozenEdgeShadowContract({ piRouterRoot: options?.piRouterRoot });
  const obj = asObject(value, "edge shadow record");

  const schema = requireNonemptyString(obj, "schema");
  if (schema !== EDGE_JOURNAL_SCHEMA) fail("schema", `unsupported edge journal schema: ${schema}`);
  const schema_version = requireU32(obj, "schema_version");
  if (schema_version !== EDGE_JOURNAL_SCHEMA_VERSION) {
    fail("schema_version", `unsupported edge journal schema_version: ${schema_version}`);
  }

  const record_id = requireHex64(obj, "record_id");
  const session_id = requireNonemptyString(obj, "session_id");
  const producer_seq = requireU64(obj, "producer_seq");
  if (producer_seq < 1) fail("producer_seq", "producer_seq must be >= 1");

  // TS field is misnamed session_writer_epoch; exact schema is nonempty string only.
  const producer_process_identity = requireNonemptyString(obj, "session_writer_epoch");
  try {
    refuseCoerceProducerIdentityToWriterEpoch(producer_process_identity);
  } catch (err) {
    if (!(err instanceof EdgeShadowProjectionError) || err.code !== "producer_identity_not_writer_epoch") {
      throw err;
    }
  }

  const record_type = requireNonemptyString(obj, "record_type");
  const created_at = requireNonemptyString(obj, "created_at");
  const payload_digest = requireHex64(obj, "payload_digest");
  const c6 = projectC6(asObject(obj.c6, "c6"));
  if (c6.session_id !== session_id) {
    fail("session_c6_mismatch", "outer session_id must equal c6.session_id");
  }
  const temporary_run_generation = requireU64(obj, "run_generation");
  const capabilities = projectCapabilities(asObject(obj.capabilities, "capabilities"));

  const plain: Record<string, unknown> = {
    schema,
    schema_version,
    record_id,
    session_id,
    producer_seq,
    producer_process_identity,
    created_at,
    payload_digest,
    c6,
    temporary_run_generation,
    capabilities,
  };

  let body: "candidate_capture" | "terminal_witness";

  if (record_type === "candidate_capture") {
    if (obj.candidate_ref !== undefined && obj.candidate_ref !== null) {
      fail("candidate_has_ref", "candidate_capture must not carry candidate_ref");
    }
    if (obj.settlement_status !== undefined && obj.settlement_status !== null) {
      fail("candidate_has_settlement", "candidate_capture must not carry settlement_status");
    }
    if (temporary_run_generation !== producer_seq) {
      fail("candidate_run_gen", "candidate_capture run_generation must equal producer_seq");
    }
    if (obj.source_ref === undefined || obj.source_ref === null) {
      fail("candidate_source", "candidate_capture must carry source_ref");
    }
    const raw_sidecar = projectRawSidecar(obj.source_ref);
    if (payload_digest !== raw_sidecar.content_id) {
      fail("payload_digest", "payload_digest must equal source_ref.content_id");
    }
    const bodyObj: Record<string, unknown> = {
      raw_sidecar,
      deferred_missing_core: projectDeferred(obj, contract.missingCoreEnum),
    };
    if (obj.leaf_tip !== undefined && obj.leaf_tip !== null) {
      bodyObj.leaf_tip = projectLeafTip(obj.leaf_tip);
    }
    plain.candidate_capture = bodyObj;
    body = "candidate_capture";
  } else if (record_type === "terminal_witness") {
    if (obj.source_ref === undefined || obj.source_ref === null) {
      fail("witness_source", "terminal_witness must carry source_ref");
    }
    if (obj.candidate_ref === undefined || obj.candidate_ref === null) {
      fail("witness_ref", "terminal_witness must carry candidate_ref");
    }
    if (obj.settlement_status === undefined || obj.settlement_status === null) {
      fail("witness_settlement", "terminal_witness must carry settlement_status");
    }
    if (typeof obj.settlement_status !== "string") {
      fail("settlement_type", "settlement_status must be a string");
    }
    let settlementFormal: string;
    if (obj.settlement_status === "unsupported_core_capability") {
      settlementFormal = "EDGE_SHADOW_SETTLEMENT_STATUS_UNSUPPORTED_CORE_CAPABILITY";
    } else if (obj.settlement_status === "capture_only") {
      settlementFormal = "EDGE_SHADOW_SETTLEMENT_STATUS_CAPTURE_ONLY";
    } else {
      fail("settlement_unknown", `unknown settlement_status: ${obj.settlement_status}`);
    }
    const raw_sidecar = projectRawSidecar(obj.source_ref);
    const candidate_ref = projectCandidateRef(obj.candidate_ref);
    if (temporary_run_generation !== candidate_ref.temporary_run_generation) {
      fail(
        "witness_run_gen",
        "terminal_witness run_generation must equal candidate_ref.run_generation",
      );
    }
    if (candidate_ref.temporary_run_generation !== candidate_ref.producer_seq) {
      fail(
        "candidate_ref_run_gen",
        "candidate_ref.run_generation must equal candidate_ref.producer_seq",
      );
    }
    if ((candidate_ref.producer_seq as number) >= producer_seq) {
      fail("witness_seq_order", "candidate_ref.producer_seq must be < witness producer_seq");
    }
    if (
      payload_digest !== candidate_ref.payload_digest ||
      payload_digest !== raw_sidecar.content_id
    ) {
      fail(
        "witness_digest",
        "payload_digest must equal candidate_ref.payload_digest and source_ref.content_id",
      );
    }
    const bodyObj: Record<string, unknown> = {
      raw_sidecar,
      candidate_ref,
      settlement_status: resolveEnumNumber(
        contract.settlementEnum,
        settlementFormal,
        "settlement_status",
      ),
      deferred_missing_core: projectDeferred(obj, contract.missingCoreEnum),
    };
    if (obj.leaf_tip !== undefined && obj.leaf_tip !== null) {
      bodyObj.leaf_tip = projectLeafTip(obj.leaf_tip);
    }
    plain.terminal_witness = bodyObj;
    body = "terminal_witness";
  } else {
    fail("record_type", `unknown record_type: ${record_type}`);
  }

  // Descriptor-driven verify + encode. Enum numbers resolved from FDS.
  const verifyErr = contract.type.verify(plain);
  if (verifyErr) {
    fail("fds_verify", `FDS reflection verify failed: ${verifyErr}`);
  }
  const message = contract.type.fromObject(plain);
  // Ensure body oneof is set exactly once via reflection (protobufjs sets message.body).
  const oneof = contract.type.oneofs?.body;
  if (!oneof) fail("fds_oneof_missing", "body oneof missing after load");
  const msgRec = message as unknown as Record<string, unknown>;
  const which = typeof msgRec.body === "string" ? msgRec.body : undefined;
  if (which !== body) {
    fail("oneof_body", `body oneof must be ${body}, got ${String(which)}`);
  }
  const other = body === "candidate_capture" ? "terminal_witness" : "candidate_capture";
  if (msgRec[other] != null) {
    fail("oneof_body", "body oneof must set exactly one variant");
  }
  const wire = contract.type.encode(message).finish();
  // Round-trip decode fail-closed.
  const decoded = contract.type.decode(wire);
  const decRec = decoded as unknown as Record<string, unknown>;
  const whichDecoded = typeof decRec.body === "string" ? decRec.body : undefined;
  if (whichDecoded !== body || decRec[body] == null || decRec[other] != null) {
    fail("wire_oneof", "decoded wire body oneof mismatch");
  }

  // Canonical proto-JSON with preserving_proto_field_name (descriptor field names).
  const proto_json = contract.type.toObject(decoded, {
    longs: Number,
    enums: String,
    bytes: String,
    defaults: false,
    oneofs: true,
    json: true,
  }) as Record<string, unknown>;

  // Strip protobufjs oneof helper keys (body / value / _optional markers).
  sanitizeProtoJson(proto_json);

  // Hard fence: never emit formal session_writer_epoch on projection.
  if ("session_writer_epoch" in proto_json) {
    fail("formal_epoch_leak", "projection must not emit session_writer_epoch");
  }
  if (typeof proto_json.producer_process_identity !== "string" || !proto_json.producer_process_identity) {
    fail("identity_missing", "producer_process_identity required on formal projection");
  }

  return {
    proto_json,
    wire: Uint8Array.from(wire),
    identity: {
      record_id,
      session_id,
      producer_seq,
      payload_digest,
      producer_process_identity,
      body,
      temporary_run_generation,
    },
  };
}

/** Remove protobufjs internal oneof marker keys from proto-JSON objects. */
function sanitizeProtoJson(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) sanitizeProtoJson(item);
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key === "body" || key === "value" || key.startsWith("_")) {
      // Keep body only if it is the nested message (should not happen); drop markers.
      if (key === "body" && (obj[key] === "candidate_capture" || obj[key] === "terminal_witness")) {
        delete obj[key];
        continue;
      }
      if (key === "value" && (obj[key] === "string_value" || obj[key] === "integer_value")) {
        delete obj[key];
        continue;
      }
      if (key.startsWith("_")) {
        delete obj[key];
        continue;
      }
    }
    sanitizeProtoJson(obj[key]);
  }
}

/**
 * Back-compat helper: project to formal proto-JSON only.
 * Prefer projectEdgeShadowToFormal when wire is needed.
 */
export function projectEdgeShadowToFormalProtoJson(
  value: unknown,
  options?: { piRouterRoot?: string },
): Record<string, unknown> {
  return projectEdgeShadowToFormal(value, options).proto_json;
}

/** Capability classification always marks shadow envelopes worker/retention-ineligible. */
export function classifyFormalEdgeShadowCapabilities(_caps: unknown): {
  identity_class: ProducerIdentityClass;
  retention_ineligible: true;
  worker_ineligible: true;
  is_shadow_envelope: true;
} {
  return {
    identity_class: "shadow_only_producer_process_identity",
    retention_ineligible: true,
    worker_ineligible: true,
    is_shadow_envelope: true,
  };
}

export interface EdgeShadowScanAggregate {
  sessions_scanned: number;
  records_seen: number;
  records_projected_ok: number;
  records_projection_failed: number;
  candidate_capture: number;
  terminal_witness: number;
  schema_v1: number;
  identity_shadow_only: number;
  retention_ineligible: number;
  worker_ineligible: number;
  filename_seq_mismatch: number;
  filename_record_id_mismatch: number;
  raw_sidecar_present: number;
  raw_sidecar_missing_file: number;
  raw_sidecar_content_id_mismatch: number;
  raw_sidecar_byte_length_mismatch: number;
  raw_sidecar_messages_digest_mismatch: number;
  raw_sidecar_schema_mismatch: number;
  rejected_unexpected_record: number;
  scan_errors: number;
  wires_emitted: number;
}

export function emptyEdgeShadowScanAggregate(): EdgeShadowScanAggregate {
  return {
    sessions_scanned: 0,
    records_seen: 0,
    records_projected_ok: 0,
    records_projection_failed: 0,
    candidate_capture: 0,
    terminal_witness: 0,
    schema_v1: 0,
    identity_shadow_only: 0,
    retention_ineligible: 0,
    worker_ineligible: 0,
    filename_seq_mismatch: 0,
    filename_record_id_mismatch: 0,
    raw_sidecar_present: 0,
    raw_sidecar_missing_file: 0,
    raw_sidecar_content_id_mismatch: 0,
    raw_sidecar_byte_length_mismatch: 0,
    raw_sidecar_messages_digest_mismatch: 0,
    raw_sidecar_schema_mismatch: 0,
    rejected_unexpected_record: 0,
    scan_errors: 0,
    wires_emitted: 0,
  };
}

/** True when `candidate` is `root` or a path strictly under `root` (after resolve). */
function isPathInsideRoot(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Fail-closed directory gate: reject symlink / non-dir / canonical OOB.
 * Does not follow a final symlink entry.
 */
function requireStableDirUnderRoot(dirPath: string, rootCanon: string): string {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dirPath);
  } catch {
    throw new EdgeShadowProjectionError("scan_dir_missing", "directory meta unavailable");
  }
  if (st.isSymbolicLink()) {
    throw new EdgeShadowProjectionError("scan_dir_symlink", "directory symlink rejected");
  }
  if (!st.isDirectory()) {
    throw new EdgeShadowProjectionError("scan_dir_not_directory", "path is not a directory");
  }
  let canon: string;
  try {
    canon = fs.realpathSync(dirPath);
  } catch {
    throw new EdgeShadowProjectionError("scan_dir_canonicalize_failed", "directory canonicalize failed");
  }
  if (!isPathInsideRoot(canon, rootCanon)) {
    throw new EdgeShadowProjectionError("scan_dir_out_of_root", "directory canonical path escapes root");
  }
  let stAfter: fs.Stats;
  try {
    stAfter = fs.lstatSync(canon);
  } catch {
    throw new EdgeShadowProjectionError("scan_dir_recheck_failed", "directory recheck failed");
  }
  if (stAfter.isSymbolicLink() || !stAfter.isDirectory()) {
    throw new EdgeShadowProjectionError("scan_dir_not_stable", "directory not a stable directory");
  }
  return canon;
}

/** Optional intermediate dir: missing → null; existing symlink/non-dir/OOB → throw. */
function requireOptionalStableDirUnderRoot(dirPath: string, rootCanon: string): string | null {
  try {
    fs.lstatSync(dirPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return null;
    throw new EdgeShadowProjectionError("scan_dir_io", "directory meta io error");
  }
  return requireStableDirUnderRoot(dirPath, rootCanon);
}

/** Fail-closed regular file under root (no symlink follow of the entry). */
function readRegularFileUnderRoot(filePath: string, rootCanon: string): Buffer {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(filePath);
  } catch {
    throw new EdgeShadowProjectionError("scan_file_missing", "file meta unavailable");
  }
  if (st.isSymbolicLink()) {
    throw new EdgeShadowProjectionError("scan_file_symlink", "file symlink rejected");
  }
  if (!st.isFile()) {
    throw new EdgeShadowProjectionError("scan_file_not_regular", "entry is not a regular file");
  }
  if (st.size > MAX_RECORD_BYTES) {
    throw new EdgeShadowProjectionError("scan_file_too_large", "file exceeds max record bytes");
  }
  let canon: string;
  try {
    canon = fs.realpathSync(filePath);
  } catch {
    throw new EdgeShadowProjectionError("scan_file_canonicalize_failed", "file canonicalize failed");
  }
  if (!isPathInsideRoot(canon, rootCanon)) {
    throw new EdgeShadowProjectionError("scan_file_out_of_root", "file canonical path escapes root");
  }
  let stAfter: fs.Stats;
  try {
    stAfter = fs.lstatSync(canon);
  } catch {
    throw new EdgeShadowProjectionError("scan_file_recheck_failed", "file recheck failed");
  }
  if (stAfter.isSymbolicLink() || !stAfter.isFile()) {
    throw new EdgeShadowProjectionError("scan_file_not_stable", "file not a stable regular file");
  }
  return fs.readFileSync(canon);
}

/**
 * Read-only walk of an edge-protocol-shadow root. Projects every journal record
 * through FDS-driven formal encoding. Never writes, never deletes, never ACKs.
 *
 * Fail-closed on by-owner/owner/sessions/session/journal/records/sources path
 * symlink, non-directory, or canonical OOB. Does not follow root-escaping links.
 */
export function scanEdgeShadowRootReadOnly(
  edgeRoot: string,
  options?: { piRouterRoot?: string },
): {
  aggregate: EdgeShadowScanAggregate;
  projections: EdgeShadowProjectionResult[];
} {
  // Ensure contract loads once (fail closed) before scan.
  loadFrozenEdgeShadowContract({ piRouterRoot: options?.piRouterRoot });

  const aggregate = emptyEdgeShadowScanAggregate();
  const projections: EdgeShadowProjectionResult[] = [];

  let rootCanon: string;
  try {
    const rootResolved = path.resolve(edgeRoot);
    // Root itself must be a stable directory (symlink root rejected).
    rootCanon = requireStableDirUnderRoot(rootResolved, rootResolved);
  } catch {
    aggregate.scan_errors += 1;
    return { aggregate, projections };
  }

  const byOwnerPath = path.join(rootCanon, "by-owner");
  let byOwnerCanon: string | null;
  try {
    byOwnerCanon = requireOptionalStableDirUnderRoot(byOwnerPath, rootCanon);
  } catch {
    aggregate.scan_errors += 1;
    return { aggregate, projections };
  }
  if (!byOwnerCanon) return { aggregate, projections };

  let owners: string[];
  try {
    owners = fs.readdirSync(byOwnerCanon);
  } catch {
    aggregate.scan_errors += 1;
    return { aggregate, projections };
  }

  for (const owner of owners) {
    let ownerCanon: string;
    try {
      ownerCanon = requireStableDirUnderRoot(path.join(byOwnerCanon, owner), rootCanon);
    } catch {
      aggregate.scan_errors += 1;
      return { aggregate, projections };
    }

    let sessionsCanon: string | null;
    try {
      sessionsCanon = requireOptionalStableDirUnderRoot(path.join(ownerCanon, "sessions"), rootCanon);
    } catch {
      aggregate.scan_errors += 1;
      return { aggregate, projections };
    }
    if (!sessionsCanon) continue;

    let sessions: string[];
    try {
      sessions = fs.readdirSync(sessionsCanon);
    } catch {
      aggregate.scan_errors += 1;
      return { aggregate, projections };
    }

    for (const session of sessions) {
      aggregate.sessions_scanned += 1;
      let sessionCanon: string;
      try {
        sessionCanon = requireStableDirUnderRoot(path.join(sessionsCanon, session), rootCanon);
      } catch {
        aggregate.scan_errors += 1;
        return { aggregate, projections };
      }

      // sources/ is part of the durable layout — if present must be a stable dir under root.
      try {
        requireOptionalStableDirUnderRoot(path.join(sessionCanon, "sources"), rootCanon);
      } catch {
        aggregate.scan_errors += 1;
        return { aggregate, projections };
      }

      let journalCanon: string | null;
      try {
        journalCanon = requireOptionalStableDirUnderRoot(path.join(sessionCanon, "journal"), rootCanon);
      } catch {
        aggregate.scan_errors += 1;
        return { aggregate, projections };
      }
      if (!journalCanon) continue;

      let recordsCanon: string | null;
      try {
        recordsCanon = requireOptionalStableDirUnderRoot(path.join(journalCanon, "records"), rootCanon);
      } catch {
        aggregate.scan_errors += 1;
        return { aggregate, projections };
      }
      if (!recordsCanon) continue;

      let names: string[];
      try {
        names = fs.readdirSync(recordsCanon);
      } catch {
        aggregate.scan_errors += 1;
        return { aggregate, projections };
      }

      for (const name of names) {
        const parsedName = parseEdgeRecordFilename(name);
        if (!parsedName) {
          aggregate.rejected_unexpected_record += 1;
          continue;
        }
        aggregate.records_seen += 1;
        const full = path.join(recordsCanon, name);
        let bytes: Buffer;
        try {
          bytes = readRegularFileUnderRoot(full, rootCanon);
        } catch (err) {
          if (err instanceof EdgeShadowProjectionError && err.code === "scan_file_too_large") {
            aggregate.records_projection_failed += 1;
          } else if (
            err instanceof EdgeShadowProjectionError &&
            (err.code === "scan_file_symlink" || err.code === "scan_file_not_regular")
          ) {
            aggregate.rejected_unexpected_record += 1;
          } else {
            aggregate.records_projection_failed += 1;
          }
          continue;
        }
        let value: unknown;
        try {
          value = JSON.parse(bytes.toString("utf8").trim());
        } catch {
          aggregate.records_projection_failed += 1;
          continue;
        }

        // M1: producer canonical record_id must match body + filename.
        try {
          const recObj = value as EdgeJournalRecord;
          if (!recObj || typeof recObj !== "object") {
            aggregate.records_projection_failed += 1;
            continue;
          }
          const bodyId = typeof recObj.record_id === "string" ? recObj.record_id : "";
          const recomputed = recomputeEdgeJournalRecordId(recObj);
          if (!bodyId || recomputed !== bodyId || recomputed !== parsedName.recordId) {
            aggregate.records_projection_failed += 1;
            if (bodyId && bodyId !== parsedName.recordId) {
              aggregate.filename_record_id_mismatch += 1;
            }
            continue;
          }
        } catch {
          aggregate.records_projection_failed += 1;
          continue;
        }

        let projected: EdgeShadowProjectionResult;
        try {
          projected = projectEdgeShadowToFormal(value, { piRouterRoot: options?.piRouterRoot });
        } catch {
          aggregate.records_projection_failed += 1;
          continue;
        }
        aggregate.records_projected_ok += 1;
        aggregate.wires_emitted += 1;
        projections.push(projected);

        if (
          projected.proto_json.schema === EDGE_JOURNAL_SCHEMA &&
          projected.proto_json.schema_version === EDGE_JOURNAL_SCHEMA_VERSION
        ) {
          aggregate.schema_v1 += 1;
        }
        if (projected.identity.producer_seq !== parsedName.producerSeq) {
          aggregate.filename_seq_mismatch += 1;
        }
        if (projected.identity.record_id !== parsedName.recordId) {
          aggregate.filename_record_id_mismatch += 1;
        }

        if (projected.identity.body === "candidate_capture") aggregate.candidate_capture += 1;
        else aggregate.terminal_witness += 1;
        aggregate.raw_sidecar_present += 1;

        const cls = classifyFormalEdgeShadowCapabilities(projected.proto_json.capabilities);
        if (cls.identity_class === "shadow_only_producer_process_identity") {
          aggregate.identity_shadow_only += 1;
        }
        if (cls.retention_ineligible) aggregate.retention_ineligible += 1;
        if (cls.worker_ineligible) aggregate.worker_ineligible += 1;

        const bodyJson =
          projected.identity.body === "candidate_capture"
            ? (projected.proto_json.candidate_capture as Record<string, unknown> | undefined)
            : (projected.proto_json.terminal_witness as Record<string, unknown> | undefined);
        const side = bodyJson?.raw_sidecar as
          | { content_id?: string; relative_path?: string; byte_length?: number }
          | undefined;
        if (!side || typeof side.relative_path !== "string" || typeof side.content_id !== "string") {
          aggregate.raw_sidecar_content_id_mismatch += 1;
          continue;
        }
        if (!isSafeRelativePath(side.relative_path)) {
          aggregate.raw_sidecar_content_id_mismatch += 1;
          continue;
        }
        const sourcePath = path.join(sessionCanon, side.relative_path);
        try {
          // sources path components must stay under session/root (no OOB follow).
          const srcBytes = readRegularFileUnderRoot(sourcePath, rootCanon);
          // sources/ parent dir already gated when present; still reject escape.
          const v = verifyEdgeSourceEnvelopeBytes(srcBytes, {
            sessionId: projected.identity.session_id,
            contentId: side.content_id,
            byteLength: typeof side.byte_length === "number" ? side.byte_length : -1,
          });
          if (!v.ok) {
            if (v.code === "byte_length_mismatch") aggregate.raw_sidecar_byte_length_mismatch += 1;
            else if (v.code === "schema_mismatch") aggregate.raw_sidecar_schema_mismatch += 1;
            else if (v.code === "content_id_mismatch") aggregate.raw_sidecar_content_id_mismatch += 1;
            else if (v.code === "messages_digest_mismatch") {
              aggregate.raw_sidecar_messages_digest_mismatch += 1;
            } else aggregate.raw_sidecar_content_id_mismatch += 1;
          }
          if (projected.identity.payload_digest !== side.content_id) {
            aggregate.raw_sidecar_content_id_mismatch += 1;
          }
        } catch {
          aggregate.raw_sidecar_missing_file += 1;
        }
      }
    }
  }

  return { aggregate, projections };
}

export function edgeProtocolShadowRootFromAbrain(abrainHome: string): string {
  return path.join(path.resolve(abrainHome), ".state", "sediment", EDGE_PROTOCOL_SHADOW_ROOT_NAME);
}

/**
 * Snapshot content digests of all regular files under edge root (read-only).
 * Used for zero-mutation proof. Returns aggregate hash only (no paths).
 *
 * Fail-closed: symlink / non-regular / canonical OOB anywhere under root throws
 * (never silently skips). Read-only — does not follow root-escaping links.
 */
export function snapshotEdgeRootContentDigest(edgeRoot: string): {
  file_count: number;
  aggregate_sha256: string;
} {
  const rootResolved = path.resolve(edgeRoot);
  const rootCanon = requireStableDirUnderRoot(rootResolved, rootResolved);
  const files: string[] = [];
  const walk = (dirCanon: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirCanon, { withFileTypes: true });
    } catch {
      throw new EdgeShadowProjectionError("snapshot_io", "snapshot readdir failed");
    }
    for (const ent of entries) {
      const full = path.join(dirCanon, ent.name);
      if (ent.isSymbolicLink()) {
        throw new EdgeShadowProjectionError("snapshot_symlink", "snapshot symlink rejected");
      }
      if (ent.isDirectory()) {
        const childCanon = requireStableDirUnderRoot(full, rootCanon);
        walk(childCanon);
        continue;
      }
      if (!ent.isFile()) {
        throw new EdgeShadowProjectionError("snapshot_nonregular", "snapshot non-regular entry rejected");
      }
      // Confirm regular + under root without following a replaced symlink.
      readRegularFileUnderRoot(full, rootCanon);
      const canon = fs.realpathSync(full);
      files.push(canon);
    }
  };
  walk(rootCanon);
  files.sort();
  const h = crypto.createHash("sha256");
  for (const f of files) {
    const rel = path.relative(rootCanon, f).split(path.sep).join("/");
    h.update(rel, "utf8");
    h.update("\0");
    h.update(fs.readFileSync(f));
    h.update("\0");
  }
  return { file_count: files.length, aggregate_sha256: h.digest("hex") };
}

/** Project a typed EdgeJournalRecord (producer shape) to formal projection. */
export function projectTypedEdgeJournalRecord(
  record: EdgeJournalRecord,
  options?: { piRouterRoot?: string },
): EdgeShadowProjectionResult {
  return projectEdgeShadowToFormal(record, options);
}
