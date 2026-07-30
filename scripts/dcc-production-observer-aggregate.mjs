#!/usr/bin/env node
/**
 * DCC production read-only observer aggregate CLI.
 *
 * Required env:
 *   DCC_ABRAIN_ROOT — absolute nonempty ABRAIN root (production wrapper must pass it)
 *
 * Behavior:
 *   - Loads production helpers via jiti (no test hooks / no injected deps)
 *   - Combines six-condition foreground observation + bind-intent inventory
 *   - Emits exactly one stdout line of strict aggregate JSON (schema v1)
 *   - Never prints path / exact epoch / nonce / head / generation / item / id /
 *     count / detail / raw error text on stdout or stderr
 *   - exit 0 only when status=ready reason_code=none; otherwise exit 1
 *   - stdout is written synchronously so process.exit cannot truncate the line
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const SCHEMA = "pi-astack/dcc-production-observer-aggregate/v1";

const OBSERVER_STATUSES = new Set(["ready", "blocked", "legacy", "unavailable"]);
const OBSERVER_REASONS = new Set([
  "none",
  "not_authorized",
  "authority_unavailable",
  "authority_revoked",
  "authority_stale",
  "attestation_unavailable",
  "attestation_not_ready",
  "head_mismatch",
  "observation_unstable",
]);
const AGGREGATE_REASONS = new Set([
  ...OBSERVER_REASONS,
  "continuation_pending",
  "continuation_failed",
  "inventory_unavailable",
  "env_missing",
  "absolute_invalid",
  "aggregate_unavailable",
]);

function writeLine(payload) {
  // Sync write to fd 1: process.exit after async write can truncate the line.
  fs.writeSync(1, `${JSON.stringify(payload)}\n`);
}

function emit(status, reason_code, exitCode) {
  const payload = {
    schema: SCHEMA,
    status,
    reason_code,
  };
  // Defense: refuse free-text / unknown closed codes before printing.
  if (
    !OBSERVER_STATUSES.has(payload.status)
    || !AGGREGATE_REASONS.has(payload.reason_code)
    || (payload.status === "ready" && payload.reason_code !== "none")
    || (payload.reason_code === "none" && payload.status !== "ready")
  ) {
    writeLine({
      schema: SCHEMA,
      status: "unavailable",
      reason_code: "aggregate_unavailable",
    });
    process.exit(1);
  }
  writeLine(payload);
  process.exit(exitCode);
}

function failClosed(status, reason_code) {
  emit(status, reason_code, 1);
}

function isSafeNonNegInt(value) {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0;
}

async function main() {
  // Never inherit accidental test hooks into production observation.
  delete process.env.PI_ASTACK_ENABLE_TEST_HOOKS;

  const abrainRoot = process.env.DCC_ABRAIN_ROOT;
  if (typeof abrainRoot !== "string" || abrainRoot.trim() === "") {
    failClosed("unavailable", "env_missing");
  }
  // Production wrapper must pass an absolute path; relative/empty-after-trim rejected closed.
  if (!path.isAbsolute(abrainRoot)) {
    failClosed("unavailable", "absolute_invalid");
  }
  const resolvedRoot = path.resolve(abrainRoot);

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const require = createRequire(import.meta.url);

  let observeForegroundCanonicalConvergence;
  let inspectAbrainBindIntentInventory;
  try {
    const { createJiti } = require("jiti");
    const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
    const control = await jiti.import(
      path.join(root, "extensions/sediment/canonical-control.ts"),
    );
    const bindIntent = await jiti.import(
      path.join(root, "extensions/abrain/bind-intent.ts"),
    );
    observeForegroundCanonicalConvergence = control.observeForegroundCanonicalConvergence;
    inspectAbrainBindIntentInventory = bindIntent.inspectAbrainBindIntentInventory;
    if (
      typeof observeForegroundCanonicalConvergence !== "function"
      || typeof inspectAbrainBindIntentInventory !== "function"
    ) {
      failClosed("unavailable", "aggregate_unavailable");
    }
  } catch {
    failClosed("unavailable", "aggregate_unavailable");
  }

  let observation;
  try {
    // Production deps only — no authorityObservation / readCanonicalHead / platform hooks.
    observation = await observeForegroundCanonicalConvergence(resolvedRoot);
  } catch {
    failClosed("unavailable", "attestation_unavailable");
  }

  if (
    !observation
    || typeof observation !== "object"
    || !OBSERVER_STATUSES.has(observation.status)
    || !OBSERVER_REASONS.has(observation.reason_code)
  ) {
    failClosed("unavailable", "attestation_unavailable");
  }

  let inventory;
  try {
    inventory = await inspectAbrainBindIntentInventory(resolvedRoot);
  } catch {
    failClosed("unavailable", "inventory_unavailable");
  }

  if (
    !inventory
    || typeof inventory !== "object"
    || !isSafeNonNegInt(inventory.pending)
    || !isSafeNonNegInt(inventory.failed)
    || !isSafeNonNegInt(inventory.invalid)
  ) {
    failClosed("unavailable", "inventory_unavailable");
  }

  // Inventory continuation reasons take precedence (never leak counts).
  if (inventory.failed > 0 || inventory.invalid > 0) {
    failClosed("blocked", "continuation_failed");
  }
  if (inventory.pending > 0) {
    failClosed("blocked", "continuation_pending");
  }

  // Inventory clean: preserve closed observer result.
  if (observation.status === "ready" && observation.reason_code === "none") {
    emit("ready", "none", 0);
  }
  failClosed(observation.status, observation.reason_code);
}

main().catch(() => {
  try {
    writeLine({
      schema: SCHEMA,
      status: "unavailable",
      reason_code: "aggregate_unavailable",
    });
  } catch {
    // ignore
  }
  process.exit(1);
});
