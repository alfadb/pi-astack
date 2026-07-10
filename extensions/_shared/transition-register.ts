import * as fs from "node:fs";
import * as path from "node:path";

export type TransitionRegisterClass = "active" | "gated";
export type TransitionRiskClass = "low" | "medium" | "high" | "critical";

export interface TransitionRegisterEntry {
  id: string;
  partition: string;
  title: string;
  human_section: string;
  register_class: TransitionRegisterClass;
  phase_status: string;
  authorization_status: string;
  entered: string;
  review_by: string;
  current: string;
  exit: readonly string[];
  evidence: readonly string[];
  owner: string;
  consumer: readonly string[];
  renewal_count: number;
  risk_class: TransitionRiskClass;
  next_action: string;
}

export interface TransitionRegister {
  schema_version: "transition-register/v1";
  register_id: string;
  updated: string;
  review_policy: {
    cadence: string;
    default_owner: string;
    markdown_mirror: "docs/transition-register.md";
  };
  transitions: readonly TransitionRegisterEntry[];
}

export interface TransitionRegisterSummary {
  registerId: string;
  updated: string;
  total: number;
  active: number;
  gated: number;
  canonicalPath: readonly {
    id: string;
    phaseStatus: string;
    authorizationStatus: string;
  }[];
}

export class TransitionRegisterError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "TransitionRegisterError";
    this.code = code;
    this.detail = detail ? deepFreeze(detail) : undefined;
  }
}

const HUMAN_SECTIONS = Object.freeze([
  "Canonical path 阶段门",
  "已就绪待决策",
  "滞留需推进",
  "健康 gated-defer",
]);
const PHASE_STATUSES = Object.freeze([
  "in_progress",
  "blocked",
  "ready_for_decision",
  "blocked_on_evidence",
  "dogfood",
  "blocked_on_implementation",
  "observe",
  "blocked_on_prerequisite",
  "blocked_on_definition",
  "gated_deferred",
]);
const AUTHORIZATION_STATUSES = Object.freeze([
  "authorized",
  "not_authorized",
  "separate_authorization_required",
  "blocked_on_prerequisite",
  "blocked_on_trigger",
  "not_applicable",
]);

export function defaultTransitionRegisterPath(): string {
  return path.resolve(__dirname, "..", "..", "docs", "transition-register.machine.json");
}

export function defaultTransitionRegisterMarkdownPath(): string {
  return path.resolve(__dirname, "..", "..", "docs", "transition-register.md");
}

export function loadTransitionRegister(registerPath = defaultTransitionRegisterPath()): TransitionRegister {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(registerPath, "utf-8"));
  } catch (err) {
    throw failure("TRANSITION_REGISTER_LOAD_FAILED", `cannot load ${registerPath}`, { error: errorMessage(err) });
  }
  return validateTransitionRegister(parsed);
}

export function loadAndValidateTransitionRegister(
  registerPath = defaultTransitionRegisterPath(),
  markdownPath = defaultTransitionRegisterMarkdownPath(),
): TransitionRegister {
  const register = loadTransitionRegister(registerPath);
  let markdown: string;
  try {
    markdown = fs.readFileSync(markdownPath, "utf-8");
  } catch (err) {
    throw failure("TRANSITION_MARKDOWN_LOAD_FAILED", `cannot load ${markdownPath}`, { error: errorMessage(err) });
  }
  validateTransitionRegisterMarkdown(register, markdown);
  return register;
}

export function validateTransitionRegister(input: unknown): TransitionRegister {
  const root = record(input, "register must be an object");
  exact(root.schema_version, "transition-register/v1", "schema_version");
  const registerId = stableId(root.register_id, "register_id");
  const updated = isoDate(root.updated, "updated");
  const reviewPolicy = record(root.review_policy, "review_policy must be an object");
  const cadence = nonEmptyString(reviewPolicy.cadence, "review_policy.cadence");
  const defaultOwner = nonEmptyString(reviewPolicy.default_owner, "review_policy.default_owner");
  exact(reviewPolicy.markdown_mirror, "docs/transition-register.md", "review_policy.markdown_mirror");
  if (!Array.isArray(root.transitions) || root.transitions.length === 0) {
    throw failure("TRANSITION_REGISTER_INVALID", "transitions must be a non-empty array");
  }

  const ids = new Set<string>();
  const titles = new Set<string>();
  const transitions = root.transitions.map((raw, index): TransitionRegisterEntry => {
    const at = `transitions[${index}]`;
    const item = record(raw, `${at} must be an object`);
    const id = stableId(item.id, `${at}.id`);
    if (ids.has(id)) throw failure("TRANSITION_REGISTER_DUPLICATE", `duplicate transition id ${id}`);
    ids.add(id);
    const title = nonEmptyString(item.title, `${at}.title`);
    if (titles.has(title)) throw failure("TRANSITION_REGISTER_DUPLICATE", `duplicate transition title ${title}`);
    titles.add(title);
    const humanSection = oneOf(item.human_section, HUMAN_SECTIONS, `${at}.human_section`);
    const registerClass = oneOf(item.register_class, ["active", "gated"] as const, `${at}.register_class`);
    const phaseStatus = oneOf(item.phase_status, PHASE_STATUSES, `${at}.phase_status`);
    const authorizationStatus = oneOf(item.authorization_status, AUTHORIZATION_STATUSES, `${at}.authorization_status`);
    const entered = isoDate(item.entered, `${at}.entered`);
    const reviewBy = isoDate(item.review_by, `${at}.review_by`);
    if (reviewBy < entered) throw failure("TRANSITION_REGISTER_INVALID", `${at}.review_by precedes entered`);
    const renewalCount = item.renewal_count;
    if (!Number.isSafeInteger(renewalCount) || (renewalCount as number) < 0) {
      throw failure("TRANSITION_REGISTER_INVALID", `${at}.renewal_count must be a non-negative safe integer`);
    }
    const entry: TransitionRegisterEntry = {
      id,
      partition: stableId(item.partition, `${at}.partition`),
      title,
      human_section: humanSection,
      register_class: registerClass,
      phase_status: phaseStatus,
      authorization_status: authorizationStatus,
      entered,
      review_by: reviewBy,
      current: nonEmptyString(item.current, `${at}.current`),
      exit: nonEmptyStringArray(item.exit, `${at}.exit`),
      evidence: nonEmptyStringArray(item.evidence, `${at}.evidence`),
      owner: nonEmptyString(item.owner, `${at}.owner`),
      consumer: nonEmptyStringArray(item.consumer, `${at}.consumer`),
      renewal_count: renewalCount as number,
      risk_class: oneOf(item.risk_class, ["low", "medium", "high", "critical"] as const, `${at}.risk_class`),
      next_action: nonEmptyString(item.next_action, `${at}.next_action`),
    };
    if (entry.register_class === "gated" && entry.phase_status !== "gated_deferred") {
      throw failure("TRANSITION_REGISTER_INVALID", `${at} gated entry must be gated_deferred`);
    }
    return entry;
  });

  validateCanonicalPathAuthorization(transitions);
  return deepFreeze({
    schema_version: "transition-register/v1" as const,
    register_id: registerId,
    updated,
    review_policy: {
      cadence,
      default_owner: defaultOwner,
      markdown_mirror: "docs/transition-register.md" as const,
    },
    transitions,
  });
}

export function renderTransitionRegisterMarkdownMirror(register: TransitionRegister): string {
  const rows = [...register.transitions]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((entry) => `| \`${entry.id}\` | ${escapeCell(entry.title)} | \`${entry.phase_status}\` | \`${entry.authorization_status}\` | ${entry.review_by} | \`${entry.risk_class}\` |`);
  return [
    "<!-- transition-register-machine-mirror:start -->",
    "## Machine source 镜像",
    "",
    "> 此区块由 `docs/transition-register.machine.json` 确定性生成；JSON 是 machine source of truth，Markdown 仅用于人类阅读。",
    "",
    "| Stable ID | 面 | Phase | Authorization | Review by | Risk |",
    "|---|---|---|---|---|---|",
    ...rows,
    "<!-- transition-register-machine-mirror:end -->",
  ].join("\n");
}

export function validateTransitionRegisterMarkdown(register: TransitionRegister, markdown: string): void {
  const expectedMirror = renderTransitionRegisterMarkdownMirror(register);
  const actualMirror = extractMirror(markdown);
  if (actualMirror !== expectedMirror) {
    throw failure("TRANSITION_MARKDOWN_DRIFT", "machine mirror does not match transition-register.machine.json");
  }

  const actualBySection = extractHumanSectionTitles(markdown);
  for (const section of HUMAN_SECTIONS) {
    const expected = register.transitions
      .filter((entry) => entry.human_section === section)
      .map((entry) => entry.title)
      .sort();
    const actual = [...(actualBySection.get(section) ?? [])].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw failure("TRANSITION_MARKDOWN_DRIFT", `human section ${section} does not map exactly to machine entries`, { expected, actual });
    }
  }
}

export function summarizeTransitionRegister(register: TransitionRegister): TransitionRegisterSummary {
  const canonicalPath = register.transitions
    .filter((entry) => entry.partition === "canonical_path")
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((entry) => ({ id: entry.id, phaseStatus: entry.phase_status, authorizationStatus: entry.authorization_status }));
  return deepFreeze({
    registerId: register.register_id,
    updated: register.updated,
    total: register.transitions.length,
    active: register.transitions.filter((entry) => entry.register_class === "active").length,
    gated: register.transitions.filter((entry) => entry.register_class === "gated").length,
    canonicalPath,
  });
}

function validateCanonicalPathAuthorization(entries: readonly TransitionRegisterEntry[]): void {
  const expected = new Map<string, [string, string]>([
    ["canonical_path.p1", ["in_progress", "authorized"]],
    ["canonical_path.p2", ["blocked", "not_authorized"]],
    ["canonical_path.p3", ["blocked", "not_authorized"]],
    ["canonical_path.p4a", ["blocked", "not_authorized"]],
    ["canonical_path.p4b", ["blocked", "not_authorized"]],
  ]);
  const canonical = entries.filter((entry) => entry.partition === "canonical_path");
  if (canonical.length !== expected.size) {
    throw failure("TRANSITION_CANONICAL_PHASE_INVALID", `canonical_path must contain exactly ${expected.size} phases`, { actual: canonical.map((entry) => entry.id) });
  }
  for (const [id, [phase, authorization]] of expected) {
    const entry = canonical.find((candidate) => candidate.id === id);
    if (!entry || entry.phase_status !== phase || entry.authorization_status !== authorization) {
      throw failure("TRANSITION_CANONICAL_PHASE_INVALID", `${id} must be ${phase}/${authorization}`, { actualPhase: entry?.phase_status, actualAuthorization: entry?.authorization_status });
    }
  }
}

function extractMirror(markdown: string): string {
  const startMarker = "<!-- transition-register-machine-mirror:start -->";
  const endMarker = "<!-- transition-register-machine-mirror:end -->";
  const start = markdown.indexOf(startMarker);
  const end = markdown.indexOf(endMarker);
  if (start < 0 || end < start || markdown.indexOf(startMarker, start + 1) >= 0 || markdown.indexOf(endMarker, end + 1) >= 0) {
    throw failure("TRANSITION_MARKDOWN_DRIFT", "Markdown must contain exactly one machine mirror block");
  }
  return markdown.slice(start, end + endMarker.length);
}

function extractHumanSectionTitles(markdown: string): Map<string, string[]> {
  const output = new Map<string, string[]>();
  let section: string | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      const heading = line.slice(3).trim();
      section = HUMAN_SECTIONS.includes(heading) ? heading : undefined;
      continue;
    }
    if (!section || !line.startsWith("|")) continue;
    const cells = line.slice(1, -1).split("|").map((cell) => cell.trim());
    const title = cells[0];
    if (!title || title === "面" || /^-+$/.test(title)) continue;
    const titles = output.get(section) ?? [];
    if (titles.includes(title)) throw failure("TRANSITION_MARKDOWN_DRIFT", `duplicate human row ${title} in ${section}`);
    titles.push(title);
    output.set(section, titles);
  }
  return output;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function failure(code: string, message: string, detail?: Record<string, unknown>): TransitionRegisterError {
  return new TransitionRegisterError(code, message, detail);
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("TRANSITION_REGISTER_INVALID", message);
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, at: string): string {
  if (typeof value !== "string" || !value.trim()) throw failure("TRANSITION_REGISTER_INVALID", `${at} must be a non-empty string`);
  return value;
}

function nonEmptyStringArray(value: unknown, at: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) throw failure("TRANSITION_REGISTER_INVALID", `${at} must be a non-empty string array`);
  const output = value.map((item, index) => nonEmptyString(item, `${at}[${index}]`));
  if (new Set(output).size !== output.length) throw failure("TRANSITION_REGISTER_DUPLICATE", `${at} contains duplicates`);
  return Object.freeze(output);
}

function stableId(value: unknown, at: string): string {
  const text = nonEmptyString(value, at);
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(text)) throw failure("TRANSITION_REGISTER_INVALID", `${at} is not a stable machine id`);
  return text;
}

function isoDate(value: unknown, at: string): string {
  const text = nonEmptyString(value, at);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00.000Z`))) {
    throw failure("TRANSITION_REGISTER_INVALID", `${at} must be an ISO calendar date`);
  }
  return text;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], at: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw failure("TRANSITION_REGISTER_INVALID", `${at} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function exact(value: unknown, expected: string, at: string): void {
  if (value !== expected) throw failure("TRANSITION_REGISTER_INVALID", `${at} must equal ${expected}`, { actual: value });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
