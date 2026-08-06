---
doc_type: completion_record
status: scope_pass
accepted: false
phase: windows_native.extension_adaptation
recorded: 2026-08-06
living_plan: docs/plans/2026-08-05-windows-native-support-plan.md
---

# Windows-only extension adaptation — scope completion

This record freezes **Windows-only extension adaptation** evidence on the current live package after production rebuild, install (`package_rx`), and focused smoke / dossier runs. It records a **scope pass** for the local extension surface only.

It does **not** claim production acceptance. Overall remains `accepted:false` / `partial`. All eight stable criteria remain open. Daemon code and live daemon state were **not** touched. Goal may pause until daemon redesign recovery and/or external hosts.

Living plan authority: [2026-08-05-windows-native-support-plan](../plans/2026-08-05-windows-native-support-plan.md).  
Historical partial (older artifact identity; do not rewrite): [2026-08-06-windows-native-production-acceptance-partial](./2026-08-06-windows-native-production-acceptance-partial.md).

## Disposition

| Field | Value |
|---|---|
| extension scope | `extension_windows_adaptation=pass` |
| overall status | `partial` |
| `accepted` | `false` |
| production acceptance claimed | **no** |
| criteria checked | none (all eight remain open) |
| daemon | **untouched** |
| goal | may **pause** (resume after daemon redesign / external host) |

## Tested artifact identity (current)

| Field | Value |
|---|---|
| source commit | `7c7dd71e5b6f401a8d7b46d64d23c1b29af4e9e5` |
| artifact commit | `0b040be85b140f69574fba1c0f1e2a279b2c253e` |
| manifest sha256 | `9c91242ba26c749e9777eac2b6992f85b293b137effa4388673d77242bb351c6` |
| binary sha256 | `9d98e955208999f59fd32e3733bf0a4ea525d081d1753110870c104c0db3b489` |
| build_id | `0f53ce2f650347b1ba32e59fd673300500c5f0a3eb1971c9389e8c38885b7ce3` |
| source_tree sha256 | `205b5eaf6df308ff7dcbaeacef8674185825d1e5f2aa38db53a72ff77bc1bb5f` (unchanged) |
| toolchain_id | `b937bbdab556e3df8ce518def79c0c6bd75fd0d163453040b8290f4c3db04c02` (unchanged) |
| pin | live (non-null manifest pin + source_commit pin; package installed `package_rx`) |

Integration note (second remote merge): remote `53ee7aa` → source `7c7dd71e5b6f401a8d7b46d64d23c1b29af4e9e5` merged into this lineage. First remote merge (`3315f57` dispatch profile removal → historical source `fc1364ec…`) remains historical under prior identity. **model-curator live smoke**：Windows URL pathname **源码 bug 仍存在**；仅用不落盘的 `fileURLToPath` 临时包装继续诊断；包装后因**父仓 live settings 未迁移**仍有 **5 fail**——属远端已存在 / 父仓待处理，**不**影响 Windows extension artifact 验收；**不得**宣称全绿。

Quick acceptance (this identity): package **15** / addon **32** / load canary **pass**；dossier `extension_windows_adaptation=pass` / overall `partial` / `accepted:false`；live abrain aggregate **unchanged**. Full retained/adapter/durable-dacl/stable/edge/DCC physical matrices not re-asserted as all-green in this refresh.

Historical note only: prior current identity was artifact `fc97429f…` / source `fc1364ec…` (now historical). Earlier extension-record identity was artifact `058b4054…` / source `bbe55894…`. Earlier partial record used artifact `8823e47f…` / source `f0aac173…` (do **not** rewrite). Those identities are **not** current.

## Build / package evidence

- build_mode: production
- reproducibility: `dual_clean_match` (prior lineage; this identity refresh inherits package_rx pin live)
- package_rx: verified / pin live; production zero-arg load positive path available
- **not** claimed: full suite all-green after second remote merge

## Smokes (quick acceptance — this identity)

| Suite | Result |
|---|---|
| package | 15 pass |
| addon | 32 pass |
| load canary | pass |
| dossier extension | pass (`extension_windows_adaptation`) |
| dossier overall | partial / `accepted:false` |
| live abrain | unchanged |
| model-curator live | **not** all-green (source Windows URL pathname bug **still open**; non-persisted `fileURLToPath` temp wrap only for continued diagnosis; after wrap still **5 fail** from parent-repo live settings not migrated — remote-known / parent pending; **out of** Windows extension artifact acceptance) |

Historical full-matrix notes (prior identity `fc97429f…`/`fc1364ec…`, not re-run as claim for this refresh): retained-native 9; adapter 11; durable-dacl (post-sync fix continuous 20 before final rebuild; continuous 5 after install); stable-view 21; edge 9; DCC physical 10.

## Dossier dual disposition

| Field | Outcome | Note |
|---|---|---|
| `extension_windows_adaptation` | pass | local mechanical gates only |
| overall `accepted` | `false` | never greened by local sections alone |
| overall `status` | `partial` | closed blocking residuals deferred |
| live abrain aggregate | unchanged | before/after equal |
| git tree after runs | clean | |

Scope pass **is not** production accepted.

## Threat model (confirmed; non-claims)

- Same TokenUser and administrator rewrite: **out of loader contract**
- Other principals: fail-closed (package_rx / path / ACL)
- hash / pin / package_rx: provenance + corruption detection — **not** same-token race proof
- **No** small native bootstrap
- same-token race is **not** a global TOCTOU blocker; do not reintroduce it as one
- `WIN-BINARY-PROVENANCE` remains open because full first-matrix external evidence is incomplete — not because same-token TOCTOU must be atomically closed

## Residuals (overall still open / deferred)

1. **Daemon DCC live** — physical path wired; live daemon lock + real git + settled kick **not covered**; daemon **untouched**
2. **Live matrix stable / edge** — temp-fixture production physical path only; not live production roots
3. **Linux zero-regression** — no on-this-host evidence
4. **Second-account DACL active tamper** — not constructible on this host
5. **Node ≥22.19 dual-lane + Windows Server** — external matrix deferred
6. **Cross-host external evidence ingestion** — removed; redesign only after daemon refactor
7. **All eight stable criteria** — open until matching external evidence exists

## Stable criteria status

All remain open. This record does **not** authorize `goal_check` or checkbox flips.

| Criterion | Disposition |
|---|---|
| `WIN-LINUX-ZERO-REGRESSION` | open (no local Linux evidence) |
| `WIN-LOCK-CONTENTION-CRASH` | open (scope/smoke pass ≠ full criterion close) |
| `WIN-STABLE-VIEW-INJECTION` | open (temp fixture; not live matrix) |
| `WIN-EDGE-JOURNAL` | open (temp fixture; not live matrix) |
| `WIN-DACL-TAMPER` | open (second-account active tamper missing) |
| `WIN-DCC-READY` | open (daemon live not covered; daemon untouched) |
| `WIN-BINARY-PROVENANCE` | open (full first-matrix external evidence incomplete; same-token out-of-contract) |
| `WIN-PRODUCTION-ACCEPTANCE` | open (`accepted:false`) |

## Explicit non-claims

- Does **not** claim Windows production acceptance.
- Does **not** claim any of the eight stable criteria verified.
- Does **not** claim same-token/admin rewrite closed (out of contract).
- Does **not** claim Windows DCC ready.
- Does **not** claim Linux zero-regression.
- Does **not** claim full first-matrix OS/Node coverage.
- Does **not** claim daemon work completed or authorized.
- Contains no absolute filesystem paths and no raw SIDs.

## Next

Resume only after **daemon redesign** and/or **external host** availability. Until then the living plan goal may pause with Windows-only extension adaptation complete in local scope and overall production accepted deferred.
