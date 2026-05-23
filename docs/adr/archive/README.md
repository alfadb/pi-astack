# ADR Archive

这里存放已经不应作为 current design 实施依据的 ADR 原文。

归档后不保留原路径 stub；引用方应直接链接到 `docs/adr/archive/<number>-*.md`。Current reading guide 见 [../INDEX.md](../INDEX.md)。

## Archived ADRs

| ADR | Why archived |
|---|---|
| [0002](./0002-gbrain-as-sole-memory-store.md) | gbrain sole-store design retired. |
| [0004](./0004-sediment-write-strategy.md) | three-voter sediment retired by single-agent/curator design. |
| [0005](./0005-pensieve-deprecated.md) | old Pensieve retirement path superseded by abrain project migration. |
| [0007](./0007-offline-degraded-mode.md) | gbrain offline fallback premise retired. |
| [0008](./0008-pi-dotfiles-dual-role.md) | `.gbrain-source` routing superseded by ADR 0017 strict binding. |
| [0011](./0011-sediment-two-track-pipeline.md) | gbrain multi-source two-track design retired. |
| [0012](./0012-sediment-pensieve-gbrain-dual-target.md) | pensieve+gbrain dual-target retired; useful only for gbrain multi-source evidence. |
| [0024-r5-pre-r6-cleanup-snapshot](./0024-r5-pre-r6-cleanup-snapshot.md) | R5 终版 ADR 0024 原文快照，2026-05-21 R6 重整理前保留。快照理由：R6 是同日内部修订（双层 reframe：机械门 → prompt engineering），wholesale revision 量较大，快照供追溯原文。评审轨迹详 [../audits/2026-05-21-adr-0024-multi-llm-r1-r6.md](../../audits/2026-05-21-adr-0024-multi-llm-r1-r6.md)。**仍以 R6 终版 [0024-second-brain-from-natural-conversation.md](../0024-second-brain-from-natural-conversation.md) 为 current，本 snapshot 仅供历史对照**。 |

Current ADR reading guide: [../INDEX.md](../INDEX.md).
