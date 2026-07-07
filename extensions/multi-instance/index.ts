import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FOOTER_STATUS_KEYS } from "../_shared/footer-status";
import { isSubAgentSession } from "../_shared/pi-internals";
import { ensureProjectGitignoredOnce } from "../_shared/runtime";
import { wrapVolatile } from "../_shared/volatile-suffix";
import {
  buildFooterText,
  buildGuardBlockReason,
  buildPeersReport,
  buildVolatileRuntimeBlock,
  classifyToolIntent,
  evaluateToolGuard,
  getMultiInstanceState,
  getRecentGuardRisks,
  recordObservedPath,
  recordOwnWrite,
  resolveMultiInstanceProjectRoot,
  scanInstanceManifests,
  setInstanceActivity,
  startForegroundSession,
  stopForegroundSession,
} from "../_shared/multi-instance";

type CtxLike = {
  cwd?: string;
  hasUI?: boolean;
  ui?: {
    setStatus?: (key: string, value: string) => void;
    notify?: (message: string, type?: string) => void;
  };
  sessionManager?: unknown;
  model?: { provider?: string; id?: string; modelId?: string };
};

type SessionManagerLike = {
  getSessionId?: () => string | null | undefined;
  getSessionFile?: () => string | null | undefined;
};

function cwdOf(ctx: unknown): string {
  return typeof (ctx as CtxLike | undefined)?.cwd === "string" ? (ctx as CtxLike).cwd! : process.cwd();
}

function sessionInfo(ctx: unknown): { sessionId?: string; sessionFile?: string } {
  const sm = (ctx as CtxLike | undefined)?.sessionManager as SessionManagerLike | undefined;
  let sessionId: string | undefined;
  let sessionFile: string | undefined;
  try {
    const id = typeof sm?.getSessionId === "function" ? sm.getSessionId() : undefined;
    if (typeof id === "string" && id) sessionId = id;
  } catch {
    // Best effort.
  }
  try {
    const file = typeof sm?.getSessionFile === "function" ? sm.getSessionFile() : undefined;
    if (typeof file === "string" && file) sessionFile = file;
  } catch {
    // Best effort.
  }
  return { sessionId, sessionFile };
}

function modelLabel(ctx: unknown): string | undefined {
  const m = (ctx as CtxLike | undefined)?.model;
  if (!m) return undefined;
  const id = m.id ?? m.modelId;
  if (!id) return undefined;
  return m.provider ? `${m.provider}/${id}` : id;
}

function currentProjectRoot(ctx: unknown): string {
  return resolveMultiInstanceProjectRoot(cwdOf(ctx));
}

function safeNotify(ctx: unknown, message: string, type: "info" | "warning" | "error" = "warning"): void {
  try {
    (ctx as CtxLike | undefined)?.ui?.notify?.(message, type);
  } catch {
    // UI is optional.
  }
}

function updateFooter(ctx: unknown, projectRoot: string): void {
  try {
    const scan = scanInstanceManifests(projectRoot);
    (ctx as CtxLike | undefined)?.ui?.setStatus?.(FOOTER_STATUS_KEYS.multiInstance, buildFooterText(scan));
  } catch {
    // Footer is diagnostic only.
  }
}

function pathsForIntent(toolName: string, input: unknown): string[] {
  const intent = classifyToolIntent(toolName, input);
  return intent.intent === "other" ? [] : intent.paths;
}

export default function (pi: ExtensionAPI) {
  if (process.env.PI_ASTACK_DISABLE_MULTI_INSTANCE === "1") return;

  const toolEpochs = new Map<string, number>();

  pi.on("session_start", async (_event: unknown, ctx: unknown) => {
    if (isSubAgentSession(ctx as { sessionManager?: unknown })) return;
    const projectRoot = currentProjectRoot(ctx);
    const { sessionId, sessionFile } = sessionInfo(ctx);
    startForegroundSession({ projectRoot, sessionId, sessionFile, model: modelLabel(ctx) });
    void ensureProjectGitignoredOnce(projectRoot).catch(() => { /* best effort */ });
    updateFooter(ctx, projectRoot);
  });

  pi.on("session_shutdown", async (_event: unknown, ctx: unknown) => {
    if (isSubAgentSession(ctx as { sessionManager?: unknown })) return;
    stopForegroundSession("session_shutdown");
    try {
      (ctx as CtxLike | undefined)?.ui?.setStatus?.(FOOTER_STATUS_KEYS.multiInstance, "peers 0");
    } catch {
      // Best effort.
    }
  });

  pi.on("agent_start", (_event: unknown, ctx: unknown) => {
    if (isSubAgentSession(ctx as { sessionManager?: unknown })) return;
    setInstanceActivity("agent running", "agent", []);
    updateFooter(ctx, currentProjectRoot(ctx));
  });

  pi.on("agent_end", (_event: unknown, ctx: unknown) => {
    if (isSubAgentSession(ctx as { sessionManager?: unknown })) return;
    setInstanceActivity(undefined, undefined, []);
    updateFooter(ctx, currentProjectRoot(ctx));
  });

  pi.on("tool_call", (event: { toolName?: string; toolCallId?: unknown; input?: unknown }, ctx: unknown) => {
    if (isSubAgentSession(ctx as { sessionManager?: unknown })) return undefined;
    const toolName = String(event.toolName ?? "");
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
    if (toolCallId) toolEpochs.set(toolCallId, getMultiInstanceState().sessionEpoch);
    const projectRoot = currentProjectRoot(ctx);
    const cwd = cwdOf(ctx);
    const scan = scanInstanceManifests(projectRoot);
    const verdict = evaluateToolGuard(toolName, event.input, projectRoot, cwd, scan.peers);

    if (verdict.action === "block") {
      const message = buildGuardBlockReason(verdict);
      safeNotify(ctx, message, "error");
      updateFooter(ctx, projectRoot);
      return { block: true, reason: message };
    }
    if (verdict.action === "warn") {
      const message = buildGuardBlockReason(verdict).replace("blocked this tool call", "flagged this tool call");
      safeNotify(ctx, message, "warning");
    }
    updateFooter(ctx, projectRoot);
    return undefined;
  });

  pi.on("tool_result", async (event: { toolName?: string; toolCallId?: string; input?: unknown; isError?: boolean }, ctx: unknown) => {
    if (isSubAgentSession(ctx as { sessionManager?: unknown })) return undefined;
    if (event.toolCallId) {
      const epochAtCall = toolEpochs.get(event.toolCallId);
      toolEpochs.delete(event.toolCallId);
      if (epochAtCall !== undefined && epochAtCall !== getMultiInstanceState().sessionEpoch) return undefined;
    }
    const toolName = String(event.toolName ?? "");
    const projectRoot = currentProjectRoot(ctx);
    const cwd = cwdOf(ctx);
    const paths = pathsForIntent(toolName, event.input);
    const intent = classifyToolIntent(toolName, event.input);

    if (intent.intent === "observe") {
      for (const p of paths) recordObservedPath(projectRoot, p, cwd);
    } else if (!event.isError && intent.intent === "write") {
      for (const p of paths) recordOwnWrite(projectRoot, p, cwd);
    }

    setInstanceActivity(undefined, undefined, []);
    updateFooter(ctx, projectRoot);
    return undefined;
  });

  pi.on("before_agent_start", async (event: { systemPrompt?: string }, ctx: unknown) => {
    if (isSubAgentSession(ctx as { sessionManager?: unknown })) return undefined;
    const projectRoot = currentProjectRoot(ctx);
    const { sessionId, sessionFile } = sessionInfo(ctx);
    startForegroundSession({ projectRoot, sessionId, sessionFile, model: modelLabel(ctx) });
    const scan = scanInstanceManifests(projectRoot);
    const block = buildVolatileRuntimeBlock(scan, getRecentGuardRisks());
    updateFooter(ctx, projectRoot);
    if (!block) return undefined;
    const current = event.systemPrompt ?? "";
    return { systemPrompt: `${current.replace(/\n+$/, "")}\n\n${wrapVolatile(block)}\n` };
  });

  const registerCommand = (pi as unknown as {
    registerCommand?: (name: string, options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> | void }) => void;
  }).registerCommand;
  if (typeof registerCommand === "function") {
    registerCommand.call(pi, "peers", {
      description: "Show pi-astack multi-instance peer and stale-context guard status",
      handler: async (_args: string, ctx: unknown) => {
        if (isSubAgentSession(ctx as { sessionManager?: unknown })) return;
        const projectRoot = currentProjectRoot(ctx);
        const scan = scanInstanceManifests(projectRoot);
        safeNotify(ctx, buildPeersReport(scan), scan.peers.length || getRecentGuardRisks().length ? "warning" : "info");
        updateFooter(ctx, projectRoot);
      },
    });
  }
}
