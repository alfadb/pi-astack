#!/usr/bin/env node
/** Canonical-path R3.4.2 P1-S4 production read-only shadow dossier. */
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const agentDir = path.resolve(repoRoot, "../..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const shadow = jiti(path.join(repoRoot, "extensions/_shared/canonical-shadow-chain.ts"));

function valueArg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  if (index + 1 >= process.argv.length || process.argv[index + 1].startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return process.argv[index + 1];
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const sourceAbrainHome = path.resolve(valueArg("source", valueArg("source-abrain-home", path.join(os.homedir(), ".abrain"))));
const suppliedShadowHome = valueArg("shadow-home", "");
const shadowAbrainHome = suppliedShadowHome
  ? path.resolve(suppliedShadowHome)
  : fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-canonical-shadow-"));
const keep = hasFlag("keep");
const readConfigDefault = path.join(agentDir, "pi-astack-settings.json");
const readConfigPath = path.resolve(valueArg("read-config", readConfigDefault));
const knowledgeEventId = valueArg("knowledge-event-id", undefined);
const projectionEventId = valueArg("projection-event-id", undefined);
const sourceL2RelativePath = valueArg("constraint-l2", "l2/views/constraint/latest/compiled-view.md");
let runId = valueArg("run-id", "");
let exitCode = 1;
let shadowHomeValidated = false;

try {
  await shadow.initializeCanonicalShadowHome(shadowAbrainHome, true);
  shadowHomeValidated = true;
  const knowledgeSelection = await shadow.selectCommittedKnowledgeFoldWinner({
    sourceAbrainHome,
    ...(knowledgeEventId ? { eventId: knowledgeEventId } : {}),
  });
  const knowledge = knowledgeSelection.anchor;
  const genesisSelection = await shadow.selectConstraintGenesisProjection({
    sourceAbrainHome,
    sourceL2RelativePath,
    ...(projectionEventId ? { projectionEventId } : {}),
  });
  const projection = genesisSelection.projection;
  if (!runId) {
    runId = shadow.deriveCanonicalShadowRunId({
      sourceGitHead: knowledge.sourceGitHead,
      knowledgeEventId: knowledge.eventId,
      projectionEventId: projection.eventId,
    });
  }
  const result = await shadow.createCanonicalPathShadowDossier({
    sourceAbrainHome,
    shadowAbrainHome,
    runId,
    knowledgeEventId: knowledge.eventId,
    projectionEventId: projection.eventId,
    sourceL2RelativePath,
    ...(fs.existsSync(readConfigPath) ? { readConfigPath } : {}),
  });
  const report = result.report;
  console.log("canonical-path R3.4.2 P1-S4 shadow dossier");
  console.log(`sourceAbrainHome=${sourceAbrainHome}`);
  console.log(`shadowAbrainHome=${shadowAbrainHome}`);
  console.log(`runId=${runId}`);
  console.log(`knowledgeEventId=${knowledge.eventId}`);
  console.log(`projectionEventId=${projection.eventId}`);
  console.log(`reportPath=${result.reportPath}`);
  console.log(`dossierSelfHash=${report.dossier_self_hash}`);
  console.log(`reportFileSha256External=${crypto.createHash("sha256").update(fs.readFileSync(result.reportPath)).digest("hex")}`);
  console.log(`phaseDisabledShadowCountBefore=${report.phase_disabled_shadow_count_before}`);
  console.log(`phaseDisabledShadowCountAfter=${report.phase_disabled_shadow_count_after}`);
  for (const field of [
    "sourceChanged",
    "refChanged",
    "indexChanged",
    "worktreeChanged",
    "pushChanged",
    "canonicalChanged",
    "readChanged",
    "foldChanged",
  ]) console.log(`${field}=${report[field]}`);
  exitCode = result.ok ? 0 : 1;
} catch (err) {
  console.error(`FAIL: ${err?.stack || err?.message || String(err)}`);
  exitCode = 1;
} finally {
  if (!keep && shadowHomeValidated) {
    fs.rmSync(shadowAbrainHome, { recursive: true, force: true });
    console.log("shadowKept=false");
  } else {
    console.log(`shadowKept=${keep || shadowHomeValidated === false}`);
  }
}

process.exit(exitCode);
