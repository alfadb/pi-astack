---
doc_type: review-evidence
status: pending-review
created: 2026-06-16
gate: cross-vendor review (goal g-eaaa09e1, task E) — suppresses tool calls on the dispatch tool_call path
---

# E 工具空转检测:tool idle-loop guard

## 机制

pi 的 `tool_call` 事件:handler 返回 `{ block: true, reason }` 即**抑制该工具执行**,`reason` 作为工具结果回流给模型(`emitToolCall` 见 block 即短路)。dispatch 扩展注册该 handler。

- `extensions/dispatch/tool-loop-guard.ts`(纯逻辑):`toolCallSignature(tool, input)`(key 排序 JSON,顺序无关)、`evaluateToolLoop(state, sig, threshold)`(连发计数)、`buildLoopReflection`、`resolveIdleLoopGuardSettings`。
- `dispatch/index.ts` 接线:per-session `Map<sid, {lastSig, consecutive}>`;`agent_start` 每轮清空该 session 的 streak;`tool_call` 算签名→连发计数→达阈值 `{block:true, reason:<reflection>}`。

**判据:连发(consecutive)相同 (tool, args)**。任何不同的工具调用都把 streak 归零。阈值 3 = 允许两次相同、第 3 次起抑制(直到签名改变)。

## 为什么保守(不误杀)

连发-only 是**假阳性地板**:read→edit→read→edit→read(交错同文件)里 read 从不连发 → 永不抑制;有间隔的重跑测试(中间有别的调用)也不连发。只有**真正背靠背、中间无任何动作**的重复(结果证明不会变)才被抑制。状态极小、每轮重置、显式 settings kill-switch(`dispatch.idleLoopGuard` = `{enabled:true, threshold:3}`,已落 settings.json + schema)。

## 已知局限(请审查者判断可接受性)

1. **vault-bash 假阴性**:abrain 的 vault bash guard(字母序在前)会在本 guard 之前改写 `bash` 的 `input.command`(注入 vault env)。若改写包含每次不同的临时路径/nonce,则同一 vault-bash 连发会产生不同签名 → **漏判**(安全的假阴性,绝不假阳性)。非-vault bash 与其它所有工具不受影响。
2. **被抑制的 vault-bash 可能留下孤儿 vault 状态**:abrain 先跑(注册 `vaultBashRuns.set(toolCallId,...)` + 写 env 文件),本 guard 再 block → 该调用不执行,abrain 那条 post-run 记录无人消费(每个被抑制的 vault-bash 一条,极少)。

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
