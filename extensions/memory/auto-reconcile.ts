// ADR 0035 §79(a)/§49 + ADR 0036 §10.6 — search-time 双向自动 reconcile。
//
// 缺口: reconcile(写向量索引)此前唯一 runtime 触发点是 sediment 写盘
// (sediment/index.ts)。所以 git-pull 拉进来的新/改/archive/delete、新设备空索引、
// 纯读会话 —— 都不触发,dense 静默退化(新设备甚至无 dense)。
//
// 本模块在 search 路径(数据已加载,纯 set 运算免费)检测**双向** backlog:
//   - ADD : active entry 缺失/陈旧于索引(content-hash diff,robust to 手改/git-pull)
//   - PRUNE: 索引里 scope 在本次范围、但 slug 不再 active 的孤儿(archived/deleted)
// 任一够量 → fire 一个 **detached / single-flight / cooldown** 的后台 reconcile
// (同一 reconcile 调用 add+prune 一起做)。全程非阻塞:search 当轮仍走 bounded
// fallback,下一轮受益。covers add/update · archive · delete · git-pull · 新设备 ·
// 纯读会话 六种场景,不需要 git commit-id(content-hash + orphan set-diff 更强)。
import { loadEntries } from "./parser";
import { reconcileEmbeddings, resolveEmbeddingProviderConfig, vectorIndexPath } from "./embedding";
import type { MemorySettings } from "./settings";

export interface ReconcileSignal {
  indexEmpty: boolean;
  staleCount: number;   // active 缺失/陈旧(需 ADD)
  orphanCount: number;  // 索引内 in-scope 但已非 active(需 PRUNE)
  activeCount: number;  // 本次加载的 active entry 数(空则无可索引)
}

export interface AutoReconcileDecision { trigger: boolean; reason: string; }

export interface DecisionState {
  enabled: boolean;
  embeddingConfigured: boolean;
  hasProjectRoot: boolean;
  inFlight: boolean;
  now: number;
  lastRunAt: number;
  cooldownMs: number;
  minBacklog: number;
}

/** 纯决策(deterministic, 免 LLM/IO, 可单测)。触发优先级与短路顺序固定。 */
export function shouldTriggerReconcile(sig: ReconcileSignal, st: DecisionState): AutoReconcileDecision {
  if (!st.enabled) return { trigger: false, reason: "disabled" };
  if (!st.embeddingConfigured) return { trigger: false, reason: "embedding_off" };
  if (!st.hasProjectRoot) return { trigger: false, reason: "no_project_root" }; // 排除 oracle/scratch 调用
  if (st.inFlight) return { trigger: false, reason: "in_flight" };
  if (st.now - st.lastRunAt < st.cooldownMs) return { trigger: false, reason: "cooldown" };
  if (sig.activeCount === 0) return { trigger: false, reason: "empty_corpus" }; // 无可索引
  if (sig.indexEmpty) return { trigger: true, reason: "index_empty" };           // 新设备/冷启动
  const backlog = sig.staleCount + sig.orphanCount;
  if (backlog >= st.minBacklog) return { trigger: true, reason: `backlog_${backlog}` };
  return { trigger: false, reason: `backlog_below_min_${backlog}` };
}

let inFlight = false;
let lastRunAt = 0;

/** test-only: 复位 module 级 single-flight/cooldown 状态。 */
export function __resetAutoReconcileState(): void { inFlight = false; lastRunAt = 0; }

/** Fire-and-forget。返回决策(供 metrics/调试);触发时后台 reconcile 不被 await。
 *  错误一律 swallow —— search-time bounded-union 已兜底,provider 故障绝不阻塞检索。 */
export function maybeAutoReconcile(
  projectRoot: string | undefined,
  settings: MemorySettings,
  modelRegistry: unknown,
  sig: ReconcileSignal,
): AutoReconcileDecision {
  const decision = shouldTriggerReconcile(sig, {
    enabled: settings.search.autoReconcile,
    embeddingConfigured: !!(settings.embedding.provider && settings.embedding.model),
    hasProjectRoot: !!projectRoot,
    inFlight,
    now: Date.now(),
    lastRunAt,
    cooldownMs: settings.search.autoReconcileCooldownMs,
    minBacklog: settings.search.autoReconcileMinBacklog,
  });
  if (!decision.trigger) return decision;
  inFlight = true;
  lastRunAt = Date.now();
  void (async () => {
    try {
      const cfg = await resolveEmbeddingProviderConfig(
        modelRegistry as Parameters<typeof resolveEmbeddingProviderConfig>[0],
        settings.embedding,
      );
      // 后台 reconcile 自己 loadEntries 取权威最新态(不复用 search 的过滤 corpus);
      // reconcileEmbeddings 内部 content-hash gated + scope-safe prune + 文件锁串行。
      const corpus = await loadEntries(projectRoot!, settings, undefined);
      await reconcileEmbeddings(corpus, cfg, vectorIndexPath());
    } catch {
      /* swallow: 索引退化由 search-time bounded-union 兜底,绝不阻塞/报错 */
    } finally {
      inFlight = false;
    }
  })();
  return decision;
}
