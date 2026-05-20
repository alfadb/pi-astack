/**
 * Internal `askPromptUser` service (ADR 0022 P2).
 *
 * The handler.ts wraps this with the LLM tool surface. Future slash
 * commands (e.g. `/about-me` from ADR 0021 G2) call `askPromptUser`
 * DIRECTLY so they don't have to pretend to be LLMs.
 *
 * Responsibilities:
 *   1. Acquire a pending slot via `manager.acquirePending`.
 *   2. Open the PromptDialog overlay via `ctx.ui.custom(...)` OR fall
 *      back to chained `ctx.ui.select/input` when `ctx.ui.custom` is
 *      unavailable (ADR 0022 §D7, R4 fix: NOT first-line reject).
 *   3. Convert the dialog's raw answer payload into the canonical
 *      `PromptUserResult` shape, applying secret redaction.
 *   4. Write audit rows BEFORE returning (one `prompt_user_ask` row,
 *      one `prompt_user_answer` / `_failed` row per ADR 0022 §D6.3).
 *   5. NEVER throw — translate any unexpected error into
 *      `{ ok:false, reason:"cancelled", detail:"internal error: ..." }`.
 *
 * Note: `redactPromptParams` (the credential pre-pass of §D6.2) is the
 * handler's job and runs BEFORE we get here; service.ts works on
 * already-sanitized params.
 */

import type { PromptUserParams, PromptUserResult } from "./types";
import { acquirePending } from "./manager";
import {
  lengthBucket,
  redactPromptParams,
  redactSecretAnswer,
} from "../redact";

// ── External adapters ───────────────────────────────────────────────

/**
 * Subset of pi's `ctx.ui` that we depend on. Kept minimal so the
 * service is straightforward to mock in smoke fixtures.
 *
 * `custom` is intentionally typed `unknown` here because the precise
 * generic signature lives in the pi-tui types which we don't want to
 * pull in across the test boundary. The PromptDialog adapter typed
 * below narrows that down at the wiring layer.
 */
export interface PromptUserCtx {
  ui: {
    custom?: (
      factory: PromptDialogFactory,
      opts: { overlay: true; overlayOptions?: Record<string, unknown> },
    ) => Promise<RawDialogResult | null>;
    select?: (
      title: string,
      items: string[],
      opts?: { signal?: AbortSignal },
    ) => Promise<string | undefined>;
    input?: (
      prompt: string,
      opts?: { signal?: AbortSignal },
    ) => Promise<string | undefined>;
    // ADR 0022 P1-fix (DEEPSEEK review): chained fallback for
    // type:"multi" walks each option through ui.confirm so the user
    // can include/exclude N items independently. Without confirm in
    // the surface, multi degrades to single-pick which loses semantics.
    confirm?: (
      title: string,
      message: string,
      opts?: { signal?: AbortSignal },
    ) => Promise<boolean>;
    notify?: (message: string, level?: string) => void;
  };
  signal?: AbortSignal;
  hasUI?: boolean;
}

/** What the PromptDialog component passes back via `done(...)`. */
export interface RawDialogResult {
  /** "submit" — user submitted answers; "cancel" — user pressed Esc / Reject. */
  outcome: "submit" | "cancel";
  /** id -> array of selected labels (or single text/secret string). */
  answers: Record<string, string[]>;
  /** Raw secrets in plaintext, keyed by question id. Caller MUST
   * redact these before they cross any I/O boundary. The PromptDialog
   * passes them here so service.ts can compute `lengthBucket` for
   * audit metadata; immediately after that, they are dropped. */
  rawSecrets: Record<string, string>;
}

export type PromptDialogFactory = (
  tui: unknown,
  theme: unknown,
  kb: unknown,
  done: (value: RawDialogResult | null) => void,
) => unknown;

/**
 * Audit sink. Concrete wiring lives in `extensions/abrain/index.ts`
 * where it shares `appendVaultReadAudit` (same VAULT_EVENTS file, just
 * a different `lane`). Service takes it as a callable so smoke can
 * inject a recorder.
 */
export interface PromptAuditSink {
  recordAsk(ev: {
    id: string;
    reason: string;
    questionCount: number;
    types: string[];
    startedAt: string;
  }): void;
  recordResult(ev: {
    id: string;
    outcome: "answered" | "rejected" | "timeout" | "cancelled" | "ui_unavailable";
    durationMs: number;
    /** Per-question metadata. Secrets carry only `lengthBucket`. */
    perQuestion: Array<{
      qid: string;
      type: string;
      // For non-secret: short summary of the chosen label(s).
      // For secret: `[REDACTED_SECRET:<id>]`.
      summary: string;
      lengthBucket?: "1-8" | "9-32" | ">32";
    }>;
  }): void;
}

// ── PromptDialog factory adapter ────────────────────────────────────

/**
 * Type of the lazy importer for the actual TUI component. service.ts
 * does NOT statically `import "./ui/PromptDialog"` because the dialog
 * pulls in `@earendil-works/pi-tui` runtime — fine in pi process,
 * heavy for smoke. Caller passes the factory in via `deps`.
 */
export interface PromptDialogDeps {
  buildDialog: (args: {
    params: PromptUserParams;
    variant: "question" | "vault_release" | "bash_output_release";
    onDone: (result: RawDialogResult | null) => void;
    tui: unknown;
    theme: unknown;
    keybindings: unknown;
    /**
     * ADR 0022 Batch B (f.arch), 2026-05-20: label/value split for
     * vault variants. When provided, OptionList renders
     * `labelFor(opt.label)` as display text while the returned answer
     * is the raw `opt.label` (stable enum). LLM-facing `prompt_user`
     * leaves this undefined — LLM passes the label it wants the user
     * to see, no separate enum exists.
     */
    labelFor?: (rawValue: string) => string;
    /**
     * ADR 0022 Batch B (i), 2026-05-20: split the bottom hint across
     * two text rows so 40-col terminals wrap on a deliberate
     * boundary. Defaults to true for vault variants inside
     * `buildPromptDialog`; callers normally do not need to pass this.
     */
    compactHint?: boolean;
  }) => unknown;
}

// ── Service entry ───────────────────────────────────────────────────

export interface AskPromptUserOptions {
  /** Variant only matters when caller is vault_release / vault-bash;
   * LLM-facing `prompt_user(...)` always passes "question". P3 wires
   * the other two. */
  variant?: "question" | "vault_release" | "bash_output_release";
}

/**
 * Open a PromptDialog overlay and resolve with a canonical
 * `PromptUserResult`. This is the single funnel through which all
 * paused-turn UX flows.
 *
 * Caller invariants:
 *   - `params` must already be schema-validated and credential-redacted.
 *   - `ctx.hasUI` must be true (handler rejects with `ui-unavailable`
 *     otherwise).
 *   - Sub-pi guard must have been checked upstream (handler /
 *     dispatch); this layer trusts its caller.
 */
export async function askPromptUser(
  ctx: PromptUserCtx,
  params: PromptUserParams,
  deps: PromptDialogDeps,
  audit: PromptAuditSink,
  options: AskPromptUserOptions = {},
): Promise<PromptUserResult> {
  const startedAt = Date.now();
  const variant = options.variant ?? "question";
  const timeoutSec = params.timeoutSec ?? 600;

  // ADR 0022 P1-fix (OPUS review): re-run redactPromptParams at the
  // service entry as defense-in-depth. handler.ts already calls it,
  // but service is the canonical entry for future slash commands
  // (ADR 0021 G2 /about-me, P3b vault_release migration). The call
  // is idempotent, so the double pass for LLM-driven callers is a
  // no-op on the second sweep.
  params = redactPromptParams(params);

  const handle = acquirePending({
    timeoutSec,
    upstreamSignal: ctx.signal,
  });

  // ── Audit: prompt_user_ask ──
  audit.recordAsk({
    id: handle.id,
    reason: params.reason,
    questionCount: params.questions.length,
    types: params.questions.map((q) => q.type),
    startedAt: new Date(startedAt).toISOString(),
  });

  // ── Resolve helper that also writes the result audit row ──
  const finalizeWithAudit = (result: PromptUserResult): PromptUserResult => {
    const outcome: "answered" | "rejected" | "timeout" | "cancelled" | "ui_unavailable" =
      result.ok
        ? "answered"
        : result.reason === "timeout"
          ? "timeout"
          : result.reason === "user-rejected"
            ? "rejected"
            : result.reason === "ui-unavailable"
              ? "ui_unavailable"
              : "cancelled";
    const perQuestion = params.questions.map((q) => {
      if (q.type === "secret") {
        // For secret: NEVER record raw. We MAY have a length bucket
        // when we successfully read a raw value before redacting.
        // The detail is supplied via `result.detail` flag set by
        // the dialog→service bridge below.
        // ADR 0022 batch C (2026-05-19): renamed `__secretLengths` to
        // `__secretLengthsInternal` to make 'NOT wire-visible' explicit
        // in the field name itself. Tightens P0d INV-G (secret length
        // disclosure) audit: any future code reviewer sees `Internal`
        // suffix and knows this MUST be stripped before audit/LLM exit.
        const raw = (
          result as { __secretLengthsInternal?: Record<string, string> }
        ).__secretLengthsInternal?.[q.id];
        return {
          qid: q.id,
          type: q.type,
          summary: `[REDACTED_SECRET:${q.id}]`,
          lengthBucket: (raw as "1-8" | "9-32" | ">32" | undefined),
        };
      }
      const a = result.ok ? result.answers[q.id] ?? [] : [];
      const summary = a.length === 0
        ? "(no answer)"
        : a.length === 1
          ? a[0]
          : `[${a.length} selected: ${a.join(", ")}]`;
      return { qid: q.id, type: q.type, summary };
    });
    audit.recordResult({
      id: handle.id,
      outcome,
      durationMs: result.durationMs,
      perQuestion,
    });
    // Strip the internal channel before returning to caller. ADR 0022
    // batch C: renamed `__secretLengths` -> `__secretLengthsInternal`.
    const clean = { ...result } as PromptUserResult & {
      __secretLengthsInternal?: unknown;
    };
    delete clean.__secretLengthsInternal;
    return clean;
  };

  // ── Choose path: ctx.ui.custom (primary) or chained fallback (§D7) ──
  if (typeof ctx.ui.custom === "function") {
    // PRIMARY PATH ──────────────────────────────────────────────────
    // Pump dialog result through the manager promise. We do NOT await
    // ctx.ui.custom directly; instead the factory's `done(...)` callback
    // resolves the manager handle. This means timeout / signal / shutdown
    // all win the race uniformly without needing custom() to be
    // cancellable.
    //
    // R8 (post-T0 OPUS xhigh P1#1, 2026-05-18): capture both the
    // dialog root (for __wipeSecrets) and pi's `done` callback so
    // manager-side terminal resolutions (timeout / signal abort /
    // cancelAllPending) can ACTIVELY tear down both the dialog's
    // secret buffers and pi's editor-region overlay. Without this,
    // MaskedInput.buffer would linger holding plaintext until the
    // user manually pressed Esc/Enter on the now-stale dialog —
    // an INV-C violation window of seconds to minutes.
    let customPromise: Promise<unknown> | null = null;
    let dialogRoot: { __wipeSecrets?: () => void } | null = null;
    let dialogDone: ((v: unknown) => void) | null = null;
    try {
      customPromise = ctx.ui.custom(
        (tui, theme, kb, done) => {
          dialogDone = done;
          const root = deps.buildDialog({
            params,
            variant,
            tui,
            theme,
            keybindings: kb,
            onDone: (result) => {
              try { done(result); } catch { /* second-done from pi runtime */ }
              // Dialog resolved itself — release done ref so the
              // disposer below does not double-fire done(null).
              dialogDone = null;
            },
          }) as { __wipeSecrets?: () => void };
          dialogRoot = root;
          return root as unknown;
        },
        // 2026-05-17 R6 UX fix: inline底部 editor 区域替换
        // (`overlay: false`) 取代屏幕居中弹窗。理由：
        //   1. 业内对齐 — Claude Code AskUserQuestion / Codex
        //      request_user_input / OpenCode question 都是底部 inline;
        //   2. pi 内建 — ctx.ui.select / input / confirm / editor 都走
        //      editorContainer 替换路径,prompt_user 用 overlay 是
        //      ADR 0022 §D7 当时对 ctx.ui.custom 默认行为的误读
        //      (`overlay: false` 才是 pi 默认);
        //   3. UX — overlay 遮挡上方对话流,inline 自然融入消息流;
        //   4. ADR §D7 主路径 5 条理由 (紧凑布局 / chip / variant /
        //      keybindings / countdown) 在 inline 下全部成立 ——
        //      <PromptDialog> 组件代码完全不变,只是宿主容器换了。
        // 三个 variant (question / vault_release / bash_output_release)
        // 一起改为 inline,保持视觉路径一致。
        { overlay: false },
      );
    } catch (err) {
      // ctx.ui.custom can throw synchronously when the editor subsystem
      // is unhealthy — degrade to chained fallback. (Pre-R6 this comment
      // said "overlay subsystem"; the API surface is now inline editor
      // replacement, but the fallback path is unchanged.)
      ctx.ui.notify?.(`prompt_user: inline dialog failed, falling back: ${(err as Error)?.message}`, "warning");
      return finalizeWithAudit(
        await chainedFallback(ctx, params, handle, startedAt),
      );
    }

    // R8 (post-T0 OPUS xhigh P1#1): register a disposer that runs on
    // every terminal resolution. Success path runs it AFTER the
    // PromptDialog already wiped its own state (idempotent re-wipe);
    // timeout / signal / shutdown paths rely on this as the ONLY
    // wipe hook. The disposer is also responsible for tearing down
    // pi's editor region by calling the captured `done(null)`.
    handle.registerDisposer(() => {
      try { dialogRoot?.__wipeSecrets?.(); } catch { /* best-effort */ }
      try { dialogDone?.(null); } catch { /* pi may reject second done */ }
      dialogRoot = null;
      dialogDone = null;
    });

    // Wire custom's promise into manager so async errors don't strand us.
    customPromise.then(
      (rawResult) => {
        // ctx.ui.custom resolves with whatever `done()` was called with,
        // or null if the user dismissed without `done`.
        if (!rawResult) {
          handle.resolve({
            ok: false,
            reason: "user-rejected",
            durationMs: Date.now() - startedAt,
          });
          return;
        }
        const raw = rawResult as RawDialogResult;
        if (raw.outcome === "cancel") {
          handle.resolve({
            ok: false,
            reason: "user-rejected",
            durationMs: Date.now() - startedAt,
          });
          return;
        }
        // Build the canonical answers / redactions structure.
        const redactions: Record<string, { type: "secret"; placeholder: string }> = {};
        const secretLengths: Record<string, "1-8" | "9-32" | ">32"> = {};
        const answers: Record<string, string[]> = {};
        for (const q of params.questions) {
          if (q.type === "secret") {
            const raw0 = raw.rawSecrets[q.id] ?? "";
            const placeholder = redactSecretAnswer(raw0, q.id);
            answers[q.id] = [placeholder];
            redactions[q.id] = { type: "secret", placeholder };
            secretLengths[q.id] = lengthBucket(raw0);
            // No further reference to raw0 in this closure.
          } else {
            answers[q.id] = raw.answers[q.id] ?? [];
          }
        }
        const hasSecret = Object.keys(redactions).length > 0;
        handle.resolve({
          ok: true,
          answers,
          durationMs: Date.now() - startedAt,
          ...(hasSecret ? { redactions } : {}),
          // Stashed for audit metadata; stripped before returning. ADR 0022
          // batch C: explicit `Internal` suffix to make non-wire status
          // self-evident at the call site.
          __secretLengthsInternal: secretLengths,
        } as PromptUserResult & {
          __secretLengthsInternal: Record<string, string>;
        });
      },
      (err) => {
        ctx.ui.notify?.(
          `prompt_user: overlay error: ${(err as Error)?.message}`,
          "warning",
        );
        handle.resolve({
          ok: false,
          reason: "cancelled",
          durationMs: Date.now() - startedAt,
          detail: `overlay error: ${(err as Error)?.message}`.slice(0, 200),
        });
      },
    );

    const result = await handle.promise;
    return finalizeWithAudit(result);
  }

  // FALLBACK PATH ──────────────────────────────────────────────────
  return finalizeWithAudit(
    await chainedFallback(ctx, params, handle, startedAt),
  );
}

/**
 * §D7 chained fallback: when `ctx.ui.custom` is unavailable, drive
 * each question through `ctx.ui.select` (single/multi) or
 * `ctx.ui.input` (text) in sequence. `type:"secret"` cannot fall back
 * — there is no masked input — so we return `ui-unavailable`
 * (also matches INV-A note: secret + custom-unavailable → reject).
 */
async function chainedFallback(
  ctx: PromptUserCtx,
  params: PromptUserParams,
  handle: { id: string; resolve: (r: PromptUserResult) => void; promise: Promise<PromptUserResult>; signal: AbortSignal },
  startedAt: number,
): Promise<PromptUserResult> {
  // If we hit "secret" without ui.custom we cannot proceed safely.
  if (params.questions.some((q) => q.type === "secret")) {
    handle.resolve({
      ok: false,
      reason: "ui-unavailable",
      durationMs: Date.now() - startedAt,
      detail: "type:\"secret\" requires PromptDialog overlay (no masked input in fallback chain)",
    });
    return handle.promise;
  }
  if (typeof ctx.ui.select !== "function" || typeof ctx.ui.input !== "function") {
    handle.resolve({
      ok: false,
      reason: "ui-unavailable",
      durationMs: Date.now() - startedAt,
      detail: "ctx.ui.custom unavailable AND ctx.ui.select/input missing",
    });
    return handle.promise;
  }

  // Run questions sequentially; cancellation tears the chain down via
  // handle.signal.
  const answers: Record<string, string[]> = {};
  for (const q of params.questions) {
    if (handle.signal.aborted) {
      // Manager already resolved with timeout/cancelled; nothing more
      // to do. Return promise so caller sees the manager's verdict.
      return handle.promise;
    }
    if (q.type === "single") {
      const labels = (q.options ?? []).map((o) => o.label);
      // Always append "Other (specify)" — INV: LLM cannot disable Other
      const otherSentinel = "Other (specify)";
      const items = [...labels, otherSentinel];
      const pick = await ctx.ui.select(`${q.header}: ${q.question}`, items, {
        signal: handle.signal,
      });
      if (pick === undefined) {
        handle.resolve({
          ok: false,
          reason: "user-rejected",
          durationMs: Date.now() - startedAt,
        });
        return handle.promise;
      }
      let final = pick;
      if (pick === otherSentinel) {
        const free = await ctx.ui.input("Enter your answer:", {
          signal: handle.signal,
        });
        if (!free) {
          handle.resolve({
            ok: false,
            reason: "user-rejected",
            durationMs: Date.now() - startedAt,
          });
          return handle.promise;
        }
        final = free;
      }
      answers[q.id] = [final];
    } else if (q.type === "multi") {
      // ADR 0022 P1-fix (DEEPSEEK review): real multi-select via
      // sequential ui.confirm per option. Without this, multi was
      // degrading to single-pick by sharing the single branch above,
      // losing the LLM-visible semantics that multi answers can be
      // length 0..N. If ui.confirm is unavailable, fall back to
      // ui-unavailable rather than silently degrading.
      if (typeof ctx.ui.confirm !== "function") {
        handle.resolve({
          ok: false,
          reason: "ui-unavailable",
          durationMs: Date.now() - startedAt,
          detail:
            'type:"multi" fallback requires ctx.ui.confirm; surface unavailable',
        });
        return handle.promise;
      }
      const picks: string[] = [];
      for (const opt of q.options ?? []) {
        if (handle.signal.aborted) return handle.promise;
        const include = await ctx.ui.confirm(
          `${q.header}: ${q.question}`,
          `Include: ${opt.label}?`,
          { signal: handle.signal },
        );
        if (include === undefined) {
          // confirm cancelled — treat as user-rejected for the whole prompt
          handle.resolve({
            ok: false,
            reason: "user-rejected",
            durationMs: Date.now() - startedAt,
          });
          return handle.promise;
        }
        if (include) picks.push(opt.label);
      }
      // "Other (specify)" as a trailing yes/no with free-text follow-up.
      const wantOther = await ctx.ui.confirm(
        `${q.header}: ${q.question}`,
        "Add a custom answer (Other)?",
        { signal: handle.signal },
      );
      if (wantOther) {
        const free = await ctx.ui.input("Enter your custom answer:", {
          signal: handle.signal,
        });
        if (free) picks.push(free);
      }
      // Empty multi answer is legal (length 0). The LLM gets an empty
      // array; INV-H still holds (still an array).
      answers[q.id] = picks;
    } else {
      // text
      const ans = await ctx.ui.input(`${q.header}: ${q.question}`, {
        signal: handle.signal,
      });
      if (ans === undefined) {
        handle.resolve({
          ok: false,
          reason: "user-rejected",
          durationMs: Date.now() - startedAt,
        });
        return handle.promise;
      }
      answers[q.id] = [ans];
    }
  }
  handle.resolve({
    ok: true,
    answers,
    durationMs: Date.now() - startedAt,
    detail: "answered via fallback chain (ctx.ui.custom unavailable)",
  });
  return handle.promise;
}
