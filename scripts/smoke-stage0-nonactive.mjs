#!/usr/bin/env node
/**
 * ADR 0035 P7: 非-active 查询走 stage0(不回退全库) + stale 只算可索引集 smoke。
 *
 * 漏洞: sediment curator 去重 search 带 status:["all"], 原 selectStage0Pool 的
 * wantsNonActive→null 使其回退全库 full_body 915K/次(每轮高频)。
 * 修复: (1) 删 wantsNonActive→null, 非 active 查询走 hybrid 缩候选;
 *      (2) staleOrMissingSlugs 只对可索引集(status==active 且 非 zone:rules)算 —
 *         否则全部非 active + rule neighbors 被标 stale 塞爆候选池(永久 stale)。
 *
 * 测法: corpus = 真(pi-global+world) + 注入 50 superseded probe + 5 active-zone:rules
 * probe(均内容独特, sparse 不命中)。status:["all"] 调 selectStage0Pool:
 *   - pool != null(不回退全库) + mode=hybrid + candidateEntries <= maxCand(缩候选)
 *   - 两类不可索引 probe 都不进候选(superseded: 非 active 不进 stale;
 *     rule: zone:rules 被排除) → 证明 γ 险(stale 塞爆)已堵
 */
import { createJiti } from "jiti";
import fs from "node:fs";
import { embeddingConfig } from "./_embedding-config.mjs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url);
const ABRAIN = path.join(os.homedir(), ".abrain");
const MODELS_JSON = path.join(os.homedir(), ".pi", "agent", "models.json");

const EMBEDDING = embeddingConfig();
if (!EMBEDDING.apiKey || !EMBEDDING.baseUrl) { console.log("SKIP — memory.embedding baseUrl/apiKey not configured"); process.exit(0); }

const { selectStage0Pool } = await jiti.import(path.join(repoRoot, "extensions/memory/llm-search.ts"));
const { parseEntry } = await jiti.import(path.join(repoRoot, "extensions/memory/parser.ts"));
const { resolveSettings } = await jiti.import(path.join(repoRoot, "extensions/memory/settings.ts"));

const realRuntime = await ModelRuntime.create({ modelsPath: MODELS_JSON });
const realRegistry = new ModelRegistry(realRuntime);
const registry = {
  find: (p, id) => (p === "embedding" ? { __embed: true, provider: p, id, baseUrl: EMBEDDING.baseUrl } : realRegistry.find(p, id)),
  getApiKeyAndHeaders: async (m) => (m && m.__embed ? { ok: true, apiKey: EMBEDDING.apiKey } : realRegistry.getApiKeyAndHeaders(m)),
};

function walkMd(dir) { const o = []; if (!fs.existsSync(dir)) return o; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) o.push(...walkMd(p)); else if (e.name.endsWith(".md") && !e.name.startsWith("_")) o.push(p); } return o; }

const corpus = [];
const pgRoot = path.join(ABRAIN, "projects", "pi-global");
for (const f of walkMd(pgRoot)) { const e = await parseEntry(f, { scope: "project", root: pgRoot, label: "pi-global" }, pgRoot); if (e && e.status === "active") corpus.push(e); }
const kdir = path.join(ABRAIN, "knowledge");
for (const f of walkMd(kdir)) { const e = await parseEntry(f, { scope: "world", root: kdir, label: "knowledge" }, kdir); if (e && e.status === "active") corpus.push(e); }
const base0 = corpus[0];

// 注入 50 个 superseded probe(非 active, 内容独特 sparse 不命中)
const supersededProbes = Array.from({ length: 50 }, (_, i) => ({
  ...base0, slug: `__superseded-probe-${i}`, status: "superseded",
  title: `qzxvbnm superseded probe ${i}`, summary: `qzxvbnm superseded ${i}`, compiledTruth: `qzxvbnm superseded body ${i}`,
}));
// 注入 5 个 active + zone:rules probe(模拟 readonly rule neighbor, 永不索引)
const ruleProbes = Array.from({ length: 5 }, (_, i) => ({
  ...base0, slug: `__rule-neighbor-probe-${i}`, status: "active",
  frontmatter: { ...(base0.frontmatter ?? {}), zone: "rules" },
  title: `qzxvbnm rule neighbor probe ${i}`, summary: `qzxvbnm rule ${i}`, compiledTruth: `qzxvbnm rule body ${i}`,
}));
// 注入 1 个“相关” superseded probe(title/body 含 query 词, sparse 应命中) ——
// 验证去重场景: 非 active 旧版能被召回(sediment 才能决定 supersede 它)。
const relevantSuperseded = {
  ...base0, slug: "__relevant-superseded-probe", status: "superseded",
  title: "git singleflight lock index race condition retired version",
  summary: "git singleflight lock index race retired",
  compiledTruth: "git singleflight lock index race condition old superseded implementation",
};
const probeSlugs = new Set([...supersededProbes, ...ruleProbes].map((e) => e.slug));
const corpusAll = [...corpus, ...supersededProbes, ...ruleProbes, relevantSuperseded];
// Defensive callers can carry obsolete lifecycle rows before their active
// replacement. Bare-slug identity must still select active, regardless of
// whether the earlier duplicate is archived or superseded.
const archivedBeforeActive = {
  ...base0, slug: "__archived-before-active", status: "archived",
  title: "git singleflight lock index race condition archived duplicate",
  summary: "git singleflight lock index race condition archived duplicate",
  compiledTruth: "git singleflight lock index race condition archived duplicate",
};
const supersededBeforeActive = {
  ...base0, slug: "__superseded-before-active", status: "superseded",
  title: "git singleflight lock index race condition superseded duplicate",
  summary: "git singleflight lock index race condition superseded duplicate",
  compiledTruth: "git singleflight lock index race condition superseded duplicate",
};
const activeAfterArchived = { ...archivedBeforeActive, status: "active", title: "git singleflight lock index race condition active authority archived duplicate" };
const activeAfterSuperseded = { ...supersededBeforeActive, status: "active", title: "git singleflight lock index race condition active authority superseded duplicate" };
const duplicateCorpus = [...corpusAll, archivedBeforeActive, activeAfterArchived, supersededBeforeActive, activeAfterSuperseded];

const settings = { ...resolveSettings(), embedding: resolveSettings().embedding };
const s = { ...settings, search: { ...settings.search, stage0Enabled: true } };
const query = "git singleflight lock index race condition"; // 真实 query, dense 工作

console.log(`smoke-stage0-nonactive | corpus=${corpus.length}(+50 superseded +5 rule) | status:["all"]\n`);
let failed = 0;
const check = (n, c) => { console.log(`  ${c ? "ok  " : "FAIL"}  ${n}`); if (!c) failed++; };

const baselinePool = await selectStage0Pool(query, corpus, s, registry, { status: ["all"] });
const pool = await selectStage0Pool(query, corpusAll, s, registry, { status: ["all"] });
const duplicatePool = await selectStage0Pool(query, duplicateCorpus, s, registry, { status: ["all"] });
check(`pool != null (P7: status:["all"] 不再回退全库 full_body)`, pool !== null);
if (pool) {
  const maxCand = s.search.stage0MaxCandidates;
  const candSlugs = pool.candidateEntries.map((e) => e.slug);
  const probesInPool = candSlugs.filter((sl) => probeSlugs.has(sl)).length;
  check(`mode=hybrid (dense 工作, 非熔断): ${pool.mode}`, pool.mode === "hybrid");
  check(`候选面缩到 <= maxCand=${maxCand} (非全库 ${corpusAll.length}): pool=${pool.candidateEntries.length}`, pool.candidateEntries.length <= maxCand);
  check(`不可索引 probe(50 superseded + 5 rule) 不被塞进候选: 进候选数=${probesInPool} (期望 0)`, probesInPool === 0);
  check(`staleCount 对 55 个不可索引 probe 不变: all=${pool.staleCount}, baseline=${baselinePool?.staleCount}`, pool.staleCount === baselinePool?.staleCount);
  check(`相关非 active 旧版能被召回(sparse 通道, 去重质量): __relevant-superseded-probe ∈ pool=${candSlugs.includes("__relevant-superseded-probe")}`, candSlugs.includes("__relevant-superseded-probe"));
  const duplicateBySlug = new Map((duplicatePool?.candidateEntries ?? []).map((entry) => [entry.slug, entry.status]));
  check(`archived-first duplicate slug resolves to active: ${duplicateBySlug.get("__archived-before-active")}`, duplicateBySlug.get("__archived-before-active") === "active");
  check(`superseded-first duplicate slug resolves to active: ${duplicateBySlug.get("__superseded-before-active")}`, duplicateBySlug.get("__superseded-before-active") === "active");
  console.log(`\n  pool=${pool.candidateEntries.length} dense=${pool.denseCount} sparse=${pool.sparseCount} stale=${pool.staleCount}`);
}
console.log(`${failed === 0 ? "\nP7 PASS — 非 active 查询走 stage0 缩候选, 不可索引集不塞 stale, 全库 full_body 漏洞已堵" : "\n" + failed + " FAILED"}`);
process.exit(failed ? 1 : 0);
