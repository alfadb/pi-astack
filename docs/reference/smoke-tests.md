# Smoke Tests Reference

`package.json#scripts` 是 smoke test live truth。本文只是便于阅读的镜像；修改脚本时请同步本文。

## Current scripts（2026-05-20, 26 total）

| npm script | File | Coverage |
|---|---|---|
| `smoke:memory` | `scripts/smoke-memory-sediment.mjs` | memory facade + sediment integration regressions, including credential typed-redaction boundary (pre-LLM, audit, writer, `memory_search` query) |
| `smoke:dispatch` | `scripts/smoke-dispatch-input-compat.mjs` | dispatch input compatibility |
| `smoke:dispatch-output-format` | `scripts/smoke-dispatch-output-format.mjs` | dispatch sub-agent output formatting (no 500-char truncation) |
| `smoke:fallback-timing` | `scripts/smoke-model-fallback-mutation-timing.mjs` | model-fallback mutation timing |
| `smoke:vision` | `scripts/smoke-vision.mjs` | vision tool registration/schema/basic path |
| `smoke:imagine` | `scripts/smoke-imagine.mjs` | imagine tool registration/schema/output path |
| `smoke:paths` | `scripts/smoke-pi-astack-paths.mjs` | runtime path helpers |
| `smoke:vault-subpi-isolation` | `scripts/smoke-vault-subpi-isolation.mjs` | sub-pi `PI_ABRAIN_DISABLED` isolation |
| `smoke:abrain` | `scripts/smoke-abrain-backend-detect.mjs` | vault backend detection |
| `smoke:abrain-bootstrap` | `scripts/smoke-abrain-bootstrap.mjs` | vault bootstrap |
| `smoke:abrain-git-sync` | `scripts/smoke-abrain-git-sync.mjs` | abrain git auto-sync (ADR 0020) |
| `smoke:abrain-vault-writer` | `scripts/smoke-abrain-vault-writer.mjs` | vault write/encrypt path |
| `smoke:abrain-vault-reader` | `scripts/smoke-abrain-vault-reader.mjs` | vault read/release path |
| `smoke:abrain-vault-bash` | `scripts/smoke-abrain-vault-bash.mjs` | bash injection/output handling + ADR 0022 batch C grep anchors |
| `smoke:abrain-vault-grant-isolation` | `scripts/smoke-abrain-vault-grant-isolation.mjs` | stage-index INV-E grant cross-key isolation E2E + ui_path stamp + fail-closed envelope + handler E2E (ADR 0022 batch A subgroup 2) |
| `smoke:abrain-vault-identity` | `scripts/smoke-abrain-vault-identity.mjs` | vault file identity / placeholder format |
| `smoke:abrain-active-project` | `scripts/smoke-abrain-active-project.mjs` | strict active project binding |
| `smoke:abrain-secret-scope` | `scripts/smoke-abrain-secret-scope.mjs` | project/global secret scope behavior |
| `smoke:abrain-i18n` | `scripts/smoke-abrain-i18n.mjs` | abrain i18n strings |
| `smoke:abrain-redact` | `scripts/smoke-abrain-redact.mjs` | abrain redactor unit coverage |
| `smoke:compaction-tuner-prompt-user` | `scripts/smoke-compaction-tuner-prompt-user.mjs` | INV-K compaction-defer hook (`__abrainPromptUserGetPending`) |
| `smoke:prompt-user` | `scripts/smoke-prompt-user.mjs` | prompt_user manager + secret redaction + INV-A/B/C/D contracts |
| `smoke:prompt-user-finalizer` | `scripts/smoke-prompt-user-finalizer.mjs` | R8 P1#1: dialog teardown / disposer / __wipeSecrets |
| `smoke:prompt-user-option-list` | `scripts/smoke-prompt-user-option-list.mjs` | PromptDialog real-render vault & question variants |
| `smoke:prompt-user-subpi` | `scripts/smoke-prompt-user-subpi.mjs` | sub-pi prompt_user disabled |
| `smoke:persistent-input-history` | `scripts/smoke-persistent-input-history.mjs` | persistent-input-history SDK-drift defense: capability probe (`addToHistory`) + semver gate (0.75.x–0.99.x) + `FORCE_DISABLED` env escape + degraded-mode notify on missing `Editor.history` field + replay-matcher no-double-feed (27 assertion, 4 negative tests verified) |

## Recommended subsets

```bash
npm run smoke:memory
npm run smoke:dispatch
npm run smoke:abrain-active-project
npm run smoke:abrain-vault-reader
npm run smoke:abrain-vault-bash
npm run smoke:vision
npm run smoke:imagine
```

For doc-only changes, run at least `npm run smoke:paths` if paths/runtime references were touched. For memory/sediment/vault changes, run the relevant subset above plus any command-specific smoke. For sanitizer or sediment secret-boundary changes, run `npm run smoke:memory` because it covers typed placeholders, prompt redaction, audit raw_text/error redaction, trigger phrase sanitization, and `memory_search` query redaction.

## Historical note

Older audit docs listed “15 smoke” but mixed npm aliases with file names and omitted `vision`/`imagine`. Treat audit lists as snapshots, not live reference.
