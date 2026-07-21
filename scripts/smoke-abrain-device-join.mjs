#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(root, { interopDefault: true });
const join = jiti(path.join(root, "extensions/_shared/device-join-coordinator.ts"));
const barrier = jiti(path.join(root, "extensions/_shared/canonical-mutation-barrier.ts"));
const l1 = jiti(path.join(root, "extensions/_shared/l1-schema-registry.ts"));
const sync = jiti(path.join(root, "extensions/abrain/git-sync.ts"));
const autoRefresh = jiti(path.join(root, "extensions/sediment/constraint-compiler/auto-refresh.ts"));
const canonicalRuntime = jiti(path.join(root, "extensions/_shared/canonical-git-runtime.ts"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-device-join-smoke-"));
const disabledSettings = path.join(tmp, "settings.json");
fs.writeFileSync(disabledSettings, '{"canonicalGitRuntime":{"enabled":false,"mode":"local_convergence_v2"}}\n');
process.env.PI_ASTACK_SETTINGS_PATH = disabledSettings;
let passed = 0;
const failures = [];

function assert(value, message) { if (!value) throw new Error(message); }
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (error) { failures.push({ name, error }); console.log(`  FAIL  ${name}\n        ${error?.stack ?? error}`); }
}
function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, LANG: "C", LC_ALL: "C" } }).trim();
}
function commit(repo, message, paths = ["-A"], timestamp = 1700000000) {
  git(repo, "add", ...paths);
  execFileSync("git", ["-C", repo, "commit", "-qm", message], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Join Fixture",
      GIT_AUTHOR_EMAIL: "join@example.invalid",
      GIT_COMMITTER_NAME: "Join Fixture",
      GIT_COMMITTER_EMAIL: "join@example.invalid",
      GIT_AUTHOR_DATE: `${timestamp} +0000`,
      GIT_COMMITTER_DATE: `${timestamp} +0000`,
    },
  });
  return git(repo, "rev-parse", "HEAD");
}
function initRepo(name) {
  const repo = path.join(tmp, name);
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".state/\n");
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  commit(repo, "base", [".gitignore", "base.txt"]);
  return repo;
}
function knowledgeBody(seq, slug = `join-${seq}`) {
  return {
    event_schema_version: "knowledge-evidence-event/v1",
    event_type: "knowledge_entry_observed",
    created_at_utc: `2026-07-20T00:00:${String(seq).padStart(2, "0")}.000Z`,
    device_id: `join-device-${seq}`,
    device_event_seq: seq,
    producer_nonce: `join-${seq}`,
    causal_parents: [],
    session_id: "device-join-smoke",
    turn_id: `turn-${seq}`,
    actor: { role: "assistant", id: "sediment" },
    source: { channel: "agent_end", source_ref: `sediment:auto_write:created:${slug}` },
    intent: { domain_hint: "knowledge", operation_hint: "create", confidence: 0.9 },
    scope: { kind: "project", project_id: "pi-astack" },
    payload: {
      slug,
      title: `Join ${seq}`,
      kind: "knowledge",
      status: "active",
      provenance: "synthetic-smoke",
      confidence: 9,
      compiled_truth: `# Join ${seq}\n\nSynthetic device join fixture.`,
      trigger_phrases: ["device join"],
      derives_from: [],
    },
    sanitizer: { sanitizer_name: "fixture", sanitizer_version: "v1", status: "passed", replacements_count: 0 },
    legacy_parallel_write: { attempted: false, status: "skipped", reason: "fixture" },
    producer: { name: "sediment.knowledge-event-writer", version: "adr0039-p5" },
  };
}
function writeKnowledge(repo, seq, slug) {
  const body = knowledgeBody(seq, slug);
  const eventId = l1.canonicalL1BodyHash(body);
  const envelope = { schema: "knowledge-evidence-envelope/v1", canonicalization: "RFC8785-JCS", hash_alg: "sha256", event_id: eventId, body_hash: eventId, body };
  const relative = l1.expectedL1EventRelativePath(eventId);
  const file = path.join(repo, ...relative.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(envelope)}\n`);
  return { eventId, relative, file };
}
function validStaleManifest(latestEventId = "0".repeat(64)) {
  return `${JSON.stringify({ schemaVersion: "knowledge-projection-manifest/v1", updatedAtUtc: "2000-01-01T00:00:00.000Z", latestEventId, latestOutputPath: "latest/projects/pi-astack/stale.md", latestScope: { kind: "project", project_id: "pi-astack" }, latestOperation: "create" }, null, 2)}\n`;
}
function createDivergenceFixture(name) {
  const repo = initRepo(name);
  for (const [file, bytes] of [["local-mod.txt", "base-local\n"], ["upstream-mod.txt", "base-upstream\n"], ["upstream-delete.txt", "delete me\n"], ["local-mode.sh", "#!/bin/sh\nexit 0\n"]]) fs.writeFileSync(path.join(repo, file), bytes);
  const manifest = path.join(repo, "l2/views/knowledge/latest/manifest.json");
  const staleL2 = path.join(repo, "l2/views/knowledge/latest/world/stale.md");
  fs.mkdirSync(path.dirname(staleL2), { recursive: true });
  fs.writeFileSync(manifest, validStaleManifest());
  fs.writeFileSync(staleL2, "---\nschema_version: 1\nsediment_projection: knowledge-evidence/v1\nsediment_projector: knowledge-projector\nsediment_projector_version: adr0039-p5\nsediment_template_version: knowledge-markdown/v1\n---\n\n# stale\n");
  commit(repo, "shared tracked base");
  const base = git(repo, "rev-parse", "HEAD");

  git(repo, "switch", "-qc", "upstream");
  const upstreamEvent = writeKnowledge(repo, 2, "upstream-entry");
  fs.writeFileSync(path.join(repo, "upstream-mod.txt"), "upstream changed\n");
  fs.rmSync(path.join(repo, "upstream-delete.txt"));
  fs.writeFileSync(path.join(repo, "upstream-add.txt"), "upstream add\n");
  fs.writeFileSync(manifest, validStaleManifest(upstreamEvent.eventId));
  const upstream = commit(repo, "upstream", ["-A"], 1700000002);

  git(repo, "switch", "main");
  const localEvent = writeKnowledge(repo, 1, "local-entry");
  fs.writeFileSync(path.join(repo, "local-mod.txt"), "local changed\n");
  fs.writeFileSync(path.join(repo, "local-add.txt"), "local add\n");
  fs.chmodSync(path.join(repo, "local-mode.sh"), 0o755);
  fs.writeFileSync(manifest, validStaleManifest(localEvent.eventId));
  const local = commit(repo, "local", ["-A"], 1700000001);
  return { repo, base, local, upstream, localEvent, upstreamEvent, manifest, staleL2 };
}
async function prepare(repo) { return join.prepareDeviceJoin({ repo, upstreamRef: "refs/heads/upstream" }); }
function expectCode(error, code) { assert(error?.code === code || String(error).includes(code), `expected ${code}, got ${error?.code}: ${error}`); }

console.log("smoke: abrain deterministic multi-device join");

await check("clean divergence unions L1, rebuilds tracked manifest, and selects ordinary add/modify/delete/mode", async () => {
  const fixture = createDivergenceFixture("clean-divergence");
  const prepared = await prepare(fixture.repo);
  assert(prepared.status === "join" && prepared.base === fixture.base, "divergence did not create a deterministic join");
  const parentLine = git(fixture.repo, "show", "-s", "--format=%P", prepared.candidate).split(" ");
  assert(JSON.stringify(parentLine) === JSON.stringify([fixture.local, fixture.upstream]), `join parents are not H,U: ${parentLine}`);
  assert(git(fixture.repo, "show", "-s", "--format=%B", prepared.candidate) === "pi-astack: deterministic device join", "join message is not fixed");
  assert(git(fixture.repo, "show", "-s", "--format=%at %ct", prepared.candidate) === "946684800 946684800", "join dates are not fixed");
  const result = await join.publishPreparedDeviceJoin(prepared);
  assert(result.status === "published" && result.head === prepared.candidate, "join did not publish");
  assert(git(fixture.repo, "status", "--porcelain") === "", "published join is dirty");
  assert(fs.readFileSync(path.join(fixture.repo, "local-mod.txt"), "utf8") === "local changed\n", "local-only modification lost");
  assert(fs.readFileSync(path.join(fixture.repo, "upstream-mod.txt"), "utf8") === "upstream changed\n", "upstream-only modification lost");
  assert(!fs.existsSync(path.join(fixture.repo, "upstream-delete.txt")), "upstream-only deletion lost");
  assert(fs.existsSync(path.join(fixture.repo, "local-add.txt")) && fs.existsSync(path.join(fixture.repo, "upstream-add.txt")), "one-sided additions lost");
  assert((fs.statSync(path.join(fixture.repo, "local-mode.sh")).mode & 0o111) !== 0, "mode-only change lost");
  assert(git(fixture.repo, "ls-tree", "-r", "--name-only", "HEAD").includes(fixture.localEvent.relative), "local L1 missing");
  assert(git(fixture.repo, "ls-tree", "-r", "--name-only", "HEAD").includes(fixture.upstreamEvent.relative), "upstream L1 missing");
  const manifest = JSON.parse(fs.readFileSync(fixture.manifest, "utf8"));
  assert(manifest.latestEventId === fixture.upstreamEvent.eventId, "manifest was not rebuilt from complete union L1");
  assert(!fs.existsSync(fixture.staleL2), "stale registered L2 path survived full rebuild");
  assert(!fs.readFileSync(path.join(fixture.repo, ".gitignore"), "utf8").includes("l2/views/knowledge/latest/manifest.json"), "manifest unexpectedly ignored");
});

for (const operation of ["modify", "delete"]) {
  await check(`L1 ${operation} against merge base fails closed`, async () => {
    const repo = initRepo(`l1-${operation}`);
    const event = writeKnowledge(repo, 10, `base-${operation}`);
    commit(repo, "L1 base");
    git(repo, "branch", "upstream");
    if (operation === "modify") fs.appendFileSync(event.file, "different\n");
    else fs.rmSync(event.file);
    commit(repo, `local ${operation}`);
    let error;
    try { await prepare(repo); } catch (caught) { error = caught; }
    expectCode(error, "DEVICE_JOIN_L1_NOT_ADD_ONLY");
  });
}

await check("first join absorbs an ignored legacy manifest with different bytes and removes its old ignore line", async () => {
  const repo = initRepo("legacy-manifest-migration");
  fs.appendFileSync(path.join(repo, ".gitignore"), "l2/views/knowledge/latest/manifest.json\n");
  commit(repo, "legacy manifest ignore");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "switch", "-qc", "upstream");
  const upstreamEvent = writeKnowledge(repo, 32, "legacy-upstream");
  commit(repo, "upstream knowledge");
  git(repo, "switch", "main");
  const localEvent = writeKnowledge(repo, 31, "legacy-local");
  const local = commit(repo, "local knowledge");
  const manifest = path.join(repo, "l2/views/knowledge/latest/manifest.json");
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, validStaleManifest("f".repeat(64)));
  assert(git(repo, "check-ignore", "-q", "--no-index", "--", "l2/views/knowledge/latest/manifest.json") === "", "legacy manifest fixture is not ignored");
  const prepared = await prepare(repo);
  assert(prepared.status === "join" && prepared.base === base, "legacy migration did not produce a deterministic join");
  assert(!git(repo, "show", `${prepared.candidate}:.gitignore`).split("\n").includes("l2/views/knowledge/latest/manifest.json"), "candidate retained the legacy manifest ignore line");
  const result = await join.publishPreparedDeviceJoin(prepared);
  assert(result.status === "published" && git(repo, "rev-parse", "HEAD") === prepared.candidate, "legacy manifest migration did not publish");
  const migrated = JSON.parse(fs.readFileSync(manifest, "utf8"));
  assert(migrated.latestEventId === upstreamEvent.eventId, "legacy manifest bytes were not replaced by the union-L1 reconciler output");
  assert(git(repo, "ls-files", "--error-unmatch", "l2/views/knowledge/latest/manifest.json").endsWith("manifest.json"), "migrated manifest is not tracked");
  assert(!fs.readFileSync(path.join(repo, ".gitignore"), "utf8").split("\n").includes("l2/views/knowledge/latest/manifest.json"), "worktree retained the legacy manifest ignore line");
  assert(git(repo, "status", "--porcelain") === "" && !fs.existsSync(path.join(repo, ".state/device-join-journal.v1.json")), "legacy migration wedged publication state");
  assert(local === prepared.localHead && localEvent.eventId !== upstreamEvent.eventId, "legacy migration fixture did not diverge");
});

await check("same-head tracked manifest policy residue converges through a recoverable one-parent canonicalization", async () => {
  const fixture = createDivergenceFixture("same-head-manifest-policy");
  const first = await prepare(fixture.repo);
  assert((await join.publishPreparedDeviceJoin(first)).status === "published", "fixture join did not publish");
  fs.appendFileSync(path.join(fixture.repo, ".gitignore"), "l2/views/knowledge/latest/manifest.json\n");
  const local = commit(fixture.repo, "restore legacy manifest policy", [".gitignore"]);
  git(fixture.repo, "branch", "-f", "upstream", local);
  const prepared = await prepare(fixture.repo);
  assert(prepared.status === "canonicalize" && prepared.localHead === prepared.upstreamHead, "same-head residue did not create a canonicalization candidate");
  assert(git(fixture.repo, "show", "-s", "--format=%P", prepared.candidate) === local, "canonicalization candidate is not single-parent");
  assert(git(fixture.repo, "show", "-s", "--format=%B", prepared.candidate) === "pi-astack: canonical L2 migration", "canonicalization message is not fixed");
  try {
    await join.publishPreparedDeviceJoin(prepared, { crashHook(phase) { if (phase === "journal_written") throw new Error("crash:canonicalize"); } });
  } catch (error) {
    assert(String(error).includes("crash:canonicalize"), `unexpected canonicalization crash: ${error}`);
  }
  const recovered = await join.recoverDeviceJoinJournal({ repo: fixture.repo });
  assert(recovered?.status === "published" && git(fixture.repo, "rev-parse", "HEAD") === prepared.candidate, "canonicalization journal did not recover");
  assert(!fs.readFileSync(path.join(fixture.repo, ".gitignore"), "utf8").split("\n").includes("l2/views/knowledge/latest/manifest.json"), "canonicalization retained old ignore policy");
  assert(git(fixture.repo, "status", "--porcelain") === "", "canonicalization recovery left a dirty repo");
});

await check("ordinary ignored create collision fails before journal and CAS", async () => {
  const repo = initRepo("ordinary-ignored-collision");
  fs.appendFileSync(path.join(repo, ".gitignore"), "ignored-create.txt\n");
  const local = commit(repo, "ignore ordinary create");
  git(repo, "switch", "-qc", "upstream");
  fs.writeFileSync(path.join(repo, "ignored-create.txt"), "upstream tracked bytes\n");
  commit(repo, "upstream ignored create", ["-f", "ignored-create.txt"]);
  git(repo, "switch", "main");
  fs.writeFileSync(path.join(repo, "ignored-create.txt"), "local ignored collision\n");
  const prepared = await prepare(repo);
  let error;
  try { await join.publishPreparedDeviceJoin(prepared); } catch (caught) { error = caught; }
  expectCode(error, "DEVICE_JOIN_WORKTREE_THIRD_STATE");
  assert(git(repo, "rev-parse", "HEAD") === local, "ordinary ignored collision moved HEAD");
  assert(!fs.existsSync(path.join(repo, ".state/device-join-journal.v1.json")), "ordinary ignored collision wrote a journal");
  assert(fs.readFileSync(path.join(repo, "ignored-create.txt"), "utf8") === "local ignored collision\n", "ordinary ignored collision bytes were overwritten");
});

await check("same L1 path with different blobs fails closed", async () => {
  const repo = initRepo("l1-collision");
  const base = git(repo, "rev-parse", "HEAD");
  const relative = "l1/events/sha256/aa/bb/" + "a".repeat(64) + ".json";
  const file = path.join(repo, ...relative.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "local\n"); commit(repo, "local collision");
  git(repo, "switch", "-qc", "upstream", base);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "upstream\n"); commit(repo, "upstream collision");
  git(repo, "switch", "main");
  let error; try { await prepare(repo); } catch (caught) { error = caught; }
  expectCode(error, "DEVICE_JOIN_L1_COLLISION");
});

await check("ordinary tracked bilateral conflict fails closed", async () => {
  const repo = initRepo("ordinary-conflict");
  fs.writeFileSync(path.join(repo, "conflict.txt"), "base\n"); commit(repo, "ordinary base");
  git(repo, "branch", "upstream");
  fs.writeFileSync(path.join(repo, "conflict.txt"), "local\n"); commit(repo, "local conflict");
  git(repo, "switch", "upstream"); fs.writeFileSync(path.join(repo, "conflict.txt"), "upstream\n"); commit(repo, "upstream conflict");
  git(repo, "switch", "main");
  let error; try { await prepare(repo); } catch (caught) { error = caught; }
  expectCode(error, "DEVICE_JOIN_TRACKED_CONFLICT");
});

await check("ordinary directory/file transitions materialize without a post-CAS wedge", async () => {
  const repo = initRepo("directory-file-transition");
  fs.mkdirSync(path.join(repo, "to-file"));
  fs.writeFileSync(path.join(repo, "to-file/child.txt"), "child\n");
  fs.writeFileSync(path.join(repo, "to-directory"), "flat\n");
  commit(repo, "shape base");
  git(repo, "switch", "-qc", "upstream");
  fs.rmSync(path.join(repo, "to-file"), { recursive: true });
  fs.writeFileSync(path.join(repo, "to-file"), "flat now\n");
  fs.rmSync(path.join(repo, "to-directory"));
  fs.mkdirSync(path.join(repo, "to-directory"));
  fs.writeFileSync(path.join(repo, "to-directory/child.txt"), "nested now\n");
  commit(repo, "shape transition");
  git(repo, "switch", "main");
  const prepared = await prepare(repo);
  const result = await join.publishPreparedDeviceJoin(prepared);
  assert(result.status === "published", "shape transition was not published");
  assert(fs.statSync(path.join(repo, "to-file")).isFile(), "directory did not become a file");
  assert(fs.statSync(path.join(repo, "to-directory")).isDirectory(), "file did not become a directory");
  assert(git(repo, "status", "--porcelain") === "", "shape transition left a dirty worktree");
});

await check("candidate removal of the .state exclusion fails before publication", async () => {
  const repo = initRepo("state-ignore-required");
  const local = git(repo, "rev-parse", "HEAD");
  git(repo, "switch", "-qc", "upstream");
  fs.writeFileSync(path.join(repo, ".gitignore"), "other-cache/\n");
  commit(repo, "remove state exclusion");
  git(repo, "switch", "main");
  let error; try { await prepare(repo); } catch (caught) { error = caught; }
  expectCode(error, "DEVICE_JOIN_STATE_IGNORE_REQUIRED");
  assert(git(repo, "rev-parse", "HEAD") === local && !fs.existsSync(path.join(repo, ".state/device-join-journal.v1.json")), "state-ignore rejection mutated publication state");
});

await check("changed gitlinks fail before journal and CAS", async () => {
  const repo = initRepo("gitlink-pre-cas");
  const local = git(repo, "rev-parse", "HEAD");
  git(repo, "switch", "-qc", "upstream");
  git(repo, "update-index", "--add", "--cacheinfo", `160000,${local},module`);
  execFileSync("git", ["-C", repo, "commit", "-qm", "add gitlink"], {
    env: { ...process.env, GIT_AUTHOR_NAME: "Join Fixture", GIT_AUTHOR_EMAIL: "join@example.invalid", GIT_COMMITTER_NAME: "Join Fixture", GIT_COMMITTER_EMAIL: "join@example.invalid", GIT_AUTHOR_DATE: "1700000003 +0000", GIT_COMMITTER_DATE: "1700000003 +0000" },
  });
  git(repo, "switch", "main");
  const prepared = await prepare(repo);
  let error; try { await join.publishPreparedDeviceJoin(prepared); } catch (caught) { error = caught; }
  expectCode(error, "DEVICE_JOIN_MATERIALIZE_UNSUPPORTED");
  assert(git(repo, "rev-parse", "HEAD") === local && !fs.existsSync(path.join(repo, ".state/device-join-journal.v1.json")), "gitlink rejection crossed the publication boundary");
});

for (const phase of ["journal_written", "cas_published", "path_materialized", "index_converged", "verified"]) {
  await check(`journal recovery closes crash after ${phase}`, async () => {
    const repo = initRepo(`crash-${phase}`);
    const base = git(repo, "rev-parse", "HEAD");
    git(repo, "switch", "-qc", "upstream");
    fs.writeFileSync(path.join(repo, "remote.txt"), "remote\n"); commit(repo, "remote");
    git(repo, "switch", "main");
    const prepared = await prepare(repo);
    let fired = false;
    try {
      await join.publishPreparedDeviceJoin(prepared, { crashHook(current) { if (!fired && current === phase) { fired = true; throw new Error(`crash:${phase}`); } } });
    } catch (error) { assert(String(error).includes(`crash:${phase}`), `unexpected injected crash: ${error}`); }
    assert(fired, `phase ${phase} was never reached`);
    const recovered = await join.recoverDeviceJoinJournal({ repo });
    assert(recovered?.status === "published" && git(repo, "rev-parse", "HEAD") === prepared.candidate, `recovery did not reach M after ${phase}`);
    assert(git(repo, "status", "--porcelain") === "" && fs.readFileSync(path.join(repo, "remote.txt"), "utf8") === "remote\n", `recovery left dirty bytes after ${phase}`);
    assert(!fs.existsSync(path.join(repo, ".state/device-join-journal.v1.json")), `journal survived recovery after ${phase}`);
    assert(base === prepared.localHead, "fast-forward crash fixture base drifted");
  });
}

await check("journal recovery removes only a validated partial device-join atomic temp", async () => {
  const repo = initRepo("journal-atomic-temp");
  git(repo, "switch", "-qc", "upstream");
  fs.writeFileSync(path.join(repo, "remote.txt"), "remote\n");
  commit(repo, "remote");
  git(repo, "switch", "main");
  const prepared = await prepare(repo);
  try {
    await join.publishPreparedDeviceJoin(prepared, { crashHook(phase) { if (phase === "journal_written") throw new Error("crash:atomic-temp"); } });
  } catch (error) {
    assert(String(error).includes("crash:atomic-temp"), `unexpected setup crash: ${error}`);
  }
  const entry = prepared.candidateMap.get("remote.txt");
  assert(entry, "remote entry missing from candidate map");
  const tempPath = join.__TEST.atomicTempPath(repo, "remote.txt", entry);
  fs.writeFileSync(tempPath, "rem");
  const recovered = await join.recoverDeviceJoinJournal({ repo });
  assert(recovered?.status === "published", "partial atomic temp recovery did not publish M");
  assert(!fs.existsSync(tempPath) && fs.readFileSync(path.join(repo, "remote.txt"), "utf8") === "remote\n", "validated atomic temp was not cleaned and rematerialized");
  assert(git(repo, "status", "--porcelain") === "" && !fs.existsSync(path.join(repo, ".state/device-join-journal.v1.json")), "atomic temp recovery left a wedge");
});

await check("journal recovery rejects a path outside exact H/M images", async () => {
  const repo = initRepo("journal-third-state");
  git(repo, "switch", "-qc", "upstream"); fs.writeFileSync(path.join(repo, "remote.txt"), "remote\n"); commit(repo, "remote");
  git(repo, "switch", "main");
  const prepared = await prepare(repo);
  try { await join.publishPreparedDeviceJoin(prepared, { crashHook(phase) { if (phase === "journal_written") throw new Error("crash:journal-third-state"); } }); }
  catch (error) { assert(String(error).includes("crash:journal-third-state"), `unexpected setup crash: ${error}`); }
  fs.writeFileSync(path.join(repo, "remote.txt"), "third state\n");
  let error; try { await join.recoverDeviceJoinJournal({ repo }); } catch (caught) { error = caught; }
  expectCode(error, "DEVICE_JOIN_WORKTREE_THIRD_STATE");
  assert(git(repo, "rev-parse", "HEAD") === prepared.localHead, "third-state recovery moved HEAD");
});

await check("dirty unknown path blocks before journal/CAS", async () => {
  const repo = initRepo("dirty-unknown");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "switch", "-qc", "upstream"); fs.writeFileSync(path.join(repo, "remote.txt"), "remote\n"); commit(repo, "remote");
  git(repo, "switch", "main");
  const prepared = await prepare(repo);
  fs.writeFileSync(path.join(repo, "unknown.txt"), "dirty\n");
  let error; try { await join.publishPreparedDeviceJoin(prepared); } catch (caught) { error = caught; }
  expectCode(error, "DEVICE_JOIN_DIRTY_UNKNOWN");
  assert(git(repo, "rev-parse", "HEAD") === base && !fs.existsSync(path.join(repo, ".state/device-join-journal.v1.json")), "dirty rejection mutated HEAD/journal");
});

await check("CAS race returns stale and leaves the recomputation boundary clean", async () => {
  const repo = initRepo("cas-race");
  git(repo, "switch", "-qc", "upstream"); fs.writeFileSync(path.join(repo, "remote.txt"), "remote\n"); commit(repo, "remote");
  git(repo, "switch", "main");
  const prepared = await prepare(repo);
  fs.writeFileSync(path.join(repo, "racer.txt"), "race\n"); const raced = commit(repo, "racer");
  const result = await join.publishPreparedDeviceJoin(prepared);
  assert(result.status === "stale" && result.head === raced, `CAS race did not request recomputation: ${JSON.stringify(result)}`);
  assert(!fs.existsSync(path.join(repo, ".state/device-join-journal.v1.json")), "stale preparation wrote a journal");
});

await check("CAS loss after journal write clears the nonrecoverable H/M marker", async () => {
  const repo = initRepo("cas-after-journal");
  git(repo, "switch", "-qc", "upstream"); fs.writeFileSync(path.join(repo, "remote.txt"), "remote\n"); commit(repo, "remote");
  git(repo, "switch", "main");
  const prepared = await prepare(repo);
  const tree = git(repo, "rev-parse", `${prepared.localHead}^{tree}`);
  const raced = execFileSync("git", ["-C", repo, "commit-tree", tree, "-p", prepared.localHead], {
    input: "external ref race\n",
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Race", GIT_AUTHOR_EMAIL: "race@example.invalid", GIT_COMMITTER_NAME: "Race", GIT_COMMITTER_EMAIL: "race@example.invalid", GIT_AUTHOR_DATE: "1700000010 +0000", GIT_COMMITTER_DATE: "1700000010 +0000" },
  }).trim();
  const result = await join.publishPreparedDeviceJoin(prepared, { crashHook(phase) {
    if (phase === "journal_written") git(repo, "update-ref", prepared.refName, raced, prepared.localHead);
  } });
  assert(result.status === "stale" && result.head === raced, `post-journal CAS race was not stale: ${JSON.stringify(result)}`);
  assert(!fs.existsSync(path.join(repo, ".state/device-join-journal.v1.json")), "post-journal CAS race left an unrecoverable journal");
});

function barrierChild(repo, holdMs, marker) {
  const code = `const {createJiti}=require('jiti');const fs=require('fs'),p=require('path');(async()=>{const j=createJiti(${JSON.stringify(root)},{interopDefault:true});const b=j(p.join(${JSON.stringify(root)},'extensions/_shared/canonical-mutation-barrier.ts'));await b.withCanonicalMutationBarrier(${JSON.stringify(repo)},async()=>{${marker ? `fs.writeFileSync(${JSON.stringify(marker)},'held\\n');` : ""}process.stdout.write('start '+Date.now()+'\\n');await new Promise(r=>setTimeout(r,${holdMs}));process.stdout.write('end '+Date.now()+'\\n')});})().catch(e=>{console.error(e);process.exit(1)});`;
  return spawn(process.execPath, ["-e", code], { cwd: root, env: { ...process.env, LANG: "C", LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"] });
}
function childOutput(child) {
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `child exit ${code}`)));
  });
}
async function waitFor(label, predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}
function legacyWorkflowChild(repo) {
  const code = `const {createJiti}=require('jiti');const fs=require('fs'),p=require('path');(async()=>{const j=createJiti(${JSON.stringify(root)},{interopDefault:true});const w=j(p.join(${JSON.stringify(root)},'extensions/sediment/writer.ts'));const file=p.join(${JSON.stringify(repo)},'l2','legacy-writer-output.txt');fs.mkdirSync(p.dirname(file),{recursive:true});fs.writeFileSync(file,'legacy writer output\\n');const result=await w.commitAbrainDerivedOutputs(${JSON.stringify(repo)},'legacy-barrier-smoke',[file]);process.stdout.write(JSON.stringify(result));})().catch(e=>{console.error(e);process.exit(1)});`;
  return spawn(process.execPath, ["-e", code], { cwd: root, env: { ...process.env, PI_ASTACK_SETTINGS_PATH: disabledSettings, PI_ABRAIN_NO_AUTOSYNC: "1", LANG: "C", LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"] });
}
await check("cross-process canonical writers are mutually exclusive", async () => {
  const repo = initRepo("ofd-mutual-exclusion");
  const first = barrierChild(repo, 250);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const second = barrierChild(repo, 50);
  const [firstRaw, secondRaw] = await Promise.all([childOutput(first), childOutput(second)]);
  const parse = (raw) => Object.fromEntries(raw.trim().split("\n").map((line) => { const [kind, value] = line.split(" "); return [kind, Number(value)]; }));
  const a = parse(firstRaw), b = parse(secondRaw);
  const noOverlap = a.end <= b.start || b.end <= a.start;
  assert(noOverlap, `OFD critical sections overlapped: ${JSON.stringify({ a, b })}`);
});

await check("detached async context cannot retain a released barrier lease", async () => {
  const repo = initRepo("detached-barrier-lease");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let detached;
  let outside;
  await barrier.withCanonicalMutationBarrier(repo, async () => {
    assert(barrier.canonicalMutationBarrierHeld(repo), "barrier was not visible inside its callback");
    outside = barrier.withoutCanonicalMutationBarrierContext(async () => barrier.canonicalMutationBarrierHeld(repo));
    detached = gate.then(() => barrier.canonicalMutationBarrierHeld(repo));
  });
  assert(await outside === false, "explicit detached context retained the active parent lease");
  release();
  assert(await detached === false, "detached continuation inherited a released barrier lease");
});

await check("simulated long constraint compile does not hold the canonical OFD barrier", async () => {
  const repo = initRepo("compile-outside-barrier");
  let compileStarted;
  const started = new Promise((resolve) => { compileStarted = resolve; });
  let releaseCompile;
  const compileGate = new Promise((resolve) => { releaseCompile = resolve; });
  const trigger = {
    abrainHome: repo,
    cwd: repo,
    settings: {
      curatorModel: "test/model",
      constraintShadowCompiler: {
        enabled: true,
        model: "test/model",
        maxPromptChars: 0,
        maxCompileRetries: 0,
        escalationModelRef: "",
        timeoutMs: 1_000,
        maxRetries: 0,
        l2OutputRoot: "state",
        mergedSourceVerifier: { enabled: false, model: "", maxPromptChars: 0 },
        autoRefresh: { enabled: true, debounceMs: 0, minIntervalMs: 0, eventStaleAfterMs: 0, maxPromptChars: 0 },
      },
    },
    modelRegistry: { find() { return {}; }, async getApiKeyAndHeaders() { return { ok: true, apiKey: "fixture" }; } },
    reason: "barrier_scope_smoke",
  };
  autoRefresh._setConstraintShadowSettingsResolverForTests(() => trigger.settings);
  const compileRun = autoRefresh._runConstraintShadowAutoRefreshWithCompilerForTests(trigger, async () => {
    compileStarted();
    await compileGate;
    return { ok: false, inputRootHash: "compile-scope-fixture", sourceCount: 0, diagnostics: [] };
  });
  await started;
  const writer = barrierChild(repo, 20);
  const writerDone = childOutput(writer);
  let writerOutput;
  try {
    writerOutput = await Promise.race([
      writerDone,
      new Promise((_, reject) => setTimeout(() => reject(new Error("writer was blocked by long compile")), 500)),
    ]);
  } finally {
    releaseCompile();
  }
  await compileRun;
  autoRefresh._resetConstraintShadowAutoRefreshForTests();
  assert(String(writerOutput).includes("start") && String(writerOutput).includes("end"), "cross-process writer did not complete during compile");
});

await check("startup retries low-level barrier timeouts inside one shared promise", async () => {
  const repo = initRepo("startup-timeout-retry");
  const enabledSettings = path.join(tmp, "startup-timeout-enabled.json");
  fs.writeFileSync(enabledSettings, '{"canonicalGitRuntime":{"enabled":true,"mode":"local_convergence_v2"}}\n');
  const marker = path.join(tmp, "startup-timeout-holder.marker");
  const holder = barrierChild(repo, 500, marker);
  const holderDone = childOutput(holder);
  await waitFor("startup timeout holder", () => fs.existsSync(marker));
  const options = {
    abrainHome: repo,
    settingsPath: enabledSettings,
    sourceRoot: root,
    startupBarrierTimeoutMs: 25,
    startupBusyBudgetMs: 2_000,
    startupBusyInitialBackoffMs: 10,
    startupBusyMaxBackoffMs: 40,
    startupRetryRandom: () => 0,
  };
  const first = canonicalRuntime.getCanonicalStartupPromise(options);
  const shared = canonicalRuntime.getCanonicalStartupPromise(options);
  assert(first === shared, "busy startup created more than one process-local promise");
  const retried = await first;
  await holderDone;
  assert(retried.startup === "ready", `startup retry stayed deferred/blocked: ${retried.blockedReason}`);
  assert(retried.tail.some((row) => row.status === "canonical_mutation_busy_retry"), "startup did not record an internal busy retry");
  assert(retried.tail.filter((row) => row.phase === "freeze_initial" && row.status === "enter").length >= 2, "busy retry reused the old startup tuple");
});

await check("legacy writer holds the canonical barrier against an automatic join", async () => {
  const repo = initRepo("legacy-writer-vs-join");
  git(repo, "config", "user.name", "Legacy Writer Fixture");
  git(repo, "config", "user.email", "legacy-writer@example.invalid");
  git(repo, "switch", "-qc", "upstream");
  fs.writeFileSync(path.join(repo, "remote.txt"), "remote\n");
  commit(repo, "remote");
  git(repo, "switch", "main");
  const prepared = await prepare(repo);
  const marker = path.join(tmp, "legacy-writer-hook.marker");
  fs.writeFileSync(path.join(repo, ".git/hooks/pre-commit"), `#!/bin/sh\nprintf held > ${JSON.stringify(marker)}\nsleep 0.35\n`, { mode: 0o755 });
  const writer = legacyWorkflowChild(repo);
  const writerDone = childOutput(writer);
  await waitFor("legacy writer pre-commit hook", () => fs.existsSync(marker), 10_000);
  let joinResolved = false;
  const joining = join.publishPreparedDeviceJoin(prepared).then((value) => { joinResolved = true; return value; });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert(!joinResolved, "join overlapped the legacy writer critical section");
  const writerResult = JSON.parse(await writerDone);
  const joined = await joining;
  assert(writerResult.status === "local_durable" && writerResult.canonical === false, `legacy writer did not commit: ${JSON.stringify(writerResult)}`);
  assert(joined.status === "stale" && joined.head === git(repo, "rev-parse", "HEAD"), `join did not re-enter at the stale recomputation boundary: ${JSON.stringify(joined)}`);
  assert(!fs.existsSync(path.join(repo, ".state/device-join-journal.v1.json")), "serialized stale join wrote a journal");
});

await check("exact-OID push rejection retries are bounded", async () => {
  const rootDir = path.join(tmp, "push-retry"); fs.mkdirSync(rootDir);
  const bare = path.join(rootDir, "remote.git"); const repo = path.join(rootDir, "repo");
  git(rootDir, "init", "--bare", bare);
  git(rootDir, "clone", bare, repo);
  git(repo, "config", "user.name", "Push Fixture"); git(repo, "config", "user.email", "push@example.invalid");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".state/\n"); fs.writeFileSync(path.join(repo, "base.txt"), "base\n"); commit(repo, "base");
  git(repo, "push", "-u", "origin", "HEAD");
  const count = path.join(rootDir, "attempts"); fs.writeFileSync(count, "0\n");
  const hook = path.join(bare, "hooks/pre-receive");
  fs.writeFileSync(hook, `#!/bin/sh\nn=$(cat ${JSON.stringify(count)})\nn=$((n+1))\nprintf '%s\\n' "$n" > ${JSON.stringify(count)}\necho rejected-by-smoke >&2\nexit 1\n`, { mode: 0o755 });
  fs.appendFileSync(path.join(repo, "base.txt"), "local\n"); commit(repo, "local push");
  const result = await sync.pushAsync({ abrainHome: repo, maxAttempts: 2, jitterMs: 0, timeoutMs: 10_000 });
  assert(result.result === "push_rejected", `bounded push did not report rejection: ${JSON.stringify(result)}`);
  assert(fs.readFileSync(count, "utf8").trim() === "2", `push retry count was not bounded at 2: ${fs.readFileSync(count, "utf8")}`);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed}/${passed + failures.length} checks passed`);
if (failures.length) process.exitCode = 1;
