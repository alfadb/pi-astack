#!/usr/bin/env node
/**
 * smoke-time-injector — verifies the time-injector extension's pure
 * formatting + dedup logic.
 *
 * Loading strategy follows smoke-persistent-input-history.mjs: use the
 * locally-installed `typescript` package to transpile the .ts source
 * to CommonJS, write to a tmp .cjs, and require it. This avoids
 * jiti/Node-24 compatibility noise.
 *
 * What this asserts (no pi runtime needed; formatTimeLine / composeBlock
 * / stripExistingBlock are pure):
 *
 *   1. formatTimeLine() output matches the documented shape
 *      "Current date and time: YYYY-MM-DD HH:MM ±HHMM (Zone, Weekday)"
 *   2. Precision IS minute (no seconds substring)
 *   3. composeBlock() wraps with BEGIN/END markers
 *   4. stripExistingBlock() is idempotent
 *   5. stripExistingBlock() removes a block injected by composeBlock()
 *   6. Re-injection after stripping yields exactly ONE block
 *   7. Two simulated before_agent_start fires still yield ONE block
 *
 * Run: node scripts/smoke-time-injector.mjs
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

const srcPath = path.join(repoRoot, "extensions/time-injector/index.ts");
const transpiled = ts.transpileModule(fs.readFileSync(srcPath, "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
  },
}).outputText;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-ti-"));
const tmpFile = path.join(tmpDir, "time-injector.cjs");
fs.writeFileSync(tmpFile, transpiled);

const mod = require(tmpFile);
const { formatTimeLine, composeBlock, stripExistingBlock, BEGIN_MARKER, END_MARKER } = mod.__TEST;

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok    ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}

console.log("smoke: time-injector");

// 1. shape
const line = formatTimeLine();
const shape = /^Current date and time: \d{4}-\d{2}-\d{2} \d{2}:\d{2} [+-]\d{4} \([^,]+, (Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\)$/;
check("formatTimeLine shape", shape.test(line), `got: ${line}`);

// 2. no seconds (line has exactly one HH:MM, not HH:MM:SS)
check("no seconds in line", !/\d{2}:\d{2}:\d{2}/.test(line), `got: ${line}`);

// 3. composeBlock wraps with markers
const block = composeBlock(line);
check("block starts with BEGIN_MARKER", block.startsWith(BEGIN_MARKER));
check("block ends with END_MARKER", block.endsWith(END_MARKER));
check("block contains the time line", block.includes(line));

// 4. strip idempotency
const sysPrompt = `You are a helpful assistant.\nCurrent date: 2026-05-28\nCurrent working directory: /tmp\n\n${block}\n`;
const stripped1 = stripExistingBlock(sysPrompt);
const stripped2 = stripExistingBlock(stripped1);
check("strip is idempotent", stripped1 === stripped2);

// 5. strip removes the block (no markers remain)
check("strip removes BEGIN_MARKER", !stripped1.includes(BEGIN_MARKER));
check("strip removes END_MARKER", !stripped1.includes(END_MARKER));
check(
  "strip preserves non-block content",
  stripped1.includes("You are a helpful assistant.") && stripped1.includes("/tmp"),
);

// 6. re-injection produces exactly ONE block
const reInjected = `${stripped1.replace(/\n+$/, "")}\n\n${block}\n`;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const countMarker = (text, marker) =>
  (text.match(new RegExp(escapeRe(marker), "g")) || []).length;
check("re-inject has exactly 1 BEGIN", countMarker(reInjected, BEGIN_MARKER) === 1);
check("re-inject has exactly 1 END", countMarker(reInjected, END_MARKER) === 1);

// 7. simulating two consecutive before_agent_start fires:
//    handler strips first, then re-appends. Net result should remain 1 block.
function simulateFire(systemPrompt) {
  const cleaned = stripExistingBlock(systemPrompt);
  return `${cleaned.replace(/\n+$/, "")}\n\n${composeBlock(formatTimeLine())}\n`;
}
const afterFirst = simulateFire(sysPrompt);
const afterSecond = simulateFire(afterFirst);
check("double-fire dedupe yields 1 BEGIN", countMarker(afterSecond, BEGIN_MARKER) === 1);
check("double-fire dedupe yields 1 END", countMarker(afterSecond, END_MARKER) === 1);

// 8. Sanity: the appended line is on a separate line from the prior
//    cwd line (no smashed-together "tmp<!-- pi-astack..." accidents).
check(
  "block is on its own paragraph (blank line before BEGIN_MARKER)",
  afterFirst.includes(`\n\n${BEGIN_MARKER}`),
);

console.log(`\nfailures: ${failures}`);
console.log(`sample line: ${line}`);

// cleanup
try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch {
  // best-effort
}

process.exit(failures === 0 ? 0 : 1);
