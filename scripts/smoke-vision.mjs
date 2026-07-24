#!/usr/bin/env node
/**
 * Smoke test for pi-astack vision extension.
 *
 * Tests the security-critical path validation logic and error paths.
 * Does NOT call real vision APIs — uses transpiled module logic with
 * mocked dependencies.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

let pass = 0;
let fail = 0;
function ok(msg) { pass++; console.log(`  ✓ ${msg}`); }
function failMsg(msg) { fail++; console.log(`  ✗ ${msg}`); }

// ── Transpile vision/index.ts to CJS ────────────────────────────

function transpile(srcPath) {
  const source = fs.readFileSync(srcPath, "utf8");
  return ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      esModuleInterop: true,
    },
    fileName: srcPath,
  }).outputText;
}

const visionSrc = path.join(repoRoot, "extensions", "vision", "index.ts");
// Minimal real 1×1 PNG (binary fixture — not a string pretending to be PNG).
const REAL_PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
if (REAL_PNG_1X1[0] !== 0x89 || REAL_PNG_1X1.subarray(1, 4).toString("ascii") !== "PNG") {
  console.error("REAL_PNG_1X1 fixture is not a valid PNG");
  process.exit(1);
}

let moduleExports;
let prodValidateImagePath;
let prodResolveImage;
let prodIsPathInside;
try {
  // Append smoke-only exports so tests exercise production functions without
  // widening the production API surface of vision/index.ts.
  const code =
    transpile(visionSrc) +
    "\n// smoke-only exports (not part of production API)\n" +
    "exports.__smokeValidateImagePath = validateImagePath;\n" +
    "exports.__smokeResolveImage = resolveImage;\n" +
    "exports.__smokeIsPathInside = isPathInside;\n";
  // Wrap to extract exports / top-level functions we want to test
  // We use a VM context to avoid polluting global scope
  const vm = require("node:vm");
  const exportBag = {};
  const ctx = {
    require: (m) => {
      // Real fs/promises so production resolveImage actually reads file bytes.
      if (m === "node:fs/promises") return fs.promises;
      if (m === "node:fs") return fs;
      if (m === "node:os") return os;
      if (m === "node:path") return path;
      if (m === "node:crypto") return require("node:crypto");
      if (m === "../_shared/llm-audit") return {
        auditStreamSimple: async (_projectRoot, _meta, piAi, model, opts, config) => piAi.streamSimple(model, opts, config).result(),
      };
      if (m === "typebox") return {
        Type: {
          Object: () => ({}),
          String: () => ({}),
          Optional: () => ({}),
        },
      };
      throw new Error(`unexpected require: ${m}`);
    },
    process: { cwd: () => os.tmpdir(), env: { PI_ABRAIN_DISABLED: "1" }, platform: process.platform },
    console,
    setTimeout,
    clearTimeout,
    Buffer,
    exports: exportBag,
    module: { exports: exportBag },
    __dirname: path.dirname(visionSrc),
    __filename: visionSrc,
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename: visionSrc });
  moduleExports = ctx.module.exports;
  prodValidateImagePath = moduleExports.__smokeValidateImagePath;
  prodResolveImage = moduleExports.__smokeResolveImage;
  prodIsPathInside = moduleExports.__smokeIsPathInside;
  if (
    typeof prodValidateImagePath !== "function" ||
    typeof prodResolveImage !== "function" ||
    typeof prodIsPathInside !== "function"
  ) {
    throw new Error(
      "smoke-only production exports missing " +
      `(validateImagePath=${typeof prodValidateImagePath}, resolveImage=${typeof prodResolveImage}, isPathInside=${typeof prodIsPathInside})`,
    );
  }
} catch (err) {
  console.error(`Failed to transpile/load vision/index.ts: ${err.message}`);
  process.exit(1);
}

// ── Test 1: validateImagePath (security-critical) ────────────────

// Re-implement validateImagePath locally from the source to test it
// (it's a pure function, not exported)

const ALLOWED_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const EXT_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function isPathInside(abs, root, pathApi = path) {
  const sep = pathApi.sep;
  let a = abs;
  let r = root;
  if (sep === "\\") {
    a = a.toLowerCase();
    r = r.toLowerCase();
  }
  const rootWithSep = r.endsWith(sep) ? r : r + sep;
  return a === r || a.startsWith(rootWithSep);
}

function validateImagePath(userPath, cwd) {
  const ext = path.extname(userPath).toLowerCase();
  if (!ALLOWED_IMAGE_EXTS.has(ext)) {
    return { ok: false, error: `Image path extension "${ext || "(none)"}" not allowed.` };
  }
  const rootRaw = path.resolve(cwd ?? process.cwd());
  const absRaw = path.resolve(rootRaw, userPath);
  const tmpRawList =
    process.platform === "win32"
      ? [path.resolve(os.tmpdir())]
      : [...new Set([path.resolve(os.tmpdir()), path.resolve("/tmp")])];
  let root, abs;
  const tmpRoots = [];
  try { root = fs.realpathSync(rootRaw); } catch { root = rootRaw; }
  try { abs = fs.realpathSync(absRaw); } catch { abs = absRaw; }
  for (const tmpRaw of tmpRawList) {
    try { tmpRoots.push(fs.realpathSync(tmpRaw)); } catch { tmpRoots.push(tmpRaw); }
  }
  if (!isPathInside(abs, root) && !tmpRoots.some((tmpRoot) => isPathInside(abs, tmpRoot))) {
    return { ok: false, error: `Image path resolves outside the project root and system temporary directory.` };
  }
  return { ok: true, abs, ext };
}

console.log("\n  validateImagePath (security):");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-vision-"));
  const imgFile = path.join(tmp, "test.png");
  fs.writeFileSync(imgFile, "fake");

  // valid extension
  const r1 = validateImagePath("test.png", tmp);
  if (r1.ok) ok("accepts .png extension");
  else failMsg(`rejected .png: ${r1.error}`);

  // valid .jpg
  const r1b = validateImagePath("photo.jpg", tmp);
  if (r1b.ok) ok("accepts .jpg extension");
  else failMsg(`rejected .jpg: ${r1b.error}`);

  // valid .webp
  const r1c = validateImagePath("img.webp", tmp);
  if (r1c.ok) ok("accepts .webp extension");
  else failMsg(`rejected .webp: ${r1c.error}`);

  // valid .gif
  const r1d = validateImagePath("anim.gif", tmp);
  if (r1d.ok) ok("accepts .gif extension");
  else failMsg(`rejected .gif: ${r1d.error}`);

  // reject .txt
  const r2 = validateImagePath("secret.txt", tmp);
  if (!r2.ok && r2.error.includes("not allowed")) ok("rejects .txt extension");
  else failMsg(`accepted .txt or wrong error: ${JSON.stringify(r2)}`);

  // reject .js
  const r3 = validateImagePath("evil.js", tmp);
  if (!r3.ok) ok("rejects .js extension");
  else failMsg("accepted .js");

  // reject no extension
  const r4 = validateImagePath("noext", tmp);
  if (!r4.ok) ok("rejects path without extension");
  else failMsg("accepted no-extension path");

  // reject path traversal
  const r5 = validateImagePath("../../../etc/passwd.png", tmp);
  if (!r5.ok && r5.error.includes("outside")) ok("rejects path traversal");
  else failMsg(`accepted traversal or wrong error: ${JSON.stringify(r5)}`);

  // reject absolute path outside cwd
  const r6 = validateImagePath("/etc/hostname.png", tmp);
  if (!r6.ok && r6.error.includes("outside")) ok("rejects absolute path outside cwd");
  else failMsg(`accepted outside absolute path: ${JSON.stringify(r6)}`);

  // reject .html
  const r7 = validateImagePath("page.html", tmp);
  if (!r7.ok) ok("rejects .html extension");
  else failMsg("accepted .html");

  // reject .svg (not in allowlist)
  const r8 = validateImagePath("icon.svg", tmp);
  if (!r8.ok) ok("rejects .svg (not in allowlist)");
  else failMsg("accepted .svg");

  fs.rmSync(tmp, { recursive: true, force: true });
}

// Project root deliberately outside os.tmpdir() so temp-dir allowance is not
// conflated with ordinary project-root containment (mkdtemp under os.tmpdir
// often IS the system temp). These cases call the production validateImagePath
// from extensions/vision/index.ts (smoke-only export), not the local reimpl.
console.log("\n  production validateImagePath (system temp allowance + escape defense):");
{
  const sysTmp = os.tmpdir();
  const project = fs.mkdtempSync(path.join(os.homedir(), ".smoke-vision-proj-"));
  const outsideHome = fs.mkdtempSync(path.join(os.homedir(), ".smoke-vision-out-"));
  const tmpImg = path.join(sysTmp, `smoke-vision-allow-${process.pid}-${Date.now()}.png`);
  const outsideImg = path.join(outsideHome, "secret.png");
  const escapeLink = path.join(sysTmp, `smoke-vision-escape-${process.pid}-${Date.now()}.png`);
  const tmpLookalike = (sysTmp.endsWith(path.sep) ? sysTmp.slice(0, -1) : sysTmp) + "-not-really";
  const lookalikeImg = path.join(tmpLookalike, "evil.png");
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { fs.rmSync(project, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(outsideHome, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpImg); } catch { /* ignore */ }
    try { fs.unlinkSync(escapeLink); } catch { /* ignore */ }
  };

  try {
    fs.writeFileSync(tmpImg, REAL_PNG_1X1);
    fs.writeFileSync(outsideImg, REAL_PNG_1X1);

    // success: absolute image under real system temp while cwd is a non-temp project
    const rTmp = prodValidateImagePath(tmpImg, project);
    if (rTmp.ok && rTmp.abs === fs.realpathSync(tmpImg)) ok("production accepts real image under system temp dir");
    else failMsg(`production rejected system-temp image: ${JSON.stringify(rTmp)}`);

    // reject: path outside both project root and system temp
    const rOut = prodValidateImagePath(outsideImg, project);
    if (!rOut.ok && rOut.error.includes("outside")) ok("production rejects path outside project and system temp");
    else failMsg(`production accepted outside path: ${JSON.stringify(rOut)}`);

    // reject: temp-dir symlink whose realpath target escapes allowed roots.
    // On Windows, creating a file symlink often needs admin/Developer Mode;
    // only EPERM/EACCES/ENOSYS are visible skips — other errors still fail.
    let symlinkReady = false;
    try {
      fs.symlinkSync(outsideImg, escapeLink);
      symlinkReady = true;
    } catch (e) {
      const code = e && e.code;
      if (process.platform === "win32" && (code === "EPERM" || code === "EACCES" || code === "ENOSYS")) {
        ok(`skip temp symlink escape on Windows (${code}: cannot create file symlink)`);
      } else {
        failMsg(`temp symlink setup failed: ${code || e.message}`);
      }
    }
    if (symlinkReady) {
      const rEsc = prodValidateImagePath(escapeLink, project);
      if (!rEsc.ok && rEsc.error.includes("outside")) ok("production rejects temp-dir symlink escape after realpath");
      else failMsg(`production accepted temp-dir symlink escape: ${JSON.stringify(rEsc)}`);
    }

    // prefix guard: <tmpdir>-not-really is not under system temp
    const rPrefix = prodValidateImagePath(lookalikeImg, project);
    if (!rPrefix.ok && rPrefix.error.includes("outside")) ok("production rejects system-temp prefix lookalike");
    else failMsg(`production accepted system-temp prefix lookalike: ${JSON.stringify(rPrefix)}`);
  } finally {
    cleanup();
  }
}

// ── Test 2: scoreByPrefs (model selection) ──────────────────────

console.log("\n  scoreByPrefs (model selection):");

const DEFAULT_VISION_PREFS = [
  "provider-a/model-a",
  "provider-b/model-b",
  "provider-b/model-c",
  "provider-c/model-d",
];

function scoreByPrefs(m, prefs) {
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

{
  // top preference gets score 0
  const s1 = scoreByPrefs({ provider: "provider-a", id: "model-a" }, DEFAULT_VISION_PREFS);
  if (s1 === 0) ok("top preference gets score 0");
  else failMsg(`expected 0, got ${s1}`);

  // second preference gets score 1
  const s2 = scoreByPrefs({ provider: "provider-b", id: "model-b-20250701" }, DEFAULT_VISION_PREFS);
  if (s2 === 1) ok("version-tolerant preference gets score 1");
  else failMsg(`expected 1, got ${s2}`);

  // unmatched model gets prefs.length
  const s3 = scoreByPrefs({ provider: "meta", id: "llama-4" }, DEFAULT_VISION_PREFS);
  if (s3 === DEFAULT_VISION_PREFS.length) ok("unmatched model gets prefs.length");
  else failMsg(`expected ${DEFAULT_VISION_PREFS.length}, got ${s3}`);

  // case-insensitive id match (id is lowercase-normalized inside scoreByPrefs)
  const s4 = scoreByPrefs({ provider: "provider-a", id: "MODEL-A" }, DEFAULT_VISION_PREFS);
  if (s4 === 0) ok("case-insensitive id match");
  else failMsg(`expected 0, got ${s4}`);

  // exact provider check (provider names from registry are always lowercase)
  const s5 = scoreByPrefs({ provider: "provider-a", id: "model-b" }, DEFAULT_VISION_PREFS);
  if (s5 === DEFAULT_VISION_PREFS.length) ok("provider mismatch → not matched");
  else failMsg(`expected ${DEFAULT_VISION_PREFS.length}, got ${s5}`);
}

// ── Test 3: resolveImage error paths ────────────────────────────

console.log("\n  resolveImage (error paths):");

async function resolveImage(input, cwd) {
  let imageBase64 = input.imageBase64;
  let mimeType = input.mimeType || "image/png";

  if (input.path && !imageBase64) {
    const validation = validateImagePath(input.path, cwd);
    if ("ok" in validation && !validation.ok) return validation;

    try {
      const buf = await fs.promises.readFile(validation.abs);
      imageBase64 = buf.toString("base64");
      mimeType = EXT_MIME[validation.ext] || "image/png";
    } catch (e) {
      return { ok: false, error: `Failed to read image file: ${e.message}` };
    }
  }

  if (!imageBase64) {
    return { ok: false, error: "No image provided." };
  }

  return { base64: imageBase64, mimeType };
}

{
  // base64 input works
  const r1 = await resolveImage({ imageBase64: "aaaa", prompt: "test" }, os.tmpdir());
  if (r1.ok || r1.base64) ok("base64 input resolves");
  else failMsg(`base64 input failed: ${r1.error}`);

  // no input at all → error
  const r2 = await resolveImage({ prompt: "test" }, os.tmpdir());
  if (!r2.ok) ok("no input → error");
  else failMsg("no input should error");

  // non-existent file → error
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-vision-"));
  const r3 = await resolveImage({ path: "nonexistent.png", prompt: "test" }, tmp);
  if (!r3.ok && r3.error.includes("Failed to read")) ok("missing file → read error");
  else failMsg(`missing file: ${JSON.stringify(r3)}`);

  // invalid extension on path
  const r4 = await resolveImage({ path: "bad.txt", prompt: "test" }, tmp);
  if (!r4.ok && r4.error.includes("not allowed")) ok("bad extension on path → rejected");
  else failMsg(`bad extension: ${JSON.stringify(r4)}`);

  // valid file
  const imgFile = path.join(tmp, "real.png");
  fs.writeFileSync(imgFile, "fake-png-data");
  const r5 = await resolveImage({ path: "real.png", prompt: "test" }, tmp);
  if (r5.ok || r5.base64) ok("valid file resolves to base64");
  else failMsg(`valid file: ${JSON.stringify(r5)}`);

  // base64 takes priority over path
  const r6 = await resolveImage({ imageBase64: "bbbb", path: "real.png", prompt: "test" }, tmp);
  if (r6.ok || r6.base64 === "bbbb") ok("base64 takes priority over path");
  else failMsg(`priority: ${JSON.stringify(r6)}`);

  fs.rmSync(tmp, { recursive: true, force: true });
}

// Production resolveImage (system-temp read path) — calls the transpiled vision
// module with real fs/promises so file bytes are actually loaded from disk.
console.log("\n  production resolveImage (system temp real PNG read):");
{
  const sysTmp = os.tmpdir();
  const project = fs.mkdtempSync(path.join(os.homedir(), ".smoke-vision-resolve-"));
  const outsideHome = fs.mkdtempSync(path.join(os.homedir(), ".smoke-vision-resolve-out-"));
  const tmpImg = path.join(sysTmp, `smoke-vision-resolve-${process.pid}-${Date.now()}.png`);
  const outsideImg = path.join(outsideHome, "secret.png");
  const escapeLink = path.join(sysTmp, `smoke-vision-resolve-escape-${process.pid}-${Date.now()}.png`);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { fs.rmSync(project, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(outsideHome, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpImg); } catch { /* ignore */ }
    try { fs.unlinkSync(escapeLink); } catch { /* ignore */ }
  };

  try {
    // Runtime-created real PNG under system temp; project cwd is deliberately not under it.
    fs.writeFileSync(tmpImg, REAL_PNG_1X1);
    fs.writeFileSync(outsideImg, REAL_PNG_1X1);
    const onDisk = await fs.promises.readFile(tmpImg);
    if (!onDisk.equals(REAL_PNG_1X1)) {
      failMsg("on-disk system-temp PNG bytes do not match fixture");
    } else {
      ok("wrote real PNG bytes under system temp dir");
    }

    const expected = REAL_PNG_1X1.toString("base64");
    const r7 = await prodResolveImage({ path: tmpImg, prompt: "test" }, project);
    if (r7 && !("ok" in r7 && r7.ok === false) && r7.base64 === expected && r7.mimeType === "image/png") {
      ok("production resolveImage reads real system-temp PNG from non-temp cwd");
    } else {
      failMsg(`production system-temp resolveImage: ${JSON.stringify(r7)}`);
    }

    // reject: outside both project and system temp must not resolve through production path
    const rOut = await prodResolveImage({ path: outsideImg, prompt: "test" }, project);
    if (rOut && rOut.ok === false && String(rOut.error || "").includes("outside")) {
      ok("production resolveImage rejects path outside project and system temp");
    } else {
      failMsg(`production resolveImage accepted outside path: ${JSON.stringify(rOut)}`);
    }

    // reject: temp-dir symlink escape must not load outside bytes.
    // Windows file-symlink privilege failures are visible skips only for EPERM/EACCES/ENOSYS.
    let symlinkReady = false;
    try {
      fs.symlinkSync(outsideImg, escapeLink);
      symlinkReady = true;
    } catch (e) {
      const code = e && e.code;
      if (process.platform === "win32" && (code === "EPERM" || code === "EACCES" || code === "ENOSYS")) {
        ok(`skip resolveImage temp symlink escape on Windows (${code}: cannot create file symlink)`);
      } else {
        failMsg(`resolveImage temp symlink setup failed: ${code || e.message}`);
      }
    }
    if (symlinkReady) {
      const rEsc = await prodResolveImage({ path: escapeLink, prompt: "test" }, project);
      if (rEsc && rEsc.ok === false && String(rEsc.error || "").includes("outside")) {
        ok("production resolveImage rejects temp-dir symlink escape");
      } else {
        failMsg(`production resolveImage accepted symlink escape: ${JSON.stringify(rEsc)}`);
      }
    }
  } finally {
    cleanup();
  }
}

// Optional production acceptance: real screenshot under /tmp via VISION_SMOKE_REAL_IMAGE.
// Unset → skip (ordinary smoke stays independent; no machine-local path hardcoded).
console.log("\n  production resolveImage (VISION_SMOKE_REAL_IMAGE optional):");
{
  const realImagePath = process.env.VISION_SMOKE_REAL_IMAGE;
  if (!realImagePath) {
    ok("VISION_SMOKE_REAL_IMAGE unset — skip real-image acceptance");
  } else {
    const project = fs.mkdtempSync(path.join(os.homedir(), ".smoke-vision-real-"));
    try {
      if (!fs.existsSync(realImagePath)) {
        failMsg(`VISION_SMOKE_REAL_IMAGE path missing: ${realImagePath}`);
      } else {
        const onDisk = await fs.promises.readFile(realImagePath);
        const expectedB64 = onDisk.toString("base64");
        const r = await prodResolveImage({ path: realImagePath, prompt: "smoke real image" }, project);
        if (r && !("ok" in r && r.ok === false) && r.base64 === expectedB64 && r.mimeType === "image/png") {
          ok("production resolveImage: real image base64 matches disk bytes, MIME image/png");
        } else {
          const b64Match = r && r.base64 === expectedB64;
          failMsg(
            `real image resolve mismatch: mime=${r && r.mimeType} b64Match=${b64Match} err=${JSON.stringify(r && r.error)}`,
          );
        }
      }
    } finally {
      try { fs.rmSync(project, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

// ── Test 4: modelRegistry null-guard (P0 fix from audit round 6) ─

console.log("\n  modelRegistry null-guard (P0 fix):");
{
  // The extension's execute() function now checks ctx.modelRegistry before
  // calling analyzeImage.  Verify the guard is present in the source code.
  const source = fs.readFileSync(visionSrc, "utf8");
  const hasGuard = source.includes("if (!ctx.modelRegistry)");
  if (hasGuard) ok("null-guard exists in source");
  else failMsg("null-guard for ctx.modelRegistry NOT FOUND in vision/index.ts");

  // Also verify the guard message mentions modelRegistry
  const hasMsg = source.includes("modelRegistry not available");
  if (hasMsg) ok("error message references modelRegistry");
  else failMsg("error message does not reference modelRegistry");
}

// ── Test 5: production source keeps platform temp realpath allowance ─

console.log("\n  production source (system temp allowance contract):");
{
  const source = fs.readFileSync(visionSrc, "utf8");
  const hasTmpdir = source.includes("os.tmpdir()");
  if (hasTmpdir) ok("source uses os.tmpdir() for temp root");
  else failMsg("vision/index.ts missing os.tmpdir()");

  // Must not treat path.resolve("/tmp") as the sole/cross-platform temp root.
  const hardcodesOnlyTmp =
    (source.includes('path.resolve("/tmp")') || source.includes("path.resolve('/tmp')")) &&
    !source.includes("os.tmpdir()");
  if (!hardcodesOnlyTmp) ok("source does not hardcode path.resolve(\"/tmp\") as sole temp root");
  else failMsg("vision/index.ts still hardcodes path.resolve(\"/tmp\") without os.tmpdir()");

  const hasWinGuard = source.includes('platform === "win32"') || source.includes("platform === 'win32'");
  if (hasWinGuard) ok("source gates Unix /tmp with win32 platform check");
  else failMsg("vision/index.ts missing win32 guard around /tmp");

  const hasDualContainment =
    source.includes("isPathInside(abs, root)") &&
    (source.includes("isPathInside(abs, tmpRoot)") || source.includes("tmpRoots.some"));
  if (hasDualContainment) ok("source allows project root or real system temp only");
  else failMsg("vision/index.ts missing dual isPathInside containment");

  const hasOutsideMsg =
    source.includes("system temporary directory") ||
    source.includes("system temp");
  if (hasOutsideMsg) ok("source error mentions system temporary directory");
  else failMsg("vision/index.ts rejection message missing system-temp wording");

  const hasWinCase =
    source.includes('sep === "\\\\"') || source.includes("toLowerCase()");
  if (hasWinCase) ok("source isPathInside handles Windows case-insensitive containment");
  else failMsg("vision/index.ts isPathInside missing Windows case handling");
}

// ── Test 6: pure path Windows / posix containment regression ─────
// Exercises production isPathInside with path.win32 / path.posix so Windows
// semantics are verified even when smoke runs on Linux.

console.log("\n  isPathInside (Windows path.win32 semantics):");
{
  const win = path.win32;

  if (prodIsPathInside("C:\\Temp\\img.png", "C:\\temp", win)) {
    ok("win32: case-insensitive directory match");
  } else {
    failMsg("win32: rejected case-different path under temp");
  }

  if (prodIsPathInside("c:\\Temp\\img.png", "C:\\Temp", win)) {
    ok("win32: case-insensitive drive letter");
  } else {
    failMsg("win32: rejected case-different drive letter");
  }

  if (!prodIsPathInside("C:\\Temp2\\img.png", "C:\\Temp", win)) {
    ok("win32: C:\\Temp2 is not inside C:\\Temp");
  } else {
    failMsg("win32: incorrectly treated C:\\Temp2 as inside C:\\Temp");
  }

  if (!prodIsPathInside("D:\\Temp\\img.png", "C:\\Temp", win)) {
    ok("win32: other drive rejected");
  } else {
    failMsg("win32: accepted path on other drive");
  }

  if (prodIsPathInside("C:\\Temp", "C:\\Temp", win)) {
    ok("win32: exact root match");
  } else {
    failMsg("win32: exact root rejected");
  }

  if (prodIsPathInside("C:\\Temp\\a\\b.png", "C:\\Temp", win)) {
    ok("win32: nested path inside");
  } else {
    failMsg("win32: nested path rejected");
  }

  if (!prodIsPathInside("C:\\Temp", "C:\\Temp\\sub", win)) {
    ok("win32: parent is not inside child");
  } else {
    failMsg("win32: parent incorrectly inside child");
  }
}

console.log("\n  isPathInside (posix regression — Linux must not loosen):");
{
  const posix = path.posix;

  if (prodIsPathInside("/tmp/foo.png", "/tmp", posix)) {
    ok("posix: /tmp/foo inside /tmp");
  } else {
    failMsg("posix: /tmp/foo rejected");
  }

  if (!prodIsPathInside("/tmp2/foo.png", "/tmp", posix)) {
    ok("posix: /tmp2 not inside /tmp");
  } else {
    failMsg("posix: /tmp2 incorrectly inside /tmp");
  }

  if (!prodIsPathInside("/tmp/Foo", "/tmp/foo", posix)) {
    ok("posix: case-sensitive (no false match on case alone)");
  } else {
    failMsg("posix: case-insensitive false match (Linux regression)");
  }

  if (!prodIsPathInside("/var/foo.png", "/tmp", posix)) {
    ok("posix: other tree rejected");
  } else {
    failMsg("posix: /var incorrectly inside /tmp");
  }

  if (prodIsPathInside("/tmp", "/tmp", posix)) {
    ok("posix: exact root match");
  } else {
    failMsg("posix: exact root rejected");
  }
}

// ── Summary ─────────────────────────────────────────────────────

console.log(`\n  Results: ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
