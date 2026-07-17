---
doc_type: design-note
status: accepted-round-13-design-implementation-and-append-not-authorized
---

# ADR0040 real policy proposition append design

## Decision status

Round 6 ended at the six-vendor unanimous `SIGN` architecture milestone from OpenAI, Anthropic, DeepSeek, Moonshot AI, MiniMax, and Z.ai. Those historical verdicts remain transcript-observed architecture records, not cryptographic vendor attestations or post-write exact-byte signatures.

Round 13 supersedes the Round-6 dedicated PID/mtime/token lock and its stale/dead-owner/token tests. It retains bubblewrap confinement, the fixed-event deterministic-temp S0-S4 state machine, scanner agreement, hardlink no-replace event publication, exact fsync chain, no shard deletion, and terminal/transient mutation accounting. Round 13 also tightens repo-evidence publication, target-first terminal precedence, bootstrap/recovery authorization checks, and the boundary on what observed drift may be claimed.

The six Round-13 records now preserve the exact outputs of the final exact full-protocol review, not an expanded reconstruction of an earlier delta review. The unique matching dispatch is session line 441, message `a661f269`, toolCallId `call_7UYC0hmIxLdDyfYAoXxyBzvk|fc_05772e61151ea5ed016a568b9a9c588198a78fafc88fb0f00f`; its immediately following result is line 442, event `75279dc3`. Each prompt is 1,246 UTF-8 bytes with SHA-256 `ffcf38ecc0985a19bd2ee0b9b1ba508d8a029cb550fe1e4486aefd126f0bbaa8`; each record stores its exact returned output text plus independently replayable UTF-8 byte length and SHA-256.

The transcript-observed routes are three Anthropic tasks and three OpenAI tasks: `anthropic/claude-opus-4-8`, `openai/gpt-5.6-sol`, `openai/gpt-5.5`, `openai/gpt-5.6-terra`, a second isolated `anthropic/claude-opus-4-8` task, and `anthropic/claude-sonnet-5`. All returned `SIGN` and found no strictly better in-scope protocol. These are transcript-observed model outputs and task routes, not cryptographic vendor attestations and not user-provided reviewer identities. The frozen review filenames are legacy authorized path labels only; no Round-13 participation is claimed for DeepSeek, MiniMax, Moonshot AI, or Z.ai.

### User-attested review-gate substitution

The `accepted_design_only` status is supported by a later prompt_user user-attested decision, not by a `role=user` text message and not by a reviewer identity claim. In session `/home/worker/.pi/agent/sessions/--home-worker-.pi--/2026-07-12T13-55-08-627Z_019f569c-40d3-73f0-9a5f-666b395f6b9a.jsonl`, assistant prompt message `02748e40` at line 452 (`2026-07-14T19:45:42.510Z`) issued toolCall `call_NIF5OQ0UeODZ8wv4JMZfwRR5|fc_05772e61151ea5ed016a5691e2c794819888e404bfdbbd739b` with question id `round13_review_gate`; successful prompt_user result event `374c3270` at line 453 (`2026-07-15T00:38:33.029Z`) returned the exact selected answer `接受 2 个 provider（3 Anthropic + 3 OpenAI）、6 个隔离上下文的一致 SIGN，替代本次原定六厂商门槛；允许修正包状态并生成 Stage2 精确授权文本` (181 UTF-8 bytes, SHA-256 `303e29c779c347e337607bebb36d457dde0fa12171191982f2092b895be80867`).

That decision substitutes only the original six-vendor review gate for this `b53bc2692fc65f478301597756217a097bb2b2627a74c4c3ef5cd82ef1684a76` protocol. It changes neither the protocol object/hash nor any of the six review bytes. It does not authorize Stage 2 implementation, Stage 3 append, `.abrain` mutation, commit, push, restart, P2a CAS, P2b publication/selection, or any runtime/read flip.

This package accepts design only. It does not authorize Stage 2 implementation, Stage 3 production append, any `.abrain` mutation, P2a CAS advance, P2b work or publication, stable-view selection, a runtime consumer or read flip, P3/P4, restart, commit, or push. P2b.1 remains complete only as the repo/sandbox compiler substrate plus real read-only empty-source preview; P2b overall remains `blocked / separate_authorization_required`.

## Canonical package identities

The Round-13 protocol hash is `b53bc2692fc65f478301597756217a097bb2b2627a74c4c3ef5cd82ef1684a76`.

The canonical [append authorization plan](../evidence/adr0040-real-policy-proposition-append-design/append-authorization-plan.json) raw/self SHA-256 is `06a2915ecf88022e861295f9e844ae96b2ea3543b544e44ebe7426ac54d609a5` / `1505659abc5a6ea56aa5c45bb5140b6ed8433a24e9d7410d34c0411042019478`. The [read-only preview dossier](../evidence/2026-07-14-adr0040-real-policy-proposition-append-read-only-preview-dossier.json) raw/self SHA-256 is `08cd956a1ba382c239ecd447159e510e8597a0d7cb6a0fd9dd4a2d4de7b347d9` / `c6a1d9ae759b282b110ae55a9c6bc0fc65bf63c4d172ca62c20d1a3cc4b34ec1`.

| Legacy path label | Transcript-observed route | Task index / exact task name | Output SHA-256 | Raw SHA-256 | Self SHA-256 |
|---|---|---|---|---|---|
| `01-anthropic.json` | `anthropic/claude-opus-4-8` | 3 / `b53协议精确审查-OpusA` | `874a425b2a16f1a9bffcd1c40bd2d69fa056b51639e4ce56ca0790a786350ae5` | `f6f258c404b57703bc9e04e7aa34a61e5c22f37501a31b0ee97fba488b211f68` | `861a1c5754c3445600feaf5aae2cceb4e63026c79e6b30ac6dec2979bd07b436` |
| `02-deepseek.json` | `openai/gpt-5.6-sol` | 0 / `b53协议精确审查-OpenAI` | `81f132d4bfa4c36f432ab4c2355b1b2d3e8a061818ef5001eeba8dbdc9d72f42` | `b0cd7f17efb87bd3c3584999fce0e3ab464dd6e4ebce79e7db26f7e6c1b9e252` | `fefb55b8db4be2bcb3a43916f20c6a452426d11a3ea2172d5498763fc2cfff3a` |
| `03-minimax.json` | `openai/gpt-5.5` | 1 / `b53协议精确审查-GPT55` | `95bed094600e3097862ced1b56fe7acf9dac06177635d6421df6c60586477964` | `d0b3e21a4af4cdb77b575d1272b08f5a72257fe31b27ef89a51b84bf24d352e1` | `cde660f5517e650067b723a012ab642fcfb28a12a0c0ef7c24e722754be36088` |
| `04-moonshot.json` | `openai/gpt-5.6-terra` | 2 / `b53协议精确审查-Terra` | `a53a48b883dcd49bf5de01b06d38c764dc77bd337e2c8c5160ec5e1ebc06f529` | `871dc9ad2efa44a68c5f94ad6dc9e64f6790ae957b6162d5b476d9f411b7cbb2` | `5fc2566a879c26237a690bed16de7eb7a5585b89cf0efb76b3a7fafb6a67a6cf` |
| `05-openai.json` | `anthropic/claude-opus-4-8` | 4 / `b53协议精确审查-OpusB` | `18a565410229fd006d1e54f63735adec66548a477200ab0a760588d5b860bb08` | `f7d8e0023477cd3ed218d34980725b5ff275132b47990f7e30982ef06f6a42dd` | `8294bdb432e881de244470c5b14cafa8662bf08064ecefc192ea7e269186b91e` |
| `06-zai.json` | `anthropic/claude-sonnet-5` | 5 / `b53协议精确审查-Sonnet` | `092aa9d6d5822c788866820b5c9e9d598cbb47a51a86e5da6efa7165c688c207` | `e085a35d254db258b5fcd7ace9b1c981d1eff06c367956f23ab2fef5ba53699d` | `021486e9f6b4662091192fe38f3d79a82da92d683c8349542c0a3259718cb68b` |

All eight machine JSON artifacts are UTF-8 `RFC8785-JCS(object) + LF`, with no BOM, CRLF, indentation, or other whitespace. Each self hash omits only its own hash field and excludes the LF; each raw hash covers exact stored bytes including the LF. Plan and dossier contain the same six review raw/self pointers, and every review binds the protocol hash above.

## Preserved historical correction

The earlier Round-3 plan to call the shared random-temp `durableAtomicCreateFile` path directly for the L1 event was superseded after post-write review found unrecoverable SIGKILL windows after shard or random-temp creation. Round 6 replaced that event-target mechanism with the fixed-event, intent-bound, deterministic event-temp S0-S4 protocol. Round 13 does not restore the Round-3 path and does not change shared helpers, the P1b writer, scanner, registry, schemas, package metadata, runtime roots, or existing tests.

Round 13 replaces only the lock protocol and the named bootstrap/recovery/evidence semantics. The Round-6 protocol hash `d10c0e2394fc01d89aaf739230d4774f3e141efb6201e4a7ad722d78817f05d2` remains historical evidence, not the current authorization target.

## Frozen event identity

The proposition statement remains exactly `New feature and capability acceptance MUST use real production data; synthetic data, handwritten fixtures, and waiting for low-frequency natural events are insufficient as sole acceptance evidence. When compliance, privacy, or security prevents direct production access, equivalent evidence must be explicitly documented and human-approved.` It is 340 UTF-8 bytes with SHA-256 `6a25beb3a45141409c139b9832068f3b23b98cd21134cfed07f34c4feeffc262`.

The frozen envelope remains `proposition-evidence-envelope/v1`; its body remains `proposition-evidence-event/v1`; event type remains `proposition_observed`. Producer remains `pi-astack.proposition-production-evidence-writer` at gate-specific version `adr0040-real-policy-proposition-append-writer/v1`. The proposition tuple, facets, epoch, trigger, transcript coordinate, lineage, and all other fields remain byte-identical to Round 6.

Body hash and event ID remain `1c8cc5d23110f44affb574598e65027ac350373b86c651c4ed1354ad171685a6`. Canonical envelope file bytes remain 1,868 bytes including one terminal LF, raw SHA-256 `0fe6ded4012423cbebcf618341d68a57a459dd010e2fa56f6ced0a1a311eeb2e`. The target remains `/home/worker/.abrain/l1/events/sha256/1c/8c/1c8cc5d23110f44affb574598e65027ac350373b86c651c4ed1354ad171685a6.json`. The read-only Round-13 observation found the `8c` shard and target absent.

The trusted source remains session `019f569c-40d3-73f0-9a5f-666b395f6b9a`, message `f2774365`, parent `0f250dbd`, line 379, timestamp `2026-07-14T14:09:06.838Z`, text SHA-256 `32bde2472f817e5532959842f602100fcc4cc3a17d517cc6f49edd73db097b3f`, and prefix SHA-256 `d53cb0e73b1271c3c4cb89d2b833a9b7d67dd9e1b93af0fc30051494a1bf3335` over 5,092,479 bytes. This is the original user design-authorization transcript provenance; it remains separate from the review-dispatch provenance above and is not rewritten as reviewer authorization.

## Three separately authorized stages

Stage 1 is this design-only package, real read-only observation, canonical plan/dossier, and six transcript-observed final exact full-protocol Round-13 reviews. It creates no `.abrain` state and grants no later authority.

Stage 2 requires a fresh exact `role=user` authorization binding the plan raw/self, all six review raw/self values, and the original eight create-only paths. It may create only:

1. `extensions/_shared/proposition-real-policy-append-writer.ts`
2. `extensions/_shared/proposition-real-policy-append-transcript.ts`
3. `extensions/_shared/proposition-real-policy-append-production-preview.ts`
4. `extensions/_shared/proposition-real-policy-append-production-execute.ts`
5. `scripts/dossier-proposition-real-policy-append-production-preview.mjs`
6. `scripts/execute-proposition-real-policy-append-evidence.mjs`
7. `scripts/smoke-proposition-real-policy-append.mjs`
8. `docs/evidence/2026-07-14-adr0040-real-policy-proposition-append-execution-ready-preview-dossier.json`

Stage 2 modifies no existing path and does not change `package.json`. Acceptance must run against real production data on the real production ZFS filesystem. It must verify the actual Node, procfs dirfd surface, pinned `/usr/bin/flock`, loader/DSO closure, JCS implementation, effective bwrap closure, filesystem durability behavior, and same-OFD flock lifetime. If any required surface is unsupported, Stage 2 fails, emits no authorization text, and has no fallback to another filesystem, synthetic fixture, handwritten evidence, or reduced acceptance.

Stage 3 requires a still later fresh exact `role=user` authorization binding the complete Stage-2 source closure, execution-ready dossier, fixed tuple, transcript evidence, confinement, ratification, intent, output paths, and terminal/transient mutation protocol. Authority never carries between stages.

## Exact Stage 2 authorization text

The following block is the complete text to send unchanged as a fresh `role=user` message:

```text
I authorize only ADR0040 real-policy-proposition-append Stage 2: implement and execute the execution-ready read-only preview defined by the exact design package below. This authorization does not authorize Stage 3 or any production append.

This authorization binds these exact immutable inputs:
- plan: `docs/evidence/adr0040-real-policy-proposition-append-design/append-authorization-plan.json`, raw SHA-256 `06a2915ecf88022e861295f9e844ae96b2ea3543b544e44ebe7426ac54d609a5`, self SHA-256 `1505659abc5a6ea56aa5c45bb5140b6ed8433a24e9d7410d34c0411042019478`
- dossier: `docs/evidence/2026-07-14-adr0040-real-policy-proposition-append-read-only-preview-dossier.json`, raw SHA-256 `08cd956a1ba382c239ecd447159e510e8597a0d7cb6a0fd9dd4a2d4de7b347d9`, self SHA-256 `c6a1d9ae759b282b110ae55a9c6bc0fc65bf63c4d172ca62c20d1a3cc4b34ec1`
- Round-13 protocol SHA-256: `b53bc2692fc65f478301597756217a097bb2b2627a74c4c3ef5cd82ef1684a76`
- review 1: `docs/evidence/adr0040-real-policy-proposition-append-design/reviews/01-anthropic.json`, raw SHA-256 `f6f258c404b57703bc9e04e7aa34a61e5c22f37501a31b0ee97fba488b211f68`, self SHA-256 `861a1c5754c3445600feaf5aae2cceb4e63026c79e6b30ac6dec2979bd07b436`
- review 2: `docs/evidence/adr0040-real-policy-proposition-append-design/reviews/02-deepseek.json`, raw SHA-256 `b0cd7f17efb87bd3c3584999fce0e3ab464dd6e4ebce79e7db26f7e6c1b9e252`, self SHA-256 `fefb55b8db4be2bcb3a43916f20c6a452426d11a3ea2172d5498763fc2cfff3a`
- review 3: `docs/evidence/adr0040-real-policy-proposition-append-design/reviews/03-minimax.json`, raw SHA-256 `d0b3e21a4af4cdb77b575d1272b08f5a72257fe31b27ef89a51b84bf24d352e1`, self SHA-256 `cde660f5517e650067b723a012ab642fcfb28a12a0c0ef7c24e722754be36088`
- review 4: `docs/evidence/adr0040-real-policy-proposition-append-design/reviews/04-moonshot.json`, raw SHA-256 `871dc9ad2efa44a68c5f94ad6dc9e64f6790ae957b6162d5b476d9f411b7cbb2`, self SHA-256 `5fc2566a879c26237a690bed16de7eb7a5585b89cf0efb76b3a7fafb6a67a6cf`
- review 5: `docs/evidence/adr0040-real-policy-proposition-append-design/reviews/05-openai.json`, raw SHA-256 `f7d8e0023477cd3ed218d34980725b5ff275132b47990f7e30982ef06f6a42dd`, self SHA-256 `8294bdb432e881de244470c5b14cafa8662bf08064ecefc192ea7e269186b91e`
- review 6: `docs/evidence/adr0040-real-policy-proposition-append-design/reviews/06-zai.json`, raw SHA-256 `e085a35d254db258b5fcd7ace9b1c981d1eff06c367956f23ab2fef5ba53699d`, self SHA-256 `021486e9f6b4662091192fe38f3d79a82da92d683c8349542c0a3259718cb68b`

Stage 2 may create only these eight paths, all of which must be absent before creation:
1. `extensions/_shared/proposition-real-policy-append-writer.ts`
2. `extensions/_shared/proposition-real-policy-append-transcript.ts`
3. `extensions/_shared/proposition-real-policy-append-production-preview.ts`
4. `extensions/_shared/proposition-real-policy-append-production-execute.ts`
5. `scripts/dossier-proposition-real-policy-append-production-preview.mjs`
6. `scripts/execute-proposition-real-policy-append-evidence.mjs`
7. `scripts/smoke-proposition-real-policy-append.mjs`
8. `docs/evidence/2026-07-14-adr0040-real-policy-proposition-append-execution-ready-preview-dossier.json`

Use real production data on the real production ZFS filesystem. Both are mandatory. There is no fallback to another filesystem, synthetic data, handwritten fixtures/evidence, reduced acceptance, or any substitute environment. If a required production, ZFS, Node, procfs-dirfd, pinned `/usr/bin/flock`, loader/DSO, JCS, effective-bubblewrap, filesystem-durability, hardlink, fsync, BUSY, or same-OFD lock-lifetime proof is unsupported or fails, Stage 2 must fail closed and emit no Stage 3 authorization text.

All existing paths are read-only. Create only the eight paths listed above and modify no existing path. In particular, do not modify `package.json`, any package metadata, schema, registry, existing shared helper, existing source, existing script, existing test, or existing documentation/evidence file.

Stage 2 is limited to implementing and executing the execution-ready read-only preview. It must not mutate any path under `/home/worker/.abrain`; create any Stage-3 repository output, including `docs/evidence/2026-07-14-adr0040-real-policy-proposition-append-production-ratification-record.json`, `docs/evidence/adr0040-real-policy-proposition-append-execution-intent-1c8cc5d23110f44a.json`, or `docs/evidence/2026-07-14-adr0040-real-policy-proposition-append-production-post-execute-dossier.json`; append the proposition event; perform P2a CAS advance; perform P2b publication or selection; change any runtime consumer or read mode; perform any runtime/read flip; or commit, push, or restart.

After Stage 2 completes, stop. Report the exact paths, byte lengths, raw SHA-256 values, self SHA-256 values where applicable, the complete Stage-2 source-closure hash, and the execution-ready preview result. Confirm that all pre-existing paths and `/home/worker/.abrain` remained unchanged and that no Stage-3 output exists. Then require another fresh exact `role=user` Stage 3 authorization that binds the completed Stage-2 source closure and execution-ready dossier; do not infer, generate, or exercise Stage 3 authority from this message.
```

## Official executor and kernel lock

There is one official Node Stage-3 executor inside verified confinement. It opens the existing repository evidence directory and every required ancestor with `O_DIRECTORY|O_NOFOLLOW`, verifies the FD identities and chain, and performs all repository creates relative to the retained verified dirfd through the Stage-2-proven procfs dirfd surface. The only `.abrain` write surface is the exact event S0-S4 FSM.

The executor locks the retained evidence-directory open file description, not a lock file. It maps that same OFD to child fd 3 and executes the pinned, already verified `/usr/bin/flock -xn 3` closure with scrubbed environment and cwd. Only fd 3 and minimum verified stdio/null descriptors are inherited; subsequent children do not inherit the OFD by default.

Child status 0 with no signal means acquired. Parent Node retains the same OFD so the lock remains held after `flock` exits. Child status 1 with no signal means `BUSY`; a BUSY contender performs no target, authorization, stable-anchor, transcript, or dossier checks. Every other status, signal, spawn error, identity mismatch, loader/DSO anomaly, procfs anomaly, or syscall anomaly is a hard failure. Parent close or holder `SIGKILL` releases the OFD lock.

There is no lock file, PID, mtime, token, stale recovery, dead-owner recovery, token mismatch handling, or lock cleanup. `flock` coordinates official executors only; it is not claimed to exclude foreign writers.

## Repo-evidence publication

The Stage-3 repository outputs remain exactly:

- ratification: `docs/evidence/2026-07-14-adr0040-real-policy-proposition-append-production-ratification-record.json`
- intent: `docs/evidence/adr0040-real-policy-proposition-append-execution-intent-1c8cc5d23110f44a.json`
- terminal post dossier: `docs/evidence/2026-07-14-adr0040-real-policy-proposition-append-production-post-execute-dossier.json`

All three are handled under the same kernel lock. Each expected artifact derives a deterministic same-directory temp from its content raw SHA-256. The executor creates that temp relative to the verified evidence dirfd with `O_CREAT|O_EXCL|O_NOFOLLOW`, mode `0600`; verifies owner, mode, device, inode, type, and `nlink`; writes and reads back exact bytes; fsyncs the file; hardlinks temp to final without replacement; verifies shared device/inode and `nlink==2`; fsyncs the parent; unlinks only the recognized temp; fsyncs the parent again; requires final `nlink==1`; then refsyncs and exactly reads back final and parent state. Any syscall or identity anomaly aborts.

Recovery accepts only three exact shapes. Final absent plus the sole deterministic recognized temp requires a no-follow regular executor-owned mode-`0600` temp at `nlink==1`; it is unlinked, parent-fsynced, proved absent, and recreated fresh. Final plus temp may be cleaned only when both names have the same device/inode, each has `nlink==2`, and exact expected bytes/owner/mode/type; cleanup then requires parent fsync and final `nlink==1`. Exact final alone requires self-valid exact bytes and `nlink==1`. Every other final/temp shape fails closed without overwrite or foreign cleanup.

## Single terminal post path

The post path carries exactly one mutually exclusive terminal artifact: `COMPLETE` or `target_durable_evidence_incomplete`. They can never overwrite one another.

Classification is target-first. After target classification, terminal precedence is:

1. Exact self-valid `COMPLETE`: verify and return identical. It statically binds exact ratification, intent, fixed target tuple, and the recorded clean S4 observation. Later live drift cannot retroactively change it.
2. Exact self-valid `target_durable_evidence_incomplete`: return terminal incomplete. It statically binds exact ratification, intent, attempted tuple/target, and the completed-check observed-drift basis. Later live drift cannot retroactively change it.
3. Post absent: perform current checks and no-replace create the exact applicable terminal artifact.
4. Malformed, foreign, byte-different, or differently bound post: hard fail without replacement or cleanup.

An incomplete artifact may claim only drift actually observed by a completed check in that run. It does not claim transient drift that reverted before a completed check, drift between checks, post-S4 drift, or any drift not durably observed before `SIGKILL`.

## Bootstrap checks

The original I0 shape remains: final ratification, absent intent, exact genesis-plus-`beee...` proposition prestate, absent `8c`, event temp and target, and absent later outputs. Only I0 may create intent; exact self-valid prior intent may be reused only by recovery.

Before intent, C0a and C0b require exact equality of the closed stable anchors already enumerated by Round 6: proposition event coordinates/bytes/counts and selected/foldable zero; target/ancestor/first-shard state; registry/schema/generic-gate bytes; P2a bundle/latest/inventory; P2b.1 plan/dossier/status/destination/reachability; verified implementation/executable/loader/DSO/JCS/bwrap/procfs/flock/package/runtime/source closure; protected stable surfaces; and initial Stage-3 authorization coordinate/bytes/prefix/chain. Event and evidence ancestor chains reject symlinks.

A whole-abrain no-follow raw inventory remains evidence, not a gate. Regular-file rows include raw byte hashes; existing symlinks are recorded with `lstat` and `readlink` and are never followed. The Round-13 C0a/C0b evidence inventory hash is `10a239adf1c4cbded96592a84c0174ae6012361259047f09cc32e1f7a496c834`; both existing symlinks and their link text are in the dossier.

Intent embeds C0. After durable intent, C1 rechecks every stable anchor and requires the initial Stage-3 authorization to remain exact, latest, and fresh. Ccommit repeats the same checks immediately before `link(event-temp,target)`. If a completed pre-link check actually observes drift, the executor does not append.

## Recovery checks

Recovery first acquires the same kernel lock, validates exact ratification and intent, and then classifies target first as absent, exact durable, or foreign. It applies any existing terminal post precedence before checking stable anchors and recovery authorization.

Recovery C1, Ccommit, and S4 require the recorded authorization coordinate, exact bytes, prefix, and continuous parent chain to remain intact, and require the transcript suffix to be append-only. They do not require latest-user or time freshness. This exception is only for recovery of the already authorized attempted tuple; initial bootstrap still requires exact/latest/fresh authorization.

Target absent plus a completed check observing drift means no append and failure. Because no target is durable, it does not create `target_durable_evidence_incomplete`. Exact durable target plus observed drift and absent post creates terminal incomplete. Exact durable target plus no observed drift may create COMPLETE after clean S4. A foreign target always hard-fails. Existing post artifacts always follow terminal precedence.

S4 incomplete evidence is bounded to drift actually observed by this run's completed check. No claim is made for reverted transient drift, between-check drift, post-S4 drift, or facts not durably observed before process death. Cancellation and remediation require separate authorization.

## Retained event S0-S4 protocol

The event temp remains `.${event_id}.json.0.0.${intent_hash.slice(0,16)}.tmp`, private to the fixed-event writer and compatible with the frozen scanner grammar. It is distinct from repo-evidence content-hash temps.

Classification checks target first. S0 is absent `8c`/temp/target and may create only retained `8c` mode `0700`, then fsync `1c`. S1 is exact empty retained `8c`. S2 is target absent plus the sole exact recognized event temp; under valid intent and kernel lock, the temp is never adopted, is unlinked and fsynced, then recreated fresh. S3 is exact target plus exact same-inode event temp, both `nlink==2` and byte-identical; it removes only temp, fsyncs, requires target `nlink==1`, and continues to S4. S4 is target-only exact bytes, owner, mode `0600`, and `nlink==1`, followed by file/directory fsync, exact readback/restat, poststate/protected checks, and terminal post handling.

Every open/stat/read/write/chmod/link/unlink/fsync anomaly fails closed. The scanner remains unchanged; no shard is deleted; no foreign bytes are cleaned. R6 event SIGKILL boundaries, scanner adversarial cases, no-shard-deletion rule, and mutation accounting remain required. A BUSY contender does no checks, while a later uncontended exact run may converge and return identical.

The only terminal `.abrain` additions remain `l1/events/sha256/1c/8c` and the fixed target. The event temp is an authorized transient create/remove and must be absent at S4. The existing `1c` directory is never replaced, deleted, chmodded, chowned, or redirected; only its expected mtime/ctime and retained-child link-count effect may change.

## Threat and reversal boundaries

Advisory `flock` protects cooperation among official executors. Foreign mutation is handled by no-replace publication, exact inode/link identity, ancestor checks, stable-anchor checks, and exact-byte validation. The official executor cannot replace or damage foreign final/temp/event bytes and fails closed on any unrecognized shape.

After event durability, physical deletion, rewrite, replacement, or rollback is forbidden. Semantic reversal requires a separately designed, reviewed, and authorized lifecycle append. Remediation and cancellation are also separate authorization surfaces.

## Preserved downstream boundaries

The future writer accepts no caller-supplied tuple fields and only the exact production prestate genesis plus `beee43be3ca23c25c77981349cb378a91948d84f6ca92cc5777d066514651585`. Generic preflight remains `L1_SCHEMA_WRITE_DISABLED`; registry bytes remain unchanged; selected/foldable remain zero. No Knowledge shadow, P2a, or P2b artifact is published or advanced by this append design.

The disposable prediction remains informational only: a separately authorized later Knowledge projection would contain two cards, and a separately authorized later policy projection would contain one included candidate plus the existing `beee...` exclusion and diagnostic. Predicted bundle hashes are not append conditions. P2b remains blocked, unpublished, unselected, and runtime-unreachable.
