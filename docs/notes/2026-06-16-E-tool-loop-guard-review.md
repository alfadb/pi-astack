---
doc_type: review-evidence
status: review-passed
created: 2026-06-16
gate: cross-vendor review (goal g-eaaa09e1, task E) — 3 cross-vendor T0 (2 SHIP / 1 SWC); bash exempted per review (see §结果)
---

# E 工具空转检测:tool idle-loop guard

## 机制

pi 的 `tool_call` 事件:handler 返回 `{ block: true, reason }` 即**抑制该工具执行**,`reason` 作为工具结果回流给模型(`emitToolCall` 见 block 即短路)。dispatch 扩展注册该 handler。

- `extensions/dispatch/tool-loop-guard.ts`(纯逻辑):`toolCallSignature(tool, input)`(key 排序 JSON,顺序无关)、`evaluateToolLoop(state, sig, threshold)`(连发计数)、`buildLoopReflection`、`resolveIdleLoopGuardSettings`。
- `dispatch/index.ts` 接线:per-session `Map<sid, {lastSig, consecutive}>`;`agent_start` 每轮清空该 session 的 streak;`tool_call` 算签名→连发计数→达阈值 `{block:true, reason:<reflection>}`。

**判据:连发(consecutive)相同 (tool, args)**。任何不同的工具调用都把 streak 归零。阈值 3 = 允许两次相同、第 3 次起抑制(直到签名改变)。

## 为什么保守(不误杀)

连发-only 是**假阳性地板**:read→edit→read→edit→read(交错同文件)里 read 从不连发 → 永不抑制;有间隔的重跑测试(中间有别的调用)也不连发。只有**真正背靠背、中间无任何动作**的重复(结果证明不会变)才被抑制。状态极小、每轮重置、显式 settings kill-switch(`dispatch.idleLoopGuard` = `{enabled:true, threshold:3}`,已落 settings.json + schema)。

## bash 豁免(复评结论)

`bash` 被**整体豁免**(`GUARD_EXEMPT_TOOLS`):它是通向 timeful 外部世界的逃生口(`sleep N && curl health` 轮询、`pgrep`、`docker ps`、重试 flaky fetch)——相同 args 连发是合法的等待/轮询,且结果**会**在调用间变化,抑制它会弄坏 agent。豁免 bash 同时**彻底避开**了与 abrain vault-bash 改写的交互(原本的假阴性 + 孤儿 vault 状态两个顾虑随之消失)。guard 仍守 read/grep/find/ls/dispatch_agent/memory_search 等——这些工具相同 args 连发必然是无意义空转(结果不可能变)。

## 样本 + 回归门:`smoke:tool-loop-guard`(15 断言,绿)

- **样本(连发抑制)**:`read{path:A}` ×4 → block 序列 `[f,f,t,t]`(第 3、4 次被抑制)。
- **假阳性护栏**:`read A, edit A, read A, edit A, read A` → 全 `false`(read A 从不连发);不同 bash 命令 → 全 `false`。
- 签名 key 顺序无关 / 不同 args/tool 不同;threshold=2 第 2 次起抑制;reflection 含 tool 名+次数+「改 args 绕过」提示;settings 默认/自定义/`threshold<2 回默认`/垃圾输入 fail-open。
- 回归:`smoke:dispatch`、`smoke:dispatch-hub`、`smoke:memory` 均绿(dispatch 改动未破)。

(附带:修了 C 提交里 package.json 的重复 `smoke:derive-provenance` 键。)

## 给审查者的问题

1. **连发-only + 阈值 3** 够保守吗?有没有一类工具**本应**被相同 args 反复调用(轮询/等待)而会被误伤?pi 工具集里存在这种吗?
2. block 把 reason 回流给模型——模型会据此跳出(改 args/换思路),还是可能继续撞同一个 block?永久抑制相同签名(直到改变)是否是对的行为?
3. vault-bash 的两个局限(假阴性 + 孤儿 vault 状态)可接受吗?还是应当干脆**豁免 bash**(只守 read/grep/find/dispatch_* 等无副作用或幂等工具)以彻底避开与 abrain 的交互?
4. per-session state + 每轮 agent_start 重置,有无竞态/泄漏(子代理各自 sid 隔离;Map 永不清理已结束 session 的条目——单进程内会缓慢增长吗)?

## 结果(2026-06-16, 3 家跨厂商 T0)

kimi-k2.6 + deepseek-v4-pro **SHIP**;gpt-5.5 **SHIP-WITH-CHANGES**。三家都验证了逻辑正确:无 off-by-one(阈值 3 → 放行 1/2、抑制 3+)、stableStringify 无碰撞(NaN/Infinity 理论性、JSON tool args 不可能出现)、`{block,reason}` 合约属实(reason 回流模型)、`event.input` 字段正确、per-session sid keying 正确、多个 agent_start handler 可共存。

- **采纳 gpt-5.5:豁免 bash**。唯一实质变更。bash 是唯一一类“相同 args 可合法连发且结果会变”的工具(轮询/等待),豁免后既除了该假阳性面,也顺带闭了 abrain vault-bash 交互。
- **采纳 Map 界**:超 128 sessions 则修剪除当前外的条目(防长进程慢泄漏;单用户远不会触)。
- block-loop 行为:三家认同“持续抑制相同签名(直到变化)”比“抑一次再放行”更安全(reflection 已给逃生口:改 args/换思路)。

新增断言:isGuardedTool(read/grep/dispatch_agent 受守、bash 豁免)。**smoke:tool-loop-guard 17 断言全绿**;回归 smoke:dispatch/dispatch-hub/memory 绿。

**结论**:E 评审通过。
