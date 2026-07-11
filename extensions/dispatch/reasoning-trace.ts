import { createHash, randomUUID, type Hash } from "node:crypto";
import { chmod, mkdir, open } from "node:fs/promises";
import * as path from "node:path";
import type { CausalAnchor } from "../_shared/causal-anchor";

export const DISPATCH_REASONING_TRACE_SCHEMA_VERSION = 1;
export const DEFAULT_MAX_TRACE_BYTES = 64 * 1024 * 1024;
export const DISPATCH_REASONING_TRACE_TERMINAL_RESERVE_BYTES = 12 * 1024;
// Back-compat for older smoke/import sites. The cap is now serialized JSONL
// trace bytes, not raw reasoning delta bytes.
export const DEFAULT_MAX_RAW_REASONING_BYTES = DEFAULT_MAX_TRACE_BYTES;

export type DispatchReasoningTraceStatus = "complete" | "forced_incomplete" | "write_failed";

export interface DispatchReasoningTraceOptions {
  projectRoot: string;
  anchor?: CausalAnchor;
  dispatchToolCallId?: string;
  taskIndex?: number;
  taskCount?: number;
  model: string;
  thinking: string;
  modelApi?: string;
  maxTraceBytes?: number;
  /** @deprecated use maxTraceBytes. Retained only for internal callers/tests during rollout. */
  maxRawReasoningBytes?: number;
  workflowRunId?: string;
  workflowStageId?: string;
  /** Test seam for deterministic append/sync/close fault injection. */
  io?: DispatchReasoningTraceIo;
}

export interface DispatchReasoningTraceTerminal {
  stopReason?: string;
  error?: unknown;
  usage?: unknown;
  forceIncomplete?: boolean;
  /** True only after the actual session.prompt() run promise settles. */
  runSettled?: boolean;
}

export interface DispatchReasoningTraceSummary {
  reasoning_trace_path: string;
  reasoning_chars: number;
  reasoning_chunks: number;
  reasoning_truncated: boolean;
  reasoning_sha256: string;
  reasoning_trace_status: DispatchReasoningTraceStatus;
  reasoning_trace_bytes: number;
  reasoning_trace_error_code?: string;
}

export interface DispatchReasoningTraceWriter {
  readonly traceId: string;
  readonly tracePath: string;
  handleSessionEvent(event: unknown): void;
  end(terminal?: DispatchReasoningTraceTerminal): Promise<DispatchReasoningTraceSummary>;
}

export interface DispatchReasoningTraceFileHandle {
  appendFile(data: string, options: { encoding: "utf8" }): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
  chmod(mode: number): Promise<void>;
}

export interface DispatchReasoningTraceIo {
  mkdir(dir: string): Promise<void>;
  chmod(dir: string, mode: number): Promise<void>;
  open(file: string): Promise<DispatchReasoningTraceFileHandle>;
}

const REAL_TRACE_IO: DispatchReasoningTraceIo = {
  mkdir: async (dir) => { await mkdir(dir, { recursive: true, mode: 0o700 }); },
  chmod,
  open: async (file) => open(file, "ax", 0o600),
};

interface RetryOrigin {
  agentCallSeq: number;
  responseId: string | null;
}

interface QueuedLine {
  line: string;
  bytes: number;
}

function finiteNonNegativeInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : fallback;
}

function controlledUsage(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total", "totalTokens"]) {
    if (typeof input[key] === "number" && Number.isFinite(input[key])) output[key] = input[key];
  }
  if (input.cost && typeof input.cost === "object") {
    const cost: Record<string, number> = {};
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"]) {
      const amount = (input.cost as Record<string, unknown>)[key];
      if (typeof amount === "number" && Number.isFinite(amount)) cost[key] = amount;
    }
    if (Object.keys(cost).length > 0) output.cost = cost;
  } else if (typeof input.cost === "number" && Number.isFinite(input.cost)) {
    output.cost = input.cost;
  }
  return Object.keys(output).length > 0 ? output : null;
}

function redactControlledString(raw: string): string {
  return raw
    .slice(0, 4096)
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [pi-astack-redacted]")
    .replace(/\b(?:api[\s_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, "credential=[pi-astack-redacted]")
    .replace(/\b(?:sk|rk|pk|xai)-[A-Za-z0-9_-]{8,}\b/g, "[pi-astack-redacted-api-key]")
    .replace(/\b(?:AIza|AKIA)[A-Za-z0-9_-]{12,}\b/g, "[pi-astack-redacted-api-key]")
    .replace(/\bgsk_[A-Za-z0-9_-]{8,}\b/g, "[pi-astack-redacted-api-key]");
}

function controlledError(value: unknown): string | null {
  const raw = typeof value === "string"
    ? value
    : value instanceof Error
      ? value.message
      : null;
  return raw ? redactControlledString(raw) : null;
}

function controlledErrorCode(value: unknown, op?: string): string | undefined {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  const raw = typeof record?.code === "string"
    ? record.code
    : value instanceof Error && value.name ? value.name
      : typeof value === "string" && value ? "string_error"
        : undefined;
  if (!raw) return op;
  return op ? `${op}:${raw.slice(0, 80)}` : raw.slice(0, 80);
}

function responseIdFrom(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const responseId = (value as Record<string, unknown>).responseId;
  return typeof responseId === "string" && responseId.length > 0 ? responseId : null;
}

function digestCopy(hash: Hash): string {
  return hash.copy().digest("hex");
}

function captureScope(model: string, modelApi: string | undefined): {
  reasoning_capture_scope: string;
  openai_visible_summary_only: boolean;
} {
  const provider = model.includes("/") ? model.slice(0, model.indexOf("/")).toLowerCase() : "";
  const isOpenAi = provider === "openai" ||
    (typeof modelApi === "string" && modelApi.toLowerCase().includes("openai-responses"));
  return isOpenAi
    ? {
        reasoning_capture_scope: "provider_visible_summary_thinking_delta_only",
        openai_visible_summary_only: true,
      }
    : {
        reasoning_capture_scope: "normalized_plaintext_thinking_delta",
        openai_visible_summary_only: false,
      };
}

class FileDispatchReasoningTraceWriter implements DispatchReasoningTraceWriter {
  readonly traceId = randomUUID();
  readonly tracePath: string;

  private readonly options: DispatchReasoningTraceOptions;
  private readonly io: DispatchReasoningTraceIo;
  private readonly maxTraceBytes: number;
  private readonly totalHash = createHash("sha256");
  private callHash = createHash("sha256");
  private readonly queue: QueuedLine[] = [];
  private queueHead = 0;
  private queuedBytes = 0;
  private scheduledTraceBytes = 0;
  private writtenTraceBytes = 0;
  private drainPromise: Promise<void> | undefined;
  private fileHandle: DispatchReasoningTraceFileHandle | undefined;
  private writeFailed = false;
  private writeErrorCode: string | undefined;
  private correctionTerminalWritten = false;
  private ended = false;
  private endPromise: Promise<DispatchReasoningTraceSummary> | undefined;
  private readonly dispatchToolCallId: string | undefined;
  private agentCallSeq = 0;
  private turnSeq = 0;
  private callOpen = false;
  private workerTerminalObserved = false;
  private responseId: string | null = null;
  private contentIndex: number | null = null;
  private chunkSeq = 0;
  private totalChars = 0;
  private totalBytes = 0;
  private totalChunks = 0;
  private persistedChars = 0;
  private persistedBytes = 0;
  private persistedChunks = 0;
  private callChars = 0;
  private callBytes = 0;
  private callChunks = 0;
  private truncated = false;
  private retryOrigin: RetryOrigin | undefined;
  private lastStopReason: string | null = null;
  private lastError: string | null = null;
  private lastUsage: Record<string, unknown> | null = null;

  constructor(options: DispatchReasoningTraceOptions) {
    this.options = options;
    this.io = options.io ?? REAL_TRACE_IO;
    this.dispatchToolCallId = typeof options.dispatchToolCallId === "string" && options.dispatchToolCallId.length > 0
      ? options.dispatchToolCallId
      : undefined;
    this.maxTraceBytes = finiteNonNegativeInt(
      options.maxTraceBytes ?? options.maxRawReasoningBytes,
      DEFAULT_MAX_TRACE_BYTES,
    );
    const dir = path.join(
      path.resolve(options.projectRoot),
      ".pi-astack",
      "llm-audit",
      "dispatch-reasoning",
    );
    this.tracePath = path.join(
      dir,
      `trace-${Date.now()}-${process.pid}-${this.traceId}.jsonl`,
    );
    const scope = captureScope(options.model, options.modelApi);
    this.enqueueControl("trace_start", {
      max_trace_bytes: this.maxTraceBytes,
      terminal_trace_reserve_bytes: DISPATCH_REASONING_TRACE_TERMINAL_RESERVE_BYTES,
      ...scope,
      dispatch_association: this.dispatchToolCallId
        ? "tool_call_id_and_causal_anchor"
        : "causal_anchor_only_no_tool_call_id",
      replay_fidelity: "all_admitted_thinking_delta_text_exact; all_received_deltas_counted_and_hashed",
      complete_cot_claim: false,
    });
  }

  handleSessionEvent(event: unknown): void {
    if (this.ended || !event || typeof event !== "object") return;
    const record = event as Record<string, unknown>;
    const eventType = typeof record.type === "string" ? record.type : "unknown";

    if (eventType === "agent_start") {
      this.enqueueControl("agent_start", {});
      return;
    }

    if (eventType === "agent_settled") {
      this.workerTerminalObserved = true;
      this.enqueueControl("agent_settled", {
        stopReason: this.lastStopReason,
        error: this.lastError,
        usage: this.lastUsage,
        ...this.reasoningTotals(),
      });
      return;
    }

    if (eventType === "agent_end") {
      const messages = Array.isArray(record.messages) ? record.messages : [];
      const willRetry = record.willRetry === true;
      if (!willRetry) this.workerTerminalObserved = true;
      this.enqueueControl("agent_end", {
        will_retry: willRetry,
        message_count: messages.length,
        assistant_message_count: messages.filter((message) =>
          !!message && typeof message === "object" && (message as Record<string, unknown>).role === "assistant").length,
        stopReason: this.lastStopReason,
        error: this.lastError,
        usage: this.lastUsage,
        ...this.reasoningTotals(),
      });
      return;
    }

    if (eventType === "turn_start") {
      this.turnSeq++;
      this.enqueueControl("turn_start", {});
      return;
    }

    if (eventType === "turn_end") {
      const message = record.message as Record<string, unknown> | undefined;
      if (message?.role === "assistant") this.observeTerminalMessage(message);
      this.enqueueControl("turn_end", {
        tool_result_count: Array.isArray(record.toolResults) ? record.toolResults.length : 0,
        stopReason: this.lastStopReason,
        error: this.lastError,
        usage: this.lastUsage,
        ...this.reasoningTotals(),
      });
      return;
    }

    if (eventType === "message_start") {
      const message = record.message as Record<string, unknown> | undefined;
      if (message?.role !== "assistant") return;
      this.startCall(message);
      return;
    }

    if (eventType === "message_update") {
      const assistantEvent = record.assistantMessageEvent as Record<string, unknown> | undefined;
      if (!assistantEvent || typeof assistantEvent.type !== "string") return;
      const assistantEventType = assistantEvent.type;
      const partial = assistantEvent.partial ?? record.message;

      if (assistantEventType === "thinking_start" || assistantEventType === "thinking_end") {
        if (!this.callOpen) this.startCall(partial);
        this.responseId = responseIdFrom(partial) ?? this.responseId;
        this.contentIndex = typeof assistantEvent.contentIndex === "number"
          ? Math.floor(assistantEvent.contentIndex)
          : null;
        this.enqueueControl(assistantEventType, {});
        return;
      }

      if (assistantEventType === "thinking_delta" && typeof assistantEvent.delta === "string") {
        if (!this.callOpen) this.startCall(partial);
        this.responseId = responseIdFrom(partial) ?? responseIdFrom(record.message) ?? this.responseId;
        this.contentIndex = typeof assistantEvent.contentIndex === "number"
          ? Math.floor(assistantEvent.contentIndex)
          : null;
        this.recordDelta(assistantEvent.delta);
      }
      // Text/tool-call updates and cumulative partial bodies are intentionally
      // omitted. message_end closes one provider response, not the worker.
      return;
    }

    if (eventType === "message_end") {
      const message = record.message as Record<string, unknown> | undefined;
      if (message?.role !== "assistant") return;
      if (!this.callOpen) this.startCall(message);
      this.observeTerminalMessage(message);
      const responseEvent = this.responseHasError() ? "response_error" : "response_end";
      this.enqueueControl(responseEvent, {
        stopReason: this.lastStopReason,
        error: this.lastError,
        usage: this.lastUsage,
        call_reasoning_chars: this.callChars,
        call_reasoning_bytes: this.callBytes,
        call_reasoning_chunks: this.callChunks,
        call_reasoning_sha256: digestCopy(this.callHash),
        ...this.reasoningTotals(),
      });
      this.enqueueControl("message_end", {
        ...this.messageShape(message),
        stopReason: this.lastStopReason,
        error: this.lastError,
        usage: this.lastUsage,
        call_reasoning_chars: this.callChars,
        call_reasoning_bytes: this.callBytes,
        call_reasoning_chunks: this.callChunks,
        call_reasoning_sha256: digestCopy(this.callHash),
        ...this.reasoningTotals(),
      });
      this.callOpen = false;
      return;
    }

    if (eventType === "auto_retry_start") {
      this.retryOrigin = {
        agentCallSeq: this.agentCallSeq,
        responseId: this.responseId,
      };
      this.enqueueControl("auto_retry_start", {
        retry_attempt: typeof record.attempt === "number" ? record.attempt : null,
        retry_max_attempts: typeof record.maxAttempts === "number" ? record.maxAttempts : null,
        retry_delay_ms: typeof record.delayMs === "number" ? record.delayMs : null,
        error: controlledError(record.errorMessage),
        retry_origin_agent_call_seq: this.retryOrigin.agentCallSeq,
        retry_origin_response_id: this.retryOrigin.responseId,
      });
      return;
    }

    if (eventType === "auto_retry_end") {
      this.enqueueControl("auto_retry_end", {
        retry_attempt: typeof record.attempt === "number" ? record.attempt : null,
        retry_success: record.success === true,
        error: controlledError(record.finalError),
        retry_origin_agent_call_seq: this.retryOrigin?.agentCallSeq ?? null,
        retry_origin_response_id: this.retryOrigin?.responseId ?? null,
        retry_terminal_agent_call_seq: this.agentCallSeq,
        retry_terminal_response_id: this.responseId,
      });
      this.retryOrigin = undefined;
    }
  }

  end(terminal: DispatchReasoningTraceTerminal = {}): Promise<DispatchReasoningTraceSummary> {
    if (this.endPromise) return this.endPromise;
    this.ended = true;
    this.lastStopReason = typeof terminal.stopReason === "string" ? terminal.stopReason : this.lastStopReason;
    this.lastError = controlledError(terminal.error) ?? this.lastError;
    this.lastUsage = controlledUsage(terminal.usage) ?? this.lastUsage;
    const runSettled = terminal.runSettled === true;
    this.endPromise = this.finalizeTerminal(terminal.forceIncomplete === true, runSettled);
    return this.endPromise;
  }

  private startCall(message: unknown): void {
    this.agentCallSeq++;
    this.callOpen = true;
    this.responseId = responseIdFrom(message);
    this.contentIndex = null;
    this.chunkSeq = 0;
    this.callChars = 0;
    this.callBytes = 0;
    this.callChunks = 0;
    this.callHash = createHash("sha256");
    this.enqueueControl("response_start", this.messageShape(message));
  }

  private messageShape(message: unknown): Record<string, unknown> {
    const record = message as Record<string, unknown> | undefined;
    return {
      message_role: "assistant",
      provider: typeof record?.provider === "string" ? record.provider : null,
      api: typeof record?.api === "string" ? record.api : this.options.modelApi ?? null,
      response_model: typeof record?.model === "string"
        ? record.model
        : typeof record?.responseModel === "string" ? record.responseModel : null,
      response_id: responseIdFrom(record),
    };
  }

  private observeTerminalMessage(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    this.responseId = responseIdFrom(record) ?? this.responseId;
    if (typeof record.stopReason === "string") this.lastStopReason = record.stopReason;
    this.lastError = controlledError(record.errorMessage);
    this.lastUsage = controlledUsage(record.usage);
  }

  private responseHasError(): boolean {
    return !!this.lastError || this.lastStopReason === "error" || this.lastStopReason === "abort" || this.lastStopReason === "aborted";
  }

  private terminationKind(status: DispatchReasoningTraceStatus): "completed" | "truncated" | "aborted" | "error" | "forced_incomplete" | "write_failed" | "unknown" {
    if (status === "write_failed") return "write_failed";
    if (status === "forced_incomplete") return "forced_incomplete";
    if (this.lastStopReason === "aborted" || this.lastStopReason === "abort") return "aborted";
    if (this.lastStopReason === "length" || this.lastStopReason === "max_tokens") return "truncated";
    if (this.lastError || this.lastStopReason === "error") return "error";
    if (this.lastStopReason) return "completed";
    return "unknown";
  }

  private recordDelta(delta: string): void {
    const deltaChars = delta.length;
    const deltaBytes = Buffer.byteLength(delta, "utf8");
    this.chunkSeq++;
    this.totalChars += deltaChars;
    this.totalBytes += deltaBytes;
    this.totalChunks++;
    this.callChars += deltaChars;
    this.callBytes += deltaBytes;
    this.callChunks++;
    this.totalHash.update(delta, "utf8");
    this.callHash.update(delta, "utf8");

    if (!this.truncated) {
      const admitted = this.enqueueData("thinking_delta", {
        delta,
        delta_chars: deltaChars,
        delta_bytes: deltaBytes,
      });
      if (admitted) {
        this.persistedChars += deltaChars;
        this.persistedBytes += deltaBytes;
        this.persistedChunks++;
        return;
      }
      this.truncated = true;
      this.enqueueControl("trace_truncated", {
        max_trace_bytes: this.maxTraceBytes,
        rejected_delta_chars: deltaChars,
        rejected_delta_bytes: deltaBytes,
        ...this.reasoningTotals(),
      });
    }
  }

  private reasoningTotals(): Record<string, unknown> {
    return {
      reasoning_chars: this.totalChars,
      reasoning_bytes: this.totalBytes,
      reasoning_chunks: this.totalChunks,
      reasoning_persisted_chars: this.persistedChars,
      reasoning_persisted_bytes: this.persistedBytes,
      reasoning_persisted_chunks: this.persistedChunks,
      reasoning_truncated: this.truncated,
      reasoning_sha256: digestCopy(this.totalHash),
      reasoning_trace_bytes_scheduled: this.scheduledTraceBytes,
    };
  }

  private summary(forceIncomplete: boolean, runSettled: boolean): DispatchReasoningTraceSummary {
    return {
      reasoning_trace_path: this.tracePath,
      reasoning_chars: this.totalChars,
      reasoning_chunks: this.totalChunks,
      reasoning_truncated: this.truncated,
      reasoning_sha256: digestCopy(this.totalHash),
      reasoning_trace_status: this.statusFor(forceIncomplete, runSettled),
      reasoning_trace_bytes: this.writtenTraceBytes,
      ...(this.writeErrorCode ? { reasoning_trace_error_code: this.writeErrorCode } : {}),
    };
  }

  private statusFor(_forceIncomplete: boolean, runSettled: boolean): DispatchReasoningTraceStatus {
    if (this.writeFailed) return "write_failed";
    return runSettled && this.workerTerminalObserved ? "complete" : "forced_incomplete";
  }

  private enqueueData(eventType: string, fields: Record<string, unknown>): boolean {
    if (this.ended || this.writeFailed) return false;
    return this.enqueueRow(eventType, fields);
  }

  private enqueueControl(eventType: string, fields: Record<string, unknown>): boolean {
    if (this.ended || this.writeFailed) return false;
    return this.enqueueRow(eventType, fields);
  }

  private enqueueRow(eventType: string, fields: Record<string, unknown>): boolean {
    const line = this.serializeRow(eventType, fields);
    const bytes = Buffer.byteLength(line, "utf8");
    if (!this.canAdmitNonTerminal(bytes)) {
      this.truncated = true;
      return false;
    }
    this.pushLine(line, bytes);
    return true;
  }

  private serializeRow(eventType: string, fields: Record<string, unknown>): string {
    const anchor = this.options.anchor;
    const row = {
      schema_version: DISPATCH_REASONING_TRACE_SCHEMA_VERSION,
      row_type: "dispatch_reasoning_event",
      event_type: eventType,
      timestamp: new Date().toISOString(),
      trace_id: this.traceId,
      reasoning_trace_path: this.tracePath,
      session_id: anchor?.session_id ?? null,
      turn_id: anchor?.turn_id ?? null,
      subturn: anchor?.subturn ?? null,
      sub_agent_label: anchor?.sub_agent_label ?? null,
      dispatch_tool_call_id: this.dispatchToolCallId ?? null,
      dispatch_tool_call_id_available: this.dispatchToolCallId !== undefined,
      task_index: this.options.taskIndex ?? null,
      task_count: this.options.taskCount ?? null,
      workflow_run_id: this.options.workflowRunId ?? null,
      workflow_stage_id: this.options.workflowStageId ?? null,
      model: this.options.model,
      thinking: this.options.thinking,
      turn_seq: this.turnSeq,
      agent_call_seq: this.agentCallSeq,
      response_id: this.responseId,
      content_index: this.contentIndex,
      chunk_seq: this.chunkSeq,
      delta: null,
      delta_chars: null,
      delta_bytes: null,
      ...fields,
    };
    return `${JSON.stringify(row)}\n`;
  }

  private terminalFields(status: DispatchReasoningTraceStatus): Record<string, unknown> {
    return {
      termination_kind: this.terminationKind(status),
      stopReason: this.lastStopReason,
      error: this.lastError,
      usage: this.lastUsage,
      reasoning_trace_status: status,
      ...(this.writeErrorCode ? { reasoning_trace_error_code: this.writeErrorCode } : {}),
      ...this.reasoningTotals(),
    };
  }

  private compactTerminalLine(
    status: DispatchReasoningTraceStatus,
    errorCode: string | undefined = this.writeErrorCode,
  ): string {
    return `${JSON.stringify({
      schema_version: DISPATCH_REASONING_TRACE_SCHEMA_VERSION,
      row_type: "dispatch_reasoning_event",
      event_type: "trace_end",
      trace_id: this.traceId,
      termination_kind: this.terminationKind(status),
      reasoning_trace_status: status,
      ...(errorCode ? { reasoning_trace_error_code: errorCode } : {}),
      reasoning_chars: this.totalChars,
      reasoning_bytes: this.totalBytes,
      reasoning_chunks: this.totalChunks,
      reasoning_truncated: this.truncated,
      reasoning_sha256: digestCopy(this.totalHash),
    })}\n`;
  }

  private canAdmitNonTerminal(lineBytes: number): boolean {
    const bodyLimit = Math.max(0, this.maxTraceBytes - DISPATCH_REASONING_TRACE_TERMINAL_RESERVE_BYTES);
    return this.scheduledTraceBytes + lineBytes <= bodyLimit;
  }

  private pushLine(line: string, bytes: number): void {
    this.queue.push({ line, bytes });
    this.queuedBytes += bytes;
    this.scheduledTraceBytes += bytes;
    this.startDrain();
  }

  private startDrain(): void {
    if (this.drainPromise) return;
    this.drainPromise = this.drainLoop().finally(() => {
      this.drainPromise = undefined;
      if (this.queueHead < this.queue.length && !this.writeFailed) this.startDrain();
    });
  }

  private async drainLoop(): Promise<void> {
    while (this.queueHead < this.queue.length && !this.writeFailed) {
      const item = this.queue[this.queueHead++]!;
      this.queuedBytes -= item.bytes;
      try {
        const handle = await this.ensureOpen();
        await handle.appendFile(item.line, { encoding: "utf8" });
        this.writtenTraceBytes += item.bytes;
      } catch (error) {
        this.markWriteFailed(error, this.writeErrorCode ? undefined : "append");
      }
      this.compactQueue();
    }
    if (this.writeFailed) this.clearQueue();
  }

  private compactQueue(): void {
    if (this.queueHead < 1024 || this.queueHead * 2 < this.queue.length) return;
    this.queue.splice(0, this.queueHead);
    this.queueHead = 0;
  }

  private clearQueue(): void {
    this.queue.length = 0;
    this.queueHead = 0;
    this.queuedBytes = 0;
  }

  private async flushQueue(): Promise<void> {
    while (this.drainPromise) await this.drainPromise;
  }

  private async ensureOpen(): Promise<DispatchReasoningTraceFileHandle> {
    if (this.fileHandle) return this.fileHandle;
    const dir = path.dirname(this.tracePath);
    try {
      await this.io.mkdir(dir);
      try { await this.io.chmod(dir, 0o700); } catch { /* best-effort mode repair */ }
      this.fileHandle = await this.io.open(this.tracePath);
      try { await this.fileHandle.chmod(0o600); } catch { /* best-effort mode repair */ }
      return this.fileHandle;
    } catch (error) {
      this.markWriteFailed(error, "open");
      throw error;
    }
  }

  private async appendTerminal(handle: DispatchReasoningTraceFileHandle, line: string, op: string): Promise<boolean> {
    const bytes = Buffer.byteLength(line, "utf8");
    if (this.writtenTraceBytes + bytes > this.maxTraceBytes) {
      this.markWriteFailed(new Error("terminal row exceeds maxTraceBytes"), `${op}_cap`);
      return false;
    }
    try {
      await handle.appendFile(line, { encoding: "utf8" });
      this.writtenTraceBytes += bytes;
      return true;
    } catch (error) {
      this.markWriteFailed(error, op);
      return false;
    }
  }

  private async appendWriteFailedCorrection(handle: DispatchReasoningTraceFileHandle): Promise<void> {
    if (this.correctionTerminalWritten) return;
    const line = this.compactTerminalLine("write_failed");
    const bytes = Buffer.byteLength(line, "utf8");
    if (this.writtenTraceBytes + bytes > this.maxTraceBytes) return;
    try {
      await handle.appendFile(line, { encoding: "utf8" });
      this.writtenTraceBytes += bytes;
      this.correctionTerminalWritten = true;
      try { await handle.sync(); } catch (error) { this.markWriteFailed(error, "correction_sync"); }
    } catch (error) {
      this.markWriteFailed(error, "correction_append");
    }
  }

  private async closeAfterTerminal(handle: DispatchReasoningTraceFileHandle): Promise<void> {
    try {
      await handle.close();
      this.fileHandle = undefined;
    } catch (error) {
      this.markWriteFailed(error, "close");
      await this.appendWriteFailedCorrection(handle);
      try {
        await handle.close();
        this.fileHandle = undefined;
      } catch (retryError) {
        this.markWriteFailed(retryError, "close_retry");
      }
    }
  }

  private async finalizeTerminal(forceIncomplete: boolean, runSettled: boolean): Promise<DispatchReasoningTraceSummary> {
    await this.flushQueue();
    let handle = this.fileHandle;
    if (!handle && !this.writeFailed) {
      try { handle = await this.ensureOpen(); } catch { /* summary reports write_failed */ }
    }
    if (!handle) return this.summary(forceIncomplete, runSettled);

    // Phase 1: all non-terminal rows must be appended and synced before any
    // terminal can claim completion.
    if (!this.writeFailed) {
      try { await handle.sync(); } catch (error) { this.markWriteFailed(error, "prepare_sync"); }
    }
    if (this.writeFailed) {
      await this.appendWriteFailedCorrection(handle);
      await this.closeAfterTerminal(handle);
      return this.summary(forceIncomplete, runSettled);
    }

    const status = this.statusFor(forceIncomplete, runSettled);
    const correctionBytes = Buffer.byteLength(
      this.compactTerminalLine("write_failed", "x".repeat(256)),
      "utf8",
    );
    let terminalLine = this.serializeRow("trace_end", this.terminalFields(status));
    if (this.writtenTraceBytes + Buffer.byteLength(terminalLine, "utf8") + correctionBytes > this.maxTraceBytes) {
      this.truncated = true;
      terminalLine = this.compactTerminalLine(status);
    }
    if (this.writtenTraceBytes + Buffer.byteLength(terminalLine, "utf8") + correctionBytes > this.maxTraceBytes) {
      this.markWriteFailed(new Error("terminal reserve is smaller than required terminal rows"), "terminal_reserve");
      await this.appendWriteFailedCorrection(handle);
      await this.closeAfterTerminal(handle);
      return this.summary(forceIncomplete, runSettled);
    }

    // Phase 2: append the terminal claim, then make it durable. A failure in
    // append/sync/close switches the summary and, while writable, appends a
    // corrective write_failed trace_end as the last line.
    const appended = await this.appendTerminal(handle, terminalLine, "terminal_append");
    if (appended) {
      try { await handle.sync(); } catch (error) { this.markWriteFailed(error, "terminal_sync"); }
    }
    if (this.writeFailed) await this.appendWriteFailedCorrection(handle);
    await this.closeAfterTerminal(handle);
    return this.summary(forceIncomplete, runSettled);
  }

  private markWriteFailed(error: unknown, op?: string): void {
    if (!this.writeFailed) {
      this.writeFailed = true;
      this.writeErrorCode = controlledErrorCode(error, op) ?? "write_failed";
      try {
        console.warn(
          `pi-astack/dispatch: reasoning trace ${op ?? "write"} failed ` +
          `(${controlledError(error) ?? this.writeErrorCode}); trace=${this.tracePath}`,
        );
      } catch { /* best-effort warning */ }
    } else if (!this.writeErrorCode) {
      this.writeErrorCode = controlledErrorCode(error, op) ?? "write_failed";
    }
    this.clearQueue();
  }
}

export function createDispatchReasoningTrace(
  options: DispatchReasoningTraceOptions,
): DispatchReasoningTraceWriter {
  return new FileDispatchReasoningTraceWriter(options);
}
