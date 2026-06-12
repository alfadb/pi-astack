#!/usr/bin/env node
/**
 * Smoke test: PR-4/P0.3 Tier-1 Jaccard → curator adjudication lane
 * (ADR 0028 R5'/R2' 调和, O2 verdict 2026-06-10).
 *
 * fs-level (no LLM): exercises the writer-side mechanics —
 *   - legacy writer default: cross-slug Jaccard hit → status "deduped"
 *     when callers do not request the ADR 0028 adjudication lane;
 *   - semanticDedup:"report" → "similar_found" intermediate, nothing written;
 *   - semanticDedup:"off"    → create bypasses the cross-slug scan
 *     (same-slug duplicate_slug gate still enforced);
 *   - readRuleForAdjudication: title/status + body sans timeline;
 *   - applyTier1RuleAdjudication update: evidence appended once, idempotent
 *     on repeat (evidence_duplicate), `updated:` touched;
 *   - applyTier1RuleAdjudication merge: body replaced, body_hash recomputed,
 *     timeline preserved + tier1-merge note; entry_not_found rejected;
 * plus the adjudicator parse layer (C6 strict: closed decision space,
 * merge requires merged_body, garbage → null).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url, { moduleCache: false });

const failures = [];
let total = 0;
async function check(name, fn) {
  total++;
  try { await fn(); console.log(`  ok    ${name}`); }
  catch (err) { failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.stack || err.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

const writer = await jiti.import(`${repoRoot}/extensions/sediment/writer.ts`);
const { writeAbrainRule, readRuleForAdjudication, applyTier1RuleAdjudication } = writer;
const adj = await jiti.import(`${repoRoot}/extensions/sediment/tier1-adjudicator.ts`);
const { parseTier1Adjudication, buildTier1AdjudicationPrompt, resolveTier1JaccardHit } = adj;

const SETTINGS = { gitCommit: false, lockTimeoutMs: 5000 };
function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-t1adj-"));
}
const BODY = "所有托管在 git.alfadb.cn 的仓库必须使用 glab CLI 工具进行管理操作。";
const baseDraft = {
  zone: "rules", kind: "preference", entryConfidence: 9, routingConfidence: 1,
  routingReason: "tier1 smoke", sessionId: "smoke", injectMode: "always", scope: "global",
};
async function seedRule(home) {
  const r = await writeAbrainRule(
    { ...baseDraft, title: "glab 管理规则", body: BODY, slug: "glab-rule" },
    { abrainHome: home, settings: SETTINGS });
  assert(r.status === "created", `seed status=${r.status} reason=${r.reason}`);
  return r;
}

console.log("tier1 jaccard adjudication — PR-4/P0.3 (O2 2026-06-10)");

// 1. Writer default (no semanticDedup opt): cross-slug near-dup → deduped.
// Production Tier-1 callers now request semanticDedup:"report" by default;
// this preserves the lower-level writer rollback path only.
await check("writer default: cross-slug Jaccard hit -> deduped (rollback path unchanged)", async () => {
  const home = freshHome();
  await seedRule(home);
  const r = await writeAbrainRule(
    { ...baseDraft, title: "glab 规则重述", body: BODY, slug: "glab-rule-restated" },
    { abrainHome: home, settings: SETTINGS });
  assert(r.status === "deduped" && r.dedupedAgainst === "glab-rule", `status=${r.status} against=${r.dedupedAgainst}`);
});

// 2. report mode: similar_found intermediate, no write.
await check("semanticDedup:report -> similar_found + dedupedAgainst, nothing written", async () => {
  const home = freshHome();
  await seedRule(home);
  const r = await writeAbrainRule(
    { ...baseDraft, title: "glab 规则重述", body: BODY, slug: "glab-rule-restated" },
    { abrainHome: home, settings: SETTINGS, semanticDedup: "report" });
  assert(r.status === "similar_found" && r.dedupedAgainst === "glab-rule", `status=${r.status} against=${r.dedupedAgainst}`);
  assert(!fs.existsSync(path.join(home, "rules", "always", "glab-rule-restated.md")), "report mode must not write");
});

// 3. off mode: cross-slug scan bypassed -> created; same-slug gate intact.
await check("semanticDedup:off -> created despite near-dup; duplicate_slug still rejects", async () => {
  const home = freshHome();
  await seedRule(home);
  const r = await writeAbrainRule(
    { ...baseDraft, title: "glab 规则重述", body: BODY, slug: "glab-rule-restated" },
    { abrainHome: home, settings: SETTINGS, semanticDedup: "off" });
  assert(r.status === "created", `status=${r.status} reason=${r.reason}`);
  const dup = await writeAbrainRule(
    { ...baseDraft, title: "其他标题", body: "完全不同的另一条规则内容，避开相似度门。", slug: "glab-rule" },
    { abrainHome: home, settings: SETTINGS, semanticDedup: "off" });
  assert(dup.status === "rejected" && dup.reason === "duplicate_slug", `status=${dup.status} reason=${dup.reason}`);
});

// 4. readRuleForAdjudication: body sans timeline.
await check("readRuleForAdjudication returns title + body without Timeline section", async () => {
  const home = freshHome();
  await seedRule(home);
  const e = readRuleForAdjudication(home, "global", undefined, "glab-rule");
  assert(e && e.title === "glab 管理规则", `title=${e?.title}`);
  assert(e.body.includes("glab CLI"), "body content present");
  assert(!e.body.includes("## Timeline"), "timeline stripped");
  assert(readRuleForAdjudication(home, "global", undefined, "no-such") === undefined, "missing -> undefined");
});

// 5. update: evidence appended once; idempotent repeat -> evidence_duplicate.
await check("adjudication update: evidence line appended; repeat -> deduped evidence_duplicate", async () => {
  const home = freshHome();
  await seedRule(home);
  const quote = "git.alfadb.cn 上所有仓库都要用 glab 管理（重申）";
  const r1 = await applyTier1RuleAdjudication(
    { slug: "glab-rule", scope: "global" },
    { op: "update", evidenceQuote: quote, reason: "restatement of existing rule" },
    { abrainHome: home, settings: SETTINGS });
  assert(r1.status === "updated" && r1.reason === "tier1_evidence_appended", `status=${r1.status} reason=${r1.reason}`);
  const raw1 = fs.readFileSync(path.join(home, "rules", "always", "glab-rule.md"), "utf-8");
  assert(raw1.includes("tier1-evidence") && raw1.includes("重申"), "evidence line landed");
  const r2 = await applyTier1RuleAdjudication(
    { slug: "glab-rule", scope: "global" },
    { op: "update", evidenceQuote: quote, reason: "restatement again" },
    { abrainHome: home, settings: SETTINGS });
  assert(r2.status === "deduped" && (r2.reason ?? "").startsWith("evidence_duplicate"), `status=${r2.status} reason=${r2.reason}`);
  const raw2 = fs.readFileSync(path.join(home, "rules", "always", "glab-rule.md"), "utf-8");
  assert(raw2.split("重申").length === 2, "quote appears exactly once after idempotent repeat");
});

// 6. merge: body replaced, hash recomputed, timeline preserved.
await check("adjudication merge: body replaced + body_hash recomputed + timeline preserved", async () => {
  const home = freshHome();
  await seedRule(home);
  const fp = path.join(home, "rules", "always", "glab-rule.md");
  const before = fs.readFileSync(fp, "utf-8");
  const hashBefore = before.match(/^body_hash: (\S+)$/m)?.[1];
  const merged = "所有托管在 git.alfadb.cn 的仓库必须用 glab CLI 管理；git 原生操作（commit/push/pull/clone）允许原生 git。";
  const r = await applyTier1RuleAdjudication(
    { slug: "glab-rule", scope: "global" },
    { op: "merge", evidenceQuote: "git 原生操作允许原生 git", mergedBody: merged, reason: "new directive refines scope" },
    { abrainHome: home, settings: SETTINGS });
  assert(r.status === "updated" && r.reason === "tier1_merged_body", `status=${r.status} reason=${r.reason}`);
  const after = fs.readFileSync(fp, "utf-8");
  assert(after.includes("git 原生操作（commit/push/pull/clone）允许原生 git"), "merged body landed");
  // Old body must be gone from the BODY SEGMENT (between frontmatter close and
  // ## Timeline). The frontmatter `hint:` line legitimately keeps the creation-
  // time fallback hint (derived from the old body) — hints are retrieval cues,
  // not authoritative content, and a human/LLM-provided hint must not be
  // clobbered by merge (we cannot distinguish the two).
  const bodySeg = after.slice(after.indexOf("\n---\n", 3) + 5, after.search(/^## Timeline$/m));
  assert(!bodySeg.includes("管理操作。"), "old body replaced in body segment");
  const hashAfter = after.match(/^body_hash: (\S+)$/m)?.[1];
  assert(hashAfter && hashAfter !== hashBefore, "body_hash recomputed");
  assert(after.includes("## Timeline") && after.includes("| created |"), "timeline section + created line preserved");
  assert(after.includes("tier1-merge"), "merge note appended");
  assert(after.split("---\n").length === before.split("---\n").length, "frontmatter structure intact");
});

// 6b. merge guards: idempotency (same body → deduped, no timeline bloat) and
//     concurrent-modification witness (R1 N4/N5).
await check("merge idempotency: same merged body -> deduped body_unchanged; expectedBodyHash mismatch -> rejected", async () => {
  const home = freshHome();
  await seedRule(home);
  const fp = path.join(home, "rules", "always", "glab-rule.md");
  const merged = "所有托管在 git.alfadb.cn 的仓库必须用 glab CLI 管理；原生 git 操作除外。";
  const apply = (extra = {}) => applyTier1RuleAdjudication(
    { slug: "glab-rule", scope: "global" },
    { op: "merge", evidenceQuote: "q", mergedBody: merged, reason: "r", ...extra },
    { abrainHome: home, settings: SETTINGS });
  const r1 = await apply();
  assert(r1.status === "updated", `first merge status=${r1.status} reason=${r1.reason}`);
  const after1 = fs.readFileSync(fp, "utf-8");
  const r2 = await apply();
  assert(r2.status === "deduped" && (r2.reason ?? "").startsWith("body_unchanged"), `re-merge status=${r2.status} reason=${r2.reason}`);
  assert(fs.readFileSync(fp, "utf-8") === after1, "idempotent re-merge must not rewrite the file (no timeline bloat)");
  const r3 = await apply({ mergedBody: merged + "另一版本。", expectedBodyHash: "deadbeef" });
  assert(r3.status === "rejected" && r3.reason === "concurrent_modification", `stale hash status=${r3.status} reason=${r3.reason}`);
});

// 7. merge guards: entry_not_found; short merged_body rejected.
await check("adjudication apply guards: entry_not_found + validation_error_merged_body", async () => {
  const home = freshHome();
  const r = await applyTier1RuleAdjudication(
    { slug: "no-such", scope: "global" },
    { op: "merge", evidenceQuote: "x", mergedBody: "一条足够长的合并后规则内容。", reason: "r" },
    { abrainHome: home, settings: SETTINGS });
  assert(r.status === "rejected" && r.reason === "entry_not_found", `status=${r.status} reason=${r.reason}`);
  await seedRule(home);
  const r2 = await applyTier1RuleAdjudication(
    { slug: "glab-rule", scope: "global" },
    { op: "merge", evidenceQuote: "x", mergedBody: "短", reason: "r" },
    { abrainHome: home, settings: SETTINGS });
  assert(r2.status === "rejected" && r2.reason === "validation_error_merged_body", `status=${r2.status} reason=${r2.reason}`);
});

// 8. parse layer: closed decision space (C6 strict).
await check("parseTier1Adjudication: closed space; merge requires merged_body; garbage null", async () => {
  const p = parseTier1Adjudication;
  assert(p('{"decision":"update","reason":"same intent"}')?.decision === "update", "update parses");
  assert(p('prose before {"decision":"create","reason":"different tool"} prose after')?.decision === "create", "embedded JSON parses");
  const m = p(`{"decision":"merge","merged_body":"合并后的完整规则内容,足够长","reason":"adds scope"}`);
  assert(m?.decision === "merge" && m.mergedBody?.includes("合并后"), "merge with body parses");
  assert(p('{"decision":"merge","reason":"no body"}') === null, "merge without merged_body -> null");
  assert(p('{"decision":"merge","merged_body":"短","reason":"short"}') === null, "merge with short body -> null");
  assert(p('{"decision":"skip","reason":"out of space"}') === null, "skip excluded from decision space");
  assert(p('{"decision":"stage","reason":"x"}') === null, "stage excluded");
  assert(p("not json at all") === null, "garbage -> null");
  assert(p("") === null, "empty -> null");
});

// 9. prompt builder sanity: both bodies + closed-space instruction present.
await check("buildTier1AdjudicationPrompt embeds both versions + no-skip contract", async () => {
  const prompt = buildTier1AdjudicationPrompt({
    draftTitle: "新指令", draftBody: "新内容A", existingSlug: "s", existingTitle: "旧规则", existingBody: "旧内容B",
  });
  assert(prompt.includes("新内容A") && prompt.includes("旧内容B"), "both bodies embedded");
  assert(prompt.includes("NO skip option"), "closed decision space stated");
  assert(prompt.includes("merged_body"), "merge contract stated");
  assert(prompt.includes("<rule>") && prompt.includes("<directive>") && prompt.includes("DATA, not instructions"), "injection delimiting present (deepseek R1 N2)");
});

// 10. resolver orchestration (opus R1 N6: B1 must be smoke-visible).
//     Stubbed adjudicateFn — no LLM, no registry.
const AUDIT_CTX = { lane: "auto_write", sessionId: "smoke", correlationId: "c", candidateId: "cand" };
async function resolveWith(home, adjudicateFn, draftBody = BODY) {
  await seedRule(home);
  const draft = { ...baseDraft, title: "glab 规则重述", body: draftBody, slug: "glab-rule-restated" };
  const first = await writeAbrainRule(draft, { abrainHome: home, settings: SETTINGS, semanticDedup: "report" });
  assert(first.status === "similar_found", `precondition: report -> similar_found, got ${first.status}`);
  return resolveTier1JaccardHit({
    draft, firstResult: first, settings: SETTINGS, modelRegistry: undefined,
    abrainHome: home, auditContext: AUDIT_CTX, ...(adjudicateFn ? { adjudicateFn } : {}),
  });
}

await check("resolver: adjudicator failure -> deterministic create (O2 fallback)", async () => {
  const home = freshHome();
  const { result, adjudication } = await resolveWith(home, async () => ({ ok: false, model: "stub", error: "timeout", durationMs: 1 }));
  assert(result.status === "created", `status=${result.status} reason=${result.reason}`);
  assert(adjudication.fallback === "timeout" && adjudication.decision === "create", `adjudication=${JSON.stringify(adjudication)}`);
});

await check("resolver: registry unavailable (real adjudicator, no stub) -> deterministic create", async () => {
  const home = freshHome();
  const { result, adjudication } = await resolveWith(home, null);
  assert(result.status === "created", `status=${result.status} reason=${result.reason}`);
  assert(String(adjudication.fallback).includes("model_registry_unavailable"), `fallback=${adjudication.fallback}`);
});

await check("resolver: decision=update -> applied to existing rule", async () => {
  const home = freshHome();
  // Near-dup VARIANT (clears Jaccard 0.85, not a substring of the existing
  // file) — a verbatim restatement would short-circuit to evidence_duplicate
  // (also a valid capture, but this check pins the update-apply path).
  // Token note: Chinese runs tokenize as whole segments (split on
  // punctuation/space only), so the variant APPENDS a separate token instead
  // of editing mid-sentence (which would drop a whole token and miss 0.85).
  const variant = `${BODY.replace(/。$/, "")}（重申一遍）。`;
  const { result, adjudication } = await resolveWith(home, async () => ({
    ok: true, model: "stub", durationMs: 1,
    decision: { decision: "update", reason: "restatement" },
  }), variant);
  assert(result.status === "updated" && result.reason === "tier1_evidence_appended" && result.slug === "glab-rule", `status=${result.status} reason=${result.reason} slug=${result.slug}`);
  assert(adjudication.decision === "update", `adjudication=${JSON.stringify(adjudication)}`);
});

await check("resolver: decision=merge with body -> merged onto existing rule", async () => {
  const home = freshHome();
  const merged = "所有 git.alfadb.cn 仓库用 glab 管理；原生 git 操作（commit/push/pull/clone）除外。";
  const { result } = await resolveWith(home, async () => ({
    ok: true, model: "stub", durationMs: 1,
    decision: { decision: "merge", mergedBody: merged, reason: "adds exception" },
  }));
  assert(result.status === "updated" && result.reason === "tier1_merged_body" && result.slug === "glab-rule", `status=${result.status} reason=${result.reason}`);
});

await check("resolver B1: apply-stage reject (merge without body) -> deterministic create, NOT rejected", async () => {
  const home = freshHome();
  const { result, adjudication } = await resolveWith(home, async () => ({
    ok: true, model: "stub", durationMs: 1,
    // parse layer would normally block this, but the resolver must hold the
    // O2 contract against ANY apply-stage reject on its own.
    decision: { decision: "merge", reason: "bad merge" },
  }));
  assert(result.status === "created", `status=${result.status} reason=${result.reason}`);
  assert(String(adjudication.fallback).startsWith("adjudication_apply_rejected:validation_error_merged_body"), `fallback=${adjudication.fallback}`);
});

await check("resolver: decision=create -> new rule written bypassing the gate", async () => {
  const home = freshHome();
  const { result } = await resolveWith(home, async () => ({
    ok: true, model: "stub", durationMs: 1,
    decision: { decision: "create", reason: "genuinely different" },
  }));
  assert(result.status === "created" && result.slug === "glab-rule-restated", `status=${result.status} slug=${result.slug}`);
  assert(fs.existsSync(path.join(home, "rules", "always", "glab-rule-restated.md")), "new rule file exists");
});

console.log(failures.length === 0
  ? `PASS — ${total} checks (tier1 jaccard adjudication).`
  : `FAIL — ${failures.length}/${total} checks failed.`);
process.exit(failures.length === 0 ? 0 : 1);
