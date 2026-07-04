// ADR 0031 Phase 3 — gated forgetting executor(dry-run + real demote 两模式)。
// 注:此件含**真实** active→archived 编排路径(非 skeleton/非只读)——运行模式
// 由 settings flag 决定(见下两模式说明);真实 demote 仅在 autoDemote && autoLlmWriteEnabled
// && orchestrator 注入 archiveEntry 时发生,否则退化 dry-run。
//
// 消费**既有** pending `op=archive` lifecycle proposal(`entry-lifecycle-proposals.ts`,
// 已是 §4.2 独立证据门控的 affirmative 通道 —— disuse-only 永不进入,故 executor
// 天然继承「真值变化驱动」安全),叠加 anti-oscillation hysteresis(复用 entry-telemetry
// 的 proposal_cooldown_until / holdout_until)+ 每批速率上限 + resurrection 自回退,
// 产出 demote plan。
//
// 两种运行模式:
//   - **dry-run**(`runForgettingExecutorDryRun`, flag `demoteShadow`):只读 + 算 plan +
//     写 shadow audit,**绝不 mutate**。
//   - **real**(`runForgettingExecutor`, flag `autoDemote` 且 orchestrator 注入 archiveEntry):
//     真实 active→archived,但 executor **自身仍不 import writer** —— 实际归档由注入的
//     archiveEntry callback 完成(orchestrator 持 writer + expected_status:"active" CAS),
//     executor 只编排门控 + markProposalsExecuted + setEntryHysteresis + 反失控断路器 + audit。
// 真实落地仍受:(1) data-gate(Phase 0 数据 + 影子回归绿);(2) graduation-gate(decay-scorer
// 跨厂商去相关, ADR 0031 §5);flag `autoDemote` 默认 off + 冷启动 fail-safe(见下)。
import * as fs from "node:fs";
import * as path from "node:path";
import { userGlobalSedimentDir, ensureUserGlobalSidecarMigrated, formatLocalIsoTimestamp } from "../_shared/runtime";
import { getCurrentAnchor, spreadAnchor } from "../_shared/causal-anchor";
import { readLifecycleProposals, markProposalsExecuted, type LifecycleProposalExpectedStatus } from "./entry-lifecycle-proposals";
import { getEntryTelemetry, setEntryHysteresis } from "./entry-telemetry";
import { resurrectionRateReport } from "./resurrection-rate-monitor";
import type { MemorySettings } from "../memory/settings";

// 构建时焊死的反失控结构地板(INV-REVERSIBLE-AUTONOMY:大脑自治决定「忘什么」,这些
// 非可调策略,只 bound「多快/多狠」防 curator/proposal 失控批量;可逆性不豁免限速。
// opus M4/M5 review P1-4)。
const DEMOTE_MAX_PER_DAY = 20;                          // 24h 真实 demote 累计上限(跨 agent_end)
const MIN_ACTIVE_CORPUS_FLOOR = 50;                     // active 语料 ≤ 此 → 停止 demote(防抽空)
const DEMOTE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;    // demote 后 30d 不再 demote(防 demote↔reactivate 振荡)

export interface ArchiveProposalInput {
  slug: string;
  kind: string;
  reason: string; // affirm_stale | affirm_superseded | affirm_echo_chamber(已 §4.2 证据门控)
  expected_status?: LifecycleProposalExpectedStatus;
}
export interface HysteresisState {
  proposal_cooldown_until?: string;
  holdout_until?: string;
}
export interface DemoteDecision { slug: string; kind: string; reason: string; expected_status?: LifecycleProposalExpectedStatus; }
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
  // P1-2 fail-safe: insufficient_data(复活历史不足, 冷启动)视同 backoff —— 数据不足时
  // 绝不 demote, 而非照 demote。否则开局复活刹车是哑的(恰是最危险窗口)。
  const backoff =
    input.resurrection.trend === "accelerating" ||
    input.resurrection.trend === "insufficient_data" ||
    input.resurrection.recent_rate >= input.resurrectionBackoffRate;

  const eligible: DemoteDecision[] = [];
  for (const p of input.proposals) {
    if (!p.slug) { skipped.push({ slug: String(p.slug ?? ""), skip_reason: "no_slug" }); continue; }
    const h = input.hysteresisBySlug[p.slug] ?? {};
    const cooldown = h.proposal_cooldown_until ? Date.parse(h.proposal_cooldown_until) : NaN;
    const holdout = h.holdout_until ? Date.parse(h.holdout_until) : NaN;
    if (Number.isFinite(cooldown) && cooldown > input.nowMs) { skipped.push({ slug: p.slug, skip_reason: "cooldown" }); continue; }
    if (Number.isFinite(holdout) && holdout > input.nowMs) { skipped.push({ slug: p.slug, skip_reason: "holdout" }); continue; }
    eligible.push({ slug: p.slug, kind: p.kind, reason: p.reason, expected_status: p.expected_status });
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

/** 真实 demote 事件 durable ledger(per-slug)。同时是 24h 累计断路器的计数源。 */
export function forgettingDemoteLedgerPath(): string {
  ensureUserGlobalSidecarMigrated();
  return path.join(userGlobalSedimentDir(), "forgetting-demote-ledger.jsonl");
}

function countDemotesLast24h(nowMs: number): number {
  try {
    const file = forgettingDemoteLedgerPath();
    if (!fs.existsSync(file)) return 0;
    let n = 0;
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const row = JSON.parse(t) as { ts_ms?: number };
        if (typeof row.ts_ms === "number" && nowMs - row.ts_ms <= 24 * 60 * 60 * 1000) n++;
      } catch { /* corrupt line ignored */ }
    }
    return n;
  } catch { return 0; }
}

export interface CircuitBreakerStatus { tripped: boolean; reason?: "daily_cap" | "corpus_floor"; demoted_last_24h: number; }

/** 反失控断路器:24h 累计上限 + active 语料下限。与 resurrection backoff 正交(后者滞后
 *  且冷启动 fail-safe;此闸限「盲目累积」)。 */
function evalCircuitBreaker(nowMs: number, activeCorpusSize: number | undefined, plannedCount: number): CircuitBreakerStatus {
  const demoted24h = countDemotesLast24h(nowMs);
  if (demoted24h + plannedCount > DEMOTE_MAX_PER_DAY) return { tripped: true, reason: "daily_cap", demoted_last_24h: demoted24h };
  // corpus floor: **fail-closed**(activeCorpusSize 不可知 —— loadEntries 失败 —— 视同跌破地板,
  // deepseek P1)+ 计入本批 plannedCount(active - planned < floor → 跳, 防一批抽到地板以下,
  // gpt+opus P1/P2)。
  if (typeof activeCorpusSize !== "number" || activeCorpusSize - plannedCount < MIN_ACTIVE_CORPUS_FLOOR) {
    return { tripped: true, reason: "corpus_floor", demoted_last_24h: demoted24h };
  }
  return { tripped: false, demoted_last_24h: demoted24h };
}

function appendDemoteLedger(projectRoot: string, target: DemoteDecision, now: Date): void {
  try {
    const file = forgettingDemoteLedgerPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const row = {
      ...spreadAnchor(getCurrentAnchor()),
      ts: formatLocalIsoTimestamp(now),
      ts_ms: now.getTime(),
      project_root: path.resolve(projectRoot),
      slug: target.slug,
      kind: target.kind,
      reason: target.reason,
      expected_status: target.expected_status ?? "active",
      op: "demote",
      reactivation_monitor_window_days: 30,
      reactivation_expected: false
    };
    fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf-8");
  } catch { /* best-effort */ }
}

function appendRealAudit(projectRoot: string, plan: DemotePlan, demoted: string[], failed: { slug: string; error: string }[], abandoned: string[], breaker: CircuitBreakerStatus, now: Date): void {
  try {
    const file = forgettingDryRunAuditPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const row = {
      ...spreadAnchor(getCurrentAnchor()),
      ts: formatLocalIsoTimestamp(now),
      project_root: path.resolve(projectRoot),
      dry_run: false,
      planned_count: plan.demote.length,
      demoted_count: demoted.length,
      failed_count: failed.length,
      abandoned_count: abandoned.length,
      demoted_slugs: demoted,
      abandoned_slugs: abandoned,
      failed,
      resurrection_backoff: plan.resurrection_backoff,
      circuit_breaker: breaker,
    };
    fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf-8");
  } catch { /* best-effort */ }
}

function executableArchiveProposals(projectRoot: string): ArchiveProposalInput[] {
  return readLifecycleProposals(projectRoot)
    .filter((p) =>
      p.op === "archive" &&
      p.status === "pending" &&
      (p.disposition ?? "execution_ready") === "execution_ready" &&
      typeof p.slug === "string" &&
      p.slug,
    )
    .map((p) => ({
      slug: p.slug as string,
      kind: p.kind,
      reason: p.reason,
      expected_status: p.expected_status ?? "active",
    }));
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
    const proposals: ArchiveProposalInput[] = executableArchiveProposals(projectRoot);

    const hysteresisBySlug: Record<string, HysteresisState> = {};
    for (const p of proposals) {
      const t = getEntryTelemetry(projectRoot, p.slug);
      if (t) hysteresisBySlug[p.slug] = { proposal_cooldown_until: t.proposal_cooldown_until, holdout_until: t.holdout_until };
    }

    const rr = resurrectionRateReport(30, now, projectRoot);
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

/** 注入式真实归档(executor 不 import writer —— orchestrator 提供, 内部 archiveProjectEntry
 *  + expected_status:"active" CAS + dryRun:false)。返回 status 反映落地后状态。 */
export type ArchiveEntryFn = (target: DemoteDecision) => Promise<{ ok: boolean; status?: string; error?: string; rejected?: boolean }>;

export interface ForgettingExecutorRealResult {
  ok: boolean;
  enabled: boolean;
  dry_run: boolean;
  reason?: string;
  plan?: DemotePlan;
  demoted?: string[];
  failed?: { slug: string; error: string }[];
  abandoned?: string[]; // CAS reject(条目非 active)→ 放弃重试的 proposal
  circuit_breaker?: CircuitBreakerStatus;
}

/** Real-capable 入口(orchestrator 用)。`autoDemote` off 或未注入 archiveEntry → 退化为
 *  dry-run(写 shadow audit, 零 mutation)。on + 注入 + 断路器未跳 → 逐条 archiveEntry
 *  (CAS active→archived)+ markProposalsExecuted + setEntryHysteresis + ledger。
 *  per-target fail-open:单条失败不阻断其余, 失败条目留 pending(下轮重试)。 */
export async function runForgettingExecutor(
  projectRoot: string | undefined,
  settings: MemorySettings,
  deps: { archiveEntry?: ArchiveEntryFn; activeCorpusSize?: number } = {},
  now: Date = new Date(),
): Promise<ForgettingExecutorRealResult> {
  if (!settings.forgetting?.demoteShadow) return { ok: true, enabled: false, dry_run: true, reason: "demoteShadow_off" };
  if (!projectRoot) return { ok: true, enabled: true, dry_run: true, reason: "no_project_root" };
  try {
    const proposals: ArchiveProposalInput[] = executableArchiveProposals(projectRoot);

    const hysteresisBySlug: Record<string, HysteresisState> = {};
    for (const p of proposals) {
      const t = getEntryTelemetry(projectRoot, p.slug);
      if (t) hysteresisBySlug[p.slug] = { proposal_cooldown_until: t.proposal_cooldown_until, holdout_until: t.holdout_until };
    }

    const rr = resurrectionRateReport(30, now, projectRoot);
    const plan = selectDemoteTargets({
      proposals,
      hysteresisBySlug,
      resurrection: { trend: rr.trend, recent_rate: rr.recent.resurrection_rate },
      nowMs: now.getTime(),
      maxBatch: settings.forgetting.demoteMaxBatch,
      resurrectionBackoffRate: settings.forgetting.resurrectionBackoffRate,
    });

    const wantReal = settings.forgetting.autoDemote === true && typeof deps.archiveEntry === "function";
    if (!wantReal) {
      appendDryRunAudit(projectRoot, plan, now);
      return { ok: true, enabled: true, dry_run: true, plan };
    }

    const breaker = evalCircuitBreaker(now.getTime(), deps.activeCorpusSize, plan.demote.length);
    if (breaker.tripped) {
      appendRealAudit(projectRoot, plan, [], [], [], breaker, now);
      return { ok: true, enabled: true, dry_run: true, reason: `circuit_breaker_${breaker.reason}`, plan, circuit_breaker: breaker };
    }

    const demoted: string[] = [];
    const failed: { slug: string; error: string }[] = [];
    const abandoned: string[] = [];
    const cooldownIso = formatLocalIsoTimestamp(new Date(now.getTime() + DEMOTE_COOLDOWN_MS));
    const nowIso = formatLocalIsoTimestamp(now);
    for (const target of plan.demote) {
      try {
        // P1(gpt+deepseek): cooldown-first —— 先落 30d 冷却(保守防振荡), 即使 archive 失败
        // 也不会下轮立刻重提;如果被复活 → 下轮 cooldown 未过 → selectDemoteTargets skip。
        const hys = setEntryHysteresis(projectRoot, target.slug, { proposal_cooldown_until: cooldownIso, last_proposed_at: nowIso });
        const r = await deps.archiveEntry!(target);
        if (r.ok && (r.status === "archived" || r.status === undefined)) {
          const mark = markProposalsExecuted(projectRoot, [target.slug]); // P1: 检查返回值
          appendDemoteLedger(projectRoot, target, now);
          demoted.push(target.slug);
          if (!mark.ok || !hys.ok) failed.push({ slug: target.slug, error: `demoted_but_bookkeeping_degraded(mark=${mark.ok},hys=${hys.ok})` });
        } else if (r.rejected) {
          // CAS reject(条目非 active: 已 archived 或已复活)→ 放弃该 proposal(标 executed 停重试),
          // 防孤儿 pending 在条目被复活后再次 demote(deepseek 6.2 + gpt P0 stale-replay)。
          markProposalsExecuted(projectRoot, [target.slug]);
          abandoned.push(target.slug);
        } else {
          // 瞬时失败(callback 抛错/IO)→ 留 pending 下轮重试(cooldown 已挡 30d, 不会立即)。
          failed.push({ slug: target.slug, error: r.error ?? "archive_failed" });
        }
      } catch (e) {
        failed.push({ slug: target.slug, error: e instanceof Error ? e.message : String(e) });
      }
    }
    appendRealAudit(projectRoot, plan, demoted, failed, abandoned, breaker, now);
    return { ok: true, enabled: true, dry_run: false, plan, demoted, failed, abandoned, circuit_breaker: breaker };
  } catch (e) {
    return { ok: false, enabled: true, dry_run: true, reason: e instanceof Error ? e.message : String(e) };
  }
}
