#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-llm-audit-budget-home-"));
process.env.HOME = tmpHome;
process.env.ABRAIN_ROOT = path.join(tmpHome, ".abrain");

const require = createRequire(import.meta.url);
const { default: createJitiDefault, createJiti } = require("jiti");
const makeJiti = createJiti ?? createJitiDefault;
const jiti = makeJiti(repoRoot, { interopDefault: true });

const {
  BackgroundLlmBudgetExceededError,
  _resetLlmAuditBudgetForTests,
  auditStreamSimple,
} = jiti(path.join(repoRoot, "extensions/_shared/llm-audit.ts"));

const settingsFile = path.join(tmpHome, ".pi", "agent", "pi-astack-settings.json");

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    _resetLlmAuditBudgetForTests();
    await fn();
    pass++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    fail++;
    console.log(`  FAIL  ${name}\n        ${err?.stack || err?.message || err}`);
  }
}

function writeSettings(backgroundBudget) {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ llmAudit: { backgroundBudget } }, null, 2) + "\n", "utf8");
}

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-llm-audit-budget-project-"));
}

function auditFile(projectRoot) {
  return path.join(projectRoot, ".pi-astack", "llm-audit", "audit.jsonl");
}

function readRows(projectRoot) {
  const file = auditFile(projectRoot);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function makeFakePiAi() {
  const calls = { count: 0 };
  return {
    calls,
    piAi: {
      streamSimple() {
        calls.count++;
        return {
          async result() {
            return { stopReason: "stop", usage: { input: 1, output: 1 }, content: [{ type: "text", text: "ok" }] };
          },
        };
      },
    },
  };
}

async function runAudit(projectRoot, fakePiAi, operation, prompt) {
  return auditStreamSimple(
    projectRoot,
    { module: "smoke", operation, model_ref: "fake/model" },
    fakePiAi,
    { provider: "fake", id: "model" },
    { messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] },
    {},
  );
}

console.log("llm-audit budget smoke");

await check("prompt over limit fails closed before streamSimple", async () => {
  writeSettings({
    enabled: true,
    maxPromptChars: 12,
    maxPromptEstimatedTokens: 1000,
    perOperationMaxCallsPerTurn: 10,
    perOperationMaxEstimatedTokensPerTurn: 1000,
  });
  const projectRoot = tmpProject();
  const { calls, piAi } = makeFakePiAi();
  const prompt = "PROMPT_SECRET_SHOULD_NOT_APPEAR_IN_BUDGET_AUDIT";
  let err;
  try {
    await runAudit(projectRoot, piAi, "prompt_limit", prompt);
  } catch (e) {
    err = e;
  }
  if (!(err instanceof BackgroundLlmBudgetExceededError)) throw new Error(`expected BackgroundLlmBudgetExceededError, got ${err}`);
  if (err.code !== "PI_ASTACK_BACKGROUND_LLM_BUDGET_EXCEEDED") throw new Error(`bad error code: ${err.code}`);
  if (!String(err.message).includes("background LLM budget exceeded")) throw new Error(`bad message: ${err.message}`);
  if (calls.count !== 0) throw new Error(`streamSimple should not be called, got ${calls.count}`);
  const rows = readRows(projectRoot);
  const budget = rows.find((r) => r.row_type === "budget" && r.result === "blocked");
  if (!budget) throw new Error(`missing blocked budget row: ${JSON.stringify(rows)}`);
  if (budget.budget_name !== "maxPromptChars") throw new Error(`wrong budget_name: ${budget.budget_name}`);
  const raw = fs.readFileSync(auditFile(projectRoot), "utf8");
  if (raw.includes(prompt)) throw new Error("budget audit leaked prompt text");
});

await check("per-operation call limit fails on second call", async () => {
  writeSettings({
    enabled: true,
    maxPromptChars: 1000,
    maxPromptEstimatedTokens: 1000,
    perOperationMaxCallsPerTurn: 1,
    perOperationMaxEstimatedTokensPerTurn: 1000,
  });
  const projectRoot = tmpProject();
  const { calls, piAi } = makeFakePiAi();
  await runAudit(projectRoot, piAi, "call_limit", "hello");
  let err;
  try {
    await runAudit(projectRoot, piAi, "call_limit", "hello again");
  } catch (e) {
    err = e;
  }
  if (!(err instanceof BackgroundLlmBudgetExceededError)) throw new Error(`expected BackgroundLlmBudgetExceededError, got ${err}`);
  if (err.budgetName !== "perOperationMaxCallsPerTurn") throw new Error(`wrong budgetName: ${err.budgetName}`);
  if (calls.count !== 1) throw new Error(`second call should be blocked before streamSimple, got ${calls.count}`);
  const blocked = readRows(projectRoot).find((r) => r.row_type === "budget" && r.result === "blocked");
  if (!blocked || blocked.count !== 2 || blocked.limit !== 1) throw new Error(`bad blocked row: ${JSON.stringify(blocked)}`);
});

await check("enabled=false allows calls through", async () => {
  writeSettings({
    enabled: false,
    maxPromptChars: 1,
    maxPromptEstimatedTokens: 1,
    perOperationMaxCallsPerTurn: 0,
    perOperationMaxEstimatedTokensPerTurn: 1,
  });
  const projectRoot = tmpProject();
  const { calls, piAi } = makeFakePiAi();
  const result = await runAudit(projectRoot, piAi, "disabled", "this prompt is longer than every configured limit");
  if (calls.count !== 1) throw new Error(`streamSimple should be called once, got ${calls.count}`);
  if (result.content?.[0]?.text !== "ok") throw new Error(`unexpected result: ${JSON.stringify(result)}`);
  const budgetRows = readRows(projectRoot).filter((r) => r.row_type === "budget");
  if (budgetRows.length !== 0) throw new Error(`budget rows should not be written when disabled: ${JSON.stringify(budgetRows)}`);
});

await check("budget audit rows contain counters but not prompt text", async () => {
  writeSettings({
    enabled: true,
    maxPromptChars: 1000,
    maxPromptEstimatedTokens: 1000,
    perOperationMaxCallsPerTurn: 10,
    perOperationMaxEstimatedTokensPerTurn: 1000,
  });
  const projectRoot = tmpProject();
  const { piAi } = makeFakePiAi();
  const prompt = "UNIQUE_BUDGET_ROW_PROMPT_TEXT";
  await runAudit(projectRoot, piAi, "privacy", prompt);
  const budget = readRows(projectRoot).find((r) => r.row_type === "budget" && r.result === "allow");
  if (!budget) throw new Error("missing allow budget row");
  for (const key of ["operation", "model_id", "prompt_chars", "estimated_tokens", "budget_name", "count", "limit", "result"]) {
    if (!(key in budget)) throw new Error(`budget row missing ${key}: ${JSON.stringify(budget)}`);
  }
  if (JSON.stringify(budget).includes(prompt)) throw new Error(`budget row leaked prompt text: ${JSON.stringify(budget)}`);
});

if (fail) {
  console.error(`llm-audit budget smoke failed: ${fail}/${pass + fail}`);
  process.exit(1);
}
console.log(`llm-audit budget smoke passed: ${pass}/${pass + fail}`);
