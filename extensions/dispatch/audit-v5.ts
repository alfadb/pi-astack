import { auditChecksumHex } from "../_shared/audit-checksum";
import type { WorkerProviderRetryAuditFields } from "./worker-run-governor";

const HTTP_STATUS_FIELDS = ["httpStatus", "http_status", "statusCode", "status_code"] as const;
const NOT_TIME_UNIT = String.raw`(?!\s*(?:ms|sec|seconds?|min|minutes?|hours?|days?)\b)`;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function errorText(record: Record<string, unknown>, phase: "start" | "end"): string | undefined {
  const value = phase === "start" ? record.errorMessage : record.finalError;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function explicitHttpStatus(record: Record<string, unknown>): number | undefined {
  for (const field of HTTP_STATUS_FIELDS) {
    const value = record[field];
    if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) {
      return value;
    }
  }
  return undefined;
}

function httpStatusFromText(value: string | undefined): number | undefined {
  if (!value) return undefined;
  // A bare three-digit number is not HTTP evidence. Require an explicit
  // HTTP/status/code label so retry counts, delays, and model ids cannot be
  // misreported as response codes.
  const match = new RegExp(
    String.raw`\b(?:http(?:\/\d(?:\.\d)?)?(?:\s+(?:status|error))?|status(?:\s*code)?|statuscode|code)\s*[:=]?\s*([1-5]\d\d)\b` + NOT_TIME_UNIT,
    "i",
  ).exec(value);
  if (!match) return undefined;
  const status = Number(match[1]);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

export function classifyProviderRetryError(
  value: string | undefined,
  httpStatus?: number,
): WorkerProviderRetryAuditFields["error_classification"] {
  if (!value && httpStatus === undefined) return "none";
  const text = (value ?? "").toLowerCase();
  if (httpStatus === 401 || httpStatus === 403 || /unauthorized|forbidden|invalid api key|authentication failed|expired token|credentials/.test(text)) {
    return "auth";
  }
  if (httpStatus === 429 || /rate.?limit|quota.*exceed|too many requests/.test(text)) return "rate_limit";
  if (/context.?length|prompt too long|context window|max.?tokens|token.?limit|context_length_exceeded/.test(text)) {
    return "context_overflow";
  }
  if (/econnreset|etimedout|enotfound|eai_again|econnrefused|fetch failed|network error|socket hang up|tls.*handshake|upstream.*disconnect|stream.?read.?error|unexpected eof|connection lost/.test(text)) {
    return "network";
  }
  if ((httpStatus !== undefined && httpStatus >= 500) || /server error|overloaded|service unavailable|bad gateway|internal server/.test(text)) {
    return "server_error";
  }
  return "unknown";
}

/**
 * Privacy-safe additive projection of SDK auto_retry_* fields. Raw error text
 * is used only as a checksum input and is never returned to worker_run_event.
 */
export function providerRetryAuditFields(
  phase: "start" | "end",
  event: unknown,
): WorkerProviderRetryAuditFields {
  try {
    const record = asRecord(event);
    const rawError = errorText(record, phase);
    const httpStatus = explicitHttpStatus(record) ?? httpStatusFromText(rawError);
    const success = typeof record.success === "boolean" ? record.success : undefined;
    const retryOutcome: WorkerProviderRetryAuditFields["retry_outcome"] = phase === "start"
      ? "retrying"
      : success === true ? "recovered" : success === false ? "exhausted" : "unknown";
    const fingerprint = rawError
      ? auditChecksumHex("dispatch/provider-retry-error/v1", rawError)
      : undefined;
    return {
      retry_phase: phase,
      ...(typeof record.attempt === "number" && Number.isFinite(record.attempt)
        ? { retry_attempt: Math.max(0, Math.floor(record.attempt)) }
        : {}),
      ...(typeof record.maxAttempts === "number" && Number.isFinite(record.maxAttempts)
        ? { retry_max_attempts: Math.max(0, Math.floor(record.maxAttempts)) }
        : {}),
      ...(typeof record.delayMs === "number" && Number.isFinite(record.delayMs)
        ? { retry_delay_ms: Math.max(0, Math.floor(record.delayMs)) }
        : {}),
      retry_outcome: retryOutcome,
      error_classification: classifyProviderRetryError(rawError, httpStatus),
      ...(fingerprint ? { error_fingerprint: fingerprint } : {}),
      ...(httpStatus !== undefined ? { http_status: httpStatus } : {}),
    };
  } catch {
    return {
      retry_phase: phase,
      retry_outcome: phase === "start" ? "retrying" : "unknown",
      error_classification: "unknown",
    };
  }
}
