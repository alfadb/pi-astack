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
 *    xai/grok-4.6 is a T0/flagship judgment route promoted 2026-08-13 on benchmark
 *    evidence with production replay pending, and remains the temporary execution
 *    escalation for Flash while the xai subscription expiry (2026-08-18) stays unrenewed;
 *    flash remains a bounded
 *    mid-level execution route under precise specs + adversarial acceptance and must not
 *    enter generic automatic model fallback; deepseek-v4-pro is restored to live
 *    providers/hints and the flagship tier as a T0/flagship judgment route (not
 *    daily execution, automatic fallback, or background hot paths); every other
 *    curated non-GPT model remains judgment-only.
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
 * 8. The tier roster renders each tier's configured description at runtime — the
 *    flagship capability-threshold-before-vendor-diversity rule and the specialist
 *    description are visible in the render block, not just in JSON. The live config
 *    uses the `specialist` key (no `flagship_candidate`), its label contains no T0,
 *    and the k3-256k hint is a paid temporary/on-demand alternate with no $0
 *    subscription claim; the GLM hint requires a strict output contract when invoked.
 * 9. Execution tier lock: live flagship is exactly [gpt-5.6-sol, claude-opus-5,
 *    deepseek-v4-pro, xai/grok-4.6] — deepseek-v4-flash is demoted to the `execution` tier
 *    (label 'Execution routes — no general T0 judgment vote') whose description and
 *    renderer caveat separate execution qualification from general T0 judgment
 *    status (no general T0 independent votes, no standalone high-risk architecture
 *    review); Flash's hint states production replay did not qualify it for general
 *    T0 judgment while keeping PRIMARY DEFAULT execution-layer duty; grok-4.6's hint
 *    records the 2026-08-13 benchmark-evidence promotion (production replay pending,
 *    demote if missed) plus the temporary unrenewed-subscription caveat, and grok-4.5
 *    is fully removed from providers, hints, and tiers. The legacy `provisional` key
 *    still renders the execution caveat (compat) but live uses `execution` only.
 * 10. deepseek-v4-pro shares the DeepSeek V4 family with the PRIMARY DEFAULT
 *     execution route (deepseek-v4-flash): the Pro hint must not present Pro as
 *     the sole independent reviewer of Flash-produced work (supplementary opinion
 *     only; true adversarial acceptance must be cross-provider/architecture), and
 *     a structural walk of the live settings must find deepseek-v4-pro in NO
 *     automatic/background model call point (modelFallback, vision, memory,
 *     sediment hot paths, compactionTuner, workflow default) — operator-only
 *     disabled configs (e.g. sediment.constraintShadowCompiler) are not
 *     automatic call points.
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
      flagship: {
        label: "T0",
        description: "T0 membership requires clearing the capability threshold FIRST — a vendor seat does not automatically grant T0.",
        models: ["alpha/executor", "beta/reviewer", "gamma/candidate"],
      },
      execution: {
        label: "Execution routes — no general T0 judgment vote",
        description: "Execution qualification is separate from general T0 judgment status — no general T0 independent votes, no standalone high-risk architecture review; members remain fully usable for their hint-defined execution roles.",
        models: ["alpha/executor"],
      },
      specialist: {
        label: "Specialist candidates — explicit second-opinion only",
        description: "Capability does not reach general T0 — explicit specialist/second-opinion voices only; not counted as independent votes; no standalone review.",
        models: ["gamma/candidate"],
      },
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
    check("block contains '**specialist**' roster entry when configured", !tiers.specialist || block.includes("**specialist**"));
    check("block contains '**execution**' roster entry when configured", !tiers.execution || block.includes("**execution**"));
    check("block contains '**standard**' roster entry", block.includes("**standard**"));
    check("block contains '**fast**' roster entry", block.includes("**fast**"));
    check("block contains at least one flagship model id", (tiers.flagship?.models ?? []).some((m) => block.includes(m)));
    check("block contains frontier caveat when configured",
      !tiers.frontier || block.includes("scarce capability ABOVE ordinary T0/flagship"));
    check("block renders the flagship description (capability threshold before vendor diversity)",
      !tiers.flagship?.description || (block.includes("capability threshold") && block.includes("vendor seat")));
    check("block renders the specialist description",
      !tiers.specialist?.description || block.includes("explicit specialist/second-opinion voices only"));
    check("block contains specialist caveat when configured",
      !tiers.specialist || block.includes("do NOT count them as general T0 independent votes"));
    check("block renders the execution description (no general T0 votes, no standalone high-risk review)",
      !tiers.execution?.description || (block.includes("no general T0 independent votes") && block.includes("standalone high-risk architecture review")));
    check("block contains execution caveat when configured",
      !tiers.execution || block.includes("Execution caveat: execution qualification does NOT grant general T0 judgment status"));
    check("block contains the cross-vendor selection guidance",
      block.includes("two models from the same vendor"));
    const firstProviderTable = Math.min(
      ...[...curatedProviders].map((provider) => block.indexOf(`### ${provider} _(`)),
    );
    check("roster is rendered BEFORE the per-provider table",
      block.indexOf("### Tier roster") < firstProviderTable);
    check("frontier renders before flagship when present",
      !tiers.frontier || (block.indexOf("**frontier**") < block.indexOf("**flagship**")));
    check("specialist renders between flagship and standard when present",
      !tiers.specialist || (block.indexOf("**flagship**") < block.indexOf("**specialist**") && block.indexOf("**specialist**") < block.indexOf("**standard**")));
    check("execution renders between flagship and specialist when present",
      !tiers.execution || (block.indexOf("**flagship**") < block.indexOf("**execution**") && block.indexOf("**execution**") < block.indexOf("**specialist**")));
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

    // Legacy compat: a config still using the old `flagship_candidate` key must
    // keep the specialist caveat rendered (the renderer accepts both key names).
    {
      const legacyTiers = {
        ...tiers,
        flagship_candidate: { label: "legacy candidate", models: ["gamma/candidate"] },
      };
      const legacyBlock = buildAvailableModelsBlock(reg, hints, curatedProviders, legacyTiers, fixtureSettings.modelCurator.imageGen);
      check("legacy flagship_candidate key still renders the specialist caveat (compat)",
        legacyBlock !== null &&
          legacyBlock.includes("**flagship_candidate**") &&
          legacyBlock.includes("do NOT count them as general T0 independent votes"));
    }

    // Legacy compat: a config still using the old `provisional` key must
    // keep the execution caveat rendered (the renderer accepts both key names).
    {
      const legacyTiers = {
        ...tiers,
        provisional: { label: "legacy provisional", models: ["alpha/executor"] },
      };
      const legacyBlock = buildAvailableModelsBlock(reg, hints, curatedProviders, legacyTiers, fixtureSettings.modelCurator.imageGen);
      check("legacy provisional key still renders the execution caveat (compat)",
        legacyBlock !== null &&
          legacyBlock.includes("**provisional**") &&
          legacyBlock.includes("Execution caveat: execution qualification does NOT grant general T0 judgment status"));
    }
  }
}

console.log("\n[4] live responsibility hints: Flash primary execution, Grok 4.6 benchmark-evidence T0 promotion, and other non-GPT models judgment-only");
{
  const liveHints = liveSettings.modelCurator?.hints ?? {};
  const liveTiers = liveSettings.modelCurator?.tiers ?? {};
  const grokHint = liveHints["xai/grok-4.6"];
  check("live Grok 4.6 hint is a T0/flagship judgment route promoted on benchmark evidence",
    typeof grokHint === "string" &&
      grokHint.includes("T0/flagship judgment route") &&
      grokHint.includes("2026-08-13") &&
      grokHint.includes("AA Intelligence Index 61") &&
      grokHint.includes("Artificial Analysis") &&
      grokHint.includes("production replay pending"));
  check("live Grok 4.6 hint is not PRIMARY DEFAULT preferred execution",
    typeof grokHint === "string" &&
      !grokHint.startsWith("PRIMARY DEFAULT") &&
      grokHint.includes("not the default execution layer"));
  check("live Grok 4.6 hint retains judgment and independent-review responsibilities",
    typeof grokHint === "string" &&
      grokHint.includes("judgment-oriented tasks") &&
      grokHint.includes("independent review of completed task results or final diffs"));
  check("live Grok 4.6 hint keeps the temporary unrenewed-subscription caveat",
    typeof grokHint === "string" &&
      grokHint.includes("2026-08-18") &&
      grokHint.includes("subscription"));
  check("live Grok 4.6 hint retains execution escalation for Flash while available",
    typeof grokHint === "string" &&
      grokHint.includes("deepseek/deepseek-v4-flash") &&
      grokHint.includes("escalation"));

  const liveProvidersForDeepseek = liveSettings.modelCurator?.providers ?? {};
  const deepseekKeep = liveProvidersForDeepseek.deepseek ?? [];
  const fastModels = liveTiers.fast?.models ?? [];
  check("live deepseek keep-list includes deepseek-v4-pro",
    deepseekKeep.includes("deepseek-v4-pro"));
  check("live deepseek keep-list includes deepseek-v4-flash",
    deepseekKeep.includes("deepseek-v4-flash"));
  check("live hints include deepseek/deepseek-v4-pro",
    typeof liveHints["deepseek/deepseek-v4-pro"] === "string");
  const flagshipModels = liveTiers.flagship?.models ?? [];
  const executionModels = liveTiers.execution?.models ?? [];
  check("live deepseek-v4-pro appears in flagship exactly once",
    flagshipModels.includes("deepseek/deepseek-v4-pro") &&
      Object.values(liveTiers).filter((tier) =>
        Array.isArray(tier?.models) && tier.models.includes("deepseek/deepseek-v4-pro")).length === 1);
  check("live flagship is exactly [gpt-5.6-sol, claude-opus-5, deepseek-v4-pro, xai/grok-4.6]",
    flagshipModels.length === 4 &&
      flagshipModels.includes("openai/gpt-5.6-sol") &&
      flagshipModels.includes("anthropic/claude-opus-5") &&
      flagshipModels.includes("deepseek/deepseek-v4-pro") &&
      flagshipModels.includes("xai/grok-4.6"));
  check("live flagship excludes deepseek/deepseek-v4-flash and xai/grok-4.5",
    !flagshipModels.includes("deepseek/deepseek-v4-flash") &&
      !flagshipModels.includes("xai/grok-4.5"));
  check("live execution tier exists with label 'Execution routes — no general T0 judgment vote'",
    typeof liveTiers.execution?.label === "string" &&
      liveTiers.execution.label.includes("Execution routes") &&
      liveTiers.execution.label.includes("no general T0 judgment vote"));
  check("live provisional tier does not exist (renamed to execution)",
    liveTiers.provisional === undefined);
  check("live execution description separates execution qualification from general T0 judgment status",
    typeof liveTiers.execution?.description === "string" &&
      liveTiers.execution.description.includes("does NOT count as a general T0 independent vote") &&
      liveTiers.execution.description.includes("does NOT independently take on high-risk architecture reviews") &&
      liveTiers.execution.description.includes("prompt-only production replay") &&
      liveTiers.execution.description.includes("evidence bar"));
  check("live execution contains only deepseek-v4-flash (grok-4.5 fully removed)",
    executionModels.length === 1 &&
      executionModels.includes("deepseek/deepseek-v4-flash") &&
      !executionModels.includes("xai/grok-4.5"));
  check("live execution ranks between flagship and specialist",
    Object.keys(liveTiers).indexOf("flagship") < Object.keys(liveTiers).indexOf("execution") &&
      Object.keys(liveTiers).indexOf("execution") < Object.keys(liveTiers).indexOf("specialist"));
  check("live fast excludes deepseek/deepseek-v4-flash",
    !fastModels.includes("deepseek/deepseek-v4-flash"));
  check("live deepseek-v4-flash appears in exactly one tier",
    Object.values(liveTiers).filter((tier) =>
      Array.isArray(tier?.models) && tier.models.includes("deepseek/deepseek-v4-flash")).length === 1);
  check("live xai/grok-4.5 appears in no tier (fully removed)",
    Object.values(liveTiers).filter((tier) =>
      Array.isArray(tier?.models) && tier.models.includes("xai/grok-4.5")).length === 0);
  check("live xai/grok-4.6 appears in exactly one tier (flagship)",
    flagshipModels.includes("xai/grok-4.6") &&
      Object.values(liveTiers).filter((tier) =>
        Array.isArray(tier?.models) && tier.models.includes("xai/grok-4.6")).length === 1);
  check("live xai keep-list is exactly [grok-4.6] (grok-4.5 removed)",
    (liveProvidersForDeepseek["xai"] ?? []).length === 1 &&
      (liveProvidersForDeepseek["xai"] ?? []).includes("grok-4.6") &&
      !(liveProvidersForDeepseek["xai"] ?? []).includes("grok-4.5"));
  check("live hints no longer carry xai/grok-4.5",
    liveHints["xai/grok-4.5"] === undefined);

  const proHint = liveHints["deepseek/deepseek-v4-pro"];
  check("live deepseek-v4-pro hint is a T0/flagship judgment route",
    typeof proHint === "string" &&
      proHint.includes("T0") &&
      proHint.includes("flagship") &&
      proHint.includes("independent review"));
  check("live deepseek-v4-pro hint is not the sole independent reviewer of Flash output (same DeepSeek V4 family)",
    typeof proHint === "string" &&
      proHint.toLowerCase().includes("same deepseek v4 family") &&
      proHint.includes("deepseek-v4-flash") &&
      proHint.includes("sole independent reviewer") &&
      proHint.includes("supplementary opinion") &&
      proHint.includes("different provider/architecture"));
  check("live deepseek-v4-pro hint is not daily execution, automatic fallback, or background hot path",
    typeof proHint === "string" &&
      proHint.includes("Use only for judgment-oriented tasks") &&
      proHint.includes("do not use for coding, log review, or concrete implementation") &&
      !proHint.includes("PRIMARY DEFAULT") &&
      !proHint.includes("preferred execution layer") &&
      !proHint.includes("Assign all routine rollbackable deterministic tasks"));

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
  check("live deepseek-v4-flash hint separates execution qualification from general T0 judgment (production replay did not qualify it)",
    typeof flashHint === "string" &&
      flashHint.includes("Execution qualification does not grant general T0 judgment status") &&
      flashHint.includes("production replay did not qualify it for general T0 judgment") &&
      flashHint.includes("execution role unaffected") &&
      !flashHint.includes("provisional pending production replay"));
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
      flashHint.includes("xai/grok-4.6") &&
      flashHint.includes("GPT-5.6 execution route"));

  const otherNonGptHints = Object.entries(liveHints).filter(
    ([model]) =>
      !model.startsWith("openai/") &&
      model !== "xai/grok-4.6" &&
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
  const rollbackModels = liveTiers.rollback?.models ?? [];
  check("live Opus 5 hint is Primary Anthropic T0 route",
    typeof opusHint === "string" && opusHint.includes("Primary Anthropic T0 route"));
  check("live Opus 5 hint is the preferred judgment route for complex frontend visual design",
    typeof opusHint === "string" &&
      opusHint.includes("Preferred judgment route for complex frontend visual design") &&
      opusHint.includes("information architecture") &&
      opusHint.includes("composition") &&
      opusHint.includes("spacing/density") &&
      opusHint.includes("interaction design") &&
      opusHint.includes("screenshot/reference-based design critique"));
  check("live Opus 5 hint stays judgment-only (no coding/log review/concrete implementation, no execution-layer claim)",
    typeof opusHint === "string" &&
      opusHint.includes("Use only for judgment-oriented tasks") &&
      opusHint.includes("do not use for coding, log review, or concrete implementation") &&
      !opusHint.includes("PRIMARY DEFAULT") &&
      !opusHint.includes("preferred execution layer") &&
      !opusHint.includes("Execution-capable"));
  check("live Opus 5 hint does not claim SVG as a special or preferred capability",
    typeof opusHint === "string" && !opusHint.includes("SVG"));
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
  check("live flagship excludes kimi-coding/k3",
    !flagshipModels.includes("kimi-coding/k3"));
  const standardModels = liveTiers.standard?.models ?? [];
  const specialistModels = liveTiers.specialist?.models ?? [];
  check("live rollback includes kimi-coding/k3",
    rollbackModels.includes("kimi-coding/k3"));
  check("live rollback includes kimi-coding/k3-256k",
    rollbackModels.includes("kimi-coding/k3-256k"));
  check("live standard excludes kimi-coding/k3-256k",
    !standardModels.includes("kimi-coding/k3-256k"));
  check("live specialist tier exists with non-empty models",
    Array.isArray(specialistModels) && specialistModels.length > 0);
  check("live specialist carries kimi-k2.7-code, MiniMax-M3, and glm-5.2",
    specialistModels.includes("moonshotai/kimi-k2.7-code") &&
      specialistModels.includes("minimax/MiniMax-M3") &&
      specialistModels.includes("zai-coding-cn/glm-5.2"));
  check("live flagship excludes the four demoted models",
    !flagshipModels.includes("moonshotai/kimi-k2.7-code") &&
      !flagshipModels.includes("minimax/MiniMax-M3") &&
      !flagshipModels.includes("zai-coding-cn/glm-5.2") &&
      !flagshipModels.includes("kimi-coding/k3"));
  check("live specialist ranks between flagship and rollback",
    Object.keys(liveTiers).indexOf("flagship") < Object.keys(liveTiers).indexOf("specialist") &&
      Object.keys(liveTiers).indexOf("specialist") < Object.keys(liveTiers).indexOf("rollback"));
  check("live flagship_candidate tier does not exist (renamed to specialist)",
    liveTiers.flagship_candidate === undefined);
  check("live specialist label contains no T0",
    typeof liveTiers.specialist?.label === "string" &&
      !liveTiers.specialist.label.includes("T0"));
  check("live flagship description puts capability threshold before vendor diversity",
    typeof liveTiers.flagship?.description === "string" &&
      liveTiers.flagship.description.includes("capability threshold FIRST") &&
      liveTiers.flagship.description.includes("vendor seat does not automatically grant T0"));
  check("live specialist description forbids general T0 votes and standalone review",
    typeof liveTiers.specialist?.description === "string" &&
      liveTiers.specialist.description.includes("do NOT count them as independent T0 votes") &&
      liveTiers.specialist.description.includes("do NOT use them for standalone review"));
  const k27Hint = liveHints["moonshotai/kimi-k2.7-code"];
  check("live kimi-k2.7-code hint is in-subscription second review, not a standalone reviewer",
    typeof k27Hint === "string" &&
      k27Hint.includes("second review") &&
      k27Hint.includes("do not use as a standalone reviewer"));
  const m3Hint = liveHints["minimax/MiniMax-M3"];
  check("live MiniMax-M3 hint is explicit multimodal/long-context only, not an independent blind-review vote",
    typeof m3Hint === "string" &&
      m3Hint.includes("explicit invocation only") &&
      m3Hint.includes("not counted as an independent blind-review vote"));
  const glmHint = liveHints["zai-coding-cn/glm-5.2"];
  check("live glm-5.2 hint is Chinese-requirements supplementary vote, not a standalone reviewer",
    typeof glmHint === "string" &&
      glmHint.includes("supplementary vote") &&
      glmHint.includes("do not use as a standalone reviewer"));
  check("live glm-5.2 hint requires a strict output contract when invoked",
    typeof glmHint === "string" &&
      glmHint.includes("When invoked") &&
      glmHint.includes("require/enforce a strict output contract"));
  const k3Hint = liveHints["kimi-coding/k3"];
  check("live kimi-coding/k3 hint is paid temporary upgrade, same Moonshot family, not an independent vote",
    typeof k3Hint === "string" &&
      k3Hint.includes("Paid temporary upgrade") &&
      k3Hint.includes("not counted as an independent vote"));
  const k3256Hint = liveHints["kimi-coding/k3-256k"];
  check("live k3-256k hint is paid temporary/on-demand alternate with no $0 subscription claim",
    typeof k3256Hint === "string" &&
      k3256Hint.includes("paid temporary") &&
      !k3256Hint.includes("$0") &&
      !k3256Hint.includes("subscription quota"));
  check("live k3-256k hint shares the same base model as k3 (not an independent vote)",
    typeof k3256Hint === "string" &&
      k3256Hint.includes("Same underlying K3 model as kimi-coding/k3") &&
      k3256Hint.includes("does not count as an independent vote"));
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

console.log("\n[5] live deepseek-v4-pro stays out of every automatic/background model call point");
{
  const pro = "deepseek/deepseek-v4-pro";
  // Structural walk: collect every model-bearing leaf under a subtree. A leaf is
  // model-bearing when its key ends in "Model"/"ModelRef" (string value) or it is
  // a non-empty array of strings (model arrays — in the live settings every such
  // array is a model list, e.g. fallbackModels/modelPreferences/summaryModels/
  // reviewerProviders/modelAllowlist). skipKeys prunes operator-only subtrees that
  // are not automatic call points (e.g. sediment.constraintShadowCompiler:
  // auto-refresh disabled, explicit operator runs only).
  function collectModelLeaves(node, key, out, skipKeys) {
    if (skipKeys.has(key)) return out;
    if (Array.isArray(node)) {
      if (node.length > 0 && node.every((v) => typeof v === "string")) {
        out.push({ key, values: node });
      }
      return out;
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === "string") {
          if (/Model(Ref)?$/.test(k)) out.push({ key: k, values: [v] });
        } else {
          collectModelLeaves(v, k, out, skipKeys);
        }
      }
    }
    return out;
  }
  const noPro = (leaves) => leaves.every((leaf) => !leaf.values.includes(pro));

  const fallbackModels = liveSettings.modelFallback?.fallbackModels ?? [];
  const visionPrefs = liveSettings.vision?.modelPreferences ?? [];
  const summaryModels = liveSettings.compactionTuner?.summaryModels ?? [];
  const workflowDefault = liveSettings.workflow?.defaultModel ?? "";
  check("modelFallback.fallbackModels excludes deepseek-v4-pro",
    !fallbackModels.includes(pro));
  check("vision.modelPreferences excludes deepseek-v4-pro",
    !visionPrefs.includes(pro));
  check("compactionTuner.summaryModels excludes deepseek-v4-pro",
    !summaryModels.includes(pro));
  check("workflow.defaultModel is not deepseek-v4-pro",
    workflowDefault !== pro);

  const memoryLeaves = collectModelLeaves(liveSettings.memory ?? {}, "", [], new Set());
  check("memory model fields (all *Model / model-array leaves) exclude deepseek-v4-pro",
    memoryLeaves.length > 0 && noPro(memoryLeaves));

  const sedimentLeaves = collectModelLeaves(
    liveSettings.sediment ?? {}, "", [], new Set(["constraintShadowCompiler"]),
  );
  check("sediment automatic model fields exclude deepseek-v4-pro (operator-only constraintShadowCompiler skipped)",
    sedimentLeaves.length > 0 && noPro(sedimentLeaves));

  // Backstop: outside modelCurator, no model-bearing leaf anywhere may be Pro.
  const outsideCurator = { ...liveSettings };
  delete outsideCurator.modelCurator;
  const outsideLeaves = collectModelLeaves(outsideCurator, "", [], new Set(["constraintShadowCompiler"]));
  check("deepseek-v4-pro appears in no model-bearing leaf outside modelCurator",
    outsideLeaves.length > 0 && noPro(outsideLeaves));
}

console.log("");
console.log(`pass=${pass}, fail=${fail}`);
if (savedSettingsPath === undefined) delete process.env.PI_ASTACK_SETTINGS_PATH;
else process.env.PI_ASTACK_SETTINGS_PATH = savedSettingsPath;
fs.rmSync(fixtureRoot, { recursive: true, force: true });
if (fail > 0) process.exit(1);
process.exit(0);
