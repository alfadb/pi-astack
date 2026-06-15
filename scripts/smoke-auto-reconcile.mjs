/**
 * ADR 0036 §10.6 — auto-reconcile 触发决策 deterministic 单测(免 LLM/IO)。
 * 测 shouldTriggerReconcile 纯函数: 六种场景 + 各短路门(disabled/embedding/projectRoot/
 * in-flight/cooldown/empty-corpus/index-empty/backlog 阈值)。
 */
import { createJiti } from "jiti";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url);
const { shouldTriggerReconcile } = await jiti.import(path.join(__dirname, "..", "extensions/memory/auto-reconcile.ts"));

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"}: ${msg}`); if (!cond) fails++; };

// 基准: 可触发的健康状态(enabled, embedding on, projectRoot, 不在飞行, 过 cooldown)
const baseSt = { enabled: true, embeddingConfigured: true, hasProjectRoot: true, inFlight: false, now: 1_000_000, lastRunAt: 0, cooldownMs: 300_000, minBacklog: 3 };
const sig = (o) => ({ indexEmpty: false, staleCount: 0, orphanCount: 0, activeCount: 100, ...o });
const D = (sigO, stO) => shouldTriggerReconcile(sig(sigO), { ...baseSt, ...stO });

// ── 短路门(均不触发)──────────────────────────────────────────
ok(D({ indexEmpty: true }, { enabled: false }).reason === "disabled", "disabled → 不触发");
ok(D({ indexEmpty: true }, { embeddingConfigured: false }).reason === "embedding_off", "embedding 未配 → 不触发");
ok(D({ indexEmpty: true }, { hasProjectRoot: false }).reason === "no_project_root", "无 projectRoot(oracle/scratch)→ 不触发");
ok(D({ indexEmpty: true }, { inFlight: true }).reason === "in_flight", "single-flight: 已在飞行 → 不触发");
ok(D({ indexEmpty: true }, { lastRunAt: 999_000 }).reason === "cooldown", "cooldown 内 → 不触发(now-last=1000ms<300000)");
ok(D({ indexEmpty: true, activeCount: 0 }).reason === "empty_corpus", "空 corpus(无可索引)→ 不触发");

// ── 触发场景 ──────────────────────────────────────────────────
ok(D({ indexEmpty: true }).trigger === true, "新设备/冷启动: 空索引 + 有 active → 触发(index_empty)");
ok(D({ staleCount: 3 }).trigger === true, "git-pull/新写: backlog=3 ≥ min → 触发(ADD)");
ok(D({ orphanCount: 5 }).trigger === true, "archive/delete via sync: orphan=5 ≥ min → 触发(PRUNE)");
ok(D({ staleCount: 2, orphanCount: 1 }).trigger === true, "ADD+PRUNE 混合 backlog=3 ≥ min → 触发");

// ── 小变动不触发(走 bounded fallback)──────────────────────────
ok(D({ staleCount: 2 }).trigger === false && /below_min/.test(D({ staleCount: 2 }).reason), "backlog=2 < min=3 → 不触发(走 search-time bounded fallback)");
ok(D({ orphanCount: 1 }).trigger === false, "单个孤儿 < min → 不触发");
ok(D({}).reason === "backlog_below_min_0", "稳态(索引新, backlog=0)→ 不触发, 零开销");

// ── 边界: cooldown 刚好过 / minBacklog 可配 ────────────────────
ok(D({ staleCount: 3 }, { lastRunAt: 700_000 }).trigger === true, "now-last=300000=cooldownMs(非<)→ 过冷却可触发");
ok(D({ staleCount: 1 }, { minBacklog: 1 }).trigger === true, "minBacklog=1 时 backlog=1 → 触发(阈值可配)");
ok(D({ indexEmpty: true }, { enabled: false }).trigger === false, "index_empty 也敌不过 disabled(门优先级正确)");

console.log(fails === 0
  ? "\n✅ ALL PASS — auto-reconcile 决策: 六场景收敛 + 全部短路门 + 阈值/冷却边界"
  : `\n❌ ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
