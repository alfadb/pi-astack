#!/usr/bin/env node
/**
 * smoke-script-registry-drift — keep smoke gate discovery honest.
 *
 * package.json#scripts is the live truth for default smoke gates. Every
 * scripts/smoke-*.mjs file must be registered under a smoke:* npm script,
 * and every smoke:* script must point at an existing scripts/smoke-*.mjs file.
 *
 * Live LLM prompt dossiers are intentionally excluded from the default gate:
 * they must use scripts/dossier-*.mjs and be registered under dossier:*.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

// True when this module is the CLI entrypoint (not imported as a library).
// The exported detectors below are pure and reusable; the registry checks
// and process.exit at the bottom must only run on `node scripts/...`.
const isMain = import.meta.url === pathToFileURL(process.argv[1] || "").href;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const scriptsDir = path.join(repoRoot, "scripts");
const packagePath = path.join(repoRoot, "package.json");
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const packageScripts = pkg.scripts ?? {};

const smokeFiles = fs.readdirSync(scriptsDir)
  .filter((name) => /^smoke-.*\.mjs$/.test(name))
  .map((name) => `scripts/${name}`)
  .sort();
const dossierFiles = fs.readdirSync(scriptsDir)
  .filter((name) => /^dossier-.*\.mjs$/.test(name))
  .map((name) => `scripts/${name}`)
  .sort();

function smokeFileFromCommand(command) {
  const match = /^node\s+(scripts\/smoke-[^\s]+\.mjs)$/.exec(command);
  return match?.[1] ?? null;
}

function dossierFileFromCommand(command) {
  const match = /^node\s+(scripts\/dossier-[^\s]+\.mjs)(?:\s+.*)?$/.exec(command);
  return match?.[1] ?? null;
}

const registeredSmoke = Object.entries(packageScripts)
  .filter(([name]) => name.startsWith("smoke:"));
const registeredDossiers = Object.entries(packageScripts)
  .filter(([name]) => name.startsWith("dossier:"));
const registeredSmokeFiles = new Map(
  registeredSmoke.map(([name, command]) => [name, smokeFileFromCommand(command)]),
);
const registeredDossierFiles = new Map(
  registeredDossiers.map(([name, command]) => [name, dossierFileFromCommand(command)]),
);

const smokeFileSet = new Set(smokeFiles);
const registeredSmokeFileSet = new Set([...registeredSmokeFiles.values()].filter(Boolean));
const dossierFileSet = new Set(dossierFiles);
const registeredDossierFileSet = new Set([...registeredDossierFiles.values()].filter(Boolean));

const failures = [];
function check(name, ok, detail = "") {
  if (ok) {
    console.log(`  ok    ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

// CLI mode only: the registry checks below are side effects — they must not
// run when this module is imported (review probe / detector reuse). The
// block keeps its original indentation to keep the diff minimal.
if (isMain) {
console.log("smoke script registry drift");

const malformedSmoke = [...registeredSmokeFiles]
  .filter(([, file]) => !file)
  .map(([name]) => `${name}=${packageScripts[name]}`);
check("all smoke:* scripts use `node scripts/smoke-*.mjs`", malformedSmoke.length === 0, malformedSmoke.join("\n"));

const unregisteredSmokeFiles = smokeFiles.filter((file) => !registeredSmokeFileSet.has(file));
check("every scripts/smoke-*.mjs file is registered", unregisteredSmokeFiles.length === 0, unregisteredSmokeFiles.join("\n"));

const missingSmokeTargets = [...registeredSmokeFiles]
  .filter(([, file]) => file && !smokeFileSet.has(file))
  .map(([name, file]) => `${name} -> ${file}`);
check("every smoke:* target exists on disk", missingSmokeTargets.length === 0, missingSmokeTargets.join("\n"));

const duplicateSmokeTargets = [...registeredSmokeFileSet]
  .filter((file) => [...registeredSmokeFiles.values()].filter((value) => value === file).length > 1);
check("no smoke file is registered more than once", duplicateSmokeTargets.length === 0, duplicateSmokeTargets.join("\n"));

const malformedDossiers = [...registeredDossierFiles]
  .filter(([, file]) => !file)
  .map(([name]) => `${name}=${packageScripts[name]}`);
check("all dossier:* scripts use `node scripts/dossier-*.mjs`", malformedDossiers.length === 0, malformedDossiers.join("\n"));

const unregisteredDossiers = dossierFiles.filter((file) => !registeredDossierFileSet.has(file));
check("every scripts/dossier-*.mjs file is registered as dossier:*", unregisteredDossiers.length === 0, unregisteredDossiers.join("\n"));

const missingDossierTargets = [...registeredDossierFiles]
  .filter(([, file]) => file && !dossierFileSet.has(file))
  .map(([name, file]) => `${name} -> ${file}`);
check("every dossier:* target exists on disk", missingDossierTargets.length === 0, missingDossierTargets.join("\n"));

const dossierUnderSmoke = registeredSmoke
  .filter(([, command]) => /scripts\/dossier-/.test(command))
  .map(([name, command]) => `${name}=${command}`);
check("dossier scripts are not in the default smoke gate", dossierUnderSmoke.length === 0, dossierUnderSmoke.join("\n"));

const retiredRuntimeArtifacts = [
  "extensions/_shared/production-trace-replay.ts",
  "scripts/dossier-convergence-production-trace.mjs",
  "scripts/_convergence-production-trace-worker.mjs",
];
const retiredOnDisk = retiredRuntimeArtifacts.filter((file) => fs.existsSync(path.join(repoRoot, file)));
const retiredPackageRefs = Object.entries(packageScripts).filter(([, command]) => retiredRuntimeArtifacts.some((file) => String(command).includes(file)));
check("retired P1-B runtime trace artifacts stay forward-deleted", retiredOnDisk.length === 0, retiredOnDisk.join("\n"));
check("package scripts do not resurrect retired P1-B runtime trace entrypoints", retiredPackageRefs.length === 0, retiredPackageRefs.map(([name, command]) => `${name}=${command}`).join("\n"));

check("retired prepush alias stays removed", packageScripts["prepush:adr0039"] === undefined);
check(
  "standalone ADR0039 checker has a neutral manual-check alias",
  packageScripts["check:adr0039-integrity"] === "node scripts/pre-push-adr0039-reconcile.mjs --abrain ~/.abrain",
  String(packageScripts["check:adr0039-integrity"] ?? "missing"),
);
const manualCheckerSource = fs.readFileSync(path.join(repoRoot, "scripts/pre-push-adr0039-reconcile.mjs"), "utf8");
check("standalone ADR0039 checker is not documented as a live hook/runtime gate", manualCheckerSource.includes("manual local integrity checker") && !manualCheckerSource.includes("called by pushAsync") && !manualCheckerSource.includes("git push"));
check(
  "ADR0039 manual checker output uses local-integrity wording",
  manualCheckerSource.includes("PASS — ADR0039 local integrity check passed.") &&
    !manualCheckerSource.includes("PASS — ADR0039 pre-push blocker passed."),
);
const reconcileSmokeSource = fs.readFileSync(path.join(repoRoot, "scripts/smoke-adr0039-reconcile.mjs"), "utf8");
check(
  "ADR0039 reconcile runner output avoids push-gate/pre-push wording",
  reconcileSmokeSource.includes("PASS — ADR0039 local integrity checks passed.") &&
    !reconcileSmokeSource.includes("PASS — ADR0039 reconcile push-gate checks passed.") &&
    !reconcileSmokeSource.includes("PASS — B4 pre-push hardblock"),
);
}

// T0 eval/replay split lock (ADR 0027 C6): the default smoke gate must stay
// offline-deterministic. Production/live acceptance (real episodes, real
// providers, live pipeline subprocesses) lives ONLY in the explicit
// dossier:* scripts. This targets the "mixed responsibility" regression —
// smoke files carrying real-data/live acceptance — not the generic registry
// rules above (registration + smoke-gate exclusion are already covered).
//
// The smoke-side lock is AST-based (typescript compiler API, already a
// direct dependency) and closes real child_process execution into a NARROW
// approved subset (ADR 0027 C6): every real call identified through a
// scope-aware node:child_process binding must be EITHER
//   (a) direct process.execPath / static node executable / static known
//       t0-*.mjs command, whose argv is fully, finitely, statically reduced
//       (helper callsites expanded; cycle/budget-aware spread flattening;
//       NO unknown/dynamic elements, NO unresolved spread residuals), and
//       which identifies EXACTLY ONE T0_ENTRIES entry passing the per-entry
//       required flags + every dangerous path flag's value as an explicit
//       tmp root (os.tmpdir()/fs.mkdtemp*), OR
//   (b) the defined exact Node `-c/--check <static file>` syntax-only form
//       with shell absent/disabled (node -c parses the file, never runs it).
// Any OTHER real child_process call fails closed UNCONDITIONALLY as an
// unapproved/unresolvable child_process call — regardless of whether a T0
// marker is identifiable first: unknown/dynamic commands, unresolvable
// argv, resolved arrays containing unknown elements, spread residuals that
// exhaust the recursion budget or cycle, exec/execSync command strings,
// shell -c / shell:true / npm/yarn/pnpm/env/timeout/unknown wrappers, and
// fully static NON-T0 subprocesses. Only a node:child_process binding is a
// real call — a same-named spawnSync/execFileSync imported from or
// destructured off an arbitrary other module is NOT a real call and is
// allowed. makeJudgeInvoker is an executable-REFERENCE lock: any
// identifier/property/element that is named makeJudgeInvoker or resolves to
// it (import aliases, multi-hop const aliases, destructured reads,
// namespace/dynamic-import properties provably from t0-eval-common or
// unprovable) is rejected even when never invoked — assigned-but-never-
// called, object properties, Reflect.apply, bind, arrays, destructuring all
// reject; only import-specifier declarations, object-literal property keys,
// and string/comment occurrences are allowed (a same-named property
// provably from a different module is allowed). Real production-path
// expressions (path.join/path.resolve with static ".pi-astack" +
// "t0-episodes" fragments, standalone whole-path strings, module-property
// paths) and real file-IO detector stay. Helpers (function declarations /
// arrows / [script, ...args] patterns, multiple callsites) are verified
// callsite-by-callsite when every callsite is fully statically reducible;
// an unresolvable callsite or a helper with no resolvable callsite fails
// closed as a generic failure record that t0SpawnHits outputs
// unconditionally — no silent drops, ever. Comments, assert strings, and
// strings merely NAMING the markers cannot trip the lock, and
// whitespace/newline tricks cannot hide a real call.
// T0 smoke files are discovered from the filesystem (scripts/smoke-t0-*.mjs)
// — never hardcoded — so a new T0 smoke is gated automatically. Every
// discovered file must pass the parse / invoker / production-path / spawn /
// path-value checks below.
const t0SmokeFiles = fs.readdirSync(scriptsDir)
  .filter((name) => /^smoke-t0-.*\.mjs$/.test(name))
  .map((name) => `scripts/${name}`)
  .sort();
const t0LiveDossierFiles = ["scripts/dossier-t0-eval-production.mjs", "scripts/dossier-t0-replay-production.mjs"];
const t0ReadonlyDossierFiles = ["scripts/dossier-t0-replay-fair-production.mjs"];

// Per-entry required-flags table (ADR 0027 C6): every real spawn of a T0
// CLI entry in a smoke must explicitly pass the flags that would otherwise
// fall back to dangerous production read/write/provider defaults. Entries
// not listed here fail closed if they ever appear in a spawn.
const T0_ENTRIES = {
  "t0-eval": { marker: "t0-eval.mjs", required: ["--episodes", "--output", "--models-json"] },
  "t0-replay-eval": { marker: "t0-replay-eval.mjs", required: ["--dataset", "--output", "--models-json"] },
  "t0-replay-select": { marker: "t0-replay-select.mjs", required: ["--episodes", "--meta"] },
  "t0-replay-build": { marker: "t0-replay-build.mjs", required: ["--episodes", "--meta", "--output", "--models-json"] },
  "t0-eval-select": { marker: "t0-eval-select.mjs", required: ["--episodes", "--meta"] },
  "t0-eval-aggregate": { marker: "t0-eval-aggregate.mjs", required: ["--episodes", "--meta", "--eval"] },
  "t0-replay-aggregate": { marker: "t0-replay-aggregate.mjs", required: ["--dataset", "--eval"] },
};

// npm/yarn/pnpm `run <t0:* script>` aliases, derived from package.json#scripts
// (the live truth): `npm run t0:eval` is a real T0 CLI spawn with the same
// production defaults as `node scripts/t0-eval.mjs`, so it must be mapped back
// to the entry and gated identically. Scripts whose target is not a defined
// T0_ENTRIES entry (e.g. t0:episode-build) fail closed as unknown entries.
const PACKAGE_T0_ALIASES = {};
for (const [name, command] of Object.entries(packageScripts)) {
  if (!name.startsWith("t0:")) continue;
  const m = /^node\s+scripts\/(t0-[^\s]+\.mjs)$/.exec(String(command));
  if (m) PACKAGE_T0_ALIASES[name] = m[1].replace(/\.mjs$/, "");
}

// Per-entry dangerous PATH flags (data/output/models/eval/selection/
// checkpoint). A real spawn must not only pass the required flag NAMES —
// every present path flag's VALUE must be statically provable as an explicit
// tmp root (os.tmpdir()/fs.mkdtemp* or an absolute os.tmpdir() path); an
// unknown/env/production value fails closed. --blind-key is a string key, not
// a path, so it is deliberately absent.
const T0_PATH_FLAGS = {
  "t0-eval": ["--episodes", "--replay-dataset", "--output", "--models-json"],
  "t0-replay-eval": ["--dataset", "--replay-dataset", "--output", "--models-json"],
  "t0-replay-select": ["--episodes", "--meta", "--exclusions", "--stats", "--output", "--checkpoint-dir", "--models-json"],
  "t0-replay-build": ["--selection", "--episodes", "--meta", "--exclusions", "--stats", "--output", "--models-json"],
  "t0-eval-select": ["--episodes", "--meta", "--exclusions", "--stats", "--output"],
  "t0-eval-aggregate": ["--episodes", "--meta", "--eval", "--output"],
  "t0-replay-aggregate": ["--dataset", "--eval", "--output"],
};

function parseSmokeSource(src) {
  return ts.createSourceFile("smoke.mjs", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

// Depth-limited expression unwrapping: strip transparent wrapper nodes
// (parenthesized expressions, TypeScript as/type-assertion/non-null/
// satisfies casts) so callee/command/target identification sees through
// them. `(makeJudgeInvoker)(...)`, `(path.join)(...)`, `(script)` all
// resolve to their inner expression.
function unwrapExpression(node, depth = 0) {
  if (!node || depth > 8) return node;
  if (ts.isParenthesizedExpression(node)) return unwrapExpression(node.expression, depth + 1);
  if (ts.isAsExpression(node)) return unwrapExpression(node.expression, depth + 1);
  if (ts.isTypeAssertionExpression(node)) return unwrapExpression(node.expression, depth + 1);
  if (ts.isNonNullExpression(node)) return unwrapExpression(node.expression, depth + 1);
  if (ts.isSatisfiesExpression(node)) return unwrapExpression(node.expression, depth + 1);
  return node;
}

function staticString(node) {
  if (!node) return null;
  node = unwrapExpression(node);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  // Numeric literals resolve to their source text, so `[makeJudgeInvoker][0]`
  // / `path[0]` / `{ 0: x }` element/property keys stay statically visible.
  if (ts.isNumericLiteral(node)) return node.text;
  return null;
}

// Object-literal property key: identifier, string/numeric literal, or a
// static computed key (`{ ["shell"]: true }`). Returns null when the key
// is not statically resolvable.
function propertyKeyOf(prop) {
  if (ts.isIdentifier(prop.name)) return prop.name.text;
  if (ts.isComputedPropertyName(prop.name)) {
    const s = staticString(prop.name.expression);
    return s !== null ? s : null;
  }
  return staticString(prop.name);
}

function calleeBaseName(node) {
  node = unwrapExpression(node);
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isImportKeyword(node)) return "import";
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) {
    const key = staticString(node.argumentExpression);
    return key ?? null;
  }
  return null;
}

function calleeNameOf(node) {
  node = unwrapExpression(node);
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isImportKeyword(node)) return "import";
  if (ts.isPropertyAccessExpression(node)) {
    const obj = calleeNameOf(node.expression);
    return obj ? `${obj}.${node.name.text}` : node.name.text;
  }
  if (ts.isElementAccessExpression(node)) {
    const key = staticString(node.argumentExpression);
    if (key !== null) {
      const obj = calleeNameOf(node.expression);
      return obj ? `${obj}.${key}` : key;
    }
  }
  return null;
}

// Limited lexical binding collection: const initializers, function
// declarations, function parameters (for the `[script, ...args]` helper
// pattern), and default imports. Bindings are kept per-scope and resolved
// by walking the ancestor scope chain from the USE site, so an unrelated
// inner-scope binding with the same name can never shadow a real helper
// globally. Scope kinds mirror JS lexical scoping: function scopes (params
// + body), block scopes, for-loop scopes (initializer/condition/increment/
// body), switch CaseBlock scopes (all case clauses share one), and catch
// scopes (the catch parameter binds there, the block nests inside). Only a
// true `const` declaration (VariableDeclarationList flags) is statically
// reducible — `let`/`var` are mutable and never grant proof through
// resolveStatic/resolveStaticModuleSpecifier/moduleSourceKind/tmp
// rootedness; `var` hoists to the nearest function/root scope. A duplicate
// declaration in the same scope is recorded as ambiguous so every proof
// fails closed (the real checker rejects illegal duplicates; `var x; var
// x;` is legal JS but unprovable statically). Deliberately not a full
// interpreter — only the shapes the lock needs (const/function/param/
// import) are tracked.
function collectBindings(sourceFile) {
  const rootScope = { parent: null, bindings: new Map(), kind: "root" };
  const scopeNodes = new Map(); // scope-creating node -> scope
  let current = rootScope;
  const declareIn = (scope, name, info) => {
    if (scope.bindings.has(name)) {
      // Duplicate declaration in the same scope: ambiguous — every proof
      // must fail closed (never a silent Map.set overwrite).
      scope.bindings.set(name, { kind: "ambiguous" });
      return;
    }
    scope.bindings.set(name, info);
  };
  const declare = (name, info) => declareIn(current, name, info);
  // `var` hoists to the nearest function/root scope (never a block/for/
  // case/catch scope).
  const declareVar = (name, info) => {
    let scope = current;
    while (scope && scope.kind !== "function" && scope.kind !== "root") scope = scope.parent;
    declareIn(scope ?? rootScope, name, info);
  };
  const walk = (node) => {
    if (!node) return;
    if (ts.isFunctionLike(node)) {
      // Function declarations bind their name in the OUTER scope (hoisting);
      // params bind in the function's own scope.
      if (ts.isFunctionDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
        declare(node.name.text, { kind: "function", node });
      }
      const fnScope = { parent: current, bindings: new Map(), kind: "function" };
      current = fnScope;
      scopeNodes.set(node, fnScope);
      for (const p of node.parameters ?? []) {
        if (ts.isIdentifier(p.name)) declare(p.name.text, { kind: "param" });
      }
      walk(node.body);
      current = fnScope.parent;
      return;
    }
    if (ts.isBlock(node)) {
      const blockScope = { parent: current, bindings: new Map(), kind: "block" };
      current = blockScope;
      scopeNodes.set(node, blockScope);
      for (const stmt of node.statements) walk(stmt);
      current = blockScope.parent;
      return;
    }
    // For loops create their own lexical scope: the initializer (for-init
    // const/let), condition, increment, and body all live inside it, so a
    // loop-local binding can never shadow an outer binding outside the loop.
    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      const forScope = { parent: current, bindings: new Map(), kind: "for" };
      current = forScope;
      scopeNodes.set(node, forScope);
      if (ts.isForStatement(node)) {
        walk(node.initializer);
        walk(node.condition);
        walk(node.incrementor);
      } else {
        walk(node.initializer);
        walk(node.expression);
      }
      walk(node.statement);
      current = forScope.parent;
      return;
    }
    // Switch CaseBlock: every case clause shares one lexical scope.
    if (ts.isCaseBlock(node)) {
      const caseScope = { parent: current, bindings: new Map(), kind: "case" };
      current = caseScope;
      scopeNodes.set(node, caseScope);
      for (const clause of node.clauses) walk(clause);
      current = caseScope.parent;
      return;
    }
    // CatchClause: the catch parameter binds in the catch's own scope; the
    // block nests inside it.
    if (ts.isCatchClause(node)) {
      const catchScope = { parent: current, bindings: new Map(), kind: "catch" };
      current = catchScope;
      scopeNodes.set(node, catchScope);
      if (node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name)) {
        declare(node.variableDeclaration.name.text, { kind: "param" });
      }
      walk(node.block);
      current = catchScope.parent;
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      // Only a true `const` declaration (VariableDeclarationList flags) is
      // statically reducible; `let`/`var` are mutable and never grant proof
      // through resolveStatic/resolveStaticModuleSpecifier/moduleSourceKind/
      // tmp-rootedness. `var` hoists to the nearest function/root scope.
      const declList = node.parent;
      const flags = ts.isVariableDeclarationList(declList) ? declList.flags : 0;
      const isConst = (flags & ts.NodeFlags.Const) !== 0;
      const isVar = !isConst && (flags & ts.NodeFlags.Let) === 0;
      const kind = isConst ? "const" : "mutable";
      const bind = isVar ? declareVar : declare;
      if (ts.isIdentifier(node.name)) {
        bind(node.name.text, { kind, init: node.initializer ?? null });
      } else if (ts.isObjectBindingPattern(node.name)) {
        // `const { makeJudgeInvoker: invoke } = await import(...)` — the
        // destructured rename binds `invoke` to the imported property.
        for (const el of node.name.elements) {
          if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
            const prop = el.propertyName
              ? (ts.isIdentifier(el.propertyName) ? el.propertyName.text : staticString(el.propertyName))
              : el.name.text;
            bind(el.name.text, { kind, init: node.initializer ?? null, destructuredProp: prop });
          }
        }
      }
    } else if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      // `import fs from "node:fs"` — a real default import binds the name;
      // provenance (node:os/node:fs/node:path/node:child_process) is decided
      // from the moduleSpecifier, never from the surface name.
      if (clause && clause.name) {
        declare(clause.name.text, { kind: "defaultImport", moduleSpecifier: node.moduleSpecifier });
      }
      const named = clause?.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          if (ts.isIdentifier(el.name)) {
            const importedName = el.propertyName ? el.propertyName.text : el.name.text;
            if (importedName === "default") {
              // `import { default as path } from "node:path"` binds the same
              // default export as `import path from "node:path"` — normalize
              // to defaultImport so node:path/node:os/node:fs provenance is
              // uniform. The static child_process surface pass still rejects
              // a named `default` import of child_process on its own AST
              // pass (never relaxed by this normalization).
              declare(el.name.text, { kind: "defaultImport", moduleSpecifier: node.moduleSpecifier });
            } else {
              declare(el.name.text, { kind: "import", importedName, moduleSpecifier: node.moduleSpecifier });
            }
          }
        }
      } else if (named && ts.isNamespaceImport(named)) {
        // `import * as C from "..."` — module namespace; property access on it
        // (C.makeJudgeInvoker / C.DEFAULT_EPISODES_PATH) is resolved by the
        // alias/production-path detectors.
        declare(named.name.text, { kind: "namespace", moduleSpecifier: node.moduleSpecifier });
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
  const scopeOf = (node) => {
    let cur = node;
    while (cur) {
      const scope = scopeNodes.get(cur);
      if (scope) return scope;
      cur = cur.parent;
    }
    return rootScope;
  };
  return {
    lookup: (name, useNode) => {
      let scope = useNode ? scopeOf(useNode) : rootScope;
      while (scope) {
        const info = scope.bindings.get(name);
        if (info) return info;
        scope = scope.parent;
      }
      return undefined;
    },
  };
}

function findReturnExpression(fnNode) {
  let found = null;
  const visit = (node) => {
    if (found) return;
    if (node !== fnNode && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) {
      found = node.expression;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fnNode, visit);
  return found;
}

// Binding-aware resolution of a tmp-fixture callee to its canonical name:
// "os.tmpdir" / "fs.mkdtempSync" / "fs.mkdtemp" ONLY when the module
// provenance is statically provable — a static default/named/namespace
// import, a dynamic import/require (through scope-aware static module-spec
// resolution), or a const alias/destructure chain of one of those. A
// fake/local `const os = { tmpdir: … }`, a param `os`, a bare undeclared
// `os`/`fs`, or a bare/local `mkdtempSync` never grants tmp proof. Returns
// null when the callee is not provably node:os tmpdir / node:fs mkdtemp*.
function tmpRootCalleeOf(node, lookup, depth = 0) {
  if (!node || depth > 8) return null;
  node = unwrapExpression(node);
  if (ts.isIdentifier(node)) {
    const info = lookup(node.text, node);
    if (!info) return null;
    if (info.kind === "import") {
      const imported = info.importedName;
      const spec = info.moduleSpecifier;
      if (imported === "tmpdir" && ts.isStringLiteral(spec) && isModuleSpecOf(spec.text, "os")) return "os.tmpdir";
      if ((imported === "mkdtempSync" || imported === "mkdtemp") && ts.isStringLiteral(spec) && isModuleSpecOf(spec.text, "fs")) {
        return imported === "mkdtempSync" ? "fs.mkdtempSync" : "fs.mkdtemp";
      }
      return null;
    }
    if (info.kind === "const") {
      if (info.destructuredProp !== undefined) {
        // `const { tmpdir } = await import("node:os")` /
        // `const { mkdtempSync } = require("node:fs")` — the init's
        // provable module decides ("no" and "unknown" both fail closed).
        if (info.destructuredProp === "tmpdir") return moduleSourceKind(info.init, "os", lookup) === "yes" ? "os.tmpdir" : null;
        if (info.destructuredProp === "mkdtempSync" || info.destructuredProp === "mkdtemp") {
          return moduleSourceKind(info.init, "fs", lookup) === "yes" ? (info.destructuredProp === "mkdtempSync" ? "fs.mkdtempSync" : "fs.mkdtemp") : null;
        }
        return null;
      }
      return tmpRootCalleeOf(info.init, lookup, depth + 1);
    }
    return null; // param / function / undeclared binding — no tmp proof
  }
  if (ts.isPropertyAccessExpression(node)) {
    const prop = node.name.text;
    if (prop === "tmpdir") return moduleSourceKind(node.expression, "os", lookup) === "yes" ? "os.tmpdir" : null;
    if (prop === "mkdtempSync" || prop === "mkdtemp") {
      return moduleSourceKind(node.expression, "fs", lookup) === "yes" ? (prop === "mkdtempSync" ? "fs.mkdtempSync" : "fs.mkdtemp") : null;
    }
    return null;
  }
  if (ts.isElementAccessExpression(node)) {
    const key = staticString(node.argumentExpression);
    if (key === "tmpdir") return moduleSourceKind(node.expression, "os", lookup) === "yes" ? "os.tmpdir" : null;
    if (key === "mkdtempSync" || key === "mkdtemp") {
      return moduleSourceKind(node.expression, "fs", lookup) === "yes" ? (key === "mkdtempSync" ? "fs.mkdtempSync" : "fs.mkdtemp") : null;
    }
    return null;
  }
  return null;
}

// True when a path expression's root is an explicit tmp fixture root
// (a PROVABLE node:os tmpdir() / node:fs mkdtemp* call, resolved through
// scope-aware binding lookup — see tmpRootCalleeOf). Used to allow tmp
// fixtures that deliberately mimic the production path shape while still
// rejecting every non-tmp production path expression. A fake/local `os`/
// `fs`/bare `mkdtempSync` can never grant tmp proof.
function isTmpRoot(node, lookup, depth = 0) {
  if (!node || depth > 6) return false;
  node = unwrapExpression(node);
  if (ts.isCallExpression(node)) {
    const tmpName = tmpRootCalleeOf(node.expression, lookup);
    if (tmpName === "os.tmpdir") return true;
    if (tmpName === "fs.mkdtempSync" || tmpName === "fs.mkdtemp") {
      // mkdtemp* is a tmp root ONLY when its prefix is itself statically
      // provable as an explicit tmp root (os.tmpdir()/mkdtemp path or an
      // absolute os.tmpdir() string). A missing/env/unknown/production
      // prefix fails closed — the real result would land outside the tmpdir.
      const prefix = node.arguments[0];
      if (!prefix) return false;
      const r = resolveStatic(prefix, lookup, depth + 1);
      return isTmpRootedValue(r);
    }
    const pathName = pathCalleeNameOf(node.expression, lookup);
    if (pathName === "path.join" || pathName === "path.resolve" || pathName === "join" || pathName === "resolve") {
      const first = node.arguments[0];
      return first ? isTmpRoot(first, lookup, depth + 1) : false;
    }
    return false;
  }
  if (ts.isIdentifier(node)) {
    const info = lookup(node.text, node);
    if (info && info.kind === "const") return isTmpRoot(info.init, lookup, depth + 1);
    return false;
  }
  return false;
}

// Collect every static string fragment in a subtree (scope-aware: follows
// const AND mutable (let/var) initializers, call args, `+` concat,
// templates, arrays/spreads). Used to derive the VISIBLE tokens of an
// otherwise-unresolvable spawn argv/command so the required-flags check can
// fail closed on what is statically visible.
//
// REJECTION-SIDE FORENSICS ONLY: a mutable (let/var) initializer may add
// REJECT evidence (visible fragments that name a production path segment /
// a models.json target) but must NEVER grant proof —
// resolveStatic/resolveStaticModuleSpecifier/moduleSourceKind/tmp-rootedness
// only follow `const`, so a let/var binding can never make a path
// tmp-rooted or a module spec provable. A cycle/seen guard keeps
// `let a = a` / `const a = [...a]` terminating; an ambiguous
// (duplicate-declared) binding is not followed at all (fail closed).
function staticFragmentsOf(node, lookup, depth = 0, out = [], seen = null) {
  if (!node || depth > 8) return out;
  node = unwrapExpression(node);
  if (ts.isIdentifier(node)) {
    const info = lookup(node.text, node);
    if (info && (info.kind === "const" || info.kind === "mutable") && info.init) {
      if (seen && seen.has(info.init)) return out;
      const nextSeen = seen ? new Set(seen) : new Set();
      nextSeen.add(info.init);
      return staticFragmentsOf(info.init, lookup, depth + 1, out, nextSeen);
    }
    return out;
  }
  if (ts.isCallExpression(node)) {
    for (const arg of node.arguments) staticFragmentsOf(arg, lookup, depth + 1, out);
    return out;
  }
  if (ts.isBinaryExpression(node)) {
    staticFragmentsOf(node.left, lookup, depth + 1, out);
    staticFragmentsOf(node.right, lookup, depth + 1, out);
    return out;
  }
  if (ts.isTemplateExpression(node)) {
    out.push(node.head.text);
    for (const span of node.templateSpans) {
      staticFragmentsOf(span.expression, lookup, depth + 1, out);
      out.push(span.literal.text);
    }
    return out;
  }
  if (ts.isArrayLiteralExpression(node)) {
    for (const el of node.elements) staticFragmentsOf(el, lookup, depth + 1, out);
    return out;
  }
  if (ts.isSpreadElement(node)) {
    staticFragmentsOf(node.expression, lookup, depth + 1, out);
    return out;
  }
  const s = staticString(node);
  if (s !== null) out.push(s);
  return out;
}

// execSync/exec command strings are tokenized on whitespace; the lock only
// needs flag presence, not shell-accurate quoting.
function commandTokens(cmd) {
  return String(cmd).split(/\s+/).filter(Boolean);
}

// True when a path string is an absolute path that, after normalization, is
// os.tmpdir() itself or a subdirectory of it. Boundary-matched (never a bare
// startsWith prefix): `/tmpfoo/...` and `/tmp/../home/...` (which normalizes
// outside the tmpdir) are both rejected.
function isUnderTmpdir(p) {
  if (typeof p !== "string" || p === "") return false;
  if (!path.isAbsolute(p)) return false;
  const normalized = path.normalize(p);
  const tmp = path.normalize(os.tmpdir());
  if (normalized === tmp) return true;
  return normalized.startsWith(tmp + path.sep);
}

// Normalize a path segment for traversal checking: split on BOTH separators
// so an embedded Windows `..\\..` escape is seen as `..` pieces, then re-join
// with the platform separator so path.join/path.resolve normalize correctly.
// A plain name like `foo..bar` (no separator inside) is untouched.
function normalizeSegment(value) {
  const pieces = value.split(/[\\/]/);
  return { pieces, joined: pieces.join("/") };
}

// True when a binding is a named import from node:path (the ONLY module
// whose `join`/`resolve` count as path functions — an arbitrary module's
// `join` must never be treated as node:path). collectBindings keeps the
// moduleSpecifier so the import source can be checked here.
function isNodePathImport(info) {
  if (!info || info.kind !== "import") return false;
  const spec = info.moduleSpecifier;
  return ts.isStringLiteral(spec) && /(?:^|[\/:])path$/.test(spec.text);
}

// True when a binding is a module namespace import of node:path
// (`import * as path from "node:path"`).
function isNodePathImportNamespace(info) {
  if (!info || info.kind !== "namespace") return false;
  const spec = info.moduleSpecifier;
  return ts.isStringLiteral(spec) && /(?:^|[\/:])path$/.test(spec.text);
}

// True when a static module-specifier string refers to the builtin module
// named `name` ("path"/"os"/"fs"/"child_process"), boundary-matched:
// "node:path", "path", "node:child_process" count; "mypath", "some-os"
// never do.
function isModuleSpecOf(spec, name) {
  return typeof spec === "string" && new RegExp(`(?:^|[\\/:])${name}$`).test(spec);
}

// Scope-aware static resolution of a dynamic import/require module ARGUMENT:
// string literals, no-substitution templates, template expressions with
// static spans, static `+` concatenation, and const identifier chains
// (`const M = "node:child_process"; await import(M)`,
// `import("node:child_" + "process")`). Cycle/depth guards fail closed
// (null): a specifier that cannot be proven statically is never guessed.
const MODULE_SPEC_MAX_DEPTH = 32;
function resolveStaticModuleSpecifier(node, lookup, depth = 0, seen = null) {
  if (!node || depth > MODULE_SPEC_MAX_DEPTH) return null;
  node = unwrapExpression(node);
  const s = staticString(node);
  if (s !== null) return s;
  if (ts.isIdentifier(node)) {
    if (seen && seen.has(node)) return null;
    const info = lookup(node.text, node);
    if (!info || info.kind !== "const") return null;
    const nextSeen = seen ? new Set(seen) : new Set();
    nextSeen.add(node);
    return resolveStaticModuleSpecifier(info.init, lookup, depth + 1, nextSeen);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = resolveStaticModuleSpecifier(node.left, lookup, depth + 1, seen);
    const r = resolveStaticModuleSpecifier(node.right, lookup, depth + 1, seen);
    if (l === null || r === null) return null;
    return l + r;
  }
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      const v = resolveStaticModuleSpecifier(span.expression, lookup, depth + 1, seen);
      if (v === null) return null;
      out += v + span.literal.text;
    }
    return out;
  }
  return null;
}

// Resolve a module-SOURCE node (a namespace/default import binding, a const
// alias chain, an await-unwrapped or `.default` form, or a dynamic
// import/require call) to its provable identity against `moduleName`: "yes"
// (provably that module), "no" (provably a DIFFERENT module), or "unknown"
// (cannot be proven statically — callers fail closed). The AST
// import/require-call source (through scope-aware static spec resolution) is
// what proves the module, so a same-named API from an arbitrary module or an
// unprovable source is never mistaken for it.
function moduleSourceKind(node, moduleName, lookup, depth = 0) {
  if (!node || depth > 6) return "unknown";
  node = unwrapExpression(node);
  if (ts.isAwaitExpression(node)) return moduleSourceKind(node.expression, moduleName, lookup, depth + 1);
  if (ts.isIdentifier(node)) {
    const info = lookup(node.text, node);
    if (!info) return "unknown";
    if (info.kind === "namespace" || info.kind === "defaultImport") {
      const spec = info.moduleSpecifier;
      return ts.isStringLiteral(spec) ? (isModuleSpecOf(spec.text, moduleName) ? "yes" : "no") : "unknown";
    }
    if (info.kind === "const") return moduleSourceKind(info.init, moduleName, lookup, depth + 1);
    return "unknown"; // named import / param / function binding — cannot prove
  }
  if (ts.isPropertyAccessExpression(node) && node.name.text === "default") {
    return moduleSourceKind(node.expression, moduleName, lookup, depth + 1);
  }
  if (ts.isCallExpression(node)) {
    const name = calleeNameOf(node.expression);
    if (name === "import" || name === "require") {
      const spec = resolveStaticModuleSpecifier(node.arguments[0], lookup);
      return spec !== null ? (isModuleSpecOf(spec, moduleName) ? "yes" : "no") : "unknown";
    }
    return "unknown";
  }
  return "unknown";
}

// True when a node is (or resolves through const chains / await unwrapping
// to) a dynamic import/require call of the node:path module — the ONLY
// module whose join/resolve count as path functions. The AST import-call
// source proves the module, so `const { join } = await import("lodash")` /
// `const p = await import("some-mod")` can never be mistaken for node:path.
function isNodePathModuleSource(node, lookup, depth = 0) {
  if (!node || depth > 6) return false;
  node = unwrapExpression(node);
  if (ts.isAwaitExpression(node)) return isNodePathModuleSource(node.expression, lookup, depth + 1);
  if (ts.isIdentifier(node)) {
    const info = lookup(node.text, node);
    if (!info) return false;
    if (info.kind === "const") return isNodePathModuleSource(info.init, lookup, depth + 1);
    return false;
  }
  if (ts.isCallExpression(node)) {
    const name = calleeNameOf(node.expression);
    if (name === "import" || name === "require") {
      const spec = staticString(node.arguments[0]);
      return spec !== null && /(?:^|[\/:])path$/.test(spec);
    }
    return false;
  }
  return false;
}

// True when a node resolves to a node:path module namespace import, through
// const alias chains: a static namespace import (`import * as path from
// "node:path"`) or a dynamic import/require of node:path (`const p = await
// import("node:path")` / `const p = require("node:path")`, including
// await-unwrapped and alias forms). The ESM default-export namespace is
// handled too: `(await import("node:path")).default`, `ns.default` (where ns
// is a dynamic import), and `const p = (await import("node:path")).default`
// all resolve to the node:path namespace — the dynamic import's module
// source is what proves it is node:path, so an arbitrary module's default
// can never be mistaken for it.
function resolvesToNodePathNamespace(node, lookup, depth = 0) {
  if (!node || depth > 6) return false;
  node = unwrapExpression(node);
  if (ts.isIdentifier(node)) {
    const info = lookup(node.text, node);
    if (!info) return false;
    if (info.kind === "namespace") return isNodePathImportNamespace(info);
    if (info.kind === "defaultImport") {
      const spec = info.moduleSpecifier;
      return ts.isStringLiteral(spec) && /(?:^|[\/:])path$/.test(spec.text);
    }
    if (info.kind === "const") return resolvesToNodePathNamespace(info.init, lookup, depth + 1);
    return false;
  }
  if (ts.isPropertyAccessExpression(node) && node.name.text === "default") {
    return resolvesToNodePathNamespace(node.expression, lookup, depth + 1);
  }
  if (ts.isElementAccessExpression(node)) {
    const key = staticString(node.argumentExpression);
    if (key === "default") return resolvesToNodePathNamespace(node.expression, lookup, depth + 1);
    return false;
  }
  return isNodePathModuleSource(node, lookup, depth);
}

// Resolve a callee node to a node:path named import: the importedName
// ("join"/"resolve") for `import { join } from "node:path"` / import aliases
// / multi-hop const aliases, and destructured renames of a node:path
// namespace import (`const { join: j } = path`). Returns null when the
// callee is not provably a node:path function.
function resolvesToNodePathImport(node, lookup, depth = 0) {
  if (!node || depth > 8) return null;
  node = unwrapExpression(node);
  if (ts.isIdentifier(node)) {
    const info = lookup(node.text, node);
    if (!info) return null;
    if (info.kind === "import") return isNodePathImport(info) ? info.importedName : null;
    if (info.kind === "const") {
      if (info.destructuredProp !== undefined) {
        // `const { join: j } = path` — only when the init resolves to a
        // node:path namespace import.
        return (info.destructuredProp === "join" || info.destructuredProp === "resolve") && resolvesToNodePathNamespace(info.init, lookup) ? info.destructuredProp : null;
      }
      return resolvesToNodePathImport(info.init, lookup, depth + 1);
    }
    return null;
  }
  if (ts.isPropertyAccessExpression(node)) {
    if (node.name.text === "join" || node.name.text === "resolve") {
      return resolvesToNodePathNamespace(node.expression, lookup) ? node.name.text : null;
    }
    return null;
  }
  return null;
}

// Classify the provenance of a `path`-named base binding for
// pathCalleeNameOf: "node-path" (provably node:path — the surface name
// grants the canonical path.join/path.resolve), "other" (provably a
// DIFFERENT module or a provably-local non-node:path value — the surface
// name is NOT node:path and stays allowed), or "unknown" (param / mutable /
// ambiguous / unprovable const init — fail closed: the caller returns the
// canonical name so the production detector rejects). A local const
// object-literal fake `path` is provably local (never node:path) and stays
// allowed without granting any tmp proof; an uncertain const init
// (`const path = getPath()`) cannot be proven and fails closed.
function pathBaseProvenanceOf(info, lookup, depth = 0) {
  if (!info) return "unknown"; // undeclared — fail closed
  if (info.kind === "namespace" || info.kind === "defaultImport") {
    const spec = info.moduleSpecifier;
    return ts.isStringLiteral(spec) && /(?:^|[\/:])path$/.test(spec.text) ? "node-path" : "other";
  }
  if (info.kind === "import") return "other"; // named import — provably a module, never the node:path namespace
  if (info.kind === "const") {
    if (info.destructuredProp !== undefined) {
      // `const { path } = ns` / `const { join: path } = ns` — the init's
      // provable module decides; an unprovable source fails closed.
      const src = moduleSourceKind(info.init, "path", lookup);
      if (src === "yes") return "node-path";
      if (src === "no") return "other";
      return "unknown";
    }
    return constPathProvenanceOf(info.init, lookup, depth + 1);
  }
  return "unknown"; // param / mutable / ambiguous / function binding — fail closed
}

// Provenance of a const `path` initializer: "node-path" (a static
// namespace/default import of node:path or a dynamic import/require of it,
// through const chains / await / .default unwrapping), "other" (a
// provably-local value like an object/array/function literal — a fake
// `const path = { join: … }` is never node:path), or "unknown" (an
// unprovable call/identifier — fail closed).
function constPathProvenanceOf(node, lookup, depth = 0) {
  if (!node || depth > 6) return "unknown";
  node = unwrapExpression(node);
  if (ts.isIdentifier(node)) {
    const info = lookup(node.text, node);
    if (!info) return "unknown";
    if (info.kind === "const") return constPathProvenanceOf(info.init, lookup, depth + 1);
    if (info.kind === "namespace" || info.kind === "defaultImport") {
      const spec = info.moduleSpecifier;
      return ts.isStringLiteral(spec) && /(?:^|[\/:])path$/.test(spec.text) ? "node-path" : "other";
    }
    return "unknown";
  }
  if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    return "other"; // provably a local value — never node:path
  }
  if (ts.isAwaitExpression(node)) return constPathProvenanceOf(node.expression, lookup, depth + 1);
  if (ts.isPropertyAccessExpression(node) && node.name.text === "default") {
    return constPathProvenanceOf(node.expression, lookup, depth + 1);
  }
  if (ts.isCallExpression(node)) {
    const name = calleeNameOf(node.expression);
    if (name === "import" || name === "require") {
      const spec = resolveStaticModuleSpecifier(node.arguments[0], lookup);
      if (spec === null) return "unknown";
      return /(?:^|[\/:])path$/.test(spec) ? "node-path" : "other";
    }
    return "unknown"; // getPath() — cannot prove
  }
  return "unknown";
}

// Resolve a path-call callee to its canonical name: "path.join"/"path.resolve"
// (the literal property-access name, kept for namespace/default path
// aliases) or the importedName of a node:path named import ("join"/"resolve"
// — only when the import source is provably node:path). Returns null when
// the callee is not provably a node:path function. The literal `path` base
// must resolve to the node:path module (a static namespace import or a
// dynamic import/require of it, through const chains) — or be undeclared
// (fail closed); a `path` bound to anything else is not node:path. A base
// with param/mutable/ambiguous/unknown provenance is NOT provably another
// module, so the canonical name is returned and the production detector
// fails closed; only a provably different module (static namespace/default/
// named import) or a provably-local non-node:path value (const object
// literal fake) stays allowed.
function pathCalleeNameOf(node, lookup) {
  node = unwrapExpression(node);
  const name = calleeNameOf(node);
  if (name === "path.join" || name === "path.resolve") {
    const base = node.expression;
    if (ts.isIdentifier(base)) {
      const info = lookup(base.text, base);
      if (info) {
        const prov = pathBaseProvenanceOf(info, lookup);
        if (prov === "node-path") return name;
        if (prov === "other") return null;
        return name; // unknown provenance — fail closed (canonical name)
      }
    }
    return name;
  }
  return resolvesToNodePathImport(node, lookup);
}

// Static resolution for spawn argv elements: string literals, const
// bindings, path.join/path.resolve (static parts only — unknown args are
// skipped, but an explicit tmp root is remembered), local helper calls
// (their return expression, with the helper's params bound to the call
// site's args), object-literal returns (for `const { a, b } = helper(...)`
// destructuring), array/spread, static `+` concatenation, and
// no-substitution templates. `paramMap` binds a local helper's params to the
// resolved call-site args so `writeMinimalModelsJson(tmp)` / `writeCliFixture(
// tmp, ...)` style helpers keep their tmp-rootedness through the return.
// Flatten a resolved-element sequence into ONE flat list: nested array
// elements (a spread of a static const array, or a bare const-array element)
// are recursively inlined — `[...base, "--quiet"]` behaves exactly like a
// hand-written flat argv. Unresolved markers ({kind:"spread"} / unknown) are
// preserved in place so the `[script, ...args]` helper-pattern detection and
// the fail-closed gates still see them. EVERY argv-semantic consumer (target
// recognition, entryOf, package/env wrappers, required flags, path values,
// syntax-check exact shape, models.json) operates on this same flat sequence
// — a nested array can never hide a script/flag/path from a gate.
function flattenResolvedElements(elements, out = []) {
  for (const el of elements) {
    if (el && el.kind === "array") flattenResolvedElements(el.elements, out);
    else out.push(el);
  }
  return out;
}

// path.resolve semantics are honored: a later ABSOLUTE segment resets the
// root, so `path.resolve(tmp, "/home/u/.pi/…")` can never be whitelisted
// just because tmp came first. When every part is a static string the
// normalized absolute path is computed and tmp-rootedness is decided by the
// boundary check against os.tmpdir() — `path.join(os.tmpdir(), "..", "home",
// …)` normalizes outside the tmpdir and fails closed; a `..` segment over an
// abstract (mkdtemp) root can never be proven safe and also fails closed.
// Static argv resolution budget: generous enough to flatten natural
// 2-level / 8-level const spreads (each level costs ~2-3 depth) while still
// bounded; cycle-aware via a per-resolution seen-set so `const a = [...a]`
// terminates as an unresolved spread instead of recursing forever. Any
// residual unknown/spread past the budget still fails closed — never
// silently dropped.
const STATIC_RESOLVE_MAX_DEPTH = 96;
function resolveStatic(node, lookup, depth = 0, paramMap = null, seen = null) {
  if (!node || depth > STATIC_RESOLVE_MAX_DEPTH) return { kind: "unknown" };
  if (!seen) seen = new Set();
  node = unwrapExpression(node);
  const str = staticString(node);
  if (str !== null) return { kind: "string", value: str };
  if (ts.isIdentifier(node)) {
    if (paramMap && paramMap.has(node.text)) return paramMap.get(node.text);
    const info = lookup(node.text, node);
    if (!info) return { kind: "unknown" };
    if (info.kind === "const") {
      // Cycle guard: a const chain re-entering the SAME initializer node
      // (`const a = [...a]`) is unresolvable — return unknown so the caller
      // fails closed instead of recursing forever.
      if (seen.has(info.init)) return { kind: "unknown" };
      seen.add(info.init);
      if (info.destructuredProp !== undefined) {
        // `const { episodesPath } = writeCliFixture(tmp, …)` — resolve the
        // helper's object-literal return and pick the property.
        const init = resolveStatic(info.init, lookup, depth + 1, paramMap, seen);
        seen.delete(info.init);
        if (init.kind === "object") {
          const v = init.props.get(info.destructuredProp);
          if (v) return v;
        }
        return { kind: "unknown" };
      }
      const init = resolveStatic(info.init, lookup, depth + 1, paramMap, seen);
      seen.delete(info.init);
      return init;
    }
    if (info.kind === "function") return { kind: "function", node: info.node };
    return { kind: "unknown" };
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolveStatic(node.left, lookup, depth + 1, paramMap, seen);
    const right = resolveStatic(node.right, lookup, depth + 1, paramMap, seen);
    if (left.kind === "string" && right.kind === "string") return { kind: "string", value: left.value + right.value };
    return { kind: "unknown" };
  }
  if (ts.isTemplateExpression(node)) {
    const parts = [node.head.text];
    for (const span of node.templateSpans) {
      const r = resolveStatic(span.expression, lookup, depth + 1, paramMap, seen);
      if (r.kind !== "string") return { kind: "unknown" };
      parts.push(r.value, span.literal.text);
    }
    return { kind: "string", value: parts.join("") };
  }
  if (ts.isCallExpression(node)) {
    // Binding-aware tmp-root callees: only a PROVABLE node:os tmpdir /
    // node:fs mkdtemp* call (through imports/const chains — see
    // tmpRootCalleeOf) yields tmp-rootedness proof. A fake/local `os`/`fs`
    // binding or a bare `os.tmpdir`/`mkdtempSync` never does.
    const tmpName = tmpRootCalleeOf(node.expression, lookup);
    if (tmpName === "os.tmpdir") {
      return { kind: "path", parts: [os.tmpdir()], tmpRooted: true, concrete: true };
    }
    if (tmpName === "fs.mkdtempSync" || tmpName === "fs.mkdtemp") {
      // The result is tmp-rooted ONLY when the prefix itself is statically
      // provable as an explicit tmp root (os.tmpdir()/mkdtemp path or an
      // absolute os.tmpdir() string). A missing/env/unknown/production
      // prefix fails closed (unknown) — the real mkdtemp result would land
      // outside the tmpdir. The real fixture shape
      // `fs.mkdtempSync(path.join(os.tmpdir(), "t0-…"))` keeps resolving.
      const prefix = node.arguments[0];
      if (!prefix) return { kind: "unknown" };
      const prefixResolved = resolveStatic(prefix, lookup, depth + 1, paramMap, seen);
      if (isTmpRootedValue(prefixResolved)) {
        return { kind: "path", parts: [], tmpRooted: true, concrete: false };
      }
      return { kind: "unknown" };
    }
    // Binding-aware path.join/path.resolve: only a provable node:path callee
    // (literal undeclared `path`, real namespace/default/dynamic import, or a
    // named join/resolve import) yields tmp-rootedness proof. A fake/local
    // `path` binding must never grant tmp proof.
    const pathName = pathCalleeNameOf(node.expression, lookup);
    if (pathName === "path.join" || pathName === "path.resolve" || pathName === "join" || pathName === "resolve") {
      const isResolve = pathName === "path.resolve" || pathName === "resolve";
      const parts = [];
      let tmpRooted = false;
      let sawAbsolute = false;
      let lastAbsoluteTmp = false;
      let concrete = true; // every part is a known string (or a concrete root)
      let hasDotDot = false;
      let rootEstablished = false; // a string/path arg has set the path root
      let unknownBeforeRoot = false; // an unknown arg appeared before the root
      let nonTmpRootBeforeTmp = false; // a non-tmp root was set before any tmp root
      let sawUnknown = false; // ANY unknown path parameter fails closed
      for (const arg of node.arguments) {
        const r = resolveStatic(arg, lookup, depth + 1, paramMap, seen);
        if (r.kind === "string") {
          const norm = normalizeSegment(r.value);
          parts.push(norm.joined);
          if (norm.pieces.some((p) => p === ".." || p === ".")) hasDotDot = true;
          if (norm.joined.startsWith("/")) {
            sawAbsolute = true;
            lastAbsoluteTmp = isUnderTmpdir(norm.joined);
          }
          if (!rootEstablished) {
            rootEstablished = true;
            if (!(norm.joined.startsWith("/") && isUnderTmpdir(norm.joined))) nonTmpRootBeforeTmp = true;
          }
        } else if (r.kind === "path") {
          parts.push(...r.parts);
          if (r.parts.some((p) => p === ".." || p === ".")) hasDotDot = true;
          if (r.parts.length > 0 && r.parts[0].startsWith("/")) {
            sawAbsolute = true;
            lastAbsoluteTmp = isUnderTmpdir(r.parts[0]);
          }
          if (r.tmpRooted) tmpRooted = true;
          if (!r.concrete) concrete = false;
          if (!rootEstablished) {
            rootEstablished = true;
            if (!r.tmpRooted) nonTmpRootBeforeTmp = true;
          }
        } else if (r.kind === "array") {
          parts.push(...elementStrings(r.elements));
          concrete = false;
          if (!rootEstablished) {
            rootEstablished = true;
            nonTmpRootBeforeTmp = true;
          }
        } else if (isTmpRoot(arg, lookup)) {
          tmpRooted = true;
          concrete = false;
          rootEstablished = true;
        } else {
          concrete = false;
          sawUnknown = true;
          if (!rootEstablished) unknownBeforeRoot = true;
        }
      }
      // ANY unknown path parameter fails closed — even after a tmp root was
      // already established (`path.join(os.tmpdir(), env, …)` is NOT provably
      // under the tmpdir; a later tmp argument must not "bleach" it back).
      if (sawUnknown) tmpRooted = false;
      // path.resolve: the LAST absolute segment wins and resets the root;
      // path.join never resets (it concatenates).
      else if (isResolve && sawAbsolute) tmpRooted = lastAbsoluteTmp;
      // The tmp root is decided by the FIRST valid root only: an unknown
      // prefix (env var, unresolvable identifier) or a non-tmp root before
      // the first tmp argument means the real result is not provably under
      // the tmpdir — a later tmp argument must not "bleach" it
      // (`path.join(process.env.HOME, os.tmpdir(), …)` is NOT tmp-rooted).
      else if (unknownBeforeRoot || nonTmpRootBeforeTmp) tmpRooted = false;
      if (parts.length === 0) return { kind: "unknown" };
      if (concrete) {
        const joined = isResolve ? path.resolve(...parts) : path.join(...parts);
        return { kind: "path", parts, tmpRooted: isUnderTmpdir(joined), concrete: true, normalized: joined };
      }
      // A `..`/`.` segment over an abstract (mkdtemp) root can never be
      // proven to stay inside the tmpdir — fail closed.
      if (hasDotDot) tmpRooted = false;
      return { kind: "path", parts, tmpRooted, concrete };
    }
    const calleeText = calleeNameOf(node.expression);
    const info = calleeText ? lookup(calleeText, node) : undefined;
    if (info && info.kind === "function") {
      const ret = findReturnExpression(info.node);
      if (ret) {
        const fnParams = info.node.parameters ?? [];
        const nextMap = new Map();
        for (let i = 0; i < fnParams.length; i++) {
          const p = fnParams[i];
          if (ts.isIdentifier(p.name) && node.arguments[i]) {
            nextMap.set(p.name.text, resolveStatic(node.arguments[i], lookup, depth + 1, paramMap, seen));
          }
        }
        return resolveStatic(ret, lookup, depth + 1, nextMap, seen);
      }
    }
    return { kind: "unknown" };
  }
  if (ts.isObjectLiteralExpression(node)) {
    const props = new Map();
    for (const prop of node.properties) {
      if (ts.isPropertyAssignment(prop)) {
        const key = ts.isIdentifier(prop.name) ? prop.name.text : staticString(prop.name);
        if (key !== null) props.set(key, resolveStatic(prop.initializer, lookup, depth + 1, paramMap, seen));
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        props.set(prop.name.text, resolveStatic(prop.name, lookup, depth + 1, paramMap, seen));
      }
    }
    return { kind: "object", props };
  }
  if (ts.isArrayLiteralExpression(node)) {
    // Flat array resolution: a spread of a static const array (or a bare
    // const-array element) is INLINED — `[...base, "--quiet"]` resolves to
    // the same flat sequence as a hand-written `["...", "--quiet"]`. Every
    // argv-semantic consumer shares this flat shape, so a nested array can
    // never hide a script/flag/path from the gates. Unresolved spreads stay
    // {kind:"spread"} markers (the `[script, ...args]` helper pattern relies
    // on them); unknown elements stay unknown.
    return { kind: "array", elements: flattenResolvedElements(node.elements.map((el) => resolveStatic(el, lookup, depth + 1, paramMap, seen))) };
  }
  if (ts.isSpreadElement(node)) {
    const r = resolveStatic(node.expression, lookup, depth + 1, paramMap, seen);
    if (r.kind === "array") return r; // inlined by the enclosing array-literal flatten
    return { kind: "spread" };
  }
  return { kind: "unknown" };
}

const SPAWN_CALLEES = new Set(["execFileSync", "spawnSync", "spawn", "execFile", "execSync", "exec"]);

// True when a binding is a module namespace import of node:child_process
// (the ONLY namespace that counts as a spawn namespace — an arbitrary module
// namespace must never be treated as child_process). collectBindings keeps
// the moduleSpecifier so the import source can be checked here.
function isChildProcessNamespace(info) {
  if (!info || info.kind !== "namespace") return false;
  const spec = info.moduleSpecifier;
  return ts.isStringLiteral(spec) && /(?:^|[\/:])child_process$/.test(spec.text);
}

// True when a binding is a NAMED import from node:child_process (the ONLY
// module whose named spawnSync/execFileSync/… imports count as real spawns
// — `import { spawnSync } from "some-lib"` is a different module's
// same-named API and is NOT a real child_process call).
function isChildProcessImport(info) {
  if (!info || info.kind !== "import") return false;
  const spec = info.moduleSpecifier;
  return ts.isStringLiteral(spec) && /(?:^|[\/:])child_process$/.test(spec.text);
}

// True when a node PROVABLY resolves to a same-named spawn API from a
// module that is NOT child_process (a named import / namespace destructure /
// property access off a statically different module, through const chains).
// Used to keep `const launch = otherModuleSpawn` multi-hop aliases allowed
// while still failing closed on `const spawnSync = getIt()` (an unprovable
// source is never assumed to be another module's API).
function provablyOtherModuleSpawnName(node, lookup, depth = 0) {
  if (!node || depth > 8) return false;
  node = unwrapExpression(node);
  if (ts.isIdentifier(node)) {
    const info = lookup(node.text, node);
    if (!info) return false;
    if (info.kind === "import") return SPAWN_CALLEES.has(info.importedName) && !isChildProcessImport(info);
    if (info.kind === "namespace") return !isChildProcessNamespace(info);
    if (info.kind === "const") {
      if (info.destructuredProp !== undefined) {
        if (!SPAWN_CALLEES.has(info.destructuredProp)) return false;
        return moduleSourceKind(info.init, "child_process", lookup) === "no";
      }
      return provablyOtherModuleSpawnName(info.init, lookup, depth + 1);
    }
    return false;
  }
  if (ts.isPropertyAccessExpression(node)) {
    if (!SPAWN_CALLEES.has(node.name.text)) return false;
    return moduleSourceKind(node.expression, "child_process", lookup) === "no";
  }
  if (ts.isElementAccessExpression(node)) {
    const key = staticString(node.argumentExpression);
    if (key === null || !SPAWN_CALLEES.has(key)) return false;
    return moduleSourceKind(node.expression, "child_process", lookup) === "no";
  }
  return false; // CallExpression getIt() / other shapes — not provably other-module
}

// Resolve a callee node to its canonical spawn kind name
// ("execFileSync"/"spawnSync"/"spawn"/"execFile"/"execSync"/"exec") with
// fail-closed semantics: null ONLY when the callee is provably NOT a real
// child_process call (a same-named API imported from or destructured off a
// statically different module). An unprovable source — `const spawnSync =
// getIt()`, a destructured/property-accessed spawn API from an unresolvable
// dynamic import, an undeclared property-access base — fails closed to the
// surface name, so a real call is never silently missed. Covers bare
// identifiers, ES import aliases, multi-hop const aliases, destructured
// renames, and property/element access on child_process namespaces.
function resolvedSpawnKindOf(node, lookup, depth = 0) {
  if (!node || depth > 8) return null;
  node = unwrapExpression(node);
  if (ts.isIdentifier(node)) {
    const info = lookup(node.text, node);
    if (SPAWN_CALLEES.has(node.text)) {
      // Bare spawn name: the BINDING decides — `import { spawnSync } from
      // "some-lib"` / `const { spawnSync } = await import("some-lib")` are a
      // different module's same-named API and NOT real calls; an undeclared
      // or non-import binding fails closed (real).
      if (!info) return node.text;
      if (info.kind === "import") return isChildProcessImport(info) ? node.text : null;
      if (info.kind === "namespace") return isChildProcessNamespace(info) ? node.text : null;
      if (info.kind === "defaultImport") {
        // A default import binds the whole module object, never a spawn
        // function — but if it ever reached a bare spawn-name callee, the
        // moduleSpecifier decides (the surface gate still rejects default
        // imports of child_process unconditionally).
        const spec = info.moduleSpecifier;
        return ts.isStringLiteral(spec) && /(?:^|[\/:])child_process$/.test(spec.text) ? node.text : null;
      }
      if (info.kind === "const") {
        if (info.destructuredProp !== undefined) {
          if (!SPAWN_CALLEES.has(info.destructuredProp)) return null;
          // `const { spawnSync } = await import(…)` — the init's provable
          // module decides; an unresolvable source fails closed.
          const src = moduleSourceKind(info.init, "child_process", lookup);
          if (src === "no") return null;
          return info.destructuredProp;
        }
        const inner = resolvedSpawnKindOf(info.init, lookup, depth + 1);
        if (inner !== null) return inner;
        // Local const whose init cannot be proven to be a different module's
        // same-named API (`const spawnSync = getIt()`) — fail closed.
        return provablyOtherModuleSpawnName(info.init, lookup) ? null : node.text;
      }
      return node.text; // param/function binding — fail closed
    }
    if (!info) return null;
    if (info.kind === "const") {
      if (info.destructuredProp !== undefined) {
        // `const { spawnSync: launch } = cp` — only when the init is a
        // child_process namespace/import (an arbitrary module's namespace is
        // not a spawn object); an unresolvable source fails closed.
        if (!SPAWN_CALLEES.has(info.destructuredProp)) return null;
        const src = moduleSourceKind(info.init, "child_process", lookup);
        if (src === "no") return null;
        return info.destructuredProp;
      }
      return resolvedSpawnKindOf(info.init, lookup, depth + 1);
    }
    if (info.kind === "import") return SPAWN_CALLEES.has(info.importedName) && isChildProcessImport(info) ? info.importedName : null;
    return null; // namespace/param/function binding as a bare callee — not a spawn
  }
  if (ts.isPropertyAccessExpression(node)) {
    if (!SPAWN_CALLEES.has(node.name.text)) return null;
    return moduleSourceKind(node.expression, "child_process", lookup, depth) === "no" ? null : node.name.text;
  }
  if (ts.isElementAccessExpression(node)) {
    const key = staticString(node.argumentExpression);
    if (key === null || !SPAWN_CALLEES.has(key)) return null;
    return moduleSourceKind(node.expression, "child_process", lookup, depth) === "no" ? null : key;
  }
  return null; // CallExpression getIt() / other shapes — never resolves to a spawn
}

// True when a callee node resolves (through scope-aware const/import lookup)
// to a real child_process spawn call — child_process provenance, or an
// unprovable source (fail closed). See resolvedSpawnKindOf.
function resolvesToSpawnCallee(node, lookup, depth = 0) {
  return resolvedSpawnKindOf(node, lookup, depth) !== null;
}

// The canonical spawn function a callee node resolves to (execSync/exec are
// command-string spawns; the rest are argv spawns). Same resolution as
// resolvesToSpawnCallee so analyzeSpawnArgvs can dispatch on the RESOLVED
// kind instead of the surface callee name — `import { execSync as run }`,
// multi-hop const aliases of execSync/exec, and `const execSync = getIt()`
// must go through command-string analysis, not the argv branch.
function spawnKindOf(node, lookup, depth = 0) {
  return resolvedSpawnKindOf(node, lookup, depth);
}

function findSpawnCalls(sourceFile) {
  const { lookup } = collectBindings(sourceFile);
  const calls = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      if (resolvesToSpawnCallee(node.expression, lookup)) calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return calls;
}

// Approved child_process API surface for T0 smoke (ADR 0027 C6 pre-gate):
// ONLY a static named import of spawnSync/execFileSync from
// node:child_process / child_process, each local reference used DIRECTLY as a
// CallExpression callee that findSpawnCalls/analyze already covers. Import
// declarations themselves are allowed; every other child_process surface
// (forbidden named imports even unused, default/namespace/dynamic/require,
// non-direct references of approved APIs, bare fork, bare non-direct
// spawnSync/execFileSync) fails closed. Bare direct spawnSync/execFileSync
// snippets stay on the existing analyzer path. Provably other-module same
// names are allowed.
const APPROVED_CHILD_PROCESS_APIS = new Set(["spawnSync", "execFileSync"]);
const BARE_CHILD_PROCESS_APIS = new Set(["spawnSync", "execFileSync", "spawn", "execFile", "execSync", "exec", "fork"]);

function isChildProcessModuleSpecText(spec) {
  return typeof spec === "string" && /(?:^|[\/:])child_process$/.test(spec);
}

// True when `node` (an Identifier) is the direct callee of a CallExpression
// after unwrapping parentheses (optional-call form included).
function directCallOfIdentifier(node) {
  if (!node || !ts.isIdentifier(node)) return null;
  let cur = node;
  while (cur.parent && ts.isParenthesizedExpression(cur.parent) && cur.parent.expression === cur) {
    cur = cur.parent;
  }
  if (cur.parent && ts.isCallExpression(cur.parent) && cur.parent.expression === cur) {
    return cur.parent;
  }
  return null;
}

// child_process import/reference pre-gate. Returns { hits } — the set of
// child_process surfaces that are not the closed approved subset.
// Two-pass: ESM bindings are independent of declaration position, so pass 1
// pre-collects every static child_process import surface (approved locals +
// default/namespace/forbidden/re-export hits) before pass 2 scans dynamic
// import/require and references. Import/export-from subtrees are fully
// handled in pass 1 and skipped in pass 2 (no double hits).
function childProcessSurfaceHits(sf) {
  const { lookup } = collectBindings(sf);
  const hits = [];
  const analyzedCalls = new Set(findSpawnCalls(sf));
  // localName -> importedName for approved static named imports
  const approvedLocals = new Map();

  // Pass 1: static import / re-export surfaces only.
  const collectStaticSurface = (node) => {
    if (!node) return;

    if (ts.isImportDeclaration(node)) {
      const specNode = node.moduleSpecifier;
      const spec = ts.isStringLiteral(specNode) ? specNode.text : null;
      if (spec !== null && isChildProcessModuleSpecText(spec)) {
        const clause = node.importClause;
        if (clause) {
          // default import: `import cp from "node:child_process"`
          if (clause.name) {
            hits.push("unapproved child_process surface: default import");
          }
          const named = clause.namedBindings;
          if (named && ts.isNamespaceImport(named)) {
            hits.push("unapproved child_process surface: namespace import");
          } else if (named && ts.isNamedImports(named)) {
            for (const el of named.elements) {
              const importedName = el.propertyName ? el.propertyName.text : el.name.text;
              if (APPROVED_CHILD_PROCESS_APIS.has(importedName)) {
                approvedLocals.set(el.name.text, importedName);
              } else {
                hits.push(`unapproved child_process surface: forbidden named import of ${importedName}`);
              }
            }
          }
        }
      }
      // Import subtree fully handled — do not descend (avoids pass-2 double hits).
      return;
    }

    // `export { … } from "node:child_process"` / `export * from "…"`
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const spec = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null;
      if (spec !== null && isChildProcessModuleSpecText(spec)) {
        hits.push("unapproved child_process surface: re-export from child_process");
      }
      // export-from subtree fully handled — do not descend.
      return;
    }

    ts.forEachChild(node, collectStaticSurface);
  };
  ts.forEachChild(sf, collectStaticSurface);

  // Pass 2: dynamic import/require + identifier/property references.
  // Static import / export-from declarations were fully collected above.
  const visitSurface = (node) => {
    if (!node) return;

    // Already fully handled in pass 1 — skip entire subtree (no double hits).
    if (ts.isImportDeclaration(node)) return;
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) return;

    // Dynamic import / require of child_process — the module ARGUMENT is
    // resolved scope-aware (const chains / static `+` concat / static
    // templates), so `const M = "node:child_process"; await import(M)` /
    // `require(M)` / `import("node:child_" + "process")` all hit.
    if (ts.isCallExpression(node)) {
      const cname = calleeNameOf(node.expression);
      if (cname === "import" || cname === "require") {
        const spec = resolveStaticModuleSpecifier(node.arguments[0], lookup);
        if (spec !== null && isChildProcessModuleSpecText(spec)) {
          hits.push("unapproved child_process surface: dynamic import/require");
        }
      }
    }

    // Identifier uses of approved locals / bare child_process API names.
    if (ts.isIdentifier(node)) {
      // Import/export specifier names and binding names are declarations.
      if (inDeclarationPosition(node)) {
        ts.forEachChild(node, visitSurface);
        return;
      }
      // Property-name identifiers are decided at the access level.
      if (node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) {
        return;
      }

      const info = lookup(node.text, node);

      // Approved static named-import locals: only direct CallExpression callee
      // that findSpawnCalls already covers is allowed. Position-independent:
      // references before or after the import declaration are the same binding.
      if (approvedLocals.has(node.text) && info && info.kind === "import" && isChildProcessImport(info)
          && APPROVED_CHILD_PROCESS_APIS.has(info.importedName)) {
        const call = directCallOfIdentifier(node);
        if (!call) {
          hits.push("unapproved child_process surface: non-direct reference to approved API");
        } else if (!analyzedCalls.has(call)) {
          hits.push("unapproved child_process surface: approved direct call not recognized by analyzer");
        }
        return;
      }

      // Bare / unbound child_process API names (and non-approved imports handled
      // at the import site). Provably other-module same names stay allowed.
      if (BARE_CHILD_PROCESS_APIS.has(node.text)) {
        // BindingElement PROPERTY name (`const { spawnSync: launch } = src`):
        // a source property read. Allowed only when src is provably NOT
        // child_process; a child_process source or an unresolvable source
        // fails closed (the import site may already have hit).
        if (node.parent && ts.isBindingElement(node.parent) && node.parent.propertyName === node) {
          let init = null;
          let cur = node.parent.parent; // ObjectBindingPattern
          if (cur && ts.isObjectBindingPattern(cur) && cur.parent) {
            if (ts.isVariableDeclaration(cur.parent)) init = cur.parent.initializer;
            else if (ts.isParameter(cur.parent)) init = cur.parent.initializer;
            else if (ts.isAssignmentExpression(cur.parent)) init = cur.parent.right;
          }
          if (init) {
            const src = moduleSourceKind(init, "child_process", lookup);
            if (src === "no") return;
            if (src === "unknown") {
              hits.push("unapproved child_process surface: spawn API destructured from an unresolvable module source (fail closed)");
              return;
            }
          }
          hits.push("unapproved child_process surface: non-direct reference");
          return;
        }
        // Provably other module named import — allow.
        if (info && info.kind === "import" && !isChildProcessImport(info)) return;
        if (info && info.kind === "const" && info.destructuredProp !== undefined) {
          // Destructured off another source: allowed only when the source is
          // provably NOT child_process; an unresolvable source fails closed
          // (`const { spawnSync } = await import(unknownPath)` must reject).
          const src = moduleSourceKind(info.init, "child_process", lookup);
          if (src === "no") return;
          if (src === "unknown") {
            hits.push("unapproved child_process surface: destructured spawn API from an unresolvable module source (fail closed)");
            return;
          }
        }
        if (info && info.kind === "namespace" && !isChildProcessNamespace(info)) return;

        if (node.text === "fork") {
          // Bare fork (or child_process-bound fork) always fails closed — not
          // an approved API and not covered by the spawn analyzer.
          hits.push("unapproved child_process surface: bare fork");
          return;
        }

        if (APPROVED_CHILD_PROCESS_APIS.has(node.text) || SPAWN_CALLEES.has(node.text)) {
          const call = directCallOfIdentifier(node);
          if (call) {
            // Bare direct spawnSync/execFileSync/spawn/… snippets stay on the
            // existing analyzer path (no pre-gate hit).
            return;
          }
          // Non-direct bare reference (assignment, .call/.apply/.bind,
          // Reflect.apply arg, object/array element, promisify arg, …).
          hits.push("unapproved child_process surface: non-direct reference");
          return;
        }
      }
      return;
    }

    // Property/element access of a spawn API is never the approved
    // static-named-import surface — fail closed on a child_process namespace
    // AND on an unresolvable module source (a dynamic import whose module
    // cannot be proven, a fake/local object); only a provably different
    // module's same-named property stays allowed. Duplicate hits with the
    // import/require site are fine.
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      let propName = null;
      let base = null;
      if (ts.isPropertyAccessExpression(node)) {
        propName = node.name.text;
        base = node.expression;
      } else {
        propName = staticString(node.argumentExpression);
        base = node.expression;
      }
      if (propName !== null && BARE_CHILD_PROCESS_APIS.has(propName)) {
        const src = moduleSourceKind(base, "child_process", lookup);
        if (src === "yes") {
          hits.push(`unapproved child_process surface: namespace/property access of ${propName}`);
        } else if (src === "unknown") {
          hits.push(`unapproved child_process surface: ${propName} accessed on an unresolvable module source (fail closed)`);
        }
      }
    }

    ts.forEachChild(node, visitSurface);
  };
  ts.forEachChild(sf, visitSurface);
  return { hits };
}

function enclosingFunction(node) {
  let cur = node.parent;
  while (cur) {
    if (ts.isFunctionLike(cur)) return cur;
    cur = cur.parent;
  }
  return null;
}

function functionName(fn) {
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  // Only a DIRECT VariableDeclaration assignment counts: a nested anonymous
  // helper (e.g. `return () => { spawnSync(...) }` inside an outer function)
  // must never be attributed to the outer function's name.
  if (fn.parent && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) {
    return fn.parent.name.text;
  }
  return null;
}

function findCallsOf(sourceFile, name) {
  const calls = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && calleeBaseName(node.expression) === name) calls.push(node);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return calls;
}

// T0 entries named by a `npm|yarn|pnpm run <t0:* script>` pattern inside a
// static string fragment (e.g. the head of a dynamic execSync template). The
// whole-fragment exact alias lookup cannot see these, so the pattern is
// matched directly against the live PACKAGE_T0_ALIASES map.
function packageAliasTargetsFromString(s) {
  const targets = new Set();
  const m = /(?:^|\s)(npm|yarn|pnpm)(?:\s+run)?\s+(t0:[^\s]+)/.exec(s);
  if (m) {
    const entry = PACKAGE_T0_ALIASES[m[2]];
    if (entry) targets.add(entry);
  }
  return targets;
}

// Fail-closed target identification for an unresolvable argv expression.
// Scope-aware: follows identifier initializers, path.join/path.resolve
// subtrees, `+` concatenation and template literals, so an argv whose target
// is statically identifiable fails closed even when resolveStatic overall
// returns unknown (e.g. `const argv = buildArgs(script)` where script is a
// const-bound t0 path). Scoped to the argv node so unrelated comments/
// strings elsewhere cannot trip it. `npm run t0:*` package-alias patterns
// inside static fragments are identified too, so a dynamic command string
// whose static head names a t0 alias fails closed instead of being missed.
function staticTargetOf(node, lookup, depth = 0) {
  if (!node || depth > 8) return [];
  const targets = new Set();
  const add = (n) => {
    // TemplateHead/Middle/Tail literals carry static text — a target split
    // across template spans (`` `${head}t0-eval.mjs ${mid}...` ``) must still
    // be visible to the diagnostic fallback. (Diagnostic only; the argv
    // gates resolve templates structurally via resolveStatic.)
    const s = ts.isTemplateLiteralToken(n) ? n.text : staticString(n);
    if (s === null) return;
    for (const [name, def] of Object.entries(T0_ENTRIES)) {
      if (s.includes(def.marker)) targets.add(name);
    }
    if (s.includes("models.json")) targets.add("models.json");
    if (PACKAGE_T0_ALIASES[s]) targets.add(PACKAGE_T0_ALIASES[s]);
    for (const t of packageAliasTargetsFromString(s)) targets.add(t);
  };
  const visit = (n, d) => {
    if (!n || d > 8) return;
    n = unwrapExpression(n);
    if (ts.isIdentifier(n)) {
      const info = lookup(n.text, n);
      if (info && info.kind === "const") {
        visit(info.init, d + 1);
        return;
      }
      return;
    }
    if (ts.isCallExpression(n)) {
      // The callee may carry the target (`[script].concat([])`,
      // `(script).filter(Boolean)`), so it is visited too.
      visit(n.expression, d + 1);
      for (const arg of n.arguments) visit(arg, d + 1);
      return;
    }
    if (ts.isBinaryExpression(n)) {
      visit(n.left, d + 1);
      visit(n.right, d + 1);
      return;
    }
    if (ts.isTemplateExpression(n)) {
      add(n.head);
      for (const span of n.templateSpans) {
        visit(span.expression, d + 1);
        add(span.literal);
      }
      return;
    }
    if (ts.isArrayLiteralExpression(n)) {
      for (const el of n.elements) visit(el, d + 1);
      return;
    }
    if (ts.isSpreadElement(n)) {
      visit(n.expression, d + 1);
      return;
    }
    if (ts.isPropertyAccessExpression(n)) {
      visit(n.expression, d + 1);
      return;
    }
    if (ts.isElementAccessExpression(n)) {
      visit(n.expression, d + 1);
      visit(n.argumentExpression, d + 1);
      return;
    }
    if (ts.isConditionalExpression(n)) {
      visit(n.condition, d + 1);
      visit(n.whenTrue, d + 1);
      visit(n.whenFalse, d + 1);
      return;
    }
    const s = ts.isTemplateLiteralToken(n) ? n.text : staticString(n);
    if (s !== null) {
      add(n);
      return;
    }
    // Unknown expression shape: conservatively recurse ALL children so an
    // identifiable target nested anywhere in the expression still fails
    // closed (depth-limited, so const-init cycles cannot loop forever).
    ts.forEachChild(n, (child) => visit(child, d + 1));
  };
  visit(node, depth);
  return [...targets];
}

// Same identification for already-resolved argv elements (path parts /
// strings), used to fail closed when a helper's fixed argv names a T0
// target but the call site's dynamic args cannot be resolved. The flat
// normalized sequence is scanned, so a nested const-array element can never
// hide a marker.
function targetsFromElements(elements) {
  const targets = new Set();
  const add = (s) => {
    for (const [name, def] of Object.entries(T0_ENTRIES)) {
      if (s.includes(def.marker)) targets.add(name);
    }
    if (s.includes("models.json")) targets.add("models.json");
    if (PACKAGE_T0_ALIASES[s]) targets.add(PACKAGE_T0_ALIASES[s]);
  };
  for (const el of flattenResolvedElements(elements)) {
    if (el.kind === "path") {
      for (const part of el.parts) add(part);
    } else if (el.kind === "string") {
      add(el.value);
    }
  }
  return [...targets];
}

// Normalize a command element to a package-manager name: "npm"/"yarn"/"pnpm"
// exactly, or a path whose basename (minus .cmd/.exe/.bat/.ps1) is one of
// them — `/usr/bin/npm`, `C:\…\npm.cmd`, `./node_modules/.bin/npm` all count
// as the same package-manager wrapper.
function packageManagerNameOf(el) {
  if (!el || el.kind !== "string") return null;
  let base = el.value;
  if (base.includes("/") || base.includes("\\")) base = base.split(/[\\/]/).pop();
  base = base.replace(/\.(cmd|exe|bat|ps1)$/i, "");
  return ["npm", "yarn", "pnpm"].includes(base) ? base : null;
}

// Normalize a command element to the env wrapper name: "env" exactly, or a
// path whose basename (minus .exe) is "env" — `/usr/bin/env`, `env.exe`,
// `C:\…\env.exe` all count as the same env wrapper.
function envNameOf(el) {
  if (!el || el.kind !== "string") return null;
  let base = el.value;
  if (base.includes("/") || base.includes("\\")) base = base.split(/[\\/]/).pop();
  base = base.replace(/\.exe$/i, "");
  return base === "env" ? base : null;
}

// npm/yarn/pnpm `run <t0:* script>` alias detection over resolved argv
// elements. Returns { entry, flags } where flags are the elements that reach
// the T0 CLI (npm only forwards args after `--`; yarn/pnpm forward args
// directly, with an optional leading `--` separator). Returns null when the
// argv is not a package-alias form or the script is not a t0:* alias. The
// command element is normalized through packageManagerNameOf, so an absolute
// package-manager path (`/usr/bin/npm`) is detected identically. The
// sequence is flattened first, so a const-array element can never hide the
// package-manager/script/flags positions.
function packageAliasEntry(elements) {
  elements = flattenResolvedElements(elements);
  const pm = packageManagerNameOf(elements[0]);
  if (!pm) return null;
  let scriptName = null;
  let idx = 1;
  if (elements[1]?.kind === "string" && elements[1].value === "run") {
    scriptName = elements[2]?.kind === "string" ? elements[2].value : null;
    idx = 3;
  } else {
    scriptName = elements[1]?.kind === "string" ? elements[1].value : null;
    idx = 2;
  }
  if (!scriptName) return null;
  const entry = PACKAGE_T0_ALIASES[scriptName];
  if (!entry) return null;
  let flags = elements.slice(idx);
  if (pm === "npm") {
    // npm run <script> -- <args>: only args after the `--` separator reach
    // the script. Without `--` the script runs with NO args (production
    // defaults) — flags stay empty and the required-flags gate fails closed.
    const sep = flags.findIndex((el) => el.kind === "string" && el.value === "--");
    flags = sep === -1 ? [] : flags.slice(sep + 1);
  } else if (flags[0]?.kind === "string" && flags[0].value === "--") {
    flags = flags.slice(1);
  }
  return { entry, flags };
}

// True when a resolved argv element is statically provable as an explicit
// tmp root: a tmp-rooted path (os.tmpdir()/fs.mkdtemp* root, already
// normalized + boundary-checked by resolveStatic), a string explicitly
// marked tmp-rooted (a resolvable dynamic command part), or an absolute
// string that normalizes to os.tmpdir() itself or a subdirectory of it.
// Unknown/env/production/relative values are NOT provable and fail closed.
// The absolute-string check is boundary-matched (never a bare startsWith
// prefix): `/tmpfoo/...` and `/tmp/../home/...` are rejected.
function isTmpRootedValue(el) {
  if (el.kind === "path") return el.tmpRooted === true;
  if (el.kind === "string") {
    if (el.tmpRooted === true) return true;
    return isUnderTmpdir(el.value);
  }
  return false;
}

// Per-entry value gate over the dangerous path flags: every present path
// flag's VALUE must be statically provable as an explicit tmp root. A
// REQUIRED flag with NO value — the next token is another flag or the argv
// ends — is a bare flag and is itself a violation: the required-flags gate
// would pass on the flag NAME alone while the value is unprovable, so the
// path-value gate must not skip it. A bare NON-required path flag is a
// malformed argv the CLI rejects before any data access (the smokes
// legitimately exercise this as a negative test), so it is not flagged.
// This is what makes `--episodes
// /home/u/.pi/.pi-astack/t0-episodes/episodes.jsonl` fail even though the
// flag NAME is present.
function pathValueHits(entry, elements, requiredFlags) {
  const flags = T0_PATH_FLAGS[entry];
  if (!flags) return [];
  const hits = [];
  const flat = [];
  const flatten = (els) => {
    for (const el of els) {
      if (el.kind === "array") flatten(el.elements);
      else flat.push(el);
    }
  };
  flatten(elements);
  for (let i = 0; i < flat.length; i++) {
    const el = flat[i];
    if (el.kind !== "string" || !flags.includes(el.value)) continue;
    const next = flat[i + 1];
    if (!next) {
      if (requiredFlags.has(el.value)) hits.push(`${entry} ${el.value} has no value (bare flag, fail closed)`);
      continue;
    }
    if (next.kind === "string" && next.value.startsWith("--")) {
      if (requiredFlags.has(el.value)) hits.push(`${entry} ${el.value} has no value (next token is another flag, fail closed)`);
      continue;
    }
    if (!isTmpRootedValue(next)) {
      hits.push(`${entry} ${el.value} value is not statically provable as an explicit tmp root (fail closed)`);
    }
  }
  return hits;
}

// Marker for a resolvable tmp-rooted dynamic part inside a command string
// (execSync/exec template). The marker survives whitespace tokenization and
// marks the containing token as statically provable tmp-rooted.
const TMP_SENTINEL = "\u0000TMP\u0000";

// Resolve a command string (execSync/exec) into ordered string parts. A
// template's dynamic expression that resolves to a tmp-rooted path
// (${tmp} where tmp is mkdtemp/os.tmpdir) is provable and marked with the
// TMP_SENTINEL; a `..` segment in the following literal can never be proven
// to stay inside the tmpdir and fails closed. Any other unresolvable part
// (env vars, unknown identifiers, non-tmp paths) returns null so the caller
// fails closed on the statically identifiable target.
function resolveCommandParts(node, lookup, depth = 0) {
  if (!node || depth > 8) return null;
  node = unwrapExpression(node);
  const str = staticString(node);
  if (str !== null) return [{ kind: "string", value: str }];
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      const r = resolveStatic(span.expression, lookup, depth + 1);
      if (r.kind === "string") {
        out += r.value;
      } else if (r.kind === "path" && r.tmpRooted === true) {
        if (span.literal.text.split(/[\\/]/).includes("..")) return null;
        out += TMP_SENTINEL;
      } else {
        return null;
      }
      out += span.literal.text;
    }
    return [{ kind: "string", value: out }];
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolveCommandParts(node.left, lookup, depth + 1);
    const right = resolveCommandParts(node.right, lookup, depth + 1);
    if (!left || !right) return null;
    return [...left, ...right];
  }
  if (ts.isIdentifier(node)) {
    const info = lookup(node.text, node);
    if (info && info.kind === "const") return resolveCommandParts(info.init, lookup, depth + 1);
    return null;
  }
  return null;
}

// Common shell names for shell -c command-string spawns
// (spawnSync("sh", ["-c", "npm run t0:eval"]) / bash/dash/zsh/…). A
// non-shell -c (e.g. `node -c` syntax check) is not a command-string spawn.
const SHELL_NAMES = new Set(["sh", "bash", "dash", "zsh", "ksh", "ash", "csh", "tcsh", "fish", "cmd", "cmd.exe", "pwsh", "powershell", "powershell.exe"]);

// True when a flag string is a shell -c style flag: `-c`, combined short
// flags containing c (`-lc`, `-ec`), `cmd /c`, or PowerShell `-Command`.
function isShellCommandFlag(flag) {
  return flag === "-c" || /^-[a-z]*c[a-z]*$/.test(flag) || flag === "/c" || flag === "/C" || flag === "-Command" || flag === "-command";
}

// Extract the nested command node of a shell -c argv
// (`spawnSync("sh", ["-c", "npm run t0:eval"])`): the element after the
// -c/-Command flag. The shell name (resolved from arguments[0]) must be a
// known shell or unresolvable (fail closed); a non-shell -c is not a
// command-string spawn. The -c flag may be preceded by other shell flags
// (`bash --noprofile -c "…"`), so the whole argv is scanned for the first
// shell command flag. Returns null when the argv is not a shell -c form.
function shellCommandNodeOf(argvNode, shellName, cmdNode, lookup, depth = 0) {
  if (!argvNode || depth > 6) return null;
  argvNode = unwrapExpression(argvNode);
  if (ts.isIdentifier(argvNode)) {
    const info = lookup(argvNode.text, argvNode);
    if (info && info.kind === "const") return shellCommandNodeOf(info.init, shellName, cmdNode, lookup, depth + 1);
    return null;
  }
  if (!ts.isArrayLiteralExpression(argvNode)) return null;
  if (shellName !== null && !SHELL_NAMES.has(shellName)) return null;
  // A known non-shell command (process.execPath / a static node executable /
  // a t0-*.mjs script path) is never a shell -c spawn — `node -c script` is
  // a syntax check, not a command-string spawn. Only a known shell or a
  // truly unknown wrapper analyzes -c.
  if (cmdNode && isAllowedDirectCommandNode(cmdNode, lookup)) return null;
  for (let i = 0; i < argvNode.elements.length; i++) {
    const flagResolved = resolveStatic(argvNode.elements[i], lookup);
    if (flagResolved.kind !== "string" || !isShellCommandFlag(flagResolved.value)) continue;
    return argvNode.elements[i + 1] ?? null;
  }
  return null;
}

// True when a node is (or resolves through const chains to) an object
// literal — i.e. the spawn's SECOND argument is the options object (no
// argv), not an argv array.
function isOptionsObjectNode(node, lookup, depth = 0) {
  if (!node || depth > 6) return false;
  node = unwrapExpression(node);
  if (ts.isObjectLiteralExpression(node)) return true;
  if (ts.isIdentifier(node)) {
    const info = lookup(node.text, node);
    if (info && info.kind === "const") return isOptionsObjectNode(info.init, lookup, depth + 1);
    return false;
  }
  return false;
}

// Shell-state resolution with JS final-value semantics: object properties
// apply left-to-right, so a later shell property overrides an earlier one
// and a spread's shell value is overridden by a later explicit property
// (`{shell:false,shell:true}` is enabled; `{shell:true,shell:false}` and
// `{...base,shell:false}` with base={shell:true} are disabled;
// `{shell:false,...base}` with base={shell:true} is enabled). Returns
// "absent" (no shell property), "disabled" (shell:false / shell:""),
// "enabled" (shell:true / truthy / unknown shell value — fail closed), or
// "unknown" (the options expression itself cannot be proven absent/disabled
// — a conditional/logical/nullish/comma/other non-array non-object
// expression, an unknown identifier, makeOpts() call, or unresolvable spread
// — fail closed whenever the spawn reaches an identifiable T0 target). A
// conditional with BOTH branches provably shell-disabled resolves disabled;
// any provably-enabled branch resolves enabled; a mixed/unknown branch
// resolves unknown. Array literals are argv arrays, not options, and stay
// absent.
function shellStateOfOptions(node, lookup, depth = 0) {
  if (!node) return "absent";
  node = unwrapExpression(node);
  if (ts.isIdentifier(node)) {
    const info = lookup(node.text, node);
    if (info && info.kind === "const") return shellStateOfOptions(info.init, lookup, depth + 1);
    return "unknown";
  }
  if (ts.isCallExpression(node)) return "unknown"; // makeOpts() — fail closed
  if (ts.isObjectLiteralExpression(node)) return shellStateOfObject(node, lookup, depth);
  if (ts.isConditionalExpression(node)) {
    const whenTrue = shellStateOfOptions(node.whenTrue, lookup, depth + 1);
    const whenFalse = shellStateOfOptions(node.whenFalse, lookup, depth + 1);
    if (whenTrue === "enabled" || whenFalse === "enabled") return "enabled";
    if (whenTrue === "unknown" || whenFalse === "unknown") return "unknown";
    return whenTrue === "disabled" || whenFalse === "disabled" ? "disabled" : "absent";
  }
  if (ts.isCommaListExpression(node)) {
    // `(0, {shell:true})` — the final value is the LAST expression.
    if (node.elements.length === 0) return "absent";
    return shellStateOfOptions(node.elements[node.elements.length - 1], lookup, depth + 1);
  }
  if (ts.isBinaryExpression(node)) {
    // `(0, {shell:true})` — a comma expression evaluates left-to-right and
    // yields the RIGHT operand (parsed as a BinaryExpression with CommaToken
    // in expression positions; CommaListExpression covers statement-level
    // contexts).
    if (node.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      return shellStateOfOptions(node.right, lookup, depth + 1);
    }
    // `opts || {shell:true}` / `opts && …` / `opts ?? …` — the final value
    // depends on a runtime operand, so the shell state cannot be proven
    // absent/disabled (fail closed). Other binary operators are not provable
    // options expressions either.
    return "unknown";
  }
  if (ts.isArrayLiteralExpression(node)) return "absent"; // argv array, not options
  return "unknown"; // any other non-array non-object expression — fail closed
}

function shellStateOfObject(node, lookup, depth = 0) {
  let state = "absent";
  for (const prop of node.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const key = propertyKeyOf(prop);
      if (key === null) {
        // Unknown computed property — shell may be set at runtime (fail closed).
        return "unknown";
      }
      if (key !== "shell") continue;
      state = shellValueState(prop.initializer, lookup, depth + 1);
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      if (prop.name.text !== "shell") continue;
      // { shell } — the value comes from the const binding.
      const info = lookup(prop.name.text, prop.name);
      if (info && info.kind === "const") state = shellValueState(info.init, lookup, depth + 1);
      else state = "unknown";
    } else if (ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop) || ts.isMethodDeclaration(prop)) {
      // Accessors/methods: get shell rejects as enabled (runtime shell on);
      // set/method named shell and unknown computed keys are unknown
      // (cannot prove disabled). Ordinary non-shell getters/setters/methods
      // do not affect shell state.
      const key = propertyKeyOf(prop);
      if (key === null) return "unknown";
      if (key !== "shell") continue;
      if (ts.isGetAccessorDeclaration(prop)) state = "enabled";
      else state = "unknown";
    } else if (ts.isSpreadAssignment(prop)) {
      const spreadState = shellStateOfOptions(prop.expression, lookup, depth + 1);
      if (spreadState === "unknown") return "unknown";
      if (spreadState !== "absent") state = spreadState;
    }
  }
  return state;
}

function shellValueState(node, lookup, depth = 0) {
  if (!node || depth > 6) return "unknown";
  node = unwrapExpression(node);
  if (node.kind === ts.SyntaxKind.FalseKeyword) return "disabled";
  if (node.kind === ts.SyntaxKind.TrueKeyword) return "enabled";
  const s = staticString(node);
  if (s === "") return "disabled";
  if (s !== null) return "enabled"; // shell: "/bin/bash" — truthy string
  if (ts.isIdentifier(node)) {
    const info = lookup(node.text, node);
    if (info && info.kind === "const") return shellValueState(info.init, lookup, depth + 1);
    return "unknown";
  }
  return "unknown";
}

// Convert a resolved command (arguments[0]) into an argv element so the
// command stays in target recognition: a static string, or a path whose
// parts may carry the t0-*.mjs script name (path.join(root, "scripts",
// "t0-eval.mjs") with an unresolvable root still resolves to a path).
function commandElementOf(cmdResolved) {
  if (cmdResolved.kind === "string") return { kind: "string", value: cmdResolved.value };
  if (cmdResolved.kind === "path") return { kind: "path", parts: cmdResolved.parts, tmpRooted: cmdResolved.tmpRooted, concrete: cmdResolved.concrete };
  return null;
}

// Analyze a command string (execSync/exec command, shell -c command, or a
// spawn with shell:true / no argv) into argv entries. Static strings are
// tokenized; templates with tmp-rooted dynamic parts are provable and marked
// with the TMP_SENTINEL; any unresolvable part fails closed on the
// statically identifiable target. Every entry is marked shellForm (or
// packageWrapper for npm/yarn/pnpm run aliases): T0 smoke has no business
// launching the T0 CLI through a shell/package-manager wrapper, so a
// command-string spawn that reaches a T0 entry fails closed unconditionally
// in t0SpawnHits — only direct Node/script argv is allowed.
function analyzeCommandString(cmdNode, lookup, argvs) {
  const parts = resolveCommandParts(cmdNode, lookup);
  if (parts) {
    const tokens = [];
    for (const part of parts) {
      for (const raw of commandTokens(part.value)) {
        if (raw.includes(TMP_SENTINEL)) {
          const value = raw.split(TMP_SENTINEL).join("").trim();
          tokens.push({ kind: "string", value: value || "<tmp>", tmpRooted: true });
        } else {
          tokens.push({ kind: "string", value: raw });
        }
      }
    }
    if (envNameOf(tokens[0])) {
      // env-wrapped command string (`env npm run t0:eval`): re-analyze the
      // wrapped command with the same rules as a direct spawn.
      const wrapped = tokens.slice(1);
      const pkg = packageAliasEntry(wrapped);
      if (pkg) argvs.push({ elements: pkg.flags, packageEntry: pkg.entry, packageWrapper: true });
      else argvs.push({ elements: wrapped, shellForm: true });
      return;
    }
    const pkgAlias = packageAliasEntry(tokens);
    if (pkgAlias) {
      argvs.push({ elements: pkgAlias.flags, packageEntry: pkgAlias.entry, packageWrapper: true });
    } else {
      argvs.push({ elements: tokens, shellForm: true });
    }
  } else {
    const targets = staticTargetOf(cmdNode, lookup);
    if (targets.length > 0) {
      const visible = commandTokens(staticFragmentsOf(cmdNode, lookup).join(" "));
      argvs.push({ elements: [], unresolvedTargets: targets, visibleTokens: visible, shellForm: true });
    } else {
      // Unresolvable command string with no identifiable target: still a real
      // shell-form subprocess — fail closed, never silently dropped.
      argvs.push({ elements: [], genericFail: "unapproved child_process call: unresolvable command string (fail closed)" });
    }
  }
}

// env wrapper: `spawnSync("env", ["npm", "run", "t0:eval"])` — the wrapped
// command is the argv itself (env options like -i / -u NAME / VAR=value are
// skipped). The wrapped command is re-analyzed with the same rules as a
// direct spawn: package-manager run aliases and shell -c command strings
// fail closed as wrappers. The approved subset is DIRECT node/script argv
// ONLY, so an env wrapper around a node/t0-script argv is still a wrapper
// and fails closed whenever it reaches an identifiable T0 target; an
// unknown wrapped command fails closed unconditionally.
function analyzeEnvWrapped(elements, lookup, argvs) {
  elements = flattenResolvedElements(elements);
  let i = 0;
  while (i < elements.length && elements[i].kind === "string" && (elements[i].value.startsWith("-") || elements[i].value.includes("="))) i++;
  const wrapped = elements.slice(i);
  if (wrapped.length === 0) {
    argvs.push({ elements: [], genericFail: "unapproved child_process call: env wrapper with no command (fail closed)" });
    return;
  }
  const pkgAlias = packageAliasEntry(wrapped);
  if (pkgAlias) {
    argvs.push({ elements: pkgAlias.flags, packageEntry: pkgAlias.entry, packageWrapper: true });
    return;
  }
  // env-wrapped shell -c: `env sh -c "npm run t0:eval"` — the shell name is
  // wrapped[0]; the -c flag and nested command are scanned from the rest.
  const shellName = wrapped[0]?.kind === "string" ? wrapped[0].value : null;
  if (shellName === null || SHELL_NAMES.has(shellName)) {
    for (let j = 1; j < wrapped.length; j++) {
      const flag = wrapped[j];
      if (flag?.kind === "string" && isShellCommandFlag(flag.value)) {
        const cmd = wrapped[j + 1];
        if (cmd?.kind === "string") {
          const tokens = commandTokens(cmd.value).map((v) => ({ kind: "string", value: v }));
          const pkg = packageAliasEntry(tokens);
          if (pkg) argvs.push({ elements: pkg.flags, packageEntry: pkg.entry, packageWrapper: true });
          else argvs.push({ elements: tokens, shellForm: true });
        } else {
          argvs.push({ elements: [], genericFail: "unapproved child_process call: env-wrapped shell -c without a resolvable command (fail closed)" });
        }
        return;
      }
    }
  }
  // A direct node/t0-script argv through env is a WRAPPER (not an approved
  // direct command) and fails closed whenever it reaches an identifiable T0
  // target; an unknown wrapped command fails closed unconditionally.
  const targets = targetsFromElements(wrapped);
  if (targetScript(wrapped)) {
    argvs.push({ elements: [], unresolvedTargets: targets, shellForm: true });
    return;
  }
  if (targets.length > 0) {
    argvs.push({ elements: [], unresolvedTargets: targets, shellForm: true });
  } else {
    argvs.push({ elements: [], genericFail: "unapproved child_process call: env-wrapped command without an approved T0 target (fail closed)" });
  }
}

// True when a spawn command node is an explicitly allowed DIRECT command:
// process.execPath (or a const alias of it), a static node executable
// ("node" / node.exe / an absolute path to it), or a static t0-*.mjs script
// path (execFile-style). ONLY these may enter the required-flags gate — any
// other command (unknown identifier, dynamic expression, npm/env/timeout/
// docker/busybox wrapper) must fail closed whenever the argv or command
// names a T0 target, even when the argv carries a direct script path.
function isAllowedDirectCommandNode(node, lookup, depth = 0) {
  if (!node || depth > 6) return false;
  node = unwrapExpression(node);
  if (ts.isPropertyAccessExpression(node)) {
    return calleeNameOf(node) === "process.execPath";
  }
  if (ts.isIdentifier(node)) {
    const info = lookup(node.text, node);
    if (!info) return false;
    if (info.kind === "const") return isAllowedDirectCommandNode(info.init, lookup, depth + 1);
    return false;
  }
  const s = staticString(node);
  if (s !== null) {
    let base = s;
    if (base.includes("/") || base.includes("\\")) base = base.split(/[\\/]/).pop();
    base = base.replace(/\.exe$/i, "");
    return base === "node";
  }
  const r = resolveStatic(node, lookup, depth + 1);
  if (r.kind === "path") {
    const last = r.parts[r.parts.length - 1];
    return !!last && /^t0-.*\.mjs$/.test(last);
  }
  return false;
}

// True when a spawn command is provably the node executable ITSELF:
// process.execPath (or a const alias of it) or a static node executable
// ("node" / node.exe / an absolute path to it). Narrower than
// isAllowedDirectCommandNode: an execFile-style t0-*.mjs script path is a
// script, not the node binary, so `t0-*.mjs -c …` is never a node syntax
// check.
function isNodeCommandNode(node, lookup, depth = 0) {
  if (!node || depth > 6) return false;
  node = unwrapExpression(node);
  if (ts.isPropertyAccessExpression(node)) {
    return calleeNameOf(node) === "process.execPath";
  }
  if (ts.isIdentifier(node)) {
    const info = lookup(node.text, node);
    if (!info) return false;
    if (info.kind === "const") return isNodeCommandNode(info.init, lookup, depth + 1);
    return false;
  }
  const s = staticString(node);
  if (s !== null) {
    let base = s;
    if (base.includes("/") || base.includes("\\")) base = base.split(/[\\/]/).pop();
    base = base.replace(/\.exe$/i, "");
    return base === "node";
  }
  return false;
}

// Node syntax-check flags: `-c` / `--check` only. These are the ONLY node
// CLI flags that turn a `node <script>` spawn into a pure syntax check
// (parses the file without executing it). `-e`/`--eval` execute code and
// are deliberately excluded.
function isNodeSyntaxCheckFlag(s) {
  return s === "-c" || s === "--check";
}

// Principled syntax-check exemption for `node -c/--check <script>`: the
// command must be provably the node executable itself (process.execPath /
// static node executable — never a t0-*.mjs execFile-style path, shell,
// package manager, or unknown wrapper) and the argv must be statically
// resolvable to EXACTLY [checkFlag, script] — no spread, no dynamic
// elements, nothing after the script. The script position may be any static
// string (node treats it as a filename to check; `node -c "npm run t0:eval"`
// can never trigger the package manager) or a path (const-bound /
// path.join T0 .mjs paths included). A dynamic argv or a check flag mixed
// with execution-bearing elements is not the exact safe shape and fails
// closed through the normal gates. The caller must also have verified the
// shell state is absent/disabled — shell:true / unresolvable options never
// reach here.
function isNodeSyntaxCheckForm({ cmdNode, argvNode, lookup }) {
  if (!isNodeCommandNode(cmdNode, lookup)) return false;
  const resolved = resolveStatic(argvNode, lookup);
  if (resolved.kind !== "array" || resolved.elements.length !== 2) return false;
  const [flag, script] = resolved.elements;
  if (flag.kind !== "string" || !isNodeSyntaxCheckFlag(flag.value)) return false;
  return script.kind === "string" || script.kind === "path";
}

// Resolve every real spawn argv in the file. The argv expression is
// resolved through resolveStatic first, so `const argv = [...];
// spawnSync(..., argv)` is analyzed just like a direct ArrayLiteral. The
// `[script, ...param]` helper pattern (spawnSelect / spawnBuild style) is
// expanded to each call site's argument, with the helper's own static
// elements (script + any fixed flags) kept — every callsite is verified
// one by one and an unresolvable callsite / no-callsite helper fails
// closed as a generic failure record, never silently dropped. execSync/exec
// take a single command string and are tokenized the same way — the
// callee's RESOLVED spawn kind is used (spawnKindOf), so
// `import { execSync as run }` and multi-hop const aliases of execSync/exec
// go through command-string analysis, never the argv branch.
// Shell/command-string spawns are analyzed the same way:
// `spawnSync("sh", ["-c", "npm run t0:eval"])` (bash/dash/zsh/… -c, with
// flags before -c allowed), `spawnSync("npm run t0:eval", {shell:true})`
// and `spawnSync("node scripts/t0-eval.mjs", {shell:true})` — the options
// object may be the second OR third argument (possibly a const-bound
// options variable). T0 smoke has no business launching the T0 CLI through
// a shell/package-manager wrapper, so every command-string / package-alias
// / env-wrapped / unknown-wrapper form that reaches a T0 entry fails
// closed unconditionally (shellForm/packageWrapper markers); only
// statically-resolvable direct Node/script argv is gated on required flags
// + tmp path values. A spawn with NO argv whose static
// command names a T0 target fails closed. npm/yarn/pnpm `run t0:*` aliases
// (including absolute package-manager paths like `/usr/bin/npm`) are mapped
// back to their T0 entry and fail closed as wrappers. An argv/command that
// cannot be resolved fails closed as an unresolved argv (with its VISIBLE
// static tokens kept when the target is identifiable) or as a GENERIC
// failure record when no target is identifiable — including helpers with
// no resolvable callsite, unresolvable callsite args, and anonymous/nested
// helpers: a real call is never silently dropped.
function analyzeSpawnArgvs(sourceFile, lookup) {
  const argvs = [];
  const helperPatterns = [];
  const paramArgvHelpers = [];
  for (const call of findSpawnCalls(sourceFile)) {
    const kind = spawnKindOf(call.expression, lookup);
    if (kind === "execSync" || kind === "exec") {
      const cmdNode = call.arguments[0];
      if (!cmdNode) {
        argvs.push({ elements: [], genericFail: "unapproved child_process call: execSync/exec with no command (fail closed)" });
        continue;
      }
      analyzeCommandString(cmdNode, lookup, argvs);
      continue;
    }
    const argvNode = call.arguments[1];
    const cmdResolved = resolveStatic(call.arguments[0], lookup);
    const cmdElement = commandElementOf(cmdResolved);
    if (!argvNode) {
      // No argv at all: a static command naming a T0 target fails closed —
      // the command would run with production defaults (or is a malformed
      // execFile-style form that must never be silently skipped); a command
      // with no identifiable target is still an unapproved subprocess.
      const targets = new Set(staticTargetOf(call.arguments[0], lookup));
      if (cmdElement) {
        for (const t of targetsFromElements([cmdElement])) targets.add(t);
      }
      if (targets.size > 0) argvs.push({ elements: [], unresolvedTargets: [...targets] });
      else argvs.push({ elements: [], genericFail: "unapproved child_process call: spawn with no argv and no identifiable T0 target (fail closed)" });
      continue;
    }
    // shell -c command strings: spawnSync("sh", ["-c", "npm run t0:eval"]) /
    // bash/dash/zsh/… — the nested command string is analyzed like an
    // execSync command (npm run t0:* aliases map back to the T0 entry). A
    // known non-shell command (process.execPath / node) is never a shell -c
    // spawn — `node -c script` is a syntax check.
    const shellCmdNode = shellCommandNodeOf(argvNode, cmdElement?.kind === "string" ? cmdElement.value : null, call.arguments[0], lookup);
    if (shellCmdNode) {
      analyzeCommandString(shellCmdNode, lookup, argvs);
      continue;
    }
    // shell:true command strings: spawnSync("npm run t0:eval", {shell:true})
    // / spawnSync("node scripts/t0-eval.mjs", {shell:true}). The options
    // object may be the SECOND argument (no argv) or the THIRD argument
    // (spawnSync(cmd, argv, {shell:true})), possibly through a const-bound
    // options variable — both positions are checked. With shell:true the
    // argv is joined into the shell command, so any T0 target in the argv
    // (direct script argv, env-wrapped package run) fails closed too. The
    // shell state follows JS final-value semantics (left-to-right override,
    // spread then explicit property); an options expression that cannot be
    // resolved (unknown identifier, makeOpts() call, unresolvable spread)
    // fails closed whenever the spawn reaches an identifiable T0 target.
    const optsNode = isOptionsObjectNode(argvNode, lookup) ? argvNode : call.arguments[2];
    const optsState = shellStateOfOptions(optsNode, lookup);
    // Node syntax-check form (`node -c/--check <script>`): when the shell
    // state is absent/disabled and the argv is statically EXACTLY
    // [checkFlag, script], the spawn is a pure syntax check that parses the
    // script WITHOUT executing it — it never runs the T0 pipeline, so it
    // must not trip the required-flags gate. Only an explicit direct node
    // command (process.execPath / static node executable) qualifies; -e/
    // --eval (executes code), dynamic argv, mixed-in elements after the
    // check flag, and any shell/package-manager/unknown wrapper fail closed
    // through the normal gates instead.
    if ((optsState === "absent" || optsState === "disabled") && isNodeSyntaxCheckForm({ cmdNode: call.arguments[0], argvNode, lookup })) {
      continue;
    }
    if (optsState === "enabled") {
      analyzeCommandString(call.arguments[0], lookup, argvs);
      const shellCmdNode = shellCommandNodeOf(argvNode, cmdElement?.kind === "string" ? cmdElement.value : null, call.arguments[0], lookup);
      if (shellCmdNode) {
        analyzeCommandString(shellCmdNode, lookup, argvs);
      } else {
        const resolved = resolveStatic(argvNode, lookup);
        if (resolved.kind === "array") {
          const elements = resolved.elements;
          if (elements.some((el) => el.kind === "spread")) {
            const fixed = elements.filter((el) => el.kind !== "spread");
            const withCmd = cmdElement ? [cmdElement, ...fixed] : fixed;
            const pkgAlias = packageAliasEntry(withCmd);
            if (pkgAlias) {
              argvs.push({ elements: pkgAlias.flags, packageEntry: pkgAlias.entry, packageWrapper: true });
            } else {
              const targets = targetsFromElements(withCmd);
              if (targets.length > 0) argvs.push({ elements: [], unresolvedTargets: targets });
              else argvs.push({ elements: [], genericFail: "unapproved child_process call: shell:true argv contains an unresolved spread (fail closed)" });
            }
          } else if (envNameOf(cmdElement)) {
            analyzeEnvWrapped(elements, lookup, argvs);
          } else {
            const withCmd = cmdElement ? [cmdElement, ...elements] : elements;
            const pkgAlias = packageAliasEntry(withCmd);
            if (pkgAlias) {
              argvs.push({ elements: pkgAlias.flags, packageEntry: pkgAlias.entry, packageWrapper: true });
            } else {
              argvs.push({ elements: withCmd, shellForm: true });
            }
          }
        } else {
          // shell:true with a non-array argv (string / unknown shape): the
          // joined shell command cannot be statically approved — fail closed.
          const targets = new Set([...staticTargetOf(call.arguments[0], lookup), ...staticTargetOf(argvNode, lookup)]);
          if (targets.size > 0) argvs.push({ elements: [], unresolvedTargets: [...targets], shellForm: true });
          else argvs.push({ elements: [], genericFail: "unapproved child_process call: unresolvable shell:true argv (fail closed)" });
        }
      }
      continue;
    }
    if (optsState === "unknown") {
      // Unknown options object (unknown identifier / makeOpts() call /
      // unresolvable spread): the shell state cannot be proven disabled, so
      // fail closed whenever the command or argv names an identifiable T0
      // target. Record the failure and do NOT fall through into argv analysis
      // (a runtime-enabled shell would rewrite the argv as a shell command).
      const targets = new Set([...staticTargetOf(call.arguments[0], lookup), ...staticTargetOf(argvNode, lookup)]);
      if (cmdElement) {
        for (const t of targetsFromElements([cmdElement])) targets.add(t);
      }
      if (targets.size > 0) {
        argvs.push({ elements: [], unresolvedTargets: [...targets], unknownOptions: true });
      } else {
        // Unresolvable options on a spawn with no identifiable T0 target:
        // the shell state cannot be proven disabled — fail closed.
        argvs.push({ elements: [], genericFail: "unapproved child_process call: unresolvable options (shell state cannot be proven disabled, fail closed)" });
      }
      continue;
    }
    const resolved = resolveStatic(argvNode, lookup);
    if (resolved.kind === "array") {
      const elements = resolved.elements;
      if (elements.some((el) => el.kind === "spread")) {
        const fn = enclosingFunction(call);
        const name = fn ? functionName(fn) : null;
        if (name) {
          helperPatterns.push({ name, elements, cmdElement, cmdNode: call.arguments[0], binding: lookup(name, call) });
          continue;
        }
        // Anonymous helper (or nested anonymous fn): cannot expand to
        // callsites — fail closed on the fixed target instead of silently
        // dropping the spawn.
        const fixed = elements.filter((el) => el.kind !== "spread");
        const withCmd = cmdElement ? [cmdElement, ...fixed] : fixed;
        const pkgAlias = packageAliasEntry(withCmd);
        if (pkgAlias) {
          argvs.push({ elements: pkgAlias.flags, packageEntry: pkgAlias.entry, packageWrapper: true });
          continue;
        }
        const targets = targetsFromElements(withCmd);
        if (targets.length > 0) argvs.push({ elements: [], unresolvedTargets: targets });
        else argvs.push({ elements: [], genericFail: "unapproved child_process call: argv contains an unresolved spread (cycle/budget exceeded or dynamic, fail closed)" });
        continue;
      }
      // npm/yarn/pnpm `run t0:*` aliases: the command is arguments[0] and
      // the args are arguments[1] — combine them for alias detection. The
      // command is kept in the elements for non-alias argv too, so a direct
      // execFile-style spawn whose command is a t0-*.mjs path
      // (spawnSync(script, ["--episodes", …])) never loses its target.
      let withCmd = cmdElement ? [cmdElement, ...elements] : elements;
      // env wrapper: `spawnSync("env", ["npm", "run", "t0:eval"])` — the
      // wrapped command is the argv itself (env options -i/-u/VAR=value are
      // skipped); it is re-analyzed with the same rules as a direct spawn.
      if (envNameOf(cmdElement)) {
        analyzeEnvWrapped(elements, lookup, argvs);
        continue;
      }
      const pkgAlias = packageAliasEntry(withCmd);
      if (pkgAlias) {
        argvs.push({ elements: pkgAlias.flags, packageEntry: pkgAlias.entry, packageWrapper: true });
        continue;
      }
      // Unknown/dynamic command wrapper: only an explicitly allowed direct
      // command (process.execPath / static node executable / static
      // t0-*.mjs execFile-style) may enter the required-flags gate. Any
      // other command — unknown identifier, dynamic expression,
      // npm/env/timeout/docker/busybox wrapper — must fail closed whenever
      // the argv or command names a T0 target, even when the argv carries a
      // direct script path.
      if (!isAllowedDirectCommandNode(call.arguments[0], lookup)) {
        const targets = new Set([...staticTargetOf(argvNode, lookup), ...staticTargetOf(call.arguments[0], lookup)]);
        if (cmdElement) {
          for (const t of targetsFromElements([cmdElement])) targets.add(t);
        }
        if (targets.size > 0) {
          argvs.push({ elements: [], unresolvedTargets: [...targets] });
          continue;
        }
        // Unknown command wrapper with no identifiable T0 target: still an
        // unapproved subprocess — fail closed, never silently dropped.
        argvs.push({ elements: [], genericFail: "unapproved child_process call: unknown/dynamic command wrapper without an identifiable T0 target (fail closed)" });
        continue;
      }
      argvs.push({ elements: withCmd, ...(elements.some((el) => el.kind === "unknown") ? { visibleTokens: commandTokens(staticFragmentsOf(argvNode, lookup).join(" ")) } : {}) });
    } else if (resolved.kind === "unknown") {
      // Param-argv helper data flow: `function run(argv) {
      // spawnSync(process.execPath, argv) }` — the argv is a function
      // param, so each callsite's argument at that position becomes the
      // argv. Collected here and expanded to callsites below (function
      // declarations and const arrows, multiple callsites).
      if (ts.isIdentifier(argvNode)) {
        const fn = enclosingFunction(call);
        const name = fn ? functionName(fn) : null;
        if (name) {
          const params = fn.parameters ?? [];
          const argvIdx = params.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === argvNode.text);
          if (argvIdx !== -1) {
            let cmdIdx = null;
            if (ts.isIdentifier(call.arguments[0])) {
              const cIdx = params.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === call.arguments[0].text);
              if (cIdx !== -1) cmdIdx = cIdx;
            }
            paramArgvHelpers.push({ name, argvParamIndex: argvIdx, cmdParamIndex: cmdIdx, cmdElement, cmdNode: call.arguments[0], binding: lookup(name, call) });
            continue;
          }
        }
      }
      // Unresolved argv: fail closed whenever the STATIC fragments of the
      // argv OR the command identify a T0 target.
      const targets = new Set([...staticTargetOf(argvNode, lookup), ...staticTargetOf(call.arguments[0], lookup)]);
      if (cmdElement) {
        for (const t of targetsFromElements([cmdElement])) targets.add(t);
      }
      if (targets.size > 0) {
        const visible = commandTokens(staticFragmentsOf(argvNode, lookup).join(" "));
        argvs.push({ elements: [], unresolvedTargets: [...targets], visibleTokens: visible });
      } else {
        // Unresolvable argv with no identifiable target (conditional /
        // concat / filter / array-index / replace / dynamic expression):
        // fail closed — never silently dropped.
        argvs.push({ elements: [], genericFail: "unapproved child_process call: unresolvable argv (cannot be statically resolved, fail closed)" });
      }
    } else if (resolved.kind === "object") {
      // Options object without shell: the command is executed directly — a
      // t0-*.mjs command with no flags runs with production defaults.
      const targets = new Set(staticTargetOf(call.arguments[0], lookup));
      if (cmdElement) {
        for (const t of targetsFromElements([cmdElement])) targets.add(t);
      }
      if (targets.size > 0) argvs.push({ elements: [], unresolvedTargets: [...targets] });
      else argvs.push({ elements: [], genericFail: "unapproved child_process call: spawn options object without argv and no identifiable T0 target (fail closed)" });
    } else {
      // A resolved string/path/function argv (spawnSync("node", "arg")) is
      // not an argv array — fail closed, never silently dropped.
      const targets = new Set([...staticTargetOf(argvNode, lookup), ...staticTargetOf(call.arguments[0], lookup)]);
      if (cmdElement) {
        for (const t of targetsFromElements([cmdElement])) targets.add(t);
      }
      if (targets.size > 0) argvs.push({ elements: [], unresolvedTargets: [...targets] });
      else argvs.push({ elements: [], genericFail: "unapproved child_process call: non-array argv shape (cannot be statically approved, fail closed)" });
    }
  }
  for (const hp of helperPatterns) {
    const fixed = hp.elements.filter((el) => el.kind !== "spread");
    const fixedWithCmd = hp.cmdElement ? [hp.cmdElement, ...fixed] : fixed;
    const fixedTargets = targetsFromElements(fixedWithCmd);
    // Scope-aware callsite matching: only calls whose `name` resolves to the
    // SAME binding as the helper count — a same-named helper in another
    // scope (e.g. two `run` helpers in different check callbacks) must never
    // be attributed to this one.
    const calls = findCallsOf(sourceFile, hp.name).filter((c) => lookup(hp.name, c) === hp.binding);
    if (calls.length === 0) {
      // Helper with no resolvable callsite: fail closed unconditionally —
      // the spread cannot be expanded, so the real argv is unknowable (a
      // fixed t0 script is attached for the narrow detectors).
      const pkgAlias = packageAliasEntry(fixedWithCmd);
      if (pkgAlias) {
        argvs.push({ elements: pkgAlias.flags, packageEntry: pkgAlias.entry, packageWrapper: true });
      } else {
        argvs.push({ elements: [], unresolvedTargets: fixedTargets, genericFail: "unapproved child_process call: helper has no resolvable callsite (fail closed)" });
      }
      continue;
    }
    for (const call of calls) {
      const arg = call.arguments[0];
      // Dynamic command wrapper: the helper's command must be an allowed
      // direct command; otherwise fail closed on any identifiable target
      // (fixed or from the callsite arg) — an unknown command must never be
      // allowed through an argv that carries a direct script path.
      if (hp.cmdNode && !isAllowedDirectCommandNode(hp.cmdNode, lookup)) {
        const targets = [...new Set([...fixedTargets, ...(arg ? staticTargetOf(arg, lookup) : [])])];
        if (targets.length > 0) {
          argvs.push({ elements: [], unresolvedTargets: targets });
          continue;
        }
      }
      if (!arg) {
        // No callsite arg: the spread is empty — fail closed unconditionally
        // (the fixed target is attached for the narrow detectors).
        argvs.push({ elements: [], unresolvedTargets: fixedTargets, genericFail: "unapproved child_process call: helper callsite without argv (fail closed)" });
        continue;
      }
      const resolved = resolveStatic(arg, lookup);
      if (resolved.kind === "array") {
        const combined = [...fixedWithCmd, ...resolved.elements];
        if (combined.some((el) => el.kind === "spread")) {
          const targets = [...new Set([...fixedTargets, ...targetsFromElements(resolved.elements)])];
          argvs.push({ elements: [], unresolvedTargets: targets, genericFail: "unapproved child_process call: helper callsite argv contains an unresolved spread (fail closed)" });
          continue;
        }
        const pkgAlias = packageAliasEntry(combined);
        if (pkgAlias) {
          argvs.push({ elements: pkgAlias.flags, packageEntry: pkgAlias.entry, packageWrapper: true });
          continue;
        }
        argvs.push({ elements: combined });
      } else if (resolved.kind === "unknown") {
        const targets = [...new Set([...fixedTargets, ...staticTargetOf(arg, lookup)])];
        argvs.push({ elements: [], unresolvedTargets: targets, genericFail: "unapproved child_process call: helper callsite argv unresolvable (fail closed)" });
      } else {
        // Callsite arg resolves to a non-array (string/path/object): the
        // helper spread would receive a scalar — fail closed.
        const targets = [...new Set([...fixedTargets, ...staticTargetOf(arg, lookup)])];
        argvs.push({ elements: [], unresolvedTargets: targets, genericFail: "unapproved child_process call: helper callsite argv is not an array (fail closed)" });
      }
    }
  }
  for (const hp of paramArgvHelpers) {
    // Scope-aware callsite matching (same binding identity as the helper).
    const calls = findCallsOf(sourceFile, hp.name).filter((c) => lookup(hp.name, c) === hp.binding);
    if (calls.length === 0) {
      // Helper with no resolvable callsite: fail closed unconditionally.
      const fixedTargets = hp.cmdElement ? targetsFromElements([hp.cmdElement]) : [];
      argvs.push({ elements: [], unresolvedTargets: fixedTargets, genericFail: "unapproved child_process call: helper has no resolvable callsite (fail closed)" });
      continue;
    }
    for (const call of calls) {
      const cmdNode = hp.cmdParamIndex !== null ? call.arguments[hp.cmdParamIndex] : hp.cmdNode;
      const cmdEl = hp.cmdParamIndex !== null
        ? (cmdNode ? commandElementOf(resolveStatic(cmdNode, lookup)) : null)
        : hp.cmdElement;
      const arg = call.arguments[hp.argvParamIndex];
      if (!arg) {
        const fixedTargets = cmdEl ? targetsFromElements([cmdEl]) : [];
        argvs.push({ elements: [], unresolvedTargets: fixedTargets, genericFail: "unapproved child_process call: helper callsite without argv (fail closed)" });
        continue;
      }
      const resolved = resolveStatic(arg, lookup);
      // Dynamic command wrapper: only an allowed direct command may enter
      // the required-flags gate; an unknown command must fail closed on any
      // identifiable target even when the argv carries a direct script path.
      if (cmdNode && !isAllowedDirectCommandNode(cmdNode, lookup)) {
        const targets = [...new Set([...(cmdEl ? targetsFromElements([cmdEl]) : []), ...staticTargetOf(arg, lookup)])];
        if (targets.length > 0) {
          argvs.push({ elements: [], unresolvedTargets: targets });
          continue;
        }
      }
      if (resolved.kind === "array") {
        const combined = cmdEl ? [cmdEl, ...resolved.elements] : resolved.elements;
        if (combined.some((el) => el.kind === "spread")) {
          const targets = [...new Set([...(cmdEl ? targetsFromElements([cmdEl]) : []), ...targetsFromElements(resolved.elements)])];
          argvs.push({ elements: [], unresolvedTargets: targets, genericFail: "unapproved child_process call: helper callsite argv contains an unresolved spread (fail closed)" });
          continue;
        }
        const pkgAlias = packageAliasEntry(combined);
        if (pkgAlias) {
          argvs.push({ elements: pkgAlias.flags, packageEntry: pkgAlias.entry, packageWrapper: true });
          continue;
        }
        argvs.push({ elements: combined });
      } else if (resolved.kind === "unknown") {
        const targets = [...new Set([...(cmdEl ? targetsFromElements([cmdEl]) : []), ...staticTargetOf(arg, lookup)])];
        argvs.push({ elements: [], unresolvedTargets: targets, genericFail: "unapproved child_process call: helper callsite argv unresolvable (fail closed)" });
      } else {
        // Callsite arg resolves to a non-array (string/path/object): the
        // helper argv would receive a scalar — fail closed.
        const targets = [...new Set([...(cmdEl ? targetsFromElements([cmdEl]) : []), ...staticTargetOf(arg, lookup)])];
        argvs.push({ elements: [], unresolvedTargets: targets, genericFail: "unapproved child_process call: helper callsite argv is not an array (fail closed)" });
      }
    }
  }
  return argvs;
}

function elementStrings(elements, out = []) {
  for (const el of elements) {
    if (el.kind === "string") out.push(el.value);
    else if (el.kind === "path") out.push(...el.parts);
    else if (el.kind === "array") elementStrings(el.elements, out);
  }
  return out;
}

// Identify the T0 target scripts among a (flat) element sequence: scans ALL
// elements so an intermediate runner/helper .mjs earlier in the argv can
// never shadow a later T0 target (the first arbitrary .mjs is NOT the
// target). Returns the distinct set of T0 entry names plus an unknownT0 flag
// (a t0-*.mjs script with no defined entry).
function t0MarkersOf(elements) {
  const entries = new Set();
  let unknownT0 = false;
  for (const el of flattenResolvedElements(elements)) {
    const s = el.kind === "string" ? el.value : (el.kind === "path" ? (el.parts[el.parts.length - 1] ?? null) : null);
    if (!s) continue;
    let matched = false;
    for (const [name, def] of Object.entries(T0_ENTRIES)) {
      if (s.endsWith(def.marker)) {
        entries.add(name);
        matched = true;
        break;
      }
    }
    if (!matched && /^t0-.*\.mjs$/.test(s)) unknownT0 = true;
  }
  return { entries, unknownT0 };
}

// First T0 script marker in the flattened element sequence (all elements
// scanned — a non-T0 runner earlier in the argv never shadows a later T0
// target). Returns the marker script string ("t0-eval.mjs" etc.) or null.
function targetScript(elements) {
  for (const el of flattenResolvedElements(elements)) {
    const s = el.kind === "string" ? el.value : (el.kind === "path" ? (el.parts[el.parts.length - 1] ?? null) : null);
    if (s && /^t0-.*\.mjs$/.test(s)) return s;
  }
  return null;
}

// The makeJudgeInvoker detector is an executable-REFERENCE lock (ADR 0027
// C6): t0-eval-common's makeJudgeInvoker builds a real judge provider, so a
// smoke must never hold an executable reference to it AT ALL — not even an
// assigned-but-never-called alias, an object property, a destructured read,
// a Reflect.apply argument, an array element, or a .bind result. ANY
// identifier/property/element that is NAMED makeJudgeInvoker or RESOLVES to
// it (import aliases, multi-hop const aliases, destructured renames,
// namespace / dynamic-import properties) is rejected unless it sits in an
// import-specifier declaration or an object-literal property KEY position,
// or is string/comment text. A same-named property PROVABLY from a different
// module (a static or statically-resolvable module specifier that is not
// t0-eval-common) is allowed; anything that cannot be proven non-
// t0-eval-common fails closed.
function isT0EvalCommonSpecifier(spec) {
  return /(?:^|[\\/])t0-eval-common(?:\.mjs)?$/.test(spec);
}

// Resolve a node to the static module specifier of the module it was loaded
// from: a static namespace import's moduleSpecifier, or a dynamic
// import/require call's static string argument — through const alias chains
// and await unwrapping. A dynamic specifier (`import(path.join(root,
// "scripts/t0-eval-common.mjs"))`) resolves through resolveStatic when its
// static fragments pin the basename. Returns null when the module source
// cannot be proven statically (fail closed).
function moduleSpecifierOf(node, lookup, depth = 0) {
  if (!node || depth > 6) return null;
  node = unwrapExpression(node);
  if (ts.isIdentifier(node)) {
    const info = lookup(node.text, node);
    if (!info) return null;
    if (info.kind === "namespace") {
      const spec = info.moduleSpecifier;
      return ts.isStringLiteral(spec) ? spec.text : null;
    }
    if (info.kind === "const") return moduleSpecifierOf(info.init, lookup, depth + 1);
    return null;
  }
  if (ts.isAwaitExpression(node)) return moduleSpecifierOf(node.expression, lookup, depth + 1);
  if (ts.isCallExpression(node)) {
    const name = calleeNameOf(node.expression);
    if (name === "import" || name === "require") {
      const spec = staticString(node.arguments[0]);
      if (spec !== null) return spec;
      const r = resolveStatic(node.arguments[0], lookup);
      if (r.kind === "path" || r.kind === "string") {
        const last = r.kind === "path" ? r.parts[r.parts.length - 1] : r.value;
        if (typeof last === "string" && last !== "") return last;
      }
      return null;
    }
    return null;
  }
  return null;
}

// True when a module source node is (or cannot be proven to NOT be)
// t0-eval-common — the marker module. A provably different module returns
// false (allowed); an unprovable source returns true (fail closed).
function isMarkerModuleSource(node, lookup) {
  const spec = moduleSpecifierOf(node, lookup);
  return spec === null ? true : isT0EvalCommonSpecifier(spec);
}

// Base of a `.makeJudgeInvoker` / `["makeJudgeInvoker"]` access: true when
// the base is the marker module namespace (or unprovable → fail closed);
// false only when the base is provably a different module.
function isMarkerBase(node, lookup, depth = 0) {
  if (!node || depth > 6) return true;
  node = unwrapExpression(node);
  if (ts.isIdentifier(node)) {
    const info = lookup(node.text, node);
    if (!info) return true; // undeclared base — fail closed
    if (info.kind === "namespace") {
      const spec = info.moduleSpecifier;
      return ts.isStringLiteral(spec) ? isT0EvalCommonSpecifier(spec.text) : true;
    }
    if (info.kind === "const") {
      if (info.destructuredProp !== undefined) return isMarkerModuleSource(info.init, lookup);
      return isMarkerBase(info.init, lookup, depth + 1);
    }
    return true; // import/param/function binding base — fail closed
  }
  if (ts.isAwaitExpression(node)) return isMarkerBase(node.expression, lookup, depth + 1);
  if (ts.isCallExpression(node)) {
    const name = calleeNameOf(node.expression);
    if (name === "import" || name === "require") return isMarkerModuleSource(node, lookup);
    return true;
  }
  if (ts.isPropertyAccessExpression(node) && node.name.text === "default") {
    return isMarkerBase(node.expression, lookup, depth + 1);
  }
  if (ts.isElementAccessExpression(node)) {
    const key = staticString(node.argumentExpression);
    if (key === "default") return isMarkerBase(node.expression, lookup, depth + 1);
    return true;
  }
  return true; // any other base shape — fail closed
}

// True when an identifier USE is a reference to the makeJudgeInvoker marker:
// either its surface name is makeJudgeInvoker (with the binding consulted so
// a provably different module's same-named import/property stays allowed) or
// it resolves through const/import/destructure chains to the marker.
function isMarkerReference(node, lookup, depth = 0) {
  if (!node || depth > 8) return false;
  node = unwrapExpression(node);
  if (!ts.isIdentifier(node)) return false;
  const info = lookup(node.text, node);
  if (node.text === "makeJudgeInvoker") {
    if (info && info.kind === "import") {
      // Same-named named import: allowed only when the module is provably
      // NOT t0-eval-common.
      const spec = info.moduleSpecifier;
      return !(ts.isStringLiteral(spec) && !isT0EvalCommonSpecifier(spec.text));
    }
    if (info && info.kind === "const" && info.destructuredProp !== undefined) {
      // `const { makeJudgeInvoker } = await import("…")` — a destructured
      // read; allowed only when the source module is provably not the marker.
      return isMarkerModuleSource(info.init, lookup);
    }
    // Undeclared / local const / param / function binding named
    // makeJudgeInvoker: no provable other-module provenance → fail closed.
    return true;
  }
  if (!info) return false;
  if (info.kind === "import") {
    if (info.importedName !== "makeJudgeInvoker") return false;
    const spec = info.moduleSpecifier;
    return !(ts.isStringLiteral(spec) && !isT0EvalCommonSpecifier(spec.text));
  }
  if (info.kind === "const") {
    if (info.destructuredProp !== undefined) {
      return info.destructuredProp === "makeJudgeInvoker" && isMarkerModuleSource(info.init, lookup);
    }
    return isMarkerReference(info.init, lookup, depth + 1);
  }
  return false;
}

// True when an identifier sits in a DECLARATION position: import specifier
// names, object-literal property KEYS (including methods / accessors / class
// members), and binding/parameter/function/class NAMES. An EXPORT specifier
// is deliberately NOT a declaration: `export { launch }` (no module
// specifier) is a REFERENCE to the local binding — exporting an approved
// child_process alias or the makeJudgeInvoker marker is an executable
// reference. (`export { x } from "…"` re-export subtrees are skipped by the
// child_process pass 2 walk and re-reviewed by the marker walk.)
// A BindingElement PROPERTY name is a source read, not a declaration, so it
// is NOT exempt — destructuring the marker property is an executable
// reference. Shorthand object properties read the variable too and are not
// exempt. An object-binding SHORTHAND name (`{ makeJudgeInvoker }`) is both
// a local declaration AND a source property read — it still gets the
// declaration exemption here (so `{ other }` stays allowed), but
// makeJudgeInvokerHits re-reviews shorthand names as marker references.
function inDeclarationPosition(node) {
  const p = node.parent;
  if (!p) return false;
  if (ts.isImportSpecifier(p) || ts.isNamespaceImport(p) || ts.isImportClause(p)) return true;
  if (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isClassDeclaration(p) || ts.isClassExpression(p)) return p.name === node;
  if (ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isArrowFunction(p)) return p.name === node;
  if (ts.isVariableDeclaration(p) || ts.isParameter(p)) return p.name === node;
  if (ts.isBindingElement(p)) return p.name === node; // local name = declaration; propertyName = read → reject
  return false;
}

// True when an identifier is the NAME of an OBJECT-binding SHORTHAND element
// (`const { makeJudgeInvoker } = await import(…)`): no propertyName, so the
// name is also the source property being read — destructuring it holds an
// executable reference to that property even when never used afterwards.
// A named binding (`{ makeJudgeInvoker: invoke }`) HAS a propertyName (the
// read) and its name is purely the local declaration; an ARRAY binding
// element (`[makeJudgeInvoker]`) is positional — its name is no property
// read at all. Both keep the plain declaration exemption.
function isObjectShorthandBindingName(node) {
  const p = node.parent;
  if (!p || !ts.isBindingElement(p) || p.name !== node || p.propertyName !== undefined) return false;
  return !!p.parent && ts.isObjectBindingPattern(p.parent);
}

// Executable makeJudgeInvoker reference hits: every identifier/property/
// element named makeJudgeInvoker or resolving to it, in a non-declaration
// position — string/comment occurrences are never visited by the AST walk,
// so they stay allowed automatically.
function makeJudgeInvokerHits(sf) {
  const { lookup } = collectBindings(sf);
  const hits = [];
  const visit = (node) => {
    if (!node) return;
    if (ts.isPropertyAccessExpression(node)) {
      if (node.name.text === "makeJudgeInvoker" && isMarkerBase(node.expression, lookup)) {
        hits.push("executable makeJudgeInvoker property reference (fail closed)");
      }
      visit(node.expression);
      return;
    }
    if (ts.isElementAccessExpression(node)) {
      // Static key OR a const-bound string key (`const k = "makeJudgeInvoker"; C[k]`).
      let key = staticString(node.argumentExpression);
      if (key === null) {
        const r = resolveStatic(node.argumentExpression, lookup);
        if (r.kind === "string") key = r.value;
      }
      if (key === "makeJudgeInvoker" && isMarkerBase(node.expression, lookup)) {
        hits.push("executable makeJudgeInvoker element reference (fail closed)");
      }
      visit(node.expression);
      visit(node.argumentExpression);
      return;
    }
    if (ts.isIdentifier(node)) {
      // Property-NAME identifiers are decided at the PropertyAccess level
      // (the base determines whether the module is the marker).
      if (node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) return;
      if (inDeclarationPosition(node)) {
        // Object-binding SHORTHAND name: exempt from the plain reference
        // walk, but it doubles as a source property read — reject when it
        // is/resolves to makeJudgeInvoker from a marker or unprovable
        // source. Named binding names and array-binding names are pure
        // local declarations and stay exempt.
        if (isObjectShorthandBindingName(node) && isMarkerReference(node, lookup)) {
          hits.push("executable makeJudgeInvoker shorthand binding (fail closed)");
        }
        return;
      }
      if (isMarkerReference(node, lookup)) {
        hits.push("executable makeJudgeInvoker reference (fail closed)");
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return hits;
}

// A node inside an assert.* call argument is test assertion text, not I/O:
// a plain assert string naming the production path must not trip the lock.
function isAssertArgument(node) {
  let cur = node.parent;
  while (cur) {
    if (ts.isCallExpression(cur)) {
      const name = calleeNameOf(cur.expression);
      if (name && (name === "assert" || name.startsWith("assert."))) return true;
      return false;
    }
    cur = cur.parent;
  }
  return false;
}

// True when a node is a property/element access on a module namespace import
// whose property name carries a production data marker (episodes/models) —
// the value is unknowable statically, so the path fails closed (best-effort
// coverage of module-property production paths like
// `path.join(C.DEFAULT_EPISODES_PATH, …)`).
function isModulePropertyProductionPath(node, lookup) {
  if (!node) return false;
  node = unwrapExpression(node);
  let propName = null;
  let base = null;
  if (ts.isPropertyAccessExpression(node)) {
    propName = node.name.text;
    base = node.expression;
  } else if (ts.isElementAccessExpression(node)) {
    const key = staticString(node.argumentExpression);
    if (key === null) return false;
    propName = key;
    base = node.expression;
  } else {
    return false;
  }
  if (!/episodes|models/i.test(propName)) return false;
  let cur = base;
  for (let i = 0; i < 6 && cur; i++) {
    if (ts.isIdentifier(cur)) {
      const info = lookup(cur.text, cur);
      if (!info) return false;
      if (info.kind === "namespace") return true;
      if (info.kind === "const") {
        cur = info.init;
        continue;
      }
      return false;
    }
    return false;
  }
  return false;
}

// Production-path detection: path.join/path.resolve args are resolved
// through scope lookup, and the path fails closed whenever its STATIC
// fragments carry both `.pi-astack` and `t0-episodes` — even when part of
// the path is dynamic. tmp-rootedness is decided by resolving the WHOLE
// path call (resolveStatic honors path.resolve's absolute-segment reset and
// normalizes + boundary-checks against os.tmpdir()), so a later absolute
// production segment can never be covered up by an earlier tmp root
// (`path.resolve(tmp, "/home/u/.pi/…")` fails even though tmp came first).
// A path whose root is an explicit tmp fixture (mkdtemp/os.tmpdir) is
// allowed; a standalone static string containing the whole production path
// is also rejected unless it is assert text or normalizes inside the
// tmpdir. Module-property production paths (namespace-import property named
// episodes/models) fail closed too.
function productionPathHits(sf) {
  const { lookup } = collectBindings(sf);
  const hits = [];
  const visit = (node) => {
    if (!node) return;
    node = unwrapExpression(node);
    if (ts.isCallExpression(node)) {
      const pathName = pathCalleeNameOf(node.expression, lookup);
      if (pathName === "path.join" || pathName === "path.resolve" || pathName === "join" || pathName === "resolve") {
        if (!isAssertArgument(node)) {
          const whole = resolveStatic(node, lookup);
          const tmpRooted = whole.kind === "path" ? whole.tmpRooted === true : false;
          const fragments = [];
          let moduleProperty = false;
          for (const arg of node.arguments) {
            const r = resolveStatic(arg, lookup);
            if (r.kind === "string") fragments.push(r.value);
            else if (r.kind === "path") fragments.push(...r.parts);
            else if (r.kind === "array") fragments.push(...elementStrings(r.elements));
            else {
              fragments.push(...staticFragmentsOf(arg, lookup));
              if (isModulePropertyProductionPath(arg, lookup)) moduleProperty = true;
            }
          }
          if (moduleProperty) {
            hits.push("path.join/path.resolve with module-property production data path (episodes/models)");
          } else if (!tmpRooted && fragments.some((s) => s.includes(".pi-astack")) && fragments.some((s) => s.includes("t0-episodes"))) {
            hits.push("path.join/path.resolve with production data path segments");
          }
        }
        return; // nested path calls are handled via resolveStatic; no re-visit
      }
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      if (!isAssertArgument(node)) {
        // Rejection evidence: static fragments (const AND mutable
        // initializers) only decide marker presence — a let/var initializer
        // may name a production segment but must never grant a tmp
        // exemption (`let base='/tmp/'; base='/home/u/.pi/'; …` still
        // rejects).
        const fragments = staticFragmentsOf(node, lookup);
        if (fragments.some((s) => s.includes(".pi-astack")) && fragments.some((s) => s.includes("t0-episodes"))) {
          // tmp exemption/proof: const-only resolution of the WHOLE node —
          // a mutable/unknown binding resolves to unknown and can never
          // exempt; only a fully const-resolved string/path that
          // normalizes inside the tmpdir allows.
          const whole = resolveStatic(node, lookup);
          const tmpRooted = whole.kind === "string" ? isUnderTmpdir(whole.value) : whole.kind === "path" ? whole.tmpRooted === true : false;
          if (!tmpRooted) {
            hits.push("static string containing the production data path");
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return hits;
}

// Required flags for a T0 entry given the visible flag set. t0-replay-select
// additionally needs --models-json unless it is a bare --hard-only listing;
// t0-replay-build additionally needs --selection unless it is an explicit
// fixture-legacy run (--allow-legacy-select) or a deliberate fail-closed
// negative test whose data paths are all explicit tmp fixtures (the build
// gate rejects a missing --selection before any data access).
function requiredFlagsFor(entry, flags, elements, lookup) {
  const def = T0_ENTRIES[entry];
  if (!def) return null;
  const req = [...def.required];
  // t0-eval's corpus flag is mode-dependent: replay mode (--replay-dataset
  // present in the argv) requires THAT flag as the corpus; normal mode keeps
  // requiring --episodes. --output/--models-json stay required in both.
  if (entry === "t0-eval" && flags.has("--replay-dataset")) {
    const i = req.indexOf("--episodes");
    if (i !== -1) req[i] = "--replay-dataset";
  }
  if (entry === "t0-replay-select" && !flags.has("--hard-only")) req.push("--models-json");
  if (entry === "t0-replay-build" && !flags.has("--selection") && !flags.has("--allow-legacy-select") && !allDataPathsTmpRooted(elements, lookup)) {
    req.push("--selection");
  }
  return req;
}

// True when every data-path flag value (--episodes/--meta/--output/
// --models-json) in the argv resolves to an explicit tmp fixture root
// (mkdtemp/os.tmpdir) — the signature of a fixture/negative test rather than
// a real run.
function allDataPathsTmpRooted(elements, lookup) {
  const flat = [];
  const flatten = (els) => {
    for (const el of els) {
      if (el.kind === "array") flatten(el.elements);
      else flat.push(el);
    }
  };
  flatten(elements);
  const dataFlags = ["--episodes", "--meta", "--output", "--models-json"];
  const values = [];
  for (let i = 0; i < flat.length; i++) {
    const el = flat[i];
    if (el.kind === "string" && dataFlags.includes(el.value)) {
      const next = flat[i + 1];
      if (next) values.push(next);
    }
  }
  if (values.length === 0) return false;
  return values.every((v) => {
    if (v.kind === "path") return v.tmpRooted === true;
    if (v.kind === "string") return v.tmpRooted === true || isUnderTmpdir(v.value);
    return false;
  });
}

// Identify the T0 entry a spawn argv targets, from resolved elements or
// from the fail-closed target set of an unresolvable argv. ALL elements are
// scanned for T0 markers (never just the first .mjs), so an intermediate
// runner can never shadow a later T0 target; multiple distinct T0 targets
// (or a defined entry plus an unknown t0-* script) in one argv are
// ambiguous and fail closed.
function entryOf(elements, targets) {
  const { entries, unknownT0 } = t0MarkersOf(elements);
  if (entries.size > 1 || (entries.size === 1 && unknownT0)) return "ambiguous-t0";
  if (entries.size === 1) return [...entries][0];
  if (unknownT0) return "other-t0";
  for (const t of targets) {
    if (T0_ENTRIES[t]) return t;
  }
  return null;
}

// Required-flags + path-value gate over every real T0 spawn argv (resolved,
// package-alias, or fail-closed-unresolved). An argv that cannot be resolved
// ALWAYS fails closed — even when its VISIBLE static tokens already carry
// every required flag name, the path VALUES cannot be proven as explicit tmp
// roots (the visible tokens are not positionally accurate), so the path-value
// gate can never be skipped for an unresolved argv. A shell/package-manager
// wrapper form (shellForm/packageWrapper: exec/execSync command strings,
// shell -c, shell:true, npm/yarn/pnpm run aliases, env/unknown wrappers)
// fails closed UNCONDITIONALLY once it reaches a T0 entry — T0 smoke has no
// business launching the T0 CLI through a wrapper, so only direct
// Node/script argv is gated on the flags that actually reach the CLI; every
// present dangerous path flag's value must be statically provable as an
// explicit tmp root.
function t0SpawnHits(argvs, lookup) {
  const hits = [];
  for (const { elements, unresolvedTargets, visibleTokens, packageEntry, shellForm, packageWrapper, unknownOptions, genericFail } of argvs) {
    // Generic failure records (unresolvable helpers/callsites/argv/spreads
    // with no identifiable target) are output UNCONDITIONALLY — a real call
    // is never silently dropped.
    if (genericFail) {
      hits.push(genericFail);
      continue;
    }
    const targets = unresolvedTargets ?? [];
    const entry = packageEntry ?? entryOf(elements, targets);
    if (!entry) {
      // Closed approved subset: EVERY real child_process call must be a
      // defined T0 entry (direct node/script argv passing the gates below)
      // or an exact node -c/--check syntax check (already exempted in
      // analyzeSpawnArgvs). A real call identifying no T0 entry — including
      // a fully static non-T0 subprocess — is unapproved.
      if (shellForm || packageWrapper) {
        hits.push("unapproved child_process call: shell/package-manager/env wrapper without a defined T0 entry (fail closed)");
      } else {
        hits.push("unapproved child_process call: non-T0 child process argv (only direct node/T0-script argv for a defined T0 entry is approved)");
      }
      continue;
    }
    if (entry === "ambiguous-t0") {
      hits.push(`multiple T0 targets identified in one spawn argv (fail closed: ambiguous)`);
      continue;
    }
    if (entry === "other-t0" || !T0_ENTRIES[entry]) {
      hits.push(`${entry} spawned without defined required flags (fail closed)`);
      continue;
    }
    if (shellForm || packageWrapper) {
      hits.push(`${entry} spawned via shell/package-manager wrapper (fail closed: only direct node argv allowed)`);
      continue;
    }
    if (unknownOptions) {
      hits.push(`${entry} spawn options object is unresolvable (fail closed: shell state cannot be proven as disabled)`);
      continue;
    }
    if (unresolvedTargets) {
      hits.push(`${entry} spawn argv is unresolvable (fail closed: path values cannot be proven as explicit tmp roots)`);
      continue;
    }
    const flags = new Set(elementStrings(elements));
    const required = requiredFlagsFor(entry, flags, elements, lookup);
    const missing = required.filter((f) => !flags.has(f));
    if (missing.length > 0) {
      hits.push(`${entry} spawn argv must explicitly pass ${missing.join(", ")} (production defaults otherwise)`);
    }
    hits.push(...pathValueHits(entry, elements, new Set(required)));
    // Fully-static argv gate: an element that could not be statically
    // resolved (env var, unknown identifier, dynamic expression) makes the
    // argv non-finite/non-static — fail closed even when the required flag
    // NAMES and path values happened to check out.
    if (elements.some((el) => el.kind === "unknown")) {
      hits.push(`${entry} spawn argv contains an unresolvable element (fail closed: argv must be fully static)`);
    }
  }
  return hits;
}

function modelsJsonSpawnHits(argvs) {
  const hits = [];
  for (const { elements, unresolvedTargets, visibleTokens } of argvs) {
    const strings = elementStrings(elements);
    const visible = new Set(visibleTokens ?? []);
    // A models.json reference may be visible only through static fragments
    // (a let/var-bound path.join(home, "models.json") element, or an
    // unresolvable argv whose fragments name it) — rejection-side evidence
    // that must never be silently dropped. The --models-json FLAG itself
    // (resolved strings or visible tokens) also enters the check — never
    // rely on the value's basename, so a tmp fixture named m1.json/m2.json
    // is still duplicate-rejected / value-validated.
    const refsModels = unresolvedTargets?.includes("models.json") || strings.some((s) => s.includes("models.json")) || [...visible].some((s) => s.includes("models.json")) || strings.includes("--models-json") || visible.has("--models-json");
    if (!refsModels) continue;
    const flags = new Set(strings);
    if (!flags.has("--models-json") && !visible.has("--models-json")) {
      hits.push("spawn argv references a models.json target without --models-json in the same argv");
      continue;
    }
    // --models-json is present: EVERY occurrence must have exactly one
    // successor value and every value must be statically provable as an
    // explicit tmp fixture — a mutable/unknown value (e.g. a let-bound
    // path.join(home, "models.json")) could reach the production config.
    // A duplicate flag fails closed outright (CLI last-wins ambiguity: a
    // mixed production/tmp pair must never be approved because one value is
    // tmp); a bare flag (no value) fails closed too. When the flag is only
    // visible through static fragments of an unresolvable argv, no value
    // can be proven — fail closed.
    const flat = [];
    const flatten = (els) => {
      for (const el of els) {
        if (el.kind === "array") flatten(el.elements);
        else flat.push(el);
      }
    };
    flatten(elements);
    let modelsJsonCount = 0;
    let allValuesTmp = true;
    for (let i = 0; i < flat.length; i++) {
      const el = flat[i];
      if (el.kind !== "string" || el.value !== "--models-json") continue;
      modelsJsonCount++;
      const next = flat[i + 1];
      if (!next || !isTmpRootedValue(next)) allValuesTmp = false;
    }
    if (modelsJsonCount === 0) {
      hits.push("spawn argv references a models.json target whose value is not statically provable as an explicit tmp fixture (fail closed)");
    } else if (modelsJsonCount > 1) {
      hits.push("spawn argv contains duplicate --models-json flags (fail closed: ambiguous)");
    } else if (!allValuesTmp) {
      hits.push("spawn argv references a models.json target whose value is not statically provable as an explicit tmp fixture (fail closed)");
    }
  }
  return hits;
}

// Pure src-based detectors (exported for reuse; the script still runs as a
// CLI — the top-level checks below execute on `node scripts/...`). Every
// detector fails closed on TypeScript parse diagnostics: a src that does not
// parse cleanly cannot be trusted to have been analyzed as written.
function parseDiagnosticsOf(sf) {
  return (sf.parseDiagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
}

function parseDiagnosticHits(src) {
  const diags = parseDiagnosticsOf(parseSmokeSource(src));
  return diags.length > 0 ? [`src has TypeScript parse diagnostics (fail closed): ${diags.map((d) => d.messageText).join("; ")}`] : [];
}

// Executable makeJudgeInvoker REFERENCE lock (the name is kept for probe
// compatibility; the semantics are the closed reference lock described
// above — any executable identifier/property/element named makeJudgeInvoker
// or resolving to it is reported, even when never invoked).
export function detectMakeJudgeInvokerCalls(src) {
  const diagHits = parseDiagnosticHits(src);
  if (diagHits.length > 0) return diagHits;
  return makeJudgeInvokerHits(parseSmokeSource(src));
}
export function detectProductionPathExpressions(src) {
  const diagHits = parseDiagnosticHits(src);
  if (diagHits.length > 0) return diagHits;
  return productionPathHits(parseSmokeSource(src));
}
export function detectSelectorSpawnViolations(src) {
  const diagHits = parseDiagnosticHits(src);
  if (diagHits.length > 0) return diagHits;
  const sf = parseSmokeSource(src);
  const { lookup } = collectBindings(sf);
  const argvs = analyzeSpawnArgvs(sf, lookup);
  return t0SpawnHits(argvs.filter(({ elements, unresolvedTargets, packageEntry }) => packageEntry === "t0-replay-select" || unresolvedTargets?.includes("t0-replay-select") || targetScript(elements)?.endsWith("t0-replay-select.mjs")), lookup);
}
export function detectModelsJsonSpawnViolations(src) {
  const diagHits = parseDiagnosticHits(src);
  if (diagHits.length > 0) return diagHits;
  const sf = parseSmokeSource(src);
  const { lookup } = collectBindings(sf);
  const argvs = analyzeSpawnArgvs(sf, lookup);
  return modelsJsonSpawnHits(argvs.filter(({ elements, unresolvedTargets, visibleTokens }) => {
    const strings = elementStrings(elements);
    const visible = new Set(visibleTokens ?? []);
    return unresolvedTargets?.includes("models.json") || strings.some((s) => s.includes("models.json")) || [...visible].some((s) => s.includes("models.json")) || strings.includes("--models-json") || visible.has("--models-json");
  }));
}
export function detectT0SpawnViolations(src) {
  const diagHits = parseDiagnosticHits(src);
  if (diagHits.length > 0) return diagHits;
  const sf = parseSmokeSource(src);
  const { lookup } = collectBindings(sf);
  const surface = childProcessSurfaceHits(sf);
  return [...surface.hits, ...t0SpawnHits(analyzeSpawnArgvs(sf, lookup), lookup)];
}

// CLI mode only: when this module is imported (review probe / detector
// reuse), the exported detectors above are the whole surface — the registry
// checks and process.exit below must not run. The block keeps its original
// indentation to keep the diff minimal.
if (isMain) {
for (const file of t0SmokeFiles) {
  const src = fs.readFileSync(path.join(repoRoot, file), "utf8");
  const sf = parseSmokeSource(src);
  const parseDiags = parseDiagnosticsOf(sf);
  check(`${file} parses cleanly (no TypeScript parse diagnostics)`, parseDiags.length === 0, parseDiags.map((d) => d.messageText).join("; "));
  const { lookup } = collectBindings(sf);
  const argvs = analyzeSpawnArgvs(sf, lookup);
  const invokerHits = makeJudgeInvokerHits(sf);
  const pathHits = productionPathHits(sf);
  check(`${file} stays offline-deterministic (no production data / real invoker / live pipeline)`, invokerHits.length === 0 && pathHits.length === 0, [...invokerHits, ...pathHits].join(", "));
  const surface = childProcessSurfaceHits(sf);
  const spawnHits = [...surface.hits, ...t0SpawnHits(argvs, lookup)];
  check(`${file} T0 spawns pass explicit-temp required flags (no production defaults)`, spawnHits.length === 0, spawnHits.join(", "));
  const modelsHits = modelsJsonSpawnHits(argvs);
  check(`${file} models.json references are temp --models-json fixtures (never the production config)`, modelsHits.length === 0, modelsHits.join(", "));
}
// Pure-detector self-test table: the lock must reject the review
// counterexamples (whitespace tricks, quote tricks, flags in unrelated
// arrays) and allow comment/assert text and legal temp-path spawns.
// Failures count in check() like any other registry check.
const detectorSelfTests = [
  // makeJudgeInvoker (executable-REFERENCE lock): direct / property /
  // element / alias forms, assigned-but-never-called aliases, object
  // properties, destructured reads, arrays, bind results, and same-name
  // shadowing ALL reject — any executable reference is forbidden, not just
  // invocations. Only import-specifier declarations, object-literal
  // property keys, and string/comment text allow.
  { name: "rejects spaced makeJudgeInvoker call", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: "makeJudgeInvoker ()" },
  { name: "rejects property/element makeJudgeInvoker calls", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'C.makeJudgeInvoker({ modelsJsonPath });\nC["makeJudgeInvoker"]({ modelsJsonPath });' },
  { name: "rejects import-alias makeJudgeInvoker call", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'import { makeJudgeInvoker as invoke } from "./t0-eval-common.mjs";\ninvoke({ modelsJsonPath });' },
  { name: "rejects const-alias makeJudgeInvoker call", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'const invoke = makeJudgeInvoker;\ninvoke({ modelsJsonPath });' },
  { name: "rejects 2-hop const alias makeJudgeInvoker call", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'const a = makeJudgeInvoker;\nconst b = a;\nb({ modelsJsonPath });' },
  { name: "rejects destructured import-alias makeJudgeInvoker call", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'const { makeJudgeInvoker: invoke } = await import("./t0-eval-common.mjs");\ninvoke({ modelsJsonPath });' },
  { name: "rejects alias assigned but never called (reference lock)", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'const invoke = makeJudgeInvoker;\n// invoke is never called here' },
  { name: "rejects inner same-name binding shadowing the alias (reference lock)", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'const invoke = makeJudgeInvoker;\nfunction f() { const invoke = other; invoke({}); }' },
  // Object-binding SHORTHAND (`{ makeJudgeInvoker }`): the name doubles as a
  // local declaration AND a read of the source property — it holds an
  // executable reference even when never used afterwards. A marker or
  // unprovable source rejects; a provably different module allows. Named
  // bindings (`{ makeJudgeInvoker: invoke }`) keep the existing
  // propertyName-read behavior; array-binding names are positional, not
  // property reads.
  { name: "rejects marker shorthand destructure never used", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'const { makeJudgeInvoker } = await import("./t0-eval-common.mjs");' },
  { name: "rejects static-namespace marker shorthand destructure", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'import * as C from "./t0-eval-common.mjs";\nconst { makeJudgeInvoker } = C;' },
  { name: "rejects require marker shorthand destructure", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'const { makeJudgeInvoker } = require("./t0-eval-common.mjs");' },
  { name: "rejects unknown-source shorthand destructure (fail closed)", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'const { makeJudgeInvoker } = await import(modulePath);' },
  { name: "rejects marker shorthand destructure with subsequent use", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'const { makeJudgeInvoker } = await import("./t0-eval-common.mjs");\nmakeJudgeInvoker({});' },
  { name: "allows other-module shorthand destructure", detect: detectMakeJudgeInvokerCalls, expect: "allow", src: 'const { makeJudgeInvoker } = await import("./unrelated-module.mjs");' },
  { name: "allows static-namespace other-module shorthand destructure", detect: detectMakeJudgeInvokerCalls, expect: "allow", src: 'import * as C from "./unrelated-module.mjs";\nconst { makeJudgeInvoker } = C;' },
  { name: "allows ordinary non-marker shorthand destructure from the marker module", detect: detectMakeJudgeInvokerCalls, expect: "allow", src: 'const { other } = await import("./t0-eval-common.mjs");' },
  { name: "allows import-specifier declaration naming makeJudgeInvoker never used", detect: detectMakeJudgeInvokerCalls, expect: "allow", src: 'import { makeJudgeInvoker } from "./t0-eval-common.mjs";\n// declared but never used' },
  // production paths: static fragments with both markers reject even when
  // partially dynamic; assert strings and explicit tmp roots allow.
  { name: "rejects single-quoted production path", detect: detectProductionPathExpressions, expect: "reject", src: "path.join(home,'.pi','.pi-astack','t0-episodes')" },
  { name: "rejects production path with const-bound segments", detect: detectProductionPathExpressions, expect: "reject", src: 'const a = ".pi-astack";\nconst b = "t0-episodes";\npath.join(home, a, b);' },
  { name: "rejects production path via static + concat", detect: detectProductionPathExpressions, expect: "reject", src: 'path.join(home, ".pi-astack" + "/" + "t0-episodes");' },
  { name: "rejects production path via template literal", detect: detectProductionPathExpressions, expect: "reject", src: 'const a = ".pi-astack";\nconst b = "t0-episodes";\npath.join(home, `${a}/${b}`);' },
  { name: "rejects partially dynamic production path (static fragments carry both markers)", detect: detectProductionPathExpressions, expect: "reject", src: 'path.join(home, ".pi-astack" + suffix, "t0-episodes");' },
  { name: "rejects static string containing the whole production path", detect: detectProductionPathExpressions, expect: "reject", src: 'const p = "/home/u/.pi/.pi-astack/t0-episodes/episodes.jsonl";' },
  { name: "rejects dotdot-escaped static production path string", detect: detectProductionPathExpressions, expect: "reject", src: 'const p = "/tmp/../home/u/.pi/.pi-astack/t0-episodes/episodes.jsonl";' },
  { name: "rejects /tmpfoo static production path string (boundary, not startsWith)", detect: detectProductionPathExpressions, expect: "reject", src: 'const p = "/tmpfoo/.pi-astack/t0-episodes/episodes.jsonl";' },
  { name: "rejects path.join(os.tmpdir(), .., home, …) escaping the tmpdir", detect: detectProductionPathExpressions, expect: "reject", src: 'path.join(os.tmpdir(), "..", "home", ".pi-astack", "t0-episodes")' },
  { name: "rejects path.join(mkdtemp, .., …) escaping the tmpdir", detect: detectProductionPathExpressions, expect: "reject", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-x-"));\npath.join(tmp, "..", "home", ".pi-astack", "t0-episodes")' },
  { name: "allows tmp fixture path with only t0-episodes", detect: detectProductionPathExpressions, expect: "allow", src: 'path.join(tmp, "t0-episodes")' },
  { name: "allows tmp-rooted path with both markers", detect: detectProductionPathExpressions, expect: "allow", src: 'path.join(os.tmpdir(), ".pi-astack", "t0-episodes")' },
  { name: "allows assert string naming the full production path", detect: detectProductionPathExpressions, expect: "allow", src: 'assert.ok(p === "/home/u/.pi/.pi-astack/t0-episodes/episodes.jsonl");' },
  // spawn required flags: missing flags / unresolved const initializers /
  // helper patterns without callsites / anonymous helpers / execSync
  // commands all fail closed; legal per-entry argv allows.
  { name: "rejects selector argv missing flags (unrelated array carries them)", detect: detectSelectorSpawnViolations, expect: "reject", src: 'const script = path.join(root, "scripts", "t0-replay-select.mjs");\nspawnSync(process.execPath, [script, "--episodes", epPath], {});\nconst unrelated = ["--meta", "--output", "--checkpoint-dir"];' },
  { name: "rejects const argv selector missing --meta", detect: detectSelectorSpawnViolations, expect: "reject", src: 'const script = path.join(root, "scripts", "t0-replay-select.mjs");\nconst argv = [script, "--episodes", epPath];\nspawnSync(process.execPath, argv, {});' },
  { name: "rejects const initializer unresolved selector argv (fail closed)", detect: detectSelectorSpawnViolations, expect: "reject", src: 'const script = path.join(root, "scripts", "t0-replay-select.mjs");\nconst argv = buildArgs(script);\nspawnSync(process.execPath, argv, {});' },
  { name: "rejects unresolved argv with visible required flag names (path values unprovable, fail closed)", detect: detectT0SpawnViolations, expect: "reject", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nconst argv = buildArgs(script, "--episodes", process.env.EP, "--output", "/tmp/o", "--models-json", "/tmp/m");\nspawnSync(process.execPath, argv);' },
  { name: "rejects const initializer unresolved models.json argv (fail closed)", detect: detectModelsJsonSpawnViolations, expect: "reject", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nconst argv = buildArgs(script, path.join(tmp, "models.json"));\nspawnSync(process.execPath, argv, {});' },
  { name: "rejects const argv models.json without --models-json", detect: detectModelsJsonSpawnViolations, expect: "reject", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nconst argv = [script, "--episodes", epPath, path.join(tmp, "models.json")];\nspawnSync(process.execPath, argv, {});' },
  { name: "allows legal const argv selector with --meta", detect: detectSelectorSpawnViolations, expect: "allow", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-sel-"));\nconst script = path.join(root, "scripts", "t0-replay-select.mjs");\nconst argv = [script, "--episodes", path.join(tmp, "ep.jsonl"), "--meta", path.join(tmp, "meta.jsonl"), "--models-json", path.join(tmp, "models.json")];\nspawnSync(process.execPath, argv, {});' },
  { name: "rejects models.json fixture without --models-json in the same argv", detect: detectModelsJsonSpawnViolations, expect: "reject", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", epPath, "--meta", metaPath, path.join(tmp, "models.json")], {});\nconst unrelated = ["--models-json"];' },
  { name: "inner same-name binding does not shadow the real selector script", detect: detectSelectorSpawnViolations, expect: "reject", src: 'const script = path.join(root, "scripts", "t0-replay-select.mjs");\nfunction unrelated() { const script = "not-the-selector"; return script; }\nspawnSync(process.execPath, [script, "--episodes", epPath], {});' },
  { name: "fails closed on unresolvable selector argv with identifiable target", detect: detectSelectorSpawnViolations, expect: "reject", src: 'function spawnSelect(args) {\n  const script = path.join(root, "scripts", "t0-replay-select.mjs");\n  spawnSync(process.execPath, [script, ...args], {});\n}\nspawnSelect(buildArgs());' },
  { name: "fails closed on unresolvable models.json argv with identifiable target", detect: detectModelsJsonSpawnViolations, expect: "reject", src: 'function spawnEval(args) {\n  const script = path.join(root, "scripts", "t0-eval.mjs");\n  const argv = [script, path.join(tmp, "models.json"), ...args];\n  spawnSync(process.execPath, argv, {});\n}\nspawnEval(buildArgs());' },
  { name: "fails closed on helper with no resolvable callsite", detect: detectSelectorSpawnViolations, expect: "reject", src: 'function spawnSelect(args) {\n  const script = path.join(root, "scripts", "t0-replay-select.mjs");\n  spawnSync(process.execPath, [script, ...args], {});\n}' },
  { name: "fails closed on nested anonymous helper with fixed t0 target", detect: detectSelectorSpawnViolations, expect: "reject", src: 'const outer = () => {\n  return () => {\n    const script = path.join(root, "scripts", "t0-replay-select.mjs");\n    spawnSync(process.execPath, [script, ...args], {});\n  };\n};' },
  { name: "rejects execSync selector command missing --meta", detect: detectSelectorSpawnViolations, expect: "reject", src: 'const script = path.join(root, "scripts", "t0-replay-select.mjs");\nexecSync(`node ${script} --episodes ${epPath}`);' },
  { name: "rejects execSync selector command with unresolvable dynamic values (fail closed)", detect: detectSelectorSpawnViolations, expect: "reject", src: 'const script = path.join(root, "scripts", "t0-replay-select.mjs");\nexecSync(`node ${script} --episodes ${epPath} --meta ${metaPath} --models-json ${modelsJson}`);' },
  { name: "rejects default t0-eval spawn with no flags", detect: detectT0SpawnViolations, expect: "reject", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script], {});' },
  { name: "rejects unknown t0 entry spawn (fail closed, no defined required flags)", detect: detectT0SpawnViolations, expect: "reject", src: 'const script = path.join(root, "scripts", "t0-episode-build.mjs");\nspawnSync(process.execPath, [script, "--output", out], {});' },
  { name: "allows legal t0-eval argv", detect: detectT0SpawnViolations, expect: "allow", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-eval-"));\nconst script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", path.join(tmp, "ep.jsonl"), "--output", path.join(tmp, "out"), "--models-json", path.join(tmp, "models.json")], {});' },
  // replay-dataset corpus flag (ADR 0027 C6): a t0-eval replay spawn must
  // pass --replay-dataset (tmp-rooted) as the corpus flag instead of
  // --episodes, with --output/--models-json still required; t0-replay-eval
  // wrapper spawns must pass --dataset (tmp-rooted) instead of --episodes.
  { name: "allows legal t0-eval replay argv with tmp --replay-dataset corpus", detect: detectT0SpawnViolations, expect: "allow", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-rev-"));\nconst script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--replay-dataset", path.join(tmp, "ds"), "--output", path.join(tmp, "out"), "--models-json", path.join(tmp, "models.json")], {});' },
  { name: "allows t0-eval replay argv with --episodes also present (both tmp; corpus flag is --replay-dataset)", detect: detectT0SpawnViolations, expect: "allow", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-rev4-"));\nconst script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--replay-dataset", path.join(tmp, "ds"), "--episodes", path.join(tmp, "ep.jsonl"), "--output", path.join(tmp, "out"), "--models-json", path.join(tmp, "models.json")], {});' },
  { name: "rejects t0-eval replay argv without --models-json (replay corpus does not relax --output/--models-json)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "must explicitly pass --models-json", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-rev2-"));\nconst script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--replay-dataset", path.join(tmp, "ds"), "--output", path.join(tmp, "out")], {});' },
  { name: "rejects t0-eval replay argv with production --replay-dataset value (path-value gate)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "not statically provable as an explicit tmp root", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--replay-dataset", "/home/u/.pi/.pi-astack/t0-replay/ds", "--output", "/tmp/o", "--models-json", "/tmp/m"], {});' },
  { name: "allows legal t0-replay-eval wrapper argv with tmp --dataset corpus", detect: detectT0SpawnViolations, expect: "allow", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-rw-"));\nconst script = path.join(root, "scripts", "t0-replay-eval.mjs");\nspawnSync(process.execPath, [script, "--dataset", path.join(tmp, "ds"), "--output", path.join(tmp, "out"), "--models-json", path.join(tmp, "models.json")], {});' },
  { name: "rejects t0-replay-eval wrapper argv with --episodes corpus (requires --dataset)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "must explicitly pass --dataset", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-rw2-"));\nconst script = path.join(root, "scripts", "t0-replay-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", path.join(tmp, "ep.jsonl"), "--output", path.join(tmp, "out"), "--models-json", path.join(tmp, "models.json")], {});' },
  { name: "rejects t0-replay-eval wrapper argv with production --dataset value (path-value gate)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "not statically provable as an explicit tmp root", src: 'const script = path.join(root, "scripts", "t0-replay-eval.mjs");\nspawnSync(process.execPath, [script, "--dataset", "/home/u/.pi/.pi-astack/t0-replay/ds", "--output", "/tmp/o", "--models-json", "/tmp/m"], {});' },
  { name: "allows legal t0-replay-select argv", detect: detectT0SpawnViolations, expect: "allow", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-sel2-"));\nconst script = path.join(root, "scripts", "t0-replay-select.mjs");\nspawnSync(process.execPath, [script, "--episodes", path.join(tmp, "ep.jsonl"), "--meta", path.join(tmp, "meta.jsonl"), "--models-json", path.join(tmp, "models.json")], {});' },
  { name: "allows legal hard-only t0-replay-select argv without --models-json", detect: detectT0SpawnViolations, expect: "allow", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-hard-"));\nconst script = path.join(root, "scripts", "t0-replay-select.mjs");\nspawnSync(process.execPath, [script, "--hard-only", "--episodes", path.join(tmp, "ep.jsonl"), "--meta", path.join(tmp, "meta.jsonl")], {});' },
  { name: "allows legal t0-replay-build argv", detect: detectT0SpawnViolations, expect: "allow", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-build-"));\nconst script = path.join(root, "scripts", "t0-replay-build.mjs");\nspawnSync(process.execPath, [script, "--selection", path.join(tmp, "selection.json"), "--episodes", path.join(tmp, "ep.jsonl"), "--meta", path.join(tmp, "meta.jsonl"), "--output", path.join(tmp, "out"), "--models-json", path.join(tmp, "models.json")], {});' },
  { name: "allows legal t0-eval-select argv", detect: detectT0SpawnViolations, expect: "allow", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-esel-"));\nconst script = path.join(root, "scripts", "t0-eval-select.mjs");\nspawnSync(process.execPath, [script, "--episodes", path.join(tmp, "ep.jsonl"), "--meta", path.join(tmp, "meta.jsonl")], {});' },
  { name: "allows legal t0-eval-aggregate argv", detect: detectT0SpawnViolations, expect: "allow", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-eagg-"));\nconst script = path.join(root, "scripts", "t0-eval-aggregate.mjs");\nspawnSync(process.execPath, [script, "--episodes", path.join(tmp, "ep.jsonl"), "--meta", path.join(tmp, "meta.jsonl"), "--eval", path.join(tmp, "eval")], {});' },
  { name: "allows legal t0-replay-aggregate argv", detect: detectT0SpawnViolations, expect: "allow", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-ragg-"));\nconst script = path.join(root, "scripts", "t0-replay-aggregate.mjs");\nspawnSync(process.execPath, [script, "--dataset", path.join(tmp, "ds"), "--eval", path.join(tmp, "eval")], {});' },
  { name: "rejects t0-replay-aggregate argv with --episodes corpus (requires --dataset)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "must explicitly pass --dataset", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-ragg2-"));\nconst script = path.join(root, "scripts", "t0-replay-aggregate.mjs");\nspawnSync(process.execPath, [script, "--episodes", path.join(tmp, "ep.jsonl"), "--meta", path.join(tmp, "meta.jsonl"), "--eval", path.join(tmp, "eval")], {});' },
  { name: "allows comment/assert text naming the markers", detect: detectMakeJudgeInvokerCalls, expect: "allow", src: '// before makeJudgeInvoker\nassert.ok(!msg.includes("t0-episodes"));' },
  { name: "allows legal temp selector argv", detect: detectSelectorSpawnViolations, expect: "allow", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-sel3-"));\nconst script = path.join(root, "scripts", "t0-replay-select.mjs");\nspawnSync(process.execPath, [script, "--episodes", path.join(tmp, "ep.jsonl"), "--meta", path.join(tmp, "meta.jsonl"), "--output", path.join(tmp, "out"), "--models-json", path.join(tmp, "models.json")], { env: { PI_OFFLINE: "1" } });' },
  { name: "allows legal eval argv with --models-json", detect: detectModelsJsonSpawnViolations, expect: "allow", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-eval2-"));\nconst evalScript = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [evalScript, "--episodes", path.join(tmp, "ep.jsonl"), "--output", path.join(tmp, "out"), "--models-json", path.join(tmp, "models.json")], {});' },
  { name: "rejects duplicate --models-json flags with non-models.json-named tmp values (flag itself enters the check)", detect: detectModelsJsonSpawnViolations, expect: "reject", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-mjdup-"));\nconst script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", path.join(tmp, "ep.jsonl"), "--output", path.join(tmp, "out"), "--models-json", path.join(tmp, "m1.json"), "--models-json", path.join(tmp, "m2.json")], {});' },
  { name: "allows single --models-json with non-models.json-named tmp value (m.json)", detect: detectModelsJsonSpawnViolations, expect: "allow", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-mj1-"));\nconst script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", path.join(tmp, "ep.jsonl"), "--output", path.join(tmp, "out"), "--models-json", path.join(tmp, "m.json")], {});' },
  // expression visibility / unwrapping: parenthesized callees, argv and
  // commands resolve to their inner expression; unknown expression shapes
  // (concat / conditional / filter / property chains) are conservatively
  // recursed so an identifiable target anywhere in the expression fails
  // closed. Comment-only / uninvoked variables are never spawns.
  { name: "rejects parenthesized makeJudgeInvoker call", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: '(makeJudgeInvoker)({ modelsJsonPath });' },
  { name: "rejects multi-level parenthesized makeJudgeInvoker call", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: '((makeJudgeInvoker))({ modelsJsonPath });' },
  { name: "rejects parenthesized alias makeJudgeInvoker call", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'const invoke = makeJudgeInvoker;\n(invoke)({ modelsJsonPath });' },
  { name: "rejects parenthesized namespace makeJudgeInvoker call", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'import * as C from "./t0-eval-common.mjs";\n(C.makeJudgeInvoker)({ modelsJsonPath });' },
  { name: "rejects parenthesized makeJudgeInvoker assigned but never called", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'const invoke = (makeJudgeInvoker);\n// never called' },
  { name: "rejects parenthesized path.join production path", detect: detectProductionPathExpressions, expect: "reject", src: '(path.join)(home, ".pi-astack", "t0-episodes");' },
  { name: "rejects parenthesized path.resolve production path", detect: detectProductionPathExpressions, expect: "reject", src: '((path.resolve))(tmp, "/home/u/.pi/.pi-astack/t0-episodes/episodes.jsonl");' },
  { name: "rejects concat argv [script].concat([...]) (fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "unresolvable", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script].concat(["--episodes", "/tmp/ep.jsonl", "--output", "/tmp/o", "--models-json", "/tmp/m"]));' },
  { name: "rejects conditional argv flag ? a : b (fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "unresolvable", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, flag ? [script, "--episodes", "/tmp/ep.jsonl", "--output", "/tmp/o", "--models-json", "/tmp/m"] : [script]);' },
  { name: "rejects filter(Boolean) argv (fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "unresolvable", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", "/tmp/ep.jsonl", "--output", "/tmp/o", "--models-json", "/tmp/m"].filter(Boolean));' },
  { name: "rejects parenthesized argv with unresolvable helper (fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "unresolvable", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, (buildArgs(script)));' },
  { name: "rejects parenthesized command with unresolvable argv (fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "unresolvable", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync((script), buildArgs());' },
  { name: "rejects parenthesized command with no argv (fail closed)", detect: detectT0SpawnViolations, expect: "reject", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync((script));' },
  { name: "allows parenthesized command with legal tmp argv", detect: detectT0SpawnViolations, expect: "allow", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-pc-"));\nconst script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync((script), ["--episodes", path.join(tmp, "ep.jsonl"), "--output", path.join(tmp, "o"), "--models-json", path.join(tmp, "m")]);' },
  { name: "allows parenthesized argv with legal tmp values", detect: detectT0SpawnViolations, expect: "allow", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-pa-"));\nconst script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, ([script, "--episodes", path.join(tmp, "ep.jsonl"), "--output", path.join(tmp, "o"), "--models-json", path.join(tmp, "m")]));' },
  { name: "rejects bare spawnSync alias assigned but never called (non-direct)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "non-direct reference", src: 'const launch = spawnSync;\n// launch is never called' },
  // named node:path imports: `import { join } from "node:path"` / aliases /
  // destructured namespace renames are real path calls with the same
  // tmp-rootedness semantics as path.join/path.resolve — but only when the
  // import source is provably node:path (an arbitrary module's join is not).
  { name: "rejects named node:path join production path", detect: detectProductionPathExpressions, expect: "reject", src: 'import { join } from "node:path";\njoin(home, ".pi-astack", "t0-episodes");' },
  { name: "rejects named node:path join alias production path", detect: detectProductionPathExpressions, expect: "reject", src: 'import { join as j } from "node:path";\nconst j2 = j;\nj2(home, ".pi-astack", "t0-episodes");' },
  { name: "rejects named node:path resolve absolute reset", detect: detectProductionPathExpressions, expect: "reject", src: 'import { resolve } from "node:path";\nresolve(tmp, "/home/u/.pi/.pi-astack/t0-episodes/episodes.jsonl");' },
  { name: "rejects destructured node:path namespace join production path", detect: detectProductionPathExpressions, expect: "reject", noCanonicalImports: true, src: 'import * as path from "node:path";\nconst { join: j } = path;\nj(home, ".pi-astack", "t0-episodes");' },
  { name: "allows named node:path join tmp fixture", detect: detectProductionPathExpressions, expect: "allow", src: 'import { join } from "node:path";\njoin(os.tmpdir(), ".pi-astack", "t0-episodes");' },
  { name: "allows destructured node:path namespace join tmp fixture", detect: detectProductionPathExpressions, expect: "allow", noCanonicalImports: true, src: 'import * as path from "node:path";\nconst { join: j } = path;\nj(os.tmpdir(), "t0-episodes");' },
  { name: "allows arbitrary module join (not node:path)", detect: detectProductionPathExpressions, expect: "allow", src: 'import { join } from "lodash";\njoin(home, ".pi-astack", "t0-episodes");' },
  { name: "allows named node:path join tmp flag values", detect: detectT0SpawnViolations, expect: "allow", src: 'import { join } from "node:path";\nconst tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-nj-"));\nconst script = join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", join(tmp, "ep.jsonl"), "--output", join(tmp, "o"), "--models-json", join(tmp, "m")]);' },
  { name: "rejects named node:path join production flag value", detect: detectT0SpawnViolations, expect: "reject", src: 'import { join } from "node:path";\nconst script = join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", join(home, ".pi-astack", "t0-episodes", "ep.jsonl"), "--output", "/tmp/o", "--models-json", "/tmp/m"]);' },
  // named-default imports: `import { default as path } from "node:path"` is
  // the same binding as `import path from "node:path"` — node:path/
  // node:os/node:fs provenance is uniform, and a named `default` import of
  // child_process stays a forbidden surface (never relaxed by the binding
  // normalization).
  { name: "rejects named-default node:path import production path", detect: detectProductionPathExpressions, expect: "reject", noCanonicalImports: true, src: 'import { default as path } from "node:path";\npath.join(home, ".pi-astack", "t0-episodes");' },
  { name: "allows named-default node:path import legal tmp argv", detect: detectT0SpawnViolations, expect: "allow", noCanonicalImports: true, src: 'import fs from "node:fs";\nimport os from "node:os";\nimport { default as path } from "node:path";\nconst tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-ndp-"));\nconst script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", path.join(tmp, "ep.jsonl"), "--output", path.join(tmp, "o"), "--models-json", path.join(tmp, "m")]);' },
  { name: "allows named-default node:os/node:fs tmp fixtures", detect: detectT0SpawnViolations, expect: "allow", noCanonicalImports: true, src: 'import { default as os } from "node:os";\nimport { default as fs } from "node:fs";\nimport path from "node:path";\nconst tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-ndos-"));\nconst script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", path.join(tmp, "ep.jsonl"), "--output", path.join(tmp, "o"), "--models-json", path.join(tmp, "m")]);' },
  { name: "rejects named-default child_process import (forbidden surface)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "forbidden named import of default", src: 'import { default as cp } from "node:child_process";\nconst { spawnSync } = cp;\nspawnSync("echo", ["hi"]);' },
  // direct node syntax checks: `node -c/--check <script>` parses the script
  // WITHOUT executing it, so a statically-exact [checkFlag, script] direct
  // node spawn never runs the T0 pipeline and is allowed. Only -c/--check
  // qualify (the script may be any static string — node treats it as a
  // filename, so `node -c "npm run t0:eval"` can never trigger the package
  // manager — or a const/path.join T0 .mjs path); -e/--eval (executes
  // code), dynamic argv, mixed-in elements after the check flag, and
  // shell:true all fail closed through the normal gates. Known shells still
  // analyze -c as a command string.
  { name: "allows process.execPath -c npm run t0:eval (node -c checks the string as a filename, never executes)", detect: detectT0SpawnViolations, expect: "allow", src: 'spawnSync(process.execPath, ["-c", "npm run t0:eval"]);' },
  { name: "allows process.execPath -c t0 script (node -c is a syntax check, never runs the pipeline)", detect: detectT0SpawnViolations, expect: "allow", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, ["-c", script]);' },
  { name: "allows node -c t0 script (syntax check, never runs the pipeline)", detect: detectT0SpawnViolations, expect: "allow", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync("node", ["-c", script]);' },
  { name: "allows node --check t0 script (syntax check, never runs the pipeline)", detect: detectT0SpawnViolations, expect: "allow", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync("node", ["--check", script]);' },
  { name: "allows process.execPath --check const argv t0 script (syntax check)", detect: detectT0SpawnViolations, expect: "allow", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nconst checkArgv = ["--check", script];\nspawnSync(process.execPath, checkArgv);' },
  { name: "rejects node -e t0 script (-e executes code, missing flags)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "must explicitly pass", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, ["-e", script]);' },
  { name: "rejects node --eval t0 script (executes code, missing flags)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "must explicitly pass", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync("node", ["--eval", script]);' },
  { name: "rejects node -c t0 script with extra argv (not the exact syntax-check shape)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "must explicitly pass", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, ["-c", script, "--episodes", epPath]);' },
  { name: "rejects dynamic argv node -c (fail closed, cannot prove syntax-check shape)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "unresolvable", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nconst checkArgv = getCheckArgv(script);\nspawnSync(process.execPath, checkArgv);' },
  { name: "rejects node -c t0 script with shell:true (wrapper fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, ["-c", script], { shell: true });' },
  { name: "rejects sh -c npm run t0:eval (known shell still wrapper)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'spawnSync("sh", ["-c", "npm run t0:eval"]);' },
  // unknown-prefix tmp semantics: an unknown prefix before the first valid
  // root means the real result is not provably under the tmpdir — a later
  // tmp argument must not bleach it; path.resolve absolute-segment reset is
  // preserved.
  { name: "rejects path.join(env.HOME, os.tmpdir(), …) flag value (unknown prefix not bleached)", detect: detectT0SpawnViolations, expect: "reject", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", path.join(process.env.HOME, os.tmpdir(), "ep.jsonl"), "--output", "/tmp/o", "--models-json", "/tmp/m"]);' },
  { name: "rejects path.join(\"a\", env, os.tmpdir(), …) flag value (non-tmp root before tmp)", detect: detectT0SpawnViolations, expect: "reject", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", path.join("a", process.env.HOME, os.tmpdir(), "ep.jsonl"), "--output", "/tmp/o", "--models-json", "/tmp/m"]);' },
  { name: "rejects path.join(os.tmpdir(), env, …) flag value (unknown suffix after tmp root fails closed)", detect: detectT0SpawnViolations, expect: "reject", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", path.join(os.tmpdir(), process.env.HOME, "ep.jsonl"), "--output", "/tmp/o", "--models-json", "/tmp/m"]);' },
  { name: "rejects path.resolve(env.HOME, os.tmpdir(), …) production path (reset preserved)", detect: detectProductionPathExpressions, expect: "reject", src: 'path.resolve(process.env.HOME, os.tmpdir(), "/home/u/.pi/.pi-astack/t0-episodes/episodes.jsonl");' },
  // mutable bindings: `let`/`var` are never statically reducible — a let
  // tmp reassigned to a production path, or a let module spec reassigned to
  // node:child_process, must fail closed (the binding could hold anything at
  // runtime).
  { name: "rejects let tmp reassigned to production (mutable binding never grants tmp proof)", detect: detectT0SpawnViolations, expect: "reject", src: 'let tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-let-"));\ntmp = "/home/u/.pi/.pi-astack/t0-episodes";\nconst script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", path.join(tmp, "ep.jsonl"), "--output", "/tmp/o", "--models-json", "/tmp/m"]);' },
  { name: "rejects let module spec reassigned to child_process (mutable spec never resolves)", detect: detectT0SpawnViolations, expect: "reject", src: 'let M = "some-lib";\nM = "node:child_process";\nconst { spawnSync } = await import(M);\nspawnSync("echo", ["hi"]);' },
  { name: "rejects var tmp binding (var never grants tmp proof)", detect: detectT0SpawnViolations, expect: "reject", src: 'var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-var-"));\nconst script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", path.join(tmp, "ep.jsonl"), "--output", "/tmp/o", "--models-json", "/tmp/m"]);' },
  // mutable fragments are REJECTION-side forensics: a let/var initializer
  // may name a production path segment (visible fragments) but never grants
  // proof — the production-path detector must fail closed on them.
  { name: "rejects let-bound production path segment (mutable fragment evidence)", detect: detectProductionPathExpressions, expect: "reject", src: "let dir='.pi-astack';\npath.join(home,dir,'t0-episodes')" },
  { name: "rejects let-bound multi production path segments", detect: detectProductionPathExpressions, expect: "reject", src: "let a='.pi-astack', b='t0-episodes';\npath.join(home,a,b)" },
  { name: "rejects var-bound multi production path segments", detect: detectProductionPathExpressions, expect: "reject", src: "var a='.pi-astack', b='t0-episodes';\npath.join(home,a,b)" },
  { name: "rejects function-local var production path segment", detect: detectProductionPathExpressions, expect: "reject", src: "function f() { var seg='.pi-astack';\nreturn path.join(home,seg,'t0-episodes'); }" },
  { name: "rejects mutable template span production path", detect: detectProductionPathExpressions, expect: "reject", src: "let a='.pi-astack';\npath.join(home, `${a}/t0-episodes`)" },
  // mutable string/template tmp exemption closure: a let/var initializer
  // that starts under /tmp must never suppress the production-path reject —
  // rejection evidence (static fragments) decides marker presence, but the
  // tmp exemption comes ONLY from const-only resolution of the whole node.
  { name: "rejects let tmp initializer suppressing production string (mutable never exempts)", detect: detectProductionPathExpressions, expect: "reject", src: "let base='/tmp/';\nbase='/home/u/.pi/';\nfs.readFileSync(`${base}.pi-astack/t0-episodes/x.jsonl`);" },
  { name: "rejects var tmp initializer suppressing production string (var never exempts)", detect: detectProductionPathExpressions, expect: "reject", src: "var base='/tmp/f/';\nfs.readFileSync(`${base}.pi-astack/t0-episodes/x.jsonl`);" },
  { name: "allows const tmp template production-shaped string (const-only proof)", detect: detectProductionPathExpressions, expect: "allow", src: "const base='/tmp/f/';\nfs.readFileSync(`${base}.pi-astack/t0-episodes/x.jsonl`);" },
  { name: "rejects param path production path (fail closed, not provably other module)", detect: detectProductionPathExpressions, expect: "reject", src: "function f(path){ return path.join(home,'.pi-astack','t0-episodes','episodes.jsonl'); }" },
  { name: "rejects mutable path binding production path (fail closed)", detect: detectProductionPathExpressions, expect: "reject", noCanonicalImports: true, src: "let path = { join: (...a) => a.join('/') };\npath.join(home, '.pi-astack', 't0-episodes');" },
  { name: "rejects ambiguous path binding production path (fail closed)", detect: detectProductionPathExpressions, expect: "reject", noCanonicalImports: true, src: "const path = { join: (...a) => a.join('/') };\nconst path = other;\npath.join(home, '.pi-astack', 't0-episodes');" },
  { name: "rejects uncertain const path binding production path (fail closed)", detect: detectProductionPathExpressions, expect: "reject", noCanonicalImports: true, src: "const path = getPath();\npath.join(home, '.pi-astack', 't0-episodes');" },
  // for/switch/catch lexical scoping: a loop-local / case-local / catch
  // binding with the same name must never shadow an outer binding OUTSIDE
  // that construct — the top-level approved import stays the binding for
  // the top-level call.
  { name: "rejects for-init shadow of approved spawnSync (loop-local const must not cover the top-level import)", detect: detectT0SpawnViolations, expect: "reject", src: 'import { spawnSync } from "node:child_process";\nimport { spawnSync as otherSpawn } from "some-lib";\nfor (const spawnSync = otherSpawn; ; ) { break; }\nspawnSync("echo", ["hi"]);' },
  { name: "rejects switch-case shadow of approved spawnSync (case-local const must not cover the top-level import)", detect: detectT0SpawnViolations, expect: "reject", src: 'import { spawnSync } from "node:child_process";\nimport { spawnSync as otherSpawn } from "some-lib";\nswitch (x) { case 1: const spawnSync = otherSpawn; break; }\nspawnSync("echo", ["hi"]);' },
  { name: "rejects for-of shadow of node:path (loop-local path must not silence the production detector)", detect: detectProductionPathExpressions, expect: "reject", noCanonicalImports: true, src: 'import * as path from "node:path";\nfor (const path of files) { void path; }\npath.join(home, ".pi-astack", "t0-episodes");' },
  { name: "rejects catch shadow of node:path (catch param must not silence the production detector)", detect: detectProductionPathExpressions, expect: "reject", noCanonicalImports: true, src: 'import * as path from "node:path";\ntry { work(); } catch (path) { void path; }\npath.join(home, ".pi-astack", "t0-episodes");' },
  { name: "rejects for-init shadow of marker namespace (loop-local C must not cover the top-level t0-eval-common import)", detect: detectMakeJudgeInvokerCalls, expect: "reject", noCanonicalImports: true, src: 'import * as C from "./t0-eval-common.mjs";\nimport * as other from "./other.mjs";\nfor (const C = other; ; ) { break; }\nC.makeJudgeInvoker;' },
  { name: "rejects switch-case shadow of marker namespace (case-local C must not cover the top-level import)", detect: detectMakeJudgeInvokerCalls, expect: "reject", noCanonicalImports: true, src: 'import * as C from "./t0-eval-common.mjs";\nimport * as other from "./other.mjs";\nswitch (x) { case 1: const C = other; break; }\nC.makeJudgeInvoker;' },
  // mkdtemp prefix tightening: the result is tmp-rooted ONLY when the
  // prefix itself is statically provable as an explicit tmp root — a
  // missing/env/unknown/production prefix fails closed; the real fixture
  // shape (static default imports + mkdtemp prefix) stays allowed.
  { name: "rejects mkdtemp with env prefix (result not tmp-rooted)", detect: detectT0SpawnViolations, expect: "reject", src: 'const tmp = fs.mkdtempSync(process.env.TMPDIR);\nconst script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", path.join(tmp, "ep.jsonl"), "--output", "/tmp/o", "--models-json", "/tmp/m"]);' },
  { name: "rejects mkdtemp with production prefix (result not tmp-rooted)", detect: detectT0SpawnViolations, expect: "reject", src: 'const tmp = fs.mkdtempSync("/home/u/.pi/t0-x-");\nconst script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", path.join(tmp, "ep.jsonl"), "--output", "/tmp/o", "--models-json", "/tmp/m"]);' },
  { name: "rejects mkdtemp with no prefix (result not tmp-rooted)", detect: detectT0SpawnViolations, expect: "reject", src: 'const tmp = fs.mkdtempSync();\nconst script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", path.join(tmp, "ep.jsonl"), "--output", "/tmp/o", "--models-json", "/tmp/m"]);' },
  { name: "allows static default imports + mkdtemp prefix (real tmp fixture shape)", detect: detectT0SpawnViolations, expect: "allow", noCanonicalImports: true, src: 'import fs from "node:fs";\nimport os from "node:os";\nimport path from "node:path";\nconst tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-dflt-"));\nconst script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", path.join(tmp, "ep.jsonl"), "--output", path.join(tmp, "o"), "--models-json", path.join(tmp, "m")]);' },
  // child_process call aliases: import aliases, multi-hop const aliases and
  // namespace-import property access must be treated as real spawns.
  { name: "rejects child_process import-alias npm run t0:eval (no flags)", detect: detectT0SpawnViolations, expect: "reject", src: 'import { spawnSync as launch } from "node:child_process";\nlaunch("npm", ["run", "t0:eval"]);' },
  { name: "rejects child_process const multi-hop alias npm run t0:eval", detect: detectT0SpawnViolations, expect: "reject", src: 'const launch = spawnSync;\nconst l2 = launch;\nl2("npm", ["run", "t0:eval"]);' },
  { name: "rejects child_process namespace-import spawn alias", detect: detectT0SpawnViolations, expect: "reject", src: 'import * as cp from "node:child_process";\ncp.spawnSync("npm", ["run", "t0:eval"]);' },
  { name: "rejects child_process namespace-import const alias spawn", detect: detectT0SpawnViolations, expect: "reject", src: 'import * as cp from "node:child_process";\nconst launch = cp.spawnSync;\nlaunch("npm", ["run", "t0:eval"]);' },
  { name: "rejects child_process namespace-import multi-hop const alias spawn", detect: detectT0SpawnViolations, expect: "reject", src: 'import * as cp from "node:child_process";\nconst a = cp.spawnSync;\nconst b = a;\nb("npm", ["run", "t0:eval"]);' },
  { name: "allows arbitrary module namespace spawnSync property (not child_process)", detect: detectT0SpawnViolations, expect: "allow", src: 'import * as C from "./t0-eval-common.mjs";\nconst launch = C.spawnSync;\nlaunch("npm", ["run", "t0:eval"]);' },
  { name: "rejects child_process destructured-import spawn alias", detect: detectT0SpawnViolations, expect: "reject", src: 'const { spawnSync: launch } = await import("node:child_process");\nlaunch("npm", ["run", "t0:eval"]);' },
  { name: "rejects child_process namespace destructured-import spawn alias", detect: detectT0SpawnViolations, expect: "reject", src: 'import * as cp from "node:child_process";\nconst { spawnSync: launch } = cp;\nlaunch("npm", ["run", "t0:eval"]);' },
  { name: "rejects child_process namespace destructured-import multi-hop spawn alias", detect: detectT0SpawnViolations, expect: "reject", src: 'import * as cp from "node:child_process";\nconst { spawnSync: launch } = cp;\nconst l2 = launch;\nl2("npm", ["run", "t0:eval"]);' },
  { name: "rejects child_process namespace destructured-import assigned but never called", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "namespace", src: 'import * as cp from "node:child_process";\nconst { spawnSync: launch } = cp;\n// launch is never called' },
  { name: "allows arbitrary module namespace destructured spawnSync (not child_process)", detect: detectT0SpawnViolations, expect: "allow", src: 'import * as C from "./t0-eval-common.mjs";\nconst { spawnSync: launch } = C;\nlaunch("npm", ["run", "t0:eval"]);' },
  { name: "rejects child_process import-alias execSync command (no flags)", detect: detectT0SpawnViolations, expect: "reject", src: 'import { execSync as run } from "node:child_process";\nrun("npm run t0:eval");' },
  { name: "rejects child_process const multi-hop execSync alias command", detect: detectT0SpawnViolations, expect: "reject", src: 'const run = execSync;\nconst r2 = run;\nr2("npm run t0:eval");' },
  { name: "rejects child_process import-alias exec command (no flags)", detect: detectT0SpawnViolations, expect: "reject", src: 'import { exec as run } from "node:child_process";\nrun("npm run t0:eval");' },
  { name: "rejects child_process import-alias npm run t0:eval with temp flags (wrapper fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'import { spawnSync as launch } from "node:child_process";\nconst tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-alias-"));\nlaunch("npm", ["run", "t0:eval", "--", "--episodes", path.join(tmp, "ep.jsonl"), "--output", path.join(tmp, "out"), "--models-json", path.join(tmp, "models.json")]);' },
  // makeJudgeInvoker module namespace property aliases (multi-hop + element
  // access); assigned-but-never-called stays allowed.
  { name: "rejects namespace-property makeJudgeInvoker alias", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'import * as C from "./t0-eval-common.mjs";\nconst invoke = C.makeJudgeInvoker;\ninvoke({ modelsJsonPath });' },
  { name: "rejects namespace-property makeJudgeInvoker multi-hop alias", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'import * as C from "./t0-eval-common.mjs";\nconst a = C.makeJudgeInvoker;\nconst b = a;\nb({ modelsJsonPath });' },
  { name: "rejects namespace element-access makeJudgeInvoker call", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'import * as C from "./t0-eval-common.mjs";\nC["makeJudgeInvoker"]({ modelsJsonPath });' },
  { name: "rejects namespace-property makeJudgeInvoker assigned but never called", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'import * as C from "./t0-eval-common.mjs";\nconst invoke = C.makeJudgeInvoker;\n// never called' },
  { name: "rejects namespace destructured makeJudgeInvoker alias", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'import * as C from "./t0-eval-common.mjs";\nconst { makeJudgeInvoker: createInvoker } = C;\ncreateInvoker();' },
  { name: "rejects namespace destructured makeJudgeInvoker multi-hop alias", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'import * as C from "./t0-eval-common.mjs";\nconst { makeJudgeInvoker: createInvoker } = C;\nconst b = createInvoker;\nb();' },
  { name: "rejects namespace destructured makeJudgeInvoker assigned but never called", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'import * as C from "./t0-eval-common.mjs";\nconst { makeJudgeInvoker: createInvoker } = C;\n// never called' },
  // npm/yarn/pnpm run package aliases: mapped back to the T0 entry with the
  // flags that actually reach the CLI; unknown t0 entries fail closed.
  { name: "rejects npm run t0:eval with no flags (production defaults)", detect: detectT0SpawnViolations, expect: "reject", src: 'spawnSync("npm", ["run", "t0:eval"]);' },
  { name: "rejects npm run t0:eval with production path value", detect: detectT0SpawnViolations, expect: "reject", src: 'spawnSync("npm", ["run", "t0:eval", "--", "--episodes", "/home/u/.pi/.pi-astack/t0-episodes/episodes.jsonl", "--output", "/tmp/out", "--models-json", "/tmp/mj"]);' },
  { name: "rejects npm run t0:eval with unknown (env) path value", detect: detectT0SpawnViolations, expect: "reject", src: 'spawnSync("npm", ["run", "t0:eval", "--", "--episodes", process.env.EPISODES, "--output", "/tmp/out", "--models-json", "/tmp/mj"]);' },
  { name: "rejects npm run t0:eval with temp flags after -- (wrapper fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-npm-"));\nspawnSync("npm", ["run", "t0:eval", "--", "--episodes", path.join(tmp, "ep.jsonl"), "--output", path.join(tmp, "out"), "--models-json", path.join(tmp, "models.json")]);' },
  { name: "rejects yarn run t0:eval with temp flags (wrapper fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-yarn-"));\nspawnSync("yarn", ["run", "t0:eval", "--episodes", path.join(tmp, "ep.jsonl"), "--output", path.join(tmp, "out"), "--models-json", path.join(tmp, "models.json")]);' },
  { name: "rejects pnpm t0:eval with temp flags (wrapper fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-pnpm-"));\nspawnSync("pnpm", ["t0:eval", "--episodes", path.join(tmp, "ep.jsonl"), "--output", path.join(tmp, "out"), "--models-json", path.join(tmp, "models.json")]);' },
  { name: "rejects npm run t0:episode-build (unknown t0 entry, fail closed)", detect: detectT0SpawnViolations, expect: "reject", src: 'spawnSync("npm", ["run", "t0:episode-build", "--", "--output", "/tmp/out"]);' },
  { name: "rejects execSync npm run t0:eval with no flags", detect: detectT0SpawnViolations, expect: "reject", src: 'execSync("npm run t0:eval");' },
  { name: "rejects execSync npm run t0:eval with tmp-rooted dynamic values (wrapper fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-npm2-"));\nexecSync(`npm run t0:eval -- --episodes ${tmp}/ep.jsonl --output ${tmp}/out --models-json ${tmp}/models.json`);' },
  { name: "rejects execSync npm run t0:eval with env dynamic value (fail closed)", detect: detectT0SpawnViolations, expect: "reject", src: 'execSync(`npm run t0:eval -- --episodes ${process.env.EP} --output /tmp/o --models-json /tmp/m`);' },
  { name: "rejects execSync npm run t0:eval with tmp-rooted value plus .. escape (fail closed)", detect: detectT0SpawnViolations, expect: "reject", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-npm3-"));\nexecSync(`npm run t0:eval -- --episodes ${tmp}/../home/u/.pi/.pi-astack/t0-episodes/episodes.jsonl --output /tmp/o --models-json /tmp/m`);' },
  // shell -c / shell:true / no-argv command strings: the nested command is
  // mapped to the package alias / T0 entry and gated on required flags +
  // tmp path values; dynamic template/env paths fail closed.
  { name: "rejects sh -c npm run t0:eval (no flags)", detect: detectT0SpawnViolations, expect: "reject", src: 'spawnSync("sh", ["-c", "npm run t0:eval"]);' },
  { name: "rejects bash -c npm run t0:eval (no flags)", detect: detectT0SpawnViolations, expect: "reject", src: 'spawnSync("bash", ["-c", "npm run t0:eval"]);' },
  { name: "rejects dash -lc npm run t0:eval (no flags)", detect: detectT0SpawnViolations, expect: "reject", src: 'spawnSync("dash", ["-lc", "npm run t0:eval"]);' },
  { name: "rejects zsh -c node t0-eval.mjs (no flags)", detect: detectT0SpawnViolations, expect: "reject", src: 'spawnSync("zsh", ["-c", "node scripts/t0-eval.mjs"]);' },
  { name: "rejects spawn sh -c npm run t0:eval (no flags)", detect: detectT0SpawnViolations, expect: "reject", src: 'spawn("sh", ["-c", "npm run t0:eval"]);' },
  { name: "rejects shell:true npm run t0:eval (no flags)", detect: detectT0SpawnViolations, expect: "reject", src: 'spawnSync("npm run t0:eval", { shell: true });' },
  { name: "rejects shell:true node t0-eval.mjs (no flags)", detect: detectT0SpawnViolations, expect: "reject", src: 'spawnSync("node scripts/t0-eval.mjs", { shell: true });' },
  { name: "rejects spawn shell:true npm run t0:eval (no flags)", detect: detectT0SpawnViolations, expect: "reject", src: 'spawn("npm run t0:eval", { shell: true });' },
  { name: "rejects no-argv npm run t0:eval (fail closed)", detect: detectT0SpawnViolations, expect: "reject", src: 'spawnSync("npm run t0:eval");' },
  { name: "rejects no-argv t0 script path (fail closed)", detect: detectT0SpawnViolations, expect: "reject", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(script);' },
  { name: "rejects sh -c with env dynamic value (fail closed)", detect: detectT0SpawnViolations, expect: "reject", src: 'spawnSync("sh", ["-c", `node scripts/t0-eval.mjs --episodes ${process.env.EP} --output /tmp/o --models-json /tmp/m`]);' },
  { name: "rejects shell:true with env dynamic value (fail closed)", detect: detectT0SpawnViolations, expect: "reject", src: 'spawnSync(`node scripts/t0-eval.mjs --episodes ${process.env.EP} --output /tmp/o --models-json /tmp/m`, { shell: true });' },
  { name: "rejects sh -c with explicit tmp flags (wrapper fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'spawnSync("sh", ["-c", "node scripts/t0-eval.mjs --episodes /tmp/ep.jsonl --output /tmp/out --models-json /tmp/mj"]);' },
  { name: "rejects sh -c with tmp-rooted template flags (wrapper fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-shc-"));\nspawnSync("sh", ["-c", `node scripts/t0-eval.mjs --episodes ${tmp}/ep.jsonl --output ${tmp}/out --models-json ${tmp}/models.json`]);' },
  { name: "rejects shell:true with explicit tmp flags (wrapper fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'spawnSync("node scripts/t0-eval.mjs --episodes /tmp/ep.jsonl --output /tmp/out --models-json /tmp/mj", { shell: true });' },
  { name: "rejects shell:true npm run t0:eval with tmp flags after -- (wrapper fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'spawnSync("npm run t0:eval -- --episodes /tmp/ep.jsonl --output /tmp/out --models-json /tmp/mj", { shell: true });' },
  // third-argument shell:true / env / absolute package-manager path / shell
  // flags before -c / unknown wrappers: the same wrapper forms must fail
  // closed regardless of where the options object sits or how the wrapper is
  // spelled, and the violation category must be the wrapper itself (not just
  // missing flags).
  { name: "rejects spawnSync third-arg shell:true npm run t0:eval (no flags)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'spawnSync("npm run t0:eval", [], { shell: true });' },
  { name: "rejects spawn third-arg shell:true npm run t0:eval (no flags)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'spawn("npm run t0:eval", [], { shell: true });' },
  { name: "rejects spawnSync third-arg shell:true node t0-eval.mjs (no flags)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'spawnSync("node scripts/t0-eval.mjs", [], { shell: true });' },
  { name: "rejects spawnSync third-arg shell:true via options variable", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'const opts = { shell: true };\nspawnSync("npm run t0:eval", [], opts);' },
  { name: "rejects spawnSync third-arg shell:true with direct argv (fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync("node", [script, "--episodes", "/tmp/ep.jsonl", "--output", "/tmp/out", "--models-json", "/tmp/mj"], { shell: true });' },
  { name: "rejects env npm run t0:eval (no flags)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'spawnSync("env", ["npm", "run", "t0:eval"]);' },
  { name: "rejects env npm run t0:eval with temp flags (wrapper fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'spawnSync("env", ["npm", "run", "t0:eval", "--", "--episodes", "/tmp/ep.jsonl", "--output", "/tmp/out", "--models-json", "/tmp/mj"]);' },
  { name: "rejects env sh -c npm run t0:eval (no flags)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'spawnSync("env", ["sh", "-c", "npm run t0:eval"]);' },
  { name: "rejects absolute /usr/bin/npm run t0:eval (no flags)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'spawnSync("/usr/bin/npm", ["run", "t0:eval"]);' },
  { name: "rejects absolute /usr/bin/npm run t0:eval with temp flags (wrapper fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'spawnSync("/usr/bin/npm", ["run", "t0:eval", "--", "--episodes", "/tmp/ep.jsonl", "--output", "/tmp/out", "--models-json", "/tmp/mj"]);' },
  { name: "rejects bash --noprofile -c npm run t0:eval (no flags)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'spawnSync("bash", ["--noprofile", "-c", "npm run t0:eval"]);' },
  { name: "rejects bash --noprofile -c node t0-eval.mjs (no flags)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'spawnSync("bash", ["--noprofile", "-c", "node scripts/t0-eval.mjs"]);' },
  { name: "rejects unknown wrapper with t0 alias in argv (fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "unresolvable", src: 'spawnSync(wrapper, ["run", "t0:eval"]);' },
  { name: "rejects unknown wrapper with shell -c argv (fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'spawnSync(wrapper, ["-c", "npm run t0:eval"]);' },
  // execFile-style spawns: the command argument is a t0-*.mjs path and the
  // argv is a flags array — the command must stay in target recognition.
  { name: "rejects execFile-style t0-eval path with missing flags", detect: detectT0SpawnViolations, expect: "reject", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(script, ["--episodes", "/tmp/ep.jsonl"]);' },
  { name: "rejects execFile-style t0-eval path with production value", detect: detectT0SpawnViolations, expect: "reject", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(script, ["--episodes", "/home/u/.pi/.pi-astack/t0-episodes/episodes.jsonl", "--output", "/tmp/out", "--models-json", "/tmp/mj"]);' },
  { name: "allows execFile-style t0-eval path with legal tmp flags", detect: detectT0SpawnViolations, expect: "allow", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-ef-"));\nconst script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(script, ["--episodes", path.join(tmp, "ep.jsonl"), "--output", path.join(tmp, "out"), "--models-json", path.join(tmp, "models.json")]);' },
  { name: "rejects execFile-style t0-eval path with unresolvable argv (fail closed)", detect: detectT0SpawnViolations, expect: "reject", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(script, buildArgs());' },
  { name: "rejects execFile-style t0-eval path with options object (no flags)", detect: detectT0SpawnViolations, expect: "reject", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(script, { cwd: tmp });' },
  // required path flags: the VALUE must be statically provable as an explicit
  // tmp root — unknown/env/production values fail closed even when the flag
  // NAME is present.
  { name: "rejects t0-eval argv with production --episodes value", detect: detectT0SpawnViolations, expect: "reject", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", "/home/u/.pi/.pi-astack/t0-episodes/episodes.jsonl", "--output", "/tmp/out", "--models-json", "/tmp/mj"], {});' },
  { name: "rejects t0-eval argv with unknown --episodes value", detect: detectT0SpawnViolations, expect: "reject", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", epPath, "--output", "/tmp/out", "--models-json", "/tmp/mj"], {});' },
  { name: "rejects t0-eval argv with bare --episodes (next token is another flag)", detect: detectT0SpawnViolations, expect: "reject", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", "--output", "/tmp/o", "--models-json", "/tmp/m"], {});' },
  { name: "rejects t0-eval argv with trailing bare --episodes (no value at all)", detect: detectT0SpawnViolations, expect: "reject", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes"], {});' },
  { name: "rejects t0-eval argv with /tmpfoo path value (boundary, not startsWith)", detect: detectT0SpawnViolations, expect: "reject", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", "/tmpfoo/ep.jsonl", "--output", "/tmp/out", "--models-json", "/tmp/mj"], {});' },
  { name: "rejects t0-eval argv with dotdot-escaped tmp path value", detect: detectT0SpawnViolations, expect: "reject", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", "/tmp/../home/u/.pi/.pi-astack/t0-episodes/episodes.jsonl", "--output", "/tmp/out", "--models-json", "/tmp/mj"], {});' },
  { name: "rejects t0-replay-select argv with production --checkpoint-dir value", detect: detectT0SpawnViolations, expect: "reject", src: 'const script = path.join(root, "scripts", "t0-replay-select.mjs");\nspawnSync(process.execPath, [script, "--episodes", "/tmp/ep.jsonl", "--meta", "/tmp/meta.jsonl", "--models-json", "/tmp/mj", "--checkpoint-dir", "/home/u/.pi/.pi-astack/t0-replay-fair/checkpoints-fair"], {});' },
  { name: "rejects t0-replay-build argv with production --selection value", detect: detectT0SpawnViolations, expect: "reject", src: 'const script = path.join(root, "scripts", "t0-replay-build.mjs");\nspawnSync(process.execPath, [script, "--selection", "/home/u/.pi/.pi-astack/t0-replay-fair/selection.json", "--episodes", "/tmp/ep.jsonl", "--meta", "/tmp/meta.jsonl", "--output", "/tmp/out", "--models-json", "/tmp/mj"], {});' },
  { name: "allows t0-eval argv with tmp-rooted values via helper call", detect: detectT0SpawnViolations, expect: "allow", src: 'function writeMinimalModelsJson(dir) { return path.join(dir, "models.json"); }\nconst tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-helper-"));\nconst script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", path.join(tmp, "ep.jsonl"), "--output", path.join(tmp, "out"), "--models-json", writeMinimalModelsJson(tmp)], {});' },
  { name: "allows t0-replay-select argv with destructured helper fixture paths", detect: detectSelectorSpawnViolations, expect: "allow", src: 'function writeCliFixture(dir) { return { episodesPath: path.join(dir, "episodes.jsonl"), metaPath: path.join(dir, "episodes.meta.jsonl") }; }\nconst tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-dest-"));\nconst { episodesPath, metaPath } = writeCliFixture(tmp);\nconst script = path.join(root, "scripts", "t0-replay-select.mjs");\nspawnSync(process.execPath, [script, "--episodes", episodesPath, "--meta", metaPath, "--models-json", path.join(tmp, "models.json")], {});' },
  // path.resolve absolute-segment reset: a later absolute production segment
  // must not be whitelisted by an earlier tmp root; a later absolute tmp
  // segment stays legal.
  { name: "rejects path.resolve(tmp, absoluteProductionPath)", detect: detectProductionPathExpressions, expect: "reject", src: 'path.resolve(tmp, "/home/u/.pi/.pi-astack/t0-episodes/episodes.jsonl")' },
  { name: "rejects path.resolve(tmp, absoluteProductionPath) as flag value", detect: detectT0SpawnViolations, expect: "reject", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nconst tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-res-"));\nspawnSync(process.execPath, [script, "--episodes", path.resolve(tmp, "/home/u/.pi/.pi-astack/t0-episodes/episodes.jsonl"), "--output", "/tmp/out", "--models-json", "/tmp/mj"], {});' },
  { name: "allows path.resolve(tmp, absoluteTmpPath)", detect: detectProductionPathExpressions, expect: "allow", src: 'path.resolve(tmp, "/tmp/t0-fixture/episodes.jsonl")' },
  { name: "rejects module-property production path (namespace import)", detect: detectProductionPathExpressions, expect: "reject", src: 'import * as C from "./t0-eval-common.mjs";\npath.join(C.DEFAULT_EPISODES_PATH, "episodes.jsonl");' },
  // TypeScript parse diagnostics fail closed.
  { name: "rejects src with TypeScript parse diagnostics", detect: detectT0SpawnViolations, expect: "reject", src: "const x = ;" },
  // helper data flow: the callsite argv is expanded through the helper's
  // param and gated like a direct spawn (function declarations and const
  // arrows, multiple callsites; unresolvable callsite args fail closed).
  { name: "rejects helper fn-decl callsite argv with env path value", detect: detectT0SpawnViolations, expect: "reject", src: 'const script = path.join(root,"scripts","t0-eval.mjs"); function run(argv){spawnSync(process.execPath,argv)}; run([script,"--episodes",process.env.EP,"--output","/tmp/o","--models-json","/tmp/m"])' },
  { name: "allows helper fn-decl callsite argv with legal temp values", detect: detectT0SpawnViolations, expect: "allow", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(),"t0-hf-")); const script = path.join(root,"scripts","t0-eval.mjs"); function run(argv){spawnSync(process.execPath,argv)}; run([script,"--episodes",path.join(tmp,"ep.jsonl"),"--output",path.join(tmp,"o"),"--models-json",path.join(tmp,"m")])' },
  { name: "rejects helper const-arrow callsite argv with env path value", detect: detectT0SpawnViolations, expect: "reject", src: 'const script = path.join(root,"scripts","t0-eval.mjs"); const run = (argv) => { spawnSync(process.execPath, argv); }; run([script,"--episodes",process.env.EP,"--output","/tmp/o","--models-json","/tmp/m"])' },
  { name: "rejects helper multi-callsite with one bad callsite", detect: detectT0SpawnViolations, expect: "reject", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(),"t0-hm2-")); const script = path.join(root,"scripts","t0-eval.mjs"); function run(argv){spawnSync(process.execPath,argv)}; run([script,"--episodes",path.join(tmp,"ep.jsonl"),"--output",path.join(tmp,"o"),"--models-json",path.join(tmp,"m")]); run([script,"--episodes",process.env.EP,"--output","/tmp/o","--models-json","/tmp/m"])' },
  { name: "allows helper multi-callsite with all legal callsites", detect: detectT0SpawnViolations, expect: "allow", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(),"t0-hm-")); const script = path.join(root,"scripts","t0-eval.mjs"); function run(argv){spawnSync(process.execPath,argv)}; run([script,"--episodes",path.join(tmp,"ep.jsonl"),"--output",path.join(tmp,"o"),"--models-json",path.join(tmp,"m")]); run([script,"--episodes",path.join(tmp,"ep2.jsonl"),"--output",path.join(tmp,"o2"),"--models-json",path.join(tmp,"m2")])' },
  { name: "fails closed on helper callsite with unresolvable argv (target identifiable)", detect: detectT0SpawnViolations, expect: "reject", src: 'const script = path.join(root,"scripts","t0-eval.mjs"); function run(argv){spawnSync(process.execPath,argv)}; run(buildArgs(script))' },
  // dynamic command wrapper: only explicitly allowed direct commands
  // (process.execPath / static node executable / static t0-*.mjs
  // execFile-style) may enter the required-flags gate; an unknown command
  // must fail closed even when the argv carries a direct script path.
  { name: "rejects dynamic command wrapper with direct script argv (complete tmp args)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "unresolvable", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(),"t0-dw-")); const script = path.join(root,"scripts","t0-eval.mjs"); spawnSync(wrapper,[script,"--episodes",path.join(tmp,"ep.jsonl"),"--output",path.join(tmp,"o"),"--models-json",path.join(tmp,"m")])' },
  { name: "rejects dynamic command wrapper with direct script argv (env value)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "unresolvable", src: 'const script = path.join(root,"scripts","t0-eval.mjs"); spawnSync(wrapper,[script,"--episodes",process.env.EP,"--output","/tmp/o","--models-json","/tmp/m"])' },
  { name: "rejects helper-pattern dynamic wrapper with direct script argv", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "unresolvable", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(),"t0-hw-")); const script = path.join(root,"scripts","t0-eval.mjs"); function go(args) { spawnSync(wrapper, [script, ...args]); } go(["--episodes", path.join(tmp,"ep.jsonl"), "--output", path.join(tmp,"o"), "--models-json", path.join(tmp,"m")])' },
  { name: "rejects timeout wrapper with node script argv (fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "unresolvable", src: 'const script = path.join(root,"scripts","t0-eval.mjs"); spawnSync("timeout", ["60", "node", script, "--episodes", "/tmp/ep.jsonl", "--output", "/tmp/o", "--models-json", "/tmp/m"]);' },
  // shell options: shorthand, object spread (multi-level const), third-arg
  // variable, unknown values fail closed; {shell:false} / {shell:""} and
  // provably-disabled spreads never false-positive.
  { name: "rejects shell shorthand { shell } (unknown value, fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "unresolvable", src: 'const script = path.join(root,"scripts","t0-eval.mjs"); spawnSync("node",[script,"--episodes","/tmp/ep.jsonl","--output","/tmp/o","--models-json","/tmp/m"],{ shell })' },
  { name: "rejects shell shorthand { shell } with const true value", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'const script = path.join(root,"scripts","t0-eval.mjs"); const shell = true; spawnSync("node",[script,"--episodes","/tmp/ep.jsonl","--output","/tmp/o","--models-json","/tmp/m"],{ shell })' },
  { name: "allows shell shorthand { shell } with const false value", detect: detectT0SpawnViolations, expect: "allow", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(),"t0-shf-")); const script = path.join(root,"scripts","t0-eval.mjs"); const shell = false; spawnSync(process.execPath,[script,"--episodes",path.join(tmp,"ep.jsonl"),"--output",path.join(tmp,"o"),"--models-json",path.join(tmp,"m")],{ shell })' },
  { name: "rejects shell shorthand { shell } with unknown const value", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "unresolvable", src: 'const script = path.join(root,"scripts","t0-eval.mjs"); const shell = process.env.SHELL; spawnSync("node",[script,"--episodes","/tmp/ep.jsonl","--output","/tmp/o","--models-json","/tmp/m"],{ shell })' },
  { name: "rejects object spread { ...base } with shell:true", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'const base = { shell: true }; spawnSync("npm run t0:eval", [], { ...base });' },
  { name: "rejects multi-level const object spread with shell:true", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'const a = { shell: true }; const b = { ...a }; spawnSync("npm run t0:eval", [], b);' },
  { name: "rejects unknown shell value (fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "unresolvable", src: 'spawnSync("npm run t0:eval", [], { shell: process.env.SHELL });' },
  { name: "allows {shell:false} (FalseKeyword, not a string)", detect: detectT0SpawnViolations, expect: "allow", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(),"t0-sf-")); const script = path.join(root,"scripts","t0-eval.mjs"); spawnSync(process.execPath,[script,"--episodes",path.join(tmp,"ep.jsonl"),"--output",path.join(tmp,"o"),"--models-json",path.join(tmp,"m")],{ shell: false });' },
  { name: "allows {shell:\"\"}", detect: detectT0SpawnViolations, expect: "allow", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(),"t0-se-")); const script = path.join(root,"scripts","t0-eval.mjs"); spawnSync(process.execPath,[script,"--episodes",path.join(tmp,"ep.jsonl"),"--output",path.join(tmp,"o"),"--models-json",path.join(tmp,"m")],{ shell: "" });' },
  { name: "rejects object spread of unknown source (fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "unresolvable", src: 'spawnSync("npm run t0:eval", [], { ...opts });' },
  { name: "allows object spread of static options without shell (absent)", detect: detectT0SpawnViolations, expect: "allow", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(),"t0-abs-")); const base = { cwd: tmp }; const script = path.join(root,"scripts","t0-eval.mjs"); spawnSync(process.execPath,[script,"--episodes",path.join(tmp,"ep.jsonl"),"--output",path.join(tmp,"o"),"--models-json",path.join(tmp,"m")],{ ...base });' },
  { name: "allows object spread with provably-disabled shell:false", detect: detectT0SpawnViolations, expect: "allow", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(),"t0-sd-")); const base = { shell: false }; const script = path.join(root,"scripts","t0-eval.mjs"); spawnSync(process.execPath,[script,"--episodes",path.join(tmp,"ep.jsonl"),"--output",path.join(tmp,"o"),"--models-json",path.join(tmp,"m")],{ ...base });' },
  // shell final-value semantics (JS left-to-right override): a later shell
  // property wins over an earlier one, and an explicit property wins over a
  // spread. `{shell:false,shell:true}` is enabled; `{shell:true,shell:false}`
  // and `{...base,shell:false}` (base={shell:true}) are disabled;
  // `{shell:false,...base}` (base={shell:true}) is enabled again.
  { name: "rejects duplicate shell last-wins {shell:false,shell:true}", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'spawnSync("npm run t0:eval", [], { shell: false, shell: true });' },
  { name: "rejects duplicate shell last-wins {shell:false,shell:true} on direct argv", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'const script = path.join(root,"scripts","t0-eval.mjs"); spawnSync(process.execPath,[script,"--episodes","/tmp/ep.jsonl","--output","/tmp/o","--models-json","/tmp/m"],{ shell: false, shell: true });' },
  { name: "allows duplicate shell last-wins {shell:true,shell:false}", detect: detectT0SpawnViolations, expect: "allow", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(),"t0-ds-")); const script = path.join(root,"scripts","t0-eval.mjs"); spawnSync(process.execPath,[script,"--episodes",path.join(tmp,"ep.jsonl"),"--output",path.join(tmp,"o"),"--models-json",path.join(tmp,"m")],{ shell: true, shell: false });' },
  { name: "allows spread-then-override { ...base, shell:false } (base shell:true)", detect: detectT0SpawnViolations, expect: "allow", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(),"t0-so-")); const base = { shell: true }; const script = path.join(root,"scripts","t0-eval.mjs"); spawnSync(process.execPath,[script,"--episodes",path.join(tmp,"ep.jsonl"),"--output",path.join(tmp,"o"),"--models-json",path.join(tmp,"m")],{ ...base, shell: false });' },
  { name: "rejects override-then-spread { shell:false, ...base } (base shell:true)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'const base = { shell: true }; const script = path.join(root,"scripts","t0-eval.mjs"); spawnSync(process.execPath,[script,"--episodes","/tmp/ep.jsonl","--output","/tmp/o","--models-json","/tmp/m"],{ shell: false, ...base });' },
  { name: "rejects multi-level const spread override { shell:false, ...b } (b={...a}, a shell:true)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'const a = { shell: true }; const b = { ...a }; const script = path.join(root,"scripts","t0-eval.mjs"); spawnSync(process.execPath,[script,"--episodes","/tmp/ep.jsonl","--output","/tmp/o","--models-json","/tmp/m"],{ shell: false, ...b });' },
  { name: "rejects static computed [\"shell\"]:true", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'spawnSync("npm run t0:eval", [], { ["shell"]: true });' },
  { name: "allows static computed [\"shell\"]:false", detect: detectT0SpawnViolations, expect: "allow", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(),"t0-cs-")); const script = path.join(root,"scripts","t0-eval.mjs"); spawnSync(process.execPath,[script,"--episodes",path.join(tmp,"ep.jsonl"),"--output",path.join(tmp,"o"),"--models-json",path.join(tmp,"m")],{ ["shell"]: false });' },
  // dynamic options: an unresolvable options expression (makeOpts() call /
  // unknown identifier / unresolvable spread) fails closed whenever the
  // spawn reaches an identifiable T0 target — the shell state cannot be
  // proven disabled.
  { name: "rejects makeOpts() options on direct t0 argv (fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "unresolvable", src: 'const script = path.join(root,"scripts","t0-eval.mjs"); spawnSync(process.execPath,[script,"--episodes","/tmp/ep.jsonl","--output","/tmp/o","--models-json","/tmp/m"],makeOpts());' },
  { name: "rejects unknown options identifier on direct t0 argv (fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "unresolvable", src: 'const script = path.join(root,"scripts","t0-eval.mjs"); spawnSync(process.execPath,[script,"--episodes","/tmp/ep.jsonl","--output","/tmp/o","--models-json","/tmp/m"],opts);' },
  { name: "rejects unresolvable spread { ...makeOpts() } on direct t0 argv", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "unresolvable", src: 'const script = path.join(root,"scripts","t0-eval.mjs"); spawnSync(process.execPath,[script,"--episodes","/tmp/ep.jsonl","--output","/tmp/o","--models-json","/tmp/m"],{ ...makeOpts() });' },
  { name: "allows static plain options without shell (encoding/timeout/env absent)", detect: detectT0SpawnViolations, expect: "allow", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(),"t0-plain-")); const script = path.join(root,"scripts","t0-eval.mjs"); spawnSync(process.execPath,[script,"--episodes",path.join(tmp,"ep.jsonl"),"--output",path.join(tmp,"o"),"--models-json",path.join(tmp,"m")],{ encoding: "utf8", timeout: 30000, env: { PI_OFFLINE: "1" } });' },
  // path traversal: `..`/`.` segments embedded in a single string arg
  // (including Windows `..\\..` separators) must fail closed over an
  // abstract mkdtemp root; plain names like `foo..bar` stay legal. Both the
  // production-path detector and the T0 path-flag gate are covered.
  { name: "rejects path.join(mkdtemp, ../../home/.../.pi-astack/t0-episodes)", detect: detectProductionPathExpressions, expect: "reject", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(),"t0-pt-")); path.join(tmp,"../../home/u/.pi/.pi-astack/t0-episodes/episodes.jsonl")' },
  { name: "rejects path.join(mkdtemp, ..\\.. windows separators)", detect: detectProductionPathExpressions, expect: "reject", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(),"t0-pt2-")); path.join(tmp,"..\\..\\home\\u\\.pi\\.pi-astack\\t0-episodes\\episodes.jsonl")' },
  { name: "allows path.join(mkdtemp, foo..bar, t0-episodes)", detect: detectProductionPathExpressions, expect: "allow", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(),"t0-pt3-")); path.join(tmp,"foo..bar","t0-episodes")' },
  { name: "rejects t0 flag value path.join(mkdtemp, ../../home/.../.pi-astack/t0-episodes)", detect: detectT0SpawnViolations, expect: "reject", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(),"t0-pt4-")); const script = path.join(root,"scripts","t0-eval.mjs"); spawnSync(process.execPath,[script,"--episodes",path.join(tmp,"../../home/u/.pi/.pi-astack/t0-episodes/episodes.jsonl"),"--output","/tmp/o","--models-json","/tmp/m"],{})' },
  { name: "rejects t0 flag value path.join(mkdtemp, ..\\.. windows separators)", detect: detectT0SpawnViolations, expect: "reject", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(),"t0-pt5-")); const script = path.join(root,"scripts","t0-eval.mjs"); spawnSync(process.execPath,[script,"--episodes",path.join(tmp,"..\\..\\home\\u\\.pi\\.pi-astack\\t0-episodes\\episodes.jsonl"),"--output","/tmp/o","--models-json","/tmp/m"],{})' },
  // wrapper normalization: env spellings (/usr/bin/env, env.exe, Windows
  // env paths) behave like env; static unknown wrappers (busybox sh -c,
  // timeout, docker run) fail closed whenever the argv statically names a
  // T0 alias/script/shell nested target.
  { name: "rejects /usr/bin/env npm run t0:eval (no flags)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'spawnSync("/usr/bin/env", ["npm", "run", "t0:eval"]);' },
  { name: "rejects env.exe npm run t0:eval (no flags)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'spawnSync("env.exe", ["npm", "run", "t0:eval"]);' },
  { name: "rejects Windows env path npm run t0:eval (no flags)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'spawnSync("C:\\\\Windows\\\\System32\\\\env.exe", ["npm", "run", "t0:eval"]);' },
  { name: "rejects busybox sh -c npm run t0:eval (fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "unresolvable", src: 'spawnSync("busybox", ["sh", "-c", "npm run t0:eval"]);' },
  { name: "rejects timeout 60 npm run t0:eval (fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "unresolvable", src: 'spawnSync("timeout", ["60", "npm", "run", "t0:eval"]);' },
  { name: "rejects docker run img npm run t0:eval (fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "unresolvable", src: 'spawnSync("docker", ["run", "img", "npm", "run", "t0:eval"]);' },
  // P0 flatten/normalization: a spread of a static const array (or a bare
  // const-array element) resolves to the SAME flat argv as a hand-written
  // one — scripts/flags/path values can never hide inside a nested array.
  // Missing required flags, env path values, unknown t0 entries, missing
  // --selection, and multi-T0 ambiguity all fail closed; legal complete tmp
  // bases and exact static node -c spreads allow.
  { name: "rejects spread const base argv missing flags (Anthropic N1)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "must explicitly pass", src: 'const base = ["t0-eval.mjs"];\nspawnSync(process.execPath, [...base, "--quiet"]);' },
  { name: "rejects spread const base argv with env path value", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "not statically provable", src: 'const base = ["t0-eval.mjs", "--episodes", process.env.EP, "--output", "/tmp/o", "--models-json", "/tmp/m"];\nspawnSync(process.execPath, [...base]);' },
  { name: "rejects spread const base unknown t0 entry (Anthropic N3)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "without defined required flags", src: 'const base = ["t0-episode-build.mjs"];\nspawnSync(process.execPath, [...base]);' },
  { name: "rejects spread const base t0-replay-build missing --selection (Anthropic N5)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "must explicitly pass --selection", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-bs-")); const base = ["t0-replay-build.mjs", "--episodes", process.env.EP, "--meta", path.join(tmp,"m.jsonl"), "--output", path.join(tmp,"o"), "--models-json", path.join(tmp,"mj.json")];\nspawnSync(process.execPath, [...base]);' },
  { name: "rejects nested 2-level spread const base argv missing flags", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "must explicitly pass", src: 'const a = ["t0-eval.mjs"]; const b = [...a];\nspawnSync(process.execPath, [...b, "--quiet"]);' },
  { name: "rejects bare const-array element argv missing flags", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "must explicitly pass", src: 'const base = ["t0-eval.mjs"];\nspawnSync(process.execPath, [base, "--quiet"]);' },
  { name: "allows spread const base legal complete tmp argv", detect: detectT0SpawnViolations, expect: "allow", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-base-")); const base = ["t0-eval.mjs", "--episodes", path.join(tmp, "ep.jsonl"), "--output", path.join(tmp, "out"), "--models-json", path.join(tmp, "models.json")];\nspawnSync(process.execPath, [...base]);' },
  { name: "allows node -c spread exact static array (Anthropic N7)", detect: detectT0SpawnViolations, expect: "allow", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nconst base = ["-c", script];\nspawnSync(process.execPath, [...base]);' },
  { name: "rejects node -c spread with extra element (Anthropic B6)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "must explicitly pass", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nconst base = ["-c", script];\nspawnSync(process.execPath, [...base, "--episodes", "/tmp/e"]);' },
  { name: "rejects runner .mjs shadowing a later t0 target", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "must explicitly pass", src: 'const runner = path.join(root, "scripts", "runner.mjs");\nconst script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [runner, script, "--quiet"]);' },
  { name: "rejects nested-array runner shadowing a t0 target", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "must explicitly pass", src: 'spawnSync(process.execPath, [["t0-eval.mjs"], "--quiet"]);' },
  { name: "rejects multi-T0 targets in one argv (ambiguous, fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "ambiguous", src: 'spawnSync(process.execPath, ["t0-eval.mjs", "t0-replay-select.mjs", "--quiet"]);' },
  { name: "rejects defined entry plus unknown t0 script (ambiguous)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "ambiguous", src: 'spawnSync(process.execPath, ["t0-eval.mjs", "t0-episode-build.mjs", "--quiet"]);' },
  { name: "rejects models.json inside spread base without --models-json", detect: detectModelsJsonSpawnViolations, expect: "reject", expectMsg: "without --models-json", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-mb-")); const base = ["t0-eval.mjs", "--episodes", path.join(tmp,"e.jsonl"), "--output", path.join(tmp,"o"), path.join(tmp,"models.json")];\nspawnSync(process.execPath, [...base], {});' },
  { name: "rejects models.json in mutable initializer (independent detector sees let-bound production config)", detect: detectModelsJsonSpawnViolations, expect: "reject", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nlet mj = path.join(home, "models.json");\nspawnSync(process.execPath, [script, "--episodes", "/tmp/e", "--output", "/tmp/o", "--models-json", mj]);' },
  { name: "rejects models.json in mutable initializer via T0 gate (value not provably tmp)", detect: detectT0SpawnViolations, expect: "reject", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nlet mj = path.join(home, "models.json");\nspawnSync(process.execPath, [script, "--episodes", "/tmp/e", "--output", "/tmp/o", "--models-json", mj]);' },
  // duplicate --models-json closure: EVERY occurrence must have exactly one
  // successor value and every value must be tmp-rooted — a mixed
  // production/tmp pair (either order) and a tmp/tmp duplicate both fail
  // closed (CLI last-wins ambiguity); a bare flag with no value fails
  // closed too. The T0 total gate keeps its per-value rejection.
  { name: "rejects duplicate --models-json production then tmp (mixed duplicate)", detect: detectModelsJsonSpawnViolations, expect: "reject", expectMsg: "duplicate", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-md1-"));\nconst script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", "/tmp/e", "--output", "/tmp/o", "--models-json", "/home/u/.pi/.pi-astack/t0-episodes/models.json", "--models-json", path.join(tmp, "models.json")], {});' },
  { name: "rejects duplicate --models-json tmp then production (mixed duplicate)", detect: detectModelsJsonSpawnViolations, expect: "reject", expectMsg: "duplicate", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-md2-"));\nconst script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", "/tmp/e", "--output", "/tmp/o", "--models-json", path.join(tmp, "models.json"), "--models-json", "/home/u/.pi/.pi-astack/t0-episodes/models.json"], {});' },
  { name: "rejects duplicate --models-json both tmp (CLI ambiguity)", detect: detectModelsJsonSpawnViolations, expect: "reject", expectMsg: "duplicate", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-md3-"));\nconst script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", "/tmp/e", "--output", "/tmp/o", "--models-json", path.join(tmp, "models.json"), "--models-json", path.join(tmp, "m2.json")], {});' },
  { name: "rejects bare --models-json followed by another flag (no value)", detect: detectModelsJsonSpawnViolations, expect: "reject", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-mb2-"));\nconst script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", "/tmp/e", "--output", "/tmp/o", "--models-json", "--quiet", path.join(tmp, "models.json")], {});' },
  { name: "rejects duplicate --models-json via T0 gate (per-value)", detect: detectT0SpawnViolations, expect: "reject", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-md4-"));\nconst script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", "/tmp/e", "--output", "/tmp/o", "--models-json", "/home/u/.pi/.pi-astack/t0-episodes/models.json", "--models-json", path.join(tmp, "models.json")], {});' },
  // options expressions that cannot be proven absent/disabled fail closed:
  // conditional/logical/nullish/comma in the third options argument (or any
  // explicit options position) must never silently fall through as "absent"
  // — a runtime-enabled shell would turn the argv into a shell command. A
  // conditional with BOTH branches provably shell-disabled (or shell-absent)
  // stays allowed.
  { name: "rejects conditional options flag ? shell:true : shell:false (options A1)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", "/tmp/e.jsonl", "--output", "/tmp/o", "--models-json", "/tmp/m"], flag ? {shell:true} : {shell:false});' },
  { name: "rejects logical-or options opts || {shell:true} (options A2)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "unresolvable", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nconst OPTS = opts || {shell:true};\nspawnSync(process.execPath, [script, "--episodes", "/tmp/e.jsonl", "--output", "/tmp/o", "--models-json", "/tmp/m"], OPTS);' },
  { name: "rejects nullish options opts ?? {shell:true} (options A3)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "unresolvable", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nconst OPTS = opts ?? {shell:true};\nspawnSync(process.execPath, [script, "--episodes", "/tmp/e.jsonl", "--output", "/tmp/o", "--models-json", "/tmp/m"], OPTS);' },
  { name: "rejects comma options (0, {shell:true}) (options A4)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", "/tmp/e.jsonl", "--output", "/tmp/o", "--models-json", "/tmp/m"], (0, {shell:true}));' },
  { name: "allows conditional options both branches shell-disabled", detect: detectT0SpawnViolations, expect: "allow", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", "/tmp/e.jsonl", "--output", "/tmp/o", "--models-json", "/tmp/m"], flag ? {shell:false} : {shell:false});' },
  { name: "allows conditional options without any shell property", detect: detectT0SpawnViolations, expect: "allow", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", "/tmp/e.jsonl", "--output", "/tmp/o", "--models-json", "/tmp/m"], flag ? {cwd: "/tmp"} : {env: {PI_OFFLINE: "1"}});' },
  { name: "rejects node -c syntax check with conditional shell options (fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, ["-c", script], flag ? {shell:true} : {shell:false});' },
  { name: "allows node -c syntax check with conditional both-disabled options", detect: detectT0SpawnViolations, expect: "allow", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, ["-c", script], flag ? {shell:false} : {shell:false});' },
  // dynamic node:path imports: `const { join } = await import("node:path")`,
  // alias renames, and `const p = await import("node:path"); p.join(...)`
  // are real path functions with the same tmp-rootedness semantics — the
  // AST import-call source proves the module, so an arbitrary module's join
  // is never misidentified.
  { name: "rejects dynamic node:path destructured join production path", detect: detectProductionPathExpressions, expect: "reject", src: 'const { join } = await import("node:path");\njoin(home, ".pi-astack", "t0-episodes");' },
  { name: "rejects dynamic node:path destructured alias join production path", detect: detectProductionPathExpressions, expect: "reject", src: 'const { join: j } = await import("node:path");\nj(home, ".pi-astack", "t0-episodes");' },
  { name: "rejects dynamic node:path namespace join production path", detect: detectProductionPathExpressions, expect: "reject", src: 'const p = await import("node:path");\np.join(home, ".pi-astack", "t0-episodes");' },
  { name: "allows dynamic node:path destructured join tmp fixture", detect: detectProductionPathExpressions, expect: "allow", src: 'const { join } = await import("node:path");\njoin(os.tmpdir(), ".pi-astack", "t0-episodes");' },
  { name: "allows dynamic node:path namespace join tmp fixture", detect: detectProductionPathExpressions, expect: "allow", src: 'const p = await import("node:path");\np.join(os.tmpdir(), "t0-episodes");' },
  { name: "allows dynamic import of arbitrary module join (not node:path)", detect: detectProductionPathExpressions, expect: "allow", src: 'const { join } = await import("lodash");\njoin(home, ".pi-astack", "t0-episodes");' },
  { name: "allows dynamic node:path join tmp flag values", detect: detectT0SpawnViolations, expect: "allow", src: 'import { join } from "node:path";\nconst { join: j } = await import("node:path");\nconst tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-dp-"));\nconst script = join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", j(tmp, "ep.jsonl"), "--output", "/tmp/o", "--models-json", "/tmp/m"]);' },
  { name: "rejects dynamic node:path join production flag value", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "not statically provable", src: 'const { join } = await import("node:path");\nconst script = join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", join(home, ".pi-astack", "t0-episodes", "ep.jsonl"), "--output", "/tmp/o", "--models-json", "/tmp/m"]);' },
  // P2 makeJudgeInvoker invocation forms: .call/.apply (direct, aliased,
  // namespace), calling a bind(...) result (directly or via a const alias of
  // the bound function — bind itself never invokes), and static-array
  // element access. Assigned/bound but never invoked stays allowed.
  { name: "rejects makeJudgeInvoker.call invocation", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'makeJudgeInvoker.call(null, { modelsJsonPath });' },
  { name: "rejects makeJudgeInvoker.apply invocation", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'makeJudgeInvoker.apply(null, [{ modelsJsonPath }]);' },
  { name: "rejects aliased makeJudgeInvoker .call invocation", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'const invoke = makeJudgeInvoker;\ninvoke.call(null, { modelsJsonPath });' },
  { name: "rejects calling makeJudgeInvoker.bind(...) result directly", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'makeJudgeInvoker.bind(null)({ modelsJsonPath });' },
  { name: "rejects const alias of makeJudgeInvoker.bind(...) called", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'const bound = makeJudgeInvoker.bind(null);\nbound({ modelsJsonPath });' },
  { name: "rejects multi-hop alias of bound makeJudgeInvoker called", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'const bound = makeJudgeInvoker.bind(null);\nconst b2 = bound;\nb2({ modelsJsonPath });' },
  { name: "rejects namespace makeJudgeInvoker .call invocation", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'import * as C from "./t0-eval-common.mjs";\nC.makeJudgeInvoker.call(null, { modelsJsonPath });' },
  { name: "rejects namespace makeJudgeInvoker.bind(...) result called", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'import * as C from "./t0-eval-common.mjs";\nC.makeJudgeInvoker.bind(null)({ modelsJsonPath });' },
  { name: "rejects static array [makeJudgeInvoker][0]()", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: '[makeJudgeInvoker][0]({ modelsJsonPath });' },
  { name: "rejects const static array [makeJudgeInvoker][0]()", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'const arr = [makeJudgeInvoker];\narr[0]({ modelsJsonPath });' },
  { name: "rejects makeJudgeInvoker.bind(...) result never invoked (reference lock)", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'const bound = makeJudgeInvoker.bind(null);\n// bound is never called here' },
  { name: "rejects makeJudgeInvoker.bind(...) result discarded (reference lock)", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'makeJudgeInvoker.bind(null);' },
  // makeJudgeInvoker executable-reference lock — exotic reference forms:
  // Reflect.apply arguments, object properties (explicit + shorthand),
  // destructured reads, arrays; only object-literal KEYS, import-specifier
  // declarations, provably-other-module same-named properties, and
  // string/comment occurrences allow.
  { name: "rejects Reflect.apply(makeJudgeInvoker, ...)", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'Reflect.apply(makeJudgeInvoker, null, []);' },
  { name: "rejects object property makeJudgeInvoker", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'const o = { makeJudgeInvoker: fn };\no.makeJudgeInvoker({});' },
  { name: "rejects shorthand object property { makeJudgeInvoker }", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'const o = { makeJudgeInvoker };\n// never read' },
  { name: "rejects destructured makeJudgeInvoker from unresolvable module", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'const { makeJudgeInvoker } = someModule;\nmakeJudgeInvoker();' },
  { name: "rejects static array [makeJudgeInvoker] never read", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'const arr = [makeJudgeInvoker];\n// never read' },
  { name: "allows object literal key named makeJudgeInvoker", detect: detectMakeJudgeInvokerCalls, expect: "allow", src: 'const o = { makeJudgeInvoker: 1 };' },
  { name: "allows same-named named import from provably other module", detect: detectMakeJudgeInvokerCalls, expect: "allow", src: 'import { makeJudgeInvoker } from "some-lib";\nmakeJudgeInvoker();' },
  { name: "allows same-named property on provably other module namespace", detect: detectMakeJudgeInvokerCalls, expect: "allow", noCanonicalImports: true, src: 'import * as fs from "node:fs";\nfs.makeJudgeInvoker;' },
  { name: "rejects namespace property from dynamic t0-eval-common import (specifier resolved)", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'const C = await import(path.join(root, "scripts/t0-eval-common.mjs"));\nC.makeJudgeInvoker;' },
  { name: "rejects dynamic import of t0-eval-common destructured (specifier resolved)", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'const { makeJudgeInvoker: createInvoker } = await import(path.join(root, "scripts/t0-eval-common.mjs"));\ncreateInvoker();' },
  { name: "allows string/comment occurrences of makeJudgeInvoker (incl. src.indexOf)", detect: detectMakeJudgeInvokerCalls, expect: "allow", src: '// makeJudgeInvoker in a comment\nassert.ok(src.indexOf("makeJudgeInvoker") > -1);' },
  // closed approved subset — spread/budget/cycle: 2-level and 8-level
  // natural const spreads resolve statically (missing flags reject via the
  // required-flags gate); a cyclic spread or an over-budget nesting fails
  // closed GENERICALLY — never silently dropped.
  { name: "rejects 8-level spread const base argv missing flags", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "must explicitly pass", src: 'const a1 = ["t0-eval.mjs"]; const a2 = [...a1]; const a3 = [...a2]; const a4 = [...a3]; const a5 = [...a4]; const a6 = [...a5]; const a7 = [...a6]; const a8 = [...a7];\nspawnSync(process.execPath, [...a8, "--quiet"]);' },
  { name: "allows 8-level spread const base legal complete tmp argv", detect: detectT0SpawnViolations, expect: "allow", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-8s-")); const a1 = ["t0-eval.mjs", "--episodes", path.join(tmp, "ep.jsonl"), "--output", path.join(tmp, "o"), "--models-json", path.join(tmp, "m")]; const a2 = [...a1]; const a3 = [...a2]; const a4 = [...a3]; const a5 = [...a4]; const a6 = [...a5]; const a7 = [...a6]; const a8 = [...a7];\nspawnSync(process.execPath, [...a8]);' },
  { name: "rejects cyclic spread argv (generic fail closed, never dropped)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "unapproved child_process call", src: 'const a = [...a];\nspawnSync(process.execPath, [...a]);' },
  { name: "rejects over-budget nested array argv (generic fail closed, never dropped)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "unapproved child_process call", src: 'const deep = ' + "[".repeat(120) + '"t0-eval.mjs"' + "]".repeat(120) + ';\nspawnSync(process.execPath, deep);' },
  // closed approved subset — resolved-array hidden targets: a conditional /
  // array-index / replace() argv that cannot be statically resolved fails
  // closed GENERICALLY even when the target is buried inside.
  { name: "rejects conditional argv with unresolvable branches (generic fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "unapproved child_process call", src: 'spawnSync(process.execPath, [flag ? script : otherScript, "--quiet"]);' },
  { name: "rejects array-index argv (generic fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "unapproved child_process call", src: 'spawnSync(process.execPath, unknownArr[0]);' },
  { name: "rejects replace() argv (generic fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "unapproved child_process call", src: 'const argv = getArgs();\nspawnSync(process.execPath, argv.replace(/x/, suffix));' },
  // template middle/tail literals: a T0 target split across template spans
  // is visible to the diagnostic fallback (fail closed), in exec/spawn/
  // shell/helper positions.
  { name: "rejects exec template with target in a middle literal", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'execSync(`node scripts/${process.env.DIR}t0-eval.mjs --episodes ${process.env.EP}`);' },
  { name: "rejects spawnSync template command with target in a middle literal", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "unresolvable", src: 'spawnSync(`node scripts/${process.env.DIR}t0-eval.mjs --episodes ${process.env.EP}`);' },
  { name: "rejects sh -c template with target in a middle literal", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'spawnSync("sh", ["-c", `node scripts/${process.env.DIR}t0-eval.mjs --episodes ${process.env.EP}`]);' },
  { name: "rejects helper argv template element hiding the target (generic fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "unapproved child_process call", src: 'function run(args) { spawnSync(process.execPath, [`scripts/${process.env.DIR}t0-eval.mjs`, ...args], {}); }\nrun([]);' },
  // dynamic node:path default-export namespace: `(await import("node:path"))
  // .default.join`, `ns.default.join`, and `const p = (await import(
  // "node:path")).default; p.join` are real node:path functions — production
  // paths reject, tmp fixtures allow.
  { name: "rejects (await import(\"node:path\")).default.join production path", detect: detectProductionPathExpressions, expect: "reject", expectMsg: "production data path", src: '(await import("node:path")).default.join(home, ".pi-astack", "t0-episodes");' },
  { name: "rejects ns.default.join production path", detect: detectProductionPathExpressions, expect: "reject", expectMsg: "production data path", src: 'const ns = await import("node:path");\nns.default.join(home, ".pi-astack", "t0-episodes");' },
  { name: "rejects const p = (await import(\"node:path\")).default; p.join production path", detect: detectProductionPathExpressions, expect: "reject", expectMsg: "production data path", src: 'const p = (await import("node:path")).default;\np.join(home, ".pi-astack", "t0-episodes");' },
  { name: "allows (await import(\"node:path\")).default.join tmp fixture", detect: detectProductionPathExpressions, expect: "allow", src: '(await import("node:path")).default.join(os.tmpdir(), "t0-episodes");' },
  { name: "allows ns.default.join tmp fixture", detect: detectProductionPathExpressions, expect: "allow", src: 'const ns = await import("node:path");\nns.default.join(os.tmpdir(), "t0-episodes");' },
  { name: "allows default-namespace join tmp flag values", detect: detectT0SpawnViolations, expect: "allow", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-dn-")); const p = (await import("node:path")).default; const script = p.join(root, "scripts/t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", p.join(tmp, "ep.jsonl"), "--output", "/tmp/o", "--models-json", "/tmp/m"]);' },
  // closed approved subset — non-child_process same-named APIs are NOT real
  // calls; fully static non-T0 subprocesses and env-wrapped node argv are
  // unapproved; the legal four-smoke helper/spread/syntax-check forms stay
  // allowed.
  { name: "allows named import spawnSync from arbitrary module (not child_process)", detect: detectT0SpawnViolations, expect: "allow", src: 'import { spawnSync } from "some-lib";\nspawnSync("echo", ["hi"]);' },
  { name: "allows destructured spawnSync from arbitrary module (not child_process)", detect: detectT0SpawnViolations, expect: "allow", src: 'const { spawnSync: launch } = await import("some-lib");\nlaunch("echo", ["hi"]);' },
  { name: "rejects fully static non-T0 subprocess (fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "unapproved child_process call", src: 'spawnSync("echo", ["hello"]);' },
  { name: "rejects fully static non-T0 execFile-style subprocess (fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "unapproved child_process call", src: 'spawnSync("/bin/ls", ["-la"]);' },
  { name: "rejects no-argv non-T0 command (fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "unapproved child_process call", src: 'spawnSync("echo");' },
  { name: "rejects env-wrapped node t0-script argv (wrapper fail closed)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'const script = path.join(root, "scripts/t0-eval.mjs");\nspawnSync("env", ["node", script, "--episodes", "/tmp/ep.jsonl", "--output", "/tmp/o", "--models-json", "/tmp/m"]);' },
  { name: "rejects t0-eval argv with unknown element after complete flags (fully-static gate)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "unresolvable element", src: 'const script = path.join(root, "scripts/t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", "/tmp/ep.jsonl", "--output", "/tmp/o", "--models-json", "/tmp/m", extraUnknown]);' },
  { name: "allows full tmp nested spread through helper (real smoke shape)", detect: detectT0SpawnViolations, expect: "allow", src: 'function spawnBuild(args) { spawnSync(process.execPath, [path.join(root, "scripts/t0-replay-build.mjs"), ...args], {}); }\nconst tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-hb-"));\nconst invArgs = ["--episodes", path.join(tmp, "ep.jsonl"), "--meta", path.join(tmp, "meta.jsonl"), "--models-json", path.join(tmp, "mj.json")];\nspawnBuild(["--selection", path.join(tmp, "sel.json"), "--output", path.join(tmp, "out"), ...invArgs]);' },
  // child_process import/reference pre-gate: only static named import of
  // spawnSync/execFileSync used as a direct CallExpression callee is the
  // approved surface; every other surface fails closed with a precise
  // expectMsg. Bare direct snippets stay on the analyzer path.
  { name: "rejects spawnSync.call non-direct surface", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "non-direct reference", src: 'import { spawnSync } from "node:child_process";\nspawnSync.call(null, process.execPath, ["-c", "x"]);' },
  { name: "rejects spawnSync.apply non-direct surface", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "non-direct reference", src: 'import { spawnSync } from "node:child_process";\nspawnSync.apply(null, [process.execPath, ["-c", "x"]]);' },
  { name: "rejects Reflect.apply(spawnSync) non-direct surface", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "non-direct reference", src: 'import { spawnSync } from "node:child_process";\nReflect.apply(spawnSync, null, [process.execPath, ["-c", "x"]]);' },
  { name: "rejects spawnSync.bind non-direct surface", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "non-direct reference", src: 'import { spawnSync } from "node:child_process";\nconst bound = spawnSync.bind(null);\nbound(process.execPath, ["-c", "x"]);' },
  { name: "rejects spawnSync stored in object property", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "non-direct reference", src: 'import { spawnSync } from "node:child_process";\nconst o = { spawnSync };\no.spawnSync(process.execPath, ["-c", "x"]);' },
  { name: "rejects spawnSync stored in array element", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "non-direct reference", src: 'import { spawnSync } from "node:child_process";\nconst a = [spawnSync];\na[0](process.execPath, ["-c", "x"]);' },
  { name: "rejects promisify(exec) forbidden import surface", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "forbidden named import", src: 'import { exec } from "node:child_process";\nimport { promisify } from "node:util";\npromisify(exec);' },
  { name: "rejects bare fork direct call", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "bare fork", src: 'fork("scripts/t0-eval.mjs");' },
  { name: "rejects fork named import even unused", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "forbidden named import of fork", src: 'import { fork } from "node:child_process";\n// unused' },
  { name: "rejects default import of child_process", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "default import", src: 'import cp from "node:child_process";\nconst { spawnSync } = cp;\nspawnSync("echo", ["hi"]);' },
  { name: "rejects unused forbidden execFile import", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "forbidden named import of execFile", src: 'import { execFile } from "node:child_process";\n// unused' },
  { name: "allows approved spawnSync alias direct legal tmp argv", detect: detectT0SpawnViolations, expect: "allow", src: 'import { spawnSync as launch } from "node:child_process";\nconst tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-ap-"));\nconst script = path.join(root, "scripts", "t0-eval.mjs");\nlaunch(process.execPath, [script, "--episodes", path.join(tmp, "ep.jsonl"), "--output", path.join(tmp, "o"), "--models-json", path.join(tmp, "m")]);' },
  { name: "rejects approved execFileSync alias with invalid flags", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "must explicitly pass", src: 'import { execFileSync as run } from "node:child_process";\nconst script = path.join(root, "scripts", "t0-eval.mjs");\nrun(process.execPath, [script]);' },
  // Late-import order independence: ESM bindings ignore declaration position,
  // so approved direct aliases allow (and are findSpawnCalls-recognized) both
  // before and after the import; non-direct aliases reject in both orders.
  { name: "rejects late-import non-direct alias reference", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "non-direct reference to approved API", src: 'const x = launch;\nimport { spawnSync as launch } from "node:child_process";' },
  { name: "allows late-import direct legal tmp argv", detect: detectT0SpawnViolations, expect: "allow", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-li-"));\nconst script = path.join(root, "scripts", "t0-eval.mjs");\nlaunch(process.execPath, [script, "--episodes", path.join(tmp, "ep.jsonl"), "--output", path.join(tmp, "o"), "--models-json", path.join(tmp, "m")]);\nimport { spawnSync as launch } from "node:child_process";' },
  { name: "rejects late-import direct invalid flags", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "must explicitly pass", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nlaunch(process.execPath, [script]);\nimport { spawnSync as launch } from "node:child_process";' },
  { name: "allows other-module same-named spawnSync", detect: detectT0SpawnViolations, expect: "allow", src: 'import { spawnSync } from "some-lib";\nspawnSync("echo", ["hi"]);' },
  { name: "rejects const key makeJudgeInvoker element access", detect: detectMakeJudgeInvokerCalls, expect: "reject", expectMsg: "makeJudgeInvoker element", src: 'import * as C from "./t0-eval-common.mjs";\nconst k = "makeJudgeInvoker";\nC[k]({ modelsJsonPath });' },
  { name: "rejects get shell accessor options (enabled)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "shell/package-manager wrapper", src: 'const script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", "/tmp/e.jsonl", "--output", "/tmp/o", "--models-json", "/tmp/m"], { get shell() { return true; } });' },
  { name: "allows ordinary non-shell getter in options", detect: detectT0SpawnViolations, expect: "allow", src: 'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-og-"));\nconst script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", path.join(tmp, "ep.jsonl"), "--output", path.join(tmp, "o"), "--models-json", path.join(tmp, "m")], { get cwd() { return tmp; } });' },
  { name: "allows fake local path module (no tmp proof, not node:path)", detect: detectT0SpawnViolations, expect: "allow", noCanonicalImports: true, src: 'const path = { join: (...a) => a.join("/") };\nconst tmp = fs.mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "t0-fk-"));\n// bare path.join is NOT node:path — production-path detector ignores it; no spawn' },
  { name: "rejects fake path.join flag value (no tmp proof from local path)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "not statically provable", noCanonicalImports: true, src: 'const path = { join: (...a) => a.join("/") };\nconst script = "scripts/t0-eval.mjs";\nspawnSync(process.execPath, [script, "--episodes", path.join("/tmp", "ep.jsonl"), "--output", "/tmp/o", "--models-json", "/tmp/m"]);' },
  // P1 local exports are REFERENCES, not declarations: `export { launch }`
  // (no module specifier) exports a local binding — exporting an approved
  // child_process alias or the makeJudgeInvoker marker is an executable
  // reference and must reject. (`export { x } from "…"` re-export subtrees
  // are skipped by the child_process pass-2 walk / re-reviewed by the marker
  // walk.)
  { name: "rejects local export of approved child_process alias", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "non-direct reference", src: 'import { spawnSync as launch } from "node:child_process";\nexport { launch };' },
  { name: "rejects local export alias of approved child_process alias", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "non-direct reference", src: 'import { spawnSync as launch } from "node:child_process";\nexport { launch as run };' },
  { name: "rejects local export of imported makeJudgeInvoker", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'import { makeJudgeInvoker as invoke } from "./t0-eval-common.mjs";\nexport { invoke };' },
  { name: "rejects local export alias of imported makeJudgeInvoker", detect: detectMakeJudgeInvokerCalls, expect: "reject", src: 'import { makeJudgeInvoker as invoke } from "./t0-eval-common.mjs";\nexport { invoke as inv };' },
  // node:os/node:fs tmp-root provenance is binding-aware (symmetric with
  // node:path): only a PROVABLE node:os tmpdir / node:fs mkdtemp* counts as
  // an explicit tmp fixture root. Fake/local `const os = { tmpdir: … }`,
  // `const fs = { … }`, bare/local `mkdtempSync`, and param `os` never grant
  // tmp proof.
  { name: "rejects fake os tmpdir production path (no tmp proof from fake os)", detect: detectProductionPathExpressions, expect: "reject", noCanonicalImports: true, src: 'const os = { tmpdir: () => "/home/u" };\npath.join(os.tmpdir(), ".pi-astack", "t0-episodes");' },
  { name: "rejects fake os tmpdir on all three t0 flags (no tmp proof)", detect: detectT0SpawnViolations, expect: "reject", noCanonicalImports: true, src: 'const os = { tmpdir: () => "/home/u" };\nconst script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", path.join(os.tmpdir(), "ep.jsonl"), "--output", path.join(os.tmpdir(), "out"), "--models-json", path.join(os.tmpdir(), "models.json")]);' },
  { name: "rejects bare mkdtempSync tmp root (no tmp proof)", detect: detectT0SpawnViolations, expect: "reject", src: 'const tmp = mkdtempSync("/tmp/t0-bare-");\nconst script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", path.join(tmp, "ep.jsonl"), "--output", path.join(tmp, "o"), "--models-json", path.join(tmp, "m")]);' },
  { name: "rejects fake fs mkdtempSync tmp root (no tmp proof from fake fs)", detect: detectT0SpawnViolations, expect: "reject", noCanonicalImports: true, src: 'const fs = { mkdtempSync: () => "/home/u/t0" };\nconst tmp = fs.mkdtempSync();\nconst script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", path.join(tmp, "ep.jsonl"), "--output", path.join(tmp, "o"), "--models-json", path.join(tmp, "m")]);' },
  { name: "rejects param os tmpdir production path (no tmp proof from param)", detect: detectProductionPathExpressions, expect: "reject", src: 'function f(os) { return path.join(os.tmpdir(), ".pi-astack", "t0-episodes"); }' },
  // Legal node:os/node:fs provenance forms keep granting tmp proof: static
  // named imports, namespace imports, and dynamic import/require (including
  // destructured forms) all count as explicit tmp fixture roots.
  { name: "allows named node:os/node:fs tmp fixtures", detect: detectT0SpawnViolations, expect: "allow", src: 'import { tmpdir } from "node:os";\nimport { mkdtempSync } from "node:fs";\nconst tmp = mkdtempSync(path.join(tmpdir(), "t0-named2-"));\nconst script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", path.join(tmp, "ep.jsonl"), "--output", path.join(tmp, "o"), "--models-json", path.join(tmp, "m")]);' },
  { name: "allows namespace node:os/node:fs tmp fixtures", detect: detectT0SpawnViolations, expect: "allow", noCanonicalImports: true, src: 'import * as os from "node:os";\nimport * as fs from "node:fs";\nconst tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-ns2-"));\nconst script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", path.join(tmp, "ep.jsonl"), "--output", path.join(tmp, "o"), "--models-json", path.join(tmp, "m")]);' },
  { name: "allows dynamic node:os/node:fs tmp fixtures", detect: detectT0SpawnViolations, expect: "allow", noCanonicalImports: true, src: 'const os = await import("node:os");\nconst fs = await import("node:fs");\nconst tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-dyn2-"));\nconst script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", path.join(tmp, "ep.jsonl"), "--output", path.join(tmp, "o"), "--models-json", path.join(tmp, "m")]);' },
  { name: "allows destructured dynamic node:os/node:fs tmp fixtures", detect: detectT0SpawnViolations, expect: "allow", src: 'const { tmpdir } = await import("node:os");\nconst { mkdtempSync } = await import("node:fs");\nconst tmp = mkdtempSync(path.join(tmpdir(), "t0-ddyn-"));\nconst script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", path.join(tmp, "ep.jsonl"), "--output", path.join(tmp, "o"), "--models-json", path.join(tmp, "m")]);' },
  // dynamic/unknown child_process source closure: the module argument of
  // import()/require() is resolved scope-aware (const chains / static +
  // concat / static templates); an unresolvable module spec fails closed
  // only when its result reaches a spawn API surface (destructure / property
  // access / binding) — plain dynamic local-module imports stay allowed.
  { name: "rejects await import(const M) destructured spawnSync (R1)", detect: detectT0SpawnViolations, expect: "reject", src: 'const M = "node:child_process";\nconst { spawnSync } = await import(M);\nspawnSync("npm", ["run", "t0:eval"]);' },
  { name: "rejects require(const M) destructured execSync (R1)", detect: detectT0SpawnViolations, expect: "reject", src: 'const M = "node:child_process";\nconst { execSync } = require(M);\nexecSync("npm run t0:eval");' },
  { name: "rejects import(static concat) destructured spawnSync", detect: detectT0SpawnViolations, expect: "reject", src: 'const { spawnSync } = await import("node:child_" + "process");\nspawnSync("echo", ["hi"]);' },
  { name: "rejects destructured spawnSync from unresolvable dynamic source", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "fail closed", src: 'const { spawnSync } = await import(modulePath);\nspawnSync("echo", ["hi"]);' },
  { name: "rejects property-access spawnSync on unresolvable dynamic source", detect: detectT0SpawnViolations, expect: "reject", src: 'const cp = await import(modulePath);\ncp.spawnSync("echo", ["hi"]);' },
  { name: "rejects const spawnSync = getIt() then direct call (E1)", detect: detectT0SpawnViolations, expect: "reject", expectMsg: "must explicitly pass", src: 'const spawnSync = getIt();\nspawnSync(process.execPath, ["t0-eval.mjs"]);' },
  { name: "allows plain dynamic local-module import with legal tmp spawn", detect: detectT0SpawnViolations, expect: "allow", src: 'const { aggregate } = await import(path.join(root, "scripts/t0-eval-aggregate.mjs"));\nconst tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-dl2-"));\nconst script = path.join(root, "scripts", "t0-eval.mjs");\nspawnSync(process.execPath, [script, "--episodes", path.join(tmp, "ep.jsonl"), "--output", path.join(tmp, "o"), "--models-json", path.join(tmp, "m")]);' },
];
// Detector self-test snippets are complete provenance modules: the lock only
// grants tmp-rootedness proof through a PROVABLE node:fs/node:os import, so
// every snippet that relies on `fs.mkdtempSync`/`os.tmpdir`/`path.join` gets
// the canonical default imports prepended. Fake-binding snippets (which
// declare their own local `path`/`os`/`fs`) opt out so they never get
// duplicate declarations — a fake binding must stay the only binding.
const detectorSelfTestImports = 'import fs from "node:fs";\nimport os from "node:os";\nimport path from "node:path";\n';
const detectorSelfTestFailures = [];
for (const t of detectorSelfTests) {
  const src = t.noCanonicalImports ? t.src : detectorSelfTestImports + t.src;
  const hits = t.detect(src);
  const ok = t.expectMsg ? hits.some((h) => h.includes(t.expectMsg)) : (t.expect === "reject" ? hits.length > 0 : hits.length === 0);
  if (!ok) detectorSelfTestFailures.push(`${t.name}: expected ${t.expect}${t.expectMsg ? ` (message containing "${t.expectMsg}")` : ""}, got ${JSON.stringify(hits)}`);
}
check("T0 offline-lock detector self-tests pass", detectorSelfTestFailures.length === 0, detectorSelfTestFailures.join("\n"));
// Real dossier/pilot TEMP-ARTIFACT prefix lock (ADR 0027 C6): a smoke must
// never read a real dossier's own generated output from /tmp. These are
// EXECUTABLE path forms only — `path.join(os.tmpdir(), "t0-…")` or an
// absolute `/tmp/t0-…` string — so an explanatory comment merely naming the
// artifacts (e.g. "never reads pilot output") cannot trip them. Covers both
// the current dossier prefixes and the retired pilot ones.
const t0TempArtifactForbidden = [
  'path.join(os.tmpdir(), "t0-eval-dossier-',
  'path.join(os.tmpdir(), "t0-replay-fair-dossier-',
  'path.join(os.tmpdir(), "t0-eval-pilot-',
  'path.join(os.tmpdir(), "t0-replay-pilot-',
  '"/tmp/t0-eval-dossier-',
  '"/tmp/t0-replay-fair-dossier-',
  '"/tmp/t0-eval-pilot-',
  '"/tmp/t0-replay-pilot-',
];
for (const file of t0SmokeFiles) {
  const src = fs.readFileSync(path.join(repoRoot, file), "utf8");
  const hits = t0TempArtifactForbidden.filter((m) => src.includes(m));
  check(`${file} never reads real dossier/pilot temp artifacts (tmpdir join or /tmp absolute path)`, hits.length === 0, hits.join(", "));
}
// Every parseArgs call in the episode-build dossier must pass an explicit
// tmp-rooted --output (the dossier's scratch outputs are all mkdtemp
// fixtures; a production output path would mean the dossier writes real
// data).
function dossierParseArgsOutputHits(src) {
  const sf = parseSmokeSource(src);
  const { lookup } = collectBindings(sf);
  const hits = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && calleeBaseName(node.expression) === "parseArgs") {
      const arg = node.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        for (const prop of arg.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          const key = ts.isIdentifier(prop.name) ? prop.name.text : staticString(prop.name);
          if (key !== "output") continue;
          const r = resolveStatic(prop.initializer, lookup);
          if (!(r.kind === "path" && r.tmpRooted === true)) {
            hits.push("parseArgs output is not statically provable as an explicit tmp root");
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return hits;
}

// All four T0 dossiers are registered as dossier:* (never smoke:*).
const t0DossierNames = ["dossier:t0-eval-production", "dossier:t0-replay-production", "dossier:t0-replay-fair-production", "dossier:t0-episode-build-production"];
for (const name of t0DossierNames) {
  const command = packageScripts[name];
  check(`T0 dossier ${name} registered as dossier:*`, dossierFileFromCommand(command) !== null, String(command ?? "missing"));
}
// Live dossiers read real production data; the read-only fair dossier reads
// the same data but must NEVER build a real invoker or call a provider.
for (const file of [...t0LiveDossierFiles, ...t0ReadonlyDossierFiles]) {
  const src = fs.readFileSync(path.join(repoRoot, file), "utf8");
  const missing = ["t0-episodes", "models.json"].filter((m) => !src.includes(m));
  check(`${file} reads real production data (t0-episodes + models.json)`, missing.length === 0, `missing: ${missing.join(", ")}`);
}
for (const file of t0LiveDossierFiles) {
  const src = fs.readFileSync(path.join(repoRoot, file), "utf8");
  const missing = ["makeJudgeInvoker", "execFileSync("].filter((m) => !src.includes(m));
  check(`${file} makes real invoker + live pipeline subprocess calls`, missing.length === 0, `missing: ${missing.join(", ")}`);
}
{
  const src = fs.readFileSync(path.join(repoRoot, "scripts/dossier-t0-replay-fair-production.mjs"), "utf8");
  const live = ["makeJudgeInvoker", "callJudge("].filter((m) => src.includes(m));
  check("dossier-t0-replay-fair-production is read-only (no real invoker / provider calls)", live.length === 0, live.join(", "));
}
// The episode-build dossier reads real production dispatch/session defaults
// through t0-episode-build's own parseArgs/buildEpisodes (its data source is
// the dispatch audit + session corpus, NOT t0-episodes/models.json), is
// read-only (no invoker/provider/live pipeline subprocess), and every
// parseArgs output is an explicit tmp root.
{
  const src = fs.readFileSync(path.join(repoRoot, "scripts/dossier-t0-episode-build-production.mjs"), "utf8");
  const missing = ["t0-episode-build.mjs", "parseArgs", "buildEpisodes", "production-data"].filter((m) => !src.includes(m));
  check("dossier-t0-episode-build-production reads real production dispatch/session defaults (t0-episode-build + parseArgs + buildEpisodes)", missing.length === 0, `missing: ${missing.join(", ")}`);
  const parseOutputHits = dossierParseArgsOutputHits(src);
  check("dossier-t0-episode-build-production parseArgs outputs are explicit tmp roots only", parseOutputHits.length === 0, parseOutputHits.join(", "));
  const live = ["makeJudgeInvoker", "callJudge(", "spawnSync(", "execFileSync(", "execSync(", "execFile(", "spawn(", "fork("].filter((m) => src.includes(m));
  if (/from\s+["'](?:node:)?child_process["']/.test(src) || /(?:import|require)\(\s*["'](?:node:)?child_process["']/.test(src)) {
    live.push("child_process import/require");
  }
  check("dossier-t0-episode-build-production is read-only (no real invoker / provider / live pipeline subprocess)", live.length === 0, live.join(", "));
}
// Executable-path locks (not comment strings): the replay dossier must run
// the fair-manifest preflight through the build's own validator/eligibility
// resolver and pass the REAL manifest via --selection; the fair dossier must
// run the hard-gate scan and spawn the selector with --hard-only.
{
  const src = fs.readFileSync(path.join(repoRoot, "scripts/dossier-t0-replay-production.mjs"), "utf8");
  check(
    "dossier-t0-replay-production preflights via loadAndValidateSelection + resolveSelectedSourceEpisodes + --selection",
    src.includes("loadAndValidateSelection(") && src.includes("resolveSelectedSourceEpisodes(") && src.includes("--selection"),
  );
}
{
  const src = fs.readFileSync(path.join(repoRoot, "scripts/dossier-t0-replay-fair-production.mjs"), "utf8");
  check(
    "dossier-t0-replay-fair-production runs the hard-gate scan and spawns the selector with --hard-only",
    src.includes("selectHardCandidates(") && src.includes("--hard-only"),
  );
}
// Both REPLAY dossiers validate the canonical real manifest's provenance via
// the shared pure validator (full hard-gate scan + checkpoints-fair/*.json)
// BEFORE any provider request / as a read-only check — a hand-written or
// derived manifest must fail closed, never a warn. (The eval dossier has no
// fair selection manifest to validate.)
for (const file of ["scripts/dossier-t0-replay-production.mjs", "scripts/dossier-t0-replay-fair-production.mjs"]) {
  const src = fs.readFileSync(path.join(repoRoot, file), "utf8");
  check(
    `${file} validates fair manifest provenance via validateFairManifestProvenance + checkpoints-fair`,
    src.includes("validateFairManifestProvenance(") && src.includes("checkpoints-fair"),
  );
}

console.log(`\nsummary: smoke_files=${smokeFiles.length} smoke_scripts=${registeredSmoke.length} dossier_files=${dossierFiles.length} dossier_scripts=${registeredDossiers.length}`);
if (failures.length) {
  console.log(`FAIL — ${failures.length} registry drift check(s) failed.`);
  process.exit(1);
}
console.log("PASS — smoke/dossier registry is in sync.");
process.exit(0);
}
