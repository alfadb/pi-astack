#!/usr/bin/env node
/**
 * smoke-c5-heartbeat-consumer — ADR 0027 §C2' Stage 1c consumer-side
 * liveness detection.
 *
 * Covers the pure staleness math (deterministic via injected `now`) AND a
 * real writer→reader round-trip (startHeartbeat writes a trace,
 * assessLivenessForAnchor reads it).
 *
 *   [1]  no beats → unknown
 *   [2]  last phase=stopping → stopped (clean termination, NOT timeout)
 *   [3]  recent beat → alive (0 missed)
 *   [4]  >= threshold missed beats → stale
 *   [5]  boundary: exactly threshold → stale; threshold-1 → alive
 *   [6]  unparseable ts → unknown
 *   [7]  clock skew (future ts) → alive (0 missed, not negative)
 *   [8]  interval source: started beat interval_ms used; fallback when absent
 *   [9]  seq-gap detection
 *   [10] terminalStateFromLiveness: stale → cancelled/timeout/cleanup/resumable;
 *        non-stale verdicts → null
 *   [11] real writer→reader round-trip + missing-file → unknown
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

const here = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const { default: createJitiDefault, createJiti } = require("jiti");
const makeJiti = createJiti ?? createJitiDefault;
const jiti = makeJiti(repoRoot, { interopDefault: true });

let pass = 0, fail = 0;
const check = (n, ok, why = "") => {
  if (ok) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${why ? `  ← ${why}` : ""}`); }
};

const consumer = jiti(path.join(repoRoot, "extensions/dispatch/heartbeat-consumer.ts"));
const hb = jiti(path.join(repoRoot, "extensions/_shared/heartbeat.ts"));

const {
  assessLiveness,
  assessLivenessFromTrace,
  assessLivenessForAnchor,
  terminalStateFromLiveness,
  DEFAULT_MISSED_BEAT_THRESHOLD,
} = consumer;
const { startHeartbeat, _resetHeartbeatRegistryForTests } = hb;

// Fixed base instant for deterministic staleness math.
const T0 = Date.parse("2026-05-30T12:00:00.000Z");
const ISO = (ms) => new Date(ms).toISOString();
const INTERVAL = 15_000;

function beat(over = {}) {
  return {
    ts: ISO(T0),
    phase: "alive",
    pid: 123,
    schema_version: 1,
    seq: 1,
    session_id: "sess",
    turn_id: 1,
    ...over,
  };
}

// ─── [1] no beats → unknown ─────────────────────────────────────────
console.log("[1] no beats → unknown");
{
  const a = assessLiveness([]);
  check("verdict unknown", a.verdict === "unknown");
  check("reason mentions absence not hang", /absence is NOT evidence|never started/.test(a.reason));
}

// ─── [2] stopping → stopped ─────────────────────────────────────────
console.log("[2] last phase=stopping → stopped");
{
  const beats = [beat({ phase: "started", seq: 1, interval_ms: INTERVAL }), beat({ phase: "stopping", seq: 2 })];
  // Even with a huge elapsed, a stopping beat means clean termination.
  const a = assessLiveness(beats, { now: T0 + 999 * INTERVAL });
  check("verdict stopped", a.verdict === "stopped");
  check("NOT stale despite huge elapsed", a.verdict !== "stale");
  check("lastPhase stopping", a.lastPhase === "stopping");
  // A trace whose ONLY beat is stopping (started lost to partial read) is
  // still a clean stop — stopping wins regardless of elapsed / no interval.
  const onlyStopping = assessLiveness([beat({ phase: "stopping", seq: 1 })], { now: T0 + 999 * INTERVAL });
  check("only-stopping beat → stopped", onlyStopping.verdict === "stopped");
}

// ─── [3] recent beat → alive ────────────────────────────────────────
console.log("[3] recent beat → alive");
{
  const beats = [beat({ phase: "started", seq: 1, interval_ms: INTERVAL })];
  const a = assessLiveness(beats, { now: T0 + 2000 }); // 2s after, < 1 interval
  check("verdict alive", a.verdict === "alive");
  check("missedBeats 0", a.missedBeats === 0);
  check("observedIntervalMs from started beat", a.observedIntervalMs === INTERVAL);
}

// ─── [4] >= threshold missed → stale ────────────────────────────────
console.log("[4] >= threshold missed → stale");
{
  const beats = [beat({ phase: "started", seq: 1, interval_ms: INTERVAL })];
  const a = assessLiveness(beats, { now: T0 + 5 * INTERVAL }); // 5 missed
  check("verdict stale", a.verdict === "stale");
  check("missedBeats 5", a.missedBeats === 5);
  check("reason mentions hung/dead", /presumed hung\/dead/.test(a.reason));
}

// ─── [5] boundary ───────────────────────────────────────────────────
console.log("[5] threshold boundary");
{
  const beats = [beat({ phase: "started", seq: 1, interval_ms: INTERVAL })];
  const th = DEFAULT_MISSED_BEAT_THRESHOLD; // 3
  const atThreshold = assessLiveness(beats, { now: T0 + th * INTERVAL });
  check(`exactly threshold (${th}) → stale`, atThreshold.verdict === "stale");
  const below = assessLiveness(beats, { now: T0 + (th * INTERVAL) - 1 }); // th-? just under
  check("just under threshold → alive", below.verdict === "alive");
  // custom threshold
  const custom = assessLiveness(beats, { now: T0 + 2 * INTERVAL, missedBeatThreshold: 2 });
  check("custom threshold=2, 2 missed → stale", custom.verdict === "stale");
}

// ─── [6] unparseable ts → unknown ───────────────────────────────────
console.log("[6] unparseable ts → unknown");
{
  const beats = [beat({ ts: "not-a-date", phase: "alive", seq: 1 })];
  const a = assessLiveness(beats, { now: T0 + 999 * INTERVAL });
  check("verdict unknown", a.verdict === "unknown");
  check("reason mentions unparseable", /unparseable/.test(a.reason));
}

// ─── [7] clock skew (future ts) → alive ─────────────────────────────
console.log("[7] clock skew future ts → alive");
{
  const beats = [beat({ phase: "started", seq: 1, interval_ms: INTERVAL, ts: ISO(T0 + 60_000) })];
  const a = assessLiveness(beats, { now: T0 }); // now BEFORE the beat
  check("verdict alive (not stale, not crash)", a.verdict === "alive");
  check("missedBeats clamped to 0", a.missedBeats === 0);
  check("msSinceLastBeat negative preserved", a.msSinceLastBeat < 0);
}

// ─── [8] interval source + fallback ─────────────────────────────────
console.log("[8] interval source / fallback");
{
  // started beat carries 5s interval → 4 elapsed intervals at that rate
  const withStart = [beat({ phase: "started", seq: 1, interval_ms: 5000 }), beat({ phase: "alive", seq: 2, ts: ISO(T0) })];
  const a = assessLiveness(withStart, { now: T0 + 20_000 });
  check("uses started interval_ms=5000", a.observedIntervalMs === 5000);
  check("20s / 5s = 4 missed → stale", a.verdict === "stale" && a.missedBeats === 4);

  // no interval_ms anywhere → fallback 15s; custom fallback honored
  const noInterval = [beat({ phase: "alive", seq: 1 })];
  const b = assessLiveness(noInterval, { now: T0 + 30_000, fallbackIntervalMs: 10_000 });
  check("custom fallback interval used", b.observedIntervalMs === 10_000);
  check("30s / 10s = 3 missed → stale", b.verdict === "stale" && b.missedBeats === 3);

  // fallback FLOOR mirrors the writer's 1000ms clamp (3-T0 P2): a tiny
  // fallback must not make a few ms read as many missed beats → false stale.
  const c = assessLiveness(noInterval, { now: T0 + 2000, fallbackIntervalMs: 0 });
  check("fallbackIntervalMs:0 floored to 1000", c.observedIntervalMs === 1000);
  check("2s @ 1000ms floor = 2 missed → alive (not instant stale)", c.verdict === "alive" && c.missedBeats === 2);
}

// ─── [9] seq-gap detection ──────────────────────────────────────────
console.log("[9] seq-gap detection");
{
  const contiguous = [beat({ seq: 1, interval_ms: INTERVAL, phase: "started" }), beat({ seq: 2 }), beat({ seq: 3 })];
  check("contiguous → seqGap false", assessLiveness(contiguous, { now: T0 }).seqGap === false);
  const gapped = [beat({ seq: 1, interval_ms: INTERVAL, phase: "started" }), beat({ seq: 4 })];
  check("gap (1,4) → seqGap true", assessLiveness(gapped, { now: T0 }).seqGap === true);
  // no seq field anywhere → undefined ("not assessable"), NOT false (3-T0 NIT).
  const noSeq = [{ ts: ISO(T0), phase: "alive", pid: 1, schema_version: 1, interval_ms: INTERVAL }];
  check("no seq field → seqGap undefined (not assessable)", assessLiveness(noSeq, { now: T0 }).seqGap === undefined);
}

// ─── [10] terminalStateFromLiveness ─────────────────────────────────
console.log("[10] terminalStateFromLiveness");
{
  const staleAssess = assessLiveness([beat({ phase: "started", seq: 1, interval_ms: INTERVAL })], { now: T0 + 9 * INTERVAL });
  const ts = terminalStateFromLiveness(staleAssess);
  check("stale → non-null", ts !== null);
  check("terminal_state cancelled", ts?.terminal_state === "cancelled");
  check("cancel_source timeout", ts?.cancel_source === "timeout");
  check("cleanup_done true (v1 read-only)", ts?.cleanup_done === true);
  check("resumable false (v1)", ts?.resumable === false);

  check("alive → null", terminalStateFromLiveness(assessLiveness([beat({ interval_ms: INTERVAL, phase: "started", seq: 1 })], { now: T0 })) === null);
  check("stopped → null", terminalStateFromLiveness(assessLiveness([beat({ phase: "stopping", seq: 1 })], { now: T0 + 99 * INTERVAL })) === null);
  check("unknown → null", terminalStateFromLiveness(assessLiveness([])) === null);
}

// ─── [11] real writer → reader round-trip + missing file ────────────
console.log("[11] real writer→reader round-trip");
{
  _resetHeartbeatRegistryForTests();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-hbc-"));
  const anchor = { session_id: "rt-sess", turn_id: 7, subturn: 0, device_id: "dev" };

  const h = startHeartbeat({ anchor, projectRoot: tmp, intervalMs: 15_000 });
  check("handle active", h.active === true);
  check("trace file exists after start", h.tracePath && fs.existsSync(h.tracePath));

  // Fresh trace, now ≈ start → alive.
  const fresh = assessLivenessForAnchor(tmp, anchor, { now: Date.now() });
  check("fresh trace → alive", fresh.verdict === "alive");
  check("read the started beat", fresh.beatCount >= 1 && fresh.observedIntervalMs === 15_000);

  // Same trace, now far in the future → stale.
  const future = assessLivenessForAnchor(tmp, anchor, { now: Date.now() + 10 * 60_000 });
  check("far-future now → stale", future.verdict === "stale");
  const tsf = terminalStateFromLiveness(future);
  check("maps to cancelled/timeout", tsf?.terminal_state === "cancelled" && tsf?.cancel_source === "timeout");

  // stop() writes stopping beat then unlinks → file gone → unknown.
  h.stop();
  const afterStop = assessLivenessForAnchor(tmp, anchor, { now: Date.now() });
  check("after stop()+unlink → unknown (file gone)", afterStop.verdict === "unknown");

  // Missing file directly → unknown, never throws.
  const missing = assessLivenessFromTrace(path.join(tmp, "does-not-exist.jsonl"));
  check("missing file → unknown", missing.verdict === "unknown");

  fs.rmSync(tmp, { recursive: true, force: true });
  _resetHeartbeatRegistryForTests();
}

console.log("");
console.log(`pass=${pass}, fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
