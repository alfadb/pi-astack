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
| source commit | `fc1364ec20f00375534aa7b5738fa79388a7359e` |
| artifact commit | `fc97429fc9dd46455a8f0dd23fd5e22bea2b59db` |
| manifest sha256 | `ccde3967d28801c8bd707ff61cc3ff2658f04052f43ac880563950be7d655278` |
| binary sha256 | `f95ee212a16ea246e338064cf334d6c1588c66c994117c9c39dedeacccd0bf46` |
| build_id | `f84854a9a21281ef56ccc3f74f1cc19ed003d8663310d9bdd1f0877787a038c0` |
| source_tree sha256 | `205b5eaf6df308ff7dcbaeacef8674185825d1e5f2aa38db53a72ff77bc1bb5f` |
| toolchain_id | `b937bbdab556e3df8ce518def79c0c6bd75fd0d163453040b8290f4c3db04c02` (unchanged) |
| pin | live (non-null manifest pin + source_commit pin; package installed `package_rx`) |

Integration note: `origin/main` `3315f57` dispatch profile removal was merged into source `fc1364ec…`. Core dispatch/workflow tests passed. workflow-tools Windows symlink **EPERM×4** is an environment limitation, not a functional regression. Post-merge production dual_clean_match / native 21 / clippy / package_rx and full focused smokes passed; dossier extension pass / overall partial; live abrain aggregate unchanged.

Historical note only: prior extension-record identity was artifact `058b4054…` / source `bbe55894…` (now historical). Earlier partial record used artifact `8823e47f…` / source `f0aac173…` (do **not** rewrite). Those identities are **not** current.

## Build / package evidence

- build_mode: production
- reproducibility: `dual_clean_match`
- native tests: passed (21)
- clippy: passed
- package_rx: verified
- pin live; production zero-arg load positive path available

## Smokes (pass)

| Suite | Result |
|---|---|
| package | 15 pass |
| addon | 32 pass |
| load canary | pass |
| retained-native | 9 pass |
| adapter | 11 pass |
| durable-dacl | pass（同步修复后、最终 artifact 重建前连续 20 次；最终 artifact 安装后连续 5 次） |
| stable-view | 21 pass |
| edge | 9 pass |
| DCC physical | 10 pass |

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
