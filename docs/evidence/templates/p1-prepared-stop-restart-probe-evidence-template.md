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
- Active recovery scan/fold SHA-256:

## Controlled stop

- Writer publication status/reason/localCommit:
- Episode ID / slot / candidate:
- Candidate shape verification:
- HEAD unchanged:
- Shared index unchanged:
- Original writer cohort and unrelated worktree bytes unchanged:
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
