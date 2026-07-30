/**
 * Shared host pi-coding-agent resolution for smokes.
 *
 * Prefer: PI_COMPAT_ROOT > legacy PI_08010_ROOT > active `pi` on PATH
 * (skipping repo-local installs when allowLocal=false) > import.meta.resolve
 * > local node_modules (only when allowLocal=true).
 *
 * Extracted from smoke-pi-08010-compat.mjs so turn-progress / model-fallback /
 * compaction remote smokes can locate the same external active host.
 *
 * No fixed Volta /home/worker hardcodes — PATH + explicit root env are enough.
 * Windows executable name variants retained for residual multi-platform notes.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PI_CODING_AGENT_NAME = "@earendil-works/pi-coding-agent";

export function readPkgVersion(pkgPath) {
  try {
    return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
  } catch {
    return null;
  }
}

export function readPkgName(pkgPath) {
  try {
    return JSON.parse(fs.readFileSync(pkgPath, "utf8")).name;
  } catch {
    return null;
  }
}

function safeRealpath(candidate) {
  try {
    return fs.realpathSync(path.resolve(candidate));
  } catch {
    return path.resolve(candidate);
  }
}

/** True when candidate is the repo itself or lives under repoRoot (realpath-safe). */
export function isRepoLocalPath(candidate, repoRoot) {
  const resolved = safeRealpath(candidate);
  const root = safeRealpath(repoRoot);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

/** Walk up from a resolved file (often dist/index.js / dist/cli.js) to package root. */
export function packageRootFromResolved(resolvedUrlOrPath, packageName = PI_CODING_AGENT_NAME) {
  let cur;
  try {
    cur = String(resolvedUrlOrPath).startsWith("file:")
      ? fileURLToPath(resolvedUrlOrPath)
      : path.resolve(String(resolvedUrlOrPath));
  } catch {
    return null;
  }
  if (fs.existsSync(cur) && fs.statSync(cur).isFile()) cur = path.dirname(cur);
  for (let i = 0; i < 8 && cur && cur !== path.dirname(cur); i++) {
    const pkgPath = path.join(cur, "package.json");
    if (fs.existsSync(pkgPath) && readPkgName(pkgPath) === packageName) return safeRealpath(cur);
    cur = path.dirname(cur);
  }
  return null;
}

/**
 * Resolve the package root behind the active `pi` executable on PATH.
 * When allowLocal=false, never returns a root under repoRoot.
 *
 * Windows residual: also probe pi.cmd / pi.exe next to PATH entries.
 */
export function activePiPackageRoot(repoRoot, options = {}) {
  const allowLocal = options.allowLocal !== false;
  const pathEntries = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  // Windows residual: pi.cmd / pi.exe may appear without a bare `pi` shim.
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
        if (!isRepoLocalPath(root, repoRoot)) {
          return { root, executable: candidate, real };
        }
        if (allowLocal) {
          repoLocal ??= { root, executable: candidate, real };
        }
      } catch {
        /* try the next PATH entry */
      }
    }
  }
  return allowLocal ? repoLocal : null;
}

/**
 * Prefer explicit compatibility roots, then the active pi executable. A local
 * import is only a fallback because direct Node resolution can select this
 * repository's node_modules instead of the process host.
 *
 * options.allowLocal (default true): when false, never return a repo-local root
 * from active pi / import.meta.resolve / local node_modules.
 */
export function resolveHostCodingAgent(repoRoot, options = {}) {
  const tried = [];
  const allowLocal = options.allowLocal !== false;

  for (const envName of ["PI_COMPAT_ROOT", "PI_08010_ROOT"]) {
    if (!process.env[envName]) continue;
    const root = path.resolve(process.env[envName]);
    const pkgPath = path.join(root, "package.json");
    tried.push(`${envName}=${root}`);
    if (!fs.existsSync(pkgPath)) {
      tried.push(`${envName}=missing-package.json`);
      continue;
    }
    const name = readPkgName(pkgPath);
    if (name !== PI_CODING_AGENT_NAME) {
      tried.push(`${envName}=rejected name=${String(name)}`);
      continue;
    }
    if (!allowLocal && isRepoLocalPath(root, repoRoot)) {
      tried.push(`${envName}=rejected-repo-local`);
      continue;
    }
    return { root: safeRealpath(root), source: envName, tried };
  }

  const activePi = activePiPackageRoot(repoRoot, { allowLocal });
  tried.push(
    activePi
      ? `active-pi=${activePi.executable}→${activePi.real}→root=${activePi.root}`
      : "active-pi=not found",
  );
  if (activePi) return { root: activePi.root, source: "active pi executable", tried };

  try {
    const resolved = import.meta.resolve(PI_CODING_AGENT_NAME);
    const root = packageRootFromResolved(resolved);
    tried.push(`import.meta.resolve→${resolved}→root=${root}`);
    if (root && (allowLocal || !isRepoLocalPath(root, repoRoot))) {
      return { root, source: "import.meta.resolve", tried };
    }
    if (root && !allowLocal && isRepoLocalPath(root, repoRoot)) {
      tried.push("import.meta.resolve=rejected-repo-local");
    }
  } catch (err) {
    tried.push(`import.meta.resolve failed: ${err.message}`);
  }

  if (allowLocal) {
    const local = path.join(repoRoot, "node_modules/@earendil-works/pi-coding-agent");
    tried.push(`local=${local}`);
    if (fs.existsSync(path.join(local, "package.json"))) {
      return { root: safeRealpath(local), source: "local node_modules", tried };
    }
  }

  // Volta /home/worker hardcodes removed: PATH + PI_COMPAT_ROOT/PI_08010_ROOT
  // are sufficient. Do not reintroduce machine-specific fallbacks.

  return { root: null, source: null, tried };
}

/** Nested/sibling package version under a coding-agent host root. */
export function hostPackageVersion(hostRoot, name) {
  if (name === PI_CODING_AGENT_NAME) {
    return readPkgVersion(path.join(hostRoot, "package.json"));
  }
  const root = hostPackageRoot(hostRoot, name);
  return root ? readPkgVersion(path.join(root, "package.json")) : null;
}

/** Nested/sibling package root under a coding-agent host root. */
export function hostPackageRoot(hostRoot, name) {
  if (name === PI_CODING_AGENT_NAME) return safeRealpath(hostRoot);
  const unscoped = name.startsWith("@earendil-works/")
    ? name.slice("@earendil-works/".length)
    : name;
  const candidates = [
    path.join(hostRoot, "node_modules", name),
    path.join(path.dirname(hostRoot), unscoped),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "package.json"))) return safeRealpath(candidate);
  }
  return null;
}

/** External (non-repo-local) host preferred for production-like smokes. */
export function resolveExternalHostCodingAgent(repoRoot) {
  const resolved = resolveHostCodingAgent(repoRoot, { allowLocal: false });
  if (!resolved.root) {
    // Also record any local candidate that would have been used, for diagnostics.
    const localOnly = resolveHostCodingAgent(repoRoot, { allowLocal: true });
    if (localOnly.root && isRepoLocalPath(localOnly.root, repoRoot)) {
      return {
        root: null,
        source: localOnly.source,
        tried: [...resolved.tried, "rejected-repo-local", ...localOnly.tried],
        external: false,
        localRoot: localOnly.root,
      };
    }
    return { ...resolved, external: false };
  }
  if (isRepoLocalPath(resolved.root, repoRoot)) {
    return {
      root: null,
      source: resolved.source,
      tried: [...resolved.tried, "rejected-repo-local"],
      external: false,
      localRoot: resolved.root,
    };
  }
  return { ...resolved, external: true };
}
