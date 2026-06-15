// ADR 0031 Phase 0 — 读侧用量埋点(retrieval-hit + citation)。
//
// 目的: 为后续衰减标定积累 Lane G 当年缺的用量数据 —— 哪些 entry 被检索 surfaced
// (retrieval-hit) / 被实际纳入 prompt cited(进 path-A inject 块 / decide brief)。
// 「被用」≠「被检索」: citation 是 retrieval 的真子集, 信号更强。
//
// 零行为变化: 纯观测, slug-keyed 计数写 ~/.abrain/.state/memory/usage-metrics.json,
// 不污染 entry frontmatter, 不做任何 demote/delete/归档。
//
// 守卫(三道):
//   1. settings.forgetting.instrumentation —— schema 默认 false; off → 完全短路不写。
//   2. projectRoot gate —— oracle/scratch(无 projectRoot)不写(同 auto-reconcile/logSearchMetrics)。
//   3. profile gate —— 只对 user-facing 检索(toolSearch/pathAInject/decideSearch)记
//      retrieval-hit; sedimentDedup/correctionSearch 是写侧 curator 操作, 非「用量」, 不计。
//
// 写侧事件(superseded_by/contradicted_by/demote/resurrection)属 sediment 子系统,
// 不在本模块 —— ADR 0031 Phase 0 后续 slice。
import * as path from "node:path";
import { vectorIndexPath } from "./embedding";
import type { MemorySettings } from "./settings";
import type { SearchProfileName } from "./search-profiles";

export interface UsageMetric {
  last_retrieval_hit_at?: string;
  retrieval_hit_count?: number;
  last_cited_at?: string;
  cited_count?: number;
}
export type UsageStore = Record<string, UsageMetric>;
export type UsageSignal = "retrieval_hit" | "cited";

/** retrieval-hit 只对「用户面」检索记账; 写侧 curator profile(dedup/correction)不算用量。 */
const USAGE_RECORDING_PROFILES: ReadonlySet<SearchProfileName> = new Set<SearchProfileName>([
  "toolSearch",
  "pathAInject",
  "decideSearch",
]);

export function isUsageRecordingProfile(name: SearchProfileName): boolean {
  return USAGE_RECORDING_PROFILES.has(name);
}

/** usage-metrics.json 与向量索引同住 .state/memory/(全局, slug-keyed, 与 index 同 scope 面)。 */
export function usageMetricsPath(): string {
  return path.join(path.dirname(vectorIndexPath()), "usage-metrics.json");
}

/** 纯决策: 是否落盘(deterministic, 免 IO, 可单测)。三条全真才写。 */
export function shouldRecordUsage(o: { enabled: boolean; hasProjectRoot: boolean; slugCount: number }): boolean {
  return o.enabled && o.hasProjectRoot && o.slugCount > 0;
}

/** 纯合并: 把一批 slug 的 signal 叠加进 store(免 IO, 可单测)。retrieval_hit / cited
 *  各自独立计数 + 各自 last_*_at 时间戳; 互不覆盖。返回同一 store(原地改 + 返回)。 */
export function mergeUsage(store: UsageStore, slugs: string[], signal: UsageSignal, nowIso: string): UsageStore {
  for (const slug of slugs) {
    const m: UsageMetric = store[slug] ?? {};
    if (signal === "retrieval_hit") {
      m.retrieval_hit_count = (m.retrieval_hit_count ?? 0) + 1;
      m.last_retrieval_hit_at = nowIso;
    } else {
      m.cited_count = (m.cited_count ?? 0) + 1;
      m.last_cited_at = nowIso;
    }
    store[slug] = m;
  }
  return store;
}

/** best-effort 落盘: read-modify-write + tmp→rename(防 torn-write)。同步执行(无 await)
 *  → 进程内原子; 跨进程 lost-update 对标定数据可接受。埋点绝不抛错/阻塞检索。 */
export function recordUsage(
  slugs: string[],
  signal: UsageSignal,
  settings: MemorySettings,
  projectRoot: string | undefined,
): void {
  const uniq = [...new Set((slugs ?? []).filter((s): s is string => typeof s === "string" && s.length > 0))];
  if (!shouldRecordUsage({
    enabled: !!settings.forgetting?.instrumentation,
    hasProjectRoot: !!projectRoot,
    slugCount: uniq.length,
  })) return;
  try {
    const file = usageMetricsPath();
    const dir = path.dirname(file);
    const fs = require("node:fs") as typeof import("node:fs");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    let store: UsageStore = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (parsed && typeof parsed === "object") store = parsed as UsageStore;
    } catch { store = {}; }
    mergeUsage(store, uniq, signal, new Date().toISOString());
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store), "utf-8");
    fs.renameSync(tmp, file);
  } catch { /* best-effort: 埋点绝不影响检索 */ }
}
