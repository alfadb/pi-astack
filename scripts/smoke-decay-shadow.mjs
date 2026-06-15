/**
 * ADR 0031 Phase 1(1A)— decay-shadow deterministic 单测(免 LLM)。
 * 核心:§4.2 回归不变量 would_demote_usage_only_count(must 0)+ normalize 代码侧兜底
 * (would_demote 无证据 → 强制 false)+ deterministic baseline 有界/单调 + reconcile +
 * sandbox writer。
 */
import { createJiti } from "jiti";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-decay-shadow-"));
process.env.ABRAIN_ROOT = tmp; // sandbox: decayShadowPath → tmp/.state/sediment/

const jiti = createJiti(import.meta.url);
const { normalizeAssessment, auditDecayAssessments, deterministicDecayBaseline, reconcileDecayShadow, writeDecayShadow, decayShadowPath } =
  await jiti.import(path.join(__dirname, "..", "extensions/sediment/decay-shadow.ts"));

let fails = 0;
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}: ${m}`); if (!c) fails++; };

// ── normalizeAssessment ──────────────────────────────────────
ok(normalizeAssessment({ slug: "", decay_score: 0.5 }) === null, "无 slug → null");
{
  const n = normalizeAssessment({ slug: "a", decay_score: 1.5, would_demote: true, demote_evidence_type: "superseded_by", primary_driver: "supersede", falsifier: "f" });
  ok(n.decay_score === 1, "decay_score 钳到 [0,1]");
  ok(n.would_demote === true && n.demote_evidence_type === "superseded_by", "有合法证据 → would_demote 保留");
}
{
  // §4.2 代码侧兜底: would_demote=true 但无证据 → 强制 false + evidence null
  const n = normalizeAssessment({ slug: "b", decay_score: 0.9, would_demote: true, demote_evidence_type: null, primary_driver: "disuse", falsifier: "f" });
  ok(n.would_demote === false && n.demote_evidence_type === null, "would_demote 无证据 → normalize 强制 false(disuse 不能 demote)");
}
{
  const n = normalizeAssessment({ slug: "c", decay_score: 0.3, would_demote: true, demote_evidence_type: "bogus", primary_driver: "x", falsifier: "f" });
  ok(n.would_demote === false, "非法 evidence type → would_demote false");
  ok(n.primary_driver === "disuse", "非法 driver → 兜底 disuse");
}

// ── auditDecayAssessments(回归不变量,对 RAW 跑)──────────────
{
  // 干净集: would_demote 都有证据
  const clean = [
    { slug: "a", decay_score: 0.8, would_demote: true, demote_evidence_type: "contradicted" },
    { slug: "b", decay_score: 0.2, would_demote: false, demote_evidence_type: null },
  ];
  const r = auditDecayAssessments(clean);
  ok(r.would_demote_usage_only_count === 0 && r.ok === true, "干净集 → usage_only=0, ok");
  ok(r.would_demote_count === 1, "would_demote_count=1");
}
{
  // 违规: would_demote=true 但无证据(prompt regression — §4 disuse-only 后门)
  const dirty = [
    { slug: "x", decay_score: 0.9, would_demote: true, demote_evidence_type: null },
    { slug: "y", decay_score: 0.9, would_demote: true },  // 缺字段
  ];
  const r = auditDecayAssessments(dirty);
  ok(r.would_demote_usage_only_count === 2 && r.ok === false, "would_demote 无证据 → usage_only=2, ok=false(回归命中)");
  ok(r.violations.some((v) => v.reason === "would_demote_without_truth_change_evidence"), "violation reason 正确");
}
{
  const r = auditDecayAssessments([{ slug: "z", decay_score: 2, would_demote: false }]);
  ok(r.invalid_score_count === 1 && r.ok === false, "decay_score 越界 → invalid_score_count=1, ok=false");
}

// ── deterministicDecayBaseline(有界 + 方向)──────────────────
{
  const high = deterministicDecayBaseline({ window_retrieved_unused: 10, window_total_retrievals: 10, citation_count: 0 });
  const low = deterministicDecayBaseline({ window_retrieved_unused: 0, window_total_retrievals: 10, citation_count: 10 });
  ok(high >= 0 && high <= 1 && low >= 0 && low <= 1, "baseline 有界 [0,1]");
  ok(high > low, "全 unused + 0 citation 的 baseline > 全 used + 高 citation");
}

// ── reconcileDecayShadow ─────────────────────────────────────
{
  ok(reconcileDecayShadow(0.9, 0.2).divergent === true, "|0.9-0.2|=0.7>0.4 → divergent");
  ok(reconcileDecayShadow(0.5, 0.45).divergent === false, "|0.5-0.45|=0.05 → 不 divergent");
}

// ── writeDecayShadow(sandbox)─────────────────────────────────
{
  const file = decayShadowPath();
  ok(file.startsWith(tmp), "sandbox: decay-shadow.jsonl 落 ABRAIN_ROOT 下");
  ok(writeDecayShadow("", [{ slug: "a", decay_score: 0.5 }]) === 0, "无 projectRoot → 写 0 行");
  const n = writeDecayShadow("/proj", [
    { slug: "a", decay_score: 0.8, would_demote: true, demote_evidence_type: "superseded_by", primary_driver: "supersede", falsifier: "f" },
    { slug: "", decay_score: 0.5 }, // 无 slug → 丢弃
  ]);
  ok(n === 1, "写 1 行(无 slug 的被丢)");
  const rows = fs.readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  ok(rows.length === 1 && rows[0].slug === "a" && rows[0].status === "shadow", "落盘行正确 + status=shadow");
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(fails === 0
  ? "\n✅ ALL PASS — decay-shadow: §4.2 回归不变量 + normalize 兜底 + baseline + reconcile + writer"
  : `\n❌ ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
