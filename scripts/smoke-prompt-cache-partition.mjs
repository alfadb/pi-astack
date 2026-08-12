#!/usr/bin/env node
/**
 * D 缓存分区门(deterministic, 免 LLM): 验证 volatile-suffix 协议把易变块
 * (path-A 记忆召回) 下沉到 prompt 末尾, 使 session-stable 前缀
 * 跨轮字节一致 —— 这是 Anthropic prefix-cache 命中的结构前提。
 *
 * 模拟真实注入顺序(字母序加载): abrain(rules) → footnote → path-A(wrapped)
 * → model-curator → sediment, 然后 time-injector 作为
 * 末位注入器调用 hoistVolatileSuffix 收口 + 追加 time 块。
 */
import { createJiti } from "jiti";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url);
const { wrapVolatile, hoistVolatileSuffix, VOLATILE_SUFFIX_BEGIN, VOLATILE_SUFFIX_END } =
  await jiti.import(path.join(__dirname, "..", "extensions/_shared/volatile-suffix.ts"));

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"}: ${msg}`); if (!cond) fails++; };

// ── stable blocks (session 内不变) ──
const RULES = "<!-- BEGIN_ABRAIN_RULES -->\n## Rules Catalog\nstable rule body\n<!-- END_ABRAIN_RULES -->";
const FOOTNOTE = "<!-- pi-astack/memory: memory-footnote protocol -->\n## memory-footnote\nstable protocol text";
const MC = "<!-- pi-model-curator: capability snapshot -->\n## Available models\nstable roster";
const SED = "<!-- pi-astack/sediment: main-session read-only contract -->\n## 长期记忆\nstable contract";
const TIME = "<!-- pi-astack/time-injector: minute-precision wall clock -->\nCurrent time ...\n<!-- /pi-astack/time-injector -->";

// ── volatile blocks (每轮变) ──
const pathABlk = (s) => `<!-- pi-astack/memory: path-a relevant memory context -->\n## 第二大脑\nrecall ${s}\n(召回结束)`;

// 模拟整轮装配 + time-injector 末位收口
function assemble({ pathA, time = true }) {
  let p = RULES;
  p += "\n\n" + FOOTNOTE;
  if (pathA !== undefined) p += "\n\n" + wrapVolatile(pathABlk(pathA));
  p += "\n\n" + MC + "\n\n" + SED;
  const hoisted = hoistVolatileSuffix(p); // time-injector finalizer
  return time ? `${hoisted.replace(/\n+$/, "")}\n\n${TIME}\n` : hoisted;
}

// ── Test 1: 分区 —— 全部 stable 块在全部 volatile 块之前 ──
{
  const t = assemble({ pathA: "p1" });
  const iR = t.indexOf(RULES), iF = t.indexOf(FOOTNOTE), iM = t.indexOf(MC), iS = t.indexOf(SED);
  const iPathA = t.indexOf("recall p1"), iTime = t.indexOf("minute-precision wall clock");
  ok(iR < iF && iF < iM && iM < iS, "stable 块按序连续 (rules<footnote<model-curator<sediment)");
  ok(iS < iPathA, "sediment(stable) 在 path-A(volatile) 之前");
  ok(iPathA < iTime, "path-A 在 time 之前");
  ok(t.trimEnd().endsWith("<!-- /pi-astack/time-injector -->"), "time 块在最末");
}

// ── Test 2: 无丢失 ──
{
  const t = assemble({ pathA: "keepP" });
  ok(t.includes("recall keepP"), "volatile 内容无丢失");
}

// ── Test 3: 幂等 ──
{
  const h = assemble({ pathA: "p", time: false });
  ok(hoistVolatileSuffix(h) === h, "hoist 幂等 (再 hoist 不变)");
}

// ── Test 4: 稳定前缀跨轮字节一致 (核心缓存不变式) ──
// 轮A: path-A 内容X; 轮B: path-A 内容Y (内容不同, 前缀仍同)。
{
  const tA = assemble({ pathA: "alpha" });
  const tB = assemble({ pathA: "beta" });
  const preA = tA.slice(0, tA.indexOf(VOLATILE_SUFFIX_BEGIN));
  const preB = tB.slice(0, tB.indexOf(VOLATILE_SUFFIX_BEGIN));
  ok(preA === preB, "稳定前缀字节一致 (path-A 内容不同, 前缀仍同)");
  ok([RULES, FOOTNOTE, MC, SED].every((b) => preA.includes(b)), "稳定前缀含全部 stable 块");
  ok(!preA.includes("alpha") && !preA.includes("beta"), "稳定前缀不含任何 volatile 内容");
}

// ── Test 5: 空/孤儿 wrapper 清理 (易变块清空时 strip 留下的空壳) ──
{
  const orphan = `${RULES}\n\n${VOLATILE_SUFFIX_BEGIN}\n   \n${VOLATILE_SUFFIX_END}\n\n${SED}`;
  const c = hoistVolatileSuffix(orphan);
  ok(!c.includes(VOLATILE_SUFFIX_BEGIN), "空 wrapper 被丢弃 (无残留 marker)");
  ok(c.includes(RULES) && c.includes(SED), "孤儿清理后 stable 块保留");
}

// ── Test 6: 无 volatile 块时是 no-op (只 stable) ──
{
  const t = assemble({ time: false });
  ok(!t.includes(VOLATILE_SUFFIX_BEGIN), "无 volatile 块时不产生 wrapper");
  ok(t.includes(RULES) && t.includes(SED), "纯 stable 装配完好");
}

// ── Test 7: marker collision —— 易变内容里恰含本协议 marker 串, 不得 mis-slice ──
{
  const evil = `危险 ${VOLATILE_SUFFIX_END} 中段 ${VOLATILE_SUFFIX_BEGIN} 尾部`;
  const p = RULES + "\n\n" + FOOTNOTE +
    "\n\n" + wrapVolatile(pathABlk("p") + "\n" + evil) + "\n\n" + MC + "\n\n" + SED;
  const hoisted = hoistVolatileSuffix(p);
  const t = `${hoisted.replace(/\n+$/, "")}\n\n${TIME}\n`;
  const nBegin = t.split(VOLATILE_SUFFIX_BEGIN).length - 1;
  const nEnd = t.split(VOLATILE_SUFFIX_END).length - 1;
  ok(nBegin === 1 && nEnd === 1, `内嵌 marker 转义: 真实 BEGIN/END 各 1 (got ${nBegin}/${nEnd})`);
  const pre = t.slice(0, t.indexOf(VOLATILE_SUFFIX_BEGIN));
  ok([RULES, FOOTNOTE, MC, SED].every((b) => pre.includes(b)) && !pre.includes("危险") && !pre.includes("recall p"),
     "内嵌 marker 不致 volatile 内容泄漏进稳定前缀");
  ok(t.includes("中段") && t.includes("尾部") && t.includes("recall p"), "转义后 volatile 内容仍完整保留");
}

// ── Test 8: 有/无 volatile 块时, stable 连续段字节一致 ──
{
  const tNone = assemble({ time: false });
  const tPathA = assemble({ pathA: "x", time: false });
  const stableRun = (s) => s.slice(s.indexOf(RULES), s.indexOf(SED) + SED.length);
  ok(stableRun(tNone) === stableRun(tPathA), "stable 连续段字节一致 (有/无 volatile 块)");
}

console.log(fails === 0
  ? "\n✅ ALL PASS — volatile-suffix 分区: 稳定前缀跨轮字节一致, 易变块下沉末尾, time 最后, 幂等"
  : `\n❌ ${fails} FAIL`);
process.exit(fails === 0 ? 0 : 1);
