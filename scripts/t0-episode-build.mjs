#!/usr/bin/env node
/**
 * t0-episode-build — T0 historical evaluation pipeline.
 *
 * Builds a strict same-question production episode dataset from the dispatch
 * audit log (`.pi-astack/dispatch/audit.jsonl` + rotated archive) joined to
 * the parent pi session JSONL transcripts.
 *
 * Episode definition (strict):
 *   within ONE dispatch_parallel call, tasks whose (prompt verbatim, thinking
 *   level, tools allowlist) are byte-identical AND that span >= 2 distinct
 *   underlying models.
 *
 * Blind review safety (v2):
 *   - There is NO global model-id map. Each episode assigns its own
 *     randomized candidate ids (c0..cN) to the slot models, derived from a
 *     random blind key that lives ONLY in `blind-key.json` inside the output
 *     directory (never fed to a judge). A self-report in one episode cannot
 *     be correlated with any other episode.
 *   - Model names, basenames, family/alias tokens, leaky version fragments
 *     (k2-thinking, M2.7, for-coding, ...) and residual old-style ids (mN)
 *     mentioned in prompt/output text are replaced with episode-local stable
 *     pseudonyms ([model-a], [model-b], ...) that preserve referential
 *     distinction between different entities without revealing identity.
 *   - Roster-order safety: the body slot array is a fresh random permutation
 *     per episode (blind key + episode id), slot ids are random hashes, and
 *     the body carries NO task_index — the original dispatch roster order
 *     cannot be recovered from the body. The sidecar keeps the
 *     slot_id -> model/task_index mapping for the builder/aggregator only.
 *   - Bare context-ambiguous identity tokens (K2, M3, M2, K3, v4-pro, v4pro)
 *     are NEVER mechanically replaced: they could be model identities OR
 *     ordinary text (e.g. M1/M2/M3 evaluation criteria). When a bare
 *     occurrence (not part of a longer known model/family token) is found in
 *     the raw prompt/output, the whole episode is fail-closed excluded and
 *     recorded with `ambiguous_identity_token` in exclusions.jsonl — the
 *     token is never guessed.
 *   - Rebuilding into the same output directory reuses `blind-key.json` and
 *     is byte-deterministic. A new directory reproduces the same dataset with
 *     `--blind-key <hex>` or `--seed <n>`.
 *
 * Judge-feed contract: the judge-feed API (the ONLY interface between this
 * dataset and an anonymous judge) is contractually limited to reading
 * episodes.jsonl. The sidecar (episodes.meta.jsonl) in the same directory is
 * for the builder/aggregator only. The judge's runtime disables tools, so a
 * judge cannot read the filesystem; the contract keeps the feed path itself
 * from ever exposing identity material.
 *
 * Dataset mode:
 *   The blind body declares `dataset_mode`. The current production set has no
 *   thinking text and no tool-call trajectory, so it is built as
 *   `final_answer_only`: the body carries only final answers and the dead
 *   thinking / tool_calls / final_stop_reason fields are omitted. Slots with
 *   result != ok, partial tool results, or empty output never enter the
 *   capability body; they are kept in the identity sidecar and counted in the
 *   availability statistics. Episodes that fall below the min-models bar
 *   after that filtering are excluded as a whole but still write sidecar
 *   records and count into the availability statistics.
 *
 * Join strategy:
 *   - exact: audit rows carrying `dispatch_tool_call_id` (audit v3+) are
 *     joined to the parent session toolCall by id; prompt_chars is verified
 *     against the recovered prompt length.
 *   - heuristic: legacy rows (audit v1/v2, no tool_call_id) are joined only
 *     when the parent session can verbatim-recover the task prompt (non-null
 *     taskSpec.prompt) AND exactly ONE session toolCall matches
 *     (model/thinking/tools/prompt_chars/task_count + timestamp ordering).
 *     Any multi-candidate join is excluded — the binding is not reliable, so
 *     the prompt cannot be verbatim-confirmed. This is a heuristic, not a
 *     verified join: the audit row only records prompt_chars (a length), so
 *     the prompt text itself is never confirmed against the audit.
 *
 * Privacy: this script reads ONLY the dispatch audit logs and the parent
 * session JSONL transcripts. It never opens auth.json / secrets.json / API
 * key material. The blind-review episode body (episodes.jsonl) keeps only
 * judge-necessary, de-identified evidence; usage/cost/tokens/duration/audit
 * metadata (pid, session id, run id, trace paths, timestamps) and the real
 * model names are written ONLY to the sidecar (episodes.meta.jsonl).
 * Tool-call args/results recovered from the dispatch trace are size-capped
 * before being written.
 *
 * Resource bounds (configurable, fail-closed):
 *   --max-output-bytes  per-slot output cap (truncated with a marker)
 *   --max-episode-bytes per-episode body cap (episode excluded, fail-closed)
 *   --max-total-bytes   total episodes.jsonl cap (build aborts, fail-closed)
 *
 * Usage:
 *   node scripts/t0-episode-build.mjs [options]
 *
 * Options:
 *   --project-root <path>   pi config repo root (default: ~/.pi)
 *   --sessions-root <path>  parent session transcript dir (default:
 *                           <agentDir>/sessions; agentDir = PI_CODING_AGENT_DIR
 *                           or <project-root>/agent). Never scans HOME.
 *   --audit <path>          dispatch audit jsonl (default:
 *                           <project-root>/.pi-astack/dispatch/audit.jsonl)
 *   --archive-dir <path>    rotated audit dir (default:
 *                           <project-root>/.pi-astack/dispatch/archive)
 *   --no-archive            skip rotated audit logs
 *   --since <ISO>           episode selection: every slot timestamp >= since
 *   --until <ISO>           episode selection: every slot timestamp <= until
 *   --models <csv>          episode selection: every slot model in the list
 *   --output <dir>          output dir (default:
 *                           <project-root>/.pi-astack/t0-episodes)
 *   --min-models <n>        min distinct models per episode (default: 2)
 *   --blind-key <hex>       explicit 64-hex blind key (reproducibility)
 *   --seed <n>              derive the blind key from a seed (reproducibility)
 *   --max-tool-result-bytes <n>  per-call tool result cap (default: 4096)
 *   --max-tool-args-bytes <n>    per-call tool args cap (default: 1024)
 *   --max-output-bytes <n>  per-slot output cap (default: 200000)
 *   --max-episode-bytes <n> per-episode body cap (default: 1000000)
 *   --max-total-bytes <n>   total episodes.jsonl cap (default: 500000000)
 *   --quiet                 suppress per-episode summary lines
 *
 * The models/time filters are applied AFTER full call/group reconstruction as
 * episode selection conditions (an episode is kept only if EVERY slot passes),
 * so a call is never split by the filter.
 *
 * Outputs (all deterministic for a fixed input + blind key):
 *   episodes.jsonl      blind-review episode bodies (de-identified) — the
 *                       ONLY file that may be fed to an anonymous judge
 *   episodes.meta.jsonl sidecar: per-slot identity + runtime/audit metadata
 *   blind-key.json      the random blind key (never fed to a judge)
 *   exclusions.jsonl    rows/episodes excluded from the strict set, with reasons
 *   stats.json          reproducible statistics
 *   README.md           judge-feedable rules + dataset mode + reproducibility
 */

import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DISPATCH_TRACE_CUSTOM_TYPE = "pi-astack/dispatch-trace/v1";
export const EPISODE_SCHEMA_VERSION = 3;
export const BLIND_KEY_FILE = "blind-key.json";
export const BLIND_KEY_HEX_LENGTH = 64;
export const DEFAULT_MIN_MODELS = 2;
export const DEFAULT_MAX_TOOL_RESULT_BYTES = 4096;
export const DEFAULT_MAX_TOOL_ARGS_BYTES = 1024;
export const DEFAULT_MAX_OUTPUT_BYTES = 200_000;
export const DEFAULT_MAX_EPISODE_BYTES = 1_000_000;
export const DEFAULT_MAX_TOTAL_BYTES = 500_000_000;
export const TRUNCATED_MARKER = "[truncated]";
/** Defensive fallback for residual mN ids not seen during the pre-scan. */
export const GENERIC_RESIDUAL_PSEUDONYM = "[model-unknown]";

/**
 * Family/alias tokens that identify a model family even when the canonical
 * name is absent (e.g. "Claude Opus", "DeepSeek V4", "Kimi K2.7", "Grok 4.5",
 * "MiniMax M3", "GLM 5.2", abbreviated aliases like "opusA"/"opusB", and
 * provider routes like "github-copilot"). Matched word-boundary,
 * case-insensitive, longest-first. Bare version tokens that collide with
 * ordinary text ("v4" in "schema v4", "pro" in "pros and cons", "code",
 * "256k") are deliberately NOT listed — they are covered by the longer
 * basename/alias tokens instead. "M3" is also NOT listed: it is handled by
 * AMBIGUOUS_IDENTITY_TOKENS (it is ambiguous with numbered criteria, so it
 * fails the episode closed instead of being guessed).
 */
export const FAMILY_TOKENS = [
  // providers / routes
  "openai", "anthropic", "xai", "moonshotai", "kimi-coding", "zai-coding-cn", "minimax", "deepseek", "moonshot",
  "github-copilot", "google", "xiaomi", "cloudflare-workers-ai", "mistralai", "gemini",
  // families
  "claude", "gpt", "kimi", "grok", "glm",
  // subfamilies / variants
  "opus", "sonnet", "haiku", "fable", "flash", "sol", "terra", "luna", "mini", "codex", "spark",
  "k2.7", "k2.6", "opusA", "opusB", "Z.ai",
  // family+version prefixes (dash and space forms)
  "claude-opus", "claude opus", "claude-sonnet", "claude sonnet", "claude-haiku", "claude haiku", "claude-fable", "claude fable",
  "gpt-5.6", "gpt 5.6", "gpt-5.5", "gpt 5.5", "gpt-5.4", "gpt 5.4", "gpt-5.3", "gpt 5.3",
  "deepseek-v4", "deepseek v4", "kimi-k2.7", "kimi k2.7", "kimi-k2.6", "kimi k2.6",
  "grok-4.5", "grok 4.5", "glm-5.2", "glm 5.2", "glm-5.1", "glm 5.1", "minimax-m3", "minimax m3",
  "k3-256k", "k3 256k", "codex-spark", "codex spark",
];

/**
 * Bare context-ambiguous identity tokens. These tokens could be model
 * identities (K2 = Kimi K2, M3/M2 = MiniMax-M3/M2, K3 = kimi-coding/k3,
 * v4-pro/v4pro = deepseek-v4-pro) OR ordinary text (M1/M2/M3 evaluation
 * criteria, K1/K2/K3 criteria, a generic "v4-pro" version). They are NEVER
 * mechanically replaced — replacing them either leaks identity (if the token
 * is a model) or damages semantics (if it is ordinary text). When a bare
 * occurrence (not part of a longer known model/family token) is found in the
 * raw prompt/output, the whole episode is fail-closed excluded and recorded
 * with `ambiguous_identity_token` in exclusions.jsonl.
 */
export const AMBIGUOUS_IDENTITY_TOKENS = ["K2", "M3", "M2", "K3", "v4-pro", "v4pro"];

/**
 * Standalone version fragments that identify a model even when the canonical
 * name is absent. These are the observed leaky fragments in the production
 * corpus ("M2.7" = MiniMax-M2.7, "k2-thinking" = kimi-k2-thinking,
 * "for-coding" = kimi-for-coding, "5-mini" = gpt-5-mini, "5-pro" = gpt-5.5-pro).
 * Tokens already covered by FAMILY_TOKENS (k3-256k, codex-spark) are not
 * repeated here. Generic version numbers ("4-8", "5.6", "2.7") are NOT
 * listed: they collide with ordinary text (section numbers, percentages,
 * UUIDs) and are instead covered by full basename redaction. Context-
 * ambiguous fragments (M3, M2, K2, K3, v4-pro, v4pro) are NOT listed here —
 * they live in AMBIGUOUS_IDENTITY_TOKENS and fail the episode closed instead
 * of being guessed.
 */
export const LEAK_FRAGMENT_TOKENS = [
  "M2.7", "k2-thinking", "for-coding", "5-mini", "5-pro",
];

// ── small helpers ─────────────────────────────────────────────────────────

export function sha256Hex(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function hmacHex(key, data) {
  return createHmac("sha256", key).update(String(data), "utf8").digest("hex");
}

/** Deterministic dispatch-trace run id (mirrors extensions/dispatch/dispatch-trace.ts). */
export function computeDispatchRunId(parentSessionId, parentToolCallId, taskIndex) {
  const ns = String(parentSessionId ?? "");
  const tool = String(parentToolCallId ?? "");
  const idx = Number.isFinite(taskIndex) ? Math.max(0, Math.floor(taskIndex)) : 0;
  const digest = createHash("sha256")
    .update(ns, "utf8")
    .update("\0", "utf8")
    .update(tool, "utf8")
    .update("\0", "utf8")
    .update(String(idx), "utf8")
    .digest("hex");
  return `dtr_${digest.slice(0, 24)}`;
}

/** UTF-8 byte-safe tail truncation with an explicit marker. */
export function truncateUtf8Tail(value, maxBytes) {
  const text = String(value ?? "");
  if (maxBytes <= 0) return "";
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  if (maxBytes <= TRUNCATED_MARKER.length) return TRUNCATED_MARKER.slice(0, maxBytes);
  const budget = maxBytes - TRUNCATED_MARKER.length;
  let start = Math.max(0, buf.length - budget);
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return `${TRUNCATED_MARKER}${buf.subarray(start).toString("utf8")}`;
}

export function utf8ByteLength(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function parseIso(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── CLI ───────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const args = { ...argv };
  const out = {
    projectRoot: args["project-root"] ? path.resolve(args["project-root"]) : undefined,
    sessionsRoot: args["sessions-root"] ? path.resolve(args["sessions-root"]) : undefined,
    audit: args.audit ? path.resolve(args.audit) : undefined,
    archiveDir: args["archive-dir"] ? path.resolve(args["archive-dir"]) : undefined,
    noArchive: args["no-archive"] === true,
    since: parseIso(args.since),
    until: parseIso(args.until),
    models: typeof args.models === "string" && args.models.trim()
      ? args.models.split(",").map((m) => m.trim()).filter(Boolean)
      : undefined,
    output: args.output ? path.resolve(args.output) : undefined,
    minModels: Number.isFinite(Number(args["min-models"])) ? Math.max(2, Math.floor(Number(args["min-models"]))) : DEFAULT_MIN_MODELS,
    blindKey: typeof args["blind-key"] === "string" && args["blind-key"].trim() ? args["blind-key"].trim() : undefined,
    seed: args.seed !== undefined && args.seed !== true && String(args.seed).trim() !== "" ? String(args.seed) : undefined,
    maxToolResultBytes: Number.isFinite(Number(args["max-tool-result-bytes"]))
      ? Math.max(0, Math.floor(Number(args["max-tool-result-bytes"])))
      : DEFAULT_MAX_TOOL_RESULT_BYTES,
    maxToolArgsBytes: Number.isFinite(Number(args["max-tool-args-bytes"]))
      ? Math.max(0, Math.floor(Number(args["max-tool-args-bytes"])))
      : DEFAULT_MAX_TOOL_ARGS_BYTES,
    maxOutputBytes: Number.isFinite(Number(args["max-output-bytes"]))
      ? Math.max(0, Math.floor(Number(args["max-output-bytes"])))
      : DEFAULT_MAX_OUTPUT_BYTES,
    maxEpisodeBytes: Number.isFinite(Number(args["max-episode-bytes"]))
      ? Math.max(0, Math.floor(Number(args["max-episode-bytes"])))
      : DEFAULT_MAX_EPISODE_BYTES,
    maxTotalBytes: Number.isFinite(Number(args["max-total-bytes"]))
      ? Math.max(0, Math.floor(Number(args["max-total-bytes"])))
      : DEFAULT_MAX_TOTAL_BYTES,
    quiet: args.quiet === true,
  };
  const home = path.resolve(process.env.HOME || os.homedir());
  out.projectRoot = out.projectRoot ?? path.join(home, ".pi");
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(out.projectRoot, "agent");
  out.sessionsRoot = out.sessionsRoot ?? path.join(agentDir, "sessions");
  out.audit = out.audit ?? path.join(out.projectRoot, ".pi-astack", "dispatch", "audit.jsonl");
  out.archiveDir = out.archiveDir ?? path.join(out.projectRoot, ".pi-astack", "dispatch", "archive");
  out.output = out.output ?? path.join(out.projectRoot, ".pi-astack", "t0-episodes");
  return out;
}

function parseCli(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return parseArgs(args);
}

// ── blind key ─────────────────────────────────────────────────────────────

/**
 * Resolve the blind key for an output directory.
 *
 * Precedence: explicit `--blind-key` > `--seed` > existing `blind-key.json`
 * in the output dir (deterministic rebuild) > freshly generated random key.
 *
 * Returns { key, source } where source is what the stats should record. When
 * the key is reused from an existing file, the file's own source field is
 * returned so repeated builds produce byte-identical stats.
 */
export function resolveBlindKey(outputDir, options) {
  if (typeof options.blindKey === "string" && options.blindKey.trim()) {
    const key = options.blindKey.trim().toLowerCase();
    if (!new RegExp(`^[0-9a-f]{${BLIND_KEY_HEX_LENGTH}}$`).test(key)) {
      throw new Error(`--blind-key must be ${BLIND_KEY_HEX_LENGTH} hex chars, got ${key.length} chars`);
    }
    return { key, source: "explicit" };
  }
  if (options.seed !== undefined && options.seed !== null && String(options.seed).trim() !== "") {
    return {
      key: createHash("sha256").update(`t0-episode-blind-key\0seed\0${options.seed}`, "utf8").digest("hex"),
      source: "seed",
    };
  }
  const keyFile = path.join(outputDir, BLIND_KEY_FILE);
  if (fs.existsSync(keyFile)) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(keyFile, "utf8"));
    } catch {
      throw new Error(`blind-key.json exists but is not valid JSON: ${keyFile}`);
    }
    if (typeof parsed?.blind_key === "string" && new RegExp(`^[0-9a-f]{${BLIND_KEY_HEX_LENGTH}}$`, "i").test(parsed.blind_key)) {
      return { key: parsed.blind_key.toLowerCase(), source: typeof parsed.source === "string" ? parsed.source : "reused" };
    }
    throw new Error(`blind-key.json exists but has no valid blind_key: ${keyFile}`);
  }
  return { key: randomBytes(BLIND_KEY_HEX_LENGTH / 2).toString("hex"), source: "generated" };
}

// ── audit loading ─────────────────────────────────────────────────────────

export function loadAuditRows(options) {
  const files = [options.audit];
  if (!options.noArchive && fs.existsSync(options.archiveDir)) {
    const archived = fs.readdirSync(options.archiveDir)
      .filter((name) => name.endsWith(".jsonl") && !name.endsWith(".generation.json"))
      .sort()
      .map((name) => path.join(options.archiveDir, name));
    files.push(...archived);
  }
  const rows = [];
  const fileStats = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let count = 0;
    const raw = fs.readFileSync(file, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (!asRecord(row)) continue;
      if (row.operation !== "dispatch_parallel.task") continue;
      count++;
      rows.push(row);
    }
    fileStats.push({ file, rows: count });
  }
  return { rows, fileStats };
}

/**
 * Episode-level model/time filter. Applied AFTER full call/group reconstruction
 * so a call is never split: an episode is kept only if EVERY slot passes the
 * filter. Returns the selected episodes plus the filtered-out ones (for stats).
 */
export function applyEpisodeFilters(episodes, options) {
  const selected = [];
  const timeFiltered = [];
  const modelFiltered = [];
  for (const episode of episodes) {
    const timeOk = episode.slots.every((slot) => {
      const ts = slot.row.timestamp;
      if (!ts) return true;
      if (options.since && ts < options.since) return false;
      if (options.until && ts > options.until) return false;
      return true;
    });
    if (!timeOk) {
      timeFiltered.push(episode);
      continue;
    }
    const modelOk = episode.slots.every((slot) => !options.models || options.models.includes(slot.row.model));
    if (!modelOk) {
      modelFiltered.push(episode);
      continue;
    }
    selected.push(episode);
  }
  return { episodes: selected, timeFiltered, modelFiltered };
}

// ── session indexing ──────────────────────────────────────────────────────

/**
 * Index parent session transcripts. Bounded: only `sessionsRoot` is scanned
 * (never HOME), and only files whose session id is referenced by audit rows
 * are read. Extracts dispatch_parallel toolCalls (id, timestamp, tasks).
 */
export function indexSessions(sessionsRoot, neededSessionIds) {
  const index = new Map();
  if (!fs.existsSync(sessionsRoot)) return index;
  const wanted = new Set(neededSessionIds);
  const entries = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(sessionsRoot, entry.name);
    let names;
    try {
      names = fs.readdirSync(dirPath);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const sessionId = name.slice(name.lastIndexOf("_") + 1, -".jsonl".length);
      if (!wanted.has(sessionId)) continue;
      const filePath = path.join(dirPath, name);
      const { toolCalls, toolResults } = extractToolCalls(filePath);
      index.set(sessionId, { path: filePath, toolCalls, toolResults });
    }
  }
  return index;
}

function extractToolCalls(filePath) {
  const toolCalls = [];
  const toolResults = new Map(); // toolCallId -> { text, timestamp }
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row?.type !== "message") continue;
    const message = row.message;
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    if (message.role === "toolResult" && message.toolName === "dispatch_parallel" && message.toolCallId) {
      const text = content
        .filter((part) => asRecord(part)?.type === "text")
        .map((part) => String(part.text ?? ""))
        .join("");
      toolResults.set(String(message.toolCallId), { text, timestamp: row.timestamp ?? "" });
      continue;
    }
    for (const part of content) {
      if (!asRecord(part)) continue;
      const type = part.type;
      if (type !== "toolCall" && type !== "tool_use" && type !== "tool_call") continue;
      if (part.name !== "dispatch_parallel") continue;
      const args = part.arguments ?? part.args;
      if (!asRecord(args) || !Array.isArray(args.tasks)) continue;
      toolCalls.push({
        id: String(part.id ?? ""),
        timestamp: row.timestamp ?? "",
        tasks: args.tasks.map((task) => ({
          name: task?.name ?? null,
          model: task?.model ?? null,
          thinking: task?.thinking ?? null,
          tools: task?.tools ?? null,
          prompt: task?.prompt ?? null,
        })),
      });
    }
  }
  return { toolCalls, toolResults };
}

// ── join ──────────────────────────────────────────────────────────────────

export function joinRows(rows, sessionIndex) {
  const joined = [];
  const excluded = [];
  for (const row of rows) {
    const sessionId = row.session_id;
    const session = sessionIndex.get(sessionId);
    if (!session) {
      excluded.push({ row, reason: "session_file_missing" });
      continue;
    }
    const toolCallId = row.dispatch_tool_call_id;
    if (toolCallId) {
      const toolCall = session.toolCalls.find((tc) => tc.id === toolCallId);
      if (!toolCall) {
        excluded.push({ row, reason: "tool_call_not_found" });
        continue;
      }
      const taskIndex = row.task_index;
      const taskSpec = toolCall.tasks[taskIndex];
      if (!taskSpec) {
        excluded.push({ row, reason: "task_index_out_of_range" });
        continue;
      }
      if (taskSpec.prompt == null) {
        excluded.push({ row, reason: "prompt_missing_in_session" });
        continue;
      }
      if (typeof row.prompt_chars === "number" && taskSpec.prompt.length !== row.prompt_chars) {
        excluded.push({ row, reason: "prompt_chars_mismatch" });
        continue;
      }
      joined.push({
        row,
        toolCallId,
        taskSpec,
        joinConfidence: "exact",
        joinNote: "exact (tool-call id)",
      });
    } else {
      const heuristic = heuristicJoin(session, row);
      if (!heuristic.ok) {
        excluded.push({ row, reason: heuristic.reason });
        continue;
      }
      joined.push({
        row,
        toolCallId: heuristic.toolCallId,
        taskSpec: heuristic.taskSpec,
        joinConfidence: "heuristic",
        joinNote: heuristic.note,
      });
    }
  }
  return { joined, excluded };
}

/**
 * Legacy join for audit rows without dispatch_tool_call_id (v1/v2).
 * Session-scoped: candidates are dispatch_parallel toolCalls where
 * tasks[task_index] matches (model, thinking, tools-if-present,
 * prompt_chars, task_count) and the toolCall timestamp is <= the audit row
 * timestamp. The prompt is verbatim-recoverable only when the candidate
 * taskSpec carries a non-null prompt; the binding is reliable only when
 * EXACTLY ONE candidate exists. Any multi-candidate join is excluded — the
 * audit row records only prompt_chars (a length), so the prompt text cannot
 * be verbatim-confirmed against the audit; this is a heuristic, not a
 * verified join.
 */
export function heuristicJoin(session, row) {
  const taskIndex = row.task_index;
  const candidates = [];
  for (const toolCall of session.toolCalls) {
    const taskSpec = toolCall.tasks[taskIndex];
    if (!taskSpec) continue;
    if (taskSpec.model !== row.model) continue;
    if (taskSpec.thinking !== row.thinking) continue;
    if (row.tools != null && taskSpec.tools != null && taskSpec.tools !== row.tools) continue;
    if (taskSpec.prompt == null) continue;
    if (typeof row.prompt_chars === "number" && taskSpec.prompt.length !== row.prompt_chars) continue;
    if (toolCall.timestamp && row.timestamp && toolCall.timestamp > row.timestamp) continue;
    if (typeof row.task_count === "number" && toolCall.tasks.length !== row.task_count) continue;
    candidates.push({ toolCall, taskSpec });
  }
  if (candidates.length === 0) {
    return { ok: false, reason: "heuristic_no_match" };
  }
  if (candidates.length > 1) {
    return { ok: false, reason: "heuristic_ambiguous" };
  }
  const best = candidates[0];
  return {
    ok: true,
    toolCallId: best.toolCall.id,
    taskSpec: best.taskSpec,
    note: "unique match (model/thinking/tools/prompt_chars)",
  };
}

// ── grouping ──────────────────────────────────────────────────────────────

/**
 * Group joined slots within the same dispatch_parallel call by
 * (prompt verbatim, thinking level, tools allowlist). Returns groups that
 * span >= minModels distinct models.
 *
 * The call key is (sessionId, toolCallId) — toolCall ids are not guaranteed
 * unique across sessions. The group key distinguishes null from empty string
 * (a null thinking/tools is NOT the same as an explicitly empty one).
 */
export function groupSlots(joined, minModels = DEFAULT_MIN_MODELS) {
  const byCall = new Map();
  for (const slot of joined) {
    const callKey = `${slot.row.session_id}\u0000${slot.toolCallId}`;
    let call = byCall.get(callKey);
    if (!call) {
      call = { callKey, toolCallId: slot.toolCallId, sessionId: slot.row.session_id, groups: new Map() };
      byCall.set(callKey, call);
    }
    const key = JSON.stringify([slot.taskSpec.prompt, slot.taskSpec.thinking, slot.taskSpec.tools]);
    let group = call.groups.get(key);
    if (!group) {
      group = { key, prompt: slot.taskSpec.prompt, thinking: slot.taskSpec.thinking ?? null, tools: slot.taskSpec.tools ?? null, slots: [] };
      call.groups.set(key, group);
    }
    group.slots.push(slot);
  }
  const episodes = [];
  const belowMin = [];
  for (const call of byCall.values()) {
    for (const group of call.groups.values()) {
      const models = new Set(group.slots.map((s) => s.row.model));
      if (models.size >= minModels) {
        episodes.push({ ...group, sessionId: call.sessionId, toolCallId: call.toolCallId });
      } else {
        belowMin.push({ ...group, sessionId: call.sessionId, toolCallId: call.toolCallId, modelCount: models.size });
      }
    }
  }
  const byCallKey = (a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : a.toolCallId < b.toolCallId ? -1 : a.toolCallId > b.toolCallId ? 1 : 0);
  episodes.sort(byCallKey);
  belowMin.sort(byCallKey);
  return { episodes, belowMin };
}

// ── trace recovery ────────────────────────────────────────────────────────

/**
 * Re-read session files that contain episodes and extract dispatch-trace
 * events for the needed (sessionId, runId) pairs. Returns
 * Map<`${sessionId}\u0000${runId}`, events[]>.
 */
export function extractTraceEvents(sessionIndex, neededKeys) {
  const bySession = new Map();
  for (const key of neededKeys) {
    const [sessionId, runId] = key.split("\u0000");
    let set = bySession.get(sessionId);
    if (!set) {
      set = new Set();
      bySession.set(sessionId, set);
    }
    set.add(runId);
  }
  const out = new Map();
  for (const [sessionId, runIds] of bySession) {
    const session = sessionIndex.get(sessionId);
    if (!session) continue;
    const events = extractTraceEventsFromFile(session.path, runIds);
    for (const [runId, list] of events) {
      out.set(`${sessionId}\u0000${runId}`, list);
    }
  }
  return out;
}

function extractTraceEventsFromFile(filePath, runIds) {
  const wanted = new Set(runIds);
  const rawEvents = new Map(); // `${runId}\u0000${eventSeq}` -> fragments[]
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row?.type !== "custom" || row.customType !== DISPATCH_TRACE_CUSTOM_TYPE) continue;
    const data = asRecord(row.data);
    if (!data || data.recordType !== "event") continue;
    if (!wanted.has(data.runId)) continue;
    const key = `${data.runId}\u0000${data.eventSeq}`;
    let fragments = rawEvents.get(key);
    if (!fragments) {
      fragments = [];
      rawEvents.set(key, fragments);
    }
    fragments.push({
      fragmentIndex: data.fragmentIndex ?? 0,
      fragmentCount: data.fragmentCount ?? 1,
      payload: data.payload ?? null,
      payloadFragment: data.payloadFragment ?? null,
      eventKind: data.eventKind,
      createdAt: data.createdAt,
    });
  }
  const out = new Map();
  for (const [key, fragments] of rawEvents) {
    const [runId] = key.split("\u0000");
    fragments.sort((a, b) => a.fragmentIndex - b.fragmentIndex);
    const payload = reassemblePayload(fragments);
    if (payload === null) continue;
    let list = out.get(runId);
    if (!list) {
      list = [];
      out.set(runId, list);
    }
    list.push({
      eventKind: fragments[0].eventKind,
      eventSeq: Number(key.split("\u0000")[1]),
      createdAt: fragments[0].createdAt,
      payload,
    });
  }
  for (const list of out.values()) {
    list.sort((a, b) => a.eventSeq - b.eventSeq);
  }
  return out;
}

export function reassemblePayload(fragments) {
  if (fragments.length === 0) return null;
  if (fragments.some((f) => f.payloadFragment != null)) {
    const joined = fragments.map((f) => f.payloadFragment ?? "").join("");
    try {
      return JSON.parse(joined);
    } catch {
      return { reassembly_failed: true };
    }
  }
  return fragments[0].payload ?? null;
}

/**
 * Recover per-slot evidence from dispatch-trace events: the production
 * AgentResult output (the LAST non-empty assistant turn — intermediate
 * assistant messages are tool-use announcements, not the final answer),
 * thinking text, and the paired tool-call trajectory. Size caps apply to
 * tool args/results only.
 */
export function recoverTraceEvidence(events, options) {
  const assistant = [];
  const thinking = [];
  const toolCalls = [];
  const toolResults = new Map();
  for (const event of events) {
    const payload = asRecord(event.payload);
    if (!payload) continue;
    if (event.eventKind === "assistant_message") {
      assistant.push({ text: String(payload.text ?? ""), stopReason: payload.stopReason ?? null, eventSeq: event.eventSeq });
    } else if (event.eventKind === "thinking") {
      thinking.push({ text: String(payload.text ?? ""), eventSeq: event.eventSeq });
    } else if (event.eventKind === "tool_call") {
      toolCalls.push({
        name: String(payload.name ?? "unknown"),
        id: String(payload.id ?? ""),
        args: payload.args ?? null,
        eventSeq: event.eventSeq,
      });
    } else if (event.eventKind === "tool_result") {
      toolResults.set(String(payload.id ?? ""), {
        name: String(payload.name ?? "unknown"),
        result: payload.result ?? null,
        isError: payload.isError === true,
        eventSeq: event.eventSeq,
      });
    }
  }
  assistant.sort((a, b) => a.eventSeq - b.eventSeq);
  thinking.sort((a, b) => a.eventSeq - b.eventSeq);
  toolCalls.sort((a, b) => a.eventSeq - b.eventSeq);

  const nonEmpty = assistant.filter((a) => a.text.length > 0);
  const output = nonEmpty.length > 0 ? nonEmpty[nonEmpty.length - 1].text : "";
  const finalStopReason = nonEmpty.length > 0
    ? nonEmpty[nonEmpty.length - 1].stopReason
    : (assistant.length > 0 ? assistant[assistant.length - 1].stopReason : null);
  const thinkingText = thinking.map((t) => t.text).join("");

  const trajectory = [];
  for (const call of toolCalls) {
    const result = toolResults.get(call.id);
    trajectory.push({
      name: call.name,
      args: capJson(call.args, options.maxToolArgsBytes),
      result: capJson(result?.result ?? null, options.maxToolResultBytes),
      isError: result?.isError === true,
    });
  }
  return { output, thinking: thinkingText, finalStopReason, toolCalls: trajectory };
}

function capJson(value, maxBytes) {
  if (value === null || value === undefined) return null;
  if (utf8ByteLength(JSON.stringify(value)) <= maxBytes) return value;
  if (typeof value === "string") return truncateUtf8Tail(value, maxBytes);
  return { truncated: true, marker: TRUNCATED_MARKER };
}

// ── legacy toolResult recovery ────────────────────────────────────────────

/**
 * Parse the dispatch_parallel toolResult display text (legacy v3-era runs
 * predate the dispatch-trace protocol, so the parent session toolResult is
 * the only source of per-task output). Section headers are matched by the
 * EXACT task model name + index + duration, so markdown headers inside the
 * output body cannot be mistaken for section boundaries.
 *
 * Returns Map<taskIndex, { output, partial }> where `partial` is true when
 * the section rendered a `_partial output (N chars):_` preview (failure
 * capture) instead of the full output.
 */
export function parseParallelToolResult(text, tasks) {
  const out = new Map();
  if (typeof text !== "string" || text.length === 0) return out;
  const lines = text.split("\n");
  // Expected header per task: `### N. <model> (<dur>s —  ↑in ↓out $cost)`
  // with the usage segment optional. The model name is the disambiguator.
  const headerRe = new Map();
  for (const task of tasks) {
    const index = Number(task.index) + 1;
    const re = new RegExp(
      `^### ${index}\\. ${escapeRegex(task.model)} \\(\\d+\\.\\d+s(?: —  ↑\\d+ ↓\\d+ \\$\\d+\\.\\d+)?\\)$`,
    );
    headerRe.set(task.index, re);
  }
  // Find header line positions.
  const positions = [];
  for (let i = 0; i < lines.length; i++) {
    for (const [taskIndex, re] of headerRe) {
      if (re.test(lines[i])) {
        positions.push({ line: i, taskIndex });
        break;
      }
    }
  }
  positions.sort((a, b) => a.line - b.line);
  for (let p = 0; p < positions.length; p++) {
    const { line, taskIndex } = positions[p];
    const endLine = p + 1 < positions.length ? positions[p + 1].line : lines.length;
    let body = lines.slice(line + 1, endLine).join("\n").trim();
    // Strip leading metadata lines (failure line `❌/🚫 [type] msg` and retry
    // summary `_retries: ..._`) in any order, line-scoped so a greedy match
    // cannot swallow the partial marker or output text on later lines.
    // Alternation (not a character class) for the emoji: they are surrogate
    // pairs and a class without the `u` flag matches only half a code point.
    for (let i = 0; i < 4; i++) {
      const before = body;
      body = body.replace(/^(?:❌|🚫) \[[^\]]*\][^\n]*\n?/, "").trim();
      body = body.replace(/^_retries: [^\n]*_\n?/, "").trim();
      if (body === before) break;
    }
    const partialMatch = /^_partial output \(\d+ chars\):_\n?/.exec(body);
    const partial = partialMatch !== null;
    const output = partial ? body.replace(partialMatch[0], "").trim() : body;
    out.set(taskIndex, { output, partial });
  }
  return out;
}

// ── episode-local anonymization ───────────────────────────────────────────

export function buildEpisodeId(sessionId, toolCallId, prompt, thinking, tools) {
  const digest = sha256Hex(`${sessionId}\u0000${toolCallId}\u0000${prompt}\u0000${thinking ?? ""}\u0000${tools ?? ""}`);
  return `ep-${digest.slice(0, 16)}`;
}

/**
 * Episode-local randomized candidate ids. For one episode, the slot models
 * are sorted by HMAC(blindKey, `${episodeId}\0model\0${name}`) and assigned
 * c0..cN in that order. The same model always gets the same id within the
 * episode (referential consistency), but a different episode derives a
 * different id for the same model (episode-local randomization), so a
 * self-report in one episode cannot be correlated with any other episode.
 * Deterministic for a fixed (blindKey, episodeId, model set).
 */
export function episodeLocalModelIds(blindKey, episodeId, modelNames) {
  const scored = [...new Set(modelNames)].map((name) => ({
    name,
    h: hmacHex(blindKey, `${episodeId}\0model\0${name}`),
  }));
  scored.sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
  const map = new Map();
  scored.forEach((s, i) => map.set(s.name, `c${i}`));
  return map;
}

/**
 * Episode-local random slot id. The suffix is HMAC(blindKey, episodeId, runId)
 * so it carries NO roster position (the old `slot-<ep>-<index>` encoded
 * task_index). Deterministic for a fixed (blindKey, episodeId, runId).
 */
export function episodeSlotId(blindKey, episodeId, runId) {
  return `slot-${episodeId}-${hmacHex(blindKey, `${episodeId}\0slotid\0${runId}`).slice(0, 12)}`;
}

/**
 * Episode-local random slot ordering. Slots are sorted by
 * HMAC(blindKey, `${episodeId}\0slotorder\0${runId}`) so the body slot array
 * is a fresh random permutation per episode that is INDEPENDENT of the
 * dispatch roster order (task_index). Deterministic for a fixed
 * (blindKey, episodeId, runId set).
 */
export function episodeSlotOrder(blindKey, episodeId, runIds) {
  const scored = runIds.map((runId) => ({ runId, h: hmacHex(blindKey, `${episodeId}\0slotorder\0${runId}`) }));
  scored.sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
  return scored.map((s) => s.runId);
}

/** Bijective base-26 label: 0 -> a, 25 -> z, 26 -> aa, 27 -> ab, ... */
export function pseudonymForIndex(index) {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    n -= 1;
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return `[model-${s}]`;
}

/** Split a basename on "-" keeping numeric version runs together ("4-8"). */
export function splitBasename(basename) {
  const raw = String(basename).split("-");
  const parts = [];
  for (const part of raw) {
    if (parts.length > 0 && /^\d+$/.test(parts[parts.length - 1]) && /^\d+$/.test(part)) {
      parts[parts.length - 1] += `-${part}`;
    } else {
      parts.push(part);
    }
  }
  return parts;
}

function capitalizePart(part) {
  return /^[a-z]/i.test(part) ? part[0].toUpperCase() + part.slice(1) : part;
}

/**
 * Humanized alias variants of a basename, e.g. "gpt-5.6-sol" →
 * "GPT-5.6-Sol", "GPT 5.6 Sol", "GPT-5.6 Sol", "GPT 5.6-Sol".
 */
export function aliasVariants(basename) {
  const parts = splitBasename(basename).map(capitalizePart);
  if (parts.length === 1) return [parts[0]];
  const joinedDash = parts.join("-");
  const joinedSpace = parts.join(" ");
  const firstDash = `${parts[0]}-${parts.slice(1).join(" ")}`;
  const firstSpace = `${parts[0]} ${parts.slice(1).join("-")}`;
  return [...new Set([joinedDash, joinedSpace, firstDash, firstSpace])];
}

/**
 * Collect distinct residual old-style model ids (`mN`) from raw texts. These
 * are ids baked into the corpus by older builds of this pipeline; they are
 * redacted per-episode like any other entity.
 */
export function collectResidualIds(texts) {
  const ids = new Set();
  const re = /\bm\d+\b/g;
  for (const text of texts) {
    const s = String(text ?? "");
    let m;
    while ((m = re.exec(s)) !== null) ids.add(m[0]);
  }
  return [...ids].sort();
}

export function isAmbiguousIdentityToken(token) {
  const lower = String(token).toLowerCase();
  return AMBIGUOUS_IDENTITY_TOKENS.some((t) => t.toLowerCase() === lower);
}

/**
 * The set of tokens the redactor may replace (model full names/basenames/
 * aliases, family tokens, unambiguous leak fragments, residual ids) MINUS any
 * token that is itself a bare ambiguous identity token (e.g. the basename
 * "k3" of kimi-coding/k3 is ambiguous with the criterion "K3" and must not
 * be mechanically replaced). Ambiguous tokens are handled by
 * detectAmbiguousIdentityTokens (fail-closed), not by the redactor.
 */
export function buildKnownTokenSet(corpusModelNames, residualIds) {
  const known = new Set();
  for (const name of corpusModelNames) {
    const basename = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
    for (const token of [name, basename, ...aliasVariants(basename)]) {
      if (!isAmbiguousIdentityToken(token)) known.add(token);
    }
  }
  for (const token of FAMILY_TOKENS) if (!isAmbiguousIdentityToken(token)) known.add(token);
  for (const token of LEAK_FRAGMENT_TOKENS) if (!isAmbiguousIdentityToken(token)) known.add(token);
  for (const id of residualIds) known.add(id);
  return known;
}

/**
 * Fail-closed detection of undeterminable identity fragments in raw
 * (unredacted) prompt/output/thinking/tool-call text. Two families are
 * detected:
 *   - bare context-ambiguous identity tokens (AMBIGUOUS_IDENTITY_TOKENS): a
 *     token is "bare" when it is NOT part of a longer known model/family
 *     token (e.g. "M3" inside "MiniMax-M3" is part of a full model name and
 *     is not ambiguous; a standalone "M3" is);
 *   - residual old-style ids (`mN`): they could be model ids baked in by
 *     older builds of this pipeline OR ordinary numbered criteria (m1/m2/m3
 *     review items) — the two cannot be reliably told apart, so they fail
 *     closed like any other ambiguous fragment.
 * Returns the sorted list of ambiguous tokens found; the caller must exclude
 * the whole episode (never guess).
 */
export function detectAmbiguousIdentityTokens(rawTexts, corpusModelNames, residualIds) {
  // Residual ids are NOT part of the known set: they are fail-closed, so they
  // must not mask a bare ambiguous token (e.g. the residual "m2" must not
  // mask the criterion "M2").
  const known = buildKnownTokenSet(corpusModelNames, []);
  const entries = [...known].sort((a, b) => b.length - a.length);
  const knownRe = entries.length > 0
    ? new RegExp(entries.map((t) => `\\b${escapeRegex(t)}\\b`).join("|"), "gi")
    : null;
  const found = new Set();
  for (const text of rawTexts) {
    const s = String(text ?? "");
    const masked = knownRe ? s.replace(knownRe, (m) => " ".repeat(m.length)) : s;
    for (const token of AMBIGUOUS_IDENTITY_TOKENS) {
      const re = new RegExp(`\\b${escapeRegex(token)}\\b`, "gi");
      let m;
      while ((m = re.exec(masked)) !== null) found.add(token);
    }
  }
  for (const id of residualIds ?? []) {
    if (![...found].some((t) => t.toLowerCase() === id.toLowerCase())) found.add(id);
  }
  return [...found].sort();
}

/**
 * Build an episode-local redactor.
 *
 * Entity universe (each entity gets ONE episode-local pseudonym):
 *   - every corpus model: full name, basename and humanized aliases all map
 *     to the same entity (referential consistency);
 *   - every family/alias token (FAMILY_TOKENS);
 *   - every leaky version fragment (LEAK_FRAGMENT_TOKENS);
 *   - every residual old-style id (`mN`) found in the episode's raw text.
 *
 * Pseudonyms are assigned by sorting the entity keys with
 * HMAC(blindKey, `${episodeId}\0entity\0${key}`) and labelling them
 * [model-a], [model-b], ... — deterministic per (blindKey, episodeId),
 * episode-local, and distinct across entities (referential distinction).
 *
 * The returned redact() applies to strings, arrays and plain objects
 * (tool args/results) recursively. Residual ids are handled in a pre-pass
 * (per-id pseudonyms, generic fallback for unseen ids); session/run ids
 * quoted in content are replaced with generic placeholders.
 */
export function buildEpisodeRedactor(blindKey, episodeId, corpusModelNames, residualIds) {
  const entities = new Map(); // entityKey -> { tokens: string[], replacement: string }
  const addEntity = (key, tokens) => {
    let entity = entities.get(key);
    if (!entity) {
      entity = { tokens: [], replacement: null };
      entities.set(key, entity);
    }
    for (const token of tokens) {
      if (!entity.tokens.includes(token)) entity.tokens.push(token);
    }
  };
  const known = buildKnownTokenSet(corpusModelNames, residualIds);
  for (const name of corpusModelNames) {
    const basename = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
    const tokens = [name, basename, ...aliasVariants(basename)].filter((t) => known.has(t));
    addEntity(`model:${name}`, tokens);
  }
  for (const token of FAMILY_TOKENS) if (known.has(token)) addEntity(`family:${token}`, [token]);
  for (const token of LEAK_FRAGMENT_TOKENS) if (known.has(token)) addEntity(`fragment:${token}`, [token]);
  for (const id of residualIds) addEntity(`residual:${id}`, [id]);

  const keys = [...entities.keys()];
  const scored = keys.map((key) => ({ key, h: hmacHex(blindKey, `${episodeId}\0entity\0${key}`) }));
  scored.sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
  scored.forEach((s, i) => { entities.get(s.key).replacement = pseudonymForIndex(i); });

  const residualByLower = new Map();
  for (const id of residualIds) residualByLower.set(id.toLowerCase(), entities.get(`residual:${id}`).replacement);

  const entries = [];
  for (const { tokens, replacement } of entities.values()) {
    for (const token of tokens) entries.push({ token, replacement });
  }
  entries.sort((a, b) => b.token.length - a.token.length);
  if (entries.length === 0) {
    return { redact: (value) => value };
  }
  const combined = new RegExp(entries.map((e) => `\\b${escapeRegex(e.token)}\\b`).join("|"), "gi");
  const byLower = new Map(entries.map((e) => [e.token.toLowerCase(), e.replacement]));
  // Content-level identity tokens: session ids (ULID-style 019f…) and
  // dispatch run ids (dtr_…) quoted inside prompt/output/thinking text are
  // replaced with generic placeholders so the body cannot be correlated back
  // to a specific session or run. The session-id pattern uses hex-context
  // lookarounds (not \b) because ids embedded in file names are preceded by
  // "_" (a word char).
  const RESIDUAL_ID_RE = /\bm\d+\b/g;
  const SESSION_ID_RE = /(?<![0-9a-f])019f[0-9a-f-]{20,}(?![0-9a-f])/g;
  const RUN_ID_RE = /\bdtr_[0-9a-f]{20,}\b/g;
  // Version fragments glued to a pseudonym ("[model-a]-4-8", "5.6-[model-b]") are
  // the signature of a partially redacted model name (e.g. "fable-5" -> "fable"
  // matched as a family token, leaving "-5"). Collapse them so no version
  // fragment survives next to a pseudonym. Only short version runs are matched
  // (max one separator) so dates like "2026-05-28" are not swallowed.
  const PSEUDONYM_VERSION_RE = /\[model-[a-z]+\](?:-\d+(?:[.-]\d+)*)+|\d+(?:[.-]\d+){0,1}-\[model-[a-z]+\]/g;
  const redact = (value) => {
    if (value === null || value === undefined) return value;
    if (typeof value === "string") {
      return value
        .replace(RESIDUAL_ID_RE, (match) => residualByLower.get(match.toLowerCase()) ?? GENERIC_RESIDUAL_PSEUDONYM)
        .replace(combined, (match) => byLower.get(match.toLowerCase()) ?? match)
        .replace(PSEUDONYM_VERSION_RE, (match) => match.match(/\[model-[a-z]+\]/)[0])
        .replace(SESSION_ID_RE, "[session]")
        .replace(RUN_ID_RE, "[run]");
    }
    if (Array.isArray(value)) return value.map((item) => redact(item));
    if (value && typeof value === "object") {
      const out = {};
      for (const [key, item] of Object.entries(value)) out[key] = redact(item);
      return out;
    }
    return value;
  };
  return { redact };
}

/**
 * Cap a slot output to maxBytes (UTF-8 byte-safe, tail-truncated with a
 * marker). maxBytes <= 0 yields an empty string.
 */
export function capOutput(output, maxBytes) {
  if (maxBytes <= 0) return "";
  return truncateUtf8Tail(output, maxBytes);
}

/**
 * Capability-body eligibility. Slots with result != ok, partial tool results,
 * empty output, or an output length that contradicts the audit never enter
 * the capability body; they are kept in the identity sidecar and counted in
 * the availability statistics.
 */
export function slotBodyEligibility(slot, output, outputSource) {
  const auditOutputChars = typeof slot.row.output_chars === "number" ? slot.row.output_chars : null;
  if (slot.row.result !== "ok") return { eligible: false, reason: "result_not_ok" };
  if (outputSource === "tool_result_partial") return { eligible: false, reason: "tool_result_partial" };
  if (output.length === 0) return { eligible: false, reason: "output_empty" };
  // ±1 tolerance: the toolResult section body is trimmed, so a trailing
  // newline in the original output can make recovered length differ by 1.
  if (auditOutputChars !== null && Math.abs(output.length - auditOutputChars) > 1) {
    return { eligible: false, reason: "output_chars_mismatch" };
  }
  return { eligible: true, reason: null };
}

/**
 * Judge-meaningful missing evidence for a body slot. In final_answer_only
 * mode every quality issue causes exclusion (recorded in the sidecar), so
 * the body carries no missing evidence. In full_trajectory mode, missing
 * thinking is judge-meaningful.
 */
export function judgeMeaningfulMissing(slot, evidence, datasetMode) {
  if (datasetMode !== "full_trajectory") return [];
  const missing = [];
  if (evidence.thinking.length === 0 && slot.row.thinking !== "off") {
    missing.push(slot.row.reasoning_trace_path ? "thinking_missing_but_reasoning_trace_path_present" : "thinking_missing");
  }
  if (typeof slot.row.reasoning_chars === "number" && evidence.thinking.length !== slot.row.reasoning_chars) {
    missing.push(`thinking_chars_mismatch(audit=${slot.row.reasoning_chars},recovered=${evidence.thinking.length})`);
  }
  return missing;
}

// ── main pipeline ─────────────────────────────────────────────────────────

export function buildEpisodes(options) {
  const audit = loadAuditRows(options);
  const rows = audit.rows;
  const neededSessionIds = [...new Set(rows.map((r) => r.session_id))].sort();
  const sessionIndex = indexSessions(options.sessionsRoot, neededSessionIds);
  const { joined, excluded } = joinRows(rows, sessionIndex);
  const { episodes: candidateEpisodes, belowMin } = groupSlots(joined, options.minModels);
  // models/time filters are episode selection conditions applied AFTER full
  // call/group reconstruction — a call is never split by the filter.
  const { episodes, timeFiltered, modelFiltered } = applyEpisodeFilters(candidateEpisodes, options);

  // Blind key: explicit --blind-key / --seed win; otherwise reuse the key
  // file in the output dir (deterministic rebuild) or generate a new one.
  const blind = resolveBlindKey(options.output, options);
  if (blind.source !== "reused") {
    fs.mkdirSync(options.output, { recursive: true });
    fs.writeFileSync(
      path.join(options.output, BLIND_KEY_FILE),
      `${JSON.stringify({ schema_version: 1, blind_key: blind.key, source: blind.source }, null, 2)}\n`,
    );
  }

  // The redactor entity universe covers EVERY model seen in the audit (not
  // just the episode slot models): models that appear only in prompt/output
  // text would otherwise leak their basenames and version fragments.
  const corpusModelNames = [...new Set(rows.map((r) => r.model).filter(Boolean))].sort();

  // Trace recovery: only sessions that produced selected episodes are re-read.
  const neededKeys = [];
  for (const episode of episodes) {
    for (const slot of episode.slots) {
      const runId = slot.row.run_id || computeDispatchRunId(episode.sessionId, episode.toolCallId, slot.row.task_index);
      neededKeys.push(`${episode.sessionId}\u0000${runId}`);
    }
  }
  const traceIndex = extractTraceEvents(sessionIndex, neededKeys);

  // Pass A: recover evidence + assess body eligibility per episode.
  const prepared = [];
  let hasTrajectory = false;
  const toolResultCache = new Map();
  for (const episode of episodes) {
    const episodeId = buildEpisodeId(episode.sessionId, episode.toolCallId, episode.prompt, episode.thinking, episode.tools);
    const session = sessionIndex.get(episode.sessionId);
    const toolResultText = session?.toolResults?.get(episode.toolCallId)?.text ?? null;
    let parsedToolResult;
    if (toolResultText != null) {
      const cacheKey = `${episode.sessionId}\u0000${episode.toolCallId}`;
      if (!toolResultCache.has(cacheKey)) {
        const callTasks = session.toolCalls.find((tc) => tc.id === episode.toolCallId)?.tasks ?? [];
        toolResultCache.set(cacheKey, parseParallelToolResult(toolResultText, callTasks.map((task, index) => ({
          index,
          model: task.model ?? "unknown",
        }))));
      }
      parsedToolResult = toolResultCache.get(cacheKey);
    }
    const rawSlots = episode.slots
      .slice()
      .sort((a, b) => a.row.task_index - b.row.task_index)
      .map((slot) => {
        const runId = slot.row.run_id || computeDispatchRunId(episode.sessionId, episode.toolCallId, slot.row.task_index);
        const traceEvents = traceIndex.get(`${episode.sessionId}\u0000${runId}`) ?? [];
        const evidence = recoverTraceEvidence(traceEvents, options);
        const legacy = parsedToolResult?.get(slot.row.task_index);
        const output = evidence.output.length > 0 ? evidence.output : (legacy?.output ?? "");
        const outputSource = evidence.output.length > 0 ? "dispatch_trace" : legacy ? (legacy.partial ? "tool_result_partial" : "tool_result") : "none";
        return { slot, evidence, output, outputSource, runId };
      });
    for (const raw of rawSlots) {
      if (raw.evidence.thinking.length > 0 || raw.evidence.toolCalls.length > 0) hasTrajectory = true;
    }
    const rawTexts = [episode.prompt, ...rawSlots.flatMap((r) => [r.output, r.evidence.thinking, JSON.stringify(r.evidence.toolCalls)])];
    const residualIds = collectResidualIds(rawTexts);
    const ambiguousTokens = detectAmbiguousIdentityTokens(rawTexts, corpusModelNames, residualIds);
    const { redact } = buildEpisodeRedactor(blind.key, episodeId, corpusModelNames, residualIds);
    const slotModelIds = episodeLocalModelIds(blind.key, episodeId, rawSlots.map((r) => r.slot.row.model));
    const assessed = rawSlots.map((raw) => {
      const { eligible, reason } = slotBodyEligibility(raw.slot, raw.output, raw.outputSource);
      return { ...raw, eligible, exclusionReason: reason };
    });
    prepared.push({ episode, episodeId, assessed, slotModelIds, redact, ambiguousTokens });
  }
  const datasetMode = hasTrajectory ? "full_trajectory" : "final_answer_only";

  // Pass B: build body + sidecar records.
  const episodeRecords = [];
  const sidecarRecords = [];
  const belowMinAfterAvailability = [];
  const ambiguousEpisodes = [];
  const tooLargeEpisodes = [];
  const availabilityByReason = {};
  const modelCoverage = new Map(); // model name -> { episodes: Set, slots: number }
  let totalBodyBytes = 0;

  for (const { episode, episodeId, assessed, slotModelIds, redact, ambiguousTokens } of prepared) {
    if (ambiguousTokens.length > 0) {
      // Fail-closed: a bare context-ambiguous identity token in the raw
      // prompt/output cannot be reliably classified as a model identity or
      // ordinary text — exclude the whole episode, never guess.
      ambiguousEpisodes.push({
        episodeId,
        tokens: ambiguousTokens,
        modelCount: new Set(assessed.filter((a) => a.eligible).map((a) => slotModelIds.get(a.slot.row.model))).size,
      });
      continue;
    }
    const bodyModelIds = new Set(assessed.filter((a) => a.eligible).map((a) => slotModelIds.get(a.slot.row.model)));
    const belowMin = bodyModelIds.size < options.minModels;

    const bodySlotRecords = []; // { runId, record }
    const sidecarSlotRecords = [];
    for (let index = 0; index < assessed.length; index++) {
      const raw = assessed[index];
      const { slot, evidence, output, outputSource, eligible, exclusionReason } = raw;
      const slotId = episodeSlotId(blind.key, episodeId, raw.runId);
      if (!eligible) {
        availabilityByReason[exclusionReason] = (availabilityByReason[exclusionReason] ?? 0) + 1;
      }
      const inBody = eligible && !belowMin;
      sidecarSlotRecords.push({
        slot_id: slotId,
        model: slot.row.model ?? null,
        in_body: inBody,
        exclusion_reason: !eligible ? exclusionReason : (belowMin ? "below_min_models_after_availability" : null),
        usage: {
          tokens_in: slot.row.tokens_in ?? null,
          tokens_out: slot.row.tokens_out ?? null,
          cost: slot.row.cost ?? null,
          max_output_tokens: slot.row.max_output_tokens ?? null,
          tool_call_count: slot.row.tool_call_count ?? null,
          duration_ms: slot.row.duration_ms ?? null,
        },
        audit: {
          audit_version: slot.row.audit_version ?? null,
          timestamp: slot.row.timestamp ?? null,
          pid: slot.row.pid ?? null,
          worker_run_id: slot.row.worker_run_governance?.worker_run_id ?? null,
          session_id: episode.sessionId,
          tool_call_id: episode.toolCallId,
          task_index: slot.row.task_index ?? null,
          task_count: slot.row.task_count ?? null,
          dispatch_tool_call_id: slot.row.dispatch_tool_call_id ?? null,
          run_id: raw.runId,
          reasoning_trace_path: slot.row.reasoning_trace_path ?? null,
          heartbeat_trace_path: slot.row.heartbeat_trace_path ?? null,
        },
      });
      if (!inBody) continue;

      // Redact the full output first, then cap: the cap bounds the WRITTEN body
      // content exactly (pseudonyms can be longer than the tokens they replace).
      const redactedFull = redact(output);
      const capped = capOutput(redactedFull, options.maxOutputBytes);
      const bodySlot = {
        slot_id: slotId,
        model_id: slotModelIds.get(slot.row.model),
        output: capped,
        output_source: outputSource,
        output_chars: capped.length,
        result: slot.row.result ?? null,
        terminal_state: slot.row.terminal_state ?? null,
        stop_reason: slot.row.stop_reason ?? null,
        failure_type: slot.row.failure_type ?? null,
        join_confidence: slot.joinConfidence,
        join_note: slot.joinNote,
        missing_evidence: judgeMeaningfulMissing(slot, evidence, datasetMode),
      };
      if (datasetMode === "full_trajectory") {
        bodySlot.thinking = redact(evidence.thinking);
        bodySlot.thinking_chars = evidence.thinking.length;
        bodySlot.final_stop_reason = evidence.finalStopReason;
        bodySlot.tool_calls = redact(evidence.toolCalls);
      }
      if (redactedFull !== output) bodySlot.redacted = true;
      bodySlotRecords.push({ runId: raw.runId, record: bodySlot });

      const modelName = slot.row.model;
      if (modelName) {
        let cov = modelCoverage.get(modelName);
        if (!cov) {
          cov = { episodes: new Set(), slots: 0 };
          modelCoverage.set(modelName, cov);
        }
        cov.episodes.add(episodeId);
        cov.slots++;
      }
    }

    if (belowMin) {
      // Episodes below the available-model threshold still write sidecar
      // records and count into the availability statistics.
      belowMinAfterAvailability.push({ episodeId, modelCount: bodyModelIds.size });
      availabilityByReason["below_min_models_after_availability"] =
        (availabilityByReason["below_min_models_after_availability"] ?? 0) + sidecarSlotRecords.length;
      sidecarRecords.push({
        schema_version: EPISODE_SCHEMA_VERSION,
        dataset_mode: datasetMode,
        episode_id: episodeId,
        slots: sidecarSlotRecords,
      });
      continue;
    }

    // Roster-order safety: the body slot array is a fresh random permutation
    // per episode (blind key + episode id), independent of task_index order.
    const bodyOrder = episodeSlotOrder(blind.key, episodeId, bodySlotRecords.map((r) => r.runId));
    const byRunId = new Map(bodySlotRecords.map((r) => [r.runId, r.record]));
    const bodySlots = bodyOrder.map((runId) => byRunId.get(runId));

    const confidences = [...new Set(bodySlots.map((s) => s.join_confidence))];
    const episodeRecord = {
      schema_version: EPISODE_SCHEMA_VERSION,
      dataset_mode: datasetMode,
      episode_id: episodeId,
      prompt: redact(episode.prompt),
      thinking_level: episode.thinking,
      tools: episode.tools,
      model_count: bodyModelIds.size,
      join_confidence: confidences.length === 1 ? confidences[0] : "mixed",
      missing_evidence: [...new Set(bodySlots.flatMap((s) => s.missing_evidence))],
      slots: bodySlots,
    };
    const episodeBytes = utf8ByteLength(JSON.stringify(episodeRecord));
    if (episodeBytes > options.maxEpisodeBytes) {
      tooLargeEpisodes.push({ episodeId, bytes: episodeBytes });
      continue;
    }
    // max-total-bytes is checked against the REAL episodes.jsonl size: one
    // newline byte per episode line (writeOutputs joins with "\n" and appends
    // a trailing newline, so the file is exactly sum(JSON bytes) + N bytes).
    totalBodyBytes += episodeBytes + 1;
    episodeRecords.push(episodeRecord);
    sidecarRecords.push({
      schema_version: EPISODE_SCHEMA_VERSION,
      dataset_mode: datasetMode,
      episode_id: episodeId,
      slots: sidecarSlotRecords,
    });
  }

  if (totalBodyBytes > options.maxTotalBytes) {
    throw new Error(
      `t0-episode-build: total episodes.jsonl size ${totalBodyBytes} bytes exceeds --max-total-bytes ${options.maxTotalBytes} (fail-closed)`,
    );
  }

  const exclusionRecords = [
    ...excluded.map(({ row, reason }) => ({
      session_id: row.session_id,
      task_index: row.task_index,
      task_count: row.task_count,
      model: row.model,
      audit_version: row.audit_version ?? null,
      timestamp: row.timestamp ?? null,
      dispatch_tool_call_id: row.dispatch_tool_call_id ?? null,
      reason,
    })),
    ...belowMinAfterAvailability.map(({ episodeId, modelCount }) => ({
      episode_id: episodeId,
      reason: "below_min_models_after_availability",
      model_count: modelCount,
    })),
    ...ambiguousEpisodes.map(({ episodeId, tokens, modelCount }) => ({
      episode_id: episodeId,
      reason: "ambiguous_identity_token",
      ambiguous_identity_token: tokens,
      model_count: modelCount,
    })),
    ...tooLargeEpisodes.map(({ episodeId, bytes }) => ({
      episode_id: episodeId,
      reason: "episode_too_large",
      bytes,
    })),
  ];

  const stats = buildStats({
    options,
    blind,
    audit,
    sessionIndex,
    joined,
    excluded,
    episodes: episodeRecords,
    belowMin,
    belowMinAfterAvailability,
    ambiguousEpisodes,
    tooLargeEpisodes,
    timeFiltered,
    modelFiltered,
    corpusModelNames,
    datasetMode,
    availabilityByReason,
    modelCoverage,
    totalBodyBytes,
  });

  return { episodes: episodeRecords, sidecar: sidecarRecords, blind, exclusions: exclusionRecords, stats };
}

export function buildStats({ options, blind, audit, sessionIndex, joined, excluded, episodes, belowMin, belowMinAfterAvailability, ambiguousEpisodes, tooLargeEpisodes, timeFiltered, modelFiltered, corpusModelNames, datasetMode, availabilityByReason, modelCoverage, totalBodyBytes }) {
  const excludedByReason = {};
  for (const { reason } of excluded) {
    excludedByReason[reason] = (excludedByReason[reason] ?? 0) + 1;
  }
  const byModelCount = {};
  const byThinking = {};
  const byConfidence = {};
  const byJoinConfidence = {};
  const byOutputSource = {};
  let slotsWithOutput = 0;
  let slotsMissingOutput = 0;
  let slotsRedacted = 0;
  let totalOutputBytes = 0;
  let totalEpisodeBytes = 0;
  for (const episode of episodes) {
    byModelCount[episode.model_count] = (byModelCount[episode.model_count] ?? 0) + 1;
    byThinking[episode.thinking_level ?? "null"] = (byThinking[episode.thinking_level ?? "null"] ?? 0) + 1;
    byConfidence[episode.join_confidence] = (byConfidence[episode.join_confidence] ?? 0) + 1;
    // Once per episode — not per slot (avoids double counting AND redundant
    // serialization of the whole episode inside the slot loop). +1 per episode
    // = the real newline byte in episodes.jsonl (max-total-bytes is checked
    // against the real file size).
    totalEpisodeBytes += utf8ByteLength(JSON.stringify(episode)) + 1;
    for (const slot of episode.slots) {
      byJoinConfidence[slot.join_confidence] = (byJoinConfidence[slot.join_confidence] ?? 0) + 1;
      byOutputSource[slot.output_source] = (byOutputSource[slot.output_source] ?? 0) + 1;
      if (slot.output.length > 0) slotsWithOutput++;
      else slotsMissingOutput++;
      if (slot.redacted === true) slotsRedacted++;
      totalOutputBytes += utf8ByteLength(slot.output);
    }
  }
  const belowMinByModelCount = {};
  for (const group of belowMin) {
    belowMinByModelCount[group.modelCount] = (belowMinByModelCount[group.modelCount] ?? 0) + 1;
  }
  const byName = {};
  for (const [name, cov] of modelCoverage) {
    byName[name] = { episodes: cov.episodes.size, slots: cov.slots };
  }
  const bodyModelNames = [...modelCoverage.keys()].sort();
  const absentFromBody = corpusModelNames.filter((n) => !modelCoverage.has(n));
  const slotsExcluded = Object.values(availabilityByReason).reduce((sum, n) => sum + n, 0);
  return {
    schema_version: EPISODE_SCHEMA_VERSION,
    dataset_mode: datasetMode,
    inputs: {
      audit_files: audit.fileStats,
      sessions_root: options.sessionsRoot,
      sessions_referenced: audit.rows.length > 0 ? new Set(audit.rows.map((r) => r.session_id)).size : 0,
      sessions_indexed: sessionIndex.size,
    },
    filters: {
      since: options.since ?? null,
      until: options.until ?? null,
      models: options.models ?? null,
      min_models: options.minModels,
      no_archive: options.noArchive,
      max_output_bytes: options.maxOutputBytes,
      max_episode_bytes: options.maxEpisodeBytes,
      max_total_bytes: options.maxTotalBytes,
    },
    blind_key: {
      source: blind.source,
      sha256: sha256Hex(blind.key),
    },
    audit_rows: {
      parallel_task_rows_scanned: audit.rows.length,
      eligible: audit.rows.length,
    },
    join: {
      exact: joined.filter((s) => s.joinConfidence === "exact").length,
      heuristic: joined.filter((s) => s.joinConfidence === "heuristic").length,
      excluded: excluded.length,
      excluded_by_reason: excludedByReason,
    },
    episode_filters: {
      time_filtered: timeFiltered.length,
      model_filtered: modelFiltered.length,
    },
    groups: {
      episodes: episodes.length,
      groups_below_min_models: belowMin.length,
      groups_below_min_models_by_model_count: belowMinByModelCount,
      episodes_below_min_after_availability: belowMinAfterAvailability.length,
      episodes_ambiguous_identity: ambiguousEpisodes.length,
      slots_in_episodes: episodes.reduce((sum, e) => sum + e.slots.length, 0),
    },
    availability: {
      slots_excluded: slotsExcluded,
      slots_excluded_by_reason: availabilityByReason,
      episodes_too_large: tooLargeEpisodes.length,
    },
    episodes: {
      by_model_count: byModelCount,
      by_thinking_level: byThinking,
      by_join_confidence: byConfidence,
      slots_by_join_confidence: byJoinConfidence,
      slots_by_output_source: byOutputSource,
      slots_with_output: slotsWithOutput,
      slots_missing_output: slotsMissingOutput,
      slots_redacted: slotsRedacted,
      total_output_bytes: totalOutputBytes,
      total_episode_bytes: totalEpisodeBytes,
    },
    models: {
      corpus_count: corpusModelNames.length,
      body_count: bodyModelNames.length,
      absent_from_body: absentFromBody,
      by_name: byName,
    },
    resource: {
      max_output_bytes: options.maxOutputBytes,
      max_episode_bytes: options.maxEpisodeBytes,
      max_total_bytes: options.maxTotalBytes,
      total_episodes_bytes: totalBodyBytes,
    },
  };
}

export function buildReadme(stats) {
  return `# T0 Episode Dataset

Generated by \`scripts/t0-episode-build.mjs\` (schema v${stats.schema_version}).

## Judge-feedable files

- **episodes.jsonl** — the ONLY file that may be fed to an anonymous LLM
  judge. One episode per line: a verbatim same-prompt dispatch_parallel group
  with >= ${stats.filters.min_models} distinct models. Slots carry
  episode-local randomized candidate ids (c0..cN), random slot ids and
  de-identified final-answer outputs only. The body slot array is a fresh
  random permutation per episode (blind key + episode id) and carries no
  task_index, so the original dispatch roster order cannot be recovered from
  the body.

## Judge-feed contract

The judge-feed API — the ONLY interface between this dataset and an anonymous
judge — is contractually limited to reading \`episodes.jsonl\`. It must never
open any other file in the output directory. The judge's runtime disables
tools, so a judge cannot read the filesystem at all; the contract exists to
keep the feed path itself from ever exposing identity material.

## NEVER feed to a judge

- **episodes.meta.jsonl** — identity sidecar: real model names, usage/cost and
  audit metadata (session ids, run ids, pids, timestamps). Reverses candidate
  ids and slot ids. It lives in the same directory as episodes.jsonl but is
  for the builder/aggregator ONLY — never for a judge.
- **blind-key.json** — the random blind key that derives the episode-local
  candidate ids, slot ids and text pseudonyms. With it, candidate ids can be
  reversed.
- **exclusions.jsonl** — rows/episodes excluded from the strict set, with real
  model names and reasons (including \`ambiguous_identity_token\`).
- **stats.json** — build statistics including real model coverage.
- Any \`model-map.json\` left by older builds.

## Dataset mode

\`${stats.dataset_mode}\`: the blind body contains only final answers. Slots
with result != ok, partial tool results, or empty output are excluded from the
body and kept in the sidecar / availability statistics. Episodes whose
body-eligible slots span fewer than ${stats.filters.min_models} distinct
models are excluded as a whole but still write sidecar records and count into
the availability statistics. Episodes whose raw prompt/output contains a bare
context-ambiguous identity token (K2/M3/M2/K3/v4-pro/v4pro) are fail-closed
excluded and recorded in exclusions.jsonl with \`ambiguous_identity_token\` —
the token is never guessed.

## Reproducibility

Rebuilding into the same output directory reuses \`blind-key.json\` and is
byte-deterministic. A new directory reproduces the same dataset with
\`--blind-key <hex>\` or \`--seed <n>\`.
`;
}

export function writeOutputs(outputDir, { episodes, sidecar, exclusions, stats }) {
  fs.mkdirSync(outputDir, { recursive: true });
  // Stale model-map.json from the pre-v2 global-mapping scheme must never be
  // fed to a judge — remove it so it cannot be mistaken for current output.
  fs.rmSync(path.join(outputDir, "model-map.json"), { force: true });
  fs.writeFileSync(path.join(outputDir, "episodes.jsonl"), episodes.map((e) => JSON.stringify(e)).join("\n") + (episodes.length > 0 ? "\n" : ""));
  fs.writeFileSync(path.join(outputDir, "episodes.meta.jsonl"), sidecar.map((e) => JSON.stringify(e)).join("\n") + (sidecar.length > 0 ? "\n" : ""));
  fs.writeFileSync(path.join(outputDir, "exclusions.jsonl"), exclusions.map((e) => JSON.stringify(e)).join("\n") + (exclusions.length > 0 ? "\n" : ""));
  fs.writeFileSync(path.join(outputDir, "stats.json"), `${JSON.stringify(stats, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, "README.md"), buildReadme(stats));
}

// ── CLI entry ─────────────────────────────────────────────────────────────

function main() {
  const options = parseCli(process.argv.slice(2));
  const result = buildEpisodes(options);
  writeOutputs(options.output, result);
  const { stats } = result;
  console.log(`t0-episode-build: ${stats.groups.episodes} episodes, ${stats.groups.slots_in_episodes} slots, ` +
    `dataset_mode=${stats.dataset_mode}, blind_key=${stats.blind_key.source}, ` +
    `${stats.join.exact} exact-joined, ${stats.join.heuristic} heuristic-joined, ` +
    `${stats.join.excluded} join-excluded, ${stats.availability.slots_excluded} availability-excluded, ` +
    `${stats.episode_filters.time_filtered + stats.episode_filters.model_filtered} episode-filtered, ` +
    `${stats.models.body_count}/${stats.models.corpus_count} models in body`);
  if (!options.quiet) {
    for (const episode of result.episodes) {
      const models = episode.slots.map((s) => s.model_id).join(",");
      console.log(`  ${episode.episode_id} models=${models} thinking=${episode.thinking_level} slots=${episode.slots.length}`);
    }
  }
  console.log(`output: ${options.output}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
