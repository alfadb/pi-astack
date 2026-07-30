/**
 * Load pi-ai's deep `convertResponsesMessages` helper without going through
 * the public `@earendil-works/pi-ai/api/*` subpath.
 *
 * Why: Pi's extension loader aliases `@earendil-works/pi-ai` (and `/compat`) to
 * the host install, but does not rewrite deep `/api/*` subpaths correctly. The
 * previous native `.mjs` re-export also sat outside jiti's TypeScript pipeline.
 *
 * Lazy + fail closed:
 *   - Module import is cheap and does NOT resolve pi-ai (so extension load
 *     succeeds with remote compaction disabled / default-off).
 *   - First actual conversion call resolves `@earendil-works/pi-ai/compat` via
 *     the current loader alias (host in production; explicit test override for
 *     independent smoke), validates package name + rejects this package's own
 *     local node_modules pi-ai, then dynamic-imports the deep helper.
 *
 * No hardcoded global npm paths, NODE_PATH, cwd, or silent repo node_modules
 * fallback. No copy of the conversion function.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Api, Context, Model, Tool } from "@earendil-works/pi-ai";
import type { ResponseInput } from "openai/resources/responses/responses.js";

const PI_AI_NAME = "@earendil-works/pi-ai";
const PI_ASTACK_PACKAGE_NAME = "@alfadb/pi-astack";
const COMPAT_SPEC = `${PI_AI_NAME}/compat`;
const SHARED_REL = ["api", "openai-responses-shared.js"] as const;

/**
 * Explicit test-only escape hatch for independent smokes that intentionally
 * exercise the repo's devDependency pi-ai. Production and default smoke paths
 * must leave this unset (fail closed against local node_modules).
 * Requires both NODE_ENV=test and a true-ish value of this env.
 */
export const TEST_ALLOW_LOCAL_PI_AI_ENV = "PI_ASTACK_TEST_ALLOW_LOCAL_PI_AI";

/** Options mirror of pi-ai `ConvertResponsesToolsOptions` (no deep import). */
export interface ConvertResponsesToolsOptions {
  strict?: boolean | null;
  supportsStrictMode?: boolean;
  supportsOpenAIGrammarTools?: boolean;
  deferLoading?: boolean;
}

/** Options mirror of pi-ai `ConvertResponsesMessagesOptions` (no deep import). */
export interface ConvertResponsesMessagesOptions {
  includeSystemPrompt?: boolean;
  grammarToolInputProperties?: ReadonlyMap<string, string>;
  deferredTools?: ReadonlyMap<string, Tool>;
  toolOptions?: ConvertResponsesToolsOptions;
}

/**
 * Accurate signature of pi-ai `convertResponsesMessages`.
 * Type-only public root Tool + openai ResponseInput — no deep `/api/*` runtime import.
 */
export type ConvertResponsesMessages = <TApi extends Api = Api>(
  model: Model<TApi>,
  context: Context,
  allowedToolCallProviders: ReadonlySet<string>,
  options?: ConvertResponsesMessagesOptions,
) => ResponseInput;

export interface LoadedOpenAIResponsesShared {
  convertResponsesMessages: ConvertResponsesMessages;
  sourcePath: string;
  compatUrl: string;
  packageRoot: string;
}

function fail(detail: string): never {
  throw new Error(`openai-responses-shared-loader: ${detail}`);
}

function safeRealpath(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function isPathInsideOrEqual(candidate: string, root: string): boolean {
  const resolved = safeRealpath(candidate);
  const base = safeRealpath(root);
  return resolved === base || resolved.startsWith(`${base}${path.sep}`);
}

/** Walk up from this module to the @alfadb/pi-astack package root (best-effort). */
function findPiAstackPackageRoot(fromPath: string): string | null {
  let cur = path.dirname(fromPath);
  for (let i = 0; i < 12; i++) {
    const pkgPath = path.join(cur, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const name = JSON.parse(fs.readFileSync(pkgPath, "utf8")).name;
        if (name === PI_ASTACK_PACKAGE_NAME) return safeRealpath(cur);
      } catch {
        /* keep walking */
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function packageRootFromFile(filePath: string, expectedName: string): { root: string; name: string | undefined } {
  let packageRoot = path.dirname(filePath);
  let packageName: string | undefined;
  for (let i = 0; i < 8; i++) {
    const pkgPath = path.join(packageRoot, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        packageName = JSON.parse(fs.readFileSync(pkgPath, "utf8")).name;
      } catch {
        packageName = undefined;
      }
      if (packageName === expectedName) {
        return { root: safeRealpath(packageRoot), name: packageName };
      }
      // Keep walking if name mismatch (e.g. monorepo intermediate package.json).
    }
    const parent = path.dirname(packageRoot);
    if (parent === packageRoot) break;
    packageRoot = parent;
  }
  return { root: safeRealpath(path.dirname(filePath)), name: packageName };
}

function testAllowsLocalPiAi(): boolean {
  // Dual gate: NODE_ENV=test AND explicit true-ish override env.
  if (process.env.NODE_ENV !== "test") return false;
  const raw = process.env[TEST_ALLOW_LOCAL_PI_AI_ENV];
  if (raw == null || raw === "") return false;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

async function resolveAndLoad(): Promise<LoadedOpenAIResponsesShared> {
  let compatUrl: string;
  try {
    compatUrl = import.meta.resolve(COMPAT_SPEC);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`failed to resolve ${COMPAT_SPEC} (${msg})`);
  }

  if (typeof compatUrl !== "string" || !compatUrl.startsWith("file:")) {
    fail(`${COMPAT_SPEC} must resolve to a file: URL, got ${String(compatUrl)}`);
  }

  let compatPath: string;
  try {
    compatPath = fileURLToPath(compatUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`invalid file URL from ${COMPAT_SPEC}: ${compatUrl} (${msg})`);
  }

  if (!fs.existsSync(compatPath)) {
    fail(`compat path does not exist: ${compatPath}`);
  }

  const distDir = path.dirname(compatPath);
  const { root: packageRoot, name: packageName } = packageRootFromFile(compatPath, PI_AI_NAME);

  if (packageName !== PI_AI_NAME) {
    fail(
      `compat resolved outside ${PI_AI_NAME} (name=${String(packageName)}, path=${compatPath})`,
    );
  }

  // Fail closed: never silently use this package's own local node_modules pi-ai
  // (devDependency). Production must load host-aliased pi-ai; independent smoke
  // may set PI_ASTACK_TEST_ALLOW_LOCAL_PI_AI explicitly.
  const selfPackageRoot = findPiAstackPackageRoot(fileURLToPath(import.meta.url));
  if (selfPackageRoot && isPathInsideOrEqual(packageRoot, selfPackageRoot) && !testAllowsLocalPiAi()) {
    fail(
      `refusing local ${PI_AI_NAME} under ${PI_ASTACK_PACKAGE_NAME} at ${packageRoot}` +
        ` (test-only local loads require NODE_ENV=test and ${TEST_ALLOW_LOCAL_PI_AI_ENV}=1;` +
        ` production requires host-aliased pi-ai/compat)`,
    );
  }

  // Prefer the shared file next to the resolved compat entry (same dist/).
  const sourcePath = path.join(distDir, ...SHARED_REL);
  if (!fs.existsSync(sourcePath)) {
    fail(`${SHARED_REL.join("/")} missing next to compat at ${sourcePath}`);
  }

  let mod: { convertResponsesMessages?: unknown };
  try {
    mod = await import(pathToFileURL(sourcePath).href);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`dynamic import failed for ${sourcePath} (${msg})`);
  }

  const fn = mod.convertResponsesMessages;
  if (typeof fn !== "function") {
    fail(`convertResponsesMessages export missing from ${sourcePath}`);
  }

  return {
    convertResponsesMessages: fn as ConvertResponsesMessages,
    sourcePath: safeRealpath(sourcePath),
    compatUrl,
    packageRoot,
  };
}

/** Cached load promise — one resolve attempt per process/module instance. */
let loadPromise: Promise<LoadedOpenAIResponsesShared> | undefined;

/**
 * Lazily resolve and cache the host (or test-override local) deep helper.
 * Safe to call repeatedly; first failure rejects and is cached.
 */
export function loadOpenAIResponsesShared(): Promise<LoadedOpenAIResponsesShared> {
  loadPromise ??= resolveAndLoad();
  return loadPromise;
}

/** Async wrapper used by remote compaction conversion paths. */
export async function convertResponsesMessages<TApi extends Api = Api>(
  model: Model<TApi>,
  context: Context,
  allowedToolCallProviders: ReadonlySet<string>,
  options?: ConvertResponsesMessagesOptions,
): Promise<ResponseInput> {
  const loaded = await loadOpenAIResponsesShared();
  return loaded.convertResponsesMessages(model, context, allowedToolCallProviders, options);
}

/** Test/audit: reset the cached promise (does not unload already-imported modules). */
export function __resetOpenAIResponsesSharedLoaderForTests(): void {
  loadPromise = undefined;
}
