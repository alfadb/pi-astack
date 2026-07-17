---
doc_type: design-note
status: completed-repo-sandbox-read-only-preview-no-publication
---

# ADR0040 P2b.1 stable-view compiler design

## Decision status

Four T0 design rounds converged on a final six-vendor unanimous `SIGN` from OpenAI, Anthropic, DeepSeek, Moonshot, MiniMax, and Z.ai. A later exact authorization implemented only the six-path repo/sandbox compiler substrate and executed the real read-only empty-source preview. It did not authorize a production write, publication, a runtime consumer, or a read flip.

P2b overall remains `blocked / separate_authorization_required`. P2b.1 is completed only as the repo/sandbox compiler substrate and a real read-only empty-source preview. TTL, age/stale semantics, cross-source compatibility, LKG selection or promotion, and rollback state semantics are deferred to a separately authorized future P2b selection/LKG gate. Because P2b.1 publishes nothing, its rollback operation is a no-op, not deployment rollback evidence.

The canonical implementation plan is [implementation-authorization-plan.json](../evidence/adr0040-p2b1-stable-view-design/implementation-authorization-plan.json), raw/self SHA-256 `44df57357ff0e32602a08171fb57d73872f8ef43a6df08d5d3369cfe28921ca5` / `b985654d88783e39f5d07d35fa42a5bfcf892eb7dcaa07eaa2314b623be07ce0`. The completed [read-only preview dossier](../evidence/2026-07-14-adr0040-p2b1-production-read-only-preview-dossier.json) has raw/self SHA-256 `2d9d1cf3913aac68b7bc5c463577e9dfc1861196b805bb2058c352e29e722c71` / `dd58e8aef05f97dd6c9f0b491ee19ba97a0d9cc803c9a091e2d0c2593245520b`; it records `ready_empty`, zero items, zero injectable bytes, exact P2a inventory preservation, whole-abrain equality, sandbox cleanup, and runtime unreachability.

## Bound current state

The only real input is the validated, inert P2a production bundle `dfa3e81fce150bacf635a446d20055f96bc39df368f2c02d99c13342cdcaa5a0`. It contains exactly zero candidate entries, one statement-free exclusion, and one matching statement-free diagnostic. The exclusion and diagnostic both bind source event `beee43be3ca23c25c77981349cb378a91948d84f6ca92cc5777d066514651585`, stage `policy_hint`, and reason `consumer_hints_policy_false`.

The corrected P2a [post-execution dossier](../evidence/2026-07-14-adr0040-p2a2-production-post-execution-dossier.json) has raw/self SHA-256 `8deffe753352e18296ac4b53b417f1f1300389a0f1e001f36e46a192d0e7f0a7` / `3ee5e8b668ad60d12137429e35abfb7ea1a6a524033011c4f7d90020d1fc3515`. Its target inventory is `ee29acf5f4fc106156999f6685baf407eaf1aa523e6d2f5a292de3d4be4edb4d`, runtime consumer is false, and the bundle remains inert.

## Compiler contract

The new family is `proposition-policy-stable-view/v1`. It is non-authoritative, repo/sandbox-only, disjoint from ADR0039, and reproducible from a validated P2a bundle, a content-addressed compile profile, and either the exact empty-source sentinel or a sandbox-only synthetic fixture decision.

The compile identity is:

```text
compile_key = sha256(RFC8785-JCS({
  source_bundle_hash,
  compile_profile_hash,
  accepted_decision_hash_or_empty_sentinel
}))
```

Request IDs, nonces, timestamps, mtimes, and observation state never enter artifact identity. On the real empty source, any supplied decision is rejected as `unexpected_decision_for_empty`, and the exact sentinel `empty-source/no-decision/v1` is used. A real nonempty source without a future accepted production decision is queued and emits no stable artifact. P2b.1 does not define or activate a production decision schema.

The compile profile may contain only deterministic renderer, scope, budget, and state-policy rules. It recursively forbids injection decisions, including `injectMode`, always/listed/omitted eligibility, priority, selection, LKG, TTL/staleness, rollback, runtime consumer, and production placement fields. It cannot mechanically infer always/listed injection from proposition facets.

A successful compile emits all five artifacts or none: `view.json`, `view.md`, `diagnostics.json`, `parity.json`, and `manifest.json`. `view.md` is rendered only from `view.json`. Statements may occur only in `view.json` items and their deterministic `view.md` rendering; diagnostics, parity, manifest, receipts, observation envelopes, and the preview dossier are statement-free. `ready_empty` has zero items, exactly zero injectable UTF-8 bytes, and no default, no-op, or placeholder rule.

Every input source event has exactly one disposition: included, merged, or excluded. Included/merged lineage occurs exactly once. Exclusions preserve source ID, stage, and reason without statement text. Diagnostics are conserved separately and cannot create a second disposition. Parity covers only source conservation, deterministic rendering, scope/lineage, and noninterference; it has no legacy or constraint-shadow semantic fields.

## Observation contract

Immutable request and outcome receipts are separate from the observation-time envelope. P2b.1 permits exactly four tuples:

| Condition | pipeline | freshness | selection | health |
|---|---|---|---|---|
| no request | `idle` | `unknown` | `none` | `blocked` |
| real empty success | `completed` | `fresh` | `current` | `ok` |
| real nonempty, no production decision | `queued` | `unknown` | `none` | `blocked` |
| rejected request | `rejected` | `unknown` | `none` | `blocked` |

`fresh` means completed for the exact current request, not TTL freshness. `current` means the artifact was produced for that exact request, including an empty artifact; it conveys no injection or runtime authority. Health is derived: only the exact completed/fresh/current tuple is `ok`; every other legal tuple is `blocked`.

`fixture-decision-set/v1` is allowed only for nonempty synthetic sandbox tests, carries `fixture_synthetic=true`, uses a namespace byte-incompatible with any future production decision, and can never enter or satisfy the real preview path.

## Preview and gates

The real preview must use no-follow, identity-verified opened file descriptors for the P2a pointer and artifacts, execute in effective bubblewrap confinement with the repository and abrain read-only, a temporary directory as the only writable surface, no network, no provider credentials, and no unconstrained fallback. It must remove the temporary output, persist only a self-hashed repo dossier, prove protected-state equality and P2a latest identity before/after, prove no P2b target or runtime reachability, and never import, resolve, open, or parse ADR0039 content. A generic opaque protected snapshot may prove noninterference without semantic content access.

Future gates remain ordered and independently authorized: real policy proposition append; P2a multi-bundle CAS advance; accepted L1 projection decision schema/event plus adapter; nonempty deterministic preview; inert P2b publication; P2b selection/LKG promotion; each P3 consumer; P4 retirement. For the [real policy proposition append design](./2026-07-14-adr0040-real-policy-proposition-append-design.md), Round 6 is only the historical six-vendor architecture milestone. The current Round 13 package supersedes the Round 6 PID/mtime/token lock and terminal semantics and was accepted by six isolated review contexts from two actual providers (3 Anthropic + 3 OpenAI); no Round 13 participation is claimed for DeepSeek, MiniMax, Moonshot, or Z.ai. Its implementation and append remain unauthorized. No gate carries authority into the next.
