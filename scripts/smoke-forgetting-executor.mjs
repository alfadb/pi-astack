/**
 * ADR 0031 Phase 3 skeleton — forgetting-executor deterministic 单测(免 LLM/IO)。
 * 测 selectDemoteTargets 纯决策:门优先级(resurrection backoff > hysteresis > batch cap)、
 * cooldown/holdout skip、batch 上限、resurrection 自回退(趋势/速率两路)、no_slug、空。
 */
import { createJiti } from "jiti";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-forgetting-exec-")); // sandbox: 不碰生产 ~/.abrain
process.env.ABRAIN_ROOT = tmp;
const jiti = createJiti(import.meta.url);
const { selectDemoteTargets, runForgettingExecutorDryRun } = await jiti.import(path.join(__dirname, "..", "extensions/sediment/forgetting-executor.ts"));

let fails = 0;
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}: ${m}`); if (!c) fails++; };

const NOW = Date.parse("2026-06-15T00:00:00Z");
const future = new Date(NOW + 86_400_000).toISOString();
const past = new Date(NOW - 86_400_000).toISOString();
const prop = (slug, kind = "fact", reason = "affirm_superseded") => ({ slug, kind, reason });
const calm = { trend: "stable", recent_rate: 0.1 };
const base = (over = {}) => ({
  proposals: [], hysteresisBySlug: {}, resurrection: calm,
  nowMs: NOW, maxBatch: 5, resurrectionBackoffRate: 0.5, ...over,
});

// 空
{
  const p = selectDemoteTargets(base());
  ok(p.demote.length === 0 && p.skipped.length === 0 && !p.resurrection_backoff, "空 proposals → 空 plan");
}

// 基本: 3 archive proposal, 无 hysteresis, calm → 全 demote
{
  const p = selectDemoteTargets(base({ proposals: [prop("a"), prop("b"), prop("c")] }));
  ok(p.demote.length === 3 && p.skipped.length === 0, "3 proposal + calm + 无 hysteresis → 全 demote");
  ok(p.demote.map((d) => d.slug).join(",") === "a,b,c", "demote 保序");
}

// cooldown skip
{
  const p = selectDemoteTargets(base({ proposals: [prop("a"), prop("b")], hysteresisBySlug: { a: { proposal_cooldown_until: future } } }));
  ok(p.demote.length === 1 && p.demote[0].slug === "b", "cooldown 未过的 a 被 skip, b demote");
  ok(p.skipped.some((s) => s.slug === "a" && s.skip_reason === "cooldown"), "a skip_reason=cooldown");
}

// cooldown 已过(past)→ 不 skip
{
  const p = selectDemoteTargets(base({ proposals: [prop("a")], hysteresisBySlug: { a: { proposal_cooldown_until: past } } }));
  ok(p.demote.length === 1, "cooldown 已过 → 正常 demote");
}

// holdout skip
{
  const p = selectDemoteTargets(base({ proposals: [prop("a")], hysteresisBySlug: { a: { holdout_until: future } } }));
  ok(p.demote.length === 0 && p.skipped[0].skip_reason === "holdout", "holdout 未过 → skip holdout");
}

// batch cap
{
  const p = selectDemoteTargets(base({ proposals: [prop("a"), prop("b"), prop("c"), prop("d"), prop("e")], maxBatch: 2 }));
  ok(p.demote.length === 2 && p.batch_cap === 2, "maxBatch=2 → 只 demote 2");
  ok(p.skipped.filter((s) => s.skip_reason === "batch_cap").length === 3, "超出的 3 个 skip batch_cap");
}

// resurrection backoff: 趋势 accelerating → 全 skip
{
  const p = selectDemoteTargets(base({ proposals: [prop("a"), prop("b")], resurrection: { trend: "accelerating", recent_rate: 0.1 } }));
  ok(p.resurrection_backoff === true && p.demote.length === 0 && p.batch_cap === 0, "accelerating → backoff 全 skip");
  ok(p.skipped.every((s) => s.skip_reason === "resurrection_backoff"), "skip_reason 全 resurrection_backoff");
}

// resurrection backoff: recent_rate >= threshold → 全 skip
{
  const p = selectDemoteTargets(base({ proposals: [prop("a")], resurrection: { trend: "stable", recent_rate: 0.5 } }));
  ok(p.resurrection_backoff === true && p.demote.length === 0, "recent_rate≥0.5 → backoff");
}

// 门优先级: backoff 压过 batch_cap(即便 maxBatch 足够也全 skip)
{
  const p = selectDemoteTargets(base({ proposals: [prop("a")], maxBatch: 10, resurrection: { trend: "accelerating", recent_rate: 0.9 } }));
  ok(p.demote.length === 0 && p.resurrection_backoff, "backoff 优先级高于 batch_cap");
}

// no_slug
{
  const p = selectDemoteTargets(base({ proposals: [{ slug: "", kind: "fact", reason: "affirm_stale" }, prop("b")] }));
  ok(p.demote.length === 1 && p.demote[0].slug === "b", "空 slug 被 skip, b demote");
  ok(p.skipped.some((s) => s.skip_reason === "no_slug"), "空 slug skip_reason=no_slug");
}

// ── runForgettingExecutorDryRun 门控(agent_end 接线路径)+ 无 mutation 结构保证 ──
{
  const off = runForgettingExecutorDryRun("/proj", { forgetting: { demoteShadow: false } });
  ok(off.enabled === false && off.reason === "demoteShadow_off", "demoteShadow off → 短路 enabled:false(零行为变化)");
  const noPr = runForgettingExecutorDryRun(undefined, { forgetting: { demoteShadow: true } });
  ok(noPr.enabled === true && noPr.reason === "no_project_root", "on + 无 projectRoot → no_project_root");
  const on = runForgettingExecutorDryRun("/proj", { forgetting: { demoteShadow: true, demoteMaxBatch: 5, resurrectionBackoffRate: 0.5 } });
  ok(on.ok === true && on.dry_run === true && on.plan && on.plan.demote.length === 0, "on + sandbox 空 proposal → dry-run 空 plan, dry_run:true");
}
// 结构无-mutation 保证: executor 源码不 import writer/archive 路径
{
  const src = fs.readFileSync(path.join(__dirname, "..", "extensions/sediment/forgetting-executor.ts"), "utf-8");
  // 检查真实 import / 调用(带「(」), 排除注释里解释「不用 archiveProjectEntry」的词提及。
  const noWriterImport = !/from\s+["'][^"']*writer["']/.test(src);
  const noMutateCall = !/\b(archiveProjectEntry|updateProjectEntry|supersedeProjectEntry)\s*\(/.test(src);
  ok(noWriterImport && noMutateCall, "executor 源码无 writer import / 无 archive|update|supersedeProjectEntry 调用(结构保证绝不 mutate)");
}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(fails === 0
  ? "\n✅ ALL PASS — forgetting-executor(dry-run skeleton): 门优先级 + hysteresis + batch cap + resurrection 自回退 + agent_end 门控 + 无-mutation 结构保证"
  : `\n❌ ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
