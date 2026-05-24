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
  loadSessionCheckpoint,
  saveSessionCheckpoint,
  type RunWindow,
} from "./checkpoint";
import { curateProjectDraft, type CuratorAudit } from "./curator";
import { detectProjectDuplicate } from "./dedupe";
import { parseExplicitAboutMeBlocks, parseExplicitMemoryBlocks, previewExtraction, type ExtractedAboutMeDraft } from "./extractor";
import {
  runLlmExtractor,
  summarizeLlmExtractorResult,
  type LlmExtractorResult,
} from "./llm-extractor";
import { runCorrectionPipeline, type RelatedEntryCard, type CorrectionSignal } from "./correction-pipeline";
import { collectOutcomes, writeOutcomeLedger } from "./outcome-collector";
import { tryGetSessionMessages, verifyPiInternals, warnOnceIfUnavailable, _resetWarnedApisForTests } from "../_shared/pi-internals";
import { resolveSettings as resolveMemorySettings } from "../memory/settings";
import { sanitizeForMemory } from "./sanitizer";

import {
  appendAudit,
  archiveProjectEntry,
  deleteProjectEntry,
  mergeProjectEntries,
  supersedeProjectEntry,
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
  /** sessionId of the CURRENT foreground session (updated by
   *  session_start / agent_start). Used by maybeSetIdleIfNoInflight
   *  to distinguish same-session bg completion (keep completed/failed
   *  indicator visible) from cross-session /new bg completion (flip
   *  the new session's stuck 'running (prev session)' back to idle). */
  __sediment_currentSessionId?: string | undefined;
};
if (_G.__sediment_inflightCount === undefined) _G.__sediment_inflightCount = 0;

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
 * the sessionId.
 *
 * 2026-05-24 history:
 *   commit f3555e8 hard-disabled this function (no-op) as part of
 *   INV-INVISIBILITY collapse — the reasoning was that the footer
 *   slot's persistent "📝 sediment / ✅ sediment: 3 created" display
 *   was the status-bar equivalent of the "I learned X" popup explicitly
 *   banned by ADR 0024 §4.2 anti-pattern #1.
 *
 *   That collapse over-reached: ADR 0024 §4.3 explicitly carves out
 *   "high-power user diagnostic" surfaces (the author / dogfood debugger
 *   needs to see what sediment is doing in the background — hard-disabling
 *   the footer removes that observability without replacement).
 *
 *   The correct semantic is opt-in:
 *     - default false — INV-INVISIBILITY satisfied for regular users
 *     - settings.devFooterEnabled = true — power users opt in
 *
 *   This commit (post-f3555e8) restores the original write path under
 *   the settings flag. Both setStatus call and the in-memory Map are
 *   kept inside the gate so flipping the flag doesn't require restart
 *   to re-populate state.
 *
 * Map invariant: sedimentStatusBySession.set() always runs (even when
 * devFooterEnabled=false) so agent_start's reset-to-idle gate logic
 * keeps working consistently. Reads of this Map are NOT user-visible;
 * only setStatus / _G.__sediment_latestSetStatus are footer surfaces.
 */
function applySedimentStatus(
  setStatus: ((msg?: string) => void) | undefined,
  sessionId: string | undefined,
  state: SedimentStatus,
  detail?: string,
): void {
  // Always track in-memory state (call-site compat for agent_start reset).
  if (sessionId) sedimentStatusBySession.set(sessionId, state);

  // Opt-in footer surface (ADR 0024 §4.3 power-user diagnostic).
  // resolveSedimentSettings is cheap (file read + parse) but called per
  // status update, which is per-agent_end + drain ticks. If this turns
  // into a hotspot, hoist the check to a module-level cached flag with
  // a session_start reload — not needed at current call frequency.
  if (!resolveSedimentSettings().devFooterEnabled) return;

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
 * Same opt-in semantics as applySedimentStatus: only runs when
 * settings.devFooterEnabled = true.
 */
function maybeSetIdleIfNoInflight(bgSessionId: string | undefined): void {
  if (!resolveSedimentSettings().devFooterEnabled) return;
  if ((_G.__sediment_inflightCount ?? 0) > 0) return;
  if (!_G.__sediment_latestSetStatus) return;
  // Same-session bg completion: keep the completed/failed indicator
  // visible. agent_start on the next prompt will reset to idle.
  // (Undefined bg/foreground sessionId falls through to the cross-
  // session path — better to risk one extra idle flip than to leave a
  // stuck 'prev session' display when sessionId tracking is missing.)
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
 * Session-local working set for task-local: NOT IMPLEMENTED in this commit.
 * Until that lands, task-local signals are dropped from the current curator
 * (preventing pollution) but lost from future curators (incomplete
 * ADR §4.1.4 fulfillment). The dispatch audit row records the drop so a
 * future aggregator can quantify how much task-local signal we are losing.
 */
function dispatchCorrectionSignal(
  signal: CorrectionSignal | null | undefined,
): {
  forwarded: CorrectionSignal | null;
  decision:
    | "forwarded_to_curator"
    | "dropped_debug"
    | "dropped_task_local"
    | "dropped_unknown_typing"
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
      // TODO(session-local-working-set): ADR §4.1.4 says task-local should
      // accumulate into a session-local working set and inject into FUTURE
      // curator calls (not the current one). Until that's implemented, we
      // drop from the current curator to prevent task-local pollution; the
      // signal is lost from future curators too. Audit captures the drop.
      return {
        forwarded: null,
        decision: "dropped_task_local",
        reason: "per ADR §4.1.4 task-local belongs in a session-local working set (not yet implemented); dropped from current curator to prevent pollution",
      };
    case "durable":
      return {
        forwarded: signal,
        decision: "forwarded_to_curator",
        reason: `durable typing${signal.confidence !== undefined ? ` (conf=${signal.confidence})` : ""} forwarded to curator advisory`,
      };
    default:
      // Unknown / missing typing — conservative: forward as advisory
      // (preserves pre-T1-1 behavior for any signal whose typing field
      // didn't parse). Audit flags it so we can spot classifier regressions.
      return {
        forwarded: signal,
        decision: "dropped_unknown_typing",
        reason: `signal has unknown or missing typing (${JSON.stringify(signal.typing ?? null)}); forwarded conservatively`,
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
  lane: "explicit" | "auto_write" | "about_me",
  sessionId: string,
  window: RunWindow,
): string {
  return `${lane}-${safeAuditIdPart(sessionId, "session")}-${safeAuditIdPart(window.lastEntryId, "entry")}-${Date.now().toString(36)}`;
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
  pi.on("before_agent_start", async (event: { systemPrompt?: string }) => {
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

例外：用户**明确**说“沉淀这条” / 调用 \`/sediment\` 或 \`/about-me\`
slash 命令、或在回复里主动写 \`MEMORY:\` / \`MEMORY-ABOUT-ME:\`
fence 时才走显式 lane。没有明确请求就让 sediment 自己接 ——
它看到了。不确定是否“明确”时不要写。

读是完全开放的：\`memory_search\` / \`memory_get\` / \`memory_list\` /
\`memory_neighbors\` / \`memory_decide\` 都鼓励动手前查。
`;
    return { systemPrompt: current + "\n\n" + block };
  });

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

      if ((_G.__sediment_inflightCount ?? 0) > 0) {
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
      if ((_G.__sediment_inflightCount ?? 0) > 0) {
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
      // Fire-and-forget outcome collection: scan branch for memory tool
      // invocations and log retrieved entries to outcome-ledger (ADR 0025 P2).
      // Invalid footnotes (placeholder slugs, unknown 'used' values) are
      // routed to audit.jsonl as 'outcome_footnote_parse_error' instead of
      // silently defaulted to 'confirmatory' — per pattern
      // `outcome-footnote-handling-principle-prefer-loss-over-guessing`.
      if (sessionId && branch.length > 0) {
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
        applySedimentStatus(setStatus, sessionId, "completed", `project_not_bound:${binding.reason}`);
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
        await appendAudit(cwd, {
          operation: "skip",
          lane: "system",
          reason: unhealthyStopReason,
          session_id: sessionId,
          branch_size: branch.length,
          stop_reason: lastAssistant?.stopReason,
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
        const detail =
          unhealthyStopReason === "agent_error"
            ? "agent error"
            : "agent aborted";
        applySedimentStatus(setStatus, sessionId, "completed", detail);
        return;
      }

      const tStart = Date.now();
      const checkpoint = await loadSessionCheckpoint(cwd, sessionId);
      const window = buildRunWindow(branch, checkpoint, settings);
      const tWindowBuilt = Date.now();
      const summary = checkpointSummary(window);
      const entryBreakdown = countEntryTypes(window.entries);

      if (window.skipReason || !window.lastEntryId) {
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
          stage_ms: {
            window_build: tWindowBuilt - tStart,
            parse: 0,
            write_total: 0,
            total: Date.now() - tStart,
          },
          checkpoint_advanced: !!window.lastEntryId,
        });
        // Healthy no-op skip (window too small or empty). Mark completed
        // so the agent_start of the next prompt resets to idle.
        applySedimentStatus(
          setStatus,
          sessionId,
          "completed",
          window.skipReason ?? "no new entries",
        );
        return;
      }

      const tParseStart = Date.now();
      const drafts = parseExplicitMemoryBlocks(window.text);
      // ADR 0021 G2 (2026-05-20): parse Lane G MEMORY-ABOUT-ME fences in
      // the same window pass. Lane A and Lane G run as TWO independent
      // synchronous write loops further below; if neither hits we still
      // drop into the LLM auto-write lane (Lane C). The bg auto-write
      // lane intentionally does NOT consume Lane G fences — explicit
      // attestation is the only way to write identity/skills/habits in
      // G1–G2 (G3 will add an LLM aboutness classifier).
      const aboutMeDrafts = parseExplicitAboutMeBlocks(window.text);
      const tParseEnd = Date.now();

      // ADR 0025 P1: run correction classifier as FIRE-AND-FORGET.
      // Must not block agent_end — the classifier does 2 LLM calls
      // (memory_search + classifier) which take 10-45s. Blocking here
      // makes the main session show "Working" and prevents the user
      // from continuing.
      //
      // The classifier Promise is stored so the auto-write lane can
      // await it before launching curator (correctionSignal is needed
      // for better update/merge decisions). Lane A/G don't consume it.
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
            const searchQuery = window.text.slice(-2000);
            const memResult = await (await import("../memory/llm-search")).llmSearchEntries(
              await (await import("../memory/parser")).loadEntries(cwd, memSettings, ctx.signal),
              { query: `Find memory entries related to: ${searchQuery.slice(-500)}`, filters: { limit: 10, status: ["active"] } },
              memSettings,
              modelRegistry,
              ctx.signal,
              cwd,
            ) as Array<{ slug: unknown; title?: unknown; kind?: unknown; status?: unknown; scope?: unknown; compiled_truth?: unknown }>;
            relatedEntries = (memResult && !(memResult as any).ok)
              ? []
              : (Array.isArray(memResult) ? memResult.map((c: any) => ({
                  slug: String(c.slug ?? ""),
                  title: typeof c.title === "string" ? c.title : undefined,
                  scope: typeof c.scope === "string" ? c.scope : typeof c.metadata?.scope === "string" ? c.metadata.scope : undefined,
                  kind: typeof c.kind === "string" ? c.kind : undefined,
                  status: typeof c.status === "string" ? c.status : undefined,
                  summary: typeof c.compiled_truth === "string" ? c.compiled_truth.slice(0, 150) : undefined,
                })).filter(e => e.slug) : []);
          } catch { /* search failure is non-fatal */ }
          const cr = await runCorrectionPipeline(branch, relatedEntries, {
            settings,
            modelRegistry: modelRegistry as Parameters<typeof runCorrectionPipeline>[2]["modelRegistry"],
            signal: ctx.signal,
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
          }).catch(() => {});
          return cr;
        })();
        // Don't await — fire-and-forget. Auto-write lane will await it.
      }

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
                        correctionSignal: undefined, // drain re-reads branch — original signal may be stale
                      });
                      // Round 8 P1 (sonnet R8 audit fix): drain loop now
                      // writes audit rows for ALL outcomes (wrote /
                      // ineligible / llm_skip / llm_error / threw),
                      // mirroring main bg path. Previously only `wrote`
                      // produced an audit row — every other outcome was
                      // silent, leaving operators with no forensic trail
                      // for drain failures.
                      if (auto.kind === "wrote") {
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
                          checkpoint_advanced: true,
                          background_async: true,
                          drain: true,
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
          // Do not advance the checkpoint and do not write audit noise:
          // the next agent_end after that worker drains will start from
          // the checkpoint advanced by the previous run and include this
          // turn's content in the next window.
          return;
        }

        // Optimistic checkpoint advance before launching bg work.
        await saveSessionCheckpoint(cwd, sessionId, {
          lastProcessedEntryId: window.lastEntryId,
        });

        // Mark running BEFORE scheduling the bg promise so the footer
        // updates synchronously with agent_end. The bg promise will
        // transition to completed/failed in its finally block.
        applySedimentStatus(setStatus, sessionId, "running", "extracting");
        const autoCorrelationId = makeCorrelationId(
          "auto_write",
          sessionId,
          window,
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
              window,
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
                const dispatch = dispatchCorrectionSignal(classifierResult?.signal ?? null);
                if (classifierResult?.signal) {
                  appendAudit(cwd, {
                    operation: "correction_signal_dispatch",
                    lane: "auto_write",
                    session_id: sessionId,
                    correlation_id: autoCorrelationId,
                    decision: dispatch.decision,
                    reason: dispatch.reason,
                    signal_typing: classifierResult.signal.typing ?? null,
                    signal_confidence: classifierResult.signal.confidence ?? null,
                    signal_target_slug: classifierResult.signal.target_entry_slug ?? null,
                    prompt_version: buildPromptVersionAudit("activeCorrectionClassifier", settings),
                  }).catch(() => {});
                }
                return dispatch.forwarded;
              })(),
            });
            const tAutoEnd = Date.now();

            if (auto.kind === "wrote") {
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
              // ADR 0024 §2 INV-INVISIBILITY (2026-05-24): Lane C
              // auto-write is fully autonomous — the user did NOT trigger
              // it with an explicit fence or slash command. Notifying
              // "Sediment auto-write (bg): N entries" after every turn
              // is the literal form of §4.2 anti-pattern #1 (system
              // popup 'I learned X'). audit.jsonl below retains the
              // full per-result record for diagnostic recovery.
              //
              // Explicit-lane notifies (Lane A MEMORY: / Lane G
              // MEMORY-ABOUT-ME:) below are preserved because the user
              // actively wrote the fence — those are user-attested
              // actions, not autonomous brain lifecycle, and feedback
              // on user actions is a legitimate natural-interaction
              // surface (§4.1).
              //
              // Removed block kept here as a deletion marker so future
              // readers see the explicit ADR justification:
              //   notify(
              //     formatSedimentNotify("auto-write (bg)", auto.results, abrainHome),
              //     "info",
              //   );
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

      // ── Combined checkpoint advance ─────────────────────────────
      const combinedShouldAdvance = laneAShouldAdvance && laneGShouldAdvance;
      if (combinedShouldAdvance) {
        await saveSessionCheckpoint(cwd, sessionId, {
          lastProcessedEntryId: window.lastEntryId,
        });
      }

      // ── Lane A audit row ────────────────────────────────────────
      if (drafts.length > 0 && explicitCorrelationId) {
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

      // ── Lane G audit row ────────────────────────────────────────
      if (aboutMeDrafts.length > 0 && aboutMeCorrelationId) {
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

      // ── Status: combined verdict ─────────────────────────────────
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
  const fullDrafts =
    llmResult.rawText && llmResult.rawText !== "SKIP"
      ? (await import("./extractor")).parseExplicitMemoryBlocks(
          llmResult.rawText,
        )
      : [];
  const schemaPreview = previewExtraction(fullDrafts);
  const compliantDrafts: ProjectEntryDraft[] = fullDrafts.filter(
    (_, i) => schemaPreview.drafts[i]?.validationErrors.length === 0,
  );

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
    if (curated.decision.op === "skip") {
      results.push({
        slug: draft.title,
        path: "",
        status: "skipped",
        reason: curated.decision.reason,
        lane: "auto_write",
        sessionId,
        correlationId,
        candidateId,
      });
      continue;
    }
    if (curated.decision.op === "update") {
      results.push(
        await updateProjectEntry(
          curated.decision.slug,
          {
            ...curated.decision.patch,
            sessionId,
            timelineNote:
              curated.decision.patch.timelineNote ||
              curated.decision.rationale ||
              "updated by sediment curator",
          },
          {
            projectRoot: cwd,
            abrainHome,
            projectId,
            scope: curated.decision.scope,
            settings,
            dryRun: false,
            auditContext,
          },
        ),
      );
      continue;
    }
    if (curated.decision.op === "merge") {
      results.push(
        ...(await mergeProjectEntries(
          curated.decision.target,
          curated.decision.sources,
          {
            compiledTruth: curated.decision.compiledTruth,
            timelineNote: curated.decision.timelineNote,
            reason:
              curated.decision.rationale ||
              curated.decision.timelineNote ||
              "merged by sediment curator",
            sessionId,
          },
          {
            projectRoot: cwd,
            abrainHome,
            projectId,
            scope: curated.decision.scope,
            settings,
            dryRun: false,
            auditContext,
          },
        )),
      );
      continue;
    }
    if (curated.decision.op === "archive") {
      results.push(
        await archiveProjectEntry(curated.decision.slug, {
          projectRoot: cwd,
          abrainHome,
          projectId,
          scope: curated.decision.scope,
          settings,
          dryRun: false,
          reason:
            curated.decision.reason ||
            curated.decision.rationale ||
            "archived by sediment curator",
          sessionId,
          auditContext,
        }),
      );
      continue;
    }
    if (curated.decision.op === "supersede") {
      results.push(
        await supersedeProjectEntry(curated.decision.oldSlug, {
          projectRoot: cwd,
          abrainHome,
          projectId,
          scope: curated.decision.scope,
          settings,
          dryRun: false,
          newSlug: curated.decision.newSlug,
          reason:
            curated.decision.reason ||
            curated.decision.rationale ||
            "superseded by sediment curator",
          sessionId,
          auditContext,
        }),
      );
      continue;
    }
    if (curated.decision.op === "delete") {
      results.push(
        await deleteProjectEntry(curated.decision.slug, {
          projectRoot: cwd,
          abrainHome,
          projectId,
          scope: curated.decision.scope,
          settings,
          dryRun: false,
          mode: curated.decision.mode,
          reason:
            curated.decision.reason ||
            curated.decision.rationale ||
            "deleted by sediment curator",
          sessionId,
          auditContext,
        }),
      );
      continue;
    }

    results.push(
      await writeProjectEntry(
        {
          ...draft,
          ...(curated.decision.op === "create" && curated.decision.derives_from?.length
            ? { derivesFrom: curated.decision.derives_from }
            : {}),
          sessionId,
          timelineNote:
            draft.timelineNote || "captured from LLM auto-write extractor",
        },
        {
          projectRoot: cwd,
          abrainHome,
          projectId,
          scope: curated.decision.op === "create" ? (curated.decision.scope ?? "project") : "project",
          settings,
          dryRun: false,
          auditContext,
        },
      ),
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
  sedimentStatusBySession.clear();
  sessionAgentCycle.clear();
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

/**
 * Test-only hook to await any background auto-write work to settle.
 * Smoke tests that exercise the bg path call this before asserting
 * on audit rows produced asynchronously.
 */
export async function _waitForAutoWriteIdleForTests(): Promise<void> {
  while (autoWriteInFlight.size > 0) {
    await Promise.allSettled([...autoWriteInFlight.values()]);
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
      "Declare an about-me fact: /about-me [--region=identity|skills|habits] [--title=\"...\"] <body>. Injects a MEMORY-ABOUT-ME fence into the transcript; sediment writes to ~/.abrain/<region>/ on the next agent_end (ADR 0021 G2). Empty body opens interactive prompts.",
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
