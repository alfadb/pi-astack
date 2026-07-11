/**
 * model-curator extension for pi-astack — whitelist pi models and inject
 * capability hints into the main session system prompt.
 *
 * Ported from pi-model-curator (archived 2026-05-07), adapted to use
 * pi.registerProvider() (ExtensionAPI-level) instead of the lower-level
 * ModelRegistry.registerProvider().
 *
 * Two responsibilities:
 *
 * 1. **Whitelist registry**: pi-ai ships hundreds of model definitions.
 *    We filter to a curated keep-list per provider and re-register them
 *    via pi.registerProvider(), which replaces the provider's model set
 *    entirely. Credentials are resolved from the EXISTING provider config
 *    via modelRegistry.getApiKeyAndHeaders() — no models.json reading,
 *    no hardcoded env var names.
 *
 * 2. **Capability advertisement**: before every main-session turn,
 *    before_agent_start injects a markdown table into the system prompt.
 *
 * Override via modelCurator in pi-astack-settings.json (top-level key; providers, hints).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { FOOTER_STATUS_KEYS } from "../_shared/footer-status";
import { isSubAgentBoundaryUntrusted, getSubAgentBoundaryUntrustedDiagnostic, isSubAgentSession } from "../_shared/pi-internals";

// ── pi-astack settings loader ──────────────────────────────
// pi-astack uses its own settings file (not pi's settings.json) to keep our
// config isolated from pi's official schema. ExtensionContext does not inject
// settings to extensions, so we read the file directly. Missing/malformed
// file falls back to DEFAULTS — the extension always works out of the box.

const PI_STACK_SETTINGS_PATH = path.join(
  os.homedir(), ".pi", "agent", "pi-astack-settings.json",
);

function loadPiStackSettings(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(PI_STACK_SETTINGS_PATH, "utf-8"));
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`pi-astack: failed to parse ${PI_STACK_SETTINGS_PATH}: ${message}. Using defaults.`);
    return {};
  }
}

// ── Default keep-list + capability hints ────────────────────────

export interface TierRoster {
  label: string;
  description?: string;
  models: readonly string[];
}

interface CuratorDefaults {
  providers: Record<string, readonly string[]>;
  hints: Record<string, string>;
  imageGen: Record<string, string>;
  tiers: Record<string, TierRoster>;
}

// Plan A (3-T0 consensus 2026-06-10): model strategy data (providers / hints /
// imageGen / tiers) is single-sourced in pi-astack-settings.json — NOT
// duplicated here. This constant previously held a ~68-line byte-for-byte
// mirror of settings.json, forcing every model/hint change to be applied in
// two places and kept identical (a recurring sync-gap hazard — e.g.
// github-copilot once silently missing from DEFAULTS). It is now intentionally
// empty: resolveConfig() returns these empties only when the corresponding
// settings key is missing, in which case the curator fails closed (tiers are
// REQUIRED and loadConfig() throws if absent).
// To configure models/hints/tiers, edit pi-astack-settings.json (schema:
// pi-astack-settings.schema.json). The pi-global repo always ships that file.
const DEFAULTS: CuratorDefaults = {
  providers: {},
  hints: {},
  imageGen: {},
  tiers: {},
};

// ── Config resolution ───────────────────────────────────────────

function resolveConfig(): CuratorDefaults {
  const settings = loadPiStackSettings();
  const cfg = (settings.modelCurator as Record<string, unknown>) ?? {};
  return {
    providers: (cfg.providers as CuratorDefaults["providers"]) ?? DEFAULTS.providers,
    hints: (cfg.hints as CuratorDefaults["hints"]) ?? DEFAULTS.hints,
    imageGen: (cfg.imageGen as CuratorDefaults["imageGen"]) ?? DEFAULTS.imageGen,
    tiers: (cfg.tiers as CuratorDefaults["tiers"]) ?? DEFAULTS.tiers,
  };
}

class CuratorConfigError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "CuratorConfigError";
  }
}

/**
 * Tiers are REQUIRED. The tier roster is the single source of truth for
 * model capability ranking injected into the system prompt. If `tiers` is
 * missing, empty, or contains an empty model list, the curator must not
 * silently fall back — it throws so the operator fixes the config before
 * the next turn ships a misleading prompt.
 */
function loadTiersOrThrow(): Record<string, TierRoster> {
  const cfg = resolveConfig();
  const tiers = cfg.tiers;
  if (!tiers || typeof tiers !== "object" || Array.isArray(tiers)) {
    throw new CuratorConfigError(
      `pi-astack model-curator: \`modelCurator.tiers\` missing from ${PI_STACK_SETTINGS_PATH}. ` +
        `This is a REQUIRED field — add at least one tier (e.g. flagship/standard/fast) ` +
        `with a non-empty models list. See pi-astack-settings.schema.json.`,
    );
  }
  const entries = Object.entries(tiers);
  if (entries.length === 0) {
    throw new CuratorConfigError(
      `pi-astack model-curator: \`modelCurator.tiers\` is empty in ${PI_STACK_SETTINGS_PATH}. ` +
        `At least one tier (e.g. flagship/standard/fast) is required.`,
    );
  }
  for (const [name, tier] of entries) {
    if (!tier || !Array.isArray(tier.models) || tier.models.length === 0) {
      throw new CuratorConfigError(
        `pi-astack model-curator: tier "${name}" in \`modelCurator.tiers\` must have a non-empty \`models\` array.`,
      );
    }
  }
  return tiers;
}

// ── Helpers ─────────────────────────────────────────────────────

function modelToProviderConfig(m: Model<Api>) {
  return {
    id: m.id, name: m.name, api: m.api, baseUrl: m.baseUrl,
    reasoning: m.reasoning, thinkingLevelMap: m.thinkingLevelMap,
    input: m.input, cost: m.cost, contextWindow: m.contextWindow,
    maxTokens: m.maxTokens, headers: m.headers, compat: m.compat,
  };
}

async function applyWhitelist(
  pi: ExtensionAPI,
  providerName: string,
  keepIds: readonly string[],
  allBuiltin: Model<Api>[],
  reg: {
    getApiKeyAndHeaders(m: Model<Api>): Promise<{
      ok: boolean; apiKey?: string; headers?: Record<string, string>;
    }>;
  },
): Promise<{ kept: number; missing: string[] }> {
  const missing: string[] = [];
  const found: Model<Api>[] = [];

  for (const id of keepIds) {
    const m = allBuiltin.find((x) => x.provider === providerName && x.id === id);
    if (m) found.push(m);
    else missing.push(id);
  }

  if (found.length === 0) return { kept: 0, missing };

  const baseUrl = found[0].baseUrl;
  const api = found[0].api;

  // Resolve the actual API key from the existing provider config
  // via pi's own auth system — no models.json reading, no env var guessing.
  const auth = await reg.getApiKeyAndHeaders(found[0]);
  if (!auth.ok || !auth.apiKey) return { kept: 0, missing: ["(auth failed)"] };

  pi.registerProvider(providerName, {
    baseUrl,
    api,
    apiKey: auth.apiKey,
    models: found.map(modelToProviderConfig),
  });

  return { kept: found.length, missing };
}

// ── Capability snapshot builder ─────────────────────────────────

const INJECT_MARKER = "<!-- pi-model-curator: capability snapshot -->";

function buildAvailableModelsBlock(
  reg: { getAvailable(): Model<Api>[]; getAll(): Model<Api>[] },
  hints: Record<string, string>,
  curatedProviders: Set<string>,
  tiers: Record<string, TierRoster>,
  imageGen?: Record<string, string>,
): string | null {
  // Plan A guard (3-T0 consensus 2026-06-10): when nothing is curated (no
  // settings.json present → empty providers), do NOT dump the entire pi
  // built-in registry into the system prompt as a giant raw table. Emit
  // nothing instead. In the pi-global deployment settings.json always
  // populates curatedProviders, so this only fires in the unconfigured
  // fresh-clone case.
  if (curatedProviders.size === 0) return null;
  const all = reg.getAvailable ? reg.getAvailable() : reg.getAll();
  if (!all || all.length === 0) return null;

  const byProvider = new Map<string, Array<{ m: Model<Api>; hint: string }>>();
  for (const m of all) {
    const key = `${m.provider}/${m.id}`;
    const hint = hints[key];
    const isCurated = curatedProviders.has(m.provider);

    // Curated provider: only include explicitly hinted models (whitelist).
    // Uncurated provider (e.g. github-copilot): inject raw — list every
    // available model so the main session knows it can dispatch them.
    if (isCurated && !hint) continue;

    const arr = byProvider.get(m.provider) ?? [];
    arr.push({ m, hint: hint ?? "" });
    byProvider.set(m.provider, arr);
  }
  if (byProvider.size === 0) return null;

  const lines: string[] = [
    "## Available models (curated by pi-astack/model-curator)",
    "",
    "Chat models currently available for dispatch. Sections marked **curated** " +
      "have been hand-picked + annotated; sections marked **raw** are passed " +
      "through from pi's registry untouched (no obsolete-model filtering, no " +
      "hints). Isolated contexts are the invariant; prefer provider diversity " +
      "when multiple vendors are available, then degrade to cross-model or same-model isolation.",
    "",
  ];

  // ── Tier roster (REQUIRED, fail-closed upstream via loadTiersOrThrow) ──
  // The roster renders BEFORE the per-provider detail table so the LLM
  // reads the capability ranking first, then the row-level details.
  if (tiers && Object.keys(tiers).length > 0) {
    lines.push("### Tier roster");
    lines.push("");
    lines.push(
      "Authoritative capability ranking (single source of truth = " +
        "`modelCurator.tiers` in pi-astack-settings.json). Tier membership is " +
        "for LLM selection guidance and T0 dispatch planning — it is NOT a " +
        "runtime fallback chain. Business call points (memory, sediment, " +
        "vision, workflow, goal, compaction, imagine) read their own per-role " +
        "model fields, NOT this roster.",
    );
    lines.push("");
    for (const [tierName, tier] of Object.entries(tiers)) {
      const label = tier.label?.trim() || tierName;
      lines.push(`- **${tierName}** (${label}) — ${tier.models.map((m) => `\`${m}\``).join(", ")}`);
      if (tierName === "flagship_candidate") {
        lines.push(
          "  - Candidate caveat: do NOT count these as primary T0 voters in " +
            "3-way blind audits; use them as supplementary 4–5 way " +
            "architecture-diversity voices until their promotion gate closes.",
        );
      }
    }
    if (tiers.flagship) {
      lines.push("");
      lines.push(
        "When dispatching flagship-tier models for blind review or " +
          "architecture critique, prefer cross-vendor + cross-architecture " +
          "picks when available; two models from the same vendor (e.g. fable-5 + opus-4-8) " +
          "do NOT count as fully independent voters unless availability forces " +
          "a cross-model/same-model isolated downgrade. Always check the per-model " +
          "hints below before dispatching — the tier roster is a rough guide.",
      );
    }
    lines.push("");
  }

  const providerOrder = ["anthropic", "openai", "deepseek"];
  const curatedFirst = [
    ...providerOrder.filter((p) => byProvider.has(p) && curatedProviders.has(p)),
    ...[...byProvider.keys()].filter(
      (p) => !providerOrder.includes(p) && curatedProviders.has(p),
    ),
  ];
  const rawAfter = [...byProvider.keys()]
    .filter((p) => !curatedProviders.has(p))
    .sort();
  const sorted = [...curatedFirst, ...rawAfter];

  for (const prov of sorted) {
    const entries = byProvider.get(prov)!;
    const tag = curatedProviders.has(prov) ? "curated" : "raw";
    lines.push(`### ${prov} _(${tag})_`);
    lines.push("");
    lines.push("| model | reasoning | image-in | $/1M in | hint |");
    lines.push("|---|---|---|---|---|");

    entries.sort((a, b) => {
      const rA = a.m.reasoning ? 1 : 0;
      const rB = b.m.reasoning ? 1 : 0;
      if (rA !== rB) return rB - rA;
      return (b.m.cost?.input ?? 0) - (a.m.cost?.input ?? 0);
    });

    for (const { m, hint } of entries) {
      const reasoning = m.reasoning ? "✓" : "—";
      const imageIn = Array.isArray(m.input) && m.input.includes("image") ? "✓" : "—";
      const costIn = typeof m.cost?.input === "number" && m.cost.input > 0
        ? `$${m.cost.input.toFixed(2)}` : "—";
      lines.push(
        `| \`${prov}/${m.id}\` | ${reasoning} | ${imageIn} | ${costIn} | ${hint} |`,
      );
    }
    lines.push("");
  }

  lines.push(
    "**Selection guidance.** When choosing models: (1) isolated contexts are " +
      "the invariant; prefer DIFFERENT providers for independent judgment when " +
      "available, then degrade to cross-model or same-model isolated instances; " +
      "(2) assign execution-oriented tasks, including coding, log review, and concrete implementation, exclusively to GPT models; GPT models may also be used for judgment-oriented tasks, including research, discussion, classification, synthesis, decision-making, solution evaluation, architecture critique, and independent review of completed task results or final diffs. " +
      "Use non-GPT curated models only for judgment-oriented tasks, including research, discussion, classification, synthesis, decision-making, solution evaluation, architecture critique, and independent review of completed task results or final diffs; see each model's hint for permitted examples and boundaries; (3) for vision " +
      "tasks, pick a model with `image-in: ✓`; (4) for **curated** sections, " +
      "follow each model's hint; (5) for **raw** sections (e.g. github-copilot) " +
      "pi exposes its full model list — prefer the newest non-preview entries.",
  );

  if (imageGen && Object.keys(imageGen).length > 0) {
    lines.push("");
    lines.push("### Image generation");
    lines.push("");
    lines.push("| model | hint |");
    lines.push("|---|---|");
    for (const [modelId, hint] of Object.entries(imageGen)) {
      lines.push(`| \`${modelId}\` | ${hint} |`);
    }
  }

  return lines.join("\n");
}

// ── Extension entry ─────────────────────────────────────────────

interface CuratorRegistryLike {
  getAll(): Model<Api>[];
  getAvailable?(): Model<Api>[];
  getApiKeyAndHeaders(m: Model<Api>): Promise<{
    ok: boolean; apiKey?: string; headers?: Record<string, string>;
  }>;
}

interface CuratorCtxLike {
  modelRegistry?: CuratorRegistryLike;
  hasUI?: boolean;
  ui?: {
    setStatus?(key: string, text: string): void;
    notify?(msg: string, level?: string): void;
  };
}

export default function (pi: ExtensionAPI) {
  // Sub-pi guard (2026-05-14 audit): model-curator must not modify
  // a sub-pi's model registry — it could remove the model the parent
  // dispatched the sub-agent with.
  if (process.env.PI_ABRAIN_DISABLED === "1") return;

  // ── Live re-apply state (3-T0 consensus 2026-06-10) ──────────────
  // The whitelist used to be applied exactly once (session_start), so adding
  // a model to pi-astack-settings.json required restarting pi before dispatch
  // could see it (the hints table refreshed every turn but the registry
  // didn't — a confusing split). We now track the settings file's mtime and
  // which providers we actually registered: before_agent_start re-applies the
  // whitelist when the file changed, and /curator-reload forces it manually.
  let lastAppliedMtimeMs: number | null = null;
  let appliedProviderNames: string[] = [];
  // Original built-in catalog, captured on the FIRST application BEFORE any
  // whitelist replaces provider model sets. Re-applies resolve keep-lists
  // against this cache so we never unregister-then-re-register (which would
  // expose raw built-ins during the auth await window and fail open if auth
  // resolution failed mid-apply — T0 audit P0). registerProvider() is an
  // upsert that REPLACES the provider's model set, so re-applying on top of
  // an existing registration needs no prior unregister. NOTE: models.json
  // edits are NOT picked up by re-apply (catalog cached at process start) —
  // same as the pre-live-reapply behavior; they still need a pi restart.
  let builtinCatalog: Model<Api>[] | null = null;
  // Serialize concurrent applications (two sessions in one process, or
  // /curator-reload racing before_agent_start) — T0 audit P0.
  let applyInFlight: Promise<void> | null = null;

  function settingsMtimeMs(): number | null {
    try {
      return fs.statSync(PI_STACK_SETTINGS_PATH).mtimeMs;
    } catch {
      return null; // absent/unreadable → no re-apply signal; keep last config
    }
  }

  function applyAllWhitelists(ctx: CuratorCtxLike): Promise<void> {
    if (applyInFlight) return applyInFlight;
    applyInFlight = doApplyAllWhitelists(ctx).finally(() => {
      applyInFlight = null;
    });
    return applyInFlight;
  }

  async function doApplyAllWhitelists(ctx: CuratorCtxLike): Promise<void> {
    const reg = ctx.modelRegistry;
    if (!reg) return;

    // Snapshot the mtime BEFORE reading config (T0 audit P0: a write landing
    // during apply must NOT be absorbed by a post-apply fresh stat — the
    // next turn's stat differs from this snapshot and re-triggers).
    const mtimeSnapshot = settingsMtimeMs();
    const cfg = resolveConfig();

    // Fail-closed: tiers are REQUIRED. Validate at apply time so a missing
    // or empty `modelCurator.tiers` surfaces here (session_start / live
    // re-apply) instead of producing a misleading prompt at the next turn.
    loadTiersOrThrow();

    builtinCatalog ??= reg.getAll();
    const allBuiltin = builtinCatalog;

    // Providers we previously curated that are no longer in settings:
    // unregister to restore raw passthrough (deliberate config removal;
    // unregisterProvider is a no-op for never-registered names).
    const cfgProviderNames = new Set(Object.keys(cfg.providers));
    for (const name of appliedProviderNames) {
      if (!cfgProviderNames.has(name)) {
        try { pi.unregisterProvider(name); } catch { /* best-effort */ }
      }
    }

    const report: string[] = [];
    const registered: string[] = [];
    let totalKept = 0;
    let totalMissing = 0;

    for (const [providerName, keepIds] of Object.entries(cfg.providers)) {
      const { kept, missing } = await applyWhitelist(
        pi, providerName, keepIds, allBuiltin, reg,
      );

      totalKept += kept;
      totalMissing += missing.length;
      if (kept > 0) registered.push(providerName);

      if (missing.length > 0) {
        report.push(
          `[model-curator] WARN ${providerName}: missing from built-in: ${missing.join(", ")}`,
        );
      }
      if (kept === 0) {
        report.push(
          `[model-curator] SKIP ${providerName}: no kept models found — leaving as-is`,
        );
      } else {
        report.push(
          `[model-curator] OK   ${providerName}: kept ${kept}/${keepIds.length} models`,
        );
      }
    }

    // Tracking = providers registered this round, plus providers whose
    // PREVIOUS registration is still active in the registry (kept=0 this
    // round, e.g. transient auth failure — their old whitelist remains; we
    // intentionally did not unregister them, preserving last-good config).
    const previouslyApplied = appliedProviderNames.filter(
      (n) => cfgProviderNames.has(n) && !registered.includes(n),
    );
    appliedProviderNames = [...registered, ...previouslyApplied];
    // Advance the mtime watermark even on partial failure — no per-turn
    // auto-retry loops (avoids re-apply latency every turn while auth is
    // down). /curator-reload is the manual retry path.
    lastAppliedMtimeMs = mtimeSnapshot;

    if (ctx.hasUI) {
      try {
        // Total models actually available for dispatch. Falls back to getAll()
        // if getAvailable isn't exposed by this pi version.
        let totalAvailable = totalKept;
        try {
          const list = reg.getAvailable ? reg.getAvailable() : reg.getAll();
          totalAvailable = Array.isArray(list) ? list.length : totalKept;
        } catch { /* keep totalKept fallback */ }

        const status = totalMissing > 0
          ? `📋 ${totalAvailable} models (${totalKept}✓ ${totalMissing}!)`
          : `📋 ${totalAvailable} models`;
        ctx.ui?.setStatus?.(FOOTER_STATUS_KEYS.modelCurator, status);
      } catch { /* ignore */ }
    }

    for (const line of report) {
      if (line.includes("WARN") || line.includes("FAIL") || line.includes("SKIP")) {
        console.error(line);
      }
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    if (isSubAgentBoundaryUntrusted()) {
      const diagnostic = getSubAgentBoundaryUntrustedDiagnostic();
      console.error(`[model-curator] sub-agent boundary untrusted; blocked session_start registry mutation (${diagnostic?.reason ?? "unknown"})`);
      try { ctx.ui?.setStatus?.(FOOTER_STATUS_KEYS.modelCurator, "boundary untrusted"); } catch { /* ignore */ }
      try { ctx.ui?.notify?.("model-curator: sub-agent boundary untrusted; registry mutation disabled", "error"); } catch { /* ignore */ }
      return;
    }

    // ADR 0027 PR-B (v3 in-process replacement for the env guard above):
    // model-curator must NOT prune a sub-agent's model registry — dispatch
    // explicitly chose the sub-agent's model, and the curator's whitelist
    // is a main-session configuration concept.
    if (isSubAgentSession(ctx)) return;

    // P2 fix (R6 audit): outer try/catch so model-curator startup
    // failure (network/auth/registry error) doesn't reject the hook
    // and silently disable all other session_start handlers.
    try {
      await applyAllWhitelists(ctx as CuratorCtxLike);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[model-curator] session_start error (model whitelist failed, leaving registry as-is): ${message}`);
      try {
        ctx.ui?.setStatus?.(FOOTER_STATUS_KEYS.modelCurator, "⚠️ model-curator error");
      } catch { /* ignore */ }
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const reg = ctx.modelRegistry;
    if (!reg) return undefined;

    // Live re-apply (mtime-gated): if pi-astack-settings.json changed since
    // the last whitelist application, re-apply BEFORE building the hints
    // block so a newly added model is dispatchable this very turn — no
    // restart. Guarded for sub-agents: their registry must not be re-pruned
    // mid-dispatch (same invariant as the session_start guard).
    if (isSubAgentBoundaryUntrusted()) {
      const diagnostic = getSubAgentBoundaryUntrustedDiagnostic();
      console.error(`[model-curator] sub-agent boundary untrusted; blocked live registry re-apply (${diagnostic?.reason ?? "unknown"})`);
      try { ctx.ui?.setStatus?.(FOOTER_STATUS_KEYS.modelCurator, "boundary untrusted"); } catch { /* ignore */ }
    } else if (!isSubAgentSession(ctx)) {
      const m = settingsMtimeMs();
      if (m !== null && m !== lastAppliedMtimeMs) {
        try {
          await applyAllWhitelists(ctx as CuratorCtxLike);
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          console.error(`[model-curator] live re-apply failed (registry left as-is): ${message}`);
        }
      }
    }

    const current = event.systemPrompt ?? "";
    if (current.includes(INJECT_MARKER)) return undefined;

    const cfg = resolveConfig();
    const tiers = loadTiersOrThrow();
    const curatedProviders = new Set(Object.keys(cfg.providers));
    const block = buildAvailableModelsBlock(
      reg, cfg.hints, curatedProviders, tiers, cfg.imageGen,
    );
    if (!block) return undefined;

    return {
      systemPrompt: current + "\n\n" + INJECT_MARKER + "\n" + block + "\n",
    };
  });

  // ── /curator-reload: manual re-apply (feature-detected for older pi) ──
  // The mtime gate above covers the normal edit→next-message flow; this
  // command is the explicit fallback (e.g. clock-skewed mounts where mtime
  // doesn't change, or to force a retry after a transient auth failure).
  const maybeRegisterCommand = (pi as unknown as {
    registerCommand?: (name: string, options: {
      description?: string;
      handler: (args: string, ctx: unknown) => Promise<void>;
    }) => void;
  }).registerCommand;
  if (typeof maybeRegisterCommand === "function") {
    maybeRegisterCommand.call(pi, "curator-reload", {
      description: "Re-apply modelCurator whitelist/hints from pi-astack-settings.json (no restart needed)",
      handler: async (_args: string, cmdCtx: unknown) => {
        const c = cmdCtx as CuratorCtxLike;
        try {
          await applyAllWhitelists(c);
          c.ui?.notify?.("model-curator: whitelist re-applied from settings", "info");
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          c.ui?.notify?.(`model-curator reload failed: ${message}`, "error");
        }
      },
    });
  }
}

// ── Test-only exports (NOT used by the live extension) ───────────
// These symbols are imported by scripts/smoke-model-curator-tiers.mjs via
// jiti's `__TEST` channel. They re-export the same closures the live code
// path uses, so smoke tests stay in sync with the real implementation.
export const __TEST = {
  resolveConfig,
  loadTiersOrThrow,
  buildAvailableModelsBlock,
};
