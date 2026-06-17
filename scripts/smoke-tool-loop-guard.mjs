#!/usr/bin/env node
/**
 * E 门(deterministic, 免 LLM): tool idle-loop guard。
 * 样本 = 重复工具调用序列; 验证连发抑制 + 假阳性护栏 + settings kill-switch。
 */
import { createJiti } from "jiti";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url);
const {
  newToolLoopState,
  toolCallSignature,
  evaluateToolLoop,
  buildLoopReflection,
  isGuardedTool,
  resolveIdleLoopGuardSettings,
  IDLE_LOOP_GUARD_DEFAULTS,
} = await jiti.import(path.join(__dirname, "..", "extensions/dispatch/tool-loop-guard.ts"));

let fails = 0;
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}: ${m}`); if (!c) fails++; };

// ── 真实 settings.json 落盘校验(kill-switch 显式存在) ──
{
  const p = path.join(os.homedir(), ".pi", "agent", "pi-astack-settings.json");
  const g = resolveIdleLoopGuardSettings(JSON.parse(fs.readFileSync(p, "utf-8")));
  ok(g.enabled === true && g.threshold === 3, `settings.json dispatch.idleLoopGuard = {enabled:true,threshold:3} got ${JSON.stringify(g)}`);
}

// ── 签名 ──
ok(toolCallSignature("read", { path: "A", limit: 5 }) === toolCallSignature("read", { limit: 5, path: "A" }), "签名: 参数 key 顺序无关");
ok(toolCallSignature("read", { path: "A" }) !== toolCallSignature("read", { path: "B" }), "签名: 不同 args 不同");
ok(toolCallSignature("read", { path: "A" }) !== toolCallSignature("bash", { path: "A" }), "签名: 不同 tool 不同");

// 跑一个序列, 收集每步 block 标记
function runSeq(calls, threshold = 3) {
  const st = newToolLoopState();
  return calls.map(([t, a]) => evaluateToolLoop(st, toolCallSignature(t, a), threshold).block);
}

// ── 样本: 同一 (read,A) 连发 4 次 → 第 3、4 次被抑制 ──
{
  const A = ["read", { path: "A" }];
  const blocks = runSeq([A, A, A, A]);
  ok(JSON.stringify(blocks) === JSON.stringify([false, false, true, true]), `spin: read A ×4 → [f,f,t,t] got ${JSON.stringify(blocks)}`);
}

// ── 样本: read A, read A, read B, read B → 不同调用重置 streak, 不抑制 ──
{
  const blocks = runSeq([["read", { path: "A" }], ["read", { path: "A" }], ["read", { path: "B" }], ["read", { path: "B" }]]);
  ok(blocks.every((b) => b === false), `不同调用打断 streak → 不抑制 got ${JSON.stringify(blocks)}`);
}

// ── 假阳性护栏: read A, edit A, read A, edit A, read A → read A 从不连发 → 从不抑制 ──
{
  const rA = ["read", { path: "A" }], eA = ["edit", { path: "A" }];
  const blocks = runSeq([rA, eA, rA, eA, rA]);
  ok(blocks.every((b) => b === false), `交错 read/edit 同文件 → 从不抑制(假阳性护栏) got ${JSON.stringify(blocks)}`);
}

// ── bash 豁免: timeful poll(sleep+curl / pgrep / docker ps)不误伤 + 避开 vault 交互 ──
ok(isGuardedTool("read") && isGuardedTool("grep") && isGuardedTool("dispatch_agent"), "isGuardedTool: read/grep/dispatch_agent 受守");
ok(!isGuardedTool("bash"), "isGuardedTool: bash 豁免(连发 poll 不误伤)");
// ── 受守工具(grep)不同 args 不算 spin ──
{
  const blocks = runSeq([["grep", { pattern: "a" }], ["grep", { pattern: "b" }], ["grep", { pattern: "a" }]]);
  ok(blocks.every((b) => b === false), `不同 grep → 不抑制 got ${JSON.stringify(blocks)}`);
}

// ── threshold=2 更激进: 第 2 次起抑制 ──
{
  const A = ["read", { path: "A" }];
  ok(JSON.stringify(runSeq([A, A, A], 2)) === JSON.stringify([false, true, true]), "threshold=2 → 第 2 次起抑制");
}

// ── reflection 内容: 含 tool 名 + 次数 + 改 args 提示 ──
{
  const st = newToolLoopState();
  const sig = toolCallSignature("read", { path: "A" });
  evaluateToolLoop(st, sig, 3); evaluateToolLoop(st, sig, 3);
  const v = evaluateToolLoop(st, sig, 3);
  const msg = buildLoopReflection("read", v.consecutive);
  ok(v.block && msg.includes("read") && msg.includes(String(v.consecutive)) && /vary|different/i.test(msg), `reflection 含 tool/次数/改args 提示`);
}

// ── settings 解析: 默认 / 自定义 / 防误伤 / fail-open ──
ok(JSON.stringify(resolveIdleLoopGuardSettings(undefined)) === JSON.stringify(IDLE_LOOP_GUARD_DEFAULTS), "settings: undefined → 默认");
ok(resolveIdleLoopGuardSettings({ dispatch: { idleLoopGuard: { enabled: false } } }).enabled === false, "settings: enabled=false 生效(kill-switch)");
ok(resolveIdleLoopGuardSettings({ dispatch: { idleLoopGuard: { threshold: 5 } } }).threshold === 5, "settings: 自定义 threshold=5");
ok(resolveIdleLoopGuardSettings({ dispatch: { idleLoopGuard: { threshold: 1 } } }).threshold === IDLE_LOOP_GUARD_DEFAULTS.threshold, "settings: threshold<2 → 回默认(防误伤)");
ok(resolveIdleLoopGuardSettings("garbage").enabled === IDLE_LOOP_GUARD_DEFAULTS.enabled, "settings: 垃圾输入 → fail-open 默认");

console.log(fails === 0 ? "\n✅ ALL PASS — tool idle-loop guard: 连发抑制 + 假阳性护栏 + settings kill-switch" : `\n❌ ${fails} FAIL`);
process.exit(fails === 0 ? 0 : 1);
