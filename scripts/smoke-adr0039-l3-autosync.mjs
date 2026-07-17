#!/usr/bin/env node
/**
 * Smoke: ADR0039 L3 SQLite auto-sync after Knowledge L2 writes.
 *
 * Uses only temporary abrain fixtures. It verifies the post-write hook resolves
 * the current Knowledge L2 root from settings (including repo mode), that the
 * explicit MEMORY lane is wired to the hook, and that reprojectAllKnowledge
 * refreshes L3 after writing manifest.json.
 */

import { createRequire } from "node:module";
import { createJiti } from "jiti";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

if (!process.versions.sqlite) {
  throw new Error("node:sqlite is required for ADR0039 L3 autosync smoke");
}

const { DatabaseSync } = require("node:sqlite");
const failures = [];
let total = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message || "assertion failed");
}

async function check(name, fn) {
  total += 1;
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err && err.message ? err.message : err}`);
  }
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function transpile(srcPath) {
  const out = ts.transpileModule(fs.readFileSync(srcPath, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      esModuleInterop: true,
      skipLibCheck: true,
    },
  }).outputText;
  new (require("node:vm").Script)(out, { filename: srcPath });
  return out;
}

function stageTs(outRoot, src, dst = src.replace(/^extensions\//, "").replace(/\.ts$/, ".js")) {
  writeFile(path.join(outRoot, dst), transpile(path.join(repoRoot, src)));
}

function loadKnowledgeModule() {
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adr0039-l3-autosync-mod-"));
  stageTs(outRoot, "extensions/_shared/durable-write.ts");
  stageTs(outRoot, "extensions/_shared/jcs.ts");
  stageTs(outRoot, "extensions/_shared/proposition.ts");
  stageTs(outRoot, "extensions/_shared/l1-schema-registry.ts");
  fs.mkdirSync(path.join(outRoot, "schemas"), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "schemas", "l1-schema-role-registry.json"), path.join(outRoot, "schemas", "l1-schema-role-registry.json"));
  stageTs(outRoot, "extensions/memory/settings.ts");
  stageTs(outRoot, "extensions/memory/utils.ts");
  stageTs(outRoot, "extensions/sediment/adr0039-l3.ts");
  stageTs(outRoot, "extensions/sediment/knowledge-evidence.ts");
  return createRequire(path.join(outRoot, "runner.cjs"))("./sediment/knowledge-evidence.js");
}

const km = loadKnowledgeModule();
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const sedimentIndex = await jiti.import(path.join(repoRoot, "extensions/sediment/index.ts"));
const sedimentSettingsModule = await jiti.import(path.join(repoRoot, "extensions/sediment/settings.ts"));
const piAiCompat = await import("@earendil-works/pi-ai/compat");

function settings(projectOnWrite) {
  return {
    knowledgeEvidenceEventWriter: {
      enabled: true,
      mode: "parallel_legacy",
      legacyFallbackOnEventFailure: true,
    },
    knowledgeProjector: {
      enabled: true,
      hotOverlayEnabled: true,
      projectOnWrite,
      maxReadBytes: 1000000,
      l2OutputRoot: "repo",
      projectionMode: "single",
    },
  };
}

async function appendKnowledgeFixture(abrainHome, opts = {}) {
  const projectOnWrite = opts.projectOnWrite !== false;
  const slug = opts.slug || "adr0039-l3-autosync-fixture";
  const result = await km.appendKnowledgeEvidenceForWrite({
    abrainHome,
    projectId: "pi-global",
    scope: "project",
    draft: {
      title: opts.title || "ADR0039 L3 Autosync Fixture",
      kind: "fact",
      status: "active",
      provenance: "assistant-observed",
      confidence: 8,
      compiledTruth: `# ${opts.title || "ADR0039 L3 Autosync Fixture"}\n\n${opts.body || "Fixture projection for L3 autosync."}`,
      triggerPhrases: ["adr0039 l3 autosync"],
      derivesFrom: [],
      sessionId: "smoke-adr0039-l3-autosync",
    },
    result: {
      slug,
      path: path.join(abrainHome, "projects", "pi-global", "facts", `${slug}.md`),
      status: "created",
      gitCommit: null,
    },
    settings: settings(projectOnWrite),
    auditContext: { lane: "smoke", sessionId: "smoke-adr0039-l3-autosync" },
    sessionId: "smoke-adr0039-l3-autosync",
    operation: "create",
    createdAtUtc: opts.createdAtUtc || "2026-07-04T00:00:00.000Z",
  });
  assert(result.append.ok, `append failed: ${JSON.stringify(result.append)}`);
  if (projectOnWrite) assert(result.projection?.status === "projected", `projection failed: ${JSON.stringify(result.projection)}`);
  return result;
}

function dbPath(abrainHome) {
  return path.join(abrainHome, ".state", "sediment", "adr0039-l3", "adr0039.sqlite");
}

function makeAutoWriteSettings() {
  return {
    ...sedimentSettingsModule.DEFAULT_SEDIMENT_SETTINGS,
    enabled: true,
    gitCommit: false,
    autoLlmWriteEnabled: true,
    extractorModel: "faux/faux-1",
    extractorTimeoutMs: 1000,
    extractorMaxRetries: 0,
    curatorModel: "faux/faux-1",
    curatorTimeoutMs: 1000,
    curatorMaxRetries: 0,
    rulesAsReadonlyNeighborsEnabled: false,
    multiView: {
      ...sedimentSettingsModule.DEFAULT_SEDIMENT_SETTINGS.multiView,
      reviewAllMutations: false,
    },
    knowledgeEvidenceEventWriter: {
      enabled: true,
      mode: "parallel_legacy",
      legacyFallbackOnEventFailure: true,
      legacyMarkdownWriteOnSuccessfulEvent: true,
    },
    knowledgeProjector: {
      ...sedimentSettingsModule.DEFAULT_SEDIMENT_SETTINGS.knowledgeProjector,
      enabled: true,
      hotOverlayEnabled: true,
      projectOnWrite: true,
      maxReadBytes: 1000000,
      l2OutputRoot: "repo",
      projectionMode: "single",
    },
  };
}

async function withAbrainRoot(abrainHome, fn) {
  const previous = process.env.ABRAIN_ROOT;
  process.env.ABRAIN_ROOT = abrainHome;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.ABRAIN_ROOT;
    else process.env.ABRAIN_ROOT = previous;
  }
}

function readDbSummary(abrainHome) {
  const db = new DatabaseSync(dbPath(abrainHome), { readOnly: true });
  try {
    const count = (table) => Number(db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get().cnt);
    const searchRow = db.prepare("SELECT slug, title, file_path FROM search_corpus ORDER BY row_id LIMIT 1").get();
    const l2Row = db.prepare("SELECT view_id, file_path FROM l2_views ORDER BY view_id LIMIT 1").get();
    return {
      jobs: count("jobs"),
      l2Views: count("l2_views"),
      searchCorpus: count("search_corpus"),
      projectorState: count("projector_state"),
      searchRow,
      l2Row,
    };
  } finally {
    db.close();
  }
}

function assertRepoRootRows(summary, slug) {
  assert(summary.jobs === 1, `expected one L3 job, got ${summary.jobs}`);
  assert(summary.l2Views === 1, `expected one l2_views row, got ${summary.l2Views}`);
  assert(summary.searchCorpus === 1, `expected one search_corpus row, got ${summary.searchCorpus}`);
  assert(summary.projectorState === 1, `expected one projector_state row, got ${summary.projectorState}`);
  assert(summary.searchRow?.slug === slug, `unexpected search slug: ${JSON.stringify(summary.searchRow)}`);
  assert(String(summary.searchRow.file_path).startsWith("l2/views/knowledge/latest/projects/pi-global/"), `search row used wrong L2 root: ${summary.searchRow.file_path}`);
  assert(String(summary.l2Row.file_path).startsWith("l2/views/knowledge/latest/projects/pi-global/"), `l2 view used wrong L2 root: ${summary.l2Row.file_path}`);
}

console.log("ADR0039 L3 autosync smoke");

await check("explicit MEMORY Lane A source calls L3 sync after write results", async () => {
  const src = fs.readFileSync(path.join(repoRoot, "extensions/sediment/index.ts"), "utf8");
  const laneStart = src.indexOf("// ── Lane A (MEMORY:)");
  const laneEnd = src.indexOf("// ── Lane G (MEMORY-ABOUT-ME:)", laneStart);
  assert(laneStart >= 0 && laneEnd > laneStart, "explicit Lane A block not found");
  const lane = src.slice(laneStart, laneEnd);
  const advanceIdx = lane.indexOf("laneAShouldAdvance = shouldAdvanceAfterResults(results);");
  const guardIdx = lane.indexOf("hasAdr0039L3RelevantWriteResult(results)");
  const syncIdx = lane.indexOf("syncAdr0039L3AfterKnowledgeWrite({ abrainHome, settings })");
  assert(advanceIdx >= 0, "explicit Lane A should compute laneAShouldAdvance after writes");
  assert(guardIdx > advanceIdx, "explicit Lane A should guard L3 sync with relevant write results");
  assert(syncIdx > guardIdx, "explicit Lane A should call L3 sync after the relevant-write guard");
});

await check("multi-view replay source syncs L3 after writer commit checks", async () => {
  const src = fs.readFileSync(path.join(repoRoot, "extensions/sediment/index.ts"), "utf8");
  const replayStart = src.indexOf("const replayResult: ReplayBatchResult = await replayMultiviewPending({");
  const replayEnd = src.indexOf("signal: undefined,", replayStart);
  assert(replayStart >= 0 && replayEnd > replayStart, "multi-view replay block not found");
  const replay = src.slice(replayStart, replayEnd);
  const writerIdx = replay.indexOf("results = await executeCuratorDecisionToBrain({");
  const rejectedIdx = replay.indexOf("const rejected = results.find((r) => r.status === \"rejected\");");
  const missingCommitIdx = replay.indexOf("const missingCommit = results.find((r) => settings.gitCommit === true");
  const missingCommitThrowIdx = replay.indexOf("throw new Error(`multi-view replay writer missing git commit", missingCommitIdx);
  const guardIdx = replay.indexOf("hasAdr0039L3RelevantWriteResult(results)");
  const syncIdx = replay.indexOf("syncAdr0039L3AfterKnowledgeWrite({ abrainHome, settings })");
  assert(writerIdx >= 0, "multi-view replay should call executeCuratorDecisionToBrain");
  assert(rejectedIdx > writerIdx, "multi-view replay should check rejected writer results after dispatch");
  assert(missingCommitIdx > rejectedIdx, "multi-view replay should check missing commits after rejected results");
  assert(missingCommitThrowIdx > missingCommitIdx, "multi-view replay missing-commit check should throw before sync");
  assert(guardIdx > missingCommitThrowIdx, "multi-view replay should guard L3 sync after writer commit checks");
  assert(syncIdx > guardIdx, "multi-view replay should call L3 sync after relevant-write guard");
});

await check("staging promotion source batches L3 sync after relevant writes", async () => {
  const src = fs.readFileSync(path.join(repoRoot, "extensions/sediment/staging-promotion.ts"), "utf8");
  const runStart = src.indexOf("export async function runStagingPromotionIfDue");
  const runEnd = src.indexOf("function isWriterDedupeResult", runStart);
  assert(runStart >= 0 && runEnd > runStart, "staging promotion run block not found");
  const run = src.slice(runStart, runEnd);
  const flagDeclareIdx = run.indexOf("let wroteAdr0039L3RelevantKnowledge = false;");
  const writerIdx = run.indexOf("writeResults = await executeCuratorDecisionToBrain({");
  const flagSetIdx = run.indexOf("wroteAdr0039L3RelevantKnowledge = wroteAdr0039L3RelevantKnowledge || hasAdr0039L3RelevantWriteResult(writeResults);");
  const loopEndIdx = run.indexOf("if (result.promoted_slugs.length > 0 && wroteAdr0039L3RelevantKnowledge)");
  const syncIdx = run.indexOf("syncAdr0039L3AfterKnowledgeWrite({ abrainHome: options.abrainHome, settings: options.settings })", loopEndIdx);
  assert(flagDeclareIdx >= 0, "staging promotion should declare L3 relevant-write accumulator");
  assert(writerIdx > flagDeclareIdx, "staging promotion should write approved decisions after declaring accumulator");
  assert(flagSetIdx > writerIdx, "staging promotion should update accumulator from executeCuratorDecisionToBrain writeResults");
  assert(loopEndIdx > flagSetIdx, "staging promotion should defer L3 sync until after the candidate loop");
  assert(syncIdx > loopEndIdx, "staging promotion should call L3 sync after the loop-level accumulator guard");
});

await check("auto-write lane hook writes Knowledge L2 and auto-syncs SQLite", async () => {
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "adr0039-l3-autosync-auto-write-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "adr0039-l3-autosync-cwd-"));
  const slug = "adr0039-l3-auto-write-fixture";
  const faux = piAiCompat.registerFauxProvider({ tokensPerSecond: 0 });
  try {
    faux.setResponses([
      piAiCompat.fauxAssistantMessage([
        "MEMORY:",
        "title: ADR0039 L3 Auto Write Fixture",
        "kind: fact",
        "status: active",
        "confidence: 7",
        "---",
        "# ADR0039 L3 Auto Write Fixture",
        "",
        "Auto-write lane fixture for ADR0039 L3 autosync.",
        "END_MEMORY",
      ].join("\n")),
      piAiCompat.fauxAssistantMessage(JSON.stringify({ op: "create", rationale: "smoke fixture create" })),
    ]);
    const modelRegistry = {
      find(provider, modelId) {
        return provider === "faux" ? faux.getModel(modelId) : undefined;
      },
      async getApiKeyAndHeaders(model) {
        return model ? { ok: true, apiKey: "faux-smoke-key", headers: {} } : { ok: false, error: "missing model" };
      },
    };
    const result = await withAbrainRoot(abrainHome, () => sedimentIndex._tryAutoWriteLaneForTests({
      cwd,
      sessionId: "smoke-adr0039-l3-autosync",
      settings: makeAutoWriteSettings(),
      window: {
        entries: [],
        text: "Assistant observed a durable ADR0039 L3 auto-write fixture.",
        start: 0,
        end: 0,
        truncated: false,
      },
      modelRegistry,
      correlationId: "smoke-adr0039-l3-autosync:auto-write",
      abrainHome,
      projectId: "pi-global",
    }));
    assert(result.kind === "wrote", `auto-write lane did not write: ${JSON.stringify(result)}`);
    assert(result.results?.some((r) => r.status === "created" && r.slug === slug), `unexpected write results: ${JSON.stringify(result.results)}`);
    assert(fs.existsSync(dbPath(abrainHome)), "L3 DB was not created by auto-write lane hook");
    assertRepoRootRows(readDbSummary(abrainHome), slug);
    assert(faux.getPendingResponseCount() === 0, "faux LLM responses were not fully consumed");
  } finally {
    faux.unregister();
  }
});

await check("reprojectAllKnowledge auto-syncs L3 after manifest write", async () => {
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "adr0039-l3-autosync-reproject-"));
  const slug = "adr0039-l3-autosync-reproject";
  await appendKnowledgeFixture(abrainHome, { slug, projectOnWrite: false, title: "ADR0039 L3 Autosync Reproject" });
  assert(!fs.existsSync(dbPath(abrainHome)), "L3 DB should not exist before reproject hook runs");
  const result = await km.reprojectAllKnowledge({ abrainHome, settings: settings(false) });
  assert(result.failed === 0, `reproject failures: ${JSON.stringify(result)}`);
  assert(result.projected === 1, `expected one projected entry: ${JSON.stringify(result)}`);
  assert(fs.existsSync(dbPath(abrainHome)), "L3 DB was not created by reproject auto-sync");
  assertRepoRootRows(readDbSummary(abrainHome), slug);
});

if (failures.length) {
  console.log(`FAIL - ${failures.length}/${total} check(s) failed.`);
  process.exit(1);
}

console.log(`PASS - ${total} ADR0039 L3 autosync checks passed.`);
