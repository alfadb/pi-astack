#!/usr/bin/env node
/**
 * ADR 0035 P8: stage1 紧凑 surface vs full-body surface 的 recall 对比 oracle。
 *
 * 对一组 query, 同一 stage0 候选池, stage1 分别用:
 *   full    = full-body surface(meta+summary+compiledTruth+timeline, ~810 tok/entry)
 *   compact = 紧凑 surface(meta+title+trigger+related+summary, ~150 tok/entry)
 * 对比最终 hits:
 *   coverage(full⊆compact) = compact 是否保留 full 会选中的 entry(recall 不丢)
 *   jaccard = 双向一致性
 * 强 model(ORACLE_MODEL, 默认 v4-pro)避免弱 model 噪声(记忆教训)。
 */
import { createJiti } from "jiti";
import fs from "node:fs";
import { secret } from "./_secrets.mjs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url);
const ABRAIN = path.join(os.homedir(), ".abrain");
const MODELS_JSON = path.join(os.homedir(), ".pi", "agent", "models.json");

const { llmSearchEntriesWithVerdict } = await jiti.import(path.join(repoRoot, "extensions/memory/llm-search.ts"));
const { parseEntry } = await jiti.import(path.join(repoRoot, "extensions/memory/parser.ts"));
const { resolveSettings } = await jiti.import(path.join(repoRoot, "extensions/memory/settings.ts"));

const realRegistry = ModelRegistry.create(AuthStorage.create(), MODELS_JSON);
const EMBED_KEY = secret("embedding");
const EMBED_BASE = (() => { try { return JSON.parse(fs.readFileSync(MODELS_JSON, "utf8")).providers?.embedding?.baseUrl; } catch { return undefined; } })();
const registry = {
  find: (p, id) => (p === "embedding" ? { __embed: true, provider: p, id, baseUrl: EMBED_BASE } : realRegistry.find(p, id)),
  getApiKeyAndHeaders: async (m) => (m && m.__embed ? { ok: true, apiKey: EMBED_KEY } : realRegistry.getApiKeyAndHeaders(m)),
};
if (!EMBED_KEY) { console.log("SKIP — no embedding key in ~/.pi/secrets.json"); process.exit(0); }

const baseSettings = resolveSettings();
function walkMd(dir) { const o = []; if (!fs.existsSync(dir)) return o; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) o.push(...walkMd(p)); else if (e.name.endsWith(".md") && !e.name.startsWith("_")) o.push(p); } return o; }
const corpus = [];
const pgRoot = path.join(ABRAIN, "projects", "pi-global");
for (const f of walkMd(pgRoot)) { const e = await parseEntry(f, { scope: "project", root: pgRoot, label: "pi-global" }, pgRoot); if (e && e.status === "active") corpus.push(e); }
const kdir = path.join(ABRAIN, "knowledge");
for (const f of walkMd(kdir)) { const e = await parseEntry(f, { scope: "world", root: kdir, label: "knowledge" }, kdir); if (e && e.status === "active") corpus.push(e); }

const ORACLE_MODEL = process.env.ORACLE_MODEL || "deepseek/deepseek-v4-pro";
const mk = (compact) => ({ ...baseSettings, search: { ...baseSettings.search, stage0Enabled: true, stage1Model: ORACLE_MODEL, stage2Model: ORACLE_MODEL, stage1CompactSurface: compact } });
// ORACLE_COMPACT=0 → compactS 也用 full surface = full-vs-full 随机性基线对照
const CMP = process.env.ORACLE_COMPACT !== "0";
const fullS = mk(false), compactS = mk(CMP);

const queries = [
  "stage1 候选检索改成 embedding 向量",
  "sediment 写入路径 content-hash 增量",
  "scope filter 必须在 topN 之前执行",
  "全局索引 prune 跨 project 数据丢失",
  "git singleflight lock index race condition",
  "ModelRegistry getApiKeyAndHeaders auth resolution",
  "ADR 0035 sublinear retrieval architecture decision",
  "dispatch parallel T0 cross-vendor blind review",
];
const _off = Number(process.env.ORACLE_OFFSET || 0), _lim = Number(process.env.ORACLE_LIMIT || queries.length);
const runQ = queries.slice(_off, _off + _lim);
const jacc = (a, b) => { const A = new Set(a), B = new Set(b); const i = [...A].filter((x) => B.has(x)).length; const u = new Set([...a, ...b]).size; return u === 0 ? 1 : i / u; };

console.log(`oracle-compact-surface | model=${ORACLE_MODEL} | corpus=${corpus.length} | queries=${runQ.length} | mode=${CMP ? "full-vs-COMPACT" : "full-vs-full(随机性基线)"}\n`);
const covs = [], jacs = [];
for (const q of runQ) {
  const full = await llmSearchEntriesWithVerdict(corpus, { query: q }, fullS, registry);
  const compact = await llmSearchEntriesWithVerdict(corpus, { query: q }, compactS, registry);
  const hf = full.hits.map((h) => h.slug), hc = compact.hits.map((h) => h.slug);
  const cov = hf.length === 0 ? 1 : hf.filter((s) => hc.includes(s)).length / hf.length;
  const j = jacc(hf, hc);
  covs.push(cov); jacs.push(j);
  console.log(`Q: ${q}`);
  console.log(`  full(${full.relevance_verdict}) hits=${hf.length} [${hf.slice(0, 5).join(", ")}]`);
  console.log(`  compact(${compact.relevance_verdict}) hits=${hc.length} [${hc.slice(0, 5).join(", ")}]`);
  console.log(`  → coverage(full⊆compact)=${(cov * 100).toFixed(0)}%  jaccard=${(j * 100).toFixed(0)}%\n`);
}
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
console.log(`平均 coverage(full⊆compact)=${(avg(covs) * 100).toFixed(1)}%  平均 jaccard=${(avg(jacs) * 100).toFixed(1)}%`);
console.log(`判定: coverage 高 = compact 保留 full 会选的 entry, recall 不丢; 低 = compiledTruth/timeline 对 stage1 判断重要。`);
