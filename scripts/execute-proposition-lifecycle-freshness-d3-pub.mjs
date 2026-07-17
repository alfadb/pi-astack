#!/usr/bin/env node
/** Official future D3-PUB entrypoint. Default invocation is read-only and denied. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertD3PubRuntimeEntryPolicy,
  canonicalizeBuiltinJcs,
  executeD3PubCleanPublisher,
} from "./proposition-lifecycle-freshness-d3-pub-bootstrap.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function deny(reason, message) {
  const error = new Error(`NOT_AUTHORIZED: ${reason}: ${message}`);
  error.code = "NOT_AUTHORIZED";
  error.detail = { reason };
  throw error;
}

async function main() {
  assertD3PubRuntimeEntryPolicy();
  const forbidden = ["--force", "--yes", "--bypass", "--authorization", "--authorization-text", "--dossier", "--plan", "--target", "--abrain"].find((flag) => process.argv.includes(flag));
  if (forbidden) deny("CALLER_SUPPLIED_AUTHORITY_FORBIDDEN", `unsupported caller authority or target option ${forbidden}`);
  if (process.argv.length === 2) deny("FRESH_RATIFICATION_REQUIRED", "default invocation is read-only and denied; publication requires a later trusted-transcript grant for the frozen dossier");
  if (process.argv.length !== 3 || process.argv[2] !== "--production-publish") deny("ARGUMENTS_INVALID", "the only non-default route is --production-publish");
  const result = await executeD3PubCleanPublisher({ repoRoot });
  process.stdout.write(`${canonicalizeBuiltinJcs(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.code ?? "D3_PUB_EXECUTE_FAILED"}: ${error?.message ?? String(error)}\n`);
  if (error?.detail) process.stderr.write(`${JSON.stringify(error.detail)}\n`);
  process.exitCode = 1;
});
