/**
 * ADR 0036 P5 — query routing(精确直查)deterministic 单测。无 LLM/embedding 依赖:
 * routeExactLookup 是纯函数; runMemorySearch 的 toolSearch 路由命中即短路(不碰 registry),
 * 故用"会抛的 registry"反证短路成立 / fall-through 时确实进了内核。
 */
import { createJiti } from "jiti";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url);
const { runMemorySearch, routeExactLookup } = await jiti.import(path.join(__dirname, "..", "extensions/memory/llm-search.ts"));
const { resolveSettings } = await jiti.import(path.join(__dirname, "..", "extensions/memory/settings.ts"));

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"}: ${msg}`); if (!cond) fails++; };

// 最小 MemoryEntry 形状(resultCard 只读这些字段 + timeline/relatedSlugs)
const mk = (slug) => ({
  slug, title: `T:${slug}`, summary: `S:${slug}`, kind: "decision", status: "active",
  confidence: 8, created: "2026-01-01", updated: "2026-01-02", timeline: [], relatedSlugs: [],
});
const entries = [
  mk("two-stage-search-separates-recall-from-precision"),
  mk("adr-0035-stage0-candidate-retrieval"),
  mk("adr-0036-bar"),
  mk("adr-0036-baz"), // 0036 有两条 → ADR 编号路由对 0036 应 ambiguous → null
];

// ── 1) routeExactLookup 纯决策 ───────────────────────────────────
ok(routeExactLookup("two-stage-search-separates-recall-from-precision", entries)?.slug
  === "two-stage-search-separates-recall-from-precision", "整体恰为 slug → 命中该 entry");
ok(routeExactLookup("  TWO-STAGE-SEARCH-SEPARATES-RECALL-FROM-PRECISION  ", entries)?.slug
  === "two-stage-search-separates-recall-from-precision", "slug 匹配大小写不敏感 + trim");
ok(routeExactLookup("ADR 0035", entries)?.slug === "adr-0035-stage0-candidate-retrieval", "\"ADR 0035\" → 唯一 adr-0035-* 命中");
ok(routeExactLookup("adr-0035", entries)?.slug === "adr-0035-stage0-candidate-retrieval", "\"adr-0035\" → 同一条");
ok(routeExactLookup("adr 35", entries)?.slug === "adr-0035-stage0-candidate-retrieval", "\"adr 35\" → 补零 0035 命中");
ok(routeExactLookup("ADR 0036", entries) === null, "\"ADR 0036\" 命中两条 → ambiguous → null(不乱路由)");
ok(routeExactLookup("how does two stage search work", entries) === null, "自然语言 query → null(不短路, 走正常检索)");
ok(routeExactLookup("", entries) === null, "空 query → null");
ok(routeExactLookup("adr-9999", entries) === null, "无对应 entry 的 ADR 编号 → null(fall-through 无害)");

// ── 2) runMemorySearch 集成: 命中即短路, 不碰 registry ───────────
const settingsOn = (() => { const s = resolveSettings(); return { ...s, search: { ...s.search, queryRouting: true } }; })();
const settingsOff = (() => { const s = resolveSettings(); return { ...s, search: { ...s.search, queryRouting: false } }; })();
const throwingRegistry = {
  find: () => { throw new Error("KERNEL_REACHED"); },
  getApiKeyAndHeaders: async () => { throw new Error("KERNEL_REACHED"); },
};

// flag ON + toolSearch + 精确 slug → 返回 exact-route card, registry 未被触碰(没抛)
let routed;
try {
  routed = await runMemorySearch("toolSearch", "adr-0035", entries, settingsOn, throwingRegistry, {});
} catch (e) { routed = { threw: String(e?.message) }; }
ok(Array.isArray(routed) && routed.length === 1 && routed[0].slug === "adr-0035-stage0-candidate-retrieval",
  "queryRouting ON + 精确命中 → 单条 card 短路(registry 未触碰)");
ok(Array.isArray(routed) && routed[0].score === 1 && /exact-route/.test(routed[0].rank_reason || ""),
  "短路 card: score=1 + rank_reason 标 exact-route");

// flag OFF + 精确 slug → 不路由 → fall-through 进内核 → throwingRegistry 抛(证明没短路)
let offResult;
try {
  offResult = await runMemorySearch("toolSearch", "adr-0035", entries, settingsOff, throwingRegistry, {});
} catch (e) { offResult = { threw: String(e?.message) }; }
const offDidNotRoute = (offResult && offResult.threw)
  || !(Array.isArray(offResult) && offResult.length === 1 && /exact-route/.test(offResult[0]?.rank_reason || ""));
ok(offDidNotRoute, "queryRouting OFF + 精确 slug → 不短路(fall-through 进内核, 默认行为不变)");

// 非 toolSearch profile(如 correctionSearch)即便 flag ON 也不路由 → 进内核
let nonTool;
try {
  nonTool = await runMemorySearch("correctionSearch", "adr-0035", entries, settingsOn, throwingRegistry, {});
} catch (e) { nonTool = { threw: String(e?.message) }; }
const nonToolDidNotRoute = (nonTool && nonTool.threw)
  || !(Array.isArray(nonTool) && nonTool.length === 1 && /exact-route/.test(nonTool[0]?.rank_reason || ""));
ok(nonToolDidNotRoute, "非 toolSearch profile(correctionSearch)即便 flag ON 也不路由");

console.log(fails === 0
  ? "\n✅ ALL PASS — P5 query routing: 精确直查决策正确 + 仅 toolSearch+flag-on 短路, 默认行为不变"
  : `\n❌ ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
