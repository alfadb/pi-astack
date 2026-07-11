#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
process.env.PI_ASTACK_CANONICAL_LOCAL_TRANSPORT_FOR_TESTS = "1";
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(root, { interopDefault: true, moduleCache: false });

function git(repo, args, options = {}) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}
function initRepo(base, remote = true) {
  const repo = path.join(base, `repo-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "smoke"]);
  git(repo, ["config", "user.email", "smoke@example.invalid"]);
  fs.writeFileSync(path.join(repo, "README.md"), "initial\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".state/\n");
  git(repo, ["add", "README.md", ".gitignore"]);
  git(repo, ["commit", "-m", "initial"]);
  let bare = null;
  if (remote) {
    bare = path.join(base, `remote-${Math.random().toString(16).slice(2)}.git`);
    execFileSync("git", ["init", "--bare", bare], { stdio: "ignore" });
    git(repo, ["remote", "add", "origin", bare]);
    git(repo, ["push", "-u", "origin", "main"]);
  }
  return { repo, bare };
}
const TEST_TRANSPORT_POLICY = JSON.parse(fs.readFileSync(path.resolve(root, "..", "..", "pi-astack-settings.json"), "utf8")).canonicalGitRuntime.transport;
function settingsFile(base, enabled, suffix = "") {
  const file = path.join(base, `settings${suffix}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ canonicalGitRuntime: { enabled, mode: "p1_controlled", transport: TEST_TRANSPORT_POLICY } }, null, 2)}\n`);
  return file;
}

async function worker() {
  const runtimeModule = jiti(path.join(root, "extensions/_shared/canonical-git-runtime.ts"));
  const repo = process.env.SMOKE_REPO;
  const settingsPath = process.env.SMOKE_SETTINGS;

  if (process.env.SMOKE_PHASE === "git-sync") {
    const syncModule = jiti(path.join(root, "extensions/abrain/git-sync.ts"));
    const result = await syncModule.sync({ abrainHome: repo });
    const expected = process.env.SMOKE_EXPECT_SYNC;
    if (expected === "ok") {
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.match(result.summary, /canonical facade/);
    } else {
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.match(result.events[0]?.reason ?? "", /canonical_(startup|remote|push|backlog)/);
    }
    process.stdout.write(`git-sync-${expected}-ready\n`);
    return;
  }

  if (process.env.SMOKE_PHASE === "locale-manifest") {
    const knowledge = jiti(path.join(root, "extensions/sediment/knowledge-evidence.ts"));
    const nodes = JSON.parse(process.env.SMOKE_LOCALE_NODES);
    process.stdout.write(`${JSON.stringify({
      topo: knowledge.topoSortKnowledgeEvents(nodes).map((node) => node.eventId),
      manifest: knowledge.renderKnowledgeProjectionManifestFromSet(nodes),
    })}\n`);
    return;
  }

  if (process.env.SMOKE_PHASE === "p1a-evidence-sort") {
    const evidence = jiti(path.join(root, "extensions/_shared/p1a-dossier-evidence.ts"));
    const values = JSON.parse(process.env.SMOKE_P1A_SORT_VALUES);
    process.stdout.write(`${JSON.stringify(values.sort(evidence.compareUtf16CodeUnits))}\n`);
    return;
  }

  if (process.env.SMOKE_PHASE === "invalid-settings") {
    const writer = jiti(path.join(root, "extensions/sediment/writer.ts"));
    const sync = jiti(path.join(root, "extensions/abrain/git-sync.ts"));
    const migrate = jiti(path.join(root, "extensions/memory/migrate-go.ts"));
    const ingest = jiti(path.join(root, "extensions/memory/ingest-adr.ts"));
    const before = `${git(repo, ["rev-parse", "HEAD"])}\n${git(repo, ["status", "--porcelain=v1", "-uall"])}`;
    await assert.rejects(() => writer.writeAbrainWorkflow({}, { abrainHome: repo, settings: {} }), /CANONICAL_GIT_SETTINGS_INVALID/);
    await assert.rejects(() => sync.pushAsync({ abrainHome: repo }), /CANONICAL_GIT_SETTINGS_INVALID/);
    await assert.rejects(() => migrate.runMigrationGo({}), /CANONICAL_GIT_SETTINGS_INVALID/);
    await assert.rejects(() => ingest.runAdrIngest({}), /CANONICAL_GIT_SETTINGS_INVALID/);
    const after = `${git(repo, ["rev-parse", "HEAD"])}\n${git(repo, ["status", "--porcelain=v1", "-uall"])}`;
    assert.equal(after, before, "invalid settings reached a mutation before throwing");
    process.stdout.write("invalid-settings-ready\n");
    return;
  }

  const runtime = await runtimeModule.getCanonicalGitRuntime({ abrainHome: repo, settingsPath, sourceRoot: process.env.SMOKE_SOURCE_ROOT ?? root });
  const startup = await runtime.awaitStartup();
  if (process.env.SMOKE_PHASE === "primary") {
    const l1Registry = jiti(path.join(root, "extensions/_shared/l1-schema-registry.ts"));
    const pushClaims = async () => (await l1Registry.scanWholeL1Validated({ abrainHome: repo })).all.filter((record) => record.body?.lane === "push" && record.body?.event_type === "recovery_slot_claimed").length;
    const claimsBeforeRepeat = await pushClaims();
    const repeatedStartup = await runtime.awaitStartup();
    assert.strictEqual(repeatedStartup, startup, "awaitStartup did not return the process-cached result");
    assert.equal(await pushClaims(), claimsBeforeRepeat, "repeated awaitStartup advanced another push slot");
  }
  if (process.env.SMOKE_PHASE === "startup-blocked") {
    assert.equal(startup.startup, "blocked", JSON.stringify(startup));
    process.stdout.write("startup-blocked-ready\n");
    return;
  }
  assert.equal(startup.startup, "ready", JSON.stringify(startup));
  const provenanceLabels = new Set(startup.loadedProvenance.map((entry) => entry.label));
  for (const label of ["l1-registry-implementation", "jcs", "durable-write", "memory-parser", "knowledge-evidence-renderer", "constraint-renderer", "constraint-normalizer", "abrain-index", "sediment-index", "constraint-auto-refresh", "writer", "git-sync", "reconcile", "settings-schema", "registry"]) {
    assert.ok(provenanceLabels.has(label), `missing provenance dependency: ${label}`);
  }

  if (process.env.SMOKE_PHASE === "constraint-auto-refresh") {
    const autoRefresh = jiti(path.join(root, "extensions/sediment/constraint-compiler/auto-refresh.ts"));
    const evidence = jiti(path.join(root, "extensions/sediment/constraint-evidence/integration.ts"));
    const projection = jiti(path.join(root, "extensions/sediment/constraint-compiler/projection.ts"));
    const sedimentSettings = jiti(path.join(root, "extensions/sediment/settings.ts"));
    const mode = process.env.SMOKE_CONSTRAINT_MODE;
    const settings = {
      ...sedimentSettings.DEFAULT_SEDIMENT_SETTINGS,
      constraintShadowCompiler: {
        ...sedimentSettings.DEFAULT_SEDIMENT_SETTINGS.constraintShadowCompiler,
        enabled: true,
        model: "smoke/compiler",
        l2OutputRoot: "repo",
        autoRefresh: { ...sedimentSettings.DEFAULT_SEDIMENT_SETTINGS.constraintShadowCompiler.autoRefresh, enabled: true, debounceMs: 60_000, minIntervalMs: 0 },
      },
    };
    const appended = await evidence.appendTier1ConstraintEvidenceEvent({
      abrainHome: repo,
      signal: { user_quote: "All canonical integration runs must preserve exact publication evidence.", confidence: 9, provenance: "user-expressed", scope_description: "global rule" },
      draft: { title: "Canonical integration publication", body: "All canonical integration runs must preserve exact publication evidence.", entryConfidence: 9, injectMode: "always" },
      sessionId: `constraint-${mode}`,
      turnId: "turn-1",
      projectId: "integration-project",
      cwd: repo,
      createdAtUtc: "2026-07-11T01:00:00.000Z",
      correlationId: `constraint-${mode}:auto`,
      candidateId: "c0",
      deviceId: "constraint-integration-device",
    });
    assert.equal(appended.append.ok, true, JSON.stringify(appended));
    const sourceEventId = appended.append.eventId;
    let sourceEventIds = [sourceEventId];
    if (mode === "debounce-success") {
      const secondAppended = await evidence.appendTier1ConstraintEvidenceEvent({
        abrainHome: repo,
        signal: { user_quote: "Every debounced source must remain in the exact publication cohort.", confidence: 9, provenance: "user-expressed", scope_description: "global rule" },
        draft: { title: "Canonical debounce completeness", body: "Every debounced source must remain in the exact publication cohort.", entryConfidence: 9, injectMode: "always" },
        sessionId: `constraint-${mode}`,
        turnId: "turn-2",
        projectId: "integration-project",
        cwd: repo,
        createdAtUtc: "2026-07-11T01:00:01.000Z",
        correlationId: `constraint-${mode}:auto-2`,
        candidateId: "c1",
        deviceId: "constraint-integration-device",
      });
      assert.equal(secondAppended.append.ok, true, JSON.stringify(secondAppended));
      sourceEventIds = [sourceEventId, secondAppended.append.eventId].sort();
    }
    const decision = {
      schemaVersion: "constraint-shadow-decision/v1",
      inputRootHash: "1".repeat(64),
      constraints: [], exclusions: [], unresolved: [], merges: [], rescopeProposals: [], mappings: [], diagnostics: [],
      validationHash: "2".repeat(64),
    };
    let compilerRuns = 0;
    const compilerRunner = async (scheduledTrigger) => {
      compilerRuns += 1;
      if (mode === "missing-output") {
        return { ok: true, inputRootHash: decision.inputRootHash, sourceCount: 1, prompt: {}, decision, view: { shadowOutputHash: "3".repeat(64) }, diff: {}, diagnostics: [] };
      }
      const fixed = await projection.fixateConstraintDecisionAndRenderL2({
        abrainHome: repo,
        decision,
        provenance: { model: "smoke/compiler", prompt_hash: "4".repeat(64), input_hash: decision.inputRootHash, raw_output_hash: "5".repeat(64), acceptance: "accepted_for_event_append" },
        inputEventIds: [...(scheduledTrigger.sourceEventIds ?? [scheduledTrigger.sourceEventId]).filter(Boolean)].sort(),
        createdAtUtc: "2026-07-11T01:01:00.000Z",
        deviceId: "constraint-integration-device",
        producerVersion: "constraint-integration/v1",
      });
      assert.equal(fixed.ok, true, JSON.stringify(fixed));
      return {
        ok: true,
        inputRootHash: decision.inputRootHash,
        sourceCount: sourceEventIds.length,
        prompt: {}, decision,
        view: { shadowOutputHash: "3".repeat(64) }, diff: {}, diagnostics: [],
        l2Projection: { status: fixed.status, eventId: fixed.eventId, l2RelativePath: fixed.l2RelativePath, decisionHash: fixed.decisionHash },
      };
    };
    const refreshTrigger = (eventId) => ({
      abrainHome: repo,
      cwd: repo,
      activeProjectId: "integration-project",
      knownProjectIds: ["integration-project"],
      settings: mode === "debounce-success" ? {
        ...settings,
        constraintShadowCompiler: {
          ...settings.constraintShadowCompiler,
          autoRefresh: { ...settings.constraintShadowCompiler.autoRefresh, debounceMs: 25 },
        },
      } : settings,
      modelRegistry: { find: () => ({}), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "offline-smoke" }) },
      reason: `constraint_${mode}`,
      sourceEventId: eventId,
    });
    if (mode === "debounce-success") {
      await autoRefresh._scheduleConstraintShadowAutoRefreshWithCompilerForTests(refreshTrigger(sourceEventIds[0]), compilerRunner);
      await autoRefresh._scheduleConstraintShadowAutoRefreshWithCompilerForTests(refreshTrigger(sourceEventIds[1]), compilerRunner);
      const auditFile = path.join(repo, ".state", "sediment", "constraint-shadow", "auto-refresh", "audit.jsonl");
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const rows = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
        if (rows.some((row) => row.status === "completed")) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } else {
      await autoRefresh._runConstraintShadowAutoRefreshWithCompilerForTests(refreshTrigger(sourceEventId), compilerRunner);
    }
    const auditFile = path.join(repo, ".state", "sediment", "constraint-shadow", "auto-refresh", "audit.jsonl");
    const rows = fs.readFileSync(auditFile, "utf8").trim().split("\n").map(JSON.parse);
    if (mode === "success" || mode === "debounce-success") {
      const completed = rows.find((row) => row.status === "completed" && (mode === "debounce-success" || row.sourceEventId === sourceEventId));
      assert.equal(completed?.publication?.status, "remote_durable", JSON.stringify(rows));
      const remoteHead = execFileSync("git", ["--git-dir", process.env.SMOKE_REMOTE, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim();
      assert.equal(remoteHead, git(repo, ["rev-parse", "HEAD"]));
      assert.ok(git(repo, ["ls-tree", "-r", "--name-only", "HEAD"]).includes("l2/views/constraint/latest/compiled-view.md"));
      if (mode === "debounce-success") {
        assert.equal(compilerRuns, 1, `debounce ran compiler ${compilerRuns} times`);
        assert.deepEqual(completed.sourceEventIds, sourceEventIds, JSON.stringify(completed));
        for (const eventId of sourceEventIds) {
          const rel = `l1/events/sha256/${eventId.slice(0, 2)}/${eventId.slice(2, 4)}/${eventId}.json`;
          assert.ok(git(repo, ["ls-tree", "-r", "--name-only", "HEAD"]).includes(rel), `debounced source missing from HEAD: ${eventId}`);
        }
      }
    } else if (mode === "pending") {
      assert.ok(rows.some((row) => row.status === "publication_pending" && row.publication?.status === "durable_pending"), JSON.stringify(rows));
      assert.ok(rows.some((row) => row.status === "retry_scheduled" && row.previousStatus === "failed"), JSON.stringify(rows));
    } else {
      assert.ok(rows.some((row) => row.status === "publication_terminal" && row.terminalReason === "required_l2_output_missing"), JSON.stringify(rows));
      assert.ok(!rows.some((row) => row.status === "completed"), JSON.stringify(rows));
      assert.ok(!rows.some((row) => row.status === "retry_scheduled"), JSON.stringify(rows));
    }
    autoRefresh._resetConstraintShadowAutoRefreshForTests();
    process.stdout.write(`constraint-auto-refresh-${mode}-ready\n`);
    return;
  }

  if (process.env.SMOKE_PHASE === "project-and-abrain-writers") {
    const writer = jiti(path.join(root, "extensions/sediment/writer.ts"));
    const sedimentSettings = jiti(path.join(root, "extensions/sediment/settings.ts"));
    const settings = {
      ...sedimentSettings.DEFAULT_SEDIMENT_SETTINGS,
      gitCommit: true,
      knowledgeEvidenceEventWriter: { ...sedimentSettings.DEFAULT_SEDIMENT_SETTINGS.knowledgeEvidenceEventWriter, enabled: true, mode: "event_first", legacyFallbackOnEventFailure: false, legacyMarkdownWriteOnSuccessfulEvent: false },
      knowledgeProjector: { ...sedimentSettings.DEFAULT_SEDIMENT_SETTINGS.knowledgeProjector, enabled: true, projectOnWrite: true, projectionMode: "topo", l2OutputRoot: "repo" },
    };
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "canonical-project-writer-"));
    fs.writeFileSync(path.join(repo, "noncohort-staged.txt"), "preserved staged bytes\n");
    git(repo, ["add", "noncohort-staged.txt"]);
    const stagedBefore = git(repo, ["ls-files", "--stage", "noncohort-staged.txt"]);
    const worktreeBefore = fs.readFileSync(path.join(repo, "noncohort-staged.txt"), "utf8");
    const projectResult = await writer.writeProjectEntry({
      title: "Enabled canonical project writer",
      kind: "fact",
      compiledTruth: "# Enabled canonical project writer\n\nThis fixture proves the real Knowledge projector publication path.",
      status: "active",
      provenance: "assistant-observed",
      confidence: 8,
      sessionId: "enabled-project-writer",
    }, { projectRoot, abrainHome: repo, projectId: "integration-project", scope: "project", settings });
    assert.equal(projectResult.status, "created", JSON.stringify(projectResult));
    assert.equal(projectResult.publication?.status, "remote_durable", JSON.stringify(projectResult.publication));
    assert.ok(projectResult.knowledgeEvidenceEvent?.projection?.manifestPath, "project writer did not invoke the Knowledge projector");
    const manifestProof = await runtimeModule.proveCanonicalArtifactOwnership({ abrainHome: repo, filePath: projectResult.knowledgeEvidenceEvent.projection.manifestPath });
    assert.equal(manifestProof.owner, "knowledge_l2");

    const workflowResult = await writer.writeAbrainWorkflow({
      title: "Enabled canonical abrain writer",
      trigger: "real enabled integration smoke",
      body: "Run the canonical enabled integration workflow with exact cohort preservation and durable publication.",
      crossProject: true,
      sessionId: "enabled-abrain-writer",
    }, { abrainHome: repo, settings });
    assert.equal(workflowResult.status, "created", JSON.stringify(workflowResult));
    assert.equal(workflowResult.publication?.status, "remote_durable", JSON.stringify(workflowResult.publication));
    assert.equal(git(repo, ["ls-files", "--stage", "noncohort-staged.txt"]), stagedBefore, "enabled writers changed the noncohort index entry");
    assert.equal(fs.readFileSync(path.join(repo, "noncohort-staged.txt"), "utf8"), worktreeBefore, "enabled writers changed noncohort worktree bytes");
    assert.ok(!git(repo, ["ls-tree", "-r", "--name-only", "HEAD"]).includes("noncohort-staged.txt"), "enabled writer folded noncohort staged content into HEAD");
    const remoteHead = execFileSync("git", ["--git-dir", process.env.SMOKE_REMOTE, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim();
    assert.equal(remoteHead, git(repo, ["rev-parse", "HEAD"]), "enabled writer did not reach exact remote durability");
    const tree = git(repo, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n");
    assert.ok(tree.some((rel) => rel.startsWith("l1/events/sha256/")), "enabled project writer omitted L1 from exact tree");
    assert.ok(tree.includes("l2/views/knowledge/latest/manifest.json"), "enabled project writer omitted manifest from exact tree");
    assert.ok(tree.includes("l2/views/knowledge/latest/projects/integration-project/enabled-canonical-project-writer.md"), "enabled project writer omitted L2 markdown from exact tree");
    assert.ok(tree.includes(path.relative(repo, workflowResult.path).split(path.sep).join("/")), "enabled abrain writer omitted workflow from exact tree");
    process.stdout.write("project-and-abrain-writers-ready\n");
    return;
  }

  if (process.env.SMOKE_PHASE === "maintenance-blocked") {
    const migrate = jiti(path.join(root, "extensions/memory/migrate-go.ts"));
    const ingest = jiti(path.join(root, "extensions/memory/ingest-adr.ts"));
    const before = `${git(repo, ["rev-parse", "HEAD"])}\n${git(repo, ["status", "--porcelain=v1", "-uall"])}`;
    await assert.rejects(() => migrate.runMigrationGo({}), /CANONICAL_MIGRATION_REQUIRES_EVENT_IMPORT/);
    await assert.rejects(() => ingest.runAdrIngest({}), /CANONICAL_ADR_INGEST_REQUIRES_EVENT_IMPORT/);
    const after = `${git(repo, ["rev-parse", "HEAD"])}\n${git(repo, ["status", "--porcelain=v1", "-uall"])}`;
    assert.equal(after, before, "enabled maintenance rejection mutated repository");
    process.stdout.write("maintenance-blocked-ready\n");
    return;
  }

  if (process.env.SMOKE_PHASE === "writer-untracked-noncohort") {
    const writer = jiti(path.join(root, "extensions/sediment/writer.ts"));
    const sedimentSettings = jiti(path.join(root, "extensions/sediment/settings.ts"));
    const settings = {
      ...sedimentSettings.DEFAULT_SEDIMENT_SETTINGS,
      gitCommit: true,
      knowledgeEvidenceEventWriter: { ...sedimentSettings.DEFAULT_SEDIMENT_SETTINGS.knowledgeEvidenceEventWriter, enabled: true, mode: "event_first", legacyFallbackOnEventFailure: false, legacyMarkdownWriteOnSuccessfulEvent: false },
      knowledgeProjector: { ...sedimentSettings.DEFAULT_SEDIMENT_SETTINGS.knowledgeProjector, enabled: true, projectOnWrite: true, projectionMode: "topo", l2OutputRoot: "repo" },
    };
    const headBefore = git(repo, ["rev-parse", "HEAD"]);
    const roguePath = path.join(repo, "untracked-noncohort.txt");
    fs.writeFileSync(roguePath, "block exact canonical ownership\n");
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "canonical-pending-project-"));
    const projectResult = await writer.writeProjectEntry({
      title: "Canonical pending project artifact",
      kind: "fact",
      compiledTruth: "# Canonical pending project artifact\n\nL1 and L2 must survive prepublication ownership blocking.",
      status: "active",
      provenance: "assistant-observed",
      confidence: 8,
      sessionId: "canonical-pending-project",
    }, { projectRoot, abrainHome: repo, projectId: "pending-project", scope: "project", settings });
    assert.equal(projectResult.status, "created", JSON.stringify(projectResult));
    assert.equal(projectResult.publication?.canonical, true, JSON.stringify(projectResult.publication));
    assert.ok(["durable_pending", "terminal_before_publish"].includes(projectResult.publication?.status), JSON.stringify(projectResult.publication));

    const workflowResult = await writer.writeAbrainWorkflow({
      title: "Canonical pending workflow artifact",
      trigger: "retry after untracked noncohort ownership blocker",
      body: "This valid workflow remains durable and retryable after canonical prepublication is blocked.",
      crossProject: true,
      sessionId: "canonical-pending-workflow",
    }, { abrainHome: repo, settings });
    assert.equal(workflowResult.status, "created", JSON.stringify(workflowResult));
    assert.equal(workflowResult.publication?.canonical, true, JSON.stringify(workflowResult.publication));
    assert.ok(["durable_pending", "terminal_before_publish"].includes(workflowResult.publication?.status), JSON.stringify(workflowResult.publication));
    assert.equal(git(repo, ["rev-parse", "HEAD"]), headBefore, "blocked canonical writer changed HEAD");

    const pendingPaths = [
      projectResult.knowledgeEvidenceEvent?.append?.filePath,
      projectResult.knowledgeEvidenceEvent?.projection?.outputPath,
      projectResult.knowledgeEvidenceEvent?.projection?.manifestPath,
      workflowResult.path,
    ].filter(Boolean);
    assert.equal(pendingPaths.length, 4, `missing expected pending workflow/L1/L2 paths: ${JSON.stringify(projectResult)}`);
    for (const file of pendingPaths) assert.ok(fs.existsSync(file), `canonical cleanup removed pending artifact: ${file}`);
    assert.ok(fs.existsSync(roguePath), "canonical cleanup removed the noncohort blocker");

    fs.rmSync(roguePath);
    const receipts = [];
    for (const filePath of [...new Set(pendingPaths)]) {
      receipts.push(await runtimeModule.createProducedArtifactReceipt({ abrainHome: repo, filePath, sourceIds: ["writer:retry:pending-cohort"] }));
    }
    const retried = await runtime.requestDrain(receipts, "smoke: retry preserved canonical artifacts");
    assert.equal(retried.status, "index_converged", JSON.stringify(retried));
    const pushed = await runtime.requestPush(retried.commit);
    assert.equal(pushed.status, "success", JSON.stringify(pushed));
    assert.notEqual(git(repo, ["rev-parse", "HEAD"]), headBefore, "retry did not publish preserved artifacts");
    for (const file of pendingPaths) assert.ok(fs.existsSync(file), `retry lost canonical artifact: ${file}`);
    process.stdout.write("writer-untracked-noncohort-ready\n");
    return;
  }

  if (process.env.SMOKE_PHASE === "writer-push-terminal") {
    const writer = jiti(path.join(root, "extensions/sediment/writer.ts"));
    const sedimentSettings = jiti(path.join(root, "extensions/sediment/settings.ts"));
    const headBefore = git(repo, ["rev-parse", "HEAD"]);
    const result = await writer.writeAbrainWorkflow({
      title: "Canonical terminal push preservation",
      trigger: "real nonretryable push preservation smoke",
      body: "This workflow body is long enough to pass deterministic validation and must remain after push rejection.",
      crossProject: true,
      sessionId: "canonical-terminal-push-smoke",
    }, {
      abrainHome: repo,
      settings: { ...sedimentSettings.DEFAULT_SEDIMENT_SETTINGS, gitCommit: true },
    });
    assert.equal(result.status, "created", JSON.stringify(result));
    assert.equal(result.publication?.status, "durable_pending", JSON.stringify(result.publication));
    assert.equal(result.publication?.localCommit, "index_converged", JSON.stringify(result.publication));
    assert.equal(result.publication?.pushStatus, "terminal", JSON.stringify(result.publication));
    assert.notEqual(result.gitCommit, headBefore, "writer did not publish local commit before terminal push");
    assert.equal(git(repo, ["rev-parse", "HEAD"]), result.gitCommit, "terminal push cleanup rewound HEAD");
    assert.ok(fs.existsSync(result.path), "terminal push cleanup unlinked the published worktree artifact");
    assert.match(fs.readFileSync(result.path, "utf8"), /Canonical terminal push preservation/);
    const terminalAudit = fs.readFileSync(path.join(repo, ".state", "git-sync.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(terminalAudit.some((row) => row.op === "canonical_push" && row.result === "terminal" && row.targetCommit === result.gitCommit), "terminal canonical push audit missing exact target");
    assert.ok(terminalAudit.some((row) => row.op === "writer_publication" && row.result === "durable_pending" && row.localCommit === "index_converged"), "terminal writer publication audit lost local state");
    process.stdout.write("writer-push-terminal-ready\n");
    return;
  }

  if (process.env.SMOKE_PHASE === "provenance-drift") {
    const sourceRoot = process.env.SMOKE_SOURCE_ROOT;
    const driftPath = path.join(sourceRoot, "extensions/_shared/jcs.ts");
    git(sourceRoot, ["add", "extensions/_shared/jcs.ts"]);
    git(sourceRoot, ["commit", "-m", "commit already-loaded source bytes"]);
    const afterHeadAdvance = await runtime.requestBacklogPreflight();
    assert.notEqual(afterHeadAdvance.status, "blocked", "source HEAD advancing to loaded bytes caused false provenance drift");
    fs.appendFileSync(driftPath, "\n// dependency drift fixture\n");
    await assert.rejects(() => runtime.requestBacklogPreflight(), /PROVENANCE_DRIFT/);
    process.stdout.write("provenance-drift-ready\n");
    return;
  }

  if (process.env.SMOKE_PHASE === "writer-blocked") {
    const writer = jiti(path.join(root, "extensions/sediment/writer.ts"));
    const sedimentSettings = jiti(path.join(root, "extensions/sediment/settings.ts"));
    const gitDir = git(repo, ["rev-parse", "--absolute-git-dir"]);
    const lockPath = path.join(gitDir, "index.lock");
    fs.writeFileSync(lockPath, "writer-blocked-smoke");
    const headBefore = git(repo, ["rev-parse", "HEAD"]);
    const result = await writer.writeAbrainWorkflow({
      title: "Canonical blocked writer",
      trigger: "canonical writer integration smoke",
      body: "This workflow body is long enough to pass deterministic validation.",
      crossProject: true,
      sessionId: "canonical-writer-smoke",
    }, {
      abrainHome: repo,
      settings: { ...sedimentSettings.DEFAULT_SEDIMENT_SETTINGS, gitCommit: true },
    });
    assert.equal(result.status, "created", JSON.stringify(result));
    assert.equal(result.gitCommit, null, "blocked writer falsely reported commit completion");
    assert.equal(result.publication?.status, "durable_pending", JSON.stringify(result.publication));
    assert.ok(fs.existsSync(result.path), "blocked canonical writer deleted its durable pending artifact");
    assert.equal(git(repo, ["rev-parse", "HEAD"]), headBefore, "blocked writer changed HEAD");
    const auditRows = fs.readFileSync(path.join(repo, ".state", "git-sync.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(auditRows.some((row) => row.op === "writer_publication" && row.result === "durable_pending"), "typed writer publication audit missing");
    assert.equal(fs.readFileSync(lockPath, "utf8"), "writer-blocked-smoke", "writer removed shared index.lock");
    process.stdout.write("writer-blocked-ready\n");
    return;
  }

  if (process.env.SMOKE_PHASE === "restart") {
    assert.ok(git(repo, ["ls-tree", "-r", "--name-only", "HEAD", "l1"]).includes("l1/events/sha256/"), "fresh process absorbed prior metadata tail");
    process.stdout.write("restart-ready\n");
    return;
  }

  if (process.env.SMOKE_PHASE === "tracked-delete-startup") {
    assert.ok(!git(repo, ["ls-tree", "-r", "--name-only", "HEAD", "l2/views/knowledge/latest/world"]).includes("ownership-proof.md"), "startup did not publish the tracked tombstone delete");
    const manifestPath = path.join(repo, "l2", "views", "knowledge", "latest", "manifest.json");
    const manifestProof = await runtimeModule.proveCanonicalArtifactOwnership({ abrainHome: repo, filePath: manifestPath });
    assert.equal(manifestProof.owner, "knowledge_l2");
    const syncModule = jiti(path.join(root, "extensions/abrain/git-sync.ts"));
    const synced = await syncModule.sync({ abrainHome: repo });
    assert.equal(synced.ok, true, JSON.stringify(synced));
    process.stdout.write("tracked-delete-startup-ready\n");
    return;
  }

  fs.writeFileSync(path.join(repo, "manual.txt"), "preserve staged\n");
  git(repo, ["add", "manual.txt"]);
  const stagedBefore = git(repo, ["ls-files", "--stage", "manual.txt"]);
  fs.mkdirSync(path.join(repo, "projects", "p", "knowledge"), { recursive: true });
  const firstPath = path.join(repo, "projects", "p", "knowledge", "first.md");
  fs.writeFileSync(firstPath, "first\n");
  process.env.GIT_INDEX_FILE = path.join(repo, "poison-index-that-must-not-be-used");
  const firstReceipt = await runtimeModule.createProducedArtifactReceipt({
    abrainHome: repo,
    filePath: firstPath,
    sourceIds: ["writer:smoke:first"],
  });
  const first = await runtime.requestDrain([firstReceipt], "smoke: first exact drain");
  delete process.env.GIT_INDEX_FILE;
  assert.equal(first.status, "index_converged");
  assert.equal(git(repo, ["show", "HEAD:projects/p/knowledge/first.md"]), "first");
  assert.equal(git(repo, ["ls-files", "--stage", "manual.txt"]), stagedBefore, "noncohort staged entry changed");
  assert.equal(fs.readFileSync(firstPath, "utf8"), "first\n", "worktree changed");
  const metadataAfterFirst = git(repo, ["status", "--porcelain=v1", "-uall", "--", "l1"]);
  assert.match(metadataAfterFirst, /l1\/events\/sha256\//, "same-repo metadata tail missing");

  const secondPath = path.join(repo, "projects", "p", "knowledge", "second.md");
  fs.writeFileSync(secondPath, "second\n");
  const secondReceipt = await runtimeModule.createProducedArtifactReceipt({ abrainHome: repo, filePath: secondPath, sourceIds: ["writer:smoke:second"] });
  const second = await runtime.requestDrain([secondReceipt], "smoke: second drain absorbs tail");
  assert.equal(second.status, "index_converged");
  assert.ok(git(repo, ["ls-tree", "-r", "--name-only", "HEAD", "l1"]).includes("l1/events/sha256/"), "next drain did not absorb metadata tail");

  const rogue = path.join(repo, "rogue.txt");
  fs.writeFileSync(rogue, "unowned\n");
  const blockedPath = path.join(repo, "projects", "p", "knowledge", "blocked.md");
  fs.writeFileSync(blockedPath, "blocked\n");
  const blockedReceipt = await runtimeModule.createProducedArtifactReceipt({ abrainHome: repo, filePath: blockedPath, sourceIds: ["writer:smoke:blocked"] });
  await assert.rejects(() => runtime.requestDrain([blockedReceipt]), /ARTIFACT_UNOWNED/);
  fs.rmSync(rogue);
  fs.rmSync(blockedPath);

  const pushed = await runtime.requestPush(second.commit);
  assert.equal(pushed.status, "success", pushed.reason);
  const contained = await runtime.requestPush(second.commit);
  assert.equal(contained.status, "success", contained.reason);
  assert.equal(contained.remoteContained, true);
  const pushAuditRows = fs.readFileSync(path.join(repo, ".state", "git-sync.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(pushAuditRows.some((row) => row.op === "canonical_push" && row.result === "success" && row.targetCommit === second.commit && row.episodeId), "successful canonical push audit missing episode/ref/target binding");
  const cycleRows = runtime.diagnostics().tail.filter((row) => row.operation === "transport_cycle");
  assert.ok(cycleRows.some((row) => row.publicOperation === "startup" && row.status === "closed"), "startup transport cycle did not close");
  assert.equal(cycleRows.filter((row) => row.publicOperation === "requestPush" && row.status === "opened").length, 2, "steady-state writes did not open independent transport cycles");
  assert.equal(cycleRows.filter((row) => row.publicOperation === "requestPush" && row.status === "closed").length, 2, "steady-state transport cycles did not close");
  const runtimeL1 = jiti(path.join(root, "extensions/_shared/l1-schema-registry.ts"));
  const runtimeRecords = (await runtimeL1.scanWholeL1Validated({ abrainHome: repo })).all;
  const steadyEpisodeIds = new Set(pushAuditRows.filter((row) => row.op === "canonical_push" && row.targetCommit === second.commit).map((row) => row.episodeId));
  assert.equal(runtimeRecords.some((record) => record.body?.event_type === "recovery_episode_terminal" && steadyEpisodeIds.has(record.body?.episode_id)), false, "post-startup steady-state push became terminal");
  const remoteOid = execFileSync("git", ["--git-dir", process.env.SMOKE_REMOTE, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim();
  assert.equal(remoteOid, second.commit, "target OID not remote-contained");
  assert.ok(runtime.diagnostics().tail.length <= 64, "diagnostic tail unbounded");
  // Leave a startup-valid repository for the fresh-process recovery test.
  git(repo, ["restore", "--staged", "manual.txt"]);
  fs.rmSync(path.join(repo, "manual.txt"));

  const splitSettings = path.join(path.dirname(settingsPath), "split-settings.json");
  fs.writeFileSync(splitSettings, `${JSON.stringify({ canonicalGitRuntime: { enabled: true, mode: "p1_controlled", transport: TEST_TRANSPORT_POLICY }, split: true })}\n`);
  await assert.rejects(
    () => runtimeModule.getCanonicalGitRuntime({ abrainHome: repo, settingsPath: splitSettings, sourceRoot: root }),
    /RUNTIME_PROVENANCE_SPLIT/,
  );
  process.stdout.write("primary-ready\n");
}

if (process.argv.includes("--worker")) {
  await worker();
} else {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-canonical-runtime-"));
  try {
    const runtimeModule = jiti(path.join(root, "extensions/_shared/canonical-git-runtime.ts"));
    const sharedParser = jiti(path.join(root, "extensions/_shared/git-z-parser.ts"));
    const disabled = settingsFile(base, false, "-disabled");
    const enabled = settingsFile(base, true, "-enabled");
    assert.equal(runtimeModule.resolveCanonicalGitRuntimeSettings(disabled).enabled, false);
    assert.equal(runtimeModule.resolveCanonicalGitRuntimeSettings(path.join(base, "missing.json")).valid, false);
    const invalid = path.join(base, "invalid.json");
    fs.writeFileSync(invalid, JSON.stringify({ canonicalGitRuntime: { enabled: true, mode: "wrong" } }));
    const settingsExtra = path.join(base, "settings-extra.json");
    fs.writeFileSync(settingsExtra, JSON.stringify({ canonicalGitRuntime: { enabled: true, mode: "p1_controlled", extra: true } }));
    const settingsMissing = path.join(base, "settings-missing-key.json");
    fs.writeFileSync(settingsMissing, JSON.stringify({ canonicalGitRuntime: { enabled: true } }));
    const settingsWrongType = path.join(base, "settings-wrong-type.json");
    fs.writeFileSync(settingsWrongType, JSON.stringify({ canonicalGitRuntime: { enabled: "true", mode: "p1_controlled" } }));
    const settingsBadComment = path.join(base, "settings-bad-comment.json");
    fs.writeFileSync(settingsBadComment, JSON.stringify({ canonicalGitRuntime: { enabled: true, mode: "p1_controlled", _comment: 1 } }));
    for (const file of [invalid, settingsExtra, settingsMissing, settingsWrongType, settingsBadComment]) {
      assert.equal(runtimeModule.resolveCanonicalGitRuntimeSettings(file).valid, false, `${path.basename(file)} must fail closed`);
      assert.throws(() => runtimeModule.canonicalGitRuntimeEnabled(file), (error) => error?.code === "CANONICAL_GIT_SETTINGS_INVALID");
    }
    assert.throws(() => runtimeModule.canonicalGitRuntimeEnabled(path.join(base, "missing.json")), (error) => error?.code === "CANONICAL_GIT_SETTINGS_INVALID");
    const unreadable = path.join(base, "settings-directory");
    fs.mkdirSync(unreadable);
    assert.throws(() => runtimeModule.canonicalGitRuntimeEnabled(unreadable), (error) => error?.code === "CANONICAL_GIT_SETTINGS_INVALID");
    const parsedRename = sharedParser.parseGitStatusPorcelainV1Z(Buffer.concat([
      Buffer.from("R  new-name.md\0old-name.md\0", "utf8"),
      Buffer.from("?? utf8-路径.md\0", "utf8"),
    ]));
    assert.deepEqual(parsedRename[0].paths, ["new-name.md", "old-name.md"]);
    assert.equal(parsedRename[1].path, "utf8-路径.md");
    assert.throws(() => sharedParser.parseGitStatusPorcelainV1Z(Buffer.from([0x3f, 0x3f, 0x20, 0xff, 0x00])), /GIT_PATH_UTF8_INVALID/);
    assert.throws(() => sharedParser.parseGitStatusPorcelainV1Z(Buffer.from("?? ../escape\0")), /GIT_PATH_NONCANONICAL/);

    const schema = JSON.parse(fs.readFileSync(path.join(root, "pi-astack-settings.schema.json"), "utf8"));
    assert.ok(schema.required.includes("canonicalGitRuntime"), "settings schema does not require the fail-closed canonical section");
    assert.equal(schema.properties.canonicalGitRuntime.additionalProperties, false);
    assert.deepEqual(schema.properties.canonicalGitRuntime.required.slice().sort(), ["enabled", "mode", "transport"]);
    assert.deepEqual(Object.keys(schema.properties.canonicalGitRuntime.properties).sort(), ["_comment", "enabled", "mode", "transport"]);
    const sourceRuntime = fs.readFileSync(path.join(root, "extensions/_shared/canonical-git-runtime.ts"), "utf8");
    const sourceWriter = fs.readFileSync(path.join(root, "extensions/sediment/writer.ts"), "utf8");
    const sourceSync = fs.readFileSync(path.join(root, "extensions/abrain/git-sync.ts"), "utf8");
    const sourceAbrain = fs.readFileSync(path.join(root, "extensions/abrain/index.ts"), "utf8");
    const sourceSediment = fs.readFileSync(path.join(root, "extensions/sediment/index.ts"), "utf8");
    const sourceRefresh = fs.readFileSync(path.join(root, "extensions/sediment/constraint-compiler/auto-refresh.ts"), "utf8");
    const sourceDossier = fs.readFileSync(path.join(root, "scripts/dossier-canonical-path-p1a.mjs"), "utf8");
    const sourceRecovery = fs.readFileSync(path.join(root, "extensions/_shared/convergence-recovery.ts"), "utf8");
    const sourceExactCohort = fs.readFileSync(path.join(root, "extensions/_shared/git-exact-cohort.ts"), "utf8");
    const dossierEvidence = jiti(path.join(root, "extensions/_shared/p1a-dossier-evidence.ts"));
    const fakeEvidenceErrors = dossierEvidence.validateP1ADossierExecutionEvidence({ headChanged: true, published: true });
    assert.ok(fakeEvidenceErrors.includes("candidate_missing") && fakeEvidenceErrors.includes("cohort_missing") && fakeEvidenceErrors.includes("remote_exact_convergence_missing"), "dossier accepted fake HEAD-change evidence");
    const sourceReconcile = fs.readFileSync(path.join(root, "extensions/abrain/reconcile-gate.ts"), "utf8");
    assert.match(sourceRuntime, /parser\.parseFrontmatter\(markdown\)/, "Knowledge L2 must use the existing frontmatter parser");
    assert.match(sourceRuntime, /renderKnowledgeProjectionFromSet\(nodes\)/, "Knowledge ownership must recompute the pure fold");
    assert.match(sourceRuntime, /renderConstraintL2View\(decision, latest\.eventId\)/, "Constraint ownership must recompute the pure renderer");
    assert.match(sourceRuntime, /tailFirst\.hash !== tailSecond\.hash/, "status freeze must compare two consecutive hashes");
    assert.match(sourceRuntime, /parseGitStatusPorcelainV1Z\(raw\)/, "runtime must use the shared Buffer parser");
    assert.match(sourceReconcile, /from "\.\.\/_shared\/git-z-parser"/, "reconcile must use the shared parser");
    assert.match(sourceDossier, /git-z-parser\.ts/, "dossier must use the shared parser");
    assert.match(sourceDossier, /P1-S2-curator-only/);
    assert.doesNotMatch(sourceDossier, /blockers\.push\("curator_adapter_blocked"\)/);
    assert.match(sourceDossier, /validateP1ADossierExecutionEvidence\(execution\)/);
    assert.doesNotMatch(sourceDossier, /localeCompare/, "P1-A dossier evidence ordering depends on the process locale");
    assert.doesNotMatch(sourceDossier, /\.sort\(\)/, "P1-A dossier evidence ordering uses an implicit comparator");
    for (const source of [sourceRecovery, sourceExactCohort]) {
      assert.match(source, /LANG:\s*"C"/);
      assert.match(source, /LC_ALL:\s*"C"/);
      assert.match(source, /!key\.startsWith\("GIT_"\)/, "Git environment scrub was removed");
    }
    const p1aSortValues = ["\uE000", "中", "😀", "ä", "Z"];
    const p1aLocaleOutputs = ["C", "en_US.utf8", "zh_CN.utf8"].map((locale) => spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--worker"], {
      env: { ...process.env, SMOKE_PHASE: "p1a-evidence-sort", SMOKE_P1A_SORT_VALUES: JSON.stringify(p1aSortValues), LANG: locale, LC_ALL: locale },
      encoding: "utf8",
      timeout: 30_000,
    }));
    for (const output of p1aLocaleOutputs) assert.equal(output.status, 0, `${output.stdout}\n${output.stderr}`);
    assert.ok(p1aLocaleOutputs.every((output) => output.stdout === p1aLocaleOutputs[0].stdout), "P1-A evidence order changed across locales");
    assert.deepEqual(JSON.parse(p1aLocaleOutputs[0].stdout), ["Z", "ä", "中", "😀", "\uE000"], "P1-A evidence order is not UTF-16 code-unit order");
    assert.doesNotMatch(sourceDossier, /toString\("utf8"\)\.split\("\\0"\)/, "dossier reimplemented a weak NUL parser");
    assert.match(sourceWriter, /if \(canonicalGitRuntimeEnabled\(\)\)/);
    assert.match(sourceSync, /if \(canonicalGitRuntimeEnabled\(\)\)/);
    assert.ok(sourceWriter.indexOf("if (canonicalGitRuntimeEnabled())") < sourceWriter.indexOf("gitCommitManyUnlocked"), "enabled writer path does not precede legacy add/commit path");
    assert.ok(sourceSync.indexOf("if (canonicalGitRuntimeEnabled())") < sourceSync.indexOf('["-C", opts.abrainHome, "push"'), "enabled push facade does not precede legacy push");
    assert.match(sourceSync, /canonical_fetch_merge_retired/, "enabled fetch/merge retirement guard missing");
    assert.match(sourceAbrain, /canonicalAutoCommitAbrainPaths/, "bind abrain cohort bypasses canonical receipts");
    assert.match(sourceAbrain, /canonicalBarrierReady/, "rule self-heal is not gated by the canonical startup barrier");
    assert.ok(sourceAbrain.indexOf("if (!canonicalModeEnabled) initializeAbrainRuntimeAfterBarrier()") < sourceAbrain.indexOf('eventRegistry.on("session_start"'), "disabled initialization boundary moved after session registration");
    assert.match(sourceAbrain, /canonicalBarrierReady = true;\s*initializeAbrainRuntimeAfterBarrier\(\);/s, "enabled initialization is not behind startup ready");
    assert.match(sourceSediment, /awaitStartup\(\)/, "sediment mutation hooks lack canonical startup barrier");
    assert.match(sourceRefresh, /publication_pending/, "constraint auto-refresh does not inspect publication outcome");
    assert.match(sourceWriter, /publication\.canonical === false\s*&& publication\.status === "terminal_before_publish"/, "canonical publication can still enter legacy cleanup");

    for (const kind of ["file", "symlink", "directory"]) {
      const fixture = initRepo(base, false).repo;
      const gitDir = git(fixture, ["rev-parse", "--absolute-git-dir"]);
      const lock = path.join(gitDir, "index.lock");
      if (kind === "file") fs.writeFileSync(lock, "owned elsewhere");
      else if (kind === "symlink") fs.symlinkSync(path.join(fixture, "missing-target"), lock);
      else fs.mkdirSync(lock);
      const headBefore = git(fixture, ["rev-parse", "HEAD"]);
      await assert.rejects(() => runtimeModule.preflightSharedIndexLock(fixture), /INDEX_LOCK_PRESENT/);
      assert.ok(fs.lstatSync(lock), `${kind} index.lock was removed`);
      assert.equal(git(fixture, ["rev-parse", "HEAD"]), headBefore, `${kind} lock allowed CAS`);
    }

    // Prepared slot crash window: create the lock in the hook immediately next
    // to update-ref CAS. Recovery must leave HEAD unchanged and preserve lock.
    const exact = jiti(path.join(root, "extensions/_shared/git-exact-cohort.ts"));
    const recovery = jiti(path.join(root, "extensions/_shared/convergence-recovery.ts"));
    const casFixture = initRepo(base, false).repo;
    const casHead = git(casFixture, ["rev-parse", "HEAD"]);
    const episodeId = recovery.drainEpisodeIdentity({ repo_id: "cas-lock-smoke", ref_name: "refs/heads/main", generation_anchor: "genesis" });
    const claim = await recovery.claimNextRecoverySlot({ abrainHome: casFixture, episodeId, lane: "drain" });
    assert.equal(claim.shouldExecute, true);
    const snapshot = await exact.snapshotIndexEntries(casFixture, ["cas-owned.md"]);
    const prepared = await exact.prepareExactCohortCommit({
      repo: casFixture,
      refName: "refs/heads/main",
      frozenCommit: casHead,
      plan: [{ path: "cas-owned.md", op: "put", content: "candidate\n" }],
      message: "cas lock smoke",
    });
    await recovery.recordDrainPrepared({ abrainHome: casFixture, episodeId, slot: claim.slot, prepared, frozenIndexSnapshot: snapshot });
    const casGitDir = git(casFixture, ["rev-parse", "--absolute-git-dir"]);
    const casLock = path.join(casGitDir, "index.lock");
    await assert.rejects(() => recovery.recoverDrainSlot({
      abrainHome: casFixture,
      episodeId,
      slot: claim.slot,
      prePublishCheck: async () => {
        fs.writeFileSync(casLock, "appeared-before-cas");
        await runtimeModule.preflightSharedIndexLock(casFixture);
      },
    }), /INDEX_LOCK_PRESENT/);
    assert.equal(git(casFixture, ["rev-parse", "HEAD"]), casHead, "index.lock appeared before CAS but ref changed");
    assert.equal(fs.readFileSync(casLock, "utf8"), "appeared-before-cas", "CAS preflight removed index.lock");

    // Same-repo post-CAS lock window: publication is durable, convergence is
    // retried on the same slot after lock removal, and no abort fact is emitted.
    fs.rmSync(casLock, { force: true });
    const postCasRepo = initRepo(base, true).repo;
    const postCasHead = git(postCasRepo, ["rev-parse", "HEAD"]);
    const postCasEpisode = recovery.drainEpisodeIdentity({ repo_id: "post-cas-lock-smoke", ref_name: "refs/heads/main", generation_anchor: "genesis" });
    const postCasClaim = await recovery.claimNextRecoverySlot({ abrainHome: postCasRepo, episodeId: postCasEpisode, lane: "drain" });
    fs.writeFileSync(path.join(postCasRepo, "post-cas.md"), "published\n");
    const postCasSnapshot = await exact.snapshotIndexEntries(postCasRepo, ["post-cas.md"]);
    const postCasPrepared = await exact.prepareExactCohortCommit({ repo: postCasRepo, refName: "refs/heads/main", frozenCommit: postCasHead, plan: [{ path: "post-cas.md", op: "put", content: "published\n" }], message: "post-CAS lock smoke" });
    await recovery.recordDrainPrepared({ abrainHome: postCasRepo, episodeId: postCasEpisode, slot: postCasClaim.slot, prepared: postCasPrepared, frozenIndexSnapshot: postCasSnapshot });
    const postCasLock = path.join(git(postCasRepo, ["rev-parse", "--absolute-git-dir"]), "index.lock");
    await assert.rejects(() => recovery.recoverDrainSlot({
      abrainHome: postCasRepo,
      episodeId: postCasEpisode,
      slot: postCasClaim.slot,
      preConvergeCheck: async () => { fs.writeFileSync(postCasLock, "post-cas-lock"); await runtimeModule.preflightSharedIndexLock(postCasRepo); },
    }), /INDEX_LOCK_PRESENT/);
    const postCasPending = recovery.foldRecoveryEvents(await recovery.readRecoveryEvents(postCasRepo, postCasEpisode, "drain")).get(postCasClaim.slot);
    assert.ok(postCasPending.published && !postCasPending.aborted && !postCasPending.converged, "post-CAS lock burned published slot");
    fs.rmSync(postCasLock, { force: true });
    const postCasRestart = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--worker"], {
      env: { ...process.env, SMOKE_REPO: postCasRepo, SMOKE_SETTINGS: enabled, PI_ASTACK_SETTINGS_PATH: enabled, SMOKE_PHASE: "restart" },
      encoding: "utf8",
      timeout: 180_000,
    });
    assert.equal(postCasRestart.status, 0, `${postCasRestart.stdout}\n${postCasRestart.stderr}`);
    const postCasRecovered = recovery.foldRecoveryEvents(await recovery.readRecoveryEvents(postCasRepo, postCasEpisode, "drain")).get(postCasClaim.slot);
    assert.ok(postCasRecovered.published && postCasRecovered.converged && !postCasRecovered.aborted, "startup did not retry the published same slot to index convergence");

    // Knowledge owner proofs cover exact complete-fold manifest bytes and a
    // real tracked tombstone drained by fresh-process startup.
    const knowledgeFixture = initRepo(base, true);
    const knowledgeRepo = knowledgeFixture.repo;
    const knowledge = jiti(path.join(root, "extensions/sediment/knowledge-evidence.ts"));
    const sedimentSettings = jiti(path.join(root, "extensions/sediment/settings.ts"));
    const knowledgeSettings = {
      ...sedimentSettings.DEFAULT_SEDIMENT_SETTINGS,
      knowledgeEvidenceEventWriter: { ...sedimentSettings.DEFAULT_SEDIMENT_SETTINGS.knowledgeEvidenceEventWriter, enabled: true, mode: "event_first" },
      knowledgeProjector: { ...sedimentSettings.DEFAULT_SEDIMENT_SETTINGS.knowledgeProjector, enabled: true, projectOnWrite: true, projectionMode: "topo", l2OutputRoot: "repo" },
    };
    const observed = await knowledge.appendKnowledgeEvidenceForWrite({
      abrainHome: knowledgeRepo,
      projectId: "unused",
      scope: "world",
      draft: { title: "Ownership proof", kind: "fact", compiledTruth: "# Ownership proof\n\nCanonical knowledge ownership fixture.", status: "active", confidence: 3, sessionId: "knowledge-owner-smoke" },
      result: { slug: "ownership-proof", path: path.join(knowledgeRepo, "knowledge", "ownership-proof.md"), status: "created" },
      settings: knowledgeSettings,
      sessionId: "knowledge-owner-smoke",
      operation: "create",
      createdAtUtc: "2026-07-11T00:00:00.000Z",
    });
    assert.ok(observed.append.ok && observed.projection?.ok, JSON.stringify(observed));
    const localeNodes = [
      { eventId: "1".repeat(64), body: { ...JSON.parse(JSON.stringify(observed.body)), created_at_utc: "2026-07-11T00:00:00.000Z", device_id: "z", causal_parents: [], payload: { ...observed.body.payload, slug: "locale-z", title: "Locale z" } } },
      { eventId: "2".repeat(64), body: { ...JSON.parse(JSON.stringify(observed.body)), created_at_utc: "2026-07-11T00:00:00.000Z", device_id: "ä", causal_parents: [], payload: { ...observed.body.payload, slug: "locale-ä", title: "Locale ä" } } },
    ];
    const localeOutputs = ["C", "en_US.UTF-8"].map((locale) => spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--worker"], {
      env: { ...process.env, SMOKE_PHASE: "locale-manifest", SMOKE_LOCALE_NODES: JSON.stringify(localeNodes), LANG: locale, LC_ALL: locale },
      encoding: "utf8",
      timeout: 30_000,
    }));
    for (const output of localeOutputs) assert.equal(output.status, 0, `${output.stdout}\n${output.stderr}`);
    assert.equal(localeOutputs[0].stdout, localeOutputs[1].stdout, "Knowledge topo/manifest bytes changed across process locales");
    const localeRendered = JSON.parse(localeOutputs[0].stdout);
    assert.deepEqual(localeRendered.topo, ["1".repeat(64), "2".repeat(64)], "Knowledge topo did not use UTF-16 code-unit order");
    assert.equal(localeRendered.manifest.winnerEventId, "2".repeat(64), "Knowledge global manifest winner did not use UTF-16 code-unit order");
    assert.match(localeRendered.manifest.json, /locale-ä/, "non-ASCII manifest fixture was not rendered exactly");

    const secondIdentity = await knowledge.appendKnowledgeEvidenceForWrite({
      abrainHome: knowledgeRepo,
      projectId: "unused",
      scope: "world",
      draft: { title: "Earlier second identity", kind: "fact", compiledTruth: "# Earlier second identity\n\nGlobal winner must not follow invocation order.", status: "active", confidence: 3, sessionId: "knowledge-owner-smoke" },
      result: { slug: "earlier-second-identity", path: path.join(knowledgeRepo, "knowledge", "earlier-second-identity.md"), status: "created" },
      settings: knowledgeSettings,
      sessionId: "knowledge-owner-smoke",
      operation: "create",
      createdAtUtc: "2026-07-10T23:59:00.000Z",
    });
    assert.ok(secondIdentity.append.ok && secondIdentity.projection?.ok, JSON.stringify(secondIdentity));
    const manifestBytes = fs.readFileSync(observed.projection.manifestPath, "utf8");
    const manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.latestEventId, observed.append.eventId, "manifest latestEventId followed invocation order instead of the deterministic global identity winner");
    assert.equal(manifest.updatedAtUtc, "2026-07-11T00:00:00.000Z", "manifest updatedAtUtc is not derived from the winner event");
    assert.equal(manifest.latestOutputPath, "latest/world/ownership-proof.md", "manifest persisted a checkout-dependent output path");
    assert.ok(!manifestBytes.includes(knowledgeRepo), "manifest bytes contain the absolute projection root");
    const allManifestNodes = await knowledge.collectAllKnowledgeEventNodes(knowledgeRepo);
    const manifestAtRootA = knowledge.renderKnowledgeProjectionManifestFromSet(allManifestNodes, "/tmp/checkout-a").json;
    const manifestAtRootB = knowledge.renderKnowledgeProjectionManifestFromSet(allManifestNodes, "/different/checkout-b").json;
    assert.equal(manifestAtRootA, manifestAtRootB, "identical nodes rendered different manifest bytes across checkout roots");
    let manifestProof = await runtimeModule.proveCanonicalArtifactOwnership({ abrainHome: knowledgeRepo, filePath: observed.projection.manifestPath });
    const entryProof = await runtimeModule.proveCanonicalArtifactOwnership({ abrainHome: knowledgeRepo, filePath: observed.projection.outputPath });
    assert.equal(manifestProof.owner, "knowledge_l2");
    assert.equal(manifestProof.sourceIds.length, 2, "manifest ownership did not bind the complete event set");
    assert.equal(entryProof.owner, "knowledge_l2");
    fs.writeFileSync(observed.projection.manifestPath, manifestBytes.replace("2026-07-11T00:00:00.000Z", "2026-07-11T00:00:00.001Z"));
    await assert.rejects(() => runtimeModule.proveCanonicalArtifactOwnership({ abrainHome: knowledgeRepo, filePath: observed.projection.manifestPath }), /KNOWLEDGE_MANIFEST_MISMATCH/);
    fs.writeFileSync(observed.projection.manifestPath, manifestBytes);
    git(knowledgeRepo, ["add", "l1", "l2"]);
    git(knowledgeRepo, ["commit", "-m", "tracked owned knowledge projection"]);
    git(knowledgeRepo, ["push", "origin", "main"]);

    const deleted = await knowledge.appendKnowledgeEvidenceForWrite({
      abrainHome: knowledgeRepo,
      projectId: "unused",
      scope: "world",
      draft: { title: "Ownership proof", kind: "fact", compiledTruth: "# Ownership proof\n\nDelete fixture.", status: "active", confidence: 3, sessionId: "knowledge-owner-smoke" },
      result: { slug: "ownership-proof", path: observed.projection.outputPath, status: "deleted" },
      settings: knowledgeSettings,
      sessionId: "knowledge-owner-smoke",
      operation: "delete",
      createdAtUtc: "2026-07-11T00:01:00.000Z",
    });
    assert.equal(deleted.projection?.status, "removed", JSON.stringify(deleted));
    const tombstoneProof = await runtimeModule.proveCanonicalArtifactOwnership({ abrainHome: knowledgeRepo, filePath: observed.projection.outputPath, op: "delete" });
    assert.equal(tombstoneProof.op, "delete");
    assert.equal(tombstoneProof.owner, "knowledge_l2");
    assert.match(git(knowledgeRepo, ["status", "--porcelain=v1", "-uall"]), /^ D l2\/views\/knowledge\/latest\/world\/ownership-proof\.md$/m, "fixture did not create a real tracked delete record");
    const trackedDeleteStartup = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--worker"], {
      env: { ...process.env, SMOKE_REPO: knowledgeRepo, SMOKE_SETTINGS: enabled, PI_ASTACK_SETTINGS_PATH: enabled, SMOKE_PHASE: "tracked-delete-startup" },
      encoding: "utf8",
      timeout: 180_000,
    });
    assert.equal(trackedDeleteStartup.status, 0, `${trackedDeleteStartup.stdout}\n${trackedDeleteStartup.stderr}`);
    assert.match(trackedDeleteStartup.stdout, /tracked-delete-startup-ready/);

    const ownershipScaleRepo = initRepo(base, false).repo;
    const l1Registry = jiti(path.join(root, "extensions/_shared/l1-schema-registry.ts"));
    for (let index = 0; index < 369; index += 1) {
      const body = JSON.parse(JSON.stringify(observed.body));
      body.created_at_utc = new Date(Date.parse("2026-07-11T03:00:00.000Z") + index).toISOString();
      body.producer_nonce = `ownership-scale-${index}`;
      body.payload.slug = `ownership-scale-${String(index).padStart(3, "0")}`;
      body.payload.title = `Ownership scale ${index}`;
      body.payload.compiled_truth = `# Ownership scale ${index}\n\nBatched ownership fixture ${index}.`;
      body.causal_parents = [];
      const eventId = l1Registry.canonicalL1BodyHash(body);
      const envelope = { schema: "knowledge-evidence-envelope/v1", canonicalization: "RFC8785-JCS", hash_alg: "sha256", event_id: eventId, body_hash: eventId, body };
      const file = l1Registry.expectedL1EventPath(ownershipScaleRepo, eventId);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, l1Registry.canonicalL1EnvelopeJson(envelope));
    }
    const scaleStarted = Date.now();
    const ownershipScale = await runtimeModule.buildCanonicalOwnershipContext({ abrainHome: ownershipScaleRepo });
    const scaleElapsed = Date.now() - scaleStarted;
    assert.equal(ownershipScale.instrumentation.wholeL1Scans, 1);
    assert.equal(ownershipScale.instrumentation.knowledgeIdentityCount, 369);
    assert.equal(ownershipScale.instrumentation.knowledgeFoldRenders, 369);
    assert.equal(ownershipScale.instrumentation.globalManifestRenders, 1);
    assert.equal(ownershipScale.instrumentation.headMembershipQueries, 1);
    assert.equal(ownershipScale.instrumentation.indexMembershipQueries, 1);
    assert.ok(scaleElapsed < 30_000, `369-event ownership context took ${scaleElapsed}ms`);

    const missingIntentRepo = initRepo(base, false).repo;
    const missingIntentEpisode = recovery.pushEpisodeIdentity({ repo_id: "missing-intent-smoke", remote: "origin", ref_name: "refs/heads/main", target_commit: git(missingIntentRepo, ["rev-parse", "HEAD"]) });
    const missingIntentClaim = await recovery.claimNextRecoverySlot({ abrainHome: missingIntentRepo, episodeId: missingIntentEpisode, lane: "push" });
    assert.equal(missingIntentClaim.shouldExecute, true);
    const missingIntentRuntime = await runtimeModule.getCanonicalGitRuntime({ abrainHome: missingIntentRepo, settingsPath: enabled, sourceRoot: root });
    const missingIntentStartup = await missingIntentRuntime.awaitStartup();
    assert.equal(missingIntentStartup.startup, "blocked");
    assert.match(missingIntentStartup.blockedReason, /PUSH_INTENT_MISSING/);

    const { repo, bare } = initRepo(base, true);
    const childEnv = { ...process.env, SMOKE_REPO: repo, SMOKE_REMOTE: bare, SMOKE_SETTINGS: enabled, PI_ASTACK_SETTINGS_PATH: enabled };
    const primary = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--worker"], { env: { ...childEnv, SMOKE_PHASE: "primary" }, encoding: "utf8", timeout: 180_000 });
    assert.equal(primary.status, 0, `${primary.stdout}\n${primary.stderr}`);
    assert.match(primary.stdout, /primary-ready/);
    const restart = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--worker"], { env: { ...childEnv, SMOKE_PHASE: "restart" }, encoding: "utf8", timeout: 180_000 });
    assert.equal(restart.status, 0, `${restart.stdout}\n${restart.stderr}`);
    assert.match(restart.stdout, /restart-ready/);

    const cleanSyncFixture = initRepo(base, true);
    const cleanSync = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--worker"], {
      env: { ...process.env, SMOKE_REPO: cleanSyncFixture.repo, SMOKE_REMOTE: cleanSyncFixture.bare, SMOKE_SETTINGS: enabled, PI_ASTACK_SETTINGS_PATH: enabled, SMOKE_PHASE: "git-sync", SMOKE_EXPECT_SYNC: "ok" },
      encoding: "utf8",
      timeout: 180_000,
    });
    assert.equal(cleanSync.status, 0, `${cleanSync.stdout}\n${cleanSync.stderr}`);
    assert.match(cleanSync.stdout, /git-sync-ok-ready/);

    const enabledWriterFixture = initRepo(base, true);
    const enabledWriters = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--worker"], {
      env: { ...process.env, SMOKE_REPO: enabledWriterFixture.repo, SMOKE_REMOTE: enabledWriterFixture.bare, SMOKE_SETTINGS: enabled, PI_ASTACK_SETTINGS_PATH: enabled, SMOKE_PHASE: "project-and-abrain-writers" },
      encoding: "utf8",
      timeout: 180_000,
    });
    assert.equal(enabledWriters.status, 0, `${enabledWriters.stdout}\n${enabledWriters.stderr}`);
    assert.match(enabledWriters.stdout, /project-and-abrain-writers-ready/);

    const constraintSuccessFixture = initRepo(base, true);
    const constraintSuccess = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--worker"], {
      env: { ...process.env, SMOKE_REPO: constraintSuccessFixture.repo, SMOKE_REMOTE: constraintSuccessFixture.bare, SMOKE_SETTINGS: enabled, PI_ASTACK_SETTINGS_PATH: enabled, SMOKE_PHASE: "constraint-auto-refresh", SMOKE_CONSTRAINT_MODE: "success" },
      encoding: "utf8",
      timeout: 180_000,
    });
    assert.equal(constraintSuccess.status, 0, `${constraintSuccess.stdout}\n${constraintSuccess.stderr}`);
    assert.match(constraintSuccess.stdout, /constraint-auto-refresh-success-ready/);

    const constraintDebounceFixture = initRepo(base, true);
    const constraintDebounce = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--worker"], {
      env: { ...process.env, SMOKE_REPO: constraintDebounceFixture.repo, SMOKE_REMOTE: constraintDebounceFixture.bare, SMOKE_SETTINGS: enabled, PI_ASTACK_SETTINGS_PATH: enabled, SMOKE_PHASE: "constraint-auto-refresh", SMOKE_CONSTRAINT_MODE: "debounce-success" },
      encoding: "utf8",
      timeout: 180_000,
    });
    assert.equal(constraintDebounce.status, 0, `${constraintDebounce.stdout}\n${constraintDebounce.stderr}`);
    assert.match(constraintDebounce.stdout, /constraint-auto-refresh-debounce-success-ready/);

    const constraintPendingFixture = initRepo(base, true);
    fs.writeFileSync(path.join(constraintPendingFixture.bare, "hooks", "pre-receive"), "#!/bin/sh\necho 'constraint pending fixture' >&2\nexit 1\n", { mode: 0o755 });
    const constraintPending = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--worker"], {
      env: { ...process.env, SMOKE_REPO: constraintPendingFixture.repo, SMOKE_REMOTE: constraintPendingFixture.bare, SMOKE_SETTINGS: enabled, PI_ASTACK_SETTINGS_PATH: enabled, SMOKE_PHASE: "constraint-auto-refresh", SMOKE_CONSTRAINT_MODE: "pending" },
      encoding: "utf8",
      timeout: 180_000,
    });
    assert.equal(constraintPending.status, 0, `${constraintPending.stdout}\n${constraintPending.stderr}`);
    assert.match(constraintPending.stdout, /constraint-auto-refresh-pending-ready/);

    const constraintMissingFixture = initRepo(base, true);
    const constraintMissing = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--worker"], {
      env: { ...process.env, SMOKE_REPO: constraintMissingFixture.repo, SMOKE_REMOTE: constraintMissingFixture.bare, SMOKE_SETTINGS: enabled, PI_ASTACK_SETTINGS_PATH: enabled, SMOKE_PHASE: "constraint-auto-refresh", SMOKE_CONSTRAINT_MODE: "missing-output" },
      encoding: "utf8",
      timeout: 180_000,
    });
    assert.equal(constraintMissing.status, 0, `${constraintMissing.stdout}\n${constraintMissing.stderr}`);
    assert.match(constraintMissing.stdout, /constraint-auto-refresh-missing-output-ready/);

    const noncohortWriterFixture = initRepo(base, true);
    const noncohortWriter = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--worker"], {
      env: { ...process.env, SMOKE_REPO: noncohortWriterFixture.repo, SMOKE_REMOTE: noncohortWriterFixture.bare, SMOKE_SETTINGS: enabled, PI_ASTACK_SETTINGS_PATH: enabled, SMOKE_PHASE: "writer-untracked-noncohort" },
      encoding: "utf8",
      timeout: 180_000,
    });
    assert.equal(noncohortWriter.status, 0, `${noncohortWriter.stdout}\n${noncohortWriter.stderr}`);
    assert.match(noncohortWriter.stdout, /writer-untracked-noncohort-ready/);

    const writerFixture = initRepo(base, true).repo;
    const writerBlocked = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--worker"], {
      env: { ...process.env, SMOKE_REPO: writerFixture, SMOKE_SETTINGS: enabled, PI_ASTACK_SETTINGS_PATH: enabled, SMOKE_PHASE: "writer-blocked" },
      encoding: "utf8",
      timeout: 180_000,
    });
    assert.equal(writerBlocked.status, 0, `${writerBlocked.stdout}\n${writerBlocked.stderr}`);
    assert.match(writerBlocked.stdout, /writer-blocked-ready/);

    const terminalFixture = initRepo(base, true);
    const preReceive = path.join(terminalFixture.bare, "hooks", "pre-receive");
    fs.writeFileSync(preReceive, "#!/bin/sh\necho 'protected branch terminal fixture' >&2\nexit 1\n", { mode: 0o755 });
    const terminalWriter = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--worker"], {
      env: { ...process.env, SMOKE_REPO: terminalFixture.repo, SMOKE_SETTINGS: enabled, PI_ASTACK_SETTINGS_PATH: enabled, SMOKE_PHASE: "writer-push-terminal" },
      encoding: "utf8",
      timeout: 180_000,
    });
    assert.equal(terminalWriter.status, 0, `${terminalWriter.stdout}\n${terminalWriter.stderr}`);
    assert.match(terminalWriter.stdout, /writer-push-terminal-ready/);
    const terminalEpisodeTarget = git(terminalFixture.repo, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(terminalFixture.repo, "target-different.txt"), "new HEAD must not bypass same-scope v2 terminal\n");
    git(terminalFixture.repo, ["add", "target-different.txt"]);
    git(terminalFixture.repo, ["commit", "-m", "advance HEAD after terminal"]);
    const terminalHeadBeforeRestart = git(terminalFixture.repo, ["rev-parse", "HEAD"]);
    assert.notEqual(terminalHeadBeforeRestart, terminalEpisodeTarget, "v2 target-different fixture did not advance HEAD");
    const terminalStatusBeforeRestart = git(terminalFixture.repo, ["status", "--porcelain=v1", "-uall"]);
    const terminalIndexPath = path.join(git(terminalFixture.repo, ["rev-parse", "--absolute-git-dir"]), "index");
    const terminalIndexBeforeRestart = fs.readFileSync(terminalIndexPath);
    const terminalRemoteBeforeRestart = execFileSync("git", ["--git-dir", terminalFixture.bare, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim();
    const terminalPushRowsBefore = fs.readFileSync(path.join(terminalFixture.repo, ".state", "git-sync.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse).filter((row) => row.op === "canonical_push").length;
    const terminalRestart = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--worker"], {
      env: { ...process.env, SMOKE_REPO: terminalFixture.repo, SMOKE_SETTINGS: enabled, PI_ASTACK_SETTINGS_PATH: enabled, SMOKE_PHASE: "startup-blocked" },
      encoding: "utf8",
      timeout: 180_000,
    });
    assert.equal(terminalRestart.status, 0, `${terminalRestart.stdout}\n${terminalRestart.stderr}`);
    assert.equal(git(terminalFixture.repo, ["rev-parse", "HEAD"]), terminalHeadBeforeRestart, "terminal startup changed HEAD");
    assert.equal(git(terminalFixture.repo, ["status", "--porcelain=v1", "-uall"]), terminalStatusBeforeRestart, "terminal startup changed worktree status");
    assert.deepEqual(fs.readFileSync(terminalIndexPath), terminalIndexBeforeRestart, "terminal startup changed index bytes");
    assert.equal(execFileSync("git", ["--git-dir", terminalFixture.bare, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim(), terminalRemoteBeforeRestart, "terminal startup changed remote");
    const terminalPushRowsAfter = fs.readFileSync(path.join(terminalFixture.repo, ".state", "git-sync.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse).filter((row) => row.op === "canonical_push").length;
    assert.equal(terminalPushRowsAfter, terminalPushRowsBefore, "terminal startup attempted a second push");

    const behindFixture = initRepo(base, true);
    const behindPeer = path.join(base, "remote-descendant-peer");
    execFileSync("git", ["clone", "-q", behindFixture.bare, behindPeer]);
    git(behindPeer, ["config", "user.name", "remote-smoke"]);
    git(behindPeer, ["config", "user.email", "remote-smoke@example.invalid"]);
    fs.writeFileSync(path.join(behindPeer, "remote-descendant.txt"), "remote descendant\n");
    git(behindPeer, ["add", "remote-descendant.txt"]);
    git(behindPeer, ["commit", "-m", "remote descendant"]);
    git(behindPeer, ["push", "origin", "HEAD:refs/heads/main"]);
    const startupBlocked = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--worker"], {
      env: { ...process.env, SMOKE_REPO: behindFixture.repo, SMOKE_SETTINGS: enabled, PI_ASTACK_SETTINGS_PATH: enabled, SMOKE_PHASE: "startup-blocked" },
      encoding: "utf8",
      timeout: 180_000,
    });
    assert.equal(startupBlocked.status, 0, `${startupBlocked.stdout}\n${startupBlocked.stderr}`);
    assert.match(startupBlocked.stdout, /startup-blocked-ready/);
    const behindSync = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--worker"], {
      env: { ...process.env, SMOKE_REPO: behindFixture.repo, SMOKE_SETTINGS: enabled, PI_ASTACK_SETTINGS_PATH: enabled, SMOKE_PHASE: "git-sync", SMOKE_EXPECT_SYNC: "blocked" },
      encoding: "utf8",
      timeout: 180_000,
    });
    assert.equal(behindSync.status, 0, `${behindSync.stdout}\n${behindSync.stderr}`);

    const divergedFixture = initRepo(base, true);
    const divergedPeer = path.join(base, "diverged-peer");
    execFileSync("git", ["clone", "-q", divergedFixture.bare, divergedPeer]);
    git(divergedPeer, ["config", "user.name", "remote-smoke"]);
    git(divergedPeer, ["config", "user.email", "remote-smoke@example.invalid"]);
    fs.writeFileSync(path.join(divergedPeer, "remote-side.txt"), "remote side\n");
    git(divergedPeer, ["add", "remote-side.txt"]);
    git(divergedPeer, ["commit", "-m", "remote side"]);
    git(divergedPeer, ["push", "origin", "HEAD:refs/heads/main"]);
    fs.writeFileSync(path.join(divergedFixture.repo, "local-side.txt"), "local side\n");
    git(divergedFixture.repo, ["add", "local-side.txt"]);
    git(divergedFixture.repo, ["commit", "-m", "local side"]);
    const divergedSync = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--worker"], {
      env: { ...process.env, SMOKE_REPO: divergedFixture.repo, SMOKE_SETTINGS: enabled, PI_ASTACK_SETTINGS_PATH: enabled, SMOKE_PHASE: "git-sync", SMOKE_EXPECT_SYNC: "blocked" },
      encoding: "utf8",
      timeout: 180_000,
    });
    assert.equal(divergedSync.status, 0, `${divergedSync.stdout}\n${divergedSync.stderr}`);

    const provenanceFixture = initRepo(base, true).repo;
    const sourceCopy = path.join(base, "provenance-source-copy");
    fs.cpSync(root, sourceCopy, {
      recursive: true,
      filter: (source) => !source.includes(`${path.sep}node_modules${path.sep}`) && !source.endsWith(`${path.sep}node_modules`) && !source.includes(`${path.sep}.git${path.sep}`) && !source.endsWith(`${path.sep}.git`),
    });
    git(sourceCopy, ["init", "-b", "main"]);
    git(sourceCopy, ["config", "user.name", "provenance-smoke"]);
    git(sourceCopy, ["config", "user.email", "provenance-smoke@example.invalid"]);
    git(sourceCopy, ["add", "."]);
    git(sourceCopy, ["commit", "-m", "baseline source"]);
    fs.appendFileSync(path.join(sourceCopy, "extensions/_shared/jcs.ts"), "\n// loaded source bytes awaiting commit\n");
    const provenanceDrift = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--worker"], {
      env: { ...process.env, SMOKE_REPO: provenanceFixture, SMOKE_SETTINGS: enabled, PI_ASTACK_SETTINGS_PATH: enabled, SMOKE_SOURCE_ROOT: sourceCopy, SMOKE_PHASE: "provenance-drift" },
      encoding: "utf8",
      timeout: 180_000,
    });
    assert.equal(provenanceDrift.status, 0, `${provenanceDrift.stdout}\n${provenanceDrift.stderr}`);
    assert.match(provenanceDrift.stdout, /provenance-drift-ready/);

    const maintenanceFixture = initRepo(base, true).repo;
    const maintenanceBlocked = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--worker"], {
      env: { ...process.env, SMOKE_REPO: maintenanceFixture, SMOKE_SETTINGS: enabled, PI_ASTACK_SETTINGS_PATH: enabled, SMOKE_PHASE: "maintenance-blocked" },
      encoding: "utf8",
      timeout: 180_000,
    });
    assert.equal(maintenanceBlocked.status, 0, `${maintenanceBlocked.stdout}\n${maintenanceBlocked.stderr}`);
    assert.match(maintenanceBlocked.stdout, /maintenance-blocked-ready/);

    for (const invalidSettingsPath of [path.join(base, "missing.json"), invalid, settingsExtra, settingsMissing, settingsWrongType, settingsBadComment, unreadable]) {
      const invalidFixture = initRepo(base, false).repo;
      const invalidBlocked = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--worker"], {
        env: { ...process.env, SMOKE_REPO: invalidFixture, SMOKE_SETTINGS: invalidSettingsPath, PI_ASTACK_SETTINGS_PATH: invalidSettingsPath, SMOKE_PHASE: "invalid-settings" },
        encoding: "utf8",
        timeout: 180_000,
      });
      assert.equal(invalidBlocked.status, 0, `${invalidBlocked.stdout}\n${invalidBlocked.stderr}`);
      assert.match(invalidBlocked.stdout, /invalid-settings-ready/);
    }

    const dossier = spawnSync(process.execPath, [path.join(root, "scripts/dossier-canonical-path-p1a.mjs"), "--abrain", repo, "--settings", disabled], { encoding: "utf8", timeout: 60_000 });
    assert.equal(dossier.status, 2, dossier.stderr);
    const report = JSON.parse(dossier.stdout);
    assert.equal(report.status, "preflight-blocked");
    assert.equal(report.mutationAttempted, false);
    assert.equal(report.stopReason, "kill_switch_disabled");

    const dossierProofRepo = initRepo(base, false).repo;
    const dossierProjection = await knowledge.appendKnowledgeEvidenceForWrite({
      abrainHome: dossierProofRepo,
      projectId: "unused",
      scope: "world",
      draft: { title: "Dossier ownership proof", kind: "fact", compiledTruth: "# Dossier ownership proof\n\nRead-only preflight must record concrete registry and renderer evidence.", status: "active", confidence: 8, sessionId: "dossier-proof" },
      result: { slug: "dossier-ownership-proof", path: path.join(dossierProofRepo, "knowledge", "dossier-ownership-proof.md"), status: "created" },
      settings: knowledgeSettings,
      sessionId: "dossier-proof",
      operation: "create",
      createdAtUtc: "2026-07-11T02:00:00.000Z",
    });
    assert.ok(dossierProjection.append.ok && dossierProjection.projection?.ok, JSON.stringify(dossierProjection));
    const dossierProof = spawnSync(process.execPath, [path.join(root, "scripts/dossier-canonical-path-p1a.mjs"), "--abrain", dossierProofRepo, "--settings", disabled], { encoding: "utf8", timeout: 60_000 });
    assert.equal(dossierProof.status, 2, dossierProof.stderr);
    const dossierProofReport = JSON.parse(dossierProof.stdout);
    assert.equal(dossierProofReport.mutationAttempted, false);
    assert.equal(dossierProofReport.preFreeze.statusStable, true);
    assert.equal(dossierProofReport.preFreeze.cohortStable, true);
    const l1DossierProof = dossierProofReport.ownershipPreflight.ownerProofs.find((proof) => proof.path.startsWith("l1/events/sha256/"));
    assert.equal(l1DossierProof?.proof?.kind, "l1_registry_validation", JSON.stringify(dossierProofReport.ownershipPreflight));
    assert.equal(l1DossierProof?.proof?.envelopeSchema, "knowledge-evidence-envelope/v1");
    assert.equal(l1DossierProof?.proof?.producer?.name, "sediment.knowledge-event-writer");
    const l2DossierProofs = dossierProofReport.ownershipPreflight.ownerProofs.filter((proof) => proof.owner === "knowledge_l2");
    assert.ok(l2DossierProofs.length === 2 && l2DossierProofs.every((proof) => proof.proof?.kind === "l2_exact_recompute" && proof.proof.exactByteEqualAccepted === true), JSON.stringify(l2DossierProofs));
    assert.ok(l2DossierProofs.some((proof) => proof.proof.renderer.includes("complete-identity-fold")), "dossier omitted the manifest complete-fold recompute proof");

    const dossierExecuteFixture = initRepo(base, true);
    fs.writeFileSync(path.join(dossierExecuteFixture.repo, "noncohort-staged.txt"), "preserve dossier noncohort\n");
    git(dossierExecuteFixture.repo, ["add", "noncohort-staged.txt"]);
    const dossierNonCohortIndex = git(dossierExecuteFixture.repo, ["ls-files", "--stage", "noncohort-staged.txt"]);
    const dossierNonCohortBytes = fs.readFileSync(path.join(dossierExecuteFixture.repo, "noncohort-staged.txt"), "utf8");
    const dossierOwned = await knowledge.appendKnowledgeEvidenceForWrite({
      abrainHome: dossierExecuteFixture.repo,
      projectId: "unused",
      scope: "world",
      draft: { title: "Dossier execute owned cohort", kind: "fact", compiledTruth: "# Dossier execute owned cohort\n\nReal execute evidence fixture.", status: "active", confidence: 8, sessionId: "dossier-execute" },
      result: { slug: "dossier-execute-owned-cohort", path: path.join(dossierExecuteFixture.repo, "knowledge", "dossier-execute-owned-cohort.md"), status: "created" },
      settings: knowledgeSettings,
      sessionId: "dossier-execute",
      operation: "create",
      createdAtUtc: "2026-07-11T04:00:00.000Z",
    });
    assert.ok(dossierOwned.append.ok && dossierOwned.projection?.ok, JSON.stringify(dossierOwned));
    const dossierExecute = spawnSync(process.execPath, [path.join(root, "scripts/dossier-canonical-path-p1a.mjs"), "--abrain", dossierExecuteFixture.repo, "--settings", enabled, "--execute"], {
      env: { ...process.env, PI_ASTACK_SETTINGS_PATH: enabled },
      encoding: "utf8",
      timeout: 180_000,
    });
    assert.equal(dossierExecute.status, 0, `${dossierExecute.stdout}\n${dossierExecute.stderr}`);
    const dossierExecuteReport = JSON.parse(dossierExecute.stdout);
    assert.equal(dossierExecuteReport.status, "acceptance", JSON.stringify(dossierExecuteReport.execution));
    assert.equal(dossierExecuteReport.mutationAttempted, true);
    assert.match(dossierExecuteReport.execution.candidate, /^[0-9a-f]{40,64}$/);
    assert.match(dossierExecuteReport.execution.cohortManifestRoot, /^[0-9a-f]{64}$/);
    assert.equal(dossierExecuteReport.execution.validation.exactCandidatePublished, true);
    assert.equal(dossierExecuteReport.execution.validation.exactCohortBound, true);
    assert.equal(dossierExecuteReport.execution.validation.exactIndexConverged, true);
    assert.equal(dossierExecuteReport.execution.remote.ahead, 0);
    assert.equal(dossierExecuteReport.execution.remote.behind, 0);
    assert.equal(dossierExecuteReport.execution.validation.nonCohortIndexAndWorktreePreserved, true);
    assert.equal(dossierExecuteReport.artifactVerification?.ok, true, JSON.stringify(dossierExecuteReport.artifactVerification));
    assert.match(dossierExecuteReport.artifactVerification?.reportExactSha256 ?? "", /^[0-9a-f]{64}$/);
    assert.equal(dossierEvidence.computeP1ADossierReportExactHash(dossierExecuteReport), dossierExecuteReport.artifactVerification.reportExactSha256, "dossier report payload hash is not exact/recomputable");
    const forgedCandidateReport = JSON.parse(JSON.stringify(dossierExecuteReport));
    delete forgedCandidateReport.artifactVerification;
    forgedCandidateReport.execution.candidate = "f".repeat(40);
    const forgedCandidateVerification = await dossierEvidence.verifyP1ADossierExecutionArtifact({
      abrainHome: dossierExecuteFixture.repo,
      report: forgedCandidateReport,
      expectedReportExactSha256: dossierEvidence.computeP1ADossierReportExactHash(forgedCandidateReport),
    });
    assert.equal(forgedCandidateVerification.ok, false, "artifact verifier accepted a forged candidate with self-consistent report hash");
    assert.ok(forgedCandidateVerification.errors.some((error) => /candidate|published|converged|head|remote/.test(error)), JSON.stringify(forgedCandidateVerification));
    const forgedCohortPathsReport = JSON.parse(JSON.stringify(dossierExecuteReport));
    delete forgedCohortPathsReport.artifactVerification;
    forgedCohortPathsReport.execution.cohortPaths = [...forgedCohortPathsReport.execution.cohortPaths, "l2/forged-path.md"].sort(dossierEvidence.compareUtf16CodeUnits);
    const forgedCohortPathsVerification = await dossierEvidence.verifyP1ADossierExecutionArtifact({
      abrainHome: dossierExecuteFixture.repo,
      report: forgedCohortPathsReport,
      expectedReportExactSha256: dossierEvidence.computeP1ADossierReportExactHash(forgedCohortPathsReport),
    });
    assert.equal(forgedCohortPathsVerification.ok, false, "artifact verifier accepted a forged cohort path list with self-consistent report hash");
    assert.ok(forgedCohortPathsVerification.errors.includes("cohort_paths_mismatch"), JSON.stringify(forgedCohortPathsVerification));
    const forgedBooleanReport = JSON.parse(JSON.stringify(dossierExecuteReport));
    forgedBooleanReport.execution.validation.headIsCandidate = false;
    const forgedBooleanVerification = await dossierEvidence.verifyP1ADossierExecutionArtifact({
      abrainHome: dossierExecuteFixture.repo,
      report: forgedBooleanReport,
      expectedReportExactSha256: dossierExecuteReport.artifactVerification.reportExactSha256,
    });
    assert.equal(forgedBooleanVerification.ok, false, "artifact verifier accepted a forged validation boolean");
    assert.ok(forgedBooleanVerification.errors.includes("report_exact_hash_mismatch"), JSON.stringify(forgedBooleanVerification));
    assert.equal(git(dossierExecuteFixture.repo, ["ls-files", "--stage", "noncohort-staged.txt"]), dossierNonCohortIndex);
    assert.equal(fs.readFileSync(path.join(dossierExecuteFixture.repo, "noncohort-staged.txt"), "utf8"), dossierNonCohortBytes);
    assert.ok(!git(dossierExecuteFixture.repo, ["ls-tree", "-r", "--name-only", "HEAD"]).includes("noncohort-staged.txt"));

    const dossierRemoteFailureFixture = initRepo(base, true);
    git(dossierRemoteFailureFixture.repo, ["remote", "set-url", "origin", path.join(base, "missing-remote.git")]);
    const dossierRemoteFailure = spawnSync(process.execPath, [path.join(root, "scripts/dossier-canonical-path-p1a.mjs"), "--abrain", dossierRemoteFailureFixture.repo, "--settings", disabled], { encoding: "utf8", timeout: 60_000 });
    assert.equal(dossierRemoteFailure.status, 2, dossierRemoteFailure.stderr);
    const dossierRemoteFailureReport = JSON.parse(dossierRemoteFailure.stdout);
    assert.equal(dossierRemoteFailureReport.preFreeze.remoteStable, false, "null remote advertisements were treated as stable");
    assert.ok(dossierRemoteFailureReport.blockers.includes("remote_advertisement_unavailable"), JSON.stringify(dossierRemoteFailureReport.blockers));
    assert.match(dossierRemoteFailureReport.before.remote.advertisementErrorSha256, /^[0-9a-f]{64}$/, "remote query failure did not record an error hash");
    assert.equal(dossierRemoteFailureReport.before.remote.mainAdvertisementSha256, null);

    const dossierTerminalFixture = initRepo(base, true);
    const dossierTerminalOwned = await knowledge.appendKnowledgeEvidenceForWrite({
      abrainHome: dossierTerminalFixture.repo,
      projectId: "unused",
      scope: "world",
      draft: { title: "Dossier terminal after startup", kind: "fact", compiledTruth: "# Dossier terminal after startup\n\nA terminal episode appearing after startup must reject execute acceptance.", status: "active", confidence: 8, sessionId: "dossier-terminal" },
      result: { slug: "dossier-terminal-after-startup", path: path.join(dossierTerminalFixture.repo, "knowledge", "dossier-terminal-after-startup.md"), status: "created" },
      settings: knowledgeSettings,
      sessionId: "dossier-terminal",
      operation: "create",
      createdAtUtc: "2026-07-11T04:00:30.000Z",
    });
    assert.ok(dossierTerminalOwned.append.ok && dossierTerminalOwned.projection?.ok, JSON.stringify(dossierTerminalOwned));
    const terminalBarrierDir = path.join(base, "dossier-terminal-after-startup-barrier");
    const dossierTerminalChild = spawn(process.execPath, [path.join(root, "scripts/dossier-canonical-path-p1a.mjs"), "--abrain", dossierTerminalFixture.repo, "--settings", enabled, "--execute"], {
      env: { ...process.env, PI_ASTACK_SETTINGS_PATH: enabled, PI_ASTACK_ENABLE_TEST_HOOKS: "1", PI_ASTACK_DOSSIER_POST_EXECUTE_TEST_BARRIER: terminalBarrierDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let dossierTerminalStdout = "";
    let dossierTerminalStderr = "";
    dossierTerminalChild.stdout.setEncoding("utf8");
    dossierTerminalChild.stderr.setEncoding("utf8");
    dossierTerminalChild.stdout.on("data", (chunk) => { dossierTerminalStdout += chunk; });
    dossierTerminalChild.stderr.on("data", (chunk) => { dossierTerminalStderr += chunk; });
    const terminalBarrierDeadline = Date.now() + 30_000;
    while (!fs.existsSync(path.join(terminalBarrierDir, "ready"))) {
      if (Date.now() >= terminalBarrierDeadline) throw new Error("timed out waiting for terminal-after-startup dossier barrier");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const terminalEpisodeId = recovery.drainEpisodeIdentity({ repo_id: "terminal-after-startup-smoke", ref_name: "refs/heads/main", generation_anchor: "terminal-after-startup" });
    await recovery.claimRecoverySlot({ abrainHome: dossierTerminalFixture.repo, episodeId: terminalEpisodeId, lane: "drain", slot: 1 });
    await recovery.appendRecoveryEvent({
      abrainHome: dossierTerminalFixture.repo,
      episodeId: terminalEpisodeId,
      lane: "drain",
      slot: 1,
      eventType: "recovery_episode_terminal",
      body: { reason: "owner_intervention_required", owner_alert: true },
    });
    fs.writeFileSync(path.join(terminalBarrierDir, "continue"), "continue\n");
    const dossierTerminalExit = await new Promise((resolve, reject) => {
      dossierTerminalChild.once("error", reject);
      dossierTerminalChild.once("close", (code) => resolve(code));
    });
    assert.equal(dossierTerminalExit, 2, dossierTerminalStderr);
    const dossierTerminalReport = JSON.parse(dossierTerminalStdout);
    assert.equal(dossierTerminalReport.execution.validation.recoveryClosed, false, "post-startup terminal episode did not reopen recovery");
    assert.ok(dossierTerminalReport.after.recovery.terminal.some((item) => item.episodeId === terminalEpisodeId), JSON.stringify(dossierTerminalReport.after.recovery));
    assert.equal(dossierTerminalReport.status, "preflight-blocked", "terminal-after-startup execute was accepted");

    const dossierNonCohortFixture = initRepo(base, true);
    const dossierNonCohortPath = path.join(dossierNonCohortFixture.repo, "noncohort-staged.txt");
    fs.writeFileSync(dossierNonCohortPath, "noncohort before execute\n");
    git(dossierNonCohortFixture.repo, ["add", "noncohort-staged.txt"]);
    const dossierNonCohortOwned = await knowledge.appendKnowledgeEvidenceForWrite({
      abrainHome: dossierNonCohortFixture.repo,
      projectId: "unused",
      scope: "world",
      draft: { title: "Dossier noncohort rejection", kind: "fact", compiledTruth: "# Dossier noncohort rejection\n\nRemote contains candidate but noncohort drift rejects.", status: "active", confidence: 8, sessionId: "dossier-noncohort" },
      result: { slug: "dossier-noncohort-rejection", path: path.join(dossierNonCohortFixture.repo, "knowledge", "dossier-noncohort-rejection.md"), status: "created" },
      settings: knowledgeSettings,
      sessionId: "dossier-noncohort",
      operation: "create",
      createdAtUtc: "2026-07-11T04:01:00.000Z",
    });
    assert.ok(dossierNonCohortOwned.append.ok && dossierNonCohortOwned.projection?.ok, JSON.stringify(dossierNonCohortOwned));
    const postBarrierDir = path.join(base, "dossier-post-execute-barrier");
    const dossierNonCohortChild = spawn(process.execPath, [path.join(root, "scripts/dossier-canonical-path-p1a.mjs"), "--abrain", dossierNonCohortFixture.repo, "--settings", enabled, "--execute"], {
      env: { ...process.env, PI_ASTACK_SETTINGS_PATH: enabled, PI_ASTACK_ENABLE_TEST_HOOKS: "1", PI_ASTACK_DOSSIER_POST_EXECUTE_TEST_BARRIER: postBarrierDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let dossierNonCohortStdout = "";
    let dossierNonCohortStderr = "";
    dossierNonCohortChild.stdout.setEncoding("utf8");
    dossierNonCohortChild.stderr.setEncoding("utf8");
    dossierNonCohortChild.stdout.on("data", (chunk) => { dossierNonCohortStdout += chunk; });
    dossierNonCohortChild.stderr.on("data", (chunk) => { dossierNonCohortStderr += chunk; });
    const postBarrierDeadline = Date.now() + 30_000;
    while (!fs.existsSync(path.join(postBarrierDir, "ready"))) {
      if (Date.now() >= postBarrierDeadline) throw new Error("timed out waiting for dossier post-execute barrier");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    fs.writeFileSync(dossierNonCohortPath, "noncohort changed after remote publication\n");
    fs.writeFileSync(path.join(postBarrierDir, "continue"), "continue\n");
    const dossierNonCohortExit = await new Promise((resolve, reject) => {
      dossierNonCohortChild.once("error", reject);
      dossierNonCohortChild.once("close", (code) => resolve(code));
    });
    assert.equal(dossierNonCohortExit, 2, dossierNonCohortStderr);
    const dossierNonCohortReport = JSON.parse(dossierNonCohortStdout);
    assert.equal(dossierNonCohortReport.execution.remote.remoteContained, true);
    assert.equal(dossierNonCohortReport.execution.validation.nonCohortIndexAndWorktreePreserved, false);
    assert.equal(dossierNonCohortReport.status, "preflight-blocked");

    const toctouRepo = initRepo(base, false).repo;
    const barrierDir = path.join(base, "dossier-toctou-barrier");
    const dossierChild = spawn(process.execPath, [path.join(root, "scripts/dossier-canonical-path-p1a.mjs"), "--abrain", toctouRepo, "--settings", disabled], {
      env: { ...process.env, PI_ASTACK_ENABLE_TEST_HOOKS: "1", PI_ASTACK_DOSSIER_TEST_BARRIER: barrierDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let dossierStdout = "";
    let dossierStderr = "";
    dossierChild.stdout.setEncoding("utf8");
    dossierChild.stderr.setEncoding("utf8");
    dossierChild.stdout.on("data", (chunk) => { dossierStdout += chunk; });
    dossierChild.stderr.on("data", (chunk) => { dossierStderr += chunk; });
    const barrierDeadline = Date.now() + 10_000;
    while (!fs.existsSync(path.join(barrierDir, "ready"))) {
      if (Date.now() >= barrierDeadline) throw new Error("timed out waiting for dossier TOCTOU barrier");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    fs.writeFileSync(path.join(toctouRepo, "concurrent-change.txt"), "HEAD changed during ownership freeze\n");
    git(toctouRepo, ["add", "concurrent-change.txt"]);
    git(toctouRepo, ["commit", "-m", "concurrent HEAD change"]);
    fs.writeFileSync(path.join(barrierDir, "continue"), "continue\n");
    const dossierExit = await new Promise((resolve, reject) => {
      dossierChild.once("error", reject);
      dossierChild.once("close", (code) => resolve(code));
    });
    assert.equal(dossierExit, 2, dossierStderr);
    const toctouReport = JSON.parse(dossierStdout);
    assert.equal(toctouReport.mutationAttempted, false);
    assert.equal(toctouReport.preFreeze.headStable, false, "dossier accepted a HEAD TOCTOU injection");
    assert.ok(toctouReport.blockers.includes("pre_execute_freeze_drift"), "dossier did not report the HEAD freeze drift blocker");

    console.log("smoke-canonical-git-runtime: PASS");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}
