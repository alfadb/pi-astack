---
doc_type: design-note
status: production-operator-implemented-not-authorized
revision: R4
---

# ADR0040 D3-v2 session_start S2 create/bind operator R4 design

R4 is the production create/bind operator that follows the immutable R3.9 execution-ready predecessor. It implements the machinery needed for S2, but this repository state does not authorize or execute S2.

## Binding model

The operator is bind-existing-only. It captures one explicit persisted session as exact path, device, inode, prefix byte count, and prefix SHA-256. It never creates, appends, rewrites, renames, or quarantines a session. The target may not already occur in the v1 selector, the v2 prestate selector, or a foreign authorized activation.

The production target is fixed by the committed R4 dossier. Production CLI callers cannot override session, settings, control, audit, rollback, or quarantine paths. Sandbox tests can supply disposable roots through the module API; sandbox mode rejects every hard production path.

## Authorization

Fresh execute and fresh continue each read the trusted persisted session JSONL independently. The shared verifier checks the exact sessions root and file, NOFOLLOW ancestors, file identity before/after read, duplicate IDs, parent-chain membership, header session ID, active branch, exact latest standalone single-text-part `role=user`, transcript prefix, timestamp ordering, and freshness. No caller-supplied authorization JSON, raw text, `--force`, or `--yes` is accepted.

The initial authorization phrase grants the operator permission to derive a closed machine tuple. That tuple binds the target session identity/prefix, D3 six-hash tuple and sequence coordinates, R3.9 predecessor dossier, R4 operator manifest and execution dossier, exact settings pre identity/raw hash and exact post raw hash, desired v2 subtree, all control path derivation rules, source closure, clean source commit, and transcript coordinate. `operation_id` is exactly SHA-256 over RFC8785-JCS of that complete tuple.

Continue requires its own later exact phrase and coordinate. The original authorization cannot be inherited as continue authority. Continue revalidates the original recorded coordinate/prefix and then validates the new coordinate.

## Durable state machine

Final object paths are deterministic single files under the R4 control root:

1. `intents/<operation_id>.json`
2. `activations/<operation_id>.json`
3. `receipts/<operation_id>.json`

Each publication uses a retained parent FD, an `O_EXCL` mode-0600 temp, file fsync, hardlink no-replace publication, parent fsync, exact linked-pair readback, temp removal, second parent fsync, and exact final readback. Fresh execute stops when any target already exists, including byte-identical repetition. Continue validates existing objects and never rewrites them.

The activation is created once as `AUTHORIZED`, `bound`, and executable. There is no `NOT_AUTHORIZED` to `AUTHORIZED` object flip. Its self-hash covers the full object except `activation_object_hash`; it binds operation, intent, D3, session prefix, manifest/dossier/source closure, settings pre/post hashes, audit target, rollback target, and quarantine target.

The commit receipt is an exactly-once durable object, not a message. Its self-hash covers every field except `receipt_hash`. It binds operation, intent, activation, settings pre/post raw hashes and exact post file identity, target session, D3, adapter/operator manifests, predecessor/R4 dossiers, source closure, initial authorization coordinate, completion authorization coordinate, and all resolved control paths.

## Settings CAS

Settings are parsed with an invalid-UTF-8 and duplicate-key rejecting parser. The only legal v2 prestate is key-absent or the exact closed object `{enabled:false,selector:{session_ids:[]}}`. The postimage inserts one unique R4 desired subtree; deleting the v2 key before comparison proves every other setting and the v1 subtree are deep-semantically identical.

The operator holds a retained settings-parent OFD cooperative lock. It binds preimage device, inode, mode, owner, link count, size, mtime, ctime, and raw SHA-256; rechecks that identity immediately before anchored rename; fsyncs the temp and parent; then performs exact post readback. A CAS race can converge only when readback is the exact authorized postimage. A non-cooperative writer can still race between the final recheck and rename because the platform has no file-content compare-and-exchange rename; this residual is recorded explicitly and is not claimed closed.

## Runtime gate and recovery

Disabled or absent R4 settings are inert. For an enabled selected session, before any D3 read the runtime requires exact agreement among settings post, sole intent, sole R4 activation, sole commit receipt, operation ID, all self-hashes, session path/dev/ino/prefix, D3/settings pins, source closure, and settings post file identity. Missing, partial, foreign, replayed, stale, cross-session, or mismatched state yields selected-zero injection with no ADR0039 fallback. A settings-CAS to receipt crash therefore injects zero.

Fresh continue accepts only these states:

- settings pre + exact intent/activation + receipt absent: CAS, then create receipt;
- settings post + exact intent/activation + receipt absent: create receipt only;
- settings post + exact receipt: verify terminal without rewrite;
- settings pre + receipt, or any other combination: halt.

There is no automatic retry.

## Audit and rollback boundary

Operator audit is best-effort and explicitly non-authoritative. A successful operator result means only `bound`; actual injection still requires the later exclusive runtime audit.

R4 does not pre-sign or invoke rollback. Lightweight disable is a separate settings operation that leaves the session in place. Heavy quarantine is the R3.9 rollback sequence with independent triple authorization, session taint, real quarantine rename, and terminal halt. They are not interchangeable.

## Source publication boundary

The execution-ready dossier is generated while the source tree is uncommitted, so it binds the complete source-closure manifest rather than inventing a future commit. Production execute/continue additionally require the published tree to be clean and bind its exact commit into the authorization tuple. The default production preview reports that later commit binding without writing production state.
