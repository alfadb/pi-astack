#!/usr/bin/env node
/**
 * Build the win32-x64 N-API addon via cargo + fixed MSVC toolchain.
 *
 * Modes:
 * - Development (default): dirty tree allowed; build_info.development_only=true.
 * - Production: PI_ASTACK_PRODUCTION_BUILD=1 — requires clean closure paths, repro
 *   not skipped, HEAD contains closure, ambient RUSTFLAGS/wrappers sanitized.
 *   Do NOT attempt production build on a dirty tree.
 *
 * Gates:
 * - cargo build --locked --offline --target x86_64-pc-windows-msvc --release
 * - cargo test --locked --offline --target ... (native unit tests are a real gate)
 * - cargo clippy --locked --offline --target ... -- -D warnings
 * - Default dual clean rebuild hash match (unless PI_ASTACK_SKIP_REPRO=1; forbidden in prod)
 * - cl/link banners required in toolchain capture
 *
 * Source closure includes native sources, build driver, TS ABI, manifest schema,
 * smoke scripts, and package.json (script registry related inputs).
 * Does NOT write/commit production manifest or production binary pin.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const nativeRoot = path.join(repoRoot, "native", "windows");
const CARGO_TARGET = "x86_64-pc-windows-msvc";
const VSWHERE_CANDIDATES = [
  path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe"),
  "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe",
];
const BUILDTOOLS_VSDEVCMD = "C:\\BuildTools\\Common7\\Tools\\VsDevCmd.bat";

/** Ambient env keys that must not silently influence cargo/rustc for provenance. */
const AMBIENT_STRIP_KEYS = [
  "RUSTFLAGS",
  "CARGO_ENCODED_RUSTFLAGS",
  "RUSTC_WRAPPER",
  "RUSTDOCFLAGS",
  "CARGO_BUILD_RUSTC_WRAPPER",
  "CARGO_BUILD_RUSTFLAGS",
];

/** Source closure paths relative to repo root (posix separators). */
const EXTRA_CLOSURE_FILES = [
  ".gitattributes",
  "scripts/build-windows-native-addon.mjs",
  "scripts/package-windows-native-addon.mjs",
  "scripts/smoke-windows-native-addon.mjs",
  "scripts/smoke-windows-native-retained-lock.mjs",
  "scripts/smoke-windows-native-durable-dacl.mjs",
  "scripts/smoke-windows-native-package.mjs",
  "scripts/dossier-windows-native-production-acceptance.mjs",
  "scripts/smoke-retained-directory-lock.mjs",
  "scripts/smoke-dcc-windows-attestation.mjs",
  "scripts/smoke-proposition-policy-stable-view-windows.mjs",
  "scripts/smoke-edge-protocol-shadow-windows.mjs",
  "extensions/_shared/windows-native-addon.ts",
  // pin.ts is a package OUTPUT — deliberately excluded from source closure.
  "extensions/_shared/retained-directory-lock.ts",
  "extensions/_shared/proposition-policy-stable-view-windows-native.ts",
  "extensions/sediment/edge-protocol-shadow-windows-native.ts",
  "schemas/windows-native-addon-manifest-v1.json",
  "package.json",
];

/** Package artifacts / pin must never enter source_tree_sha256 (self-reference). */
const FORBIDDEN_CLOSURE_PATHS = [
  "extensions/_shared/windows-native-addon-pin.ts",
  "native/windows/win32-x64/manifest.json",
  "native/windows/win32-x64/pi-astack-windows-native.node",
];

/** Sorted known capability set bound into build_id / build-info. */
const CAPABILITIES = [
  "atomic_file_tempdir_v1",
  "atomic_file_v1",
  "protected_dacl_v1",
  "retained_directory_lock_v1",
];

function die(msg, code = 1) {
  console.error(`build-windows-native-addon: ${msg}`);
  process.exit(code);
}

function sha256Buffer(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function sha256Text(text) {
  return sha256Buffer(Buffer.from(text, "utf8"));
}

function listNativeSourceFiles(root) {
  const out = [];
  function walk(dir, relBase) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "target" || ent.name === ".git") continue;
      const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full, rel);
      else if (ent.isFile()) {
        const norm = rel.replace(/\\/g, "/");
        if (
          norm === "Cargo.toml"
          || norm === "Cargo.lock"
          || norm === "build.rs"
          || norm === "rust-toolchain.toml"
          || norm === ".cargo/config.toml"
          || norm.startsWith("src/")
        ) {
          out.push(norm);
        }
      }
    }
  }
  walk(root, "");
  out.sort();
  return out;
}

function hashSourceClosure() {
  /** @type {{ repoRel: string, abs: string }[]} */
  const entries = [];
  for (const rel of listNativeSourceFiles(nativeRoot)) {
    entries.push({
      repoRel: `native/windows/${rel}`,
      abs: path.join(nativeRoot, ...rel.split("/")),
    });
  }
  for (const rel of EXTRA_CLOSURE_FILES) {
    const abs = path.join(repoRoot, ...rel.split("/"));
    if (!fs.existsSync(abs)) die(`source closure missing: ${rel}`);
    entries.push({ repoRel: rel, abs });
  }
  entries.sort((a, b) => (a.repoRel < b.repoRel ? -1 : a.repoRel > b.repoRel ? 1 : 0));
  const seen = new Set();
  const unique = [];
  for (const e of entries) {
    if (seen.has(e.repoRel)) continue;
    seen.add(e.repoRel);
    unique.push(e);
  }
  if (unique.length === 0) die("native source closure is empty");
  // Hard assert: pin + package artifacts are build/package outputs, never closure inputs.
  for (const forbidden of FORBIDDEN_CLOSURE_PATHS) {
    if (seen.has(forbidden) || EXTRA_CLOSURE_FILES.includes(forbidden)) {
      die(`source closure must not include package artifact/pin (self-reference): ${forbidden}`);
    }
  }
  const h = createHash("sha256");
  const files = [];
  for (const { repoRel, abs } of unique) {
    if (FORBIDDEN_CLOSURE_PATHS.includes(repoRel)) {
      die(`source closure must not include package artifact/pin (self-reference): ${repoRel}`);
    }
    const bytes = fs.readFileSync(abs);
    // Working tree must already be LF-normalized (* text=auto eol=lf); refuse CRLF inputs.
    if (!/\.(node|dll|exe|png|jpg|jpeg|gif|webp|ico|zip|gz|7z|woff2?)$/i.test(repoRel)) {
      if (bytes.includes(0x0d)) {
        die(`source closure text file contains CR (CRLF); normalize to LF: ${repoRel}`);
      }
    }
    h.update(repoRel);
    h.update("\0");
    h.update(bytes);
    h.update("\0");
    files.push(repoRel);
  }
  return { sha256: h.digest("hex"), files };
}

function gitSourceCommit() {
  const r = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.status !== 0) die(`git rev-parse HEAD failed: ${r.stderr || r.stdout || r.error}`);
  const sha = String(r.stdout || "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) die(`unexpected git HEAD: ${sha}`);
  return sha;
}

function gitTreeDirty() {
  const r = spawnSync("git", ["status", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.status !== 0) {
    return { dirty: true, detail: `git status failed: ${r.stderr || r.stdout || r.error}` };
  }
  const text = String(r.stdout || "");
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return { dirty: lines.length > 0, detail: lines.slice(0, 40).join("\n"), count: lines.length };
}

/** Closure paths relative to repo that must be clean / present in HEAD for production. */
function gitClosureDirty(closureFiles) {
  const dirty = [];
  for (const rel of closureFiles) {
    const r = spawnSync("git", ["status", "--porcelain", "--", rel], {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    if (r.status !== 0) {
      dirty.push(`${rel}: git status failed`);
      continue;
    }
    if (String(r.stdout || "").trim()) dirty.push(rel);
    // Ensure HEAD contains the path (tracked).
    const ls = spawnSync("git", ["ls-files", "--error-unmatch", "--", rel], {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    if (ls.status !== 0) dirty.push(`${rel}: not in HEAD/index`);
  }
  return dirty;
}

function findVsDevCmd() {
  if (fs.existsSync(BUILDTOOLS_VSDEVCMD)) return BUILDTOOLS_VSDEVCMD;
  for (const vswhere of VSWHERE_CANDIDATES) {
    if (!fs.existsSync(vswhere)) continue;
    const r = spawnSync(
      vswhere,
      [
        "-products", "*",
        "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
        "-property", "installationPath",
        "-latest",
      ],
      { encoding: "utf8", windowsHide: true },
    );
    if (r.status !== 0) continue;
    const installPath = String(r.stdout || "").trim().split(/\r?\n/).filter(Boolean)[0];
    if (!installPath) continue;
    const candidate = path.join(installPath, "Common7", "Tools", "VsDevCmd.bat");
    if (fs.existsSync(candidate)) return candidate;
  }
  die("MSVC VsDevCmd.bat not found (expected C:\\BuildTools or vswhere-discovered VS install)");
}

function captureVsDevEnv(vsDevCmd) {
  const marker = "__PI_ASTACK_VSDEV_ENV_BEGIN__";
  const script = [
    `@echo off`,
    `call "${vsDevCmd}" -arch=amd64 -host_arch=amd64 -no_logo`,
    `if errorlevel 1 exit /b 1`,
    `echo ${marker}`,
    `set`,
  ].join("\r\n");
  const batPath = path.join(nativeRoot, "target", "_vsdev_env.cmd");
  fs.mkdirSync(path.dirname(batPath), { recursive: true });
  fs.writeFileSync(batPath, script, "utf8");
  const r = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/c", batPath], {
    cwd: nativeRoot,
    encoding: "utf8",
    windowsHide: true,
    env: process.env,
  });
  if (r.error) die(`VsDevCmd spawn failed: ${r.error.message}`);
  if (r.status !== 0) {
    die(`VsDevCmd failed status=${r.status}: ${r.stderr || r.stdout || ""}`);
  }
  const out = String(r.stdout || "");
  const idx = out.indexOf(marker);
  if (idx < 0) die("VsDevCmd env capture marker missing");
  const env = { ...process.env };
  for (const line of out.slice(idx + marker.length).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    env[key] = value;
  }
  if (!env.PATH && !env.Path) die("VsDevCmd did not produce PATH");
  return env;
}

/** Strip ambient rust/cargo influence and record what was stripped. */
function sanitizeCargoEnv(baseEnv) {
  const env = { ...baseEnv };
  const stripped = [];
  for (const key of AMBIENT_STRIP_KEYS) {
    if (env[key] != null && env[key] !== "") {
      stripped.push(`${key}=${env[key]}`);
      delete env[key];
    }
  }
  // Force offline + locked semantics via env too (belt).
  env.CARGO_NET_OFFLINE = "true";
  // Stable equivalent of profile trim-paths="all" (unavailable on cargo 1.97.1 stable).
  // Controlled remaps only — never ambient user RUSTFLAGS. Paths themselves are NOT
  // hashed into toolchain_id (only that remaps are applied is implied by build driver).
  applyTrimPathRemaps(env);
  return { env, stripped };
}

/**
 * Inject stable --remap-path-prefix for absolute roots so release objects do not
 * embed machine-local paths (trim-paths=all intent on stable cargo/rustc).
 *
 * CARGO_ENCODED_RUSTFLAGS completely overrides .cargo/config.toml rustflags.
 * Therefore this must re-include deterministic PE link flags from config:
 *   rustflags = ["-C", "link-arg=/Brepro"]
 * as separate unit-separated tokens (not a single collapsed flag).
 */
function applyTrimPathRemaps(env) {
  const pairs = [];
  const push = (from, to) => {
    if (!from) return;
    const norm = path.resolve(from);
    if (!norm) return;
    pairs.push([norm, to]);
    // Also map forward-slash form on Windows for rustc path matching.
    const fwd = norm.replace(/\\/g, "/");
    if (fwd !== norm) pairs.push([fwd, to]);
  };
  push(nativeRoot, "native/windows");
  push(repoRoot, ".");
  push(env.CARGO_HOME || process.env.CARGO_HOME, "cargo-home");
  push(env.RUSTUP_HOME || process.env.RUSTUP_HOME, "rustup-home");
  push(env.USERPROFILE || process.env.USERPROFILE, "user-home");
  push(env.HOME || process.env.HOME, "user-home");
  // Longer prefixes first so nested roots remap correctly.
  pairs.sort((a, b) => b[0].length - a[0].length);
  const seen = new Set();
  // Preserve .cargo/config.toml semantics that ENCODED_RUSTFLAGS would otherwise drop.
  const flags = ["-C", "link-arg=/Brepro"];
  for (const [from, to] of pairs) {
    const key = from.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    flags.push(`--remap-path-prefix=${from}=${to}`);
  }
  // CARGO_ENCODED_RUSTFLAGS uses unit separator; do not reintroduce ambient flags.
  env.CARGO_ENCODED_RUSTFLAGS = flags.join("\u001f");
  delete env.RUSTFLAGS;
  assertEncodedRustflags(env.CARGO_ENCODED_RUSTFLAGS);
  return env.CARGO_ENCODED_RUSTFLAGS;
}

/** Final encoded flags must keep /Brepro + at least one remap (config + trim intent). */
function assertEncodedRustflags(encoded) {
  const parts = String(encoded || "").split("\u001f").filter(Boolean);
  if (!parts.includes("-C")) {
    die("CARGO_ENCODED_RUSTFLAGS must include explicit -C token (config /Brepro semantics)");
  }
  if (!parts.includes("link-arg=/Brepro")) {
    die("CARGO_ENCODED_RUSTFLAGS must include link-arg=/Brepro (must not drop .cargo/config.toml)");
  }
  if (!parts.some((p) => p.startsWith("--remap-path-prefix="))) {
    die("CARGO_ENCODED_RUSTFLAGS must include --remap-path-prefix=... remaps");
  }
  const joined = parts.join(" ");
  if (!joined.includes("/Brepro")) {
    die("CARGO_ENCODED_RUSTFLAGS must contain /Brepro");
  }
  if (!joined.includes("remap")) {
    die("CARGO_ENCODED_RUSTFLAGS must contain remap");
  }
}

function runCapture(cmd, args, env, cwd = nativeRoot) {
  const r = spawnSync(cmd, args, {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    status: r.status,
    stdout: String(r.stdout || ""),
    stderr: String(r.stderr || ""),
    error: r.error,
  };
}

/**
 * Extract numeric MSVC cl version from banner; never hash the raw locale banner.
 * English: "Compiler Version 19.44.35222". Localized banners still embed dotted 19.x.
 */
function extractClNumericVersion(banner) {
  const text = String(banner);
  const en = text.match(/Compiler Version\s+([0-9]+(?:\.[0-9]+)+)/i);
  if (en) return en[1];
  // Locale-agnostic: first MSVC-style 19.x / 18.x / 17.x dotted version token.
  const any = text.match(/\b((?:1[7-9]|2[0-9])\.\d+\.\d+(?:\.\d+)?)\b/);
  return any ? any[1] : "";
}

/**
 * Extract numeric MSVC link version from banner; never hash the raw locale banner.
 * English: "Linker Version 14.44.35222.0". Localized banners still embed dotted 14.x.
 */
function extractLinkNumericVersion(banner) {
  const text = String(banner);
  const en = text.match(/Linker Version\s+([0-9]+(?:\.[0-9]+)+)/i);
  if (en) return en[1];
  // Locale-agnostic: first MSVC linker-style 14.x dotted version token.
  const any = text.match(/\b(14\.\d+\.\d+(?:\.\d+)?)\b/);
  return any ? any[1] : "";
}

/** Trim trailing slash/backslash from Windows SDK version tokens. */
function trimSdkVersion(value) {
  return String(value || "").replace(/[\\/]+$/g, "");
}

/**
 * toolchain_id preimage must be path/locale free: no cargo_home/rustup_home,
 * no raw cl/link banners (locale), only numeric versions + trimmed SDK.
 */
function assertToolchainIdPreimageClean(canonical) {
  const text = String(canonical);
  if (/cargo_home=|rustup_home=/.test(text)) {
    die("toolchain_id preimage must not include cargo_home/rustup_home");
  }
  if (/cl_banner=|link_banner=/.test(text)) {
    die("toolchain_id preimage must not include raw cl/link locale banners");
  }
  // Absolute Windows / Unix home-ish paths must not appear in hash preimage.
  if (/[A-Za-z]:\\|\/home\/|\/Users\//.test(text)) {
    die("toolchain_id preimage must not include absolute filesystem paths");
  }
  // Common localized MSVC banner fragments must not appear.
  if (/Optimizing Compiler|Incremental Linker|Copyright \(C\) Microsoft/i.test(text)) {
    die("toolchain_id preimage must not include locale MSVC banner text");
  }
}

function captureToolchain(vsEnv) {
  const rustc = runCapture("rustc", ["-Vv"], vsEnv);
  if (rustc.status !== 0) die(`rustc -Vv failed: ${rustc.stderr || rustc.stdout || rustc.error}`);
  const cargo = runCapture("cargo", ["-V"], vsEnv);
  if (cargo.status !== 0) die(`cargo -V failed: ${cargo.stderr || cargo.stdout || cargo.error}`);

  const cl = runCapture("cl", [], vsEnv);
  const link = runCapture("link", [], vsEnv);
  const clBanner = (cl.stderr || cl.stdout || "").trim().split(/\r?\n/).slice(0, 4).join("\n");
  const linkBanner = (link.stderr || link.stdout || "").trim().split(/\r?\n/).slice(0, 4).join("\n");
  if (!clBanner || !/Microsoft|Compiler Version|cl\.exe/i.test(clBanner)) {
    die(`cl banner missing or unrecognizable (cl must be on PATH after VsDevCmd):\n${clBanner || "(empty)"}`);
  }
  if (!linkBanner || !/Microsoft|Linker|Version/i.test(linkBanner)) {
    die(`link banner missing or unrecognizable:\n${linkBanner || "(empty)"}`);
  }
  const clVersion = extractClNumericVersion(clBanner);
  const linkVersion = extractLinkNumericVersion(linkBanner);
  if (!clVersion) die(`cl numeric version missing from banner:\n${clBanner}`);
  if (!linkVersion) die(`link numeric version missing from banner:\n${linkBanner}`);

  const cargoConfigPath = path.join(nativeRoot, ".cargo", "config.toml");
  const cargoConfigText = fs.existsSync(cargoConfigPath)
    ? fs.readFileSync(cargoConfigPath, "utf8")
    : "";
  const cargoHome = vsEnv.CARGO_HOME || process.env.CARGO_HOME || "";
  const rustupHome = vsEnv.RUSTUP_HOME || process.env.RUSTUP_HOME || "";
  const sdkVersion = trimSdkVersion(vsEnv.WindowsSDKVersion || vsEnv.WINDOWSSDKVERSION || "");

  // Hash components only — no path homes, no raw locale banners.
  const components = {
    rustc_vv: rustc.stdout.trim(),
    cargo_v: cargo.stdout.trim(),
    cl_version: clVersion,
    link_version: linkVersion,
    VCToolsVersion: vsEnv.VCToolsVersion || vsEnv.VCTOOLSVERSION || "",
    WindowsSDKVersion: sdkVersion,
    target: CARGO_TARGET,
    cargo_config_toml: cargoConfigText,
  };
  const keys = Object.keys(components).sort();
  const canonical = keys.map((k) => `${k}=${components[k]}`).join("\n") + "\n";
  assertToolchainIdPreimageClean(canonical);
  const toolchain_id = sha256Text(canonical);
  const toolchain_summary = [
    components.cargo_v,
    `cl=${clVersion}`,
    `link=${linkVersion}`,
    `VCToolsVersion=${components.VCToolsVersion || "unknown"}`,
    `WindowsSDKVersion=${sdkVersion || "unknown"}`,
    `target=${CARGO_TARGET}`,
  ].join(" | ").slice(0, 256);
  // Raw diagnostics retained for build-info only — never mixed into toolchain_id.
  const diagnostics = {
    cl_banner: clBanner,
    link_banner: linkBanner,
    cargo_home: cargoHome,
    rustup_home: rustupHome,
  };
  return { toolchain_id, toolchain_summary, components, diagnostics, canonical };
}

function ensureRustToolchain(vsEnv) {
  const vv = runCapture("rustc", ["-Vv"], vsEnv);
  if (vv.status !== 0) die(`rustc -Vv failed before build: ${vv.stderr || vv.stdout}`);
  const releaseLine = vv.stdout.split(/\r?\n/).find((l) => l.startsWith("release:"));
  const release = releaseLine ? releaseLine.slice("release:".length).trim() : "";
  const toolchainFile = path.join(nativeRoot, "rust-toolchain.toml");
  const text = fs.readFileSync(toolchainFile, "utf8");
  if (!text.includes("1.97.1")) {
    die("rust-toolchain.toml must pin channel 1.97.1 (or record installed equivalent)");
  }
  const probe = runCapture("rustup", ["run", "1.97.1", "rustc", "-Vv"], vsEnv);
  if (probe.status !== 0) {
    if (!release.startsWith("1.97.1")) {
      die(
        `rust-toolchain 1.97.1 is not installed and active rustc is ${release || "unknown"}; install 1.97.1 offline or match channel`,
      );
    }
    console.log(
      `build-windows-native-addon: rustup run 1.97.1 unavailable; active rustc ${release} matches pin — continuing with installed toolchain (recorded in toolchain_id)`,
    );
  } else {
    console.log("build-windows-native-addon: rust-toolchain 1.97.1 resolvable via rustup run");
  }
  return { release };
}

function runCargo(args, env) {
  console.log(`build-windows-native-addon: cargo ${args.join(" ")}`);
  const r = spawnSync("cargo", args, {
    cwd: nativeRoot,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (r.error) die(`cargo spawn failed: ${r.error.message}`);
  if (r.status !== 0) die(`cargo ${args.join(" ")} failed with status ${r.status}`);
}

function findBuiltArtifact() {
  const releaseDir = path.join(nativeRoot, "target", CARGO_TARGET, "release");
  const legacyDir = path.join(nativeRoot, "target", "release");
  const names = [
    "pi_astack_windows_native.dll",
    "pi_astack_windows_native.node",
    "pi-astack-windows-native.node",
  ];
  for (const dir of [releaseDir, legacyDir]) {
    for (const name of names) {
      const p = path.join(dir, name);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    }
    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir)) {
        if (/\.(node|dll)$/i.test(name) && name.toLowerCase().includes("pi_astack_windows_native")) {
          return path.join(dir, name);
        }
      }
    }
  }
  die(`built artifact not found under ${releaseDir}`);
}

/**
 * Scan release binary for leaked absolute roots (ASCII case-insensitive + UTF-16LE).
 * production/repro builds must not embed repoRoot/userProfile/cargoHome/rustupHome.
 */
function assertBinaryHasNoSensitivePaths(binaryBytes, roots) {
  const hayAscii = Buffer.from(binaryBytes);
  const hayLower = Buffer.from(hayAscii.toString("latin1").toLowerCase(), "latin1");
  for (const [label, raw] of roots) {
    if (!raw) continue;
    const candidates = new Set();
    const norm = path.resolve(String(raw));
    candidates.add(norm);
    candidates.add(norm.toLowerCase());
    candidates.add(norm.replace(/\\/g, "/"));
    candidates.add(norm.replace(/\\/g, "/").toLowerCase());
    candidates.add(norm.replace(/\//g, "\\"));
    candidates.add(norm.replace(/\//g, "\\").toLowerCase());
    for (const c of candidates) {
      if (!c || c.length < 4) continue;
      const asciiNeedle = Buffer.from(c.toLowerCase(), "utf8");
      if (asciiNeedle.byteLength >= 4 && hayLower.includes(asciiNeedle)) {
        die(`built binary embeds sensitive path bytes (${label}): refuse package/repro artifact`);
      }
      // UTF-16LE scan (Windows PE often stores wide paths).
      const u16 = Buffer.alloc(c.length * 2);
      for (let i = 0; i < c.length; i += 1) {
        const code = c.toLowerCase().charCodeAt(i);
        u16[i * 2] = code & 0xff;
        u16[i * 2 + 1] = (code >> 8) & 0xff;
      }
      if (u16.byteLength >= 8 && hayAscii.includes(u16)) {
        die(`built binary embeds sensitive path UTF-16LE bytes (${label}): refuse package/repro artifact`);
      }
      // Also try original-case UTF-16LE.
      const u16o = Buffer.alloc(c.length * 2);
      for (let i = 0; i < c.length; i += 1) {
        const code = c.charCodeAt(i);
        u16o[i * 2] = code & 0xff;
        u16o[i * 2 + 1] = (code >> 8) & 0xff;
      }
      if (u16o.byteLength >= 8 && hayAscii.includes(u16o)) {
        die(`built binary embeds sensitive path UTF-16LE bytes (${label}): refuse package/repro artifact`);
      }
    }
  }
}

function buildOnce(envExtra, vsEnv) {
  const { env } = sanitizeCargoEnv({ ...vsEnv, ...envExtra });
  runCargo(
    [
      "build",
      "--locked",
      "--offline",
      "--target",
      CARGO_TARGET,
      "--release",
      "--manifest-path",
      "Cargo.toml",
    ],
    env,
  );
  const artifact = findBuiltArtifact();
  const bytes = fs.readFileSync(artifact);
  return { artifact, bytes, sha256: sha256Buffer(bytes) };
}

function runNativeTestsAndClippy(envExtra, vsEnv) {
  const { env } = sanitizeCargoEnv({ ...vsEnv, ...envExtra });
  // Tests need the same provenance env as build.rs.
  runCargo(
    [
      "test",
      "--locked",
      "--offline",
      "--target",
      CARGO_TARGET,
      "--manifest-path",
      "Cargo.toml",
    ],
    env,
  );
  runCargo(
    [
      "clippy",
      "--locked",
      "--offline",
      "--target",
      CARGO_TARGET,
      "--manifest-path",
      "Cargo.toml",
      "--",
      "-D",
      "warnings",
    ],
    env,
  );
  return { native_tests_passed: true, clippy_passed: true };
}

function main() {
  if (process.platform !== "win32") {
    die("build is only supported on win32 (first support matrix)");
  }
  if (process.arch !== "x64") {
    die(`build requires x64 host, got ${process.arch}`);
  }
  if (!fs.existsSync(path.join(nativeRoot, "Cargo.toml"))) {
    die(`missing ${path.join(nativeRoot, "Cargo.toml")}`);
  }
  if (!fs.existsSync(path.join(nativeRoot, "Cargo.lock"))) {
    die("Cargo.lock missing — required for --locked builds");
  }

  const productionBuild = process.env.PI_ASTACK_PRODUCTION_BUILD === "1";
  const skipRepro = process.env.PI_ASTACK_SKIP_REPRO === "1";
  const mode = productionBuild ? "production" : "development";

  if (productionBuild && skipRepro) {
    die("PI_ASTACK_PRODUCTION_BUILD=1 forbids PI_ASTACK_SKIP_REPRO=1");
  }

  const sourceCommit = gitSourceCommit();
  const dirty = gitTreeDirty();
  const closure = hashSourceClosure();

  if (productionBuild) {
    if (dirty.dirty) {
      die(
        "PI_ASTACK_PRODUCTION_BUILD=1 requires a clean git tree (closure + worktree). "
          + "Do not attempt production build on a dirty tree. "
          + `dirty=${dirty.count || "?"} paths`,
      );
    }
    const closureDirty = gitClosureDirty(closure.files);
    if (closureDirty.length) {
      die(`production build: closure paths dirty or not in HEAD:\n${closureDirty.join("\n")}`);
    }
  }

  const vsDevCmd = findVsDevCmd();
  console.log(`build-windows-native-addon: VsDevCmd=${vsDevCmd}`);
  const vsEnvRaw = captureVsDevEnv(vsDevCmd);
  const { env: vsEnv, stripped: strippedEnv } = sanitizeCargoEnv(vsEnvRaw);
  if (strippedEnv.length) {
    console.log(`build-windows-native-addon: stripped ambient env: ${strippedEnv.map((s) => s.split("=")[0]).join(",")}`);
  }
  // Re-assert encoded flags after sanitize (must keep /Brepro + remap).
  assertEncodedRustflags(vsEnv.CARGO_ENCODED_RUSTFLAGS);
  ensureRustToolchain(vsEnv);
  const tc = captureToolchain(vsEnv);

  // development_only: true for any non-production mode OR residual dirty tree.
  const developmentOnly = !productionBuild || dirty.dirty === true;
  const buildConfigSha256 = sha256Text(tc.components.cargo_config_toml || "");
  // Reproducibility claim baked into identity after gates; dual rebuild verifies match.
  const reproducibility = skipRepro ? "skipped" : "dual_clean_match";

  console.log(`build-windows-native-addon: mode=${mode}`);
  console.log(`build-windows-native-addon: development_only=${developmentOnly}`);
  console.log(`build-windows-native-addon: source_commit=${sourceCommit}`);
  console.log(`build-windows-native-addon: source_tree_sha256=${closure.sha256}`);
  console.log(`build-windows-native-addon: source_files=${closure.files.join(",")}`);
  console.log(`build-windows-native-addon: toolchain_id=${tc.toolchain_id}`);
  console.log(`build-windows-native-addon: build_config_sha256=${buildConfigSha256}`);
  if (dirty.dirty) {
    console.log(`build-windows-native-addon: dirty tree (${dirty.count || "?"} paths) — development_only`);
  }

  // Gates first with placeholder identity (tests do not package this binary).
  // Release build env is set AFTER gates so native_tests/clippy=passed are real.
  const gateEnvExtra = {
    PI_ASTACK_SOURCE_COMMIT: sourceCommit,
    PI_ASTACK_SOURCE_TREE_SHA256: closure.sha256,
    PI_ASTACK_BUILD_ID: "gate-placeholder-not-for-package",
    PI_ASTACK_TOOLCHAIN_ID: tc.toolchain_id,
    PI_ASTACK_BUILD_MODE: mode,
    PI_ASTACK_REPRODUCIBILITY: reproducibility,
    PI_ASTACK_NATIVE_TESTS: "passed",
    PI_ASTACK_CLIPPY: "passed",
    PI_ASTACK_BUILD_CONFIG_SHA256: buildConfigSha256,
  };
  console.log("build-windows-native-addon: running cargo test + clippy gate (before release build)");
  const gates = runNativeTestsAndClippy(gateEnvExtra, vsEnv);
  if (!gates.native_tests_passed || !gates.clippy_passed) {
    die("native_tests/clippy gates did not pass");
  }
  const nativeTests = "passed";
  const clippyStatus = "passed";

  // Deterministic build_id preimage includes the same evidence fields baked into binary/manifest.
  const buildIdPreimage = [
    `source_commit=${sourceCommit}`,
    `source_tree_sha256=${closure.sha256}`,
    `toolchain_id=${tc.toolchain_id}`,
    `target=${CARGO_TARGET}`,
    `addon_abi=1`,
    `capabilities=${CAPABILITIES.join(",")}`,
    `build_mode=${mode}`,
    `reproducibility=${reproducibility}`,
    `native_tests=${nativeTests}`,
    `clippy=${clippyStatus}`,
    `build_config_sha256=${buildConfigSha256}`,
    `stripped_env_keys=${strippedEnv.map((s) => s.split("=")[0]).sort().join(",")}`,
  ].join("\n") + "\n";
  const buildIdPreimageSha256 = sha256Text(buildIdPreimage);
  const buildId = buildIdPreimageSha256;

  console.log(`build-windows-native-addon: build_id=${buildId}`);
  console.log(`build-windows-native-addon: build_id_preimage_sha256=${buildIdPreimageSha256}`);
  console.log(`build-windows-native-addon: build_mode=${mode} reproducibility=${reproducibility}`);

  const envExtra = {
    PI_ASTACK_SOURCE_COMMIT: sourceCommit,
    PI_ASTACK_SOURCE_TREE_SHA256: closure.sha256,
    PI_ASTACK_BUILD_ID: buildId,
    PI_ASTACK_TOOLCHAIN_ID: tc.toolchain_id,
    PI_ASTACK_BUILD_MODE: mode,
    PI_ASTACK_REPRODUCIBILITY: reproducibility,
    PI_ASTACK_NATIVE_TESTS: nativeTests,
    PI_ASTACK_CLIPPY: clippyStatus,
    PI_ASTACK_BUILD_CONFIG_SHA256: buildConfigSha256,
  };

  // Release builds only after gates; env values are real (passed/dual_clean_match|skipped).
  runCargo(["clean", "--manifest-path", "Cargo.toml"], sanitizeCargoEnv({ ...vsEnv, ...envExtra }).env);
  const first = buildOnce(envExtra, vsEnv);
  console.log(`build-windows-native-addon: first binary_sha256=${first.sha256} bytes=${first.bytes.byteLength}`);

  let second = null;
  if (!skipRepro) {
    runCargo(["clean", "--manifest-path", "Cargo.toml"], sanitizeCargoEnv({ ...vsEnv, ...envExtra }).env);
    second = buildOnce(envExtra, vsEnv);
    console.log(`build-windows-native-addon: second binary_sha256=${second.sha256} bytes=${second.bytes.byteLength}`);
    if (first.sha256 !== second.sha256) {
      die(`repro failed: clean rebuild hashes differ ${first.sha256} vs ${second.sha256}`);
    }
    console.log("build-windows-native-addon: repro OK (two clean rebuild hashes match → dual_clean_match)");
  } else {
    console.log("build-windows-native-addon: PI_ASTACK_SKIP_REPRO=1 — single build only (reproducibility=skipped)");
  }

  const final = second || first;

  // Sensitive path scan (ASCII case-insensitive + UTF-16LE) on the package candidate.
  assertBinaryHasNoSensitivePaths(final.bytes, [
    ["repoRoot", repoRoot],
    ["nativeRoot", nativeRoot],
    ["userProfile", process.env.USERPROFILE || process.env.HOME || ""],
    ["cargoHome", vsEnv.CARGO_HOME || process.env.CARGO_HOME || ""],
    ["rustupHome", vsEnv.RUSTUP_HOME || process.env.RUSTUP_HOME || ""],
  ]);

  const outDir = path.join(nativeRoot, "target", "smoke-staging");
  fs.mkdirSync(outDir, { recursive: true });
  const stagedNode = path.join(outDir, "pi-astack-windows-native.node");
  fs.copyFileSync(final.artifact, stagedNode);

  // Stage real mutex-squat helper used by durable-dacl smoke (not a mock).
  const helperName = "pi-astack-mutex-squat-helper.exe";
  const helperCandidates = [
    path.join(nativeRoot, "target", CARGO_TARGET, "release", helperName),
    path.join(nativeRoot, "target", "release", helperName),
  ];
  const helperSrc = helperCandidates.find((p) => fs.existsSync(p));
  if (!helperSrc) {
    die(`mutex squat helper not found under release (expected ${helperName})`);
  }
  const stagedHelper = path.join(outDir, helperName);
  fs.copyFileSync(helperSrc, stagedHelper);

  const buildInfo = {
    schema: "windows-native-addon-build-info/v1",
    note: "Local build metadata for smoke only. NOT a production manifest. Production pin remains null. Only production mode + clean tree may enter a future package; development_only builds are smoke-only.",
    mode,
    build_mode: mode,
    development_only: developmentOnly,
    dirty_tree: dirty.dirty === true,
    dirty_detail: dirty.dirty ? dirty.detail : "",
    addon_abi: 1,
    platform: "win32",
    arch: "x64",
    napi_version: 9,
    target: "win32-x64",
    cargo_target: CARGO_TARGET,
    capabilities: [...CAPABILITIES],
    source_commit: sourceCommit,
    source_tree_sha256: closure.sha256,
    source_files: closure.files,
    toolchain_id: tc.toolchain_id,
    toolchain: tc.toolchain_summary,
    toolchain_components: tc.components,
    // Raw path/locale diagnostics — NOT part of toolchain_id preimage.
    toolchain_diagnostics: tc.diagnostics,
    stripped_ambient_env_keys: strippedEnv.map((s) => s.split("=")[0]).sort(),
    build_id: buildId,
    build_id_preimage_sha256: buildIdPreimageSha256,
    build_config_sha256: buildConfigSha256,
    reproducibility,
    native_tests: nativeTests,
    clippy: clippyStatus,
    artifact_path: final.artifact,
    staged_node_path: stagedNode,
    staged_mutex_squat_helper_path: stagedHelper,
    binary_bytes: final.bytes.byteLength,
    binary_sha256: final.sha256,
    repro: skipRepro
      ? { skipped: true, matched: false }
      : { skipped: false, first_sha256: first.sha256, second_sha256: second.sha256, matched: true },
    // Cross-check helper: package may recompute preimage sha over these exact fields.
    build_id_preimage_fields: {
      source_commit: sourceCommit,
      source_tree_sha256: closure.sha256,
      toolchain_id: tc.toolchain_id,
      target: CARGO_TARGET,
      addon_abi: 1,
      capabilities: [...CAPABILITIES],
      build_mode: mode,
      reproducibility,
      native_tests: nativeTests,
      clippy: clippyStatus,
      build_config_sha256: buildConfigSha256,
      stripped_env_keys: strippedEnv.map((s) => s.split("=")[0]).sort(),
    },
  };
  const buildInfoPath = path.join(outDir, "build-info.json");
  fs.writeFileSync(buildInfoPath, `${JSON.stringify(buildInfo, null, 2)}\n`, "utf8");

  console.log(`build-windows-native-addon: artifact=${final.artifact}`);
  console.log(`build-windows-native-addon: staged=${stagedNode}`);
  console.log(`build-windows-native-addon: binary_bytes=${final.bytes.byteLength}`);
  console.log(`build-windows-native-addon: binary_sha256=${final.sha256}`);
  console.log(`build-windows-native-addon: build_info=${buildInfoPath}`);
  console.log(`build-windows-native-addon: native_tests=${nativeTests} clippy=${clippyStatus} reproducibility=${reproducibility}`);
  console.log(
    developmentOnly
      ? "build-windows-native-addon: OK development_only (no production package)"
      : "build-windows-native-addon: OK production-mode build (no production manifest/pin written yet)",
  );
}

main();
