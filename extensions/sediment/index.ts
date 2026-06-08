/**
 * sediment extension for pi-astack — project-only markdown writer.
 *
 * agent_end pipeline (in order):
 *   1. Synchronous ctx capture (cwd / branch / sessionId / notify) to
 *      survive stale-ctx invalidation during async work.
 *   2. Ephemeral session early-return (--no-session, dispatch_agent
 *      subprocesses, CI). Records a single audit row and returns.
 *   3. buildRunWindow over the per-session checkpoint slot.
 *   4. parseExplicitMemoryBlocks (deterministic, fence-aware). Always
 *      attempted. If hit, write each block via writeProjectEntry.
 *   5. When (4) yielded zero blocks AND autoLlmWriteEnabled gates pass,
 *      the LLM auto-write lane runs in the background. ADR 0016 changes
 *      the default posture from mechanical semantic gates to an LLM-curator
 *      posture: the LLM decides whether a durable candidate is worth
 *      writing; hard gates are reserved for sensitive information and
 *      storage integrity.
 *      No dry-run/readiness/rate/sampling/rolling semantic gates remain.
 *      Git history + audit are the rollback surface; hard gates are only
 *      standard write-side defenses (sensitive-info sanitizer, schema,
 *      lint, lock, atomic write, audit).
 *   6. Lane A advances checkpoint after terminal write outcomes. Lane C
 *      optimistically advances before bg work because auto-write is
 *      best-effort, not an authoritative replay queue.
 *   7. Audit row.
 */

import * as os from "node:os";
import * as path from "node:path";
import { mkdir } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildPromptVersionAudit, resolveSedimentSettings, type SedimentSettings } from "./settings";
import {
  buildRunWindow,
  checkpointSummary,
  entryToText,
  loadSessionCheckpoint,
  saveSessionCheckpoint,
  type RunWindow,
} from "./checkpoint";
import { curateProjectDraft, type CuratorAudit } from "./curator";
import { executeCuratorDecisionToBrain } from "./curator-decision-writer";
import { detectProjectDuplicate } from "./dedupe";
import { parseExplicitAboutMeBlocks, parseExplicitMemoryBlocks, previewExtraction, type ExtractedAboutMeDraft } from "./extractor";
import {
  runLlmExtractor,
  summarizeLlmExtractorResult,
  type LlmExtractorResult,
} from "./llm-extractor";
import { runCorrectionPipeline, shouldEscalateToCurator, type RelatedEntryCard, type CorrectionSignal } from "./correction-pipeline";
import { ruleBodySimilarity, RULE_DEDUP_SIMILARITY_THRESHOLD } from "./rule-writer";
import { replayMultiviewPending, type ReplayBatchResult } from "./multiview-staging-replay";
import { relevantEntriesForCurator } from "./curator";
import { collectOutcomes, writeOutcomeLedger, readProjectOutcomeRows, summarizeEntryActivity, sanitizeSlug } from "./outcome-collector";
import { summarizeClassifierHealth } from "./health";
import { runAndWriteSedimentAggregatorIfDue } from "./aggregator";
import { mergeEntryTelemetryIfDue } from "./entry-telemetry";
import { runArchiveReactivationIfDue } from "./archive-reactivation";
import { runStagingResolverIfDue, STAGING_RESOLVER_PROMPT_VERSION } from "./staging-resolver";
import { runStagingAgeOutIfDue, STAGING_AGEOUT_PROMPT_VERSION } from "./staging-ageout";
import { tryGetSessionMessages, verifyPiInternals, warnOnceIfUnavailable, _resetWarnedApisForTests, isSubAgentSession } from "../_shared/pi-internals";
import { getCurrentAnchor, runWithTriggerAnchor } from "../_shared/causal-anchor";
import { resolveSettings as resolveMemorySettings } from "../memory/settings";
import { sanitizeForMemory } from "./sanitizer";

import {
  appendAudit,
  updateProjectEntry,
  writeAbrainAboutMe,
  writeProjectEntry,
  type AboutMeDraft,
  type ProjectEntryDraft,
  type WriteAboutMeResult,
  type WriteProjectEntryResult,
  type WriterAuditContext,
} from "./writer";
import { LANE_G_ALLOWED_REGIONS, type AboutMeRegion } from "./about-me-router";
import { FOOTER_STATUS_KEYS } from "../_shared/footer-status";
import { abrainProjectDir, abrainSedimentStagingPath, resolveActiveProject } from "../_shared/runtime";

// ---------------------------------------------------------------
// Phase 1.4 A2 / ADR 0016: in-process bg work tracking.
//
// We intentionally keep only an in-flight guard. Older readiness/rate/
// sampling/rolling Maps were removed when sediment became an LLM curator:
// git + audit are the rollback surface; semantic hard gates are gone.
// ---------------------------------------------------------------

/**
 * sessionId -> in-flight Promise of the background LLM-extraction work.
 *
 * agent_end intentionally does NOT await this promise. The handler
 * captures everything it needs synchronously, schedules the bg work,
 * and returns immediately so the user's main session is not blocked
 * on a 30s LLM call (observed live post-A2: pi shows "Working" for
 * the entire LLM duration if we await here).
 *
 * If a NEW agent_end fires while the previous turn's bg work is
 * still running, we silently do nothing for the new turn: no audit,
 * no checkpoint advance. The next agent_end after the bg worker drains
 * starts from the checkpoint advanced by that previous sediment run.
 */
const autoWriteInFlight = new Map<string, Promise<void>>();

type DeferredStopReason = "agent_error" | "agent_aborted";

interface DeferredStopState {
  reason: DeferredStopReason;
  sessionId: string;
  lastEntryId?: string;
  timestamp: string;
}

/**
 * Per-process hint that the previous healthy-scope agent_end was
 * deliberately deferred because the main agent ended unhealthy. The
 * durable guarantee still comes from holding the on-disk checkpoint;
 * this map is only for closing the user-visible/audit loop when the
 * next healthy agent_end reprocesses and advances that checkpoint.
 */
const deferredStopBySession = new Map<string, DeferredStopState>();

interface SessionCorrectionState {
  signals: CorrectionSignal[];
  updatedAt: number;
}

const sessionCorrectionWorkingSet = new Map<string, SessionCorrectionState>();
const MAX_SESSION_CORRECTIONS = 5;

/**
 * §4.1.4 session-local working set for TASK-LOCAL corrections.
 *
 * Distinct from sessionCorrectionWorkingSet (which buffers DURABLE
 * signals for one-shot consumption by a later same-session curator).
 * Task-local semantics per ADR 0025 §4.1.4:
 *   - never persisted to durable sediment
 *   - carried into EVERY subsequent agent_end curator context in the
 *     same session (a standing working set, not one-shot)
 *   - cleared when the session ends
 *
 * Therefore reads are NON-CONSUMING (deep-copy): the same task-local
 * evidence must keep surfacing across multiple curator turns until the
 * session ends. Stored in a reduced shape {intent, scope, quote} that
 * carries the natural-language meaning WITHOUT the durable-routing
 * primitives (slug / op / confidence) — task-local context must never
 * look like an actionable durable target to the curator.
 *
 * Capacity: LRU on BOTH axes.
 *   - MAX_TASK_LOCAL_SESSIONS sessions retained (oldest updatedAt evicted)
 *   - MAX_TASK_LOCAL_ITEMS items per session (oldest evicted)
 * We deliberately do NOT clear on session_start (review H2: a /resume
 * re-enters an existing sessionId and must keep its working set). The
 * LRU session cap bounds memory growth instead.
 */
interface TaskLocalWorkingItem {
  intent: string;
  scope: string;
  quote: string;
  at: number;
}
interface TaskLocalSessionState {
  items: TaskLocalWorkingItem[];
  updatedAt: number;
}
const sessionTaskLocalSet = new Map<string, TaskLocalSessionState>();
const MAX_TASK_LOCAL_SESSIONS = 50;
const MAX_TASK_LOCAL_ITEMS = 20;

/** Track agent_start/end balance per session. When ended >= started,
 *  the main-session LLM is in agent_end state (finished, not working) —
 *  safe for bg drain. When started > ended, the LLM is working — drain
 *  must wait for the next agent_end. */
const sessionAgentCycle = new Map<string, { started: number; ended: number; drainCount: number }>();

/**
 * Cross-module-instance state for footer bridging across /new /resume.
 * pi tears down and reloads extensions on session switch, which resets
 * module-level variables. globalThis survives teardown so bg work from
 * a previous session can still update the current footer.
 */
const _G = globalThis as typeof globalThis & {
  __sediment_latestSetStatus?: ((msg?: string) => void) | undefined;
  __sediment_inflightCount?: number;
  __sediment_multiViewReplayInFlight?: Map<string, Promise<void>>;
  /** sessionId of the CURRENT foreground session (updated by
   *  session_start / agent_start). Used by maybeSetIdleIfNoInflight
   *  to distinguish same-session bg completion (keep completed/failed
   *  indicator visible) from cross-session /new bg completion (flip
   *  the new session's stuck 'running (prev session)' back to idle). */
  __sediment_currentSessionId?: string | undefined;
};
if (_G.__sediment_inflightCount === undefined) _G.__sediment_inflightCount = 0;
if (!_G.__sediment_multiViewReplayInFlight) _G.__sediment_multiViewReplayInFlight = new Map<string, Promise<void>>();
const multiViewReplayInFlight = _G.__sediment_multiViewReplayInFlight;

/** Status key for ctx.ui.setStatus(). */
const SEDIMENT_STATUS_KEY = FOOTER_STATUS_KEYS.sediment;

function resolveAbrainHomeForSediment(): string {
  return process.env.ABRAIN_ROOT
    ? process.env.ABRAIN_ROOT.replace(/^~(?=$|\/)/, os.homedir())
    : path.join(os.homedir(), ".abrain");
}

/**
 * Footer status state machine for the sediment extension.
 *
 *   idle      Pi is loaded; sediment is enabled; no extraction work
 *             is currently in progress (either nothing has run yet,
 *             or the last activity already flushed back to idle on
 *             a fresh agent_start).
 *
 *   running   The agent_end handler is currently running the explicit
 *             write loop (synchronous, fast) OR has scheduled
 *             background LLM auto-write that is still in flight.
 *
 *   completed The most recent extraction finished successfully
 *             (writes succeeded, lint clean, audit row written) or
 *             produced no entries in a healthy way (the LLM returned
 *             SKIP, or the curator chose skip).
 *
 *   failed    The most recent extraction hit an error path: lint /
 *             validation reject, LLM call errored, or bg work threw.
 *
 * Transitions, per user spec (2026-05-08), amended 2026-05-23:
 *   - session_start (no inflight)            -> idle
 *   - session_start (inflight bg work)       -> running (prev session)
 *   - agent_start while in completed/failed  -> idle (reset)
 *   - agent_start while in running           -> running (unchanged)
 *   - agent_end                              -> running -> completed/failed
 *   - bg work drain completes + no inflight  -> idle
 */
type SedimentStatus = "idle" | "running" | "completed" | "failed";

const sedimentStatusBySession = new Map<string, SedimentStatus>();

/** Exported for smoke regression. Do not rely on this signature
 *  outside test code; the formatting is informational. */
export function renderSedimentStatus(
  state: SedimentStatus,
  detail?: string,
): string {
  const prefix = (() => {
    switch (state) {
      case "idle":
        return "💤 sediment";
      case "running":
        return "📝 sediment";
      case "completed":
        return "✅ sediment";
      case "failed":
        return "⚠️  sediment";
      default:
        return `❓ sediment (${state})`;
    }
  })();
  return detail ? `${prefix}: ${detail}` : prefix;
}

/**
 * Apply a sediment status to ctx.ui.setStatus and remember it under
 * the sessionId. Both setStatus and sessionId may be undefined (older
 * pi version without setStatus, or ephemeral session); the function
 * tolerates both. The setStatus call is always wrapped in try/catch
 * so a stale-ctx late fire from background work never throws.
 *
 * 2026-05-24 history (recorded for future readers):
 *   commit f3555e8 hard-disabled this function (no-op) on the mistaken
 *   theory that the footer "📝 sediment / ✅ sediment: 3 created"
 *   display violated ADR 0024 INV-INVISIBILITY.
 *
 *   commit 16cb6f0 walked that back partially by adding
 *   `devFooterEnabled: boolean` (default false, power users opt in).
 *
 *   This commit removes the opt-in flag entirely and restores the
 *   original always-on behaviour. The author clarified:
 *     INV-INVISIBILITY = user does NOT participate in brain management
 *                        (no approval / no vetoing / no scheduled review)
 *     INV-INVISIBILITY ≠ brain runtime state is hidden from user
 *
 *   In fact: brain runtime indicators (footer status, completion
 *   notifications, audit visibility) SHOULD be on by default so the user
 *   feels the brain working in the background. The forbidden surface is
 *   "system asking the user to DO something for the brain" — the
 *   indicator itself is healthy feedback, not management burden.
 *
 *   See ADR 0024 §2 / §4.2 / §8 (updated in the same commit) for the
 *   restated invariant.
 */
function applySedimentStatus(
  setStatus: ((msg?: string) => void) | undefined,
  sessionId: string | undefined,
  state: SedimentStatus,
  detail?: string,
): void {
  if (sessionId) sedimentStatusBySession.set(sessionId, state);
  const msg = renderSedimentStatus(state, detail);
  if (setStatus) {
    try {
      setStatus(msg);
    } catch {
      /* stale ctx late fire is best-effort; fall through to globalThis */
    }
  }
  // Fallback via globalThis: bg work from a PREVIOUS session (after
  // /new) has a stale captured setStatus. globalThis survives pi's
  // extension-module teardown/reload, so the current session's footer
  // gets updated even when the calling module instance is dead.
  if (_G.__sediment_latestSetStatus) {
    try { _G.__sediment_latestSetStatus(msg); } catch { /* best-effort */ }
  }
}

/**
 * Transition footer to idle IFF no bg work is inflight AND the bg
 * work that just settled belongs to a DIFFERENT session than the
 * current foreground. Safe to call from fire-and-forget finally blocks.
 *
 * Why the session check: the original intent (per docstring of the
 * call site in the bg auto-write finally) was to recover the footer
 * after `/new` — the new session's session_start shows 'running (prev
 * session)' while the old session's bg work finishes, and once that
 * settles we want the new session's footer to go idle. But blindly
 * flipping to idle on every bg completion also nukes the in-session
 * completed/failed indicator (e.g. '✅ sediment: 3 created') the user
 * wants to see persist until the next agent_start.
 *
 * Resolution: only flip to idle when `bgSessionId !== currentSessionId`
 * (i.e. cross-session /new case). Same-session bg completion leaves
 * the just-set ✅/⚠️ display in place — agent_start on the next user
 * prompt resets it to idle.
 */
function maybeSetIdleIfNoInflight(bgSessionId: string | undefined): void {
  if ((_G.__sediment_inflightCount ?? 0) > 0 || multiViewReplayInFlight.size > 0) return;
  if (!_G.__sediment_latestSetStatus) return;
  // Same-session bg completion: keep the completed/failed indicator
  // visible. agent_start on the next prompt will reset to idle.
  if (bgSessionId && _G.__sediment_currentSessionId === bgSessionId) return;
  try {
    _G.__sediment_latestSetStatus(renderSedimentStatus("idle"));
  } catch { /* best-effort */ }
}

/**
 * Derive the abrain scope label from a write result path.
 *
 * Used by the bg auto-write notify so users see "world" / "project:<id>" /
 * "workflow" / etc. instead of having to mentally parse paths. ADR 0014 §B5
 * 7-zone layout: `~/.abrain/{identity,skills,habits,workflows,projects/<id>,
 * knowledge,vault}/`. The sediment auto-write lane today writes only to
 * `projects/<id>/` and `knowledge/`; the others are recorded for future-
 * proofing when Lane G writers ship.
 *
 * Returns "?" if `filePath` is undefined (status=rejected before path was
 * resolved) or the path doesn't sit under abrainHome (defensive — should
 * not happen in production).
 */
function deriveAutoWriteScope(filePath: string | undefined, abrainHome: string): string {
  if (!filePath) return "?";
  const rel = path.relative(abrainHome, filePath);
  if (rel.startsWith("..")) return "?";
  const parts = rel.split(path.sep);
  // ADR 0023 INV-R8/R9: a rule write must be VISIBLY distinct from a normal
  // knowledge/project write (it changes every future session). Detect the
  // rules/{always,listed} segment at any depth FIRST, otherwise a project
  // rule (projects/<id>/rules/...) would mislabel as a plain project write.
  const rulesIdx = parts.indexOf("rules");
  if (rulesIdx >= 0 && (parts[rulesIdx + 1] === "always" || parts[rulesIdx + 1] === "listed")) {
    const owner = parts[0] === "projects" && parts[1] ? `project:${parts[1]}` : "global";
    return `rules:${parts[rulesIdx + 1]}/${owner}`;
  }
  if (parts[0] === "projects" && parts[1]) return `project:${parts[1]}`;
  if (parts[0] === "knowledge") return "world";
  if (parts[0] === "workflows") return "workflow";
  if (parts[0] === "identity") return "identity";
  if (parts[0] === "skills") return "skill";
  if (parts[0] === "habits") return "habit";
  if (parts[0]) return parts[0];
  return "?";
}

/**
 * One-char glyph per status so users can scan the auto-write notify
 * vertically. Status taxonomy follows WriteProjectEntryResult.status.
 */
function statusGlyph(status: string): string {
  switch (status) {
    case "created":    return "+";
    case "updated":    return "~";
    case "merged":     return "↻";
    case "superseded": return "→";
    case "archived":   return "↓";
    case "deleted":    return "−";
    case "skipped":    return "·";
    case "rejected":   return "✗";
    case "dry_run":    return "?";
    default:           return " ";
  }
}

/**
 * Format sediment write results as one entry per line with scope + glyph +
 * slug. Used for the user-facing `notify()` on both auto-write (bg) and
 * explicit (MEMORY marker) lanes.
 *
 * 2026-05-15 UX fix: previous format joined all results with ", " so a
 * multi-result outcome rendered as one long unreadable line and didn't
 * surface scope (users couldn't tell at a glance whether a sediment write
 * landed under world knowledge or some project's substrate).
 *
 * New format:
 *   Sediment auto-write (bg): 2 entries
 *     + [project:pi-global] created    adr-0020-round-2-...
 *     ~ [project:pi-global] updated    adr-0020-round-2-...
 *
 * `lane` is the label after "Sediment " in the header (e.g. "auto-write
 * (bg)" or "explicit marker extraction"); keep both lanes consistent.
 */
function formatSedimentNotify(
  lane: string,
  results: WriteProjectEntryResult[],
  abrainHome: string,
): string {
  const header = `Sediment ${lane}: ${results.length} entr${results.length === 1 ? "y" : "ies"}`;
  if (results.length === 0) return header;
  const lines: string[] = [header];
  for (const r of results) {
    const scope = deriveAutoWriteScope(r.path, abrainHome);
    const glyph = statusGlyph(r.status);
    const reason = r.reason ? ` (${r.reason})` : "";
    lines.push(`  ${glyph} [${scope}] ${r.status.padEnd(10)} ${r.slug}${reason}`);
  }
  return lines.join("\n");
}

/** Format write results: only non-zero counts, e.g. "3 created, 1 updated, 2 skipped". */
function compactResultSummary(results: WriteProjectEntryResult[]): string {
  const c: Record<string, number> = {};
  for (const r of results) c[r.status] = (c[r.status] || 0) + 1;
  const parts: string[] = [];
  for (const st of ["created", "updated", "merged", "archived", "superseded", "deleted", "skipped", "rejected"]) {
    if (c[st]) parts.push(`${c[st]} ${st}`);
  }
  return parts.join(", ") || "no changes";
}

function shouldAdvanceAfterResults(results: WriteProjectEntryResult[]): boolean {
  const terminalReasons = new Set([
    "duplicate_slug", "validation_error", "lint_error",
    // CAS guard (ADR 0027 C3'): a status_precondition_failed means the entry
    // changed under us; retrying the same expected_status transition cannot
    // succeed without fresh intent, so treat it as terminal (advance the
    // checkpoint) to avoid an unbounded retry loop.
    "status_precondition_failed",
  ]);
  return results.every((result) => {
    if (result.status === "created" || result.status === "updated" || result.status === "merged" || result.status === "archived" || result.status === "superseded" || result.status === "deleted" || result.status === "skipped" || result.status === "dry_run") return true;
    if (!result.reason) return false;
    return terminalReasons.has(result.reason) || result.reason.startsWith("credential pattern detected");
  });
}

/**
 * Lane G analogue of `shouldAdvanceAfterResults` (ADR 0021 G2, 2026-05-20).
 *
 * Lane G's `WriteAboutMeResult.status` taxonomy is narrower than Lane A's
 * (only created / skipped / dry_run / rejected — no merge/update lifecycle
 * yet), so we keep this helper local rather than overloading the Lane A
 * one. Terminal-advance reasons mirror Lane A's: a user-attested fence
 * that fails validation / router / dedupe / lint should NOT block the
 * checkpoint, because re-processing the same fence on a future run will
 * fail identically. Transient failures (git_commit_failed, IO errors)
 * keep the checkpoint pinned so the next agent_end retries them.
 */
/**
 * ADR §4.1.4 typing-based dispatch for correction signals.
 *
 * Before this helper existed, ALL signal_found=true signals were forwarded
 * to the curator advisory regardless of typing. That violated ADR §4.1.4:
 *   - debug      → should ONLY land in audit.jsonl, NEVER influence curator
 *   - task-local → should accumulate into a session-local working set and
 *                  inject into FUTURE curator calls, not the current one
 *   - durable    → forward to curator (current behavior preserved)
 *
 * The blast-radius case this fixes: a classifier hit on "X 坏了先用 Y"
 * (debug, conf=6) used to enter the curator prompt as an advisory hypothesis,
 * potentially nudging create/update decisions toward a temporary debugging
 * preference. Per ADR 0024 §4.1 INV-ACTIVE-CORRECTION the three typings are
 * structurally different signals and must be routed differently.
 *
 * Minimal closure note: only durable signals enter the in-memory working
 * set today. Task-local remains audit-only until a non-durable session
 * context surface exists; never inject task-local into the durable curator.
 */
function rememberSessionCorrection(sessionId: string | undefined, signal: CorrectionSignal): void {
  if (!sessionId) return;
  const state = sessionCorrectionWorkingSet.get(sessionId) ?? { signals: [], updatedAt: Date.now() };
  const key = `${signal.typing || "unknown"}|${signal.target_entry_slug || ""}|${signal.user_quote || signal.correction_intent || ""}`;
  state.signals = [
    signal,
    ...state.signals.filter((item) => `${item.typing || "unknown"}|${item.target_entry_slug || ""}|${item.user_quote || item.correction_intent || ""}` !== key),
  ].slice(0, MAX_SESSION_CORRECTIONS);
  state.updatedAt = Date.now();
  sessionCorrectionWorkingSet.set(sessionId, state);
}

function takeSessionCorrectionForCurator(sessionId: string | undefined): CorrectionSignal | null {
  if (!sessionId) return null;
  const state = sessionCorrectionWorkingSet.get(sessionId);
  if (!state) return null;
  const index = state.signals.findIndex((signal) => signal.typing === "durable");
  if (index < 0) return null;
  const [signal] = state.signals.splice(index, 1);
  if (state.signals.length === 0) sessionCorrectionWorkingSet.delete(sessionId);
  else state.updatedAt = Date.now();
  return signal ?? null;
}

/**
 * §4.1.4 — record a task-local correction into the session working set.
 *
 * Reduced shape only: slug / op / confidence are intentionally dropped so
 * the stored context can never be mistaken for an actionable durable
 * target downstream. Dedup key = intent|scope|quote; a repeat refreshes
 * recency (moved to front) without growing the set. LRU-capped on items
 * per session AND on total session count (oldest-updated session evicted).
 */
function rememberTaskLocal(sessionId: string | undefined, signal: CorrectionSignal): void {
  if (!sessionId) return;
  const intent = (signal.correction_intent || "").trim();
  const scope = (signal.scope_description || "").trim();
  const quote = (signal.user_quote || "").trim();
  // Require at least one non-empty natural-language field; an empty
  // task-local item carries no working context and would just be noise.
  if (!intent && !scope && !quote) return;

  const state = sessionTaskLocalSet.get(sessionId) ?? { items: [], updatedAt: Date.now() };
  // Structured dedup key (JSON.stringify, NOT pipe-join): a pipe inside any
  // field would let two semantically distinct items collide on a delimiter-
  // joined key and silently drop one (3-T0 review consensus P2).
  const keyOf = (it: { intent: string; scope: string; quote: string }) =>
    JSON.stringify([it.intent, it.scope, it.quote]);
  const key = keyOf({ intent, scope, quote });
  state.items = [
    { intent, scope, quote, at: Date.now() },
    ...state.items.filter((it) => keyOf(it) !== key),
  ].slice(0, MAX_TASK_LOCAL_ITEMS);
  state.updatedAt = Date.now();
  sessionTaskLocalSet.set(sessionId, state);

  // Session-axis LRU: evict oldest-updated sessions beyond the cap.
  if (sessionTaskLocalSet.size > MAX_TASK_LOCAL_SESSIONS) {
    const evictCount = sessionTaskLocalSet.size - MAX_TASK_LOCAL_SESSIONS;
    const oldest = [...sessionTaskLocalSet.entries()]
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
      .slice(0, evictCount);
    for (const [sid] of oldest) sessionTaskLocalSet.delete(sid);
  }
}

/**
 * §4.1.4 — NON-CONSUMING read of the session's task-local working set.
 *
 * Returns a deep copy in the curator-facing shape (timestamps dropped) so
 * the same evidence keeps surfacing on EVERY subsequent agent_end curator
 * call within the session. Never mutates or removes items — only session
 * end (or LRU eviction) clears them. Empty array when nothing is stored.
 */
function getTaskLocalForCurator(
  sessionId: string | undefined,
): { intent: string; scope: string; quote: string }[] {
  if (!sessionId) return [];
  const state = sessionTaskLocalSet.get(sessionId);
  if (!state || state.items.length === 0) return [];
  return state.items.map((it) => ({ intent: it.intent, scope: it.scope, quote: it.quote }));
}

function dispatchCorrectionSignal(
  signal: CorrectionSignal | null | undefined,
  opts: { sessionId?: string; currentCurator?: boolean; captureTaskLocal?: boolean } = {},
): {
  forwarded: CorrectionSignal | null;
  decision:
    | "forwarded_to_curator"
    | "stored_durable"
    | "stored_task_local"
    | "dropped_debug"
    | "dropped_unknown_typing"
    | "pending_multiview"
    | "no_signal";
  reason: string;
} {
  if (!signal || !signal.signal_found) {
    return {
      forwarded: null,
      decision: "no_signal",
      reason: "classifier produced no active-correction signal",
    };
  }
  switch (signal.typing) {
    case "debug":
      return {
        forwarded: null,
        decision: "dropped_debug",
        reason: "per ADR §4.1.4 debug signals only land in classifier audit, never curator advisory",
      };
    case "task-local":
      if (opts.captureTaskLocal) {
        rememberTaskLocal(opts.sessionId, signal);
      }
      return {
        forwarded: null,
        decision: "stored_task_local",
        reason: opts.captureTaskLocal
          ? "task-local correction recorded into the session working set (§4.1.4); injected as NON-DURABLE context into future same-session curator calls, never as a durable advisory"
          : "task-local correction kept audit-only (no captureTaskLocal sink in this lane); never injected into durable curator calls",
      };
    case "durable":
      if (!opts.currentCurator) {
        rememberSessionCorrection(opts.sessionId, signal);
        return {
          forwarded: null,
          decision: "stored_durable",
          reason: "durable correction stored for later same-session curator calls; no current curator is available in this lane",
        };
      }
      return {
        forwarded: signal,
        decision: (signal.confidence ?? 0) >= 8 ? "pending_multiview" : "forwarded_to_curator",
        reason: `durable typing${signal.confidence !== undefined ? ` (conf=${signal.confidence})` : ""} forwarded to curator advisory${(signal.confidence ?? 0) >= 8 ? "; multi-view must gate any resulting high-value write" : ""}`,
      };
    default:
      // Unknown / missing typing indicates classifier schema drift or a
      // partial parse. Keep it in audit, but do NOT forward to curator:
      // an untyped correction hypothesis has no safe dispatch semantics.
      return {
        forwarded: null,
        decision: "dropped_unknown_typing",
        reason: `signal has unknown or missing typing (${JSON.stringify(signal.typing ?? null)}); dropped from curator advisory`,
      };
  }
}

function shouldAdvanceAfterAboutMeResults(results: WriteAboutMeResult[]): boolean {
  const terminalReasons = new Set([
    "duplicate_slug",
    "duplicate_slug_race",
    "validation_error",
    "route_rejected",
    "lint_error",
  ]);
  return results.every((result) => {
    if (result.status === "created" || result.status === "skipped" || result.status === "dry_run") return true;
    if (!result.reason) return false;
    return terminalReasons.has(result.reason) || result.reason.startsWith("credential pattern detected");
  });
}

function safeAuditIdPart(value: string | undefined, fallback: string): string {
  const cleaned = (value || fallback)
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (cleaned || fallback).slice(-24);
}

function makeCorrelationId(
  lane: "explicit" | "auto_write" | "about_me" | "replay",
  sessionId: string,
  window: Pick<RunWindow, "lastEntryId">,
): string {
  return `${lane}-${safeAuditIdPart(sessionId, "session")}-${safeAuditIdPart(window.lastEntryId, "entry")}-${Date.now().toString(36)}`;
}

function makeShortWindow(window: RunWindow): RunWindow {
  return window.skipReason === "window_too_small" ? { ...window, skipReason: undefined } : window;
}

function candidateIdFor(correlationId: string, index: number): string {
  return `${correlationId}:c${index + 1}`;
}

function resultSummary(result: WriteProjectEntryResult) {
  return {
    status: result.status,
    slug: result.slug,
    reason: result.reason,
    path: result.path,
    deleteMode: result.deleteMode,
    lintErrors: result.lintErrors,
    lintWarnings: result.lintWarnings,
    validationErrors: result.validationErrors,
    duplicate: result.duplicate,
    sanitizedReplacements: result.sanitizedReplacements,
    gitCommit: result.gitCommit,
    correlation_id: result.correlationId,
    candidate_id: result.candidateId,
  };
}

function registerSedimentCommand(pi: ExtensionAPI) {
  const maybePi = pi as unknown as {
    registerCommand?: (
      name: string,
      options: {
        description?: string;
        getArgumentCompletions?: (
          prefix: string,
        ) => Array<{ value: string; label: string }> | null;
        handler: (
          args: string,
          ctx: {
            cwd?: string;
            sessionManager?: {
              getBranch(): unknown[];
              getSessionId?(): string | undefined | null;
              getSessionFile?(): string | undefined | null;
            };
            modelRegistry?: unknown;
            signal?: AbortSignal;
            ui: { notify(message: string, type?: string): void };
          },
        ) => Promise<void> | void;
      },
    ) => void;
  };
  if (typeof maybePi.registerCommand !== "function") return;

  maybePi.registerCommand("sediment", {
    description:
      "Sediment status/dedupe: /sediment status — show writer queue + audit tail; /sediment dedupe --title <title> (or bare /sediment dedupe <title> as shorthand) — check if <title> would collide with an existing project entry slug",
    getArgumentCompletions(prefix: string) {
      const items = ["status", "dedupe --title "];
      const filtered = items.filter((item) => item.startsWith(prefix));
      return filtered.length
        ? filtered.map((value) => ({ value, label: value }))
        : null;
    },
    async handler(
      args: string,
      ctx: {
        cwd?: string;
        sessionManager?: {
          getBranch(): unknown[];
          getSessionId?(): string | undefined | null;
          getSessionFile?(): string | undefined | null;
        };
        modelRegistry?: unknown;
        signal?: AbortSignal;
        ui: { notify(message: string, type?: string): void };
      },
    ) {
      const cwd = path.resolve(ctx.cwd || process.cwd());
      const settings = resolveSedimentSettings();
      const sessionId = readSessionId(ctx.sessionManager);
      const [subcommand = "status", ...rest] = args.trim()
        ? args.trim().split(/\s+/)
        : [];

      if (subcommand === "status") {
        ctx.ui.notify(
          [
            `Sediment enabled: ${settings.enabled}`,
            `Git commit: ${settings.gitCommit}`,
            `Lock timeout: ${settings.lockTimeoutMs}ms`,
            `Window: min=${settings.minWindowChars} chars, max=${settings.maxWindowChars} chars, entries=${settings.maxWindowEntries}`,
            `LLM extractor model: ${settings.extractorModel}`,
            `Auto LLM write enabled: ${settings.autoLlmWriteEnabled}`,
            "Auto LLM extractor: LIVE on agent_end after explicit MEMORY miss; no dry-run/readiness/rate/sampling/rolling semantic gates",
          ].join("\n"),
          "info",
        );
        return;
      }

      if (subcommand === "dedupe") {
        // Two accepted forms (documented in command description):
        //   /sediment dedupe --title <title>   — canonical
        //   /sediment dedupe <title>           — shorthand, all remaining
        //                                        tokens joined as the title
        // Both produce identical results; the shorthand is here because
        // titles often contain spaces and quoting them in the slash command
        // line is awkward.
        const titleFlagIndex = rest.indexOf("--title");
        const title =
          titleFlagIndex >= 0
            ? rest
                .slice(titleFlagIndex + 1)
                .join(" ")
                .trim()
            : rest.join(" ").trim();
        if (!title) {
          ctx.ui.notify("Usage: /sediment dedupe --title <title> (or /sediment dedupe <title>)", "warning");
          return;
        }
        // Post-2026-05-13 B5 cutover: project entries live in
        // `<abrainHome>/projects/<projectId>/`, not `<cwd>/.pensieve/`.
        // Scan abrain target so dedupe sees the canonical store; require
        // strict binding (same contract as sediment writer).
        const abrainHomeForDedupe = resolveAbrainHomeForSediment();
        const binding = resolveActiveProject(cwd, { abrainHome: abrainHomeForDedupe });
        if (!binding.activeProject) {
          ctx.ui.notify(
            `Not bound (binding=${binding.reason}). Run /abrain bind --project=<id> before /sediment dedupe.`,
            "warning",
          );
          return;
        }
        const scanRoot = abrainProjectDir(abrainHomeForDedupe, binding.activeProject.projectId);
        const result = await detectProjectDuplicate(scanRoot, title);
        ctx.ui.notify(
          JSON.stringify(result, null, 2),
          result.duplicate ? "warning" : "info",
        );
        return;
      }

      ctx.ui.notify(
        "Usage: /sediment status OR /sediment dedupe --title <title>",
        "warning",
      );
    },
  });
}

export default function (pi: ExtensionAPI) {
  // ── Sub-pi enforce ──────────────────────────────────────────
  // ADR 0014 §6 defense-in-depth: sub-pi has no need for sediment
  // write hooks or tools. Dispatch sets PI_ABRAIN_DISABLED=1.
  if (process.env.PI_ABRAIN_DISABLED === "1") return;

  // Verify internal pi APIs we depend on. Missing APIs degrade gracefully
  // but log a warning so operators know after a pi upgrade.
  verifyPiInternals({ pi });

  registerSedimentCommand(pi);
  registerAboutMeCommand(pi);

  // ── System-prompt injection: main-session read-only contract ──
  //
  // Why this lives here (not in the user's AGENTS.md):
  //
  // The rule "main session reads memory but does NOT write" is a
  // sediment-extension behavior contract — it only makes sense when
  // sediment is loaded and enabled, and the wording references
  // sediment-specific lanes (auto-write / explicit MEMORY: marker /
  // /sediment slash). Pinning it in a user-global AGENTS.md means:
  //   (a) users who disable sediment still see the rule (confusing),
  //   (b) users on older pi-astack with stale terminology (gbrain /
  //       /skill:pensieve) drift out of sync with what the extension
  //       actually exposes today,
  //   (c) the rule appears even in sub-pi contexts where
  //       PI_ABRAIN_DISABLED=1 already short-circuits the extension.
  //
  // Hosting it inside the extension fixes all three: the text ships
  // alongside the code that enforces it, evolves with the same commit,
  // and only appears when the extension is actually active.
  //
  // Pattern mirrors model-curator/index.ts:350 (idempotency marker +
  // string-concat append — the only native API for system-prompt
  // injection per docs/extensions.md §before_agent_start).
  const SEDIMENT_INJECT_MARKER = "<!-- pi-astack/sediment: main-session read-only contract -->";
  pi.on("before_agent_start", async (event: { systemPrompt?: string }, ctx?: unknown) => {
    // ADR 0027 PR-B: sub-agent should NOT trigger sediment’s sticky-rule
    // surveillance — sub-agent system prompts are dispatch-generated, not
    // user-authored, so there’s no “user sticky rule” signal to observe.
    if (isSubAgentSession(ctx as { sessionManager?: unknown })) return;
    const settings = resolveSedimentSettings();
    if (!settings.enabled) return undefined;
    const current = event.systemPrompt ?? "";
    if (current.includes(SEDIMENT_INJECT_MARKER)) return undefined;
    const block = `${SEDIMENT_INJECT_MARKER}
## 长期记忆：主会话只读不写

主会话**不要**主动写 memory entry，不论是直接编辑
\`~/.abrain/projects/<id>/\` 下的 markdown、调用任何 memory 写入 API，
还是在仓库里顺手 git commit 进去。这些是后台 sediment
sidecar 的工作：它在每轮 \`agent_end\` 后看完整上下文决定该
写什么、如何去重、slug 冲突怎么处理。主会话越位会：

- 和 sediment race（同一洞察两份 slug）
- 绕过去重 / 风格对齐
- 推动 LLM 将每件事都评价为“值得记录”，污染主线思考

过渡期仍存在少量显式诊断/迁移入口，但主会话不要主动教用户使用或生成
任何大脑管理类入口。只有当用户已经主动输入这类命令/结构化块，或明确要求
“按这个显式入口处理”时，才把它当作用户给出的数据/命令继续当前任务；
否则不要写结构化记忆块、不要建议 slash，让后台 sediment 自己接 —— 它看到了。

读是完全开放的：\`memory_search\` / \`memory_get\` / \`memory_list\` /
\`memory_neighbors\` / \`memory_decide\` 都鼓励动手前查。
`;
    return { systemPrompt: current + "\n\n" + block };
  });

  // §4.1.4 lifecycle (3-T0 P1): clear THIS session's task-local working
  // set when the session ends, for any reason (quit/reload/new/resume/
  // fork). The session-axis LRU is the backstop for persistent-process
  // modes where the module is not torn down; this handler makes "cleared
  // at session end" literal rather than incidental, and stops task-local
  // user quotes from lingering in process memory across unrelated
  // sessions. delete() on an absent key is a safe no-op (sub-agents and
  // task-local-free sessions never populate the set).
  pi.on(
    "session_shutdown",
    (
      _event: unknown,
      ctx: { sessionManager?: { getSessionId?(): string | undefined | null } },
    ) => {
      const sessionId = readSessionId(ctx.sessionManager);
      if (sessionId) sessionTaskLocalSet.delete(sessionId);
    },
  );

  // Footer state machine: session_start sets idle UNLESS bg work from
  // a previous session is still inflight (e.g. user did /new while
  // sediment was extracting). In that case show running so the user
  // knows sediment didn't silently abort.
  pi.on(
    "session_start",
    async (
      _event: unknown,
      ctx: {
        sessionManager?: {
          getSessionId?(): string | undefined | null;
          getSessionFile?(): string | undefined | null;
        };
        ui?: { setStatus?(extId: string, message?: string): void };
      },
    ) => {
      // ADR 0027 PR-B: sub-agent has no sediment footer / no checkpoint
      // to advance / no UI to attach to. Skip entirely.
      if (isSubAgentSession(ctx)) return;

      const settings = resolveSedimentSettings();
      if (!settings.enabled) return;

      // ADR 0025 P0: ensure the sidecar staging directory exists.
      const abrainHome = resolveAbrainHomeForSediment();
      await mkdir(abrainSedimentStagingPath(abrainHome), { recursive: true });

      const sessionId = readSessionId(ctx.sessionManager);
      const setStatusRaw = ctx.ui?.setStatus?.bind(ctx.ui);
      const setStatus = setStatusRaw
        ? (msg?: string) => {
            try {
              setStatusRaw(SEDIMENT_STATUS_KEY, msg);
            } catch {}
          }
        : undefined;
      // Always refresh globalThis.__sediment_latestSetStatus so bg work
      // from a PREVIOUS session (whose module was torn down by pi on
      // /new) can still reach the current footer. Same for
      // currentSessionId — used by maybeSetIdleIfNoInflight to tell
      // same-session vs cross-session bg completion apart.
      _G.__sediment_latestSetStatus = setStatus;
      _G.__sediment_currentSessionId = sessionId;

      if ((_G.__sediment_inflightCount ?? 0) > 0 || multiViewReplayInFlight.size > 0) {
        // Inflight bg work from previous session — show running, NOT idle.
        applySedimentStatus(setStatus, sessionId, "running", "prev session");
      } else {
        applySedimentStatus(setStatus, sessionId, "idle");
      }
    },
  );

  // Footer state machine: agent_start resets completed/failed back to
  // idle so each new prompt starts visually clean. running stays
  // unchanged so a long-running bg work from the previous turn
  // remains visible. Also checks autoWriteInFlight in case bg work
  // from a previous session is still running after /new.
  pi.on(
    "agent_start",
    async (
      _event: unknown,
      ctx: {
        sessionManager?: {
          getSessionId?(): string | undefined | null;
          getSessionFile?(): string | undefined | null;
        };
        ui?: { setStatus?(extId: string, message?: string): void };
      },
    ) => {
      // ADR 0027 PR-B: sub-agent session has no sediment lifecycle to track.
      if (isSubAgentSession(ctx)) return;

      const settings = resolveSedimentSettings();
      if (!settings.enabled) return;
      const sessionId = readSessionId(ctx.sessionManager);
      if (!sessionId) return;
      const c = sessionAgentCycle.get(sessionId) ?? { started: 0, ended: 0, drainCount: 0 };
      c.started++;
      c.drainCount = 0; // reset drain counter for new agent cycle
      sessionAgentCycle.set(sessionId, c);
      const prev = sedimentStatusBySession.get(sessionId);
      if (prev !== "completed" && prev !== "failed") return; // running -> stay; idle -> already idle
      const setStatusRaw = ctx.ui?.setStatus?.bind(ctx.ui);
      const setStatus = setStatusRaw
        ? (msg?: string) => {
            try {
              setStatusRaw(SEDIMENT_STATUS_KEY, msg);
            } catch {}
          }
        : undefined;
      _G.__sediment_latestSetStatus = setStatus;
      _G.__sediment_currentSessionId = sessionId;
      // If bg work from a previous session is still inflight, keep
      // showing running instead of resetting to idle.
      if ((_G.__sediment_inflightCount ?? 0) > 0 || multiViewReplayInFlight.size > 0) {
        applySedimentStatus(setStatus, sessionId, "running", "prev session");
      } else {
        applySedimentStatus(setStatus, sessionId, "idle");
      }
    },
  );

  pi.on(
    "agent_end",
    async (
      event: {
        messages?: ReadonlyArray<{
          role?: string;
          stopReason?: string;
          errorMessage?: string;
        }>;
      },
      ctx: {
        cwd?: string;
        sessionManager?: {
          getBranch(): unknown[];
          getSessionId?(): string | undefined | null;
          getSessionFile?(): string | undefined | null;
        };
        modelRegistry?: unknown;
        signal?: AbortSignal;
        ui?: {
          notify(message: string, type?: string): void;
          setStatus?(extId: string, message?: string): void;
        };
      },
    ) => {
      // ADR 0027 PR-B (critical): sub-agent output is a tool product, not
      // user conversation. Letting sediment extract from it would pollute
      // the brain with LLM-reasoning artifacts instead of user implicit
      // ground truth signal (violates ADR 0025 INV-IMPLICIT-GROUND-TRUTH).
      // This is the v3 in-process replacement for PI_ABRAIN_DISABLED env
      // gate from the v2 subprocess model.
      if (isSubAgentSession(ctx)) return;

      // ADR 0027 PR-B+ R1 P0-β: snapshot anchor at handler entry. The
      // body below kicks off fire-and-forget bg work (Lane C extractor,
      // curator, aggregator scheduler) that may run for ~60s and still
      // call getCurrentAnchor() after the user submits the NEXT prompt.
      // Without this scope, those late writes would carry turn N+1's
      // anchor for work triggered by turn N — wrong join key.
      // AsyncLocalStorage propagates the snapshot through await chains
      // AND through fire-and-forget promises created inside this closure.
      // ALL existing `return;` statements below return from the inner
      // async fn; the outer handler returns the runWithTriggerAnchor
      // promise which resolves to the inner result — same observable
      // behavior.
      return runWithTriggerAnchor(getCurrentAnchor(), async () => {

      const settings = resolveSedimentSettings();
      if (!settings.enabled) return;

      // Capture everything we need from `ctx` SYNCHRONOUSLY before the first
      // await. pi may invalidate ctx ("stale ctx") if newSession/fork/reload
      // happens during our async work; touching ctx after invalidation
      // throws "Extension error: stale ctx". Capturing values upfront makes
      // the rest of the handler ctx-independent.
      let cwd = path.resolve(ctx.cwd || process.cwd());
      if (!ctx.sessionManager?.getBranch) return;
      let branch: unknown[];
      try {
        branch = ctx.sessionManager.getBranch();
      } catch {
        // ctx already stale at hook entry — skip silently.
        return;
      }
      const sessionId = readSessionId(ctx.sessionManager);
      // Track agent_end for drain-loop gating (only drain when LLM not working).
      if (sessionId) {
        const c = sessionAgentCycle.get(sessionId) ?? { started: 0, ended: 0, drainCount: 0 };
        c.ended++;
        sessionAgentCycle.set(sessionId, c);
      }
      // Capture getBranch for drain-loop re-reads (bg work outlives ctx).
      const getBranch = ctx.sessionManager.getBranch.bind(ctx.sessionManager);
      // Capture sessionManager for continuation-call extractor (bg work outlives ctx).
      const sessMgr = ctx.sessionManager;
      const notify = ctx.ui?.notify?.bind(ctx.ui);
      // setStatus is ctx.ui.setStatus; we need to bind it AND tolerate
      // older pi versions where the method is missing. Wrap in a
      // try/catch so a stale-ctx late call cannot throw out of bg work.
      const setStatusRaw = ctx.ui?.setStatus?.bind(ctx.ui);
      const setStatus = setStatusRaw
        ? (msg?: string) => {
            try {
              setStatusRaw(SEDIMENT_STATUS_KEY, msg);
            } catch {}
          }
        : undefined;
      // Capture EVERY ctx field we'll need post-await synchronously.
      // pi may invalidate ctx ("stale ctx") between any await pair if a
      // newSession/fork/reload/process-shutdown race fires; touching
      // ctx after invalidation throws "Extension error: stale ctx". Do NOT
      // pass ctx.signal into fire-and-forget LLM work: it is tied to the
      // foreground turn lifecycle and gets aborted when the user continues,
      // which would cancel sediment mid-flight.
      const modelRegistry = ctx.modelRegistry;
      const settingsSnapshot = snapshotSedimentSettings(settings);

      // Ephemeral sessions (`pi --print --no-session`, dispatch_agent
      // subprocess, CI / automation) refuse to run the deterministic
      // extractor entirely.
      //
      // Rationale:
      //   - Subagents return their output to the calling session via
      //     tool_result; that real session's own agent_end hook will see
      //     the subagent's content (including any MEMORY: blocks) and
      //     sediment it there. Running sediment in the subprocess too is
      //     redundant.
      //   - `--no-session` is a user-explicit "throwaway" signal; writing
      //     to .pensieve/ + git committing it directly contradicts that.
      //   - Attribution: an entry written from `session_id: undefined` has
      //     no session JSONL to trace back to; future debugging cannot
      //     answer "where did this come from?".
      //
      // We still record a single audit row for observability so users
      // running `tail audit.jsonl` can see ephemeral runs happened.
      if (!sessionId) {
        await appendAudit(cwd, {
          operation: "skip",
          lane: "system",
          reason: "ephemeral_session",
          ephemeral_session: true,
          branch_size: branch.length,
          settings_snapshot: settingsSnapshot,
          extractor: "explicit_marker",
          parser_version: PARSER_VERSION,
          checkpoint_advanced: false,
          stage_ms: { window_build: 0, parse: 0, write_total: 0, total: 0 },
        });
        return;
      }

      // Skip sediment when the agent loop ended unhealthy (LLM error or
      // user-abort). Per spec: do NOT advance checkpoint — the next
      // successful agent_end will re-process this window so MEMORY: blocks
      // written before the failure (or regenerated cleanly on retry) are
      // still recoverable. We still emit one audit row + a footer status
      // so the skip is visible / traceable.
      //
      // Only `error` and `aborted` are treated as unhealthy here. `length`
      // (token truncation) and `toolUse` (rare at loop end) are left in
      // the healthy path because MEMORY: blocks typically aren't at the
      // tail and may still be intact.
      const lastAssistant = [...(event.messages ?? [])]
        .reverse()
        .find((m) => m?.role === "assistant");
      const unhealthyStopReason =
        lastAssistant?.stopReason === "error"
          ? "agent_error"
          : lastAssistant?.stopReason === "aborted"
            ? "agent_aborted"
            : null;
      // ADR 0017 / B4.5 strict binding: sediment is a project-scoped
      // writer. Resolve it before all non-ephemeral audit/checkpoint paths,
      // including unhealthy-stop skips, so launching pi from a repo subdir
      // never splits audit/checkpoint files into <repo>/subdir/.pi-astack.
      const binding = resolveActiveProject(cwd, { abrainHome: resolveAbrainHomeForSediment() });
      if (!binding.activeProject) {
        await appendAudit(cwd, {
          operation: "skip",
          lane: "system",
          reason: "project_not_bound",
          binding_status: binding.reason,
          hint: binding.reason === "manifest_missing" ? "/abrain bind --project=<id>" : "/abrain bind",
          session_id: sessionId,
          branch_size: branch.length,
          stop_reason: lastAssistant?.stopReason,
          settings_snapshot: settingsSnapshot,
          extractor: "explicit_marker",
          parser_version: PARSER_VERSION,
          checkpoint_advanced: false,
          stage_ms: { window_build: 0, parse: 0, write_total: 0, total: 0 },
        });
        // Strict binding failure means sediment did NOT observe/write the
        // project. Surface it as a warning/error state, not as ✅ completed;
        // INV-INVISIBILITY means no user management burden, not misleading
        // health reporting.
        applySedimentStatus(setStatus, sessionId, "failed", `project_not_bound:${binding.reason}`);
        return;
      }
      // From this point on, all checkpoint/audit/writer paths must use the
      // bound project root, not the launch subdirectory. Otherwise starting
      // pi from <repo>/subdir would pass strict binding via git root and
      // write checkpoint/audit into <repo>/subdir/.pi-astack/ — fragmenting
      // forensic data across a real project root and a non-canonical sibling.
      cwd = binding.activeProject.projectRoot;
      // Closure-scoped abrain identity, used by every writer invocation
      // below. Per the 2026-05-13 sediment cutover, entry markdown lives
      // in `<abrainHome>/projects/<projectId>/` (the project repo itself
      // is no longer a sediment write substrate).
      const projectId = binding.activeProject.projectId;
      const abrainHome = resolveAbrainHomeForSediment();

      if (unhealthyStopReason) {
        const lastBranchEntry = branch.length > 0 ? branch[branch.length - 1] : undefined;
        const lastBranchEntryId = lastBranchEntry && typeof lastBranchEntry === "object" && "id" in lastBranchEntry
          ? (lastBranchEntry as { id?: unknown }).id
          : undefined;
        const deferredAt = new Date().toISOString();
        deferredStopBySession.set(sessionId, {
          reason: unhealthyStopReason,
          sessionId,
          lastEntryId: typeof lastBranchEntryId === "string" ? lastBranchEntryId : undefined,
          timestamp: deferredAt,
        });
        await appendAudit(cwd, {
          operation: "skip",
          lane: "system",
          reason: unhealthyStopReason,
          deferred: true,
          recovery: "next_healthy_agent_end",
          session_id: sessionId,
          branch_size: branch.length,
          stop_reason: lastAssistant?.stopReason,
          deferred_at: deferredAt,
          deferred_last_entry_id: typeof lastBranchEntryId === "string" ? lastBranchEntryId : undefined,
          // Round 9 P1 (sonnet R9-4 fix): cap error_message at 500 chars
          // to avoid leaking provider-side error spew that may echo back
          // request body (which can contain pasted secrets) into
          // audit.jsonl. Other audit rows (drain failures, checkpoint
          // save) already cap; main bg path was the lone exception.
          error_message: sanitizeAuditText(lastAssistant?.errorMessage, 500),
          settings_snapshot: settingsSnapshot,
          extractor: "explicit_marker",
          parser_version: PARSER_VERSION,
          checkpoint_advanced: false,
          stage_ms: { window_build: 0, parse: 0, write_total: 0, total: 0 },
        });
        // Error/abort means sediment intentionally skipped this turn and
        // held the checkpoint for retry. Surface as ⚠️ with explicit
        // deferral semantics, not ✅ completed and not a generic pipeline
        // failure.
        applySedimentStatus(setStatus, sessionId, "failed", formatDeferredStopStatusDetail(unhealthyStopReason));
        return;
      }

      // Outcome collection runs only after the turn is known healthy and the
      // launch cwd has been canonicalized to the bound project root. Aborted /
      // errored assistant messages can contain partial footnotes/tool traces;
      // keep those out of ADR 0026 weighting.
      if (sessionId) {
        const outcome = collectOutcomes(branch, sessionId);
        if (outcome.rows.length > 0) {
          writeOutcomeLedger(outcome.rows, cwd);
        }
        if (outcome.dropped.length > 0) {
          appendAudit(cwd, {
            operation: "outcome_footnote_parse_error",
            session_id: sessionId,
            dropped_count: outcome.dropped.length,
            dropped: outcome.dropped,
          }).catch(() => {});
        }
      }

      // Outcome→Entry feedback edge, Tier-A read-only telemetry lane (3-T0
      // sequencing decision 2026-06-04). Fire-and-forget like the aggregator;
      // derives ONLY from the outcome-ledger flushed just above and writes a
      // git-ignored sidecar. It NEVER touches durable memory (no writer /
      // curator / multi-view imports — locked by smoke). Debounced ~1h inside
      // mergeEntryTelemetryIfDue. Wired BEFORE the durable executor exists so
      // that unit's later code 3-T0 reviews against REAL accumulated telemetry
      // rather than synthetic fixtures. No LLM, so it runs in every mode.
      const scheduleTelemetry = typeof setImmediate === "function"
        ? setImmediate
        : (fn: () => void) => setTimeout(fn, 0);
      scheduleTelemetry(() => {
        try { mergeEntryTelemetryIfDue({ projectRoot: cwd }); }
        catch { /* advisory-only; telemetry failure never affects sediment */ }
      });

      // ADR 0025 §4.3 skeptical-historian MVP: schedule deterministic
      // advisory aggregation over existing sidecars. setImmediate keeps the
      // sync JSONL scans off the hot agent_end path; last-run gating keeps
      // the sidecar bounded to a daily cadence. It never prompts the user,
      // gates writes, or mutates memory entries.
      const scheduleAggregator = typeof setImmediate === "function"
        ? setImmediate
        : (fn: () => void) => setTimeout(fn, 0);
      scheduleAggregator(() => {
        void (async () => {
          try {
            // Phase C.3 (ADR 0025 §4.3): pass modelRegistry so the v1
            // LLM skeptical-historian pass runs after the deterministic
            // v0.2 mechanical aggregation. modelRegistry may be undefined
            // in ephemeral/dispatch contexts — the aggregator falls back
            // to v0.2-only behavior in that case (backward-compatible).
            // No ctx.signal here: aggregator is fire-and-forget bg, must
            // not be aborted when the user continues the next turn.
            //
            // R8 P1 fix (Opus + GPT-5.5 + DeepSeek unanimous): when
            // autoLlmWriteEnabled === false, settings.ts docstring
            // promises "no LLM tokens spent on sediment in any
            // agent_end". Other 4 lanes honor that (classifier,
            // archive-reactivation, multi-view replay, auto-write); the
            // aggregator silently violated it by always passing
            // modelRegistry, which lets the v1 skeptical-historian LLM
            // pass fire. We now drop the registry in `false` mode so
            // aggregator degrades to v0.2 mechanical-only (still useful
            // for diagnostic advisory, costs 0 LLM tokens).
            const llmAllowed = settings.autoLlmWriteEnabled !== false;
            const summary = await runAndWriteSedimentAggregatorIfDue({
              projectRoot: cwd,
              settings,
              sessionId,
              modelRegistry: llmAllowed
                ? (modelRegistry as Parameters<typeof runAndWriteSedimentAggregatorIfDue>[0]["modelRegistry"])
                : undefined,
            });
            if (!summary) return;
            // Phase C round-2 review P1-1/P1-2/P1-3 fix: distinguish the three
            // execution engines so audit consumers can disambiguate v1 success
            // from v0.2 fallback and from no-model-registry skip. v1 prompt §6
            // requires audit row gate to use promoted_advisories (NOT v0.2
            // mechanical advisories). The promoted_kinds + degraded flag carry
            // enough state for the next aggregator's prior_aggregator_summaries.
            const promoted = summary.prompt_native?.promoted_advisories ?? [];
            const llmAttempted = !!modelRegistry;
            // Phase C round-3 P3: source-side discriminator on the
            // AggregatorSummary itself. Fall back to local recompute if
            // a future caller path produces a summary without this field.
            const aggregatorEngine =
              summary.aggregator_engine
              ?? (!llmAttempted
                ? "mechanical_v0_2_no_model_registry"
                : summary.degraded_to_mechanical
                  ? "mechanical_v0_2_degraded"
                  : "prompt_native_v1");
            // Audit row gate (v1 prompt §6 contract): emit the aggregator_advisory
            // row when EITHER v1 promoted_advisories non-empty (real LLM signal)
            // OR mechanical advisories present AND we did NOT run a successful v1
            // pass (i.e. degraded or no-registry — mechanical is the only signal
            // we have, so it's the audit substrate for that run).
            const v1Promoted = aggregatorEngine === "prompt_native_v1" && promoted.length > 0;
            const mechanicalFallbackAudit = aggregatorEngine !== "prompt_native_v1" && summary.advisories.length > 0;
            if (!v1Promoted && !mechanicalFallbackAudit) return;
            await appendAudit(cwd, {
              operation: "aggregator_advisory",
              lane: "diagnostic",
              session_id: sessionId,
              ok: summary.ok,
              aggregator_engine: aggregatorEngine,
              llm_attempted: llmAttempted,
              degraded_to_mechanical: !!summary.degraded_to_mechanical,
              ...(summary.degraded_reason ? { degraded_reason: summary.degraded_reason } : {}),
              // Both lists shown for transparency; the gate above decided which
              // is authoritative for this run.
              promoted_advisory_count: promoted.length,
              promoted_advisory_kinds: promoted.map((a) => a.kind),
              mechanical_advisory_count: summary.advisories.length,
              mechanical_advisory_kinds: summary.advisories.map((a) => a.kind),
              advisories: aggregatorEngine === "prompt_native_v1" ? promoted : summary.advisories,
              staging: summary.staging,
              outcome: {
                window_rows: summary.outcome.window_rows,
                slugs_seen: summary.outcome.slugs_seen,
                high_unused_count: summary.outcome.high_unused.length,
                echo_chamber_candidate_count: summary.outcome.echo_chamber_candidates.length,
              },
              audit: {
                recent_rows: summary.audit.recent_rows,
                error_like_count: summary.audit.error_like_count,
              },
              prompt_version: buildPromptVersionAudit("aggregator", settings),
            });
          } catch {
            // Advisory-only; aggregator failures must never affect sediment.
          }
        })();
      });

      // Lane R: replay old multi-view staging backlog on every healthy,
      // bound agent_end, independent of whether this turn also has an
      // explicit marker or a natural-language auto-write window. The old
      // implementation only scheduled replay after Lane A/G, so ordinary
      // conversation turns could leave multiview-pending files undrained.
      scheduleMultiviewReplay({
        enabled: settings.autoLlmWriteEnabled !== false,
        cwd,
        sessionId,
        settings,
        modelRegistry,
        abrainHome,
        projectId,
      });

      // ADR 0025 §4.1.5.1 staging-resolver (Stage 3, 2026-05-29).
      // Debounced batch pass that TRIAGES the provisional-correction staging
      // backlog. NON-DESTRUCTIVE: it only annotates each entry's
      // resolver_disposition (likely_noise / plausible / promote_candidate) +
      // reviewed-at and NEVER flips attribution_pending or deletes files —
      // retirement stays the job of the time-bounded age-out (deletion sweep
      // is a deferred follow-up). Fire-and-forget; never blocks main session.
      // Gated like archive-reactivation: false → no LLM tokens, no scheduling.
      // It only rewrites .state staging files (never durable entries), so it
      // is safe under "staging-only" too (promotion-to-durable is deferred to
      // a multi-view follow-up; the resolver only flags promote_candidate).
      if (settings.autoLlmWriteEnabled !== false) scheduleAggregator(() => {
        void (async () => {
          try {
            const recentForStaging = branch.slice(-50);
            const stagingWindowText = recentForStaging
              .map((e: unknown) => entryToText(e))
              .filter((s: string) => !!s)
              .join("\n\n");
            const stagingResult = await runStagingResolverIfDue({
              projectRoot: cwd,
              windowText: stagingWindowText,
              settings,
              modelRegistry: modelRegistry as Parameters<typeof runStagingResolverIfDue>[0]["modelRegistry"],
              sessionId,
            });
            if (!stagingResult.skipped && (stagingResult.likely_noise_slugs.length > 0 || stagingResult.promote_candidates.length > 0 || stagingResult.degraded)) {
              await appendAudit(cwd, {
                operation: "staging_resolve",
                lane: "diagnostic",
                session_id: sessionId,
                ok: stagingResult.ok,
                degraded: stagingResult.degraded ?? false,
                reviewed_count: stagingResult.reviewed_count,
                likely_noise_count: stagingResult.likely_noise_slugs.length,
                plausible_count: stagingResult.plausible_count,
                promote_candidate_count: stagingResult.promote_candidates.length,
                likely_noise_slugs: stagingResult.likely_noise_slugs,
                promote_candidates: stagingResult.promote_candidates,
                model: stagingResult.model,
                duration_ms: stagingResult.durationMs,
                prompt_version: STAGING_RESOLVER_PROMPT_VERSION,
              });
            }
          } catch {
            /* fire-and-forget bg; never throw out of agent_end */
          }
        })();
      });

      // ADR 0025 §4.1.5 / §4.6.6 staging AGE-OUT reviewer (Stage 4, 2026-05-29).
      // Daily-debounced prompt-native review of AGED-OUT (≥30d) provisional
      // hypotheses — the tier the resolver explicitly skips. The reviewer
      // gives each a disposition: keep_aging / soft_archive / promote_candidate.
      // REVERSIBLE: soft_archive only flips lifecycle_state (drops the entry
      // from the active backlog) — it NEVER unlinks (staging is git-ignored
      // .state, so unlink is irreversible; the mechanical hard-delete window
      // is a deferred Stage 5). promote_candidate is ADVISORY only (multi-view
      // §4.4 still gates promotion). Only rewrites .state staging files (never
      // durable entries), so it is safe under "staging-only" too. Gated like
      // the resolver: false → no LLM tokens, no scheduling. Own 24h debounce /
      // lock / ledger, independent of the resolver's 6h cadence.
      if (settings.autoLlmWriteEnabled !== false) scheduleAggregator(() => {
        void (async () => {
          try {
            const recentForAgeOut = branch.slice(-50);
            const ageOutWindowText = recentForAgeOut
              .map((e: unknown) => entryToText(e))
              .filter((s: string) => !!s)
              .join("\n\n");
            const ageOutResult = await runStagingAgeOutIfDue({
              projectRoot: cwd,
              windowText: ageOutWindowText,
              settings,
              modelRegistry: modelRegistry as Parameters<typeof runStagingAgeOutIfDue>[0]["modelRegistry"],
              sessionId,
            });
            if (!ageOutResult.skipped && (ageOutResult.soft_archived_slugs.length > 0 || ageOutResult.promote_candidates.length > 0 || ageOutResult.degraded)) {
              await appendAudit(cwd, {
                operation: "staging_ageout",
                lane: "diagnostic",
                session_id: sessionId,
                ok: ageOutResult.ok,
                degraded: ageOutResult.degraded ?? false,
                reviewed_count: ageOutResult.reviewed_count,
                soft_archived_count: ageOutResult.soft_archived_slugs.length,
                kept_aging_count: ageOutResult.kept_aging_count,
                promote_candidate_count: ageOutResult.promote_candidates.length,
                soft_archived_slugs: ageOutResult.soft_archived_slugs,
                promote_candidates: ageOutResult.promote_candidates,
                model: ageOutResult.model,
                duration_ms: ageOutResult.durationMs,
                prompt_version: STAGING_AGEOUT_PROMPT_VERSION,
              });
            }
          } catch {
            /* fire-and-forget bg; never throw out of agent_end */
          }
        })();
      });

      // ADR 0025 §4.6 archive-reactivation reviewer (Stage 2).
      // Daily-debounced prompt-native review of archived entries: if a
      // recently-archived entry's preference is showing up in the live
      // conversation behavior, reactivate it. Fire-and-forget; never
      // blocks main session. Reuses the same scheduleAggregator helper
      // defined inline above (setImmediate when available).
      //
      // Settings semantics (R7 GPT-5.5 P2 fix):
      //   autoLlmWriteEnabled === true          → review + mutate
      //   autoLlmWriteEnabled === "staging-only" → review (LLM call) but don't flip status
      //   autoLlmWriteEnabled === false         → hard kill: NO LLM tokens, NO scheduling.
      // The settings.ts docstring promises “false = no LLM tokens spent
      // on sediment”. Honor that for archive-reactivation too.
      if (settings.autoLlmWriteEnabled !== false) scheduleAggregator(() => {
        void (async () => {
          try {
            // Avoid mutation in staging-only mode (the reviewer's
            // `reactivate` decision would call writer.updateProjectEntry,
            // which is a durable write). When autoLlmWriteEnabled is
            // "staging-only", we still want the audit signal for
            // diagnostics but no status flip — disable the
            // reactivateEntry closure in that mode.
            const canMutate = settings.autoLlmWriteEnabled === true;
            const memSettings = resolveMemorySettings();
            const allEntries = await (await import("../memory/parser"))
              .loadEntries(cwd, memSettings, undefined);
            const archived = allEntries.filter((e: { status: string }) => e.status === "archived");
            // Build a compact window text from the most recent entries
            // in branch. We use the SAME entryToText (with L2 mask) as
            // the classifier path so the reviewer never sees sub-agent
            // reasoning. ~50 most recent entries should be plenty.
            const recent = branch.slice(-50);
            const windowText = recent
              .map((e: unknown) => entryToText(e))
              .filter((s: string) => !!s)
              .join("\n\n");
            const result = await runArchiveReactivationIfDue({
              projectRoot: cwd,
              archivedEntries: archived,
              windowText,
              settings,
              modelRegistry: modelRegistry as Parameters<typeof runArchiveReactivationIfDue>[0]["modelRegistry"],
              sessionId,
              reactivateEntry: canMutate
                ? async (slug: string, scope: "project" | "world", rationale: string) => {
                    try {
                      // R1 P1-B fix: pass scope so world-scoped entries
                      // reactivate against <abrainHome>/knowledge/ instead of
                      // <abrainHome>/projects/<id>/.
                      // R2 CRIT-2 fix (GPT-5.5 P1, DeepSeek NIT-1):
                      // `auditOperation` belongs in the OPTIONS argument
                      // (WriteProjectEntryOptions), NOT the patch draft
                      // (ProjectEntryUpdateDraft has no such field).
                      // Putting it in the draft made the audit row default
                      // to operation="update", so `jq 'select(.operation
                      // == "archive_reactivation_apply")'` against audit.jsonl
                      // returned zero results.
                      const res = await updateProjectEntry(
                        slug,
                        {
                          status: "active",
                          // CAS guard (Stage 2, 2026-05-29): the reviewer
                          // decided to reactivate from an `archivedEntries`
                          // snapshot taken BEFORE the LLM call. By apply time
                          // fresher intent may have reactivated/superseded/
                          // contested/deleted the entry. Require it to STILL be
                          // archived; otherwise the write is rejected
                          // (status_precondition_failed) instead of clobbering
                          // the newer status back to active. A rejected race is
                          // a benign no-op (surfaced via res.reason below).
                          expected_status: "archived",
                          timelineAction: "reactivated",
                          timelineNote: `archive-reactivation-reviewer v1: ${rationale.slice(0, 200)}`,
                          sessionId,
                        },
                        {
                          projectRoot: cwd,
                          abrainHome,
                          projectId,
                          settings,
                          scope,
                          dryRun: false,
                          auditOperation: "archive_reactivation_apply",
                        },
                      );
                      return { ok: res.status !== "rejected", error: res.reason };
                    } catch (e: unknown) {
                      return { ok: false, error: e instanceof Error ? e.message : String(e) };
                    }
                  }
                : undefined,
            });
            // Audit each meaningful result.
            if (!result.skipped && (result.decisions.length > 0 || result.degraded)) {
              // R3 GPT R2-RESIDUAL-3 fix: surface deferred_count and
              // archived_total in audit so operators can detect batch
              // pressure / starvation risk from audit.jsonl alone
              // (without having to read the per-project reviewedAt
              // sidecar). archived_total = reviewed_count + deferred_count.
              const deferredCount = result.deferred_count ?? 0;
              await appendAudit(cwd, {
                operation: "archive_reactivation",
                lane: "diagnostic",
                session_id: sessionId,
                ok: result.ok,
                reviewed_count: result.reviewed_count,
                deferred_count: deferredCount,
                archived_total: result.reviewed_count + deferredCount,
                reactivated_slugs: result.reactivated_slugs,
                decisions_summary: result.decisions.map((d) => ({
                  slug: d.slug,
                  decision: d.decision,
                  age_days: d.age_days_approx,
                  ...(d.rationale.startsWith("reactivate_guard_failed:")
                    ? { guard_failed: true }
                    : {}),
                })),
                ...(result.degraded ? { degraded: true, degraded_reason: result.degraded_reason } : {}),
                llm_model: result.llm_model,
                llm_duration_ms: result.llm_duration_ms,
                duration_ms: result.duration_ms,
                prompt_version: buildPromptVersionAudit("archiveReactivationReviewer", settings),
              });
            }
            // R7 Opus P1-2 fix: surface reactivations to the user.
            //
            // Previously the archive-reactivation.ts docstring promised
            // “may surface in formatSedimentNotify like any other
            // create/update” but the code path never actually pushed
            // anything to ctx.ui.notify. INV-INVISIBILITY is “tell the
            // user, don’t ask” — we were doing neither: a slug the user
            // remembered as archived could silently come back active.
            //
            // We notify ONLY when reactivations actually happened (not
            // every diagnostic run). Notify is best-effort; if the host
            // dropped the ui handle (e.g. headless), we skip silently.
            //
            // R8 NIT fix (Opus): use reactivated_entries (with scope) so
            // world entries get the correct [world:<id>] label — the
            // R7 “[project]” hardcoding mis-labelled them.
            const reactivatedEntries = result.reactivated_entries
              ?? result.reactivated_slugs.map((slug) => ({ slug, scope: "project" as const }));
            if (
              !result.skipped &&
              reactivatedEntries.length > 0 &&
              ctx.ui?.notify
            ) {
              const lines: string[] = [
                `Sediment archive-reactivation (bg): ${reactivatedEntries.length} entr${reactivatedEntries.length === 1 ? "y" : "ies"} reactivated`,
              ];
              for (const re of reactivatedEntries) {
                const scopeLabel = re.scope === "world" ? "world" : `project:${projectId}`;
                lines.push(`  ↑ [${scopeLabel}] reactivated  ${re.slug}`);
              }
              try {
                ctx.ui.notify(lines.join("\n"), "info");
              } catch {
                // Notify is best-effort; never let UI error kill the
                // background lane.
              }
            }
          } catch {
            // Archive-reactivation is diagnostic; failure never affects sediment.
          }
        })();
      });

      const tStart = Date.now();
      const checkpoint = await loadSessionCheckpoint(cwd, sessionId);
      const window = buildRunWindow(branch, checkpoint, settings);
      const tWindowBuilt = Date.now();
      const summary = checkpointSummary(window);
      const entryBreakdown = countEntryTypes(window.entries);

      if ((window.skipReason && window.skipReason !== "window_too_small") || !window.lastEntryId) {
        const pendingDeferred = deferredStopBySession.get(sessionId);
        const checkpointAdvanced = !!window.lastEntryId;
        if (window.lastEntryId)
          await saveSessionCheckpoint(cwd, sessionId, {
            lastProcessedEntryId: window.lastEntryId,
          });
        await appendAudit(cwd, {
          operation: "skip",
          lane: "window",
          reason: window.skipReason ?? "no_last_entry",
          session_id: sessionId,
          ...summary,
          extractor: "explicit_marker",
          parser_version: PARSER_VERSION,
          settings_snapshot: settingsSnapshot,
          entry_breakdown: entryBreakdown,
          recovered_deferred: checkpointAdvanced && !!pendingDeferred,
          ...(checkpointAdvanced && pendingDeferred ? { previous_deferred_reason: pendingDeferred.reason } : {}),
          stage_ms: {
            window_build: tWindowBuilt - tStart,
            parse: 0,
            write_total: 0,
            total: Date.now() - tStart,
          },
          checkpoint_advanced: checkpointAdvanced,
        });
        await recordDeferredRecoveryIfNeeded({
          cwd,
          sessionId,
          window,
          checkpointAdvanced,
          lane: "window",
        });
        // Healthy no-op skip (no new entries). Mark completed so the
        // agent_start of the next prompt resets to idle.
        applySedimentStatus(
          setStatus,
          sessionId,
          "completed",
          window.skipReason ?? "no new entries",
        );
        return;
      }

      const shortWindowClassifierOnly = window.skipReason === "window_too_small";
      const effectiveWindow = makeShortWindow(window);

      const tParseStart = Date.now();
      const drafts = parseExplicitMemoryBlocks(effectiveWindow.text);
      // ADR 0021 G2 (2026-05-20): parse Lane G MEMORY-ABOUT-ME fences in
      // the same window pass. Lane A and Lane G run as TWO independent
      // synchronous write loops further below; if neither hits we still
      // drop into the LLM auto-write lane (Lane C). The bg auto-write
      // lane intentionally does NOT consume Lane G fences — explicit
      // attestation is the only way to write identity/skills/habits in
      // G1–G2 (G3 will add an LLM aboutness classifier).
      const aboutMeDrafts = parseExplicitAboutMeBlocks(effectiveWindow.text);
      const tParseEnd = Date.now();

      // ADR 0025 P1: run correction classifier as FIRE-AND-FORGET.
      // Must not block agent_end — the classifier does 2 LLM calls
      // (memory_search + classifier) which take 10-45s. Blocking here
      // makes the main session show "Working" and prevents the user
      // from continuing.
      //
      // The classifier Promise is stored so the auto-write lane can
      // await it before launching curator (correctionSignal is needed
      // for better update/merge decisions). Lane A/G don't block on it,
      // but still dispatch/audit its result asynchronously so explicit
      // correction signals are observable and available to later same-session
      // curator calls.
      let correctionPromise: Promise<Awaited<ReturnType<typeof runCorrectionPipeline>>> | null = null;
      const classifierLane =
        drafts.length > 0 ? "explicit" : aboutMeDrafts.length > 0 ? "about_me" : "auto_write";
      // ADR 0025 §5.3 P5.5 tristate: when autoLlmWriteEnabled === false (strict),
      // classifier is also disabled — a hard kill switch for users who explicitly
      // do not want sediment observing. `true` and `"staging-only"` both run the
      // classifier (staging-only writes provisional staging but skips curator/writer).
      const classifierEnabled = settings.autoLlmWriteEnabled !== false;
      if (branch && classifierEnabled) {
        correctionPromise = (async () => {
          let relatedEntries: RelatedEntryCard[] = [];
          try {
            const memSettings = resolveMemorySettings();
            const searchQuery = effectiveWindow.text.slice(-2000);
            const loadedEntries = await (await import("../memory/parser")).loadEntries(cwd, memSettings, undefined);
            const memResult = await (await import("../memory/llm-search")).llmSearchEntries(
              loadedEntries,
              { query: `Find memory entries related to: ${searchQuery.slice(-500)}`, filters: { limit: 10, status: ["active"] } },
              memSettings,
              modelRegistry,
              undefined,
              cwd,
            ) as Array<{ slug: unknown; title?: unknown; summary?: unknown; kind?: unknown; status?: unknown; scope?: unknown; compiled_truth?: unknown }>;
            const bySlug = new Map(loadedEntries.map((entry: any) => [String(entry.slug), entry]));
            relatedEntries = (memResult && !(memResult as any).ok)
              ? []
              : (Array.isArray(memResult) ? memResult.map((c: any) => {
                  const full = bySlug.get(String(c.slug ?? ""));
                  return {
                    slug: String(c.slug ?? ""),
                    title: typeof c.title === "string" ? c.title : undefined,
                    scope: typeof c.scope === "string" ? c.scope : typeof c.metadata?.scope === "string" ? c.metadata.scope : undefined,
                    kind: typeof c.kind === "string" ? c.kind : undefined,
                    status: typeof c.status === "string" ? c.status : undefined,
                    summary: typeof full?.compiledTruth === "string"
                      ? full.compiledTruth.slice(0, 150)
                      : typeof c.summary === "string" ? c.summary.slice(0, 150) : undefined,
                  };
                }).filter(e => e.slug) : []);
          } catch { /* search failure is non-fatal */ }
          // P2.A (ADR 0025 §4.2.5): enrich related cards with PROJECT-SCOPED
          // outcome track record so the classifier can discount low-trust entries.
          // Constraints (3-T0 Round 1, docs/notes/outcome-to-classifier-feedback-
          // design.md §7.1): project-filtered read only (never unscoped ledger),
          // same sanitizeSlug both sides, attach only when real data, bounded read,
          // best-effort silent-skip (INV-INVISIBILITY).
          try {
            const CLASSIFIER_OUTCOME_ROW_LIMIT = 5000; // single-user KB-scale ledger; bounds per-turn read
            const cardBySlug = new Map<string, RelatedEntryCard>();
            for (const e of relatedEntries) cardBySlug.set(sanitizeSlug(e.slug), e);
            const slugs = [...cardBySlug.keys()].filter(Boolean);
            if (slugs.length > 0) {
              const rows = readProjectOutcomeRows(cwd, CLASSIFIER_OUTCOME_ROW_LIMIT);
              for (const a of summarizeEntryActivity(rows, slugs, 30)) {
                const hasData = !!a.last_seen || a.decisive_count > 0 || a.confirmatory_count > 0
                  || a.retrieved_unused_count > 0 || a.total_retrievals > 0;
                const card = cardBySlug.get(a.slug);
                if (card && hasData) {
                  card.outcome_activity = {
                    decisive: a.decisive_count,
                    confirmatory: a.confirmatory_count,
                    retrieved_unused: a.retrieved_unused_count,
                    possible_echo_chamber: a.possible_echo_chamber,
                    last_seen: a.last_seen,
                  };
                }
              }
            }
          } catch { /* outcome enrich best-effort; silent-skip */ }
          const cr = await runCorrectionPipeline(effectiveWindow.entries.length > 0 ? effectiveWindow.entries : branch, relatedEntries, {
            settings,
            modelRegistry: modelRegistry as Parameters<typeof runCorrectionPipeline>[2]["modelRegistry"],
            signal: undefined,
          });
          // Log classifier result to audit — always, so failures are traceable.
          appendAudit(cwd, {
            operation: "correction_classifier",
            lane: classifierLane,
            session_id: sessionId,
            ok: cr.ok,
            signal: cr.signal,
            model: cr.model,
            duration_ms: cr.durationMs,
            staging_written: cr.stagingWritten,
            prompt_version: buildPromptVersionAudit("activeCorrectionClassifier", settings),
            ...(cr.error ? { error: cr.error } : {}),
            ...(cr.stagingAdvisory ? { staging_advisory: cr.stagingAdvisory } : {}),
          }).then(() => {
            const health = summarizeClassifierHealth(cwd);
            if (health.classifierRowCount === 0 || health.ok) return undefined;
            return appendAudit(cwd, {
              operation: "classifier_health_meta_check",
              lane: "diagnostic",
              session_id: sessionId,
              ok: health.ok,
              classifier_row_count: health.classifierRowCount,
              sample_size: health.sampleSize,
              window_size: health.windowSize,
              quote_rate: Number(health.quoteRate.toFixed(3)),
              alternative_rate: Number(health.alternativeRate.toFixed(3)),
              concrete_self_critique_rate: Number(health.concreteSelfCritiqueRate.toFixed(3)),
              threshold: health.threshold,
              advisories: health.advisories,
            });
          }).catch(() => {});
          return cr;
        })();
        // Don't await — fire-and-forget. Auto-write lane will await it.
      }

      const writeCorrectionDispatchAudit = (
        lane: "auto_write" | "explicit" | "about_me" | "drain",
        correlationId: string,
        dispatch: ReturnType<typeof dispatchCorrectionSignal>,
        signal: CorrectionSignal | null | undefined,
        model?: string,
      ): void => {
        appendAudit(cwd, {
          operation: "correction_signal_dispatch",
          lane,
          session_id: sessionId,
          correlation_id: correlationId,
          decision: dispatch.decision,
          reason: dispatch.reason,
          signal_found: signal?.signal_found ?? false,
          signal_typing: signal?.typing ?? null,
          signal_confidence: signal?.confidence ?? null,
          signal_target_slug: signal?.target_entry_slug ?? null,
          // AX-PROVENANCE (ADR 0028 v1.1): record the deterministic provenance.
          signal_provenance: signal?.provenance ?? null,
          // R3' directive-recall observability (audit P2: broadened): every DURABLE
          // directive-like signal leaves a trace with its derived provenance +
          // escalated=true/false. Broadened beyond provenance==='user-expressed' so
          // a user directive that was DEMOTED to assistant-observed (e.g. a
          // quote-match miss) is STILL visible as 'not_user_expressed' instead of
          // vanishing — the silent-non-promotion class that left 'rules: none'
          // unnoticed for weeks must be observable in audit.jsonl.
          ...(signal?.signal_found && signal.typing === "durable"
            ? { directive_recall: {
                escalated: shouldEscalateToCurator(signal),
                provenance: signal.provenance ?? null,
                quote: (signal.user_quote ?? "").slice(0, 200),
                reason: shouldEscalateToCurator(signal)
                  ? "escalated_to_tier1"
                  : signal.provenance !== "user-expressed"
                    ? `not_user_expressed_${signal.provenance ?? "unknown"}`
                    : (signal.target_entry_slug ? "has_target_update" : `below_escalation_threshold_conf_${signal.confidence ?? 0}`),
              } }
            : {}),
          ...(model ? { model } : {}),
          prompt_version: buildPromptVersionAudit("activeCorrectionClassifier", settings),
        }).catch(() => {});
      };

      const recordCorrectionDispatch = (
        lane: "auto_write" | "explicit" | "about_me" | "drain",
        correlationId: string,
        classifierResult: Awaited<ReturnType<typeof runCorrectionPipeline>> | null | undefined,
        currentCurator: boolean,
      ): CorrectionSignal | null => {
        const dispatch = dispatchCorrectionSignal(classifierResult?.signal ?? null, { sessionId, currentCurator, captureTaskLocal: true });
        writeCorrectionDispatchAudit(lane, correlationId, dispatch, classifierResult?.signal ?? null, classifierResult?.model);
        return dispatch.forwarded;
      };

      const recordConsumedSessionCorrection = (
        lane: "auto_write" | "drain",
        correlationId: string,
        signal: CorrectionSignal,
      ): CorrectionSignal => {
        const dispatch = {
          forwarded: signal,
          decision: (signal.confidence ?? 0) >= 8 ? "pending_multiview" as const : "forwarded_to_curator" as const,
          reason: `consumed durable session-working-set correction${signal.confidence !== undefined ? ` (conf=${signal.confidence})` : ""}${(signal.confidence ?? 0) >= 8 ? "; multi-view must gate any resulting high-value write" : ""}`,
        };
        writeCorrectionDispatchAudit(lane, correlationId, dispatch, signal, "session-working-set");
        return signal;
      };

      if (drafts.length === 0 && aboutMeDrafts.length === 0) {
        // Phase 1.4 A2 + UX fix: LLM auto-write lane is FIRE-AND-FORGET.
        //
        // pi awaits agent_end synchronously; if we await the LLM call
        // here, the user's main session shows "Working" for the full
        // LLM duration (~30s+). Instead:
        //   1. Optimistically advance the checkpoint past this window
        //      (we KNOW explicit-marker found 0 hits; bg work is
        //      best-effort over the same window).
        //   2. Schedule the LLM lane as background work, tracked in
        //      autoWriteInFlight Map so a re-fire on the next prompt
        //      doesn't double-spend.
        //   3. Show a footer status (ctx.ui.setStatus) while bg work
        //      runs, cleared on completion.
        //
        // Tradeoffs:
        //   - Optimistic checkpoint advance: if bg work fails, that
        //     window is gone (LLM extraction is best-effort, not
        //     authoritative). Explicit MEMORY: blocks always go
        //     through the synchronous path above so user-attested
        //     writes are never optimistically dropped.
        //   - In pi --print, the process exits after agent_end and bg
        //     work is cancelled. Acceptable: --print is one-shot.
        // ── Drain loop ─────────────────────────────────────────────
        // After a bg auto-write cycle completes, immediately check if
        // more entries accumulated while it was running. If so, start
        // another cycle without waiting for the next agent_end.
        const scheduleDrainIfBacklog = () => {
          // Only drain when the main-session LLM is NOT working
          // (agent_end fires and no new agent_start has followed).
          // If started > ended, the LLM is mid-response — the next
          // agent_end will trigger sediment naturally.
          // Drain cap: at most 3 drain cycles per agent_end to prevent
          // budget exhaustion from log-monitor or continuous-input loops.
          const MAX_DRAIN_PER_CYCLE = 3;
          const cyc = sessionAgentCycle.get(sessionId);
          if (!cyc || cyc.started > cyc.ended) return;
          if (cyc.drainCount >= MAX_DRAIN_PER_CYCLE) return;
          cyc.drainCount++;

          let branchNow: unknown[];
          try {
            branchNow = getBranch();
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            appendAudit(cwd, {
              operation: "skip",
              lane: "auto_write",
              session_id: sessionId,
              reason: "drain_branch_read_failed",
              error: sanitizeAuditText(message, 200),
              drain: true,
            }).catch(() => {});
            applySedimentStatus(setStatus, sessionId, "failed", `branch: ${message.slice(0, 40)}`);
            return;
          }
          loadSessionCheckpoint(cwd, sessionId)
            .then((cp) => {
              const latestCycle = sessionAgentCycle.get(sessionId);
              if (!latestCycle || latestCycle.started > latestCycle.ended) return;
              const win = buildRunWindow(branchNow, cp, settings);
              if (win.skipReason || !win.lastEntryId) return; // no backlog

              // Save checkpoint and launch another cycle
              saveSessionCheckpoint(cwd, sessionId, {
                lastProcessedEntryId: win.lastEntryId,
              })
                .then(() => {
                  const latestCycle = sessionAgentCycle.get(sessionId);
                  if (!latestCycle || latestCycle.started > latestCycle.ended) return;
                  applySedimentStatus(setStatus, sessionId, "running", "drain");
                  const corrId = makeCorrelationId(
                    "auto_write",
                    sessionId,
                    win,
                  );
                  // Forward-declare with definite-assignment assertion so
                  // the IIFE body's `if (autoWriteInFlight.get(...) === bg)`
                  // typechecks under TS strict. Runtime-safe: the closure
                  // body cannot reach the comparison until after the
                  // assignment one line below completes (async body runs
                  // up to first await, which is the inner tryAutoWriteLane).
                  let bg!: Promise<void>;
                  bg = (async () => {
                    try {
                      const auto = await tryAutoWriteLane({
                        cwd,
                        sessionId,
                        settings,
                        window: win,
                        modelRegistry,
                        signal: undefined,
                        correlationId: corrId,
                        abrainHome,
                        projectId,
                        branchEntries: branchNow,
                        sessionManager: sessMgr,
                        correctionSignal: (() => {
                          const stored = takeSessionCorrectionForCurator(sessionId);
                          return stored ? recordConsumedSessionCorrection("drain", corrId, stored) : null;
                        })(),
                      });
                      // Round 8 P1 (sonnet R8 audit fix): drain loop now
                      // writes audit rows for ALL outcomes (wrote /
                      // ineligible / llm_skip / llm_error / threw),
                      // mirroring main bg path. Previously only `wrote`
                      // produced an audit row — every other outcome was
                      // silent, leaving operators with no forensic trail
                      // for drain failures.
                      if (auto.kind === "wrote") {
                        const pendingDeferred = deferredStopBySession.get(sessionId);
                        await appendAudit(cwd, {
                          operation: "auto_write",
                          lane: "auto_write",
                          session_id: sessionId,
                          ...checkpointSummary(win),
                          extractor: "llm_extractor",
                          parser_version: PARSER_VERSION,
                          settings_snapshot: settingsSnapshot,
                          correlation_id: corrId,
                          candidate_count: auto.drafts.length,
                          results: auto.results.map(resultSummary),
                          curator: auto.curatorAudits,
                          llm: auto.llmAuditSummary,
                          raw_text: auto.rawTextStored,
                          raw_text_truncated: auto.rawTextTruncated,
                          raw_text_redacted: auto.rawTextRedacted,
                          raw_text_redaction_reason: auto.rawTextRedactionReason,
                          recovered_deferred: !!pendingDeferred,
                          ...(pendingDeferred ? { previous_deferred_reason: pendingDeferred.reason } : {}),
                          checkpoint_advanced: true,
                          background_async: true,
                          drain: true,
                        });
                        await recordDeferredRecoveryIfNeeded({
                          cwd,
                          sessionId,
                          window: win,
                          checkpointAdvanced: true,
                          lane: "auto_write",
                          correlationId: corrId,
                        });
                        const compact = compactResultSummary(auto.results);
                        applySedimentStatus(
                          setStatus,
                          sessionId,
                          "completed",
                          compact,
                        );
                      } else {
                        // R8 P1-A fix: was silent. Now record skip with
                        // reason so drain-only failures (network blips,
                        // model unavailable) don't disappear from audit.
                        await appendAudit(cwd, {
                          operation: "skip",
                          lane: "auto_write",
                          session_id: sessionId,
                          ...checkpointSummary(win),
                          extractor: "llm_extractor",
                          parser_version: PARSER_VERSION,
                          settings_snapshot: settingsSnapshot,
                          correlation_id: corrId,
                          reason: auto.kind,
                          background_async: true,
                          drain: true,
                        }).catch(() => { /* best-effort: don't break drain on audit failure */ });
                        applySedimentStatus(
                          setStatus,
                          sessionId,
                          "completed",
                          auto.kind,
                        );
                      }
                    } catch (err: any) {
                      // R8 P1-A fix: was silent (just setStatus failed).
                      // Now also write an audit row so post-mortem can
                      // see the error message + correlation id.
                      await appendAudit(cwd, {
                        operation: "skip",
                        lane: "auto_write",
                        session_id: sessionId,
                        ...checkpointSummary(win),
                        correlation_id: corrId,
                        reason: "drain_threw",
                        error: sanitizeAuditText(err?.message ?? String(err), 200),
                        background_async: true,
                        drain: true,
                      }).catch(() => {});
                      applySedimentStatus(
                        setStatus,
                        sessionId,
                        "failed",
                        `err: ${err?.message?.slice(0, 40) ?? String(err).slice(0, 40)}`,
                      );
                    } finally {
                      if (autoWriteInFlight.get(sessionId) === bg) {
                        autoWriteInFlight.delete(sessionId);
                        _G.__sediment_inflightCount = Math.max(0, (_G.__sediment_inflightCount ?? 1) - 1);
                      }
                      scheduleDrainIfBacklog(); // recurse
                      // Pass sessionId so same-session drain completion
                      // leaves the ✅/⚠️ indicator visible (only cross-
                      // session /new flips it back to idle).
                      maybeSetIdleIfNoInflight(sessionId);
                    }
                  })();
                  _G.__sediment_inflightCount = (_G.__sediment_inflightCount ?? 0) + 1;
                  autoWriteInFlight.set(sessionId, bg);
                  bg.catch(() => {});
                })
                .catch((err: unknown) => {
                  // R8 P1 (deepseek): saveSessionCheckpoint failures used
                  // to be silent. Surface as audit + status so drain
                  // doesn't die invisibly when checkpoint disk is wedged.
                  const message = err instanceof Error ? err.message : String(err);
                  appendAudit(cwd, {
                    operation: "skip",
                    lane: "auto_write",
                    session_id: sessionId,
                    reason: "drain_checkpoint_save_failed",
                    error: sanitizeAuditText(message, 200),
                    drain: true,
                  }).catch(() => {});
                  applySedimentStatus(setStatus, sessionId, "failed", `cp_save: ${message.slice(0, 40)}`);
                });
            })
            .catch((err: unknown) => {
              // R8 P1 (deepseek): loadSessionCheckpoint failures (corrupt
              // JSON / EACCES / disk full) used to be silent.
              const message = err instanceof Error ? err.message : String(err);
              appendAudit(cwd, {
                operation: "skip",
                lane: "auto_write",
                session_id: sessionId,
                reason: "drain_checkpoint_load_failed",
                error: sanitizeAuditText(message, 200),
                drain: true,
              }).catch(() => {});
              applySedimentStatus(setStatus, sessionId, "failed", `cp_load: ${message.slice(0, 40)}`);
            });
        };

        if (autoWriteInFlight.has(sessionId)) {
          // A previous background sediment run is still authoritative.
          // Do not advance the checkpoint; the next drain/agent_end will
          // re-read this backlog. Still dispatch the classifier result so
          // active corrections observed during the in-flight window are
          // not stranded as classifier-only audit rows.
          if (correctionPromise) {
            const inflightCorrelationId = makeCorrelationId("auto_write", sessionId, effectiveWindow);
            _G.__sediment_inflightCount = (_G.__sediment_inflightCount ?? 0) + 1;
            correctionPromise
              .then((classifierResult) => {
                recordCorrectionDispatch("auto_write", inflightCorrelationId, classifierResult, false);
              })
              .catch(() => {})
              .finally(() => {
                _G.__sediment_inflightCount = Math.max(0, (_G.__sediment_inflightCount ?? 1) - 1);
                maybeSetIdleIfNoInflight(sessionId);
              });
          }
          return;
        }

        // Short windows are classifier-only: run active-correction routing
        // and advance checkpoint, but do not spend extractor/curator calls
        // on tiny windows that used to be auto-write-ineligible. If the
        // classifier hard kill-switch is off, preserve the old skip behavior.
        if (shortWindowClassifierOnly) {
          if (!classifierEnabled || !correctionPromise) {
            await appendAudit(cwd, {
              operation: "skip",
              lane: "window",
              reason: "window_too_small",
              session_id: sessionId,
              ...summary,
              extractor: "explicit_marker",
              parser_version: PARSER_VERSION,
              settings_snapshot: settingsSnapshot,
              entry_breakdown: entryBreakdown,
              stage_ms: {
                window_build: tWindowBuilt - tStart,
                parse: tParseEnd - tParseStart,
                write_total: 0,
                total: Date.now() - tStart,
              },
              checkpoint_advanced: false,
            });
            applySedimentStatus(setStatus, sessionId, "completed", "window_too_small");
            return;
          }

          const shortCorrelationId = makeCorrelationId("auto_write", sessionId, effectiveWindow);
          applySedimentStatus(setStatus, sessionId, "running", "classifier-only");
          let shortBg!: Promise<void>;
          shortBg = (async () => {
            let checkpointAdvanced = false;
            try {
              const classifierResult = await correctionPromise.catch(() => ({ ok: false, signal: null } as const));
              // #1 (T0 consensus 2026-06-07): a high-confidence user-EXPRESSED durable
              // create signal ESCALATES this short window to the FULL curator + multi-view
              // lane, so the rule promotes at full fidelity (incl. zone:rules) instead of
              // being parked as a lossy provisional hypothesis. The curator stays the gate
              // (re-applies the rules trust taxonomy + conservatism) and create_rules_zone
              // forces 2-pass review, so a false escalation costs one extractor+curator
              // call and the curator still skips. Fires only on a positive rare signal.
              if (classifierResult.ok && classifierResult.escalateToCurator) {
                const escForwarded = recordCorrectionDispatch("auto_write", shortCorrelationId, classifierResult, true);
                const auto = await tryAutoWriteLane({
                  cwd, sessionId, settings, window: effectiveWindow, modelRegistry,
                  signal: undefined, correlationId: shortCorrelationId, abrainHome, projectId,
                  branchEntries: branch, sessionManager: sessMgr,
                  correctionSignal: escForwarded ?? classifierResult.signal ?? undefined,
                });
                // No-loss invariant (audit P0, 2026-06-07, gpt-5.5 2 rounds): advance the
                // checkpoint ONLY when the signal is safely CAPTURED — the curator persisted
                // a rule (or it's a dedup hit, i.e. the rule already exists) OR the
                // provisional staging safety net actually persisted on disk. Otherwise HOLD
                // (retry next turn): a transient llm_error, or NOTHING captured AND staging
                // IO failed, must not advance past a signal that is neither stored nor
                // promoted. 'wrote' is NOT sufficient alone — the curator may have processed
                // the window and skipped/rejected every result. The hold is bounded by the
                // window scrolling past + (normally) the staging net.
                const transient = auto.kind === "llm_error";
                const captured = auto.kind === "wrote" && auto.results.some((r) =>
                  r.status === "created" || r.status === "updated" || r.status === "merged" ||
                  r.status === "superseded" || r.status === "archived" || r.status === "deleted" ||
                  (r.reason ?? "").startsWith("semantic_duplicate"));
                const safelyStaged = classifierResult.stagingWritten === true;
                const advance = !transient && (captured || safelyStaged);
                if (advance) {
                  await saveSessionCheckpoint(cwd, sessionId, { lastProcessedEntryId: effectiveWindow.lastEntryId });
                  await recordDeferredRecoveryIfNeeded({ cwd, sessionId, window: effectiveWindow, checkpointAdvanced: true, lane: "auto_write", correlationId: shortCorrelationId });
                }
                if (auto.kind === "wrote") {
                  await appendAudit(cwd, {
                    operation: "auto_write", lane: "auto_write", session_id: sessionId, ...summary,
                    extractor: "active_correction_escalated", parser_version: PARSER_VERSION,
                    settings_snapshot: settingsSnapshot, entry_breakdown: entryBreakdown,
                    correlation_id: shortCorrelationId, escalated_from: "short_window_classifier_only",
                    candidate_count: auto.drafts.length, results: auto.results.map(resultSummary),
                    curator: auto.curatorAudits, checkpoint_advanced: advance, classifier_only: false, background_async: true,
                  });
                  const compact = compactResultSummary(auto.results);
                  applySedimentStatus(setStatus, sessionId, auto.results.some((r) => r.status === "rejected") ? "failed" : "completed", compact);
                  if (notify) { try { notify(formatSedimentNotify("rule escalation (bg)", auto.results, abrainHome), "info"); } catch {} }
                } else {
                  await appendAudit(cwd, {
                    operation: "skip", lane: "auto_write", reason: `escalation_${auto.kind}${safelyStaged ? "" : "_unstaged"}`, session_id: sessionId, ...summary,
                    extractor: "active_correction_escalated", parser_version: PARSER_VERSION,
                    settings_snapshot: settingsSnapshot, entry_breakdown: entryBreakdown,
                    correlation_id: shortCorrelationId, escalated_from: "short_window_classifier_only",
                    checkpoint_advanced: advance, classifier_only: false, background_async: true,
                  });
                  applySedimentStatus(setStatus, sessionId, advance ? "completed" : "failed", `escalation ${auto.kind}; ${advance ? "staged as fallback" : "checkpoint held for retry"}`);
                }
                return;
              }
              const forwarded = recordCorrectionDispatch("auto_write", shortCorrelationId, classifierResult, false);
              const signalFound = classifierResult.signal?.signal_found === true;
              checkpointAdvanced = !!(classifierResult.ok && classifierResult.signal && !signalFound);
              if (checkpointAdvanced) {
                await saveSessionCheckpoint(cwd, sessionId, {
                  lastProcessedEntryId: effectiveWindow.lastEntryId,
                });
              }
              const pendingDeferred = deferredStopBySession.get(sessionId);
              await appendAudit(cwd, {
                operation: "skip",
                lane: "auto_write",
                reason: classifierResult.ok
                  ? signalFound ? "window_too_small_classifier_signal_checkpoint_held" : checkpointAdvanced ? "window_too_small_classifier_no_signal" : "window_too_small_classifier_unparseable"
                  : "window_too_small_classifier_failed_or_unparseable",
                session_id: sessionId,
                ...summary,
                extractor: "active_correction_classifier",
                parser_version: PARSER_VERSION,
                settings_snapshot: settingsSnapshot,
                entry_breakdown: entryBreakdown,
                correlation_id: shortCorrelationId,
                recovered_deferred: checkpointAdvanced && !!pendingDeferred,
                ...(checkpointAdvanced && pendingDeferred ? { previous_deferred_reason: pendingDeferred.reason } : {}),
                checkpoint_advanced: checkpointAdvanced,
                classifier_only: true,
                classifier_ok: classifierResult.ok,
                classifier_signal_found: signalFound,
                correction_forwarded: !!forwarded,
                stage_ms: {
                  window_build: tWindowBuilt - tStart,
                  parse: tParseEnd - tParseStart,
                  write_total: 0,
                  total: Date.now() - tStart,
                  background: true,
                },
              });
              await recordDeferredRecoveryIfNeeded({
                cwd,
                sessionId,
                window: effectiveWindow,
                checkpointAdvanced,
                lane: "auto_write",
                correlationId: shortCorrelationId,
              });
              applySedimentStatus(
                setStatus,
                sessionId,
                checkpointAdvanced ? "completed" : classifierResult.ok ? "completed" : "failed",
                checkpointAdvanced ? "no correction; checkpoint advanced" : signalFound ? "correction found; checkpoint held" : classifierResult.ok ? "classifier unparseable; checkpoint held" : "classifier failed; checkpoint held",
              );
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err);
              await appendAudit(cwd, {
                operation: "skip",
                lane: "auto_write",
                reason: "window_too_small_classifier_threw",
                session_id: sessionId,
                ...summary,
                extractor: "active_correction_classifier",
                parser_version: PARSER_VERSION,
                settings_snapshot: settingsSnapshot,
                entry_breakdown: entryBreakdown,
                correlation_id: shortCorrelationId,
                checkpoint_advanced: false,
                classifier_only: true,
                error: sanitizeAuditText(message, 500),
                stage_ms: {
                  window_build: tWindowBuilt - tStart,
                  parse: tParseEnd - tParseStart,
                  write_total: 0,
                  total: Date.now() - tStart,
                  background: true,
                },
              }).catch(() => {});
              applySedimentStatus(setStatus, sessionId, "failed", `classifier err: ${message.slice(0, 40)}`);
            } finally {
              if (autoWriteInFlight.get(sessionId) === shortBg) {
                autoWriteInFlight.delete(sessionId);
                _G.__sediment_inflightCount = Math.max(0, (_G.__sediment_inflightCount ?? 1) - 1);
              }
              maybeSetIdleIfNoInflight(sessionId);
            }
          })();
          _G.__sediment_inflightCount = (_G.__sediment_inflightCount ?? 0) + 1;
          autoWriteInFlight.set(sessionId, shortBg);
          shortBg.catch(() => {});
          return;
        }

        // Optimistic checkpoint advance before launching bg work.
        await saveSessionCheckpoint(cwd, sessionId, {
          lastProcessedEntryId: effectiveWindow.lastEntryId,
        });

        // Mark running BEFORE scheduling the bg promise so the footer
        // updates synchronously with agent_end. The bg promise will
        // transition to completed/failed in its finally block.
        applySedimentStatus(setStatus, sessionId, "running", "extracting");
        const autoCorrelationId = makeCorrelationId(
          "auto_write",
          sessionId,
          effectiveWindow,
        );

        // Definite-assignment assertion: TS can't prove the IIFE body's
        // `if (autoWriteInFlight.get(...) === bgPromise)` closure read
        // happens after the assignment on the next line, but runtime-wise
        // the async body suspends at its first await before reaching
        // that comparison. `!` silences the spurious strict-mode warning.
        let bgPromise!: Promise<void>;
        bgPromise = (async () => {
          try {
            const auto = await tryAutoWriteLane({
              cwd,
              sessionId,
              settings,
              window: effectiveWindow,
              modelRegistry,
              signal: undefined,
              correlationId: autoCorrelationId,
              abrainHome,
              projectId,
              branchEntries: branch,
              sessionManager: sessMgr, // captured, not ctx.sessionManager (stale ctx risk)
              // Await the fire-and-forget classifier promise (started before lane branching).
              // If classifier hasn't finished yet, wait for it; if it failed or wasn't
              // started, fall back to null signal (curator works without it).
              // ADR §4.1.4 typing-based dispatch (T1-1 fix). dispatchCorrectionSignal
              // routes by typing so debug doesn't pollute curator and task-local
              // doesn't leak into the current curator's prompt. The decision goes
              // to audit so the aggregator can attribute future false-positive rates
              // to the right dispatch bucket.
              correctionSignal: await (async () => {
                const classifierResult = correctionPromise
                  ? await correctionPromise.catch(() => ({ ok: false, signal: null } as const))
                  : null;
                const forwarded = recordCorrectionDispatch("auto_write", autoCorrelationId, classifierResult, true);
                if (forwarded) return forwarded;
                const stored = takeSessionCorrectionForCurator(sessionId);
                return stored ? recordConsumedSessionCorrection("auto_write", autoCorrelationId, stored) : null;
              })(),
            });
            const tAutoEnd = Date.now();

            if (auto.kind === "wrote") {
              const pendingDeferred = deferredStopBySession.get(sessionId);
              await appendAudit(cwd, {
                operation: "auto_write",
                lane: "auto_write",
                session_id: sessionId,
                ...summary,
                extractor: "llm_extractor",
                parser_version: PARSER_VERSION,
                settings_snapshot: settingsSnapshot,
                entry_breakdown: entryBreakdown,
                correlation_id: autoCorrelationId,
                candidate_count: auto.drafts.length,
                candidates: auto.drafts.map((d, i) => ({
                  candidate_id: candidateIdFor(autoCorrelationId, i),
                  // 2026-05-15: route candidate title through the same audit
                  // sanitizer used for raw_text/error fields. A malicious or
                  // careless transcript could put secret-shaped strings into a
                  // MEMORY block title; we don't want them landing verbatim in
                  // audit.jsonl just because the rest of the redaction chain
                  // only protects body/raw_text.
                  title: sanitizeAuditText(d.title, 500),
                  kind: d.kind,
                  confidence: d.confidence,
                  status: d.status,
                  body_chars: (d.compiledTruth || "").length,
                })),
                results: auto.results.map(resultSummary),
                curator: auto.curatorAudits,
                llm: auto.llmAuditSummary,
                raw_text: auto.rawTextStored,
                raw_text_truncated: auto.rawTextTruncated,
                raw_text_redacted: auto.rawTextRedacted,
                raw_text_redaction_reason: auto.rawTextRedactionReason,
                recovered_deferred: !!pendingDeferred,
                ...(pendingDeferred ? { previous_deferred_reason: pendingDeferred.reason } : {}),
                stage_ms: {
                  window_build: tWindowBuilt - tStart,
                  parse: tParseEnd - tParseStart,
                  llm_total: auto.llmDurationMs,
                  write_total: tAutoEnd - auto.writeStart,
                  total: Date.now() - tStart,
                  background: true,
                },
                checkpoint_advanced: true,
                background_async: true,
              });
              await recordDeferredRecoveryIfNeeded({
                cwd,
                sessionId,
                window: effectiveWindow,
                checkpointAdvanced: true,
                lane: "auto_write",
                correlationId: autoCorrelationId,
              });
              if (notify) {
                try {
                  // 2026-05-15 UX fix: per-result lines + scope label
                  // (world / project:<id> / workflow / etc.) instead of
                  // a single comma-joined line. Format helper lives at
                  // top of file alongside compactResultSummary.
                  //
                  // 2026-05-24 history: commit f3555e8 deleted this
                  // notify on the mistaken theory it violated ADR 0024
                  // INV-INVISIBILITY. Restored — the author clarified
                  // that brain runtime indicators ("sediment auto-write
                  // (bg): N entries") are healthy feedback signals, NOT
                  // management burden. INV-INVISIBILITY = user does no
                  // brain-management work, NOT brain hides what it did.
                  // See ADR 0024 §2 / §4.2 (updated same commit).
                  notify(
                    formatSedimentNotify("auto-write (bg)", auto.results, abrainHome),
                    "info",
                  );
                } catch {}
              }
              const createdCount = auto.results.filter(
                (r) => r.status === "created",
              ).length;
              const updatedCount = auto.results.filter(
                (r) => r.status === "updated",
              ).length;
              const mergedCount = auto.results.filter(
                (r) => r.status === "merged",
              ).length;
              const archivedCount = auto.results.filter(
                (r) => r.status === "archived",
              ).length;
              const supersededCount = auto.results.filter(
                (r) => r.status === "superseded",
              ).length;
              const skippedCount = auto.results.filter(
                (r) => r.status === "skipped",
              ).length;
              const deletedCount = auto.results.filter(
                (r) => r.status === "deleted",
              ).length;
              const rejectedCount = auto.results.filter(
                (r) => r.status === "rejected",
              ).length;
              const compact = compactResultSummary(auto.results);
              if (rejectedCount > 0) {
                applySedimentStatus(setStatus, sessionId, "failed", compact);
              } else {
                applySedimentStatus(setStatus, sessionId, "completed", compact);
              }
              return;
            }

            const pendingDeferred = deferredStopBySession.get(sessionId);
            await appendAudit(cwd, {
              operation: "skip",
              lane: "auto_write",
              reason:
                auto.kind === "ineligible"
                  ? (auto.eligibility.reason ?? "auto_write_ineligible")
                  : auto.kind === "llm_skip"
                    ? "llm_returned_skip"
                    : auto.kind === "llm_error"
                      ? "llm_extraction_error"
                      : "no_explicit_memory_markers",
              session_id: sessionId,
              ...summary,
              extractor:
                auto.kind === "ineligible"
                  ? "explicit_marker"
                  : "llm_extractor",
              parser_version: PARSER_VERSION,
              settings_snapshot: settingsSnapshot,
              entry_breakdown: entryBreakdown,
              correlation_id: autoCorrelationId,
              eligibility:
                auto.kind === "ineligible" ? auto.eligibility : undefined,
              llm:
                auto.kind === "ineligible" ? undefined : auto.llmAuditSummary,
              raw_text:
                auto.kind === "llm_error" || auto.kind === "llm_skip"
                  ? auto.rawTextStored
                  : undefined,
              raw_text_truncated:
                auto.kind === "llm_error" || auto.kind === "llm_skip"
                  ? auto.rawTextTruncated
                  : undefined,
              raw_text_redacted:
                auto.kind === "llm_error" || auto.kind === "llm_skip"
                  ? auto.rawTextRedacted
                  : undefined,
              raw_text_redaction_reason:
                auto.kind === "llm_error" || auto.kind === "llm_skip"
                  ? auto.rawTextRedactionReason
                  : undefined,
              recovered_deferred: !!pendingDeferred,
              ...(pendingDeferred ? { previous_deferred_reason: pendingDeferred.reason } : {}),
              stage_ms: {
                window_build: tWindowBuilt - tStart,
                parse: tParseEnd - tParseStart,
                llm_total: auto.kind === "ineligible" ? 0 : auto.llmDurationMs,
                write_total: 0,
                total: Date.now() - tStart,
                background: true,
              },
              checkpoint_advanced: true,
              background_async: true,
            });
            await recordDeferredRecoveryIfNeeded({
              cwd,
              sessionId,
              window: effectiveWindow,
              checkpointAdvanced: true,
              lane: "auto_write",
              correlationId: autoCorrelationId,
            });
            // ineligible / llm_skip = healthy completion;
            // llm_error = failed (LLM call broke; user should know).
            if (auto.kind === "llm_error") {
              applySedimentStatus(
                setStatus,
                sessionId,
                "failed",
                `LLM err: ${(auto.llmAuditSummary.error ?? "unknown").slice(0, 40)}`,
              );
            } else if (auto.kind === "ineligible") {
              applySedimentStatus(
                setStatus,
                sessionId,
                "completed",
                (auto.eligibility.reason ?? "ineligible").slice(0, 40),
              );
            } else {
              applySedimentStatus(
                setStatus,
                sessionId,
                "completed",
                "LLM skip",
              );
            }
          } catch (err: any) {
            // Last-resort failure path. Never let bg work throw out of
            // the Promise (uncaught rejection in pi can crash the
            // session).
            try {
              await appendAudit(cwd, {
                operation: "skip",
                lane: "auto_write",
                reason: "auto_write_bg_threw",
                session_id: sessionId,
                ...summary,
                extractor: "llm_extractor",
                parser_version: PARSER_VERSION,
                settings_snapshot: settingsSnapshot,
                entry_breakdown: entryBreakdown,
                correlation_id: autoCorrelationId,
                // Sanitize before capping; provider error spew can echo request bodies.
                error: sanitizeAuditText(err?.message ?? String(err), 500),
                checkpoint_advanced: true,
                background_async: true,
              });
            } catch {}
            applySedimentStatus(
              setStatus,
              sessionId,
              "failed",
              `bg err: ${(err?.message ?? String(err)).slice(0, 40)}`,
            );
          } finally {
            // Status is already transitioned to completed/failed above.
            // Do NOT clear with setStatus(undefined) — user wants the
            // completed/failed indicator visible until the next
            // agent_start resets to idle.
            if (autoWriteInFlight.get(sessionId) === bgPromise) {
              autoWriteInFlight.delete(sessionId);
              _G.__sediment_inflightCount = Math.max(0, (_G.__sediment_inflightCount ?? 1) - 1);
            }

            // Drain loop: while this bg cycle ran, the user may have sent
            // more messages → new entries in the branch. Check immediately
            // and start another cycle if there's a backlog, rather than
            // waiting for the next agent_end (which might not come soon).
            //
            // scheduleDrainIfBacklog is a closure over (cwd, sessionId,
            // settings, getBranch, notify, setStatus, modelRegistry,
            // settingsSnapshot) declared above — it takes no args. An
            // earlier draft passed those as an object literal; JS runtime
            // silently ignored the extra arg but tsc --strict would flag
            // it. Keep this call argument-free.
            scheduleDrainIfBacklog();

            // When ALL inflight work (including drain cycles) settles,
            // switch the footer back to idle ONLY if this bg work
            // belongs to a different session than the current foreground
            // (i.e. /new happened mid-flight). Same-session completion
            // leaves the ✅/⚠️ indicator visible — agent_start on the
            // next user prompt resets it. Passing sessionId lets
            // maybeSetIdleIfNoInflight do that disambiguation; without
            // it the helper would nuke the just-set completed display.
            maybeSetIdleIfNoInflight(sessionId);
          }
        })();
        _G.__sediment_inflightCount = (_G.__sediment_inflightCount ?? 0) + 1;
        autoWriteInFlight.set(sessionId, bgPromise);
        bgPromise.catch(() => {});
        // DO NOT await bgPromise. agent_end returns immediately so the
        // main session is unblocked.
        return;
      }

      // Synchronous explicit lanes: Lane A (MEMORY:) and Lane G
      // (MEMORY-ABOUT-ME:) both run here, in that order. Status is
      // visible briefly during each write loop (each writer call is
      // typically < 200ms). Final completed/failed lands AFTER both
      // lanes have run so the user sees one combined verdict per
      // agent_end.
      //
      // ADR 0021 G2 (2026-05-20): Lane G was added here as a parallel
      // synchronous block. Both lanes share the same parsed window;
      // either or both may produce drafts. The checkpoint advances
      // ONLY if BOTH lanes report terminal outcomes (combinedShouldAdvance
      // below) — a Lane G git failure should not silently bury a Lane A
      // write under an advanced checkpoint, and vice versa.
      const laneSummary = [
        drafts.length > 0 ? `A:${drafts.length}` : null,
        aboutMeDrafts.length > 0 ? `G:${aboutMeDrafts.length}` : null,
      ]
        .filter(Boolean)
        .join(" ");
      applySedimentStatus(setStatus, sessionId, "running", `writing ${laneSummary}`);

      // ── Lane A (MEMORY:) ─────────────────────────────────────────
      const results: WriteProjectEntryResult[] = [];
      let tWriteStart = 0;
      let tWriteEnd = 0;
      let explicitCorrelationId: string | undefined;
      let laneAShouldAdvance = true; // vacuous-true when Lane A has 0 drafts
      if (drafts.length > 0) {
        tWriteStart = Date.now();
        explicitCorrelationId = makeCorrelationId(
          "explicit",
          sessionId,
          window,
        );
        for (const [i, draft] of drafts.entries()) {
          const auditContext: WriterAuditContext = {
            lane: "explicit",
            sessionId,
            correlationId: explicitCorrelationId,
            candidateId: candidateIdFor(explicitCorrelationId, i),
          };
          results.push(
            await writeProjectEntry( /* writer-call: auto-write-block */
              {
                ...draft,
                sessionId,
                timelineNote:
                  draft.timelineNote || "captured from explicit MEMORY block",
              },
              { projectRoot: cwd, abrainHome, projectId, settings, dryRun: false, auditContext },
            ),
          );
        }
        tWriteEnd = Date.now();
        laneAShouldAdvance = shouldAdvanceAfterResults(results);
      }

      // ── Lane G (MEMORY-ABOUT-ME:) ────────────────────────────────
      // ADR 0021 G2. For each fence draft, build an AboutMeDraft and
      // call writeAbrainAboutMe. Defaults applied here for fence fields
      // the extractor leaves optional:
      //   - routingConfidence: 1.0 when fence omits (user-attested fence
      //     = highest trust; consistent with extractor.ts comment).
      //   - routeCandidates: [region] (single candidate; G3 LLM
      //     classifier will broaden this when it lands).
      //   - routingReason: default explainer; fence may override.
      //   - stagingProjectId / stagingSessionEpoch: ALWAYS supplied so
      //     that even if a fence carries confidence < threshold (router
      //     auto-downgrades to staging), the writer has the anchor it
      //     needs and does not throw. This is exactly the P0-1 audit-fix
      //     surface that smoke pre-registered for G2 wire-up.
      const aboutMeResults: WriteAboutMeResult[] = [];
      let tAboutMeStart = 0;
      let tAboutMeEnd = 0;
      let aboutMeCorrelationId: string | undefined;
      let laneGShouldAdvance = true;
      const aboutMeSkipped: Array<{ markerIndex: number; reason: string }> = [];
      if (aboutMeDrafts.length > 0) {
        tAboutMeStart = Date.now();
        aboutMeCorrelationId = makeCorrelationId(
          "about_me",
          sessionId,
          window,
        );
        // One epoch per agent_end batch — staging filenames already use
        // independent Date.now() + 8-hex randomBytes suffix to defeat
        // intra-batch collisions, so sharing the epoch across candidates
        // is fine and keeps the batch traceable in audit/logs.
        const aboutMeSessionEpoch = Date.now();
        let candidateIndex = 0;
        for (const fence of aboutMeDrafts) {
          // Defensive: extractor already rejects fences with missing /
          // unknown region (parseAboutMeBlock returns null), but the
          // ExtractedAboutMeDraft type leaves region optional for G3
          // anticipation. Skip + audit when region absent so a future
          // extractor relaxation cannot silently land an entry with a
          // bogus kind / region (would corrupt frontmatter).
          if (!fence.region || !LANE_G_ALLOWED_REGIONS.includes(fence.region as AboutMeRegion)) {
            aboutMeSkipped.push({
              markerIndex: fence.markerIndex,
              reason: "missing_or_invalid_region",
            });
            continue;
          }
          const draftDoc: AboutMeDraft = {
            title: fence.title,
            body: fence.body,
            region: fence.region as AboutMeRegion,
            routingConfidence: fence.routingConfidence ?? 1.0,
            routeCandidates: [fence.region as AboutMeRegion],
            // routingReason is a routing rationale (≤ 200 char sanitized),
            // NOT a timeline narrative. For G1 the only routing signal is
            // user attestation through the fence; G3 LLM classifier will
            // populate a real rationale later. Keep the timelineNote
            // separate so the Timeline section still reads naturally
            // ("explicit MEMORY-ABOUT-ME block" from the extractor).
            routingReason: "user-attested via MEMORY-ABOUT-ME fence (G1)",
            triggerPhrases: fence.triggerPhrases,
            tags: fence.tags,
            status: (fence.status as AboutMeDraft["status"]) || undefined,
            timelineNote: fence.timelineNote,
            sessionId,
            stagingProjectId: projectId,
            stagingSessionEpoch: aboutMeSessionEpoch,
          };
          const auditContext: WriterAuditContext = {
            lane: "about_me",
            sessionId,
            correlationId: aboutMeCorrelationId,
            candidateId: candidateIdFor(aboutMeCorrelationId, candidateIndex++),
          };
          aboutMeResults.push(
            await writeAbrainAboutMe(draftDoc, {
              abrainHome,
              settings,
              dryRun: false,
              auditContext,
            }),
          );
        }
        tAboutMeEnd = Date.now();
        laneGShouldAdvance = shouldAdvanceAfterAboutMeResults(aboutMeResults);
      }

      // Lane A/G do not run a curator in-line, but the classifier still
      // contributes active-correction routing state and audit. Keep it
      // fire-and-forget so explicit user-attested writes stay synchronous.
      const explicitDispatchCorrelationId = explicitCorrelationId ?? aboutMeCorrelationId;
      if (correctionPromise && explicitDispatchCorrelationId) {
        const explicitDispatchLane: "explicit" | "about_me" = explicitCorrelationId ? "explicit" : "about_me";
        _G.__sediment_inflightCount = (_G.__sediment_inflightCount ?? 0) + 1;
        correctionPromise
          .then((classifierResult) => {
            recordCorrectionDispatch(explicitDispatchLane, explicitDispatchCorrelationId, classifierResult, false);
          })
          .catch(() => {})
          .finally(() => {
            _G.__sediment_inflightCount = Math.max(0, (_G.__sediment_inflightCount ?? 1) - 1);
            maybeSetIdleIfNoInflight(sessionId);
          });
      }

      // ── Combined checkpoint advance ─────────────────────────────
      const combinedShouldAdvance = laneAShouldAdvance && laneGShouldAdvance;
      if (combinedShouldAdvance) {
        await saveSessionCheckpoint(cwd, sessionId, {
          lastProcessedEntryId: effectiveWindow.lastEntryId,
        });
      }

      // ── Lane A audit row ────────────────────────────────────────
      if (drafts.length > 0 && explicitCorrelationId) {
        const pendingDeferred = deferredStopBySession.get(sessionId);
        await appendAudit(cwd, {
          operation: "explicit_extract",
          lane: "explicit",
          session_id: sessionId,
          ...summary,
          extractor: "explicit_marker",
          parser_version: PARSER_VERSION,
          settings_snapshot: settingsSnapshot,
          entry_breakdown: entryBreakdown,
          correlation_id: explicitCorrelationId,
          recovered_deferred: combinedShouldAdvance && !!pendingDeferred,
          ...(combinedShouldAdvance && pendingDeferred ? { previous_deferred_reason: pendingDeferred.reason } : {}),
          candidate_count: drafts.length,
          candidates: drafts.map((d, i) => ({
            candidate_id: candidateIdFor(explicitCorrelationId!, i),
            // 2026-05-15: see auto_write lane above. Explicit MEMORY blocks are
            // user-authored; usually clean, but a stray `password=hunter2`-style
            // title is exactly the kind of thing the sanitizer was built to
            // catch before it reaches audit.jsonl.
            title: sanitizeAuditText(d.title, 500),
            kind: d.kind,
            confidence: d.confidence,
            status: d.status,
            body_chars: (d.compiledTruth || "").length,
          })),
          results: results.map(resultSummary),
          stage_ms: {
            window_build: tWindowBuilt - tStart,
            parse: tParseEnd - tParseStart,
            write_total: tWriteEnd - tWriteStart,
            total: Date.now() - tStart,
          },
          // ADR 0021 G2: report the COMBINED advance decision so a Lane G
          // failure that pins the checkpoint shows up as `false` on the
          // Lane A row too — grepping correlation_id within one batch
          // gives operators a consistent picture of disk state.
          checkpoint_advanced: combinedShouldAdvance,
          lane_advance_decision: laneAShouldAdvance,
        });
      }

      if (drafts.length > 0 && explicitCorrelationId) {
        await recordDeferredRecoveryIfNeeded({
          cwd,
          sessionId,
          window: effectiveWindow,
          checkpointAdvanced: combinedShouldAdvance,
          lane: "explicit",
          correlationId: explicitCorrelationId,
        });
      }

      // ── Lane G audit row ────────────────────────────────────────
      if (aboutMeDrafts.length > 0 && aboutMeCorrelationId) {
        const pendingDeferred = deferredStopBySession.get(sessionId);
        await appendAudit(cwd, {
          operation: "about_me_extract",
          lane: "about_me",
          session_id: sessionId,
          ...summary,
          extractor: "explicit_marker",
          parser_version: PARSER_VERSION,
          settings_snapshot: settingsSnapshot,
          entry_breakdown: entryBreakdown,
          correlation_id: aboutMeCorrelationId,
          recovered_deferred: combinedShouldAdvance && !!pendingDeferred,
          ...(combinedShouldAdvance && pendingDeferred ? { previous_deferred_reason: pendingDeferred.reason } : {}),
          candidate_count: aboutMeDrafts.length,
          candidates: aboutMeDrafts.map((d, i) => ({
            candidate_id: candidateIdFor(aboutMeCorrelationId!, i),
            title: sanitizeAuditText(d.title, 500),
            region: d.region,
            routing_confidence: d.routingConfidence,
            status: d.status,
            body_chars: (d.body || "").length,
          })),
          results: aboutMeResults.map((r) => ({
            status: r.status,
            slug: r.slug,
            region: r.region,
            reason: r.reason,
            path: r.path,
            routeRejected: r.routeRejected,
            validationErrors: r.validationErrors,
            sanitizedReplacements: r.sanitizedReplacements,
            gitCommit: r.gitCommit,
            correlation_id: r.correlationId,
            candidate_id: r.candidateId,
          })),
          skipped: aboutMeSkipped,
          stage_ms: {
            window_build: tWindowBuilt - tStart,
            parse: tParseEnd - tParseStart,
            write_total: tAboutMeEnd - tAboutMeStart,
            total: Date.now() - tStart,
          },
          checkpoint_advanced: combinedShouldAdvance,
          lane_advance_decision: laneGShouldAdvance,
        });
      }

      if (aboutMeDrafts.length > 0 && aboutMeCorrelationId) {
        await recordDeferredRecoveryIfNeeded({
          cwd,
          sessionId,
          window: effectiveWindow,
          checkpointAdvanced: combinedShouldAdvance,
          lane: "about_me",
          correlationId: aboutMeCorrelationId,
        });
      }

      // ── Notify (one notification per active lane) ────────────────
      // Use captured `notify` (ctx.ui.notify pre-bound) rather than ctx.ui
      // directly, so a late ctx invalidation does not throw here.
      if (notify) {
        if (drafts.length > 0) {
          try {
            notify(
              formatSedimentNotify("explicit marker extraction", results, abrainHome),
              laneAShouldAdvance ? "info" : "warning",
            );
          } catch { /* best-effort */ }
        }
        if (aboutMeDrafts.length > 0) {
          try {
            // Lane G result shape (WriteAboutMeResult) is a structural
            // subset of WriteProjectEntryResult for the four fields
            // formatSedimentNotify reads (path/status/slug/reason), so
            // the cast is safe and reuses the same vertical layout.
            notify(
              formatSedimentNotify(
                "about-me explicit extraction",
                aboutMeResults as unknown as WriteProjectEntryResult[],
                abrainHome,
              ),
              laneGShouldAdvance ? "info" : "warning",
            );
          } catch { /* best-effort */ }
        }
      }


      // ── Status: combined verdict ──────────────────────────────
      const allResultsStatusSummary = [
        ...results.map((r) => r.status),
        ...aboutMeResults.map((r) => r.status),
      ];
      const anyRejected = allResultsStatusSummary.includes("rejected");
      const compactCombined = (() => {
        const c: Record<string, number> = {};
        for (const s of allResultsStatusSummary) c[s] = (c[s] || 0) + 1;
        const parts: string[] = [];
        for (const st of ["created", "updated", "merged", "archived", "superseded", "deleted", "skipped", "dry_run", "rejected"]) {
          if (c[st]) parts.push(`${c[st]} ${st}`);
        }
        return parts.join(", ") || "no changes";
      })();
      if (anyRejected || !combinedShouldAdvance) {
        applySedimentStatus(setStatus, sessionId, "failed", compactCombined);
      } else {
        applySedimentStatus(setStatus, sessionId, "completed", compactCombined);
      }

      }); // end runWithTriggerAnchor — ADR 0027 PR-B+ R1 P0-β trigger-time scope
    },
  );
}

// ===========================================================================
// LLM auto-write lane implementation
// ===========================================================================

interface ModelRegistryLike {
  find(provider: string, modelId: string): unknown;
  getApiKeyAndHeaders(
    model: unknown,
  ): Promise<{
    ok: boolean;
    apiKey?: string;
    headers?: Record<string, string>;
    error?: string;
  }>;
}

type AutoWriteLaneOutcome =
  | {
      kind: "ineligible";
      eligibility: {
        eligible: false;
        reason: string;
        detail?: Record<string, unknown>;
      };
    }
  | {
      kind: "llm_skip";
      llmAuditSummary: ReturnType<typeof summarizeLlmExtractorResult>;
      llmDurationMs: number;
      rawTextStored?: string;
      rawTextTruncated?: boolean;
      rawTextRedacted?: boolean;
      rawTextRedactionReason?: string;
    }
  | {
      kind: "llm_error";
      llmAuditSummary: ReturnType<typeof summarizeLlmExtractorResult>;
      llmDurationMs: number;
      rawTextStored?: string;
      rawTextTruncated?: boolean;
      rawTextRedacted?: boolean;
      rawTextRedactionReason?: string;
    }
  | {
      kind: "wrote";
      drafts: ProjectEntryDraft[];
      results: WriteProjectEntryResult[];
      curatorAudits?: CuratorAudit[];
      llmAuditSummary: ReturnType<typeof summarizeLlmExtractorResult>;
      llmDurationMs: number;
      writeStart: number;
      rawTextStored?: string;
      rawTextTruncated?: boolean;
      rawTextRedacted?: boolean;
      rawTextRedactionReason?: string;
    };

function truncateRawForAudit(
  raw: string | undefined,
  cap: number,
): { text?: string; truncated?: boolean } {
  if (!raw || cap <= 0) return {};
  if (raw.length <= cap) return { text: raw, truncated: false };
  return { text: raw.slice(0, cap), truncated: true };
}

function sanitizeAuditText(value: unknown, cap: number): string | undefined {
  const raw = value === undefined || value === null ? "" : String(value);
  if (!raw) return undefined;
  const s = sanitizeForMemory(raw);
  const text = s.ok ? (s.text ?? raw) : `[redacted: ${s.error}]`;
  return cap > 0 ? text.slice(0, cap) : text;
}

function formatDeferredStopStatusDetail(reason: DeferredStopReason): string {
  return reason === "agent_error"
    ? "deferred — agent error; will retry after next healthy turn"
    : "deferred — agent aborted; will retry after next healthy turn";
}

async function recordDeferredRecoveryIfNeeded(args: {
  cwd: string;
  sessionId: string;
  window: RunWindow;
  checkpointAdvanced: boolean;
  lane: string;
  correlationId?: string;
}): Promise<void> {
  const pending = deferredStopBySession.get(args.sessionId);
  if (!pending || !args.checkpointAdvanced) return;

  await appendAudit(args.cwd, {
    operation: "deferred_recovered",
    lane: args.lane,
    session_id: args.sessionId,
    previous_reason: pending.reason,
    deferred_at: pending.timestamp,
    deferred_last_entry_id: pending.lastEntryId,
    recovered_last_entry_id: args.window.lastEntryId,
    checkpoint_advanced: true,
    ...(args.correlationId ? { correlation_id: args.correlationId } : {}),
  });
  deferredStopBySession.delete(args.sessionId);
}

/**
 * Sanitize the raw_text field before it lands in audit.jsonl. The LLM's
 * response (or its error spew) may echo back credentials from the window.
 * truncateRawForAudit only caps length — it does not redact secrets. This
 * wrapper applies the same typed-placeholder redaction used before LLM
 * calls so raw_text remains useful for forensics without storing plaintext
 * credentials.
 */
function sanitizeAndTruncateRawForAudit(
  raw: string | undefined,
  cap: number,
): { text?: string; truncated?: boolean; redacted?: boolean; redactionReason?: string } {
  if (!raw || cap <= 0) return {};
  // Sanitize BEFORE truncation. Truncating first can leave a partial token
  // that no longer matches vendor regexes but is still sensitive audit data.
  const s = sanitizeForMemory(raw);
  if (!s.ok) {
    const t = truncateRawForAudit(`[redacted: ${s.error}]`, cap);
    return {
      text: t.text,
      truncated: raw.length > cap,
      redacted: true,
      redactionReason: s.error,
    };
  }
  const sanitized = s.text ?? raw;
  const t = truncateRawForAudit(sanitized, cap);
  return {
    ...t,
    redacted: s.replacements.length > 0,
    ...(s.replacements.length > 0 ? { redactionReason: s.replacements.join(",") } : {}),
  };
}

/**
 * Build a thin rules CANDIDATE draft from a high-confidence durable
 * user-EXPRESSED correction signal (design consensus 2026-06-07, 3xT0
 * opus-4-8/gpt-5.5/deepseek-v4-pro). This does NOT bypass the curator: it only
 * guarantees the durable rule reaches curateProjectDraft so the rules-trust
 * taxonomy + create_rules_zone 2-pass review decide create-vs-skip and
 * zone/tier/ruleScope, instead of the rule being silently dropped when the
 * general extractor emits no draft for it (GAP B). The body LEADS with the
 * VERBATIM user_quote (maximally attributable); scope_description is a classifier
 * paraphrase used only as the candidate title/summary and as a fallback to pad a
 * terse quote past writeAbrainRule's min-body gate. The curator decides
 * zone/tier/ruleScope; kind stays the candidate kind ("preference" is valid for
 * rules — rules inject by tier, not kind — and the curator does not re-judge it).
 */
function buildEscalationSeedDraft(signal: CorrectionSignal, sessionId: string): ProjectEntryDraft {
  // typeof guards: parse should type these as strings, but a malformed signal
  // must not throw on .trim() inside the background lane (audit P2).
  const quote = (typeof signal.user_quote === "string" ? signal.user_quote : "").trim();
  const scope = (typeof signal.scope_description === "string" ? signal.scope_description : "").trim();
  // writeAbrainRule rejects a body < 10 code units (validation_error_body) and
  // many durable rules are terse ("用 glab"). Lead with the verbatim directive;
  // when it is too short to stand alone, append the classifier scope elaboration
  // so the body is self-contained without sacrificing attribution (audit P1).
  const compiledTruth = quote.length >= 10 ? quote : [quote, scope].filter(Boolean).join("\n\n");
  return {
    title: (scope || quote).slice(0, 200),
    kind: "preference",
    compiledTruth,
    summary: scope || undefined,
    status: "active",
    // Tier-1 seed: carry the deterministic provenance (user-expressed) so the
    // rule frontmatter records the true source instead of a blanket default.
    provenance: signal.provenance,
    confidence: signal.confidence,
    sessionId,
    timelineNote: "seeded from active-correction escalation (durable user-expressed rule)",
  };
}

/**
 * Run the LLM auto-write lane end-to-end. The function performs all
 * gate checks, runs the LLM extractor when enabled, and applies
 * `previewExtraction` plus the curator loop so compliant candidates
 * become create/update/merge/archive/supersede/delete/skip operations. Semantic hard gates were
 * removed in ADR 0016; git + audit provide rollback.
 */
async function tryAutoWriteLane(args: {
  cwd: string;
  sessionId: string;
  settings: SedimentSettings;
  window: RunWindow;
  modelRegistry: unknown;
  signal?: AbortSignal;
  correlationId: string;
  // 2026-05-13 B5 cutover: writer now requires abrain identity in opts.
  // tryAutoWriteLane is a module-level function (not nested inside the
  // agent_end closure where abrainHome / projectId live), so the curator
  // -> writer call sites below need these explicitly threaded through.
  // Without them, every non-skip curator decision crashes with
  // `ReferenceError: abrainHome is not defined` at runtime
  // (audit catches it as `auto_write_bg_threw`, footer shows `failed`).
  // Production smoke missed this because the smoke fixture exercises
  // writers directly, not via tryAutoWriteLane.
  abrainHome: string;
  projectId: string;
  /** When provided, enables continuation-call: reuses the main session's
   *  assembled messages as prompt prefix for KV cache reuse. */
  sessionManager?: unknown;
  /** When provided, the extractor uses the full branch for richer context
   *  instead of the pruned RunWindow. The fixed system prefix (AGENTS.md)
   *  + full transcript enables prompt caching across consecutive calls. */
  branchEntries?: unknown[];
  /** ADR 0025 P1: correction classifier result from the pre-lane run.
   *  Injected into curator context for better update/merge decisions.
   *  null when classifier didn't run (ephemeral session) or found no signal. */
  correctionSignal?: CorrectionSignal | null;
}): Promise<AutoWriteLaneOutcome> {
  const { cwd, sessionId, settings, window, correlationId, abrainHome, projectId, branchEntries, sessionManager } = args;
  const modelRegistry = args.modelRegistry as ModelRegistryLike | undefined;

  // ADR 0025 §5.3 P5.5 tristate gate:
  //   - false          → skip (full kill switch, also gates classifier upstream)
  //   - "staging-only" → skip tryAutoWriteLane but classifier+staging keep running
  //   - true           → run extractor / curator / writer (default since P5.5)
  if (settings.autoLlmWriteEnabled !== true) {
    return {
      kind: "ineligible",
      eligibility: {
        eligible: false,
        reason: settings.autoLlmWriteEnabled === "staging-only"
          ? "auto_write_staging_only_mode"
          : "auto_write_disabled_setting",
      },
    };
  }

  if (
    !modelRegistry ||
    typeof modelRegistry.find !== "function" ||
    typeof modelRegistry.getApiKeyAndHeaders !== "function"
  ) {
    return {
      kind: "ineligible",
      eligibility: { eligible: false, reason: "model_registry_unavailable" },
    };
  }

  const tier1ShadowSignal = args.correctionSignal;
  if (settings.tier1ShadowEnabled && tier1ShadowSignal && shouldEscalateToCurator(tier1ShadowSignal)) {
    const shadowStart = Date.now();
    const shadowDraft = buildEscalationSeedDraft(tier1ShadowSignal, sessionId);
    try {
      if (shadowDraft.compiledTruth.trim().length >= 10) {
        const shadow = await curateProjectDraft(shadowDraft, {
          projectRoot: cwd,
          sedimentSettings: settings,
          memorySettings: resolveMemorySettings(),
          modelRegistry,
          signal: args.signal,
          correctionSignal: tier1ShadowSignal,
          taskLocalContext: getTaskLocalForCurator(sessionId),
          projectId,
          abrainHome,
          observeOnly: true,
        });
        await appendAudit(cwd, {
          operation: "tier1_shadow_decision",
          lane: "auto_write",
          session_id: sessionId,
          ...checkpointSummary(window),
          correlation_id: correlationId,
          candidate_id: candidateIdFor(correlationId, -1),
          candidate_title: sanitizeAuditText(shadowDraft.title, 500),
          candidate_kind: shadowDraft.kind,
          candidate_confidence: shadowDraft.confidence,
          candidate_body_chars: shadowDraft.compiledTruth.length,
          correction_signal: {
            confidence: tier1ShadowSignal.confidence ?? null,
            provenance: tier1ShadowSignal.provenance ?? null,
            quote_source: tier1ShadowSignal.quote_source ?? null,
            quote: (tier1ShadowSignal.user_quote ?? "").slice(0, 200),
          },
          decision: shadow.decision,
          curator: shadow.audit,
          observe_only: true,
          wrote: false,
          signal_consumed: false,
          checkpoint_advanced: false,
          durationMs: Date.now() - shadowStart,
        });
      } else {
        await appendAudit(cwd, {
          operation: "tier1_shadow_decision",
          lane: "auto_write",
          session_id: sessionId,
          ...checkpointSummary(window),
          correlation_id: correlationId,
          candidate_id: candidateIdFor(correlationId, -1),
          reason: "shadow_candidate_body_too_short",
          observe_only: true,
          wrote: false,
          signal_consumed: false,
          checkpoint_advanced: false,
          durationMs: Date.now() - shadowStart,
        });
      }
    } catch (e: any) {
      await appendAudit(cwd, {
        operation: "tier1_shadow_decision",
        lane: "auto_write",
        session_id: sessionId,
        ...checkpointSummary(window),
        correlation_id: correlationId,
        candidate_id: candidateIdFor(correlationId, -1),
        reason: "tier1_shadow_error",
        error: sanitizeAuditText(e?.message ?? String(e), 500),
        observe_only: true,
        wrote: false,
        signal_consumed: false,
        checkpoint_advanced: false,
        durationMs: Date.now() - shadowStart,
      }).catch(() => {});
    }
  }

  // 1. Run extractor. It does not write or commit; it only runs the
  //    model and parses the MEMORY/SKIP response. The curator/writer
  //    stages below decide and persist lifecycle operations.
  //
  //    Continuation-call: if sessionManager is available, reuse the main
  //    session's assembled messages as prompt prefix so the provider-side
  //    KV cache from the main session call can be reused.
  const llmStart = Date.now();
  let continuationMessages: unknown[] | undefined;
  if (sessionManager) {
    continuationMessages = tryGetSessionMessages(sessionManager);
    if (!continuationMessages) {
      warnOnceIfUnavailable("SessionManager.buildSessionContext");
    }
  }
  let llmResult: LlmExtractorResult;
  try {
    llmResult = await runLlmExtractor(window.text, {
      settings,
      modelRegistry: modelRegistry as Parameters<
        typeof runLlmExtractor
      >[1]["modelRegistry"],
      signal: args.signal,
      branchEntries,
      continuationMessages,
    });
  } catch (e: any) {
    llmResult = {
      ok: false,
      model: settings.extractorModel,
      error: sanitizeAuditText(e?.message ?? "extractor threw", 500),
    };
  }
  const llmDurationMs = Date.now() - llmStart;

  const llmAuditSummary = summarizeLlmExtractorResult(llmResult, {
    maxCandidates: settings.extractorMaxCandidates,
    rawPreviewChars: settings.extractorAuditRawChars,
  });

  const {
    text: rawTextStored,
    truncated: rawTextTruncated,
    redacted: rawTextRedacted,
    redactionReason: rawTextRedactionReason,
  } = sanitizeAndTruncateRawForAudit(llmResult.rawText, settings.autoWriteRawAuditChars);

  if (!llmResult.ok) {
    return {
      kind: "llm_error",
      llmAuditSummary,
      llmDurationMs,
      rawTextStored,
      rawTextTruncated,
      rawTextRedacted,
      rawTextRedactionReason,
    };
  }

  // 2. Keep only schema-valid candidates. Semantic gates are gone; the
  //    curator decides create/update/merge/archive/supersede/delete/skip after looking up existing memory.
  const fullDrafts = llmResult.rawText && llmResult.rawText !== "SKIP"
    ? parseExplicitMemoryBlocks(llmResult.rawText)
    : [];
  const schemaPreview = previewExtraction(fullDrafts);
  const compliantDrafts: ProjectEntryDraft[] = fullDrafts.filter(
    (_, i) => schemaPreview.drafts[i]?.validationErrors.length === 0,
  );

  // Rule-escalation seed (design consensus 2026-06-07, 3xT0). A high-confidence
  // user-EXPRESSED durable CREATE signal must reach the curator EVEN WHEN the
  // general extractor produced no draft covering it (GAP B) — otherwise the rule
  // is silently dropped and only a provisional staging entry survives. Seeding at
  // this single chokepoint (all three lane callers funnel through tryAutoWriteLane
  // with the signal already forwarded) ALSO dissolves the window-size gating
  // (GAP A) with no caller edits. Suppressed when an extractor draft already
  // covers the same rule (cheap in-memory token-set Jaccard) to avoid a double
  // curator call + self-dedup. The curator + create_rules_zone 2-pass review +
  // write-time findSimilarRuleSlug dedup remain the gates (this never force-writes
  // a rule; the curator can still skip).
  const escSig = args.correctionSignal;
  if (escSig && shouldEscalateToCurator(escSig)) {
    const seedBody = (typeof escSig.user_quote === "string" ? escSig.user_quote : "").trim();
    // ADR 0028 v1.1: attribution grounding is now the DETERMINISTIC AX-PROVENANCE
    // gate inside shouldEscalateToCurator (provenance==='user-expressed' means the
    // verbatim quote was found in a USER-role turn, computed from turn.role in
    // correction-pipeline.deriveProvenance). That structurally blocks the
    // README/tool content-in-transcript trap, so the prior token-subset substring
    // band-aid is removed. Remaining guards: dedup (don't double-curate a rule the
    // extractor already covered) + min-body (writeAbrainRule rejects < 10 CU; fall
    // back to the provisional staging net rather than emit a guaranteed-reject).
    const alreadyCovered = compliantDrafts.some(
      (d) => ruleBodySimilarity(seedBody, d.compiledTruth ?? "") >= RULE_DEDUP_SIMILARITY_THRESHOLD,
    );
    if (!alreadyCovered) {
      const seed = buildEscalationSeedDraft(escSig, sessionId);
      // Do not emit a draft writeAbrainRule would reject for an under-length body
      // (validation_error_body, < 10 CU) — that would burn a curator call and, on
      // the optimistic-advance long/drain lanes, risk advancing past an unwritten
      // rule. When the body cannot be made valid, the provisional staging entry is
      // the no-loss net (audit P1: gpt-5.5 + deepseek).
      if (seed.compiledTruth.trim().length >= 10) compliantDrafts.push(seed);
    }
  }

  if (compliantDrafts.length === 0) {
    return {
      kind: "llm_skip",
      llmAuditSummary,
      llmDurationMs,
      rawTextStored,
      rawTextTruncated,
      rawTextRedacted,
      rawTextRedactionReason,
    };
  }

  // 3. Apply each compliant draft through the curator lookup loop.
  const writeStart = Date.now();
  const results: WriteProjectEntryResult[] = [];
  const curatorAudits: CuratorAudit[] = [];
  for (const [i, draft] of compliantDrafts.entries()) {
    const candidateId = candidateIdFor(correlationId, i);
    const auditContext: WriterAuditContext = {
      lane: "auto_write",
      sessionId,
      correlationId,
      candidateId,
    };
    let curated: Awaited<ReturnType<typeof curateProjectDraft>>;
    try {
      curated = await curateProjectDraft(draft, {
        projectRoot: cwd,
        sedimentSettings: settings,
        memorySettings: resolveMemorySettings(),
        modelRegistry,
        signal: args.signal,
        correctionSignal: args.correctionSignal,
        // §4.1.4: non-consuming read of this session's task-local working
        // set. Injected as NON-DURABLE context so the curator stays
        // consistent with how the user steered THIS session, without
        // ever treating a session-scoped instruction as durable.
        taskLocalContext: getTaskLocalForCurator(sessionId),
        projectId,
        abrainHome,
      });
    } catch (e: any) {
      // F4 defense (2026-05-14): curateProjectDraft has internal try/catch
      // for loadEntries / llmSearchEntries / callCuratorModel, but no
      // catch-all at the outermost function boundary. An unexpected runtime
      // error (e.g. path.resolve on malformed data, OOM) would previously
      // kill ALL remaining candidates in the loop. Now we isolate each
      // candidate's curator call and continue to the next.
      const error = sanitizeAuditText(e?.message ?? String(e), 500) ?? "curator crashed";
      curatorAudits.push({ decision: { op: "skip", reason: "curator_crashed", rationale: error }, neighbors: [], stage_ms: { search: 0, decide: 0, total: 0 }, error });
      results.push({
        slug: draft.title,
        path: "",
        status: "skipped",
        reason: `curator_crashed: ${error}`,
        lane: "auto_write",
        sessionId,
        correlationId,
        candidateId,
      });
      continue;
    }
    curatorAudits.push(curated.audit);
    results.push(
      ...(await executeCuratorDecisionToBrain({
        decision: curated.decision,
        draft,
        projectRoot: cwd,
        abrainHome,
        projectId,
        settings,
        dryRun: false,
        auditContext,
        sessionId,
        createTimelineNote: "captured from LLM auto-write extractor",
        updateTimelineNote: curated.decision.rationale || "updated by sediment curator",
        mergeTimelineNote: curated.decision.rationale || "merged by sediment curator",
        archiveReason: curated.decision.op === "archive" ? curated.decision.reason || curated.decision.rationale || "archived by sediment curator" : undefined,
        supersedeReason: curated.decision.op === "supersede" ? curated.decision.reason || curated.decision.rationale || "superseded by sediment curator" : undefined,
        deleteReason: curated.decision.op === "delete" ? curated.decision.reason || curated.decision.rationale || "deleted by sediment curator" : undefined,
      })),
    );
  }

  return {
    kind: "wrote",
    drafts: compliantDrafts,
    results,
    curatorAudits,
    llmAuditSummary,
    llmDurationMs,
    writeStart,
    rawTextStored,
    rawTextTruncated,
    rawTextRedacted,
    rawTextRedactionReason,
  };
}

/** Compact subset of SedimentSettings safe to embed in every audit row. */
function snapshotSedimentSettings(
  settings: ReturnType<typeof resolveSedimentSettings>,
) {
  return {
    enabled: settings.enabled,
    autoLlmWriteEnabled: settings.autoLlmWriteEnabled,
    extractorModel: settings.extractorModel,
    defaultConfidence: settings.defaultConfidence,
    maxWindowChars: settings.maxWindowChars,
    maxWindowEntries: settings.maxWindowEntries,
    skipContinuationSanitize: settings.skipContinuationSanitize,
  };
}

/**
 * Test-only hook to reset all in-process state. Smoke tests call this
 * between fixtures so cross-fixture pollution can't mask real bugs.
 * Do not call from production code paths.
 */
export function _resetAutoWriteStateForTests(): void {
  autoWriteInFlight.clear();
  multiViewReplayInFlight.clear();
  sedimentStatusBySession.clear();
  sessionAgentCycle.clear();
  sessionCorrectionWorkingSet.clear();
  sessionTaskLocalSet.clear();
  deferredStopBySession.clear();
  _resetWarnedApisForTests();
}

/**
 * Test-only export of `tryAutoWriteLane` so smoke can drive the
 * extractor → curator → writer integration path that the explicit-marker
 * lane bypasses. Added 2026-05-13 alongside the B5 sediment writer cutover
 * after a code review found that `tryAutoWriteLane` had silently lost
 * lexical access to its `abrainHome` / `projectId` closure variables
 * (they live inside the `agent_end` listener, not at module scope) and
 * production smoke missed it because every writer fixture calls the
 * writer functions directly. Smoke should call this with a stub LLM /
 * model registry to lock the closure-arg threading invariant.
 */
export const _tryAutoWriteLaneForTests = tryAutoWriteLane;
export const _dispatchCorrectionSignalForTests = dispatchCorrectionSignal;
// §4.1.4 task-local working set test hooks.
export const _rememberTaskLocalForTests = rememberTaskLocal;
export const _getTaskLocalForCuratorForTests = getTaskLocalForCurator;
export const _taskLocalCapsForTests = {
  MAX_TASK_LOCAL_SESSIONS,
  MAX_TASK_LOCAL_ITEMS,
};

/**
 * Test-only hook to await any background auto-write work to settle.
 * Smoke tests that exercise the bg path call this before asserting
 * on audit rows produced asynchronously.
 */
export async function _waitForAutoWriteIdleForTests(): Promise<void> {
  while (autoWriteInFlight.size > 0 || multiViewReplayInFlight.size > 0) {
    await Promise.allSettled([...autoWriteInFlight.values(), ...multiViewReplayInFlight.values()]);
  }
}

/** Tally entry types within the included window for at-a-glance diagnostics. */
function countEntryTypes(entries: unknown[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const obj = e as Record<string, unknown>;
    let key = typeof obj.type === "string" ? obj.type : "unknown";
    if (key === "message" && obj.message && typeof obj.message === "object") {
      const role = (obj.message as Record<string, unknown>).role;
      if (typeof role === "string") key = `message/${role}`;
    }
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** Identifier of the parser-version producing this audit row.
 *  Bumped whenever the parser semantics change (e.g., fence-awareness). */
const PARSER_VERSION = "fence_aware_v1";

/**
 * Best-effort sessionId reader, with ephemeral-session filtering.
 *
 * pi >= 0.74 exposes `getSessionId` on ReadonlySessionManager. However,
 * `--no-session` (and dispatch_agent subprocesses) still allocate a fresh
 * UUID for the in-memory session even though nothing is persisted to
 * disk; using that UUID as a checkpoint slot would balloon
 * `checkpoint.json` with single-use entries and pollute audit `session_id`
 * fields with throwaway IDs.
 *
 * We treat a session as ephemeral (=> return undefined here) when
 * `getSessionFile()` is unavailable or returns no path. The agent_end
 * handler then early-returns before any extractor/writer work and emits
 * a single `ephemeral_session: true` audit row for attribution.
 */
function readSessionId(
  sm:
    | {
        getSessionId?(): string | undefined | null;
        getSessionFile?(): string | undefined | null;
      }
    | undefined,
): string | undefined {
  if (!sm || typeof sm.getSessionId !== "function") return undefined;
  if (typeof sm.getSessionFile === "function") {
    try {
      const file = sm.getSessionFile();
      if (!file || typeof file !== "string") return undefined;
    } catch {
      return undefined;
    }
  }
  try {
    const id = sm.getSessionId();
    return typeof id === "string" && id.trim() ? id : undefined;
  } catch {
    return undefined;
  }
}

function scheduleMultiviewReplay(args: {
  enabled: boolean;
  cwd: string;
  sessionId: string;
  settings: ReturnType<typeof resolveSedimentSettings>;
  modelRegistry: unknown;
  abrainHome: string;
  projectId: string;
}): void {
  if (!args.enabled || !args.cwd || !args.sessionId) return;

  // Staging is user-global under one abrain home. Key in-flight replay by
  // abrain+project binding rather than session so `/new` or two sessions
  // cannot spend duplicate reviewer calls on the same staging files.
  const replayCwd = args.cwd;
  const replaySessionId = args.sessionId;
  const replayKey = `${path.resolve(args.abrainHome)}:${args.projectId}:${path.resolve(replayCwd)}`;
  if (multiViewReplayInFlight.has(replayKey)) return;

  // Re-bind for the closure to avoid any subsequent scope mutation.
  const { settings, modelRegistry, abrainHome, projectId } = args;

  let replayPromise!: Promise<void>;
  replayPromise = (async () => {
    try {
      const memSettings = resolveMemorySettings();
      const replayResult: ReplayBatchResult = await replayMultiviewPending({
        settings,
        modelRegistry: modelRegistry as Parameters<typeof replayMultiviewPending>[0]["modelRegistry"],
        currentProjectId: projectId,
        currentProjectRoot: replayCwd,
        loadNeighborsBySlug: async (slugs: string[]) => {
          if (slugs.length === 0) return [];
          const all = await (await import("../memory/parser")).loadEntries(replayCwd, memSettings, undefined);
          const filtered = relevantEntriesForCurator(all);
          const bySlug = new Map(filtered.map((entry) => [entry.slug, entry]));
          return slugs.map((slug) => bySlug.get(slug)).filter((entry): entry is NonNullable<typeof entry> => !!entry);
        },
        writeApprovedToBrain: async (decision, candidate) => {
          const replayCorrelationId = makeCorrelationId("replay", replaySessionId, {
            lastEntryId: `multiview-replay-${candidate.title}`,
          });
          let results: WriteProjectEntryResult[] = [];
          let dispatcherError: unknown;
          try {
            results = await executeCuratorDecisionToBrain({
              decision,
              draft: candidate,
              projectRoot: replayCwd,
              abrainHome,
              projectId,
              settings,
              dryRun: false,
              auditContext: {
                lane: "replay",
                sessionId: replaySessionId,
                correlationId: replayCorrelationId,
                candidateId: candidateIdFor(replayCorrelationId, 0),
              },
              sessionId: replaySessionId,
              createTimelineNote: "captured from multi-view staging replay",
              updateTimelineNote: decision.rationale || "updated by multi-view staging replay",
              mergeTimelineNote: decision.rationale || "merged by multi-view staging replay",
              archiveReason: decision.op === "archive" ? decision.reason || decision.rationale || "archived by multi-view staging replay" : undefined,
              supersedeReason: decision.op === "supersede" ? decision.reason || decision.rationale || "superseded by multi-view staging replay" : undefined,
              deleteReason: decision.op === "delete" ? decision.reason || decision.rationale || "deleted by multi-view staging replay" : undefined,
            });
          } catch (e: unknown) {
            dispatcherError = e;
          }

          try {
            await appendAudit(replayCwd, {
              operation: "multi_view_replay_brain_write",
              session_id: replaySessionId,
              lane: "replay",
              correlation_id: replayCorrelationId,
              decision_op: decision.op,
              decision,
              candidate_title: candidate.title,
              candidate_kind: candidate.kind,
              result_count: results.length,
              results: results.map(resultSummary),
              writer_rejected: results.some((r) => r.status === "rejected"),
              ...(dispatcherError ? { dispatcher_error: dispatcherError instanceof Error ? dispatcherError.message : String(dispatcherError) } : {}),
            });
          } catch {
            // The dispatcher may already have applied a durable brain write.
            // Keep this diagnostic row best-effort so audit failure cannot
            // preserve staging and replay an already-applied mutation.
          }

          if (dispatcherError) throw dispatcherError;
          const rejected = results.find((r) => r.status === "rejected");
          if (rejected) {
            throw new Error(`multi-view replay writer rejected op=${decision.op}: ${rejected.reason || "unknown"}`);
          }
          const missingCommit = results.find((r) => settings.gitCommit === true
            && r.status !== "skipped"
            && r.status !== "dry_run"
            && r.gitCommit === null);
          if (missingCommit) {
            throw new Error(`multi-view replay writer missing git commit op=${decision.op} status=${missingCommit.status} slug=${missingCommit.slug}`);
          }
        },
        signal: undefined,
      });

      // Audit the replay batch outcome.
      await appendAudit(replayCwd, {
        operation: "multi_view_replay_batch",
        session_id: replaySessionId,
        lane: "replay",
        attempted: replayResult.attempted,
        succeeded: replayResult.succeeded,
        re_staged: replayResult.re_staged,
        terminal_max_retries: replayResult.terminal_max_retries,
        terminal_stale: replayResult.terminal_stale,
        deferred_other_project: replayResult.deferred_other_project,
        skipped_backoff: replayResult.skipped_backoff,
        cleanup_pending: replayResult.cleanup_pending,
        terminal_writer_max_retries: replayResult.terminal_writer_max_retries,
        staging_delete_failed: replayResult.staging_delete_failed,
        errors: replayResult.errors,
        total_pending: replayResult.totalPending,
        durationMs: replayResult.durationMs,
      });

      // Per-row audit so each entry's full context is traceable. Keep
      // individual rows best-effort: staging state has already been
      // finalized by replayMultiviewPending, so an audit append failure
      // must not turn the lane into a false replay failure.
      for (const row of replayResult.auditRows) {
        try {
          await appendAudit(replayCwd, {
            operation: row.outcome === "error" ? "multi_view_replay_entry_error" : "multi_view_replay_entry",
            session_id: replaySessionId,
            lane: "replay",
            slug: row.slug,
            prior_state: row.prior_state,
            prior_attempts: row.prior_attempts,
            age_days: row.age_days,
            outcome: row.outcome,
            detail: row.detail,
            new_state: row.new_state,
            new_attempts: row.new_attempts,
            new_writer_attempts: row.new_writer_attempts,
            new_decision: row.new_decision,
            durationMs: row.durationMs,
          });
        } catch { /* best-effort per-entry audit */ }
      }
    } catch (e: unknown) {
      // Any uncaught error in the replay framework itself (not
      // per-entry, those are caught inside processOneEntry). Audit
      // and continue — replay is non-critical; main flow already
      // succeeded.
      try {
        await appendAudit(replayCwd, {
          operation: "multi_view_replay_lane_error",
          session_id: replaySessionId,
          lane: "replay",
          error: e instanceof Error ? e.message : String(e),
        });
      } catch { /* best-effort */ }
    } finally {
      if (multiViewReplayInFlight.get(replayKey) === replayPromise) {
        multiViewReplayInFlight.delete(replayKey);
      }
      maybeSetIdleIfNoInflight(replaySessionId);
    }
  })();
  multiViewReplayInFlight.set(replayKey, replayPromise);
  replayPromise.catch(() => {});
}

// ===========================================================================
// /about-me slash command (ADR 0021 G2, 2026-05-20)
// ===========================================================================
//
// `/about-me [--region=identity|skills|habits] [--title="..."] <body>`
//
// Builds a MEMORY-ABOUT-ME fence and injects it into the transcript via
// `pi.sendUserMessage`. The next agent_end then runs sediment's Lane G
// pipeline (parseExplicitAboutMeBlocks → writeAbrainAboutMe), keeping
// the layer-1 mechanic from ADR 0014 §6 / ADR 0021 invariant #3: the
// slash handler NEVER touches the writer directly. The cost is one
// extra LLM turn per /about-me invocation (the fence shows up in chat;
// the assistant typically acknowledges, then sediment writes on the
// resulting agent_end). The UX trade-off is documented in ADR 0021 D4.
//
// UI substrate decision (2026-05-20): G2 uses ctx.ui.select + ctx.ui.input
// rather than ADR 0022's askPromptUser overlay. Rationale:
//   - askPromptUser's chained-fallback path runs exactly these primitives
//     (service.ts chainedFallback), so functionally equivalent;
//   - avoids a sediment → abrain prompt-user dependency (no buildDialog /
//     pi-tui require + no PromptAuditSink wiring required here);
//   - consistent with /abrain, /secret, /vault — all of which use
//     ctx.ui.select + ctx.ui.input directly.
// A future polish PR can upgrade to the askPromptUser overlay if the
// unified UX is desired; the slash contract (args parsing + fence build
// + sendUserMessage) does not depend on the input modality.

/**
 * Parse `/about-me` args. Recognized flags (anywhere in `args`):
 *   --region=<id|skills|habits>
 *   --title=<bareWord|"quoted phrase"|'quoted phrase'>
 * Anything else becomes the body.
 *
 * Flags must start at the beginning OR after whitespace (the regex
 * uses `(?:^|\s)`), so a literal occurrence of `--region=foo` inside a
 * body sentence (e.g. mid-word `--region=foo`) is NOT stripped — the
 * common false-positive of "user types --region=identity is my pick"
 * is the unavoidable edge case; we accept it because it's unambiguous
 * at the syntactic level.
 */
export function parseAboutMeArgs(args: string): {
  region?: string;
  title?: string;
  body: string;
} {
  let s = args || "";
  let region: string | undefined;
  let title: string | undefined;
  s = s.replace(/(?:^|\s)--region=(\S+)/g, (_m, v) => {
    region = String(v);
    return "";
  });
  s = s.replace(
    /(?:^|\s)--title=("([^"]*)"|'([^']*)'|(\S+))/g,
    (_m, _all, dq, sq, bare) => {
      title = dq !== undefined ? dq : sq !== undefined ? sq : bare;
      return "";
    },
  );
  return { region, title, body: s.replace(/\s+/g, " ").trim() };
}

/**
 * Derive a fence title from the body when --title is omitted. Takes the
 * first non-empty line, strips leading markdown ornamentation, truncates
 * to 80 chars. Writer constraint is ≤ 200, but 80 keeps the fence header
 * readable and matches Lane A's typical title length.
 */
export function deriveAboutMeTitle(body: string): string {
  const firstLine =
    body.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? body;
  const stripped = firstLine.replace(/^[#>*\-\s]+/, "").trim();
  const slim = stripped.slice(0, 80).trim();
  return slim || "about-me";
}

/**
 * Build the MEMORY-ABOUT-ME fence text exactly as parseExplicitAboutMeBlocks
 * expects to parse it back out. Kept as an exported helper so smoke can
 * round-trip the slash output through the extractor.
 */
export function buildAboutMeFence(opts: {
  title: string;
  region: string;
  body: string;
}): string {
  return [
    "MEMORY-ABOUT-ME:",
    `title: ${opts.title}`,
    `region: ${opts.region}`,
    "---",
    opts.body,
    "END_MEMORY",
  ].join("\n");
}

function registerAboutMeCommand(pi: ExtensionAPI): void {
  const maybePi = pi as unknown as {
    registerCommand?: (
      name: string,
      options: {
        description?: string;
        getArgumentCompletions?: (
          prefix: string,
        ) => Array<{ value: string; label: string }> | null;
        handler: (
          args: string,
          ctx: {
            cwd?: string;
            ui: {
              notify(message: string, type?: string): void;
              select?: (
                title: string,
                items: string[],
                opts?: { signal?: AbortSignal },
              ) => Promise<string | undefined>;
              input?: (
                prompt: string,
                opts?: { signal?: AbortSignal },
              ) => Promise<string | undefined>;
            };
            isIdle?(): boolean;
            waitForIdle?(): Promise<void>;
            signal?: AbortSignal;
          },
        ) => Promise<void> | void;
      },
    ) => void;
    sendUserMessage?: (
      content: string,
      options?: { deliverAs?: "steer" | "followUp" },
    ) => void | Promise<void>;
  };
  if (typeof maybePi.registerCommand !== "function") return;

  const VALID_REGIONS = ["identity", "skills", "habits"] as const;
  const FLAGS = [
    "--region=identity",
    "--region=skills",
    "--region=habits",
    "--title=",
  ];

  maybePi.registerCommand("about-me", {
    description:
      "Advanced transition/diagnostic entry: /about-me [--region=identity|skills|habits] [--title=\"...\"] <body>. Injects a MEMORY-ABOUT-ME fence into the transcript; sediment writes to ~/.abrain/<region>/ on the next agent_end (ADR 0021 G2). Prefer natural conversation + background sediment for normal use. Empty body opens interactive prompts.",
    getArgumentCompletions(prefix: string) {
      const filtered = FLAGS.filter((item) => item.startsWith(prefix));
      return filtered.length
        ? filtered.map((value) => ({ value, label: value }))
        : null;
    },
    async handler(args, ctx) {
      const parsed = parseAboutMeArgs(args || "");
      let region = parsed.region?.toLowerCase();
      let title = parsed.title;
      let body = parsed.body;

      // Empty body + no region → interactive prompt for both.
      // Empty body + region supplied (e.g. `/about-me --region=skills`)
      // → only prompt for body.
      if (!body) {
        if (!region) {
          if (typeof ctx.ui.select !== "function") {
            ctx.ui.notify(
              "/about-me requires an interactive UI. Provide body inline: /about-me [--region=identity|skills|habits] <text>",
              "warning",
            );
            return;
          }
          const picked = await ctx.ui.select(
            "Which about-me region?",
            VALID_REGIONS as unknown as string[],
            { signal: ctx.signal },
          );
          if (!picked) {
            ctx.ui.notify("/about-me cancelled", "info");
            return;
          }
          region = picked.toLowerCase();
        }
        if (typeof ctx.ui.input !== "function") {
          ctx.ui.notify(
            "/about-me requires an interactive UI. Provide body inline: /about-me [--region=...] <text>",
            "warning",
          );
          return;
        }
        const text = await ctx.ui.input(
          "Your about-me statement (≥ 20 chars):",
          { signal: ctx.signal },
        );
        if (!text || !text.trim()) {
          ctx.ui.notify("/about-me cancelled", "info");
          return;
        }
        body = text.trim();
      }

      // Default region when body inline + no --region flag.
      if (!region) region = "identity";
      if (!(VALID_REGIONS as readonly string[]).includes(region)) {
        ctx.ui.notify(
          `/about-me --region must be one of ${VALID_REGIONS.join(", ")}; got '${region}'`,
          "warning",
        );
        return;
      }

      // Writer requires body ≥ 20 chars. Fail fast in the slash so the
      // user gets a clear error rather than waiting for sediment to
      // reject the fence with `validation_error` next turn.
      if (body.length < 20) {
        ctx.ui.notify(
          `/about-me body must be at least 20 characters (got ${body.length}). Tip: full sentences make better memory entries.`,
          "warning",
        );
        return;
      }
      // Cap the fence body to keep one /about-me from dominating the
      // run window. Writer accepts much larger bodies, but a 4KB fence
      // is plenty for an identity / skills / habits declaration; longer
      // entries belong in markdown edits via memory tools.
      const MAX_BODY = 4000;
      if (body.length > MAX_BODY) {
        ctx.ui.notify(
          `/about-me body must be ≤ ${MAX_BODY} characters (got ${body.length}). Split into multiple /about-me declarations or edit the markdown directly.`,
          "warning",
        );
        return;
      }

      title = (title && title.trim()) || deriveAboutMeTitle(body);
      const fence = buildAboutMeFence({ title, region, body });

      // pi.sendUserMessage triggers an LLM turn whose agent_end will
      // pick the fence up via parseExplicitAboutMeBlocks. ADR 0021 D4 +
      // inv #3: slash must NOT call the writer directly.
      if (typeof maybePi.sendUserMessage !== "function") {
        ctx.ui.notify(
          "/about-me failed: pi.sendUserMessage is not available in this pi runtime. Paste the MEMORY-ABOUT-ME fence into your next message manually.",
          "error",
        );
        return;
      }

      // waitForIdle is the recommended safety hook before sendUserMessage
      // in non-streaming mode (pi extensions.md). Best-effort: older pi
      // versions may not expose it.
      try {
        const maybeWait = (ctx as { waitForIdle?: () => Promise<void> })
          .waitForIdle;
        if (typeof maybeWait === "function") {
          await maybeWait.call(ctx);
        }
      } catch {
        /* best-effort */
      }

      try {
        await maybePi.sendUserMessage(fence);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`/about-me sendUserMessage failed: ${message}`, "error");
        return;
      }

      ctx.ui.notify(
        `/about-me [${region}] submitted (title="${title.slice(0, 60)}${title.length > 60 ? "…" : ""}"). Sediment will write to ~/.abrain/${region}/ after this turn finishes.`,
        "info",
      );
    },
  });
}
