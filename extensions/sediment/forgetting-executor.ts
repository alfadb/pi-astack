// ADR 0031 Phase 3(skeleton)— gated forgetting executor(dry-run / read-only)。
//
// 消费**既有** pending `op=archive` lifecycle proposal(`entry-lifecycle-proposals.ts`,
// 已是 §4.2 独立证据门控的 affirmative 通道 —— disuse-only 永不进入,故 executor
// 天然继承「真值变化驱动」安全),叠加 anti-oscillation hysteresis(复用 entry-telemetry
// 的 proposal_cooldown_until / holdout_until)+ 每批速率上限 + resurrection 自回退,
// 产出 demote plan。
//
// ⚠ 本 skeleton **绝不 mutate**:不 import/调用 writer/archiveProjectEntry,只读 + 算 plan
// + 写 shadow audit(sidecar)。真实 active→archived 落地待:(1) data-gate(N 周 Phase 0
// 数据 + 影子回归绿);(2) graduation-gate(decay-scorer 跨厂商去相关于 curator/reviewer,
// ADR 0031 §5);(3) Phase 1 decay 富化 proposal。flag `forgetting.demoteShadow` 默认 off。
import * as fs from "node:fs";
import * as path from "node:path";
import { userGlobalSedimentDir, ensureUserGlobalSidecarMigrated, formatLocalIsoTimestamp } from "../_shared/runtime";
import { getCurrentAnchor, spreadAnchor } from "../_shared/causal-anchor";
import { readLifecycleProposals } from "./entry-lifecycle-proposals";
import { getEntryTelemetry } from "./entry-telemetry";
import { resurrectionRateReport } from "./resurrection-rate-monitor";
import type { MemorySettings } from "../memory/settings";

export interface ArchiveProposalInput {
  slug: string;
  kind: string;
  reason: string; // affirm_stale | affirm_superseded | affirm_echo_chamber(已 §4.2 证据门控)
}
export interface HysteresisState {
  proposal_cooldown_until?: string;
  holdout_until?: string;
}
export interface DemoteDecision { slug: string; kind: string; reason: string; }
export interface DemoteSkip { slug: string; skip_reason: "cooldown" | "holdout" | "batch_cap" | "resurrection_backoff" | "no_slug"; }
export interface DemotePlan {
  demote: DemoteDecision[];
  skipped: DemoteSkip[];
  resurrection_backoff: boolean; // true = resurrection 信号强制本批全 skip
  batch_cap: number; // 生效的批上限(backoff 时为 0)
}

export interface SelectDemoteInput {
  /** ONLY op=archive proposals(上游 §4.2 证据门控)。 */
  proposals: ArchiveProposalInput[];
  hysteresisBySlug: Record<string, HysteresisState>;
  resurrection: { trend: string; recent_rate: number };
  nowMs: number;
  maxBatch: number;
  resurrectionBackoffRate: number;
}

/** 纯决策(deterministic, 免 IO, 可单测)。门优先级固定:
 *  resurrection backoff(全 skip)> hysteresis(cooldown/holdout)> batch cap。 */
export function selectDemoteTargets(input: SelectDemoteInput): DemotePlan {
  const skipped: DemoteSkip[] = [];
  const backoff = input.resurrection.trend === "accelerating" || input.resurrection.recent_rate >= input.resurrectionBackoffRate;

  const eligible: DemoteDecision[] = [];
  for (const p of input.proposals) {
    if (!p.slug) { skipped.push({ slug: String(p.slug ?? ""), skip_reason: "no_slug" }); continue; }
    const h = input.hysteresisBySlug[p.slug] ?? {};
    const cooldown = h.proposal_cooldown_until ? Date.parse(h.proposal_cooldown_until) : NaN;
    const holdout = h.holdout_until ? Date.parse(h.holdout_until) : NaN;
    if (Number.isFinite(cooldown) && cooldown > input.nowMs) { skipped.push({ slug: p.slug, skip_reason: "cooldown" }); continue; }
    if (Number.isFinite(holdout) && holdout > input.nowMs) { skipped.push({ slug: p.slug, skip_reason: "holdout" }); continue; }
    eligible.push({ slug: p.slug, kind: p.kind, reason: p.reason });
  }

  if (backoff) {
    for (const e of eligible) skipped.push({ slug: e.slug, skip_reason: "resurrection_backoff" });
    return { demote: [], skipped, resurrection_backoff: true, batch_cap: 0 };
  }

  const cap = Math.max(0, Math.floor(input.maxBatch));
  const demote = eligible.slice(0, cap);
  for (const e of eligible.slice(cap)) skipped.push({ slug: e.slug, skip_reason: "batch_cap" });
  return { demote, skipped, resurrection_backoff: false, batch_cap: cap };
}

export function forgettingDryRunAuditPath(): string {
  ensureUserGlobalSidecarMigrated();
  return path.join(userGlobalSedimentDir(), "forgetting-dry-run-audit.jsonl");
}

function appendDryRunAudit(projectRoot: string, plan: DemotePlan, now: Date): void {
  try {
    const file = forgettingDryRunAuditPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const row = {
      ...spreadAnchor(getCurrentAnchor()),
      ts: formatLocalIsoTimestamp(now),
      project_root: path.resolve(projectRoot),
      dry_run: true,
      would_demote_count: plan.demote.length,
      skipped_count: plan.skipped.length,
      resurrection_backoff: plan.resurrection_backoff,
      batch_cap: plan.batch_cap,
      would_demote_slugs: plan.demote.map((d) => d.slug),
    };
    fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf-8");
  } catch { /* best-effort: audit 绝不阻塞/抛错 */ }
}

export interface ForgettingExecutorResult {
  ok: boolean;
  enabled: boolean;
  dry_run: true; // skeleton 恒 dry-run
  reason?: string;
  plan?: DemotePlan;
}

/** Read-only / dry-run 入口:flag on 时读 proposal+hysteresis+resurrection → 算 plan +
 *  写 shadow audit。**绝不 mutate durable memory**(无 archiveProjectEntry 路径)。 */
export function runForgettingExecutorDryRun(
  projectRoot: string | undefined,
  settings: MemorySettings,
  now: Date = new Date(),
): ForgettingExecutorResult {
  if (!settings.forgetting?.demoteShadow) return { ok: true, enabled: false, dry_run: true, reason: "demoteShadow_off" };
  if (!projectRoot) return { ok: true, enabled: true, dry_run: true, reason: "no_project_root" };
  try {
    const proposals: ArchiveProposalInput[] = readLifecycleProposals(projectRoot)
      .filter((p) => p.op === "archive" && p.status === "pending" && typeof p.slug === "string" && p.slug)
      .map((p) => ({ slug: p.slug as string, kind: p.kind, reason: p.reason }));

    const hysteresisBySlug: Record<string, HysteresisState> = {};
    for (const p of proposals) {
      const t = getEntryTelemetry(projectRoot, p.slug);
      if (t) hysteresisBySlug[p.slug] = { proposal_cooldown_until: t.proposal_cooldown_until, holdout_until: t.holdout_until };
    }

    const rr = resurrectionRateReport(30, now);
    const plan = selectDemoteTargets({
      proposals,
      hysteresisBySlug,
      resurrection: { trend: rr.trend, recent_rate: rr.recent.resurrection_rate },
      nowMs: now.getTime(),
      maxBatch: settings.forgetting.demoteMaxBatch,
      resurrectionBackoffRate: settings.forgetting.resurrectionBackoffRate,
    });
    appendDryRunAudit(projectRoot, plan, now);
    return { ok: true, enabled: true, dry_run: true, plan };
  } catch (e) {
    return { ok: false, enabled: true, dry_run: true, reason: e instanceof Error ? e.message : String(e) };
  }
}
