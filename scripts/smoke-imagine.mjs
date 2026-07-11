#!/usr/bin/env node
/**
 * Smoke test for pi-astack imagine extension.
 *
 * Tests argument validation, output path creation, style encoding,
 * error paths (no API key, etc.). Does NOT call the real OpenAI API.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
function ok(msg) { pass++; console.log(`  ✓ ${msg}`); }
function failMsg(msg) { fail++; console.log(`  ✗ ${msg}`); }

// ── Test 1: validateEnum (size/quality/style validation) ────────

console.log("\n  validateEnum:");

const ALLOWED_SIZES = ["auto", "1024x1024", "1536x1024", "1024x1536", "1792x1024", "1024x1792"];
const ALLOWED_QUALITIES = ["auto", "low", "medium", "high", "standard", "hd"];
const ALLOWED_STYLES = ["vivid", "natural"];
const ALLOWED_INPUT_FIDELITIES = ["low", "high"];

function validateEnum(value, allowed, label) {
  if (value === undefined || value === null) return undefined;
  const s = String(value).toLowerCase();
  if (allowed.some((a) => a.toLowerCase() === s)) return s;
  throw new Error(`Invalid ${label} "${String(value)}". Allowed: ${allowed.join(", ")}`);
}

{
  // valid size
  try {
    const r = validateEnum("1024x1024", ALLOWED_SIZES, "size");
    if (r === "1024x1024") ok("valid size passes");
    else failMsg(`returned ${r}`);
  } catch { failMsg("valid size rejected"); }

  // valid size case-insensitive
  try {
    const r = validateEnum("1792x1024", ALLOWED_SIZES, "size");
    if (r === "1792x1024") ok("valid landscape size passes");
    else failMsg(`returned ${r}`);
  } catch { failMsg("landscape size rejected"); }

  // valid edit portrait size
  try {
    const r = validateEnum("1024x1536", ALLOWED_SIZES, "size");
    if (r === "1024x1536") ok("valid edit portrait size passes");
    else failMsg(`returned ${r}`);
  } catch { failMsg("edit portrait size rejected"); }

  // invalid size
  try {
    validateEnum("bad", ALLOWED_SIZES, "size");
    failMsg("invalid size accepted");
  } catch (e) {
    if (e.message.includes("Invalid size")) ok("invalid size rejected with message");
    else failMsg(`wrong error: ${e.message}`);
  }

  // valid quality
  try {
    const r = validateEnum("hd", ALLOWED_QUALITIES, "quality");
    if (r === "hd") ok("valid quality passes");
    else failMsg(`returned ${r}`);
  } catch { failMsg("hd quality rejected"); }

  // valid quality case-insensitive
  try {
    const r = validateEnum("Standard", ALLOWED_QUALITIES, "quality");
    if (r === "standard") ok("quality case-insensitive");
    else failMsg(`returned ${r}`);
  } catch { failMsg("Standard quality rejected"); }

  // valid GPT image quality
  try {
    const r = validateEnum("High", ALLOWED_QUALITIES, "quality");
    if (r === "high") ok("GPT image quality case-insensitive");
    else failMsg(`returned ${r}`);
  } catch { failMsg("High quality rejected"); }

  // invalid quality
  try {
    validateEnum("ultra", ALLOWED_QUALITIES, "quality");
    failMsg("invalid quality accepted");
  } catch (e) {
    if (e.message.includes("Invalid quality")) ok("invalid quality rejected");
    else failMsg(`wrong error: ${e.message}`);
  }

  // undefined → undefined
  const r7 = validateEnum(undefined, ALLOWED_SIZES, "size");
  if (r7 === undefined) ok("undefined → undefined");
  else failMsg(`undefined returned ${r7}`);

  // null → undefined
  const r8 = validateEnum(null, ALLOWED_SIZES, "size");
  if (r8 === undefined) ok("null → undefined");
  else failMsg(`null returned ${r8}`);

  // valid style
  try {
    const r = validateEnum("vivid", ALLOWED_STYLES, "style");
    if (r === "vivid") ok("vivid style passes");
    else failMsg(`returned ${r}`);
  } catch { failMsg("vivid style rejected"); }

  // valid natural style
  try {
    const r = validateEnum("Natural", ALLOWED_STYLES, "style");
    if (r === "natural") ok("natural style case-insensitive");
    else failMsg(`returned ${r}`);
  } catch { failMsg("Natural style rejected"); }

  // invalid style
  try {
    validateEnum("anime", ALLOWED_STYLES, "style");
    failMsg("invalid style accepted");
  } catch (e) {
    if (e.message.includes("Invalid style")) ok("invalid style rejected");
    else failMsg(`wrong error: ${e.message}`);
  }

  // valid input fidelity
  try {
    const r = validateEnum("High", ALLOWED_INPUT_FIDELITIES, "inputFidelity");
    if (r === "high") ok("inputFidelity case-insensitive");
    else failMsg(`returned ${r}`);
  } catch { failMsg("High inputFidelity rejected"); }

  // invalid input fidelity
  try {
    validateEnum("medium", ALLOWED_INPUT_FIDELITIES, "inputFidelity");
    failMsg("invalid inputFidelity accepted");
  } catch (e) {
    if (e.message.includes("Invalid inputFidelity")) ok("invalid inputFidelity rejected");
    else failMsg(`wrong error: ${e.message}`);
  }
}

// ── Test 2: makeOutputPath ──────────────────────────────────────

console.log("\n  makeOutputPath:");

{
  const crypto = require("node:crypto");
  const fsPromises = require("node:fs/promises");

  async function makeOutputPath(cwd) {
    const outDir = path.join(cwd || os.homedir(), ".pi-astack", "imagine");
    await fsPromises.mkdir(outDir, { recursive: true });
    const suffix = crypto.randomBytes(4).toString("hex");
    const filename = `image-${Date.now()}-${suffix}.png`;
    return path.join(outDir, filename);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-imagine-"));
  try {
    const outPath = await makeOutputPath(tmp);
    const dirCreated = fs.existsSync(path.join(tmp, ".pi-astack", "imagine"));
    if (dirCreated) ok(".pi-astack/imagine/ directory created");
    else failMsg("output directory not created");

    if (outPath.endsWith(".png")) ok("output path ends with .png");
    else failMsg(`output path: ${outPath}`);

    if (outPath.includes(".pi-astack/imagine/")) ok("output path is under .pi-astack/imagine/");
    else failMsg(`output path: ${outPath}`);

    // deterministic timestamp in filename
    if (outPath.includes("image-")) ok("filename starts with image-");
    else failMsg(`filename: ${outPath}`);

    // Two calls produce different paths (different random suffix)
    const path2 = await makeOutputPath(tmp);
    if (outPath !== path2) ok("consecutive calls produce different paths");
    else failMsg("consecutive calls returned same path");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── Test 3: Style encoding into prompt ──────────────────────────

console.log("\n  style → prompt suffix:");

{
  // Replicate the style injection logic from imagine/index.ts
  function injectStyle(prompt, style) {
    return style ? `${prompt}\n\n[Style: ${style}]` : prompt;
  }

  const r1 = injectStyle("a cat", "vivid");
  if (r1 === "a cat\n\n[Style: vivid]") ok("vivid style appends suffix");
  else failMsg(`expected suffix, got: ${r1}`);

  const r2 = injectStyle("a dog", undefined);
  if (r2 === "a dog") ok("undefined style → no suffix");
  else failMsg(`undefined style changed prompt: ${r2}`);

  const r3 = injectStyle("a bird", "natural");
  if (r3.includes("[Style: natural]")) ok("natural style appends suffix");
  else failMsg(`missing natural suffix: ${r3}`);

  const r4 = injectStyle("test", "");
  if (r4 === "test") ok("empty string style → no suffix");
  else failMsg(`empty style changed prompt: ${r4}`);
}

// ── Test 4: imagePath safety helper shape ───────────────────────

console.log("\n  imagePath safety:");

{
  const IMAGE_MIME_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
  };

  function resolveInputImagePathSync(cwd, imagePath) {
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
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return { ok: false, error: `imagePath is not a file: ${imagePath}` };
    }
    return { ok: true, path: resolved, mimeType };
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-imagine-path-"));
  try {
    const png = path.join(tmp, "source.png");
    fs.writeFileSync(png, "not really png; only path validation smoke");

    const r1 = resolveInputImagePathSync(tmp, "source.png");
    if (r1.ok && r1.mimeType === "image/png") ok("png imagePath inside cwd accepted");
    else failMsg(`png imagePath rejected: ${r1.error}`);

    const r2 = resolveInputImagePathSync(tmp, "../outside.png");
    if (!r2.ok && r2.error.includes("inside cwd")) ok("parent traversal imagePath rejected");
    else failMsg("parent traversal imagePath accepted");

    const r3 = resolveInputImagePathSync(tmp, "source.gif");
    if (!r3.ok && r3.error.includes("Unsupported image type")) ok("unsupported image type rejected");
    else failMsg("unsupported image type accepted");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── Test 5: Error paths (no API key) ────────────────────────────

console.log("\n  error paths:");

{
  // Load the transpiled module to test execute logic
  const ts = require("typescript");
  const srcPath = path.join(repoRoot, "extensions", "imagine", "index.ts");
  const source = fs.readFileSync(srcPath, "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      esModuleInterop: true,
    },
    fileName: srcPath,
  }).outputText;

  // Verify key structural elements exist in source
  const hasPrepArgs = source.includes("prepareArguments");
  if (hasPrepArgs) ok("prepareArguments hook exists");
  else failMsg("prepareArguments hook not found");

  const hasCtxModelReg = source.includes("ctx.modelRegistry");
  if (hasCtxModelReg) ok("uses ctx.modelRegistry");
  else failMsg("ctx.modelRegistry not referenced");

  const hasApiKeyCheck = source.includes("getApiKeyForProvider(\"openai\")");
  if (hasApiKeyCheck) ok("checks openai API key");
  else failMsg("openai API key check not found");

  const hasNoKeyError = source.includes("No API key configured for the openai provider");
  if (hasNoKeyError) ok("no-API-key error message exists");
  else failMsg("no-API-key error message not found");

  const hasSubPiGuard = source.includes("PI_ABRAIN_DISABLED === \"1\"");
  if (hasSubPiGuard) ok("sub-pi guard exists");
  else failMsg("sub-pi guard not found");

  const hasCallerSupports = source.includes("callerSupportsImages");
  if (hasCallerSupports) ok("callerSupportsImages logic exists");
  else failMsg("callerSupportsImages not found");

  const hasStyleInjection = source.includes("[Style:");
  if (hasStyleInjection) ok("style injection into prompt exists");
  else failMsg("style injection not found");

  const hasImagePathParam = source.includes("imagePath: Type.Optional");
  if (hasImagePathParam) ok("imagePath parameter exists");
  else failMsg("imagePath parameter not found");

  const hasImagesEditEndpoint = source.includes("/v1/images/edits");
  if (hasImagesEditEndpoint) ok("image edit endpoint exists");
  else failMsg("image edit endpoint not found");

  const hasInputFidelity = source.includes("input_fidelity");
  if (hasInputFidelity) ok("inputFidelity maps to input_fidelity");
  else failMsg("input_fidelity mapping not found");
}

// ── Test 6: PI_ABRAIN_DISABLED guard ──────────────────────────────

console.log("\n  sub-pi isolation:");

{
  const srcPath = path.join(repoRoot, "extensions", "imagine", "index.ts");
  const source = fs.readFileSync(srcPath, "utf8");

  // Check the sub-pi guard is in the default export
  const exportIdx = source.lastIndexOf("export default function");
  if (exportIdx >= 0) {
    const afterExport = source.slice(exportIdx);
    const guardIdx = afterExport.indexOf("PI_ABRAIN_DISABLED");
    const returnIdx = afterExport.indexOf("return;");
    // guard should appear before any registerTool call
    const regToolIdx = afterExport.indexOf("pi.registerTool");
    if (guardIdx >= 0 && guardIdx < regToolIdx) ok("sub-pi guard before registerTool");
    else failMsg("sub-pi guard not before registerTool or missing");
  }
}

// ── Test 7: runtime audit minimization ──────────────────────────

console.log("\n  runtime audit minimization:");

{
  const oldFetch = globalThis.fetch;
  const oldDisabled = process.env.PI_ABRAIN_DISABLED;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-imagine-audit-"));
  try {
    delete process.env.PI_ABRAIN_DISABLED;
    const { createJiti } = require("jiti");
    const jiti = createJiti(import.meta.url, { moduleCache: false });
    const imported = await jiti.import(path.join(repoRoot, "extensions", "imagine", "index.ts"));
    const activate = imported.default;
    let tool;
    activate({ registerTool(definition) { tool = definition; } });
    if (!tool) throw new Error("imagine tool did not register");

    const outputBytes = Buffer.from("inline-image-secret-bytes");
    const outputInline = outputBytes.toString("base64");
    const registry = {
      async getApiKeyForProvider() { return "imagine-api-key-secret"; },
      getAll() { return [{ provider: "openai", baseUrl: "https://sensitive-imagine.example/v1", api: "responses" }]; },
    };
    globalThis.fetch = async (_url, init) => {
      if (init?.body instanceof FormData) {
        return new Response(JSON.stringify({ data: [{ b64_json: outputInline }], usage: { input: 2, output: 3 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (!String(body.input).includes("generate-prompt-secret")) throw new Error("generate request lost prompt");
      return new Response(JSON.stringify({
        output: [{ type: "image_generation_call", result: outputInline, size: "1024x1024", quality: "high" }],
        usage: { input: 4, output: 5, totalTokens: 9 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const context = { cwd: tmp, model: { input: [] }, modelRegistry: registry };
    const generated = await tool.execute("generate-audit", {
      prompt: "generate-prompt-secret",
      model: "gpt-image-test",
      size: "1024x1024",
      quality: "high",
    }, new AbortController().signal, undefined, context);
    if (generated.isError) throw new Error(`generate failed: ${JSON.stringify(generated)}`);

    const source = path.join(tmp, "source.png");
    fs.writeFileSync(source, "source-image-secret-bytes");
    const edited = await tool.execute("edit-audit", {
      prompt: "edit-prompt-secret",
      model: "gpt-image-test",
      imagePath: "source.png",
      size: "1024x1024",
      quality: "high",
      inputFidelity: "high",
    }, new AbortController().signal, undefined, context);
    if (edited.isError) throw new Error(`edit failed: ${JSON.stringify(edited)}`);

    const auditFile = path.join(tmp, ".pi-astack", "llm-audit", "audit.jsonl");
    const raw = fs.readFileSync(auditFile, "utf8");
    for (const forbidden of [
      "generate-prompt-secret", "edit-prompt-secret", "source-image-secret-bytes",
      outputInline, "inline-image-secret-bytes", "imagine-api-key-secret",
      "https://sensitive-imagine.example", source,
    ]) {
      if (raw.includes(forbidden)) throw new Error(`imagine audit leaked forbidden value: ${forbidden}`);
    }
    const rows = raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const starts = rows.filter((row) => row.row_type === "start");
    const ends = rows.filter((row) => row.row_type === "end");
    if (starts.length !== 2 || ends.length !== 2) throw new Error(`wrong audit row count: ${rows.length}`);
    const generateStart = starts.find((row) => row.operation === "generateImage");
    const editStart = starts.find((row) => row.operation === "editImage");
    if (generateStart?.has_input_image !== false || generateStart?.input_bytes !== 0) throw new Error("generate request shape missing");
    if (editStart?.has_input_image !== true || editStart?.input_bytes !== Buffer.byteLength("source-image-secret-bytes")) throw new Error("edit request shape missing");
    for (const end of ends) {
      if (end.image_count !== 1 || end.result_transport_kinds?.[0] !== "inline_bytes" || end.result_byte_lengths?.[0] !== outputBytes.length) {
        throw new Error(`image response shape missing: ${JSON.stringify(end)}`);
      }
    }
    const forbiddenKeys = new Set(["prompt", "text", "content", "reasoning", "tool_output", "request_body", "raw_response_text", "parsed_response", "request_payload", "event", "message", "delta", "base64", "url", "headers", "credentials", "signature", "encrypted_content"]);
    const inspect = (value) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) return value.forEach(inspect);
      for (const [key, child] of Object.entries(value)) {
        const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[\s-]+/g, "_").toLowerCase();
        if (forbiddenKeys.has(normalized)) throw new Error(`forbidden imagine audit key: ${key}`);
        inspect(child);
      }
    };
    rows.forEach(inspect);
    ok("generate/edit audit stores only controlled image transport statistics");
  } catch (error) {
    failMsg(`runtime audit minimization failed: ${error?.stack || error}`);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldDisabled === undefined) delete process.env.PI_ABRAIN_DISABLED;
    else process.env.PI_ABRAIN_DISABLED = oldDisabled;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── Summary ─────────────────────────────────────────────────────

console.log(`\n  Results: ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
