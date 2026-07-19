---
doc_type: execution-ready-note
status: blocked-separate-authorization-required
revision: R4
---

# ADR0040 D3-v2 session_start R4 execution-ready

R4 implements the bind-existing-only S2 production create/bind operator and exact runtime receipt gate. It does not activate the consumer in this repository state.

The production CLI defaults to a read-only preview. Its only mutating routes are fixed `--execute` and `--continue`; both derive authority from the trusted bound session transcript and accept no path, authorization payload, raw text, force, or yes option. The committed preview records protected production equality and no settings, session, activation, intent, receipt, audit, or rollback write.

The R4 source closure includes the adapter/control/runtime wiring, activation and rollback validators, retained-parent-FD/OFD helpers, duplicate-key parser, trusted transcript verifier, create-only publisher, schema, package commands, generator, dossier builder, production CLI, and focused smoke. The R3.9 predecessor manifest/dossier/note remain immutable historical evidence.

Evidence:

- `docs/evidence/2026-07-19-adr0040-d3-v2-session-start-r4-operator-manifest.json`
- `docs/evidence/2026-07-19-adr0040-d3-v2-session-start-r4-execution-ready-dossier.json`
- `docs/evidence/2026-07-19-adr0040-d3-v2-session-start-r4-production-read-only-preview.json`
- `scripts/smoke-proposition-lifecycle-freshness-d3-v2-session-start-r4.mjs`

Recovery is operator-continue-only and requires a new exact transcript coordinate. Production rollback remains separately triple-authorized and is not called or pre-authorized. Lightweight disable and heavyweight session quarantine remain distinct operations.

`proposition.adr0040-p3-d3-v2-session-start` and aggregate P3 remain `blocked / separate_authorization_required`. Current status is explicitly **S2 NOT_AUTHORIZED**.
