/**
 * memory extension for pi-astack — read-only markdown memory Facade.
 *
 * Full implementation (2026-05-14): dual-stage LLM retrieval (ADR 0015),
 * project-level `.pensieve/` + world `~/.abrain/` read tools, strict binding
 * enforcement (ADR 0017), and `/memory migrate --go` one-shot migration.
 * Markdown + git remain the source of truth.
 *
 * LLM-facing tools (memory_search/get/list/neighbors) are strictly read-only.
 * `/memory rebuild --graph|--index` slash commands write derived indexes;
 * `/memory migrate --go` performs one-shot B4 migration. Neither path writes
 * canonical knowledge entries — that is sediment's exclusive role.
 */

import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isSubAgentSession } from "../_shared/pi-internals";
import { asBoolean, asNumber, resolveSettings } from "./settings";
import type { GetParams, ListFilters, NeighborsParams, SearchParams } from "./types";
import { loadEntries } from "./parser";
import { findEntry, listEntries, neighbors, serializeEntry } from "./search";
import { llmSearchEntries } from "./llm-search";
import { buildDecisionSearchQuery, runMemoryDecide } from "./decide";
import { PATH_A_INJECT_MARKER } from "./memory-context-injector";
import { readOutcomeLedger, summarizeEntryActivity } from "../sediment/outcome-collector";
import { formatLintReport, lintTarget } from "./lint";
import { formatMigrationPlan, planMigrationDryRun, writeMigrationReport } from "./migrate";
import { formatMigrationGoSummary, runMigrationGo } from "./migrate-go";
import * as os from "node:os";
import { formatDoctorLiteReport, runDoctorLite } from "./doctor";
import { checkBacklinks, formatBacklinkReport, formatGraphRebuildReport, rebuildGraphIndex } from "./graph";
import { formatMarkdownIndexRebuildReport, rebuildMarkdownIndex } from "./index-file";
import { clamp, normalizeBareSlug, normalizeListFilters, normalizeSearchFilters, parseMaybeJson } from "./utils";
import { resolveActiveProject } from "../_shared/runtime";

const MEMORY_FOOTNOTE_PROTOCOL_VERSION = "memory-footnote-v1";

// ─────────────────────────────────────────────────────────────────────────
// Tool result wrapper.
//
// pi-agent-core's tool execution loop (createToolResultMessage) reads
// `result.content` directly into `toolResult.message.content`. If a tool
// `execute()` returns a bare business object (array / plain object), then
// `message.content === undefined`, and on the next turn pi-ai's provider-side
// message conversion crashes:
//
//   openai-responses-shared.js:161  msg.content.filter(...)
//   anthropic.js:77                 content.some(...)   (via convertContentBlocks)
//
// Both fail with `Cannot read properties of undefined (reading 'filter'|'some')`,
// silently if the tool call is single-turn (the next turn is what blows up).
//
// Fix: every memory tool MUST return a ToolResult-shape: a content array of
// text/image blocks, with optional `isError`. We JSON-encode business payloads
// (search results / entry / neighbor list) into a single text block — the LLM
// sees structured JSON exactly as before, and the provider conversion is happy.
//
// Reference shape (matches how dispatch / imagine / vision return):
//   { content: [{ type: "text", text: "..." }], isError?: boolean }
// ─────────────────────────────────────────────────────────────────────────
function wrapToolResult(
  payload: unknown,
): { content: Array<{ type: "text"; text: string }>; details: unknown; isError?: boolean } {
  const isError =
    !!payload &&
    typeof payload === "object" &&
    "ok" in (payload as Record<string, unknown>) &&
    (payload as Record<string, unknown>).ok === false;

  let text: string;
  if (typeof payload === "string") {
    text = payload;
  } else {
    try {
      text = JSON.stringify(payload, null, 2);
    } catch {
      text = String(payload);
    }
  }

  // 2026-05-24 fix: pi SDK 0.75 ToolDefinition tightened AgentToolResult
  // shape: `details: T` is now required (was optional). Without this, the
  // ToolDefinition.execute return type no longer assigns. Runtime stayed
  // compatible because pi-agent-core treats missing details as undefined,
  // but the typecheck regression was masked by smoke tests. Pass payload
  // itself as details so UI/log consumers retain the structured object
  // alongside the text serialization.
  return {
    content: [{ type: "text" as const, text }],
    details: payload,
    ...(isError ? { isError: true } : {}),
  };
}

// 2026-05-24 fix: pi SDK 0.75 ToolDefinition.prepareArguments is typed
// (args: unknown) => Static<TParams>. Local closures previously declared
// (args: Record<string, unknown>) which is more restrictive (contravariant
// position) and so doesn't assign. This helper narrows safely and lets the
// tool registrations below keep their internal `args.foo` access style.
function asRecord(args: unknown): Record<string, unknown> {
  return (args && typeof args === "object") ? (args as Record<string, unknown>) : {};
}

function registerMemoryCommand(pi: ExtensionAPI) {
  const maybePi = pi as unknown as {
    registerCommand?: (name: string, options: {
      description?: string;
      getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
      handler: (args: string, ctx: { cwd?: string; ui: { notify(message: string, type?: string): void } }) => Promise<void> | void;
    }) => void;
  };
  if (typeof maybePi.registerCommand !== "function") return;

  maybePi.registerCommand("memory", {
    description: "Memory maintenance commands: /memory lint [path], /memory migrate [--dry-run|--go] [--report] [path], /memory check-backlinks [path], /memory rebuild --graph|--index [path], /memory doctor-lite [path]. B4.5: run /abrain bind first; --project is rejected.",
    getArgumentCompletions(prefix: string) {
      const items = [
        "lint", "lint .pensieve",
        "migrate", "migrate --dry-run", "migrate --dry-run --report",
        "migrate --go", "migrate --go .pensieve",
        "doctor-lite", "doctor-lite .pensieve",
        "check-backlinks", "check-backlinks .pensieve",
        "rebuild --graph", "rebuild --graph .pensieve",
        "rebuild --index", "rebuild --index .pensieve",
        "rebuild --graph --index", "rebuild --graph --index .pensieve",
      ];
      const filtered = items.filter((item) => item.startsWith(prefix));
      return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
    },
    async handler(args: string, ctx: { cwd?: string; ui: { notify(message: string, type?: string): void } }) {
      const cwd = path.resolve(ctx.cwd || process.cwd());
      const trimmed = args.trim();
      const [subcommand = "lint", ...rest] = trimmed ? trimmed.split(/\s+/) : [];
      const settings = resolveSettings();
      // Round 7 P1 (gpt-5.5 audit fix): outer try/catch barrier. Any
      // fs / parse / git / rebuild exception bubbling out of subcommand
      // handlers should be presented to the user as a typed notify
      // (subcommand + root cause), not leak as an unhandled rejection
      // to pi's main process.
      try {

      if (subcommand === "lint") {
        const targetArg = rest.join(" ").trim();
        const target = targetArg ? path.resolve(cwd, targetArg) : path.join(cwd, ".pensieve");
        const report = await lintTarget(target, settings);
        const message = formatLintReport(report, cwd);
        ctx.ui.notify(message, report.errorCount > 0 ? "error" : report.warningCount > 0 ? "warning" : "info");
        return;
      }

      if (subcommand === "migrate") {
        // Slash surface (per user preference): `/memory migrate` defaults to
        // dry-run; `--go` executes per-repo migration. Mutually exclusive.
        // No `--apply --yes` double-confirmation. Post-B5, the source
        // `.pensieve/` is just the legacy input snapshot: dirty/untracked
        // parent repos are allowed. Abrain target cleanliness remains the
        // hard safety precondition; rollback guidance is printed at the end
        // of the --go summary (NOT `HEAD~1` — abrain side has N+1 commits
        // when N workflow entries are routed; see docs/migration/
        // abrain-pensieve-migration.md §5).
        //
        // Flag scope (ADR 0017 / B4.5):
        //   --dry-run            : default. Supports --report.
        //   --go                 : execute. --report is ignored.
        //   --project=<id>       : rejected; identity is decided by /abrain bind.
        //   --dry-run + --go     : rejected (mutually exclusive).
        const dryRun = rest.includes("--dry-run") || rest.includes("-n");
        const goMode = rest.includes("--go");
        if (dryRun && goMode) {
          ctx.ui.notify("/memory migrate: cannot combine --dry-run and --go (default with no flag is dry-run).", "warning");
          return;
        }
        const writeReport = rest.includes("--report");
        const projectFlag = rest.find((part) => part.startsWith("--project="));
        if (projectFlag) {
          ctx.ui.notify("/memory migrate: --project is no longer supported. Run /abrain bind --project=<id> first, then /memory migrate.", "warning");
          return;
        }
        const targetParts = rest.filter((part) =>
          part !== "--dry-run" && part !== "-n" && part !== "--report" && part !== "--go",
        );
        const targetArg = targetParts.join(" ").trim();
        const explicitTarget = targetArg ? path.resolve(cwd, targetArg) : undefined;
        if (explicitTarget && path.basename(explicitTarget) !== ".pensieve") {
          ctx.ui.notify(`/memory migrate refused: target must be the project .pensieve directory; got ${explicitTarget}. Omit the path or pass <projectRoot>/.pensieve.`, "warning");
          return;
        }

        const abrainHome = process.env.ABRAIN_ROOT
          ? process.env.ABRAIN_ROOT.replace(/^~(?=$|\/)/, os.homedir())
          : path.join(os.homedir(), ".abrain");

        // ADR 0017 strictness: migration target identity is anchored on the
        // repo that owns the .pensieve target, not on the slash-command cwd.
        // This prevents `/memory migrate /other/repo/.pensieve` from using
        // the current repo's active binding and migrating another repo into
        // the wrong abrain project. With no explicit target, default to the
        // bound project root's `.pensieve`, so starting pi from a subdir works.
        const active = explicitTarget
          ? resolveActiveProject(path.dirname(explicitTarget), { abrainHome })
          : resolveActiveProject(cwd, { abrainHome });
        if (!active.activeProject) {
          ctx.ui.notify(
            `/memory migrate refused: project binding status=${active.reason}. Run ${active.reason === "manifest_missing" ? "/abrain bind --project=<id>" : "/abrain bind"} first.`,
            "warning",
          );
          return;
        }
        const target = explicitTarget ?? path.join(active.activeProject.projectRoot, ".pensieve");
        const expectedTarget = path.join(active.activeProject.projectRoot, ".pensieve");
        if (path.resolve(target) !== path.resolve(expectedTarget)) {
          ctx.ui.notify(
            `/memory migrate refused: target ${target} is not the bound project .pensieve (${expectedTarget}). Run the command from the target project or omit the path.`,
            "warning",
          );
          return;
        }
        const projectId = active.activeProject.projectId;

        if (goMode) {
          // Out-of-scope flag warnings (was previously silent — gpt-5.5
          // audit flagged): --report is dry-run-only; warn so users don't
          // assume migrate-in writes a report file.
          if (writeReport) {
            ctx.ui.notify("/memory migrate --go: --report is dry-run-only and was ignored (see `/memory migrate --dry-run --report`).", "warning");
          }
          const result = await runMigrationGo({
            pensieveTarget: target,
            abrainHome,
            projectId,
            cwd,
            settings,
          });
          const summary = formatMigrationGoSummary(result, cwd);
          const tone = !result.ok || result.failedCount > 0 ? "error" : result.movedCount + result.workflowCount > 0 ? "info" : "warning";
          ctx.ui.notify(summary, tone);
          return;
        }

        // Round 7 P0-C fixed dry-run drift by feeding projectId + abrainHome
        // through to the planner. ADR 0017/B4.5 tightens that: projectId must
        // come from strict active binding (/abrain bind), not from a migration
        // flag, so dry-run target_path values exactly match `--go` routing.
        const report = await planMigrationDryRun(target, settings, undefined, cwd, {
          abrainHome,
          projectId,
        });
        const messages = [formatMigrationPlan(report)];
        if (writeReport) {
          const written = await writeMigrationReport(target, report, cwd);
          messages.push(`Migration report written: ${written.report_path}`);
        }
        ctx.ui.notify(messages.join("\n\n"), report.migrateCount > 0 ? "warning" : "info");
        return;
      }

      if (subcommand === "doctor-lite") {
        const targetArg = rest.join(" ").trim();
        const target = targetArg ? path.resolve(cwd, targetArg) : path.join(cwd, ".pensieve");
        const report = await runDoctorLite(target, settings, undefined, cwd);
        ctx.ui.notify(formatDoctorLiteReport(report), report.status === "error" ? "error" : report.status === "warning" ? "warning" : "info");
        return;
      }

      if (subcommand === "check-backlinks") {
        const targetArg = rest.join(" ").trim();
        const target = targetArg ? path.resolve(cwd, targetArg) : path.join(cwd, ".pensieve");
        const report = await checkBacklinks(target, settings, undefined, cwd);
        const severity = report.deadLinkCount > 0 ? "error" : report.missingSymmetricCount > 0 ? "warning" : "info";
        ctx.ui.notify(formatBacklinkReport(report), severity);
        return;
      }

      if (subcommand === "rebuild") {
        const graphFlag = rest.includes("--graph");
        const indexFlag = rest.includes("--index");
        if (!graphFlag && !indexFlag) {
          ctx.ui.notify("Usage: /memory rebuild --graph|--index [path]", "warning");
          return;
        }
        const targetParts = rest.filter((part) => part !== "--graph" && part !== "--index");
        const targetArg = targetParts.join(" ").trim();
        const target = targetArg ? path.resolve(cwd, targetArg) : path.join(cwd, ".pensieve");
        const messages: string[] = [];
        let severity: "info" | "warning" = "info";
        if (graphFlag) {
          const report = await rebuildGraphIndex(target, settings, undefined, cwd);
          messages.push(formatGraphRebuildReport(report));
          if (report.deadLinkCount > 0) severity = "warning";
        }
        if (indexFlag) {
          const report = await rebuildMarkdownIndex(target, settings, undefined, cwd);
          messages.push(formatMarkdownIndexRebuildReport(report));
        }
        ctx.ui.notify(messages.join("\n\n"), severity);
        return;
      }

      ctx.ui.notify("Usage: /memory lint [path] OR /memory migrate [--dry-run|--go] [--report] [path] OR /memory doctor-lite [path] OR /memory check-backlinks [path] OR /memory rebuild --graph|--index [path]. Run /abrain bind --project=<id> before migrate.", "warning");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`/memory ${subcommand} failed: ${message}`, "error");
      }
    },
  });
}

export default function (pi: ExtensionAPI) {
  // ── Sub-pi enforce ──────────────────────────────────────────
  // ADR 0014 §6 defense-in-depth: sub-pi should not register
  // memory_search/get/list/neighbors (though dispatch's --tools
  // allowlist also blocks them).
  if (process.env.PI_ABRAIN_DISABLED === "1") return;

  registerMemoryCommand(pi);

  pi.registerTool({
    name: "memory_search",
    label: "Search Memory",
    description:
      "Search markdown memory using a natural-language retrieval prompt via the unified read-only Facade. " +
      "Internally uses ADR 0015 two-stage LLM rerank by default (stage 1 candidate selection from memory index, stage 2 full-content rerank) " +
      "so Chinese-English mixed queries, semantic paraphrases, trigger phrases, and timeline-aware relevance work. " +
      "Searches project memory (~/.abrain/projects/<id>/ post-B5 cutover, " +
      "falling back to legacy .pensieve/ when not yet migrated) and, when configured/present, ~/.abrain/knowledge/. " +
      "Returns normalized cards without scope/backend/source_path so the LLM does not choose a backend.",
    promptSnippet: "memory_search(query: natural-language retrieval prompt, filters?: { kinds?, status?, limit? })",
    promptGuidelines: [
      "Use memory_search before planning, designing, reviewing code, or making project-specific decisions.",
      "Write query as a natural-language retrieval prompt that states the full intent, not just terse keywords.",
      "Mixed-language retrieval prompts work: e.g. '找关于知识沉淀 extractor prompt 的 durable rule' can match both Chinese and English entries.",
      "Do not ask for a project/world/backend selector; the Facade merges and ranks results internally.",
      "Search results are summaries. Call memory_get(slug) when you need the full compiled truth or timeline.",
      "Default results exclude archived entries; pass filters.status if the user explicitly asks for archived/deprecated history.",
      "LLM search hard-errors if its configured model is unavailable; there is no grep degradation path because accuracy is the contract.",
      "Valid kinds: maxim, decision, anti-pattern, pattern, fact, preference, smell. Valid statuses: active, archived, superseded, deprecated, provisional, contested.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Natural-language retrieval prompt. State the full retrieval intent, including Chinese/English mixed terms, semantic context, and what kind of memory would be useful; ADR 0015 LLM retrieval interprets paraphrases and translates intent across languages." }),
      filters: Type.Optional(Type.Any({
        description: "Optional filters: { kinds?: string[], status?: string|string[], limit?: number }",
      })),
    }),
    prepareArguments(rawArgs: unknown) {
      const args = asRecord(rawArgs);
      return {
        query: String(args.query ?? ""),
        filters: normalizeSearchFilters(args.filters ?? args),
      };
    },
    async execute(_id: string, params: SearchParams, signal: AbortSignal, _onUpdate: unknown, ctx: { cwd?: string; modelRegistry?: unknown }) {
      const settings = resolveSettings();
      const entries = await loadEntries(ctx.cwd, settings, signal);
      try {
        return wrapToolResult(await llmSearchEntries(entries, params, settings, ctx.modelRegistry, signal, ctx.cwd));
      } catch (err: unknown) {
        return wrapToolResult({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          hint: "memory_search uses ADR 0015 LLM retrieval and does not degrade to grep. Fix model/auth/network/configuration and retry.",
        });
      }
    },
  });

  pi.registerTool({
    name: "memory_get",
    label: "Get Memory Entry",
    description:
      "Read one markdown memory entry by bare slug. Returns the full canonical entry " +
      "including scope and source_path because this is an exact lookup/debug view, not a ranking surface.",
    promptSnippet: "memory_get(slug, options?: { include_related?: boolean })",
    promptGuidelines: [
      "Call memory_get after memory_search when a result looks relevant and you need details.",
      "Slug is bare (e.g. avoid-long-argv-prompts), not project:/world:-prefixed.",
      "Set include_related=true when nearby decisions/patterns could affect interpretation.",
    ],
    parameters: Type.Object({
      slug: Type.String({ description: "Bare slug to read" }),
      options: Type.Optional(Type.Any({
        description: "Optional: { include_related?: boolean }",
      })),
    }),
    prepareArguments(rawArgs: unknown) {
      const args = asRecord(rawArgs);
      const options = (parseMaybeJson(args.options) as Record<string, unknown>) ?? {};
      const includeRelated = asBoolean(
        options.include_related ?? options.includeRelated ?? args.include_related ?? args.includeRelated,
        false,
      );
      return {
        slug: String(args.slug ?? args.id ?? ""),
        options: { include_related: includeRelated },
      };
    },
    async execute(_id: string, params: GetParams, signal: AbortSignal, _onUpdate: unknown, ctx: { cwd?: string }) {
      const settings = resolveSettings();
      const entries = await loadEntries(ctx.cwd, settings, signal);
      const { entry, alternatives } = findEntry(entries, params.slug);
      if (!entry) {
        return wrapToolResult({
          ok: false,
          error: `memory entry not found: ${params.slug}`,
          slug: normalizeBareSlug(params.slug),
        });
      }
      return wrapToolResult(
        serializeEntry(entry, entries, !!params.options?.include_related, alternatives),
      );
    },
  });

  pi.registerTool({
    name: "memory_list",
    label: "List Memory Entries",
    description:
      "List markdown memory metadata with pagination. Mostly for browsing/debugging; " +
      "use memory_search for relevance-ranked retrieval.",
    promptSnippet: "memory_list(filters?: { kinds?, status?, limit?, cursor? })",
    promptGuidelines: [
      "Use memory_list when you need an overview of available memory entries or to browse by kind/status.",
      "Use memory_search for task-specific retrieval; list is not relevance-ranked.",
    ],
    parameters: Type.Object({
      filters: Type.Optional(Type.Any({
        description: "Optional filters: { kinds?: string[], status?: string|string[], limit?: number, cursor?: string }",
      })),
    }),
    prepareArguments(rawArgs: unknown) {
      const args = asRecord(rawArgs);
      return { filters: normalizeListFilters(args.filters ?? args) };
    },
    async execute(_id: string, params: { filters?: ListFilters }, signal: AbortSignal, _onUpdate: unknown, ctx: { cwd?: string }) {
      const settings = resolveSettings();
      const entries = await loadEntries(ctx.cwd, settings, signal);
      return wrapToolResult(listEntries(entries, params.filters ?? {}, settings));
    },
  });

  pi.registerTool({
    name: "memory_neighbors",
    label: "Memory Neighbors",
    description:
      "Read-only graph traversal over frontmatter relations and body [[wikilinks]]. " +
      "Does not create or repair links.",
    promptSnippet: "memory_neighbors(slug, options?: { hop?: number, max?: number })",
    promptGuidelines: [
      "Use memory_neighbors to inspect related decisions/patterns after memory_get, especially when conflict or provenance matters.",
      "This is read-only graph traversal. Do not use it to declare relationships; only sediment may write relations.",
    ],
    parameters: Type.Object({
      slug: Type.String({ description: "Bare slug to traverse from" }),
      options: Type.Optional(Type.Any({
        description: "Optional: { hop?: number, max?: number }",
      })),
    }),
    prepareArguments(rawArgs: unknown) {
      const args = asRecord(rawArgs);
      const options = (parseMaybeJson(args.options) as Record<string, unknown>) ?? {};
      return {
        slug: String(args.slug ?? args.id ?? ""),
        options: {
          hop: clamp(Math.floor(asNumber(options.hop ?? args.hop, 1)), 1, 3),
          max: clamp(Math.floor(asNumber(options.max ?? args.max, 20)), 1, 100),
        },
      };
    },
    async execute(_id: string, params: NeighborsParams, signal: AbortSignal, _onUpdate: unknown, ctx: { cwd?: string }) {
      const settings = resolveSettings();
      const entries = await loadEntries(ctx.cwd, settings, signal);
      const target = findEntry(entries, params.slug).entry;
      if (!target) {
        return wrapToolResult({
          ok: false,
          error: `memory entry not found: ${params.slug}`,
          slug: normalizeBareSlug(params.slug),
          neighbors: [],
        });
      }
      return wrapToolResult({
        slug: target.slug,
        neighbors: neighbors(
          entries,
          target.slug,
          params.options?.hop ?? 1,
          params.options?.max ?? 20,
        ),
      });
    },
  });

  // memory_decide — second-brain decision participation (ADR 0026 P0a)
  pi.registerTool({
    name: "memory_decide",
    label: "Decide with Memory",
    description:
      "Ask the second brain to synthesize relevant memories into a decision brief. " +
      "Unlike memory_search (which returns raw entries), memory_decide reads the user's " +
      "documented preferences and past experiences, then produces a concise recommendation " +
      "tailored to the current decision context. " +
      "Use when the LLM is at a decision point (tech choice, architecture, workflow, tool selection) " +
      "and wants the brain's active interpretation, not just raw recall.",
    promptSnippet: "memory_decide(context: string, options?: string[], constraints?: string)",
    promptGuidelines: [
      "Use memory_decide when you face a decision and want the brain's synthesis — not just raw entries.",
      "context describes what you are deciding (e.g. 'choosing a package manager for a new React project').",
      "options lists the choices on the table (e.g. ['pnpm', 'yarn', 'npm']). Omit if the decision is open-ended.",
      "constraints describe limitations (e.g. 'must work with monorepo, team uses yarn'). Omit if none.",
      "memory_decide internally searches memories AND synthesizes them — it replaces memory_search + manual synthesis.",
      "The brief is ≤500 tokens. Read it as expert advice, not as a command.",
    ],
    parameters: Type.Object({
      context: Type.String({ description: "What decision you are making. Be specific: 'choosing between pnpm and yarn for a new Next.js project' not 'package manager'." }),
      options: Type.Optional(Type.Array(Type.String(), { description: "Choices on the table, e.g. ['pnpm', 'yarn']. Omit for open-ended decisions." })),
      constraints: Type.Optional(Type.String({ description: "Constraints or requirements, e.g. 'must work with monorepo, team standardized on yarn'." })),
    }),
    prepareArguments(rawArgs: unknown) {
      const args = asRecord(rawArgs);
      return {
        context: String(args.context ?? ""),
        options: Array.isArray(args.options) ? args.options.map(String) : [],
        constraints: typeof args.constraints === "string" ? args.constraints : "",
      };
    },
    async execute(
      _id: string,
      params: { context: string; options: string[]; constraints: string },
      signal: AbortSignal,
      _onUpdate: unknown,
      ctx: { cwd?: string; modelRegistry?: unknown },
    ) {
      const settings = resolveSettings();
      const entries = await loadEntries(ctx.cwd, settings, signal);

      // Step 1: search for relevant memories. Include options and constraints
      // in the retrieval query; the bare context often omits key recall terms
      // (library names, deployment targets, hard requirements) that decide
      // whether a memory is relevant.
      const decisionSearchQuery = buildDecisionSearchQuery({
        context: params.context,
        options: params.options,
        constraints: params.constraints,
      });
      let searchCards: Array<{ slug: unknown }>;
      try {
        const result = await llmSearchEntries(
          entries,
          { query: decisionSearchQuery, filters: { limit: 8, status: ["active"] } },
          settings,
          ctx.modelRegistry,
          signal,
          ctx.cwd,
        );
        if ((result as any)?.ok === false) {
          const message = String((result as any).error ?? "memory_decide retrieval failed");
          return wrapToolResult({
            ok: false,
            error: message,
            entryCount: 0,
            _meta: { entrySlugs: [], decisionBriefId: result && typeof (result as any).decisionBriefId === "string" ? (result as any).decisionBriefId : undefined },
            hint: "memory_decide retrieval failed. Do not infer absence of relevant memories; fall back to memory_search only after fixing retrieval availability.",
          });
        }
        searchCards = result as Array<{ slug: unknown }> ?? [];
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return wrapToolResult({
          ok: false,
          error: message || "memory_decide retrieval failed",
          entryCount: 0,
          _meta: { entrySlugs: [], decisionBriefId: undefined },
          hint: "memory_decide retrieval failed. Do not infer absence of relevant memories; fall back to memory_search only after fixing retrieval availability.",
        });
      }

      // Step 2: load full entries from slugs
      const fullEntries = searchCards
        .map((card) => findEntry(entries, String((card as any).slug ?? "")).entry)
        .filter((entry): entry is NonNullable<typeof entry> => !!entry);

      const searchResults = fullEntries.map((entry) => ({
        slug: entry.slug,
        title: entry.title,
        kind: entry.kind,
        status: entry.status,
        confidence: entry.confidence,
        created: entry.created,
        updated: entry.updated,
        compiledTruth: entry.compiledTruth,
        timeline: entry.timeline,
        frontmatter: entry.frontmatter,
      }));

      // Step 2.5 (ADR 0026 §3.4 P1.A): outcome activity summary.
      //
      // Read the user-global outcome-ledger.jsonl, summarize the last 30
      // days of decisive / confirmatory / retrieved-unused counts per slug,
      // and hand the RAW counts to the decision brief so the LLM can
      // weight its recommendation.
      //
      // Best-effort: any ledger read failure returns []. We then call
      // summarizeEntryActivity() anyway, which yields a zeroed record per
      // slug — the prompt is built to handle "all-zero" gracefully
      // (renderActivitySection prints a clarifying sentence).
      //
      // Per ADR 0024 §3 AI-Native + the three-state marking: read+count
      // is Infra (mechanical, allowed); weighting is left to the LLM
      // prompt (no `if decisive_count < 3 then drop` threshold here).
      let activity: ReturnType<typeof summarizeEntryActivity> = [];
      try {
        const ledger = readOutcomeLedger();
        activity = summarizeEntryActivity(
          ledger,
          searchResults.map((r) => r.slug),
          30,
        );
      } catch {
        // best-effort — decide.ts handles undefined activity cleanly.
      }

      // Step 3: synthesize decision brief
      const result = await runMemoryDecide({
        context: params.context,
        options: params.options,
        constraints: params.constraints,
        searchResults,
        activity,
        activityWindowDays: 30,
        settings,
        modelRegistry: ctx.modelRegistry,
        signal,
      });

      if (!result.ok) {
        return wrapToolResult({
          ok: false,
          error: result.error,
          entryCount: result.entryCount,
          _meta: {
            // LLM-visible bookkeeping (wrapToolResult serializes payload to text),
            // not a hidden side channel. Keep it minimal.
            entrySlugs: result.entrySlugs ?? searchResults.map((r) => r.slug),
            decisionBriefId: result.decisionBriefId,
            // R3 GPT-5.5: surface anchorMissing so downstream consumers
            // (and the LLM reading the tool result) can detect that the
            // ADR 0026 §5.1 anchored decision_brief_id schema is unmet
            // for this call (e.g., lifecycle not bound, or memory_decide
            // invoked before before_agent_start). Only emit when true.
            ...(result.anchorMissing ? { anchorMissing: true } : {}),
          },
          hint: "memory_decide LLM call failed. Fall back to memory_search + manual synthesis.",
        });
      }

      return wrapToolResult({
        ok: true,
        brief: result.brief,
        entryCount: result.entryCount,
        _meta: {
          // LLM-visible bookkeeping (wrapToolResult serializes payload to text),
          // not a hidden side channel. Keep it minimal.
          entrySlugs: result.entrySlugs ?? searchResults.map((r) => r.slug),
          decisionBriefId: result.decisionBriefId,
          // R3 GPT-5.5: see above — surface anchorMissing only when true.
          ...(result.anchorMissing ? { anchorMissing: true } : {}),
        },
        hint: "This is a synthesized decision brief based on the user's documented history. The LLM should treat it as expert advice, not as a binding command.",
      });
    },
  });

  // ── System-prompt injection: memory-footnote self-report protocol ──
  //
  // Why this lives in the memory extension (not the user's AGENTS.md):
  //
  // The footnote protocol is a cross-tool convention spanning the
  // memory_search / memory_get / memory_decide trio — it has no meaning
  // when those tools aren't loaded, and its taxonomy (decisive /
  // confirmatory / retrieved-unused) is tied to the outcome-collector
  // schema in extensions/sediment/outcome-collector.ts. Pinning the
  // contract in user-global AGENTS.md drifts when:
  //   (a) the tool surface changes (e.g. memory_decide was added by ADR
  //       0026 P0a, the listed tools needed manual updating in AGENTS.md),
  //   (b) users disable the memory extension yet still see the rule,
  //   (c) sub-pi forks where PI_ABRAIN_DISABLED=1 short-circuited the
  //       module never see the protocol, which is correct — but
  //       AGENTS.md would still tell them to follow it.
  //
  // Hosting it here couples the protocol to its enforcement code: when
  // outcome-collector's footnote-parsing schema evolves, this string
  // moves in the same commit. Pattern mirrors model-curator's
  // before_agent_start injector (extensions/model-curator/index.ts:350)
  // and sediment's main-session-read-only injector.
  const MEMORY_INJECT_MARKER = "<!-- pi-astack/memory: memory-footnote protocol -->";
  const MEMORY_INJECT_MARKER_SUBAGENT = "<!-- pi-astack/memory: memory tools (sub-agent variant) -->";

  // ADR 0027 PR-B+ R1 P1-2 (Route A' synthesis):
  //
  // T0 vote (Opus / GPT-5.5 / DeepSeek): split B/C/A. Consensus across all
  // three: current state (prompt mentions memory_decide but default tool
  // allowlist lacks it) is *actively misleading* the LLM and must be fixed.
  //
  // Route A' = pure A (open memory tools to sub-agent by default) MINUS
  // the footnote attribution block in sub-agent context, because:
  //   - P0-α (a11f3be) MASKS sub-agent toolResult content from sediment
  //     extraction → the memory-footnote attribution sink is closed for
  //     sub-agents. Asking sub-agent to write footnote blocks is asking
  //     it to spend tokens generating signal into /dev/null.
  //   - Opus's investment in attribution sink reality (vote B) is honored
  //     by stripping the footnote section in sub-agent context.
  //   - DeepSeek's PR-B alignment argument (vote A: sub-agent should be
  //     able to read brain per ADR 0027 C1' L1→L2 symbiosis) is honored
  //     by keeping memory tools available + memory_decide guidance.
  //   - GPT-5.5's "prompt must reflect effective tool surface" invariant
  //     (vote C) is honored partially: sub-agent's prompt now only carries
  //     the consumption guidance (read + decide), not the
  //     attribution-self-report block whose sink doesn't exist for them.
  //
  // See docs/audits/2026-05-27-adr-0024-0027-implementation-r1.md §P1-2
  // for the three full reviewer texts.
  pi.on("before_agent_start", async (event: { systemPrompt?: string }, ctx?: unknown) => {
    const current = event.systemPrompt ?? "";
    // Idempotency: skip if either marker already present (main OR sub-agent
    // variant). Prevents double-injection on lifecycle re-fire.
    if (current.includes(MEMORY_INJECT_MARKER) || current.includes(MEMORY_INJECT_MARKER_SUBAGENT)) {
      return undefined;
    }

    const isSubAgent = isSubAgentSession(ctx as { sessionManager?: unknown } | undefined | null);

    if (isSubAgent) {
      // Sub-agent variant: omit footnote attribution block (sink closed by
      // P0-α). Keep memory_decide / memory_search consumption guidance so
      // sub-agent knows when (and when NOT) to pull from brain.
      const subBlock = `${MEMORY_INJECT_MARKER_SUBAGENT}
<!-- protocol_version: ${MEMORY_FOOTNOTE_PROTOCOL_VERSION}-subagent -->
## memory 工具：sub-agent 使用说明

你现在是一个 sub-agent worker（由 dispatch_agent / dispatch_parallel 产生）。
你可以用 \`memory_search\` / \`memory_get\` / \`memory_neighbors\` /
\`memory_decide\` 拉取用户的长期记忆、偏好、架构决策、已知坑点。

什么时候调：
- 你的任务需要考虑用户的已有偏好（代码审查/选型/架构评价）时
  → 先 \`memory_search\` 查相关偏好
- 任务中遇到**反转成本不低**的决策点（技术/架构/工作流选择）
  → \`memory_decide(context=...)\` 拉决策简报
- 需要某个 entry 的完整内容（而不仅是 search snippet）→ \`memory_get\`

什么时候不需要：
- 执行类指令（读某个文件、grep某个模式）
- 纯信息查询（这个 API 怎么用）
- 机械小改动
- 调试指定问题

原则：
- 不要为了形式而调 memory_*。你是被 dispatch 出来做一件具体事的。
- \`memory_search\` 返回的 entry 是**参考资料**，不是 ground truth。
  遇到与你看到的实际代码/状态冲突时，优先相信现场证据。
- brief 是专家建议，不是命令。

注：sub-agent 的回复会作为工具返回值回流父会话，但**不会被
第二大脑作为用户信号学习**（P0-α sediment mask）。所以你**不需要**
在回复末尾写 memory-footnote block — 没人消费那个信号。你只
需要为你的 caller（父会话）交付任务结果。
`;
      return { systemPrompt: current + "\n\n" + subBlock };
    }

    // Main session: full protocol (read + decide + footnote attribution).
    const block = `${MEMORY_INJECT_MARKER}
<!-- protocol_version: ${MEMORY_FOOTNOTE_PROTOCOL_VERSION} -->
## memory-footnote：使用记忆条目的自我报告

当你在回复过程中调用了 \`memory_search\` / \`memory_get\` /
\`memory_decide\` 并获得了记忆条目时，在回复最末尾为每条你实际
纳入判断的条目附加一个 \`memory-footnote\` fenced block：用过就标
\`decisive\` / \`confirmatory\`，检索到了但最终没用就标
\`retrieved-unused\` 并解释原因。它允许用户感知第二大脑参与了判断，
同时给 sediment outcome-ledger 提供归因信号：

\`\`\`memory-footnote
entry: <slug>
used: decisive | confirmatory | retrieved-unused
decision_brief_id: <如果来自 memory_decide 返回的 decisionBriefId，可选填>
counterfactual: <如果这条记忆不在上下文里，你会做什么不同的决定？
  decisive=引用具体行为差异，confirmatory="相同决定"，
  retrieved-unused=解释为什么没用>
\`\`\`

- \`decisive\` = 这条记忆改变了你的行为（没有它你会做不同的事）
- \`confirmatory\` = 你本来就会做这个决定，记忆只是印证
- \`retrieved-unused\` = 你搜到了但没用，解释原因
- 默认偏向 \`confirmatory\`：能说清 counterfactual 才标 \`decisive\`
- 如果某条已检索记忆进入了你的判断范围但没有被采用，写 \`retrieved-unused\`，不要静默省略
- 只有当本轮没有任何记忆条目进入判断范围时，才不写 footnote

这是给第二大脑追踪条目使用情况的内部信号，正常回复给用户，
不用总结它。

## memory_decide：高价值决策时可拉取第二大脑建议

当你已经处在一个**反转成本不低**的决策点，且用户的历史偏好、
过去踩坑或长期工作流可能改变判断时，可以调用
\`memory_decide(context=...)\` 取得一份决策参考。

典型适用：技术/框架/工具/架构/工作流选择，或即将让用户做会影响
后续实现路径的选择。把它视为 Path B：由你判断需要时主动拉取，
不是每个疑似决策点都必须调用，也不是自动打断流程。

通常不需要调用：执行类指令、纯信息查询、机械小改动、调试指定问题，
或你已经调过 \`memory_search\` 并取得足够原始证据。

原则：不要假设你记得用户的偏好；但也不要为了形式而调用。
brief 是专家建议，不是命令。
`;
    return { systemPrompt: current + "\n\n" + block };
  });
}
