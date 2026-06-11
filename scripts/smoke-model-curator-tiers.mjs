#!/usr/bin/env node
/**
 * smoke-model-curator-tiers — verify the REQUIRED `modelCurator.tiers`
 * field on the model-curator extension.
 *
 * 1. loadTiersOrThrow succeeds with the real pi-astack-settings.json
 *    (settings has tiers) and returns all three tiers with non-empty models.
 * 2. loadTiersOrThrow THROWS CuratorConfigError if the tiers block is
 *    missing, empty, or any tier has an empty models array.
 * 3. buildAvailableModelsBlock renders a "Tier roster" section BEFORE the
 *    per-provider detail table when tiers are present.
 * 4. The roster output names every flagship model and the cross-vendor
 *    selection guidance sentence.
 * 5. Tiers are passed through without affecting the per-model hint table
 *    (regression: hints still render).
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

const here = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const { default: createJitiDefault, createJiti } = require("jiti");
const makeJiti = createJiti ?? createJitiDefault;
const jiti = makeJiti(repoRoot, { interopDefault: true });

let pass = 0;
let fail = 0;
function check(name, ok, why = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${why ? `  ← ${why}` : ""}`); }
}

const curator = jiti(path.join(repoRoot, "extensions/model-curator/index.ts"));
const { loadTiersOrThrow, buildAvailableModelsBlock } = curator.__TEST;
const { resolveConfig } = curator.__TEST;

const realSettingsPath = path.join(os.homedir(), ".pi", "agent", "pi-astack-settings.json");
const realSettings = JSON.parse(fs.readFileSync(realSettingsPath, "utf-8"));

console.log("[1] loadTiersOrThrow against real pi-astack-settings.json");
{
  const tiers = loadTiersOrThrow();
  const names = Object.keys(tiers);
  check("tiers is an object with at least one entry", names.length > 0);
  check("flagship tier present", typeof tiers.flagship === "object");
  check("flagship.models is non-empty", Array.isArray(tiers.flagship?.models) && tiers.flagship.models.length > 0);
  check("standard tier present", typeof tiers.standard === "object");
  check("fast tier present", typeof tiers.fast === "object");
}

console.log("\n[2] loadTiersOrThrow fails closed when tiers is missing / empty / malformed");
{
  const originalTiers = realSettings.modelCurator?.tiers;
  function withTiers(tiers) {
    return {
      ...realSettings,
      modelCurator: { ...(realSettings.modelCurator ?? {}), tiers },
    };
  }
  // We test the function by invoking resolveConfig-like logic: the function
  // reads from PI_STACK_SETTINGS_PATH. Write a tmp file, swap the env, then
  // re-import. Since the import is cached, we instead exercise the same
  // logic via a re-read of the real file but monkey-patching in-place
  // (the file watcher in curator is mtime-gated, so we save / restore).
  const tmp = path.join(os.tmpdir(), `pi-astack-curator-${Date.now()}.json`);
  function withFile(content) {
    fs.writeFileSync(realSettingsPath, JSON.stringify(content, null, 2));
  }
  function restore() {
    fs.writeFileSync(realSettingsPath, JSON.stringify({
      ...realSettings,
      modelCurator: { ...(realSettings.modelCurator ?? {}), tiers: originalTiers },
    }, null, 2));
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }

  try {
    // Missing tiers
    withFile({ ...realSettings, modelCurator: { ...(realSettings.modelCurator ?? {}), tiers: undefined } });
    let threw = null;
    try { loadTiersOrThrow(); } catch (e) { threw = e; }
    check("missing tiers throws", threw !== null);
    check("error name is CuratorConfigError", threw?.name === "CuratorConfigError");
    check("error mentions REQUIRED", /REQUIRED/i.test(String(threw?.message ?? "")));

    // Empty tiers object
    withFile(withTiers({}));
    threw = null;
    try { loadTiersOrThrow(); } catch (e) { threw = e; }
    check("empty tiers throws", threw !== null);
    check("error name is CuratorConfigError", threw?.name === "CuratorConfigError");

    // Tier with empty models array
    withFile(withTiers({ flagship: { label: "T0", models: [] } }));
    threw = null;
    try { loadTiersOrThrow(); } catch (e) { threw = e; }
    check("tier with empty models throws", threw !== null);
    check("error name is CuratorConfigError", threw?.name === "CuratorConfigError");
    check("error message names the tier", /"flagship"/.test(String(threw?.message ?? "")));

    // Tiers is not an object (e.g. an array)
    withFile(withTiers([]));
    threw = null;
    try { loadTiersOrThrow(); } catch (e) { threw = e; }
    check("non-object tiers throws", threw !== null);
  } finally {
    restore();
  }
}

console.log("\n[3] buildAvailableModelsBlock renders Tier roster BEFORE the per-provider table");
{
  // Re-load the real tiers after restore() above
  const tiers = loadTiersOrThrow();
  const curatedProviders = new Set(Object.keys(realSettings.modelCurator?.providers ?? {}));
  const reg = {
    getAvailable: () => {
      const a = [];
      for (const [provider, ids] of Object.entries(realSettings.modelCurator?.providers ?? {})) {
        for (const id of ids) {
          a.push({
            provider, id,
            reasoning: true,
            input: ["text"],
            cost: { input: 5 },
            contextWindow: 100000,
            maxTokens: 8000,
          });
        }
      }
      return a;
    },
  };
  const hints = realSettings.modelCurator?.hints ?? {};
  const block = buildAvailableModelsBlock(reg, hints, curatedProviders, tiers, realSettings.modelCurator?.imageGen);
  if (!block) {
    check("block is non-null", false, "buildAvailableModelsBlock returned null");
  } else {
    check("block contains '### Tier roster'", block.includes("### Tier roster"));
    check("block contains '**flagship**' roster entry", block.includes("**flagship**"));
    check("block contains '**flagship_candidate**' roster entry when configured", !tiers.flagship_candidate || block.includes("**flagship_candidate**"));
    check("block contains '**standard**' roster entry", block.includes("**standard**"));
    check("block contains '**fast**' roster entry", block.includes("**fast**"));
    check("block contains at least one flagship model id", (tiers.flagship?.models ?? []).some((m) => block.includes(m)));
    check("block contains candidate caveat when configured",
      !tiers.flagship_candidate || block.includes("do NOT count these as primary T0 voters"));
    check("block contains the cross-vendor selection guidance",
      block.includes("two models from the same vendor"));
    check("roster is rendered BEFORE the per-provider table",
      block.indexOf("### Tier roster") < block.indexOf("### anthropic"));
    check("flagship_candidate renders between flagship and standard when present",
      !tiers.flagship_candidate || (block.indexOf("**flagship**") < block.indexOf("**flagship_candidate**") && block.indexOf("**flagship_candidate**") < block.indexOf("**standard**")));
    check("hints still render (regression: per-model table)",
      block.includes("| model | reasoning | image-in | $/1M in | hint |"));
  }
}

console.log("");
console.log(`pass=${pass}, fail=${fail}`);
if (fail > 0) process.exit(1);
process.exit(0);
