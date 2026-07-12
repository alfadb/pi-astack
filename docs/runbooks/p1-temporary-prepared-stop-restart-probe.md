---
doc_type: temporary_runbook
status: prepared_not_executed
---

# P1 Temporary Prepared-Stop Restart Probe

This runbook is temporary. It authorizes one production acceptance probe only. It does not authorize any other production mutation, P2/P3 work, manual recovery event, remote command, commit, or push.

## Fixed contract

The only control input is `PI_ASTACK_P1_RESTART_PROBE`. Its value is exact compact single-line JSON with keys in this order:

```json
{"version":1,"runId":"00000000-0000-4000-8000-000000000001","boundary":"commit_prepared","expectedHead":"0000000000000000000000000000000000000000","expiresAtUtc":"2026-07-12T04:00:00.000Z"}
```

- `version` is exactly `1`.
- `runId` is a fresh canonical lowercase UUID.
- `boundary` is exactly `commit_prepared`.
- `expectedHead` is the exact current `refs/heads/main` OID, lowercase 40 or 64 hex.
- `expiresAtUtc` is canonical UTC with milliseconds, in the future, and no more than 15 minutes from parsing.
- Extra keys, reordered keys, whitespace, duplicate keys, newline, malformed UUID/OID/time, expired values, and longer lifetimes fail closed before runtime mutation.
- The value is process memory only. Do not put it in settings, `.state`, an L1 event, a shell profile, a supervisor configuration, or a service unit.

## Arm

An external shell cannot change `process.env` in an already running pi process. The probe must be inherited by one newly launched armed process. First, from the pi-astack repository, prepare the env while the old process is not performing a writer drain:

```bash
cd /home/worker/.pi/agent/skills/pi-astack

test -z "${PI_ASTACK_P1_RESTART_PROBE+x}"
test "$(git -C /home/worker/.abrain symbolic-ref -q HEAD)" = "refs/heads/main"
EXPECTED_HEAD="$(git -C /home/worker/.abrain rev-parse refs/heads/main)"
RUN_ID="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
EXPIRES_AT_UTC="$(node -e 'process.stdout.write(new Date(Date.now()+10*60*1000).toISOString())')"
export EXPECTED_HEAD RUN_ID EXPIRES_AT_UTC
export PI_ASTACK_P1_RESTART_PROBE="$(node -e 'process.stdout.write(JSON.stringify({version:1,runId:process.env.RUN_ID,boundary:"commit_prepared",expectedHead:process.env.EXPECTED_HEAD,expiresAtUtc:process.env.EXPIRES_AT_UTC}))')"
```

Immediately verify the exact bytes and HEAD gate:

```bash
node -e 'const p=JSON.parse(process.env.PI_ASTACK_P1_RESTART_PROBE); if(JSON.stringify(p)!==process.env.PI_ASTACK_P1_RESTART_PROBE||p.expectedHead!==process.env.EXPECTED_HEAD) process.exit(1); console.log(p)'
test "$(git -C /home/worker/.abrain rev-parse refs/heads/main)" = "$EXPECTED_HEAD"
```

Terminate the old pi process normally, then launch one fresh pi process through the normal local entrypoint from this exact shell. Do not persist the env in a profile, service, or supervisor. The armed process inherits the env, but its `awaitStartup`, recovery, and startup backlog drain never read it. Confirm startup reaches `ready`; only a later normal writer `requestDrain` may read it. If startup is not ready, terminate the armed process, unset the env in the launch shell, and abort acceptance before any manual action.

Do not invoke replay, backlog drain, explicit recovery, or a manual writer operation. Wait for the next real steady-state `sediment:auto_write:*` Knowledge writer cohort in the armed process.

## Prepared stop gate

The armed sediment process captures the strict probe isolation at module load and again at every `agent_end`. While the exact probe is active, the normal Knowledge auto-write lane remains available, but autonomous side schedulers are paused for that turn: Lane R replay, staging resolver/age-out/promotion, archive reactivation, forgetting/status mutation, constraint auto-refresh/follow-up, side L3/embedding maintenance, and related autonomous diagnostic scheduling. Explicit Lane A/G, Tier-1 direct, and rule/status mutation paths benignly defer before mutation. This temporary scheduler list is diagnostic isolation for the one-shot probe; it is not a security boundary.

The first writer publication with `reason=CONTROLLED_STOP_AFTER_PREPARED` sets a process-global immutable `{runId,state:"prepared_stop_reached"}` latch. The current auto-write candidate loop stops immediately, does not run recursive drain/L3/embedding/publication audit, and every later `agent_end` defers all canonical and staging work until process exit. A multi-candidate auto-write batch may therefore process only the first candidate that reaches the prepared boundary.

The writer result must report all of the following in one result:

- `publication.status = durable_pending`
- `publication.reason = CONTROLLED_STOP_AFTER_PREPARED`
- `publication.localCommit = not_published`
- non-empty `publication.episodeId`, integer `publication.slot`, and `publication.candidate`
- current HEAD still equals `EXPECTED_HEAD`
- the exact prepared cohort contains only the one triggering `sediment:auto_write:*` Knowledge writer transaction plus canonical recovery metadata allowed by the existing runtime; no replay/staging/foreign cohort is represented as trigger evidence
- the shared index bytes and original writer cohort worktree bytes are unchanged
- all pre-existing pending replay staging files are byte-identical, including `retry_attempts` and writer-attempt fields
- a second post-stop `agent_end` leaves the whole canonical L1/L2 plus staging fingerprint unchanged
- active recovery records for that episode/slot are exactly one `recovery_slot_claimed` and one `commit_prepared`
- there is no `commit_published`, `index_converged`, `recovery_slot_aborted`, or `recovery_episode_terminal`
- candidate is not contained by `refs/heads/main`

The two new content-addressed recovery L1 files are the required durable pending record. Therefore whole-repository `git status` is expected to gain exactly those claim/prepared files; "worktree unchanged" means the original writer cohort and unrelated paths are byte-identical.

Abort acceptance if any item differs. Terminate the armed process so it cannot observe another writer cohort, unset the variable in its launch shell, and do not manually publish, abort, burn a slot, converge the index, or run a remote command:

```bash
unset PI_ASTACK_P1_RESTART_PROBE EXPECTED_HEAD RUN_ID EXPIRES_AT_UTC
```

Preserve any pending state for diagnosis. A later approved fresh startup will use the normal recovery protocol; it must never be repaired by editing L1.

## Fresh restart

Only after the prepared stop gate passes, terminate the armed pi process normally. In its launch shell, remove the inherited env before starting the recovery process:

```bash
unset PI_ASTACK_P1_RESTART_PROBE EXPECTED_HEAD RUN_ID EXPIRES_AT_UTC
test -z "${PI_ASTACK_P1_RESTART_PROBE+x}"
```

Launch a fresh pi process through the normal local entrypoint from that clean shell. Do not carry a shell/service env containing the probe. Do not run a manual drain or recovery command.

On startup, normal `awaitStartup` recovery must publish and converge the same episode/slot/candidate. Verify:

- startup is `ready`;
- HEAD equals the recorded candidate;
- the same episode/slot now has exactly claim, prepared, published, and converged;
- candidate cohort paths are byte-exact in HEAD, shared index, and worktree;
- no abort/terminal or new slot exists;
- captured Git argv contains no `fetch`, `push`, `pull`, or `ls-remote`;
- device push outcome is not an acceptance input.

Fill [the evidence template](../evidence/templates/p1-prepared-stop-restart-probe-evidence-template.md) only from observed output and read-only verification. This implementation task must not create production evidence.

## Forward deletion

After accepted evidence is independently reviewed, delete all temporary probe surfaces in a separate authorized change:

- constants, strict parser integration, read-only isolation resolver/types, process-global prepared-stop latch, consumed-run set, source gate, `probeRunId`, and prepared-stop return in `extensions/_shared/canonical-git-runtime.ts`;
- writer latch publication mapping and controlled-stop missing-commit exception in `extensions/sediment/writer.ts` and `extensions/sediment/curator-decision-writer.ts`;
- sediment module/`agent_end` isolation snapshots, side-scheduler gates, explicit/Tier-1/rule-status defers, candidate-loop break, recursive-drain/L3/embedding gates, post-stop `agent_end` early return, and temporary test exports/hooks in `extensions/sediment/index.ts`;
- temporary coordinate fields/mapping only if no durable API consumer remains;
- `scripts/smoke-p1-restart-prepared-stop-probe.mjs` and its package script, including resolver/scheduler/staging/latch/foreign-ABORT cases;
- this runbook and its evidence template;
- the temporary Decision Log entry, only by an append-only superseding entry, never by rewriting history.

Run runtime, recovery, writer/memory, foundation, registry, docs/path, diff, and targeted TypeScript gates after deletion. Do not leave the env set in any process or persistent configuration.
