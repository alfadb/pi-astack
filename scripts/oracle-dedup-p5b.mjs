#!/usr/bin/env node
/**
 * ADR 0036 P5b 验证: sediment dedup dense-only(stage1Skip=true + sparseBM25=true)
 * 相对当前三阶段 pin(stage1Skip=false + sparseBM25=false)是否抬高 **false-merge 面**。
 *
 * 在生产单向量索引上跑**真实** sedimentDedup 检索(status:[all], limit:5), 以近重金标对
 * (A,B)的 A 为 draft(从 corpus 排除 A, 模拟新 draft)查 query, 看金标 partner B 是否
 * 进 top-5 邻居。判据(fail-closed):
 *   - distinct 对 intrusion@5: dense-only ≤ 三阶段(不引入更多 false-merge 面)
 *   - merge   对 recall@5:    dense-only ≥ 三阶段(真近重不漏召)
 *
 * 需要 SUB2API_API_KEY_EMBEDDING + 生产模型配置。
 */
import { createJiti } from "jiti";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeOracleRegistry } from "./_oracle-registry.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url);
const ABRAIN = path.join(os.homedir(), ".abrain");
const MODELS_JSON = path.join(os.homedir(), ".pi", "agent", "models.json");

const { llmSearchEntriesWithVerdict } = (await jiti.import(path.join(repoRoot, "extensions/memory/llm-search.ts"))).__oracleKernel;
const { parseEntry } = await jiti.import(path.join(repoRoot, "extensions/memory/parser.ts"));
const { resolveSettings } = await jiti.import(path.join(repoRoot, "extensions/memory/settings.ts"));

// 模型无关 registry: 从 models.json 解析 baseUrl+apiKey($ENV ref)(见 _oracle-registry.mjs)
const { registry, resolveKey, embedKey: EMBED_KEY } = makeOracleRegistry(MODELS_JSON);
if (!EMBED_KEY) { console.log("SKIP — no SUB2API_API_KEY_EMBEDDING"); process.exit(0); }

const base = resolveSettings();
const MODEL = process.env.ORACLE_MODEL || base.search.stage2Model || "deepseek/deepseek-v4-pro";
if (!resolveKey(MODEL.split("/")[0])) { console.log(`SKIP — no apiKey for ${MODEL.split("/")[0]} in models.json/env`); process.exit(0); }
// 三阶段(当前 dedup pin) vs dense-only(P5b 拟翻转)。两臂都用同一 dedup 模型, 控变量。
const cfgThree = { ...base, search: { ...base.search, stage0Enabled: true, stage1Model: MODEL, stage2Model: MODEL, stage1Skip: false, sparseBM25: false, dedupChunk0Aggregation: false } };
const cfgDense = { ...base, search: { ...base.search, stage0Enabled: true, stage1Model: MODEL, stage2Model: MODEL, stage1Skip: true, sparseBM25: true, dedupChunk0Aggregation: false } };

function walk(d) { const o = []; if (!fs.existsSync(d)) return o; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) o.push(...walk(p)); else if (e.name.endsWith(".md") && !e.name.startsWith("_")) o.push(p); } return o; }
const corpus = [];
const pg = path.join(ABRAIN, "projects", "pi-global");
for (const f of walk(pg)) { const e = await parseEntry(f, { scope: "project", root: pg, label: "pi-global" }, pg); if (e && e.status === "active") corpus.push(e); }
const kd = path.join(ABRAIN, "knowledge");
for (const f of walk(kd)) { const e = await parseEntry(f, { scope: "world", root: kd, label: "knowledge" }, kd); if (e && e.status === "active") corpus.push(e); }
const bySlug = new Map(corpus.map((e) => [e.slug, e]));

// 金标 + 多数票
const GS = path.join(repoRoot, "scripts/.goldset");
const pairs = JSON.parse(fs.readFileSync(process.env.PAIRS || path.join(GS, "neardup-pairs.json"), "utf8"));
const voteFiles = (process.env.VOTES || ["neardup-votes-opus.json", "neardup-votes-gpt.json", "neardup-votes-deepseek.json"].map((f) => path.join(GS, f)).join(","))
  .split(",").map((s) => s.trim()).filter(Boolean);
const votesByModel = voteFiles.map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
const goldOf = (id) => { let m = 0, d = 0; for (const vm of votesByModel) { const v = vm.find((x) => Number(x.id) === Number(id)); if (!v) continue; if (/merge/i.test(v.verdict)) m++; else if (/distinct/i.test(v.verdict)) d++; } return m === 0 && d === 0 ? null : m > d ? "merge" : d > m ? "distinct" : "tie"; };

// 选样: 高 cos 优先(最易 false-merge), merge/distinct 各取上限
const labeled = pairs.map((p) => ({ ...p, gold: goldOf(p.id) })).filter((p) => p.gold === "merge" || p.gold === "distinct" && bySlug.has(p.a_slug) && bySlug.has(p.b_slug));
const mergePairs = labeled.filter((p) => p.gold === "merge" && bySlug.has(p.a_slug) && bySlug.has(p.b_slug)).sort((a, b) => b.cos - a.cos).slice(0, Number(process.env.N_MERGE || 10));
const distPairs = labeled.filter((p) => p.gold === "distinct" && bySlug.has(p.a_slug) && bySlug.has(p.b_slug)).sort((a, b) => b.cos - a.cos).slice(0, Number(process.env.N_DISTINCT || 14));
const sel = [...mergePairs, ...distPairs];

const makeQuery = (e) => [
  "For sediment curator: find existing project memories that this candidate may update, merge with, supersede, or duplicate.",
  "Prefer entries with matching durable meaning even if wording differs.",
  `Candidate title: ${e.title}`, `Candidate kind: ${e.kind}`, `Candidate confidence: ${e.confidence ?? "unknown"}`,
  "Candidate compiled truth:", e.compiledTruth,
].join("\n");

console.log(`oracle-dedup-p5b | model=${MODEL} | corpus=${corpus.length} | 选样: merge=${mergePairs.length} distinct=${distPairs.length}\n`);
const stat = { three: { mR: 0, mN: 0, dI: 0, dN: 0 }, dense: { mR: 0, mN: 0, dI: 0, dN: 0 } };
for (const p of sel) {
  const A = bySlug.get(p.a_slug), B = p.b_slug;
  const sub = corpus.filter((e) => e.slug !== p.a_slug); // 排除 A, 模拟新 draft
  const q = makeQuery(A);
  const filters = { status: ["all"], limit: 5 };
  const three = await llmSearchEntriesWithVerdict(sub, { query: q, filters }, cfgThree, registry);
  const dense = await llmSearchEntriesWithVerdict(sub, { query: q, filters }, cfgDense, registry);
  const inThree = three.hits.some((h) => h.slug === B), inDense = dense.hits.some((h) => h.slug === B);
  if (p.gold === "merge") { stat.three.mN++; stat.dense.mN++; if (inThree) stat.three.mR++; if (inDense) stat.dense.mR++; }
  else { stat.three.dN++; stat.dense.dN++; if (inThree) stat.three.dI++; if (inDense) stat.dense.dI++; }
  console.log(`  ${p.gold.padEnd(8)} cos=${p.cos} three=${inThree ? "HIT" : "-  "} dense=${inDense ? "HIT" : "-  "} | ${p.a_slug.slice(0, 30)} ~ ${p.b_slug.slice(0, 30)}`);
}
const pct = (x, n) => n ? `${(x / n * 100).toFixed(0)}%` : "-";
console.log(`\n${"config".padEnd(12)} | merge-recall@5 (want 高, n=${stat.three.mN}) | distinct-INTRUSION@5 (want 低=false-merge 面, n=${stat.three.dN})`);
console.log(`three-stage  |     ${pct(stat.three.mR, stat.three.mN).padStart(4)}                |     ${pct(stat.three.dI, stat.three.dN).padStart(4)}`);
console.log(`dense-only   |     ${pct(stat.dense.mR, stat.dense.mN).padStart(4)}                |     ${pct(stat.dense.dI, stat.dense.dN).padStart(4)}`);
console.log(`\n判据(fail-closed): dense-only intrusion@5 ≤ three-stage 且 merge-recall@5 ≥ three-stage → P5b 可翻转 pin。`);
