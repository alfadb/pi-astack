/**
 * dispatch-trace — durable + live trajectory for in-process dispatch runs.
 *
 * Protocol: customType `pi-astack/dispatch-trace/v1` written to the *parent*
 * Pi session via pi.appendEntry (not sent to the LLM). Production side only;
 * consumers (router/Web) read the same JSONL custom entries later.
 *
 * Contract (T0):
 *   - stable runId = hash(parentSessionNamespace, parentToolCallId, taskIndex)
 *   - finalized event closed set via child session.subscribe
 *   - raw normalized JSON retained (no credential/key/value/image redaction);
 *     durable + liveTail each get clone/serialize isolation
 *   - fragment target ≤240KiB, per-run payload ≤8MiB with terminal reserve
 *   - single-writer serial parent append queue
 *   - liveTail ≤16KiB non-authoritative snapshot
 *   - normalize/serialize/append never throws into the child
 */

import { createHash } from "node:crypto";

export const DISPATCH_TRACE_CUSTOM_TYPE = "pi-astack/dispatch-trace/v1";
export const DISPATCH_TRACE_SCHEMA_VERSION = 1;
export const DISPATCH_TRACE_MAX_FRAGMENT_BYTES = 240 * 1024;
export const DISPATCH_TRACE_MAX_RUN_BYTES = 8 * 1024 * 1024;
export const DISPATCH_TRACE_TERMINAL_RESERVE_BYTES = 8 * 1024;
export const DISPATCH_TRACE_LIVE_TAIL_MAX_BYTES = 16 * 1024;

export type DispatchTraceEventKind =
  | "lifecycle"
  | "assistant_message"
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "retry"
  | "governor";

/** Terminal statuses written to durable marker + final tool details. */
export type DispatchTraceTerminalStatus =
  | "complete"
  | "truncated"
  | "persist_failed"
  | "interrupted";

export type DispatchTraceLifecyclePhase =
  | "queued"
  | "running"
  | "agent_end"
  | "terminal"
  | "never_started"
  | "preflight_failure";

export interface DispatchTraceNormalizedEvent {
  kind: DispatchTraceEventKind;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface DispatchTraceLiveCurrentBlock {
  kind: "assistant_message" | "thinking";
  text: string;
  updatedAt: number;
}

export interface DispatchTraceLiveTail {
  runId: string;
  revision: number;
  baseEventSeq: number;
  events: Array<{
    eventSeq: number;
    kind: DispatchTraceEventKind;
    payload: Record<string, unknown>;
    createdAt: number;
  }>;
  currentBlock?: DispatchTraceLiveCurrentBlock;
  /** Cleared (false) after terminal finalize; last bounded events retained. */
  live: boolean;
}

export interface DispatchTraceStatusSummary {
  runId: string;
  traceStatus: DispatchTraceTerminalStatus;
  lastPersistedEventSeq: number;
  droppedEventCount: number;
  droppedFragmentCount: number;
  persistedBytes: number;
  persistEnabled: boolean;
}

export type DispatchTraceAppendFn = (customType: string, data: unknown) => void;

export interface DispatchTraceSinkOptions {
  runId: string;
  parentSessionId: string;
  parentToolCallId: string;
  taskIndex: number;
  /** Parent pi.appendEntry; when missing, persist is disabled. */
  appendEntry?: DispatchTraceAppendFn;
  /** Optional shared serial writer (parallel tasks must share one). */
  writer?: ParentAppendQueue;
  maxFragmentBytes?: number;
  maxRunBytes?: number;
  terminalReserveBytes?: number;
  liveTailMaxBytes?: number;
  /** Called after each durable/live mutation (best-effort). */
  onLiveTail?: (tail: DispatchTraceLiveTail) => void;
  now?: () => number;
}

export interface DispatchTraceSink {
  readonly runId: string;
  /** True once end() has been claimed (idempotent; first caller wins). */
  isEnded(): boolean;
  emitLifecycle(
    phase: DispatchTraceLifecyclePhase,
    detail?: Record<string, unknown>,
  ): void;
  emitGovernor(summary: Record<string, unknown>): void;
  handleSessionEvent(event: unknown): void;
  getLiveTail(): DispatchTraceLiveTail;
  end(input?: {
    interrupted?: boolean;
    reason?: string;
    terminalState?: string;
  }): Promise<DispatchTraceStatusSummary>;
}

// ── runId ───────────────────────────────────────────────────────────────

/**
 * Deterministic run id for a dispatch task.
 * Namespace = parent Pi session id (or explicit override); parallel same-name
 * tasks differ by taskIndex.
 */
export function computeDispatchRunId(
  parentSessionNamespace: string,
  parentToolCallId: string,
  taskIndex: number,
): string {
  const ns = String(parentSessionNamespace ?? "");
  const tool = String(parentToolCallId ?? "");
  const idx = Number.isFinite(taskIndex) ? Math.max(0, Math.floor(taskIndex)) : 0;
  const digest = createHash("sha256")
    .update(ns, "utf8")
    .update("\0", "utf8")
    .update(tool, "utf8")
    .update("\0", "utf8")
    .update(String(idx), "utf8")
    .digest("hex");
  return `dtr_${digest.slice(0, 24)}`;
}

export function resolveParentSessionNamespace(input: {
  anchorSessionId?: string | null;
  sessionManager?: { getSessionId?(): string | null | undefined } | null;
  fallback?: string;
}): string {
  if (typeof input.anchorSessionId === "string" && input.anchorSessionId.length > 0) {
    return input.anchorSessionId;
  }
  try {
    const id = input.sessionManager?.getSessionId?.();
    if (typeof id === "string" && id.length > 0) return id;
  } catch { /* ignore */ }
  return input.fallback && input.fallback.length > 0 ? input.fallback : "unknown-session";
}

// ── UTF-8 fragmentation ─────────────────────────────────────────────────

const OMITTED_MARKER = "[pi-astack/dispatch-trace:omitted]";
const TRUNCATED_MARKER = "[truncated]";
/** Streaming delta onLiveTail throttle (ms). getLiveTail() is unaffected. */
const LIVE_TAIL_STREAM_NOTIFY_MIN_MS = 100;

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Split a string into UTF-8-safe chunks each ≤ maxBytes. */
export function splitUtf8ByMaxBytes(value: string, maxBytes: number): string[] {
  if (maxBytes <= 0) return [""];
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= maxBytes) return [value];
  const parts: string[] = [];
  let offset = 0;
  while (offset < buf.length) {
    let end = Math.min(buf.length, offset + maxBytes);
    if (end < buf.length) {
      while (end > offset && (buf[end]! & 0xc0) === 0x80) end--;
      if (end === offset) end = Math.min(buf.length, offset + maxBytes);
    }
    parts.push(buf.subarray(offset, end).toString("utf8"));
    offset = end;
  }
  return parts.length > 0 ? parts : [""];
}

export function measureJsonBytes(value: unknown): number {
  try {
    return utf8ByteLength(JSON.stringify(value));
  } catch {
    return utf8ByteLength(String(value));
  }
}

/** Keep the newest UTF-8 tail of `value` within `maxBytes` (prefix with `...` when cut). */
export function truncateUtf8Tail(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (utf8ByteLength(value) <= maxBytes) return value;
  if (maxBytes <= 3) {
    const buf = Buffer.from(value, "utf8");
    let start = Math.max(0, buf.length - maxBytes);
    while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
    return buf.subarray(start).toString("utf8");
  }
  const budget = maxBytes - 3;
  const buf = Buffer.from(value, "utf8");
  let start = Math.max(0, buf.length - budget);
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
  return `...${buf.subarray(start).toString("utf8")}`;
}

/**
 * Shrink any JSON value so `JSON.stringify(result)` UTF-8 bytes ≤ maxBytes.
 * Nested tool args/results are handled recursively; overflow uses omitted/truncated markers.
 */
export function shrinkJsonValue(value: unknown, maxBytes: number): unknown {
  if (maxBytes <= 0) return { omitted: true, marker: OMITTED_MARKER };
  if (measureJsonBytes(value) <= maxBytes) return value;

  if (typeof value === "string") {
    return shrinkStringForJsonBudget(value, maxBytes);
  }
  if (typeof value === "number" || typeof value === "boolean" || value == null) {
    return { omitted: true, marker: OMITTED_MARKER };
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return value;
    // Keep the newest suffix of the array (latest tool outputs).
    let items = value.slice();
    while (items.length > 1 && measureJsonBytes(items) > maxBytes) {
      items = items.slice(1);
    }
    if (measureJsonBytes(items) <= maxBytes) return items;
    const per = Math.max(8, Math.floor(maxBytes / Math.max(1, items.length)) - 2);
    const shrunk = items.map((item) => shrinkJsonValue(item, per));
    if (measureJsonBytes(shrunk) <= maxBytes) return shrunk;
    // Last resort: single omitted marker array.
    const omitted = [{ omitted: true, marker: OMITTED_MARKER }];
    return measureJsonBytes(omitted) <= maxBytes ? omitted : { omitted: true, marker: OMITTED_MARKER };
  }
  if (typeof value === "object") {
    let out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (let iter = 0; iter < 48; iter++) {
      if (measureJsonBytes(out) <= maxBytes) return out;
      let largestKey: string | null = null;
      let largestSize = -1;
      for (const [k, v] of Object.entries(out)) {
        const size = measureJsonBytes(v);
        if (size > largestSize) {
          largestSize = size;
          largestKey = k;
        }
      }
      if (!largestKey) break;
      const without = { ...out };
      delete without[largestKey];
      const remaining = measureJsonBytes(without);
      // Budget for this field inside the object (quotes/colon/comma headroom).
      const fieldBudget = Math.max(0, maxBytes - remaining - utf8ByteLength(JSON.stringify(largestKey)) - 8);
      if (fieldBudget <= 0 || largestSize <= 24) {
        out = { ...without, [largestKey]: { omitted: true, marker: OMITTED_MARKER } };
        if (measureJsonBytes(out) > maxBytes) {
          out = without;
        }
        continue;
      }
      out = { ...out, [largestKey]: shrinkJsonValue(out[largestKey], fieldBudget) };
    }
    if (measureJsonBytes(out) <= maxBytes) return out;
    return { omitted: true, marker: OMITTED_MARKER };
  }
  return { omitted: true, marker: OMITTED_MARKER };
}

function shrinkStringForJsonBudget(value: string, maxBytes: number): string {
  if (measureJsonBytes(value) <= maxBytes) return value;
  // Binary-search raw UTF-8 tail budget so JSON-escaped size fits (quotes/escapes).
  let lo = 0;
  let hi = utf8ByteLength(value);
  let best = TRUNCATED_MARKER;
  if (measureJsonBytes(best) > maxBytes) {
    // Even the marker is too large for tiny budgets.
    return maxBytes >= 2 ? "\"" : "";
  }
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = mid <= 0 ? TRUNCATED_MARKER : truncateUtf8Tail(value, mid);
    if (measureJsonBytes(candidate) <= maxBytes) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

// ── serial parent append queue ──────────────────────────────────────────

const PARENT_APPEND_QUEUE_KEY = Symbol.for("pi-astack/dispatch-trace/parent-append-queue/v1");

export class ParentAppendQueue {
  private chain: Promise<void> = Promise.resolve();

  enqueue(task: () => void | Promise<void>): Promise<void> {
    const run = this.chain.then(() => task(), () => task());
    // Keep chain alive even when task rejects — callers observe their own promise.
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }
}

/** Process-wide queue so parallel dispatch tasks never concurrent-write SessionManager. */
export function getSharedParentAppendQueue(): ParentAppendQueue {
  const g = globalThis as Record<symbol, unknown>;
  let queue = g[PARENT_APPEND_QUEUE_KEY] as ParentAppendQueue | undefined;
  if (!queue) {
    queue = new ParentAppendQueue();
    g[PARENT_APPEND_QUEUE_KEY] = queue;
  }
  return queue;
}

/** Test seam: replace / clear shared queue. */
export function _resetSharedParentAppendQueueForTests(): void {
  const g = globalThis as Record<symbol, unknown>;
  g[PARENT_APPEND_QUEUE_KEY] = new ParentAppendQueue();
}

// ── event normalization ─────────────────────────────────────────────────

function nowMs(now?: () => number): number {
  return typeof now === "function" ? now() : Date.now();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function assistantVisibleText(message: unknown): string {
  const rec = asRecord(message);
  const content = rec?.content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    const p = asRecord(part);
    if (p?.type === "text" && typeof p.text === "string") out += p.text;
  }
  return out;
}

function assistantThinkingText(message: unknown): string {
  const rec = asRecord(message);
  const content = rec?.content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    const p = asRecord(part);
    if (p?.type === "thinking" && typeof p.thinking === "string") out += p.thinking;
  }
  return out;
}

/**
 * Normalize a child session.subscribe event into zero or more finalized
 * dispatch-trace events. Streaming deltas are not emitted here (liveTail only).
 */
export function normalizeSessionEvent(
  event: unknown,
  createdAt: number,
): DispatchTraceNormalizedEvent[] {
  const rec = asRecord(event);
  if (!rec) return [];
  const eventType = typeof rec.type === "string" ? rec.type : "unknown";

  if (eventType === "agent_start") {
    return [{ kind: "lifecycle", payload: { phase: "running", source: "agent_start" }, createdAt }];
  }

  if (eventType === "agent_end") {
    return [{
      kind: "lifecycle",
      payload: {
        phase: "agent_end",
        source: "agent_end",
        willRetry: rec.willRetry === true,
        messageCount: Array.isArray(rec.messages) ? rec.messages.length : 0,
      },
      createdAt,
    }];
  }

  if (eventType === "message_end" && asRecord(rec.message)?.role === "assistant") {
    const message = rec.message;
    const text = assistantVisibleText(message);
    const thinking = assistantThinkingText(message);
    const out: DispatchTraceNormalizedEvent[] = [];
    if (thinking.length > 0) {
      out.push({
        kind: "thinking",
        payload: { text: thinking },
        createdAt,
      });
    }
    if (text.length > 0) {
      out.push({
        kind: "assistant_message",
        payload: {
          text,
          ...(typeof asRecord(message)?.stopReason === "string"
            ? { stopReason: asRecord(message)!.stopReason }
            : {}),
        },
        createdAt,
      });
    } else if (thinking.length === 0) {
      // Still record empty assistant terminal for lifecycle visibility when
      // stopReason/error present.
      const msg = asRecord(message);
      if (msg && (msg.stopReason || msg.errorMessage)) {
        out.push({
          kind: "assistant_message",
          payload: {
            text: "",
            ...(typeof msg.stopReason === "string" ? { stopReason: msg.stopReason } : {}),
            ...(typeof msg.errorMessage === "string" ? { errorMessage: msg.errorMessage } : {}),
          },
          createdAt,
        });
      }
    }
    return out;
  }

  if (eventType === "tool_execution_start") {
    return [{
      kind: "tool_call",
      payload: {
        name: typeof rec.toolName === "string" ? rec.toolName : "unknown",
        id: typeof rec.toolCallId === "string" ? rec.toolCallId : "",
        args: rec.args ?? null,
      },
      createdAt,
    }];
  }

  if (eventType === "tool_execution_end") {
    return [{
      kind: "tool_result",
      payload: {
        name: typeof rec.toolName === "string" ? rec.toolName : "unknown",
        id: typeof rec.toolCallId === "string" ? rec.toolCallId : "",
        result: rec.result ?? null,
        isError: rec.isError === true,
      },
      createdAt,
    }];
  }

  if (eventType === "auto_retry_start") {
    return [{
      kind: "retry",
      payload: {
        phase: "start",
        attempt: typeof rec.attempt === "number" ? rec.attempt : undefined,
        delayMs: typeof rec.delayMs === "number" ? rec.delayMs : undefined,
        errorMessage: typeof rec.errorMessage === "string" ? rec.errorMessage : undefined,
      },
      createdAt,
    }];
  }

  if (eventType === "auto_retry_end") {
    return [{
      kind: "retry",
      payload: {
        phase: "end",
        success: rec.success === true,
        attempt: typeof rec.attempt === "number" ? rec.attempt : undefined,
        finalError: typeof rec.finalError === "string" ? rec.finalError : undefined,
      },
      createdAt,
    }];
  }

  // Explicit exclusions: message_update deltas, token streams, provider raw.
  return [];
}

export function extractLiveCurrentBlock(
  event: unknown,
  previous: DispatchTraceLiveCurrentBlock | undefined,
  createdAt: number,
  /** Instance liveTail budget; keeps the newest tail, not the head. */
  maxTextBytes: number = DISPATCH_TRACE_LIVE_TAIL_MAX_BYTES,
): DispatchTraceLiveCurrentBlock | undefined {
  const rec = asRecord(event);
  if (!rec) return previous;
  if (rec.type !== "message_update") return previous;
  const ame = asRecord(rec.assistantMessageEvent);
  if (!ame || typeof ame.type !== "string") return previous;
  const textBudget = Math.max(64, Math.floor(maxTextBytes / 4));

  if (ame.type === "text_delta" && typeof ame.delta === "string") {
    const base = previous?.kind === "assistant_message" ? previous.text : "";
    return {
      kind: "assistant_message",
      // Streaming block retains the newest tail under the instance budget.
      text: truncateUtf8Tail(`${base}${ame.delta}`, textBudget),
      updatedAt: createdAt,
    };
  }
  if (ame.type === "thinking_delta" && typeof ame.delta === "string") {
    const base = previous?.kind === "thinking" ? previous.text : "";
    return {
      kind: "thinking",
      text: truncateUtf8Tail(`${base}${ame.delta}`, textBudget),
      updatedAt: createdAt,
    };
  }
  if (ame.type === "text_start" || ame.type === "thinking_start") {
    return {
      kind: ame.type === "thinking_start" ? "thinking" : "assistant_message",
      text: "",
      updatedAt: createdAt,
    };
  }
  if (ame.type === "text_end" || ame.type === "thinking_end") {
    return undefined;
  }
  return previous;
}

// ── sink implementation ─────────────────────────────────────────────────

interface InternalEvent {
  eventSeq: number;
  kind: DispatchTraceEventKind;
  payload: Record<string, unknown>;
  createdAt: number;
}

class DispatchTraceSinkImpl implements DispatchTraceSink {
  readonly runId: string;
  private readonly parentSessionId: string;
  private readonly parentToolCallId: string;
  private readonly taskIndex: number;
  private readonly appendEntry: DispatchTraceAppendFn | undefined;
  private readonly writer: ParentAppendQueue;
  private readonly maxFragmentBytes: number;
  private readonly maxRunBytes: number;
  private readonly terminalReserveBytes: number;
  private readonly liveTailMaxBytes: number;
  private readonly onLiveTail: ((tail: DispatchTraceLiveTail) => void) | undefined;
  private readonly now: () => number;

  private nextEventSeq = 1;
  private lastPersistedEventSeq = 0;
  private droppedEventCount = 0;
  private droppedFragmentCount = 0;
  private persistedBytes = 0;
  private truncated = false;
  private persistFailed = false;
  private ended = false;
  private endPromise: Promise<DispatchTraceStatusSummary> | undefined;
  private liveRevision = 0;
  private currentBlock: DispatchTraceLiveCurrentBlock | undefined;
  private readonly recentEvents: InternalEvent[] = [];
  private live = true;
  private readonly pendingWrites: Promise<void>[] = [];
  /** Last onLiveTail notify time for streaming-delta throttle. */
  private lastStreamNotifyAt = 0;

  constructor(options: DispatchTraceSinkOptions) {
    this.runId = options.runId;
    this.parentSessionId = options.parentSessionId;
    this.parentToolCallId = options.parentToolCallId;
    this.taskIndex = options.taskIndex;
    this.appendEntry = options.appendEntry;
    this.writer = options.writer ?? getSharedParentAppendQueue();
    this.maxFragmentBytes = options.maxFragmentBytes ?? DISPATCH_TRACE_MAX_FRAGMENT_BYTES;
    this.maxRunBytes = options.maxRunBytes ?? DISPATCH_TRACE_MAX_RUN_BYTES;
    this.terminalReserveBytes = options.terminalReserveBytes ?? DISPATCH_TRACE_TERMINAL_RESERVE_BYTES;
    this.liveTailMaxBytes = options.liveTailMaxBytes ?? DISPATCH_TRACE_LIVE_TAIL_MAX_BYTES;
    this.onLiveTail = options.onLiveTail;
    this.now = options.now ?? (() => Date.now());
    if (!this.appendEntry) this.persistFailed = true;
  }

  emitLifecycle(
    phase: DispatchTraceLifecyclePhase,
    detail: Record<string, unknown> = {},
  ): void {
    this.acceptNormalized({
      kind: "lifecycle",
      payload: { phase, ...detail },
      createdAt: this.now(),
    });
  }

  emitGovernor(summary: Record<string, unknown>): void {
    this.acceptNormalized({
      kind: "governor",
      payload: { ...summary },
      createdAt: this.now(),
    });
  }

  handleSessionEvent(event: unknown): void {
    if (this.ended) return;
    try {
      const at = this.now();
      const eventType = asRecord(event)?.type;
      // Live current-block update from streaming deltas (not durable).
      // Hot path: update text only; do NOT full-JSON-measure on every token.
      if (eventType === "message_update") {
        this.currentBlock = extractLiveCurrentBlock(
          event,
          this.currentBlock,
          at,
          this.liveTailMaxBytes,
        );
        this.notifyLiveTailThrottled(at);
      }
      const normalized = normalizeSessionEvent(event, at);
      for (const item of normalized) {
        // Clear current block when the matching finalized event arrives.
        if (
          (item.kind === "assistant_message" && this.currentBlock?.kind === "assistant_message") ||
          (item.kind === "thinking" && this.currentBlock?.kind === "thinking")
        ) {
          this.currentBlock = undefined;
        }
        this.acceptNormalized(item);
      }
    } catch {
      // never throw into child subscribe path
    }
  }

  getLiveTail(): DispatchTraceLiveTail {
    // Ticker / result reads always enforce the strict byte budget.
    this.enforceLiveTailBudget();
    return this.buildLiveTail();
  }

  isEnded(): boolean {
    return this.endPromise !== undefined;
  }

  end(input: {
    interrupted?: boolean;
    reason?: string;
    terminalState?: string;
  } = {}): Promise<DispatchTraceStatusSummary> {
    if (this.endPromise) return this.endPromise;
    this.endPromise = this.finalize(input);
    return this.endPromise;
  }

  private acceptNormalized(item: DispatchTraceNormalizedEvent): void {
    if (this.ended) return;
    try {
      const eventSeq = this.nextEventSeq++;
      // Durable and liveTail must not share payload object identity — liveTail
      // trim may shrink strings for the 16KiB snapshot without mutating what
      // the serial append queue will later persist. Clone/serialize isolation
      // also prevents caller reference mutations from polluting durable/live.
      const durable: InternalEvent = {
        eventSeq,
        kind: item.kind,
        payload: cloneJsonRecord(item.payload),
        createdAt: item.createdAt,
      };
      const liveCopy: InternalEvent = {
        eventSeq,
        kind: item.kind,
        payload: cloneJsonRecord(item.payload),
        createdAt: item.createdAt,
      };
      this.pushRecent(liveCopy);
      this.bumpLiveTail();

      // After persistFailed/truncated/no-append, every discarded event is counted.
      if (this.truncated || this.persistFailed || !this.appendEntry) {
        if (!this.appendEntry) this.persistFailed = true;
        this.droppedEventCount++;
        return;
      }

      void this.persistEvent(durable);
    } catch {
      this.droppedEventCount++;
    }
  }

  private remainingBudget(): number {
    return Math.max(0, this.maxRunBytes - this.terminalReserveBytes - this.persistedBytes);
  }

  private persistEvent(event: InternalEvent): void {
    const write = this.writer.enqueue(async () => {
      if (this.persistFailed || !this.appendEntry) {
        this.droppedEventCount++;
        return;
      }
      try {
        const fragments = this.buildEventFragments(event);
        if (fragments.length === 0) {
          this.droppedEventCount++;
          return;
        }
        let totalBytes = 0;
        for (const frag of fragments) totalBytes += measureJsonBytes(frag);
        if (totalBytes > this.remainingBudget()) {
          this.truncated = true;
          this.droppedEventCount++;
          this.droppedFragmentCount += fragments.length;
          return;
        }
        for (const frag of fragments) {
          const bytes = measureJsonBytes(frag);
          if (bytes > this.remainingBudget()) {
            this.truncated = true;
            this.droppedEventCount++;
            this.droppedFragmentCount += 1;
            return;
          }
          this.appendEntry!(DISPATCH_TRACE_CUSTOM_TYPE, frag);
          this.persistedBytes += bytes;
        }
        this.lastPersistedEventSeq = event.eventSeq;
      } catch {
        this.persistFailed = true;
        this.droppedEventCount++;
      }
    });
    this.pendingWrites.push(write.then(() => undefined, () => undefined));
  }

  private buildEventFragments(event: InternalEvent): Record<string, unknown>[] {
    const base = {
      schemaVersion: DISPATCH_TRACE_SCHEMA_VERSION,
      recordType: "event" as const,
      runId: this.runId,
      parentSessionId: this.parentSessionId,
      parentToolCallId: this.parentToolCallId,
      taskIndex: this.taskIndex,
      eventSeq: event.eventSeq,
      eventKind: event.kind,
      createdAt: event.createdAt,
    };

    // Prefer single-fragment full payload.
    const full = { ...base, fragmentIndex: 0, fragmentCount: 1, payload: event.payload };
    if (measureJsonBytes(full) <= this.maxFragmentBytes) return [full];

    // Fragment payload JSON as UTF-8 string chunks. Final record size is measured
    // after JSON.stringify so quote/backslash/newline double-escaping is counted.
    let payloadJson: string;
    try {
      payloadJson = JSON.stringify(event.payload);
    } catch {
      payloadJson = JSON.stringify({ serialize_failed: true });
    }

    const pack = (chunkBudget: number): Record<string, unknown>[] => {
      const chunks = splitUtf8ByMaxBytes(payloadJson, Math.max(1, chunkBudget));
      const fragmentCount = chunks.length;
      return chunks.map((payloadFragment, fragmentIndex) => ({
        ...base,
        fragmentIndex,
        fragmentCount,
        payloadFragment,
      }));
    };
    const allFit = (frags: Record<string, unknown>[]): boolean =>
      frags.every((frag) => measureJsonBytes(frag) <= this.maxFragmentBytes);

    // Binary-search the largest raw chunk budget whose final records all fit.
    let lo = 1;
    let hi = Math.max(1, utf8ByteLength(payloadJson));
    let best: Record<string, unknown>[] | null = null;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const frags = pack(mid);
      if (allFit(frags)) {
        best = frags;
        lo = mid + 1; // try larger chunks (fewer fragments)
      } else {
        hi = mid - 1;
      }
    }
    if (best && best.length > 0) return best;

    // Even 1-byte payload chunks overflow the envelope: emit an explicit omitted marker.
    const omitted = {
      ...base,
      fragmentIndex: 0,
      fragmentCount: 1,
      payload: { omitted: true, marker: OMITTED_MARKER, reason: "fragment_envelope_overflow" },
    };
    if (measureJsonBytes(omitted) <= this.maxFragmentBytes) return [omitted];
    // Absolute last resort: strip to minimal fields (should still fit 240KiB default).
    return [{
      schemaVersion: DISPATCH_TRACE_SCHEMA_VERSION,
      recordType: "event",
      runId: this.runId,
      eventSeq: event.eventSeq,
      eventKind: event.kind,
      fragmentIndex: 0,
      fragmentCount: 1,
      payload: { omitted: true, marker: OMITTED_MARKER },
      createdAt: event.createdAt,
    }];
  }

  private pushRecent(event: InternalEvent): void {
    this.recentEvents.push(event);
    this.enforceLiveTailBudget();
  }

  /**
   * Strictly enforce liveTail JSON UTF-8 size ≤ liveTailMaxBytes.
   * Drops oldest events, recursively shrinks nested tool payloads, and keeps
   * the newest currentBlock tail. Always leaves an explicit omitted/truncated
   * marker when content must be cut.
   */
  private enforceLiveTailBudget(): void {
    // Drop oldest finalized events first.
    while (this.recentEvents.length > 1 && measureJsonBytes(this.buildLiveTail()) > this.liveTailMaxBytes) {
      this.recentEvents.shift();
    }

    // Shrink sole/remaining event payloads recursively by real JSON bytes.
    if (this.recentEvents.length > 0 && measureJsonBytes(this.buildLiveTail()) > this.liveTailMaxBytes) {
      for (let i = 0; i < this.recentEvents.length; i++) {
        const ev = this.recentEvents[i]!;
        // Residual budget for this payload: total cap minus the rest of the tail.
        const skeletonBytes = measureJsonBytes(this.buildLiveTailSkeleton(i));
        const residual = Math.max(64, this.liveTailMaxBytes - skeletonBytes);
        const shrunk = shrinkJsonValue(ev.payload, residual);
        ev.payload = (shrunk && typeof shrunk === "object" && !Array.isArray(shrunk))
          ? shrunk as Record<string, unknown>
          : { value: shrunk, truncated: true, marker: TRUNCATED_MARKER };
        if (measureJsonBytes(this.buildLiveTail()) <= this.liveTailMaxBytes) break;
      }
    }

    // Shrink / drop currentBlock (newest tail retained).
    if (this.currentBlock && measureJsonBytes(this.buildLiveTail()) > this.liveTailMaxBytes) {
      const textBudget = Math.max(32, Math.floor(this.liveTailMaxBytes / 4));
      this.currentBlock = {
        ...this.currentBlock,
        text: truncateUtf8Tail(this.currentBlock.text, textBudget),
      };
      // Binary-search text if still over (JSON escaping of currentBlock).
      if (measureJsonBytes(this.buildLiveTail()) > this.liveTailMaxBytes) {
        let lo = 0;
        let hi = utf8ByteLength(this.currentBlock.text);
        let bestText = TRUNCATED_MARKER;
        while (lo <= hi) {
          const mid = Math.floor((lo + hi) / 2);
          const candidate = mid <= 0 ? TRUNCATED_MARKER : truncateUtf8Tail(this.currentBlock.text, mid);
          this.currentBlock = { ...this.currentBlock, text: candidate };
          if (measureJsonBytes(this.buildLiveTail()) <= this.liveTailMaxBytes) {
            bestText = candidate;
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
        this.currentBlock = { ...this.currentBlock, text: bestText };
      }
      if (measureJsonBytes(this.buildLiveTail()) > this.liveTailMaxBytes) {
        this.currentBlock = undefined;
      }
    }

    // Drop events entirely if still over after payload shrink.
    while (this.recentEvents.length > 0 && measureJsonBytes(this.buildLiveTail()) > this.liveTailMaxBytes) {
      if (this.recentEvents.length === 1) {
        const only = this.recentEvents[0]!;
        only.payload = { omitted: true, marker: OMITTED_MARKER };
        if (measureJsonBytes(this.buildLiveTail()) > this.liveTailMaxBytes) {
          this.recentEvents.shift();
        }
        break;
      }
      this.recentEvents.shift();
    }

    // Absolute floor: empty events, no currentBlock — skeleton must fit.
    if (measureJsonBytes(this.buildLiveTail()) > this.liveTailMaxBytes) {
      this.recentEvents.length = 0;
      this.currentBlock = undefined;
    }
  }

  /** Probe helper: liveTail with event i's payload replaced by null (size estimate). */
  private buildLiveTailSkeleton(replaceIndex: number): DispatchTraceLiveTail {
    const baseEventSeq = this.recentEvents.length > 0
      ? this.recentEvents[0]!.eventSeq - 1
      : this.lastPersistedEventSeq;
    return {
      runId: this.runId,
      revision: this.liveRevision,
      baseEventSeq: Math.max(0, baseEventSeq),
      events: this.recentEvents.map((e, idx) => ({
        eventSeq: e.eventSeq,
        kind: e.kind,
        payload: idx === replaceIndex ? {} : e.payload,
        createdAt: e.createdAt,
      })),
      ...(this.currentBlock ? { currentBlock: { ...this.currentBlock } } : {}),
      live: this.live,
    };
  }

  private buildLiveTail(): DispatchTraceLiveTail {
    const baseEventSeq = this.recentEvents.length > 0
      ? this.recentEvents[0]!.eventSeq - 1
      : this.lastPersistedEventSeq;
    return {
      runId: this.runId,
      revision: this.liveRevision,
      baseEventSeq: Math.max(0, baseEventSeq),
      events: this.recentEvents.map((e) => ({
        eventSeq: e.eventSeq,
        kind: e.kind,
        payload: e.payload,
        createdAt: e.createdAt,
      })),
      ...(this.currentBlock ? { currentBlock: { ...this.currentBlock } } : {}),
      live: this.live,
    };
  }

  private bumpLiveTail(): void {
    this.liveRevision++;
    this.enforceLiveTailBudget();
    try {
      this.onLiveTail?.(this.buildLiveTail());
    } catch { /* best-effort */ }
  }

  /**
   * Streaming-delta path: avoid full JSON stringify on every token.
   * Throttled onLiveTail; 1s ticker reads go through getLiveTail() which enforces.
   */
  private notifyLiveTailThrottled(at: number): void {
    if (at - this.lastStreamNotifyAt < LIVE_TAIL_STREAM_NOTIFY_MIN_MS) {
      // Still bump revision so consumers can detect movement without payload work.
      this.liveRevision++;
      return;
    }
    this.lastStreamNotifyAt = at;
    this.liveRevision++;
    // Cheap currentBlock-only clamp (no full event walk) before notify.
    if (this.currentBlock) {
      const textBudget = Math.max(64, Math.floor(this.liveTailMaxBytes / 4));
      if (utf8ByteLength(this.currentBlock.text) > textBudget) {
        this.currentBlock = {
          ...this.currentBlock,
          text: truncateUtf8Tail(this.currentBlock.text, textBudget),
        };
      }
    }
    try {
      // Enforce once at notify boundary so onLiveTail never exceeds the cap.
      this.enforceLiveTailBudget();
      this.onLiveTail?.(this.buildLiveTail());
    } catch { /* best-effort */ }
  }

  private async finalize(input: {
    interrupted?: boolean;
    reason?: string;
    terminalState?: string;
  }): Promise<DispatchTraceStatusSummary> {
    this.ended = true;
    // Wait for in-flight event writes before terminal marker.
    if (this.pendingWrites.length > 0) {
      try {
        await Promise.all(this.pendingWrites.splice(0));
      } catch { /* already swallowed */ }
    }

    let status: DispatchTraceTerminalStatus;
    if (this.persistFailed || !this.appendEntry) {
      status = "persist_failed";
    } else if (input.interrupted) {
      status = "interrupted";
    } else if (this.truncated) {
      status = "truncated";
    } else {
      status = "complete";
    }

    // Clear live flag but retain last bounded events for result sync.
    this.live = false;
    this.currentBlock = undefined;
    this.bumpLiveTail();

    const terminalPayload = {
      schemaVersion: DISPATCH_TRACE_SCHEMA_VERSION,
      recordType: "terminal" as const,
      runId: this.runId,
      parentSessionId: this.parentSessionId,
      parentToolCallId: this.parentToolCallId,
      taskIndex: this.taskIndex,
      status,
      lastPersistedEventSeq: this.lastPersistedEventSeq,
      droppedEventCount: this.droppedEventCount,
      droppedFragmentCount: this.droppedFragmentCount,
      persistedBytes: this.persistedBytes,
      ...(input.reason ? { reason: String(input.reason).slice(0, 500) } : {}),
      ...(input.terminalState ? { terminalState: String(input.terminalState).slice(0, 64) } : {}),
      createdAt: this.now(),
    };

    if (this.appendEntry && !this.persistFailed) {
      try {
        await this.writer.enqueue(async () => {
          try {
            this.appendEntry!(DISPATCH_TRACE_CUSTOM_TYPE, terminalPayload);
            this.persistedBytes += measureJsonBytes(terminalPayload);
          } catch {
            this.persistFailed = true;
            if (status === "complete" || status === "truncated") status = "persist_failed";
          }
        });
      } catch {
        this.persistFailed = true;
        if (status === "complete" || status === "truncated") status = "persist_failed";
      }
    } else if (!this.appendEntry) {
      this.persistFailed = true;
      status = "persist_failed";
    }

    // If terminal write flipped persistFailed after a clean run:
    if (this.persistFailed && status === "complete") status = "persist_failed";

    return {
      runId: this.runId,
      traceStatus: status,
      lastPersistedEventSeq: this.lastPersistedEventSeq,
      droppedEventCount: this.droppedEventCount,
      droppedFragmentCount: this.droppedFragmentCount,
      persistedBytes: this.persistedBytes,
      persistEnabled: !!this.appendEntry,
    };
  }
}

function cloneJsonRecord(value: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return { ...value };
  }
}

export function createDispatchTraceSink(options: DispatchTraceSinkOptions): DispatchTraceSink {
  return new DispatchTraceSinkImpl(options);
}

/** Fields for AgentResult / tool details. */
export function dispatchTraceSummaryFields(
  summary: DispatchTraceStatusSummary | undefined,
): Record<string, unknown> {
  if (!summary) return {};
  return {
    runId: summary.runId,
    traceStatus: summary.traceStatus,
    lastPersistedEventSeq: summary.lastPersistedEventSeq,
    droppedEventCount: summary.droppedEventCount,
    droppedFragmentCount: summary.droppedFragmentCount,
    persistedBytes: summary.persistedBytes,
  };
}

export function dispatchTraceFieldsFromResult(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object") return {};
  const r = result as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof r.dispatch_run_id === "string") out.runId = r.dispatch_run_id;
  if (typeof r.dispatch_trace_status === "string") out.traceStatus = r.dispatch_trace_status;
  if (typeof r.dispatch_trace_last_event_seq === "number") {
    out.lastPersistedEventSeq = r.dispatch_trace_last_event_seq;
  }
  if (typeof r.dispatch_trace_dropped_events === "number") {
    out.droppedEventCount = r.dispatch_trace_dropped_events;
  }
  if (typeof r.dispatch_trace_dropped_fragments === "number") {
    out.droppedFragmentCount = r.dispatch_trace_dropped_fragments;
  }
  if (typeof r.dispatch_trace_persisted_bytes === "number") {
    out.persistedBytes = r.dispatch_trace_persisted_bytes;
  }
  // liveTail is intentionally NOT mirrored here — final tool details keep a
  // single copy under dispatchProgress.tasks[].liveTail only.
  return out;
}
