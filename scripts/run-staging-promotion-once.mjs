#!/usr/bin/env node
/**
 * Run the staging-promotion executor once (or a small bounded number of
 * forced-due rounds) against a real abrain tree.
 *
 * Usage:
 *   node scripts/run-staging-promotion-once.mjs --abrain ~/.abrain --project-root ~/.pi --rounds 1
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { makeOracleRegistry } from "./_oracle-registry.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const defaultProjectRoot = path.resolve(repoRoot, "..", "..", "..");

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

function expandHome(input) {
  return String(input).replace(/^~(?=$|\/)/, os.homedir());
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf-8").trim();
  return raw ? raw.split(/\n+/).map((line) => JSON.parse(line)) : [];
}

function countPromotionBacklog(stagingDir) {
  const out = {
    files: 0,
    promoteCandidate: 0,
    pendingPromoteCandidate: 0,
    attempted: 0,
    promoted: 0,
    rejected: 0,
    duplicate: 0,
    stagedForReplay: 0,
    clusterSibling: 0,
    error: 0,
  };
  if (!fs.existsSync(stagingDir)) return out;
  for (const name of fs.readdirSync(stagingDir)) {
    if (!name.endsWith(".json")) continue;
    out.files++;
    let entry;
    try { entry = readJson(path.join(stagingDir, name)).entry; } catch { continue; }
    if (!entry || entry.kind !== "provisional-correction") continue;
    const candidate = entry.resolver_disposition === "promote_candidate" || entry.aged_out_decision === "promote_candidate";
    if (!candidate) continue;
    out.promoteCandidate++;
    if (entry.attribution_pending === true && entry.lifecycle_state !== "soft_archived") out.pendingPromoteCandidate++;
    if (entry.promotion_attempted_at) out.attempted++;
    if (entry.promotion_outcome === "promoted") out.promoted++;
    else if (entry.promotion_outcome === "rejected") out.rejected++;
    else if (entry.promotion_outcome === "duplicate") out.duplicate++;
    else if (entry.promotion_outcome === "staged_for_replay") out.stagedForReplay++;
    else if (entry.promotion_outcome === "cluster_sibling") out.clusterSibling++;
    else if (entry.promotion_outcome === "error") out.error++;
  }
  return out;
}

const abrainHome = path.resolve(expandHome(arg("abrain", path.join(os.homedir(), ".abrain"))));
const projectRoot = path.resolve(expandHome(arg("project-root", defaultProjectRoot)));
const rounds = Math.max(1, Math.min(10, Number.parseInt(arg("rounds", "1"), 10) || 1));
const sessionId = arg("session-id", `manual-staging-promotion-${Date.now()}`);
const modelsJsonPath = path.resolve(expandHome(arg("models", path.join(os.homedir(), ".pi", "agent", "models.json"))));

process.env.ABRAIN_ROOT = abrainHome;

const jiti = createJiti(import.meta.url, { interopDefault: true });
const promotionModule = await jiti.import(path.join(repoRoot, "extensions/sediment/staging-promotion.ts"));
const sedimentSettingsModule = await jiti.import(path.join(repoRoot, "extensions/sediment/settings.ts"));
const runtimeModule = await jiti.import(path.join(repoRoot, "extensions/_shared/runtime.ts"));
const promotion = promotionModule.default ?? promotionModule;
const sedimentSettings = sedimentSettingsModule.default ?? sedimentSettingsModule;
const runtime = runtimeModule.default ?? runtimeModule;

const active = runtime.resolveActiveProject(projectRoot, { abrainHome }).activeProject;
if (!active) {
  console.error(`No active abrain project for ${projectRoot}`);
  process.exit(2);
}
const projectId = active.projectId;
const settings = sedimentSettings.resolveSedimentSettings();
const { registry } = makeOracleRegistry(modelsJsonPath);
const ledgerPath = promotion.stagingPromotionLedgerPath();
const stagingPath = path.join(abrainHome, ".state", "sediment", "staging");
const ledgerBefore = readJsonl(ledgerPath);

console.log(JSON.stringify({
  op: "staging_promotion_once_start",
  abrainHome,
  projectRoot,
  projectId,
  rounds,
  sessionId,
  model: settings.stagingPromotionModel || settings.classifierModel || settings.curatorModel,
  before: countPromotionBacklog(stagingPath),
}, null, 2));

const results = [];
for (let i = 0; i < rounds; i++) {
  const selected = await promotion.selectPromoteCandidates(new Date(), 100, { projectRoot, projectId, abrainHome });
  console.log(JSON.stringify({ round: i + 1, selectableBeforeRound: selected.map((c) => c.entry.slug).slice(0, 20), selectableCount: selected.length }, null, 2));
  if (selected.length === 0) break;
  const result = await promotion.runStagingPromotionIfDue({
    projectRoot,
    abrainHome,
    projectId,
    settings,
    modelRegistry: registry,
    sessionId,
    minIntervalMs: 0,
    now: new Date(),
  });
  results.push(result);
  console.log(JSON.stringify({ round: i + 1, result }, null, 2));
  if (result.skipped || result.reviewed_count === 0) break;
}

const ledgerAfter = readJsonl(ledgerPath);
const newRows = ledgerAfter.slice(ledgerBefore.length);
console.log(JSON.stringify({
  op: "staging_promotion_once_done",
  resultCount: results.length,
  totals: results.reduce((acc, r) => {
    acc.reviewed += r.reviewed_count || 0;
    acc.promoted += r.promoted_slugs?.length || 0;
    acc.rejected += r.rejected_slugs?.length || 0;
    acc.duplicate += r.duplicate_slugs?.length || 0;
    acc.stagedForReplay += r.staged_for_replay_slugs?.length || 0;
    return acc;
  }, { reviewed: 0, promoted: 0, rejected: 0, duplicate: 0, stagedForReplay: 0 }),
  ledgerNewRows: newRows,
  after: countPromotionBacklog(stagingPath),
}, null, 2));
