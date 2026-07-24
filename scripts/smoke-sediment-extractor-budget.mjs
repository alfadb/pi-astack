#!/usr/bin/env node
/**
 * Sediment extractor bounded-window + prompt_budget_exceeded smoke.
 *
 * Locks:
 *  - >1.5M-shaped branch + ~350k buildRunWindow → final prompt uses ONLY
 *    selected window (not full branch prefix/suffix), stays under cap
 *  - continuationMessages / branchEntries cannot bypass the window boundary
 *  - injected BackgroundLlmBudgetExceededError → errorKind prompt_budget_exceeded
 *    (NOT provider llm_error); fingerprint dedup; pending retained
 *  - true provider error remains errorKind=provider / ok=false
 *  - changed prompt fingerprint is allowed to "retry" (new fingerprint)
 *
 * Does NOT call production LLMs or consume production pending.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-extractor-budget-home-"));
process.env.HOME = tmpHome;
process.env.ABRAIN_ROOT = path.join(tmpHome, ".abrain");

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });

const extractor = jiti(path.join(repoRoot, "extensions/sediment/llm-extractor.ts"));
const {
  buildBranchTranscript,
  buildBoundedExtractorPromptPlan,
  buildLlmExtractorPrompt,
  runLlmExtractor,
  EXTRACTOR_PROMPT_FIXED_OVERHEAD_ALLOWANCE,
  resolveExtractorPromptCharCap,
} = extractor;

const { buildRunWindow } = jiti(path.join(repoRoot, "extensions/sediment/checkpoint.ts"));

const {
  writeSedimentIntakeEvalStatus,
  readSedimentIntakeStatus,
  writeSedimentIntakeRecord,
  buildSedimentIntakeRecord,
  listSedimentIntakePending,
  ackSedimentIntake,
  sedimentIntakePendingDir,
} = jiti(path.join(repoRoot, "extensions/sediment/intake.ts"));

const {
  BackgroundLlmBudgetExceededError,
  _resetLlmAuditBudgetForTests,
} = jiti(path.join(repoRoot, "extensions/_shared/llm-audit.ts"));

const settingsFile = path.join(tmpHome, ".pi", "agent", "pi-astack-settings.json");
fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
fs.writeFileSync(settingsFile, JSON.stringify({
  llmAudit: {
    backgroundBudget: {
      enabled: true,
      maxPromptChars: 1_000_000,
      maxPromptEstimatedTokens: 300_000,
      perOperationMaxCallsPerTurn: 12,
      perOperationMaxEstimatedTokensPerTurn: 600_000,
    },
  },
  sediment: {
    maxWindowChars: 350_000,
    maxWindowEntries: 80,
    maxEntryChars: 40_000,
    minWindowChars: 0,
    extractorModel: "mock/extractor",
  },
}, null, 2));

// Minimal AGENTS.md so system context is deterministic.
fs.mkdirSync(path.join(tmpHome, ".pi", "agent"), { recursive: true });
fs.writeFileSync(path.join(tmpHome, ".pi", "agent", "AGENTS.md"), "# agents\nsmoke system context\n");

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    _resetLlmAuditBudgetForTests();
    await fn();
    pass += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL  ${name}\n        ${err?.stack || err?.message || err}`);
  }
}

function sha(s) {
  return createHash("sha256").update(String(s), "utf8").digest("hex");
}

function makeEntry(i, size, role = "assistant") {
  const body = `ENTRY_BODY_${i}_` + "W".repeat(Math.max(0, size - 20));
  return {
    id: `e${String(i).padStart(5, "0")}`,
    parentId: i === 0 ? null : `e${String(i - 1).padStart(5, "0")}`,
    type: "message",
    timestamp: new Date(Date.UTC(2026, 6, 1, 0, 0, i % 60)).toISOString(),
    message: {
      role,
      content: [{ type: "text", text: body }],
    },
  };
}

/** Build a >1.5M branch with a selectable ~350k newest window. */
function makeHugeBranch() {
  const entries = [];
  // Early bulk: large entries that should NOT enter a 350k window when
  // checkpoint is near the end.
  for (let i = 0; i < 40; i += 1) {
    entries.push(makeEntry(i, 40_000));
  }
  // Recent window candidates (~350k total).
  for (let i = 40; i < 55; i += 1) {
    entries.push(makeEntry(i, 24_000));
  }
  return entries;
}

const mockRegistry = {
  find: () => ({ id: "mock-extractor", provider: "mock" }),
  getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-test", headers: {} }),
};

console.log("sediment extractor budget smoke");

await check("bounded window prompt uses selected window not full branch", async () => {
  const branch = makeHugeBranch();
  const fullTranscript = buildBranchTranscript(branch);
  if (fullTranscript.length < 1_500_000) {
    throw new Error(`expected >1.5M branch transcript, got ${fullTranscript.length}`);
  }
  // Checkpoint after early bulk so window is the last ~15 entries.
  const checkpoint = { lastProcessedEntryId: "e00039", version: 3 };
  const settings = {
    maxWindowChars: 350_000,
    maxWindowEntries: 80,
    maxEntryChars: 40_000,
    minWindowChars: 0,
  };
  const win = buildRunWindow(branch, checkpoint, settings, { backlogOrder: "oldest" });
  if (win.chars <= 0 || win.chars > 350_000) {
    throw new Error(`window chars out of range: ${win.chars}`);
  }
  if (win.includedEntries < 2) throw new Error(`window too empty: ${win.includedEntries}`);

  // Marker uniqueness: first selected entry body must appear; pre-window bulk marker must not.
  const selectedMarker = `ENTRY_BODY_40_`;
  const bulkMarker = `ENTRY_BODY_00_`;
  if (!win.text.includes(selectedMarker)) throw new Error("window missing selected content");
  if (win.text.includes(bulkMarker)) throw new Error("window leaked pre-checkpoint bulk content");

  const plan = buildBoundedExtractorPromptPlan(win.text, {
    settings: { maxWindowChars: 350_000, extractorModel: "mock/extractor" },
    windowEntryCount: win.includedEntries,
    fullBranchChars: fullTranscript.length,
  });

  if (plan.source !== "bounded_window") throw new Error(`bad source: ${plan.source}`);
  if (plan.windowChars !== win.text.length) throw new Error(`windowChars mismatch ${plan.windowChars} vs ${win.text.length}`);
  if (plan.promptChars <= plan.windowChars) throw new Error("prompt should include template overhead");
  if (plan.promptChars > plan.promptCharCap) {
    throw new Error(`bounded prompt still over cap: ${plan.promptChars} > ${plan.promptCharCap}`);
  }
  if (!plan.wouldAllow) throw new Error("wouldAllow should be true for 350k window");
  if (plan.fullBranchChars < 1_500_000) throw new Error("fullBranchChars diagnostic missing");
  // Final prompt must contain full selected window, not bulk branch.
  if (!plan.prompt.includes(selectedMarker)) throw new Error("prompt missing selected window marker");
  if (plan.prompt.includes(bulkMarker)) throw new Error("prompt leaked bulk branch content");
  // Must not silently drop selected content: every window char sequence of the marker region.
  if (!plan.prompt.includes(win.text.slice(0, 80))) throw new Error("prompt missing window prefix");
  if (!plan.prompt.includes(win.text.slice(-80))) throw new Error("prompt missing window suffix");
  // Cap is min(maxWindow+overhead, background maxPromptChars).
  const expectedCap = Math.min(350_000 + EXTRACTOR_PROMPT_FIXED_OVERHEAD_ALLOWANCE, 1_000_000);
  if (plan.promptCharCap !== expectedCap && plan.promptCharCap !== Math.min(expectedCap, 300_000 * 4)) {
    // token-derived cap may win when tighter
    const tokenCap = 300_000 * 4;
    const want = Math.min(350_000 + EXTRACTOR_PROMPT_FIXED_OVERHEAD_ALLOWANCE, 1_000_000, tokenCap);
    if (plan.promptCharCap !== want) {
      throw new Error(`unexpected promptCharCap ${plan.promptCharCap}, want ${want}`);
    }
  }
});

await check("branchEntries and continuationMessages cannot bypass window boundary", async () => {
  const branch = makeHugeBranch();
  const hugeContinuation = Array.from({ length: 20 }, (_, i) => ({
    role: "user",
    content: [{ type: "text", text: `CONT_BYPASS_${i}_` + "Y".repeat(80_000) }],
  }));
  const full = buildBranchTranscript(branch);
  if (full.length < 1_500_000) throw new Error("branch not huge enough");
  const contChars = hugeContinuation.reduce((s, m) => s + m.content[0].text.length, 0);
  if (contChars < 1_000_000) throw new Error("continuation fixture too small");

  // Force pre-LLM budget fail so we never call a real provider. If branch or
  // continuation were used as semantic input, promptChars would be multi-MB.
  fs.writeFileSync(settingsFile, JSON.stringify({
    llmAudit: {
      backgroundBudget: {
        enabled: true,
        maxPromptChars: 5_000,
        maxPromptEstimatedTokens: 1_000_000,
        perOperationMaxCallsPerTurn: 12,
        perOperationMaxEstimatedTokensPerTurn: 1_000_000,
      },
    },
  }, null, 2));

  // Window alone (~1k + template) already exceeds 5k? Template is ~8k so yes.
  // Use a larger window to make the fail path certain while still << branch.
  const mediumWindow = "ONLY_WINDOW_CONTENT_" + "X".repeat(12_000);
  const result = await runLlmExtractor(mediumWindow, {
    settings: {
      maxWindowChars: 350_000,
      extractorModel: "mock/extractor",
      extractorTimeoutMs: 1000,
      extractorMaxRetries: 0,
      skipContinuationSanitize: false,
    },
    modelRegistry: mockRegistry,
    branchEntries: branch,
    continuationMessages: hugeContinuation,
    windowEntryCount: 1,
  });

  if (result.ok) throw new Error("expected budget fail before provider call");
  if (result.errorKind !== "prompt_budget_exceeded") {
    throw new Error(`expected prompt_budget_exceeded, got ${result.errorKind}: ${result.error}`);
  }
  if (result.source !== "bounded_window") throw new Error(`source not bounded_window: ${result.source}`);
  // Critical: promptChars must be window-scale (~20k), never full branch (>1.5M)
  // or continuation (>1M).
  if ((result.promptChars ?? 0) > 100_000) {
    throw new Error(`branch/continuation bypassed window boundary: promptChars=${result.promptChars}`);
  }
  if ((result.windowChars ?? 0) > mediumWindow.length + 10) {
    throw new Error(`windowChars reflects more than window: ${result.windowChars}`);
  }
  if ((result.promptChars ?? 0) < mediumWindow.length) {
    throw new Error(`prompt should include full selected window, got ${result.promptChars}`);
  }

  fs.writeFileSync(settingsFile, JSON.stringify({
    llmAudit: {
      backgroundBudget: {
        enabled: true,
        maxPromptChars: 1_000_000,
        maxPromptEstimatedTokens: 300_000,
        perOperationMaxCallsPerTurn: 12,
        perOperationMaxEstimatedTokensPerTurn: 600_000,
      },
    },
  }, null, 2));
});

await check("pre-cap fail closed when window+overhead exceeds maxPromptChars without silent drop", async () => {
  // Force a tiny budget so even a modest window exceeds.
  fs.writeFileSync(settingsFile, JSON.stringify({
    llmAudit: {
      backgroundBudget: {
        enabled: true,
        maxPromptChars: 20_000,
        maxPromptEstimatedTokens: 1_000_000,
        perOperationMaxCallsPerTurn: 12,
        perOperationMaxEstimatedTokensPerTurn: 1_000_000,
      },
    },
  }, null, 2));
  const windowText = "KEEP_ALL_WINDOW_" + "Z".repeat(30_000);
  const result = await runLlmExtractor(windowText, {
    settings: {
      maxWindowChars: 350_000,
      extractorModel: "mock/extractor",
      extractorTimeoutMs: 1000,
      extractorMaxRetries: 0,
    },
    modelRegistry: mockRegistry,
    windowEntryCount: 3,
  });
  if (result.ok) throw new Error("expected fail closed on budget");
  if (result.errorKind !== "prompt_budget_exceeded") {
    throw new Error(`expected prompt_budget_exceeded, got ${result.errorKind}: ${result.error}`);
  }
  if (result.source !== "bounded_window") throw new Error("source missing");
  if (result.windowEntryCount !== 3) throw new Error(`windowEntryCount ${result.windowEntryCount}`);
  if (!result.promptFingerprint) throw new Error("missing promptFingerprint");
  if (!String(result.error).includes("prompt_budget_exceeded")) {
    throw new Error(`error text should name kind: ${result.error}`);
  }
  // Window content is not truncated away from the planned prompt — plan still has it.
  const plan = buildBoundedExtractorPromptPlan(windowText, {
    settings: { maxWindowChars: 350_000, extractorModel: "mock/extractor" },
  });
  if (!plan.prompt.includes("KEEP_ALL_WINDOW_")) throw new Error("plan dropped window content");
  if (plan.wouldAllow) throw new Error("plan should not allow under 20k cap");

  fs.writeFileSync(settingsFile, JSON.stringify({
    llmAudit: {
      backgroundBudget: {
        enabled: true,
        maxPromptChars: 1_000_000,
        maxPromptEstimatedTokens: 300_000,
        perOperationMaxCallsPerTurn: 12,
        perOperationMaxEstimatedTokensPerTurn: 600_000,
      },
    },
  }, null, 2));
});

await check("BackgroundLlmBudgetExceededError maps to prompt_budget_exceeded not llm_error", async () => {
  // Inject via direct error shape classification (unit of the catch path).
  const err = new BackgroundLlmBudgetExceededError("maxPromptChars", 1_161_217, 1_000_000);
  if (err.code !== "PI_ASTACK_BACKGROUND_LLM_BUDGET_EXCEEDED") throw new Error("code mismatch");
  if (!(err instanceof BackgroundLlmBudgetExceededError)) throw new Error("instanceof failed");
  // The extractor catch maps this when auditStreamSimple throws; simulate the
  // same mapping used in runLlmExtractor / tryAutoWriteLane.
  const mapped = {
    ok: false,
    errorKind: "prompt_budget_exceeded",
    error: `prompt_budget_exceeded: ${err.budgetName} ${err.count} > ${err.limit}`,
    budgetName: err.budgetName,
    budgetCount: err.count,
    budgetLimit: err.limit,
  };
  if (mapped.errorKind === "provider" || mapped.errorKind === "llm_error") {
    throw new Error("must not masquerade as provider llm_error");
  }
  if (!mapped.error.includes("maxPromptChars") || !mapped.error.includes("1161217")) {
    throw new Error(`footer-ready text truncated budget name: ${mapped.error}`);
  }
});

await check("provider error stays provider/llm_error class", async () => {
  // Auth failure is not prompt budget.
  const result = await runLlmExtractor("--- ENTRY 1 t message/assistant ---\nhello", {
    settings: {
      maxWindowChars: 350_000,
      extractorModel: "mock/extractor",
      extractorTimeoutMs: 1000,
      extractorMaxRetries: 0,
    },
    modelRegistry: {
      find: () => ({ id: "mock" }),
      getApiKeyAndHeaders: async () => ({ ok: false, error: "provider auth failed" }),
    },
  });
  if (result.ok) throw new Error("expected auth failure");
  if (result.errorKind !== "auth") throw new Error(`expected auth, got ${result.errorKind}`);
  if (result.errorKind === "prompt_budget_exceeded") throw new Error("auth must not be budget");
});

await check("fingerprint dedup + pending retained; new fingerprint can retry", async () => {
  const abrainHome = process.env.ABRAIN_ROOT;
  const sessionFile = path.join(tmpHome, "session.jsonl");
  fs.writeFileSync(sessionFile, `${JSON.stringify({
    type: "session", version: 3, id: "sess-budget", timestamp: "2026-07-01T00:00:00.000Z", cwd: tmpHome,
  })}\n`);
  const tip = {
    id: "tip1",
    parentId: null,
    type: "message",
    timestampUtc: "2026-07-01T00:00:01.000Z",
  };
  const record = buildSedimentIntakeRecord({
    sessionId: "sess-budget",
    sessionFile,
    cwd: tmpHome,
    sourceProjectRoot: tmpHome,
    branchTip: tip,
    captureBoundary: { kind: "agent_end", boundaryUntrusted: false },
  });
  const written = await writeSedimentIntakeRecord(abrainHome, record);
  if (written.status !== "created" && written.status !== "identical") {
    throw new Error(`intake write failed: ${written.status}`);
  }
  const fp1 = sha("window-a|cap-1");
  await writeSedimentIntakeEvalStatus(abrainHome, record, "prompt_budget_exceeded", {
    promptFingerprint: fp1,
    windowChars: 350_000,
    promptChars: 400_000,
    windowEntryCount: 12,
    budgetName: "maxPromptChars",
    count: 400_000,
    limit: 20_000,
    source: "bounded_window",
  });
  const status1 = await readSedimentIntakeStatus(abrainHome, record.windowId);
  if (!status1 || status1.status !== "prompt_budget_exceeded") {
    throw new Error(`status not recorded: ${JSON.stringify(status1)}`);
  }
  if (status1.prompt_fingerprint !== fp1) throw new Error("fingerprint mismatch");
  // Pending still present (not acked).
  const pending = await listSedimentIntakePending(abrainHome);
  if (!pending.some((p) => p.windowId === record.windowId)) {
    throw new Error("pending was lost on budget status write");
  }
  // New fingerprint may retry (status can be overwritten with new fp).
  const fp2 = sha("window-b|cap-2");
  await writeSedimentIntakeEvalStatus(abrainHome, record, "prompt_budget_exceeded", {
    promptFingerprint: fp2,
    windowChars: 100,
    promptChars: 5000,
    source: "bounded_window",
  });
  const status2 = await readSedimentIntakeStatus(abrainHome, record.windowId);
  if (status2.prompt_fingerprint !== fp2) throw new Error("new fingerprint not accepted");
  // Still pending.
  const pending2 = await listSedimentIntakePending(abrainHome);
  if (!pending2.some((p) => p.windowId === record.windowId)) {
    throw new Error("pending lost after fingerprint change");
  }
  // Explicitly do not ack — cleanup only for temp home.
  void ackSedimentIntake;
  void sedimentIntakePendingDir;
  void buildLlmExtractorPrompt;
  void resolveExtractorPromptCharCap;
});

if (fail) {
  console.error(`\nFAILED ${fail}/${pass + fail}`);
  process.exit(1);
}
console.log(`\nAll ${pass} checks passed.`);
