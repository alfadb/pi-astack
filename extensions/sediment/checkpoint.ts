import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import type { SedimentSettings } from "./settings";
import {
  ensureSedimentLegacyMigrated,
  formatLocalIsoTimestamp,
  sedimentCheckpointPath,
  sedimentLocksDir,
  withFileLock,
} from "../_shared/runtime";

/**
 * Per-session checkpoint. Each pi session (identified by its sessionId)
 * has its OWN slot in the on-disk checkpoint file because session branch
 * entry IDs are not interchangeable across sessions — a `lastProcessedEntryId`
 * captured by session A is meaningless when applied to session B's branch
 * (B would fall through to the compaction-fallback path and either replay
 * everything or only the latest entry).
 */
export interface SedimentCheckpoint {
  lastProcessedEntryId?: string;
  updatedAt?: string;
}

/** On-disk format. Wraps per-session slots in a versioned envelope. */
interface CheckpointFile {
  schema_version: number;
  sessions: Record<string, SedimentCheckpoint>;
}

const CHECKPOINT_SCHEMA_VERSION = 2;
const STALE_SESSION_DAYS = 90;
const CHECKPOINT_LOCK_TIMEOUT_MS = 5_000;
const CHECKPOINT_LOCK_STEAL_AFTER_MS = 30_000;

/**
 * Slot used when migrating a v1 checkpoint that has no sessionId. The
 * first session that calls `saveSessionCheckpoint` adopts this slot's
 * lastProcessedEntryId and the slot is cleared.
 */
const LEGACY_SLOT = "_legacy";

export interface RunWindow {
  entries: unknown[];
  text: string;
  chars: number;
  totalBranchEntries: number;
  candidateEntries: number;
  includedEntries: number;
  checkpointFound: boolean;
  lastProcessedEntryId?: string;
  lastEntryId?: string;
  skipReason?: "no_new_entries" | "window_too_small";
}

export function checkpointPath(projectRoot: string): string {
  return sedimentCheckpointPath(projectRoot);
}

/**
 * Coerce any on-disk shape (v1 raw or v2 envelope) into a CheckpointFile.
 */
function upgradeCheckpoint(raw: unknown): CheckpointFile {
  if (raw && typeof raw === "object" && (raw as any).schema_version === CHECKPOINT_SCHEMA_VERSION && (raw as any).sessions) {
    return raw as CheckpointFile;
  }
  const out: CheckpointFile = { schema_version: CHECKPOINT_SCHEMA_VERSION, sessions: {} };
  if (raw && typeof raw === "object") {
    const v1 = raw as Record<string, unknown>;
    const last = typeof v1.lastProcessedEntryId === "string" ? v1.lastProcessedEntryId : undefined;
    if (last) {
      const slot = typeof v1.sessionId === "string" && v1.sessionId ? v1.sessionId : LEGACY_SLOT;
      out.sessions[slot] = {
        lastProcessedEntryId: last,
        updatedAt: typeof v1.updatedAt === "string" ? v1.updatedAt : formatLocalIsoTimestamp(),
      };
    }
  }
  return out;
}

/** Drop session slots whose `updatedAt` is more than STALE_SESSION_DAYS old. */
function pruneStaleSessions(file: CheckpointFile): CheckpointFile {
  const now = Date.now();
  const cutoffMs = STALE_SESSION_DAYS * 24 * 60 * 60 * 1000;
  const fresh: Record<string, SedimentCheckpoint> = {};
  for (const [id, sess] of Object.entries(file.sessions)) {
    if (!sess.updatedAt) { fresh[id] = sess; continue; }
    const t = Date.parse(sess.updatedAt);
    if (!Number.isFinite(t) || now - t < cutoffMs) fresh[id] = sess;
  }
  return { ...file, sessions: fresh };
}

async function loadCheckpointFile(projectRoot: string): Promise<CheckpointFile> {
  await ensureSedimentLegacyMigrated(projectRoot);
  try {
    const raw = await fs.readFile(checkpointPath(projectRoot), "utf-8");
    return upgradeCheckpoint(JSON.parse(raw));
  } catch {
    return { schema_version: CHECKPOINT_SCHEMA_VERSION, sessions: {} };
  }
}

async function atomicWriteCheckpoint(projectRoot: string, file: CheckpointFile): Promise<void> {
  const dest = checkpointPath(projectRoot);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  // Round 8 P1 (deepseek R8 audit): finally-cleanup tmp file so a crash
  // between writeFile and rename doesn't leak `checkpoint.json.tmp-*`.
  try {
    await fs.writeFile(tmp, JSON.stringify(file, null, 2) + "\n", "utf-8");
    await fs.rename(tmp, dest);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

/**
 * File-lock-protected execution to serialize concurrent read-modify-write
 * sequences across multiple pi processes sharing the same project root.
 * Steals stale locks (>30s old) to avoid deadlocks if a previous holder
 * crashed without releasing.
 */
async function withCheckpointLock<T>(projectRoot: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = path.join(sedimentLocksDir(projectRoot), "checkpoint.lock");
  return withFileLock(lockPath, {
    timeoutMs: CHECKPOINT_LOCK_TIMEOUT_MS,
    staleMs: CHECKPOINT_LOCK_STEAL_AFTER_MS,
    retryMs: 50,
    label: "checkpoint",
  }, fn);
}

/**
 * Read this session's checkpoint slot.
 *
 * - `sessionId` is required for persistence. If undefined (ephemeral pi,
 *   subprocess `--no-session`, ad-hoc CLI invocation) we return `{}` and
 *   the caller falls through to a no-checkpoint replay path. saveSession
 *   below also no-ops in that mode, so the main session's checkpoint is
 *   never corrupted by ephemeral runs.
 * - On first read, if a `_legacy` slot is present (v1 migration carry-over
 *   with no sessionId) we return its value so this session can adopt it.
 *   The slot is cleared on the next save (see saveSessionCheckpoint).
 */
export async function loadSessionCheckpoint(
  projectRoot: string,
  sessionId: string | undefined,
): Promise<SedimentCheckpoint> {
  if (!sessionId) return {};
  const file = await loadCheckpointFile(projectRoot);
  const slot = file.sessions[sessionId];
  if (slot) return slot;
  return file.sessions[LEGACY_SLOT] ?? {};
}

/**
 * Update this session's checkpoint slot. No-op when sessionId is missing
 * (ephemeral / subprocess mode).
 */
export async function saveSessionCheckpoint(
  projectRoot: string,
  sessionId: string | undefined,
  patch: SedimentCheckpoint,
): Promise<void> {
  if (!sessionId) return;
  await withCheckpointLock(projectRoot, async () => {
    let file = pruneStaleSessions(await loadCheckpointFile(projectRoot));
    // Adopt the v1 legacy slot on first save by this session, then drop it.
    if (file.sessions[LEGACY_SLOT] && !file.sessions[sessionId]) {
      file.sessions[sessionId] = file.sessions[LEGACY_SLOT];
      delete file.sessions[LEGACY_SLOT];
    }
    file.sessions[sessionId] = {
      ...(file.sessions[sessionId] || {}),
      ...patch,
      updatedAt: formatLocalIsoTimestamp(),
    };
    await atomicWriteCheckpoint(projectRoot, file);
  });
}

/**
 * @deprecated Backward-compatibility shim. New code MUST use
 * `loadSessionCheckpoint(projectRoot, sessionId)`. Reading without a
 * sessionId returns the merged latest slot (best-effort), which can be
 * the wrong session in multi-session contexts — only safe in tests with
 * a single known session.
 */
export async function loadCheckpoint(projectRoot: string): Promise<SedimentCheckpoint> {
  const file = await loadCheckpointFile(projectRoot);
  const slots = Object.values(file.sessions);
  if (slots.length === 0) return {};
  // Return the most-recently-updated slot (least surprising for tests).
  return slots.sort((a, b) => (Date.parse(b.updatedAt || "") || 0) - (Date.parse(a.updatedAt || "") || 0))[0] || {};
}

/**
 * @deprecated Backward-compatibility shim. New code MUST use
 * `saveSessionCheckpoint(projectRoot, sessionId, patch)`. This shim
 * stores the entry under the LEGACY_SLOT, which is reserved for v1
 * migration carry-overs.
 */
export async function saveCheckpoint(projectRoot: string, checkpoint: SedimentCheckpoint): Promise<void> {
  await withCheckpointLock(projectRoot, async () => {
    const file = await loadCheckpointFile(projectRoot);
    file.sessions[LEGACY_SLOT] = { ...checkpoint, updatedAt: formatLocalIsoTimestamp() };
    await atomicWriteCheckpoint(projectRoot, file);
  });
}

function entryId(entry: unknown): string | undefined {
  if (entry && typeof entry === "object" && "id" in entry) {
    const id = (entry as { id?: unknown }).id;
    return typeof id === "string" ? id : undefined;
  }
  return undefined;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const p = part as Record<string, unknown>;
    if (p.type === "text" && typeof p.text === "string") return p.text;
    if (p.type === "thinking" && typeof p.thinking === "string") return `[thinking]\n${p.thinking}`;
    if (p.type === "toolCall") return `[toolCall ${String(p.name ?? "unknown")}] ${JSON.stringify(p.arguments ?? {})}`;
    if (p.type === "image") return "[image]";
    return "";
  }).filter(Boolean).join("\n");
}

/**
 * Truncate tool output entries (toolResult, bashExecution) to prevent
 * a single large output from dominating the extractor window.
 * Head 85% + tail 15% preserved; middle replaced with marker.
 * User/assistant/compaction entries pass through untouched.
 */
function truncateEntryText(entry: unknown, rendered: string, maxChars: number): string {
  if (!maxChars || rendered.length <= maxChars) return rendered;
  if (!entry || typeof entry !== "object") return rendered;
  const e = entry as Record<string, unknown>;
  const type = typeof e.type === "string" ? e.type : "unknown";
  if (type !== "message") return rendered;
  const msg = e.message as Record<string, unknown> | undefined;
  if (!msg) return rendered;
  const role = typeof msg.role === "string" ? msg.role : "";
  if (role !== "toolResult" && role !== "bashExecution") return rendered;

  const headChars = Math.floor(maxChars * 0.85);
  const tailChars = maxChars - headChars;
  const marker = `\n[... truncated ${rendered.length - headChars - tailChars} chars at ${maxChars} cap ...]\n`;
  return rendered.slice(0, headChars) + marker + rendered.slice(rendered.length - tailChars);
}

/**
 * Tool names whose `toolResult` content MUST be withheld from sediment
 * extraction windows.
 *
 * # ADR 0027 PR-B+, R1 review P0-α
 *
 * dispatch_agent / dispatch_parallel produce L2 sub-agent reasoning text
 * that flows back to the parent session as `toolResult` entries. PR-B
 * already gates sediment's own `agent_end` handler INSIDE the sub-agent
 * (so sediment doesn't fire on the sub-agent's session at all), but the
 * PARENT session's `agent_end` still reads its own branch — including
 * these tool_result entries — when building the extraction window.
 *
 * Without this withholding, the parent's extractor LLM would see
 * sub-agent text like "Based on the user's preference for pnpm, ..."
 * and extract "user prefers pnpm" as a sediment candidate. dispatch_parallel
 * of N sub-agents → N× this pollution per turn. Worse: a sub-agent that
 * uses memory_decide will read the brain, paraphrase, return that
 * paraphrase via tool_result, and sediment would re-extract its own
 * laundered output — a self-exciting loop the echo-chamber breaker
 * (ADR 0026 §3.4) cannot detect because it watches entry usage, not
 * entry creation.
 *
 * This withholds **just the content**, not the entry itself. Sediment
 * still sees that a dispatch happened in this turn (entry id + timestamp
 * + toolName preserved in the marker line), so trace/context is intact;
 * only the sub-agent's reasoning text is replaced with an explicit
 * "[withheld]" marker.
 *
 * # Why only these two tools
 *
 * Other tools' toolResult is FACTUAL data the user is working with:
 *   - bash: command stdout/stderr (user's repo state)
 *   - web_search / web_fetch: external page content
 *   - memory_search / memory_get: brain content (already trusted)
 *   - read / grep / find / ls: filesystem facts
 *
 * These are legitimate signals about the user's working context and
 * SHOULD inform sediment learning. Only dispatch_agent/dispatch_parallel
 * results are LLM-generated sub-agent reasoning, which is L2 worker
 * artifact (not user implicit truth, per ADR 0024 INV-IMPLICIT-GROUND-TRUTH).
 *
 * # Defense layers
 *
 * This is the infra-layer cut. It's belt-and-suspenders with the
 * extractor prompt (Lane C system prompt) which also tells the LLM not
 * to extract from L2 artifacts — but prompt-layer instructions are
 * advisory, this content withhold is structural. Lane A's deterministic
 * `parseExplicitMemoryBlocks` (MEMORY:...END_MEMORY fence scan) operates
 * on the same windowText, so a sub-agent emitting `MEMORY:` blocks in
 * its output is also automatically blocked at this chokepoint.
 */
// Exported so context-packer (classifier input path) can share the SAME
// allowlist + marker (ADR 0027 PR-B+ R2 NEW-P1-A: classifier was bypassing
// this mask before because it renders toolResult independently via
// extractTextContent rather than going through entryToText). Single
// source-of-truth for what counts as an L2 fanout artifact.
export const L2_FANOUT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "dispatch_agent",
  "dispatch_parallel",
  // ADR 0030: dispatch_hub's toolResult (hub plan + worker aggregate) is L2
  // fanout output, NOT user implicit truth — withhold from sediment too.
  "dispatch_hub",
]);

export const L2_WITHHELD_MARKER =
  "[L2 sub-agent output — content withheld from sediment per ADR 0027 PR-B+ R1 P0-α; sub-agent reasoning is not user implicit truth signal]";

export function entryToText(entry: unknown): string {
  if (!entry || typeof entry !== "object") return "";
  const e = entry as Record<string, unknown>;
  const id = typeof e.id === "string" ? e.id : "no-id";
  const type = typeof e.type === "string" ? e.type : "unknown";
  const timestamp = typeof e.timestamp === "string" ? e.timestamp : "";

  if (type === "message" && e.message && typeof e.message === "object") {
    const msg = e.message as Record<string, unknown>;
    const role = typeof msg.role === "string" ? msg.role : "unknown";
    if (role === "toolResult") {
      const toolName = String(msg.toolName ?? "unknown");
      // ADR 0027 PR-B+, R1 P0-α: withhold L2 sub-agent reasoning text
      // from sediment extraction. See L2_FANOUT_TOOL_NAMES doc above.
      if (L2_FANOUT_TOOL_NAMES.has(toolName)) {
        return `--- ENTRY ${id} ${timestamp} message/toolResult:${toolName} ---\n${L2_WITHHELD_MARKER}`;
      }
      return `--- ENTRY ${id} ${timestamp} message/toolResult:${toolName} ---\n${textFromContent(msg.content)}`;
    }
    if (role === "bashExecution") {
      return `--- ENTRY ${id} ${timestamp} message/bashExecution ---\ncommand: ${String(msg.command ?? "")}\nexitCode: ${String(msg.exitCode ?? "")}\n${String(msg.output ?? "")}`;
    }
    return `--- ENTRY ${id} ${timestamp} message/${role} ---\n${textFromContent(msg.content)}`;
  }

  if (type === "compaction" || type === "branch_summary") {
    return `--- ENTRY ${id} ${timestamp} ${type} ---\n${String(e.summary ?? "")}`;
  }

  if (type === "custom_message") {
    return `--- ENTRY ${id} ${timestamp} custom_message:${String(e.customType ?? "unknown")} ---\n${textFromContent(e.content)}`;
  }

  return `--- ENTRY ${id} ${timestamp} ${type} ---\n${JSON.stringify(e)}`;
}

export function buildRunWindow(
  branch: unknown[],
  checkpoint: SedimentCheckpoint,
  settings: SedimentSettings,
): RunWindow {
  const lastProcessed = checkpoint.lastProcessedEntryId;
  const ids = branch.map(entryId);
  const lastIndex = lastProcessed ? ids.indexOf(lastProcessed) : -1;
  const checkpointFound = !lastProcessed || lastIndex >= 0;

  let candidates: unknown[];
  if (!lastProcessed) {
    candidates = branch;
  } else if (lastIndex >= 0) {
    candidates = branch.slice(lastIndex + 1);
  } else {
    // Compaction/branch fallback: avoid replaying an entire old branch if the
    // checkpoint disappeared. Keep only the latest entry as a conservative window.
    candidates = branch.length > 0 ? [branch[branch.length - 1]] : [];
  }

  if (candidates.length === 0) {
    return {
      entries: [],
      text: "",
      chars: 0,
      totalBranchEntries: branch.length,
      candidateEntries: 0,
      includedEntries: 0,
      checkpointFound,
      lastProcessedEntryId: lastProcessed,
      skipReason: "no_new_entries",
    };
  }

  const maxEntries = Math.max(1, settings.maxWindowEntries);
  const limitedByCount = candidates.slice(-maxEntries);
  const selectedNewestFirst: unknown[] = [];
  let chars = 0;

  for (let i = limitedByCount.length - 1; i >= 0; i--) {
    const entry = limitedByCount[i];
    const rawRendered = entryToText(entry);
    const rendered = truncateEntryText(entry, rawRendered, settings.maxEntryChars);
    if (selectedNewestFirst.length > 0 && chars + rendered.length > settings.maxWindowChars) break;
    selectedNewestFirst.push(entry);
    chars += rendered.length;
    if (chars >= settings.maxWindowChars) break;
  }

  const entries = selectedNewestFirst.reverse();
  const text = entries.map((entry) => truncateEntryText(entry, entryToText(entry), settings.maxEntryChars)).join("\n\n");
  const lastEntryId = entryId(entries[entries.length - 1]);
  const finalChars = text.length;

  return {
    entries,
    text,
    chars: finalChars,
    totalBranchEntries: branch.length,
    candidateEntries: candidates.length,
    includedEntries: entries.length,
    checkpointFound,
    lastProcessedEntryId: lastProcessed,
    lastEntryId,
    skipReason: finalChars < settings.minWindowChars ? "window_too_small" : undefined,
  };
}

export function checkpointSummary(window: RunWindow) {
  return {
    totalBranchEntries: window.totalBranchEntries,
    candidateEntries: window.candidateEntries,
    includedEntries: window.includedEntries,
    chars: window.chars,
    checkpointFound: window.checkpointFound,
    lastProcessedEntryId: window.lastProcessedEntryId,
    lastEntryId: window.lastEntryId,
    skipReason: window.skipReason,
  };
}
