#!/usr/bin/env node
/**
 * smoke-model-curator-tiers — verify the REQUIRED `modelCurator.tiers`
 * field on the model-curator extension.
 *
 * 1. loadTiersOrThrow succeeds with a temporary, hermetic settings fixture
 *    and returns all configured tiers with non-empty models.
 * 2. loadTiersOrThrow THROWS CuratorConfigError if the tiers block is
 *    missing, empty, or any tier has an empty models array.
 * 3. buildAvailableModelsBlock renders a "Tier roster" section BEFORE the
 *    per-provider detail table when tiers are present.
 * 4. The fixed runtime-routing authority terminates the curator snapshot;
 *    the snapshot is appended after already-composed rule injection content.
 * 5. The multi-vendor roster and per-model hints remain selectable/rendered.
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

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-model-curator-tiers-"));
const fixtureSettingsPath = path.join(fixtureRoot, "pi-astack-settings.json");
const fixtureSettings = {
  modelCurator: {
    providers: {
      alpha: ["executor"],
      beta: ["reviewer"],
      gamma: ["candidate"],
    },
    hints: {
      "alpha/executor": "Permitted responsibilities: execution and judgment.",
      "beta/reviewer": "Permitted responsibilities: judgment only.",
      "gamma/candidate": "Permitted responsibilities: judgment, subject to review conditions.",
    },
    imageGen: { "alpha/image": "fixture image generation" },
    tiers: {
      flagship: { label: "T0", models: ["alpha/executor", "beta/reviewer", "gamma/candidate"] },
      flagship_candidate: { label: "T0 candidate", models: ["gamma/candidate"] },
      standard: { label: "T1", models: ["alpha/executor"] },
      fast: { label: "T2", models: ["beta/reviewer"] },
    },
  },
};
fs.writeFileSync(fixtureSettingsPath, `${JSON.stringify(fixtureSettings, null, 2)}\n`);
const savedSettingsPath = process.env.PI_ASTACK_SETTINGS_PATH;
process.env.PI_ASTACK_SETTINGS_PATH = fixtureSettingsPath;

const curator = jiti(path.join(repoRoot, "extensions/model-curator/index.ts"));
const {
  validateTiersOrThrow,
  loadTiersOrThrow,
  buildAvailableModelsBlock,
  appendAvailableModelsSnapshot,
  INJECT_MARKER,
} = curator.__TEST;
const { MODEL_ROUTING_RUNTIME_AUTHORITY } = curator;

console.log("[1] loadTiersOrThrow against temporary settings fixture");
{
  const tiers = loadTiersOrThrow();
  const names = Object.keys(tiers);
  check("tiers is an object with at least one entry", names.length > 0);
  check("flagship tier present", typeof tiers.flagship === "object");
  check("flagship.models is non-empty", Array.isArray(tiers.flagship?.models) && tiers.flagship.models.length > 0);
  check("standard tier present", typeof tiers.standard === "object");
  check("fast tier present", typeof tiers.fast === "object");
}

console.log("\n[2] tier validation fails closed without mutating live settings");
{
  function rejected(value) {
    try {
      validateTiersOrThrow(value, "smoke fixture");
      return null;
    } catch (error) {
      return error;
    }
  }

  let threw = rejected(undefined);
  check("missing tiers throws", threw !== null);
  check("error name is CuratorConfigError", threw?.name === "CuratorConfigError");
  check("error mentions REQUIRED", /REQUIRED/i.test(String(threw?.message ?? "")));

  threw = rejected({});
  check("empty tiers throws", threw !== null);
  check("error name is CuratorConfigError", threw?.name === "CuratorConfigError");

  threw = rejected({ flagship: { label: "T0", models: [] } });
  check("tier with empty models throws", threw !== null);
  check("error name is CuratorConfigError", threw?.name === "CuratorConfigError");
  check("error message names the tier", /"flagship"/.test(String(threw?.message ?? "")));

  threw = rejected([]);
  check("non-object tiers throws", threw !== null);
}

console.log("\n[3] buildAvailableModelsBlock renders Tier roster BEFORE the per-provider table");
{
  // Re-load the real tiers after restore() above
  const tiers = loadTiersOrThrow();
  const curatedProviders = new Set(Object.keys(fixtureSettings.modelCurator.providers));
  const reg = {
    getAvailable: () => {
      const a = [];
      for (const [provider, ids] of Object.entries(fixtureSettings.modelCurator.providers)) {
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
  const hints = fixtureSettings.modelCurator.hints;
  const block = buildAvailableModelsBlock(reg, hints, curatedProviders, tiers, fixtureSettings.modelCurator.imageGen);
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
    const firstProviderTable = Math.min(
      ...[...curatedProviders].map((provider) => block.indexOf(`### ${provider} _(`)),
    );
    check("roster is rendered BEFORE the per-provider table",
      block.indexOf("### Tier roster") < firstProviderTable);
    check("flagship_candidate renders between flagship and standard when present",
      !tiers.flagship_candidate || (block.indexOf("**flagship**") < block.indexOf("**flagship_candidate**") && block.indexOf("**flagship_candidate**") < block.indexOf("**standard**")));
    check("hints still render (regression: per-model table)",
      block.includes("| model | reasoning | image-in | $/1M in | hint |"));

    const flagshipProviders = new Set((tiers.flagship?.models ?? []).map((model) => model.split("/")[0]));
    check("flagship roster retains at least three selectable providers", flagshipProviders.size >= 3);
    check("every flagship provider still has a rendered provider section",
      [...flagshipProviders].every((provider) => block.includes(`### ${provider} _(`)));
    check("snapshot contains the exact fixed runtime authority text",
      block.includes(MODEL_ROUTING_RUNTIME_AUTHORITY));
    check("runtime authority terminates the curator snapshot",
      block.trimEnd().endsWith(MODEL_ROUTING_RUNTIME_AUTHORITY));
    check("selection guidance derives responsibility from live per-model hints",
      block.includes("derive execution and judgment responsibility permissions from the live per-model hint") &&
        block.includes("do not infer permission from a provider or model family"));

    const ruleInjection = "<!-- BEGIN_ABRAIN_RULES session=smoke -->\nRULE\n<!-- END_ABRAIN_RULES -->";
    const prompt = appendAvailableModelsSnapshot(ruleInjection, block);
    const snapshot = prompt.slice(prompt.indexOf(INJECT_MARKER));
    check("capability snapshot loads after already-composed rule injection",
      prompt.indexOf(INJECT_MARKER) > prompt.indexOf("<!-- END_ABRAIN_RULES -->"));
    check("appending the snapshot preserves earlier prompt content",
      prompt.startsWith(ruleInjection));
    check("runtime authority terminates the appended curator snapshot",
      snapshot.trimEnd().endsWith(MODEL_ROUTING_RUNTIME_AUTHORITY));
  }
}

console.log("");
console.log(`pass=${pass}, fail=${fail}`);
if (savedSettingsPath === undefined) delete process.env.PI_ASTACK_SETTINGS_PATH;
else process.env.PI_ASTACK_SETTINGS_PATH = savedSettingsPath;
fs.rmSync(fixtureRoot, { recursive: true, force: true });
if (fail > 0) process.exit(1);
process.exit(0);
