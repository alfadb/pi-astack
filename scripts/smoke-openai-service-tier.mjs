#!/usr/bin/env node
/**
 * Smoke: OpenAI service_tier payload injection.
 *
 * Locks the pi-astack OpenAI fast-mode extension:
 *   - settings/schema/package entries exist
 *   - serviceTier alias `fast` normalizes to official OpenAI `priority`
 *   - only allowlisted OpenAI models receive service_tier
 *   - unsupported providers and empty allowlists are no-ops
 */

import { createJiti } from "jiti";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url);

let failures = 0;
let total = 0;

function check(name, fn) {
  total++;
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

console.log("smoke: openai-service-tier\n");

const indexPath = path.join(repoRoot, "extensions/openai-service-tier/index.ts");
const payloadPath = path.join(repoRoot, "extensions/openai-service-tier/payload.ts");
const settingsPath = path.join(repoRoot, "extensions/openai-service-tier/settings.ts");
const schemaPath = path.join(repoRoot, "pi-astack-settings.schema.json");
const packagePath = path.join(repoRoot, "package.json");

const indexSrc = fs.readFileSync(indexPath, "utf8");
const payloadSrc = fs.readFileSync(payloadPath, "utf8");
const settingsSrc = fs.readFileSync(settingsPath, "utf8");
const schemaSrc = fs.readFileSync(schemaPath, "utf8");
const packageSrc = fs.readFileSync(packagePath, "utf8");

check("extension hooks before_provider_request", () => {
  if (!indexSrc.includes('pi.on("before_provider_request"')) throw new Error("hook missing");
  if (!indexSrc.includes("injectOpenAIServiceTierIntoPayload")) throw new Error("payload helper not used");
});

check("extension has config and env disable gates", () => {
  if (!settingsSrc.includes("PI_ASTACK_DISABLE_OPENAI_SERVICE_TIER")) throw new Error("disable env missing");
  if (!settingsSrc.includes("openaiServiceTier")) throw new Error("settings key missing");
  if (!indexSrc.includes("isSubAgentSession(ctx)")) throw new Error("sub-agent guard missing");
});

check("schema and package expose openaiServiceTier", () => {
  if (!schemaSrc.includes('"openaiServiceTier"')) throw new Error("schema section missing");
  if (!packageSrc.includes('"smoke:openai-service-tier"')) throw new Error("package smoke script missing");
});

check("payload helper never injects without exact allowlist", () => {
  if (!payloadSrc.includes("modelAllowlist.length === 0")) throw new Error("empty allowlist guard missing");
  if (!payloadSrc.includes("modelAllowlist.includes(modelRef)")) throw new Error("exact allowlist match missing");
});

const payload = await jiti.import(payloadPath);
const settings = await jiti.import(settingsPath);

function responsesPayload(extra = {}) {
  return {
    model: "gpt-5.5",
    input: [],
    stream: true,
    ...extra,
  };
}

function completionsPayload(extra = {}) {
  return {
    model: "gpt-5.5",
    messages: [],
    stream: true,
    ...extra,
  };
}

console.log("\nruntime checks:");

check("fast alias normalizes to priority", () => {
  const tier = settings.normalizeServiceTier("fast", "default");
  if (tier !== "priority") throw new Error(`got ${tier}`);
});

check("OpenAI Responses allowlisted model receives service_tier", () => {
  const result = payload.injectOpenAIServiceTierIntoPayload(responsesPayload(), {
    modelProvider: "openai",
    modelApi: "openai-responses",
    modelId: "gpt-5.5",
    serviceTier: "priority",
    modelAllowlist: ["openai/gpt-5.5"],
  });
  if (!result.injected) throw new Error(`not injected: ${JSON.stringify(result)}`);
  if (result.payload.service_tier !== "priority") throw new Error(`wrong tier: ${result.payload.service_tier}`);
});

check("OpenAI Chat Completions allowlisted model receives service_tier", () => {
  const result = payload.injectOpenAIServiceTierIntoPayload(completionsPayload(), {
    modelProvider: "openai",
    modelApi: "openai-completions",
    modelId: "gpt-5.5",
    serviceTier: "priority",
    modelAllowlist: ["openai/gpt-5.5"],
  });
  if (!result.injected) throw new Error(`not injected: ${JSON.stringify(result)}`);
  if (result.payload.service_tier !== "priority") throw new Error(`wrong tier: ${result.payload.service_tier}`);
});

check("Codex Responses provider is recognized through model api", () => {
  const result = payload.injectOpenAIServiceTierIntoPayload(responsesPayload(), {
    modelProvider: "openai",
    modelApi: "openai-codex-responses",
    modelId: "gpt-5.5",
    serviceTier: "priority",
    modelAllowlist: ["openai/gpt-5.5"],
  });
  if (!result.injected) throw new Error(`not injected: ${JSON.stringify(result)}`);
  if (result.provider !== "openai-codex-responses") throw new Error(`wrong provider: ${result.provider}`);
});

check("non-allowlisted model is skipped", () => {
  const result = payload.injectOpenAIServiceTierIntoPayload(responsesPayload(), {
    modelProvider: "openai",
    modelApi: "openai-responses",
    modelId: "gpt-5.5",
    serviceTier: "priority",
    modelAllowlist: ["openai/gpt-5.4"],
  });
  if (result.injected) throw new Error("unexpected injection");
  if (result.reason !== "unsupported_model") throw new Error(`wrong reason: ${result.reason}`);
});

check("empty allowlist is inactive", () => {
  const result = payload.injectOpenAIServiceTierIntoPayload(responsesPayload(), {
    modelProvider: "openai",
    modelApi: "openai-responses",
    modelId: "gpt-5.5",
    serviceTier: "priority",
    modelAllowlist: [],
  });
  if (result.injected) throw new Error("unexpected injection");
  if (result.reason !== "empty_allowlist") throw new Error(`wrong reason: ${result.reason}`);
});

check("unsupported payload shape is skipped", () => {
  const result = payload.injectOpenAIServiceTierIntoPayload({ model: "claude-opus-4-8", messages: [] }, {
    modelProvider: "anthropic",
    modelApi: "anthropic-messages",
    modelId: "claude-opus-4-8",
    serviceTier: "priority",
    modelAllowlist: ["anthropic/claude-opus-4-8"],
  });
  if (result.injected) throw new Error("unexpected injection");
  if (result.reason !== "unsupported_provider") throw new Error(`wrong reason: ${result.reason}`);
});

console.log(`\nfailures: ${failures}/${total}`);
process.exit(failures === 0 ? 0 : 1);
