#!/usr/bin/env node
/**
 * ADR 0036 §9.1 条件 3 smoke: orderStage0Candidates window-aware 排序。
 * 验证 stage1Skip 直取 slice(0, windowSize) 时 stale-heavy 不挤出 dense top-K,
 * 且 freshness 不变量(新写 entry 必进窗口)成立。纯函数, 零 LLM/embedding。
 */
import { createJiti } from "jiti";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url);
const { orderStage0Candidates } = await jiti.import(path.join(__dirname, "..", "extensions/memory/llm-search.ts"));

const dense = Array.from({ length: 100 }, (_, i) => `d${i}`);
const allow = () => true;
const WIN = 50, MAXCAND = 400, RATIO = 0.1;
const reserve = Math.ceil(WIN * RATIO); // 5
let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"}: ${msg}`); if (!cond) fails++; };

// 场景 A: stale-heavy(50 stale, s0 最新)。窗口应 = 45 dense + 5 最新 stale。
{
  const stale = Array.from({ length: 50 }, (_, i) => `s${i}`); // s0 newest
  const ordered = orderStage0Candidates(dense, [], stale, stale, { allow, windowSize: WIN, floorReserveInWindow: reserve, maxCand: MAXCAND });
  const window = ordered.slice(0, WIN);
  const denseInWin = window.filter((s) => s.startsWith("d")).length;
  const staleInWin = window.filter((s) => s.startsWith("s")).length;
  ok(denseInWin === WIN - reserve, `stale-heavy: 窗口含 ${denseInWin} dense (期望 ${WIN - reserve}, dense 未被挤出)`);
  ok(staleInWin === reserve, `stale-heavy: 窗口含 ${staleInWin} stale 预留 (期望 ${reserve})`);
  ok(window.includes("s0"), `stale-heavy: 最新写入 s0 进窗口 (freshness 不变量)`);
  ok(window.includes("d0") && window.includes("d44"), `stale-heavy: dense top (d0..d44) 全在窗口`);
  ok(!window.includes("d45"), `stale-heavy: d45 被预留挤到窗口外 (预期, 让位最新 stale)`);
}

// 场景 B: fresh 索引(0 stale)。窗口应全 dense d0..d49(与 P6 eval 现状一致)。
{
  const ordered = orderStage0Candidates(dense, [], [], [], { allow, windowSize: WIN, floorReserveInWindow: reserve, maxCand: MAXCAND });
  const window = ordered.slice(0, WIN);
  ok(window.every((s) => s.startsWith("d")), `fresh: 窗口全 dense (0 stale 时无退化)`);
  ok(window[0] === "d0" && window[WIN - 1] === "d49", `fresh: 窗口 = dense top-50 顺序`);
}

// 场景 C: 单条新写(1 stale)。新 entry 必进窗口, 其余 dense 填满。
{
  const ordered = orderStage0Candidates(dense, [], ["s0"], ["s0"], { allow, windowSize: WIN, floorReserveInWindow: reserve, maxCand: MAXCAND });
  const window = ordered.slice(0, WIN);
  ok(window.includes("s0"), `单写: s0 进窗口 (freshness 不变量)`);
  ok(window.filter((s) => s.startsWith("d")).length === WIN - 1, `单写: 其余 ${WIN - 1} 槽全 dense (无过度预留)`);
}

// 场景 D: 去重(slug 不重复); 池上限 = maxCand。
{
  const stale = Array.from({ length: 500 }, (_, i) => `s${i}`);
  const ordered = orderStage0Candidates(dense, [], stale, stale, { allow, windowSize: WIN, floorReserveInWindow: reserve, maxCand: MAXCAND });
  ok(new Set(ordered).size === ordered.length, `去重: 无重复 slug`);
  ok(ordered.length <= MAXCAND, `上限: 池 ${ordered.length} ≤ maxCand ${MAXCAND}`);
}

console.log(fails === 0 ? "\n✅ ALL PASS — 条件 3 window-aware 排序验证通过" : `\n❌ ${fails} FAIL`);
process.exit(fails === 0 ? 0 : 1);
