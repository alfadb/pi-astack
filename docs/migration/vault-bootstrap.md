---
doc_type: migration
status: active
---

# Migration — Vault Bootstrap（age 加密 + abrain self-managed identity）

> **状态**：ACTIVE RUNBOOK（2026-05-15 v1.5）——P0a-P0c shipped；P0d（wizard / `.env` import / backend migration UX / abrain-age-key passphrase wrap）待实施。
> **依赖**：[ADR 0014](../adr/0014-abrain-as-personal-brain.md) §D4 / [ADR 0019](../adr/0019-abrain-self-managed-vault-identity.md) / [architecture/vault.md](../architecture/vault.md)
> **关联**：本文件解决 Round 3 复核 P0-B2（OS keychain 跨平台承诺不成立）
>
> ---
>
> **⚠ v1.5 重大更新（2026-05-15，[ADR 0019](../adr/0019-abrain-self-managed-vault-identity.md)）**：
>
> v1.4 以 `ssh-key` 为 Tier 1 默认 backend。实际对不成立：每台设备的 `~/.ssh/id_*` 是**各自独立生成的不同 key**，跨设备解锁需要物理复制 ssh 私钥。v1.5 引入 `abrain-age-key` backend：abrain 自管 age keypair，identity 路径固定 `~/.abrain/.vault-identity/master.age`，跨设备即复即用。
>
> **读者导航**：
> - 新装机器：看 §1.0 · §3.0 · §6 跨设备同步（v1.5 ADR 0019 路径）
> - 现有 ssh-key/gpg-file/passphrase-only 用户：你的路径仍能工作（fail-soft），但被降为 Tier 3 explicit-only；v1.4 原文（§1.1-§3.x）作为 Tier 3 详情保留。推荐重 init。
> - dogfood / migration 该看什么：§“v1.4 → v1.5 迁移手本”（§0）
>
> v1.4 原文不删除（作为 Tier 3 backend 的权威实现说明），但 Tier 1 默认以本顶部 v1.5 banner + §1.0 + §3.0 为准。
>
> ---
>
> **v1.4 重写**（2026-05-09）：v1.0-1.3 矩阵假设用户在 macOS / Linux desktop 上跑 pi，把 "CI / 容器" 划成 "不支持 vault"。**实际上 alfadb 主开发环境就是容器**——这是 design-from-stereotype 错误。v1.4 矩阵改为 portable-identity 优先（ssh-key / gpg-file / passphrase 三选一覆盖几乎所有用户），desktop keychain (mac/secret-service/pass) 降为 optional optimization。容器从 "不支持" 升 first-class。**v1.5 进一步将 Tier 1 从 ssh-key 换为 abrain-age-key，解决跨设备 ssh 私钥不一致问题。**

## 0. v1.5 路径（ADR 0019）

### 0.1 算上哪类用户

- **新装机器**：走 abrain-age-key（仅需 `age` v1.0+ 在 PATH）
- **原 ssh-key / gpg-file / passphrase-only 用户**：现有安装 fail-soft 继续工作；推荐迁移到 abrain-age-key。迁移路径见 §0.3。

### 0.2 安装 abrain-age-key（默认路径）

```bash
# 1. 确认 age 可用
age --version    # 需要 v1.0+

# 2. 运行
run pi
/vault init      # 默认 backend=abrain-age-key。产出：
#   ~/.abrain/.vault-identity/master.age      (0600、自动加入 .gitignore、不进 git)
#   ~/.abrain/.vault-identity/master.age.pub  (进 git)
#   ~/.abrain/.vault-pubkey                   (与 master.age.pub 同内容，进 git)
#   ~/.abrain/.vault-backend                  (backend=abrain-age-key，无 identity= 路径)

# 3. 验证
/vault status    # 应显示 backend=abrain-age-key、identity 可读 0600

# 4. 设个 secret 试试
/secret set --global GITHUB_TOKEN=ghp_xxxxxxxxxxxxx
```

### 0.3 v1.4 → v1.5 迁移手本

现有 ssh-key / gpg-file / passphrase-only 用户现阶段不被强制迁移（fail-soft）。`/vault status` 会显示 deprecation 提示。主动迁移：

```bash
# 1. 宝贵 secret 手动记下来（以下清除会丢掉全部加密文件）
/secret list --all-projects   # 看你有哪些 key
# 对于每个你要保留的 key：
/secret get <key>             # （该命令未实现；实际走 vault_release）

# 2. 清除旧 vault
cd ~/.abrain
rm -rf .vault-backend .vault-pubkey .vault-master.age vault/ projects/*/vault/

# 3. 重初始化走 abrain-age-key
pi
/vault init                   # 默认就是 abrain-age-key

# 4. 重新写入 secret
/secret set --global GITHUB_TOKEN=...
```

未来 `/vault migrate-backend` (P0d) 将提供无损 migration（自动 unlock 旧 master → 重加密所有 secret 到新 backend → 丢弃旧 envelope）。

### 0.4 跨设备（v1.5）

§6 原 v1.4 手动 rsync 流程仍适用；唯一区别是现在**transport 的是 abrain 专属 identity，不是系统 ssh 私钥**：

```bash
# 设备 A（已 init）→ 设备 B（新）
scp -p ~/.abrain/.vault-identity/master.age user@B:.abrain/.vault-identity/master.age
ssh user@B 'chmod 0600 ~/.abrain/.vault-identity/master.age'
# B 机 git pull abrain 进来的 .vault-identity/master.age.pub 与 A 机一致，仅私钥需要 secure transport。
# B 机启动 pi → /vault status 应显示 unlocked。
```

跨设备变动后（e.g. A 机 `/secret set` 了个新 key）需要 A `git push abrain` 后 B `git pull abrain` 才能拿到加密文件。identity 本身不变不需重传。

错误诊断：忘了 transport identity 时 `decryptSecret` 会报 actionable error（含 `scp` 与 `chmod 0600` 提示），不会 silent 返 generic "vault locked"。

## 1. v1.4 平台支持矩阵（v1.5 后为 Tier 3 explicit-only 依据，需 `--backend=...` flag）

**核心转变**：vault unlock 不再依赖 OS keychain（受限于 desktop session），而是依赖**用户已有的便携加密 identity**——大多数 dev 用户都有 ssh key 或 GPG identity（git push 已经用上），age 原生支持这两者作 recipient，零额外 glue。

### 1.1 Tier 1 — primary（每个用户能命中至少一个）

| Backend | 触发条件 | Master key 存储 | Unlock 机制 | Auto-unlock 等价物 |
|---|---|---|---|---|
| **`ssh-key`** ★推荐 | `~/.ssh/id_ed25519` 或 `~/.ssh/id_rsa` 存在 + 对应 `.pub` 存在 | `~/.abrain/.vault-master.age` 加密给 ssh public key（`age -R ~/.ssh/id_*.pub`） | `age -d -i ~/.ssh/id_*` | ssh-agent cache（用户 git push 时已解锁） |
| **`gpg-file`** | `gpg --list-secret-keys` 非空 | `~/.abrain/.vault-master.age` 加密给 GPG identity（`age -e -r <gpg-id>` via gpg pipe） | gpg-agent decrypt | gpg-agent cache TTL（用户调到 28800s ≈ 8h ≈ macOS Keychain "unlocked while logged in" 等价） |
| **`passphrase-only`** | 全部 portable identity 不可用 | `~/.abrain/.vault-master.age` 用 age scrypt（passphrase）加密 | main pi 启动时 prompt（必须有 /dev/tty） | ❌ 每次 pi 启动都需输入；session 内复用 |

**为什么 ssh-key 排第一**（v1.4 实证）：
- alfadb 主用容器开发——容器里 ssh-agent 已经在 git push 路径上 unlocked
- 容器内默认无 GPG keyring（`gpg --list-secret-keys` 空），gpg-file 路径要先 setup
- age v1.0+ 原生支持 ssh recipient（实测：`age -R ssh.pub` + `age -d -i ssh-key` roundtrip 通），无 glue

### 1.2 Tier 2 — optimization（如果恰好可用，UX 更顺）

| Backend | 触发条件 | 何时优先 |
|---|---|---|
| **`macos`** | `uname -s = Darwin` + `security` CLI | macOS 桌面用户：master key 存 Keychain，登录 session 内自动可用 |
| **`secret-service`** | Linux + (`$DISPLAY` 或 `$WAYLAND_DISPLAY`) + `secret-tool` 在 PATH | GNOME / KDE 桌面：master key 存 secret service，桌面 session 内自动可用 |
| **`pass`** | `pass` CLI + `~/.password-store/abrain/` 存在 | 已重度用 pass 的用户 |

**Tier 2 的定位**：相对 Tier 1 的好处是"unlock 时机更早 / cache 更稳"。但 Tier 1 已经覆盖所有用户，Tier 2 缺失不影响功能。

### 1.3 Tier 3 — disabled

用户 opt-out（写 `~/.abrain/.state/vault-disabled` flag，或 detection 全部 fail 的极端情况）。vault 子系统全 off，其他 abrain 功能不受影响。

### 1.4 平台检测优先级

pi 启动时按以下顺序探测，第一个成功的为该 host 的 backend：

1. `$SECRETS_BACKEND` env override（用户强制；invalid 值被静默忽略后继续走探测链，参见 `extensions/abrain/backend-detect.ts:161-174`）
2. **`ssh-key`**：`~/.ssh/id_ed25519`(`.pub`) 或 `~/.ssh/id_rsa`(`.pub`) 同时存在
3. **`gpg-file`**：`gpg` 在 PATH + `gpg --list-secret-keys --with-colons` 至少一行 `sec:` 开头
4. `macos`：`uname -s = Darwin` + `security` CLI
5. `secret-service`：Linux + (`$DISPLAY` 或 `$WAYLAND_DISPLAY`) + `secret-tool` 在 PATH
6. `pass`：`pass` CLI + `~/.password-store/abrain/` 存在
7. **`passphrase-only`**：abrain extension 已激活（兜底；auto-detect 走到这步就兜底完成）。
   ⚠️ **reader-side gap**（2026-05-15 dogfood）：实际 unlock 路径 `vault-reader.ts:113-118` 调 `age -d` 时 `defaultExec` 为 `stdin: "ignore"`，age scrypt 拿不到 tty，`loadMasterKey()` 的 try/catch 吞 stderr 返 null（`:142-148`）。passphrase-only 当前仅 init-only，下次启动 unlock 会 silent 失败。待 tty pass-through 或 doc 上明示降为 init-only stub，跟踪于 [../roadmap.md](../roadmap.md) Vault passphrase-only reader tty channel 项。
8. `disabled`：**不再**通过 auto-detection 走到这一档（`backend-detect.ts:174-218` 末档总是 passphrase-only）。只有两种明示方式才能进 `disabled`：`SECRETS_BACKEND=disabled` env、或 `~/.abrain/.state/vault-disabled` flag 文件存在。

**关键变化对比 v1.3**：
- ssh-key 是新加的 Tier 1，**容器场景头号选择**
- gpg-file 从 "fallback" 升 Tier 1
- desktop keychain (mac/secret-service/pass) 从 Tier 1 降 Tier 2 optimization
- 容器/CI 不再是 "不支持"——passphrase-only 兜底（CI 场景仍可手动 disable）
- gpg-file detection 从 "`.vault-master.age` 文件存在" 改为 "用户有 GPG secret key"——`.vault-master.age` 不存在意味着"未 init"不是"backend 不可用"

## 2. Fail-closed 原则

**永不**降级到不安全模式（如 master key 写入 plaintext env 变量）。取不到 master key 时：

| 子系统 | 行为 |
|---|---|
| `~/.abrain/vault/_meta.md` | 仍可读（未加密的元数据） |
| `~/.abrain/projects/<id>/vault/_meta.md` | 仍可读 |
| 加密文件 `*.md.age` | **不解密**（保持密文） |
| bash 注入 `$VAULT_<key>` | **拒绝执行**，返回错误："vault locked; restart pi or check `~/.abrain/.vault-master.age`"（注：`/vault unlock` 命令尚未实现，当前 unlock 路径走启动时 backend auto-detect → master decrypt）|
| `vault_release` 工具调用 | **拒绝**，返回错误 |
| `/secret <key>` 写入 | **拒绝**（因为加密需要 master key） |

启动时 vault disabled 状态在 TUI footer 持续可见（"vault: locked"），用户能立刻看到。

## 3. Master key 生成 + 注册流程（v1.4 重写）

首次安装 abrain 后跑 `/vault init`（pi slash 命令，注册在 `extensions/abrain/index.ts`）。**所有 backend 共享同一 install 临时目录语义**，不同仅在加密路径：

```bash
# 0. 创建 install 临时目录（v1.2 修正，Round 4 Opus P1 3-5）——
#    不能用 /tmp：tmpfs 上 shred 是 no-op；NFS-mounted /tmp 同样无意义。
#    用 ~/.abrain/.state/install/ 保证与 abrain 同文件系统，shred 有效。
mkdir -p ~/.abrain/.state/install
chmod 700 ~/.abrain/.state/install
INSTALL_TMP=$(mktemp -d -p ~/.abrain/.state/install)

# 1. 生成 age master keypair (全部 backend 共享这一步)
age-keygen -o "$INSTALL_TMP/master.age" 2>"$INSTALL_TMP/master.pub"
#   master.age:  AGE-SECRET-KEY-... (secret)
#   master.pub:  Public key: age1xxx...

# 2. 根据检测出的 backend 加密为密文、着陆起点路径
case "$BACKEND" in
  ssh-key)
    # Tier 1 primary —— 加密给用户 ssh public key。解锁靠 ssh-agent / ssh key passphrase。
    age -R "$SSH_PUBKEY_PATH" -o ~/.abrain/.vault-master.age "$INSTALL_TMP/master.age"
    # 记录 unlock 说明：这个 vault 靠 ssh-key 解锁
    echo "backend=ssh-key" > ~/.abrain/.vault-backend
    echo "identity=$SSH_PUBKEY_PATH" >> ~/.abrain/.vault-backend
    ;;
  gpg-file)
    # Tier 1 primary —— 加密给用户 GPG identity。解锁靠 gpg-agent。
    GPG_RECIPIENT=$(gpg --list-secret-keys --with-colons \
      | awk -F: '/^sec/{print $5; exit}')
    gpg --encrypt --recipient "$GPG_RECIPIENT" --output ~/.abrain/.vault-master.age \
      "$INSTALL_TMP/master.age"
    echo "backend=gpg-file" > ~/.abrain/.vault-backend
    echo "identity=$GPG_RECIPIENT" >> ~/.abrain/.vault-backend
    ;;
  passphrase-only)
    # Tier 1 fallback —— age scrypt mode。要求 main pi 进程有 /dev/tty（sub-pi 无 tty 以 PI_ABRAIN_DISABLED=1 跳过）。
    # init 时 prompt 两次验证，后续启动 prompt 一次。
    age -p -o ~/.abrain/.vault-master.age "$INSTALL_TMP/master.age"  # /dev/tty interactive
    echo "backend=passphrase-only" > ~/.abrain/.vault-backend
    ;;
  macos)
    # Tier 2 optimization —— master.age 存 Keychain，.vault-master.age 不使用。
    security add-generic-password -s "alfadb-abrain-master" \
      -a "$USER" -w "$(cat "$INSTALL_TMP/master.age")" -U
    echo "backend=macos" > ~/.abrain/.vault-backend
    ;;
  secret-service)
    # Tier 2 optimization
    secret-tool store --label="alfadb abrain master" \
      service abrain key master <<< "$(cat "$INSTALL_TMP/master.age")"
    echo "backend=secret-service" > ~/.abrain/.vault-backend
    ;;
  pass)
    # Tier 2 optimization
    pass insert -m abrain/master <<< "$(cat "$INSTALL_TMP/master.age")"
    echo "backend=pass" > ~/.abrain/.vault-backend
    ;;
esac

# 3. 把 public key 写入 ~/.abrain/.vault-pubkey（明文，vaultWriter 加密时引用）
grep "Public key:" "$INSTALL_TMP/master.pub" | awk '{print $3}' > ~/.abrain/.vault-pubkey

# 4. 销毁临时文件 + 整个 install 目录
shred -u "$INSTALL_TMP/master.age" "$INSTALL_TMP/master.pub" 2>/dev/null
rm -rf "$INSTALL_TMP"
```

**v1.4 设计决定**：
- **写 `~/.abrain/.vault-backend`**（v1.4 新）：记录 init 时选的 backend，未来启动时不重新探测——避免用户后加入 GPG key 导致检测跳到不同 backend。主动切 backend 需 `/vault migrate-backend <new>`（P0d 待实施；当前手动迁移：mv `~/.abrain/.vault-master.age` 备份后重跑 `/vault init`）。
- **ssh-key 与 gpg-file 共用 `~/.abrain/.vault-master.age`**：两者都是加密文件路径，区别仅在 recipient。这让子系统代码卷一样，unlock helper 读 `.vault-backend` 选解密工具。
- **passphrase-only 当前 reader 路径不可用**（2026-05-15 dogfood gap）：age scrypt 要 /dev/tty，但 `vault-reader.ts` `defaultExec` `stdin: "ignore"` 拿不到 tty，`loadMasterKey()` silent 返 null。表现与 "vault locked" 一样。sub-pi 本就 PI_ABRAIN_DISABLED=1 看不到 vault不受影响；main pi 上的 passphrase-only 则需 tty pass-through 或明示降为 init-only stub。

**安全声明**：
- master key 在生成与加密期间临时落 `~/.abrain/.state/install/`（与 abrain 同文件系统，shred 有效）。不使用 `/tmp`（可能是 tmpfs / NFS，shred 不生效）
- 备份责任在用户：ssh-key / gpg-file backend 下 master key 已加密为 `~/.abrain/.vault-master.age`，可随 abrain 一起 git push 备份（重要：ss key 本身 不 备份到 git）。macOS / pass / secret-service 下 master key 在 keychain，需依赖平台自身同步机制
- master key rotation：当前 spec 不支持。若 rotation 必要：人工 unlock 全部 vault 文件 → 用新 key 重新加密 → 注册新 key。复杂度高，列入 backlog

### 3.1 P0b 实施 invariant（v1.4 补，为实现代码准备）

实现 §3 流程时必须遵守：

#### invariant 1 —— 事务顺序与 partial state

```
(0) mktemp -p ~/.abrain/.state/install/        # 隔离临时区
(1) age-keygen → INSTALL_TMP/master.age        # 生成 secret + 拿到 publicKey
(2) backend.encrypt(secret) → vault dst        # 密文落盘 (SOT)
(3) write ~/.abrain/.vault-pubkey               # publicKey 明文
    write ~/.abrain/.vault-backend             # backend + identity 记录
(4) cleanup INSTALL_TMP (shred + rm)            # 销毁临时 secret
```

**failure point 处理**：
- (1) fail → 走 cleanup、不产生任何产出。**Idempotent**。
- (2) fail → 走 cleanup、不写 backend/pubkey 文件。**Idempotent**：只要 vault 目录里没出现 .vault-master.age 部分写入，下次重跑 init 干净。危险点：keychain backend（macOS/secret-service/pass）在 (2) 中成功写 keychain 后后续 (3) fail → keychain 里有孤儿 master key。补救：重跑 `/vault init` 时先检查 keychain，有同 name 则 prompt 覆写。
- (3a) write pubkey fail → 状态不一致（vault dst 存在但无 pubkey）。cleanup 仍跑，报错。重跑 init 要求用户 `rm ~/.abrain/.vault-master.age` 后重来。
- (3b) write backend file fail → 同 (3a)
- (4) cleanup fail → **不应该入 sleep**——secret 可能残留。cleanup 不应报错中断主流程，但要 log warn，指示用户手动 `shred -u ~/.abrain/.state/install/init-*/master.age`。

**原则**：(2) 之前重跑 init 完全干净。(2) 后需手动清理 vault dst 才能重跑——这是为了避免隐式覆写已有 vault data。

#### invariant 2 —— 禁用 argv 传 secret（process listing 防泄）

secret 由 stdin pipe 或文件路径传递，**不作为命令行参数**。`/proc/<pid>/cmdline` 同 host 可读。

**已知 trade-off**：**macOS `security` CLI 没有 stdin mode**——`security add-generic-password -w <value>` 是唯一接口。这是已知短暴露窗口。减轻：
- 仅出现于 `/vault init` 执行期间 < 100ms
- 该主机另外存在不受信任进程本身是其他问题
- macOS Keychain 是 Tier 2 optimization 不是默认 backend；ssh-key 路径 stdin pipe 完美安全

#### invariant 3 —— install_tmp 设备隔离

**`mktemp -d -p ~/.abrain/.state/install/` 严格**，不退 `/tmp`。实现中检查父目录是 abrain home——避免代码重构意外跳到 `/tmp`。

#### invariant 4 —— cleanup 在 fsync 之后、返回之前

```typescript
try {
  // (0)..(3)
} finally {
  await cleanupInstallDir(installTmp);   // 总是跑，错误路径也走
}
```

#### invariant 5 —— keychain backend 与 file backend 差异明确

| Backend | master key 落在 | 预期 mode |
|---|---|---|
| ssh-key | `~/.abrain/.vault-master.age` (age envelope) | **0600** |
| gpg-file | `~/.abrain/.vault-master.age` (GPG envelope) | **0600** |
| passphrase-only | `~/.abrain/.vault-master.age` (age scrypt envelope) | **0600** |
| macos | macOS Keychain 条目 `alfadb-abrain-master`（文件不存在） | n/a |
| secret-service | Secret Service `service=abrain key=master`（文件不存在） | n/a |
| pass | `~/.password-store/abrain/master.gpg`（`.vault-master.age` 文件不存在） | n/a |

**`.vault-master.age` 严格 0600**（v1.4.1 dogfood 修订）：加密文件本身不是 secret（攻破需 ssh/gpg secret）但 0600 仍是 hygiene——缩小 attack surface。`age -o` / `gpg --output` 默认 mode 跟 umask 相关（例如 container umask=0002 生为 0664 group-readable），**实现必须在 encrypt 后显式 `chmod 0600`**。P0b 初版遗漏（`/vault init --backend=ssh-key` 生成 0664 文件），dogfood 发现后补。

unlock helper 读 `.vault-backend` 决定去哪取 master key，不靠文件存在性判断。

#### invariant 6 —— P0b 不同路径的可测证状态

| 路径 | 容器能否 e2e 实测 |
|---|---|
| **ssh-key** | ✅ 完整 e2e（alfadb 容器有 ssh key + age + ssh-agent） |
| gpg-file | ⚠️ 需手工 setup GPG keyring 后能 e2e |
| passphrase-only | ⚠️ 需 tty 交互，smoke 不走这路径（仅 mock） |
| macos / secret-service / pass | ❌ 容器不具备环境（smoke mock-only，等真机） |

P0b 交付验收要求：ssh-key 的 e2e roundtrip smoke 走通（生成 → 加密 → 解密 → 比对）。其他 backend 代码需 mock subprocess 验证命令构造正确，真机 e2e 入 P0b acceptance backlog。

### 3.2 init 后的持久化：git commit + .gitignore（v1.4.6 补，dogfood audit 发现）

**dogfood audit**（v1.4.5 之后）：用户检查工作区发现 `~/.abrain/` 中 4 个 vault 产出 untracked 且未 commit：
`.vault-backend` / `.vault-pubkey` / `.vault-master.age` / `vault/_meta/test-key.md`。init 两天后仍没 commit
——什么都不会帮你 commit，除非你亲自跑。如果 `~/.abrain` 不是 volume mount 重启就丢；即使是 volume mount
也没跨设备同步基础。**这是隐式期待变 doc-driven 求证**。

#### .gitignore 推荐内容

`~/.abrain/.gitignore` 应该包含：

```gitignore
# Runtime state (默认已有)
.state/
.index/
_index.md

# Vault 运行时临时文件（不上 git）
vault/.lock
vault/**/.lock
vault/*.tmp.*
vault/**/*.tmp.*
projects/*/vault/.lock
projects/*/vault/*.tmp.*
projects/*/vault/**/*.tmp.*
```

**不反反记住哪些不能上，记住哪些可以上**（v1.4 §D4 example wording 一致）：

| 文件 | 上 git? | 理由 |
|---|---|---|
| `.vault-backend` | ✅ | 记录 backend + identity path（路径不是 secret） |
| `.vault-pubkey` | ✅ | age 公钥，本身就是明文设计的 |
| `.vault-master.age` | ✅ | v1.4 §D4 例外：ssh-key/gpg-file backend 下是已加密文件，随 abrain 一起 git push 是**跨设备同步手段**。macos/secret-service/pass backend 下该文件**不存在**（master 在 keychain）。 |
| `vault/_meta/<key>.md` | ✅ | 元数据 timeline（创建/rotate/forget 历史 + size），不含密文 value |
| `vault/<key>.md.age` | ✅ | age 加密 secret。与 ADR 0013 audit-only 不矛盾——加密后上 git 是主动选择的跨设备同步机制，**前提是上面 trust 边界成立**（ssh-key/gpg-file backend；其他 backend 下这些文件仍是加密的但解锁依赖 keychain，跨设备同步需额外传 master） |
| `projects/*/vault/...` | ✅ | 同上，项目级 vault |
| `vault/.lock` / `vault/*.tmp.*` | ❌ | 运行时锁文件与 atomic rename 前临时产物 |

#### init 完成后必须 git commit

**P0c.write MVP（当前）**：runInit 完成后不自动 commit。用户 init 后需手动：

```bash
cd ~/.abrain
git add .gitignore .vault-backend .vault-pubkey .vault-master.age   # 首次 init
git commit -m 'vault: initialized with <backend> backend (P0c.write)'
# 不 push（敏感；跨设备同步是手动 rsync per ADR 0014 §D-E）
```

**后续 `/secret set/forget` 之后也需手动 commit**（这是主 session 只读安全不变量的代价：主会话不能隐式决定
“这个 vault 变更该不该持久化”）。实践：每隔几天运行 `cd ~/.abrain && git add . && git commit -m 'vault: <今天刚刚出现的 keys>'`。

**P0c.read 后 enhancement 趋势**（backlog）：runInit / writeSecret / forgetSecret 可选加 `--commit` flag
或默认调 `git -C abrain commit`；问题是 main pi 写 ~/.abrain 违反 ADR 0003 不变量 #1 layer 1 mechanic
——需要为 `/secret` 这个 TUI command 路径 carve out 一个是否可以 commit 的例外（同不变量 #1 layer 1 mechanic
Lane V 同步路径 carve-out）。这个并不困难但需明确 spec，P0c.read 一起考虑。

#### 为什么不默认 auto-commit——ADR 0003 边界

ADR 0003 不变量 #1 layer 1 mechanic：LLM tool surface 中没有定制 brain mutation tool。主会话不能发起 `git commit`
到 `~/.abrain`——`git` 是通用 bash 工具，但 §坟处 #10（不变量 #1 layer 2 best-effort residual）明说主会话通过通用工具间接写
brain SOT 是已知 trade-off。推送 main pi 主动调 git commit 需谨慎，在 spec 层面明确为 `/secret`/`/vault init` TUI
command 路径独立 carve out，不能默认允许主 session 随意调 git commit 。P0c.read 设计时考虑。

## 4. 首次启动 onboarding flow（v1.4 重写）

pi 启动时首次未检测到初始化过的 vault（`~/.abrain/.vault-backend` 不存在）。**不是选 "init / 跳过"而是选哪个 backend init**——菜单动态生成，只列出该机器上 detection 发现的可用 backend。

```
┌─ Vault setup ───────────────────────────────────────────────┐
│                                                            │
│  abrain vault 尚未初始化。检测到以下可用 backend：         │
│                                                            │
│  [1] ssh-key       (~/.ssh/id_ed25519)         ★推荐       │
│  [2] gpg-file      (GPG identity 0xABC123)                 │
│  [3] passphrase    (每次 pi 启动 prompt)                   │
│                                                            │
│  [i] 我已经在另一台机器初始化 → 帮我导入（§6）             │
│  [s] 暂不初始化（vault disabled，不影响其他 abrain 功能）  │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

菜单是动态的：detection 跑完后列出**所有**命中的可用 backend（不是首个命中的）让用户选。passphrase 永远在底（其他都 fail 时作 fallback）。

常见场景菜单预期：

| 场景 | 菜单 |
|---|---|
| 容器开发者（alfadb 主场景） | `[1] ssh-key` + `[3] passphrase` |
| Linux 桌面 + GPG sign commits | `[1] ssh-key` + `[2] gpg-file` + `[secret-service]` + `[3] passphrase` |
| macOS Keychain 用户 | `[1] ssh-key` + `[macos]` + `[3] passphrase` |
| 全新环境（无 ssh 无 gpg） | `[3] passphrase` 一项 + `[s]` |

选任一 backend → 跑 §3 流程对应路径 + 写 `~/.abrain/.vault-backend`，结束后 `/vault status` 显示 `unlocked`。
选 [s] → 写 `~/.abrain/.state/vault-disabled` flag，pi 继续运行。
选 [i] → 跨设备导入流程（§6）。
### 4.1 `/vault status` 语义（v1.4.2 补，dogfood 发现）

`/vault status` 不是“如果现在 init 会选哪个 backend”——那是 §4 onboarding 菜单。status **优先读 `~/.abrain/.vault-backend`** 呈现**当前**状态：

| .vault-backend | detection | 状态 | 输出 |
|---|---|---|---|
| 存在 | （不跳） | **initialized** | 显示 init 记录的 backend / identity、在哪里取 master、auto-unlock 判断、`.vault-pubkey` 内容 |
| 不存在 | 命中某 backend | **not initialized, ready** | 提示 `运行 /vault init [--backend=<选中的>]` |
| 不存在 | disabled | **disabled (no backend)** | 同现状（detection 返回 disabled） |
| 任何 | （不跳）且 vault-disabled flag | **user-disabled** | 提示 `rm 该 flag` 重开 |
| sub-pi (PI_ABRAIN_DISABLED=1) | （不跳） | **sub-pi disabled** | 独立状 |

这避免 v1.4.x 初版的 P0a-era status “note: master key generation lands in P0b” 这种在用户已经 init 之后还说“P0b 未交付”的 spec drift。P0a 初版中主 session 用 detection 驱动 status 是因为 `.vault-backend` 概念是 v1.4 才引入的；v1.4.2 dogfood patch 补齐。

## 5. 每个 pi 进程启动时的 unlock check（v1.4 重写）

v1.4 启动 **不重跑 detection chain**——读 `~/.abrain/.vault-backend` 拿 init 时记录的 backend。这避免环境变化（加入 GPG key / 卸载 ssh-key / 临时无 ssh-agent）让启动跳到不同 backend 造成 unlock 失败。

```typescript
// pseudo-code in extensions/abrain/vault.ts
async function loadMasterKey(): Promise<MasterKey | null> {
  // (a) sub-pi guard —— v1.2 补，Round 4 GPT P0-N2。
  // 在 extension activate 顶部已处理（v1.4 P0a 已实施）。这里是 belt-and-suspenders。
  if (process.env.PI_ABRAIN_DISABLED === "1") return null;
  if (existsSync("~/.abrain/.state/vault-disabled")) return null;

  // (b) 读 init 时记录的 backend，不重跑 detection
  const backendInfo = readBackendFile("~/.abrain/.vault-backend");
  if (!backendInfo) {
    log.info("vault not initialized, run /vault init");
    return null;
  }

  // (c) 按 backend 选解密工具。每个 helper 严禁用 argv 传 master key——
  // 都从加密文件读、输出 stdout pipe，中间不作为参数出现（process listing 防泄）。
  try {
    let plaintext: Buffer;
    switch (backendInfo.backend) {
      case "ssh-key":
        // age 原生支持 ssh key 作 identity。ssh key 有 passphrase 且 ssh-agent 未 unlock 时 prompt。
        plaintext = await execAge(["-d", "-i", backendInfo.identity, "~/.abrain/.vault-master.age"]);
        break;
      case "gpg-file":
        // 加密文件本身是 GPG 包（v1.4 §3 init 用 gpg --encrypt 不是 age -e -r）。
        // 解密对称走 gpg --decrypt，gpg-agent 提供 cache。
        plaintext = await execGpg(["--decrypt", "~/.abrain/.vault-master.age"]);
        break;
      case "passphrase-only":
        // age scrypt 要 /dev/tty 交互 prompt。sub-pi 不会到这里 (a) 已拦。
        plaintext = await execAge(["-d", "~/.abrain/.vault-master.age"]);
        break;
      case "macos":
        plaintext = await execSecurity(["find-generic-password", "-s", "alfadb-abrain-master", "-w"]);
        break;
      case "secret-service":
        plaintext = await execSecretTool(["lookup", "service", "abrain", "key", "master"]);
        break;
      case "pass":
        plaintext = await execPass(["show", "abrain/master"]);
        break;
    }
    return parseMasterKey(plaintext);
  } catch (err) {
    log.warn(`vault locked: ${err.message}`);
    return null;  // fail-closed
  }
}
```

**安全考虑**：
- `plaintext` 仅在本函数范围存在，返回后 GC 可回收。`MasterKey` 对象在 main pi 内存中驻留至 vault 子系统关闭。
- helper 函数严禁用 `argv` 传 master key——`/proc/<pid>/cmdline` 同 host 其他进程可读。都从加密文件读入、输出 stdout pipe。
- `gpg-file` 与 `ssh-key` 加密文件路径相同（`~/.abrain/.vault-master.age`）但 envelope 格式不同：ssh-key 路径是 age envelope，gpg-file 路径是 GPG envelope。`.vault-backend` 决定走哪个解密工具——不要靠魔数嗅探。

### Sub-pi enforce——三层机制性（v1.2 补，Round 4 GPT P0-N2）

ADR 0014 §关键不变量 #6 要求 "sub-pi 默认看不到任何 vault" 是**机制性的**不只是 documentation。下面三点同时生效：

#### (a) `dispatch_parallel` spawn 强制 env override（不允许上层覆盖）

```typescript
// extensions/dispatch/index.ts
const childEnv: NodeJS.ProcessEnv = {
  ...process.env,                       // 先继承父环境
  PI_ABRAIN_DISABLED: "1",              // 后强制覆盖——不允许上层 export PI_ABRAIN_DISABLED=0
};
spawn("pi", args, { env: childEnv });
```

这里顺序重要：`...process.env` 在前、`PI_ABRAIN_DISABLED: "1"` 在后。如果用户 `export PI_ABRAIN_DISABLED=0` 也会被后的覆写掩盖。

#### (b) extension activate 顶层位置的 hard guard（不仅 loadMasterKey 处，上面的伪代码可见）

```typescript
// extensions/abrain/index.ts
export function activate(api: PiExtensionAPI) {
  if (process.env.PI_ABRAIN_DISABLED === "1") {
    api.log.info("abrain extension disabled (sub-pi mode)");
    return;  // 无 tool 注册、无事件订阅、无 vault metadata 加载
  }
  // 正常启动路径
  api.registerTool("vault_release", ···);
  api.subscribe("agent_end", ···);
}
```

#### (c) Smoke 验证 enforcement——不是靠 documentation、是靠测试

`scripts/smoke-vault-subpi-isolation.mjs`（已实现，2026-05-09）验证 `dispatch/index.ts:spawn("pi", ...)` 站点：
1. spawn options 含 `env` 字段
2. `...process.env` 在 `PI_ABRAIN_DISABLED` 之前，覆盖顺序正确。即使用户设 `PI_ABRAIN_DISABLED=0`，子 pi 仍然 disabled
3. 子进程用 `PI_ABRAIN_DISABLED="1"` 字串（不是 number）
4. spawn 传递 childEnv（不是别的 env object）
5. `extensions/dispatch/index.ts` 只有一处 `spawn("pi", ...)`——检验 smoke 覆盖了所有路径。

补充 enforcement 点：`extensions/abrain/vault-reader.ts:loadMasterKey()` 在 substrate 层再检查一次 `PI_ABRAIN_DISABLED === "1"`（纵深防御）。错过任意一层都不会造成明文泄露。

## 6. 跨设备导入（手动）

ADR 0014 §D-E 选择的方案：vault 跨设备靠用户手动同步（rsync / syncthing / iCloud Drive）。具体步骤：

```bash
# 设备 A（已初始化）：
# 1. rsync 整个 ~/.abrain（含 vault/）到设备 B（vault 内容已加密，传输不需 trust 通道）
rsync -av --delete ~/.abrain/ user@deviceB:.abrain/

# 2. 把 master key 安全传到设备 B
#    选项 a: 物理 USB key（推荐）
#    选项 b: 临时打开 ssh + scp 加密文件 + 立刻删除
#    选项 c: pass git remote（如果两台设备共用 pass repo）

# 设备 B：
# 1. 把 master key 注册到本设备 keychain（按 §3 流程）
# 2. 验证：/vault status → unlocked
# 3. 验证：/secret list → 看到 A 上写过的所有 keys（注：vault 不直接列 secrets，走 /secret list）
```

**已知 trade-off**：
- 设备 A 写新 secret 后，设备 B 不会自动看到——必须人工再跑一次 rsync
- vault 文件较少时这是合理代价；若 vault 写入频繁可考虑 syncthing 自动同步

## 7. 与 Lane V 同步语义的衔接

当前 vault 契约见 [architecture/vault.md](../architecture/vault.md)，历史设计背景见 [ADR 0014](../adr/0014-abrain-as-personal-brain.md)。简言之（v1.2 修正，Round 4 N1）：

- `/secret` 命令由 **main pi 进程内同步调用 vaultWriter library** 处理（不走 sediment IPC / 不走 agent_end 异步）。vaultWriter 是 `extensions/abrain/vault-writer.ts`，复用 sediment 的 validation/audit substrate 思路但代码共享不是进程共享。避免 daemon / socket / peer credential 三层新工程面
- 当前 P0c.write 落盘步骤：flock(vault 目录) → age encrypt(plaintext, `~/.abrain/.vault-pubkey`) → atomic rename 到 `vault/<key>.md.age` → append `_meta/<key>.md` + fsync → append `vault-events.jsonl` + fsync → unflock
- P0c.write 同步等待加密文件与元数据落盘后返回；下一条命令可以看到 encrypted vault artifact。`$VAULT_<key>` / `$GVAULT_<key>` / `$PVAULT_<key>` bash 注入属于 P0c.read，已于 v1.4.6 (2026-05-10、2026-05-11) 交付。全部路径（release / bash inject / output authorization / read-path audit）详见 §8 checklist + ADR 0014 P0c.read 阅读顺序。
- 写入失败（未 init/缺 `.vault-pubkey` / 加密失败 / metadata 或 audit append 失败）TUI 立刻报错；若 crash 发生在 rename 后 audit 前，`reconcile()` 在下次初始化时补 `recovered_missing_audit`。

## 8. 验收 checklist（v1.4 重写）

vault-bootstrap 完成后必须验证。**按 backend 分类，只验证该 host 实际能跳的路径**。

### Tier 1 主要验收（必须走）

- [ ] `/vault init` 在容器 (Linux + ssh-key 可用) 进行 → 选 [1] ssh-key → init 成功 → `~/.abrain/.vault-master.age` + `~/.abrain/.vault-backend` 生成
- [ ] init 后 `/vault status` 返回 `unlocked` (backend=ssh-key, identity=...)
- [ ] **fail-closed 场景**：init 后手动 `mv ~/.abrain/.vault-master.age{,.bak}` → `/vault status` 返回 `locked`而非 crash
- [ ] **fail-closed 场景 2**：init 后 `chmod 000 ~/.ssh/id_ed25519` → `/vault status` 返回 `locked` (decrypt failed)

### 公共验收（与 backend 无关，必须走）

- [x] `/secret set --global test-key=test-value` 落盘成功：生成 `vault/test-key.md.age` + `_meta/test-key.md` + `vault-events.jsonl`，且 plaintext 不出现在 metadata/audit
- [x] `/secret list --global` 只读 metadata，不解密 value
- [x] `/secret forget --global test-key` rm/shred 加密文件，保留 `_meta/test-key.md` 并追加 `forgotten` timeline；后续 list 显示 forgotten
- [x] **sub-pi 隔离**：`scripts/smoke-vault-subpi-isolation.mjs` 过（`PI_ABRAIN_DISABLED=1` 在 dispatch spawn 生效）
- [x] **sub-pi extension guard**：`scripts/smoke-abrain-backend-detect.mjs` 过（`PI_ABRAIN_DISABLED=1` 在 abrain extension activate 顶部生效，registerCommand 零次调用）
- [x] vault git 策略对齐 v1.4.6：`.vault-backend` / `.vault-pubkey` / `.vault-master.age` / encrypted `vault/*.md.age` / `vault/_meta/*.md` 可上 git；lock/tmp/runtime state gitignored
- [x] P0c.read core substrate：`vault-reader.ts` unlocks `.vault-master.age` via recorded backend, decrypts per-key `.md.age`, cleans temp identity files, and provides literal redaction helper (ssh-key e2e smoke)
- [x] P0c.read LLM surface：`vault_release` tool registers only in main pi, prompts default-deny TUI authorization (`No` / `Deny + remember` / `Yes once` / `Session`), and supports `scope='global'` plus `scope='project'` (binds to the boot-time active project; refuses with the resolver reason when none is bound). Tool schema declares `key` / `scope` / `reason` flat at the top level; nested `options.{scope,reason}` is accepted as legacy fallback. Prompt text (key, scope, reason, command preview, plaintext caveats) is run through the active session model so the wording matches the language the user is currently speaking; English is the fallback when no user context exists or the LLM call fails. i18n translator has a 12-second budget (`TRANSLATE_TIMEOUT_MS=12_000` in `extensions/abrain/i18n.ts`), keeps the most recent 3 user messages in a ring buffer (`RING_MAX=3`, `RING_TEXT_MAX=1200`), and LRU-caches `(en, hint)` translations up to 200 entries (`CACHE_MAX=200`). Technical tokens (scope:key, `$VAULT_*` refs, command previews, base64/hex/xxd/xor warnings) are preserved verbatim across languages. Covered by `npm run smoke:abrain-i18n`.
- [x] P0c.read bash path (project + global): `$VAULT_<key>` prefers the boot-time active project then falls back to global, `$GVAULT_<key>` is global-only, `$PVAULT_<key>` is project-only (block when no active project is bound). Injection still goes through a 0600 temp env file; stdout/stderr default-withheld from LLM unless user explicitly authorizes once/session, then literal redaction runs before returning output. Authorization menus put deny first so non-interactive/API runners fail closed. Covered by `npm run smoke:abrain-vault-bash`.
- [x] P0c.read audit closure: `~/.abrain/.state/vault-events.jsonl` now records read-path ops alongside the existing write-path ones — `release` / `release_denied` / `release_blocked` (vault_release lane) and `bash_inject` / `bash_inject_block` / `bash_output_release` / `bash_output_withhold` (bash hook lane). Each row carries scope, key(s), `$VAULT_<name>`→scope:key variables for bash inject, and a truncated command preview (variable refs only — never plaintext). Covered by `npm run smoke:abrain-vault-writer` (`appendVaultReadAudit` row shape) and `npm run smoke:abrain` (read-path callsite wiring).
- [x] active project resolver (legacy P1 + B4.5 strict binding): `resolveActiveProject(cwd)` now requires strict `.abrain-project.json` + `projects/<id>/_project.json` + `.state/projects/local-map.json` and exports `resolveBrainPaths(abrainHome, projectId)` (covered by `npm run smoke:abrain-active-project`). `~/.abrain/projects/_bindings.md` / remote / cwd-prefix inference is retired.
- [x] project-scoped `/secret`: `set/list/forget` default to the strict-bound active project, `--global` is the explicit opt-out, and `--project=<id>` is accepted only when it equals the boot-time bound project. When no active project resolves, default/project-scope writes refuse with actionable ADR 0017 statuses (`manifest_missing` / `registry_missing` / `path_unconfirmed` / `path_conflict` 等). `/secret list` (no flag) prints global plus the active project. `/secret list --all-projects` walks every `~/.abrain/projects/<id>/vault/` (metadata-only via `listAbrainProjects` + `listSecrets`, no decryption). Covered by `npm run smoke:abrain-secret-scope` and `npm run smoke:abrain-active-project`.


### Tier 2 optimization 验收（仅在该 backend 上 host 实际可用时走）

- [ ] macOS host：`/vault init --backend=macos` → `security find-generic-password -s alfadb-abrain-master` 返回 加密 secret
- [ ] Linux desktop + secret-tool host：`/vault init --backend=secret-service` → `secret-tool lookup service abrain key master` 返回 secret
- [ ] pass user host：`/vault init --backend=pass` → `pass show abrain/master` 返回 secret

### 容器 / CI 场景验收（v1.4 新加）

- [ ] **容器 ssh-key 路径 e2e**：worker container 上跑 `/vault init --backend=ssh-key` → init 成功 → `/vault status = unlocked`。这是 alfadb 主场景。
- [ ] **CI 场景**（无 ssh-key 无 GPG）：detection 跳到 passphrase-only。CI 推荐主动 disable：`touch ~/.abrain/.state/vault-disabled`。
