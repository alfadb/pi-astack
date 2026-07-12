#!/usr/bin/env node
/**
 * smoke-script-registry-drift — keep smoke gate discovery honest.
 *
 * package.json#scripts is the live truth for default smoke gates. Every
 * scripts/smoke-*.mjs file must be registered under a smoke:* npm script,
 * and every smoke:* script must point at an existing scripts/smoke-*.mjs file.
 *
 * Live LLM prompt dossiers are intentionally excluded from the default gate:
 * they must use scripts/dossier-*.mjs and be registered under dossier:*.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const scriptsDir = path.join(repoRoot, "scripts");
const packagePath = path.join(repoRoot, "package.json");
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const packageScripts = pkg.scripts ?? {};

const smokeFiles = fs.readdirSync(scriptsDir)
  .filter((name) => /^smoke-.*\.mjs$/.test(name))
  .map((name) => `scripts/${name}`)
  .sort();
const dossierFiles = fs.readdirSync(scriptsDir)
  .filter((name) => /^dossier-.*\.mjs$/.test(name))
  .map((name) => `scripts/${name}`)
  .sort();

function smokeFileFromCommand(command) {
  const match = /^node\s+(scripts\/smoke-[^\s]+\.mjs)$/.exec(command);
  return match?.[1] ?? null;
}

function dossierFileFromCommand(command) {
  const match = /^node\s+(scripts\/dossier-[^\s]+\.mjs)(?:\s+.*)?$/.exec(command);
  return match?.[1] ?? null;
}

const registeredSmoke = Object.entries(packageScripts)
  .filter(([name]) => name.startsWith("smoke:"));
const registeredDossiers = Object.entries(packageScripts)
  .filter(([name]) => name.startsWith("dossier:"));
const registeredSmokeFiles = new Map(
  registeredSmoke.map(([name, command]) => [name, smokeFileFromCommand(command)]),
);
const registeredDossierFiles = new Map(
  registeredDossiers.map(([name, command]) => [name, dossierFileFromCommand(command)]),
);

const smokeFileSet = new Set(smokeFiles);
const registeredSmokeFileSet = new Set([...registeredSmokeFiles.values()].filter(Boolean));
const dossierFileSet = new Set(dossierFiles);
const registeredDossierFileSet = new Set([...registeredDossierFiles.values()].filter(Boolean));

const failures = [];
function check(name, ok, detail = "") {
  if (ok) {
    console.log(`  ok    ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

console.log("smoke script registry drift");

const malformedSmoke = [...registeredSmokeFiles]
  .filter(([, file]) => !file)
  .map(([name]) => `${name}=${packageScripts[name]}`);
check("all smoke:* scripts use `node scripts/smoke-*.mjs`", malformedSmoke.length === 0, malformedSmoke.join("\n"));

const unregisteredSmokeFiles = smokeFiles.filter((file) => !registeredSmokeFileSet.has(file));
check("every scripts/smoke-*.mjs file is registered", unregisteredSmokeFiles.length === 0, unregisteredSmokeFiles.join("\n"));

const missingSmokeTargets = [...registeredSmokeFiles]
  .filter(([, file]) => file && !smokeFileSet.has(file))
  .map(([name, file]) => `${name} -> ${file}`);
check("every smoke:* target exists on disk", missingSmokeTargets.length === 0, missingSmokeTargets.join("\n"));

const duplicateSmokeTargets = [...registeredSmokeFileSet]
  .filter((file) => [...registeredSmokeFiles.values()].filter((value) => value === file).length > 1);
check("no smoke file is registered more than once", duplicateSmokeTargets.length === 0, duplicateSmokeTargets.join("\n"));

const malformedDossiers = [...registeredDossierFiles]
  .filter(([, file]) => !file)
  .map(([name]) => `${name}=${packageScripts[name]}`);
check("all dossier:* scripts use `node scripts/dossier-*.mjs`", malformedDossiers.length === 0, malformedDossiers.join("\n"));

const unregisteredDossiers = dossierFiles.filter((file) => !registeredDossierFileSet.has(file));
check("every scripts/dossier-*.mjs file is registered as dossier:*", unregisteredDossiers.length === 0, unregisteredDossiers.join("\n"));

const missingDossierTargets = [...registeredDossierFiles]
  .filter(([, file]) => file && !dossierFileSet.has(file))
  .map(([name, file]) => `${name} -> ${file}`);
check("every dossier:* target exists on disk", missingDossierTargets.length === 0, missingDossierTargets.join("\n"));

const dossierUnderSmoke = registeredSmoke
  .filter(([, command]) => /scripts\/dossier-/.test(command))
  .map(([name, command]) => `${name}=${command}`);
check("dossier scripts are not in the default smoke gate", dossierUnderSmoke.length === 0, dossierUnderSmoke.join("\n"));

const retiredRuntimeArtifacts = [
  "extensions/_shared/production-trace-replay.ts",
  "scripts/dossier-convergence-production-trace.mjs",
  "scripts/_convergence-production-trace-worker.mjs",
];
const retiredOnDisk = retiredRuntimeArtifacts.filter((file) => fs.existsSync(path.join(repoRoot, file)));
const retiredPackageRefs = Object.entries(packageScripts).filter(([, command]) => retiredRuntimeArtifacts.some((file) => String(command).includes(file)));
check("retired P1-B runtime trace artifacts stay forward-deleted", retiredOnDisk.length === 0, retiredOnDisk.join("\n"));
check("package scripts do not resurrect retired P1-B runtime trace entrypoints", retiredPackageRefs.length === 0, retiredPackageRefs.map(([name, command]) => `${name}=${command}`).join("\n"));

check("retired prepush alias stays removed", packageScripts["prepush:adr0039"] === undefined);
check(
  "standalone ADR0039 checker has a neutral manual-check alias",
  packageScripts["check:adr0039-integrity"] === "node scripts/pre-push-adr0039-reconcile.mjs --abrain ~/.abrain",
  String(packageScripts["check:adr0039-integrity"] ?? "missing"),
);
const manualCheckerSource = fs.readFileSync(path.join(repoRoot, "scripts/pre-push-adr0039-reconcile.mjs"), "utf8");
check("standalone ADR0039 checker is not documented as a live hook/runtime gate", manualCheckerSource.includes("manual local integrity checker") && !manualCheckerSource.includes("called by pushAsync") && !manualCheckerSource.includes("git push"));
check(
  "ADR0039 manual checker output uses local-integrity wording",
  manualCheckerSource.includes("PASS — ADR0039 local integrity check passed.") &&
    !manualCheckerSource.includes("PASS — ADR0039 pre-push blocker passed."),
);
const reconcileSmokeSource = fs.readFileSync(path.join(repoRoot, "scripts/smoke-adr0039-reconcile.mjs"), "utf8");
check(
  "ADR0039 reconcile runner output avoids push-gate/pre-push wording",
  reconcileSmokeSource.includes("PASS — ADR0039 local integrity checks passed.") &&
    !reconcileSmokeSource.includes("PASS — ADR0039 reconcile push-gate checks passed.") &&
    !reconcileSmokeSource.includes("PASS — B4 pre-push hardblock"),
);

console.log(`\nsummary: smoke_files=${smokeFiles.length} smoke_scripts=${registeredSmoke.length} dossier_files=${dossierFiles.length} dossier_scripts=${registeredDossiers.length}`);
if (failures.length) {
  console.log(`FAIL — ${failures.length} registry drift check(s) failed.`);
  process.exit(1);
}
console.log("PASS — smoke/dossier registry is in sync.");
process.exit(0);
