/**
 * Cross-extension single-flight serializer for git operations that share
 * a repository (PR-1 / P0.6a of docs/audits/2026-06-10-goal-workflow-impl-plan.md;
 * ADR 0027 C2' singleFlight constraint).
 *
 * Closes the KNOWN GAP documented in extensions/abrain/git-sync.ts since
 * 2026-05-17: sediment's writer-side `gitCommit` / `gitCommitAbrain` /
 * `gitCommitAbrainAboutMe` did not route through git-sync's private
 * single-flight chain, so a sediment commit could race the ADR 0020
 * auto-merge / push on `.git/index.lock`.
 *
 * WHY globalThis singleton: pi loads extensions via jiti with
 * moduleCache:false — each extension importing this module gets its OWN
 * module-level copy (heartbeat.ts R4 NEW-P0 lesson). A module-level Map
 * here would give abrain (git-sync) and sediment (writer) two separate
 * "locks" that never contend — exactly the bug this module exists to fix.
 * The chain map therefore lives on
 * `globalThis[Symbol.for("pi-astack/git-singleflight/state/v1")]`. Because
 * jiti `moduleCache:false` can load multiple copies, state() also checks a
 * version field and reuses any existing singleton in place after warning.
 *
 * KEYING: one chain per *resolved* repo root path. Ops against the same
 * `.git/index.lock` must share a key; ops on different repos must not
 * block each other. Callers pass the repo root (e.g. abrainHome); we
 * `path.resolve()` it so trailing-slash / relative variants collapse to
 * one chain. Symlinked aliases of the same repo would still get distinct
 * chains — acceptable: cross-PROCESS safety continues to rely on git's
 * own index.lock as the fail-soft path (one wins, the loser audit-logs
 * a failed result), same as before this module existed.
 *
 * ALGORITHM (inherited verbatim from git-sync.ts's Round-2 TOCTOU fix):
 * a tail-chained promise per key. Each caller links its fn onto
 * `tail.then(fn, fn)` so it runs strictly after every prior fn settles
 * (fn is passed as BOTH onFulfilled and onRejected so a prior rejection
 * doesn't block the next caller). The stored tail is a swallowed copy of
 * the new promise so the chain stays alive without poisoning downstream;
 * the caller still receives the unswallowed promise (rejections
 * propagate to the caller that owns them).
 *
 * RE-ENTRANCY NOTE: fn must NOT await another gitSingleFlight op on the
 * same key (that op is queued BEHIND fn and the await would self-deadlock).
 * Fire-and-forget enqueues (e.g. writer's detached pushAsync) are safe —
 * they chain behind and run after fn settles.
 */

import * as path from "node:path";

const _STATE_KEY = Symbol.for("pi-astack/git-singleflight/state/v1");
const STATE_VERSION = 1;

interface GitSingleFlightState {
  version: number;
  /** resolved repo root → swallowed tail of the chain */
  tails: Map<string, Promise<unknown>>;
  /** total ops ever enqueued in this process (introspection / smoke) */
  opsStarted: number;
}

function state(): GitSingleFlightState {
  const g = globalThis as Record<symbol, unknown>;
  let s = g[_STATE_KEY] as Partial<GitSingleFlightState> | undefined;
  if (!s || typeof s !== "object") {
    s = { version: STATE_VERSION, tails: new Map(), opsStarted: 0 };
    g[_STATE_KEY] = s;
    return s as GitSingleFlightState;
  }
  if (s.version !== STATE_VERSION || !(s.tails instanceof Map) || typeof s.opsStarted !== "number") {
    console.warn("[pi-astack/git-singleflight] incompatible global singleton shape/version; reusing existing instance in place");
    if (!(s.tails instanceof Map)) s.tails = new Map();
    if (typeof s.opsStarted !== "number") s.opsStarted = 0;
    if (typeof s.version !== "number") s.version = STATE_VERSION;
  }
  return s as GitSingleFlightState;
}

/**
 * Run `fn` strictly after every previously-enqueued op for the same
 * resolved `repoRoot` has settled. Returns fn's own promise (value and
 * rejection propagate to the caller).
 */
export function gitSingleFlight<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const s = state();
  const key = path.resolve(repoRoot);
  const tail = s.tails.get(key) ?? Promise.resolve();
  const p = tail.then(fn, fn);
  s.opsStarted += 1;
  s.tails.set(
    key,
    p.then(
      () => undefined,
      () => undefined,
    ),
  );
  return p;
}

/** Introspection for smoke tests / `_queueDepth` style probes. */
export function _gitSingleFlightStats(): { keys: number; opsStarted: number } {
  const s = state();
  return { keys: s.tails.size, opsStarted: s.opsStarted };
}
