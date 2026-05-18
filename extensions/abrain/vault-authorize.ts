/**
 * abrain — vault authorization helper (ADR 0022 P3b).
 *
 * Bridges `authorizeVaultRelease` / `authorizeVaultBashOutput` in
 * `index.ts` to the `<PromptDialog>` overlay substrate (variant
 * "vault_release" / "bash_output_release"). Returns the raw chosen
 * label string from `VAULT_RELEASE_AUTH_CHOICES` /
 * `VAULT_BASH_OUTPUT_AUTH_CHOICES`; caller maps choice → grant state.
 *
 * Edges (INV-D / INV-E):
 *   - DOES NOT touch `releaseSessionGrants` / `releaseRememberDenies` /
 *     `bashOutputSessionGrants` — grant state stays in `index.ts`
 *     closures (INV-E: PromptDialog holds no abrain SoT state).
 *   - DOES NOT write any audit row — caller in `index.ts` writes
 *     `lane:"vault_release"` / `lane:"bash_output"` audit (INV-D
 *     boundary: vault audit lane MUST NOT become `prompt_user`).
 *   - DOES NOT go through `service.askPromptUser` — that path's
 *     concurrent gate (INV-I) belongs to LLM-facing prompt_user; a
 *     user who has an open prompt_user must still be able to
 *     authorize a vault release (different substrate, different
 *     semantics). BUT vault has its OWN concurrent gate (see below).
 *
 * Failure modes (caller falls through to `ui.select`):
 *   - `ui_unavailable` — `ctx.ui.custom` not registered
 *   - `dialog_error`  — buildDialog threw / ui.custom threw /
 *                       choices.length < 2 / concurrent gate held
 *   - `cancelled`     — user pressed Esc / signal abort / outcome=cancel
 *
 * P3b post-ship audit fixes (commit follows 8abb48b):
 *   #1 Pre-aborted signal returns immediately, never opens dialog
 *      (OPUS P1: stale overlay if abort fires before entry).
 *   #2 Mid-dialog abort actively tears the overlay down via captured
 *      `done(null)` (OPUS P1: dialog visible after caller settled).
 *   #3 Vault-side concurrent gate at module scope. pi runs sibling
 *      tool calls in parallel (extensions.md §680); two `vault_release`
 *      calls in one assistant message would otherwise open two
 *      overlapping dialogs and cross-grant when the user picks 'Session'
 *      (OPUS P1: vault has no concurrent gate). Vault gate is
 *      independent from prompt_user INV-I — a vault dialog can be open
 *      alongside an open prompt_user dialog (different substrate).
 *   #4 Shape invariant on `choices`: must be array, length ≥ 2.
 *      (GPT-5.5 P1: buggy caller with empty/single choices renders
 *      a vault UI with no escape).
 *   #5 Narrow type check on `signal.addEventListener` to tolerate
 *      fake AbortSignals (e.g. `{}` from test fixtures or future pi
 *      runtimes) without throwing TypeError into the tool executor
 *      (OPUS P2 upgraded to P1 — safety boundary).
 */

import type { PromptUserParams } from "./prompt-user/types";
import type { PromptDialogDeps, RawDialogResult } from "./prompt-user/service";

// ── Public contract ─────────────────────────────────────────────────

export interface VaultAuthUi {
  custom?: (
    factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => unknown,
    options?: Record<string, unknown>,
  ) => Promise<unknown> | unknown;
  notify?: (msg: string, level?: string) => void;
}

export interface AskVaultAuthorizationArgs {
  ui: VaultAuthUi | undefined;
  variant: "vault_release" | "bash_output_release";
  /** Multi-line reason rendered as muted block at top of overlay. */
  reason: string;
  /** Bold chip header (short). */
  header: string;
  /** The actual question shown beneath header. */
  question: string;
  /** Ordered choice labels — first is the deny default for fail-closed TUI auto-pick. */
  choices: readonly string[];
  /** AbortSignal — when aborted, dialog resolves with `cancelled`. */
  signal?: AbortSignal;
  /** PromptDialog factory injected by activate() in index.ts. */
  buildDialog: PromptDialogDeps["buildDialog"];
}

export type AskVaultAuthorizationResult =
  | { ok: true; choice: string }
  | { ok: false; reason: "cancelled" | "ui_unavailable" | "dialog_error"; detail?: string };

/**
 * Open a PromptDialog overlay (variant=vault_release|bash_output_release)
 * with the supplied 3/4-choice select question. Resolves with the chosen
 * label string on submit, or `{ok:false, reason}` on cancel / error.
 *
 * Does NOT await `ctx.ui.custom` directly — pump the dialog result
 * through the factory's `done(...)` callback; race that against
 * `signal.abort` so cancel paths win uniformly.
 */
// Module-level vault dialog lock (#3 above). One vault dialog at a time;
// concurrent attempts return `dialog_error` so the caller can either fall
// through to ui.select OR surface the contention to the LLM. We do NOT
// queue: queueing would let the LLM open dialogs faster than the user
// answers them, creating a backlog the user can't escape.
let __vaultDialogInFlight = false;

/** Test-only: reset the module-level vault dialog lock. */
export function __resetVaultDialogLockForTests(): void {
  __vaultDialogInFlight = false;
}

/** Test-only: introspect the lock for serial-call smoke. */
export function __peekVaultDialogLockForTests(): boolean {
  return __vaultDialogInFlight;
}

export async function askVaultAuthorizationViaDialog(
  args: AskVaultAuthorizationArgs,
): Promise<AskVaultAuthorizationResult> {
  const { ui, signal, choices } = args;

  // ── Fast-rejects (no side effects, no lock acquisition) ─────────
  // Ordering matters: each early-return must happen BEFORE allocating
  // the dialog state machine.

  // #5 ui.custom missing
  if (typeof ui?.custom !== "function") {
    return { ok: false, reason: "ui_unavailable" };
  }

  // #4 Shape invariant: callers in index.ts pass stable 3/4-choice
  // arrays from vault-bash.ts / index.ts. A buggy or hostile caller
  // with empty/single choices would render a vault UI with no
  // escape — fail closed.
  if (!Array.isArray(choices) || choices.length < 2) {
    return {
      ok: false,
      reason: "dialog_error",
      detail: `vault dialog requires >= 2 choices, got ${
        Array.isArray(choices) ? choices.length : typeof choices
      }`,
    };
  }

  // #1 Pre-aborted signal: return immediately, never open the overlay.
  // The old behavior (resolveOuter after the lock + still calling
  // ui.custom) made a stale dialog flash on screen after the caller
  // had already settled.
  if (signal && (signal as AbortSignal).aborted === true) {
    return { ok: false, reason: "cancelled" };
  }

  // #3 Concurrent gate: vault has its own pending lock, independent
  // of prompt_user's INV-I (which is enforced in manager.ts and
  // belongs to the LLM-facing prompt_user surface, not vault).
  if (__vaultDialogInFlight) {
    return {
      ok: false,
      reason: "dialog_error",
      detail:
        "another vault authorization dialog is already pending — " +
        "wait for the user to answer the first one",
    };
  }
  __vaultDialogInFlight = true;

  try {
    return await __runVaultDialog(args);
  } finally {
    __vaultDialogInFlight = false;
  }
}

async function __runVaultDialog(
  args: AskVaultAuthorizationArgs,
): Promise<AskVaultAuthorizationResult> {
  const { ui, variant, reason, header, question, choices, signal, buildDialog } = args;

  // Internal PromptUserParams: vault decisions are always one single-question
  // with N options. The schema validator is NOT invoked (we bypass
  // service.askPromptUser) — vault caller controls the structure directly,
  // so INV-G (no vault tokens) doesn't apply.
  const params: PromptUserParams = {
    reason,
    questions: [
      {
        id: "_vault_decision",
        header,
        question,
        type: "single",
        options: choices.map((label) => ({ label })),
      },
    ],
  };

  // Single resolution gate — first source to fire wins.
  let resolveOuter!: (v: AskVaultAuthorizationResult) => void;
  let resolved = false;
  const outer = new Promise<AskVaultAuthorizationResult>((res) => {
    resolveOuter = (v) => {
      if (resolved) return;
      resolved = true;
      res(v);
    };
  });

  // #2 Captured dialog `done` ref. Mid-dialog abort actively calls
  // dialogDone(null) so pi tears the overlay down instead of leaving
  // the orange-framed authorization box stranded on screen after
  // the caller has already received `cancelled`.
  let dialogDone: ((v: unknown) => void) | null = null;
  let teardownCalls = 0;
  const teardownDialog = (): void => {
    if (dialogDone) {
      teardownCalls += 1;
      try { dialogDone(null); } catch { /* second-done from pi runtime */ }
      dialogDone = null;
    }
  };

  const handleDone = (result: RawDialogResult | null | undefined): void => {
    // Clear the captured done ref — the dialog has resolved itself.
    dialogDone = null;
    if (!result || result.outcome === "cancel") {
      resolveOuter({ ok: false, reason: "cancelled" });
      return;
    }
    const ans = result.answers?.["_vault_decision"];
    if (!Array.isArray(ans) || ans.length === 0) {
      resolveOuter({ ok: false, reason: "cancelled" });
      return;
    }
    // Validate against the supplied choices — guard against a synthetic
    // dialog returning an unknown string (defense in depth; should not
    // happen in production since OptionList only emits item.value).
    const choice = String(ans[0]);
    if (!choices.includes(choice)) {
      resolveOuter({ ok: false, reason: "cancelled" });
      return;
    }
    resolveOuter({ ok: true, choice });
  };

  // #5 Narrow type check: only wire abort listener if signal has the
  // AbortSignal shape. Bare `{}` or polyfills without
  // EventTarget methods used to crash with
  // `TypeError: signal.addEventListener is not a function`.
  if (signal && typeof (signal as AbortSignal).addEventListener === "function") {
    const onAbort = (): void => {
      teardownDialog();
      resolveOuter({ ok: false, reason: "cancelled" });
    };
    (signal as AbortSignal).addEventListener("abort", onAbort, { once: true });
  }

  // Expose teardown counter for smoke. NOT a public contract — attached
  // to the outer Promise so the helper signature stays clean.
  (outer as Promise<AskVaultAuthorizationResult> & { __teardownCalls?: () => number })
    .__teardownCalls = () => teardownCalls;

  // Kick off ctx.ui.custom — its return value is NOT awaited; the
  // factory's done() callback feeds handleDone. Treat synchronous
  // throws + async rejections both as dialog_error so the caller can
  // fall back to ui.select.
  try {
    const ret = ui!.custom!(
      (tui, theme, kb, done) => {
        dialogDone = done; // #2 capture for mid-dialog abort
        return buildDialog({
          params,
          variant,
          tui,
          theme,
          keybindings: kb,
          onDone: (result) => {
            try {
              done(result);
            } catch {
              /* pi runtime may reject second done — ignore */
            }
            handleDone(result);
          },
        });
      },
        // Vault auth overlay is anchored bottom inline (same as
        // prompt_user main path post-R6). pi handles the layout.
        { overlay: false },
    );
    // If ctx.ui.custom returned a Promise that rejects before done(),
    // surface that as dialog_error rather than hang forever.
    if (ret && typeof (ret as Promise<unknown>).then === "function") {
      (ret as Promise<unknown>).catch((err: unknown) => {
        dialogDone = null;
        resolveOuter({
          ok: false,
          reason: "dialog_error",
          detail: (err as Error)?.message ?? String(err),
        });
      });
    }
  } catch (err) {
    dialogDone = null;
    return {
      ok: false,
      reason: "dialog_error",
      detail: (err as Error)?.message ?? String(err),
    };
  }

  return outer;
}
