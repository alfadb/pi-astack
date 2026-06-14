#!/usr/bin/env node
/**
 * ADR 0035 P4 success criteria assert: 跑一次真实 stage0 search, 验证
 * search-metrics.jsonl 落盘了全部 stage0 观测字段(candidate pool hit rate /
 * fallback / best-rank / dirty-size / embed latency)。
 *
 * 需要 SUB2API_API_KEY_EMBEDDING + chat model(deepseek-v4-flash via registry)。
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
const MODELS_JSON = path.join(os.homedir(), ".pi", "agent", "models.json");
const ABRAIN = path.join(os.homedir(), ".abrain");

const EMBED_KEY = process.env.SUB2API_API_KEY_EMBEDDING;
if (!EMBED_KEY) { console.log("SKIP: no SUB2API_API_KEY_EMBEDDING"); process.exit(0); }

const { llmSearchEntriesWithVerdict } = (await jiti.import(path.join(repoRoot, "extensions/memory/llm-search.ts"))).__oracleKernel; // ADR 0037: 经 __oracleKernel 拿私有 wrapper
const { parseEntry } = await jiti.import(path.join(repoRoot, "extensions/memory/parser.ts"));
const { resolveSettings } = await jiti.import(path.join(repoRoot, "extensions/memory/settings.ts"));
const { memorySearchMetricsPath } = await jiti.import(path.join(repoRoot, "extensions/_shared/runtime.ts"));

// 模型无关 registry: 从 models.json 解析 baseUrl+apiKey($ENV ref)(见 _oracle-registry.mjs)
const { registry } = makeOracleRegistry(MODELS_JSON);

// corpus: world(knowledge) — 小且快, stage0 字段齐全即可
const corpus = [];
const kdir = path.join(ABRAIN, "knowledge");
function walkMd(dir) { const o = []; if (!fs.existsSync(dir)) return o; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) o.push(...walkMd(p)); else if (e.name.endsWith(".md") && !e.name.startsWith("_")) o.push(p); } return o; }
for (const f of walkMd(kdir)) { const e = await parseEntry(f, { scope: "world", root: kdir, label: "knowledge" }, kdir); if (e && e.status === "active") corpus.push(e); }

const base = resolveSettings();
const settings = { ...base, search: { ...base.search, stage0Enabled: true, stage1Model: "deepseek/deepseek-v4-flash", stage2Model: "deepseek/deepseek-v4-flash" } };

// 临时 projectRoot → 隔离 metrics
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stage0-metrics-"));
const metricsPath = memorySearchMetricsPath(tmp);

console.log(`smoke-stage0-metrics (HTTP=live) | corpus=${corpus.length} world | metrics→${metricsPath}\n`);
await llmSearchEntriesWithVerdict(corpus, { query: "embedding 向量检索 sublinear 架构" }, settings, registry, undefined, tmp);

let failed = 0;
const check = (n, c) => { console.log(`  ${c ? "ok  " : "FAIL"}  ${n}`); if (!c) failed++; };

check("search-metrics.jsonl 已落盘", fs.existsSync(metricsPath));
if (fs.existsSync(metricsPath)) {
  const lines = fs.readFileSync(metricsPath, "utf8").trim().split("\n").filter(Boolean);
  const row = JSON.parse(lines[lines.length - 1]);
  // success criteria 字段
  check(`stage1_surface=stage0_hybrid_v1 (${row.stage1_surface})`, row.stage1_surface === "stage0_hybrid_v1");
  check(`stage0_mode 存在 (${row.stage0_mode})`, typeof row.stage0_mode === "string");
  check(`stage0_fallback (rate) 存在 (${row.stage0_fallback})`, typeof row.stage0_fallback === "boolean");
  check(`stage0_pool_hit (candidate pool hit rate) 存在 (${row.stage0_pool_hit})`, "stage0_pool_hit" in row);
  check(`stage0_best_dense_rank (best-rank) 存在 (${row.stage0_best_dense_rank})`, typeof row.stage0_best_dense_rank === "number");
  check(`stage0_stale (dirty-size) 存在 (${row.stage0_stale})`, typeof row.stage0_stale === "number");
  check(`stage0_embed_ms (embed latency) 存在 (${row.stage0_embed_ms})`, typeof row.stage0_embed_ms === "number");
  check(`stage0_pool / dense / sparse 存在`, typeof row.stage0_pool === "number" && typeof row.stage0_dense === "number" && typeof row.stage0_sparse === "number");
  check(`corpus_size 存在 (${row.corpus_size})`, typeof row.corpus_size === "number");
  console.log(`\n  metrics row: ${JSON.stringify(row).slice(0, 400)}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "all stage0 metrics fields present (success criteria met)" : failed + " failed"}`);
process.exit(failed ? 1 : 0);
