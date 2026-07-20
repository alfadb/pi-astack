import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalizeJcs, sha256Hex } from "../../_shared/jcs";
import { getCurrentAnchor, spreadAnchor } from "../../_shared/causal-anchor";
import type { PropositionPolicyStableViewRuntimeReadResult } from "./proposition-policy-stable-view-reader";

export const PROPOSITION_POLICY_STABLE_VIEW_RUNTIME_AUDIT_SCHEMA = "adr0040-policy-stable-view-runtime-audit" as const;
export const PROPOSITION_POLICY_STABLE_VIEW_RUNTIME_AUDIT_VERSION = 2 as const;
export const PROPOSITION_POLICY_STABLE_VIEW_RUNTIME_AUDIT_MAX_BYTES = 8 * 1024 * 1024;
export const PROPOSITION_POLICY_STABLE_VIEW_RUNTIME_AUDIT_FILE = path.join(
  os.homedir(),
  ".pi",
  ".pi-astack",
  "adr0040-policy-stable-view-runtime-audit.jsonl",
);

const BEGIN_FENCE_MARKER = "<!-- BEGIN_ABRAIN_RULES";
const END_FENCE_MARKER = "<!-- END_ABRAIN_RULES -->";
const POLICY_STABLE_MARKER = "source=proposition-policy-stable-view";
const COMPILED_MARKER = "source=constraint-shadow-compiled-view";
const LEGACY_CATALOG_MARKER = "## Rules Catalog\n";
const D3_MARKER = "source=proposition-lifecycle-freshness-d3-v2";
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const DIRECTORY = fs.constants.O_DIRECTORY ?? 0;
const AUDIT_KEYS = new Set([
  "schema",
  "version",
  "timestamp",
  "pid",
  "session_id",
  "turn_id",
  "causal_anchor",
  "latest_user_message_id",
  "latest_user_text_sha256",
  "latest_user_text_bytes",
  "decision",
  "reason",
  "bundle_hash",
  "manifest_hash",
  "view_md_hash",
  "view_bytes",
  "item_count",
  "selection_published_at_ms",
  "selection_age_ms",
  "selection_stale",
  "rendered_prompt_sha256",
  "rendered_prompt_bytes",
  "begin_fence_count",
  "end_fence_count",
  "contains_policy_stable_marker",
  "contains_compiled_marker",
  "contains_legacy_catalog_marker",
  "contains_d3_marker",
]);

export interface PropositionPolicyStableViewRuntimeAuditRow {
  schema: typeof PROPOSITION_POLICY_STABLE_VIEW_RUNTIME_AUDIT_SCHEMA;
  version: typeof PROPOSITION_POLICY_STABLE_VIEW_RUNTIME_AUDIT_VERSION;
  timestamp: string;
  pid: number;
  session_id: string;
  turn_id: number | null;
  causal_anchor: Readonly<Record<string, unknown>> | null;
  latest_user_message_id?: string;
  latest_user_text_sha256: string;
  latest_user_text_bytes: number;
  decision: "policy_stable_view_injected" | "policy_stable_view_rejected";
  reason: string;
  bundle_hash: string | null;
  manifest_hash: string | null;
  view_md_hash: string | null;
  view_bytes: number | null;
  item_count: number | null;
  selection_published_at_ms: number | null;
  selection_age_ms: number | null;
  selection_stale: boolean | null;
  rendered_prompt_sha256: string;
  rendered_prompt_bytes: number;
  begin_fence_count: number;
  end_fence_count: number;
  contains_policy_stable_marker: boolean;
  contains_compiled_marker: boolean;
  contains_legacy_catalog_marker: boolean;
  contains_d3_marker: boolean;
}

export type PropositionPolicyStableViewRuntimeAuditAppendResult =
  | { ok: true; auditFile: string; bytes: number }
  | { ok: false; auditFile: string; error: string };

export function buildPropositionPolicyStableViewRuntimeAuditRow(args: {
  sessionId: string;
  latestUserText: string;
  latestUserMessageId?: string;
  decision: PropositionPolicyStableViewRuntimeAuditRow["decision"];
  reason: string;
  renderedPrompt: string;
  readResult: PropositionPolicyStableViewRuntimeReadResult;
  nowMs?: number;
}): PropositionPolicyStableViewRuntimeAuditRow {
  const anchor = getCurrentAnchor();
  const stable = args.readResult.ok ? args.readResult : undefined;
  const diagnostic = args.readResult;
  return {
    schema: PROPOSITION_POLICY_STABLE_VIEW_RUNTIME_AUDIT_SCHEMA,
    version: PROPOSITION_POLICY_STABLE_VIEW_RUNTIME_AUDIT_VERSION,
    timestamp: new Date(args.nowMs ?? Date.now()).toISOString(),
    pid: process.pid,
    session_id: args.sessionId,
    turn_id: anchor?.session_id === args.sessionId ? anchor.turn_id : null,
    causal_anchor: anchor ? spreadAnchor(anchor) : null,
    ...(args.latestUserMessageId ? { latest_user_message_id: args.latestUserMessageId } : {}),
    latest_user_text_sha256: sha256Hex(args.latestUserText),
    latest_user_text_bytes: Buffer.byteLength(args.latestUserText, "utf8"),
    decision: args.decision,
    reason: args.reason,
    bundle_hash: diagnostic.bundleHash ?? null,
    manifest_hash: stable?.manifestHash ?? null,
    view_md_hash: stable ? sha256Hex(stable.viewMd) : null,
    view_bytes: stable?.viewBytes ?? null,
    item_count: stable?.itemCount ?? null,
    selection_published_at_ms: diagnostic.selectionPublishedAtMs ?? null,
    selection_age_ms: diagnostic.selectionAgeMs ?? null,
    selection_stale: diagnostic.selectionStale ?? null,
    rendered_prompt_sha256: sha256Hex(args.renderedPrompt),
    rendered_prompt_bytes: Buffer.byteLength(args.renderedPrompt, "utf8"),
    begin_fence_count: countLiteral(args.renderedPrompt, BEGIN_FENCE_MARKER),
    end_fence_count: countLiteral(args.renderedPrompt, END_FENCE_MARKER),
    contains_policy_stable_marker: args.renderedPrompt.includes(POLICY_STABLE_MARKER),
    contains_compiled_marker: args.renderedPrompt.includes(COMPILED_MARKER),
    contains_legacy_catalog_marker: args.renderedPrompt.includes(LEGACY_CATALOG_MARKER),
    contains_d3_marker: args.renderedPrompt.includes(D3_MARKER),
  };
}

export function appendPropositionPolicyStableViewRuntimeAudit(
  row: PropositionPolicyStableViewRuntimeAuditRow,
): PropositionPolicyStableViewRuntimeAuditAppendResult {
  const auditFile = PROPOSITION_POLICY_STABLE_VIEW_RUNTIME_AUDIT_FILE;
  let directoryFd: number | undefined;
  let fileFd: number | undefined;
  try {
    assertAuditRowAllowlist(row);
    const serialized = `${canonicalizeJcs(row)}\n`;
    const bytes = Buffer.from(serialized, "utf8");
    if (bytes.length > PROPOSITION_POLICY_STABLE_VIEW_RUNTIME_AUDIT_MAX_BYTES) {
      throw new Error("audit row exceeds the 8 MiB hard cap");
    }

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
    if (before && (before.isSymbolicLink() || !before.isFile())) {
      throw new Error("audit path exists but is not a regular non-symlink file");
    }
    fileFd = fs.openSync(
      anchoredFile,
      fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | NOFOLLOW,
      0o600,
    );
    const opened = fs.fstatSync(fileFd);
    if (!opened.isFile() || (before && (before.dev !== opened.dev || before.ino !== opened.ino))) {
      throw new Error("opened audit file identity is unsafe");
    }
    const current = fs.lstatSync(anchoredFile);
    if (current.isSymbolicLink() || !current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new Error("named audit file changed while opening");
    }
    if (process.platform !== "win32") fs.fchmodSync(fileFd, 0o600);
    if (opened.size + bytes.length > PROPOSITION_POLICY_STABLE_VIEW_RUNTIME_AUDIT_MAX_BYTES) {
      throw new Error("audit file reached the 8 MiB hard cap");
    }
    if (opened.size > 0) {
      const tail = Buffer.allocUnsafe(1);
      if (fs.readSync(fileFd, tail, 0, 1, opened.size - 1) !== 1 || tail[0] !== 0x0a) {
        throw new Error("audit file does not end at a JSONL line boundary");
      }
    }
    fs.writeFileSync(fileFd, bytes);
    fs.fsyncSync(fileFd);
    if (process.platform !== "win32") fs.fsyncSync(directoryFd);
    return { ok: true, auditFile, bytes: bytes.length };
  } catch (error) {
    return { ok: false, auditFile, error: controlledError(error) };
  } finally {
    if (fileFd !== undefined) try { fs.closeSync(fileFd); } catch { /* ignore close failure */ }
    if (directoryFd !== undefined) try { fs.closeSync(directoryFd); } catch { /* ignore close failure */ }
  }
}

function assertAuditRowAllowlist(row: PropositionPolicyStableViewRuntimeAuditRow): void {
  for (const key of Object.keys(row)) {
    if (!AUDIT_KEYS.has(key)) throw new Error(`audit row contains non-allowlisted field: ${key}`);
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
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`audit directory component is unsafe: ${current}`);
    }
  }
}

function anchoredChild(directoryFd: number, directoryStat: fs.Stats, basename: string, fallbackDirectory: string): string {
  if (path.basename(basename) !== basename || basename === "." || basename === "..") {
    throw new Error("audit basename is invalid");
  }
  if (process.platform === "linux") {
    const procDirectory = `/proc/self/fd/${directoryFd}`;
    const procStat = fs.statSync(procDirectory);
    if (procStat.isDirectory() && procStat.dev === directoryStat.dev && procStat.ino === directoryStat.ino) {
      return path.join(procDirectory, basename);
    }
  }
  return path.join(fallbackDirectory, basename);
}

function lstatMaybe(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file);
  } catch (error) {
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

function controlledError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]+/g, " ").slice(0, 512);
}
