#!/usr/bin/env node
/**
 * RM-LIFECYCLE-001 focused smoke: archived dense dedup surface and reversible
 * writer/reactivation lifecycle. Everything runs under temporary roots.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
import * as piAiCompat from "@earendil-works/pi-ai/compat";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-archived-dense-"));
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-archived-dense-project-"));
const indexPath = path.join(tmpRoot, ".state", "memory", "focused-index.json");
const priorAbrainRoot = process.env.ABRAIN_ROOT;
const priorCwd = process.cwd();
process.env.ABRAIN_ROOT = tmpRoot;
process.chdir(projectRoot);

let passed = 0;
let failed = 0;
function check(condition, message, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`PASS: ${message}`);
  } else {
    failed += 1;
    console.error(`FAIL: ${message}${detail ? ` (${detail})` : ""}`);
  }
}

function vectorFor(text) {
  const normalized = String(text).toLowerCase();
  if (/recover semantic index|canonical ledger reconstruction|reconstitute derived vectors|restore derived catalog/.test(normalized)) return [1, 0, 0, 0];
  if (normalized.includes("active-authority-marker")) return [0, 1, 0, 0];
  if (normalized.includes("archived-shadow-marker")) return [0, 0, 1, 0];
  if (normalized.includes("world-scope-marker")) return [0, 0, 0, 1];
  return [0.2, 0.3, 0.4, 0.5];
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, init) => {
  const request = JSON.parse(String(init?.body ?? "{}"));
  const input = Array.isArray(request.input) ? request.input : [];
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        data: input.map((text, index) => ({ index, embedding: vectorFor(text) })),
        usage: { prompt_tokens: input.length },
      });
    },
  };
};

function entry(slug, status, title, compiledTruth, options = {}) {
  const scope = options.scope ?? "project";
  const projectId = options.projectId ?? "lifecycle-smoke";
  return {
    slug,
    id: scope === "world" ? `world:${slug}` : `project:${projectId}:${slug}`,
    scope,
    kind: "fact",
    status,
    confidence: 7,
    provenance: "assistant-observed",
    title,
    summary: compiledTruth.slice(0, 120),
    created: "2026-07-20T00:00:00.000Z",
    updated: "2026-07-22T00:00:00.000Z",
    sourcePath: path.join(tmpRoot, scope === "world" ? "knowledge" : `projects/${projectId}`, `${slug}.md`),
    displayPath: `${slug}.md`,
    storeRoot: scope === "world" ? path.join(tmpRoot, "knowledge") : path.join(tmpRoot, "projects", projectId),
    frontmatter: scope === "world" ? {} : { project_id: projectId },
    compiledTruth,
    timeline: [],
    relatedSlugs: [],
    relations: [],
    tokenCounts: new Map(),
    tokenTotal: 1,
  };
}

const archivedSemantic = entry(
  "archived-ledger-reconstruction",
  "archived",
  "Canonical ledger reconstruction",
  "Reconstitute derived vectors from canonical records whenever storage corruption invalidates the local catalog. ".repeat(8),
);
const activeNear = entry(
  "active-derived-catalog-recovery",
  "active",
  "Restore derived catalog from source records",
  "Restore derived catalog data from authoritative records after local storage damage.",
);
const superseded = entry(
  "superseded-index-plan",
  "superseded",
  "Retired vector plan",
  "A retired implementation that must not enter the dense lifecycle index.",
);
const worldArchived = entry(
  "world-archived-vector-rule",
  "archived",
  "World scope marker",
  "world-scope-marker remains a retained archived tombstone.",
  { scope: "world" },
);
const sameSlugArchived = entry(
  "same-slug-lifecycle",
  "archived",
  "Archived duplicate row",
  "archived-shadow-marker must never replace the active vector.",
);
const sameSlugActive = entry(
  "same-slug-lifecycle",
  "active",
  "Active duplicate row",
  "active-authority-marker must own the bare-slug vector.",
);
const corpus = [activeNear, archivedSemantic, superseded, worldArchived, sameSlugArchived, sameSlugActive];

const cfg = {
  baseUrl: "https://embedding.invalid/v1",
  apiKey: "focused-smoke",
  model: "focused-embedding-v1",
  dim: 4,
  batchSize: 3,
  tpmLimit: 1_000_000,
  timeoutMs: 5_000,
  maxRetries: 0,
  multiVector: true,
  multiVectorMaxChunks: 4,
};
const registry = {
  find(provider, modelId) {
    if (provider === "embedding") return { provider, id: modelId, baseUrl: cfg.baseUrl };
    return faux.getModel(modelId);
  },
  async getApiKeyAndHeaders(model) {
    return model ? { ok: true, apiKey: "focused-smoke", headers: {} } : { ok: false, error: "missing model" };
  },
};
const faux = piAiCompat.registerFauxProvider({ tokensPerSecond: 0 });

try {
  const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
  const embedding = await jiti.import(path.join(repoRoot, "extensions/memory/embedding.ts"));
  const searchCore = await jiti.import(path.join(repoRoot, "extensions/memory/llm-search.ts"));
  const search = await jiti.import(path.join(repoRoot, "extensions/memory/search.ts"));
  const memorySettingsModule = await jiti.import(path.join(repoRoot, "extensions/memory/settings.ts"));
  const writer = await jiti.import(path.join(repoRoot, "extensions/sediment/writer.ts"));
  const sedimentSettingsModule = await jiti.import(path.join(repoRoot, "extensions/sediment/settings.ts"));
  const archiveReactivation = await jiti.import(path.join(repoRoot, "extensions/sediment/archive-reactivation.ts"));
  const parser = await jiti.import(path.join(repoRoot, "extensions/memory/parser.ts"));

  const first = await embedding.buildCorpusEmbeddings(corpus, cfg, indexPath, { maxChars: 80 });
  check(first.total === 4 && first.active === 2 && first.archived === 2, "build indexes unique active + archived entries", JSON.stringify(first));
  const rawFirst = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  check(Boolean(rawFirst.entries[archivedSemantic.slug]), "archived tombstone is persisted in the shared vector index");
  check(!rawFirst.entries[superseded.slug], "superseded entry remains outside the dense lifecycle index");
  check(rawFirst.entries[archivedSemantic.slug].vecs.length > 1, "archived entry preserves multi-vector chunks");
  check(rawFirst.entries["same-slug-lifecycle"].hash === embedding.contentHashOf(sameSlugActive), "active row wins an active/archived bare-slug collision");

  const query = "recover semantic index after damaged cache";
  check(!searchCore.sparseMatchSlugsBM25(query, [archivedSemantic]).includes(archivedSemantic.slug), "archived candidate has no lexical sparse hit for the semantic query");

  const baseSettings = memorySettingsModule.resolveSettings();
  const settings = {
    ...baseSettings,
    embedding: {
      ...baseSettings.embedding,
      provider: "embedding",
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      dim: cfg.dim,
      batchSize: cfg.batchSize,
      tpmLimit: cfg.tpmLimit,
      timeoutMs: cfg.timeoutMs,
      maxRetries: cfg.maxRetries,
      multiVector: true,
      multiVectorMaxChunks: 4,
    },
    search: {
      ...baseSettings.search,
      stage0Enabled: true,
      stage0PoolLimit: 20,
      stage0MaxCandidates: 20,
      stage0InsufficientPoolK: 1,
      stage0StaleFloorRatio: 0,
      autoReconcile: false,
      sparseBM25: true,
      stage1Skip: true,
      queryRouting: true,
      stage1Model: "faux/faux-1",
      stage2Model: "faux/faux-1",
    },
  };

  // selectStage0Pool uses vectorIndexPath(), so mirror the focused index into
  // the isolated production-shaped location under ABRAIN_ROOT.
  const runtimeIndexPath = embedding.vectorIndexPath();
  fs.mkdirSync(path.dirname(runtimeIndexPath), { recursive: true });
  fs.copyFileSync(indexPath, runtimeIndexPath);

  const dedupPool = await searchCore.selectStage0Pool(query, corpus, settings, registry, { status: ["all"] }, { profileName: "sedimentDedup", reconcileEntries: corpus });
  check(dedupPool?.denseSlugs.includes(archivedSemantic.slug) === true, "sedimentDedup dense surface finds lexically different archived candidate");
  check(dedupPool?.candidateEntries.some((candidate) => candidate.slug === archivedSemantic.slug && candidate.status === "archived") === true, "archived dense hit enters only the dedup candidate pool");
  check(dedupPool?.reconcileSignal.orphanCount === 0, "archived vectors are not counted as reconcile orphans");

  const defaultCorpus = corpus.filter((candidate) => search.entryMatchesFilters(candidate, undefined));
  const defaultPool = await searchCore.selectStage0Pool(query, defaultCorpus, settings, registry, {}, { profileName: "toolSearch", reconcileEntries: corpus });
  check(!defaultPool?.denseSlugs.includes(archivedSemantic.slug), "default toolSearch dense allow-set excludes archived");
  check(!defaultPool?.candidateEntries.some((candidate) => candidate.status === "archived" || candidate.status === "superseded"), "default stage0 winning pool has no archived/superseded rows");
  check(!search.entryMatchesFilters(archivedSemantic, undefined) && !search.entryMatchesFilters(superseded, undefined), "default status contract excludes archived and superseded");
  check(search.entryMatchesFilters(archivedSemantic, { status: ["archived"] }), "explicit archived status filter still includes archived");
  check(!search.entryMatchesFilters(activeNear, { status: ["archived"] }), "explicit archived status filter excludes active");
  check(corpus.filter((candidate) => search.entryMatchesFilters(candidate, { status: ["all"] })).length === corpus.length, "explicit status:[all] contract remains inclusive");

  faux.setResponses([
    piAiCompat.fauxAssistantMessage(JSON.stringify({ relevance_verdict: "none", picks: [] })),
    piAiCompat.fauxAssistantMessage(JSON.stringify({
      decisions: [{
        slug: "formal-reactivation-entry",
        decision: "reactivate",
        rationale: "The current task applies the archived behavior again.",
        archived_quote: "rebuild derived indexes from canonical source records",
        user_quote: "rebuild derived indexes from canonical source records",
        age_days_approx: 2,
      }],
    })),
  ]);
  const defaultExact = await searchCore.runMemorySearch("toolSearch", archivedSemantic.slug, corpus, { ...settings, search: { ...settings.search, stage0Enabled: false } }, registry, { callerFilters: {} });
  check(!defaultExact.hits?.some?.((hit) => hit.status === "archived") && !Array.from(defaultExact).some((hit) => hit.status === "archived"), "exact-route cannot bypass default archived exclusion");
  const explicitExact = await searchCore.runMemorySearch("toolSearch", archivedSemantic.slug, corpus, settings, registry, { callerFilters: { status: ["archived"] } });
  check(Array.from(explicitExact).some((hit) => hit.slug === archivedSemantic.slug && hit.status === "archived"), "explicit archived exact lookup remains available");

  const indexed = new embedding.VectorIndex(runtimeIndexPath, cfg.model, cfg.dim).load();
  indexed.upsert("project-orphan", "orphan", [[0.1, 0.1, 0.1, 0.1]], "project:lifecycle-smoke", "m");
  indexed.upsert("world-orphan", "orphan", [[0.1, 0.1, 0.1, 0.1]], "world", "m");
  indexed.save();
  // A filtered archived-dense call cannot infer the lifecycle index's legal
  // set. Missing reconcileEntries must therefore suppress add/prune instead
  // of treating every omitted vector as an orphan.
  const archivedOnly = [archivedSemantic];
  const missingReconcile = await searchCore.selectStage0Pool(query, archivedOnly, settings, registry, { status: ["archived"] }, { profileName: "sedimentDedup" });
  check(missingReconcile?.reconcileSignal.indexableCount === 0 && missingReconcile?.reconcileSignal.staleCount === 0 && missingReconcile?.reconcileSignal.orphanCount === 0, "archivedDenseCandidates without full reconcileEntries fails closed without reconcile signals");
  const fullReconcile = await searchCore.selectStage0Pool(query, archivedOnly, settings, registry, { status: ["archived"] }, { profileName: "sedimentDedup", reconcileEntries: corpus });
  check((fullReconcile?.reconcileSignal.orphanCount ?? 0) >= 2, "archivedDenseCandidates with full reconcileEntries retains authoritative orphan detection");

  const projectOnly = corpus.filter((candidate) => candidate.scope === "project");
  const reconciledProject = await embedding.reconcileEmbeddings(projectOnly, cfg, runtimeIndexPath, { maxChars: 80 });
  const afterProject = JSON.parse(fs.readFileSync(runtimeIndexPath, "utf8"));
  check(reconciledProject.pruned === 1 && !afterProject.entries["project-orphan"], "project reconcile prunes only a true in-scope orphan");
  check(Boolean(afterProject.entries[archivedSemantic.slug]), "project reconcile retains archived tombstone");
  check(Boolean(afterProject.entries["world-orphan"]), "project reconcile preserves out-of-scope world vectors");
  const reconciledFull = await embedding.reconcileEmbeddings(corpus, cfg, runtimeIndexPath, { maxChars: 80 });
  const afterFull = JSON.parse(fs.readFileSync(runtimeIndexPath, "utf8"));
  check(reconciledFull.pruned === 1 && !afterFull.entries["world-orphan"] && Boolean(afterFull.entries[worldArchived.slug]), "full reconcile prunes world orphan but retains world archived tombstone");

  const concurrent = await Promise.all([
    embedding.reconcileEmbeddings(corpus, cfg, runtimeIndexPath, { maxChars: 80 }),
    embedding.reconcileEmbeddings(corpus, cfg, runtimeIndexPath, { maxChars: 80 }),
  ]);
  check(concurrent.every((result) => result.pruned === 0) && new embedding.VectorIndex(runtimeIndexPath, cfg.model, cfg.dim).load().size() === 4, "concurrent reconcile is serialized and idempotent");

  fs.writeFileSync(runtimeIndexPath, "{corrupt-index", "utf8");
  const rebuilt = await embedding.reconcileEmbeddings(corpus, cfg, runtimeIndexPath, { maxChars: 80 });
  const rebuiltIndex = new embedding.VectorIndex(runtimeIndexPath, cfg.model, cfg.dim).load();
  check(rebuilt.embedded === 4 && rebuiltIndex.size() === 4, "corrupt/restart index rebuild restores active + archived vectors");
  check(rebuiltIndex.topN(vectorFor(query), 10, { allowSlugs: new Set([archivedSemantic.slug]) })[0]?.slug === archivedSemantic.slug, "rebuilt index returns the archived dense candidate");

  const projectId = "lifecycle-smoke";
  fs.mkdirSync(path.join(tmpRoot, "projects", projectId), { recursive: true });
  const sedimentBase = sedimentSettingsModule.DEFAULT_SEDIMENT_SETTINGS;
  const sedimentSettings = {
    ...sedimentBase,
    gitCommit: false,
    autoLlmWriteEnabled: true,
    aggregatorModel: "faux/faux-1",
    knowledgeEvidenceEventWriter: { ...sedimentBase.knowledgeEvidenceEventWriter, enabled: false },
    knowledgeProjector: { ...sedimentBase.knowledgeProjector, enabled: false, projectOnWrite: false, canonicalReadMode: "legacy" },
  };
  const writerOptions = { projectRoot, abrainHome: tmpRoot, projectId, scope: "project", settings: sedimentSettings };
  const phrase = "rebuild derived indexes from canonical source records";
  const created = await writer.writeProjectEntry({
    preferredSlug: "formal-reactivation-entry",
    title: "Formal reactivation entry",
    kind: "fact",
    status: "active",
    confidence: 7,
    compiledTruth: `# Formal reactivation entry\n\nAlways ${phrase} after local index damage.`,
  }, writerOptions);
  check(created.status === "created", "writer creates active lifecycle entry", JSON.stringify(created));
  const archived = await writer.archiveProjectEntry(created.slug, { ...writerOptions, expected_status: "active", reason: "focused round-trip" });
  check(archived.status === "archived", "writer archives through CAS lifecycle path", JSON.stringify(archived));
  const archivedRaw = fs.readFileSync(created.path, "utf8");
  const archiveAt = /^archive_at:\s*(.+)$/m.exec(archivedRaw)?.[1]?.trim();
  check(Boolean(archiveAt), "first archive stamps archive_at");
  const archivedAgain = await writer.updateProjectEntry(created.slug, { status: "archived", expected_status: "archived", timelineNote: "idempotent archived update" }, writerOptions);
  const archiveAtAgain = /^archive_at:\s*(.+)$/m.exec(fs.readFileSync(created.path, "utf8"))?.[1]?.trim();
  check(archivedAgain.status === "updated" && archiveAtAgain === archiveAt, "archived update preserves first archive_at without sliding the window");

  const parsedArchived = await parser.parseEntry(created.path, { scope: "project", root: path.join(tmpRoot, "projects", projectId), label: "focused" }, projectRoot);
  const roundTrip = await archiveReactivation.runArchiveReactivationIfDue({
    projectRoot,
    archivedEntries: [parsedArchived],
    windowText: `The current task says to ${phrase} immediately.`,
    settings: sedimentSettings,
    modelRegistry: registry,
    sessionId: "focused-reactivation",
    minIntervalMs: 0,
    reactivateEntry: async (slug, scope, rationale) => {
      const result = await writer.updateProjectEntry(slug, {
        status: "active",
        expected_status: "archived",
        timelineAction: "reactivated",
        timelineNote: `archive-reactivation-reviewer v1: ${rationale}`,
        sessionId: "focused-reactivation",
      }, { ...writerOptions, scope, auditOperation: "archive_reactivation_apply" });
      return { ok: result.status !== "rejected", error: result.reason };
    },
  });
  const reactivatedRaw = fs.readFileSync(created.path, "utf8");
  check(roundTrip.reactivated_slugs.includes(created.slug), "formal archive-reactivation reviewer path applies reactivation");
  check(/^status: active$/m.test(reactivatedRaw), "reactivation switches status back to active");
  check(!/^archive_at:/m.test(reactivatedRaw), "reactivation clears archive_at");
  const reactivatedEntry = await parser.parseEntry(created.path, { scope: "project", root: path.join(tmpRoot, "projects", projectId), label: "focused" }, projectRoot);
  check(search.entryMatchesFilters(reactivatedEntry, undefined), "reactivated entry returns to the default active surface");
} finally {
  globalThis.fetch = originalFetch;
  process.chdir(priorCwd);
  if (priorAbrainRoot === undefined) delete process.env.ABRAIN_ROOT;
  else process.env.ABRAIN_ROOT = priorAbrainRoot;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

console.log(`\nRM-LIFECYCLE-001 focused smoke: ${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
