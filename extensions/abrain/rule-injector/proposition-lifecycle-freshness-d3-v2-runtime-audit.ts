/// <reference types="node" />
/**
 * ADR0040 D3-v2 session_start selected-path runtime audit (R3.4).
 *
 * Append is exclusive-write: flock the audit file, derive pre_offset /
 * parent_hash / self_hash from the verified tail, write JCS+LF, fsync the
 * file and parent directory, then release. Only a successful durable append
 * may authorize selected-path systemPrompt mutation.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { canonicalizeJcs, jcsSha256Hex, sha256Hex } from "../../_shared/jcs";
import type { D3V2SessionStartRuntimeReadResult } from "../../_shared/proposition-lifecycle-freshness-d3-v2-session-start";
import { D3_V2_SESSION_START_SOURCE_MARKER } from "../../_shared/proposition-lifecycle-freshness-d3-v2-session-start";

export const D3_V2_SESSION_START_RUNTIME_AUDIT_SCHEMA = "adr0040-d3-v2-session-start-runtime-audit" as const;
export const D3_V2_SESSION_START_RUNTIME_AUDIT_VERSION = 2 as const;
export const D3_V2_SESSION_START_RUNTIME_AUDIT_MAX_BYTES = 8 * 1024 * 1024;
export const D3_V2_SESSION_START_RUNTIME_AUDIT_FILE = path.join(
  os.homedir(),
  ".pi",
  ".pi-astack",
  "adr0040-d3-v2-session-start-runtime-audit.jsonl",
);

/** Test-only override; production default unchanged when unset. */
export function resolveD3V2SessionStartRuntimeAuditFile(override?: string): string {
  if (typeof override === "string" && override.trim()) return path.resolve(override.trim());
  const fromEnv = process.env.PI_ASTACK_D3V2_AUDIT_FILE;
  if (typeof fromEnv === "string" && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return D3_V2_SESSION_START_RUNTIME_AUDIT_FILE;
}

const BEGIN_FENCE_MARKER = "<!-- BEGIN_ABRAIN_RULES";
const END_FENCE_MARKER = "<!-- END_ABRAIN_RULES -->";
const POLICY_STABLE_MARKER = "source=proposition-policy-stable-view";
const COMPILED_MARKER = "source=constraint-shadow-compiled-view";
const LEGACY_CATALOG_MARKER = "## Rules Catalog\n";
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const DIRECTORY = fs.constants.O_DIRECTORY ?? 0;
const HASH = /^[0-9a-f]{64}$/;
const FLOCK = "/usr/bin/flock";

/** Fields present on the pre-append (logical) row before chain derivation. */
const PRE_APPEND_KEYS = new Set([
  "schema", "version", "timestamp", "pid", "session_id", "latest_user_message_id",
  "latest_user_text_sha256", "latest_user_text_bytes", "decision", "reason",
  "selection_hash", "head_hash", "proof_hash", "intent_hash", "stable_bundle_hash",
  "adapter_manifest_hash", "surface_combination_hash", "view_md_hash", "view_bytes",
  "item_count", "rendered_prompt_sha256", "rendered_prompt_bytes",
  "begin_fence_count", "end_fence_count", "contains_d3_v2_marker",
  "contains_policy_stable_marker", "contains_compiled_marker", "contains_legacy_catalog_marker",
  "activation_nonce", "activation_object_hash", "authorization_coordinate_hash", "causal_anchor",
]);

/** Final durable row keys after exclusive append derives chain fields. */
const FINAL_AUDIT_KEYS = new Set([
  ...PRE_APPEND_KEYS,
  "pre_offset", "parent_hash", "self_hash",
]);

type Success = Extract<D3V2SessionStartRuntimeReadResult, { ok: true }>;

export interface D3V2SessionStartRuntimeAuditRow {
  schema: typeof D3_V2_SESSION_START_RUNTIME_AUDIT_SCHEMA;
  version: typeof D3_V2_SESSION_START_RUNTIME_AUDIT_VERSION;
  timestamp: string;
  pid: number;
  session_id: string;
  latest_user_message_id?: string;
  latest_user_text_sha256: string;
  latest_user_text_bytes: number;
  decision: "d3_v2_session_start_injected" | "selected_zero_injection" | "normal_path_fallback";
  reason: string;
  selection_hash: string | null;
  head_hash: string | null;
  proof_hash: string | null;
  intent_hash: string | null;
  stable_bundle_hash: string | null;
  adapter_manifest_hash: string | null;
  surface_combination_hash: string | null;
  view_md_hash: string | null;
  view_bytes: number | null;
  item_count: number | null;
  rendered_prompt_sha256: string;
  rendered_prompt_bytes: number;
  begin_fence_count: number;
  end_fence_count: number;
  contains_d3_v2_marker: boolean;
  contains_policy_stable_marker: boolean;
  contains_compiled_marker: boolean;
  contains_legacy_catalog_marker: boolean;
  activation_nonce: string;
  activation_object_hash: string | null;
  authorization_coordinate_hash: string | null;
  causal_anchor: Readonly<Record<string, unknown>>;
  /** Present only after exclusive append derives the chain. */
  pre_offset?: number;
  parent_hash?: string | null;
  self_hash?: string;
}

export type D3V2SessionStartRuntimeAuditAppendResult =
  | { ok: true; auditFile: string; bytes: number; pre_offset: number; self_hash: string; parent_hash: string | null }
  | { ok: false; auditFile: string; error: string };

export function buildD3V2SessionStartRuntimeAuditRow(args: {
  sessionId: string;
  latestUserText: string;
  latestUserMessageId?: string;
  decision: D3V2SessionStartRuntimeAuditRow["decision"];
  reason: string;
  renderedPrompt: string;
  d3v2?: Success;
  activationNonce: string;
  adapterManifestHash?: string | null;
  activationObjectHash?: string | null;
  authorizationCoordinateHash?: string | null;
  causalAnchor: Readonly<Record<string, unknown>>;
  nowMs?: number;
}): D3V2SessionStartRuntimeAuditRow {
  if (typeof args.activationNonce !== "string" || !HASH.test(args.activationNonce)) {
    throw new Error("activation_nonce must be lowercase 64-hex");
  }
  if (!args.causalAnchor || typeof args.causalAnchor !== "object" || Array.isArray(args.causalAnchor)) {
    throw new Error("causal_anchor must be an object");
  }
  const view = args.d3v2;
  return {
    schema: D3_V2_SESSION_START_RUNTIME_AUDIT_SCHEMA,
    version: D3_V2_SESSION_START_RUNTIME_AUDIT_VERSION,
    timestamp: new Date(args.nowMs ?? Date.now()).toISOString(),
    pid: process.pid,
    session_id: args.sessionId,
    ...(args.latestUserMessageId ? { latest_user_message_id: args.latestUserMessageId } : {}),
    latest_user_text_sha256: sha256Hex(args.latestUserText),
    latest_user_text_bytes: Buffer.byteLength(args.latestUserText, "utf8"),
    decision: args.decision,
    reason: args.reason,
    selection_hash: view?.selectionHash ?? null,
    head_hash: view?.headHash ?? null,
    proof_hash: view?.proofHash ?? null,
    intent_hash: view?.intentHash ?? null,
    stable_bundle_hash: view?.stableBundleHash ?? null,
    adapter_manifest_hash: view?.adapterManifestHash ?? args.adapterManifestHash ?? null,
    surface_combination_hash: view?.surfaceCombinationHash ?? null,
    view_md_hash: view ? sha256Hex(view.viewMd) : null,
    view_bytes: view?.viewBytes ?? null,
    item_count: view?.itemCount ?? null,
    rendered_prompt_sha256: sha256Hex(args.renderedPrompt),
    rendered_prompt_bytes: Buffer.byteLength(args.renderedPrompt, "utf8"),
    begin_fence_count: countLiteral(args.renderedPrompt, BEGIN_FENCE_MARKER),
    end_fence_count: countLiteral(args.renderedPrompt, END_FENCE_MARKER),
    contains_d3_v2_marker: args.renderedPrompt.includes(D3_V2_SESSION_START_SOURCE_MARKER),
    contains_policy_stable_marker: args.renderedPrompt.includes(POLICY_STABLE_MARKER),
    contains_compiled_marker: args.renderedPrompt.includes(COMPILED_MARKER),
    contains_legacy_catalog_marker: args.renderedPrompt.includes(LEGACY_CATALOG_MARKER),
    activation_nonce: args.activationNonce,
    activation_object_hash: view?.activationObjectHash ?? args.activationObjectHash ?? null,
    authorization_coordinate_hash: view?.authorizationCoordinateHash ?? args.authorizationCoordinateHash ?? null,
    causal_anchor: Object.freeze({ ...args.causalAnchor }),
  };
}

/**
 * Exclusive durable append. Derives pre_offset/parent_hash/self_hash under flock.
 * Validates previous tail row before extending the chain. fsync file + directory
 * must succeed before returning ok.
 */
export function appendD3V2SessionStartRuntimeAudit(
  row: D3V2SessionStartRuntimeAuditRow,
  auditFileInput?: string,
): D3V2SessionStartRuntimeAuditAppendResult {
  const auditFile = resolveD3V2SessionStartRuntimeAuditFile(auditFileInput);
  let directoryFd: number | undefined;
  let fileFd: number | undefined;
  try {
    for (const key of Object.keys(row)) {
      if (!PRE_APPEND_KEYS.has(key)) throw new Error(`audit row contains non-allowlisted pre-append field: ${key}`);
    }
    if (row.version !== D3_V2_SESSION_START_RUNTIME_AUDIT_VERSION) throw new Error("audit row version differs");
    if (typeof row.activation_nonce !== "string" || !HASH.test(row.activation_nonce)) throw new Error("activation_nonce invalid");
    if (!row.causal_anchor || typeof row.causal_anchor !== "object") throw new Error("causal_anchor required");

    const directory = path.dirname(auditFile);
    ensureDirectoryNoSymlink(directory);
    directoryFd = fs.openSync(directory, fs.constants.O_RDONLY | DIRECTORY | NOFOLLOW);
    const directoryStat = fs.fstatSync(directoryFd);
    const namedDirectoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || namedDirectoryStat.isSymbolicLink() || !namedDirectoryStat.isDirectory()
      || directoryStat.dev !== namedDirectoryStat.dev || directoryStat.ino !== namedDirectoryStat.ino) {
      throw new Error("audit parent directory identity is unsafe");
    }
    if (process.platform !== "win32") fs.fchmodSync(directoryFd, 0o700);

    const anchoredFile = anchoredChild(directoryFd, directoryStat, path.basename(auditFile), directory);
    const before = lstatMaybe(anchoredFile);
    if (before && (before.isSymbolicLink() || !before.isFile())) throw new Error("audit path exists but is not a regular non-symlink file");
    fileFd = fs.openSync(anchoredFile, fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | NOFOLLOW, 0o600);
    const opened = fs.fstatSync(fileFd);
    if (!opened.isFile() || (before && (before.dev !== opened.dev || before.ino !== opened.ino))) throw new Error("opened audit file identity is unsafe");
    const current = fs.lstatSync(anchoredFile);
    if (current.isSymbolicLink() || !current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino) throw new Error("named audit file changed while opening");
    if (process.platform !== "win32") fs.fchmodSync(fileFd, 0o600);

    // Exclusive write semantics via same-OFD flock.
    acquireExclusiveFlock(fileFd);

    const sizeAfterLock = fs.fstatSync(fileFd).size;
    if (sizeAfterLock > D3_V2_SESSION_START_RUNTIME_AUDIT_MAX_BYTES) throw new Error("audit file reached the 8 MiB hard cap");

    // v2-only: under lock, verify the entire file (every line exact JCS+LF, schema/version,
    // zero-based real byte pre_offset, first parent null, subsequent parent=self, selfhash).
    // Tail truncate / offset gap / v1 / unknown fail closed.
    const parentHash = sizeAfterLock === 0
      ? null
      : validateEntireAuditFileV2Only(fileFd, sizeAfterLock);

    const preOffset = sizeAfterLock;
    const chainBase: Record<string, unknown> = {
      schema: row.schema,
      version: row.version,
      timestamp: row.timestamp,
      pid: row.pid,
      session_id: row.session_id,
      ...(row.latest_user_message_id ? { latest_user_message_id: row.latest_user_message_id } : {}),
      latest_user_text_sha256: row.latest_user_text_sha256,
      latest_user_text_bytes: row.latest_user_text_bytes,
      decision: row.decision,
      reason: row.reason,
      selection_hash: row.selection_hash,
      head_hash: row.head_hash,
      proof_hash: row.proof_hash,
      intent_hash: row.intent_hash,
      stable_bundle_hash: row.stable_bundle_hash,
      adapter_manifest_hash: row.adapter_manifest_hash,
      surface_combination_hash: row.surface_combination_hash,
      view_md_hash: row.view_md_hash,
      view_bytes: row.view_bytes,
      item_count: row.item_count,
      rendered_prompt_sha256: row.rendered_prompt_sha256,
      rendered_prompt_bytes: row.rendered_prompt_bytes,
      begin_fence_count: row.begin_fence_count,
      end_fence_count: row.end_fence_count,
      contains_d3_v2_marker: row.contains_d3_v2_marker,
      contains_policy_stable_marker: row.contains_policy_stable_marker,
      contains_compiled_marker: row.contains_compiled_marker,
      contains_legacy_catalog_marker: row.contains_legacy_catalog_marker,
      activation_nonce: row.activation_nonce,
      activation_object_hash: row.activation_object_hash ?? null,
      authorization_coordinate_hash: row.authorization_coordinate_hash ?? null,
      causal_anchor: row.causal_anchor,
      pre_offset: preOffset,
      parent_hash: parentHash,
    };
    for (const key of Object.keys(chainBase)) {
      if (!FINAL_AUDIT_KEYS.has(key) || key === "self_hash") throw new Error(`chain base field invalid: ${key}`);
    }
    const selfHash = jcsSha256Hex(chainBase);
    const finalRow = { ...chainBase, self_hash: selfHash };
    const serialized = `${canonicalizeJcs(finalRow)}\n`;
    const bytes = Buffer.from(serialized, "utf8");
    if (preOffset + bytes.length > D3_V2_SESSION_START_RUNTIME_AUDIT_MAX_BYTES) throw new Error("audit row would exceed the 8 MiB hard cap");

    fs.writeFileSync(fileFd, bytes);
    fs.fsyncSync(fileFd);
    if (process.platform !== "win32") fs.fsyncSync(directoryFd);
    return { ok: true, auditFile, bytes: bytes.length, pre_offset: preOffset, self_hash: selfHash, parent_hash: parentHash };
  } catch (error) {
    return { ok: false, auditFile, error: (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]+/g, " ").slice(0, 512) };
  } finally {
    if (fileFd !== undefined) try { fs.closeSync(fileFd); } catch { /* ignore */ }
    if (directoryFd !== undefined) try { fs.closeSync(directoryFd); } catch { /* ignore */ }
  }
}

/** Validate every existing line under exclusive lock. Returns last self_hash (parent for next row). */
function validateEntireAuditFileV2Only(fileFd: number, size: number): string | null {
  if (size <= 0) return null;
  const tail = Buffer.allocUnsafe(1);
  if (fs.readSync(fileFd, tail, 0, 1, size - 1) !== 1 || tail[0] !== 0x0a) {
    throw new Error("audit file does not end at a JSONL line boundary (tail truncate)");
  }
  const buf = Buffer.allocUnsafe(size);
  const read = fs.readSync(fileFd, buf, 0, size, 0);
  if (read !== size) throw new Error("audit full-file read incomplete");
  const text = buf.toString("utf8");
  if (text.includes("\r")) throw new Error("audit file contains CR");
  if (!text.endsWith("\n")) throw new Error("audit file not LF-terminated");
  const lines = text.slice(0, -1).split("\n");
  let offset = 0;
  let parent: string | null = null;
  let lastSelf: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line) throw new Error(`audit empty line at index ${i}`);
    let parsed: unknown;
    try { parsed = JSON.parse(line); }
    catch { throw new Error(`audit line ${i} is not JSON`); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`audit line ${i} is not an object`);
    const row = parsed as Record<string, unknown>;
    if (`${canonicalizeJcs(row)}\n` !== `${line}\n`) throw new Error(`audit line ${i} is not exact JCS+LF`);
    if (row.schema !== D3_V2_SESSION_START_RUNTIME_AUDIT_SCHEMA) throw new Error(`audit line ${i} schema differs`);
    if (row.version === 1) throw new Error(`audit line ${i} is v1 (v2-only; reject)`);
    if (row.version !== D3_V2_SESSION_START_RUNTIME_AUDIT_VERSION) throw new Error(`audit line ${i} unknown version`);
    for (const key of Object.keys(row)) {
      if (!FINAL_AUDIT_KEYS.has(key)) throw new Error(`audit line ${i} has non-allowlisted field: ${key}`);
    }
    if (typeof row.pre_offset !== "number" || !Number.isSafeInteger(row.pre_offset) || row.pre_offset !== offset) {
      throw new Error(`audit line ${i} pre_offset gap/mismatch: expected ${offset} got ${String(row.pre_offset)}`);
    }
    if (i === 0) {
      if (row.parent_hash !== null) throw new Error("first audit row parent_hash must be null");
    } else if (row.parent_hash !== parent) {
      throw new Error(`audit line ${i} parent_hash chain broken`);
    }
    if (typeof row.self_hash !== "string" || !HASH.test(row.self_hash)) throw new Error(`audit line ${i} self_hash invalid`);
    if (typeof row.activation_nonce !== "string" || !HASH.test(row.activation_nonce)) throw new Error(`audit line ${i} activation_nonce invalid`);
    const base = { ...row };
    delete base.self_hash;
    if (jcsSha256Hex(base) !== row.self_hash) throw new Error(`audit line ${i} self_hash does not recompute`);
    parent = String(row.self_hash);
    lastSelf = parent;
    offset += Buffer.byteLength(`${line}\n`, "utf8");
  }
  if (offset !== size) throw new Error("audit file size does not equal summed line bytes");
  return lastSelf;
}

function acquireExclusiveFlock(fileFd: number): void {
  if (process.platform === "win32") return;
  // flock -xn 3 takes an exclusive non-blocking lock on FD 3 (the audit file).
  // The lock is held on the same open FD until fileFd is closed in finally.
  const result = spawnSync(FLOCK, ["-xn", "3"], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    stdio: ["ignore", "ignore", "pipe", fileFd],
  });
  if (result.error) throw new Error(`exclusive flock spawn failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`exclusive flock failed: status=${result.status} stderr=${(result.stderr || "").slice(0, 200)}`);
  }
}

function ensureDirectoryNoSymlink(directoryInput: string): void {
  const directory = path.resolve(directoryInput);
  const root = path.parse(directory).root;
  let current = root;
  for (const component of path.relative(root, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat = lstatMaybe(current);
    if (!stat) {
      try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`audit directory component is unsafe: ${current}`);
  }
}

function anchoredChild(directoryFd: number, directoryStat: fs.Stats, basename: string, fallbackDirectory: string): string {
  if (path.basename(basename) !== basename || basename === "." || basename === "..") throw new Error("audit basename is invalid");
  if (process.platform === "linux") {
    const procDirectory = `/proc/self/fd/${directoryFd}`;
    const procStat = fs.statSync(procDirectory);
    if (procStat.isDirectory() && procStat.dev === directoryStat.dev && procStat.ino === directoryStat.ino) return path.join(procDirectory, basename);
  }
  return path.join(fallbackDirectory, basename);
}

function lstatMaybe(file: string): fs.Stats | undefined {
  try { return fs.lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function countLiteral(text: string, marker: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const found = text.indexOf(marker, offset);
    if (found < 0) return count;
    count += 1;
    offset = found + marker.length;
  }
}
