#!/usr/bin/env node
/**
 * S3 STORM-SHADOW smoke (living plan 2026-08-10).
 *
 * Candidate A — post-cap exact schema-rejection identity: the cap is the
 * READ-ONLY MIRROR of the governor toolObservers.schemaErrorStorm.observeAfter
 * (default 3). Every real tool_execution_end schema rejection reuses the
 * governor's own classifier for the exact identity (tool name + closed error
 * class + field path); only the keyless identity checksum (digest) is
 * persisted / compared. Reaching the cap boundary on one identity sets
 * post_cap (no abort); EXCEEDING it on subsequent same-identity rejections
 * produces would_abort (consecutive count > capAfter, or window density
 * >= windowLimit). Different identities never merge.
 *
 * The identity checksum is keyless and deterministic (ADR 0027 C6): no key
 * material, no strict-key eligibility prerequisite, no degradation branch —
 * the same identity always produces the same digest in every process.
 *
 * Candidate B — effective progress semantics: successful tool result and
 * visible COMPLETED assistant responses are progress (reset/segment); pure
 * toolUse messages are NEVER progress (neutral, basis tool_use_only); provider
 * request / retry / schema rejection / failed tool / error response / empty
 * visible retry do not reset; unknown events are never guessed.
 *
 * Anti-sticky: after the first trip of a segment (first_trip), neutral events
 * report would_abort=false with already_tripped=true instead of repeating
 * would_abort; effective progress opens a new segment.
 *
 * Audit rows stay bounded: only state-relevant events are written (schema
 * rejections, progress/reset, the first trip, the already-tripped transition,
 * one pure-toolUse marker per segment); replaying the written rows' inputs
 * reproduces the written verdicts exactly.
 *
 * Real SDK runInProcess + faux provider: the SAME run's real event stream
 * drives four consecutive same-identity schema rejections until
 * would_abort=true (first_trip), then the worker continues (successful tool →
 * progress reset → final visible completion) and completes normally — shadow
 * verdicts never touch control flow.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const S = await jiti.import(path.join(root, "extensions/dispatch/storm-shadow.ts"));
const G = await jiti.import(path.join(root, "extensions/dispatch/worker-run-governor.ts"));
const D = await jiti.import(path.join(root, "extensions/dispatch/index.ts"));
const DT = await jiti.import(path.join(root, "extensions/dispatch/dispatch-trace.ts"));
const AH = await jiti.import(path.join(root, "extensions/_shared/audit-checksum.ts"));

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error instanceof Error ? error.message : String(error)}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-storm-shadow-"));
const settings = {
  capAfter: S.DEFAULT_STORM_SHADOW_SETTINGS.capAfter,
  windowSize: S.STORM_SHADOW_WINDOW_SIZE,
  windowLimit: S.STORM_SHADOW_WINDOW_LIMIT,
};

// ── Opaque checksums (pre-projected exactly like the wiring builds them) ──
// The wiring checksum input is the unambiguous structured/framed tuple
// JSON.stringify([toolName, errorClass, fieldPath, normalized]) — same
// class/path with different normalized descriptors must never merge. The
// checksum is keyless and deterministic (ADR 0027 C6): the same identity
// always produces the same digest in every process, with no key material
// and no eligibility prerequisite.
const sig = (toolName, errorClass, fieldPath, normalized) =>
  AH.auditChecksumHex(S.STORM_SHADOW_CHECKSUM_DOMAIN, JSON.stringify([toolName, errorClass, fieldPath, normalized]));
const A = sig("read", "missing_required", "path", "schema validation: required property 'path' is missing");
const B = sig("write", "missing_required", "path", "schema validation: required property 'path' is missing");
const C = sig("read", "invalid_type", "limit", "schema validation: expected number for property 'limit'");
// Same tool/class/path, different bounded normalized descriptors (the real
// read tool's "Received arguments" JSON differs) — the P1 collision pair.
// NOTE: the normalized descriptor preserves the original case (only the
// errorClass classification lowercases); these match the real read tool text.
const A1 = sig("read", "missing_required", "must", "Validation failed for tool \"read\": - path: must have required properties path Received arguments: {}");
const A2 = sig("read", "missing_required", "must", "Validation failed for tool \"read\": - path: must have required properties path Received arguments: { \"limit\": 5 }");

// ── Pre-projected event factories (what the wiring feeds the state machine) ──
const rej = (checksum = A) => ({ kind: "tool_execution_end", isError: true, schemaRejection: true, checksum });
const toolOk = () => ({ kind: "tool_execution_end", isError: false, schemaRejection: false });
const toolFail = () => ({ kind: "tool_execution_end", isError: true, schemaRejection: false });
const visible = () => ({ kind: "assistant_response", hasVisibleText: true, completed: true, errorResponse: false, emptyVisibleRetry: false, toolUseOnly: false });
const toolUse = () => ({ kind: "assistant_response", hasVisibleText: false, completed: false, errorResponse: false, emptyVisibleRetry: false, toolUseOnly: true });
const incomplete = () => ({ kind: "assistant_response", hasVisibleText: true, completed: false, errorResponse: false, emptyVisibleRetry: false, toolUseOnly: false });
const errorResponse = () => ({ kind: "assistant_response", hasVisibleText: false, completed: false, errorResponse: true, emptyVisibleRetry: false, toolUseOnly: false });
const emptyVisible = () => ({ kind: "assistant_response", hasVisibleText: false, completed: false, errorResponse: false, emptyVisibleRetry: true, toolUseOnly: false });
const providerRequest = () => ({ kind: "provider_request" });
const providerRetry = () => ({ kind: "provider_retry" });
const unknownEvent = () => ({ kind: "unknown", eventType: "weird_sdk_event" });

function run(events, extraSettings = settings) {
  const shadow = new S.StormShadow(extraSettings);
  const observations = events.map((event) => shadow.feed(event));
  return { observations, final: shadow.snapshot() };
}

console.log("dispatch storm-rule shadow smoke\n");
console.log("[pure state machine — candidate A: post-cap exact schema-rejection signature]");

await check("pre-cap: same signature below the cap boundary never trips, post_cap stays false", () => {
  const { observations, final } = run([providerRequest(), visible(), toolOk(), rej(), toolFail(), errorResponse(), emptyVisible(), unknownEvent()]);
  assert.ok(observations.every((o) => o.post_cap === false && o.would_abort === false && o.first_trip === false && o.already_tripped === false));
  assert.equal(final.consecutive_count, 1, "a single pre-cap rejection is counted but never trips");
  assert.equal(final.window_count, 1);
  assert.equal(final.tripped, false);
  assert.ok(observations.every((o) => o.progress_verdict !== "unknown" || o.progress_basis === "unknown_event"));
});

await check("same signature reaching the cap boundary (count == capAfter) does NOT trip; the NEXT same signature trips", () => {
  const { observations } = run([rej(), rej(), rej(), rej()]);
  assert.deepEqual(
    observations.map((o) => [o.consecutive_count, o.post_cap, o.would_abort, o.would_abort_basis, o.first_trip]),
    [[1, false, false, null, false], [2, false, false, null, false], [3, true, false, null, false], [4, true, true, "consecutive", true]],
    JSON.stringify(observations.map((o) => ({ c: o.consecutive_count, p: o.post_cap, a: o.would_abort, b: o.would_abort_basis, f: o.first_trip }))),
  );
  assert.equal(observations[0].cap_after, 3, "cap_after mirrors governor schemaErrorStorm.observeAfter (3)");
});

await check("different signatures never merge (consecutive restarts; no cross-signature accumulation)", () => {
  const { observations } = run([rej(A), rej(A), rej(B), rej(A)]);
  assert.deepEqual(observations.map((o) => o.consecutive_count), [1, 2, 1, 1], "different signature restarts the streak");
  assert.ok(observations.every((o) => o.would_abort === false), "no same-signature streak of 4 exists");
  const a1 = run([rej(A)]).observations[0].identity_checksum;
  const a2 = run([rej(A)]).observations[0].identity_checksum;
  const b1 = run([rej(B)]).observations[0].identity_checksum;
  assert.deepEqual(a1, a2, "identical identity must hash identically");
  assert.notEqual(a1.digest, b1.digest, "different identity must hash differently");
  assert.notEqual(a1.digest, C.digest, "same tool, different error class/field must hash differently");
});

await check("same tool/class/path with different normalized descriptors never merge (A/B/A/B, each count 2, never trip)", () => {
  assert.notEqual(A1.digest, A2.digest, "same class/path, different normalized must produce different digests");
  const { observations } = run([rej(A1), rej(A2), rej(A1), rej(A2)]);
  assert.deepEqual(observations.map((o) => o.consecutive_count), [1, 1, 1, 1], "each signature counts independently (no cross-normalized merge)");
  assert.deepEqual(observations.map((o) => o.window_count), [1, 1, 2, 2], "each signature accumulates its own window density");
  assert.ok(observations.every((o) => o.would_abort === false && o.first_trip === false && o.already_tripped === false), "no same-signature density of 4 exists");
  assert.equal(observations[3].post_cap, false, "each signature stays below the cap boundary");
});

await check("A/A/A/A same exact identity still trips on the 4th (normalized included in the identity)", () => {
  const { observations } = run([rej(A1), rej(A1), rej(A1), rej(A1)]);
  assert.deepEqual(observations.map((o) => o.consecutive_count), [1, 2, 3, 4]);
  assert.deepEqual(observations.map((o) => o.post_cap), [false, false, true, true], "cap boundary reached at observeAfter, no abort");
  assert.deepEqual(observations.map((o) => o.would_abort), [false, false, false, true], "4th same exact identity trips");
  assert.equal(observations[3].would_abort_basis, "consecutive");
  assert.equal(observations[3].first_trip, true);
});

await check("rolling window density trips same-signature interleaving (basis rolling_window)", () => {
  // A,B,A,B,A,B,A,A → A occurs 4 times inside the last-6 window at event 8
  // while never being consecutive → window density (windowLimit=4) trips.
  const { observations } = run([rej(A), rej(B), rej(A), rej(B), rej(A), rej(B), rej(A), rej(A)]);
  const trips = observations.filter((o) => o.would_abort);
  assert.equal(trips.length, 1, JSON.stringify(observations.map((o) => ({ c: o.consecutive_count, w: o.window_count, a: o.would_abort, b: o.would_abort_basis }))));
  assert.equal(trips[0].would_abort_basis, "rolling_window");
  assert.equal(trips[0].window_count, settings.windowLimit, "window trip needs window_count >= windowLimit");
  assert.equal(trips[0].first_trip, true);
  // A's 3rd occurrence (event 5) already reached the cap boundary (post_cap).
  assert.equal(observations[4].post_cap, true, "cap boundary reached before the trip");
});

await check("window evicts oldest eligible events beyond windowSize; consecutive keeps counting", () => {
  const many = Array.from({ length: 8 }, () => rej(A));
  const { final } = run(many);
  assert.ok(final.window.length <= settings.windowSize, `window length ${final.window.length} > ${settings.windowSize}`);
  assert.equal(final.window_count, settings.windowSize, "window_count saturates at windowSize for one signature");
  assert.equal(final.consecutive_count, 8, "consecutive count is unbounded by the window (same signature)");
  assert.equal(final.post_cap, true);
  assert.equal(final.tripped, true);
});

console.log("\n[pure state machine — candidate B: effective progress semantics]");

await check("successful tool result and visible COMPLETED assistant response are progress and reset the candidate", () => {
  const viaTool = run([rej(), rej(), toolOk(), rej(), rej()]);
  assert.equal(viaTool.observations[2].progress_verdict, "progress");
  assert.equal(viaTool.observations[2].progress_basis, "successful_tool_response");
  assert.equal(viaTool.observations[2].segment, 1, "progress segments the candidate");
  assert.equal(viaTool.observations[3].consecutive_count, 1, "progress resets the consecutive streak");
  assert.equal(viaTool.observations[4].would_abort, false, "reset streak must not have reached the threshold");

  const viaVisible = run([rej(), rej(), visible(), rej(), rej()]);
  assert.equal(viaVisible.observations[2].progress_basis, "visible_assistant_response");
  assert.equal(viaVisible.observations[2].segment, 1);
  assert.equal(viaVisible.observations[3].consecutive_count, 1);
  assert.equal(viaVisible.observations[4].would_abort, false);
});

await check("pure toolUse message is NEVER progress (neutral, basis tool_use_only) and does not reset", () => {
  const alone = run([toolUse()]);
  assert.equal(alone.observations[0].progress_verdict, "not_progress");
  assert.equal(alone.observations[0].progress_basis, "tool_use_only");
  assert.equal(alone.observations[0].segment, 0, "toolUse must not advance the segment");
  assert.equal(alone.observations[0].consecutive_count, 0, "toolUse must not count toward the candidate");

  const between = run([rej(), toolUse(), rej(), rej(), rej()]);
  assert.deepEqual(between.observations.map((o) => o.consecutive_count), [1, 1, 2, 3, 4], "toolUse between rejections must not reset the streak");
  assert.equal(between.observations[4].would_abort, true, "the streak still reaches the threshold");
});

await check("incomplete assistant response (visible text, turn not completed) is NOT progress", () => {
  const { observations } = run([rej(), incomplete(), rej(), rej()]);
  assert.equal(observations[1].progress_verdict, "not_progress");
  assert.equal(observations[1].progress_basis, "incomplete_assistant_response");
  assert.equal(observations[3].consecutive_count, 3, "incomplete response must not reset");
});

await check("error response is not progress and does not reset (basis error_response, not repeated_error)", () => {
  const { observations } = run([rej(), errorResponse(), rej(), rej(), rej()]);
  assert.equal(observations[1].progress_verdict, "not_progress");
  assert.equal(observations[1].progress_basis, "error_response");
  assert.equal(observations[4].consecutive_count, 4, "error response must not reset");
  assert.equal(observations[4].would_abort, true);
});

await check("provider request / retry / schema rejection / failed tool / empty visible retry do NOT reset", () => {
  const { observations } = run([rej(), providerRequest(), rej(), providerRetry(), rej(), toolFail(), rej()]);
  assert.deepEqual(
    observations.map((o) => o.consecutive_count),
    [1, 1, 2, 2, 3, 3, 4],
    "only effective progress resets; neutral events leave the streak untouched",
  );
  assert.equal(observations[1].progress_basis, "provider_request");
  assert.equal(observations[3].progress_basis, "provider_retry");
  assert.equal(observations[5].progress_basis, "failed_tool_response");
  assert.equal(observations[6].would_abort, true, "the streak still reaches the threshold");

  const empty = run([rej(), emptyVisible(), rej(), rej()]);
  assert.equal(empty.observations[1].progress_basis, "empty_visible_retry");
  assert.equal(empty.observations[3].consecutive_count, 3, "empty visible retry must not reset");
});

await check("unknown events are never guessed: neither count nor reset", () => {
  const { observations } = run([rej(), unknownEvent(), rej(), rej()]);
  assert.equal(observations[1].progress_verdict, "unknown");
  assert.equal(observations[1].progress_basis, "unknown_event");
  assert.deepEqual(observations.map((o) => o.consecutive_count), [1, 1, 2, 3], "unknown neither counts nor resets");
  assert.equal(observations[3].would_abort, false, "no same-signature streak of 4 exists");
});

await check("anti-sticky: after the first trip, neutral events report would_abort=false with already_tripped=true", () => {
  const { observations } = run([rej(), rej(), rej(), rej(), providerRequest(), providerRequest(), visible()]);
  assert.equal(observations[3].would_abort, true, "4th same-signature rejection trips");
  assert.equal(observations[3].first_trip, true);
  assert.equal(observations[4].would_abort, false, "neutral event after trip must NOT sticky-repeat would_abort");
  assert.equal(observations[4].already_tripped, true);
  assert.equal(observations[5].would_abort, false);
  assert.equal(observations[5].already_tripped, true);
  assert.equal(observations[6].progress_verdict, "progress", "effective progress opens a new segment");
  assert.equal(observations[6].already_tripped, false, "progress clears the tripped episode");
  assert.equal(observations[6].segment, 1);
  assert.equal(observations[6].consecutive_count, 0);
});

await check("same-signature rejections beyond the cap keep reporting would_abort (each crossing event)", () => {
  const { observations } = run([rej(), rej(), rej(), rej(), rej()]);
  assert.deepEqual(observations.map((o) => [o.consecutive_count, o.would_abort, o.first_trip]),
    [[1, false, false], [2, false, false], [3, false, false], [4, true, true], [5, true, false]],
    "exceeding the cap on subsequent same-signature rejections produces would_abort; first_trip marks the first");
});

console.log("\n[audit boundedness + replay]");

await check("write predicate keeps rows bounded and the written rows replay identically", () => {
  const events = [
    toolUse(), rej(), rej(), providerRequest(), rej(), rej(), providerRequest(), providerRequest(), toolOk(), visible(),
  ];
  const shadow = new S.StormShadow(settings);
  const written = [];
  let prev;
  for (const input of events) {
    const o = shadow.feed(input);
    if (S.shouldWriteStormShadowAudit(prev, o, input)) {
      prev = o;
      written.push({ input, o });
    }
  }
  const kinds = written.map((w) => `${w.input.kind}:${w.o.progress_basis}`);
  // Schema rejections (4), one pure-toolUse marker per segment (1), progress rows (2).
  assert.deepEqual(kinds, [
    "assistant_response:tool_use_only",
    "tool_execution_end:schema_rejection",
    "tool_execution_end:schema_rejection",
    "tool_execution_end:schema_rejection",
    "tool_execution_end:schema_rejection",
    "provider_request:provider_request",
    "tool_execution_end:successful_tool_response",
    "assistant_response:visible_assistant_response",
  ], JSON.stringify(kinds));
  // Replay: feeding only the written inputs reproduces the written verdicts exactly.
  const replayed = S.replayStormShadow(written.map((w) => w.input), settings);
  assert.equal(replayed.observations.length, written.length);
  for (let i = 0; i < written.length; i++) {
    const r = replayed.observations[i];
    const w = written[i].o;
    assert.equal(r.post_cap, w.post_cap, `row ${i} post_cap`);
    assert.equal(r.would_abort, w.would_abort, `row ${i} would_abort`);
    assert.equal(r.progress_basis, w.progress_basis, `row ${i} progress_basis`);
    assert.equal(r.consecutive_count, w.consecutive_count, `row ${i} consecutive_count`);
    assert.equal(r.window_count, w.window_count, `row ${i} window_count`);
    assert.equal(r.segment, w.segment, `row ${i} segment`);
    assert.equal(r.first_trip, w.first_trip, `row ${i} first_trip`);
    assert.equal(r.already_tripped, w.already_tripped, `row ${i} already_tripped`);
  }
});

await check("already_tripped episode marker is written once, then neutral events are skipped until state changes", () => {
  const events = [rej(), rej(), rej(), rej(), providerRequest(), providerRequest(), providerRequest(), providerRetry(), rej(A)];
  const shadow = new S.StormShadow(settings);
  const written = [];
  let prev;
  for (const input of events) {
    const o = shadow.feed(input);
    if (S.shouldWriteStormShadowAudit(prev, o, input)) {
      prev = o;
      written.push({ input, o });
    }
  }
  const markers = written.filter((w) => w.o.already_tripped);
  assert.equal(markers.length, 1, "exactly one already_tripped transition marker per episode");
  assert.equal(markers[0].input.kind, "provider_request");
  assert.equal(markers[0].o.would_abort, false);
});

console.log("\n[privacy + fail-open pre-projection]");

await check("identity checksum is recomputable and opaque; the exact identity never appears in the audit row", () => {
  const { observations } = run([rej(A1), rej(A2)]);
  assert.deepEqual(observations[0].identity_checksum, A1, "observation carries exactly the pre-projected keyless identity checksum");
  assert.deepEqual(observations[1].identity_checksum, A2, "collision pair keeps two distinct opaque checksums");
  assert.match(observations[0].identity_checksum?.digest ?? "", /^[0-9a-f]{64}$/);
  assert.equal(observations[0].identity_checksum?.algorithm, "sha256");
  assert.ok(!Object.hasOwn(observations[0].identity_checksum ?? {}, "key_id"), "keyless checksum must not carry a key_id");
  const row = S.buildStormShadowAuditEvent("worker-secret", {}, observations[0]);
  const serialized = JSON.stringify(row);
  const identity = "read\u0000missing_required\u0000path";
  assert.ok(!serialized.includes(identity), "plaintext identity must not be persisted");
  assert.ok(!serialized.includes("missing_required"), "closed error class must not be persisted as plaintext");
  assert.ok(!serialized.includes("\u0000"), "no NUL-joined identity fragments in the audit");
  assert.ok(!serialized.includes("must have required properties"), "normalized descriptor must not be persisted");
  assert.ok(!serialized.includes("Received arguments"), "raw error text must not be persisted");
});

await check("classifier fail-open: hostile result (throwing getters) degrades without throwing", () => {
  const throwing = { get content() { throw new Error("hostile getter"); } };
  const result = D.buildSchemaRejectionShadowInput(throwing, "read");
  assert.deepEqual(result, { schemaRejection: false, eligibility: "not_schema_rejection" }, "classifier throw must fail open to not-a-rejection");
  const proxy = new Proxy({}, { get() { throw new Error("hostile proxy"); } });
  assert.deepEqual(D.buildSchemaRejectionShadowInput(proxy, "read"), { schemaRejection: false, eligibility: "not_schema_rejection" });
  // A normal schema rejection still classifies deterministically.
  const normal = D.buildSchemaRejectionShadowInput(
    { content: [{ type: "text", text: "schema validation: required property 'path' is missing" }] },
    "read",
  );
  assert.equal(normal.schemaRejection, true);
  assert.equal(typeof normal.checksum?.digest, "string");
  const expected = AH.auditChecksumHex(
    S.STORM_SHADOW_CHECKSUM_DOMAIN,
    JSON.stringify(["read", "missing_required", "path", "schema validation: required property 'path' is missing"]),
  );
  assert.deepEqual(normal.checksum, expected, "wiring identity (tool + class + field + normalized) must be recomputable");
  // P1 regression: same tool/class/path with different normalized descriptors
  // (the real read tool's "Received arguments" JSON differs) must NOT merge.
  const realA = D.buildSchemaRejectionShadowInput(
    { content: [{ type: "text", text: "Validation failed for tool \"read\":\n  - path: must have required properties path\n\nReceived arguments:\n{}" }] },
    "read",
  );
  const realB = D.buildSchemaRejectionShadowInput(
    { content: [{ type: "text", text: "Validation failed for tool \"read\":\n  - path: must have required properties path\n\nReceived arguments:\n{\n  \"limit\": 5\n}" }] },
    "read",
  );
  assert.equal(realA.schemaRejection, true);
  assert.equal(realB.schemaRejection, true);
  assert.notEqual(realA.checksum?.digest, realB.checksum?.digest, "same class/path, different normalized must hash differently");
  assert.deepEqual(realA.checksum, A1, "wiring digest must equal the pre-projected A1 checksum");
  assert.deepEqual(realB.checksum, A2, "wiring digest must equal the pre-projected A2 checksum");
});

console.log("\n[keyless checksum cross-process stability]");

await check("keyless checksum is cross-process stable: two independent processes produce the same digest (no key material)", () => {
  const crossRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-storm-shadow-cross-"));
  const childScript = path.join(crossRoot, "checksum-child.mjs");
  const material = JSON.stringify(["read", "missing_required", "path", "schema validation: required property 'path' is missing"]);
  fs.writeFileSync(childScript, `
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
const root = ${JSON.stringify(root)};
const require = createRequire(pathToFileURL(path.join(root, "package.json")));
const { createJiti } = require("jiti");
const jiti = createJiti(pathToFileURL(path.join(root, "package.json")).href, { moduleCache: false });
const AH = await jiti.import(path.join(root, "extensions/_shared/audit-checksum.ts"));
const sig = AH.auditChecksumHex(${JSON.stringify(S.STORM_SHADOW_CHECKSUM_DOMAIN)}, ${JSON.stringify(material)});
console.log(JSON.stringify(sig));
`);
  const runChild = () => JSON.parse(execFileSync(process.execPath, [childScript], { encoding: "utf8" }).trim());
  try {
    const first = runChild();
    const second = runChild();
    assert.equal(first.digest, second.digest, "digest must be identical across independent processes");
    assert.equal(first.algorithm, "sha256");
    assert.ok(!Object.hasOwn(first, "key_id"), "keyless checksum must not carry a key_id");
    // No key file is ever created by the checksum path.
    assert.ok(!fs.existsSync(path.join(crossRoot, ".pi-astack")), "keyless checksum must never create key material");
  } finally {
    fs.rmSync(crossRoot, { recursive: true, force: true });
  }
});

await check("assistant pre-projection fail-open: hostile message degrades to the neutral view without throwing", () => {
  const proxy = new Proxy({}, { get() { throw new Error("hostile proxy"); } });
  assert.deepEqual(D.projectAssistantMessageViewSafe(proxy), {
    hasVisibleText: false, completed: false, errorResponse: false, emptyVisibleRetry: false, toolUseOnly: false,
  });
  assert.throws(() => D.projectAssistantMessageView(proxy), /hostile proxy/, "the raw projection itself may throw; the Safe wrapper is the wiring boundary");
  const real = D.projectAssistantMessageView({ stopReason: "stop", content: [{ type: "text", text: "  done  " }] });
  assert.equal(real.hasVisibleText, true);
  assert.equal(real.completed, true);
  const pureTool = D.projectAssistantMessageView({ stopReason: "toolUse", content: [{ type: "tool_use", name: "read" }] });
  assert.equal(pureTool.hasVisibleText, false);
  assert.equal(pureTool.toolUseOnly, true);
  assert.equal(pureTool.completed, false);
});

await check("malformed pre-projected inputs never throw and never count (schemaRejection without checksum)", () => {
  const shadow = new S.StormShadow(settings);
  const malformed = { kind: "tool_execution_end", isError: true, schemaRejection: true };
  const o = shadow.feed(malformed);
  assert.equal(o.consecutive_count, 0, "missing opaque checksum must not be eligible");
  assert.equal(o.post_cap, false);
  assert.equal(o.would_abort, false);
  const after = shadow.feed({ kind: "tool_execution_end", isError: true, schemaRejection: true, checksum: A });
  assert.equal(after.consecutive_count, 1, "a real checksum after the malformed input starts clean");
});

console.log("\n[source/behavior control-flow assertions]");

await check("storm-shadow.ts has no termination/abort/dispose/tool-cap surface and no crypto/raw-payload coupling", () => {
  const source = fs.readFileSync(path.join(root, "extensions/dispatch/storm-shadow.ts"), "utf8");
  for (const forbidden of [
    "requestGovernorTermination", "tryClaim", "AbortController", ".dispose(", ".abort(", "termination.",
    "createHmac", "randomBytes", "fs.", "event.message", "event.result",
  ]) {
    assert.ok(!source.includes(forbidden), `storm-shadow.ts must not reference ${forbidden}`);
  }
  // No audit-checksum call surface in the pure module (the wiring computes outside).
  assert.ok(!/auditChecksumHex\(/.test(source), "storm-shadow.ts must not call any audit-checksum API");
  for (const toolCap of ["toolCallCount", "tool_call_count", "totalToolCap", "total_tool_cap"]) {
    assert.ok(!source.includes(toolCap), `storm-shadow.ts must have no total tool cap: ${toolCap}`);
  }
  // The pure state machine only accepts pre-projected booleans / opaque checksums.
  assert.ok(source.includes("hasVisibleText") && source.includes("toolUseOnly"), "pre-projected assistant view fields present");
  assert.ok(source.includes("checksum?: OpaqueChecksum"), "opaque checksum input present");
});

await check("wiring computes the shadow identity checksum with the keyless audit-checksum API (no key material)", () => {
  const source = fs.readFileSync(path.join(root, "extensions/dispatch/index.ts"), "utf8");
  const start = source.indexOf("export function buildSchemaRejectionShadowInput");
  const end = source.indexOf("function appendUtf8Bounded");
  assert.ok(start > 0 && end > start, "buildSchemaRejectionShadowInput missing");
  const body = source.slice(start, end);
  assert.ok(body.includes("auditChecksumHex("), "shadow identity must use the keyless audit-checksum API");
  assert.ok(!body.includes("auditHmac"), "shadow identity path must never reference any HMAC API");
  assert.ok(!body.includes("ephemeral"), "shadow identity path must never mention/generate an ephemeral key");
  assert.ok(!body.includes("projectRoot"), "shadow identity must not depend on any project key material");
  // S2 retry fingerprint semantics are untouched: audit-v5 still uses the
  // keyless audit-checksum API for the retry error fingerprint.
  const auditV5 = fs.readFileSync(path.join(root, "extensions/dispatch/audit-v5.ts"), "utf8");
  assert.ok(auditV5.includes("auditChecksumHex("), "S2 retry fingerprint must keep its audit-checksum semantics");
});

await check("runInProcess routes shadow verdicts only to the audit sink, never to termination", () => {
  const source = fs.readFileSync(path.join(root, "extensions/dispatch/index.ts"), "utf8");
  const start = source.indexOf("const emitStormShadowAudit");
  const end = source.indexOf("if (effectiveMaxOutputTokens !== undefined)");
  assert.ok(start > 0 && end > start, "emitStormShadowAudit helper missing");
  const helper = source.slice(start, end);
  assert.ok(helper.includes("appendDispatchAudit"), "shadow sink must append to the dispatch audit");
  for (const forbidden of ["requestGovernorTermination", "tryClaim", ".abort(", ".dispose(", "emitWorkerRunDecision"]) {
    assert.ok(!helper.includes(forbidden), `shadow sink must not reach ${forbidden}`);
  }
  // The real governor abort path is intact and untouched (never hidden).
  assert.match(source, /if \(decision\.mode === "abort"\) requestGovernorTermination\(decision\);/);
  assert.ok(source.includes('signal: "full_output_cap_hit"'), "real full_output_cap_hit path still present");
});

await check("shadow feed sites are fail-open and pre-project safe fields only (no raw event payloads)", () => {
  const source = fs.readFileSync(path.join(root, "extensions/dispatch/index.ts"), "utf8");
  // Fail-open boundaries: classifier + checksum, assistant projection, feed+audit.
  assert.match(source, /const shadowFeed = \(input: StormShadowEventInput\): StormShadowObservation \| undefined => \{[\s\S]*?try \{[\s\S]*?stormShadow\.feed\(input\)[\s\S]*?\} catch \{/);
  assert.match(source, /buildSchemaRejectionShadowInput\(event\.result, event\.toolName\)/);
  assert.match(source, /projectAssistantMessageViewSafe\(event\.message\)/);
  assert.match(source, /const shadowFeed = \(input[\s\S]{0,400}shouldWriteStormShadowAudit/);
  // The raw event payloads never reach the state machine.
  assert.ok(!/stormShadow\.feed\([\s\S]{0,120}event\.result/.test(source));
  assert.ok(!/stormShadow\.feed\([\s\S]{0,120}event\.args/.test(source));
  assert.ok(!/stormShadow\.feed\([\s\S]{0,120}event\.message/.test(source));
  assert.ok(!/stormShadow\.feed\([\s\S]{0,120}errorMessage/.test(source));
});

console.log("\n[1000 tool observations never terminate via a total cap]");

await check("1000 rotating-signature rejections and successes keep governor and shadow non-terminal (no total tool cap)", () => {
  const governor = new G.WorkerRunGovernor("storm-tool-volume", G.DEFAULT_WORKER_RUN_GOVERNOR_SETTINGS, root);
  const shadow = new S.StormShadow(settings);
  const signatures = [A, B, C, sig("ls", "missing_required", "path", "schema validation: required property 'path' is missing"), sig("grep", "invalid_type", "pattern", "schema validation: expected string for property 'pattern'")];
  let tripCount = 0;
  for (let i = 0; i < 1000; i++) {
    governor.observeToolStart("read", { path: `src/f${i % 17}.ts`, offset: 1, limit: 40 }, `t-${i}`);
    if (i % 4 === 0) {
      governor.observeToolEnd("read", { content: [{ type: "text", text: "ok" }] }, false, `t-${i}`);
      shadow.feed(toolOk());
    } else {
      governor.observeToolEnd("read", { content: [{ type: "text", text: "schema validation: required property 'x' is missing" }] }, true, `t-${i}`);
      shadow.feed(rej(signatures[i % signatures.length]));
    }
    if (shadow.snapshot().tripped) tripCount++;
  }
  assert.equal(governor.terminalDecision, undefined, "1000 tool calls must not terminate the governor");
  assert.equal(governor.snapshot().counters.tool_call_count, 1000);
  assert.ok(!governor.snapshot().terminal, "no governor terminal after 1000 tool observations");
  assert.equal(tripCount, 0, "no same-signature density across 1000 rotating tools (no total cap, no cross-signature merge)");
  const after = shadow.snapshot();
  assert.equal(after.segment > 0, true, "successful tools kept progressing segments");
});

console.log("\n[real SDK runInProcess + faux provider wiring]");

const sdkTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-storm-shadow-sdk-"));
fs.writeFileSync(path.join(sdkTempRoot, "ok.txt"), "hello storm shadow\n");
const codingAgentDist = path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const compatPath = path.join(codingAgentDist, "../node_modules/@earendil-works/pi-ai/dist/compat.js");
const Faux = await import(pathToFileURL(compatPath).href);
const sdkModelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
const sdkFaux = Faux.registerFauxProvider({
  provider: "faux-storm-shadow",
  tokensPerSecond: 0,
  models: [{ id: "storm-shadow-1", name: "Storm Shadow Faux", maxTokens: 16384 }],
});
const sdkFauxModel = sdkFaux.getModel();
sdkModelRuntime.registerProvider(sdkFauxModel.provider, {
  baseUrl: sdkFauxModel.baseUrl,
  api: sdkFauxModel.api,
  apiKey: "offline-smoke-key",
  authHeader: true,
  models: [{
    id: sdkFauxModel.id,
    name: sdkFauxModel.name,
    api: sdkFauxModel.api,
    reasoning: false,
    input: ["text", "image"],
    cost: sdkFauxModel.cost,
    contextWindow: sdkFauxModel.contextWindow,
    maxTokens: sdkFauxModel.maxTokens,
  }],
});
const sdkRegistry = new ModelRegistry(sdkModelRuntime);
const sdkModelName = `${sdkFauxModel.provider}/${sdkFauxModel.id}`;

const realRun = {
  runId: "dtr-storm-shadow-real",
  callId: "call-storm-shadow-real",
  sessionId: "session-storm-shadow-real",
};
let realRows = [];
let realResult = null;

// S4 STORM-ENFORCE is enabled by default; this S3 shadow-only proof must run
// with enforce disabled so would_abort verdicts provably never change control
// flow (the S4 smoke covers the authorized consecutive-branch abort). The
// settings override is scoped to this process via a temp HOME.
const shadowOnlyHome = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-storm-shadow-home-"));
const shadowOnlyAgentDir = path.join(shadowOnlyHome, ".pi", "agent");
fs.mkdirSync(shadowOnlyAgentDir, { recursive: true });
fs.writeFileSync(path.join(shadowOnlyAgentDir, "pi-astack-settings.json"), JSON.stringify({
  dispatch: { workerRunGovernor: { toolObservers: { schemaErrorStorm: { enforceConsecutiveExact: false } } } },
}));
const prevHome = process.env.HOME;
const prevUserprofile = process.env.USERPROFILE;
process.env.HOME = shadowOnlyHome;
process.env.USERPROFILE = shadowOnlyHome;

try {
  await check("real SDK: same-run collision pair never merges, then 4 same exact identity rejections reach would_abort=true (first_trip); worker continues and completes normally", async () => {
    // The SAME real event stream, all in one run:
    //   1. read({})            → schema rejection A1 (missing_required/"must"/norm1)
    //   2. read({limit: 5})    → schema rejection A2 (SAME class/path, DIFFERENT
    //                            normalized — the "Received arguments" JSON differs)
    //                            → collision pair must NOT merge (P1 regression)
    //   3. read(ok)            → successful tool → progress reset (segment 1)
    //   4-7. read({}) ×4       → same exact identity A1 → 4th trips (would_abort=true)
    //   8. read(ok)            → successful tool → progress reset (segment 2)
    //   9. final visible completion
    sdkFaux.setResponses([
      Faux.fauxAssistantMessage([Faux.fauxToolCall("read", {})], { stopReason: "toolUse" }),
      Faux.fauxAssistantMessage([Faux.fauxToolCall("read", { limit: 5 })], { stopReason: "toolUse" }),
      Faux.fauxAssistantMessage([Faux.fauxToolCall("read", { path: "ok.txt", limit: 5 })], { stopReason: "toolUse" }),
      Faux.fauxAssistantMessage([Faux.fauxToolCall("read", {})], { stopReason: "toolUse" }),
      Faux.fauxAssistantMessage([Faux.fauxToolCall("read", {})], { stopReason: "toolUse" }),
      Faux.fauxAssistantMessage([Faux.fauxToolCall("read", {})], { stopReason: "toolUse" }),
      Faux.fauxAssistantMessage([Faux.fauxToolCall("read", {})], { stopReason: "toolUse" }),
      Faux.fauxAssistantMessage([Faux.fauxToolCall("read", { path: "ok.txt", limit: 5 })], { stopReason: "toolUse" }),
      Faux.fauxAssistantMessage("final normal completion"),
    ]);
    const dispatchTrace = DT.createDispatchTraceSink({
      runId: realRun.runId,
      parentSessionId: realRun.sessionId,
      parentToolCallId: realRun.callId,
      taskIndex: 0,
    });
    realResult = await D.runInProcess(
      sdkModelName, "off", "execute the scripted storm", new AbortController().signal, 8000, sdkRegistry, "read",
      {
        projectRoot: sdkTempRoot,
        parentContextFiles: [],
        maxRuntimeMs: 20000,
        reasoningTrace: { dispatchToolCallId: realRun.callId, taskIndex: 0, taskCount: 1 },
        dispatchTrace,
      },
    );
    // would_abort=true fired INSIDE the run and the worker still completed
    // normally — shadow verdicts never changed control flow.
    assert.equal(realResult.error, undefined, JSON.stringify(realResult.error));
    assert.equal(realResult.failureType, undefined, JSON.stringify(realResult.failureType));
    assert.equal(realResult.output, "final normal completion", JSON.stringify(realResult.output));
    assert.equal(realResult.toolCallCount, 8, JSON.stringify(realResult.toolCallCount));
    assert.equal(realResult.terminationClosure?.termination_owner, "run", JSON.stringify(realResult.terminationClosure));
    assert.equal(realResult.terminationClosure?.lifecycle_path, "normal", JSON.stringify(realResult.terminationClosure));
    assert.equal(realResult.terminationClosure?.cleanup_done, true, JSON.stringify(realResult.terminationClosure));

    const auditPath = path.join(sdkTempRoot, ".pi-astack", "dispatch", "audit.jsonl");
    assert.ok(fs.existsSync(auditPath), `audit.jsonl missing at ${auditPath}`);
    // Wait for the run's task row (written after every worker event row) so the
    // full shadow sequence — including the post-trip progress/visible rows — is
    // flushed before assertions; breaking on the would_abort row alone races
    // the async audit append chain.
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      realRows = fs.readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      if (realRows.some((row) => row.dispatch_run_id === realRun.runId && row.row_kind === "task")) break;
      await sleep(25);
    }
    const shadowRows = realRows.filter((row) => row.signal === "storm_shadow" && row.dispatch_run_id === realRun.runId);
    const rejections = shadowRows.filter((row) => row.event_kind === "tool_execution_end" && row.progress_basis === "schema_rejection");
    assert.equal(rejections.length, 6, `expected 6 schema-rejection rows, got ${JSON.stringify(shadowRows.map((r) => [r.event_kind, r.progress_basis, r.consecutive_count, r.would_abort]))}`);
    // Collision pair (rows 0-1): same tool/class/path, different normalized →
    // two distinct digests, each count 1, never trip (P1 regression).
    assert.notEqual(rejections[0].identity_checksum?.digest, rejections[1].identity_checksum?.digest, "collision pair must NOT merge into one identity");
    assert.equal(rejections[0].consecutive_count, 1);
    assert.equal(rejections[1].consecutive_count, 1);
    assert.equal(rejections[0].would_abort, false);
    assert.equal(rejections[1].would_abort, false);
    assert.equal(rejections[0].segment, 0, "collision pair lives in segment 0");
    assert.equal(rejections[1].segment, 0);
    // Then 4 same exact identity rejections (rows 2-5): the 4th trips.
    assert.deepEqual(rejections.map((r) => r.consecutive_count), [1, 1, 1, 2, 3, 4]);
    assert.deepEqual(rejections.map((r) => r.post_cap), [false, false, false, false, true, true], "cap boundary reached at observeAfter, no abort");
    assert.deepEqual(rejections.map((r) => r.would_abort), [false, false, false, false, false, true], "exceeding the cap on the 4th same exact identity produces would_abort");
    assert.deepEqual(rejections.map((r) => r.first_trip), [false, false, false, false, false, true]);
    assert.equal(rejections[5].would_abort_basis, "consecutive");
    assert.equal(rejections[5].cap_after, 3, "cap_after mirrors governor observeAfter");
    assert.equal(rejections[2].segment, 1, "the 4 same exact identity rejections live in segment 1 (after the progress reset)");
    const digests = new Set(rejections.map((r) => r.identity_checksum?.digest));
    assert.equal(digests.size, 2, `expected exactly 2 distinct opaque checksums (A1 ×5 + A2 ×1), got ${digests.size}`);
    const a1Rows = rejections.filter((r) => r.identity_checksum?.digest === rejections[0].identity_checksum?.digest);
    const a2Rows = rejections.filter((r) => r.identity_checksum?.digest === rejections[1].identity_checksum?.digest);
    assert.equal(a1Rows.length, 5, "A1 (read({})) appears 5 times");
    assert.equal(a2Rows.length, 1, "A2 (read({limit:5})) appears once and never merges into A1");
    for (const row of rejections) {
      assert.equal(row.worker_run_id, realResult.workerRunGovernance?.worker_run_id);
      assert.equal(row.row_kind, "worker_run_shadow_event");
      assert.equal(row.counterfactual_action, "would_abort_only_no_control_effect");
      assert.equal(row.mode, "observe");
      assert.equal(row.rule_version, "dispatch-storm-shadow/v5");
      assert.equal(row.rule_id, "storm/post-cap-schema-rejection-signature/v1");
      assert.match(row.identity_checksum?.digest ?? "", /^[0-9a-f]{64}$/);
    }
    // Pure toolUse assistant messages are classified neutral (never progress) —
    // the toolUse-miscount fix, visible in the real audit as one marker per segment.
    const toolUseMarkers = shadowRows.filter((row) => row.progress_basis === "tool_use_only");
    assert.ok(toolUseMarkers.length >= 1, `expected at least one tool_use_only marker, got ${toolUseMarkers.length}`);
    assert.ok(toolUseMarkers.every((row) => row.progress_verdict === "not_progress"), "toolUse must never be progress");
    // After the trip, a neutral provider_request is marked already_tripped with
    // would_abort=false (anti-sticky) and no other provider_request rows exist.
    const providerRows = shadowRows.filter((row) => row.event_kind === "provider_request");
    assert.equal(providerRows.length, 1, `expected exactly 1 already-tripped provider_request marker, got ${providerRows.length}`);
    assert.equal(providerRows[0].already_tripped, true);
    assert.equal(providerRows[0].would_abort, false);
    // Progress rows: the first successful read reset the candidate (segment 1),
    // then the final visible completion advanced the segment again (segment 2).
    const successRow = shadowRows.find((row) => row.progress_basis === "successful_tool_response");
    assert.ok(successRow, "successful tool row missing");
    assert.equal(successRow.segment, 1, JSON.stringify(successRow));
    const finalRow = shadowRows.find((row) => row.progress_basis === "visible_assistant_response");
    assert.ok(finalRow, "final visible completion row missing");
    assert.equal(finalRow.segment, 3, JSON.stringify(finalRow));
    // Bounded: total shadow rows << total real events (9 provider requests +
    // 10 assistant messages + 8 tool ends ≈ 27 events; row budget ≈ 11).
    assert.ok(shadowRows.length <= 12, `shadow rows=${shadowRows.length} should stay bounded (${JSON.stringify(shadowRows.map((r) => [r.event_kind, r.progress_basis]))})`);
    // The real governor schemaErrorStorm observer still fired observe-only and
    // its counters advanced — untouched by the shadow.
    assert.equal(realResult.workerRunGovernance?.counters?.schema_error_storm_count, 2, "governor still counts the storm (observe-only)");
    const govStorm = realRows.filter((row) => row.signal === "schema_error_storm");
    assert.ok(govStorm.length >= 1 && govStorm.every((row) => row.mode === "observe"), "governor schema_error_storm stays observe-only");
  });

  await check("real SDK: audit replayable — replaying the written rows' inputs reproduces the written verdicts exactly", async () => {
    const shadowRows = realRows.filter((row) => row.signal === "storm_shadow" && row.dispatch_run_id === realRun.runId);
    assert.ok(shadowRows.length >= 6, "no shadow rows to replay (previous check failed)");
    const inputs = shadowRows.map((row) => {
      if (row.progress_basis === "schema_rejection") {
        return { kind: "tool_execution_end", isError: true, schemaRejection: true, checksum: row.identity_checksum };
      }
      if (row.progress_basis === "successful_tool_response" || row.progress_basis === "failed_tool_response") {
        return { kind: "tool_execution_end", isError: row.progress_basis === "failed_tool_response", schemaRejection: false };
      }
      if (row.progress_basis === "tool_use_only") {
        return { kind: "assistant_response", hasVisibleText: false, completed: false, errorResponse: false, emptyVisibleRetry: false, toolUseOnly: true };
      }
      if (row.progress_basis === "visible_assistant_response") {
        return { kind: "assistant_response", hasVisibleText: true, completed: true, errorResponse: false, emptyVisibleRetry: false, toolUseOnly: false };
      }
      return { kind: "provider_request" };
    });
    const replayed = S.replayStormShadow(inputs, settings);
    assert.equal(replayed.observations.length, shadowRows.length);
    for (let i = 0; i < shadowRows.length; i++) {
      const r = replayed.observations[i];
      const row = shadowRows[i];
      assert.equal(r.post_cap, row.post_cap, `row ${i} post_cap`);
      assert.equal(r.would_abort, row.would_abort, `row ${i} would_abort`);
      assert.equal(r.progress_basis, row.progress_basis, `row ${i} progress_basis`);
      assert.equal(r.consecutive_count, row.consecutive_count, `row ${i} consecutive_count`);
      assert.equal(r.window_count, row.window_count, `row ${i} window_count`);
      assert.equal(r.segment, row.segment, `row ${i} segment`);
      assert.equal(r.first_trip, row.first_trip, `row ${i} first_trip`);
      assert.equal(r.already_tripped, row.already_tripped, `row ${i} already_tripped`);
    }
  });

  await check("real SDK: audit contains no raw identity / field path / normalized / tool args", async () => {
    const serialized = JSON.stringify(realRows.filter((row) => row.signal === "storm_shadow"));
    assert.ok(!serialized.includes("\u0000"), "no NUL-joined identity fragments");
    assert.ok(!serialized.includes("missing_required"), "closed error class is never persisted as plaintext");
    assert.ok(!serialized.includes("must have required properties"), "normalized descriptor is never persisted as plaintext");
    assert.ok(!serialized.includes("Received arguments"), "raw error text is never persisted");
    const secretFile = "ok.txt";
    assert.ok(!serialized.includes(secretFile), "tool args must not leak into shadow rows");
    for (const row of realRows.filter((r) => r.signal === "storm_shadow")) {
      if (row.identity_checksum) {
        assert.match(row.identity_checksum.digest, /^[0-9a-f]{64}$/);
        assert.equal(row.identity_checksum.algorithm, "sha256");
        assert.ok(!Object.hasOwn(row.identity_checksum, "key_id"), "keyless checksum must not carry a key_id");
      }
    }
  });
} finally {
  process.env.HOME = prevHome;
  process.env.USERPROFILE = prevUserprofile;
  fs.rmSync(shadowOnlyHome, { recursive: true, force: true });
  sdkFaux.unregister();
  sdkModelRuntime.unregisterProvider(sdkFauxModel.provider);
  fs.rmSync(sdkTempRoot, { recursive: true, force: true });
}

try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}

console.log();
if (failures.length === 0) {
  console.log(`PASS - ${passed} dispatch storm-shadow checks`);
  process.exit(0);
}
console.error(`FAIL - ${failures.length} of ${passed + failures.length} checks failed`);
for (const { name, error } of failures) console.error(`  ${name}: ${error instanceof Error ? error.stack : String(error)}`);
process.exit(1);
