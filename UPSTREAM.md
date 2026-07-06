# pi-astack 上游 / vendor 策略

> 原则：read-only vendor submodule + owned adaptation layer，避免长期 fork。上游变更由 LLM 阅读 diff 后和 alfadb 讨论，不用脚本机械批量决策。

## 1. 三分类

| 类别 | 含义 | 是否进入上游跟踪 |
|---|---|---|
| A 类：自有功能 | alfadb 永久 own，不向上游 PR | 否 |
| B 类：vendor 移植参考 | 上游只读引用，pi 端口在 pi-astack 内维护 | 是 |
| C 类：内部组件迁入 | 曾经独立的 alfadb 自有包/文件，现并入 pi-astack | 否 |

## 2. 当前事实

- 当前仓库没有 active read-only methodology/reference submodule。
- `vendor/gstack/` 已于 2026-07-06 退役为 reference-on-demand；历史 upstream 为 `https://github.com/garrytan/gstack.git`，last pinned SHA 为 `e362b0ae2f94afdcb55e37cc4690f9ce55ee5d32`。
- Pensieve 上游参考 submodule 已移除；历史 pinned ref 为 `8731f61b18a65f09eb0d3cd1ffbff7650ef8df48`。
- `vendor/` 是方法论参考来源，不是 runtime package surface；pi-astack 不从 vendor 目录直接加载扩展/skills。
- 当前仓库没有 `skills/`、`prompts/`、`extensions/browse/`、`defaults/` 目录。
- `extensions/gbrain/` 已废弃，不是 current component。
- pi-astack runtime config 在 `~/.pi/agent/pi-astack-settings.json`，不是官方 settings chain 下的 package-local defaults。

## 3. A 类：自有功能

| Component | Notes |
|---|---|
| `extensions/memory/` | v7+ 自有 memory facade；替代 gbrain tools。 |
| `extensions/sediment/` | LLM curator + abrain writer substrate。 |
| `extensions/abrain/` | 七区 layout、project binding、vault。 |
| `extensions/dispatch/` | ADR 0009 后的 subprocess multi-agent capability。 |
| `extensions/model-fallback/` | alfadb 自用 fallback policy。 |
| `extensions/model-curator/` | curated/raw model capability prompt。 |
| `extensions/vision/` / `extensions/imagine/` | visual tool surface。 |
| `extensions/compaction-tuner/` | context percentage compaction trigger。 |
| future `skills/memory-wand/` / prompts | 若恢复，也是 pi-astack 自有端口。 |

## 4. C 类：内部组件迁入

| Component | Origin | Current disposition |
|---|---|---|
| `extensions/dispatch/` | `alfadb/pi-dispatch` | merged; original archive/redirect。 |
| `extensions/sediment/` | `alfadb/pi-sediment` | merged; original archive/redirect。 |
| `extensions/model-curator/` | in-tree pi skill | copied into pi-astack。 |
| `extensions/model-fallback/` | old retry-stream-eof extension | renamed/evolved into A 类。 |
| `extensions/gbrain/` | old gbrain extension | deleted/obsolete; replaced by memory facade。 |
| `alfadb/pi-gstack` content | old pi-gstack archive | not currently restored into this repo; future port only if needed。 |

## 5. B 类：retired / reference-on-demand vendor methodology references

There are currently no active B 类 vendor submodules. Retired references are not checked out by default and are not runtime dependencies. When a retired upstream is needed, clone it into a temporary path outside the tracked repo, inspect the pinned ref or upstream diff, then copy/adapt ideas into owned pi-astack files.

| Path | Upstream | Last pinned ref | Retired on | Role / access pattern |
|---|---|---|---|---|
| `vendor/gstack/` | `https://github.com/garrytan/gstack.git` | `e362b0ae2f94afdcb55e37cc4690f9ce55ee5d32` (`main`) | 2026-07-06 | Claude-code/gstack methodology reference: review/QA/security skills, `ship` flow, browse ideas, specialist docs. If needed: `git clone https://github.com/garrytan/gstack.git /tmp/gstack-ref && cd /tmp/gstack-ref && git checkout e362b0ae2f94afdcb55e37cc4690f9ce55ee5d32`; for upstream review, fetch in that temp clone and read `git diff e362b0ae2f94afdcb55e37cc4690f9ce55ee5d32..origin/main`. |

Pensieve was previously tracked as a read-only methodology reference at `https://github.com/kingkongshot/Pensieve.git` (`8731f61b18a65f09eb0d3cd1ffbff7650ef8df48` on `main`), but `vendor/pensieve/` is now removed and retired.

Historical gstack baseline previously recorded: `bf65487` (v1.26.0.0, 2026-05-02). Last tracked submodule snapshot before retirement was `e362b0ae2f94afdcb55e37cc4690f9ce55ee5d32`.

## 6. Upstream update workflow（LLM 协作）

Applicable only when a retired B 类 vendor is temporarily cloned for reference.

1. User asks to inspect upstream.
2. Assistant clones or reuses a temporary checkout outside the tracked repo, then runs `git fetch` and lists new commits.
3. Assistant reads each relevant diff (`git show <sha>`), classifies semantic value.
4. Assistant presents options to alfadb:
   - direct bugfix worth porting
   - feature worth discussion
   - upstream-only/no pi value
   - conflicts with pi-astack design
5. After decision, assistant edits owned adaptation layer with `edit`/`write`.
6. Do not re-add the retired vendor as a submodule unless a new ADR/explicit user decision reverses retirement.
7. Update this file with any new baseline/ported paths.

This is deliberately not a Makefile/script workflow. Upstream integration needs semantic judgment, not path-list diffing.

## 7. Retired entities

| Entity | Current replacement / reason |
|---|---|
| gbrain infrastructure | markdown+git + memory facade |
| `.gbrain-source` / `.gbrain-cache` / `.gbrain-scratch` | ADR 0017 strict binding |
| `extensions/gbrain/` | `extensions/memory/` |
| `<project>/.pensieve/` as write target | `~/.abrain/projects/<id>/` |
| Pensieve runtime integration / write target | removed/retired; legacy `.pensieve/` paths remain migration/debug/rollback inputs only |
| `vendor/pensieve/` | removed/retired; historical upstream reference only |
| `pi memory migrate` style docs | current slash command `/memory migrate` |
| `vendor/gstack/` | retired 2026-07-06; reference-on-demand via temporary clone at last pinned SHA `e362b0ae2f94afdcb55e37cc4690f9ce55ee5d32` |
| `skills/`/`prompts/` gstack port maps | design-intent archive until actual files exist; gstack reference is on-demand, not an active repo path |

See [docs/adr/0006-component-consolidation.md](./docs/adr/0006-component-consolidation.md) for the historical consolidation decision.
