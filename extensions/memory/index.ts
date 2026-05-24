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
import { asBoolean, asNumber, resolveSettings } from "./settings";
import type { GetParams, ListFilters, NeighborsParams, SearchParams } from "./types";
import { loadEntries } from "./parser";
import { findEntry, listEntries, neighbors, serializeEntry } from "./search";
import { llmSearchEntries } from "./llm-search";
import { runMemoryDecide } from "./decide";
import { formatLintReport, lintTarget } from "./lint";
import { formatMigrationPlan, planMigrationDryRun, writeMigrationReport } from "./migrate";
import { formatMigrationGoSummary, runMigrationGo } from "./migrate-go";
import * as os from "node:os";
import { formatDoctorLiteReport, runDoctorLite } from "./doctor";
import { checkBacklinks, formatBacklinkReport, formatGraphRebuildReport, rebuildGraphIndex } from "./graph";
import { formatMarkdownIndexRebuildReport, rebuildMarkdownIndex } from "./index-file";
import { clamp, normalizeBareSlug, normalizeListFilters, normalizeSearchFilters, parseMaybeJson } from "./utils";
import { resolveActiveProject } from "../_shared/runtime";

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

      // Step 1: search for relevant memories
      let searchCards: Array<{ slug: unknown }>;
      try {
        const result = await llmSearchEntries(
          entries,
          { query: params.context, filters: { limit: 8, status: ["active"] } },
          settings,
          ctx.modelRegistry,
          signal,
          ctx.cwd,
        );
        searchCards = (result as any)?.ok === false ? [] : (result as Array<{ slug: unknown }> ?? []);
      } catch {
        searchCards = [];
      }

      // Step 2: load full entries from slugs
      const fullEntries = searchCards
        .map((card) => findEntry(entries, String((card as any).slug ?? "")).entry)
        .filter((entry): entry is NonNullable<typeof entry> => !!entry);

      const searchResults = fullEntries.map((entry) => ({
        slug: entry.slug,
        title: entry.title,
        kind: entry.kind,
        compiledTruth: entry.compiledTruth,
      }));

      // Step 3: synthesize decision brief
      const result = await runMemoryDecide({
        context: params.context,
        options: params.options,
        constraints: params.constraints,
        searchResults,
        settings,
        modelRegistry: ctx.modelRegistry,
        signal,
      });

      if (!result.ok) {
        return wrapToolResult({
          ok: false,
          error: result.error,
          entryCount: result.entryCount,
          hint: "memory_decide LLM call failed. Fall back to memory_search + manual synthesis.",
        });
      }

      return wrapToolResult({
        ok: true,
        brief: result.brief,
        entryCount: result.entryCount,
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
  pi.on("before_agent_start", async (event: { systemPrompt?: string }) => {
    const current = event.systemPrompt ?? "";
    if (current.includes(MEMORY_INJECT_MARKER)) return undefined;
    const block = `${MEMORY_INJECT_MARKER}
## memory-footnote：使用记忆条目的自我报告

当你在回复过程中调用了 \`memory_search\` / \`memory_get\` /
\`memory_decide\` 并实际使用了返回的记忆条目时，在回复最末尾
附加一个隐藏 fenced block：

\`\`\`memory-footnote
entry: <slug>
used: decisive | confirmatory | retrieved-unused
counterfactual: <如果这条记忆不在上下文里，你会做什么不同的决定？
  decisive=引用具体行为差异，confirmatory="相同决定"，
  retrieved-unused=解释为什么没用>
\`\`\`

- \`decisive\` = 这条记忆改变了你的行为（没有它你会做不同的事）
- \`confirmatory\` = 你本来就会做这个决定，记忆只是印证
- \`retrieved-unused\` = 你搜到了但没用，解释原因
- 默认偏向 \`confirmatory\`：能说清 counterfactual 才标 \`decisive\`
- 如果没实际使用任何记忆条目，不写 footnote

这是给第二大脑追踪条目使用情况的内部信号，正常回复给用户，
不用总结它。

## 决策点优先调 memory_decide

在遇到以下场景**之前**，先调一次 \`memory_decide(context=...)\`、
让第二大脑给你一份决策参考，再推进：

- 技术选型："用 X 还是 Y" / "这个项目用什么框架/语言/库"
- 架构决策：模块拆分、数据模型、接口设计、持久化选型
- 工作流选择：CI/CD、部署方式、测试策略、分支策略
- 工具选择：多个能达成同一目的的软件/脚手架中选一个
- 你即将调 \`prompt_user\` 让用户决定选项之前

**不需要**调的场景（避免浪费 token）：

- 执行类指令："帮我写个 README" / "跳过这个文件的 import" / 调试指定问题
- 纯信息查询："这个函数的 API 是什么" / "看一下这个文件"
- 任务中间的机械步骤：改一行代码、改一个变量名
- 你已经调过 \`memory_search\` 拿到足够原始证据，不需要额外综合

原则：**你即将为用户做一个反转成本不低的选择时，
不要假设你记得用户的偏好**。memory_decide 的席主席是让你
看到"用户过去 3 个月在同类决定上的取舍轨迹"，而不是仅仅服从
你本轮上下文里最容易想到的选项。你仍是决定者，decision brief
是一份参考意见，不是命令。
`;
    return { systemPrompt: current + "\n\n" + block };
  });
}
