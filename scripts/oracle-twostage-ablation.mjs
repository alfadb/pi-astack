#!/usr/bin/env node
/**
 * ADR 0036: stage1 边际价值量化 — three-stage(现状) vs two-stage(跳 stage1) 对照。
 *
 * 同一 query 同 corpus:
 *   three = stage0 → stage1 LLM 选 top-50 → stage2 精排 top-10
 *   two   = stage0 top-K → stage2 精排 top-10(跳 stage1, stage1Skip=true)
 * 对比最终 hits:
 *   coverage(three⊆two) = two 是否保留 three 会选的 entry(删 stage1 是否丢 recall)
 *   jaccard = 一致性
 * 必须对照 three-vs-three 随机性基线(ORACLE_SKIP=0): 若 two-vs-three ≈ 基线 → stage1 冗余可删。
 * 强 model(ORACLE_MODEL, 默认 v4-pro)避免弱 model 噪声。
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

const { llmSearchEntriesWithVerdict } = (await jiti.import(path.join(repoRoot, "extensions/memory/llm-search.ts"))).__oracleKernel; // ADR 0037: oracle 经 __oracleKernel 拿私有 wrapper
const { parseEntry } = await jiti.import(path.join(repoRoot, "extensions/memory/parser.ts"));
const { resolveSettings } = await jiti.import(path.join(repoRoot, "extensions/memory/settings.ts"));

// 模型无关 registry: 从 models.json 解析 baseUrl+apiKey(!command 从 secrets.json), 任何已配 key 的 provider 都能跑(见 _oracle-registry.mjs)
const { registry, embedKey: EMBED_KEY } = await makeOracleRegistry(MODELS_JSON);
if (!EMBED_KEY) { console.log("SKIP — no embedding key in ~/.pi/secrets.json"); process.exit(0); }

const baseSettings = resolveSettings();
function walkMd(dir) { const o = []; if (!fs.existsSync(dir)) return o; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) o.push(...walkMd(p)); else if (e.name.endsWith(".md") && !e.name.startsWith("_")) o.push(p); } return o; }
const corpus = [];
const pgRoot = path.join(ABRAIN, "projects", "pi-global");
for (const f of walkMd(pgRoot)) { const e = await parseEntry(f, { scope: "project", root: pgRoot, label: "pi-global" }, pgRoot); if (e && e.status === "active") corpus.push(e); }
const kdir = path.join(ABRAIN, "knowledge");
for (const f of walkMd(kdir)) { const e = await parseEntry(f, { scope: "world", root: kdir, label: "knowledge" }, kdir); if (e && e.status === "active") corpus.push(e); }

const ORACLE_MODEL = process.env.ORACLE_MODEL || "deepseek/deepseek-v4-pro";
const mk = (skip) => ({ ...baseSettings, search: { ...baseSettings.search, stage0Enabled: true, stage1Model: ORACLE_MODEL, stage2Model: ORACLE_MODEL, stage1Skip: skip } });
// ORACLE_SKIP=0 → 对照臂也 three-stage = three-vs-three 随机性基线
const SKIP = process.env.ORACLE_SKIP !== "0";
const threeS = mk(false), cmpS = mk(SKIP);

// ADR 0036 P6: 共享 16-query 金标集(与 oracle-goldset.mjs 同源, 确认 5 点差距在更大样本稳定)
const QUERIES_PATH = path.join(__dirname, "goldset-queries.json");
const queries = JSON.parse(fs.readFileSync(QUERIES_PATH, "utf8")).map((q) => q.query);
const _off = Number(process.env.ORACLE_OFFSET || 0), _lim = Number(process.env.ORACLE_LIMIT || queries.length);
const runQ = queries.slice(_off, _off + _lim);
const jacc = (a, b) => { const A = new Set(a), B = new Set(b); const i = [...A].filter((x) => B.has(x)).length; const u = new Set([...a, ...b]).size; return u === 0 ? 1 : i / u; };

console.log(`oracle-twostage-ablation | model=${ORACLE_MODEL} | corpus=${corpus.length} | queries=${runQ.length} | mode=${SKIP ? "three-vs-TWO(skip stage1)" : "three-vs-three(随机性基线)"}\n`);
const covs = [], jacs = [];
for (const q of runQ) {
  const three = await llmSearchEntriesWithVerdict(corpus, { query: q }, threeS, registry);
  const cmp = await llmSearchEntriesWithVerdict(corpus, { query: q }, cmpS, registry);
  const ht = three.hits.map((h) => h.slug), hc = cmp.hits.map((h) => h.slug);
  const cov = ht.length === 0 ? 1 : ht.filter((s) => hc.includes(s)).length / ht.length;
  const j = jacc(ht, hc);
  covs.push(cov); jacs.push(j);
  console.log(`Q: ${q}`);
  console.log(`  three(${three.relevance_verdict}) hits=${ht.length} [${ht.slice(0, 5).join(", ")}]`);
  console.log(`  ${SKIP ? "two  " : "three"}(${cmp.relevance_verdict}) hits=${hc.length} [${hc.slice(0, 5).join(", ")}]`);
  console.log(`  → coverage(three⊆cmp)=${(cov * 100).toFixed(0)}%  jaccard=${(j * 100).toFixed(0)}%\n`);
}
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
console.log(`平均 coverage(three⊆${SKIP ? "two" : "three"})=${(avg(covs) * 100).toFixed(1)}%  平均 jaccard=${(avg(jacs) * 100).toFixed(1)}%`);
console.log(`判定: two-vs-three 接近 three-vs-three 基线 → stage1 冗余可删(9× 降本); 显著低 → stage1 有边际价值。`);
