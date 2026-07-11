/**
 * Incremental exact-tail repetition detector for assistant visible text.
 *
 * The detector is response-scoped and stores at most 64 KiB of normalized
 * text plus a bounded raw sample used only for structured-data classification.
 * Unicode whitespace is collapsed incrementally. A hash is emitted for audit,
 * but every repetition decision is made by exact character comparison.
 */

export const VISIBLE_TEXT_REPEAT_RULE_VERSION = "visible-text-exact-tail/v1";
export const VISIBLE_TEXT_RING_CHARS = 64 * 1024;
export const VISIBLE_TEXT_CHECK_INTERVAL = 256;

export interface VisibleTextRepeatMetrics {
  rule_version: typeof VISIBLE_TEXT_REPEAT_RULE_VERSION;
  hash: string;
  period: number;
  rounds: number;
  repeated_chars: number;
  normalized_chars: number;
  ring_chars: number;
  structured_ratio: number;
  structured: boolean;
}

export interface VisibleTextRepeatVerdict {
  trip: boolean;
  metrics?: VisibleTextRepeatMetrics;
}

interface CycleCandidate {
  period: number;
  pattern: string;
  hash: string;
  exactChars: number;
  nextIndex: number;
  structuredRatio: number;
}

interface CycleThreshold {
  minChars: number;
  minRounds: number;
}

function thresholdForPeriod(period: number): CycleThreshold {
  if (period <= 16) return { minChars: 4096, minRounds: 64 };
  if (period <= 128) return { minChars: 6144, minRounds: 16 };
  if (period <= 1024) return { minChars: 8192, minRounds: 8 };
  return { minChars: 24576, minRounds: 6 };
}

function requiredChars(period: number): number {
  const threshold = thresholdForPeriod(period);
  return Math.max(threshold.minChars, period * threshold.minRounds);
}

function fnv1a32(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function isUnicodeWhitespace(ch: string): boolean {
  return /\s/u.test(ch);
}

function structuredLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^(?:```|~~~|[|+\-]{3,}|@@|diff\s|index\s|[+\-]\+\+\+|---\s)/.test(trimmed)) return true;
  if (/^[+\-](?:\s|[^+\-])/.test(trimmed)) return true;
  if (/^(?:\d{4}-\d\d-\d\d[T ]|\[?(?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\]?\b)/i.test(trimmed)) return true;
  if (/^(?:[{\[]|[}\]],?$|"[^"\n]+"\s*:|[A-Za-z_$][\w$]*\s*[:=]\s*)/.test(trimmed)) return true;
  if (/^(?:function|class|interface|type|const|let|var|import|export|return|if|for|while|try|catch)\b/.test(trimmed)) return true;
  if (/^[A-Za-z0-9+/]{64,}={0,2}$/.test(trimmed)) return true;
  const syntax = (trimmed.match(/[{}\[\]();,:|<>=$`\\]/g) ?? []).length;
  return syntax >= 3 && syntax / Math.max(1, trimmed.length) >= 0.08;
}

/** Estimate what fraction of a bounded repeated sample is structured data. */
export function structuredTextRatio(input: string): number {
  if (!input) return 0;
  let structuredChars = 0;
  let totalChars = 0;
  for (const line of input.split("\n")) {
    const width = Array.from(line).length + 1;
    totalChars += width;
    if (structuredLine(line)) {
      structuredChars += width;
      continue;
    }
    for (const ch of line) {
      if (/\d/u.test(ch) || /[{}\[\]();,:|<>=$`\\]/u.test(ch)) structuredChars++;
    }
  }
  return Math.min(1, structuredChars / Math.max(1, totalChars));
}

function exactBlocksMatch(value: string, period: number): boolean {
  const right = value.length - period;
  const left = right - period;
  if (left < 0) return false;
  for (let i = 0; i < period; i++) {
    if (value.charCodeAt(left + i) !== value.charCodeAt(right + i)) return false;
  }
  return true;
}

function exactTailChars(value: string, period: number): number {
  if (value.length < period * 2) return 0;
  let count = period;
  for (let i = value.length - period - 1; i >= 0; i--) {
    if (value.charCodeAt(i) !== value.charCodeAt(i + period)) break;
    count++;
  }
  return count;
}

/**
 * Generate only periods whose trailing anchor occurs at the corresponding
 * previous position. lastIndexOf is implemented natively and avoids rebuilding
 * two 64 KiB rolling-hash arrays at every 256-character checkpoint.
 */
function anchoredPeriodCandidates(value: string, maxPeriod: number): number[] {
  const anchorLength = Math.min(32, Math.floor(value.length / 2));
  if (anchorLength < 1) return [];
  const anchorStart = value.length - anchorLength;
  const earliest = Math.max(0, anchorStart - maxPeriod);
  const anchor = value.slice(anchorStart);
  const periods: number[] = [];
  let searchFrom = anchorStart - 1;
  while (searchFrom >= earliest) {
    const found = value.lastIndexOf(anchor, searchFrom);
    if (found < earliest) break;
    periods.push(anchorStart - found);
    searchFrom = found - 1;
  }
  return periods;
}

export class VisibleTextRepeatDetector {
  private ring = "";
  private rawStructureRing = "";
  private normalizedChars = 0;
  private nextCheckAt = VISIBLE_TEXT_CHECK_INTERVAL;
  private pendingWhitespace = false;
  private carryHighSurrogate = "";
  private candidate: CycleCandidate | undefined;
  private tripped: VisibleTextRepeatMetrics | undefined;

  messageStart(): void {
    this.ring = "";
    this.rawStructureRing = "";
    this.normalizedChars = 0;
    this.nextCheckAt = VISIBLE_TEXT_CHECK_INTERVAL;
    this.pendingWhitespace = false;
    this.carryHighSurrogate = "";
    this.candidate = undefined;
    this.tripped = undefined;
  }

  pushDelta(delta: string): VisibleTextRepeatVerdict {
    if (this.tripped) return { trip: true, metrics: this.tripped };
    this.consumeRaw(String(delta ?? ""), false);
    return this.tripped ? { trip: true, metrics: this.tripped } : { trip: false };
  }

  messageEnd(): VisibleTextRepeatVerdict {
    if (this.tripped) return { trip: true, metrics: this.tripped };
    this.consumeRaw("", true);
    this.checkTail();
    return this.tripped ? { trip: true, metrics: this.tripped } : { trip: false };
  }

  snapshot(): {
    normalized_chars: number;
    ring_chars: number;
    tripped: boolean;
    candidate_period?: number;
    candidate_structured_ratio?: number;
  } {
    return {
      normalized_chars: this.normalizedChars,
      ring_chars: this.ring.length,
      tripped: this.tripped !== undefined,
      ...(this.candidate ? {
        candidate_period: this.candidate.period,
        candidate_structured_ratio: this.candidate.structuredRatio,
      } : {}),
    };
  }

  /**
   * Raw and normalized data advance in the same checkpoint-sized frames. Thus a
   * check at normalized offset N cannot classify itself using JSON/log text that
   * appears later in the same provider delta.
   */
  private consumeRaw(rawDelta: string, final: boolean): void {
    let input = this.carryHighSurrogate + rawDelta;
    this.carryHighSurrogate = "";
    if (!final && input.length > 0) {
      const last = input.charCodeAt(input.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) {
        this.carryHighSurrogate = input.slice(-1);
        input = input.slice(0, -1);
      }
    }
    if (final && this.carryHighSurrogate) {
      input += this.carryHighSurrogate;
      this.carryHighSurrogate = "";
    }

    let rawFrame = "";
    let normalizedFrame = "";
    const flush = (): void => {
      if (!rawFrame && !normalizedFrame) return;
      this.appendRaw(rawFrame);
      this.consumeNormalized(normalizedFrame);
      rawFrame = "";
      normalizedFrame = "";
    };

    for (const ch of input) {
      if (this.tripped) break;
      rawFrame += ch;
      if (isUnicodeWhitespace(ch)) {
        if (this.normalizedChars + normalizedFrame.length > 0) this.pendingWhitespace = true;
      } else {
        if (this.pendingWhitespace) {
          normalizedFrame += " ";
          this.pendingWhitespace = false;
        }
        normalizedFrame += ch;
      }
      if (this.normalizedChars + normalizedFrame.length >= this.nextCheckAt) flush();
    }
    if (final) this.pendingWhitespace = false;
    flush();
  }

  private appendRaw(value: string): void {
    if (!value) return;
    this.rawStructureRing += value;
    if (this.rawStructureRing.length > VISIBLE_TEXT_RING_CHARS) {
      this.rawStructureRing = this.rawStructureRing.slice(-VISIBLE_TEXT_RING_CHARS);
    }
  }

  private consumeNormalized(value: string): void {
    let offset = 0;
    while (offset < value.length && !this.tripped) {
      const room = Math.max(1, this.nextCheckAt - this.normalizedChars);
      const part = value.slice(offset, offset + room);
      offset += part.length;
      this.advanceCandidate(part);
      this.ring += part;
      if (this.ring.length > VISIBLE_TEXT_RING_CHARS) {
        this.ring = this.ring.slice(-VISIBLE_TEXT_RING_CHARS);
      }
      this.normalizedChars += part.length;
      if (this.normalizedChars >= this.nextCheckAt) {
        this.checkTail();
        this.nextCheckAt += VISIBLE_TEXT_CHECK_INTERVAL;
      }
    }
  }

  private advanceCandidate(value: string): void {
    const candidate = this.candidate;
    if (!candidate) return;
    for (let i = 0; i < value.length; i++) {
      if (value.charCodeAt(i) !== candidate.pattern.charCodeAt(candidate.nextIndex)) {
        this.candidate = undefined;
        return;
      }
      candidate.exactChars++;
      candidate.nextIndex = (candidate.nextIndex + 1) % candidate.period;
    }
  }

  private checkTail(): void {
    if (this.tripped) return;
    const active = this.candidate;
    if (active) {
      const thresholdChars = active.structuredRatio >= 0.6
        ? Math.max(131072, active.period * 32)
        : requiredChars(active.period);
      if (active.exactChars >= thresholdChars) this.trip(active, active.exactChars);
      return;
    }

    const maxPeriod = Math.min(4096, Math.floor(this.ring.length / 2));
    for (const period of anchoredPeriodCandidates(this.ring, maxPeriod)) {
      const required = requiredChars(period);
      if (this.ring.length < required) continue;
      if (!exactBlocksMatch(this.ring, period)) continue;
      const repeatedChars = exactTailChars(this.ring, period);
      if (repeatedChars < required) continue;

      const pattern = this.ring.slice(-period);
      const sampleChars = Math.min(this.rawStructureRing.length, Math.max(8192, repeatedChars));
      const structuredRatio = structuredTextRatio(this.rawStructureRing.slice(-sampleChars));
      const candidate: CycleCandidate = {
        period,
        pattern,
        hash: fnv1a32(pattern),
        exactChars: repeatedChars,
        nextIndex: 0,
        structuredRatio,
      };
      this.candidate = candidate;
      const thresholdChars = structuredRatio >= 0.6
        ? Math.max(131072, period * 32)
        : required;
      if (repeatedChars >= thresholdChars) this.trip(candidate, repeatedChars);
      return;
    }
  }

  private trip(candidate: CycleCandidate, repeatedChars: number): void {
    this.tripped = {
      rule_version: VISIBLE_TEXT_REPEAT_RULE_VERSION,
      hash: candidate.hash,
      period: candidate.period,
      rounds: Math.floor(repeatedChars / candidate.period),
      repeated_chars: repeatedChars,
      normalized_chars: this.normalizedChars,
      ring_chars: this.ring.length,
      structured_ratio: candidate.structuredRatio,
      structured: candidate.structuredRatio >= 0.6,
    };
  }
}

export function scanVisibleTextForRepeat(text: string): VisibleTextRepeatVerdict {
  const detector = new VisibleTextRepeatDetector();
  detector.messageStart();
  const verdict = detector.pushDelta(text);
  return verdict.trip ? verdict : detector.messageEnd();
}
