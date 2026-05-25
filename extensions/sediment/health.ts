/**
 * sediment health — ADR 0024 §5.3 / ADR 0025 §4.3 advisory classifier
 * quality meta-check.
 *
 * This module is intentionally read-only/advisory: it scans recent audit rows
 * for active-correction classifier traces and reports whether the reasoning
 * surface still contains the ingredients later LLMs need (quotes,
 * alternatives, concrete self-critique). It never gates writes and never asks
 * the user to manage memory.
 */

import * as fs from "node:fs";
import { sedimentAuditPath } from "../_shared/runtime";

export interface ClassifierHealthSummary {
  ok: boolean;
  /** Recent correction_classifier audit rows considered before trace parsing. */
  classifierRowCount: number;
  /** Rows with a parseable reasoning_trace. */
  sampleSize: number;
  windowSize: number;
  quoteRate: number;
  alternativeRate: number;
  concreteSelfCritiqueRate: number;
  threshold: number;
  advisories: string[];
}

type ReasoningTrace = Record<string, unknown>;

function readAuditRows(projectRoot: string): Record<string, unknown>[] {
  const auditPath = sedimentAuditPath(projectRoot);
  if (!fs.existsSync(auditPath)) return [];
  const rows: Record<string, unknown>[] = [];
  for (const line of fs.readFileSync(auditPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") rows.push(parsed as Record<string, unknown>);
    } catch {
      // Audit is best-effort JSONL; corrupt historical rows should not make
      // health checks noisy or block sediment.
    }
  }
  return rows;
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join("\n");
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).map(textOf).join("\n");
  return "";
}

function getTrace(row: Record<string, unknown>): ReasoningTrace | null {
  const signal = row.signal;
  if (!signal || typeof signal !== "object") return null;
  const trace = (signal as Record<string, unknown>).reasoning_trace;
  return trace && typeof trace === "object" ? trace as ReasoningTrace : null;
}

function hasVerbatimQuote(row: Record<string, unknown>, trace: ReasoningTrace): boolean {
  const signal = row.signal && typeof row.signal === "object" ? row.signal as Record<string, unknown> : {};
  const userQuote = textOf(signal.user_quote).trim();
  if (userQuote.length >= 3) return true;
  const traceText = textOf(trace);
  return /[“”"'`][^“”"'`\n]{3,}[“”"'`]/.test(traceText) || /quote\s*[:=]\s*\S/i.test(traceText);
}

function hasAlternative(trace: ReasoningTrace): boolean {
  const traceText = textOf(trace).toLowerCase();
  const alternativeKeys = Object.keys(trace).some((key) => /alternative|other|case|reading|反例|替代/.test(key.toLowerCase()));
  if (alternativeKeys && /not-a-correction|task-local|debug|durable|alternative|other reading|another interpretation|反例|另一种|替代|可能不是/.test(traceText)) return true;
  return /alternative\s*[:=]|other reading\s*[:=]|another interpretation\s*[:=]|not-a-correction.+task-local|task-local.+not-a-correction|durable.+task-local.+debug|反例\s*[:：]|另一种/.test(traceText);
}

function hasConcreteSelfCritique(row: Record<string, unknown>, trace: ReasoningTrace): boolean {
  const signal = row.signal && typeof row.signal === "object" ? row.signal as Record<string, unknown> : {};
  const explicit = textOf(signal.most_likely_error).trim();
  const traceText = textOf(trace).trim();
  const combined = `${explicit}\n${traceText}`;
  const hasQuoteRef = /[“”\"'`][^“”\"'`\n]{8,}[“”\"'`]/.test(combined) || /step\s*[-_ ]?1|user_quote|quote|引用/.test(combined);
  const hasNamedAlternative = /not-a-correction|task-local|debug|durable|alternative|other reading|反例|替代|另一种/.test(combined.toLowerCase());
  const hasReason = /because|disconfirmer|context|line|因为|证据|反例|引用/.test(combined);
  if (!hasReason || (!hasQuoteRef && !hasNamedAlternative)) return false;
  if (/generic|boilerplate|not enough information/i.test(combined) && combined.length < 100) return false;
  return combined.length >= 60;
}

function rate(hits: number, total: number): number {
  return total > 0 ? hits / total : 0;
}

export function summarizeClassifierHealth(
  projectRoot: string,
  options?: { windowSize?: number; threshold?: number },
): ClassifierHealthSummary {
  const windowSize = Math.max(1, Math.floor(options?.windowSize ?? 50));
  const threshold = options?.threshold ?? 0.4;
  const classifierRows = readAuditRows(projectRoot)
    .filter((row) => row.operation === "correction_classifier")
    .slice(-windowSize);
  const classifierRowCount = classifierRows.length;

  let quoteHits = 0;
  let alternativeHits = 0;
  let critiqueHits = 0;
  let sampleSize = 0;

  for (const row of classifierRows) {
    const trace = getTrace(row);
    if (!trace) continue;
    sampleSize++;
    if (hasVerbatimQuote(row, trace)) quoteHits++;
    if (hasAlternative(trace)) alternativeHits++;
    if (hasConcreteSelfCritique(row, trace)) critiqueHits++;
  }

  const quoteRate = rate(quoteHits, sampleSize);
  const alternativeRate = rate(alternativeHits, sampleSize);
  const concreteSelfCritiqueRate = rate(critiqueHits, sampleSize);
  const advisories: string[] = [];
  if (sampleSize === 0) {
    if (classifierRowCount > 0) advisories.push(`No classifier reasoning traces found across ${classifierRowCount} recent classifier audit rows; classifier schema or parser may have drifted.`);
    else advisories.push("No classifier audit rows found; health check has no signal yet.");
  } else {
    if (quoteRate < threshold) advisories.push(`Classifier quote rate below threshold: ${quoteRate.toFixed(2)} < ${threshold.toFixed(2)}.`);
    if (alternativeRate < threshold) advisories.push(`Classifier alternative mention rate below threshold: ${alternativeRate.toFixed(2)} < ${threshold.toFixed(2)}.`);
    if (concreteSelfCritiqueRate < threshold) advisories.push(`Classifier concrete self-critique rate below threshold: ${concreteSelfCritiqueRate.toFixed(2)} < ${threshold.toFixed(2)}.`);
  }

  return {
    ok: advisories.length === 0,
    classifierRowCount,
    sampleSize,
    windowSize,
    quoteRate,
    alternativeRate,
    concreteSelfCritiqueRate,
    threshold,
    advisories,
  };
}
