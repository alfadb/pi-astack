---
doc_type: review-evidence
status: review-passed
created: 2026-06-16
gate: cross-vendor review (goal g-eaaa09e1, task C) — read-only detector; 2 cross-vendor T0 SHIP-WITH-CHANGES, 3 findings fixed (see §结果)
---

# C 理由保鲜:source_ref provenance liveness 检测器

## 背景

251 条 abrain 条目 pin 了 `source_ref: "docs/adr/NNNN-slug.md#<heading>@<sha>"`(由 `ingest-adr.ts:buildSourceRef` 写;`rationale.ts` 暴露它"so drift is detectable")。C 实现真正的 drift/liveness 检测。

## 检测器(`extensions/memory/provenance-liveness.ts`,只读)

`parseSourceRef(ref)` → `{adrPath, heading, sha}`(处理引号、`###` 多级 heading、尾部 `@sha`)。
`checkProvenanceLiveness(entries:{slug,sourceRef}[], {docsRoot})` → 每条一个**确定性 verdict**;每个 ADR 只读一次(缓存)。

verdict 优先级(高→低):
1. `file_missing` — ADR 文件没了(改名/删除)→ 源丢失。
2. `source_superseded` — ADR status superseded/deprecated → 决策被取代,**需复查**。
3. `source_ingested` — ADR 已被 ingest 入 abrain(status archived **或** 正文带 ingest 标记 `逐条 slug`/`分解入 abrain`/`ingest 入 abrain`)→ **预期,非陈旧**(条目本身就是被 ingest 的 rationale,heading 被压缩掉是设计使然)。
4. `source_proposed` — ADR 仍 proposed → 临时来源。
5. `heading_missing` — ADR 存活(非 ingest)但 pin 的 heading 没了 → **真 section drift**。
6. `live` — accepted/active + heading 在。
0. `unparseable` — ref 畸形。

`FLAGGED_VERDICTS` = {superseded, file_missing, heading_missing, unparseable} —— 这些才上报给 sediment。`source_ingested`/`source_proposed`/`live` 是预期/信息态。

**关键设计点**:ingest-condensation 必须从 drift 里区分出来。实测 251 条指向的 ADR 全部被 condense 成「方向/机制 + 逐条 slug」骨架,pin 的原 heading 全没了。若只看"heading 在不在",会把 142 条误报成 drift 淹没 sediment。靠 ingest 标记(status archived OR 正文 marker)把它们正确归为 `source_ingested`(预期)。`source_superseded` 优先于 `source_ingested`,所以被取代的决策即便也 ingest 过仍会被 flag。

## 样本验证(真实 251,read-only,`scripts/derive-provenance.mjs`)

```
provenance liveness: 251/251 entries carry source_ref
  source_ingested: 251
```

**当前 0 个 actionable flag** —— 诚实结论:251 条的 source ADR 全部是 ingest-condensed(预期),无 superseded、无 file_missing、无真 heading drift、无 unparseable。第二大脑的 provenance 当前是干净的;检测器是**前瞻守卫**(将来某 ADR 被 superseded / 删除 / 非 ingest heading 漂移时即 flag)。

## 写路径(交 sediment)

检测器是只读 kernel,**不自动归档/退场**(主会话只读红线),**不加周期扫描**(事件驱动)。sediment 在它的策展回合可 import `checkProvenanceLiveness` 取 findings、对 flagged 条目做 LLM 判断(archive/contest/update)。本任务交付检测器 + 验证 + smoke;sediment 的消费接线是其写路径职责(单独)。

## 回归门:`smoke:derive-provenance`(16 断言,绿)

7 个 verdict 全覆盖 + parseSourceRef(引号/###/无@/无.md)+ 精确优先级(superseded 优先于 ingested、ingested 优先于 heading_missing)+ 无 source_ref 跳过 + flagged 集合精确。

## 给审查者的问题

1. ingest 标记启发式(status archived OR 正文 `逐条 slug`/`分解入 abrain`/`ingest 入 abrain`)是否稳健?会不会(a)漏判 ingest 把预期误报成 142 drift,或(b)过判把一个**真**漂移/被取代的 ADR 藏成 ingested?(注:superseded 优先级在 ingested 之上,已护住被取代的情况。)
2. parseSourceRef 有没有能错切的边界(heading 含 `@`/`#`、path 不以 .md 结尾、Windows 路径)?
3. verdict 优先级排序是否合理?heading_missing 只对非 ingest 的存活 ADR 触发——够不够?
4. "当前 251 全 source_ingested、0 actionable"这个结论成立吗?检测器是否真有前瞻价值,还是说 source_ref 这套 provenance 已无意义(因为原 heading 注定都被 condense 掉)?

## 结果(2026-06-16, 2 家跨厂商 T0)

gpt-5.5 + kimi-k2.6 均 **SHIP-WITH-CHANGES**, 3 个发现已闭:

- **修1(gpt-5.5,重要):ingest 误判隐藏 drift**。原全正文扫 marker 会误中 ADR 0035(它只是 *提及* 0015 被 ingest, 本身是活的)—如果未来某 source_ref 指向 0035 且 heading 漂移, 会被错藏成 source_ingested。**修**:marker 只扫 **heading 行**(11 个 condensed ADR 的 marker 都在 `## 机制（…逐条 slug）` heading; 0035 的在 prose)—实测修后 251 仍全 source_ingested 且 0035 不再误判。
- **修2(两家):parseSourceRef**。`indexOf(".md")` 会误切 `.mdx`/`.md.bak`。**修**:按 buildSourceRef 的真实格式 split on `.md#`(路径总以 .md 结尾、分隔符是紧跟的 #)。
- **修3(kimi):路径逃逸**。`path.resolve(docsRoot, adrPath)` 遭 `../../` 可逃出根。**修**:加 containment guard, 出树 → file_missing。
- INGEST_MARKER_RE 作为 canonical condensation marker 已在注释记明;bare catch 将 EACCES 归 file_missing(只读检测可接受)。
- 两家都认同:当前 cohort 全 source_ingested 是诚实的; 检测器对 file_missing / superseded / unparseable / 未来非-ingest ADR 漂移 仍有前瞻价值。
- 新增断言: .mdx 不误判、prose-only marker 非 ingested(live / heading_missing)、路径逃逸 file_missing — **smoke 20 断言全绿**。

**结论**:C 评审通过, 3 个发现均已闭。
