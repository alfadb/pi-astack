/**
 * vision extension for pi-astack — delegate image analysis to the best
 * available vision-capable model.
 *
 * Ported from pi-multi-agent/tools/vision-core.ts (2026-05-07).
 * Self-contained: no separate core file needed — subprocess-based dispatch
 * means subagents access this through pi's own tool registration, not through
 * in-process tool injection.
 *
 * Picks the strongest vision-capable model from the model registry (excluding
 * the caller's own model), then runs an in-process pi-ai streamSimple call
 * with the image. Returns text analysis + model used + usage stats.
 *
 * Security model (path-based image loads):
 *   1. Extension allowlist — only .png/.jpg/.jpeg/.webp/.gif accepted.
 *   2. Path containment — absolute paths and .. escapes are rejected.
 *   3. Symlink defense — realpath resolution on both sides prevents
 *      symlink-based TOCTOU bypass of path containment.
 * Together these prevent an LLM-supplied path from exfiltrating arbitrary
 * files (secrets, config, private keys) through a vision provider round-trip.
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";

// ── pi-astack settings loader ──────────────────────────────
// Read pi-astack's own config file. Missing/malformed → fallback to defaults.

const PI_STACK_SETTINGS_PATH = path.join(
  os.homedir(), ".pi", "agent", "pi-astack-settings.json",
);

function loadPiStackSettings(): Record<string, unknown> {
  try {
    return JSON.parse(fsSync.readFileSync(PI_STACK_SETTINGS_PATH, "utf-8"));
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`pi-astack: failed to parse ${PI_STACK_SETTINGS_PATH}: ${message}. Using defaults.`);
    return {};
  }
}

// ── Constants ───────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 1;

/** Image extensions permitted for path-based loads. Non-image bytes must
 *  never be base64-encoded and shipped to a third-party provider. */
const ALLOWED_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

/** MIME mapping by extension for path-based loads. */
const EXT_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

// ── Default vision model preferences ────────────────────────────

/**
 * Ordered preference list for vision model selection. Lower index = higher
 * priority. Substring match on model id (case-insensitive, tolerant of
 * version suffixes like "gpt-5.5-2026-07-15").
 *
 * Models not matching any preference still participate, ordered by
 * cost.input descending as a rough capability proxy.
 *
 * Override via top-level `vision.modelPreferences` in `~/.pi/agent/pi-astack-settings.json`.
 *
 * Aligned 2026-05-17 with model-curator keep-list: only entries whose
 * provider is currently registered (anthropic / openai / deepseek;
 * deepseek has no image-in so it's filtered at selection time anyway)
 * and whose model id is in the curator's keep-list survive substring
 * match. google/gemini-3-pro and older claude-{opus,sonnet}-4 / openai/gpt-5
 * were dropped because curator never registers them, so listing them here
 * was misleading dead-code. github-copilot models are NOT listed here
 * because scoreByPrefs does an exact `provider === pProv` match (not
 * substring) — so they fall into the unmatched bucket and get ranked
 * by cost.input descending as a soft fallback. Add explicit
 * `github-copilot/<id>` entries to pi-astack-settings.json `vision.modelPreferences`
 * if you want to promote a Copilot model.
 */
const DEFAULT_VISION_PREFS = [
  "openai/gpt-5.5",
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-opus-4-7",
  "anthropic/claude-opus-4-6",
  "anthropic/claude-sonnet-4-5",
  "openai/gpt-5.4",
  "anthropic/claude-haiku-4-5",
];

// ── Types ───────────────────────────────────────────────────────

interface VisionParams {
  imageBase64?: string;
  path?: string;
  mimeType?: string;
  prompt: string;
}

interface VisionDeps {
  modelRegistry: {
    getAvailable(): Promise<Array<{ provider: string; id: string; input?: string[]; cost?: { input?: number } }>>;
    getApiKeyAndHeaders(model: unknown): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>;
    find(provider: string, modelId: string): unknown;
  };
  prefs: string[];
  excludeMain?: { provider: string; id: string; input?: string[] };
  signal?: AbortSignal;
  timeoutMs?: number;
  cwd?: string;
}

interface VisionOk {
  ok: true;
  text: string;
  model: string;
  usage?: unknown;
  candidates: string[];
}

interface VisionErr {
  ok: false;
  error: string;
}

type VisionResult = VisionOk | VisionErr;

type ResolvedImage = { base64: string; mimeType: string };

// ── Path validation (security) ──────────────────────────────────

/**
 * Validate that a user-supplied image path is safe to read.
 *
 * Three layers of defense:
 *   1. Extension allowlist — only image extensions permitted.
 *   2. Lexical containment — resolved under cwd root.
 *   3. Symlink resolution — realpath on both sides prevents symlink escape.
 *
 * Returns the absolute path on success, or a VisionErr.
 */
function validateImagePath(
  userPath: string,
  cwd: string | undefined,
): { ok: true; abs: string; ext: string } | VisionErr {
  const ext = path.extname(userPath).toLowerCase();
  if (!ALLOWED_IMAGE_EXTS.has(ext)) {
    return {
      ok: false,
      error:
        `Image path extension "${ext || "(none)"}" not allowed. ` +
        `Permitted: ${[...ALLOWED_IMAGE_EXTS].join(", ")}`,
    };
  }

  const rootRaw = path.resolve(cwd ?? process.cwd());
  const absRaw = path.resolve(rootRaw, userPath);

  // Resolve symlinks on both sides. If either side doesn't exist yet,
  // fall back to the lexical path (a non-existent path can't be a
  // symlink-to-secret, so the lexical check is sufficient).
  let root: string;
  let abs: string;
  try { root = fsSync.realpathSync(rootRaw); } catch { root = rootRaw; }
  try { abs = fsSync.realpathSync(absRaw); } catch { abs = absRaw; }

  // Trailing-separator guard: ensure /a/bc isn't treated as inside /a/b.
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) {
    return {
      ok: false,
      error:
        `Image path "${userPath}" resolves outside the project root (after symlink resolution).`,
    };
  }

  return { ok: true, abs, ext };
}

// ── Image resolution ────────────────────────────────────────────

/**
 * Resolve image bytes from base64 input or file path. Infers MIME type
 * from file extension when loading from path.
 */
async function resolveImage(
  input: VisionParams,
  cwd: string | undefined,
): Promise<ResolvedImage | VisionErr> {
  let imageBase64 = input.imageBase64;
  let mimeType = input.mimeType || "image/png";

  if (input.path && !imageBase64) {
    const validation = validateImagePath(input.path, cwd);
    if ("ok" in validation && !validation.ok) return validation;

    try {
      const buf = await fs.readFile(validation.abs);
      imageBase64 = buf.toString("base64");
      mimeType = EXT_MIME[validation.ext] || "image/png";
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `Failed to read image file: ${msg}` };
    }
  }

  if (!imageBase64) {
    return {
      ok: false,
      error: "No image provided. Pass imageBase64 (base64-encoded data) or path (file path to an image).",
    };
  }

  return { base64: imageBase64, mimeType };
}

// ── Model selection ─────────────────────────────────────────────

/**
 * Score a model by its position in the preference list.
 * Lower score = more preferred. Substring match on model id (case-insensitive,
 * version-suffix-tolerant).
 */
function scoreByPrefs(
  m: { provider: string; id: string },
  prefs: string[],
): number {
  const id = String(m.id || "").toLowerCase();
  for (let i = 0; i < prefs.length; i++) {
    const slash = prefs[i].indexOf("/");
    if (slash < 0) continue;
    const pProv = prefs[i].slice(0, slash);
    const pPattern = prefs[i].slice(slash + 1).toLowerCase();
    if (m.provider === pProv && id.includes(pPattern)) return i;
  }
  return prefs.length;
}

// ── Core vision analysis ────────────────────────────────────────

async function analyzeImage(
  input: VisionParams,
  deps: VisionDeps,
): Promise<VisionResult> {
  // 1. Resolve image bytes
  const img = await resolveImage(input, deps.cwd);
  if ("ok" in img && !img.ok) return img as VisionErr;
  const resolved = img as ResolvedImage;

  // 2. Select the best vision-capable model
  const isExcluded = (m: { provider: string; id: string }) =>
    !!deps.excludeMain &&
    m.provider === deps.excludeMain.provider &&
    m.id === deps.excludeMain.id;

  // Defensive: getAvailable() is not guaranteed on all pi versions.
  // model-curator already uses the same fallback pattern (getAvailable ?? getAll).
  const reg = deps.modelRegistry as any;
  const available: Array<{ provider: string; id: string; input?: string[]; cost?: { input?: number } }> =
    typeof reg.getAvailable === "function"
      ? await reg.getAvailable()
      : await reg.getAll?.() ?? [];
  const candidates = available
    .filter((m) => m.input?.includes("image"))
    .filter((m) => !isExcluded(m))
    .map((m) => ({ m, pref: scoreByPrefs(m, deps.prefs) }))
    .sort((a, b) => {
      if (a.pref !== b.pref) return a.pref - b.pref;
      // Same preference bucket: higher input cost ≈ stronger model.
      return (b.m.cost?.input ?? 0) - (a.m.cost?.input ?? 0);
    })
    .map((x) => x.m);

  if (candidates.length === 0) {
    // If the excluded main model itself supports images, surface a clear
    // message — calling vision when the caller already has image input is
    // a no-op round-trip.
    if (deps.excludeMain?.input?.includes?.("image")) {
      return {
        ok: false,
        error:
          `Your current model (${deps.excludeMain.provider}/${deps.excludeMain.id}) ` +
          "already supports image input. Pass the image directly in your prompt " +
          "instead of using the vision tool. (vision exists to delegate to a *different* model.)",
      };
    }
    return {
      ok: false,
      error:
        "No vision-capable model available (other than the excluded current model). " +
        "Configure another provider with image support in your pi settings.",
    };
  }

  const best = candidates[0];

  // 3. Get auth for the chosen model
  const auth = await deps.modelRegistry.getApiKeyAndHeaders(best);
  if (!auth.ok || !auth.apiKey) {
    return {
      ok: false,
      error: `Auth failed for vision model ${best.provider}/${best.id}: ${auth.error || "no API key"}`,
    };
  }

  // 4. Run the vision call via pi-ai streamSimple
  try {
    const piAi: {
      streamSimple(
        model: unknown,
        opts: { messages: unknown[] },
        config: {
          apiKey: string;
          headers?: Record<string, string>;
          signal?: AbortSignal;
          timeoutMs?: number;
          maxRetries?: number;
        },
      ): { result(): Promise<{ stopReason?: string; errorMessage?: string; content?: Array<{ type: string; text?: string }>; usage?: unknown }> };
    } = await import("@earendil-works/pi-ai");

    const userMsg = {
      role: "user" as const,
      content: [
        { type: "image" as const, data: resolved.base64, mimeType: resolved.mimeType },
        { type: "text" as const, text: input.prompt || "Describe this image in detail." },
      ],
      timestamp: Date.now(),
    };

    const stream = piAi.streamSimple(
      best,
      { messages: [userMsg] },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal: deps.signal,
        timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxRetries: DEFAULT_MAX_RETRIES,
      },
    );

    const finalMsg = await stream.result();

    if (
      finalMsg.stopReason === "error" ||
      finalMsg.stopReason === "aborted"
    ) {
      const reason = finalMsg.errorMessage || finalMsg.stopReason;
      return {
        ok: false,
        error: `Vision analysis failed (${best.provider}/${best.id}): ${reason}`,
      };
    }

    const text = (finalMsg.content as Array<{ type?: string; text?: string }> | undefined ?? [])
      .filter((c) => c?.type === "text")
      .map((c) => c.text ?? "")
      .join("\n")
      .trim();

    if (!text) {
      return {
        ok: false,
        error: `Vision model returned no text (stopReason=${finalMsg.stopReason}).`,
      };
    }

    return {
      ok: true,
      text,
      model: `${best.provider}/${best.id}`,
      usage: finalMsg.usage,
      candidates: candidates.slice(0, 5).map((m) => `${m.provider}/${m.id}`),
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: `Vision analysis failed (${best.provider}/${best.id}): ${msg.slice(0, 500)}`,
    };
  }
}

// ── Config loading ──────────────────────────────────────────────

function loadVisionPrefs(): string[] {
  const settings = loadPiStackSettings();
  const visionConfig = settings.vision as Record<string, unknown> | undefined;
  const prefs = visionConfig?.modelPreferences;
  // Guard against mis-typed values (e.g. a bare string would pass
  // prefs.length > 0 and break scoreByPrefs character iteration).
  if (Array.isArray(prefs) && prefs.length > 0) return prefs as string[];
  return DEFAULT_VISION_PREFS;
}

// ── Extension entry ─────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Sub-pi enforce ──────────────────────────────────────────
  // ADR 0014 §6: sub-pi should not have vision tool.
  if (process.env.PI_ABRAIN_DISABLED === "1") return;

  pi.registerTool({
    name: "vision",
    label: "Vision Analysis",
    description:
      "Analyze images using the best available vision-capable model. " +
      "Use when your current model does not support image input. " +
      "Automatically selects the strongest " +
      "vision-capable model from available providers. Accepts base64-encoded " +
      "images or file paths confined to the project directory.",
    promptSnippet: "vision(imageBase64?, path?, prompt, mimeType?) — analyze an image with the best vision model",
    promptGuidelines: [
      "Use vision when the user provides an image (screenshot, photo, diagram) and your current model cannot process images.",
      "Prefer imageBase64 for images already in context. Use path for local image files within the project.",
      "The tool auto-selects the best vision model per your `vision.modelPreferences` setting in pi-astack-settings.json (top-level, no piStack wrapper).",
      "Returns the text analysis from the vision model, along with model info and token usage.",
      "For path-based loads: only .png/.jpg/.jpeg/.webp/.gif extensions are allowed, and paths are confined to the project root.",
    ],
    parameters: Type.Object({
      imageBase64: Type.Optional(Type.String({
        description: "Base64-encoded image data (preferred for inline images)",
      })),
      path: Type.Optional(Type.String({
        description: "Path to an image file within the project directory (alternative to imageBase64)",
      })),
      mimeType: Type.Optional(Type.String({
        description: "Image MIME type, e.g. image/png, image/jpeg. Auto-inferred from path extension.",
      })),
      prompt: Type.String({
        description: "What to analyze, describe, or look for in the image",
      }),
    }),

    // 2026-05-24 fix: pi SDK 0.75 prepareArguments must be (args: unknown).
    // Conditional spread keeps optional fields aligned with TParams schema.
    prepareArguments(rawArgs: unknown) {
      const args =
        rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, unknown>)
          : {};
      const imageBase64 = args.imageBase64 ? String(args.imageBase64) : undefined;
      const pathArg = args.path ? String(args.path) : undefined;
      const mimeType = args.mimeType ? String(args.mimeType) : undefined;
      return {
        prompt: String(args.prompt ?? "Describe this image in detail."),
        ...(imageBase64 !== undefined ? { imageBase64 } : {}),
        ...(pathArg !== undefined ? { path: pathArg } : {}),
        ...(mimeType !== undefined ? { mimeType } : {}),
      };
    },

    async execute(
      _id: string,
      params: VisionParams,
      signal: AbortSignal,
      _onUpdate: unknown,
      // 2026-05-24 fix: ctx widened for contravariance vs SDK
      // ExtensionContext. model/modelRegistry are `unknown`; inner code
      // casts to the shape it needs. Same pattern as memory/imagine.
      ctx: {
        cwd?: string;
        model?: unknown;
        modelRegistry: unknown;
      },
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown; isError?: boolean }> {
      const model = ctx.model as { provider: string; id: string; input?: string[] } | undefined;
      // P0 fix (2026-05-14 audit round 6): modelRegistry may be undefined in
      // some pi versions — return isError instead of crashing.
      if (!ctx.modelRegistry) {
        return {
          content: [{
            type: "text" as const,
            text: "❌ vision: modelRegistry not available in this pi session.",
          }],
          details: { error: "modelRegistry missing" },
          ...{ isError: true },
        };
      }

      const modelRegistry = ctx.modelRegistry as VisionDeps["modelRegistry"];
      const prefs = loadVisionPrefs();

      const result = await analyzeImage(params, {
        modelRegistry,
        prefs,
        excludeMain: model
          ? { provider: model.provider, id: model.id, input: model.input }
          : undefined,
        signal,
        cwd: ctx.cwd ?? process.cwd(),
      });

      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: `❌ ${result.error}` }],
          details: { error: result.error },
          ...{ isError: true },
        };
      }

      const candidatesStr = result.candidates.length > 0
        ? `\n\nAvailable vision models: ${result.candidates.join(", ")}`
        : "";

      return {
        content: [
          {
            type: "text" as const,
            text:
              `## Vision Analysis (${result.model})\n\n` +
              `${result.text}${candidatesStr}`,
          },
        ],
        details: {
          model: result.model,
          usage: result.usage,
          candidates: result.candidates,
        },
      };
    },
  });
}
