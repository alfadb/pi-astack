#!/usr/bin/env node
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const transition = jiti(path.join(repoRoot, "extensions/_shared/transition-register.ts"));

try {
  const register = transition.loadAndValidateTransitionRegister();
  const summary = transition.summarizeTransitionRegister(register);
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } else {
    process.stdout.write(`transition-register ok: total=${summary.total} active=${summary.active} gated=${summary.gated}\n`);
    for (const phase of summary.canonicalPath) {
      process.stdout.write(`${phase.id}\t${phase.phaseStatus}\t${phase.authorizationStatus}\n`);
    }
  }
} catch (err) {
  process.stderr.write(`transition-register invalid: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
