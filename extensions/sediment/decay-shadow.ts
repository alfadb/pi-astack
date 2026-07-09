// ADR 0031 Phase 1(1A: 独立件)— decay 影子评估 schema + sidecar + 回归不变量。
//
// 3×T0 共识(docs/notes/2026-06-15-adr0031-phase1-decay-shadow-design.md):
//   - P0-1: decay 走**正交** entry_decay_assessments[] → 独立 decay-shadow.jsonl,
//     不挂 lifecycle_proposal(否则覆盖坍缩到错误 population + 污染现有 sidecar)。
//   - P0-2: would_demote 必须 §4.2 真值变化证据门控(superseded_by/contradicted/
//     version_stale);**disuse 单独永不触发** → demote_evidence_type 此时必为 null。
//     回归不变量 `would_demote_usage_only_count` 必须恒为 0(任一非零 = prompt regression)。
//   - P1: deterministic baseline 复活为合法 AI-Native **影子/回归基线**(非主决策),
//     与 LLM 给的 decay_score 对账(reconcile)做漂移检测。
//
// 本模块是 decay 的「消费/校验」半 —— 纯函数 + sidecar append,**不**触碰 live aggregator
// (1B 才把 entry_decay_assessments[] 接进 aggregator 输出,gated by forgetting.enabled)。
import * as fs from "node:fs";
import * as path from "node:path";
import { userGlobalSedimentDir, ensureUserGlobalSidecarMigrated, formatLocalIsoTimestamp } from "../_shared/runtime";
import { getCurrentAnchor, spreadAnchor } from "../_shared/causal-anchor";

/** §4.2 真值变化证据类型。null ⟺ would_demote=false;usage-only **永不**产生非空 type。 */
export type DemoteEvidenceType = "superseded_by" | "contradicted" | "version_stale";

export type DecayPrimaryDriver = "supersede" | "contradiction" | "staleness" | "disuse" | "kind_atypical";

export interface DecayInputs {
  window_retrieved_unused?: number;
  decisive_streak?: number;
  last_cited_at?: string;
}

/** LLM(扩展后的 aggregator)对单条目的 decay 评估(prompt-native)。 */
export interface EntryDecayAssessment {
  slug: string;
  decay_score: number; // 0..1 advisory color,**非** would_demote 的驱动
  would_demote: boolean; // 继承 §4.2 证据门
  demote_evidence_type: DemoteEvidenceType | null;
  primary_driver: DecayPrimaryDriver;
  decay_inputs?: DecayInputs;
  falsifier: string;
}

export interface DecayShadowRow extends EntryDecayAssessment {
  schema_version: 1;
  ts: string;
  project_root: string;
  status: "shadow";
  violation_reason?: "would_demote_usage_only";
  raw_would_demote?: boolean;
  raw_demote_evidence_type?: string | null;
}

export const EVIDENCE_TYPES: ReadonlySet<string> = new Set(["superseded_by", "contradicted", "version_stale"]);
export const USAGE_ONLY_EVIDENCE_TYPES: ReadonlySet<string> = new Set(["", "usage_only", "usage-only", "disuse", "retrieval_only", "retrieval-only", "kind_atypical", "low_citation", "low-citations"]);

export function decayShadowPath(): string {
  ensureUserGlobalSidecarMigrated();
  return path.join(userGlobalSedimentDir(), "decay-shadow.jsonl");
}

/** 规范化一条 LLM 评估(tolerant;非法 → null 丢弃)。would_demote 与 evidence_type 互锁:
 *  evidence_type 不在白名单 → 视为 null;null 时 would_demote 强制 false(§4.2 门的代码侧兜底)。 */
export function normalizeAssessment(raw: unknown): EntryDecayAssessment | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const slug = typeof r.slug === "string" && r.slug.trim() ? r.slug.trim() : "";
  if (!slug) return null;
  const score = typeof r.decay_score === "number" && Number.isFinite(r.decay_score) ? Math.min(1, Math.max(0, r.decay_score)) : 0;
  const evType = typeof r.demote_evidence_type === "string" && EVIDENCE_TYPES.has(r.demote_evidence_type) ? (r.demote_evidence_type as DemoteEvidenceType) : null;
  // §4.2 代码侧兜底: 无合法证据 type → would_demote 不可为 true。
  const wouldDemote = r.would_demote === true && evType !== null;
  const driver = (["supersede", "contradiction", "staleness", "disuse", "kind_atypical"] as const).includes(r.primary_driver as DecayPrimaryDriver)
    ? (r.primary_driver as DecayPrimaryDriver) : "disuse";
  const di = (r.decay_inputs && typeof r.decay_inputs === "object") ? r.decay_inputs as Record<string, unknown> : {};
  return {
    slug,
    decay_score: score,
    would_demote: wouldDemote,
    demote_evidence_type: wouldDemote ? evType : null,
    primary_driver: driver,
    decay_inputs: {
      ...(typeof di.window_retrieved_unused === "number" ? { window_retrieved_unused: di.window_retrieved_unused } : {}),
      ...(typeof di.decisive_streak === "number" ? { decisive_streak: di.decisive_streak } : {}),
      ...(typeof di.last_cited_at === "string" ? { last_cited_at: di.last_cited_at } : {}),
    },
    falsifier: typeof r.falsifier === "string" ? r.falsifier : "",
  };
}

export interface DecayAuditResult {
  total: number;
  would_demote_count: number;
  /** would_demote=true 但 demote_evidence_type===null(§4 disuse-only 后门)。**必须恒为 0**。 */
  would_demote_usage_only_count: number;
  /** decay_score 越界(规范化后不应出现;原始审计用)。 */
  invalid_score_count: number;
  ok: boolean;
  violations: Array<{ slug: string; reason: string }>;
}

/** 回归不变量审计(可复现钩子)。打 invariant 不打 float:核心是
 *  would_demote_usage_only_count 必须 0(P0-2)。对**原始**(未规范化)评估跑,
 *  以捕获 prompt 真实产出的违规(规范化会兜底掩盖,故审计看原始)。 */
function rawUsageOnlyViolation(raw: unknown): { violation: boolean; evidenceType: string | null } {
  if (!raw || typeof raw !== "object") return { violation: false, evidenceType: null };
  const r = raw as Record<string, unknown>;
  if (r.would_demote !== true) return { violation: false, evidenceType: null };
  const evidenceType = typeof r.demote_evidence_type === "string" ? r.demote_evidence_type.trim() : null;
  if (evidenceType !== null && EVIDENCE_TYPES.has(evidenceType)) return { violation: false, evidenceType };
  return { violation: evidenceType === null || USAGE_ONLY_EVIDENCE_TYPES.has(evidenceType), evidenceType };
}

export function auditDecayAssessments(rawAssessments: unknown[]): DecayAuditResult {
  const violations: Array<{ slug: string; reason: string }> = [];
  let wouldDemote = 0, usageOnly = 0, invalidScore = 0;
  for (const raw of Array.isArray(rawAssessments) ? rawAssessments : []) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const slug = typeof r.slug === "string" ? r.slug : "";
    const wd = r.would_demote === true;
    const score = r.decay_score;
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
      invalidScore++; violations.push({ slug, reason: "decay_score_out_of_range" });
    }
    if (wd) {
      wouldDemote++;
      if (rawUsageOnlyViolation(raw).violation) { usageOnly++; violations.push({ slug, reason: "would_demote_without_truth_change_evidence" }); }
    }
  }
  return {
    total: Array.isArray(rawAssessments) ? rawAssessments.length : 0,
    would_demote_count: wouldDemote,
    would_demote_usage_only_count: usageOnly,
    invalid_score_count: invalidScore,
    ok: usageOnly === 0 && invalidScore === 0,
    violations,
  };
}

/** deepseek 影子基线(P1-1): **可复现参考分**,非主决策、非 would_demote 驱动。
 *  纯启发式 —— 高 retrieved-unused 占比 + 低 citation → 高 baseline decay。仅用于与
 *  LLM 给的 decay_score 对账检测漂移。 */
export function deterministicDecayBaseline(t: {
  window_retrieved_unused?: number;
  window_total_retrievals?: number;
  citation_count?: number;
}): number {
  const totalRetr = Math.max(0, t.window_total_retrievals ?? 0);
  const unused = Math.max(0, t.window_retrieved_unused ?? 0);
  const cited = Math.max(0, t.citation_count ?? 0);
  const unusedRatio = totalRetr > 0 ? Math.min(1, unused / totalRetr) : (cited === 0 ? 0.5 : 0);
  const citationDamp = cited > 0 ? Math.max(0, 1 - Math.min(1, cited / 5)) : 1;
  return Math.max(0, Math.min(1, 0.6 * unusedRatio + 0.4 * citationDamp));
}

/** LLM decay_score 与 deterministic baseline 对账(advisory 漂移检测,非门)。 */
export function reconcileDecayShadow(llmScore: number, baselineScore: number, divergenceEpsilon = 0.4): { delta: number; divergent: boolean } {
  const delta = Math.abs((Number.isFinite(llmScore) ? llmScore : 0) - (Number.isFinite(baselineScore) ? baselineScore : 0));
  return { delta, divergent: delta > divergenceEpsilon };
}

/** best-effort 写 decay-shadow.jsonl(append)。调用方负责 flag/projectRoot 守卫。
 *  规范化后写(已 §4.2 代码兜底);绝不抛错/阻塞。返回写入行数。 */
export function writeDecayShadow(projectRoot: string, assessments: unknown[], now: Date = new Date()): number {
  try {
    if (!projectRoot) return 0;
    const rows: DecayShadowRow[] = [];
    for (const a of Array.isArray(assessments) ? assessments : []) {
      const norm = normalizeAssessment(a);
      if (!norm) continue;
      const usageOnly = rawUsageOnlyViolation(a);
      if (!norm.would_demote && !usageOnly.violation) continue;
      rows.push({
        ...norm,
        schema_version: 1,
        ts: formatLocalIsoTimestamp(now),
        project_root: path.resolve(projectRoot),
        status: "shadow",
        ...(usageOnly.violation ? { violation_reason: "would_demote_usage_only" as const, raw_would_demote: true, raw_demote_evidence_type: usageOnly.evidenceType } : {}),
      });
    }
    if (rows.length === 0) return 0;
    const file = decayShadowPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const anchor = spreadAnchor(getCurrentAnchor());
    fs.appendFileSync(file, rows.map((row) => JSON.stringify({ ...anchor, ...row })).join("\n") + "\n", "utf-8");
    return rows.length;
  } catch {
    return 0; // best-effort: shadow 绝不影响 aggregator/检索
  }
}
