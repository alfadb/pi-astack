#!/usr/bin/env node
// Smoke: pi 0.79.0 Project Trust boundary for dispatch sub-agent loader.
//
// This is a structural source-text check. It pins the dispatch side of the
// contract: each in-process sub-agent ResourceLoader must not implicitly trust
// project-local inputs when loading the global extension stack.

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
const resourcesMatch = src.match(/export async function createSubAgentSessionResources\([\s\S]*?\n}\n\n\/\*\*/);

if (!resourcesMatch) {
  bad("could not locate createSubAgentSessionResources block - dispatch source shape changed");
} else {
  const block = resourcesMatch[0];

  if (/SettingsManager\.create[\s\S]*?\{\s*projectTrusted:\s*false\s*\}/.test(block)) {
    ok("SettingsManager.create explicitly initializes projectTrusted:false");
  } else {
    bad("SettingsManager.create must pass { projectTrusted:false } for each sub-agent loader");
  }

  if (/noExtensions:\s*false/.test(block)) {
    ok("per-session loader still loads user/global extensions for sub-agent tools");
  } else {
    bad("per-session loader noExtensions:false missing - memory/web tools may not load");
  }

  if (/noContextFiles:\s*true/.test(block)) {
    ok("per-session loader keeps noContextFiles:true (parent snapshot via agentsFilesOverride)");
  } else {
    bad("per-session loader must keep noContextFiles:true and inject parent snapshot via override");
  }

  if (/agentsFilesOverride/.test(block)) {
    ok("per-session loader supports agentsFilesOverride for parent contextFiles snapshot");
  } else {
    bad("per-session loader missing agentsFilesOverride injection for parent contextFiles");
  }

  if (/resourceLoader\.reload\(\)/.test(block)) {
    ok("per-session loader reload preserves the explicit untrusted project state");
  } else {
    bad("per-session loader reload shape changed - re-audit Project Trust behavior");
  }

  if (/resolveProjectTrust/.test(block)) {
    bad("sub-agent loader must not invent a trust decision via resolveProjectTrust");
  } else {
    ok("sub-agent loader does not bypass trust via resolveProjectTrust");
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
