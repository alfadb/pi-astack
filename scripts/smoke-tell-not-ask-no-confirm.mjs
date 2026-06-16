#!/usr/bin/env node
/**
 * Smoke: INV-TELL-NOT-ASK — capability surfaces carry NO confirmation gate.
 *
 * direction.md INV-TELL-NOT-ASK + 走偏信号 #8: the goal / dispatch / workflow
 * capability surfaces must have ZERO confirmation modal and ZERO per-run human
 * approval gate. Confirmation belongs to the "intent" layer (the user's natural
 * language), never bolted onto the "capability" layer as a [Y/N] gate. The ONLY
 * sanctioned Y/N popup in the whole system is vault_release (a data-egress
 * boundary, ADR 0014/0022) — which lives in the abrain extension, NOT here, and
 * is therefore intentionally excluded from the surfaces checked below.
 *
 * This is a REGRESSION GUARD. 走偏信号 #8 names "goal/workflow/dispatch 能力面
 * 重新出现确认弹窗" as a walk-back trigger that must escalate. The most likely
 * form is a future PR bolting a confirm modal / approval gate onto a tool
 * execute path "for safety". This smoke fails closed if that happens. It
 * complements the workflow_run-specific `--yes` lock in smoke-workflow-executor
 * with a broad cross-surface confirmation-primitive denylist.
 *
 * Static by design: it asserts the absence of confirmation-popup call syntax in
 * the registered tool sources (offline, deterministic — no live model needed).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ok    ${msg}`);
  else { console.log(`  FAIL  ${msg}`); failures++; }
}

// Capability surfaces under INV-TELL-NOT-ASK. `anchors` confirm the file still
// registers the capability (so a moved/renamed surface fails loudly rather than
// silently passing on an empty file). vault_release is intentionally NOT here:
// it is the one sanctioned data-egress Y/N gate.
const SURFACES = [
  {
    name: "goal",
    file: "extensions/goal/index.ts",
    anchors: [/name:\s*["']goal_set["']/, /registerCommand\("goal"/],
  },
  {
    name: "dispatch",
    file: "extensions/dispatch/index.ts",
    anchors: [/name:\s*["']dispatch_agent["']/, /name:\s*["']dispatch_parallel["']/],
  },
  {
    name: "workflow",
    file: "extensions/workflow/index.ts",
    anchors: [/name:\s*["']workflow_run["']/, /registerCommand\("workflow"/],
  },
];

// Confirmation-popup / per-run-approval CALL primitives that must never appear
// on a capability surface. Patterns require call syntax (parens) so a
// descriptive prose comment cannot false-trip the guard. (`--yes` is NOT here:
// workflow legitimately *strips* a legacy `--yes` token — see workflow/index.ts
// "no longer required" — so its mere presence is not a gate; the workflow_run
// no-`--yes`-gate assertion lives in smoke-workflow-executor.)
const FORBIDDEN = [
  /\bui\.confirm\s*\(/,
  /\bconfirmModal\s*\(/,
  /\brequireConfirmation\s*\(/,
  /\bawaitConfirmation\s*\(/,
  /\bpromptForConfirmation\s*\(/,
  /\brequestUserConfirmation\s*\(/,
  /\bperRunApproval\b/,
];

for (const s of SURFACES) {
  const abs = path.join(repoRoot, s.file);
  assert(fs.existsSync(abs), `${s.name}: source present (${s.file})`);
  if (!fs.existsSync(abs)) continue;
  const src = fs.readFileSync(abs, "utf8");
  for (const a of s.anchors) {
    assert(a.test(src), `${s.name}: capability anchor present ${a}`);
  }
  for (const f of FORBIDDEN) {
    assert(!f.test(src), `${s.name}: no confirmation-popup primitive ${f}`);
  }
}

// Teeth check: guard against a future refactor silently emptying the lists.
assert(SURFACES.length === 3, "all three capability surfaces enumerated");
assert(FORBIDDEN.length >= 6, "confirmation-primitive denylist is non-trivial");

console.log("");
if (failures === 0) {
  console.log("✅ INV-TELL-NOT-ASK: no confirmation gate on goal/dispatch/workflow surfaces");
  process.exit(0);
} else {
  console.log(`❌ ${failures} assertion(s) failed`);
  process.exit(1);
}
