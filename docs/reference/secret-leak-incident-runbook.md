---
doc_type: reference
status: active
---

# Secret Leak Incident Runbook

Use this when a raw credential, token, private key, connection string, or other secret may have entered the abrain git history or a remote.

1. Stop push and sync activity immediately.
   Set `PI_ABRAIN_NO_AUTOSYNC=1` for running pi sessions, avoid `/abrain sync`, and do not run `git push` from the affected abrain repo.

2. Rotate the credential at its authority.
   Treat the leaked value as compromised even if it was later removed from the working tree. Revoke or rotate API keys, passwords, SSH keys, OAuth tokens, database URLs, webhook secrets, and any derived credentials.

3. Identify the affected repository and range.
   Inspect the abrain repo locally and any remote mirrors to find the earliest commit containing the secret and every branch/tag/ref that can still reach it.

4. Rewrite git history.
   Use a purpose-built history rewrite tool such as `git filter-repo` or BFG Repo-Cleaner to remove the secret from every reachable commit. Plain file deletion, archive, soft delete, or hard delete of the current file is not sufficient because git history still contains the value.

5. Handle remotes and clones.
   Force-push rewritten refs only after rotation is complete and collaborators/devices are coordinated. Delete or rewrite remote branches/tags that still contain the value. Re-clone or aggressively clean local clones, caches, CI artifacts, and backups where feasible.

6. Restore normal sync.
   Run the ADR0039 reconcile/pre-push gate, confirm no dirty L2 or stale projection remains, then re-enable auto-sync.

Full privacy and retention boundaries for abrain will be covered by a pending ADR.
