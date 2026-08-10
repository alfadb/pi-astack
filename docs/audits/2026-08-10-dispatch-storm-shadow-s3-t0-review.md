# 2026-08-10 dispatch storm shadow S3 — T0+ / cross-vendor T0 review

## 结论

S3（风暴规则 shadow）的 T0+/跨厂商 T0 审查经五轮收敛，最终有效门通过：**T0+ Fable + cross-vendor Opus / Grok / OpenAI 均 GREEN，无 P0/P1**。S3 的 implementation / evidence / review 三项 gate 已通过（STORM-SHADOW-IMPL / -EVIDENCE / -REVIEW 勾选，13/20）；submodule commit/push 与父仓 gitlink 尚未执行（本阶段不 commit/push），STORM-SHADOW-SUBCOMMIT / -PARENT 与 S4 全部 criteria 保持未勾选，不进入 S4。

审查全程确认：shadow 未改变任何控制流（would_abort 仅作为 counterfactual 信号写入 audit，绝不进入 termination claim / abort / dispose / 拦截 / 节流，无通用 total tool cap）、未隐藏真实 abort 路径（governor 真实 schema_error_storm 路径逐字不变）、签名可复算（v4 production canary 的 11 条 shadow row hash + 2 条 governor hash + task hash 全部经 `jq -cS . | tr -d '\n' | sha256sum` 复现，embedded replay 11/11 一致）、隐私（原文/field path/tool args/normalized 不落盘，仅 opaque HMAC key_id+digest）——这些约束均未被突破。

## 审查对象

- 实现：`extensions/dispatch/storm-shadow.ts`（独立纯状态机，不 import 控制流模块）、`extensions/_shared/audit-hmac.ts`（`auditHmacHexStrict` strict key 路径 + cache 复验修复）、`extensions/dispatch/index.ts` wiring（`buildSchemaRejectionShadowInput` 只用 `auditHmacHexStrict`、shadow verdict 只进 `appendDispatchAudit`）、`extensions/dispatch/worker-run-governor.ts`（`classifySchemaErrorToolResult` 导出，governor 保持 observe-only）。
- 证据：dossier `docs/evidence/2026-08-10-dispatch-storm-shadow-s3-production.json`（v4 唯一 final 主证据，`result=accepted_impl_evidence_review_waiting_subcommit`、acceptance scope v4 strict contract；v3/v2 canary 保留为历史，不用于勾 criterion）。
- Smoke：`smoke-dispatch-storm-shadow` 34/34（含 strict-key cache 复验 P1 回归、strict-key cross-process、真实 SDK runInProcess + faux provider 同 run 碰撞对不合并 + exact4 第 4 次 would_abort 后继续正常完成）、`smoke-llm-audit` 16/16、`smoke-llm-audit-budget` 4/4、audit-log rotation/maintenance/prune（10/19/27）、terminal-closure 22/22、dispatch-audit-v5 12/12、worker governor 90/90、C5 audit-row-schema、dispatch output-format 72/72、dispatch trace 25/25、reasoning trace 19/19 全部通过；`git diff --check` 干净；改动文件 LSP 0 diagnostics、focused tsc 通过（全入口 9 个既有基线错误未扩大）。

## 五轮审查记录

### 首版：4 RED（不可达 / toolUse）

四模型 T0+/T0 审查均为 RED，四方一致确认两个核心问题：

- **候选 A 生产不可达**：full-output-cap assistant signature 候选——真实 cap hit 在单 run 内至多一次且为终态事件，post_cap 之后不可能再有同签名 cap-hit 事件，would_abort 路径只能靠合成 tail 拼接证明，非真实生产可达。
- **toolUse 误算为有效进展**：`isProviderProgressAssistantMessage` 对 stopReason=toolUse 的消息返回 true，纯 toolUse 消息被误算为有效进展（真实 SDK 事件流复现）。

修复：候选 A 重构为 **post-cap exact schema-rejection signature**（rule_version 升 `dispatch-storm-shadow/v2`、rule_id `storm/post-cap-schema-rejection-signature/v1`）——cap 明确为既有 `toolObservers.schemaErrorStorm.observeAfter`（默认 3）的只读镜像，每次真实 tool_execution_end schema rejection 复用 governor 同一 classifier 生成 exact identity（tool name + closed error class + field path），落盘与 state 比较只用项目 audit HMAC 的 key_id+digest；候选 B 改为**纯 toolUse 消息绝不算 progress**（neutral、basis `tool_use_only`），虚假 `repeated_error` basis 改真实 `error_response`。RED-first 验证：wiring capAfter 临时改 99 后真实 run would_abort 不再到达，两条真实 SDK check 变红，恢复后 26/26 绿。

### v2 复审：3 GREEN + OpenAI RED（normalized collision）

三票 GREEN；OpenAI gpt-5.6-sol 一票 RED，暴露唯一 P1：

- **normalized collision**：v2 exact identity 只含 tool+class+fieldPath，`read({})` vs `read({limit:5})` 的 Received arguments JSON 不同（同 tool/class/path、不同参数）会被误合并为同一 signature。

修复（rule_version 升 `dispatch-storm-shadow/v3`）：exact identity 增加 **bounded normalized descriptor**（<=4096、空白规范化），HMAC 输入改为无歧义结构化/framed tuple（`JSON.stringify([toolName, errorClass, fieldPath, normalized])`）——同 tool/class/path 但 normalized 不同的真实 rejection 绝不合并。RED-first 验证：`smoke-dispatch-storm-shadow` 重写为 28 checks，新增同 tool/class/path 不同 normalized A/B/A/B 各 count2 永不 trip、A/A/A/A 仍第 4 次 trip、真实 SDK 同 run 碰撞对不合并 + 4 次同 exact identity would_abort=true 后继续正常完成。

### v3 复审：3 GREEN + OpenAI RED（ephemeral fallback）

三票 GREEN；OpenAI gpt-5.6-sol 一票 RED，暴露唯一 P1：

- **ephemeral fallback**：v3 用 `auditHmacHex` 签名 shadow signature，持久 project key 不可用时（不安全目录/错误 mode/owner/symlink）会降级到**每进程随机 ephemeral key**（跨进程不稳定、digest 不可复现），且 StormShadow state machine 只比较 digest、忽略 key_id。

修复（rule_version 升 `dispatch-storm-shadow/v4`，signature domain 保持 `dispatch/storm-shadow/schema-rejection-signature/v2`——HMAC material 未变，仅 key 来源 API 从 fallback-capable 改为 strict）：(1) wiring 只用 `auditHmacHexStrict`（持久 project key、strict path）签名；持久 key 不可用时 `buildSchemaRejectionShadowInput` fail-open 返回 `{ schemaRejection: false }`、无 signature——事件不 eligible、worker 继续，**绝不生成/接受 ephemeral key 作为 eligible**（S2 retry HMAC 语义逐字不变，`audit-v5.ts` 仍用 `auditHmacHex`）；(2) state machine 内部比较键改为**无歧义复合 key_id:digest**，绝不只比 digest——不同 key 同 digest 绝不合并；(3) 文档明确 strict key availability 是 eligibility 前置。RED-first 验证：`smoke-dispatch-storm-shadow` 33/33——新增两个独立 process 同 project/material 得同非 ephemeral key_id+digest、故意不安全目录 strict 路径 fail-open、state 同 digest 不同 key 不合并（keyA/keyB 各 count1 永不 trip、同 key+digest 第 4 次仍 trip）；wiring 源码断言 `buildSchemaRejectionShadowInput` 只用 `auditHmacHexStrict(`、绝不用 `auditHmacHex(`。v4 production recanary 固化后交复审。

### v4 复审：3 GREEN + OpenAI RED（cache bypass）

三票 GREEN；OpenAI gpt-5.6-sol 一票 RED，暴露唯一 P1：

- **cache bypass**：`extensions/_shared/audit-hmac.ts` 的 `strictProjectKey` 命中 `KEY_CACHE` 后直接返回 cached material、**不复验** key file 的 mode/owner/symlink/identity——首次安全 strict 调用填 cache 后，同进程内 key file 或其目录被改成不安全状态（`llm-audit` 0755、key file 0644、key file 换成 symlink），`auditHmacHexStrict` 仍继续返回缓存 key，安全校验被绕过。

修复（rule_version 保持 `dispatch-storm-shadow/v4` 不变、signature domain 不变）：`strictProjectKey` 每次调用都经 `persistentProjectKey` **完整重新验证** root/.pi-astack/llm-audit/key file 的 mode/owner/symlink/identity 并读取强 key，cache 只更新为刚验证过的值、**绝不信任 cached material 跳过复验**；普通 `projectKey`/`auditHmacHex` 的 cache/fallback 语义与性能逐字保持（S2 普通 retry 不每次读磁盘；cache miss 才走 strict 复验并填 cache；strict 失败仍走 ephemeral fallback，契约不变）。RED-first 验证：`smoke-dispatch-storm-shadow` 34/34——新增 P1 回归 check：安全首次 strict 填 cache → 同进程 `llm-audit` 改 0755 → 第二次 `buildSchemaRejectionShadowInput` 必须 `{ schemaRejection: false }`/无 signature（fail-open）、直接 `auditHmacHexStrict` 也 throw、独立 process（fresh 无 cache）同样拒绝；恢复 0700 后 strict 恢复且 **same key_id+digest**；key file 0600→0644 同样 cache 后拒绝/恢复（same key/digest）；key file 换成 symlink 后 strict 拒绝（cache 不绕过 symlink 检查）、移除后 strict 恢复 fresh persistent key。RED 验证：临时恢复旧 cache-first `strictProjectKey` 后新 check 失败（`cached strict key must not bypass the directory mode re-verification`），恢复修复后 34/34 绿。既有 v4 production 证据在稳定安全状态下仍有效、**不标 stale**。

### 最终复审：Fable / Opus / Grok / OpenAI 全部 GREEN，无 P0/P1

四票全部 GREEN，无 P0/P1。复审逐项确认：

- **shadow 未改变控制流**：would_abort 仅作为 counterfactual 信号（`would_abort_only_no_control_effect`）写入 audit，绝不进入 `emitWorkerRunDecision` / termination claim / abort / dispose / 拦截 / 节流；无通用 total tool cap；governor 真实 schema_error_storm 路径逐字不变（observe-only）。
- **未隐藏真实 abort 路径**：governor 自身行为与阈值未被 shadow 改动，真实 abort 路径完整保留。
- **签名可复算**：v4 production canary 11 条 shadow row hash + 2 条 governor hash + task hash 全部经 `jq -cS . | tr -d '\n' | sha256sum` 从 audit 实际复算一致；embedded replay（`replay_projection`，11 条安全预投影输入 + expected observation）经项目 jiti 导入 `replayStormShadow` 实际重放 11/11 一致（0 mismatch、exit 0、final snapshot segment=3/post_cap=false/consecutive=0/window=0、digest 分布 A1=5/A2=1）。
- **strict key 契约**：签名仅经 `auditHmacHexStrict`（持久 project key、strict path），strict key availability 是 eligibility 前置，ephemeral key 绝不生成/接受为 eligible；state machine 比较无歧义复合 key_id:digest；cache 复验修复后同进程 key file/目录被改不安全状态时 strict 拒绝（fail-open），恢复后 same key_id+digest。
- **隐私**：原文/field path/tool args/normalized 不落盘，仅 opaque HMAC key_id+digest；audit 无 raw（privacy grep 验证）。
- **S1/S2 回归**：terminal closure 22/22、dispatch-audit-v5 12/12、worker governor 90/90 等全绿，唯一 termination claim、诚实 cleanup、additive audit v5 语义未被放宽。

## production canary v4（最终有效证据）

`docs/evidence/2026-08-10-dispatch-storm-shadow-s3-production.json` 顶层 `result=accepted_impl_evidence_review_waiting_subcommit`、acceptance scope v4。v4 主 canary 事实：session `019feb26-6262-73da-903f-5f5e03a6206a`、run `dtr_a73709635757e21af3f32744`、worker `9f239a2e-b5d9-439c-83a9-a3aa016d8c6e`、rule_version `dispatch-storm-shadow/v4`、worker deepseek-v4-flash real read、duration 18917ms、tools 8、completed/cleanup true/lifecycle normal/owner run/postterminal 0、persistent key_id `7a2e3c8c55f261fb329ab4b3`。碰撞对 A1=`d4072bcf…`/A2=`f39283b5…`（同 tool/class/path 不同 bounded normalized descriptor）各 count1 不 trip；success reset seg1；之后 exact4 均 A1 counts1..4，第三 post_cap/noabort、第四 abort/first_trip；之后 already marker、success reset seg2、visible seg3、task。11 条 shadow row hash（`8054721d…`/`00518bcb…`/`8746b092…`/`eabb1434…`/`6f262d48…`/`3606a522…`/`4c9fc1f9…`/`dde91c6e…`/`0f32f49a…`/`a8d7ed84…`/`54a96cd7…`）、governor hash `c2ab05ec…`/`72614cbc…`、task hash `b62e2053…` 全部复现。v3 canary 保留为历史（`superseded_by_v4_strict_contract`，行为/identity 正确但 v4 strict contract 取代其主证据地位）、v2 更旧历史保留（`succeeded_behavior_but_superseded_by_v3_exact_identity`，含首个 ephemeral-key run `dtr_051a959a…` rejected）——旧 RED 与旧证据均不隐去。

## 最终有效门

T0+ Fable + cross-vendor Opus / Grok / OpenAI 均 GREEN，无 P0/P1。审查确认 shadow 未改变控制流、未隐藏真实 abort 路径、签名可复算、strict key 契约与隐私约束未被放宽。S3 的 implementation / evidence / review 三项 gate 通过；submodule commit/push 与父仓 gitlink 尚未执行（本阶段不 commit/push），STORM-SHADOW-SUBCOMMIT / -PARENT 与 S4 全部 criteria 保持未勾选，不进入 S4。

## 隐私处理

本记录只固化审查轮次、票型、暴露问题与修复语义，不粘贴 production 审计行正文、prompt 内容或用户会话内容；canary 事实与 hash 见 evidence dossier，审计行仅按路径引用（`.pi-astack/` 为本地未跟踪目录，不纳入本文件）。
