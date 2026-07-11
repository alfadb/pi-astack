#!/usr/bin/env node
/** P1-B immutable production trace isolated replay dossier CLI. */
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const agentRoot = path.resolve(repoRoot, "../..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const replay = jiti(path.join(repoRoot, "extensions/_shared/production-trace-replay.ts"));

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  if (index + 1 >= process.argv.length || process.argv[index + 1].startsWith("--")) throw new Error(`--${name} requires a value`);
  return process.argv[index + 1];
}
function flag(name) { return process.argv.includes(`--${name}`); }

const source = path.resolve(arg("source", "/home/worker/.abrain"));
const requestedRoot = arg("replay-root", "");
const replayRoot = requestedRoot ? path.resolve(requestedRoot) : fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-p1b-production-trace-"));
const runId = arg("run-id", `p1b-production-trace-${Date.now()}`);
const readConfig = path.resolve(arg("read-config", path.join(agentRoot, "pi-astack-settings.json")));
const keep = flag("keep");
const scenarioConcurrencyText = arg("scenario-concurrency", "4");
const scenarioConcurrency = Number(scenarioConcurrencyText);
if (!/^[1-8]$/.test(scenarioConcurrencyText) || !Number.isInteger(scenarioConcurrency)) throw new Error("--scenario-concurrency must be an integer from 1 through 8");
const workerScript = path.join(repoRoot, "scripts/_convergence-production-trace-worker.mjs");
const invalidated = [];
const attemptDurationsMs = [];
let rootOwned = false;
let exitCode = 1;
let finalResult = null;

try {
  if (requestedRoot) {
    if (fs.existsSync(replayRoot) && fs.readdirSync(replayRoot).length !== 0) throw new Error(`--replay-root must be new or empty: ${replayRoot}`);
    fs.mkdirSync(replayRoot, { recursive: true });
  }
  rootOwned = true;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const attemptRoot = path.join(replayRoot, `attempt-${attempt}`);
    fs.mkdirSync(attemptRoot, { recursive: false });
    const attemptStarted = Date.now();
    let result;
    try {
      result = await replay.runProductionTraceReplay({
        sourceAbrainHome: source,
        replayRoot: attemptRoot,
        runId,
        implementationRoot: repoRoot,
        workerScript,
        ...(fs.existsSync(readConfig) ? { readConfigPath: readConfig } : {}),
        invalidatedAttempts: invalidated,
        scenarioConcurrency,
      });
    } catch (error) {
      attemptDurationsMs.push(Date.now() - attemptStarted);
      const code = String(error?.code || "P1B_ATTEMPT_FAILED");
      const blockingDriftError = code === "SHADOW_SOURCE_REF_DRIFT";
      if (!blockingDriftError) throw error;
      invalidated.push({
        attempt,
        status: "invalidated_source_drift",
        code,
        message_hash: crypto.createHash("sha256").update(String(error?.message || error)).digest("hex"),
      });
      if (attempt === 4) throw error;
      continue;
    }
    attemptDurationsMs.push(Date.now() - attemptStarted);
    const blockingDrift = result.report?.impact_flags?.sourceChanged === true || result.report?.impact_flags?.implementationChanged === true;
    if (blockingDrift) {
      invalidated.push({
        attempt,
        status: "invalidated_source_drift",
        blocking_flags: Object.fromEntries(Object.entries(result.report.impact_flags).filter(([name, changed]) => changed === true && !["stateChanged", "extendedSnapshotChanged"].includes(name))),
        report_sha256: result.reportSha256,
      });
      if (attempt === 4) throw new Error("P1B_SOURCE_DRIFT_STOP: source drift persisted through three permitted reruns");
      continue;
    }
    finalResult = result;
    break;
  }
  if (!finalResult) throw new Error("no stable P1-B production trace replay completed");
  const report = finalResult.report;
  const artifactVerification = await replay.verifyProductionTraceDossierArtifacts(report, {
    bundlePath: path.join(path.dirname(finalResult.reportPath), "source-objects.bundle"),
    implementationRoot: repoRoot,
    reportFilePath: finalResult.reportPath,
    expectedReportSha256: finalResult.reportSha256,
    expectedReportBytes: finalResult.reportBytes,
  });
  console.log("canonical-path P1-B production trace isolated replay");
  console.log(`source=${source}`);
  console.log(`replayRoot=${replayRoot}`);
  console.log(`runId=${runId}`);
  console.log(`scenarioConcurrency=${scenarioConcurrency}`);
  console.log(`attemptDurationsMs=${attemptDurationsMs.join(",")}`);
  console.log(`finalAttempt=${attemptDurationsMs.length}`);
  console.log(`captureWindowDurationMs=${report.execution_timing.capture_window_duration_ms}`);
  console.log(`scenarioDurationsMs=${JSON.stringify(report.execution_timing.scenario_durations_ms)}`);
  console.log(`reportPath=${finalResult.reportPath}`);
  console.log(`reportSha256=${finalResult.reportSha256}`);
  console.log(`reportBytes=${finalResult.reportBytes}`);
  console.log(`traceEntries=${report.trace_manifest.entries.length}`);
  console.log(`traceCohortRoot=${report.trace_manifest.cohort_root}`);
  console.log(`committedL1Count=${report.trace_manifest.full_committed_l1_set_count}`);
  console.log(`productionCurrentL1Count=${report.trace_manifest.production_current_l1_set_count}`);
  console.log(`scenarioCount=${report.scenario_count}`);
  for (const scenario of report.scenarios) console.log(`scenario.${scenario.id}=${scenario.pass ? "pass" : "FAIL"}`);
  for (const [name, value] of Object.entries(report.impact_flags)) console.log(`impact.${name}=${value}`);
  console.log(`invalidatedAttempts=${report.invalidated_attempts.length}`);
  console.log(`artifactVerifier=${JSON.stringify(artifactVerification)}`);
  exitCode = finalResult.ok ? 0 : 1;
} catch (error) {
  console.error(`FAIL: ${error?.stack || error?.message || String(error)}`);
  exitCode = 1;
} finally {
  if (!keep && rootOwned) fs.rmSync(replayRoot, { recursive: true, force: true });
  console.log(`replayKept=${keep}`);
}

process.exit(exitCode);
