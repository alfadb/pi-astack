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
import type { Api, Model } from "@earendil-works/pi-ai";
import { FOOTER_STATUS_KEYS } from "../_shared/footer-status";
import { isSubAgentSession } from "../_shared/pi-internals";

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

interface CuratorDefaults {
  providers: Record<string, readonly string[]>;
  hints: Record<string, string>;
  imageGen: Record<string, string>;
}

const DEFAULTS: CuratorDefaults = {
  providers: {
    anthropic: [
      "claude-fable-5",
      "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6",
      "claude-sonnet-4-6", "claude-sonnet-4-5", "claude-haiku-4-5",
    ],
    openai: [
      "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex",
    ],
    deepseek: [
      "deepseek-v4-pro", "deepseek-v4-flash",
    ],
    "github-copilot": [
      "gpt-5.5", "gpt-5-mini",
    ],
    "minimax": [
      "MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed",
    ],
    "kimi-coding": [
      "kimi-k2-thinking", "kimi-for-coding",
    ],
  },

  hints: {
    "anthropic/claude-fable-5":
      "Mythos-class tier above Opus 4.8 — Anthropic's newest flagship (provisional: released 2026-06-09, no official system card yet). Reported agentic-coding leader (third-party SWE-Bench Pro ~80.3% vs Opus 4.8 69.2%, Terminal-Bench 2.1 88.0% — unverified); 1M context, 128K out; xhigh-only thinking (forceAdaptiveThinking, no high/medium/low). $10/$50 (2× Opus 4.8). CAVEAT: sensitive queries (cyber/bio-chem/distillation) blocked + rerouted to Opus 4.8 (~<5% sessions) — NOT an independent voice from Opus for security-audit/blind-review work. CAVEAT: benchmarks third-party/unofficial, treat as provisional until first-party numbers land. Verify sub2api route availability/pricing. Use for hardest long-horizon autonomous agentic coding + architecture critique.",
    "anthropic/claude-opus-4-8":
      "Strongest reasoning + agentic coding (SWE-bench Verified 88.6%, SWE-bench Pro 69.2%); ~4× lower 'silent code bug' rate vs 4.7 + proactively flags input/output uncertainty (good for audit/review subagents); defaults to high effort, supports xhigh/max; regular $5/$25 same as 4.7, fast mode $10/$50 (~2.5× speed, 3× cheaper than 4.7's $30/$150 fast). Use for security audits, architecture critique, long-horizon agentic work.",
    "anthropic/claude-opus-4-7":
      "Previous-gen opus (April 2026); close to 4-8 quality but more likely to let coding flaws pass unremarked. Strong second voice for ensemble reviews. Same price tier as 4-8.",
    "anthropic/claude-opus-4-6":
      "Two-gen-back opus (Feb 2026); use only as fallback when 4-8/4-7 rate-limited or unavailable.",
    "anthropic/claude-sonnet-4-6":
      "Mid-tier, faster + cheaper than opus. Design review, refactor proposals.",
    "anthropic/claude-sonnet-4-5":
      "Previous-gen sonnet; cheap second voice or vision fallback in ensembles. Slightly older training cutoff.",
    "anthropic/claude-haiku-4-5":
      "Fastest + cheapest. Quick classification, short summaries.",
    "openai/gpt-5.5":
      "Strong general-purpose reasoning + coding. Architecture, planning. Image input. ($5/1M in)",
    "openai/gpt-5.4":
      "Previous-gen 5.x; cheaper fallback or second voice in ensemble.",
    "openai/gpt-5.4-mini":
      "Small + fast. High-volume classification, regex extraction. ($0.75/1M in)",
    "openai/gpt-5.3-codex":
      "Codex-tuned for code generation/edits; weaker on prose reasoning — prefer gpt-5.5 or gpt-5.4 for prose-heavy critique or architecture.",
    "deepseek/deepseek-v4-pro":
      "Strong structured analysis, 1M context window. Diff review, dependency audit. Cheapest top-tier.",
    "deepseek/deepseek-v4-flash":
      "Fast + very cheap ($0.14/1M in). High-volume eval or when v4-pro is rate-limited.",
    "github-copilot/gpt-5.5":
      "gpt-5.5 via Copilot raw API route; usage-based billing since 2026-06-01 (verify per-token cost). Spare OpenAI API budget / main-session overflow when Claude Max weekly limit is hit.",
    "github-copilot/gpt-5-mini":
      "Copilot-routed gpt-5-mini; fast + cheap. High-volume classification, short summaries. Real ctx ceiling ~128K (pi-declared 264K wrong on this route; models.json override corrects).",
    "minimax/MiniMax-M3":
      "Recent (2026-05) multimodal MoE, 1M context, ~$0.30/1M in. Cheap vision + huge-context reviews; non-US vendor voice for blind-review independence. Verify sub2api route pricing (some routes show $0.60).",
    "kimi-coding/kimi-k2-thinking":
      "Moonshot extended-thinking MoE, 256K context, native INT4 quantization. 5th independent vendor family (non-US/non-OpenAI/non-Anthropic/non-DeepSeek); INT4-native sparsity = decorrelated failure mode vs dense Opus/GPT and standard-MoE DeepSeek. Use as cross-vendor critique voice in 3-T0 blind-review trios when >3 independent voters needed. (~$0.45-0.68/M in via OpenRouter; verify sub2api route.)",
    "minimax/MiniMax-M2.7":
      "MiniMax MSA sparse-attn agent, 204K ctx, 10B active params, self-evolving agent capability. Architecturally distinct from M3 (MSA sparse-attn vs MoE); orthogonal failure surface to dense Opus/GPT and standard-MoE DeepSeek/K2. CAVEAT: same vendor as M3 → shared training/RLHF → don't pair M2.7+M3 as 'independent' blind-review voters. For time-boxed/blocking T0 reviews, use M2.7-highspeed variant (100 TPS, same arch). Treat 'Opus/GPT parity' claim as marketing. (~$0.30/M in via OpenRouter; verify sub2api route.)",
  },

  imageGen: {
    "gpt-image-2":
      "Latest OpenAI image generation model. Call `imagine(prompt: \"...\", size?, quality?, style?)` to generate images.",
  },
};

// ── Config resolution ───────────────────────────────────────────

function resolveConfig(): CuratorDefaults {
  const settings = loadPiStackSettings();
  const cfg = (settings.modelCurator as Record<string, unknown>) ?? {};
  return {
    providers: (cfg.providers as CuratorDefaults["providers"]) ?? DEFAULTS.providers,
    hints: (cfg.hints as CuratorDefaults["hints"]) ?? DEFAULTS.hints,
    imageGen: (cfg.imageGen as CuratorDefaults["imageGen"]) ?? DEFAULTS.imageGen,
  };
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
  imageGen?: Record<string, string>,
): string | null {
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
      "hints). When choosing a model, diversity across providers usually beats " +
      "stacking the same family.",
    "",
  ];

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
    "**Selection guidance.** When choosing models: (1) prefer DIFFERENT " +
      "providers across roles to diversify reasoning failure modes; (2) match " +
      "capability to need — don't pay for opus on one-line classification; " +
      "(3) for vision tasks, pick a model with `image-in: ✓`; (4) for **curated** " +
      "sections any listed name is safe to dispatch (obsolete models already " +
      "removed); (5) for **raw** sections (e.g. github-copilot) pi exposes its " +
      "full model list — prefer the newest non-preview entries.",
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

export default function (pi: ExtensionAPI) {
  // Sub-pi guard (2026-05-14 audit): model-curator must not modify
  // a sub-pi's model registry — it could remove the model the parent
  // dispatched the sub-agent with.
  if (process.env.PI_ABRAIN_DISABLED === "1") return;

  pi.on("session_start", async (_event, ctx) => {
    // ADR 0027 PR-B (v3 in-process replacement for the env guard above):
    // model-curator must NOT prune a sub-agent's model registry — dispatch
    // explicitly chose the sub-agent's model, and the curator's whitelist
    // is a main-session configuration concept.
    if (isSubAgentSession(ctx)) return;

    // P2 fix (R6 audit): outer try/catch so model-curator startup
    // failure (network/auth/registry error) doesn't reject the hook
    // and silently disable all other session_start handlers.
    try {
    const reg = ctx.modelRegistry;
    if (!reg) return;

    const cfg = resolveConfig();
    const allBuiltin = reg.getAll();
    const report: string[] = [];
    let totalKept = 0;
    let totalMissing = 0;

    for (const [providerName, keepIds] of Object.entries(cfg.providers)) {
      const { kept, missing } = await applyWhitelist(
        pi, providerName, keepIds, allBuiltin, reg,
      );

      totalKept += kept;
      totalMissing += missing.length;

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

    if (ctx.hasUI) {
      try {
        // Total models actually available for dispatch — includes both
        // curated (kept after whitelist) and raw providers (e.g. github-copilot,
        // which model-curator passes through untouched). Falls back to getAll()
        // if getAvailable isn't exposed by this pi version.
        let totalAvailable = totalKept;
        try {
          const list = reg.getAvailable ? reg.getAvailable() : reg.getAll();
          totalAvailable = Array.isArray(list) ? list.length : totalKept;
        } catch { /* keep totalKept fallback */ }

        const status = totalMissing > 0
          ? `📋 ${totalAvailable} models (${totalKept}✓ ${totalMissing}!)`
          : `📋 ${totalAvailable} models`;
        ctx.ui.setStatus(FOOTER_STATUS_KEYS.modelCurator, status);
      } catch { /* ignore */ }
    }

    for (const line of report) {
      if (line.includes("WARN") || line.includes("FAIL") || line.includes("SKIP")) {
        console.error(line);
      }
    }
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

    const current = event.systemPrompt ?? "";
    if (current.includes(INJECT_MARKER)) return undefined;

    const cfg = resolveConfig();
    const curatedProviders = new Set(Object.keys(cfg.providers));
    const block = buildAvailableModelsBlock(
      reg, cfg.hints, curatedProviders, cfg.imageGen,
    );
    if (!block) return undefined;

    return {
      systemPrompt: current + "\n\n" + INJECT_MARKER + "\n" + block + "\n",
    };
  });
}
