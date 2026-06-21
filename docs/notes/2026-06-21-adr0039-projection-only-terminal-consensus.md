---
doc_type: notes
status: active
---

# ADR0039 projection_only 终态 + legacy 回填缺口 — 多 T0 一致共识（2026-06-21）

> `second-brain-memory-multi-t0-consensus-refactoring-protocol` 要求的共识审计记录。
> 主会话只主持、不投票、不破票。参与 T0：anthropic/claude-opus-4-8、openai/gpt-5.5、
> deepseek/deepseek-v4-pro、moonshotai/kimi-k2.7-code（4 厂商跨架构）。
> **2 轮收敛：R1 Q1/Q2 4/4 一致 + Q4 3-1；R2 P1-P4 全部 4/4 SIGN。**

## 触发

只读核查发现 Knowledge `projection_only`（撤 legacy 兜底）的 coverage 硬门缺口 = pi-global
281 条 project legacy-only（flip-probe：legacy 1428 vs 投影 1147）。分解 = 252 顶层散落 .md
（旧扁平布局，kind=decision/pattern/fact/maxim/anti-pattern，全 active，0 撞车）+ 24 staging/
+ 5 archive/。根因：B3 回填脚本 `LEGACY_KNOWLEDGE_PROJECT_ZONES=["knowledge","decisions","maxims"]`
只扫三个 kind 子目录，结构性漏扫扁平根 + archive/。

## R1 已 4/4 一致（前提）

- **Q1（回填手段）**：扩 B3 backfill 扫描范围纳入 `projects/<id>/` 顶层散落 .md（+ archive/），
  幂等追加 `legacy_import` L1 事件（identity key=`project:<id>:<slug>` 路径无关，0 撞车），
  **legacy 文件一字节不动**，排除 `_index.md`。拒物理归位（不可逆 churn，零收益）；拒让
  scanStore/projector 直扫 raw markdown（违反 §5.2 projector 只消费 Evidence Event）。
- **Q2（coverage 分母）**：281 是错分母。staging/smell/archive **by-design 不属 active
  canonical 读面**，不算进 coverage 硬门分母。**真实 active-canonical 缺口 = 242**。

## R2 收敛：P1-P4 全 4/4 SIGN

- **P1（终态读契约）**：`projection_only` = reads（scanStore/memory_search/memory_decide）
  只消费 L2 投影；**删除静默 legacy-markdown 读 fallback 分支**。
- **P2（legacy 不删、冻结留盘）**：legacy markdown 树不物理删除，冻结为冷灾备 + 审计底座，
  仅经显式响亮可审计路径（覆盖率回归告警）访问，**绝不静默热读兜底**；任何「legacy 应激活/
  复活」修复必须生成新 L1 event 走投影。
- **P3（archived 全文进 L2）**：archived 由 projector 渲染**全文** L2 tombstone（git 同步、
  sparse 可达）；复活 = 读已在盘 L2，不靠重投影/git 考古/legacy 正文。
- **P4（gating）**：flip 仅在 (a) 全覆盖回填关 242 + archive→全文 tombstone；(b) coverage
  硬门=1.0 over 修正后 active-canonical 分母；(c) 真实生产数据验证（flip-probe + reindex-ab
  绿）非时间-soak —— 全部满足后执行。

deepseek（R1 唯一异议者）R2 转全 SIGN，明确 P2+P3+P4「全覆盖回填→读 100% 走投影→legacy 仅冷
灾备/复活」化解其「ADR0031 永久可达性 + 撤兜底 YAGNI 风险」担忧——其 R1 自有方案与 3 家终态同构，
分歧只剩「那条只会被 bug 命中的 fallback 分支删不删」，答案是删（改 fail-loud）。

## 一致采纳的强化不变量（各由 ≥1 家提出，无一相互冲突 → 并入决议）

- **A1（kimi I-L2R + opus）**：`legacy_import`/`archive` L1 事件**必须携带 archived 全文
  payload**（或内容寻址 blob 的确定性引用），使 L2 archived tombstone **可仅由 L1 重放确定性
  重建**。否则 L2 沦为新 ground truth / legacy 变 L2 重建必读源，与 P2 自相矛盾。
- **A2（opus）**：不止改 backfill（历史侧），**writer go-forward 路径也必须为新归档条目渲染
  全文 L2 tombstone**（`writer.ts:329` 现在 archived→archive/ 不投影）。否则 flip 后新归档无
  tombstone，其复活又得读 legacy → P2 对未来归档项失效。
- **A3（opus + kimi）**：archived L2 带 `status=archived`，不进 coverage 分母、默认 status
  filter 滤出 active 读面，仅经显式 status filter / reactivation 可达。
- **A4（opus + deepseek）**：P4(c)「绿」的粒度 = coverage=1.0 **且** per-(scope,slug) 字段级
  语义 diff（含 compiledTruth markdown 结构保真，零内容丢失）**且** 覆盖率按 envelope schema
  allowlist 区分多域 L1 event 计数（防 coverageRatio 误算）。依据生产记忆
  `coverage-ratio-is-necessary-but-not-sufficient-for-canonical-projection-flip`。
- **A5（opus）**：区分两种 fallback——①静默语义 fallback（投影无此条目→默读 legacy）**删除**；
  ②read-error fallback（投影读抛错）**改 fail-closed + 响亮告警**，不留 legacy 默读分支。
- **A6（gpt + kimi G1）**：legacy 访问只经显式具名 API/CLI + 日志 + 测试断言；flip 后加
  legacy-read tripwire（稳态 counter ≡ 0，非零即告警 + L1 `legacy_cold_access` audit）。
  禁「读不到 L2 自动读 legacy」分支回潮。
- **A7（kimi G2）**：周期性 L1-only rebuild canary（弃 L2、仅从 L1 重放重建、与现役 L2 哈希
  diff）；任何 archived tombstone diff = A1 被违反 = 回滚 flip。

## 立即可执行 vs gated

- **立即可执行（R1 4/4 + A1-A4 精度）**：扩 backfill 扫描范围（顶层 + archive/，排除
  `_index.md`）→ `--dry-run` 看将生成事件清单 → 回填 242 active + 5 archived→全文 tombstone →
  reconcile + flip-probe 验证覆盖率上移、0 内容丢失。**仍是写不可变 L1 进 git 历史的 migration，
  需 dry-run + 真实数据验证。**
- **gated（P1 flip 本身）**：删静默 fallback / 翻 projection_only 仅在 P4(a)(b)(c) 全绿后；
  非时间-soak。A2（writer go-forward tombstone）+ A5（read-error→fail-loud）+ A6/A7 探针为
  flip 前置工程。

## 边界

本共识为 memory 架构决策，已按协议达成全体一致。落地仍逐步、flag-guarded、真实数据验证，不一次性
重写全系统。scope 提醒：本核查数据为 pi-global；其他 project 有小批同形顶层散落，同一 backfill-scope
修复覆盖；projection_only 全局安全需所有 active project 回填。
