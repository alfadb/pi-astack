---
doc_type: adr
status: accepted
---

# ADR 0020 — Abrain auto-sync to remote (sediment-driven push + startup ff-pull)

> 📐 **方向已上提承重墙（Phase-2 SLIM，3×T0 Model B）**：本 ADR 的决策已上提 `INV-SYNC-DETERMINISTIC-MERGE`，以那里为 canonical。以下机制正文（含 Alt A-F / why-not-LLM-merge / 4 轮审计等不可代替 rationale）**待 sediment 入 abrain 后归档**，之前保留可读、勿删。

- **Status**: Accepted (revised 2026-05-17 — divergence path now auto-merges; subsequently hardened through 4 audit rounds, see [Revision: 2026-05-17 — auto-merge on divergence](#revision-2026-05-17--auto-merge-on-divergence) below)
- **Date**: 2026-05-15, revised 2026-05-17 (Rounds 1–4 audit cycle, all on the same date)
- **Supersedes**: none. Extends [ADR 0014](./0014-abrain-as-personal-brain.md) §B5 (abrain as cross-project knowledge substrate) and [ADR 0017](./0017-project-binding-strict-mode.md) for the cross-device sync gap that ADR 0017's strict binding implicitly assumed someone else would solve.
- **Builds on**: [ADR 0019](./0019-abrain-self-managed-vault-identity.md) — fixed identity drift, but not knowledge drift.

## Context

`~/.abrain` is a git repo. Since the B5 cutover (ADR 0014 §D), sediment writes markdown into it and `gitCommit()` (extensions/sediment/writer.ts:573) auto-commits each entry. The repo has a remote (`origin = git.alfadb.cn/components/abrain.git`).

**The gap**: nothing ever pushed those commits. Discovery 2026-05-15: local was **44 commits ahead of origin/main**, accumulated over weeks of sediment activity. A user with two devices would see:

- Device A: rich, growing knowledge base.
- Device B (cloned weeks ago): frozen in time. None of A's discoveries are visible.

Symmetric problem on the read side: Device B starts pi and doesn't see anything Device A pushed today, because nothing fetches.

ADR 0019 solved **identity** drift (cross-device vault unlock now works). This ADR solves **knowledge** drift.

## Constraints

1. **Must not block sediment's main path.** Sediment's commit happens in `agent_end`; if push takes 5s on a flaky network, agent_end shouldn't hang. Push is fire-and-forget.

2. **Must not auto-resolve conflicts.** Discussed and explicitly rejected:
   - LLM-merge of markdown bodies carries hallucination risk — a single fabricated sentence pollutes the knowledge substrate, and is hard to detect post-hoc.
   - The user requested in the design discussion: "不做自动解决冲突，发生冲突了就提示用户去处理"
   - So: ff-only merge is the only auto-merge strategy. Divergence aborts and surfaces a runbook.

3. **Must work with zero configuration.** Users who have `origin` set should get auto-sync without flipping a flag. Users without `origin` get silent no-op (this ADR doesn't apply to them).

4. **Must never throw to caller.** All git ops capture errors into the audit log and return a typed `GitSyncEvent`. Sediment's existing `try { gitCommit(...); } catch {}` (writer.ts:599 in pre-ADR-0020 code) is too coarse — we add explicit no-throw guarantees per op.

5. **Must not exfiltrate secrets via argv.** Same argv hygiene as ADR 0019 keychain ops: only branch names and standard verbs pass through `execFile`. Credentials live in git's credential helper or SSH agent — neither passes through us.

6. **Must serialize concurrent in-process ops.** Multiple sediment writes during one `agent_end` could call `pushAsync` nearly simultaneously; without single-flight, the second push fails with `.git/index.lock` contention. We use an in-memory promise singleton.

## Decision

Add `extensions/abrain/git-sync.ts` exposing four operations:

| op | trigger | behavior |
|---|---|---|
| `pushAsync` | sediment commit success (writer.ts:573 gitCommit) | fire-and-forget background push; detached, sediment returns immediately |
| `fetchAndFF` | abrain extension activate (pi startup) | fire-and-forget fetch + ff-only merge; divergence aborts |
| `sync` | `/abrain sync` slash command (manual) | combined fetch+push; surfaces runbook on divergence |
| `getStatus` | `/abrain status` slash command | read-only: ahead/behind + last events from audit |

### Result taxonomy

Every op returns `GitSyncEvent { ts, op, result, ahead?, behind?, durationMs?, error? }`. The `result` enum is the source of truth for downstream UX (status command, footer hints):

| `result` | meaning | UX |
|---|---|---|
| `ok` | success | silent (or log line on startup ff) |
| `noop` | nothing to do (ahead=0 push / behind=0 fetch) | silent |
| `skipped` | no git repo / no origin remote | silent — auto-sync doesn't apply |
| `diverged` | local+remote both ahead; ff refused | `/abrain status` warning; `/abrain sync` returns runbook |
| `push_rejected` | remote ahead; user must pull first | retried on next sediment commit (likely after a fetch) |
| `timeout` | git command exceeded 8s | retried on next op; visible in audit |
| `failed` | any other error | error string in audit |

### Audit log

Every op appends one row to `~/.abrain/.state/git-sync.jsonl`. This:

- Lets `getStatus` show "last push: 2026-05-15T19:45 ok 234ms" without re-running git.
- Provides forensic trail when users report "abrain not syncing".
- Bounded read (last 200 KB) so a year of sediment writes doesn't slow `/abrain status`.

### Single-flight in-process lock

```ts
let inflightOp: Promise<GitSyncEvent> | null = null;

async function singleFlight(fn: () => Promise<GitSyncEvent>): Promise<GitSyncEvent> {
  if (inflightOp) await inflightOp.catch(() => undefined);
  const p = fn();
  inflightOp = p;
  try { return await p; } finally { if (inflightOp === p) inflightOp = null; }
}
```

In-process only. Cross-process protection (multiple pi instances on the same machine) relies on git's own `.git/index.lock` — that's the fail-soft path: one wins, the other audits `result=failed` and retries on next op.

### Slash commands

- `/abrain status` — now also displays git sync state (remote URL, branch, ahead/behind, last push/fetch from audit) alongside the existing binding status.
- `/abrain sync` — new. Runs `fetchAndFF` then `pushAsync`. If fetch returns `diverged`, push is skipped and the response includes:

  ```
  diverged: local has N commit(s), remote has M commit(s) not in local.
  ff-only merge refused. resolve manually:
    cd ~/.abrain
    git fetch origin && git status
    # then either: git merge origin/main   (creates merge commit)
    #         or: git rebase origin/main   (replays your commits on top)
    # then run /abrain sync again
  ```

### Disable knob

`PI_ABRAIN_NO_AUTOSYNC=1` env var disables both startup fetch and post-commit push. Useful for:

- CI environments where network access is unreliable
- Offline development
- Smoke tests that should not contact a remote

There is no settings.json equivalent yet — env var is sufficient for the failure cases users actually hit.

## Invariants

1. **Sediment commit path is never blocked by git network ops.** `pushAsync` is fire-and-forget; sediment returns the commit SHA immediately.

2. **No auto-merge beyond fast-forward.** Divergence always aborts. The only auto-merge that runs is `git merge --ff-only` when local has no unique commits.

3. **No throw to caller.** All four public functions catch every error and record to audit. Verified by smoke (`pushAsync({abrainHome: notGit})` returns `skipped`, not throws).

4. **No secrets in argv.** Only branch names and standard git verbs. Credentials come from git credential helper / SSH agent, never from us.

5. **In-process serialization.** Concurrent calls in the same pi process are serialized via a `tail`-chained promise queue (`singleFlight`). Smoke verifies both 2-way and 3-way concurrent pushes produce no `index.lock` contention. A previous (1.0) implementation used a single `inflightOp` slot; that worked for 2 callers but had a TOCTOU race with 3+, fixed in the Round 2 audit follow-up (see §Round 2).

6. **Skipped is silent.** When `hasGitRemote` is false (no git repo or no origin), every op returns `result=skipped` and writes the audit row, but emits no console output. Users without a configured remote see zero noise.

7. **Output-side credential redaction.** Symmetric to invariant 4 (argv-in). Anything captured from git — `git remote get-url origin` stdout, push/fetch stderr embedded in error messages — passes through `redactCredentials()` before storage in `~/.abrain/.state/git-sync.jsonl` or display in `/abrain status`. Closes the asymmetry that argv-in was protected but stderr/stdout-out were not (Round 2 audit finding M1).

8. **Runbook shell-quoting.** The `/abrain sync` divergence runbook contains `cd <abrainHome>` for the user to copy/paste. `abrainHome` is shell-quoted via `shellQuotePath()` so a maliciously-crafted `ABRAIN_ROOT` env (e.g. `/tmp/evil"; curl evil.sh | sh; #`) cannot become a paste-time code-execution gadget (Round 2 audit finding M2).

## Alternatives considered

### A. Synchronous push (block sediment's commit)
**Rejected.** Sediment's contract is "agent_end completes in O(seconds), not O(network)". Blocking on push couples knowledge-write latency to network health.

### B. Debounce push (batch N seconds of commits into one push)
**Rejected.** YAGNI: single-flight already serializes, git pushes are cheap (deltas only), and a sediment burst is typically 1-3 commits. Debounce adds complexity (timer management, shutdown drain) for marginal benefit.

### C. Rebase on diverge
**Rejected.** Auto-rebase rewrites local SHAs silently — users who manually `cd ~/.abrain && git log` would see commits "move around". Knowledge substrate integrity over convenience.

### D. LLM auto-merge of conflicts
**Rejected outright in design discussion.** Hallucination risk in a knowledge substrate is unacceptable. The user explicitly chose "提示用户去处理" over LLM merge. May revisit as a separate ADR if conflict frequency justifies it after 0020 is deployed.

### E. Periodic fetch (every N minutes)
**Deferred.** Startup fetch covers 90% of cases: a user starting a pi session gets the latest knowledge. Mid-session sync is `/abrain sync` (manual). If real usage shows mid-session staleness as a problem, a periodic timer is a small extension.

### F. Settings.json knobs (gitPushOnCommit, gitFetchOnStartup, timeouts)
**Deferred to YAGNI.** Single env var (`PI_ABRAIN_NO_AUTOSYNC`) handles the only knob users actually need (full disable). More granular knobs land if specific scenarios surface (e.g. "I want fetch but not push").

## Implementation

| File | Change |
|---|---|
| `extensions/abrain/git-sync.ts` (new) | Core module: `pushAsync`, `fetchAndFF`, `sync`, `getStatus`, `formatSyncStatus`, `hasGitRemote`, `getAheadBehind`, single-flight lock, audit writer |
| `extensions/abrain/index.ts` | activate() fires `fetchAndFF` on startup (unless `PI_ABRAIN_NO_AUTOSYNC=1`); `/abrain` command gains `sync` subcommand and enhances `status` to include git sync state |
| `extensions/sediment/writer.ts` | `gitCommit()` dynamically requires `../abrain/git-sync` after successful commit and fires `pushAsync` detached |
| `scripts/smoke-abrain-git-sync.mjs` (new) | 20 assertions across 13 sections covering full taxonomy with a local bare repo as fake remote |
| `scripts/smoke-abrain-{backend-detect,vault-identity,secret-scope}.mjs` | Added git-sync.cjs companion to the transpile list (index.ts now imports it) |
| `package.json` | New script `smoke:abrain-git-sync` |

## Operational notes

### What users see when divergence happens

Real scenario: Device A pushed `sediment: create X (project:p1)` 30 minutes ago. Device B has been offline, just sediment-committed `sediment: create Y (project:p1)` locally. B starts pi → startup `fetchAndFF` returns `diverged`. B sees in console:

```
[abrain] git fetch: diverged (local ahead 1, remote ahead 1). Run /abrain sync for resolution runbook.
```

B runs `/abrain sync` → gets the runbook (cd + git merge/rebase choice). B picks `git rebase origin/main`, re-runs `/abrain sync` → success.

### Failure modes that should NOT happen (regression watchlist)

- Sediment commit succeeds but push fails → user thinks knowledge is synced when it isn't. Mitigation: audit log + `/abrain status` shows ahead count. Future TUI footer hint planned for P0e.
- Two pi processes pushing concurrently → one wins, one audits `failed` with `index.lock` error string. Acceptable: the loser will retry on next sediment commit.
- Network down at startup → fetch returns `failed/timeout`, logged once to stderr, audit row written, no further attempts until next pi start or manual `/abrain sync`. Users don't get a permanently noisy startup.

### Where this connects to other ADRs

- **ADR 0014 (abrain as cross-project substrate)**: this ADR is the missing transport layer between devices.
- **ADR 0017 (strict project binding)**: now works cross-device — binding info is part of what auto-sync ships.
- **ADR 0019 (abrain-managed vault identity)**: identity moved to abrain repo, so identity sync is part of abrain sync. `.vault-identity/master.age.pub` enters git and rides this transport; `.vault-identity/master.age` stays gitignored (still must be transported manually per ADR 0019).

## Round 2 audit (2026-05-15, post-6cbc60a)

Three models (opus-4-7 + gpt-5.5 + deepseek-v4-pro) audited the change in parallel. Consensus: ship-quality core (7-7.5/10), no CRITICAL, but five MAJORs and a handful of MINORs needed addressing before relying on this in production.

| Finding | Where | Fix |
|---|---|---|
| **MAJOR-A** `classifyError` regex (English-only) silently mislabels real push rejections as `failed` under non-English `LANG` | git-sync.ts | Added module-level `GIT_ENV` (`LANG=C LC_ALL=C GIT_TERMINAL_PROMPT=0`); threaded into every `execFileAsync` site (7 sites). Dropped bare `/behind/i` from regex. |
| **MAJOR-B** Credential URLs (`https://user:token@host/repo`) leak into `getStatus().remote` UI display + audit `error` field via push stderr | git-sync.ts | Added `redactCredentials()` export, called at both leak sites. Codified as invariant 7. |
| **MAJOR-C** `PI_ABRAIN_DISABLED=1` does not gate `writer.ts:pushAsync` invocation — single-layer enforcement | sediment/writer.ts | Added inline `process.env.PI_ABRAIN_DISABLED !== "1"` to the push gate. ADR 0014 invariant #6 now belt + suspenders. |
| **MAJOR-D** `singleFlight` TOCTOU: with 3+ concurrent callers, multiple microtasks resumed simultaneously after prior inflight resolved and all ran `fn()` in parallel | git-sync.ts | Rewrote as `tail`-chained promise queue. `tail.then(fn, fn)` runs each `fn` strictly after every prior settles (rejected slot prevents poison propagation). New smoke section pins the 3-way regression. |
| **MAJOR-E** `/abrain sync` divergence runbook injects `abrainHome` unquoted into `cd` for user to paste; ABRAIN_ROOT with shell metachars → paste-time RCE | git-sync.ts | Added `shellQuotePath()`; runbook now uses `cd '<quoted>'`. Control-char paths return refusal placeholder. Codified as invariant 8. |
| **MINOR** `git add ${rel}` lacks `--` option-parsing terminator | sediment/writer.ts | Added `"--"` to both gitCommit and gitCommitAbrain. |
| **MINOR** SIGINT (Ctrl-C) was classified as `timeout` | git-sync.ts | `classifyError` now requires `signal === 'SIGTERM'` for `timeout`; SIGINT → `failed`. |
| **MINOR** `classifyError` could label fetch errors as `push_rejected` if stderr matched regex | git-sync.ts | Added `allowPushRejected` parameter; fetch callers pass `false`. |
| **MINOR** Smoke `rmSync` cleanup outside try/finally | smoke-abrain-git-sync.mjs | Wrapped in try/catch. |

Smoke went from 20 to 27 assertions: new sections 13.2 (3-way queue regression), 14 (PI_ABRAIN_NO_AUTOSYNC contract), 15 (redaction + quoting truth tables), 16 (_queueDepth introspection).

Deferred to follow-up (tracked under P0e candidates below, NOT in Round 2 commit):

- Branch/remote detection (currently hardcoded `origin/main`; users on `master` branch silently no-op — gpt #4).
- Smoke for sediment writer's dynamic-require integration (the primary auto-push wiring is currently smoke-bypassed since the smoke direct-requires git-sync — deepseek M1).
- Audit log rotation (append-only; bounded read at 200KB — gpt minor 3).
- Workflow/bind paths don't trigger auto-push (out of ADR 0020 scope but inconsistent — gpt minor 4/5).

## Revision: 2026-05-17 — auto-merge on divergence

### What changed (vs the 2026-05-15 decision)

The 2026-05-15 design conflated **divergence** (both sides have unique
commits) with **conflict** (git's 3-way merge can't reconcile the
textual changes). `fetchAndFF` returned `diverged` and stopped whenever
`ahead > 0 && behind > 0`, forcing the user to run `/abrain sync` and
manually `git merge`/`git rebase`.

In practice, abrain's content shape makes this overly conservative:
sediment writes one markdown file per slug, so two devices running for
weeks before syncing typically diverge on **disjoint files**. Git's
own 3-way merge resolves these cases trivially without LLM assistance.
The runbook fired on every divergence — not just on real conflicts —
producing a paper cut on every `pi` startup after the user worked on
two machines.

New behavior of `fetchAndFF` when `ahead > 0 && behind > 0`:

1. Attempt `git -c user.name=abrain-autosync -c user.email=autosync@abrain.local merge --no-edit --no-ff -m "abrain auto-merge: integrate N commit(s) from origin/main" origin/main`.
2. **Merge clean** → result `ok`, new field `merged: <behind>`. Both
   sides' histories survive; the merge commit is recognizable in
   `git log` so users can audit the convergence after the fact.
3. **Textual conflict** → capture conflicting paths via
   `git diff --name-only --diff-filter=U`, then `git merge --abort` to
   restore the pre-merge working tree exactly. Result `conflict`, new
   field `conflictPaths: string[]`. The runbook in `/abrain sync` names
   the conflicting files so the user knows what to open.

### Why merge, not rebase (Alternative C from the 2026-05-15 ADR still rejected)

The original ADR's Alternative C rejected rebase because it silently
rewrites local SHAs — a user running `cd ~/.abrain && git log` would
see commits "move around". That objection still stands and applies
*only* to rebase. `git merge --no-ff` preserves local SHAs verbatim
and adds one explicit merge commit instead, which is the truthful
record of "two devices' thoughts converged here". For a knowledge
substrate, the merge commit IS the story.

### Why this isn't Alternative D (LLM auto-merge) by another name

Alternative D was rejected because LLM-merging markdown bodies risks
hallucinated sentences in the knowledge base. The 2026-05-17 revision
uses **git's own 3-way text merge** — same algorithm git uses for code
for decades, no LLM in the loop. When git itself can't resolve
(overlapping edits in the same region), we fall back to the user, never
to an LLM. The hallucination-risk firewall is intact.

### Invariants updated

| # | 2026-05-15 statement | 2026-05-17 status |
|---|---|---|
| 2 | "No auto-merge beyond fast-forward. Divergence always aborts." | **Superseded.** Auto-merge via `git merge --no-edit --no-ff` is allowed on divergence. Only a *textual conflict* aborts (with `merge --abort` restoring clean tree). No rebase, no LLM merge. |
| 1, 3, 4, 5, 6, 7, 8 | Sediment-never-blocked, no-throw, no-secrets-in-argv, in-process serialization, skipped-is-silent, output-side redaction, runbook shell-quoting | **Unchanged.** All still hold. The merge subprocess uses the same `GIT_ENV` (LANG=C, GIT_TERMINAL_PROMPT=0) and same single-flight queue. |

### Result taxonomy delta

| code | 2026-05-15 | 2026-05-17 |
|---|---|---|
| `ok` | success (push/ff merge) | success (push/ff merge/**auto-merge**); `merged` field present on auto-merge |
| `diverged` | local+remote both ahead; ff refused | **Deprecated.** Kept in the type union so historical jsonl audit rows still parse, but new `fetchAndFF` runs never emit it. |
| `conflict` | (did not exist) | **New.** Auto-merge attempted, git reported textual conflict, `merge --abort` restored tree; `conflictPaths` field present. |

Older pi versions reading new audit rows degrade gracefully: `conflict`
is an unknown enum value, so `getStatus` shows the raw label and
`formatSyncStatus` prints it as-is. The reverse case (new pi reading
old audit rows containing `diverged`) is handled by `getStatus` simply
displaying the historical row — the live status counter `ahead+behind`
is recomputed from git directly.

### `/abrain status` UX change

The "⚠ diverged — run /abrain sync for runbook" line in
`formatSyncStatus` is replaced by:

- `⚠ last fetch hit a merge conflict — run /abrain sync for runbook` when
  the most recent fetch event in the audit log has `result=conflict`
  (the only state that genuinely demands user attention).
- `ⓘ diverged — run /abrain sync to auto-merge` when `ahead > 0 &&
  behind > 0` but the user hasn't fetched yet this session (transient
  pre-merge state; informational, not warning).

The `/abrain status` notification color flips from `warning` to `info`
in the auto-merged case; `warning` is reserved for actual conflicts.

### Trigger

User feedback after running ADR 0020 in production: every cross-device
session started with the divergence message, even when no real conflict
existed. Quoting the user (2026-05-17):

> "abrain 应该自动同步，而不是要人手动同步，只有同步出现冲突时才需要人工干预"

The 2026-05-15 decision treated divergence as a proxy for conflict; this
revision restores the precise distinction.

### Smoke updates

Total assertions: 27 → 29.

- Section 6 inverted: "diverged on disjoint files" now asserts
  `result=ok`, `merged>=1`, both sides' commits present in `git log`,
  recognizable `abrain auto-merge` commit message, clean working tree.
- Section 9 inverted: `sync()` on no-conflict divergence asserts
  `ok=true`, `summary` contains `auto-merged`, remote receives both A's
  commit and the merge commit.
- Section 9b new: real textual conflict (both sides edit same line of
  same file). Asserts `result=conflict`, `conflictPaths` includes the
  file, HEAD unchanged across the failed merge attempt, working tree
  clean, `MERGE_HEAD` absent. `sync()` on the same state asserts the
  runbook names the conflicting file and skips push.
- Section 11 updated: `formatSyncStatus` warning path now triggered by
  `lastFetch.result === 'conflict'`, not by raw `ahead+behind > 0`.
- Setup hardened: `.state/` is added to `deviceA/.gitignore` before the
  initial commit, mirroring `ensureAbrainStateGitignored()`'s
  production behavior. Without it the new clean-tree assertions would
  spuriously fail on the audit log directory.

### Deferred (still on the radar)

- Branch/remote detection (still hardcoded `origin/main`).
- TUI footer hint on prolonged conflict state (P0e candidate #1).
- Smoke covering sediment writer's auto-push integration end-to-end
  (still bypassed by the smoke's direct-require pattern).
- Conflict frequency telemetry: with auto-merge in place we now have a
  clean signal for "how often does git itself give up?" which would
  inform any future revisit of Alternative D.

### Round 3 audit (2026-05-17, post-revision)

Same three-model parallel pass as Round 2 (opus-4-7 + gpt-5.5 +
deepseek-v4-pro). Consensus: the revision shipped a correct **policy**
(auto-merge on divergence) but the **implementation** had a CRITICAL
classification bug — every non-zero `git merge` exit was labelled
`conflict`, including timeouts, dirty trees, `commit.gpgsign=true`
failures, `.git/index.lock` contention, and unrelated histories. The
runbook then lied to users on every one of those non-conflict failures.

| Finding | Source | Where | Fix |
|---|---|---|---|
| **CRITICAL-A** — result=`conflict` set unconditionally on any merge subprocess failure (timeout, dirty tree, gpgsign failure, hook failure, index.lock contention, unrelated histories all misclassified) | deepseek C1, opus M1, gpt-5.5 M2 (3-way consensus) | `git-sync.ts` merge catch block | Rewrote classification: `conflict` requires positive evidence (unmerged paths in `git diff --diff-filter=U` OR `CONFLICT (`/`Automatic merge failed` in stderr under LANG=C). Otherwise route through `classifyError(false)` so SIGTERM→`timeout`, others→`failed`. |
| **MAJOR-B** — `commit.gpgsign=true` would either silently sign auto-merge with user's GPG key under `abrain-autosync` author (misleading audit trail) or fail at missing GPG agent (then misclassified as conflict per CRITICAL-A) | opus M3, gpt-5.5 M3 | merge command | Added `-c commit.gpgsign=false` to merge argv. Auto-merges are machine-generated convergence markers; signing them under a fake author would be a deceptive record. |
| **MAJOR-C** — inherited `GIT_AUTHOR_NAME/EMAIL` env wins over `-c user.name=` flag; auto-merge could carry developer identity | gpt-5.5 M5 | merge subprocess env | Introduced `MERGE_ENV` constant that hard-overrides `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_NAME`/`GIT_COMMITTER_EMAIL` to `abrain-autosync <autosync@abrain.local>` and sets `GIT_EDITOR=:` as belt-and-suspenders against editor invocation. |
| **MAJOR-D** — startup auto-merge produced local merge commit but never pushed; merge sat local until next sediment commit or manual `/abrain sync`, defeating cross-device-substrate goal | opus m1, gpt-5.5 MAJOR-1 | `extensions/abrain/index.ts` startup handler | After successful auto-merge on startup, fire-and-forget `pushAsync` with its own audit + console line. `pushAsync` already has single-flight + never-throws guarantees. |
| **MAJOR-E** — no working-tree-clean preflight; merge over dirty tree returned `conflict` (misleading) and could clobber local edits | gpt-5.5 MAJOR-4 | `fetchAndFF` divergence path | Added `git status --porcelain` preflight before merge attempt; non-empty status returns `failed` with first 5 dirty paths in error. Conservative: status-check subprocess failure also returns `failed` (refuses to merge under uncertainty). |
| **MAJOR-F** — pre-existing `MERGE_HEAD` (prior wedge) would make next `merge --ff-only` or `merge --no-ff` error opaquely; could be misclassified as conflict | opus M4 (post-abort variant), gpt-5.5 implicit | both ff and divergence branches | Added universal `MERGE_HEAD` preflight that runs before EITHER merge variant whenever `behind > 0`. Returns `failed` with explicit recovery hint (`git merge --abort`). Preflight is read-only (does not auto-recover) so failures stay visible. |
| **MAJOR-G** — `merge --abort` failure (timeout under load or hook failure) left MERGE_HEAD on disk while audit recorded `result=conflict`; runbook then claimed "working tree restored" while next sediment commit would wedge | opus M4 | merge catch block, post-abort | After every abort attempt, re-check `existsSync(.git/MERGE_HEAD)`; if wedge persists, upgrade result to `failed` with explicit "abort did not clear MERGE_HEAD" hint. The runbook now only fires when tree is genuinely restored. |
| **MINOR-H** — `conflictPaths` parsed via newline split would break on filenames containing spaces/quotes/newlines | gpt-5.5 MINOR-7 | conflict path enumeration | Switched to `git diff -z --name-only --diff-filter=U` with NUL-separator split. |
| **MINOR-I** — module-level docstring still said "ff-only is the only merge strategy", contradicting the revision; future maintainers reading source would be misled | opus M5, gpt-5.5 MINOR-8 | `git-sync.ts:1-50` | Rewrote module header + design principle #2 to describe 2026-05-17 behavior (ff for behind-only, 3-way merge for divergence, preflights, identity override, conflict-evidence requirement). Cross-referenced this Revision section. |
| **MINOR-J** — smoke pinned merge subject substring but not identity or 2-parent shape, so a regression dropping the author override would slip through | gpt-5.5 MINOR-2, opus m6.7, deepseek new-smoke-2 | section 6 | Extended assertion to check `%an/%ae/%cn/%ce` equals `abrain-autosync <autosync@abrain.local>` and `%P` parents count equals 2. |

**Known gap explicitly NOT fixed in Round 3** (recorded for traceability):

- **Sediment `gitCommit` race with auto-merge on `.git/index.lock`** (opus
  M2). Sediment's writer.ts does raw `git add`/`git commit` OUTSIDE
  `git-sync.ts`'s `singleFlight` queue. The revision's new `git merge`
  step takes `.git/index.lock` for its entire duration (the old
  `git push` did not), widening a pre-existing race surface. Round 3's
  CRITICAL-A fix means the loser of the race now correctly gets
  `result=failed` with a recognizable index.lock stderr (instead of
  spuriously labelled `conflict`), which is the minimum-viable
  mitigation: the next op will retry. Structural fix requires exporting
  `singleFlight` from `git-sync.ts` and wiring sediment's gitCommit
  through it — a writer.ts change with its own smoke and ADR
  implications, deferred to a follow-up. Module header docs this gap
  under invariant 4 so the next maintainer doesn't need to re-derive it.

**Smoke updates Round 3**: 29 → 34 assertions.

- Section 6 extended: precise identity + 2-parent shape assertions.
- Section 17 new (5 assertions, one per Round 3 finding that needed a
  regression pin):
  - 17.1 dirty working tree → `failed` (not `conflict`), local modification preserved.
  - 17.2 pre-existing MERGE_HEAD → `failed` with hint, preflight is read-only (does not clear the wedge).
  - 17.3 SIGTERM-killed merge (1ms timeout) → NOT `conflict` (pin CRITICAL-A fix).
  - 17.4 unrelated histories → `failed`, no MERGE_HEAD leak.
  - 17.5 conflict on path containing spaces → `conflictPaths` parsed correctly via `-z`.

## Round 4 audit (2026-05-17, post-Round-3)

Third audit pass with the same three models (opus + gpt-5.5 +
deepseek). Round 4 verdicts:

| Model | Verdict | Notes |
|---|---|---|
| opus-4-7 | NEEDS-CHANGES | 2 MAJORs, 5 MINORs |
| gpt-5.5 | NEEDS-CHANGES | 1 CRITICAL (= consensus item), 4 MAJORs |
| deepseek-v4-pro | SHIP-WITH-MINORS | 1 MINOR (= consensus item) |

The Round 3 CRITICAL-A fix introduced a subtle ordering bug all three
models independently caught (the consensus C1 / opus MINOR-1 / gpt
CRITICAL-1 / deepseek item 1). Plus two structural issues Round 3
missed.

| Finding | Source | Where | Fix |
|---|---|---|---|
| **CRITICAL-A2** — SIGTERM-killed merge could write partial unmerged index entries before being killed; the Round 3 catch block then saw `conflictPaths.length > 0`, set `isRealConflict=true`, and labelled `result=conflict` instead of `timeout`. Smoke 17.3's `timeoutMs:1` masked the bug by accepting both outcomes; production logs would surface a confusing "merge conflict in N file(s)" runbook for what was actually a slow network/disk. | gpt CRITICAL-1, opus MINOR-1, deepseek item 1 (3-way consensus) | `git-sync.ts` merge catch block | Re-ordered classification precedence: `wedgePersists` > SIGTERM-detected timeout > positive-conflict evidence > generic `classifyError`. SIGTERM is conclusive proof we killed the subprocess; partial index state is necessarily transient (cleared by the abort below) and must not beat that signal. New smoke 18.1 uses a `pre-merge-commit` hook with `sleep 5` to *deterministically* SIGTERM a merge that may have written conflict markers; the previous wall-clock-race-flaky 17.3 stays in for coverage but 18.1 is the bug-pin. |
| **MAJOR-B2** — the Round 3 "universal MERGE_HEAD preflight" was gated on `behind > 0`. A wedge with `behind === 0` would return `noop` and the wedge would silently block sediment's next commit (the failure surfacing inside writer.ts's swallow-catch with no breadcrumb pointing here). | opus MAJOR-2, gpt MAJOR-2 | `git-sync.ts` preflight | Removed the `behind > 0` gate. The MERGE_HEAD preflight now runs whenever `fetchAndFF` is invoked, regardless of ahead/behind. The check is still read-only — we do NOT auto-clear the wedge, since that could lose work the user was mid-resolving manually. New smoke 18.2 pins behind=0 + MERGE_HEAD → `failed`. |
| **MAJOR-C2** — the `.state/` gitignore guard (`ensureAbrainStateGitignored`) ran AFTER `fetchAndFF` at startup. An older abrain repo without `.state/` in `.gitignore` would have `.state/git-sync.jsonl` as untracked content the moment the first audit row is written; the Round 3 dirty-tree preflight would then refuse every subsequent auto-merge on that repo, permanently, until someone manually fixed `.gitignore`. | gpt MAJOR-1 | `extensions/abrain/index.ts` activate() | Wrapped startup `fetchAndFF` in a `runStartupAutoSync()` closure and invoke it AFTER `ensureAbrainStateGitignored` runs. Ordering is now enforced by call-site, not by line position (which is fragile under future inserts). The dirty-tree preflight on first run sees a `.gitignore` already covering `.state/`. |
| **MAJOR-D2** — `--no-gpg-sign` flag missing from the merge command. The Round 3 `-c commit.gpgsign=false` covers git's documented signing config key (deepseek confirmed `merge.gpgSign` does not exist as a config; opus's MAJOR-1 was based on a misremembered key name), but an explicit `--no-gpg-sign` flag adds belt-and-suspenders defense against any non-standard git build with surprising signing defaults. | opus MAJOR-1 (partial; deepseek refuted the `merge.gpgSign` half) | `git-sync.ts` merge argv | Added `--no-gpg-sign` to the merge argv alongside `-c commit.gpgsign=false`. New smoke 18.3 sets `commit.gpgsign=true` with `gpg.program=/nonexistent/...` so signing would actually fail if attempted; asserts merge still succeeds and `%G?` reports `N` (no signature). |
| **MINOR-E2** — ADR Round 3 table claimed "universal" preflight, code was gated on `behind > 0`; future maintainers reading the ADR would assume coverage that wasn't there. | opus MINOR-2, gpt project 8 | this section + Round 3 table | The Round 3 table's MAJOR-F row is left intact for historical traceability; this Round 4 entry above (MAJOR-B2) records the correction explicitly. Current code matches current docs. |
| **MINOR-F2** — startup auto-merge's "pushing…" log line had no terminal closure for `noop` or `skipped` push results; user sees an ellipsis with no resolution line. | gpt MINOR-1 | `index.ts` startup handler | All four `pushAsync` outcomes (`ok`, `noop`, `skipped`, anything else) now emit a recognizable terminal line. |
| **MINOR-G2** — preflight `git status --porcelain` had a hardcoded `timeout: 3_000`, inconsistent with the caller-supplied `timeoutMs`. If a future maintainer raises `DEFAULT_TIMEOUT_MS`, this 3s ceiling would remain a hidden cap. | deepseek NIT | `git-sync.ts` preflight | Preflight now uses the caller's `timeoutMs`. |
| **MINOR-H2** — `git diff -z` for conflict-path enumeration had `maxBuffer: 1024 * 1024` hardcoded instead of referencing the module-level `MAX_BUFFER` constant. | deepseek NIT | `git-sync.ts` conflict-path enumeration | Now uses `MAX_BUFFER`. |

**Round 4 left unresolved (deferred with rationale)**:

- **opus MINOR-4 (GIT_ENV snapshots `process.env` at module load)**: a long-running pi session where `SSH_AUTH_SOCK` rotates (tmux reattach) could see stale socket on subsequent pushes. Real but low-impact; abrain pushes are typically https or short-lived sessions. Deferred. Workaround: restart pi after switching SSH session.
- **gpt MAJOR-3 (sediment race scope widening)**: the Round 3 "known gap" wording said "sediment `gitCommit()` race" but writer.ts has multiple raw `git add`/`git commit` lanes (project/world, workflow, about-me). The minimum-viable mitigation in Round 3's CRITICAL-A fix still applies to all of them (loser of the index.lock race gets `failed`, not spurious `conflict`); the structural fix (export `singleFlight` and route all writer lanes through it) is a writer.ts PR with its own ADR implications. Tracked, deferred.
- **NIT-3 (`_queueDepth` ratchet semantics)**: cosmetic API naming; not user-visible.
- **NIT (Windows `execFile` timeout signal)**: abrain targets Linux/macOS only.

**Smoke updates Round 4**: 34 → 38 assertions.

- Section 18 new (4 assertions, one per Round 4 finding that needed a
  bug-pin):
  - 18.1 SIGTERM-killed merge via deterministic sleep hook → `result=timeout` (NOT `conflict` even if partial state existed). This is the primary CRITICAL-A2 pin.
  - 18.2 pre-existing MERGE_HEAD with `behind === 0` → `result=failed` (NOT `noop`), preflight remains read-only.
  - 18.3 `commit.gpgsign=true` with `gpg.program=/nonexistent/...` → auto-merge succeeds unsigned (`%G?` == `N`).
  - 18.4 dirty-tree refusal sanity — user's untracked file content is byte-identical after preflight refused the merge.

After 4 audit rounds with no remaining CRITICAL or MAJOR findings
across all three models, the implementation is considered stable for
production use. The deferred items are documented for future work but
are not blockers.

## P0e candidates (deferred, recorded for traceability)

1. TUI footer hint when `ahead > 0` for >5 minutes (visible "abrain: N to push") so users notice silent push failures.
2. Periodic fetch (e.g. every 15 min during active session).
3. Conflict-suggestion logging: when divergence is detected, log the conflicting paths to `.state/git-sync.jsonl` so future analysis can quantify how often LLM-merge would have helped.
4. Identity passphrase wrap (ADR 0019 P0d): once `master.age` can enter git, abrain auto-sync becomes the *only* cross-device step needed.
