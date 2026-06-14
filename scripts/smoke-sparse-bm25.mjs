#!/usr/bin/env node
/**
 * ADR 0036 P3: char n-gram BM25 sparse vs 朴素子串 sparse — 中文召回对照。
 *
 * 验证: 旧 sparseMatchSlugs 的 term regex /[a-z0-9].../ 对中文零匹配 →
 * 中文 query 的 sparse 通道完全失效。BM25(ASCII+CJK bigram+IDF)应:
 *   - 中文 query: BM25 召回 >> substring(≈0)
 *   - 英文/符号 query: BM25 不劣于 substring(不退化)
 * 无需 LLM/embedding, 纯函数对照。
 */
import { createJiti } from "jiti";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url);
const ABRAIN = path.join(os.homedir(), ".abrain");

const { sparseMatchSlugs, sparseMatchSlugsBM25 } = await jiti.import(path.join(repoRoot, "extensions/memory/llm-search.ts"));
const { parseEntry } = await jiti.import(path.join(repoRoot, "extensions/memory/parser.ts"));

function walkMd(dir) { const o = []; if (!fs.existsSync(dir)) return o; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) o.push(...walkMd(p)); else if (e.name.endsWith(".md") && !e.name.startsWith("_")) o.push(p); } return o; }
const corpus = [];
const pgRoot = path.join(ABRAIN, "projects", "pi-global");
for (const f of walkMd(pgRoot)) { const e = await parseEntry(f, { scope: "project", root: pgRoot, label: "pi-global" }, pgRoot); if (e && e.status === "active") corpus.push(e); }
const kdir = path.join(ABRAIN, "knowledge");
for (const f of walkMd(kdir)) { const e = await parseEntry(f, { scope: "world", root: kdir, label: "knowledge" }, kdir); if (e && e.status === "active") corpus.push(e); }

// 纯中文 query(无任何 ASCII 词) —— 旧 substring regex 对这些应零匹配
const zhQueries = ["盲审 跨厂商 多模型", "向量 检索 架构 知识库", "去重 全库 召回 沉淀", "陈旧 新鲜 不变量"];
const enQueries = ["git singleflight lock index", "ModelRegistry getApiKeyAndHeaders", "stage0 embedding candidate"];

console.log(`smoke-sparse-bm25 | corpus=${corpus.length}\n`);
let failed = 0;
const check = (n, c) => { console.log(`  ${c ? "ok  " : "FAIL"}  ${n}`); if (!c) failed++; };

console.log("中文 query (旧 substring 应≈0, BM25 应召回):");
let zhSubTotal = 0, zhBmTotal = 0;
for (const q of zhQueries) {
  const sub = sparseMatchSlugs(q, corpus).length;
  const bm = sparseMatchSlugsBM25(q, corpus).length;
  zhSubTotal += sub; zhBmTotal += bm;
  console.log(`  "${q}": substring=${sub}  BM25=${bm}  top=[${sparseMatchSlugsBM25(q, corpus).slice(0, 3).join(", ")}]`);
}
check(`纯中文 substring 召回≈0 (实际 ${zhSubTotal}, 印证旧 sparse regex 对中文零匹配)`, zhSubTotal <= 2);
check(`纯中文 BM25 召回 >> substring (BM25 ${zhBmTotal} 远超 substring ${zhSubTotal})`, zhBmTotal > 50);

console.log("\n英文/符号 query (BM25 不应退化):");
let enOk = true;
for (const q of enQueries) {
  const sub = sparseMatchSlugs(q, corpus);
  const bm = sparseMatchSlugsBM25(q, corpus);
  const subTop = new Set(sub.slice(0, 10));
  const overlap = bm.slice(0, 10).filter((s) => subTop.has(s)).length;
  console.log(`  "${q}": substring=${sub.length}  BM25=${bm.length}  top10 overlap=${overlap}`);
  if (bm.length === 0 && sub.length > 0) enOk = false;
}
check(`英文 BM25 召回不退化(均有召回)`, enOk);

console.log(`\n${failed === 0 ? "BM25 char n-gram PASS — 中文 sparse 盲区已补, 英文不退化" : failed + " FAILED"}`);
process.exit(failed ? 1 : 0);
