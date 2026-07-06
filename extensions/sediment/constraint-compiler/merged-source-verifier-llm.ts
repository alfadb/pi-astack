import { sanitizeForMemory } from "../sanitizer";
import { makeDiagnostic } from "./diagnostics";
import {
  buildMergedSourceVerifierInputRows,
  buildMergedSourceVerifierLookup,
  createMergedSourceVerifierReport,
  type ConstraintMergedSourceVerifierVerdictRow,
} from "./merged-source-verifier";
import { sha256Hex, stableCanonicalize } from "./normalize";
import { buildMergedSourceVerifierPrompt } from "./merged-source-verifier-prompt";
import type {
  ConstraintEventSourceRecord,
  ConstraintMergedSourceVerifierInvokeResult,
  ConstraintMergedSourceVerifierInvoker,
  ConstraintMergedSourceVerifierPrompt,
  ConstraintMergedSourceVerifierRunResult,
  ParsedConstraintMergedSourceVerifierOutput,
  ValidatedConstraintCompilerDecision,
} from "./types";

const VERDICTS = new Set(["expressed", "not_expressed", "uncertain"]);
const CONFIDENCES = new Set(["high", "medium", "low"]);

function extractJsonValue(text: string): string | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const body = fenced ? fenced[1].trim() : trimmed;
  const objectStart = body.indexOf("{");
  const arrayStart = body.indexOf("[");
  const starts = [objectStart, arrayStart].filter((index) => index >= 0).sort((a, b) => a - b);
  if (!starts.length) return null;

  const start = starts[0];
  const open = body[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < body.length; index += 1) {
    const char = body[index];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === "\\" && inString) {
      escape = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === open) depth += 1;
    if (char === close) {
      depth -= 1;
      if (depth === 0) return body.slice(start, index + 1);
    }
  }
  return null;
}

function parseRows(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).rows)) {
    return (value as Record<string, unknown>).rows as unknown[];
  }
  return null;
}

function rowKey(row: { sourceRecordId: string; targetConstraintId: string }): string {
  return `${row.sourceRecordId}\0${row.targetConstraintId}`;
}

function invalidParse(rawOutput: string, rawOutputHash: string, message: string, data: Record<string, unknown> = {}): ParsedConstraintMergedSourceVerifierOutput {
  return {
    ok: false,
    rawOutput,
    rawOutputHash,
    diagnostic: makeDiagnostic({
      code: "SC_MERGED_SOURCE_VERIFIER_PARSE_FAILED",
      message,
      data: { rawOutputHash, ...data },
    }),
  };
}

export function parseMergedSourceVerifierOutput(
  rawText: string,
  input: {
    prompt: ConstraintMergedSourceVerifierPrompt;
    events: ConstraintEventSourceRecord[];
    decision: ValidatedConstraintCompilerDecision;
  },
): ParsedConstraintMergedSourceVerifierOutput {
  const sanitized = sanitizeForMemory(rawText);
  const rawOutput = sanitized.text ?? rawText;
  const rawOutputHash = sha256Hex(rawOutput);
  const jsonText = extractJsonValue(rawOutput);
  if (!jsonText) return invalidParse(rawOutput, rawOutputHash, "constraint merged-source verifier returned no JSON value");

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch (err) {
    return invalidParse(rawOutput, rawOutputHash, "constraint merged-source verifier JSON parse failed", { error: err instanceof Error ? err.message : String(err) });
  }

  const rawRows = parseRows(parsed);
  if (!rawRows) return invalidParse(rawOutput, rawOutputHash, "constraint merged-source verifier returned unsupported row schema");

  const expectedRows = buildMergedSourceVerifierInputRows(input.events, input.decision);
  if (rawRows.length !== expectedRows.length) {
    return invalidParse(rawOutput, rawOutputHash, "constraint merged-source verifier returned the wrong row count", { expectedRows: expectedRows.length, actualRows: rawRows.length });
  }

  const expectedByKey = new Map(expectedRows.map((row) => [rowKey(row), row]));
  const seen = new Set<string>();
  const rows: ConstraintMergedSourceVerifierVerdictRow[] = [];
  for (const rawRow of rawRows) {
    if (!rawRow || typeof rawRow !== "object") return invalidParse(rawOutput, rawOutputHash, "constraint merged-source verifier row is not an object");
    const candidate = rawRow as Record<string, unknown>;
    const eventId = candidate.eventId;
    const sourceRecordId = candidate.sourceRecordId;
    const targetConstraintId = candidate.targetConstraintId;
    const verdict = candidate.verdict;
    const confidence = candidate.confidence;
    const reasoningValue = candidate.reasoning;
    if (typeof eventId !== "string" || typeof sourceRecordId !== "string" || typeof targetConstraintId !== "string") {
      return invalidParse(rawOutput, rawOutputHash, "constraint merged-source verifier row is missing binding ids");
    }
    const key = rowKey({ sourceRecordId, targetConstraintId });
    const expected = expectedByKey.get(key);
    if (!expected || expected.eventId !== eventId) return invalidParse(rawOutput, rawOutputHash, "constraint merged-source verifier row does not match requested input", { sourceRecordId, targetConstraintId });
    if (seen.has(key)) return invalidParse(rawOutput, rawOutputHash, "constraint merged-source verifier returned a duplicate row", { sourceRecordId, targetConstraintId });
    if (typeof verdict !== "string" || !VERDICTS.has(verdict)) return invalidParse(rawOutput, rawOutputHash, "constraint merged-source verifier row has invalid verdict", { sourceRecordId, targetConstraintId });
    if (typeof confidence !== "string" || !CONFIDENCES.has(confidence)) return invalidParse(rawOutput, rawOutputHash, "constraint merged-source verifier row has invalid confidence", { sourceRecordId, targetConstraintId });
    if (typeof reasoningValue !== "string") return invalidParse(rawOutput, rawOutputHash, "constraint merged-source verifier row is missing reasoning", { sourceRecordId, targetConstraintId });
    const reasoning = sanitizeForMemory(reasoningValue).text ?? reasoningValue;
    seen.add(key);
    rows.push({ eventId, sourceRecordId, targetConstraintId, verdict, confidence, reasoning });
  }

  for (const expected of expectedRows) {
    if (!seen.has(rowKey(expected))) {
      return invalidParse(rawOutput, rawOutputHash, "constraint merged-source verifier omitted a requested row", { sourceRecordId: expected.sourceRecordId, targetConstraintId: expected.targetConstraintId });
    }
  }

  rows.sort((left, right) => stableCanonicalize(left).localeCompare(stableCanonicalize(right)));
  return {
    ok: true,
    rows,
    rawOutput,
    rawOutputHash,
    parsedOutputHash: sha256Hex(stableCanonicalize(rows)),
  };
}

export async function runMergedSourceVerifierWithInvoker(input: {
  events: ConstraintEventSourceRecord[];
  decision: ValidatedConstraintCompilerDecision;
  invoker: ConstraintMergedSourceVerifierInvoker;
  modelRef?: string;
  maxPromptChars?: number;
  signal?: AbortSignal;
}): Promise<ConstraintMergedSourceVerifierRunResult> {
  let prompt: ConstraintMergedSourceVerifierPrompt;
  try {
    prompt = buildMergedSourceVerifierPrompt({ events: input.events, decision: input.decision, maxPromptChars: input.maxPromptChars });
  } catch (err) {
    return {
      ok: false,
      diagnostic: makeDiagnostic({
        code: "SC_MERGED_SOURCE_VERIFIER_PARSE_FAILED",
        message: "constraint merged-source verifier prompt construction failed",
        data: { error: err instanceof Error ? err.message : String(err) },
      }),
    };
  }

  if (prompt.rowCount === 0) {
    return {
      ok: true,
      prompt,
      report: createMergedSourceVerifierReport({
        events: input.events,
        decision: input.decision,
        verdictRows: [],
        generator: {
          modelRef: input.modelRef,
          promptHash: prompt.promptHash,
          rawOutputHash: sha256Hex(""),
          parsedOutputHash: sha256Hex(stableCanonicalize([])),
        },
      }),
      rawOutput: "",
      rawOutputHash: sha256Hex(""),
      parsedOutputHash: sha256Hex(stableCanonicalize([])),
      modelRef: input.modelRef,
    };
  }

  let invoked: ConstraintMergedSourceVerifierInvokeResult;
  try {
    invoked = await input.invoker({ prompt, modelRef: input.modelRef, signal: input.signal });
  } catch (err) {
    return {
      ok: false,
      prompt,
      modelRef: input.modelRef,
      diagnostic: makeDiagnostic({
        code: "SC_MERGED_SOURCE_VERIFIER_MODEL_UNAVAILABLE",
        message: "constraint merged-source verifier invoker threw",
        data: { error: err instanceof Error ? err.message : String(err) },
      }),
    };
  }

  if (!invoked.ok) {
    return {
      ok: false,
      prompt,
      modelRef: invoked.modelRef ?? input.modelRef,
      durationMs: invoked.durationMs,
      diagnostic: makeDiagnostic({
        code: "SC_MERGED_SOURCE_VERIFIER_MODEL_UNAVAILABLE",
        message: "constraint merged-source verifier model unavailable",
        data: { error: invoked.error },
      }),
    };
  }

  const parsed = parseMergedSourceVerifierOutput(invoked.text, { prompt, events: input.events, decision: input.decision });
  if (!parsed.ok) {
    return {
      ok: false,
      prompt,
      modelRef: invoked.modelRef ?? input.modelRef,
      durationMs: invoked.durationMs,
      rawOutput: parsed.rawOutput,
      rawOutputHash: parsed.rawOutputHash,
      diagnostic: parsed.diagnostic,
    };
  }

  const report = createMergedSourceVerifierReport({
    events: input.events,
    decision: input.decision,
    verdictRows: parsed.rows,
    generator: {
      modelRef: invoked.modelRef ?? input.modelRef,
      promptHash: prompt.promptHash,
      rawOutputHash: parsed.rawOutputHash,
      parsedOutputHash: parsed.parsedOutputHash,
      durationMs: invoked.durationMs,
    },
  });
  const lookup = buildMergedSourceVerifierLookup({ events: input.events, decision: input.decision, verifier: report });
  if (lookup.reportStatus !== "valid") {
    return {
      ok: false,
      prompt,
      modelRef: invoked.modelRef ?? input.modelRef,
      durationMs: invoked.durationMs,
      rawOutput: parsed.rawOutput,
      rawOutputHash: parsed.rawOutputHash,
      diagnostic: makeDiagnostic({
        code: "SC_MERGED_SOURCE_VERIFIER_PARSE_FAILED",
        message: "constraint merged-source verifier report binding failed validation",
        data: { reportStatus: lookup.reportStatus, rawOutputHash: parsed.rawOutputHash },
      }),
    };
  }

  return {
    ok: true,
    prompt,
    report,
    rawOutput: parsed.rawOutput,
    rawOutputHash: parsed.rawOutputHash,
    parsedOutputHash: parsed.parsedOutputHash,
    modelRef: invoked.modelRef ?? input.modelRef,
    durationMs: invoked.durationMs,
  };
}
