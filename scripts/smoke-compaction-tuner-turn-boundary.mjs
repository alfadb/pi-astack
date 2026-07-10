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

check("patch adds willContinue and normalizes successful compaction summaries after upstream handling", () => {
  if (!/InteractiveMode\.handleEvent/.test(internalsSrc)) {
    throw new Error("InteractiveMode.handleEvent integrity check missing");
  }
  if (!/willContinue:\s*true/.test(internalsSrc)) {
    throw new Error("willContinue=true patch missing");
  }
  if (!/restoreWorkingLoaderIfContinuing/.test(internalsSrc)) {
    throw new Error("working loader restore helper missing");
  }
  if (!/removeEarlierCompactionSummaries/.test(internalsSrc)) {
    throw new Error("post-upstream compaction summary normalization missing");
  }
  if (!/CompactionSummaryMessageComponent/.test(internalsSrc)) {
    throw new Error("public compaction summary component anchor missing");
  }
  if (/handleSuccessfulCompactionEndWithoutDuplicateSummary|canHandleSuccessfulCompactionEnd/.test(internalsSrc)) {
    throw new Error("broad successful compaction_end bypass was not removed");
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
const { AgentSession, CompactionSummaryMessageComponent, InteractiveMode } = await import("@earendil-works/pi-coding-agent");
const { Agent, runAgentLoop } = await import("@earendil-works/pi-agent-core");

// Deliberately not imported from pi-tui: runtime can contain a host copy and a
// package-local copy, so the production patch must recognize this by shape.
const ForeignSpacer = class Spacer {
  constructor(lines = 1) { this.lines = lines; }
  setLines(lines) { this.lines = lines; }
  render() { return Array.from({ length: this.lines }, () => ""); }
};

function createSummaryComponent(message, source) {
  const component = Object.create(CompactionSummaryMessageComponent.prototype);
  component.message = message;
  component.source = source;
  return component;
}

function appendRenderedMessage(children, message, source) {
  if (message.role === "compactionSummary") {
    children.push(new ForeignSpacer(1), createSummaryComponent(message, source));
    return;
  }
  children.push({ role: message.role, message, source });
}

function summaryComponents(children) {
  return children.filter((child) => child instanceof CompactionSummaryMessageComponent);
}

function createChatHarness(rebuiltMessages) {
  const children = [{ role: "stale" }];
  const mode = {
    settingsManager: { getShowTerminalProgress: () => false },
    defaultEditor: { onEscape: undefined },
    statusContainer: { clear: () => {} },
    chatContainer: {
      children,
      clear: () => {
        mode.chatClears = (mode.chatClears ?? 0) + 1;
        children.splice(0);
      },
    },
    rebuildChatFromMessages: () => {
      mode.rebuilds = (mode.rebuilds ?? 0) + 1;
      for (const message of rebuiltMessages) appendRenderedMessage(children, message, "rebuild");
    },
    addMessageToChat: (message) => {
      mode.addedMessages = (mode.addedMessages ?? 0) + 1;
      appendRenderedMessage(children, message, "event-result");
    },
    footer: { invalidate: () => { mode.footerInvalidations = (mode.footerInvalidations ?? 0) + 1; } },
    clearStatusIndicator: (kind) => { mode.clearedStatus = kind; },
    flushCompactionQueue: (options) => { mode.flushed = options; },
    showError: (message) => { mode.errors = [...(mode.errors ?? []), message]; },
    showStatus: (message) => { mode.statuses = [...(mode.statuses ?? []), message]; },
    ui: { requestRender: () => { mode.renderCount = (mode.renderCount ?? 0) + 1; } },
  };
  return { children, mode };
}

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
  if (event.type !== "compaction_end") return;

  if (this.settingsManager?.getShowTerminalProgress?.()) this.ui.terminal.setProgress(false);
  if (this.autoCompactionEscapeHandler) {
    this.defaultEditor.onEscape = this.autoCompactionEscapeHandler;
    this.autoCompactionEscapeHandler = undefined;
  }
  this.clearStatusIndicator?.("compaction");
  if (event.aborted) {
    if (event.reason === "manual") this.showError?.("Compaction cancelled");
    else this.showStatus?.("Auto-compaction cancelled");
  } else if (event.result) {
    this.chatContainer.clear();
    this.rebuildChatFromMessages();
    this.addMessageToChat({
      role: "compactionSummary",
      summary: event.result.summary,
      tokensBefore: event.result.tokensBefore,
      timestamp: event.result.timestamp,
    });
    this.footer.invalidate();
  } else if (event.errorMessage) {
    if (event.reason === "manual") this.showError?.(event.errorMessage);
    else this.chatContainer.children.push(new ForeignSpacer(1), { role: "error", text: event.errorMessage });
  }
  this.flushCompactionQueue?.({ willRetry: event.willRetry });
  this.ui?.requestRender?.();
  if (this.autoCompactionLoader) {
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
      agent.state.messages = [
        { role: "compactionSummary", summary: "rebuilt-old-summary", tokensBefore: 80, timestamp: 4 },
        { role: "user", content: [{ type: "text", text: "kept user" }], timestamp: 5 },
        { role: "assistant", content: [{ type: "text", text: "kept assistant" }], timestamp: 6 },
        { role: "toolResult", toolCallId: "t2", toolName: "read", content: [], timestamp: 7 },
      ];
      agent.state.tools = [{ name: "bash" }];
      return true;
    },
  };
  const restoredChildren = [];
  const chatMessages = [];
  const originalEscape = () => "restored";
  let setWorkingVisibleCalls = 0;
  const mode = {
    session: { isStreaming: true },
    settingsManager: { getShowTerminalProgress: () => true },
    workingVisible: true,
    defaultEditor: { onEscape: () => "compaction-abort" },
    autoCompactionEscapeHandler: originalEscape,
    autoCompactionLoader: { stop: () => {} },
    statusContainer: {
      clear: () => { restoredChildren.length = 0; },
      addChild: (child) => { restoredChildren.push(child); },
    },
    chatContainer: {
      children: chatMessages,
      clear: () => {
        mode.chatClears = (mode.chatClears ?? 0) + 1;
        chatMessages.length = 0;
      },
    },
    rebuildChatFromMessages: () => {
      mode.rebuilds = (mode.rebuilds ?? 0) + 1;
      for (const message of agent.state.messages) appendRenderedMessage(chatMessages, message, "rebuild");
    },
    addMessageToChat: (message) => {
      mode.addedMessages = (mode.addedMessages ?? 0) + 1;
      appendRenderedMessage(chatMessages, message, "event-result");
    },
    footer: { invalidate: () => { mode.footerInvalidations = (mode.footerInvalidations ?? 0) + 1; } },
    clearStatusIndicator: (kind) => { mode.clearedStatus = kind; },
    flushCompactionQueue: (options) => { mode.flushed = options; },
    progressHistory: [],
    ui: {
      terminal: { setProgress: (active) => { mode.progress = active; mode.progressHistory.push(active); } },
      requestRender: () => { mode.rendered = true; mode.renderCount = (mode.renderCount ?? 0) + 1; },
    },
    setWorkingVisible: (visible) => {
      setWorkingVisibleCalls++;
      if (visible !== true) throw new Error("setWorkingVisible should restore visibility with true");
      const loader = { kind: "working-visible" };
      mode.loadingAnimation = loader;
      mode.statusContainer.addChild(loader);
      mode.ui.requestRender();
    },
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
  const handledBefore = handledEvents.length;
  await InteractiveMode.prototype.handleEvent.call(mode, emitted);
  if (handledEvents.length !== handledBefore + 1 || handledEvents.at(-1)?.event !== emitted) {
    throw new Error("successful compaction_end did not run the original handler exactly once");
  }
  if (mode.chatClears !== 1) throw new Error(`expected one chat clear, got ${mode.chatClears}`);
  if (mode.rebuilds !== 1) throw new Error(`expected one rebuildChatFromMessages call, got ${mode.rebuilds}`);
  if (mode.addedMessages !== 1) throw new Error(`expected one upstream summary append, got ${mode.addedMessages}`);
  const summaries = summaryComponents(chatMessages);
  if (summaries.length !== 1 || summaries[0] !== chatMessages.at(-1)) {
    throw new Error(`expected exactly one trailing compaction summary, got ${JSON.stringify(chatMessages)}`);
  }
  if (summaries[0].message.summary !== emitted.result.summary || summaries[0].source !== "event-result") {
    throw new Error(`trailing summary did not come from event.result: ${JSON.stringify(summaries[0].message)}`);
  }
  const keptMessages = chatMessages.filter((child) => child?.source === "rebuild" && !(child instanceof CompactionSummaryMessageComponent));
  if (keptMessages.length !== 3) throw new Error(`expected three kept messages before the visible summary, got ${keptMessages.length}`);
  if (mode.footerInvalidations !== 1) throw new Error(`expected one footer invalidation, got ${mode.footerInvalidations}`);
  if (mode.clearedStatus !== "compaction") throw new Error(`compaction status was not cleared: ${mode.clearedStatus}`);
  if (mode.defaultEditor.onEscape !== originalEscape) throw new Error("auto-compaction escape handler was not restored");
  if (mode.autoCompactionEscapeHandler !== undefined) throw new Error("autoCompactionEscapeHandler was not cleared");
  if (mode.flushed?.willRetry !== true) throw new Error(`compaction queue was not flushed with willRetry=true: ${JSON.stringify(mode.flushed)}`);
  if (setWorkingVisibleCalls !== 1) throw new Error(`setWorkingVisible(true) was not called exactly once, got ${setWorkingVisibleCalls}`);
  if (mode.loadingAnimation?.kind !== "working-visible") throw new Error("working loader was not restored after compaction_end");
  if (restoredChildren.length !== 1) throw new Error(`expected one restored status child, got ${restoredChildren.length}`);
  if (JSON.stringify(mode.progressHistory) !== JSON.stringify([false, true])) {
    throw new Error(`terminal progress should stop for compaction_end then restore for continuation: ${JSON.stringify(mode.progressHistory)}`);
  }
  if (mode.rendered !== true || mode.renderCount < 2) throw new Error("UI render was not requested for compaction handling and restore");
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (!completed) throw new Error("onComplete was not called with result=true");
  if (!update?.context) throw new Error("missing AgentLoopTurnUpdate.context");
  if (update.context.systemPrompt !== "sys-after") throw new Error(`bad systemPrompt ${update.context.systemPrompt}`);
  if (update.context.messages.length !== 4 || update.context.messages[0].role !== "compactionSummary") {
    throw new Error(`bad compacted messages ${JSON.stringify(update.context.messages)}`);
  }
  if (update.context.tools[0].name !== "bash") throw new Error("bad tools snapshot");
  if (update.thinkingLevel !== "high") throw new Error(`bad thinkingLevel ${update.thinkingLevel}`);
  if (AgentSession.prototype._buildRuntime.name !== "patchedBuildRuntime") {
    throw new Error("_buildRuntime was not patched");
  }
});

await checkAsync("manual and threshold auto compaction keep only the trailing event.result summary", async () => {
  for (const event of [
    { type: "compaction_end", reason: "manual", result: { summary: "manual-result", tokensBefore: 120 }, aborted: false, willRetry: false },
    { type: "compaction_end", reason: "threshold", result: { summary: "auto-result", tokensBefore: 140 }, aborted: false, willRetry: true },
  ]) {
    const rebuiltMessages = [
      { role: "compactionSummary", summary: `${event.reason}-rebuilt-old`, tokensBefore: 100 },
      { role: "user", content: "kept-1" },
      { role: "assistant", content: "kept-2" },
      { role: "toolResult", content: "kept-3" },
      { role: "assistant", content: "kept-4" },
    ];
    const { children, mode } = createChatHarness(rebuiltMessages);
    const handledBefore = handledEvents.length;
    await InteractiveMode.prototype.handleEvent.call(mode, event);

    if (handledEvents.length !== handledBefore + 1 || handledEvents.at(-1)?.event !== event) {
      throw new Error(`${event.reason} success did not run upstream exactly once`);
    }
    if (mode.chatClears !== 1 || mode.rebuilds !== 1 || mode.addedMessages !== 1 || mode.footerInvalidations !== 1) {
      throw new Error(`${event.reason} upstream housekeeping count mismatch: ${JSON.stringify(mode)}`);
    }
    const summaries = summaryComponents(children);
    if (summaries.length !== 1) throw new Error(`${event.reason} left ${summaries.length} compaction summaries`);
    const visibleItems = children.filter((child) => child?.constructor?.name !== "Spacer");
    if (summaries[0] !== children.at(-1) || summaries[0] !== visibleItems.at(-1)) {
      throw new Error(`${event.reason} summary is not the trailing visible item`);
    }
    if (summaries[0].message.summary !== event.result.summary || summaries[0].source !== "event-result") {
      throw new Error(`${event.reason} retained the wrong summary: ${JSON.stringify(summaries[0].message)}`);
    }
    const spacers = children.filter((child) => child?.constructor?.name === "Spacer");
    if (spacers.length !== 1) throw new Error(`${event.reason} left the removed summary's adjacent spacer`);
    if (children.filter((child) => child?.source === "rebuild").length !== 4) {
      throw new Error(`${event.reason} did not preserve all kept messages`);
    }
  }
});

await checkAsync("aborted and error compaction_end events pass through without adding summaries", async () => {
  for (const event of [
    { type: "compaction_end", reason: "manual", result: undefined, aborted: true, willRetry: false },
    { type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false, errorMessage: "compact failed" },
  ]) {
    const { children, mode } = createChatHarness([{ role: "user", content: "existing" }]);
    const handledBefore = handledEvents.length;
    await InteractiveMode.prototype.handleEvent.call(mode, event);
    if (handledEvents.length !== handledBefore + 1 || handledEvents.at(-1)?.event !== event) {
      throw new Error(`${event.aborted ? "aborted" : "error"} event was not passed through exactly once`);
    }
    if (summaryComponents(children).length !== 0 || mode.addedMessages) {
      throw new Error(`${event.aborted ? "aborted" : "error"} event added a compaction summary`);
    }
    if (mode.chatClears || mode.rebuilds || mode.footerInvalidations) {
      throw new Error(`${event.aborted ? "aborted" : "error"} event ran successful compaction housekeeping`);
    }
  }
});

await checkAsync("InteractiveMode.handleEvent passes through non-compaction_end events", async () => {
  const event = { type: "message_delta", messageId: "m1", delta: { type: "text", text: "hi" } };
  const handledBefore = handledEvents.length;
  await InteractiveMode.prototype.handleEvent.call({}, event);
  if (handledEvents.length !== handledBefore + 1) {
    throw new Error("non-compaction_end event was not forwarded to the original handler");
  }
  if (handledEvents.at(-1)?.event !== event) {
    throw new Error("forwarded event identity changed");
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
