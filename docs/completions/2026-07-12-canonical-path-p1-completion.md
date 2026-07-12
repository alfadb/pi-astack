---
doc_type: completion_record
status: completed
phase: canonical_path.p1
completed: 2026-07-12
---

# Canonical-path P1 completion record

P1 is complete. This record closes only the R3.4.2 P1 production convergence phase. It does not authorize or start P2, P3, P4a, or P4b.

## Stable criteria evidence

| Criterion | Disposition | Evidence |
|---|---|---|
| `P1-S3-REGISTRY` | pass | `schemas/l1-schema-role-registry.json`, `docs/transition-register.machine.json`, and `smoke:canonical-path-foundation` validate the central write/scan gate and machine transition source. |
| `P1-S1-GIT` | pass | `docs/evidence/2026-07-11-canonical-path-p1-b-production-trace-manifest.json` records exact temporary-index/CAS/cohort/index evidence; manifest SHA-256 `e9dff27246f0ce3c69fbd54a7251d6433513f52355d5e31b7e7c4fc9439dc5f0`. |
| `LOCAL-v2-RECOVERY` | pass | `smoke:convergence-recovery`, `smoke:canonical-git-runtime`, and the three production local manifests below cover deterministic v2 closure, generation continuity, terminal semantics, and current whole-L1 recovery state. |
| `P1-S4-SHADOW` | pass | `docs/evidence/2026-07-11-canonical-path-p1-s4-production-shadow-manifest.json`; manifest SHA-256 `fa884da8eca347aeeee68f24b2aba7d7be569252a7d5f90d9db10b1b117eaa1a`. |
| `P1-B-TRACE` | pass | `docs/evidence/2026-07-11-canonical-path-p1-b-production-trace-manifest.json`; report exact SHA-256 `0a692f5cfbc65b718b4791fdcc967ca9a637b4ec585b0c68c9c804c5c2c45f56`. Retired trace entrypoints remain forward-deleted; historical evidence remains immutable. |
| `LOCAL-DRAIN-CURRENT` | pass | `docs/evidence/2026-07-12-canonical-path-p1-a-production-existing-local-drain-manifest.json`; manifest SHA-256 `1b733e8afc85d20a45b79888805828d8483f6eebd1563edebdc4a5a8a460532c`. |
| `LOCAL-DRAIN-NEXT` | pass | `docs/evidence/2026-07-12-canonical-path-p1-local-drain-next-curator-isolation-manifest.json`; manifest SHA-256 `8b288a86e50d616220803f56fcf45f488b0cd00bd0a2e37d2dcd09598626e7bc`. |
| `LOCAL-RUNTIME-RESTART` | pass | `docs/evidence/2026-07-12-canonical-path-p1-production-runtime-restart-manifest.json`; report exact SHA-256 `971c33aaa64797db73533497ca570de4c288217d6b88a9e84c59ba199b362dbd`, manifest SHA-256 `5073bd401e357dca3c6e3e0902d2e23af3cff1ad3907c044ba65dcc5376f1615`. `smoke:production-runtime-restart` passes a production clone and five real temp-repo tamper cases. |
| `NATIVE-GIT-BOUNDARY` | pass | `smoke:abrain-git-sync` verifies native fetch/ff-only/push argv and device transport isolation. The restart dossier independently records zero remote commands before canonical convergence and fetch/push only afterward. |
| `CURATOR-PENDING` | pass | The NEXT/Curator manifest above proves active v2 is drain-only, Curator production v2 wiring remains absent, and the criterion does not depend on staging counts. |
| `P1-CLOSE-GATE` | pass | This completion record references every stable P1 criterion, records residual risk, and leaves `canonical_path.p2` and `canonical_path.p3` at `blocked/not_authorized` in the machine transition register. |

## Restart evidence

The read-only restart dossier derives all full IDs from strict-valid L1. For episode `7181b2b529198e66d5dea01bd491be69df40f0707e430a0f8a7e24c9893219e9`, slot 1 is exactly:

- claim `d9cc0415498a0949074f768daf638c343f5646195725a3c9153097ab5f7539c3`
- prepared `b6c6ed419039bda16104f697b0dc324ea03bbb7bc36f496181c5b1b2b3c50f7f`
- published `bb784d04616724b3db38bb6ef6ae12cf350c01c9dc4f88fce62e50f5f4deaa7c`
- converged `7fd5615a048801b4440228eb3614e9a512acbb9c31ba0e99b0f7b4b0659a8683`

The same candidate is `4599d69b9f52015773a3033f5a3830497f0eb4b0`, with exact parent `b2395d10676a9c2cd0f815a5c341fab53e13f92e`, tree `fd9c138fb529f508c6cde51c13ab9000b51240d6`, and cohort root `ba88c7932b9e89b9d33fbce355627c14f73fa8d8ae24e42091136781f050ab94`. The actual source L1 is `0d9df863c2db351e33449443d93ec0c8b55fbd7df49c1556c8512ab11ec780f4`, whose exact source ref is `sediment:auto_write:updated:restart-probes-require-an-isolated-canonical-backlog`. Legacy `1750cb2920b9a72284335107b13011bba21228b8ee0975a0d3a3bc3ae224fc3a` is strict read-only and excluded from the cohort.

The durable timeline shows claim/prepared at 18:59:13/14 +0800, fresh session boundary at 19:14:10.735 +0800, published/converged at 19:14:19 +0800, then device fetch/push at 19:14:27/28 +0800. Device transport is an observation, not a canonical gate.

## Residual risk

The old armed process was not first confirmed exited. The fresh no-probe process (`3180698` launcher, `3180700` runtime) was started unintentionally by review dispatch, not by an orderly operator replacement. This weakens the process-handoff procedure and must not be represented as a clean operator sequence. It does not change the narrower durable fact accepted here: a fresh process crossed the existing pending prepared window and recovered the same episode, slot, and candidate through publication and index convergence without a canonical remote command.

The one-shot probe was therefore forward-deleted after evidence capture: runtime env/parser/isolation/latch/controlled-stop branches, sediment scheduler/writer/audit suppression, probe smoke/package entry, runbook, and template are absent. The R2 startup content/metadata publication fix remains active and regression-covered.

## Authorization boundary

`canonical_path.p2` and `canonical_path.p3` remain `blocked/not_authorized`. Each still requires a new six-vendor or equivalently independent unanimous multi-T0 authorization. No authorization ticket was created, no P2/P3 implementation was started, and P1 completion does not imply either authorization.
