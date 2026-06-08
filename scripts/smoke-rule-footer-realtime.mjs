#!/usr/bin/env node
/**
 * Smoke: real-time rules footer refresh (rule-injector).
 *
 * The footer was a session_start snapshot, so a rule written mid-session by
 * background sediment did not surface until /rule reload or restart. The
 * fs.watch + captured-setStatus path re-scans + pushes the footer live. fs.watch
 * timing is integration-flaky, so this exercises the DETERMINISTIC core:
 * refreshRulesFooterRealtime re-scans the rules dir and pushes the correct
 * footer text via the captured globalThis setter.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "abrain-footer-"));
// ABRAIN_HOME is evaluated at import time from ABRAIN_ROOT — set it first.
process.env.ABRAIN_ROOT = tmp;
for (const d of ["rules/always", "rules/listed"]) fs.mkdirSync(path.join(tmp, d), { recursive: true });

const jiti = createJiti(import.meta.url, { moduleCache: false });
const ri = await jiti.import(`${repoRoot}/extensions/abrain/rule-injector/index.ts`);
const { refreshRulesFooterRealtime, resolveRuleInjectorSettings } = ri;
const settings = resolveRuleInjectorSettings();
const cwd = path.join(tmp, "proj");
fs.mkdirSync(cwd, { recursive: true });

const failures = [];
let total = 0;
function assert(cond, msg) { total++; if (!cond) { failures.push(msg); console.log(`  FAIL  ${msg}`); } else console.log(`  ok    ${msg}`); }

let captured;
globalThis.__abrainRules_setFooter = (msg) => { captured = msg; };

// 1. empty rules -> "rules: none"
captured = undefined;
refreshRulesFooterRealtime(cwd, settings);
assert(captured === "🧠 rules: none", `empty -> rules: none, got ${JSON.stringify(captured)}`);

// 2. write a valid global always rule -> footer reflects it live
const rule = `---
id: "rule:global:always:test-glab"
title: "use glab for git.alfadb.cn"
scope: global
kind: "preference"
status: "active"
provenance: "user-expressed"
confidence: 8
tier: "always"
body_hash: "deadbeef"
created: "2026-06-08T00:00:00.000Z"
updated: "2026-06-08T00:00:00.000Z"
schema_version: 1
---

# use glab for git.alfadb.cn

All git.alfadb.cn repos must use glab.
`;
fs.writeFileSync(path.join(tmp, "rules/always/test-glab.md"), rule, "utf-8");

captured = undefined;
refreshRulesFooterRealtime(cwd, settings);
assert(captured === "🧠 rules: 1 always, 0 listed", `after write -> live count, got ${JSON.stringify(captured)}`);

// 3. no captured setter -> no throw (best-effort guard)
delete globalThis.__abrainRules_setFooter;
let threw = false;
try { refreshRulesFooterRealtime(cwd, settings); } catch { threw = true; }
assert(!threw, "no setter captured -> no throw");

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

if (failures.length) { console.log(`\nFAIL — ${failures.length} of ${total} failed.`); process.exit(1); }
console.log(`\nPASS — ${total} assertions (rule footer realtime).`);
