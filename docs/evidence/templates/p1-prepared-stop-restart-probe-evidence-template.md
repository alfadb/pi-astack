---
doc_type: evidence_template
status: blank_not_production_evidence
criterion: LOCAL-RUNTIME-RESTART
---

# P1 Prepared-Stop Restart Probe Evidence Template

This blank template is not evidence and must not change any acceptance checkbox.

## Authorization and arm

- User authorization anchor:
- Operator/time UTC:
- `runId`:
- `boundary` (must be `commit_prepared`):
- `expectedHead`:
- `expiresAtUtc`:
- Exact env SHA-256 (do not persist the env value):
- Steady-state startup-ready observation:

## Before trigger

- Symbolic HEAD ref/OID:
- Shared index SHA-256:
- NUL status SHA-256:
- Original writer cohort path/bytes manifest SHA-256:
- Pending replay staging path/bytes/attempt fields manifest SHA-256:
- Whole canonical L1/L2 plus staging fingerprint SHA-256:
- Active recovery scan/fold SHA-256:

## Controlled stop

- Writer publication status/reason/localCommit:
- Episode ID / slot / candidate:
- Candidate shape verification:
- Triggering Knowledge `sediment:auto_write:*` source event ID:
- Cohort exclusivity (trigger transaction + allowed canonical recovery metadata only):
- Replay/staging/foreign trigger evidence absent:
- HEAD unchanged:
- Shared index unchanged:
- Original writer cohort and unrelated worktree bytes unchanged:
- Pending replay staging files byte-identical:
- Pending replay `retry_attempts`/writer-attempt fields unchanged:
- Post-stop second `agent_end` canonical+staging fingerprint unchanged:
- Exact claim + prepared event IDs/body hashes:
- Published/converged/abort/terminal absent:
- Candidate not contained by symbolic ref:
- New slot absent:
- Env unset attestation:

## Fresh restart

- Fresh process identity/start time:
- Probe env absent attestation:
- Startup status:
- Recovered episode ID / slot / candidate:
- HEAD equals candidate:
- Exact claim/prepared/published/converged event IDs/body hashes:
- Abort/terminal/new slot absent:
- Candidate cohort HEAD/index/worktree exact manifest SHA-256:
- Pending staging snapshot unchanged through restart:
- Git argv capture SHA-256:
- Remote argv count (must be zero):
- Device delivery excluded from acceptance:

## Independent review

- Reviewer/model isolation:
- Source/diff review result:
- Evidence integrity result:
- Residual risks:
- Decision (`ACCEPT`/`REJECT`):

## Cleanup gate

- Production probe executed: [ ]
- Evidence independently accepted: [ ]
- Temporary probe code forward-deleted: [ ]
- Temporary smoke/registration removed: [ ]
- Temporary runbook/template removed: [ ]
- Post-deletion regression suite green: [ ]
