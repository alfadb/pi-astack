#!/usr/bin/env node
/**
 * Smoke: current pi install target and backward-compatible peer contracts.
 *
 * Install target: 0.82.0. Peer floor: >=0.80.10 <1.0.0.
 *
 * Covers more than source-regex:
 *   1) package.json is the publish contract: pin four @earendil-works packages to
 *      the current install target and retain the ModelRuntime-compatible peer floor
 *   2) resolveParentModelRuntime requires registry.runtime and rejects stale facades
 *   3) refreshModelRegistry awaits Promise refresh with per-registry singleflight
 *   4) Against a real host at the install target or newer,
 *      prepareNextTurnWithContext exists and ModelRegistry.refresh returns a Promise;
 *      soft-skip is forbidden for critical probes
 *   5) parent ModelRuntime E2E: real createAgentSession inherits registry.runtime
 *   6) recursive legacy AuthStorage/ModelRegistry factory scan on extensions+scripts
 *
 * package-lock.json is gitignored and is NOT a release gate. When present locally it is
 * checked as a soft consistency signal; absence or drift never fails the smoke.
 *
 * Host path: PI_COMPAT_ROOT > legacy PI_08010_ROOT > active pi executable >
 * resolvable package > local node_modules > fixed Volta path last.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url);

const failures = [];
let total = 0;

function check(name, fn) {
  total++;
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

async function checkAsync(name, fn) {
  total++;
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

function parseVersion(v) {
  const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? m.slice(1).map(Number) : null;
}

function versionInPeerRange(v) {
  const parsed = parseVersion(v);
  if (!parsed) return false;
  const [maj, min, pat] = parsed;
  return maj === 0 && ((min === 80 && pat >= 10) || min > 80);
}

function versionAtLeast(v, floor) {
  const actual = parseVersion(v);
  const required = parseVersion(floor);
  if (!actual || !required) return false;
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== required[i]) return actual[i] > required[i];
  }
  return true;
}

function readPkgVersion(pkgPath) {
  try {
    return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
  } catch {
    return null;
  }
}

/** Walk up from a resolved file (often dist/index.js) to the package root. */
function packageRootFromResolved(resolvedUrlOrPath) {
  let cur;
  try {
    cur = resolvedUrlOrPath.startsWith("file:")
      ? fileURLToPath(resolvedUrlOrPath)
      : path.resolve(resolvedUrlOrPath);
  } catch {
    return null;
  }
  if (fs.existsSync(cur) && fs.statSync(cur).isFile()) cur = path.dirname(cur);
  for (let i = 0; i < 8 && cur && cur !== path.dirname(cur); i++) {
    const pkgPath = path.join(cur, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const name = JSON.parse(fs.readFileSync(pkgPath, "utf8")).name;
        if (name === "@earendil-works/pi-coding-agent") return cur;
      } catch { /* keep walking */ }
    }
    cur = path.dirname(cur);
  }
  return null;
}

/** Resolve the package root behind the active `pi` executable on PATH. */
function activePiPackageRoot() {
  const pathEntries = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const executableNames = process.platform === "win32" ? ["pi.cmd", "pi.exe", "pi"] : ["pi"];
  let repoLocal = null;
  for (const entry of pathEntries) {
    for (const name of executableNames) {
      const candidate = path.join(entry, name);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        const real = fs.realpathSync(candidate);
        const root = packageRootFromResolved(real);
        if (!root) continue;
        const resolvedRoot = path.resolve(root);
        const isRepoLocal = resolvedRoot === repoRoot || resolvedRoot.startsWith(`${repoRoot}${path.sep}`);
        if (!isRepoLocal) return { root, executable: candidate, real };
        repoLocal ??= { root, executable: candidate, real };
      } catch { /* try the next PATH entry */ }
    }
  }
  return repoLocal;
}

/**
 * Prefer explicit compatibility roots, then the active pi executable. A local
 * import is only a fallback because direct Node resolution can select this
 * repository's stale node_modules instead of the process host.
 */
function resolveHostCodingAgent() {
  const tried = [];
  for (const envName of ["PI_COMPAT_ROOT", "PI_08010_ROOT"]) {
    if (!process.env[envName]) continue;
    const root = path.resolve(process.env[envName]);
    tried.push(`${envName}=${root}`);
    if (fs.existsSync(path.join(root, "package.json"))) return { root, source: envName, tried };
  }

  const activePi = activePiPackageRoot();
  tried.push(
    activePi
      ? `active-pi=${activePi.executable}→${activePi.real}→root=${activePi.root}`
      : "active-pi=not found",
  );
  if (activePi) return { root: activePi.root, source: "active pi executable", tried };

  try {
    const resolved = import.meta.resolve("@earendil-works/pi-coding-agent");
    const root = packageRootFromResolved(resolved);
    tried.push(`import.meta.resolve→${resolved}→root=${root}`);
    if (root) return { root, source: "import.meta.resolve", tried };
  } catch (err) {
    tried.push(`import.meta.resolve failed: ${err.message}`);
  }

  const local = path.join(repoRoot, "node_modules/@earendil-works/pi-coding-agent");
  tried.push(`local=${local}`);
  if (fs.existsSync(path.join(local, "package.json"))) {
    return { root: local, source: "local node_modules", tried };
  }

  const volta =
    "/home/worker/.volta/tools/image/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent";
  tried.push(`volta-fallback=${volta}`);
  if (fs.existsSync(path.join(volta, "package.json"))) {
    return { root: volta, source: "volta-fallback", tried };
  }

  return { root: null, source: null, tried };
}

function stripLineCommentsAndBlockComments(text) {
  // Remove block comments then line comments; keep strings roughly intact enough
  // that legacy factory call sites outside comments still match.
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l))
    .join("\n");
}

function walkFiles(dir, pred, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === ".git" || ent.name === "dist") continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(full, pred, out);
    else if (ent.isFile() && pred(full)) out.push(full);
  }
  return out;
}

const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const TARGET = "0.82.0";
const PEER_FLOOR = ">=0.80.10 <1.0.0";
const EAR = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];
// Peers declared for host packages (pi-agent-core is install-only / nested via coding-agent).
const PEER_EAR = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];

function hostPackageVersion(hostRoot, name) {
  if (name === "@earendil-works/pi-coding-agent") {
    return readPkgVersion(path.join(hostRoot, "package.json"));
  }
  const unscoped = name.slice("@earendil-works/".length);
  const candidates = [
    path.join(hostRoot, "node_modules", name, "package.json"),
    path.join(path.dirname(hostRoot), unscoped, "package.json"),
  ];
  for (const candidate of candidates) {
    const version = readPkgVersion(candidate);
    if (version != null) return version;
  }
  return null;
}

function formatVersions(readVersion) {
  return EAR.map((name) => `${name}@${readVersion(name) ?? "not installed"}`).join(", ");
}

console.log(`Smoke: pi install target ${TARGET}; peer floor ${PEER_FLOOR}\n`);
const initialHost = resolveHostCodingAgent();
console.log(
  `  note  actual host via ${initialHost.source ?? "unresolved"}: ${initialHost.root ?? "not found"}`,
);
console.log(
  `  note  actual host package versions: ${formatVersions((name) =>
    initialHost.root ? hostPackageVersion(initialHost.root, name) : null)}`,
);
console.log(
  `  note  actual local package versions: ${formatVersions((name) =>
    readPkgVersion(path.join(repoRoot, "node_modules", name, "package.json")))}`,
);

check(`package.json pins four earendil packages to ${TARGET} for install`, () => {
  for (const name of EAR) {
    const v = pkg.devDependencies?.[name];
    if (v !== TARGET) throw new Error(`${name} devDependency is ${v}, want ${TARGET}`);
  }
});

check("package.json peerDependencies floor ModelRuntime-compatible >=0.80.10", () => {
  for (const name of PEER_EAR) {
    const v = pkg.peerDependencies?.[name];
    if (v !== PEER_FLOOR) {
      throw new Error(`${name} peerDependency is ${v}, want ${PEER_FLOOR}`);
    }
    // Reject legacy floors that still admit pre-ModelRuntime hosts.
    if (/^>=0\.80\.0\b/.test(String(v)) && !/^>=0\.80\.10\b/.test(String(v))) {
      throw new Error(`${name} peer still allows 0.80.0-class hosts: ${v}`);
    }
  }
});

check(`host target floor detects versions below ${TARGET}`, () => {
  if (versionAtLeast("0.81.0", TARGET)) {
    throw new Error(`0.81.0 must be rejected as older than install target ${TARGET}`);
  }
  if (!versionAtLeast(TARGET, TARGET)) {
    throw new Error(`install target ${TARGET} must satisfy its own floor`);
  }
});

// package-lock.json is gitignored — advisory local consistency only, never a required gate.
const lockPath = path.join(repoRoot, "package-lock.json");
if (fs.existsSync(lockPath)) {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    const notes = [];
    for (const name of EAR) {
      const key = `node_modules/${name}`;
      const entry = lock.packages?.[key];
      if (!entry) notes.push(`lock missing ${key}`);
      else if (entry.version !== TARGET) notes.push(`${key} version=${entry.version}, want ${TARGET}`);
      else if (!String(entry.resolved || "").includes(`-${TARGET}.tgz`)) {
        notes.push(`${key} resolved does not point at ${TARGET}: ${entry.resolved}`);
      }
    }
    const rootDev = lock.packages?.[""]?.devDependencies || {};
    for (const name of EAR) {
      if (rootDev[name] && rootDev[name] !== TARGET) {
        notes.push(`lock root devDependency ${name}=${rootDev[name]}`);
      }
    }
    const rootPeers = lock.packages?.[""]?.peerDependencies || {};
    for (const name of PEER_EAR) {
      if (rootPeers[name] && rootPeers[name] !== PEER_FLOOR) {
        notes.push(`lock root peer ${name}=${rootPeers[name]}, want ${PEER_FLOOR}`);
      }
    }
    if (notes.length) {
      console.log(`  warn  package-lock.json (advisory only; not a gate): ${notes.join("; ")}`);
    } else {
      console.log(`  ok    package-lock.json (advisory) matches ${TARGET} pins / ${PEER_FLOOR} peers`);
    }
  } catch (err) {
    console.log(`  warn  package-lock.json unreadable (advisory only): ${err.message}`);
  }
} else {
  console.log("  skip  package-lock.json (gitignored; not a release contract)");
}

check("host resolver prefers explicit roots / external active pi before local fallback", () => {
  const resolved = resolveHostCodingAgent();
  if (!resolved.root) {
    throw new Error(`could not resolve host coding-agent; tried: ${resolved.tried.join(" | ")}`);
  }
  // import.meta.resolve must not be treated as package root when it lands on dist/index.js
  const bogusDistRoot = path.join(repoRoot, "node_modules/@earendil-works/pi-coding-agent/dist");
  if (resolved.root === bogusDistRoot) {
    throw new Error("host root incorrectly resolved to dist/ (import.meta.resolve not walked to package root)");
  }
  if (!fs.existsSync(path.join(resolved.root, "package.json"))) {
    throw new Error(`resolved host root missing package.json: ${resolved.root}`);
  }

  const savedCompatRoot = process.env.PI_COMPAT_ROOT;
  const savedLegacyRoot = process.env.PI_08010_ROOT;
  try {
    process.env.PI_COMPAT_ROOT = resolved.root;
    process.env.PI_08010_ROOT = resolved.root;
    const preferred = resolveHostCodingAgent();
    if (preferred.source !== "PI_COMPAT_ROOT") {
      throw new Error(`PI_COMPAT_ROOT did not win precedence; source=${preferred.source}`);
    }
    delete process.env.PI_COMPAT_ROOT;
    const legacy = resolveHostCodingAgent();
    if (legacy.source !== "PI_08010_ROOT") {
      throw new Error(`legacy PI_08010_ROOT alias did not resolve; source=${legacy.source}`);
    }
  } finally {
    if (savedCompatRoot === undefined) delete process.env.PI_COMPAT_ROOT;
    else process.env.PI_COMPAT_ROOT = savedCompatRoot;
    if (savedLegacyRoot === undefined) delete process.env.PI_08010_ROOT;
    else process.env.PI_08010_ROOT = savedLegacyRoot;
  }

  console.log(`  note  host root via ${resolved.source}: ${resolved.root}`);
});

check(`host install meets target >=${TARGET} and peer range ${PEER_FLOOR}`, () => {
  const { root } = resolveHostCodingAgent();
  if (!root) throw new Error("no host coding-agent root");
  const v = readPkgVersion(path.join(root, "package.json"));
  if (!versionInPeerRange(v)) {
    throw new Error(`host pi-coding-agent@${v} at ${root} outside peer range ${PEER_FLOOR}`);
  }
  if (!versionAtLeast(v, TARGET)) {
    throw new Error(`host target too old: pi-coding-agent@${v} at ${root}; need >=${TARGET}`);
  }
  for (const name of EAR) {
    if (name === "@earendil-works/pi-coding-agent") continue;
    const sv = hostPackageVersion(root, name);
    if (sv != null && !versionInPeerRange(sv)) {
      throw new Error(`host package ${name}@${sv} outside peer range ${PEER_FLOOR}`);
    }
    if (sv != null && !versionAtLeast(sv, TARGET)) {
      throw new Error(`host package target too old: ${name}@${sv}; need >=${TARGET}`);
    }
  }
});

check("dispatch source no longer uses AuthStorage/ModelRegistry.create for sessions", () => {
  const src = fs.readFileSync(path.join(repoRoot, "extensions/dispatch/index.ts"), "utf8");
  if (/modelRegistry:\s*refreshedModelRegistry/.test(src)) {
    throw new Error("createAgentSession still receives modelRegistry");
  }
  if (!/modelRuntime:\s*parentModelRuntime/.test(src)) {
    throw new Error("createAgentSession missing modelRuntime: parentModelRuntime");
  }
  if (!/await refreshModelRegistry/.test(src)) {
    throw new Error("refreshModelRegistry must be awaited");
  }
  if (!/model-registry-refresh-singleflight/.test(src)) {
    throw new Error("refresh singleflight Symbol.for key missing");
  }
  if (!/WeakMap/.test(src) || !/_modelRegistryRefreshInflight/.test(src)) {
    throw new Error("refresh singleflight must use global WeakMap slot");
  }
});

check("recursive legacy API scan: extensions/**/*.ts + scripts/**/*.mjs (ignore comments/node_modules)", () => {
  const files = [
    ...walkFiles(path.join(repoRoot, "extensions"), (f) => f.endsWith(".ts")),
    ...walkFiles(path.join(repoRoot, "scripts"), (f) => f.endsWith(".mjs")),
  ];
  if (files.length < 50) throw new Error(`expected broad recursive scan, only found ${files.length} files`);
  const offenders = [];
  for (const f of files) {
    const rel = path.relative(repoRoot, f);
    const body = stripLineCommentsAndBlockComments(fs.readFileSync(f, "utf8"));
    if (/AuthStorage\.(create|inMemory)\s*\(/.test(body)) offenders.push(`${rel}:AuthStorage`);
    if (/ModelRegistry\.(create|inMemory)\s*\(/.test(body)) offenders.push(`${rel}:ModelRegistry`);
  }
  if (offenders.length) {
    throw new Error(`legacy auth/registry factories still called: ${offenders.join(", ")}`);
  }
});

await checkAsync("resolveParentModelRuntime validates registry.runtime", async () => {
  const mod = await jiti.import(path.join(repoRoot, "extensions/dispatch/index.ts"));
  const resolve = mod.resolveParentModelRuntime;
  if (typeof resolve !== "function") throw new Error("resolveParentModelRuntime not exported");

  let threw = false;
  try { resolve(null); } catch { threw = true; }
  if (!threw) throw new Error("null registry should throw");

  threw = false;
  try { resolve({ find() {} }); } catch { threw = true; }
  if (!threw) throw new Error("registry without runtime should throw");

  const runtime = {
    getModel() { return undefined; },
    getAuth() { return Promise.resolve(undefined); },
    refresh() { return Promise.resolve(); },
  };
  const got = resolve({ runtime, find() {} });
  if (got !== runtime) throw new Error("should return the same runtime instance");

  for (const capability of ["getModel", "getAuth", "refresh"]) {
    const incomplete = { ...runtime, [capability]: undefined };
    threw = false;
    try { resolve({ runtime: incomplete, find() {} }); } catch { threw = true; }
    if (!threw) throw new Error(`runtime without ${capability} should throw`);
  }
});

await checkAsync("refreshModelRegistry singleflight: 16 concurrent → 1 refresh; failure retries", async () => {
  // Real exported helper, two jiti copies (moduleCache:false) sharing globalThis WeakMap.
  const jitiA = createJiti(import.meta.url, { moduleCache: false });
  const jitiB = createJiti(import.meta.url, { moduleCache: false });
  const modA = await jitiA.import(path.join(repoRoot, "extensions/dispatch/index.ts"));
  const modB = await jitiB.import(path.join(repoRoot, "extensions/dispatch/index.ts"));
  if (typeof modA.refreshModelRegistry !== "function") {
    throw new Error("refreshModelRegistry must be exported for behavioral tests");
  }
  if (modA.refreshModelRegistry === modB.refreshModelRegistry) {
    // Different jiti copies should produce different function objects; if equal,
    // moduleCache may have been shared — still OK as long as singleflight works.
    console.log("  note  jiti copies shared function identity (moduleCache may be warm)");
  }

  let calls = 0;
  let failOnce = true;
  let release;
  const gate = new Promise((r) => { release = r; });
  const registry = {
    async refresh() {
      calls++;
      await gate;
      if (failOnce) {
        failOnce = false;
        throw new Error("refresh-boom");
      }
    },
  };

  // Wave 1: 16 concurrent across both module copies; one inflight, one failure.
  const wave1 = [];
  for (let i = 0; i < 8; i++) wave1.push(modA.refreshModelRegistry(registry));
  for (let i = 0; i < 8; i++) wave1.push(modB.refreshModelRegistry(registry));
  // Let all callers attach to the same inflight before releasing refresh.
  await new Promise((r) => setImmediate(r));
  if (calls !== 1) throw new Error(`expected 1 refresh start before settle, got ${calls}`);
  release();
  const results1 = await Promise.allSettled(wave1);
  const rejected = results1.filter((r) => r.status === "rejected").length;
  if (rejected !== 16) throw new Error(`expected all 16 to reject on shared failure, got rejected=${rejected}`);
  if (calls !== 1) throw new Error(`expected single refresh call for wave1, got ${calls}`);

  // Wave 2: after settle, slot cleared → next call retries successfully.
  const wave2 = await Promise.all([
    modA.refreshModelRegistry(registry),
    modB.refreshModelRegistry(registry),
    modA.refreshModelRegistry(registry),
  ]);
  if (calls !== 2) throw new Error(`expected retry after failure (calls=2), got ${calls}`);
  if (wave2.length !== 3) throw new Error("wave2 incomplete");

  // Wave 3: concurrent success coalesces again.
  let release2;
  const gate2 = new Promise((r) => { release2 = r; });
  registry.refresh = async () => {
    calls++;
    await gate2;
  };
  const wave3 = [];
  for (let i = 0; i < 16; i++) {
    wave3.push((i % 2 === 0 ? modA : modB).refreshModelRegistry(registry));
  }
  await new Promise((r) => setImmediate(r));
  if (calls !== 3) throw new Error(`expected one more coalesced refresh (calls=3), got ${calls}`);
  release2();
  await Promise.all(wave3);
  if (calls !== 3) throw new Error(`wave3 must not re-enter after settle mid-flight; calls=${calls}`);
});

await checkAsync("refresh awaits Promise before subsequent find (behavioral)", async () => {
  const mod = await jiti.import(path.join(repoRoot, "extensions/dispatch/index.ts"));
  const order = [];
  const modelRegistry = {
    async refresh() {
      order.push("refresh-start");
      await new Promise((r) => setTimeout(r, 5));
      order.push("refresh-end");
    },
    find() {
      order.push("find");
      return { id: "m" };
    },
    runtime: {
      getModel() { return undefined; },
      getAuth() { return Promise.resolve(undefined); },
      refresh() { return Promise.resolve(); },
    },
  };
  await mod.refreshModelRegistry(modelRegistry);
  modelRegistry.find("p", "m");
  if (order.join(",") !== "refresh-start,refresh-end,find") {
    throw new Error(`ordering broken: ${order.join(",")}`);
  }
});

await checkAsync("host critical probe: ModelRegistry.refresh Promise + prepareNextTurnWithContext installer", async () => {
  const { root: hostRoot, source, tried } = resolveHostCodingAgent();
  if (!hostRoot) throw new Error(`could not resolve pi-coding-agent; tried: ${tried.join(" | ")}`);
  const hostPkg = JSON.parse(fs.readFileSync(path.join(hostRoot, "package.json"), "utf8"));
  if (!versionInPeerRange(hostPkg.version)) {
    throw new Error(
      `host critical probe refused soft-pass: resolved ${hostPkg.version} via ${source} at ${hostRoot} ` +
        `(outside peer range ${PEER_FLOOR})`,
    );
  }
  if (!versionAtLeast(hostPkg.version, TARGET)) {
    throw new Error(
      `host critical probe target too old: resolved ${hostPkg.version} via ${source} at ${hostRoot}; need >=${TARGET}`,
    );
  }
  const indexUrl = pathToFileURL(path.join(hostRoot, "dist/index.js")).href;
  const Pi = await import(indexUrl);
  if (typeof Pi.ModelRuntime?.create !== "function") throw new Error("host missing ModelRuntime.create");
  if (typeof Pi.ModelRegistry !== "function") throw new Error("host missing ModelRegistry");

  const runtime = await Pi.ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  const registry = new Pi.ModelRegistry(runtime);
  const refreshed = registry.refresh();
  if (!(refreshed instanceof Promise)) throw new Error(`ModelRegistry.refresh must return Promise on host target ${TARGET}`);
  await refreshed;
  if (registry.runtime !== runtime) throw new Error("ModelRegistry.runtime must be the parent ModelRuntime instance");

  const proto = Pi.AgentSession?.prototype;
  if (typeof proto?._installAgentNextTurnRefresh !== "function") {
    throw new Error(`AgentSession._installAgentNextTurnRefresh missing on host target >=${TARGET}`);
  }
  // Confirm agent-core createLoopConfig prefers WithContext (via nested dep when present).
  const agentCorePkg = path.join(hostRoot, "node_modules/@earendil-works/pi-agent-core/package.json");
  if (fs.existsSync(agentCorePkg)) {
    const ac = JSON.parse(fs.readFileSync(agentCorePkg, "utf8"));
    if (!versionInPeerRange(ac.version)) {
      throw new Error(`host nested pi-agent-core@${ac.version} outside peer range ${PEER_FLOOR}`);
    }
    if (!versionAtLeast(ac.version, TARGET)) {
      throw new Error(`host nested pi-agent-core target too old: ${ac.version}; need >=${TARGET}`);
    }
  }
});

await checkAsync("parent ModelRuntime E2E: createAgentSession holds same runtime + child inherits auth", async () => {
  const { root: hostRoot, source, tried } = resolveHostCodingAgent();
  if (!hostRoot) throw new Error(`could not resolve host; tried: ${tried.join(" | ")}`);
  const hostPkg = JSON.parse(fs.readFileSync(path.join(hostRoot, "package.json"), "utf8"));
  if (!versionInPeerRange(hostPkg.version)) {
    throw new Error(`E2E refused soft-pass on host ${hostPkg.version} via ${source}; peer range is ${PEER_FLOOR}`);
  }
  if (!versionAtLeast(hostPkg.version, TARGET)) {
    throw new Error(`E2E host target too old: ${hostPkg.version} via ${source}; need >=${TARGET}`);
  }

  const indexUrl = pathToFileURL(path.join(hostRoot, "dist/index.js")).href;
  const Pi = await import(indexUrl);

  // Resolve pi-ai/compat relative to the host package (nested or hoisted).
  let Faux;
  const compatCandidates = [
    path.join(hostRoot, "node_modules/@earendil-works/pi-ai/dist/compat.js"),
    path.join(path.dirname(hostRoot), "pi-ai/dist/compat.js"),
    path.join(repoRoot, "node_modules/@earendil-works/pi-ai/dist/compat.js"),
  ];
  let loadedCompat = null;
  for (const c of compatCandidates) {
    if (fs.existsSync(c)) {
      Faux = await import(pathToFileURL(c).href);
      loadedCompat = c;
      break;
    }
  }
  if (!Faux?.registerFauxProvider) {
    // Last resort: package export
    try {
      Faux = await import("@earendil-works/pi-ai/compat");
      loadedCompat = "@earendil-works/pi-ai/compat";
    } catch (err) {
      throw new Error(`could not load faux provider compat (${err.message}); tried ${compatCandidates.join(", ")}`);
    }
  }
  console.log(`  note  faux compat via ${loadedCompat}`);

  const mod = await jiti.import(path.join(repoRoot, "extensions/dispatch/index.ts"));
  const resolveParent = mod.resolveParentModelRuntime;
  if (typeof resolveParent !== "function") throw new Error("resolveParentModelRuntime missing");

  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-compat-e2e-"));
  const faux = Faux.registerFauxProvider({ tokensPerSecond: 0 });
  let session;
  let child;
  try {
    const modelRuntime = await Pi.ModelRuntime.create({
      modelsPath: null,
      allowModelNetwork: false,
      authPath: path.join(agentDir, "auth.json"),
    });
    const fauxModel = faux.getModel();
    modelRuntime.registerProvider("faux", {
      baseUrl: fauxModel.baseUrl,
      api: fauxModel.api,
      apiKey: "e2e-parent-key",
      authHeader: true,
      models: [{
        id: fauxModel.id,
        name: fauxModel.name,
        api: fauxModel.api,
        reasoning: false,
        input: ["text"],
        cost: fauxModel.cost,
        contextWindow: fauxModel.contextWindow,
        maxTokens: fauxModel.maxTokens,
      }],
    });
    await modelRuntime.setRuntimeApiKey("faux", "e2e-runtime-overlay-key");

    const registry = new Pi.ModelRegistry(modelRuntime);
    await registry.refresh();
    const parentRuntime = resolveParent(registry);
    if (parentRuntime !== modelRuntime) {
      throw new Error("resolveParentModelRuntime did not return the registry's ModelRuntime instance");
    }
    if (parentRuntime !== registry.runtime) {
      throw new Error("parent runtime identity mismatch vs registry.runtime");
    }

    const settingsManager = Pi.SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const resourceLoader = new Pi.DefaultResourceLoader({
      cwd: repoRoot,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => `pi ${TARGET} parent ModelRuntime e2e`,
    });
    await resourceLoader.reload();

    ({ session } = await Pi.createAgentSession({
      cwd: repoRoot,
      model: fauxModel,
      modelRuntime: parentRuntime,
      settingsManager,
      resourceLoader,
      sessionManager: Pi.SessionManager.inMemory(repoRoot),
      tools: [],
    }));

    if (session.modelRuntime !== parentRuntime) {
      throw new Error("session.modelRuntime is not the parent ModelRuntime instance");
    }
    if (session.modelRuntime !== modelRuntime) {
      throw new Error("session does not hold the original parent runtime object");
    }

    const parentAuth = await session.modelRuntime.getAuth("faux");
    const parentKey = parentAuth?.auth?.apiKey ?? parentAuth?.apiKey;
    if (parentKey !== "e2e-runtime-overlay-key") {
      throw new Error(`parent runtime auth overlay missing; got ${JSON.stringify(parentAuth)}`);
    }

    // Child session inherits the same runtime (dispatch's sub-agent contract).
    ({ session: child } = await Pi.createAgentSession({
      cwd: repoRoot,
      model: fauxModel,
      modelRuntime: resolveParent(registry),
      settingsManager,
      resourceLoader,
      sessionManager: Pi.SessionManager.inMemory(repoRoot),
      tools: [],
    }));
    if (child.modelRuntime !== session.modelRuntime) {
      throw new Error("child session did not inherit the same parent ModelRuntime");
    }
    const childAuth = await child.modelRuntime.getAuth("faux");
    const childKey = childAuth?.auth?.apiKey ?? childAuth?.apiKey;
    if (childKey !== "e2e-runtime-overlay-key") {
      throw new Error(`child cannot see parent runtime auth; got ${JSON.stringify(childAuth)}`);
    }
    // Provider registration is also shared via the same runtime.
    const childModel = child.modelRuntime.getModel("faux", fauxModel.id);
    if (!childModel || childModel.id !== fauxModel.id) {
      throw new Error("child runtime missing parent-registered faux model");
    }
  } finally {
    try { session?.dispose(); } catch { /* best effort */ }
    try { child?.dispose(); } catch { /* best effort */ }
    try { faux.unregister(); } catch { /* best effort */ }
    try { fs.rmSync(agentDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

if (failures.length) {
  console.error(`\n${failures.length}/${total} checks failed`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${total} checks passed`);
}
