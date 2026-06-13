---
doc_type: adr
status: superseded
---

# ADR 0019 - abrain self-managed vault identity

> 🗄️ **ARCHIVE-CLASS · SUPERSEDED（Phase-2，3×T0 mark-in-place）**：age/Tier-1/`.vault-backend` 机制是代码正确性（`extensions/abrain/backend-detect.ts` 等）；可移植身份取舍（不寄生系统 ssh key）可一句提炼，当前真相以代码为准。机制正文（含 3 根因 + invariant 表）原地保留可读、物理归档延后至 abrain ingest lane 落地，勿删。

- **状态**: Accepted
- **日期**: 2026-05-15
- **决策者**: alfadb
- **依赖**: ADR 0014 (abrain seven-zone) / ADR 0017 (strict project binding) / ADR 0001 (pi-astack as personal pi workflow)
- **取代关系**: 收窄 v1.4 vault-bootstrap.md §1 的 Tier 1 detection（ssh-key auto-detect 降级为 explicit-only；passphrase-only auto-detect 移除；新增 abrain-age-key 作为 Tier 1 默认）

## 背景

v1.4 vault-bootstrap (`docs/migration/vault-bootstrap.md`) 把**系统 ssh key**（`~/.ssh/id_ed25519` / `~/.ssh/id_rsa`）当作 vault 加密 identity 的 Tier 1 选择。这个设计在「容器开发者必有 ssh key for git push」的观察下看起来很自然，2026-05-15 多模型审计 + dogfood 暴露了三个根本问题：

### 问题 1：每台设备的 default ssh key 通常不是同一把

`~/.ssh/id_ed25519` 是 OS-level convention：每台 Linux/macOS 上 `ssh-keygen` 默认生成的 key。同一用户 alfadb 在两台不同设备上**通常是各自独立 ssh-keygen 出来的两把不同 key**，只是路径重名。

后果：

- A 机器 `/vault init` → 用 A 的 ssh public key 加密 vault master → master **只能用 A 的 ssh secret key 解**
- 同步 abrain repo 到 B 机器 → B 自己的 `~/.ssh/id_ed25519` 是另一把 key → **永远解不开** A 加密的 master
- 解决跨设备的唯一办法：把 A 的 ssh secret key 物理复制到 B（USB / scp）—— 这违背「ssh secret key 不应跨设备复制」的常识，且会污染 git push、ssh login 等其它依赖此 key 的子系统

### 问题 2：identity 路径硬编码进 `.vault-backend`

`.vault-backend` 当前格式：

```
backend=ssh-key
identity=/home/worker/.ssh/id_rsa
```

`.vault-backend` 进 git 跨设备同步。但 `identity=` 是**设备本地绝对路径**，B 机器上可能是 `/Users/alfadb/.ssh/id_rsa`、容器挂载点不同时是 `/root/.ssh/id_rsa`。即便 ssh key 内容跨设备一致（用户手动 sync），路径不一致就跑不起来。

### 问题 3：passphrase-only backend 在 reader 路径不可 unlock

`extensions/abrain/vault-reader.ts:113-118` 的 `defaultExec` 用 `stdin: "ignore"`，age scrypt 拿不到 tty 输入，`loadMasterKey()` silent 返 null。doc 把 passphrase-only 列为 Tier 1 fallback，实际只能 init 不能 unlock —— 「声称支持 / 实际不行」是比「未实现」更糟的 doc-vs-impl 错位。

### 共同根因

vault identity 寄生在「碰巧本机有的某个外部 key」上（系统 ssh / 系统 GPG / OS keychain / age scrypt with tty）。所有 Tier 1 选项都需要一个**外部依赖**才能解锁，而外部依赖的状态在跨设备 / 跨容器 / 跨重装时不一致。

## 决策

**vault 加密 identity 由 abrain 自管，不再寄生在系统 key 或外部状态上。** 引入新 backend `abrain-age-key`：

- abrain 在 `/vault init` 时**自己 `age-keygen`** 一对 age keypair
- secret key 落 `~/.abrain/.vault-identity/master.age`（mode 0600，**gitignore**）
- public key 落 `~/.abrain/.vault-identity/master.age.pub`（**进 git**）
- 该 keypair **同时充当 vault master**：`~/.abrain/.vault-pubkey` 写 abrain pubkey；per-key vault entries (`vault/*.md.age`) 直接用 abrain pubkey 加密；不再生成中间一层 `.vault-master.age`

跨设备同步流程：

- A 机器：`/vault init` → 生成 `.vault-identity/master.age{,.pub}` + 加密 vault entries
- A 机器：`git push abrain`（identity secret 被 gitignore，**不进 git**；pub 进 git）
- A 机器 → B 机器：用户**手动 secure transport** `~/.abrain/.vault-identity/master.age`（scp / USB / 物理介质）
- B 机器：`git clone abrain` + 手动放置 identity secret → `pi` 启动 → 直接读 `.vault-identity/master.age` → 无 prompt，立刻 unlock

与 ssh-key backend 跨设备的工作量**完全一样**（都需要 secure transport 一个 secret 文件），但语义优势：

| 维度 | ssh-key（旧） | abrain-age-key（新） |
|---|---|---|
| key 来源 | 寄生 `~/.ssh/`，每机器实际是不同 key | abrain 专属，可跨设备复制同一把 key |
| identity 路径 | A 机 `/home/worker/.ssh/id_rsa`，B 机可能 `/Users/alfadb/.ssh/id_rsa` | A/B 都是 `~/.abrain/.vault-identity/master.age` 一致 |
| 用错 key 后果 | git push / ssh login 全坏 | 仅 vault 不能解 |
| 作用域 | 系统级（多用途） | 仅 vault（专属） |
| 进 git 的 metadata | identity 绝对路径（设备本地） | 无路径（路径固定） |

## Detection chain 重新分类

新 4-tier：

| Tier | Backend | Auto-detect | 触发条件 |
|---|---|---|---|
| 1 | `abrain-age-key` | ✅ 默认 | `age-keygen` 在 PATH（或 `~/.abrain/.vault-identity/` 已存在表示已 init） |
| 2 | `macos` / `secret-service` / `pass`（包裹 abrain identity secret） | ✅ 但作为 init 选项二，需用户在菜单选 | 平台/CLI 探测 |
| 3 | `ssh-key` / `gpg-file` | ❌ explicit-only | 用户必须 `--backend=ssh-key` 或 `--backend=gpg-file`，且自知后果（跨设备 transport ssh key） |
| 4 | `disabled` | 兜底 | 全部 fail（无 age-keygen 等极端裸环境） |

`passphrase-only` 不再独立 backend —— 它本质是「abrain identity secret 用 passphrase wrap」这一变形，归 P0d 的 abrain-age-key 增强。

## `.gitignore` 与 transport 边界

`~/.abrain/.gitignore` 必须包含：

```
# Vault identity — secret 永不进 git；public key 进 git
.vault-identity/master.age
.vault-identity/master.age.tmp.*
```

`master.age.pub` 不被 gitignore，正常进 git。

跨设备 transport 责任**完全在用户**：abrain extension 不主动 scp / 不依赖任何 sync daemon。这与 ADR 0014 §D-E「abrain 跨设备靠用户手动同步」一致。建议方法（按推荐度）：

1. `scp ~/.abrain/.vault-identity/master.age user@host:.abrain/.vault-identity/`（一次性 scp，不需要持续同步）
2. 物理 USB key（高安全要求场景）
3. 1Password / Bitwarden 等密码管理器存 base64 编码的 identity secret

## 现有用户的 migration

**alfadb 的现有 vault 是测试数据，可直接 wipe**（用户 2026-05-15 确认）。所以本次 ADR 实施时：

- 不实现自动 in-place migration（不安全：要 master plaintext 经过 main pi 内存 + 跨 backend 重加密）
- **UI 层处理 deprecation（不是 reader 层）**：`formatStatus`（`/vault status` 路径）检测到旧 `backend=ssh-key` / `backend=gpg-file` / `backend=passphrase-only` 且 `~/.abrain/.vault-identity/` 不存在 → 在 status 输出中显示 deprecation notice：「⚠ DEPRECATED backend（ADR 0019）。Recommended migration: rm -rf ~/.abrain/.vault-* ~/.abrain/.vault-identity ~/.abrain/vault/ ~/.abrain/projects/*/vault/; pi → /vault init」。
- **Reader 层保持静默**：`vault-reader.ts:loadMasterKey()` 遇到旧 ssh-key / gpg-file backend 仍然**正常解锁**（保持向后兼容 + fail-soft）。reader 是 library，不该印制 UI 文本或主动 prompt 用户 migration——这是分层决策。用户什么时候看到 deprecation？他主动跑 `/vault status` 时。主会话 LLM 调 `vault_release` / `$VAULT_*` bash 注入仍然走原 backend，不会被 deprecation 打断。
- 用户重 init 后所有现有 secret 需要重新 `/secret set`

未来真有 production vault 用户（不只 alfadb）需要无损 migration 时再补 `/vault migrate-backend` 命令（roadmap P0d）。

## ssh-key / gpg-file backend 保留为 explicit-only

不删除，但：

- detection 链不再 auto-detect 这两个 backend
- `/vault init` 默认使用 `abrain-age-key`，不需要参数
- 显式 `/vault init --backend=ssh-key` 仍可工作，但 stderr warning：「ssh-key backend reuses your system ssh key. Cross-device unlock requires you to copy that ssh secret key to every device, which usually conflicts with per-device default ssh keys. Prefer the default abrain-age-key backend.」
- 显式 `/vault init --backend=gpg-file` 同理 warning

保留这两条路径的理由：(1) 已有用户场景 documented；(2) 单机用户 + 已熟悉 ssh/gpg 信任链 + 不需要跨设备 → 这两条仍然是合理选择；(3) 删除是不可逆的，留 escape hatch 不增加维护成本。

## P0d 增强：passphrase wrap for abrain-age-key

把 `~/.abrain/.vault-identity/master.age` 用 age scrypt 加密 → 整个 `.vault-identity/` 可以**直接进 git**（passphrase 是抵御 abrain repo 泄漏的唯一防线）。跨设备只需 `git clone abrain` + 输入一次 passphrase，无需手动 transport identity。

技术依赖（**本 ADR 不解决**）：

- age 不接受 stdin/env passphrase（强制 tty）
- pi TUI 占用 raw mode tty，age 子进程无法 prompt
- 解决路径需选：
  - **(Y2 推荐)** 加 npm dep `age-encryption` 纯 JS 实现 age scrypt unwrap，passphrase 通过 `ctx.ui.input("vault passphrase:", "")` 在 pi 进程内读
  - **(Y1 备选)** 加 npm dep `node-pty` 模拟 pseudo-tty 喂 age CLI

P0d 时单独 ADR 决策。本 ADR 仅锁定 schema：`.vault-identity/master.age` 文件可能是 plain age secret key（当前）或 age scrypt envelope（未来），加载器按文件首字节嗅探。

## 关键不变量

1. **vault identity secret 文件 mode 必须 0600**：`bootstrap.ts` 写入后立即 `chmodSync(0o600)`。
2. **vault identity secret 永不进 git**：`/vault init` 时确保 `~/.abrain/.gitignore` 含 `.vault-identity/master.age` 行。
3. **vault identity secret 永不出现在 argv 或 LLM context**：直接 fs read，无中间 echo / log / audit。
4. **sub-pi 不读 vault identity**：`PI_ABRAIN_DISABLED=1` guard 在 `vault-reader.ts:loadMasterKey()` + `index.ts:activate()` 两层。

   > **note (2026-05-31, v3 in-process)**：该 env guard 仍在代码中，但 **v3 下已无任何地方自动 set `PI_ABRAIN_DISABLED=1`**（v2 的 dispatch 子进程注入已移除）——它现在只是**手动 opt-out**。in-process `dispatch` sub-agent 不是子进程、不 set 该 env，abrain 照常 activate（`noExtensions:false`），此时 guard 对 sub-agent vacuous；「sub-agent 拿到 `bash` 后 spawn `pi`」这条子进程路径也**不被该 guard 自动保护**（子进程继承的 env 不含该 var）。dispatch sub-agent 的 **`vault_release` 工具**不可调用改由排他 `tools` allowlist 保证（详 ADR 0014 §不变量#6 walk-back）；注意这只挡工具、**不挡** sub-agent 用 `read` 按绝对路径读 `master.age` 密钥本身（同 §不变量#1 层2 residual surface，待独立决策加路径 denylist）。
5. **`.vault-pubkey` 与 `.vault-identity/master.age.pub` 内容必须一致**：单层 keypair 设计，两个文件存放同一个 age public key（`.vault-pubkey` 是历史名，保留兼容；`.vault-identity/master.age.pub` 是新 SOT）。`/vault init` 同步写入。
6. **不再生成 `.vault-master.age`**：abrain-age-key backend 下 master 直接是 identity secret，不需要中间一层加密文件。旧 backend (ssh-key / gpg-file) 仍然生成 `.vault-master.age`，互不影响。

## 实施清单（同步落到代码）

| 文件 | 改动 |
|---|---|
| `extensions/abrain/backend-detect.ts` | 加 `Backend = "abrain-age-key"`；detection 链新顺序；末档 `disabled` 不再 `passphrase-only` |
| `extensions/abrain/keychain.ts` | `EncryptableBackend` 加 `"abrain-age-key"`；`encryptMasterKey` 新 case：copy install tmp 的 secret 到 `.vault-identity/master.age` (0600) + 写 `.pub`；不再写 `.vault-master.age` |
| `extensions/abrain/bootstrap.ts` | `runInit` 默认 backend 改为 `abrain-age-key`；新 helper `persistAbrainIdentity()`；`.gitignore` patch 自动加 `.vault-identity/master.age` |
| `extensions/abrain/vault-reader.ts` | `readMasterEnvelope` 新 case `abrain-age-key`：fs read `.vault-identity/master.age`，无子进程；旧 backend 保持原解密路径（向后兼容，不在 reader 层印 deprecation —— 见 §「现有用户的 migration」） |
| `extensions/abrain/backend-detect.ts:formatStatus` | 旧 backend + `.vault-identity/` 缺失 → 在 `/vault status` 输出中插入 deprecation notice + 重 init 指令 |
| `extensions/abrain/index.ts` | `/vault init` 默认 abrain-age-key；`--backend=ssh-key/gpg-file/passphrase-only` 加 stderr warning；status 显示新 backend |
| `extensions/abrain/vault-writer.ts` | 不变（继续读 `.vault-pubkey`） |
| `scripts/smoke-abrain-backend-detect.mjs` | 加 abrain-age-key 优先 + 末档 disabled assertions |
| `scripts/smoke-abrain-bootstrap.mjs` | 新 abrain-age-key init flow assertions |
| `scripts/smoke-abrain-vault-reader.mjs` / `vault-writer.mjs` | abrain-age-key e2e roundtrip |
| `docs/architecture/vault.md` | §3 backend chain 重写 + §8 backend 表更新 |
| `docs/migration/vault-bootstrap.md` | §1 / §3 / §4 / §5 / §6 重写按新 4-tier |
| `docs/current-state.md` §7 | backend 列表更新 |
| `docs/roadmap.md` | passphrase-only reader tty channel 改为 P0d passphrase wrap for abrain-age-key |
| `docs/reference/commands.md` | `/vault init` 默认 backend 说明 |
| `docs/adr/README.md` | 加 ADR 0019 入读取链 |

## 后果

### 正面
- 跨设备语义清晰：identity secret 是 abrain 专属，与系统 ssh / gpg 解耦
- identity 路径不再硬编码到 `.vault-backend`，路径固定 `~/.abrain/.vault-identity/master.age`
- 单层 keypair 简化加解密路径（去掉一层 `.vault-master.age`）
- detection 末档 disabled 与 reader 能力一致，无「Tier 1 fallback 实际不能 unlock」错位
- `passphrase-only` 不再独立 backend，避免 doc-vs-impl 错位再发生

### 负面
- 跨设备需手动 secure transport identity secret（与 ssh-key backend 一样工作量；passphrase wrap 入 P0d 解决）
- 现有 ssh-key / gpg-file backend 用户必须重 init（alfadb 现有是测试数据，无影响；未来真用户需 `/vault migrate-backend`）
- `.vault-pubkey` 与 `.vault-identity/master.age.pub` 重复存储（两个文件同内容；invariant 6 同步写）

### 风险
- 用户跨设备时忘记 transport identity → B 机器 vault 永远 locked。缓解：`/vault status` 在新机器上 identity 缺失时显示 actionable error「identity missing; copy ~/.abrain/.vault-identity/master.age from your other device」。
- 用户 git add `.vault-identity/master.age` 不小心进了 git history → secret 泄漏。缓解：`.gitignore` 在 init 时自动写入；smoke 验证 `.vault-identity/master.age` 不在 `git ls-files` 输出。

## 引用

- ADR 0014 §D-E（跨设备同步靠用户手动）
- ADR 0017（strict project binding 的 manifest/state 分离模式作为参考）
- `docs/migration/vault-bootstrap.md` v1.4（被本 ADR 部分取代）
- `docs/audits/2026-05-14-rounds-1-5.md`（R6 fail-closed audit）
- `docs/audits/2026-05-15-doc-vs-impl.md`（本 ADR 触发的多模型审计）
