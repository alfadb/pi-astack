#!/usr/bin/env node
/**
 * ADR 0035 P4 success criteria assert: 跑一次真实 stage0 search, 验证
 * search-metrics.jsonl 落盘了全部 stage0 观测字段(candidate pool hit rate /
 * fallback / best-rank / dirty-size / embed latency)。
 *
 * 需要 ~/.pi/secrets.json 的 embedding key + chat model(deepseek-v4-flash via registry)。
 */
import { createJiti } from "jiti";
import fs from "node:fs";
import { embeddingConfig } from "./_embedding-config.mjs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeOracleRegistry } from "./_oracle-registry.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url);
const MODELS_JSON = path.join(os.homedir(), ".pi", "agent", "models.json");
const ABRAIN = path.join(os.homedir(), ".abrain");

const EMBEDDING = embeddingConfig();
if (!EMBEDDING.apiKey || !EMBEDDING.baseUrl) { console.log("SKIP: memory.embedding baseUrl/apiKey not configured"); process.exit(0); }

const { llmSearchEntriesWithVerdict } = (await jiti.import(path.join(repoRoot, "extensions/memory/llm-search.ts"))).__oracleKernel; // ADR 0037: 经 __oracleKernel 拿私有 wrapper
const { parseEntry } = await jiti.import(path.join(repoRoot, "extensions/memory/parser.ts"));
const { resolveSettings } = await jiti.import(path.join(repoRoot, "extensions/memory/settings.ts"));
const { memorySearchMetricsPath } = await jiti.import(path.join(repoRoot, "extensions/_shared/runtime.ts"));

// 模型无关 registry: chat 从 models.json 解析，embedding 从 memory.embedding 专用配置解析。
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
const verdict = await llmSearchEntriesWithVerdict(corpus, { query: "embedding 向量检索 sublinear 架构" }, settings, registry, undefined, tmp);

let failed = 0;
const check = (n, c) => { console.log(`  ${c ? "ok  " : "FAIL"}  ${n}`); if (!c) failed++; };

check("search-metrics.jsonl 已落盘", fs.existsSync(metricsPath));
if (fs.existsSync(metricsPath)) {
  const lines = fs.readFileSync(metricsPath, "utf8").trim().split("\n").filter(Boolean);
  const row = JSON.parse(lines[lines.length - 1]);
  // success criteria 字段
  check(`stage1_surface=stage0_hybrid_v1 (${row.stage1_surface})`, row.stage1_surface === "stage0_hybrid_v1");
  check(`search_profile 存在 (${row.search_profile})`, typeof row.search_profile === "string");
  check(`stage1/stage2 model context 存在`, typeof row.stage1_model === "string" && typeof row.stage2_model === "string");
  check(`stage2 candidate/prompt size 存在`, typeof row.stage2_candidates === "number" && typeof row.stage2_prompt_chars === "number" && typeof row.stage2_prompt_tokens_est === "number");
  check(`stage0_mode 存在 (${row.stage0_mode})`, typeof row.stage0_mode === "string");
  check(`stage0_fallback (rate) 存在 (${row.stage0_fallback})`, typeof row.stage0_fallback === "boolean");
  check(`stage0_pool_hit (candidate pool hit rate) 存在 (${row.stage0_pool_hit})`, "stage0_pool_hit" in row);
  check(`stage0_best_dense_rank (best-rank) 存在 (${row.stage0_best_dense_rank})`, typeof row.stage0_best_dense_rank === "number");
  check(`stage0_stale (dirty-size) 存在 (${row.stage0_stale})`, typeof row.stage0_stale === "number");
  check(`stage0_embed_ms (embed latency) 存在 (${row.stage0_embed_ms})`, typeof row.stage0_embed_ms === "number");
  check(`stage0_pool / dense / sparse 存在`, typeof row.stage0_pool === "number" && typeof row.stage0_dense === "number" && typeof row.stage0_sparse === "number");
  check(`corpus_size 存在 (${row.corpus_size})`, typeof row.corpus_size === "number");
  // item-4: retrievalDegraded 经真实路径透传, 且与 metrics stage0_fallback 同源一致
  check(`verdict.retrievalDegraded 透传为 boolean (${verdict.retrievalDegraded})`, typeof verdict.retrievalDegraded === "boolean");
  check(`verdict.retrievalDegraded === stage0_fallback (同源)`, verdict.retrievalDegraded === row.stage0_fallback);
  console.log(`\n  metrics row: ${JSON.stringify(row).slice(0, 400)}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "all stage0 metrics fields present (success criteria met)" : failed + " failed"}`);
process.exit(failed ? 1 : 0);
