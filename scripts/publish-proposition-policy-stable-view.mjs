#!/usr/bin/env node
/** ADR0040 production stable-view publisher. Preview remains the default. */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const publisher = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-stable-view-publisher.ts"));

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  if (index + 1 >= process.argv.length) throw new Error(`--${name} requires a value`);
  return process.argv[index + 1];
}

const mode = argument("mode", "preview");
if (mode !== "preview" && mode !== "production") throw new Error("--mode must be preview or production");
const sourceAbrainHome = path.resolve(argument("source-abrain", publisher.PROPOSITION_POLICY_STABLE_VIEW_PUBLICATION_HARD_ABRAIN_HOME));
const sandbox = argument("sandbox-abrain");

try {
  const result = await publisher.publishPropositionPolicyStableView({
    mode,
    sourceAbrainHome,
    repoRoot,
    ...(sandbox ? { sandboxAbrainHome: path.resolve(sandbox) } : {}),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error?.code ?? "PUBLISH_FAILED"}: ${error?.message ?? String(error)}\n`);
  if (error?.detail) process.stderr.write(`${JSON.stringify(error.detail)}\n`);
  process.exitCode = 1;
}
