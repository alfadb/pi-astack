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
 * 6. The live config recommends deepseek-v4-flash as PRIMARY DEFAULT preferred execution;
 *    Grok is temporary rollback/escalation for the trial window; flash remains a bounded
 *    mid-level execution route under precise specs + adversarial acceptance and must not
 *    enter generic automatic model fallback; deepseek-v4-pro is absent from live
 *    providers/hints/tiers; every other curated non-GPT model remains judgment-only.
 * 7. Flash task sizing is semantic, not numeric: the hint's self-contained segment from
 *    "Task sizing" through "Output discipline:" is extracted and must contain no ASCII
 *    digit at all (not just no legacy 80/30/10 thresholds) while locking the full
 *    boundary semantics — wide file surfaces/long runs fine, coherence/ownership/
 *    reviewability over counts, bounded recon + implementation + focused verification
 *    in the same increment, split scope not phases, split only for multiple independent
 *    outcomes / separate-adjudication ownership/contract boundaries / a mid-run
 *    main-session decision, multiple Flash dispatches with main-session review per step,
 *    never pre-bundle dependent increments, no numeric per-dispatch/serial/total caps,
 *    no size-only escalation — while the real 65536 output cap and the 2026-08-18
 *    routing window (both after the segment) survive the digit exclusion; escalation
 *    re-dispatches once with clarified scope and acceptance, never as a smaller task.
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
      frontier: { label: "T0+ — scarce frontier capability", models: ["beta/reviewer"] },
      flagship: { label: "T0", models: ["alpha/executor", "beta/reviewer", "gamma/candidate"] },
      flagship_candidate: { label: "T0 candidate", models: ["gamma/candidate"] },
      standard: { label: "T1", models: ["alpha/executor"] },
      fast: { label: "T2", models: ["beta/reviewer"] },
    },
  },
};
fs.writeFileSync(fixtureSettingsPath, `${JSON.stringify(fixtureSettings, null, 2)}\n`);
const savedSettingsPath = process.env.PI_ASTACK_SETTINGS_PATH;
const liveSettingsPath = savedSettingsPath?.trim() || path.resolve(repoRoot, "..", "..", "pi-astack-settings.json");
const liveSettings = JSON.parse(fs.readFileSync(liveSettingsPath, "utf8"));
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
    check("block contains '**frontier**' roster entry when configured", !tiers.frontier || block.includes("**frontier**"));
    check("block contains '**flagship_candidate**' roster entry when configured", !tiers.flagship_candidate || block.includes("**flagship_candidate**"));
    check("block contains '**standard**' roster entry", block.includes("**standard**"));
    check("block contains '**fast**' roster entry", block.includes("**fast**"));
    check("block contains at least one flagship model id", (tiers.flagship?.models ?? []).some((m) => block.includes(m)));
    check("block contains frontier caveat when configured",
      !tiers.frontier || block.includes("scarce capability ABOVE ordinary T0/flagship"));
    check("block contains candidate caveat when configured",
      !tiers.flagship_candidate || block.includes("do NOT count these as primary T0 voters"));
    check("block contains the cross-vendor selection guidance",
      block.includes("two models from the same vendor"));
    const firstProviderTable = Math.min(
      ...[...curatedProviders].map((provider) => block.indexOf(`### ${provider} _(`)),
    );
    check("roster is rendered BEFORE the per-provider table",
      block.indexOf("### Tier roster") < firstProviderTable);
    check("frontier renders before flagship when present",
      !tiers.frontier || (block.indexOf("**frontier**") < block.indexOf("**flagship**")));
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
    check("selection guidance authorizes execution only when the live hint explicitly permits it",
      block.includes("Assign execution-oriented tasks, including coding, log review, and concrete implementation") &&
        block.includes("only when that hint explicitly permits them and its stated conditions are met"));

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

console.log("\n[4] live responsibility hints recommend Flash primary execution, Grok trial rollback, and keep other non-GPT models judgment-only");
{
  const liveHints = liveSettings.modelCurator?.hints ?? {};
  const liveTiers = liveSettings.modelCurator?.tiers ?? {};
  const grokHint = liveHints["xai/grok-4.5"];
  check("live Grok hint is temporary rollback/escalation for the Flash trial",
    typeof grokHint === "string" &&
      grokHint.includes("Temporary rollback / execution escalation") &&
      grokHint.includes("window through 2026-08-18") &&
      grokHint.includes("preferred execution layer (deepseek/deepseek-v4-flash)"));
  check("live Grok hint is not PRIMARY DEFAULT during the trial",
    typeof grokHint === "string" &&
      grokHint.includes("Not PRIMARY DEFAULT / preferred execution layer during this trial") &&
      !grokHint.startsWith("PRIMARY DEFAULT"));
  check("live Grok hint retains judgment and independent-review responsibilities",
    typeof grokHint === "string" &&
      grokHint.includes("judgment-oriented tasks") &&
      grokHint.includes("independent review of completed task results or final diffs"));

  const liveProvidersForDeepseek = liveSettings.modelCurator?.providers ?? {};
  const deepseekKeep = liveProvidersForDeepseek.deepseek ?? [];
  const fastModels = liveTiers.fast?.models ?? [];
  check("live deepseek keep-list excludes deepseek-v4-pro",
    !deepseekKeep.includes("deepseek-v4-pro"));
  check("live deepseek keep-list includes deepseek-v4-flash",
    deepseekKeep.includes("deepseek-v4-flash"));
  check("live hints exclude deepseek/deepseek-v4-pro",
    liveHints["deepseek/deepseek-v4-pro"] === undefined);
  check("live deepseek-v4-pro is absent from every tier",
    Object.values(liveTiers).every((tier) =>
      !Array.isArray(tier?.models) || !tier.models.includes("deepseek/deepseek-v4-pro")));
  check("live flagship includes deepseek/deepseek-v4-flash",
    (liveTiers.flagship?.models ?? []).includes("deepseek/deepseek-v4-flash"));
  check("live fast excludes deepseek/deepseek-v4-flash",
    !fastModels.includes("deepseek/deepseek-v4-flash"));
  check("live deepseek-v4-flash appears in exactly one tier",
    Object.values(liveTiers).filter((tier) =>
      Array.isArray(tier?.models) && tier.models.includes("deepseek/deepseek-v4-flash")).length === 1);

  const flashHint = liveHints["deepseek/deepseek-v4-flash"];
  check("live deepseek-v4-flash hint is PRIMARY DEFAULT preferred execution layer",
    typeof flashHint === "string" &&
      flashHint.includes("PRIMARY DEFAULT / preferred execution layer") &&
      flashHint.includes("Assign all routine rollbackable deterministic tasks with clear goals and acceptance criteria") &&
      flashHint.includes("coding, log review, concrete implementation, tests, and mechanical edits"));
  check("live deepseek-v4-flash hint positions a disciplined mid-level execution engineer",
    typeof flashHint === "string" &&
      flashHint.includes("Disciplined mid-level execution engineer") &&
      flashHint.includes("steady hands and limited system vision") &&
      flashHint.includes("precise specs plus strong adversarial acceptance"));
  check("live deepseek-v4-flash hint permits only clear-boundary rollbackable concrete execution",
    typeof flashHint === "string" &&
      flashHint.includes("clear-boundary and precisely specified") &&
      flashHint.includes("Require strong adversarial independent acceptance of results"));
  check("live deepseek-v4-flash hint forbids system-level/fuzzy work and generic automatic fallback",
    typeof flashHint === "string" &&
      flashHint.includes("Not suitable for system-level architecture, cross-module global judgment") &&
      flashHint.includes("fuzzy/underspecified requirements") &&
      flashHint.includes("Shared Ollama Max GPU pool") &&
      flashHint.includes("Do not add this model to generic automatic model fallback") &&
      !flashHint.includes("manual/explicit invocation only") &&
      !flashHint.includes("no auto hot-path or execution fallback"));
  // Flash task sizing is locked as the hint's self-contained segment from
  // "Task sizing" through "Output discipline:". The extracted segment must
  // carry the full semantic-not-numeric boundary semantics AND contain NO
  // ASCII digit at all (not just no legacy 80/30/10 thresholds), while the
  // real 65536 output cap and the 2026-08-18 routing window — which live
  // AFTER the segment — must survive that digit exclusion untouched.
  const sizingStart = typeof flashHint === "string" ? flashHint.indexOf("Task sizing") : -1;
  const sizingEnd = typeof flashHint === "string" ? flashHint.indexOf("Output discipline:") : -1;
  const taskSizing = (sizingStart !== -1 && sizingEnd !== -1 && sizingStart < sizingEnd)
    ? flashHint.slice(sizingStart, sizingEnd)
    : "";
  check("live deepseek-v4-flash hint delimits the task-sizing segment (Task sizing through Output discipline:)",
    taskSizing.length > 0);
  check("live task-sizing segment opens with the semantic-not-numeric clause",
    taskSizing.startsWith("Task sizing (semantic, not numeric)"));
  check("live task-sizing segment contains no ASCII digit (no numeric thresholds, not just 80/30/10)",
    !/\d/.test(taskSizing));
  check("live task sizing = one coherent, independently reviewable vertical increment per dispatch",
    taskSizing.includes("one dispatch = one coherent, independently reviewable vertical increment"));
  check("live task sizing allows wide file surfaces and long runs",
    taskSizing.includes("wide file surfaces and long runs are fine"));
  check("live task-sizing boundaries follow coherence, ownership, and reviewability, not counts",
    taskSizing.includes("boundaries follow coherence, ownership, and reviewability, not file/tool/time/diff/context counts"));
  check("live task sizing keeps bounded recon + implementation + focused verification in the same increment",
    taskSizing.includes("keep bounded recon + implementation + focused verification for one increment in the same dispatch"));
  check("live task sizing splits scope, not phases",
    taskSizing.includes("split scope, not phases"));
  check("live task sizing splits only for multiple independent outcomes",
    taskSizing.includes("split only for multiple independent outcomes"));
  check("live task sizing splits ownership/contract boundaries for separate adjudication",
    taskSizing.includes("ownership/contract boundaries needing separate adjudication"));
  check("live task sizing splits on a mid-run main-session decision",
    taskSizing.includes("mid-run main-session decision"));
  check("live larger efforts continue as multiple Flash dispatches with main-session review per step",
    taskSizing.includes("multiple Flash dispatches with main-session review after each step"));
  check("live task sizing never pre-bundles dependent increments",
    taskSizing.includes("never pre-bundle dependent increments"));
  check("live task sizing sets no numeric per-dispatch/serial/total caps",
    taskSizing.includes("set no numeric per-dispatch/serial/total caps"));
  check("live task sizing never escalates models just because the overall effort is large",
    taskSizing.includes("do not escalate models just because the overall effort is large"));
  check("live 65536 output cap survives the digit exclusion (sits after the sizing segment)",
    typeof flashHint === "string" &&
      sizingEnd !== -1 &&
      flashHint.includes("(65536 output cap)") &&
      flashHint.indexOf("(65536 output cap)") > sizingEnd);
  check("live 2026-08-18 routing window survives the digit exclusion (sits after the sizing segment)",
    typeof flashHint === "string" &&
      flashHint.includes("through 2026-08-18") &&
      flashHint.indexOf("through 2026-08-18") > sizingEnd);
  check("live deepseek-v4-flash hint retains no legacy 'calibrated on 2026' threshold annotation",
    typeof flashHint === "string" && !flashHint.includes("calibrated on 2026"));
  check("live deepseek-v4-flash hint escalates with clarified scope, not smaller tasks",
    typeof flashHint === "string" &&
      flashHint.includes("re-dispatch once with clarified scope and acceptance at most") &&
      !flashHint.includes("re-dispatch once as a smaller task at most") &&
      flashHint.includes("output truncation, schema-error storm, or timeout") &&
      flashHint.includes("xai/grok-4.5") &&
      flashHint.includes("GPT-5.6 execution route"));

  const otherNonGptHints = Object.entries(liveHints).filter(
    ([model]) =>
      !model.startsWith("openai/") &&
      model !== "xai/grok-4.5" &&
      model !== "deepseek/deepseek-v4-flash",
  );
  check("every other curated non-GPT model remains judgment-only",
    otherNonGptHints.length > 0 && otherNonGptHints.every(([, hint]) =>
      typeof hint === "string" &&
        hint.includes("Use only for judgment-oriented tasks") &&
        hint.includes("do not use for coding, log review, or concrete implementation")
    ));

  const opusHint = liveHints["anthropic/claude-opus-5"];
  const fableHint = liveHints["anthropic/claude-fable-5"];
  const frontierModels = liveTiers.frontier?.models ?? [];
  const flagshipModels = liveTiers.flagship?.models ?? [];
  const rollbackModels = liveTiers.rollback?.models ?? [];
  check("live Opus 5 hint is Primary Anthropic T0 route",
    typeof opusHint === "string" && opusHint.includes("Primary Anthropic T0 route"));
  check("live Fable hint is scarce frontier, not routine T0",
    typeof fableHint === "string" &&
      fableHint.includes("Scarce frontier (T0+)") &&
      fableHint.includes("NOT a routine T0 route") &&
      fableHint.includes("independent weekly usage cap equal to half of the overall weekly quota") &&
      fableHint.includes("does not mean Opus, Sonnet, or Haiku are unavailable"));
  check("live frontier tier ranks above flagship by object order",
    Object.keys(liveTiers).indexOf("frontier") >= 0 &&
      Object.keys(liveTiers).indexOf("frontier") < Object.keys(liveTiers).indexOf("flagship"));
  check("live frontier contains Fable and not Opus 5",
    frontierModels.includes("anthropic/claude-fable-5") &&
      !frontierModels.includes("anthropic/claude-opus-5"));
  check("live flagship contains Opus 5 and not Fable",
    flagshipModels.includes("anthropic/claude-opus-5") &&
      !flagshipModels.includes("anthropic/claude-fable-5"));
  check("live rollback no longer lists Opus 5",
    !rollbackModels.includes("anthropic/claude-opus-5"));

  const liveProviders = liveSettings.modelCurator?.providers ?? {};
  const kimiCodingKeep = liveProviders["kimi-coding"] ?? [];
  check("live kimi-coding keep-list includes k3 and k3-256k",
    kimiCodingKeep.includes("k3") && kimiCodingKeep.includes("k3-256k"));
  check("live hints cover kimi-coding/k3 and kimi-coding/k3-256k",
    typeof liveHints["kimi-coding/k3"] === "string" &&
      typeof liveHints["kimi-coding/k3-256k"] === "string");
  check("live flagship includes kimi-coding/k3",
    flagshipModels.includes("kimi-coding/k3"));
  const standardModels = liveTiers.standard?.models ?? [];
  check("live rollback includes kimi-coding/k3-256k",
    rollbackModels.includes("kimi-coding/k3-256k"));
  check("live standard excludes kimi-coding/k3-256k",
    !standardModels.includes("kimi-coding/k3-256k"));
  check("live k3/k3-256k hints remain judgment-only and not preferred execution",
    ["kimi-coding/k3", "kimi-coding/k3-256k"].every((id) => {
      const hint = liveHints[id];
      return typeof hint === "string" &&
        hint.includes("Use only for judgment-oriented tasks") &&
        hint.includes("do not use for coding, log review, or concrete implementation") &&
        !hint.includes("PRIMARY DEFAULT") &&
        !hint.includes("preferred execution layer");
    }));
}

console.log("");
console.log(`pass=${pass}, fail=${fail}`);
if (savedSettingsPath === undefined) delete process.env.PI_ASTACK_SETTINGS_PATH;
else process.env.PI_ASTACK_SETTINGS_PATH = savedSettingsPath;
fs.rmSync(fixtureRoot, { recursive: true, force: true });
if (fail > 0) process.exit(1);
process.exit(0);
