#!/usr/bin/env node
/** Read-only replay of the real production dispatch v3 audit and settings. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const productionAudit = path.join(os.homedir(), ".pi", ".pi-astack", "dispatch", "audit.jsonl");
const productionSettings = path.join(os.homedir(), ".pi", "agent", "pi-astack-settings.json");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function finiteNonNegativeInteger(value) {
  return finiteNonNegative(value) && Number.isInteger(value);
}
function validateGovernance(value, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} is not an object`);
  const counters = value.counters;
  const thresholds = value.thresholds;
  assert(counters && typeof counters === "object" && !Array.isArray(counters), `${label}.counters missing`);
  assert(thresholds && typeof thresholds === "object" && !Array.isArray(thresholds), `${label}.thresholds missing`);
  for (const [key, field] of Object.entries(counters)) {
    assert(finiteNonNegativeInteger(field), `${label}.counters.${key} is outside the new finite integer budget domain`);
  }
  for (const [key, field] of Object.entries(thresholds)) {
    const valid = key.endsWith("_ratio") ? finiteNonNegative(field) : finiteNonNegativeInteger(field);
    assert(valid, `${label}.thresholds.${key} is outside the compatible numeric budget domain`);
  }
}

assert(fs.existsSync(productionAudit), `real production dispatch audit not found: ${productionAudit}`);
assert(fs.existsSync(productionSettings), `real production settings not found: ${productionSettings}`);
const settings = JSON.parse(fs.readFileSync(productionSettings, "utf8"));
const configuredProviderLimit = settings?.dispatch?.maxProviderConcurrency;
assert(finiteNonNegativeInteger(configuredProviderLimit), "production dispatch.maxProviderConcurrency is not a finite non-negative integer");

const versions = new Map();
const operations = new Map();
const terminals = new Map();
let lines = 0;
let governanceRows = 0;
let anchoredRows = 0;
let latestTimestamp;
const input = fs.createReadStream(productionAudit, { encoding: "utf8" });
const reader = readline.createInterface({ input, crlfDelay: Infinity });
for await (const line of reader) {
  if (!line.trim()) continue;
  lines++;
  let row;
  try {
    row = JSON.parse(line);
  } catch (error) {
    throw new Error(`production audit line ${lines} is not JSON: ${error.message}`);
  }
  versions.set(row.audit_version, (versions.get(row.audit_version) ?? 0) + 1);
  operations.set(row.operation, (operations.get(row.operation) ?? 0) + 1);
  if (row.terminal_state !== undefined) terminals.set(row.terminal_state, (terminals.get(row.terminal_state) ?? 0) + 1);
  assert(typeof row.session_id === "string" && finiteNonNegativeInteger(row.turn_id), `production audit line ${lines} lost its C6 anchor`);
  anchoredRows++;
  if (row.operation === "worker_run_event") {
    validateGovernance({ counters: row.counters, thresholds: row.thresholds }, `line ${lines}`);
    governanceRows++;
  } else if (Array.isArray(row.worker_run_governance)) {
    row.worker_run_governance.forEach((value, index) => {
      validateGovernance(value, `line ${lines}.worker_run_governance[${index}]`);
      governanceRows++;
    });
  } else if (row.worker_run_governance !== undefined && row.worker_run_governance !== null) {
    validateGovernance(row.worker_run_governance, `line ${lines}.worker_run_governance`);
    governanceRows++;
  }
  if (typeof row.timestamp === "string") latestTimestamp = row.timestamp;
}

assert(lines > 0, "production dispatch audit is empty");
assert(versions.size === 1 && versions.get(3) === lines, `production replay expected additive legacy v3 rows, got ${JSON.stringify(Object.fromEntries(versions))}`);
assert(anchoredRows === lines, "not every production row had an anchor");
assert(governanceRows > 0, "production replay found no real governor budget inputs");
for (const state of terminals.keys()) {
  assert(["completed", "failed", "degraded", "cancelled"].includes(state), `unknown production terminal state ${state}`);
}

const jiti = createJiti(import.meta.url, { moduleCache: false });
const limiterModule = await jiti.import(path.join(root, "extensions/dispatch/process-provider-limiter.ts"));
const auditModule = await jiti.import(path.join(root, "extensions/dispatch/delegation-audit.ts"));
assert(auditModule.DELEGATION_AUDIT_VERSION === 4, "delegation audit must be additive v4");
const limiter = new limiterModule.ProcessProviderLimiter({
  scope: `production-config-readonly-${process.pid}`,
  limits: { production_provider_probe: configuredProviderLimit },
});
if (configuredProviderLimit > 0) {
  const lease = await limiter.acquire("production_provider_probe");
  lease.release();
}
assert(limiter.snapshot().providers.production_provider_probe.active === 0, "real-config limiter probe leaked a lease");

const stat = fs.statSync(productionAudit);
assert((stat.mode & 0o777) === 0o600, `production audit mode is ${(stat.mode & 0o777).toString(8)}, expected 600`);

const evidence = {
  source: "real_production_read_only",
  audit_path: productionAudit,
  settings_path: productionSettings,
  bytes_observed: stat.size,
  mode: (stat.mode & 0o777).toString(8),
  parsed_rows: lines,
  schema_versions: Object.fromEntries([...versions.entries()].sort(([a], [b]) => Number(a) - Number(b))),
  operations: Object.fromEntries([...operations.entries()].sort(([a], [b]) => String(a).localeCompare(String(b)))),
  terminal_states: Object.fromEntries([...terminals.entries()].sort(([a], [b]) => String(a).localeCompare(String(b)))),
  anchored_rows: anchoredRows,
  governance_budget_rows: governanceRows,
  configured_provider_limit: configuredProviderLimit,
  latest_timestamp: latestTimestamp,
  compatibility: "v3 schema parsed; finite non-negative budget inputs accepted; separate v4 remains additive",
  repository_writes: 0,
};
console.log(JSON.stringify(evidence, null, 2));
