#!/usr/bin/env node
// Smoke: pi 0.79.0 Project Trust boundary for dispatch sub-agent loader.
//
// This is a structural source-text check. It pins the dispatch side of the
// contract: the shared in-process sub-agent ResourceLoader must not implicitly
// trust project-local inputs when loading the global extension stack.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const dispatchPath = resolve(repoRoot, "extensions/dispatch/index.ts");

let pass = 0;
let fail = 0;
function ok(msg) { pass++; console.log(`  ✓ ${msg}`); }
function bad(msg) { fail++; console.log(`  ✗ ${msg}`); }

const src = readFileSync(dispatchPath, "utf8");
const infraMatch = src.match(/function getSharedInfra\(\): Promise<[\s\S]*?\n}\n\n\/\*\*/);

if (!infraMatch) {
  bad("could not locate getSharedInfra block — dispatch source shape changed");
} else {
  const block = infraMatch[0];

  if (/SettingsManager\.create[\s\S]*?\{\s*projectTrusted:\s*false\s*\}/.test(block)) {
    ok("SettingsManager.create explicitly initializes projectTrusted:false");
  } else {
    bad("SettingsManager.create must pass { projectTrusted:false } for shared sub-agent loader");
  }

  if (/noExtensions:\s*false/.test(block)) {
    ok("shared loader still loads user/global extensions for sub-agent tools");
  } else {
    bad("shared loader noExtensions:false missing — memory/web tools may not load");
  }

  if (/resourceLoader\.reload\(\)/.test(block)) {
    ok("shared loader reload preserves the explicit untrusted project state");
  } else {
    bad("shared loader reload shape changed — re-audit Project Trust behavior");
  }

  if (/resolveProjectTrust/.test(block)) {
    bad("shared loader must not invent a trust decision via resolveProjectTrust");
  } else {
    ok("shared loader does not bypass trust via resolveProjectTrust");
  }

  if (/Project Trust[\s\S]*?project-local inputs[\s\S]*?projectTrusted:false/.test(block)) {
    ok("comment documents the pi 0.79.0 Project Trust boundary");
  } else {
    bad("missing design comment for pi 0.79.0 Project Trust boundary");
  }
}

console.log();
if (fail === 0) {
  console.log(`✅ dispatch Project Trust boundary: all ${pass} checks passed`);
  process.exit(0);
}

console.error(`❌ dispatch Project Trust boundary: ${fail} failure(s) out of ${pass + fail}`);
process.exit(1);
