/**
 * imagine extension for pi-astack — AI image generation + image-to-image editing via OpenAI APIs.
 *
 * Rewritten 2026-05-07 to piggyback on the user's existing openai provider
 * configuration. No model registration, no custom provider, no piStack config
 * needed — just uses pi's native modelRegistry to:
 *   1. getApiKeyForProvider("openai") → API key
 *   2. Find openai-responses model → get baseUrl (the Responses API endpoint)
 *   3. Call POST {baseUrl}/v1/responses with image_generation_call for text-to-image
 *   4. Call POST {baseUrl}/v1/images/edits for image-to-image when `imagePath` is provided
 *
 * No extra config: key and baseUrl both come from the openai provider — the
 * same one your chat models use. If you've pointed openai at a proxy, images
 * go through the same proxy automatically.
 *
 * Output: PNG saved to <cwd>/.pi-astack/imagine/, returned inline (base64) when
 * the caller's model supports image input.
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── Constants ───────────────────────────────────────────────────

/** Persistent output directory under the project root. Each extension owns
 *  its own subdirectory under .pi-astack/ for clean separation. The whole
 *  .pi-astack/ tree should be in the project's .gitignore. */
const OUTPUT_DIR = path.join(".pi-astack", "imagine");
const ALLOWED_SIZES = ["auto", "1024x1024", "1536x1024", "1024x1536", "1792x1024", "1024x1792"] as const;
const ALLOWED_QUALITIES = ["auto", "low", "medium", "high", "standard", "hd"] as const;
const ALLOWED_STYLES = ["vivid", "natural"] as const;
const ALLOWED_INPUT_FIDELITIES = ["low", "high"] as const;
const IMAGE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

// ── Settings (read at call time, no model in code) ──────────────

const PI_STACK_SETTINGS_PATH = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "pi-astack-settings.json",
);

function loadImagineDefaultModel(): string {
  // Configure in pi-astack-settings.json → imagine.defaultModel.
  // Empty when missing → caller must pass `model` param.
  try {
    const raw = fsSync.readFileSync(PI_STACK_SETTINGS_PATH, "utf-8");
    const cfg = JSON.parse(raw) as Record<string, unknown> | null;
    const imagine = cfg && typeof cfg === "object" && typeof (cfg as Record<string, unknown>).imagine === "object"
      ? (cfg as Record<string, unknown>).imagine as Record<string, unknown>
      : null;
    const m = imagine && typeof imagine.defaultModel === "string" ? imagine.defaultModel.trim() : "";
    return m;
  } catch {
    return "";
  }
}

// ── Output path ─────────────────────────────────────────────────

async function makeOutputPath(cwd: string): Promise<string> {
  const outDir = path.join(cwd || os.homedir(), OUTPUT_DIR);
  await fs.mkdir(outDir, { recursive: true });
  const suffix = crypto.randomBytes(4).toString("hex");
  const filename = `image-${Date.now()}-${suffix}.png`;
  return path.join(outDir, filename);
}

// ── Input image helpers ─────────────────────────────────────────

async function resolveInputImagePath(cwd: string, imagePath: string): Promise<{ ok: true; path: string; mimeType: string } | { ok: false; error: string }> {
  const trimmed = imagePath.trim();
  if (!trimmed) return { ok: false, error: "imagePath is empty" };
  const root = path.resolve(cwd || process.cwd());
  const resolved = path.resolve(root, trimmed);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { ok: false, error: `imagePath must stay inside cwd (${root}): ${imagePath}` };
  }
  const ext = path.extname(resolved).toLowerCase();
  const mimeType = IMAGE_MIME_TYPES[ext];
  if (!mimeType) {
    return { ok: false, error: `Unsupported image type "${ext || "none"}". Allowed: png, jpg, jpeg, webp` };
  }
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) return { ok: false, error: `imagePath is not a file: ${imagePath}` };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Cannot read imagePath ${imagePath}: ${msg}` };
  }
  return { ok: true, path: resolved, mimeType };
}

// ── Core image generation ───────────────────────────────────────

interface ImagineParams {
  prompt: string;
  model?: string;
  size?: string;
  quality?: string;
  style?: string;
  imagePath?: string;
  inputFidelity?: string;
}

// 2026-05-24 fix: explicit discriminated-union return type. Without
// the annotation, TS infers `ok: boolean` (not `true | false` literal),
// so the caller's `if (!result.ok) return` cannot narrow the union and
// every subsequent `result.actualSize` / `result.filepath` etc. errors
// as "Property does not exist on type {ok: boolean; error: string} |
// {ok: boolean; filepath; ...}". This was bug 7 in the 6-bug sprint.
type GenerateImageResult =
  | { ok: false; error: string }
  | {
      ok: true;
      filepath: string;
      model: string;
      requestedSize: string | undefined;
      actualSize: string | undefined;
      requestedQuality: string | undefined;
      actualQuality: string | undefined;
      mode: "generate" | "edit";
      imagePath?: string;
      imageBase64?: string;
      mimeType?: "image/png";
    };

async function saveImageResult(
  imageBase64: string,
  params: {
    cwd: string;
    callerSupportsImages: boolean;
    model: string;
    requestedSize: string | undefined;
    actualSize: string | undefined;
    requestedQuality: string | undefined;
    actualQuality: string | undefined;
    mode: "generate" | "edit";
    imagePath?: string;
  },
): Promise<GenerateImageResult> {
  const filepath = await makeOutputPath(params.cwd);
  try {
    await fs.writeFile(filepath, Buffer.from(imageBase64, "base64"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Failed to save image to disk: ${msg}` };
  }

  return {
    ok: true,
    filepath,
    model: params.model,
    requestedSize: params.requestedSize,
    actualSize: params.actualSize,
    requestedQuality: params.requestedQuality,
    actualQuality: params.actualQuality,
    mode: params.mode,
    ...(params.imagePath ? { imagePath: params.imagePath } : {}),
    ...(params.callerSupportsImages
      ? { imageBase64, mimeType: "image/png" as const }
      : {}),
  };
}

async function editImage(
  params: ImagineParams,
  opts: {
    cwd: string;
    callerSupportsImages: boolean;
    signal?: AbortSignal;
    baseUrl: string;
    apiKey: string;
  },
): Promise<GenerateImageResult> {
  const baseUrl = opts.baseUrl.replace(/\/$/, "");
  const model = params.model || loadImagineDefaultModel();
  const inputImage = await resolveInputImagePath(opts.cwd, params.imagePath ?? "");
  if (!inputImage.ok) return { ok: false, error: inputImage.error };

  const styledPrompt = params.style
    ? `${params.prompt}\n\n[Style: ${params.style}]`
    : params.prompt;

  const imageBytes = await fs.readFile(inputImage.path);
  const form = new FormData();
  form.set("model", model);
  form.set("prompt", styledPrompt);
  form.set("image", new Blob([imageBytes], { type: inputImage.mimeType }), path.basename(inputImage.path));
  form.set("output_format", "png");
  if (params.size) form.set("size", params.size);
  if (params.quality) form.set("quality", params.quality);
  if (params.inputFidelity) form.set("input_fidelity", params.inputFidelity);

  const url = `${baseUrl}/v1/images/edits`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      body: form,
      signal: opts.signal,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Image edit network error: ${msg}` };
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "unknown");
    return {
      ok: false,
      error: `Image edit HTTP ${response.status}: ${errText.slice(0, 500)}`,
    };
  }

  const data = (await response.json()) as Record<string, unknown>;
  const output = data.data as Array<Record<string, unknown>> | undefined;
  const imageBase64 = typeof output?.[0]?.b64_json === "string" ? output[0].b64_json : "";
  if (!imageBase64) {
    return {
      ok: false,
      error: `No b64_json image in edit API response. Request was sent to: ${url}`,
    };
  }

  return saveImageResult(imageBase64, {
    cwd: opts.cwd,
    callerSupportsImages: opts.callerSupportsImages,
    model,
    requestedSize: params.size,
    actualSize: data.size as string | undefined,
    requestedQuality: params.quality,
    actualQuality: data.quality as string | undefined,
    mode: "edit",
    imagePath: inputImage.path,
  });
}

async function generateImage(
  params: ImagineParams,
  opts: {
    cwd: string;
    callerSupportsImages: boolean;
    signal?: AbortSignal;
    baseUrl: string;
    apiKey: string;
  },
): Promise<GenerateImageResult> {
  if (params.imagePath) return editImage(params, opts);

  const baseUrl = opts.baseUrl.replace(/\/$/, "");

  // Style is encoded into the prompt — the Responses image_generation_call
  // path does not accept a style API parameter.
  const styledPrompt = params.style
    ? `${params.prompt}\n\n[Style: ${params.style}]`
    : params.prompt;

  const reqBody: Record<string, unknown> = {
    model: params.model || loadImagineDefaultModel(),
    input: styledPrompt,
    // 2026-06-10 fix: stream the response. Image generation regularly takes
    // 60-180s; reverse proxies in front of the endpoint (observed: Caddy in
    // front of sub2api with a 60s response timeout) kill the connection with
    // 504 while the upstream generation completes successfully. With
    // stream:true the headers + SSE events (incl. keepalives) flow
    // immediately, so no intermediary idle/header timeout fires. The full
    // image arrives in the final `response.completed` event.
    stream: true,
  };
  if (params.size && params.size !== "auto") reqBody.size = params.size;
  if (params.quality && params.quality !== "auto") reqBody.quality = params.quality;

  const url = `${baseUrl}/v1/responses`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(reqBody),
      signal: opts.signal,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Image generation network error: ${msg}` };
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "unknown");
    return {
      ok: false,
      error: `Image generation HTTP ${response.status}: ${errText.slice(0, 500)}`,
    };
  }

  // Streamed endpoints answer with text/event-stream; endpoints that ignore
  // `stream` (or proxies that unwrap it) still answer with application/json.
  // Support both: parse SSE for the terminal response.completed event, or
  // fall back to plain JSON.
  const contentType = response.headers.get("content-type") ?? "";
  let data: Record<string, unknown>;
  if (contentType.includes("text/event-stream")) {
    const sse = await readSseTerminalResponse(response.body);
    if (!sse.ok) return { ok: false, error: sse.error };
    data = sse.response;
  } else {
    data = (await response.json()) as Record<string, unknown>;
  }

  let imageBase64 = "";
  let actualSize: string | undefined;
  let actualQuality: string | undefined;

  const output = data?.output as Array<Record<string, unknown>> | undefined;
  for (const item of output ?? []) {
    if (item.type === "image_generation_call" && item.result) {
      imageBase64 = item.result as string;
      actualSize = item.size as string | undefined;
      actualQuality = item.quality as string | undefined;
      break;
    }
  }

  if (!imageBase64) {
    const outputTypes = (output ?? []).map((x: any) => x.type).filter(Boolean).join(", ");
    return {
      ok: false,
      error: `No image_generation_call in API response. Response output types: [${outputTypes || "empty"}]. ` +
        `If using a proxy or non-native OpenAI endpoint, the model may require ` +
        `tools:[{type:"image_generation"}] in the request body. ` +
        `Request was sent to: ${url}`,
    };
  }

  return saveImageResult(imageBase64, {
    cwd: opts.cwd,
    callerSupportsImages: opts.callerSupportsImages,
    model: reqBody.model as string,
    requestedSize: params.size,
    actualSize,
    requestedQuality: params.quality,
    actualQuality,
    mode: "generate",
  });
}

// ── SSE parsing ─────────────────────────────────────────────────

type SseTerminalResult =
  | { ok: true; response: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Read an OpenAI Responses API SSE stream to completion and return the
 * terminal `response.completed` payload's `.response` object (same shape as
 * the non-streaming JSON body). `response.failed` / `response.incomplete` /
 * `error` events map to an error result. Intermediate events (partial
 * images, keepalives, text deltas) are skipped — we only need the final
 * image. AbortSignal propagation: the fetch signal already covers body
 * reads, so no extra wiring is needed here.
 */
async function readSseTerminalResponse(
  body: ReadableStream<Uint8Array> | null,
): Promise<SseTerminalResult> {
  if (!body) return { ok: false, error: "SSE response had no body" };

  const decoder = new TextDecoder("utf-8", { fatal: false });
  let buf = "";
  let eventType = "";
  let dataLines: string[] = [];
  let completed: Record<string, unknown> | undefined;
  let failure: string | undefined;
  const seenTypes = new Set<string>();

  const flushEvent = () => {
    const t = eventType;
    const dataStr = dataLines.join("\n");
    eventType = "";
    dataLines = [];
    if (!t && !dataStr) return;
    if (t) seenTypes.add(t);
    if (
      t !== "response.completed" &&
      t !== "response.failed" &&
      t !== "response.incomplete" &&
      t !== "error"
    ) {
      return;
    }
    try {
      const payload = JSON.parse(dataStr) as Record<string, unknown>;
      if (t === "response.completed") {
        completed = payload.response as Record<string, unknown>;
      } else if (t === "error") {
        failure = `SSE error event: ${dataStr.slice(0, 300)}`;
      } else {
        const resp = payload.response as Record<string, unknown> | undefined;
        const err = (resp?.error ?? payload.error) as
          | { message?: string }
          | undefined;
        failure = `SSE ${t}: ${err?.message ?? dataStr.slice(0, 300)}`;
      }
    } catch {
      failure = failure ?? `SSE ${t} event had unparseable JSON data`;
    }
  };

  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        if (line === "") flushEvent();
        else if (line.startsWith("event:")) eventType = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        // comment lines (":keepalive") and unknown fields are ignored per SSE spec
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  buf += decoder.decode();
  if (dataLines.length > 0 || eventType) flushEvent();

  if (completed) return { ok: true, response: completed };
  if (failure) return { ok: false, error: failure };
  return {
    ok: false,
    error:
      `SSE stream ended without response.completed. ` +
      `Events seen: [${[...seenTypes].join(", ") || "none"}]`,
  };
}

// ── Helpers ─────────────────────────────────────────────────────

function validateEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value).toLowerCase() as T;
  if (allowed.some((a) => a.toLowerCase() === s.toLowerCase())) return s;
  throw new Error(
    `Invalid ${label} "${String(value)}". Allowed: ${allowed.join(", ")}`,
  );
}

// ── Extension entry ─────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Sub-pi enforce ──────────────────────────────────────────
  // ADR 0014 §6: sub-pi should not have image generation.
  if (process.env.PI_ABRAIN_DISABLED === "1") return;

  pi.registerTool({
    name: "imagine",
    label: "AI Image Generation",
    description:
      "Generate images or edit an existing local image via OpenAI image APIs. " +
      "Call when the user asks to create, generate, draw, or image-to-image edit. " +
      "Uses your existing openai provider API key and endpoint — no extra config.",
    promptSnippet: "imagine(prompt, imagePath?, size?, quality?, style?, inputFidelity?, model?)",
    promptGuidelines: [
      "Use imagine when the user asks for image generation, illustration, visual creation, or image-to-image editing.",
      "For image-to-image edits, pass `imagePath` as a local png/jpg/jpeg/webp path inside cwd; imagine will call the OpenAI image edit endpoint and save a new PNG without overwriting the source.",
      "Default model is read from pi-astack-settings.json → imagine.defaultModel. Pass `model` param to override per call. size / quality default to whatever the OpenAI image API picks unless you explicitly pass them; common values are size: 1024x1024 | 1536x1024 | 1024x1536 | 1792x1024 | 1024x1792, quality: auto | low | medium | high | standard | hd.",
      "Use `inputFidelity: high` for edits where preserving the source image's identity, layout, or text matters; omit it for freer edits.",
      "Uses your existing openai provider API key — no additional configuration needed.",
      "The tool saves the PNG to .pi-astack/imagine/ and returns it inline when the caller supports images.",
    ],
    parameters: Type.Object({
      prompt: Type.String({
        description: "Image description/prompt — be detailed and specific",
      }),
      model: Type.Optional(Type.String({
        description: "OpenAI image model id. If omitted, the tool uses pi-astack-settings.json → imagine.defaultModel. If both are absent, the call fails closed.",
      })),
      size: Type.Optional(Type.String({
        description: "Image dimensions. Common values: auto, 1024x1024, 1536x1024, 1024x1536, 1792x1024, 1024x1792.",
      })),
      quality: Type.Optional(Type.String({
        description: "Quality level. Common values: auto, low, medium, high, standard, hd.",
      })),
      style: Type.Optional(Type.String({
        description: "Style hint injected as prompt suffix '[Style: vivid|natural]'. vivid = hyper-real/dramatic, natural = realistic/subdued.",
      })),
      imagePath: Type.Optional(Type.String({
        description: "Local source image path for image-to-image editing. Must be png/jpg/jpeg/webp and stay inside cwd.",
      })),
      inputFidelity: Type.Optional(Type.String({
        description: "Image edit fidelity: low or high. Use high when preserving source layout, identity, or text matters.",
      })),
    }),

    // 2026-05-24 fix: pi SDK 0.75 tightened prepareArguments to
    // (args: unknown) => Static<TParams>. Narrow inside via local
    // helper. Conditional spread for optional fields so the inferred
    // return type doesn't emit `prop: undefined` (incompatible with
    // SDK's `prop?: string` schema-derived shape).
    prepareArguments(rawArgs: unknown) {
      const args =
        rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, unknown>)
          : {};
      const model = args.model ? String(args.model) : undefined;
      const size = validateEnum(args.size, ALLOWED_SIZES, "size");
      const quality = validateEnum(args.quality, ALLOWED_QUALITIES, "quality");
      const style = validateEnum(args.style, ALLOWED_STYLES, "style");
      const imagePath = args.imagePath ? String(args.imagePath) : undefined;
      const inputFidelity = validateEnum(args.inputFidelity, ALLOWED_INPUT_FIDELITIES, "inputFidelity");
      return {
        prompt: String(args.prompt ?? ""),
        ...(model !== undefined ? { model } : {}),
        ...(size !== undefined ? { size } : {}),
        ...(quality !== undefined ? { quality } : {}),
        ...(style !== undefined ? { style } : {}),
        ...(imagePath !== undefined ? { imagePath } : {}),
        ...(inputFidelity !== undefined ? { inputFidelity } : {}),
      };
    },

    // 2026-05-24 fix: explicit `Promise<{...; details: unknown}>` return
    // annotation prevents TS from locking TDetails to the first return's
    // shape (which breaks subsequent returns with different details).
    // Same pattern as memory/index.ts wrapToolResult.
    async execute(
      _id: string,
      params: ImagineParams,
      signal: AbortSignal,
      _onUpdate: unknown,
      // 2026-05-24 fix: ctx widened to match SDK ExtensionContext
      // contravariance. model + modelRegistry are `unknown` because
      // SDK's Model<any> and ModelRegistry are wider than the structural
      // subsets imagine uses; inner code casts to what it actually needs.
      // Same pattern as memory/index.ts.
      ctx: {
        cwd?: string;
        model?: unknown;
        modelRegistry: unknown;
      },
    ): Promise<{ content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; details: unknown; isError?: boolean }> {
      const registry = ctx.modelRegistry as {
        getAll(): Array<{ provider: string; baseUrl: string; api: string }>;
        getApiKeyForProvider(provider: string): Promise<string | undefined>;
      };
      // ── Key + baseUrl both from the existing openai provider ─
      const apiKey = await registry.getApiKeyForProvider("openai");
      if (!apiKey) {
        return {
          content: [{
            type: "text" as const,
            text:
              "❌ No API key configured for the openai provider. " +
              "imagine uses your existing openai provider — the same one your chat models use. " +
              "Configure an API key for the openai provider to enable image generation.",
          }],
          details: { error: "no openai API key" },
          isError: true,
        };
      }

      // Derive the image generation endpoint from the openai provider baseUrl.
      // The provider may use a completions-style baseUrl (https://x.com/v1) or
      // a responses-style one (https://x.com). We need the host root + /v1/responses.
      // Strip /v1 suffix if present to avoid double /v1.
      const allModels = registry.getAll();
      const anyOpenai = allModels.find((m) => m.provider === "openai");
      const raw = anyOpenai?.baseUrl || "https://api.openai.com";
      // Remove trailing slashes, then strip /v1 if it's the last path segment
      const baseUrl = raw.replace(/\/+$/, "").replace(/\/v1$/, "");

      // ── Generate / Edit ───────────────────────────────────
      const model = ctx.model as { input?: string[] } | undefined;
      const callerSupportsImages = !!model?.input?.includes?.("image");

      const result = await generateImage(params, {
        // SDK's ExtensionContext.cwd is required-string, but our widened
        // typing made it optional for contravariance — default to process
        // cwd for the rare case it's missing.
        cwd: ctx.cwd ?? process.cwd(),
        callerSupportsImages,
        signal,
        baseUrl,
        apiKey,
      });

      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: `❌ ${result.error}` }],
          details: { error: result.error },
          isError: true,
        };
      }

      const sizeInfo = result.actualSize ?? result.requestedSize ?? "default";
      const qualityInfo = result.actualQuality ?? result.requestedQuality ?? "default";
      const text =
        `✅ Image saved: ${result.filepath}\n` +
        `Mode: ${result.mode} | Model: ${result.model} | Size: ${sizeInfo} | Quality: ${qualityInfo}` +
        (result.imagePath ? `\nSource: ${result.imagePath}` : "");

      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
        { type: "text" as const, text },
      ];
      if (result.imageBase64 && result.mimeType) {
        content.push({
          type: "image" as const,
          data: result.imageBase64,
          mimeType: result.mimeType,
        });
      }

      return {
        content,
        details: {
          model: result.model,
          requestedSize: result.requestedSize,
          actualSize: result.actualSize,
          requestedQuality: result.requestedQuality,
          actualQuality: result.actualQuality,
          mode: result.mode,
          sourcePath: result.imagePath,
          path: result.filepath,
        },
      };
    },
  });
}
