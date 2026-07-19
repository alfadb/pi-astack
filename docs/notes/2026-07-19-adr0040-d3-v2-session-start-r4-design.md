---
doc_type: design-note
status: production-operator-implemented-not-authorized
revision: R4.1
---

# ADR0040 D3-v2 session_start S2 create/bind operator R4.1 design

R4.1 is a local corrective release over the published but not authorizing R4 source. It keeps the immutable R3.9 execution-ready predecessor and does not authorize or execute S2.

## Corrected two-session binding

R4 incorrectly used the authorization session as its canary target. R4.1 explicitly separates two persisted sessions in every frozen binding, authorization tuple, dossier, preview, activation closure, receipt, and runtime check:

- `target_session_binding`: `019f6f1d-cc5c-7fcf-bcee-18dd618656ff`, `/home/worker/.pi/agent/sessions/--home-worker-.pi--/2026-07-17T08-07-31-677Z_019f6f1d-cc5c-7fcf-bcee-18dd618656ff.jsonl`;
- `authorization_transcript_binding`: `019f77f6-899b-7fa0-ad5f-e1d8bb1ceadc`, `/home/worker/.pi/agent/sessions/--home-worker-.pi--/2026-07-19T01-21-13-627Z_019f77f6-899b-7fa0-ad5f-e1d8bb1ceadc.jsonl`.

The bindings must differ by session ID, path, and physical file identity. Selector, activation `session_id`, target prefix, quarantine, and runtime selected session bind only the target. Initial/continue coordinates are read only from the authorization transcript. The activation therefore combines an authorization coordinate from the authorization session with a `session_file` binding for the target session; these are deliberately not the same identity.

Both files use the trusted pi v3 JSONL reader. The basename must end with the exact `_<sessionId>.jsonl` suffix, not merely contain the ID. Header and entry shapes, duplicate keys, parent chain, active branch, role, standalone text, file identity, and the requested first-N-byte prefix hash are validated. Runtime has no `enforceRoot=false` path.

## Authorization and publication order

Fresh execute and fresh continue independently read the latest exact standalone `role=user` message from the authorization transcript. No caller-supplied authorization JSON/text, `--force`, `--yes`, session, or path override is accepted.

Before the first intent or any pending cleanup, the operator validates the complete closed authorization tuple, both session cross-bindings, D3, predecessor, adapter/operator manifests, execution dossier, settings A/B state, all control paths, source closure, source commit, and exact authorization coordinate. Under the retained settings-parent lock it then re-reads the target first prefix and the current latest authorization coordinate. Any drift produces zero operator writes.

`operation_id` remains SHA-256 over RFC8785-JCS of the complete tuple. The tuple binds both session bindings, D3 identities, immutable R3.9 predecessor, R4.1 operator manifest and dossier, settings pre identity/post bytes/desired subtree, control and independent rollback roots, source closure, exact HEAD commit, and the authorization coordinate.

## Source commit closure

Production preview, execute, and continue rebuild the live dossier instead of trusting JCS plus a recomputable self-hash. R4.1 reads the independent `docs/evidence/2026-07-19-adr0040-d3-v2-session-start-r4-adapter-manifest.json`, validates its closed graph and self-hash, and requires exact equality with the live 82-file adapter rebuild. It never combines the immutable R3.9 adapter evidence path with the R4.1 live identity. Rebuild also covers predecessor, D3, operator manifest, settings desired/post image, both session identities/prefixes/paths, and all control/rollback/audit/quarantine paths, then compares exact committed dossier and preview bytes.

The source commit gate enumerates every operator-manifest critical and graph file. With `GIT_OPTIONAL_LOCKS=0`, each file must be a safe live regular file, exist as `HEAD:<path>`, match the Git blob byte-for-byte, match its graph byte/hash row, and not be ignored. Repository clean status is informational only. Root `package-lock.json` is no longer ignored and is part of this closure; until a later commit contains the corrected bytes, production execute/continue remain blocked.

## Durable create-only recovery

Final authority paths are fixed `intents/<operation>.json`, `activations/<operation>.json`, and `receipts/<operation>.json`. Each has one deterministic pending name, `.<operation>.<kind>.pending`.

Fresh execute stops on any existing final, pending, or foreign entry. Publication is mode-0600 `O_EXCL` pending write, file fsync, hardlink no-replace, parent fsync, exact same-inode/nlink-2 readback, pending unlink, second parent fsync, and exact nlink-1 readback. Runtime rejects every pending entry, including a final plus pending pair left after a hardlink crash.

Only fresh `--continue`, after complete authorization and A/B matrix validation, may recover. It accepts one exact operation/kind/path and exact bytes/mode/uid/gid/size. A temp-only nlink-1 pending is unlinked and parent-fsynced before exact republication. A final+pending same-inode nlink-2 pair has only the pending name unlinked and parent-fsynced. An exact final nlink-1 state is parent-fsynced and verified, covering a crash after unlink. This includes the natural intent final-only window: intent publication completed through pending unlink, while activation publication has not begun. Foreign or multiple pending names halt without cleanup.

## Settings, receipt, and runtime

Settings CAS remains duplicate-key rejecting and binds device, inode, mode, owner, link count, size, mtime, ctime, and raw SHA-256. CAS failure may converge only on an exact authorized postimage readback. The cooperative retained-parent OFD lock and immediate recheck cannot exclude a non-cooperative writer between the final content check and rename; this residual remains explicitly accepted and is not described as closed.

Recovery states are concrete:

- settings A(pre) + exact tuple-bound intent final/pending + activation absent with no activation pending + receipt absent: rebuild and validate the expected activation, create-only publish it, CAS settings, then create the receipt;
- settings A(pre) + exact intent + exact activation + no receipt: CAS then receipt;
- settings B(post) + exact intent + exact activation + no receipt: receipt only;
- settings B(post) + exact receipt: terminal verification without rewrite;
- settings A(pre) + any receipt: halt;
- settings B(post) + activation absent, any receipt with activation absent, a foreign/mismatched activation, foreign/pending inventory, or settings neither A nor B: halt.

The operator re-discovers the sole control operation and re-reads settings under the retained settings-parent lock after the test/interposition hook and immediately before any pending cleanup or publication. Thus activation reconstruction is authorized only from the exact A(pre), intent-only, receipt-absent closure; a stale earlier observation cannot authorize it.

The receipt is deterministic per operation and fixed path, exactly once, and binds both session bindings, completion authorization, settings post identity, D3, manifests, dossiers, source closure, activation, and resolved paths. Runtime requires the exact settings/intent/activation/receipt closure, validates both trusted JSONL bindings and recorded coordinates, rejects pending temps, and otherwise returns selected-zero with no ADR0039 fallback.

## Control, rollback, and preview boundary

`control_root` and `rollback_target` are distinct, non-nested roots. Control contains only `intents`, `activations`, `receipts`, and optional non-authoritative `operator-audit.jsonl`. Rollback uses `/home/worker/.pi/.pi-astack/adr0040-d3-v2-session-start/r4-rollback`, preserving the R3.9 rule that rollback `stateRoot` must equal `activation.rollback_target`.

Default CLI preview is exact-byte comparable with the frozen preview and performs a live dossier rebuild plus source-closure inspection. The generic protected snapshot covers Git metadata, the complete target session, settings, D3, control, rollback, old activation, runtime/operator audits, and quarantine. It deliberately excludes the active authorization transcript and its parent directory: that append-only file instead uses a frozen-prefix attestation whose prefix bytes/SHA-256, device, inode, header SHA-256, and session ID must remain equal while a longer valid tail is allowed. The target session still requires complete identity and byte equality. Smoke additionally verifies the subprocess with `strace` and rejects mutating filesystem syscalls.

## Frozen evidence identities

- R4.1 adapter evidence: raw SHA-256 `917b3f9792afcf83d48de020130b669a103b67564b92f0cf3e8961ff903eea97`, self-hash `47ca017012d46a9a68e4081353c39882febe37824c4cd09b8985469434e40f1c`, graph hash `b8cd87198c002a94d8384d39e2002331b4f1d222ca5d88168260396d5ae9ab75`, 82 files.
- R4.1 operator manifest: raw SHA-256 `2bfd431cbc4a793a4547f0b8f370890b066860c60662c0436bd692d327da10cf`, self-hash `0f799e266a8726685b177aca94351e4e413d78c850d76dc29762258f3d3c6907`, graph hash `8dc6ea15bb94be5da673f42bb39e7a1c6753234cdcbc8b1222ce8c769b64e974`, source closure `ab4f9174be7f5e69907c76937a6b6d6ee1e725ff3ee7ade69c24fda8ed0cb511`.
- R4.1 dossier: raw SHA-256 `7297b7180e45959b698136216236c769128c6af4e5af74df5afca817084fe369`, self-hash `1312f357170499438bf096400073fac910d4782a1ae3d578add7e790920e4842`.
- R4.1 frozen preview: raw SHA-256 `fc10245234fe5b2719e44d7c8816fdfc5c0753114a8ba3e11d086e9a2d85fa3b`, self-hash `cf66f1ccdeb53504a19e42d1a0d0144ff771a12a5713ca02eca851c9563904a2`.
- Live settings prestate: raw SHA-256 `64b5045111148e8d9828e6da70d591d23f491029ca873b2575fd945c15ba43d5`; desired postimage raw SHA-256 `2c26e109eb0db7306c4a4b8a42009251b3a28ed8fbd777da1237c0392297825c`.

No production execute/continue, settings/session/control/D3/.abrain write, rollback, commit, or push is part of R4.1. Status remains `S2_NOT_AUTHORIZED`; the transition remains `blocked / separate_authorization_required`.
