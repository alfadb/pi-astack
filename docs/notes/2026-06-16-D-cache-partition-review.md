---
doc_type: review-evidence
status: review-passed
created: 2026-06-16
gate: cross-vendor review (goal g-eaaa09e1, task D) — touches universal every-turn system-prompt assembly; 2 cross-vendor T0 SHIP-WITH-CHANGES, both findings fixed (see §结果)
---

# D 缓存分区修复:volatile-suffix 协议

## 问题(实测,非计划假设)

计划假设是"把分钟级时间挪到末尾"。实测发现 **time 已经在末尾**(time-injector 本就 append 到最后)。真正破坏 prefix-cache 的是另外两块**易变注入夹在 stable 块中间**:

注入器按扩展加载顺序(字母序)跑、各自 append 到 `event.systemPrompt`:
`abrain(rules) → goal(g) → memory(footnote+memory_decide, path-A) → model-curator → sediment → time-injector`。

- **goal 状态块**(`goal` 扩展,字母序很靠前):goal 活跃时每轮注入,内容每轮变 → 它后面**几乎整个 prompt** 每轮都被 cache-bust。
- **path-A 记忆召回块**(`memory` 扩展,中部):每轮按用户消息召回不同条目 → 它后面的 model-curator(大块)+ sediment 每轮重算。

stable 块(rules / footnote+memory_decide / model-curator / sediment)本应是可缓存前缀,却被这两块易变内容从中间割裂。

## 修复:volatile-suffix 协议(`extensions/_shared/volatile-suffix.ts`)

- `wrapVolatile(block)`:易变注入器把自己的块用 `<!-- pi-astack:volatile-suffix -->` … `<!-- /pi-astack:volatile-suffix -->` 包起来。
- `hoistVolatileSuffix(prompt)`:把所有被包裹的块**移到末尾**(保留相对顺序、丢弃空/孤儿 wrapper、幂等)。
- 由 **time-injector**(实际末位注入器 —— 字母序在它之后的 `turn-progress` 是 runner shim 不 append 块、`goal/memory` 在它之前)在 append time 前调用 `hoistVolatileSuffix`,然后把 time append 到最后。

接入点(各 1 行):
- `goal/index.ts:374` `wrapVolatile(formatGoalBlock(state))`
- `memory/index.ts:815` `wrapVolatile(r.block)`(path-A)
- `time-injector/index.ts` 在 strip time 后、append time 前 `hoistVolatileSuffix(cleaned)`

最终顺序:`[全部 stable…][goal][path-A][time]`。stable 前缀跨轮字节一致。

## 为什么这样设计

- 加载顺序是字母序、易变注入器无法把自己排到 stable 之后(`goal`<`memory`<`model-curator`<`sediment`),所以靠"末位注入器收口"而非改加载顺序(后者脆、加个扩展就破)。
- 通用 wrapper 标记(非把 goal/path-A 的具体 marker 写进 time-injector)→ 解耦,未来新增易变块只需 `wrapVolatile`。
- 关键不变式:**移除一个夹在中间的 wrapped 块后,seam 恢复成与"本就没有该块"完全相同的 `\n\n`**(正则吃掉两侧 `\n*` 再回填 `\n\n`),所以 goal 在/不在都不影响 stable 前缀字节。

## 回归门(均绿,读断言非看 banner)

- `smoke:cache-partition`(新,14 断言):分区(全 stable 在全 volatile 前)、无丢失、相对顺序、time 最后、**稳定前缀跨轮字节一致(goal 在/不在 + path-A 内容不同)**、幂等、空 wrapper 清理、纯 stable no-op。
- `smoke:time-injector` 14/14(改用 jiti 加载以解析新跨模块 import;纯函数断言不变)。
- `smoke:goal-state` 12/12(含 goal 注入 format+strip+幂等)。
- `smoke:memory` ok、`smoke:memory-path-a` 71/71(path-A 注入幂等 + live e2e)。

## 给审查者的问题

1. `hoistVolatileSuffix` 有没有能**丢块 / 串块 / 破坏 stable 前缀字节一致**的边界(相邻 volatile 块、wrapper 内容里恰含 marker 串、CRLF、超长)?
2. 把 path-A / goal 移到末尾,会不会损害它们的语义(goal 的 anti-compaction-drift?path-A 的"在场即可"召回?位置变了但仍每轮在场)?
3. time-injector 当"末位收口者"的假设是否稳:真的没有别的扩展在它之后 append systemPrompt 块?
4. 这个改动是否值得(stable 前缀里 model-curator 大块每轮重算的代价 vs 此修复的复杂度)?有没有更简单的做法?

## 结果(2026-06-16, 3 家跨厂商 T0, 2 家出完整结论)

- **gpt-5.5 / kimi-k2.6 均 SHIP-WITH-CHANGES**(deepseek-v4-pro 1800s 超时、无可用结论。两家语义/设计都肯定:goal 移末尾不损 anti-compaction-drift(仍每轮在场)、path-A 移末尾不损“在场即可”召回、time-injector 当末位收口者取向可接受。
- **Finding 1(gpt-5.5,重要):marker 碰撞**。path-A 内容是任意用户记忆，若某条目恰好引用本协议 marker 串，非贪婪正则会在首个内嵌 END 处 mis-slice，可能把 volatile 文本泄进稳定前缀。**已修**:`wrapVolatile` 对块内容 `sanitizeMarkers`(把内嵌 marker 转义成不同的 HTML 注释)。
- **Finding 2(kimi):seam 自洽**。no-blocks 分支返 `${head}\n` vs with-blocks `${head}\n\n...`(最终输出被 time-injector 归一化后字节一致，但函数自身不该依赖调用方)。**已修**:no-blocks 也返 `${head}\n\n`。另加 `\r?` 对 CRLF 鲁棒(当前 \n-only)。
- **新增回归断言**:smoke:cache-partition 加 marker-collision(内嵌 marker 不泄漏、转义后内容完整、真实 BEGIN/END 计数==块数)+ 有/无 volatile 时 stable 连续段字节一致 —— 现 **18 断言全绿**。
- 回归:time-injector 0 fail、goal-state 12/12、memory-path-a 71/71。

**结论**:D 评审通过,两个发现均已闭。
