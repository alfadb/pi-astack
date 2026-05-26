#!/usr/bin/env node
/**
 * Smoke: compaction-tuner turn-boundary patch.
 *
 * Verifies the no-core-change path that monkey-patches AgentSession._buildRuntime
 * and installs an agent.prepareNextTurn wrapper. The wrapper must call the
 * internal _runAutoCompaction("threshold", true) at the turn boundary and
 * return a compacted context snapshot for the next provider request.
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

const failures = [];
let totalChecks = 0;

function check(name, fn) {
  totalChecks++;
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

async function checkAsync(name, fn) {
  totalChecks++;
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

console.log("Smoke: compaction-tuner turn-boundary patch\n");

const internalsSrc = fs.readFileSync(
  path.join(repoRoot, "extensions/_shared/pi-internals.ts"),
  "utf8",
);
const indexSrc = fs.readFileSync(
  path.join(repoRoot, "extensions/compaction-tuner/index.ts"),
  "utf8",
);

console.log("source anchors:");

check("patch anchors on AgentSession._buildRuntime and _emit", () => {
  if (!/AgentSession\._buildRuntime/.test(internalsSrc)) {
    throw new Error("AgentSession._buildRuntime anchor missing");
  }
  if (!/patchedBuildRuntime/.test(internalsSrc)) {
    throw new Error("patchedBuildRuntime wrapper missing");
  }
  if (!/AgentSession\._emit/.test(internalsSrc)) {
    throw new Error("AgentSession._emit anchor missing");
  }
  if (!/patchedEmit/.test(internalsSrc)) {
    throw new Error("patchedEmit wrapper missing");
  }
});

check("patch installs prepareNextTurn and createLoopConfig wrappers", () => {
  if (!/agent\.prepareNextTurn\s*=\s*async/.test(internalsSrc)) {
    throw new Error("agent.prepareNextTurn wrapper missing");
  }
  if (!/agent\.createLoopConfig\s*=/.test(internalsSrc)) {
    throw new Error("agent.createLoopConfig wrapper missing");
  }
  if (!/Object\.prototype\.hasOwnProperty\.call\(agentRecord, TURN_BOUNDARY_AGENT_PREPARE_NEXT_TURN_ORIGINAL\)/.test(internalsSrc)) {
    throw new Error("prepareNextTurn original capture must distinguish absent from stored undefined");
  }
});

check("patch adds willContinue and restores working loader", () => {
  if (!/InteractiveMode\.handleEvent/.test(internalsSrc)) {
    throw new Error("InteractiveMode.handleEvent integrity check missing");
  }
  if (!/willContinue:\s*true/.test(internalsSrc)) {
    throw new Error("willContinue=true patch missing");
  }
  if (!/restoreWorkingLoaderIfContinuing/.test(internalsSrc)) {
    throw new Error("working loader restore helper missing");
  }
});

check("patch uses internal auto-compaction without aborting", () => {
  if (!/_runAutoCompaction\("threshold",\s*true\)/.test(internalsSrc)) {
    throw new Error("expected _runAutoCompaction(\"threshold\", true)");
  }
  if (/ctx\.compact\s*\(/.test(internalsSrc)) {
    throw new Error("pi-internals must not call ctx.compact()");
  }
});

check("compaction-tuner only triggers turn-boundary compaction after toolResult", () => {
  if (!/lastMessageRole\s*!==\s*"toolResult"/.test(indexSrc)) {
    throw new Error("toolResult guard missing");
  }
});

console.log("\nruntime behavior:");

const tmpDir = fs.mkdtempSync(path.join(repoRoot, ".pi-astack", "smoke-turn-boundary-"));
const compiledPath = path.join(tmpDir, "pi-internals.mjs");
const transpiled = ts.transpileModule(internalsSrc, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  },
}).outputText;
fs.writeFileSync(compiledPath, transpiled, "utf8");

const { installTurnBoundaryCompactionPatch, _resetTurnBoundaryCompactionHooksForTests } = await import(compiledPath);
const { AgentSession, InteractiveMode } = await import("@earendil-works/pi-coding-agent");
const { Agent, runAgentLoop } = await import("@earendil-works/pi-agent-core");

// Stub private methods before installing wrappers; the smoke only verifies
// wrapper behavior, not pi's real _buildRuntime / handleEvent implementation.
AgentSession.prototype._buildRuntime = function smokeOriginalBuildRuntime() {
  return undefined;
};
const emittedEvents = [];
AgentSession.prototype._emit = function smokeOriginalEmit(event) {
  emittedEvents.push({ session: this, event });
};
const handledEvents = [];
InteractiveMode.prototype.handleEvent = async function smokeOriginalHandleEvent(event) {
  handledEvents.push({ mode: this, event });
  if (event.type === "compaction_end" && this.autoCompactionLoader) {
    this.autoCompactionLoader.stop?.();
    this.autoCompactionLoader = undefined;
    this.statusContainer.clear?.();
  }
};

await checkAsync("prepareNextTurn calls _runAutoCompaction and returns compacted snapshot", async () => {
  _resetTurnBoundaryCompactionHooksForTests();
  let completed = false;
  installTurnBoundaryCompactionPatch("smoke-turn-boundary", {
    shouldCompact: () => ({
      decision: "trigger",
      sessionId: "sess-smoke",
      usage: { tokens: 80, contextWindow: 100, percent: 80 },
    }),
    onComplete: ({ result }) => { completed = result; },
  });

  const agent = new Agent({
    initialState: {
      systemPrompt: "sys-before",
      messages: [
        { role: "user", content: [{ type: "text", text: "before" }], timestamp: 1 },
        { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }], stopReason: "toolUse", usage: { input: 80, output: 0, cacheRead: 0, cacheWrite: 0 }, timestamp: 2 },
        { role: "toolResult", toolCallId: "t1", toolName: "read", content: [], timestamp: 3 },
      ],
      tools: [{ name: "read" }],
    },
  });
  const session = {
    agent,
    model: { provider: "p", id: "m", contextWindow: 100 },
    thinkingLevel: "high",
    isCompacting: false,
    _runAutoCompaction: async (reason, willRetry) => {
      if (reason !== "threshold") throw new Error(`unexpected reason ${reason}`);
      if (willRetry !== true) throw new Error("willRetry must be true for mid-run queue semantics");
      AgentSession.prototype._emit.call(session, {
        type: "compaction_end",
        reason: "threshold",
        result: { summary: "s", tokensBefore: 80 },
        aborted: false,
        willRetry: true,
      });
      agent.state.systemPrompt = "sys-after";
      agent.state.messages = [{ role: "compactionSummary", summary: "summary", tokensBefore: 80, timestamp: 4 }];
      agent.state.tools = [{ name: "bash" }];
      return true;
    },
  };
  const restoredChildren = [];
  let staleLoaderStopped = false;
  const staleWorkingLoader = { kind: "stale-working-loader", stop: () => { staleLoaderStopped = true; } };
  const mode = {
    session: { isStreaming: true },
    settingsManager: { getShowTerminalProgress: () => true },
    workingVisible: true,
    loadingAnimation: staleWorkingLoader,
    autoCompactionLoader: { stop: () => {} },
    statusContainer: {
      clear: () => { restoredChildren.length = 0; },
      addChild: (child) => { restoredChildren.push(child); },
    },
    ui: { terminal: { setProgress: (active) => { mode.progress = active; } }, requestRender: () => { mode.rendered = true; } },
    createWorkingLoader: () => ({ kind: "working-loader" }),
  };
  mode.session = session;
  session.isStreaming = true;

  const ret = AgentSession.prototype._buildRuntime.call(session, { activeToolNames: [] });
  if (ret !== undefined) throw new Error("patched _buildRuntime should preserve original undefined return");
  if (typeof agent.prepareNextTurn !== "function") throw new Error("prepareNextTurn was not installed");
  const originalMessages = agent.state.messages.slice();
  const update = await agent.prepareNextTurn({
    message: originalMessages[1],
    toolResults: [originalMessages[2]],
    context: { messages: originalMessages },
    newMessages: originalMessages,
  });
  const emitted = emittedEvents.at(-1)?.event;
  if (emitted?.willContinue !== true) throw new Error(`willContinue was not injected at emit: ${JSON.stringify(emitted)}`);
  await InteractiveMode.prototype.handleEvent.call(mode, emitted);
  const handled = handledEvents.at(-1)?.event;
  if (handled?.willContinue !== true) throw new Error(`willContinue was not observed by TUI: ${JSON.stringify(handled)}`);
  if (!staleLoaderStopped) throw new Error("stale working loader was not stopped before restoration");
  if (mode.loadingAnimation === staleWorkingLoader) throw new Error("stale working loader was reused instead of replaced");
  if (mode.loadingAnimation?.kind !== "working-loader") throw new Error("working loader was not restored after compaction_end");
  if (restoredChildren.length !== 1) throw new Error(`expected one restored status child, got ${restoredChildren.length}`);
  if (mode.progress !== true) throw new Error("terminal progress was not restored");
  if (mode.rendered !== true) throw new Error("UI render was not requested after restore");
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (!completed) throw new Error("onComplete was not called with result=true");
  if (!update?.context) throw new Error("missing AgentLoopTurnUpdate.context");
  if (update.context.systemPrompt !== "sys-after") throw new Error(`bad systemPrompt ${update.context.systemPrompt}`);
  if (update.context.messages.length !== 1 || update.context.messages[0].role !== "compactionSummary") {
    throw new Error(`bad compacted messages ${JSON.stringify(update.context.messages)}`);
  }
  if (update.context.tools[0].name !== "bash") throw new Error("bad tools snapshot");
  if (update.thinkingLevel !== "high") throw new Error(`bad thinkingLevel ${update.thinkingLevel}`);
  if (AgentSession.prototype._buildRuntime.name !== "patchedBuildRuntime") {
    throw new Error("_buildRuntime was not patched");
  }
});

await checkAsync("prepareNextTurn forwards real turn context through createLoopConfig", async () => {
  _resetTurnBoundaryCompactionHooksForTests();
  const observed = [];
  installTurnBoundaryCompactionPatch("smoke-loop-context", {
    shouldCompact: () => ({ decision: "skip", reason: "below_threshold" }),
  });

  const agent = new Agent({
    initialState: {
      systemPrompt: "sys",
      messages: [],
      tools: [{ name: "fake", description: "fake", parameters: { type: "object", properties: {}, required: [] } }],
      model: { provider: "p", id: "m", api: "test", contextWindow: 1000, maxTokens: 100, input: [], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    },
  });
  const session = { agent, _runAutoCompaction: async () => false };
  AgentSession.prototype._buildRuntime.call(session, { activeToolNames: [] });
  agent.prepareNextTurn = async (ctx) => {
    observed.push(ctx);
    return undefined;
  };
  const config = agent.createLoopConfig();
  await runAgentLoop(
    [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }],
    { systemPrompt: "sys", messages: [], tools: agent.state.tools },
    {
      ...config,
    },
    async () => {},
    new AbortController().signal,
    async () => {
      const finalMessage = {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        api: "test",
        provider: "p",
        model: "m",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: 2,
      };
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "done", message: finalMessage };
        },
        result: async () => finalMessage,
      };
    },
  );
  const ctx = observed[0];
  if (!ctx || !Array.isArray(ctx.newMessages) || ctx.newMessages.length !== 2) {
    throw new Error(`prepareNextTurn did not receive real nextTurnContext: ${JSON.stringify(ctx)}`);
  }
  if (ctx.message?.role !== "assistant") throw new Error("nextTurnContext.message missing assistant");
});

await checkAsync("versioned prepareNextTurn reinstall does not capture old wrapper as original", async () => {
  _resetTurnBoundaryCompactionHooksForTests();
  let decisions = 0;
  installTurnBoundaryCompactionPatch("smoke-versioned-reinstall", {
    shouldCompact: () => {
      decisions++;
      return { decision: "skip", reason: "below_threshold" };
    },
  });

  const agent = new Agent({
    initialState: {
      systemPrompt: "sys",
      messages: [{ role: "toolResult", toolCallId: "t1", toolName: "read", content: [], timestamp: 1 }],
      tools: [],
    },
  });
  const session = {
    agent,
    model: { provider: "p", id: "m", contextWindow: 100 },
    thinkingLevel: "off",
    isCompacting: false,
    _runAutoCompaction: async () => true,
  };
  AgentSession.prototype._buildRuntime.call(session, { activeToolNames: [] });
  const oldWrapper = agent.prepareNextTurn;
  const installedSym = Symbol.for("pi-astack.turn-boundary-compaction.agent.installed");
  const originalSym = Symbol.for("pi-astack.turn-boundary-compaction.agent.prepareNextTurn.original");
  agent[installedSym] = "older-version";
  AgentSession.prototype._buildRuntime.call(session, { activeToolNames: [] });
  if (agent.prepareNextTurn === oldWrapper) throw new Error("version mismatch did not reinstall prepareNextTurn wrapper");
  if (agent[originalSym] !== undefined) throw new Error("stored undefined original was overwritten by old wrapper");
  await agent.prepareNextTurn(new AbortController().signal);
  if (decisions !== 1) throw new Error(`expected one shouldCompact call after reinstall, got ${decisions}`);
});

await checkAsync("prepareNextTurn respects aborted agent signal before compaction", async () => {
  _resetTurnBoundaryCompactionHooksForTests();
  let compactCalls = 0;
  installTurnBoundaryCompactionPatch("smoke-abort", {
    shouldCompact: () => ({
      decision: "trigger",
      sessionId: "sess-abort",
      usage: { tokens: 90, contextWindow: 100, percent: 90 },
    }),
  });

  const agent = new Agent({
    initialState: {
      systemPrompt: "sys",
      messages: [{ role: "toolResult", toolCallId: "t1", toolName: "read", content: [], timestamp: 1 }],
      tools: [],
    },
  });
  const controller = new AbortController();
  controller.abort();
  const session = {
    agent,
    model: { provider: "p", id: "m", contextWindow: 100 },
    thinkingLevel: "off",
    isCompacting: false,
    _runAutoCompaction: async () => {
      compactCalls++;
      return true;
    },
  };
  AgentSession.prototype._buildRuntime.call(session, { activeToolNames: [] });
  const update = await agent.prepareNextTurn({
    message: agent.state.messages[0],
    toolResults: [agent.state.messages[0]],
    context: { messages: agent.state.messages.slice() },
    newMessages: agent.state.messages.slice(),
  }, { signal: controller.signal });
  if (update !== undefined) throw new Error(`expected undefined update, got ${JSON.stringify(update)}`);
  if (compactCalls !== 0) throw new Error(`compact called despite aborted signal: ${compactCalls}`);
});

await checkAsync("prepareNextTurn skips when hook says skip", async () => {
  _resetTurnBoundaryCompactionHooksForTests();
  let compactCalls = 0;
  installTurnBoundaryCompactionPatch("smoke-turn-boundary", {
    shouldCompact: () => ({ decision: "skip", reason: "below_threshold" }),
  });

  const agent = new Agent({
    initialState: {
      systemPrompt: "sys",
      messages: [{ role: "toolResult", toolCallId: "t1", toolName: "read", content: [], timestamp: 1 }],
      tools: [],
    },
  });
  const session = {
    agent,
    model: { provider: "p", id: "m", contextWindow: 100 },
    thinkingLevel: "off",
    isCompacting: false,
    _runAutoCompaction: async () => {
      compactCalls++;
      return true;
    },
  };
  AgentSession.prototype._buildRuntime.call(session, { activeToolNames: [] });
  const update = await agent.prepareNextTurn(new AbortController().signal);
  if (update !== undefined) throw new Error(`expected undefined update, got ${JSON.stringify(update)}`);
  if (compactCalls !== 0) throw new Error(`compact called ${compactCalls} times`);
});

if (failures.length > 0) {
  console.error(`\n${failures.length}/${totalChecks} checks failed`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${totalChecks} checks passed`);
}
