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
 *     semantics).
 *
 * Failure modes (caller falls through to `ui.select`):
 *   - `ui_unavailable` — `ctx.ui.custom` not registered
 *   - `dialog_error`  — buildDialog threw / ui.custom threw
 *   - `cancelled`     — user pressed Esc / signal abort / outcome=cancel
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
export async function askVaultAuthorizationViaDialog(
  args: AskVaultAuthorizationArgs,
): Promise<AskVaultAuthorizationResult> {
  const { ui, variant, reason, header, question, choices, signal, buildDialog } = args;

  if (typeof ui?.custom !== "function") {
    return { ok: false, reason: "ui_unavailable" };
  }

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

  const handleDone = (result: RawDialogResult | null | undefined): void => {
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

  // Wire signal abort → cancelled.
  if (signal) {
    if (signal.aborted) {
      resolveOuter({ ok: false, reason: "cancelled" });
    } else {
      const onAbort = (): void => resolveOuter({ ok: false, reason: "cancelled" });
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  // Kick off ctx.ui.custom — its return value is NOT awaited; the
  // factory's done() callback feeds handleDone. Treat synchronous
  // throws + async rejections both as dialog_error so the caller can
  // fall back to ui.select.
  try {
    const ret = ui.custom(
      (tui, theme, kb, done) =>
        buildDialog({
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
        }),
        // Vault auth overlay is anchored bottom inline (same as
        // prompt_user main path post-R6). pi handles the layout.
        { overlay: false },
    );
    // If ctx.ui.custom returned a Promise that rejects before done(),
    // surface that as dialog_error rather than hang forever.
    if (ret && typeof (ret as Promise<unknown>).then === "function") {
      (ret as Promise<unknown>).catch((err: unknown) => {
        resolveOuter({
          ok: false,
          reason: "dialog_error",
          detail: (err as Error)?.message ?? String(err),
        });
      });
    }
  } catch (err) {
    return {
      ok: false,
      reason: "dialog_error",
      detail: (err as Error)?.message ?? String(err),
    };
  }

  return outer;
}
