#!/usr/bin/env node
/** Aggregate the offline core and real-production read-only delegation smokes. */

import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
for (const script of [
  "smoke-dispatch-delegation-core.mjs",
  "smoke-dispatch-delegation-shadow.mjs",
  "smoke-dispatch-delegation-production-replay.mjs",
]) {
  const result = spawnSync(process.execPath, [path.join(here, script)], {
    cwd: path.resolve(here, ".."),
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
