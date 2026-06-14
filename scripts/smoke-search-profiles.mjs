#!/usr/bin/env node
/**
 * ADR 0037 P1 等价门(deterministic, 免 LLM): 断言 5 个 SearchProfile 经
 * resolveProfileExecution 解析出的 (search settings, filters, returnVerdict) 与迁移前
 * 5 个调用方手搓的策略**逐项一致**。核心是 sedimentDedup 的泄漏防护: 即便全局
 * stage1Skip/sparseBM25=true, dedup profile 也强制二者 false。
 */
import { createJiti } from "jiti";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url);
const { SEARCH_PROFILES, resolveProfileExecution } = await jiti.import(path.join(__dirname, "..", "extensions/memory/search-profiles.ts"));
const { resolveSettings } = await jiti.import(path.join(__dirname, "..", "extensions/memory/settings.ts"));

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"}: ${msg}`); if (!cond) fails++; };
const base = resolveSettings();
const R = (name, settings = base, callerFilters) => resolveProfileExecution(SEARCH_PROFILES[name], settings, callerFilters);

// toolSearch: caller-overridable —— filters 透传, search 不变, plain hits
{
  const cf = { kinds: ["decision"], status: ["active"], limit: 3 };
  const r = R("toolSearch", base, cf);
  ok(JSON.stringify(r.filters) === JSON.stringify(cf), "toolSearch: filters == callerFilters 透传");
  ok(R("toolSearch", base, undefined).filters && Object.keys(R("toolSearch").filters).length === 0, "toolSearch: 无 callerFilters → 空 filters(内核用 settings 默认)");
  ok(r.returnVerdict === false, "toolSearch: returnVerdict false");
  ok(r.search.stage1Skip === base.search.stage1Skip && r.search.sparseBM25 === base.search.sparseBM25, "toolSearch: search 无覆写(继承全局)");
}
// decideSearch: status:[active], limit:8, plain; search 用全局(stage1Model 即 search model)
{
  const r = R("decideSearch");
  ok(JSON.stringify(r.filters.status) === JSON.stringify(["active"]) && r.filters.limit === 8, "decideSearch: status:[active] limit:8");
  ok(r.returnVerdict === false, "decideSearch: returnVerdict false");
  ok(r.search.stage1Skip === base.search.stage1Skip, "decideSearch: search 无覆写");
}
// pathAInject: status:[active], limit=pathA.searchLimit(resolver, 不冻结), verdict
{
  const r = R("pathAInject");
  ok(JSON.stringify(r.filters.status) === JSON.stringify(["active"]), "pathAInject: status:[active]");
  ok(r.filters.limit === base.pathA.searchLimit, `pathAInject: limit == pathA.searchLimit(${base.pathA.searchLimit})`);
  ok(r.returnVerdict === true, "pathAInject: returnVerdict true(走 verdict)");
  // resolver 不冻结: 改 pathA.searchLimit → filters.limit 跟随
  const bumped = { ...base, pathA: { ...base.pathA, searchLimit: base.pathA.searchLimit + 7 } };
  ok(R("pathAInject", bumped).filters.limit === base.pathA.searchLimit + 7, "pathAInject: limit 是 resolver(随 settings 变, 非冻结常量)");
}
// sedimentDedup: status:[all], limit:5; **强制 stage1Skip=false + sparseBM25=false**(泄漏防护)
{
  const r = R("sedimentDedup");
  ok(JSON.stringify(r.filters.status) === JSON.stringify(["all"]) && r.filters.limit === 5, "sedimentDedup: status:[all] limit:5");
  ok(r.search.stage1Skip === false, "sedimentDedup: stage1Skip 强制 false");
  ok(r.search.sparseBM25 === false, "sedimentDedup: sparseBM25 强制 false");
  // 关键: 即便全局 flip 为 true, dedup profile 仍钉死 false(泄漏防护)
  const allOn = { ...base, search: { ...base.search, stage1Skip: true, sparseBM25: true } };
  const r2 = R("sedimentDedup", allOn);
  ok(r2.search.stage1Skip === false && r2.search.sparseBM25 === false, "sedimentDedup: 全局 true 时仍强制 false —— 全局 flag 漏不进去(ADR 0037 核心保证)");
  ok(r.returnVerdict === false, "sedimentDedup: returnVerdict false");
}
// correctionSearch: status:[active], limit:10
{
  const r = R("correctionSearch");
  ok(JSON.stringify(r.filters.status) === JSON.stringify(["active"]) && r.filters.limit === 10, "correctionSearch: status:[active] limit:10");
  ok(r.returnVerdict === false, "correctionSearch: returnVerdict false");
}
// 全 profile 都在 registry
ok(["toolSearch","decideSearch","pathAInject","sedimentDedup","correctionSearch"].every((n) => SEARCH_PROFILES[n]?.name === n), "5 profile 全部注册");

// ADR 0037 强制 grep-guard: 生产代码(extensions/, 除内核 llm-search.ts)禁止直接调
// 裸 wrapper 或引用 __oracleKernel —— 生产唯一入口是 runMemorySearch(profile, ...)。
// 区分调用(name + "(") 与注释提及(name + 空格/无括号): 只拦调用形式。
{
  const extRoot = path.join(__dirname, "..", "extensions");
  const walkTs = (d) => { const o = []; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) o.push(...walkTs(p)); else if (e.name.endsWith(".ts")) o.push(p); } return o; };
  const callRe = /(?<![\w.])(llmSearchEntries|llmSearchEntriesWithVerdict)\(|__oracleKernel/;
  const offenders = [];
  for (const f of walkTs(extRoot)) {
    if (f.endsWith(`${path.sep}memory${path.sep}llm-search.ts`)) continue; // 内核自身
    const lines = fs.readFileSync(f, "utf8").split("\n");
    lines.forEach((ln, i) => {
      const t = ln.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return; // 跳注释行
      if (callRe.test(ln)) offenders.push(`${path.relative(extRoot, f)}:${i + 1}`);
    });
  }
  ok(offenders.length === 0, `enforcement: extensions/ 无裸 wrapper 调用/·__oracleKernel 引用${offenders.length ? " — OFFENDERS: " + offenders.join(", ") : ""}`);
}

console.log(fails === 0 ? "\n✅ ALL PASS — 5 profile 等价于迁移前手搓策略; dedup 泄漏防护成立" : `\n❌ ${fails} FAIL`);
process.exit(fails === 0 ? 0 : 1);
