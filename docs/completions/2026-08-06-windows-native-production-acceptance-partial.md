---
doc_type: completion_record
status: partial
accepted: false
phase: windows_native.production_acceptance
recorded: 2026-08-06
living_plan: docs/plans/2026-08-05-windows-native-support-plan.md
---

# Windows native production acceptance — partial record

This record freezes **partial** external evidence for the first-matrix Windows native production path after the final package was committed, installed with `package_rx`, and exercised by the production acceptance dossier. It does **not** claim production acceptance. All eight stable criteria remain unchecked. `accepted:false`.

Living plan authority: [2026-08-05-windows-native-support-plan](../plans/2026-08-05-windows-native-support-plan.md).

## Disposition

| Field | Value |
|---|---|
| overall status | `partial` |
| `accepted` | `false` |
| criteria checked | none (all eight remain open) |
| production acceptance claimed | **no** |

## Tested artifact identity

| Field | Value |
|---|---|
| artifact commit | `8823e47f4de37156ac8ebbb9a6149bd8617ce470` |
| source commit | `f0aac1737550c1a926fc73e775a1870768215320` |
| manifest sha256 | `b41b07d13005ff5189c7e61a080d36ba72640624174828ce0181a9148f5bb6e7` |
| binary sha256 | `f29c1e7ae35e4dcbd864333feb25fe972d0cb6e4b725aabf9c3bdbc237ef4d0f` |
| build_id | `0adb312d6245f470ff05ca2627cb2dc45f94616387fa2cb5f53fc1b03defce26` |
| source_tree sha256 | `d38a50965a6909267445b693c9a9f37c52f1d323ceec8c432f838f2774664afd` |
| toolchain_id | `b937bbdab556e3df8ce518def79c0c6bd75fd0d163453040b8290f4c3db04c02` |
| pin | live (non-null manifest pin + source_commit pin; package installed `package_rx`) |

## Runtime host (first-matrix slice)

| Field | Value |
|---|---|
| Node | `24.18.1` |
| ABI target | `win32-x64` |
| OS family | `Windows_NT 10.0.26100` |
| FS | local `NTFS` |

This is one real host slice inside the first support matrix. It is **not** full OS/Node matrix coverage.

## Build / package evidence

- dual clean reproducibility: match
- native tests: passed (21)
- clippy: passed
- sensitive path scan: passed
- build gates: all true
- package smoke: 15 cases
- post-pin smoke matrices: exercised under live pin (production zero-arg positive path in child processes)

## Dossier section outcomes

Controller-driven production acceptance dossier against the live package / installed `package_rx` surface:

| Section | Outcome | Note |
|---|---|---|
| provenance | pass | zero-arg load + package_rx; does **not** auto-close `WIN-BINARY-PROVENANCE` |
| retained-lock | pass | multi-process contention / crash-abandon observation under production physical path |
| DACL | pass | matrix deny paths observed; **not** second-account active tamper |
| stable-view | pass | temp-fixture production physical path (not live matrix root) |
| edge | pass | temp-fixture production physical path (not live matrix edge layout) |
| DCC | `not_covered` | cannot construct full live daemon lock + real git + settled kick six-condition ready path in this run |
| same-fd post-dlopen rehash | pass | structural/provenance evidence only; TOCTOU residual remains |
| live abrain aggregate | unchanged | before/after hash equal |
| git tree after run | clean | |

Overall dossier disposition remains **`partial` / `accepted:false`**. Exit-success of the dossier harness is not production acceptance.

## Residuals (blocking / open)

1. **TOCTOU not fully closed** — no native bootstrap atomic guarantee; residual classes include ancestor pre-open delete handles and same-token/admin rewrite. `same_fd_post_dlopen_rehash:"pass"` does not close `WIN-BINARY-PROVENANCE`.
2. **DCC not covered** — live daemon lock + real git + settled kick required before any ready-path claim; section stays `not_covered` / partial.
3. **DACL second-account active tamper** — not covered by this run (system-owner / same-token deny matrix is not a second principal active tamper proof).
4. **stable / edge scope** — temp-fixture production physical path only; not a live production matrix root walk.
5. **Linux zero-regression** — no on-this-host evidence for `WIN-LINUX-ZERO-REGRESSION`.
6. **OS / Node full matrix** — only Node 24.18.1 + Windows_NT 10.0.26100 + win32-x64 + local NTFS observed; Node >=22.19 dual-lane and broader OS matrix remain open.

## Stable criteria status

All remain open. This record does **not** authorize `goal_check` or checkbox flips.

| Criterion | Disposition |
|---|---|
| `WIN-LINUX-ZERO-REGRESSION` | open (no local Linux evidence) |
| `WIN-LOCK-CONTENTION-CRASH` | open (dossier retained pass ≠ full criterion close) |
| `WIN-STABLE-VIEW-INJECTION` | open (temp fixture path; not live matrix) |
| `WIN-EDGE-JOURNAL` | open (temp fixture path; not live matrix) |
| `WIN-DACL-TAMPER` | open (second-account active tamper missing) |
| `WIN-DCC-READY` | open (`not_covered`) |
| `WIN-BINARY-PROVENANCE` | open (TOCTOU residual remains) |
| `WIN-PRODUCTION-ACCEPTANCE` | open (`accepted:false`) |

## Explicit non-claims

- Does **not** claim Windows production acceptance.
- Does **not** claim any of the eight stable criteria verified.
- Does **not** claim TOCTOU fully closed.
- Does **not** claim Windows DCC ready.
- Does **not** claim Linux zero-regression.
- Does **not** claim full first-matrix OS/Node coverage.
- Contains no absolute filesystem paths and no raw SIDs.
