#!/usr/bin/env node
/**
 * Smoke test for pi-astack memory + sediment extensions.
 *
 * This intentionally avoids pi runtime dependencies: TypeScript sources are
 * transpiled to a temp CommonJS tree and `typebox` is stubbed with the tiny
 * subset used by the tool schemas. The test exercises parser/search/lint/
 * graph/index/migration/sediment writer/checkpoint/dedupe/extractor/report
 * paths without touching the real project `.pensieve/`.
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function assertNoLegacyPackageScope() {
  const legacyScope = ["@mariozechner", "pi-"].join("/");
  const roots = ["extensions", "docs", "package.json", "README.md"];
  const offenders = [];
  function visit(file) {
    const stat = fs.statSync(file);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(file)) visit(path.join(file, child));
      return;
    }
    if (!/\.(ts|md|json)$/.test(file)) return;
    const raw = fs.readFileSync(file, "utf-8");
    if (raw.includes(legacyScope)) offenders.push(path.relative(repoRoot, file));
  }
  for (const root of roots) visit(path.join(repoRoot, root));
  assert(offenders.length === 0, `legacy pi package scope remains: ${offenders.join(", ")}`);
}

function transpileExtensions(outRoot) {
  const extRoot = path.join(repoRoot, "extensions");
  const dirs = ["_shared", "memory", "sediment", "compaction-tuner"];
  let count = 0;
  for (const dir of dirs) {
    const srcDir = path.join(extRoot, dir);
    for (const file of fs.readdirSync(srcDir).filter((f) => f.endsWith(".ts"))) {
      const srcPath = path.join(srcDir, file);
      const outPath = path.join(outRoot, dir, file.replace(/\.ts$/, ".js"));
      const src = fs.readFileSync(srcPath, "utf-8");
      // ts.transpileModule() is the *fast* path: it strips TypeScript
      // syntax but does NOT run the full parser's diagnostics. In
      // particular, malformed JavaScript template literals (e.g. an
      // unescaped inner backtick inside a `${...}` string) will be
      // emitted as-is and only blow up when pi tries to actually load
      // the extension via its production parser (swc/babel/v8). That's
      // exactly how the 2026-05-12 regression in extensions/memory/
      // index.ts:170 (`Run \`/memory migrate --go\` ...`) slipped past
      // 5 rounds of multi-model audits + every smoke run before it.
      //
      // Workaround: after transpiling, parse the emitted JS through
      // Node's vm.Script with the strict parser to catch syntax errors
      // that transpileModule lets through. This costs ~5ms per file but
      // makes smoke a true gatekeeper for `pi load extension`.
      const transpiled = ts.transpileModule(src, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
          // TS 6 + NodeNext preserves dynamic import() in CommonJS output,
          // which Node then resolves as ESM and rejects extensionless
          // imports like import("./graph"). The smoke runs CJS modules, so
          // use classic NodeJs resolution to lower import() to require().
          moduleResolution: ts.ModuleResolutionKind.NodeJs,
          esModuleInterop: true,
          skipLibCheck: true,
        },
      });
      try {
        // vm.Script(...) only parses, doesn't execute. Throws SyntaxError
        // on malformed JS, which is the failure mode we want to surface.
        // eslint-disable-next-line no-new
        new (require("node:vm").Script)(transpiled.outputText, { filename: srcPath });
      } catch (err) {
        throw new Error(
          `Strict parse of ${path.relative(repoRoot, srcPath)} failed — ` +
            `pi will refuse to load this extension at runtime even though ` +
            `ts.transpileModule accepted it. Root cause is almost always ` +
            `unescaped backtick inside a template literal, or an unbalanced ` +
            `\${...} interpolation.\n` +
            `Original error: ${err && err.stack ? err.stack : err}`,
        );
      }
      writeFile(outPath, transpiled.outputText);
      count++;
    }
  }

  for (const subdir of ["constraint-evidence", "constraint-compiler"]) {
    for (const file of fs.readdirSync(path.join(extRoot, "sediment", subdir)).filter((f) => f.endsWith(".ts"))) {
      const srcPath = path.join(extRoot, "sediment", subdir, file);
      const outPath = path.join(outRoot, "sediment", subdir, file.replace(/\.ts$/, ".js"));
      const transpiled = ts.transpileModule(fs.readFileSync(srcPath, "utf-8"), {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
          moduleResolution: ts.ModuleResolutionKind.NodeJs,
          esModuleInterop: true,
          skipLibCheck: true,
        },
      });
      try {
        new (require("node:vm").Script)(transpiled.outputText, { filename: srcPath });
      } catch (err) {
        throw new Error(`Strict parse of ${path.relative(repoRoot, srcPath)} failed: ${err && err.stack ? err.stack : err}`);
      }
      writeFile(outPath, transpiled.outputText);
      count++;
    }
  }

  const sedimentPromptsDir = path.join(outRoot, "sediment", "prompts");
  fs.mkdirSync(sedimentPromptsDir, { recursive: true });
  for (const file of fs.readdirSync(path.join(extRoot, "sediment", "prompts")).filter((f) => f.endsWith(".md"))) {
    fs.copyFileSync(path.join(extRoot, "sediment", "prompts", file), path.join(sedimentPromptsDir, file));
  }

  // Canonical-path R3.4.2 P1-S3: the central schema-role registry JSON must be
  // available at <stage>/schemas for the staged _shared/l1-schema-registry.js.
  fs.mkdirSync(path.join(outRoot, "schemas"), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "schemas", "l1-schema-role-registry.json"), path.join(outRoot, "schemas", "l1-schema-role-registry.json"));

  // ADR 0023-R5: sediment imports the abrain rule-injector strip helper.
  // The smoke historically staged only memory/sediment/compaction; stage
  // this one abrain leaf module plus its parent index shim so relative
  // `../abrain/rule-injector` imports resolve without pulling the full
  // abrain vault stack into smoke:memory.
  {
    const srcPath = path.join(extRoot, "abrain", "rule-injector", "index.ts");
    const outPath = path.join(outRoot, "abrain", "rule-injector", "index.js");
    const transpiled = ts.transpileModule(fs.readFileSync(srcPath, "utf-8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        esModuleInterop: true,
        skipLibCheck: true,
      },
    });
    try {
      new (require("node:vm").Script)(transpiled.outputText, { filename: srcPath });
    } catch (err) {
      throw new Error(`Strict parse of ${path.relative(repoRoot, srcPath)} failed: ${err && err.stack ? err.stack : err}`);
    }
    writeFile(outPath, transpiled.outputText);
    {
      const leafSrcPath = path.join(extRoot, "abrain", "rule-injector", "dualread-audit.ts");
      const leafOutPath = path.join(outRoot, "abrain", "rule-injector", "dualread-audit.js");
      const leafTranspiled = ts.transpileModule(fs.readFileSync(leafSrcPath, "utf-8"), {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
          moduleResolution: ts.ModuleResolutionKind.NodeJs,
          esModuleInterop: true,
          skipLibCheck: true,
        },
      });
      try {
        new (require("node:vm").Script)(leafTranspiled.outputText, { filename: leafSrcPath });
      } catch (err) {
        throw new Error(`Strict parse of ${path.relative(repoRoot, leafSrcPath)} failed: ${err && err.stack ? err.stack : err}`);
      }
      writeFile(leafOutPath, leafTranspiled.outputText);
      count++;
    }
    writeFile(path.join(outRoot, "abrain", "rule-injector.js"), `module.exports = require("./rule-injector/index.js");\n`);
    count++;
  }

  // ADR 0023 D5: sediment/rule-writer.ts imports ../abrain/redact (self-
  // contained, only node:os). Stage it so sediment/writer.ts (which now
  // imports rule-writer) resolves under smoke:memory's partial tree.
  {
    const srcPath = path.join(extRoot, "abrain", "redact.ts");
    const outPath = path.join(outRoot, "abrain", "redact.js");
    const transpiled = ts.transpileModule(fs.readFileSync(srcPath, "utf-8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        esModuleInterop: true,
        skipLibCheck: true,
      },
    });
    writeFile(outPath, transpiled.outputText);
    count++;
  }

  // Minimal typebox subset for registerTool schemas.
  //
  // Keep this in sync with `Type.<Method>` usage across extensions/*/index.ts.
  // If a new method is added there and forgotten here, the smoke crashes at
  // module-load with "typebox_1.Type.<X> is not a function" — the failure is
  // unrelated to whatever the contributor was testing. Audit with:
  //   grep -hPo 'Type\.\w+' extensions/*/index.ts | sort -u
  writeFile(path.join(outRoot, "node_modules", "typebox", "index.js"), `
exports.Type = {
  Object: (properties, opts = {}) => ({ type: 'object', properties, ...opts }),
  String: (opts = {}) => ({ type: 'string', ...opts }),
  Number: (opts = {}) => ({ type: 'number', ...opts }),
  Array: (items, opts = {}) => ({ type: 'array', items, ...opts }),
  Boolean: (opts = {}) => ({ type: 'boolean', ...opts }),
  Optional: (schema) => ({ ...schema, optional: true }),
  Any: (opts = {}) => ({ ...opts }),
};
`);

  // Stub `@earendil-works/pi-tui`. memory/index.ts imports the shared
  // foldable tool-result renderer, which needs Text plus width helpers.
  // The real package is ESM-only; this CJS smoke tree uses a local subset.
  writeFile(path.join(outRoot, "node_modules", "@earendil-works", "pi-tui", "index.js"), `
class Text {
  constructor(text, paddingX = 0, paddingY = 0) { this.text = text; this.paddingX = paddingX; this.paddingY = paddingY; }
  invalidate() {}
  render() { return String(this.text).split("\\n"); }
}
function visibleWidth(text) { return Array.from(String(text)).length; }
function truncateToWidth(text, width, ellipsis = "...") {
  text = String(text);
  if (visibleWidth(text) <= width) return text;
  if (width <= 0) return "";
  if (width <= ellipsis.length) return ellipsis.slice(0, width);
  return text.slice(0, width - ellipsis.length) + ellipsis;
}
function wrapTextWithAnsi(text, width) {
  const out = [];
  for (const line of String(text).split("\\n")) {
    if (line.length === 0) { out.push(""); continue; }
    for (let i = 0; i < line.length; i += width) out.push(line.slice(i, i + width));
  }
  return out;
}
exports.Text = Text;
exports.visibleWidth = visibleWidth;
exports.truncateToWidth = truncateToWidth;
exports.wrapTextWithAnsi = wrapTextWithAnsi;
`);

  // Minimal pi-coding-agent subset for compaction-tuner custom summary hook
  // smoke. The real package is ESM-only; these CJS smokes need a local stub.
  writeFile(path.join(outRoot, "node_modules", "@earendil-works", "pi-coding-agent", "index.js"), `
exports.compact = async (preparation, model) => ({
  summary: 'stub compaction summary via ' + (model && model.id || 'unknown'),
  firstKeptEntryId: preparation.firstKeptEntryId,
  tokensBefore: preparation.tokensBefore,
});
class StubAgentSession {}
StubAgentSession.prototype._buildRuntime = function () {};
StubAgentSession.prototype._runAutoCompaction = function () {};
StubAgentSession.prototype._emit = function () {};
class StubInteractiveMode {}
StubInteractiveMode.prototype.handleEvent = function () {};
exports.AgentSession = StubAgentSession;
exports.InteractiveMode = StubInteractiveMode;
`);

  // Minimal OpenAI SDK subset so compaction-tuner modules can load inside the
  // temporary CJS smoke tree. smoke:memory never performs a remote compaction.
  writeFile(path.join(outRoot, "node_modules", "openai", "index.js"), `
class OpenAI {
  constructor(config = {}) {
    this.config = config;
    this.responses = {
      compact: async () => { throw new Error('openai compact stub should not be called by smoke:memory'); },
    };
  }
}
exports.default = OpenAI;
module.exports = OpenAI;
module.exports.default = OpenAI;
`);

  writeFile(path.join(outRoot, "compaction-tuner", "openai-responses-shared-loader.mjs"), `
export function convertResponsesMessages(messages) {
  return messages || [];
}
`);

  // Minimal pi-ai subset for ADR 0015 memory_search LLM-path smoke. Dynamic
  // import('@earendil-works/pi-ai') from transpiled CommonJS sees these named
  // exports; no real model call is made.
  writeFile(path.join(outRoot, "node_modules", "@earendil-works", "pi-ai", "index.js"), `
exports.__calls = [];
exports.__configs = [];
exports.__prompts = [];
exports.streamSimple = (_model, opts, config) => {
  exports.__configs.push(config || {});
  const prompt = opts && opts.messages && opts.messages[0] && opts.messages[0].content && opts.messages[0].content[0] && opts.messages[0].content[0].text || '';
  exports.__prompts.push(prompt);
  let text;
  if (prompt.includes('MEMORY_SEARCH_CANDIDATES')) {
    exports.__calls.push('memory-search-stage2');
    if (globalThis.__MEMORY_SEARCH_STAGE2_ERROR__) {
      return { result: async () => ({ stopReason: 'error', errorMessage: String(globalThis.__MEMORY_SEARCH_STAGE2_ERROR__) }) };
    }
    text = '[{"slug":"alpha","score":10,"why":"direct match"}]';
  } else if (prompt.includes('MEMORY_SEARCH_INDEX')) {
    exports.__calls.push('memory-search-stage1');
    text = '[{"slug":"alpha","reason":"title and summary match"}]';
  } else if (globalThis.__A2_RESPONSES__) {
    // Later A2 tests overwrite the stub file, but dynamic import may have
    // cached this module already. Honor the A2 globals here too.
    text = (globalThis.__A2_RESPONSES__ || [])[globalThis.__A2_INVOCATIONS__++] || 'SKIP';
    globalThis.__A2_LAST_PROMPT__ = prompt;
  } else {
    text = 'SKIP';
  }
  return { result: async () => ({ stopReason: 'stop', content: [{ type: 'text', text }], usage: { input: 111, output: 22, cacheRead: 7, cacheWrite: 3 } }) };
};
`);

  // Production migrated to `await import("@earendil-works/pi-ai/compat")`
  // (pi 0.80.0 moved the global stream API off the pi-ai root). Mirror the
  // stub at the /compat subpath so transpiled require() resolves it to the
  // same module instance the bare-path inspector reads.
  writeFile(path.join(outRoot, "node_modules", "@earendil-works", "pi-ai", "compat.js"), `module.exports = require("./index.js");\n`);

  return count;
}

function makeEntry({ title, kind = "fact", status = "active", confidence = 5, body = "Body.", extraFrontmatter = "" }) {
  return `---
title: ${title}
scope: project
kind: ${kind}
status: ${status}
confidence: ${confidence}
created: 2026-05-08
schema_version: 1
${extraFrontmatter}---
# ${title}

${body}

## Timeline

- 2026-05-08 | smoke | captured | ok
`;
}

async function main() {
  assertNoLegacyPackageScope();
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-"));
  const savedSettingsPath = process.env.PI_ASTACK_SETTINGS_PATH;
  const smokeSettingsPath = path.join(outRoot, "pi-astack-settings.json");
  writeFile(smokeSettingsPath, `${JSON.stringify({ canonicalGitRuntime: { enabled: false, mode: "local_convergence_v2" } }, null, 2)}\n`);
  process.env.PI_ASTACK_SETTINGS_PATH = smokeSettingsPath;
  const count = transpileExtensions(outRoot);
  const req = createRequire(path.join(outRoot, "runner.cjs"));

  try {
    const memoryExt = req("./memory/index.js").default;
    const sedimentExt = req("./sediment/index.js").default;
    const { splitFrontmatter } = req("./memory/parser.js");
    const { lintMarkdown } = req("./memory/lint.js");
    const { rebuildGraphIndex } = req("./memory/graph.js");
    const { rebuildMarkdownIndex } = req("./memory/index-file.js");
    const { planMigrationDryRun, writeMigrationReport, formatMigrationPlan } = req("./memory/migrate.js");
    const { preflightMigrationGo, runMigrationGo, formatMigrationGoSummary } = req("./memory/migrate-go.js");
    const { bindAbrainProject } = req("./_shared/runtime.js");
    const { runDoctorLite, formatDoctorLiteReport } = req("./memory/doctor.js");
    const { DEFAULT_SETTINGS } = req("./memory/settings.js");
    const { VectorIndex } = req("./memory/embedding.js");
    const { writeRenameTransactionMarker } = req("./memory/rename-entry.js");
    const { archiveProjectEntry, deleteProjectEntry, mergeProjectEntries, supersedeProjectEntry, writeProjectEntry, updateProjectEntry, writeAbrainWorkflow, writeAbrainAboutMe } = req("./sediment/writer.js");
    const { executeCuratorDecisionToBrain } = req("./sediment/curator-decision-writer.js");
    const { replayMultiviewPending } = req("./sediment/multiview-staging-replay.js");
    const { parseExplicitAboutMeBlocks, previewAboutMeExtraction } = req("./sediment/extractor.js");
    const { validateRouteDecision, applyStagingDowngrade, RouterError, LANE_G_ALLOWED_REGIONS, ROUTING_CONFIDENCE_THRESHOLD } = req("./sediment/about-me-router.js");
    // ADR 0021 G2 helpers (2026-05-20): parseAboutMeArgs / deriveAboutMeTitle /
    // buildAboutMeFence are exported from sediment/index.ts for the
    // /about-me slash. shouldAdvanceAfterAboutMeResults is internal; we
    // re-exercise its semantics through the writer in this smoke.
    const { parseAboutMeArgs, deriveAboutMeTitle, buildAboutMeFence } = req("./sediment/index.js");
    const { DEFAULT_SEDIMENT_SETTINGS } = req("./sediment/settings.js");
    const { knowledgeEvidenceEventPath, readKnowledgeProjectionStores, readKnowledgeStableViewStores } = req("./sediment/knowledge-evidence.js");
    // P2 fix (2026-05-14): smoke tests don't use real git repos, so disable
    // gitCommit by default. Tests that need git (migration tests) override
    // with gitCommit: true explicitly.
    DEFAULT_SEDIMENT_SETTINGS.gitCommit = false;
    const { buildRunWindow, saveCheckpoint, loadCheckpoint, loadSessionCheckpoint, saveSessionCheckpoint } = req("./sediment/checkpoint.js");
    const { detectProjectDuplicate } = req("./sediment/dedupe.js");
    const { parseExplicitMemoryBlocks } = req("./sediment/extractor.js");
    const { summarizeLlmExtractorResult } = req("./sediment/llm-extractor.js");
    const { sanitizeForMemory } = req("./sediment/sanitizer.js");
    const compactionTunerExt = req("./compaction-tuner/index.js").default;
    const { classifyDecision, DEFAULT_COMPACTION_TUNER_SETTINGS } = req("./compaction-tuner/index.js");
    const { resolveCompactionTunerSettings } = req("./compaction-tuner/settings.js");

    function gitCommitIfChanged(repo, paths, message) {
      const status = execFileSync("git", ["-C", repo, "status", "--porcelain", "--", ...paths], { encoding: "utf-8" });
      if (!status.trim()) return;
      execFileSync("git", ["-C", repo, "add", ...paths]);
      execFileSync("git", ["-C", repo, "commit", "-q", "-m", message]);
    }

    /**
     * Lightweight abrain target setup for sediment-writer fixtures that
     * don't need a full bind. Post-2026-05-13 cutover the writer requires
     * `abrainHome` + `projectId` in opts (no .pensieve fallback), so every
     * writeProjectEntry / updateProjectEntry / archiveProjectEntry / etc.
     * call must supply them. This helper creates an isolated abrain tmpdir
     * with an empty `projects/<projectId>/` shell — enough for the writer
     * to materialize the kind/status dir and land the entry. It does NOT
     * write `_project.json` or a project-side `.abrain-project.json`
     * because the writer itself doesn't read those (binding is the
     * caller's responsibility in production via sediment/index.ts).
     */
    function setupAbrainTarget(projectId = "smoke-fixture") {
      const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-abrain-"));
      fs.mkdirSync(path.join(abrainHome, "projects", projectId), { recursive: true });
      return { abrainHome, projectId };
    }

    async function bindMigrationProject(projectRoot, abrainHome, projectId) {
      await bindAbrainProject({
        abrainHome,
        cwd: projectRoot,
        projectId,
        now: "2026-05-12T10:00:00.000+08:00",
      });
      gitCommitIfChanged(projectRoot, [".abrain-project.json"], `bind ${projectId}`);
      const gitignorePath = path.join(abrainHome, ".gitignore");
      const existingGitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf-8") : "";
      if (!/(^|\n)\.state\/(\n|$)/.test(existingGitignore)) {
        fs.writeFileSync(gitignorePath, `${existingGitignore}${existingGitignore && !existingGitignore.endsWith("\n") ? "\n" : ""}.state/\n`);
      }
      gitCommitIfChanged(abrainHome, [".gitignore", path.join("projects", projectId, "_project.json")], `bind ${projectId}`);
    }

    const tools = new Map();
    const commands = new Map();
    // The fake `pi` mock has historically only stubbed the methods each
    // extension actually used at load time. As of pi-astack adding
    // before_agent_start injectors to memory + sediment, every extension
    // now expects `pi.on()` to exist (memory previously only needed
    // registerTool+registerCommand). Capture handlers per event so the
    // injection assertions below can drive them directly.
    const hookHandlers = { memory: new Map(), sediment: new Map(), compactionTuner: new Map() };
    const makePi = (slot, withRegisterTool) => {
      const pi = {
        registerCommand(n, o) { commands.set(n, o); },
        on(event, handler) {
          if (!hookHandlers[slot].has(event)) hookHandlers[slot].set(event, []);
          hookHandlers[slot].get(event).push(handler);
        },
      };
      if (withRegisterTool) pi.registerTool = (t) => tools.set(t.name, t);
      return pi;
    };
    memoryExt(makePi("memory", true));
    sedimentExt(makePi("sediment", false));
    compactionTunerExt(makePi("compactionTuner", false));
    // memory_search / memory_get / memory_list / memory_decide / memory_activity
    // (memory_decide added by ADR 0026 P0a; memory_neighbors removed 2026-06-16
    //  as an unused read tool — vector search covers related-entry recall; 5 → 4;
    //  memory_activity added by the activity/attention L2 on-demand reader,
    //  4 → 5 — bump this count when the tool set changes again).
    assert(tools.size === 5, `expected 5 memory tools, got ${tools.size}`);
    for (const name of ["memory_search", "memory_get", "memory_list", "memory_decide", "memory_activity"]) {
      assert(tools.has(name), `missing tool: ${name}`);
    }
    assert(commands.has("memory") && commands.has("sediment") && commands.has("compaction-tuner"), "expected memory, sediment, and compaction-tuner commands");

    // === before_agent_start system-prompt injection contract ===
    // memory + sediment moved their LLM-facing guidance out of the user's
    // AGENTS.md into native before_agent_start injectors. Lock the
    // contract here so a future refactor doesn't silently drop the
    // injection or the idempotency check.
    {
      const sedimentHandlers = hookHandlers.sediment.get("before_agent_start") ?? [];
      const memoryHandlers = hookHandlers.memory.get("before_agent_start") ?? [];
      assert(sedimentHandlers.length === 1, `sediment must register exactly 1 before_agent_start handler, got ${sedimentHandlers.length}`);
      // memory registers TWO INJECTOR handlers (ADR 0026 path A, 2026-05-28):
      // the memory-footnote protocol injector, then the path-A relevant-memory
      // context injector — kept separate because their idempotency markers
      // differ and pi chains return values from all before_agent_start handlers.
      // Stage 1 (2026-05-29, hardened): memory ALSO calls
      // bindCausalAnchorLifecycle(pi) at activate top, which ALWAYS registers
      // the causal-anchor turn-bump before_agent_start handler (bindLifecycle
      // registers on every call — the old first-only registration guard was
      // removed; idempotency is now per-turn at fire time). So in this
      // dispatch-less smoke memory's before_agent_start handlers are
      // [bump, footnote, pathA]. Either way the two injector handlers are the
      // LAST two registered, so locate them via slice(-2) rather than a fixed
      // index that the bump prefix would shift.
      assert(
        memoryHandlers.length === 2 || memoryHandlers.length === 3,
        `memory must register the 2 injector handlers (+ optional causal-anchor bump) = 2 or 3 before_agent_start handlers, got ${memoryHandlers.length}`,
      );
      const [footnoteHandler, pathAHandler] = memoryHandlers.slice(-2);

      // First call appends; second call must short-circuit on the marker.
      const sedMarker = "<!-- pi-astack/sediment: main-session read-only contract -->";
      const memMarker = "<!-- pi-astack/memory: memory-footnote protocol -->";
      const seed = "BASE-SYSTEM-PROMPT";
      const sedFirst = await sedimentHandlers[0]({ systemPrompt: seed });
      assert(sedFirst && typeof sedFirst.systemPrompt === "string", "sediment injector first call must return { systemPrompt }");
      assert(sedFirst.systemPrompt.startsWith(seed), "sediment injector must APPEND to existing prompt, not replace");
      assert(sedFirst.systemPrompt.includes(sedMarker), `sediment injection missing marker: ${sedFirst.systemPrompt.slice(-200)}`);
      assert(sedFirst.systemPrompt.includes("主会话只读不写"), "sediment injection missing core rule heading");
      assert(!sedFirst.systemPrompt.includes("gbrain"), "sediment injection must not mention retired gbrain tool");
      assert(!sedFirst.systemPrompt.includes(".pensieve/"), "sediment injection must not reference legacy .pensieve location");
      assert(!sedFirst.systemPrompt.includes("/about-me") && !sedFirst.systemPrompt.includes("MEMORY-ABOUT-ME"), "sediment main-session prompt must not enumerate explicit brain-management entry names");
      const sedSecond = await sedimentHandlers[0]({ systemPrompt: sedFirst.systemPrompt });
      assert(sedSecond === undefined, "sediment injector must be idempotent (return undefined when marker already present)");

      const memFirst = await footnoteHandler({ systemPrompt: seed });
      assert(memFirst && typeof memFirst.systemPrompt === "string", "memory injector first call must return { systemPrompt }");
      assert(memFirst.systemPrompt.includes(memMarker), `memory injection missing marker: ${memFirst.systemPrompt.slice(-200)}`);
      assert(memFirst.systemPrompt.includes("memory-footnote"), "memory injection must include the protocol name 'memory-footnote'");
      assert(memFirst.systemPrompt.includes("protocol_version: memory-footnote-v1"), "memory-footnote protocol injection must carry a version marker");
      assert(!memFirst.systemPrompt.includes("隐藏 fenced block"), "memory-footnote prompt must not claim the visible block is hidden");
      assert(memFirst.systemPrompt.includes("允许用户感知第二大脑"), "memory-footnote prompt should frame visible participation as positive feedback");
      assert(memFirst.systemPrompt.includes("retrieved-unused") && memFirst.systemPrompt.includes("不要静默省略"), "memory-footnote prompt must capture retrieved-but-unused entries instead of positive-only self-reports");
      assert(memFirst.systemPrompt.includes("decisive") && memFirst.systemPrompt.includes("confirmatory") && memFirst.systemPrompt.includes("retrieved-unused"), "memory injection must enumerate the used taxonomy");
      assert(memFirst.systemPrompt.includes("高价值决策时可拉取") && !memFirst.systemPrompt.includes("在遇到以下场景**之前**"), "memory_decide prompt must stay Path-B advisory, not pseudo Path-A mandatory trigger");
      const memSecond = await footnoteHandler({ systemPrompt: memFirst.systemPrompt });
      assert(memSecond === undefined, "memory injector must be idempotent (return undefined when marker already present)");

      // === path-A handler contract (handler[1]) ===
      // No modelRegistry / no sessionManager / empty prompt all yield
      // undefined return. With prompt set + no modelRegistry, injector
      // takes the skipped_no_model_registry path — still returns undefined
      // (no block to inject). Path A never throws, never returns invalid
      // shapes, and never bypasses INV-INVISIBILITY by surfacing errors.
      // pathAHandler located above via memoryHandlers.slice(-2).
      // Empty prompt → undefined (fast-path skip)
      assert(
        (await pathAHandler({ systemPrompt: seed, prompt: "" })) === undefined,
        "path-A handler with empty prompt must return undefined (fast-path)",
      );
      // No prompt field at all → undefined
      assert(
        (await pathAHandler({ systemPrompt: seed })) === undefined,
        "path-A handler with no prompt field must return undefined",
      );
      // Marker already present → undefined (idempotency)
      const PATH_A_MARKER = "<!-- pi-astack/memory: path-a relevant memory context (ADR 0026 §3.1 walk-back, 2026-05-28) -->";
      assert(
        (await pathAHandler({ systemPrompt: seed + "\n" + PATH_A_MARKER, prompt: "随便什么" })) === undefined,
        "path-A handler must respect its idempotency marker",
      );
      // With prompt + no modelRegistry → injector skips silently → undefined
      // (no block, but call still completes without throw)
      const pathAResult = await pathAHandler({ systemPrompt: seed, prompt: "用 React Router v6 还是 v7" }, {});
      assert(
        pathAResult === undefined,
        "path-A handler without modelRegistry must skip silently and return undefined",
      );
      const pathASource = fs.readFileSync(path.join(repoRoot, "extensions/memory/memory-context-injector.ts"), "utf-8");
      assert(pathASource.includes('source: "memory.before_agent_start"'), "path-A ledger rowBase must record the observability source");
      assert(pathASource.includes('rowBase.context = anchor ? "anchored_user_turn" : "no_causal_anchor"'), "path-A ledger context must be coarse anchor state, not raw prompt");
      assert(!/context:\s*userPrompt/.test(pathASource), "path-A ledger context must not store the raw user prompt");
    }

    // === classifier health meta-check ================================
    // ADR 0024 §5.3 / ADR 0025 §4.3: advisory-only quality degradation
    // detection over recent classifier reasoning traces.
    {
      const { summarizeClassifierHealth } = req("./sediment/health.js");
      const healthRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-health-"));
      const healthAudit = path.join(healthRoot, ".pi-astack", "sediment", "audit.jsonl");
      writeFile(healthAudit, [
        JSON.stringify({
          operation: "correction_classifier",
          signal: {
            user_quote: "use pnpm here",
            most_likely_error: "could be task-local because the quote only mentions this repo",
            reasoning_trace: {
              quote: 'User said "use pnpm here".',
              alternatives: "Could be durable, task-local, or NOT-A-CORRECTION.",
              self_critique: "If wrong, likely task-local because the quote says here.",
            },
          },
        }),
        JSON.stringify({ operation: "other_operation", signal: { reasoning_trace: { quote: "ignored" } } }),
      ].join("\n") + "\n");
      const healthy = summarizeClassifierHealth(healthRoot, { windowSize: 50, threshold: 0.4 });
      assert(healthy.ok === true, `healthy classifier trace should pass advisory check: ${JSON.stringify(healthy)}`);
      assert(healthy.sampleSize === 1, `classifier health should count only correction_classifier rows with traces: ${JSON.stringify(healthy)}`);
      assert(healthy.quoteRate === 1 && healthy.alternativeRate === 1 && healthy.concreteSelfCritiqueRate === 1, `healthy classifier rates mismatch: ${JSON.stringify(healthy)}`);

      writeFile(healthAudit, [
        JSON.stringify({ operation: "correction_classifier", signal: { reasoning_trace: { summary: "Looks good." } } }),
        JSON.stringify({ operation: "correction_classifier", signal: { reasoning_trace: { summary: "Probably fine." } } }),
      ].join("\n") + "\n");
      const degraded = summarizeClassifierHealth(healthRoot, { windowSize: 50, threshold: 0.4 });
      assert(degraded.ok === false, `degraded classifier traces should produce advisory flags: ${JSON.stringify(degraded)}`);
      assert(degraded.advisories.some((item) => item.includes("quote rate")), `degraded classifier health should flag quote rate: ${JSON.stringify(degraded)}`);
      assert(degraded.advisories.some((item) => item.includes("alternative mention rate")), `degraded classifier health should flag alternative rate: ${JSON.stringify(degraded)}`);
      assert(degraded.advisories.some((item) => item.includes("self-critique rate")), `degraded classifier health should flag self-critique rate: ${JSON.stringify(degraded)}`);

      writeFile(healthAudit, [
        JSON.stringify({ operation: "correction_classifier", signal: null }),
        JSON.stringify({ operation: "correction_classifier", signal: { signal_found: true } }),
      ].join("\n") + "\n");
      const missingTrace = summarizeClassifierHealth(healthRoot, { windowSize: 50, threshold: 0.4 });
      assert(missingTrace.ok === false, `classifier rows without reasoning_trace must be unhealthy, not suppressed: ${JSON.stringify(missingTrace)}`);
      assert(missingTrace.classifierRowCount === 2 && missingTrace.sampleSize === 0, `missing-trace health counts mismatch: ${JSON.stringify(missingTrace)}`);
      assert(missingTrace.advisories.some((item) => item.includes("No classifier reasoning traces")), `missing-trace health should explain parser/schema drift risk: ${JSON.stringify(missingTrace)}`);
    }

    // === sediment aggregator skeptical-historian MVP ==================
    // ADR 0025 §4.3: deterministic advisory aggregation over audit,
    // outcome-ledger, staging, search metrics, and classifier health. It
    // must never gate writes or require user management.
    {
      const { runSedimentAggregator, runAndWriteSedimentAggregator, runAndWriteSedimentAggregatorIfDue, aggregatorLedgerPath } = req("./sediment/aggregator.js");
      const { stagingDir } = req("./sediment/staging-loader.js");
      const aggRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-aggregator-"));
      const aggAbrain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-aggregator-abrain-"));
      const prevAbrainRoot = process.env.ABRAIN_ROOT;
      try {
        process.env.ABRAIN_ROOT = aggAbrain;
        const now = new Date("2026-05-25T12:00:00.000Z");
        const recent = (daysAgo) => new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
        writeFile(path.join(aggRoot, ".pi-astack", "sediment", "audit.jsonl"), [
          JSON.stringify({ timestamp: recent(1), operation: "correction_classifier", ok: false, reason: "classifier_unparseable", signal: { reasoning_trace: { summary: "Looks good." } } }),
          JSON.stringify({ timestamp: recent(2), operation: "skip", reason: "llm_extraction_error", error: "provider down" }),
          "{corrupt audit row",
        ].join("\n") + "\n");
        writeFile(path.join(aggRoot, ".pi-astack", "memory", "search-metrics.jsonl"), [
          JSON.stringify({ ts: recent(1), query: "x", results: 0 }),
          JSON.stringify({ ts: recent(2), query: "y", results: 2 }),
        ].join("\n") + "\n");
        writeFile(path.join(aggAbrain, ".state", "sediment", "outcome-ledger.jsonl"), [
          JSON.stringify({ ts: recent(1), session_id: "s1", entry_slug: "stale-entry", source: "memory-footnote", used: "retrieved-unused", counterfactual: "not relevant", retrieval_count: 1, project_root: aggRoot }),
          JSON.stringify({ ts: recent(2), session_id: "s2", entry_slug: "stale-entry", source: "memory-footnote", used: "retrieved-unused", counterfactual: "not relevant", retrieval_count: 1, project_root: aggRoot }),
          JSON.stringify({ ts: recent(3), session_id: "s3", entry_slug: "stale-entry", source: "memory-footnote", used: "retrieved-unused", counterfactual: "not relevant", retrieval_count: 1, project_root: aggRoot }),
          JSON.stringify({ ts: recent(4), session_id: "s4", entry_slug: "echo-entry", source: "memory-footnote", used: "decisive", counterfactual: "changed", retrieval_count: 1, project_root: aggRoot }),
          JSON.stringify({ ts: recent(5), session_id: "s5", entry_slug: "echo-entry", source: "memory-footnote", used: "decisive", counterfactual: "changed", retrieval_count: 1, project_root: aggRoot }),
          JSON.stringify({ ts: recent(6), session_id: "s6", entry_slug: "echo-entry", source: "memory-footnote", used: "decisive", counterfactual: "changed", retrieval_count: 1, project_root: aggRoot }),
          JSON.stringify({ ts: recent(7), session_id: "s7", entry_slug: "echo-entry", source: "memory-footnote", used: "decisive", counterfactual: "changed", retrieval_count: 1, project_root: aggRoot }),
          JSON.stringify({ ts: recent(8), session_id: "s8", entry_slug: "echo-entry", source: "memory-footnote", used: "decisive", counterfactual: "changed", retrieval_count: 1, project_root: aggRoot }),
          JSON.stringify({ ts: recent(0), session_id: "s-injected", entry_slug: "injected-only-entry", source: "path-a-injected", path_a_signal: "injection-only", path_a_inject_id: "agg-injected", retrieval_count: 0, project_root: aggRoot }),
          JSON.stringify({ ts: recent(1), session_id: "other-project", entry_slug: "foreign-entry", source: "memory-footnote", used: "retrieved-unused", counterfactual: "foreign", retrieval_count: 1, project_root: path.join(aggRoot, "other") }),
        ].join("\n") + "\n");
        const aggStagingDir = stagingDir();
        writeFile(path.join(aggStagingDir, "2026-04-01T00-00-00-000Z-provisional-old.json"), JSON.stringify({
          schema_version: 1,
          entry: { slug: "provisional-old", status: "provisional", kind: "provisional-correction", created: "2026-04-01T00:00:00.000Z", attribution_pending: true, originating_device: "smoke", hypothesis: "old", source_utterance: [], suggested_resolution_paths: [], _provenance_warning: "test" },
        }));
        writeFile(path.join(aggStagingDir, "2026-05-24T00-00-00-000Z-multiview-pending-abc12345.json"), JSON.stringify({
          schema_version: 1,
          entry: { slug: "multiview-pending-abc12345", status: "provisional", kind: "multiview-pending", created: recent(1) },
        }));
        const summary = runSedimentAggregator({ projectRoot: aggRoot, settings: DEFAULT_SEDIMENT_SETTINGS, sessionId: "agg-session", now, auditRowLimit: 50, searchMetricsRowLimit: 50 });
        assert(summary.outcome.high_unused.some((x) => x.slug === "stale-entry"), `aggregator should flag high retrieved-unused entries: ${JSON.stringify(summary.outcome)}`);
        assert(!summary.outcome.high_unused.some((x) => x.slug === "foreign-entry"), `aggregator must not mix outcome rows from another project: ${JSON.stringify(summary.outcome)}`);
        assert(summary.outcome.echo_chamber_candidates.some((x) => x.slug === "echo-entry" && x.decisive_streak === 5), `aggregator should flag decisive echo streaks: ${JSON.stringify(summary.outcome)}`);
        assert(summary.outcome.slugs_seen === 2, `path-a-injected must not enter outcome slugs_seen: ${JSON.stringify(summary.outcome)}`);
        assert(summary.raw_distribution?.total_slugs === 2 && summary.raw_distribution?.non_flagged_slugs === 0, `path-a-injected must not enter raw distribution: ${JSON.stringify(summary.raw_distribution)}`);
        assert(!summary.outcome.high_unused.some((x) => x.slug === "injected-only-entry") && !summary.outcome.echo_chamber_candidates.some((x) => x.slug === "injected-only-entry"), `path-a-injected must not create outcome advisories: ${JSON.stringify(summary.outcome)}`);
        assert(summary.audit.error_like_count === 3, `aggregator should count current corrupt/error audit rows once, got: ${JSON.stringify(summary.audit)}`);
        assert(summary.staging.provisional_stale === 1, `aggregator should count stale provisional staging: ${JSON.stringify(summary.staging)}`);
        assert(summary.staging.multiview_pending === 1, `aggregator should count multiview pending files: ${JSON.stringify(summary.staging)}`);
        assert(summary.advisories.some((a) => a.kind === "classifier_health"), `aggregator should include classifier health advisory: ${JSON.stringify(summary.advisories)}`);
        assert(summary.advisories.some((a) => a.kind === "staging_backlog"), `aggregator should include staging advisory: ${JSON.stringify(summary.advisories)}`);
        assert(summary.advisories.some((a) => a.kind === "multiview_pending"), `aggregator should include multiview advisory: ${JSON.stringify(summary.advisories)}`);
        // Phase C cutover: runAndWriteSedimentAggregator is now async + accepts
        // optional modelRegistry. Test without modelRegistry = v0.2-only path.
        const written = await runAndWriteSedimentAggregator({ projectRoot: aggRoot, settings: DEFAULT_SEDIMENT_SETTINGS, sessionId: "agg-session", now, auditRowLimit: 50, searchMetricsRowLimit: 50 });
        assert(written.advisories.length === summary.advisories.length, "runAndWriteSedimentAggregator should return the same advisory summary shape");
        assert(written.prompt_native === undefined, "v0.2-only path should not produce prompt_native");
        assert(written.degraded_to_mechanical === undefined, "v0.2-only path should not be marked degraded (no LLM attempted)");
        const ledgerFile = aggregatorLedgerPath();
        const ledgerRows = fs.readFileSync(ledgerFile, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
        const lastLedger = ledgerRows[ledgerRows.length - 1];
        assert(lastLedger.prompt_version && lastLedger.prompt_version.aggregator, `aggregator ledger row should carry prompt_version: ${JSON.stringify(lastLedger)}`);
        assert(lastLedger.session_id === "agg-session", `aggregator ledger should preserve session id: ${JSON.stringify(lastLedger)}`);
        // Phase C cutover: runAndWriteSedimentAggregatorIfDue is now async.
        // P0-1 fix from 3-T0 round 2 review: must await both calls;
        // pre-fix code did `firstDue && secondDue === null` against Promise objects
        // (Promises are truthy → short-circuit → secondDue===null never evaluated
        // → due-gate behavior silently untested).
        const firstDue = await runAndWriteSedimentAggregatorIfDue({ projectRoot: aggRoot, settings: DEFAULT_SEDIMENT_SETTINGS, sessionId: "agg-session", now, minIntervalMs: 60_000, auditRowLimit: 50, searchMetricsRowLimit: 50 });
        const secondDue = await runAndWriteSedimentAggregatorIfDue({ projectRoot: aggRoot, settings: DEFAULT_SEDIMENT_SETTINGS, sessionId: "agg-session", now: new Date(now.getTime() + 1_000), minIntervalMs: 60_000, auditRowLimit: 50, searchMetricsRowLimit: 50 });
        assert(firstDue !== null, `aggregator due gate first call should run: got ${firstDue}`);
        assert(secondDue === null, `aggregator due gate second call should skip: got ${JSON.stringify(secondDue)}`);
        // Phase C cutover: test the degraded path with a failing modelRegistry mock.
        // Placed LAST so it doesn't pollute the ledger assertions above
        // (each runAndWriteSedimentAggregator appends a ledger row; the last
        // row determines what "lastLedger" reads).
        const failingRegistry = {
          find: () => undefined,
          getApiKeyAndHeaders: async () => ({ ok: false, error: "smoke mock no auth" }),
        };
        const writtenDegraded = await runAndWriteSedimentAggregator({
          projectRoot: aggRoot,
          settings: DEFAULT_SEDIMENT_SETTINGS,
          sessionId: "agg-session-degraded",
          now,
          auditRowLimit: 50,
          searchMetricsRowLimit: 50,
          modelRegistry: failingRegistry,
        });
        assert(writtenDegraded.degraded_to_mechanical === true, `degraded path should set degraded_to_mechanical true, got ${JSON.stringify(writtenDegraded.degraded_to_mechanical)}`);
        assert(writtenDegraded.prompt_native === undefined, "degraded path should not produce prompt_native");
        assert(typeof writtenDegraded.degraded_reason === "string" && writtenDegraded.degraded_reason.length > 0, `degraded path should include degraded_reason: ${writtenDegraded.degraded_reason}`);
        assert(writtenDegraded.advisories.length > 0 || written.advisories.length === 0, "degraded path should still produce mechanical advisories as fallback");
        // Phase C round-3 review (Opus P2): source-anchor assertion locking
        // the aggregator_engine three-state discriminator + degraded flags in
        // the index.ts audit row. Without this assertion, a future refactor
        // could silently drop the discriminator and degraded runs would again
        // become indistinguishable from v0.2-only runs in audit.jsonl.
        const indexSrc = fs.readFileSync(path.join(repoRoot, "extensions/sediment/index.ts"), "utf-8");
        const aggSection = indexSrc.slice(
          indexSrc.indexOf("aggregatorEngine"),
          indexSrc.indexOf("prompt_version: buildPromptVersionAudit(\"aggregator\""),
        );
        assert(aggSection.includes("\"prompt_native_v1\""), "audit row gate should reference prompt_native_v1 engine");
        assert(aggSection.includes("\"mechanical_v0_2_degraded\""), "audit row gate should reference mechanical_v0_2_degraded engine");
        assert(aggSection.includes("\"mechanical_v0_2_no_model_registry\""), "audit row gate should reference mechanical_v0_2_no_model_registry engine");
        assert(aggSection.includes("aggregator_engine: aggregatorEngine"), "audit row body should emit aggregator_engine discriminator");
        assert(aggSection.includes("llm_attempted: llmAttempted"), "audit row body should emit llm_attempted flag");
        assert(aggSection.includes("degraded_to_mechanical: !!summary.degraded_to_mechanical"), "audit row body should emit degraded_to_mechanical coerced boolean");
      } finally {
        if (prevAbrainRoot === undefined) delete process.env.ABRAIN_ROOT; else process.env.ABRAIN_ROOT = prevAbrainRoot;
      }
    }

    // === correction classifier dispatch safety ========================
    {
      const { _buildClassifierPromptForTests } = req("./sediment/correction-pipeline.js");
      const { _dispatchCorrectionSignalForTests, _resetAutoWriteStateForTests } = req("./sediment/index.js");
      const classifierPrompt = _buildClassifierPromptForTests({
        windowText: "user: 这条记忆不对",
        stagingContext: [],
        relatedEntries: [{
          slug: "prefer-pnpm",
          title: "Prefer pnpm",
          kind: "preference",
          status: "active",
          summary: "User prefers pnpm.",
          retrieval_low_confidence: true,
          retrieval_degraded: true,
          retrieval_verdict: "none",
        }],
      });
      assert(classifierPrompt.includes("retrieval-quality: verdict=none low_confidence=true degraded=true"), `classifier prompt must expose related-entry retrieval quality: ${classifierPrompt}`);
      assert(classifierPrompt.includes("stage2 found no confident match") && classifierPrompt.includes("prefer target_entry_slug=null"), `classifier prompt must instruct discounting low-confidence related entries: ${classifierPrompt}`);
      _resetAutoWriteStateForTests();
      const unknown = _dispatchCorrectionSignalForTests({ signal_found: true, confidence: 9, correction_intent: "unknown typed correction" });
      assert(unknown.forwarded === null, `unknown/missing correction typing must not reach curator: ${JSON.stringify(unknown)}`);
      assert(unknown.decision === "dropped_unknown_typing", `unknown typing should be audited as dropped_unknown_typing: ${JSON.stringify(unknown)}`);
      const durable = _dispatchCorrectionSignalForTests({ signal_found: true, typing: "durable", confidence: 9, correction_intent: "durable correction" }, { sessionId: "smoke-session", currentCurator: true });
      assert(durable.forwarded && durable.decision === "pending_multiview", `high-confidence durable correction should forward but require multiview audit: ${JSON.stringify(durable)}`);
      const durableNoCurator = _dispatchCorrectionSignalForTests({ signal_found: true, typing: "durable", confidence: 9, correction_intent: "durable correction" }, { sessionId: "smoke-session", currentCurator: false });
      assert(durableNoCurator.forwarded === null && durableNoCurator.decision === "stored_durable", `durable correction without a current curator should be stored, not falsely forwarded: ${JSON.stringify(durableNoCurator)}`);
      const taskLocal = _dispatchCorrectionSignalForTests({ signal_found: true, typing: "task-local", confidence: 6, correction_intent: "use yarn only for this PR" }, { sessionId: "smoke-session", currentCurator: true });
      assert(taskLocal.forwarded === null && taskLocal.decision === "stored_task_local", `task-local correction should stay audit-only and not current-curator forward: ${JSON.stringify(taskLocal)}`);
      const debug = _dispatchCorrectionSignalForTests({ signal_found: true, typing: "debug", confidence: 6, correction_intent: "X is broken" }, { sessionId: "smoke-session", currentCurator: true });
      assert(debug.forwarded === null && debug.decision === "dropped_debug", `debug correction must remain audit-only: ${JSON.stringify(debug)}`);
      const none = _dispatchCorrectionSignalForTests({ signal_found: false, reasoning: "ordinary task instruction" }, { sessionId: "smoke-session", currentCurator: true });
      assert(none.forwarded === null && none.decision === "no_signal", `signal_found=false should be no_signal: ${JSON.stringify(none)}`);
    }

    // === ADR 0025 sidecar staging respects ABRAIN_ROOT =================
    {
      const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-staging-"));
      const oldAbrainRoot = process.env.ABRAIN_ROOT;
      process.env.ABRAIN_ROOT = stagingRoot;
      try {
        const { writeStagingEntry, loadStagingContext, stagingFileCount, stagingDir } = req("./sediment/staging-loader.js");
        const { writeMultiviewPending, loadMultiviewPending, countMultiviewPending, deleteMultiviewPending, archiveMultiviewPending } = req("./sediment/multiview-staging-io.js");
        const expectedDir = path.join(stagingRoot, ".state", "sediment", "staging");
        assert(stagingDir() === expectedDir, `stagingDir should honor ABRAIN_ROOT: ${stagingDir()} vs ${expectedDir}`);
        writeStagingEntry({
          slug: "provisional-smoke",
          status: "provisional",
          kind: "provisional-correction",
          created: new Date().toISOString(),
          attribution_pending: true,
          originating_device: "smoke",
          hypothesis: "smoke provisional correction",
          source_utterance: [{ quote: "以后用 pnpm", context: "smoke", captured_at: new Date().toISOString() }],
          suggested_resolution_paths: ["smoke"],
          correction_signal: { typing: "durable", confidence: 7, scope_description: "smoke", correction_intent: "new preference", most_likely_error_direction: "task-local" },
          _provenance_warning: "smoke",
        });
        assert(stagingFileCount() === 1, `provisional staging count should use ABRAIN_ROOT dir`);
        const ctx = loadStagingContext();
        assert(ctx.entries.some((entry) => entry.slug === "provisional-smoke"), `loadStagingContext should see provisional entry under ABRAIN_ROOT: ${JSON.stringify(ctx)}`);
        writeMultiviewPending({
          slug: "multiview-pending-smoke",
          kind: "multiview-pending",
          created: new Date().toISOString(),
          updated: new Date().toISOString(),
          originating_device: "smoke",
          multiview_state: "reviewer_unavailable",
          retry_attempts: 0,
          trigger_reason: "create_high_confidence",
          proposer_decision: { op: "create", rationale: "smoke" },
          proposer_raw_text: "smoke",
          candidate_snapshot: { title: "Smoke", kind: "fact", status: "active", confidence: 8, compiledTruth: "Smoke candidate." },
          correction_signal: null,
          neighbor_slugs: [],
        });
        assert(countMultiviewPending() === 1, `multiview pending count should use ABRAIN_ROOT dir`);
        const pending = loadMultiviewPending();
        assert(pending.entries.length === 1 && pending.entries[0].slug === "multiview-pending-smoke", `loadMultiviewPending should see only multiview entry: ${JSON.stringify(pending)}`);
        assert(loadStagingContext().entries.some((entry) => entry.slug === "provisional-smoke"), `provisional loader should ignore multiview co-tenant and keep provisional`);
        assert(deleteMultiviewPending("multiview-pending-smoke") === true, `deleteMultiviewPending should delete from ABRAIN_ROOT dir`);

        // mechanical-guard cleanup R3/B1 (2026-06-06): archiveMultiviewPending
        // soft-archives (atomic rename -> abandoned/ subdir) instead of
        // deleting; the live loaders must skip the abandoned/ subdir so an
        // archived entry is preserved but never re-picked-up.
        writeMultiviewPending({
          slug: "multiview-pending-archive-smoke",
          kind: "multiview-pending",
          created: new Date().toISOString(),
          updated: new Date().toISOString(),
          originating_device: "smoke",
          multiview_state: "reviewer_unavailable",
          retry_attempts: 0,
          trigger_reason: "create_high_confidence",
          proposer_decision: { op: "create", rationale: "smoke" },
          proposer_raw_text: "smoke",
          candidate_snapshot: { title: "Archive Smoke", kind: "fact", status: "active", confidence: 8, compiledTruth: "Archive smoke candidate." },
          correction_signal: null,
          neighbor_slugs: [],
        });
        assert(countMultiviewPending() === 1, `archive smoke: live count should be 1 before archive`);
        assert(archiveMultiviewPending("multiview-pending-archive-smoke") === true, `archiveMultiviewPending should move the entry`);
        assert(countMultiviewPending() === 0, `archive smoke: live count should be 0 after archive (abandoned/ excluded)`);
        assert(!loadMultiviewPending().entries.some((e) => e.slug === "multiview-pending-archive-smoke"), `archived entry must not be re-picked-up by loadMultiviewPending`);
        const abandonedDir = path.join(stagingDir(), "abandoned");
        const archivedFiles = fs.existsSync(abandonedDir) ? fs.readdirSync(abandonedDir).filter((f) => f.endsWith("-multiview-pending-archive-smoke.json")) : [];
        assert(archivedFiles.length === 1, `archived file must be preserved under abandoned/, got ${JSON.stringify(archivedFiles)}`);
        assert(archiveMultiviewPending("multiview-pending-archive-smoke") === false, `second archive should be a no-op (already moved out of live dir)`);

        writeMultiviewPending({
          slug: "multiview-pending-origin-smoke",
          kind: "multiview-pending",
          status: "provisional",
          created: new Date().toISOString(),
          updated: new Date().toISOString(),
          origin_project_id: "origin-project",
          origin_project_root: "/tmp/origin-project-root",
          originating_device: "smoke",
          multiview_state: "reviewer_unavailable",
          retry_attempts: 0,
          trigger_reason: "create_high_confidence",
          proposer_decision: { op: "create", rationale: "smoke" },
          proposer_raw_text: "smoke",
          candidate_snapshot: { title: "Smoke Origin", kind: "fact", status: "active", confidence: 8, compiledTruth: "Smoke origin candidate." },
          correction_signal: null,
          neighbor_slugs: [],
        });
        const originEntry = loadMultiviewPending().entries.find((entry) => entry.slug === "multiview-pending-origin-smoke");
        assert(originEntry && originEntry.origin_project_id === "origin-project" && originEntry.origin_project_root === "/tmp/origin-project-root", `multiview pending origin fields must round-trip: ${JSON.stringify(originEntry)}`);
        assert(deleteMultiviewPending("multiview-pending-origin-smoke") === true, `origin smoke entry should delete cleanly`);
      } finally {
        if (oldAbrainRoot === undefined) delete process.env.ABRAIN_ROOT;
        else process.env.ABRAIN_ROOT = oldAbrainRoot;
      }
    }

    // === sediment agent_end strict-binding hook glue ===
    // This drives the actual pi.on('agent_end') handler rather than only
    // testing writer/migration substrates. It locks the B4.5 regression
    // fingerprint: bound subdir launches write unhealthy-stop audit at the
    // bound project root, while unbound launches emit project_not_bound and
    // never advance checkpoint.
    {
      const hookRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-hook-"));
      const hookOut = path.join(hookRoot, "compiled");
      transpileExtensions(hookOut);
      const fakeHome = path.join(hookRoot, "home");
      writeFile(path.join(fakeHome, ".pi", "agent", "pi-astack-settings.json"), JSON.stringify({
        canonicalGitRuntime: { enabled: false, mode: "local_convergence_v2" },
        sediment: { enabled: true, gitCommit: false, minWindowChars: 0, autoLlmWriteEnabled: false },
      }, null, 2));
      const hookAbrain = path.join(hookRoot, "abrain");
      fs.mkdirSync(path.join(hookAbrain, "projects"), { recursive: true });

      const oldHome = process.env.HOME;
      const oldAbrainRoot = process.env.ABRAIN_ROOT;
      try {
        process.env.HOME = fakeHome;
        process.env.ABRAIN_ROOT = hookAbrain;
        const hookReq = createRequire(path.join(hookOut, "runner.cjs"));
        const hookSedimentExt = hookReq("./sediment/index.js").default;
        const { bindAbrainProject: hookBindAbrainProject } = hookReq("./_shared/runtime.js");
        const hookHandlers = new Map();
        hookSedimentExt({ registerCommand() {}, on(name, handler) { hookHandlers.set(name, handler); } });
        const agentEnd = hookHandlers.get("agent_end");
        assert(typeof agentEnd === "function", "sediment extension must register agent_end handler");

        const boundRoot = path.join(hookRoot, "bound-project");
        fs.mkdirSync(path.join(boundRoot, "subdir"), { recursive: true });
        execFileSync("git", ["-C", boundRoot, "init", "-q"]);
        await hookBindAbrainProject({
          abrainHome: hookAbrain,
          cwd: boundRoot,
          projectId: "hook-bound",
          now: "2026-05-12T10:00:00.000+08:00",
        });
        const boundSessionFile = path.join(hookRoot, "sessions", "bound.jsonl");
        writeFile(boundSessionFile, "{}\n");
        const boundStatuses = [];
        const boundBranch = [
          {
            id: "b-user-1",
            type: "message",
            timestamp: "2026-05-12T10:00:00.000+08:00",
            message: { role: "user", content: [{ type: "text", text: "hello" }] },
          },
        ];
        await agentEnd(
          { messages: [{ role: "assistant", stopReason: "aborted", errorMessage: "user aborted" }] },
          {
            cwd: path.join(boundRoot, "subdir"),
            sessionManager: {
              getBranch: () => boundBranch,
              getSessionId: () => "hook-bound-session",
              getSessionFile: () => boundSessionFile,
            },
            ui: { notify() {}, setStatus(_key, msg) { boundStatuses.push(msg); } },
          },
        );
        const boundAudit = path.join(boundRoot, ".pi-astack", "sediment", "audit.jsonl");
        const boundSubAudit = path.join(boundRoot, "subdir", ".pi-astack", "sediment", "audit.jsonl");
        assert(fs.existsSync(boundAudit), `bound unhealthy audit must land at project root: ${boundAudit}`);
        assert(!fs.existsSync(boundSubAudit), `bound unhealthy audit must not land in launch subdir: ${boundSubAudit}`);
        let boundRows = fs.readFileSync(boundAudit, "utf-8").trim().split("\n").map(JSON.parse);
        const boundRow = boundRows.find((r) => r.reason === "agent_aborted");
        assert(boundRow, `bound unhealthy audit row missing: ${JSON.stringify(boundRows)}`);
        assert(boundRow.project_root === path.resolve(boundRoot), `bound audit project_root mismatch: ${boundRow.project_root}`);
        assert(boundRow.deferred === true && boundRow.recovery === "next_healthy_agent_end", `bound unhealthy stop must be marked deferred/recoverable: ${JSON.stringify(boundRow)}`);
        assert(boundRow.deferred_last_entry_id === "b-user-1", `bound deferred audit should record last branch entry id: ${JSON.stringify(boundRow)}`);
        assert(boundStatuses.some((msg) => /^⚠️\s+sediment: deferred — agent aborted; will retry after next healthy turn/.test(String(msg))), `bound unhealthy stop footer must say deferred/retry, not generic failure: ${JSON.stringify(boundStatuses)}`);
        assert(!boundStatuses.some((msg) => /^✅\s+sediment:/.test(String(msg))), `bound unhealthy stop footer must not show completed/✅: ${JSON.stringify(boundStatuses)}`);
        assert(boundRow.checkpoint_advanced === false, `bound unhealthy stop must not advance checkpoint`);
        assert(!fs.existsSync(path.join(boundRoot, ".pi-astack", "sediment", "checkpoint.json")), `bound unhealthy stop must not create checkpoint`);

        boundBranch.push({
          id: "b-user-2",
          type: "message",
          timestamp: "2026-05-12T10:01:00.000+08:00",
          message: { role: "user", content: [{ type: "text", text: "A healthy follow-up turn that lets sediment advance the held checkpoint without writing memory." }] },
        });
        await agentEnd(
          { messages: [{ role: "assistant", stopReason: "stop" }] },
          {
            cwd: path.join(boundRoot, "subdir"),
            sessionManager: {
              getBranch: () => boundBranch,
              getSessionId: () => "hook-bound-session",
              getSessionFile: () => boundSessionFile,
            },
            ui: { notify() {}, setStatus(_key, msg) { boundStatuses.push(msg); } },
          },
        );
        await hookReq("./sediment/index.js")._waitForAutoWriteIdleForTests();
        boundRows = fs.readFileSync(boundAudit, "utf-8").trim().split("\n").map(JSON.parse);
        const recoveredRow = boundRows.find((r) => r.operation === "deferred_recovered");
        assert(recoveredRow, `healthy follow-up must record deferred_recovered: ${JSON.stringify(boundRows)}`);
        assert(recoveredRow.previous_reason === "agent_aborted", `deferred_recovered previous_reason mismatch: ${JSON.stringify(recoveredRow)}`);
        assert(recoveredRow.recovered_last_entry_id === "b-user-2", `deferred_recovered should advance through healthy follow-up: ${JSON.stringify(recoveredRow)}`);
        const recoveryCarrier = boundRows.find((r) => r.recovered_deferred === true);
        assert(recoveryCarrier && recoveryCarrier.previous_deferred_reason === "agent_aborted", `primary healthy audit row must also flag recovered_deferred: ${JSON.stringify(boundRows)}`);
        const boundCheckpoint = JSON.parse(fs.readFileSync(path.join(boundRoot, ".pi-astack", "sediment", "checkpoint.json"), "utf-8"));
        assert(boundCheckpoint.sessions["hook-bound-session"]?.lastProcessedEntryId === "b-user-2", `healthy follow-up must advance checkpoint: ${JSON.stringify(boundCheckpoint)}`);

        const unboundRoot = path.join(hookRoot, "unbound-project");
        fs.mkdirSync(path.join(unboundRoot, "subdir"), { recursive: true });
        execFileSync("git", ["-C", unboundRoot, "init", "-q"]);
        const unboundSessionFile = path.join(hookRoot, "sessions", "unbound.jsonl");
        writeFile(unboundSessionFile, "{}\n");
        const unboundStatuses = [];
        await agentEnd(
          { messages: [{ role: "assistant", stopReason: "stop" }] },
          {
            cwd: path.join(unboundRoot, "subdir"),
            sessionManager: {
              getBranch: () => [{ role: "user", content: "MEMORY: should not write" }],
              getSessionId: () => "hook-unbound-session",
              getSessionFile: () => unboundSessionFile,
            },
            ui: { notify() {}, setStatus(_key, msg) { unboundStatuses.push(msg); } },
          },
        );
        const unboundAudit = path.join(unboundRoot, "subdir", ".pi-astack", "sediment", "audit.jsonl");
        assert(fs.existsSync(unboundAudit), `unbound audit must be visible at launch cwd: ${unboundAudit}`);
        const unboundRows = fs.readFileSync(unboundAudit, "utf-8").trim().split("\n").map(JSON.parse);
        const unboundRow = unboundRows.find((r) => r.reason === "project_not_bound");
        assert(unboundRow, `unbound project_not_bound row missing: ${JSON.stringify(unboundRows)}`);
        assert(unboundRow.binding_status === "manifest_missing", `unbound binding_status mismatch: ${unboundRow.binding_status}`);
        assert(unboundStatuses.some((msg) => /^⚠️\s+sediment: project_not_bound:manifest_missing/.test(String(msg))), `unbound project_not_bound footer must be warning/failed, not completed: ${JSON.stringify(unboundStatuses)}`);
        assert(!unboundStatuses.some((msg) => /^✅\s+sediment: project_not_bound/.test(String(msg))), `unbound project_not_bound footer must not show completed/✅: ${JSON.stringify(unboundStatuses)}`);
        assert(unboundRow.checkpoint_advanced === false, `unbound project_not_bound must not advance checkpoint`);
        assert(!fs.existsSync(path.join(unboundRoot, "subdir", ".pi-astack", "sediment", "checkpoint.json")), `unbound project_not_bound must not create checkpoint`);

        // === path_unconfirmed: manifest + registry exist, but local-map
        //     has not confirmed this physical path. ADR 0017: malicious
        //     repo cannot acquire project identity just by checking in a
        //     forged `.abrain-project.json`; the user must `/abrain bind`
        //     locally so the absolute path lands in local-map.
        const unconfRoot = path.join(hookRoot, "unconfirmed-project");
        fs.mkdirSync(path.join(unconfRoot, "subdir"), { recursive: true });
        execFileSync("git", ["-C", unconfRoot, "init", "-q"]);
        // Stage a forged manifest claiming "hook-bound" (already in registry).
        writeFile(
          path.join(unconfRoot, ".abrain-project.json"),
          JSON.stringify({ schema_version: 1, project_id: "hook-bound" }, null, 2),
        );
        // Do NOT call hookBindAbrainProject — local-map stays untouched
        // (no entry maps to unconfRoot). resolveActiveProject should return
        // path_unconfirmed.
        const unconfSessionFile = path.join(hookRoot, "sessions", "unconfirmed.jsonl");
        writeFile(unconfSessionFile, "{}\n");
        await agentEnd(
          { messages: [{ role: "assistant", stopReason: "stop" }] },
          {
            cwd: path.join(unconfRoot, "subdir"),
            sessionManager: {
              getBranch: () => [{ role: "user", content: "MEMORY: should not write" }],
              getSessionId: () => "hook-unconf-session",
              getSessionFile: () => unconfSessionFile,
            },
            ui: { notify() {}, setStatus() {} },
          },
        );
        const unconfAudit = path.join(unconfRoot, "subdir", ".pi-astack", "sediment", "audit.jsonl");
        assert(fs.existsSync(unconfAudit), `path_unconfirmed audit must be visible at launch cwd: ${unconfAudit}`);
        const unconfRows = fs.readFileSync(unconfAudit, "utf-8").trim().split("\n").filter(Boolean).map(JSON.parse);
        const unconfRow = unconfRows.find((r) => r.reason === "project_not_bound");
        assert(unconfRow, `path_unconfirmed must emit project_not_bound row, got: ${JSON.stringify(unconfRows)}`);
        assert(
          unconfRow.binding_status === "path_unconfirmed",
          `path_unconfirmed audit row binding_status must be 'path_unconfirmed', got: ${unconfRow.binding_status}`,
        );
        assert(unconfRow.checkpoint_advanced === false, `path_unconfirmed must not advance checkpoint`);
        assert(!fs.existsSync(path.join(unconfRoot, "subdir", ".pi-astack", "sediment", "checkpoint.json")), `path_unconfirmed must not create checkpoint`);

        // === registry_missing: manifest claims a projectId not present in
        //     abrain's projects/<id>/_project.json. Probably a stale
        //     manifest after the operator deleted the abrain project.
        const noregRoot = path.join(hookRoot, "noreg-project");
        fs.mkdirSync(path.join(noregRoot, "subdir"), { recursive: true });
        execFileSync("git", ["-C", noregRoot, "init", "-q"]);
        writeFile(
          path.join(noregRoot, ".abrain-project.json"),
          JSON.stringify({ schema_version: 1, project_id: "never-registered" }, null, 2),
        );
        const noregSessionFile = path.join(hookRoot, "sessions", "noreg.jsonl");
        writeFile(noregSessionFile, "{}\n");
        await agentEnd(
          { messages: [{ role: "assistant", stopReason: "stop" }] },
          {
            cwd: path.join(noregRoot, "subdir"),
            sessionManager: {
              getBranch: () => [{ role: "user", content: "MEMORY: should not write" }],
              getSessionId: () => "hook-noreg-session",
              getSessionFile: () => noregSessionFile,
            },
            ui: { notify() {}, setStatus() {} },
          },
        );
        const noregAudit = path.join(noregRoot, "subdir", ".pi-astack", "sediment", "audit.jsonl");
        assert(fs.existsSync(noregAudit), `registry_missing audit must be visible at launch cwd: ${noregAudit}`);
        const noregRows = fs.readFileSync(noregAudit, "utf-8").trim().split("\n").filter(Boolean).map(JSON.parse);
        const noregRow = noregRows.find((r) => r.reason === "project_not_bound");
        assert(noregRow, `registry_missing must emit project_not_bound row, got: ${JSON.stringify(noregRows)}`);
        assert(
          noregRow.binding_status === "registry_missing",
          `registry_missing audit row binding_status must be 'registry_missing', got: ${noregRow.binding_status}`,
        );
        assert(noregRow.checkpoint_advanced === false, `registry_missing must not advance checkpoint`);
        assert(!fs.existsSync(path.join(noregRoot, "subdir", ".pi-astack", "sediment", "checkpoint.json")), `registry_missing must not create checkpoint`);
      } finally {
        if (oldHome === undefined) delete process.env.HOME;
        else process.env.HOME = oldHome;
        if (oldAbrainRoot === undefined) delete process.env.ABRAIN_ROOT;
        else process.env.ABRAIN_ROOT = oldAbrainRoot;
      }
    }

    // === compaction-tuner: settings parsing + decision logic ===
    {
      // Defaults
      const def = DEFAULT_COMPACTION_TUNER_SETTINGS;
      assert(def.enabled === false, "compaction-tuner default enabled must be false (opt-in)");
      assert(def.thresholdPercent === 75, "compaction-tuner default thresholdPercent must be 75");

      // classifyDecision: percent null -> skip
      assert(classifyDecision(null, 75, true, 5).decision === "skip", "null percent must skip");

      // Below threshold while armed: skip with reason below_threshold
      assert(classifyDecision(50, 75, true, 5).decision === "skip", "50% with threshold 75 must skip");

      // At/above threshold while armed: trigger
      assert(classifyDecision(75, 75, true, 5).decision === "trigger", "exactly threshold must trigger");
      assert(classifyDecision(80, 75, true, 5).decision === "trigger", "above threshold must trigger");

      // Above threshold but disarmed (already triggered, still hot): skip
      // with reason that distinguishes "already triggered" from below-threshold.
      const aboveDisarmed = classifyDecision(80, 75, false, 5);
      assert(aboveDisarmed.decision === "skip" && aboveDisarmed.reason === "already_triggered_awaiting_rearm",
        `disarmed at 80 must skip with awaiting_rearm, got ${JSON.stringify(aboveDisarmed)}`);

      // In-between band (threshold-margin <= percent < threshold) while disarmed:
      // skip with reason "below_threshold" (rearm only fires when usage drops
      // BELOW the floor, otherwise we hover indefinitely).
      const inBand = classifyDecision(72, 75, false, 5);
      assert(inBand.decision === "skip" && inBand.reason === "below_threshold",
        `72%/threshold75/disarmed should skip with below_threshold, got ${JSON.stringify(inBand)}`);

      // Below rearm floor while disarmed: rearm
      assert(classifyDecision(69, 75, false, 5).decision === "rearm", "below rearm floor (75-5=70) must rearm");
      assert(classifyDecision(50, 75, false, 5).decision === "rearm", "way below threshold while disarmed must rearm");

      // Settings clamping: out-of-range thresholdPercent should be clamped
      // (driven via env-pointed settings file).
      const tunerSettingsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-tuner-"));
      const tunerSettingsPath = path.join(tunerSettingsRoot, "pi-astack-settings.json");
      const HOME = os.homedir();
      const fakeHome = path.join(tunerSettingsRoot, "home");
      fs.mkdirSync(path.join(fakeHome, ".pi", "agent"), { recursive: true });
      fs.writeFileSync(
        path.join(fakeHome, ".pi", "agent", "pi-astack-settings.json"),
        JSON.stringify({
          compactionTuner: {
            enabled: true,
            thresholdPercent: 200,    // out of range, must clamp to 95
            rearmMarginPercent: -3,    // negative, must clamp to 0
            customInstructions: "keep memory architecture details",
          },
        }),
      );
      const origHome = process.env.HOME;
      process.env.HOME = fakeHome;
      // settings.ts reads os.homedir() at call time only inside the function body via
      // path.join(os.homedir(), ...). require'd module re-evaluates os.homedir() each
      // call to loadPiStackSettings() because the path is computed inside fsSync.readFile.
      // BUT our settings.ts captures PI_STACK_SETTINGS_PATH at module load time as a
      // const — so we must re-load via fresh require (delete cache).
      const settingsModulePath = require.resolve(path.join(outRoot, "compaction-tuner", "settings.js"));
      delete require.cache[settingsModulePath];
      const { resolveCompactionTunerSettings: freshResolve } = req("./compaction-tuner/settings.js");
      const clamped = freshResolve();
      assert(clamped.enabled === true, "settings file should yield enabled=true");
      assert(clamped.thresholdPercent === 95, `out-of-range thresholdPercent must clamp to 95, got ${clamped.thresholdPercent}`);
      assert(clamped.rearmMarginPercent === 0, `negative rearmMarginPercent must clamp to 0, got ${clamped.rearmMarginPercent}`);
      assert(clamped.customInstructions === "keep memory architecture details", "customInstructions must round-trip");
      process.env.HOME = origHome;
      // restore caches for any later tests
      delete require.cache[settingsModulePath];
    }

    const fm = splitFrontmatter("---\ntitle: EOF\n---");
    assert(fm.frontmatterText.trim() === "title: EOF" && fm.body === "", "EOF frontmatter parse failed");

    const valid = makeEntry({ title: "Alpha" });
    assert(lintMarkdown(valid).length === 0, "valid entry should lint cleanly");

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-project-"));
    const memorySmokeAbrainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-memory-abrain-"));
    fs.mkdirSync(path.join(root, ".pensieve", "knowledge"), { recursive: true });
    fs.mkdirSync(path.join(root, ".pensieve", "staging"), { recursive: true });
    writeFile(path.join(root, ".pensieve", "knowledge", "alpha.md"), makeEntry({ title: "Alpha Memory", body: "Dispatch prompt memory architecture facade." }));
    writeFile(path.join(root, ".pensieve", "staging", "beta.md"), makeEntry({ title: "Beta Smell", kind: "smell", status: "provisional", confidence: 2 }));

    const search = tools.get("memory_search");
    const decide = tools.get("memory_decide");
    const mockModelRegistry = {
      find(provider, id) {
        return {
          provider,
          id,
          reasoning: true,
          thinkingLevelMap: { off: "", high: "high", xhigh: "xhigh", minimal: null, low: null, medium: null },
        };
      },
      async getApiKeyAndHeaders() { return { ok: true, apiKey: "smoke-key" }; },
    };

    // memory tools wrap results in ToolResult envelope { content: [{ type, text }], isError? }
    // since commit 7f2b5d8 (fix(memory): wrap tool results in ToolResult shape).
    // smoke must unwrap to access the business payload (plain JSON array/object).
    // ADR 0015: memory_search has no grep degradation path; it requires LLM
    // modelRegistry and should return a hard error when modelRegistry is missing.
    const missingRegistryRaw = await search.execute("smoke-no-registry", search.prepareArguments({ query: "find memory about dispatch facade", limit: 2 }), new AbortController().signal, null, { cwd: root });
    assert(missingRegistryRaw.isError, `memory_search without modelRegistry must hard-error, got: ${JSON.stringify(missingRegistryRaw)}`);
    const missingRegistryPayload = JSON.parse(missingRegistryRaw.content[0].text);
    assert(String(missingRegistryPayload.error || "").includes("modelRegistry"), `missing-registry error should mention modelRegistry: ${JSON.stringify(missingRegistryPayload)}`);
    assert(String(missingRegistryPayload.hint || "").includes("does not degrade to grep"), `missing-registry hint should reject grep degradation: ${JSON.stringify(missingRegistryPayload)}`);

    const decideMissingRegistryRaw = await decide.execute("smoke-decide-no-registry", decide.prepareArguments({ context: "choosing package manager", options: ["pnpm", "yarn"] }), new AbortController().signal, null, { cwd: root });
    assert(decideMissingRegistryRaw.isError, `memory_decide retrieval failure must hard-error, not masquerade as no memories: ${JSON.stringify(decideMissingRegistryRaw)}`);
    const decideMissingRegistryPayload = JSON.parse(decideMissingRegistryRaw.content[0].text);
    assert(String(decideMissingRegistryPayload.error || "").includes("modelRegistry"), `memory_decide missing-registry error should mention modelRegistry: ${JSON.stringify(decideMissingRegistryPayload)}`);
    assert(String(decideMissingRegistryPayload.hint || "").includes("Do not infer absence"), `memory_decide retrieval failure hint should warn against absence inference: ${JSON.stringify(decideMissingRegistryPayload)}`);

    // ADR 0015 smoke: default memory_search path should call the two-stage LLM
    // reranker when a modelRegistry is available, and return the same normalized
    // ToolResult envelope shape.
    // ADR 0036 decoupling: the stage1+stage2 assertions below were authored
    // against the two-stage-LLM contract (stage1Skip=false). Production flipped
    // stage1Skip=true via the settings.json kill-switch, and memory/settings.ts
    // reads the live ~/.pi/agent/pi-astack-settings.json (os.homedir-pinned at
    // module load, no env override) — so without pinning here these assertions
    // would silently track the mutable kill-switch. memSettings is the SAME
    // cached module object index.ts imported, so overwriting resolveSettings
    // takes effect inside the search tool (CJS shared exports). Pin stage1Skip
    // explicitly to keep the test deterministic and independent of the live flag.
    const memSettings = req("./memory/settings.js");
    const sedimentSettings = req("./sediment/settings.js");
    const origResolveSettings = memSettings.resolveSettings;
    const origResolveSedimentSettings = sedimentSettings.resolveSedimentSettings;
    const previousAbrainRoot = process.env.ABRAIN_ROOT;
    process.env.ABRAIN_ROOT = memorySmokeAbrainRoot;
    sedimentSettings.resolveSedimentSettings = () => {
      const base = origResolveSedimentSettings();
      return { ...base, knowledgeProjector: { ...base.knowledgeProjector, canonicalReadMode: "legacy" } };
    };
    const pinStage1Skip = (skip) => {
      memSettings.resolveSettings = () => {
        const base = origResolveSettings();
        // Deterministic search profile for the LLM-rerank assertions below:
        // stage0 OFF (candidate surface = full_body_v3, matching the authored
        // stage1/stage2 metrics + prompt assertions; stage0 hybrid pooling is
        // covered by smoke:stage0-* ) and stage1Skip per the test path. Both are
        // pinned so this section is independent of the live settings.json flips.
        // The legacy read mode + isolated ABRAIN_ROOT keep this .pensieve fixture
        // independent of the production projection_only setting and corpus.
        return { ...base, includeWorld: false, search: { ...base.search, stage0Enabled: false, stage1Skip: skip } };
      };
    };
    pinStage1Skip(false);
    const llmSearchRaw = await search.execute("smoke-llm", search.prepareArguments({ query: "找关于 dispatch facade 的 memory entry", limit: 2 }), new AbortController().signal, null, { cwd: root, modelRegistry: mockModelRegistry });
    assert(!llmSearchRaw.isError, `memory_search LLM path returned isError envelope: ${JSON.stringify(llmSearchRaw)}`);
    assert(Array.isArray(llmSearchRaw?.content) && llmSearchRaw.content[0]?.type === "text", "memory_search envelope shape regressed (expected { content: [{type:'text', text}] })");
    const llmSearchRes = JSON.parse(llmSearchRaw.content[0].text);
    assert(Array.isArray(llmSearchRes) && llmSearchRes.length === 1 && llmSearchRes[0].slug === "alpha" && llmSearchRes[0].score === 1, `memory_search LLM path failed: ${JSON.stringify(llmSearchRes)}`);
    assert(llmSearchRes[0].degraded === undefined, "memory_search LLM result must not expose degraded flag when no degradation path exists");
    assert(llmSearchRes[0].created === "2026-05-08", "memory_search LLM result should expose created freshness signal");
    assert(Array.isArray(llmSearchRes[0].timeline_tail) && llmSearchRes[0].timeline_tail.length === 1, "memory_search LLM result should expose timeline_tail freshness signal");
    assert(llmSearchRes[0].rank_reason === "direct match", "memory_search LLM result should expose stage2 rank_reason");
    const piAiStub = req("@earendil-works/pi-ai");
    assert(JSON.stringify(piAiStub.__calls) === JSON.stringify(["memory-search-stage1", "memory-search-stage2"]), `memory_search should call stage1+stage2, got ${JSON.stringify(piAiStub.__calls)}`);
    assert(piAiStub.__prompts[0].includes("surface:full_body_v3"), "Stage 1 prompt must advertise full-body v3 candidate surface");
    assert(piAiStub.__prompts[0].includes("##### compiled_truth") && piAiStub.__prompts[0].includes("Dispatch prompt memory architecture facade."), "Stage 1 prompt must include entry compiled_truth body");
    assert(piAiStub.__prompts[0].includes("##### timeline") && piAiStub.__prompts[0].includes("2026-05-08 | smoke | captured | ok"), "Stage 1 prompt must include entry timeline");
    // ADR 0015 D3 (2026-05-11 modification): Stage 2 reasoning lowered from
    // "high" to "off" — rerank is reading comprehension + relevance judgment,
    // not a reasoning task. settings.ts default was updated in commit 4b4432f
    // but this smoke assertion was missed; now restored.
    //
    // 2026-05-24 update: when memory.search.stage*Thinking is "off", the
    // memory extension now OMITS the reasoning field entirely instead of
    // passing reasoning: "off" through to pi-ai. Rationale: pi-ai's
    // streamSimpleGoogle clamps "off" then forces effort to "high"
    // (silently turning thinking ON), and streamSimpleAnthropic treats
    // any truthy reasoning string as "thinking enabled" — only the
    // omitted-field path is uniformly interpreted as thinking disabled
    // across all providers. See extensions/memory/llm-search.ts for the
    // full rationale. The smoke assertion correspondingly checks that the
    // reasoning field is ABSENT, which is the semantic equivalent of
    // "thinking off" for the pi-ai SimpleStreamOptions surface.
    assert(
      piAiStub.__configs[0]?.reasoning === undefined && piAiStub.__configs[1]?.reasoning === undefined,
      `memory_search thinking config mismatch (expected both stages to OMIT reasoning field when settings.stage*Thinking is "off" per 2026-05-24 fix): ${JSON.stringify(piAiStub.__configs)}`,
    );

    // ADR 0036 two-stage collapse: with stage1Skip=true (production default via
    // the settings.json kill-switch) stage1 LLM is skipped and stage0 top-K feeds
    // stage2 directly — exactly ONE LLM call (stage2), no full-body candidate
    // surface. Verify the inverse of the assertions above in an isolated block,
    // restoring stub arrays + pin afterwards so downstream tests are unaffected.
    {
      const savedCalls = piAiStub.__calls, savedPrompts = piAiStub.__prompts, savedConfigs = piAiStub.__configs;
      piAiStub.__calls = []; piAiStub.__prompts = []; piAiStub.__configs = [];
      pinStage1Skip(true);
      const collapseRaw = await search.execute("smoke-collapse", search.prepareArguments({ query: "找关于 dispatch facade 的 memory entry", limit: 2 }), new AbortController().signal, null, { cwd: root, modelRegistry: mockModelRegistry });
      assert(!collapseRaw.isError, `stage1Skip=true path returned isError envelope: ${JSON.stringify(collapseRaw)}`);
      assert(JSON.stringify(piAiStub.__calls) === JSON.stringify(["memory-search-stage2"]), `stage1Skip=true must collapse to stage2-only, got ${JSON.stringify(piAiStub.__calls)}`);
      assert(!piAiStub.__prompts.some((p) => p.includes("surface:full_body_v3")), "stage1Skip=true must not emit the stage1 full-body candidate surface");
      const collapseRes = JSON.parse(collapseRaw.content[0].text);
      assert(Array.isArray(collapseRes) && collapseRes[0]?.slug === "alpha", `stage1Skip=true result should still rank alpha first: ${JSON.stringify(collapseRes)}`);
      pinStage1Skip(false);
      piAiStub.__calls = savedCalls; piAiStub.__prompts = savedPrompts; piAiStub.__configs = savedConfigs;
    }

    // Metrics logs must store the sanitized query, not raw credential-like
    // text pasted into memory_search.
    const searchToken = "ghp_" + "1234567890abcdefghijklmnopqrstuv";
    const secretQueryRaw = await search.execute("smoke-llm-secret-query", search.prepareArguments({ query: `find memory about ${searchToken}`, limit: 2 }), new AbortController().signal, null, { cwd: root, modelRegistry: mockModelRegistry });
    assert(!secretQueryRaw.isError, `memory_search secret-query smoke returned error: ${JSON.stringify(secretQueryRaw)}`);
    const secretSearchPrompts = piAiStub.__prompts.slice(-2).join("\n");
    assert(
      secretSearchPrompts.includes("[SECRET:github_token]") && !secretSearchPrompts.includes(searchToken),
      "memory_search LLM prompts must contain placeholder and not raw query credential",
    );
    const metricsPath = path.join(root, ".pi-astack", "memory", "search-metrics.jsonl");
    const metricLines = fs.readFileSync(metricsPath, "utf-8").trim().split(/\n/);
    const lastMetric = JSON.parse(metricLines[metricLines.length - 1]);
    assert(
      String(lastMetric.query).includes("[SECRET:github_token]") && !String(lastMetric.query).includes(searchToken),
      `memory_search metrics query must redact raw token: ${JSON.stringify(lastMetric)}`,
    );
    assert(lastMetric.stage1_surface === "full_body_v3", `memory_search metrics must record Stage 1 candidate surface for before/after comparison: ${JSON.stringify(lastMetric)}`);
    assert(typeof lastMetric.verdict === "string", `memory_search metrics must record stage2 verdict: ${JSON.stringify(lastMetric)}`);
    assert(lastMetric.search_profile === "toolSearch", `memory_search metrics must record caller profile: ${JSON.stringify(lastMetric)}`);
    assert(lastMetric.stage1_model && lastMetric.stage2_model && typeof lastMetric.stage1_skip === "boolean", `memory_search metrics must record model/skip context: ${JSON.stringify(lastMetric)}`);
    assert(typeof lastMetric.candidate_limit === "number" && lastMetric.candidate_limit >= 1, `memory_search metrics must record candidate_limit: ${JSON.stringify(lastMetric)}`);
    assert(typeof lastMetric.stage2_candidates === "number" && lastMetric.stage2_candidates >= 1, `memory_search metrics must record stage2 candidate count: ${JSON.stringify(lastMetric)}`);
    assert(typeof lastMetric.stage2_prompt_chars === "number" && lastMetric.stage2_prompt_chars > 0, `memory_search metrics must record stage2 prompt size: ${JSON.stringify(lastMetric)}`);
    assert(typeof lastMetric.stage2_prompt_tokens_est === "number" && lastMetric.stage2_prompt_tokens_est > 0, `memory_search metrics must record stage2 token-ish size: ${JSON.stringify(lastMetric)}`);
    assert(lastMetric.retry_count === 0 && lastMetric.retry_phase === "none" && lastMetric.backoff_applied === false, `success metric must record retry observability fields: ${JSON.stringify(lastMetric)}`);
    assert(lastMetric.stage2_usage_in === 111 && lastMetric.stage2_usage_out === 22 && lastMetric.stage2_usage_cache_hit === 7 && lastMetric.stage2_usage_cache_write === 3, `success metric must record stage2 usage/cache fields: ${JSON.stringify(lastMetric)}`);

    // LLM hard-errors must still leave an observable metrics row. This keeps
    // the accuracy contract (no grep fallback) while making provider/auth/model
    // failures diagnosable for toolSearch/decide/correction plain-call paths.
    {
      const savedCalls = piAiStub.__calls, savedPrompts = piAiStub.__prompts, savedConfigs = piAiStub.__configs;
      piAiStub.__calls = []; piAiStub.__prompts = []; piAiStub.__configs = [];
      globalThis.__MEMORY_SEARCH_STAGE2_ERROR__ = "forced stage2 failure for smoke";
      pinStage1Skip(true);
      const failRaw = await search.execute("smoke-llm-failure-metrics", search.prepareArguments({ query: "find memory about dispatch facade", limit: 2 }), new AbortController().signal, null, { cwd: root, modelRegistry: mockModelRegistry });
      delete globalThis.__MEMORY_SEARCH_STAGE2_ERROR__;
      assert(failRaw.isError, `memory_search stage2 failure must remain a hard error: ${JSON.stringify(failRaw)}`);
      const failPayload = JSON.parse(failRaw.content[0].text);
      assert(String(failPayload.error || "").includes("forced stage2 failure"), `hard-error payload must expose the provider failure: ${JSON.stringify(failPayload)}`);
      const failMetricLines = fs.readFileSync(metricsPath, "utf-8").trim().split(/\n/);
      const failMetric = JSON.parse(failMetricLines[failMetricLines.length - 1]);
      assert(failMetric.outcome === "llm_error", `LLM failure must write an observable metrics row: ${JSON.stringify(failMetric)}`);
      assert(failMetric.error_stage === "stage2" && failMetric.error_phase === "primary", `failure metric must identify stage and phase: ${JSON.stringify(failMetric)}`);
      assert(failMetric.error_type === "unknown" && failMetric.error_model_ref === failMetric.stage2_model, `failure metric must classify error type and model ref: ${JSON.stringify(failMetric)}`);
      assert(failMetric.retry_count === 0 && failMetric.retry_phase === "primary" && failMetric.backoff_applied === false, `failure metric must record retry observability fields: ${JSON.stringify(failMetric)}`);
      assert(failMetric.search_profile === "toolSearch", `failure metric must include caller profile: ${JSON.stringify(failMetric)}`);
      assert(failMetric.stage1_skip === true && failMetric.stage2_model && typeof failMetric.candidate_limit === "number", `failure metric must include model/flag/candidate context: ${JSON.stringify(failMetric)}`);
      pinStage1Skip(false);
      piAiStub.__calls = savedCalls; piAiStub.__prompts = savedPrompts; piAiStub.__configs = savedConfigs;
    }

    const graph = await rebuildGraphIndex(path.join(root, ".pensieve"), DEFAULT_SETTINGS, undefined, root);
    assert(fs.existsSync(path.join(root, ".pensieve", ".index", "graph.json")), "graph.json not written");
    assert(graph.nodeCount === 2, "graph node count mismatch");

    // Regression: code-span / fenced-block [[X]] tokens must NOT become graph edges.
    // Only the real wikilink to `beta` should yield a body_wikilink edge from `gamma`.
    writeFile(path.join(root, ".pensieve", "knowledge", "gamma.md"), makeEntry({
      title: "Gamma Wikilink Cases",
      body: [
        "Real link: [[beta]].",
        "",
        "Inline example: `[[example-in-code]]` should not become an edge.",
        "",
        "Another inline: `[[wikilink]]` is a placeholder.",
        "",
        "Fenced sample (must be skipped):",
        "",
        "```",
        "see also [[fence-link-1]] and [[fence-link-2]]",
        "```",
      ].join("\n"),
    }));
    const graph2 = await rebuildGraphIndex(path.join(root, ".pensieve"), DEFAULT_SETTINGS, undefined, root);
    assert(graph2.nodeCount === 3, `graph rebuild should pick up gamma (got ${graph2.nodeCount})`);
    const graphJson = JSON.parse(fs.readFileSync(path.join(root, ".pensieve", ".index", "graph.json"), "utf-8"));
    const gammaEdges = graphJson.edges.filter((e) => e.from === "gamma");
    const gammaWikilinkTargets = gammaEdges.filter((e) => e.source === "body_wikilink").map((e) => e.to);
    assert(
      gammaWikilinkTargets.length === 1 && gammaWikilinkTargets[0] === "beta",
      `gamma should have exactly one body_wikilink edge to beta, got: ${JSON.stringify(gammaWikilinkTargets)}`,
    );
    for (const banned of ["example-in-code", "wikilink", "fence-link-1", "fence-link-2"]) {
      assert(!gammaWikilinkTargets.includes(banned), `code-span/fenced wikilink "${banned}" leaked into graph edges`);
    }
    fs.unlinkSync(path.join(root, ".pensieve", "knowledge", "gamma.md"));

    memSettings.resolveSettings = origResolveSettings;
    sedimentSettings.resolveSedimentSettings = origResolveSedimentSettings;
    if (previousAbrainRoot === undefined) delete process.env.ABRAIN_ROOT;
    else process.env.ABRAIN_ROOT = previousAbrainRoot;

    const idx = await rebuildMarkdownIndex(path.join(root, ".pensieve"), DEFAULT_SETTINGS, undefined, root);
    assert(fs.existsSync(path.join(root, ".pensieve", "_index.md")), "_index.md not written");
    assert(idx.orphanCount === 1, "index orphan count mismatch");

    fs.mkdirSync(path.join(root, ".pensieve", "short-term", "maxims"), { recursive: true });
    writeFile(path.join(root, ".pensieve", "short-term", "maxims", "legacy.md"), `---
type: maxim
title: Legacy Rule
status: active
created: 2026-05-08
---
# Legacy Rule

Body.
`);
    writeFile(path.join(root, ".pensieve", "maxims", "eliminate-special-cases-by-redesigning-data-flow.md"), `---
id: eliminate-special-cases-by-redesigning-data-flow
type: maxim
title: Eliminate special cases by redesigning data flow
status: active
created: 2026-02-11
updated: 2026-02-11
---
# Eliminate special cases by redesigning data flow

Original Pensieve seed content.
`);
    // === Memory migrate dry-run (read-only planner) ========================
    // Round 7 P0-C (opus audit fix): dry-run now reflects --go's actual
    // routing in target_path, including pipelines (previously lied about
    // as "unsupported"). Without --project=<id>, target_path renders an
    // explicit `<unresolved>` sentinel; with --project=<id> it resolves
    // to the abrain projects/workflows substrate path.
    const migrationNoProj = await planMigrationDryRun(path.join(root, ".pensieve"), DEFAULT_SETTINGS, undefined, root);
    assert(migrationNoProj.migrateCount >= 1, "migration dry-run found no pending entries");
    const legacyPlanNoProj = migrationNoProj.items.find((item) => item.source_path === ".pensieve/short-term/maxims/legacy.md");
    assert(legacyPlanNoProj, "migration plan should include legacy.md");
    assert(
      /^<unresolved/.test(legacyPlanNoProj.target_path),
      `dry-run without --project should render <unresolved> sentinel, got: ${legacyPlanNoProj.target_path}`,
    );
    assert(legacyPlanNoProj.plan_command === undefined && legacyPlanNoProj.apply_command === undefined, "plan/apply command fields must be retired");

    // With --project=<id>, target_path resolves to the abrain destination.
    const fakeAbrainHome = path.join(root, ".abrain-fake");
    const missingCanonical = await planMigrationDryRun(path.join(root, ".pensieve"), DEFAULT_SETTINGS, undefined, root, {
      abrainHome: fakeAbrainHome,
      projectId: "smoke-proj",
    });
    const missingSeedSkip = missingCanonical.skipped.find((s) => s.source_path === ".pensieve/maxims/eliminate-special-cases-by-redesigning-data-flow.md");
    assert(
      missingSeedSkip && /would fail: extract seed's canonical copy not found/.test(missingSeedSkip.reason),
      `dry-run should mirror --go canonical-copy guard for extract seed: ${JSON.stringify(missingCanonical.skipped)}`,
    );
    writeFile(
      path.join(fakeAbrainHome, "knowledge", "eliminate-special-cases-by-redesigning-data-flow.md"),
      "---\nkind: maxim\n---\n# Canonical seed\n",
    );
    const migration = await planMigrationDryRun(path.join(root, ".pensieve"), DEFAULT_SETTINGS, undefined, root, {
      abrainHome: fakeAbrainHome,
      projectId: "smoke-proj",
    });
    assert(migration.migrateCount >= 1, "migration dry-run with --project found no pending entries");
    const legacyPlan = migration.items.find((item) => item.source_path === ".pensieve/short-term/maxims/legacy.md");
    assert(legacyPlan, "migration plan should include legacy.md (with --project)");
    // legacy.md is kind=maxim, status=active → abrain projects/<id>/maxims/<slug>.md
    assert(
      /\.abrain-fake\/projects\/smoke-proj\/maxims\/legacy\.md$/.test(legacyPlan.target_path),
      `legacy plan target should be abrain projects path, got: ${legacyPlan.target_path}`,
    );
    // Round 7 P0-C: pipelines must NOT be in `skipped` with reason "unsupported".
    // (The fixture in this section may not have pipelines; the migrate-go
    // section already tests pipeline routing. We verify here only that
    // the schema flag is gone.)
    const stillUnsupported = migration.skipped.find((s) => /pipeline.*not migrated/i.test(s.reason));
    assert(!stillUnsupported, `pipelines must no longer be flagged 'unsupported' in dry-run, found: ${stillUnsupported?.reason}`);
    const seedSkip = migration.skipped.find((s) => s.source_path === ".pensieve/maxims/eliminate-special-cases-by-redesigning-data-flow.md");
    assert(
      seedSkip && /legacy Pensieve seed; canonical copy at global abrain/.test(seedSkip.reason),
      `extract-disposition seed should be skipped with global pointer in dry-run: ${JSON.stringify(migration.skipped)}`,
    );
    assert(
      !migration.items.some((item) => item.source_path === ".pensieve/maxims/eliminate-special-cases-by-redesigning-data-flow.md"),
      `legacy seed must not appear as a project migration item`,
    );
    const formattedMigration = formatMigrationPlan(migration);
    assert(/Skipped:/.test(formattedMigration) && /legacy Pensieve seed/.test(formattedMigration), `formatted migration should show skipped seed rows: ${formattedMigration}`);
    const migrationReport = await writeMigrationReport(path.join(root, ".pensieve"), migration, root);
    const migrationReportText = fs.readFileSync(path.join(root, ".pi-astack", "memory", "migration-report.md"), "utf-8");
    assert(fs.existsSync(path.join(root, ".pi-astack", "memory", "migration-report.md")), "migration report not written");
    assert(!migrationReportText.includes("migrate-one") && !migrationReportText.includes("migration-backups"), "migration report must not reference retired per-file substrate");
    assert(migrationReport.migrateCount === migration.migrateCount, "migration report count mismatch");

    const doctor = await runDoctorLite(path.join(root, ".pensieve"), DEFAULT_SETTINGS, undefined, root);
    assert(["pass", "warning", "error"].includes(doctor.status), "doctor-lite invalid status");
    assert(doctor.migrationBackups === undefined, "doctor-lite migrationBackups field must be retired");
    assert(doctor.migration.pendingCount >= 1, "doctor-lite should still surface pending migrations");

    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "pi@example.test"], { cwd: root });
    execFileSync("git", ["config", "user.name", "pi smoke"], { cwd: root });

    const sanitize = sanitizeForMemory("/home/worker a@example.com 127.0.0.1");
    assert(sanitize.ok && sanitize.replacements.includes("home_path") && sanitize.replacements.includes("email") && sanitize.replacements.includes("ip_address"), "sanitize replacements failed");

    // Post-2026-05-13 cutover: writer requires explicit abrainHome + projectId.
    const writerTarget1 = setupAbrainTarget("writer-fixture");
    const write = await writeProjectEntry({
      title: "Writer Fixture",
      kind: "fact",
      confidence: 5,
      compiledTruth: "This validates the sediment writer substrate with enough content.",
    }, { projectRoot: root, abrainHome: writerTarget1.abrainHome, projectId: writerTarget1.projectId, settings: { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: false }, dryRun: false });
    assert(write.status === "created", `writer failed: ${write.reason}`);
    // Entry markdown must land under abrain, not under projectRoot/.pensieve/.
    assert(write.path.startsWith(path.join(writerTarget1.abrainHome, "projects", writerTarget1.projectId) + path.sep), `writer entry must land under abrain projects dir, got: ${write.path}`);
    assert(!fs.existsSync(path.join(root, ".pensieve", "facts")), "writer must NOT create projectRoot/.pensieve/facts/ after cutover");

    const writerTarget2 = setupAbrainTarget("writer-correlation");
    const correlatedWrite = await writeProjectEntry({
      title: "Writer Correlation Fixture",
      kind: "fact",
      confidence: 5,
      sessionId: "session-smoke",
      compiledTruth: "This validates that writer-level audit rows carry lane, session, correlation, and candidate identifiers.",
    }, {
      projectRoot: root,
      abrainHome: writerTarget2.abrainHome,
      projectId: writerTarget2.projectId,
      settings: { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: false },
      dryRun: false,
      auditContext: {
        lane: "auto_write",
        sessionId: "session-smoke",
        correlationId: "corr-smoke",
        candidateId: "corr-smoke:c1",
      },
    });
    assert(correlatedWrite.status === "created", `correlated writer failed: ${correlatedWrite.reason}`);
    assert(correlatedWrite.correlationId === "corr-smoke" && correlatedWrite.candidateId === "corr-smoke:c1", "writer result should echo audit correlation ids");

    const evidenceTarget = setupAbrainTarget("writer-knowledge-evidence");
    const evidenceSettings = {
      ...DEFAULT_SEDIMENT_SETTINGS,
      gitCommit: false,
      curatorModel: "provider/curator-model",
      knowledgeEvidenceEventWriter: { enabled: true, mode: "parallel_legacy", legacyFallbackOnEventFailure: true },
      knowledgeProjector: { enabled: true, hotOverlayEnabled: true, projectOnWrite: true, maxReadBytes: 1000000 },
    };
    const evidenceWrite = await writeProjectEntry({
      title: "Writer Knowledge Evidence Fixture",
      kind: "fact",
      confidence: 8,
      sessionId: "session-knowledge-evidence",
      compiledTruth: "This validates that writeProjectEntry appends a Knowledge Evidence Event and projects a hot overlay.",
      triggerPhrases: ["writer knowledge evidence fixture"],
    }, {
      projectRoot: root,
      abrainHome: evidenceTarget.abrainHome,
      projectId: evidenceTarget.projectId,
      settings: evidenceSettings,
      dryRun: false,
      auditContext: { lane: "auto_write", sessionId: "session-knowledge-evidence", correlationId: "knowledge-corr", candidateId: "knowledge-c1" },
    });
    assert(evidenceWrite.status === "created", `knowledge evidence writer failed: ${evidenceWrite.reason}`);
    assert(evidenceWrite.knowledgeEvidenceEvent?.append?.ok, `knowledge evidence append missing: ${JSON.stringify(evidenceWrite.knowledgeEvidenceEvent)}`);
    assert(evidenceWrite.knowledgeEvidenceEvent.body?.llm_extraction?.model === "provider/curator-model", `knowledge llm_extraction model missing: ${JSON.stringify(evidenceWrite.knowledgeEvidenceEvent.body?.llm_extraction)}`);
    assert(/^[0-9a-f]{64}$/.test(evidenceWrite.knowledgeEvidenceEvent.body?.llm_extraction?.input_hash || ""), `knowledge llm_extraction input_hash missing: ${JSON.stringify(evidenceWrite.knowledgeEvidenceEvent.body?.llm_extraction)}`);
    assert(evidenceWrite.knowledgeEvidenceEvent.projection?.status === "projected", `knowledge evidence projection missing: ${JSON.stringify(evidenceWrite.knowledgeEvidenceEvent.projection)}`);
    assert(fs.existsSync(knowledgeEvidenceEventPath(evidenceTarget.abrainHome, evidenceWrite.knowledgeEvidenceEvent.append.eventId)), "knowledge evidence event file missing");
    const projectionStores = await readKnowledgeProjectionStores({ abrainHome: evidenceTarget.abrainHome, projectId: evidenceTarget.projectId, settings: evidenceSettings });
    assert(projectionStores.some((store) => store.label === "knowledge-projection-project"), `knowledge projection store missing: ${JSON.stringify(projectionStores)}`);

    // ADR 0039 B3-blocker-1: gitCommit must atomically include the derived L1
    // event + L2 projection. Without the sweep every knowledge write leaves
    // uncommitted l1/l2 delta, dirtying the abrain tree so the git-sync merge
    // preflight refuses and the B4 pre-push dirty-view blocker rejects forever.
    {
      const l1l2Target = setupAbrainTarget("writer-l1l2-commit");
      const l1l2Abrain = l1l2Target.abrainHome;
      fs.writeFileSync(path.join(l1l2Abrain, ".gitignore"), ".state/\n");
      execFileSync("git", ["-C", l1l2Abrain, "init", "-q"]);
      execFileSync("git", ["-C", l1l2Abrain, "config", "user.email", "smoke@example.com"]);
      execFileSync("git", ["-C", l1l2Abrain, "config", "user.name", "smoke"]);
      execFileSync("git", ["-C", l1l2Abrain, "add", "-A"]);
      execFileSync("git", ["-C", l1l2Abrain, "commit", "-q", "-m", "baseline"]);
      const l1l2Settings = {
        ...DEFAULT_SEDIMENT_SETTINGS,
        gitCommit: true,
        knowledgeEvidenceEventWriter: { enabled: true, mode: "event_first", legacyFallbackOnEventFailure: false },
        knowledgeProjector: { enabled: true, hotOverlayEnabled: true, projectOnWrite: true, maxReadBytes: 1000000, l2OutputRoot: "repo", projectionMode: "topo" },
      };
      const l1l2Write = await writeProjectEntry({
        title: "Writer L1L2 Commit Fixture",
        kind: "fact",
        confidence: 7,
        sessionId: "session-l1l2-commit",
        compiledTruth: "Validates that gitCommit atomically commits the derived L1 event and L2 projection alongside the canonical entry.",
        triggerPhrases: ["writer l1l2 commit fixture"],
      }, {
        projectRoot: root,
        abrainHome: l1l2Abrain,
        projectId: l1l2Target.projectId,
        settings: l1l2Settings,
        dryRun: false,
      });
      assert(l1l2Write.status === "created", `l1l2 commit writer failed: ${l1l2Write.reason}`);
      assert(typeof l1l2Write.gitCommit === "string" && l1l2Write.gitCommit.length >= 7, `l1l2 commit sha missing: ${JSON.stringify(l1l2Write.gitCommit)}`);
      const l1l2Status = execFileSync("git", ["-C", l1l2Abrain, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf-8" }).trim();
      assert(l1l2Status === "", `abrain tree must be clean after write (no uncommitted l1/l2), got:\n${l1l2Status}`);
      const headFiles = execFileSync("git", ["-C", l1l2Abrain, "show", "--name-only", "--pretty=format:", "HEAD"], { encoding: "utf-8" }).trim().split("\n").filter(Boolean);
      assert(headFiles.some((f) => f.startsWith("l1/events/")), `HEAD commit must include l1/ event: ${JSON.stringify(headFiles)}`);
      assert(headFiles.some((f) => f.startsWith("l2/views/knowledge/")), `HEAD commit must include l2/ projection: ${JSON.stringify(headFiles)}`);
      assert(headFiles.some((f) => f.startsWith(`projects/${l1l2Target.projectId}/`) && f.endsWith(".md")), `HEAD commit must include canonical entry: ${JSON.stringify(headFiles)}`);
    }

    // ADR 0039 Knowledge stop-write prep: when explicitly disabled, successful
    // event-first writes keep positive writer statuses and commit L1/L2 without
    // mutating legacy markdown.
    {
      const stopTarget = setupAbrainTarget("writer-legacy-stop");
      const stopAbrain = stopTarget.abrainHome;
      fs.writeFileSync(path.join(stopAbrain, ".gitignore"), ".state/\n");
      execFileSync("git", ["-C", stopAbrain, "init", "-q"]);
      execFileSync("git", ["-C", stopAbrain, "config", "user.email", "smoke@example.com"]);
      execFileSync("git", ["-C", stopAbrain, "config", "user.name", "smoke"]);
      execFileSync("git", ["-C", stopAbrain, "add", "-A"]);
      execFileSync("git", ["-C", stopAbrain, "commit", "-q", "-m", "baseline"]);
      const stopSettings = {
        ...DEFAULT_SEDIMENT_SETTINGS,
        gitCommit: true,
        knowledgeEvidenceEventWriter: { enabled: true, mode: "event_first", legacyFallbackOnEventFailure: false, legacyMarkdownWriteOnSuccessfulEvent: false },
        knowledgeProjector: { enabled: true, hotOverlayEnabled: true, projectOnWrite: true, maxReadBytes: 1000000, l2OutputRoot: "repo", projectionMode: "topo" },
      };
      const stopCreate = await writeProjectEntry({
        title: "Writer Legacy Stop Create",
        kind: "fact",
        confidence: 7,
        sessionId: "session-legacy-stop-create",
        compiledTruth: "Validates that create can skip legacy markdown after a successful Knowledge Evidence Event.",
      }, {
        projectRoot: root,
        abrainHome: stopAbrain,
        projectId: stopTarget.projectId,
        settings: stopSettings,
        dryRun: false,
      });
      assert(stopCreate.status === "created", `legacy stop create should preserve created status: ${JSON.stringify(stopCreate)}`);
      assert(!fs.existsSync(stopCreate.path), `legacy stop create must not create markdown: ${stopCreate.path}`);
      assert(stopCreate.knowledgeEvidenceEvent?.append?.ok, `legacy stop create event append missing: ${JSON.stringify(stopCreate.knowledgeEvidenceEvent)}`);
      assert(stopCreate.knowledgeEvidenceEvent.body?.legacy_parallel_write?.attempted === false, `legacy stop create must mark attempted=false: ${JSON.stringify(stopCreate.knowledgeEvidenceEvent.body?.legacy_parallel_write)}`);
      assert(stopCreate.knowledgeEvidenceEvent.body?.legacy_parallel_write?.reason === "legacy_markdown_write_disabled", `legacy stop create reason wrong: ${JSON.stringify(stopCreate.knowledgeEvidenceEvent.body?.legacy_parallel_write)}`);
      assert(stopCreate.knowledgeEvidenceEvent.projection?.status === "projected" && fs.existsSync(stopCreate.knowledgeEvidenceEvent.projection.outputPath), `legacy stop create projection missing: ${JSON.stringify(stopCreate.knowledgeEvidenceEvent.projection)}`);
      const stopCreateFiles = execFileSync("git", ["-C", stopAbrain, "show", "--name-only", "--pretty=format:", "HEAD"], { encoding: "utf-8" }).trim().split("\n").filter(Boolean);
      assert(stopCreateFiles.some((f) => f.startsWith("l1/events/")), `legacy stop create commit must include l1: ${JSON.stringify(stopCreateFiles)}`);
      assert(stopCreateFiles.some((f) => f.startsWith("l2/views/knowledge/")), `legacy stop create commit must include l2: ${JSON.stringify(stopCreateFiles)}`);
      assert(!stopCreateFiles.some((f) => f.startsWith(`projects/${stopTarget.projectId}/`) && f.endsWith(".md")), `legacy stop create commit must not include legacy markdown: ${JSON.stringify(stopCreateFiles)}`);
      assert(execFileSync("git", ["-C", stopAbrain, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf-8" }).trim() === "", "legacy stop create must leave abrain tree clean");

      const l2OnlyProjection = stopCreate.knowledgeEvidenceEvent.projection.outputPath;
      const l2OnlyProjectionBeforeProjectOff = fs.readFileSync(l2OnlyProjection, "utf-8");
      const projectOffUpdate = await updateProjectEntry(stopCreate.slug, {
        status: "active",
        confidence: 8,
        compiledTruth: "# Writer Legacy Stop Create\n\nThis must not pretend to update L2 when projectOnWrite is disabled.",
        sessionId: "session-legacy-stop-project-off-update",
      }, {
        projectRoot: root,
        abrainHome: stopAbrain,
        projectId: stopTarget.projectId,
        settings: { ...stopSettings, knowledgeProjector: { ...stopSettings.knowledgeProjector, projectOnWrite: false } },
        dryRun: false,
      });
      assert(projectOffUpdate.status === "rejected" && projectOffUpdate.reason === "entry_not_found", `projectOnWrite=false L2-only update must fail closed, not spoof updated: ${JSON.stringify(projectOffUpdate)}`);
      assert(!projectOffUpdate.knowledgeEvidenceEvent, `projectOnWrite=false rejected L2-only update must not append an event: ${JSON.stringify(projectOffUpdate.knowledgeEvidenceEvent)}`);
      assert(fs.readFileSync(l2OnlyProjection, "utf-8") === l2OnlyProjectionBeforeProjectOff, "projectOnWrite=false rejected update must not mutate L2 projection");

      const countStopL1Events = () => {
        const eventRoot = path.join(stopAbrain, "l1", "events");
        let count = 0;
        const walk = (dir) => {
          if (!fs.existsSync(dir)) return;
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile() && entry.name.endsWith(".json")) count += 1;
          }
        };
        walk(eventRoot);
        return count;
      };
      const staleUpdateCreate = await writeProjectEntry({
        title: "Writer Legacy Stop Stale Update",
        kind: "fact",
        confidence: 7,
        sessionId: "session-legacy-stop-stale-update-create",
        compiledTruth: "Creates an L2-only projection whose watermark will be tampered before update.",
      }, {
        projectRoot: root,
        abrainHome: stopAbrain,
        projectId: stopTarget.projectId,
        settings: stopSettings,
        dryRun: false,
      });
      assert(staleUpdateCreate.status === "created" && !fs.existsSync(staleUpdateCreate.path), `stale update seed must be L2-only: ${JSON.stringify(staleUpdateCreate)}`);
      const staleUpdateProjection = staleUpdateCreate.knowledgeEvidenceEvent?.projection?.outputPath;
      assert(staleUpdateProjection && fs.existsSync(staleUpdateProjection), `stale update projection missing: ${JSON.stringify(staleUpdateCreate.knowledgeEvidenceEvent?.projection)}`);
      const staleUpdateOriginalProjection = fs.readFileSync(staleUpdateProjection, "utf-8");
      const staleUpdateTamperedProjection = staleUpdateOriginalProjection.replace(/^sediment_watermark_event_id: [0-9a-f]{64}$/m, "sediment_watermark_event_id: 0000000000000000000000000000000000000000000000000000000000000000");
      assert(staleUpdateTamperedProjection !== staleUpdateOriginalProjection, "stale update smoke failed to tamper watermark");
      fs.writeFileSync(staleUpdateProjection, staleUpdateTamperedProjection);
      const staleUpdateEventCountBefore = countStopL1Events();
      const staleUpdate = await updateProjectEntry(staleUpdateCreate.slug, {
        status: "active",
        expected_status: "archived",
        confidence: 8,
        compiledTruth: "# Writer Legacy Stop Stale Update\n\nThis update must reject stale_projection before expected_status mismatch.",
        sessionId: "session-legacy-stop-stale-update-expected-status",
      }, {
        projectRoot: root,
        abrainHome: stopAbrain,
        projectId: stopTarget.projectId,
        settings: stopSettings,
        dryRun: false,
      });
      assert(staleUpdate.status === "rejected" && staleUpdate.reason === "stale_projection", `tampered L2 update with expected_status mismatch must reject stale_projection before status_precondition_failed: ${JSON.stringify(staleUpdate)}`);
      assert(!staleUpdate.knowledgeEvidenceEvent, `stale update with expected_status mismatch must not append event result: ${JSON.stringify(staleUpdate.knowledgeEvidenceEvent)}`);
      assert(countStopL1Events() === staleUpdateEventCountBefore, "stale update with expected_status mismatch must not append an L1 event");
      assert(fs.readFileSync(staleUpdateProjection, "utf-8") === staleUpdateTamperedProjection, "stale update with expected_status mismatch must not mutate tampered L2 projection bytes");
      fs.writeFileSync(staleUpdateProjection, staleUpdateOriginalProjection);

      const staleOutputHashCreate = await writeProjectEntry({
        title: "Writer Legacy Stop Output Hash Tamper",
        kind: "fact",
        confidence: 7,
        sessionId: "session-legacy-stop-output-hash-tamper-create",
        compiledTruth: "Creates an L2-only projection whose body will be tampered while output hash remains unchanged.",
      }, {
        projectRoot: root,
        abrainHome: stopAbrain,
        projectId: stopTarget.projectId,
        settings: stopSettings,
        dryRun: false,
      });
      assert(staleOutputHashCreate.status === "created" && !fs.existsSync(staleOutputHashCreate.path), `stale output-hash seed must be L2-only: ${JSON.stringify(staleOutputHashCreate)}`);
      const staleOutputHashProjection = staleOutputHashCreate.knowledgeEvidenceEvent?.projection?.outputPath;
      assert(staleOutputHashProjection && fs.existsSync(staleOutputHashProjection), `stale output-hash projection missing: ${JSON.stringify(staleOutputHashCreate.knowledgeEvidenceEvent?.projection)}`);
      const staleOutputHashOriginalProjection = fs.readFileSync(staleOutputHashProjection, "utf-8");
      const staleOutputHashTamperedProjection = staleOutputHashOriginalProjection.replace(
        "Creates an L2-only projection whose body will be tampered while output hash remains unchanged.",
        "Creates an L2-only projection whose BODY WAS TAMPERED while output hash remains unchanged.",
      );
      assert(staleOutputHashTamperedProjection !== staleOutputHashOriginalProjection, "stale output-hash smoke failed to tamper projection body");
      fs.writeFileSync(staleOutputHashProjection, staleOutputHashTamperedProjection);
      const staleOutputHashEventCountBefore = countStopL1Events();
      const staleOutputHashUpdate = await updateProjectEntry(staleOutputHashCreate.slug, {
        status: "active",
        confidence: 8,
        compiledTruth: "# Writer Legacy Stop Output Hash Tamper\n\nThis update must reject stale_projection when L2 body bytes no longer match sediment_output_hash.",
        sessionId: "session-legacy-stop-output-hash-tamper-update",
      }, {
        projectRoot: root,
        abrainHome: stopAbrain,
        projectId: stopTarget.projectId,
        settings: stopSettings,
        dryRun: false,
      });
      assert(staleOutputHashUpdate.status === "rejected" && staleOutputHashUpdate.reason === "stale_projection", `tampered L2 body update must reject stale_projection: ${JSON.stringify(staleOutputHashUpdate)}`);
      assert(!staleOutputHashUpdate.knowledgeEvidenceEvent, `stale output-hash update must not append event result: ${JSON.stringify(staleOutputHashUpdate.knowledgeEvidenceEvent)}`);
      assert(countStopL1Events() === staleOutputHashEventCountBefore, "stale output-hash update must not append an L1 event");
      assert(fs.readFileSync(staleOutputHashProjection, "utf-8") === staleOutputHashTamperedProjection, "stale output-hash update must not mutate tampered L2 projection bytes");
      fs.writeFileSync(staleOutputHashProjection, staleOutputHashOriginalProjection);

      const staleHardDeleteCreate = await writeProjectEntry({
        title: "Writer Legacy Stop Stale Hard Delete",
        kind: "fact",
        confidence: 7,
        sessionId: "session-legacy-stop-stale-hard-delete-create",
        compiledTruth: "Creates an L2-only projection whose set hash will be tampered before hard delete.",
      }, {
        projectRoot: root,
        abrainHome: stopAbrain,
        projectId: stopTarget.projectId,
        settings: stopSettings,
        dryRun: false,
      });
      assert(staleHardDeleteCreate.status === "created" && !fs.existsSync(staleHardDeleteCreate.path), `stale hard-delete seed must be L2-only: ${JSON.stringify(staleHardDeleteCreate)}`);
      const staleHardDeleteProjection = staleHardDeleteCreate.knowledgeEvidenceEvent?.projection?.outputPath;
      assert(staleHardDeleteProjection && fs.existsSync(staleHardDeleteProjection), `stale hard-delete projection missing: ${JSON.stringify(staleHardDeleteCreate.knowledgeEvidenceEvent?.projection)}`);
      const staleHardDeleteOriginalProjection = fs.readFileSync(staleHardDeleteProjection, "utf-8");
      const staleHardDeleteTamperedProjection = staleHardDeleteOriginalProjection.replace(/^sediment_input_event_set_hash: [0-9a-f]{64}$/m, "sediment_input_event_set_hash: ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
      assert(staleHardDeleteTamperedProjection !== staleHardDeleteOriginalProjection, "stale hard-delete smoke failed to tamper input_event_set_hash");
      fs.writeFileSync(staleHardDeleteProjection, staleHardDeleteTamperedProjection);
      const staleHardDeleteEventCountBefore = countStopL1Events();
      const staleHardDeleteWithExpectedStatus = await deleteProjectEntry(staleHardDeleteCreate.slug, {
        projectRoot: root,
        abrainHome: stopAbrain,
        projectId: stopTarget.projectId,
        settings: stopSettings,
        dryRun: false,
        mode: "hard",
        expected_status: "archived",
        reason: "stale hard delete expected-status smoke",
        sessionId: "session-legacy-stop-stale-hard-delete-expected-status",
      });
      assert(staleHardDeleteWithExpectedStatus.status === "rejected" && staleHardDeleteWithExpectedStatus.reason === "stale_projection", `tampered L2 hard delete with expected_status must reject stale_projection before status_precondition_failed: ${JSON.stringify(staleHardDeleteWithExpectedStatus)}`);
      assert(!staleHardDeleteWithExpectedStatus.knowledgeEvidenceEvent, `stale hard delete with expected_status must not append event result: ${JSON.stringify(staleHardDeleteWithExpectedStatus.knowledgeEvidenceEvent)}`);
      assert(countStopL1Events() === staleHardDeleteEventCountBefore, "stale hard delete with expected_status must not append an L1 event");
      assert(fs.existsSync(staleHardDeleteProjection), `stale hard delete with expected_status must keep L2 projection: ${staleHardDeleteProjection}`);
      assert(fs.readFileSync(staleHardDeleteProjection, "utf-8") === staleHardDeleteTamperedProjection, "stale hard delete with expected_status must not mutate tampered L2 projection bytes");
      const staleHardDelete = await deleteProjectEntry(staleHardDeleteCreate.slug, {
        projectRoot: root,
        abrainHome: stopAbrain,
        projectId: stopTarget.projectId,
        settings: stopSettings,
        dryRun: false,
        mode: "hard",
        reason: "stale hard delete smoke",
        sessionId: "session-legacy-stop-stale-hard-delete",
      });
      assert(staleHardDelete.status === "rejected" && staleHardDelete.reason === "stale_projection", `tampered L2 hard delete must reject stale_projection: ${JSON.stringify(staleHardDelete)}`);
      assert(!staleHardDelete.knowledgeEvidenceEvent, `stale hard delete must not append event result: ${JSON.stringify(staleHardDelete.knowledgeEvidenceEvent)}`);
      assert(countStopL1Events() === staleHardDeleteEventCountBefore, "stale hard delete must not append an L1 event");
      assert(fs.existsSync(staleHardDeleteProjection), `stale hard delete must keep L2 projection: ${staleHardDeleteProjection}`);
      assert(fs.readFileSync(staleHardDeleteProjection, "utf-8") === staleHardDeleteTamperedProjection, "stale hard delete must not mutate tampered L2 projection bytes");
      fs.writeFileSync(staleHardDeleteProjection, staleHardDeleteOriginalProjection);

      const l2OnlyUpdate = await updateProjectEntry(stopCreate.slug, {
        status: "active",
        confidence: 8,
        compiledTruth: "# Writer Legacy Stop Create\n\nUpdated from the L2 stable view merge base while no legacy markdown file exists.",
        sessionId: "session-legacy-stop-l2only-update",
        timelineNote: "l2-only update smoke",
      }, {
        projectRoot: root,
        abrainHome: stopAbrain,
        projectId: stopTarget.projectId,
        settings: stopSettings,
        dryRun: false,
      });
      assert(l2OnlyUpdate.status === "updated", `L2-only update must not return entry_not_found: ${JSON.stringify(l2OnlyUpdate)}`);
      assert(l2OnlyUpdate.path === l2OnlyProjection, `L2-only update should read from stable view path: ${JSON.stringify(l2OnlyUpdate)}`);
      assert(!fs.existsSync(stopCreate.path), `L2-only update must not create legacy markdown: ${stopCreate.path}`);
      assert(l2OnlyUpdate.knowledgeEvidenceEvent?.append?.ok, `L2-only update event append missing: ${JSON.stringify(l2OnlyUpdate.knowledgeEvidenceEvent)}`);
      assert(l2OnlyUpdate.knowledgeEvidenceEvent?.projection?.status === "projected", `L2-only update projection missing: ${JSON.stringify(l2OnlyUpdate.knowledgeEvidenceEvent?.projection)}`);

      const l2OnlyArchive = await archiveProjectEntry(stopCreate.slug, {
        projectRoot: root,
        abrainHome: stopAbrain,
        projectId: stopTarget.projectId,
        settings: stopSettings,
        dryRun: false,
        reason: "l2-only archive smoke",
        sessionId: "session-legacy-stop-l2only-archive",
      });
      assert(l2OnlyArchive.status === "archived", `L2-only archive must not return entry_not_found: ${JSON.stringify(l2OnlyArchive)}`);
      assert(!fs.existsSync(stopCreate.path), `L2-only archive must not create legacy markdown: ${stopCreate.path}`);
      assert(l2OnlyArchive.knowledgeEvidenceEvent?.projection?.status === "projected", `L2-only archive projection missing: ${JSON.stringify(l2OnlyArchive.knowledgeEvidenceEvent?.projection)}`);

      const l2OnlyReactivate = await updateProjectEntry(stopCreate.slug, {
        status: "active",
        sessionId: "session-legacy-stop-l2only-reactivate",
        timelineAction: "reactivated",
        timelineNote: "l2-only reactivate smoke",
      }, {
        projectRoot: root,
        abrainHome: stopAbrain,
        projectId: stopTarget.projectId,
        settings: stopSettings,
        dryRun: false,
      });
      assert(l2OnlyReactivate.status === "updated", `L2-only reactivate must not return entry_not_found: ${JSON.stringify(l2OnlyReactivate)}`);
      assert(!fs.existsSync(stopCreate.path), `L2-only reactivate must not create legacy markdown: ${stopCreate.path}`);
      assert(l2OnlyReactivate.knowledgeEvidenceEvent?.projection?.status === "projected", `L2-only reactivate projection missing: ${JSON.stringify(l2OnlyReactivate.knowledgeEvidenceEvent?.projection)}`);

      const l2OnlySoftDelete = await deleteProjectEntry(stopCreate.slug, {
        projectRoot: root,
        abrainHome: stopAbrain,
        projectId: stopTarget.projectId,
        settings: stopSettings,
        dryRun: false,
        mode: "soft",
        reason: "l2-only soft delete smoke",
        sessionId: "session-legacy-stop-l2only-soft-delete",
      });
      assert(l2OnlySoftDelete.status === "deleted" && l2OnlySoftDelete.deleteMode === "soft", `L2-only soft delete must not return entry_not_found: ${JSON.stringify(l2OnlySoftDelete)}`);
      assert(l2OnlySoftDelete.knowledgeEvidenceEvent?.body?.intent?.operation_hint === "archive", `L2-only soft delete evidence event should archive, not delete: ${JSON.stringify(l2OnlySoftDelete.knowledgeEvidenceEvent?.body?.intent)}`);
      assert(l2OnlySoftDelete.knowledgeEvidenceEvent?.projection?.status === "projected", `L2-only soft delete projection should keep archived tombstone: ${JSON.stringify(l2OnlySoftDelete.knowledgeEvidenceEvent?.projection)}`);
      assert(fs.existsSync(l2OnlyProjection), `L2-only soft delete must keep stable view projection: ${l2OnlyProjection}`);
      const l2OnlySoftDeletedProjection = fs.readFileSync(l2OnlyProjection, "utf-8");
      assert(/^status: archived$/m.test(l2OnlySoftDeletedProjection), `L2-only soft delete projection must be readable archived tombstone:\n${l2OnlySoftDeletedProjection}`);
      assert(!fs.existsSync(stopCreate.path), `L2-only soft delete must not create legacy markdown: ${stopCreate.path}`);

      const l2OnlyPostSoftReactivate = await updateProjectEntry(stopCreate.slug, {
        status: "active",
        sessionId: "session-legacy-stop-l2only-post-soft-reactivate",
        timelineAction: "reactivated",
        timelineNote: "l2-only post-soft reactivate smoke",
      }, {
        projectRoot: root,
        abrainHome: stopAbrain,
        projectId: stopTarget.projectId,
        settings: stopSettings,
        dryRun: false,
      });
      assert(l2OnlyPostSoftReactivate.status === "updated", `L2-only post-soft reactivate must not return entry_not_found: ${JSON.stringify(l2OnlyPostSoftReactivate)}`);
      assert(l2OnlyPostSoftReactivate.knowledgeEvidenceEvent?.projection?.status === "projected", `L2-only post-soft reactivate projection missing: ${JSON.stringify(l2OnlyPostSoftReactivate.knowledgeEvidenceEvent?.projection)}`);
      assert(/^status: active$/m.test(fs.readFileSync(l2OnlyProjection, "utf-8")), `L2-only post-soft reactivate should restore active projection:\n${fs.readFileSync(l2OnlyProjection, "utf-8")}`);

      const repairDeleteCreate = await writeProjectEntry({
        title: "Writer Legacy Stop Delete Git Failure",
        kind: "fact",
        confidence: 7,
        sessionId: "session-legacy-stop-delete-git-failure-create",
        compiledTruth: "Creates an L2-only projection whose hard delete commit will fail before repair.",
      }, {
        projectRoot: root,
        abrainHome: stopAbrain,
        projectId: stopTarget.projectId,
        settings: stopSettings,
        dryRun: false,
      });
      assert(repairDeleteCreate.status === "created" && !fs.existsSync(repairDeleteCreate.path), `repair-delete seed must be L2-only: ${JSON.stringify(repairDeleteCreate)}`);
      assert(repairDeleteCreate.slug === "writer-legacy-stop-delete-git-failure", `repair-delete slug changed unexpectedly: ${repairDeleteCreate.slug}`);
      const repairDeleteProjection = repairDeleteCreate.knowledgeEvidenceEvent?.projection?.outputPath;
      assert(repairDeleteProjection && fs.existsSync(repairDeleteProjection), `repair-delete projection missing: ${JSON.stringify(repairDeleteCreate.knowledgeEvidenceEvent?.projection)}`);
      const repairDeleteProjectionBefore = fs.readFileSync(repairDeleteProjection, "utf-8");
      const repairDeleteL1CountBefore = countStopL1Events();
      const hookPath = path.join(stopAbrain, ".git", "hooks", "commit-msg");
      fs.writeFileSync(hookPath, [
        "#!/bin/sh",
        "msg=$(cat \"$1\")",
        `if [ "$msg" = "sediment: delete ${repairDeleteCreate.slug} (project:${stopTarget.projectId})" ]; then`,
        "  exit 1",
        "fi",
        "exit 0",
        "",
      ].join("\n"), "utf-8");
      fs.chmodSync(hookPath, 0o755);
      const repairDelete = await deleteProjectEntry(repairDeleteCreate.slug, {
        projectRoot: root,
        abrainHome: stopAbrain,
        projectId: stopTarget.projectId,
        settings: stopSettings,
        dryRun: false,
        mode: "hard",
        reason: "l2-only hard delete git failure smoke",
        sessionId: "session-legacy-stop-l2only-delete-git-failure",
      });
      fs.rmSync(hookPath, { force: true });
      assert(repairDelete.status === "rejected" && repairDelete.reason === "git_commit_failed" && repairDelete.gitCommit === null, `L2-only hard delete commit failure must reject: ${JSON.stringify(repairDelete)}`);
      assert(repairDelete.knowledgeEvidenceEvent?.projection?.status === "removed", `failed delete event should have removed projection before repair: ${JSON.stringify(repairDelete.knowledgeEvidenceEvent?.projection)}`);
      assert(fs.existsSync(repairDeleteProjection), `repair delete must restore stable view projection: ${repairDeleteProjection}`);
      const repairDeleteProjectionAfter = fs.readFileSync(repairDeleteProjection, "utf-8");
      assert(repairDeleteProjectionAfter.includes("Creates an L2-only projection whose hard delete commit will fail before repair."), `repair delete projection should preserve original payload:\n${repairDeleteProjectionAfter}`);
      assert(repairDeleteProjectionAfter !== repairDeleteProjectionBefore, "repair delete projection should be regenerated by compensation event, not left as the deleted preimage");
      assert(countStopL1Events() === repairDeleteL1CountBefore + 2, `repair delete should commit delete + compensation L1 events: before=${repairDeleteL1CountBefore} after=${countStopL1Events()}`);
      const repairDeleteFiles = execFileSync("git", ["-C", stopAbrain, "show", "--name-only", "--pretty=format:", "HEAD"], { encoding: "utf-8" }).trim().split("\n").filter(Boolean);
      assert(repairDeleteFiles.filter((f) => f.startsWith("l1/events/")).length >= 2 && repairDeleteFiles.some((f) => f.startsWith("l2/views/knowledge/")), `repair delete commit must include delete+compensation l1 and restored l2: ${JSON.stringify(repairDeleteFiles)}`);
      assert(execFileSync("git", ["-C", stopAbrain, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf-8" }).trim() === "", "repair delete must leave abrain tree clean");
      const repairDeleteAuditRows = fs.readFileSync(repairDelete.auditPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
      const repairDeleteAudit = repairDeleteAuditRows[repairDeleteAuditRows.length - 1];
      const repairDeleteEventId = repairDeleteAudit.knowledge_evidence_event?.event_id;
      const repairCompensationEventId = repairDeleteAudit.knowledge_evidence_compensation_event?.event_id;
      assert(repairDeleteAudit.event_first_legacy_compensation === "projection_only_compensation_committed", `repair delete audit mode wrong: ${JSON.stringify(repairDeleteAudit)}`);
      assert(/^[0-9a-f]{40}$/.test(String(repairDeleteAudit.knowledge_evidence_compensation_git_commit)), `repair delete audit must include compensation commit sha: ${JSON.stringify(repairDeleteAudit)}`);
      assert(/^[0-9a-f]{64}$/.test(String(repairDeleteEventId)) && /^[0-9a-f]{64}$/.test(String(repairCompensationEventId)), `repair delete audit must include delete and compensation events: ${JSON.stringify(repairDeleteAudit)}`);
      const repairCompensationPath = repairDeleteAudit.knowledge_evidence_compensation_event?.file_path;
      const repairCompensationEnvelope = JSON.parse(fs.readFileSync(repairCompensationPath, "utf-8"));
      assert(repairCompensationEnvelope.body?.intent?.operation_hint === "update", `repair compensation must be an update event: ${JSON.stringify(repairCompensationEnvelope.body?.intent)}`);
      assert(repairCompensationEnvelope.body?.causal_parents?.includes(repairDeleteEventId), `repair compensation must causal-parent failed delete event: ${JSON.stringify(repairCompensationEnvelope.body?.causal_parents)}`);

      const l2OnlyDelete = await deleteProjectEntry(stopCreate.slug, {
        projectRoot: root,
        abrainHome: stopAbrain,
        projectId: stopTarget.projectId,
        settings: stopSettings,
        dryRun: false,
        mode: "hard",
        reason: "l2-only hard delete smoke",
        sessionId: "session-legacy-stop-l2only-delete",
      });
      assert(l2OnlyDelete.status === "deleted" && l2OnlyDelete.deleteMode === "hard", `L2-only hard delete must not return entry_not_found: ${JSON.stringify(l2OnlyDelete)}`);
      assert(!fs.existsSync(stopCreate.path), `L2-only hard delete must not create legacy markdown: ${stopCreate.path}`);
      assert(l2OnlyDelete.knowledgeEvidenceEvent?.projection?.status === "removed", `L2-only hard delete projection should remove L2 entry: ${JSON.stringify(l2OnlyDelete.knowledgeEvidenceEvent?.projection)}`);
      assert(!fs.existsSync(l2OnlyProjection), `L2-only hard delete should remove stable view projection: ${l2OnlyProjection}`);
      const l2OnlyDeleteFiles = execFileSync("git", ["-C", stopAbrain, "show", "--name-only", "--pretty=format:", "HEAD"], { encoding: "utf-8" }).trim().split("\n").filter(Boolean);
      assert(l2OnlyDeleteFiles.some((f) => f.startsWith("l1/events/")) && l2OnlyDeleteFiles.some((f) => f.startsWith("l2/views/knowledge/")), `L2-only hard delete commit must include l1/l2: ${JSON.stringify(l2OnlyDeleteFiles)}`);
      assert(!l2OnlyDeleteFiles.some((f) => f.startsWith(`projects/${stopTarget.projectId}/`) && f.endsWith(".md")), `L2-only hard delete commit must not include legacy markdown: ${JSON.stringify(l2OnlyDeleteFiles)}`);
      assert(execFileSync("git", ["-C", stopAbrain, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf-8" }).trim() === "", "L2-only update/archive/reactivate/soft-delete/hard-delete must leave abrain tree clean");

      const seedSettings = { ...stopSettings, knowledgeEvidenceEventWriter: { ...stopSettings.knowledgeEvidenceEventWriter, legacyMarkdownWriteOnSuccessfulEvent: true } };
      const seed = await writeProjectEntry({
        title: "Writer Legacy Stop Seed",
        kind: "fact",
        confidence: 6,
        sessionId: "session-legacy-stop-seed",
        compiledTruth: "Seed markdown exists so update and hard delete can prove they do not mutate legacy files.",
      }, {
        projectRoot: root,
        abrainHome: stopAbrain,
        projectId: stopTarget.projectId,
        settings: seedSettings,
        dryRun: false,
      });
      assert(seed.status === "created" && fs.existsSync(seed.path), `legacy stop seed failed: ${JSON.stringify(seed)}`);
      const seedBefore = fs.readFileSync(seed.path, "utf-8");
      const updateResult = await updateProjectEntry(seed.slug, {
        status: "active",
        confidence: 9,
        compiledTruth: "# Writer Legacy Stop Seed\n\nUpdated projection content that must not be written back to legacy markdown.",
        sessionId: "session-legacy-stop-update",
        timelineNote: "legacy stop update smoke",
      }, {
        projectRoot: root,
        abrainHome: stopAbrain,
        projectId: stopTarget.projectId,
        settings: stopSettings,
        dryRun: false,
      });
      assert(updateResult.status === "updated", `legacy stop update should preserve updated status: ${JSON.stringify(updateResult)}`);
      assert(fs.readFileSync(seed.path, "utf-8") === seedBefore, "legacy stop update must not modify legacy markdown");
      assert(updateResult.knowledgeEvidenceEvent?.body?.legacy_parallel_write?.attempted === false, `legacy stop update must mark attempted=false: ${JSON.stringify(updateResult.knowledgeEvidenceEvent?.body?.legacy_parallel_write)}`);
      assert(updateResult.knowledgeEvidenceEvent?.projection?.status === "projected" && fs.existsSync(updateResult.knowledgeEvidenceEvent.projection.outputPath), `legacy stop update projection missing: ${JSON.stringify(updateResult.knowledgeEvidenceEvent?.projection)}`);
      const updateFiles = execFileSync("git", ["-C", stopAbrain, "show", "--name-only", "--pretty=format:", "HEAD"], { encoding: "utf-8" }).trim().split("\n").filter(Boolean);
      assert(updateFiles.some((f) => f.startsWith("l1/events/")) && updateFiles.some((f) => f.startsWith("l2/views/knowledge/")), `legacy stop update commit must include l1/l2: ${JSON.stringify(updateFiles)}`);
      assert(!updateFiles.some((f) => f.startsWith(`projects/${stopTarget.projectId}/`) && f.endsWith(".md")), `legacy stop update commit must not include legacy markdown: ${JSON.stringify(updateFiles)}`);

      const renameResult = await updateProjectEntry(seed.slug, {
        newSlug: "writer-legacy-stop-renamed",
        sessionId: "session-legacy-stop-rename",
      }, {
        projectRoot: root,
        abrainHome: stopAbrain,
        projectId: stopTarget.projectId,
        settings: stopSettings,
        dryRun: false,
      });
      assert(renameResult.status === "rejected" && renameResult.reason === "legacy_markdown_rename_disabled", `legacy stop rename must reject without legacy mutation: ${JSON.stringify(renameResult)}`);
      assert(fs.readFileSync(seed.path, "utf-8") === seedBefore, "legacy stop rename rejection must not modify legacy markdown");

      const deleteResult = await deleteProjectEntry(seed.slug, {
        projectRoot: root,
        abrainHome: stopAbrain,
        projectId: stopTarget.projectId,
        settings: stopSettings,
        dryRun: false,
        mode: "hard",
        reason: "legacy stop hard delete smoke",
        sessionId: "session-legacy-stop-delete",
      });
      assert(deleteResult.status === "deleted" && deleteResult.deleteMode === "hard", `legacy stop hard delete should preserve deleted status: ${JSON.stringify(deleteResult)}`);
      assert(fs.existsSync(seed.path) && fs.readFileSync(seed.path, "utf-8") === seedBefore, "legacy stop hard delete must not unlink or modify legacy markdown");
      assert(deleteResult.knowledgeEvidenceEvent?.body?.legacy_parallel_write?.attempted === false, `legacy stop delete must mark attempted=false: ${JSON.stringify(deleteResult.knowledgeEvidenceEvent?.body?.legacy_parallel_write)}`);
      assert(deleteResult.knowledgeEvidenceEvent?.projection?.status === "removed", `legacy stop delete projection should remove L2 entry: ${JSON.stringify(deleteResult.knowledgeEvidenceEvent?.projection)}`);
      const deleteFiles = execFileSync("git", ["-C", stopAbrain, "show", "--name-only", "--pretty=format:", "HEAD"], { encoding: "utf-8" }).trim().split("\n").filter(Boolean);
      assert(deleteFiles.some((f) => f.startsWith("l1/events/")) && deleteFiles.some((f) => f.startsWith("l2/views/knowledge/")), `legacy stop delete commit must include l1/l2: ${JSON.stringify(deleteFiles)}`);
      assert(!deleteFiles.some((f) => f.startsWith(`projects/${stopTarget.projectId}/`) && f.endsWith(".md")), `legacy stop delete commit must not include legacy markdown: ${JSON.stringify(deleteFiles)}`);
      assert(execFileSync("git", ["-C", stopAbrain, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf-8" }).trim() === "", "legacy stop update/delete must leave abrain tree clean");
    }

    // ADR 0039 B-prep blocker③: hot overlay bounded budget. readKnowledgeProjectionStores
    // must keep only the freshest entries within count/token caps and record an overflow
    // diagnostic — never return the whole projection dir unbounded.
    {
      const ovTarget = setupAbrainTarget("overlay-budget");
      const ovStateRoot = path.join(ovTarget.abrainHome, ".state", "sediment", "knowledge-projection");
      const ovWorld = path.join(ovStateRoot, "latest", "world");
      fs.mkdirSync(ovWorld, { recursive: true });
      const mk = (n, bytes) => {
        const f = path.join(ovWorld, `entry-${n}.md`);
        fs.writeFileSync(f, `---\nid: entry-${n}\nkind: fact\nstatus: active\n---\n\n${"x".repeat(bytes)}\n`);
        const t = new Date(Date.now() - (10 - n) * 60_000); // larger n = newer mtime
        fs.utimesSync(f, t, t);
        return f;
      };
      for (let n = 0; n < 5; n++) mk(n, 100);
      const base = (p) => path.basename(p);
      const ovSettings = {
        ...DEFAULT_SEDIMENT_SETTINGS,
        knowledgeProjector: { enabled: true, hotOverlayEnabled: true, projectOnWrite: false, maxReadBytes: 1000000, l2OutputRoot: "state", projectionMode: "topo", hotOverlay: { maxEntries: 3, maxTokens: 2_000_000, deadlineMs: 30_000 } },
      };
      // count cap = 3 → keep the 3 freshest (entry-4/3/2), drop entry-1/0.
      const ovStores = await readKnowledgeProjectionStores({ abrainHome: ovTarget.abrainHome, settings: ovSettings });
      const ovFiles = ovStores.flatMap((s) => s.files || []);
      assert(ovFiles.length === 3, `overlay count cap not enforced: got ${ovFiles.length} expected 3`);
      const got = new Set(ovFiles.map(base));
      for (const keep of ["entry-4.md", "entry-3.md", "entry-2.md"]) assert(got.has(keep), `overlay must keep freshest ${keep}: ${[...got].join(",")}`);
      for (const drop of ["entry-1.md", "entry-0.md"]) assert(!got.has(drop), `overlay must drop stale ${drop}`);
      const ovDiag = path.join(ovStateRoot, "overlay-budget.jsonl");
      assert(fs.existsSync(ovDiag), "overlay-budget.jsonl diagnostic missing on overflow");
      const ovLast = JSON.parse(fs.readFileSync(ovDiag, "utf-8").trim().split("\n").pop());
      assert(ovLast.event === "hot_overlay_budget_exceeded" && ovLast.truncated === true && ovLast.candidates === 5 && ovLast.selected === 3, `overflow diagnostic wrong: ${JSON.stringify(ovLast)}`);
      // token cap: rewrite entries large (≈2000 tokens each ≈ 8KB/4) and set a tight
      // token budget so only the freshest single entry fits (first is unconditional).
      for (let n = 0; n < 5; n++) mk(n, 8000);
      const tokStores = await readKnowledgeProjectionStores({ abrainHome: ovTarget.abrainHome, settings: { ...ovSettings, knowledgeProjector: { ...ovSettings.knowledgeProjector, hotOverlay: { maxEntries: 500, maxTokens: 2500, deadlineMs: 30_000 } } } });
      const tokFiles = tokStores.flatMap((s) => s.files || []);
      assert(tokFiles.length === 1 && base(tokFiles[0]) === "entry-4.md", `token cap should admit only freshest single entry: ${tokFiles.map(base).join(",")}`);
      // hotOverlayEnabled=false → no overlay stores at all.
      const offStores = await readKnowledgeProjectionStores({ abrainHome: ovTarget.abrainHome, settings: { ...ovSettings, knowledgeProjector: { ...ovSettings.knowledgeProjector, hotOverlayEnabled: false } } });
      assert(offStores.length === 0, "hotOverlayEnabled=false must return no stores");
    }

    // ADR 0039 Phase C: the UNBOUNDED stable-view reader returns full projection
    // dirs WITHOUT a files allow-list; scanStore must read EVERY file even though
    // the root sits UNDER l2/ (noHomeExclusions opt-out of the home-world l1/l2 glob).
    {
      const svTarget = setupAbrainTarget("stable-view");
      const svLatest = path.join(svTarget.abrainHome, "l2", "views", "knowledge", "latest");
      const svWorld = path.join(svLatest, "world");
      const svProj = path.join(svLatest, "projects", svTarget.projectId);
      fs.mkdirSync(svWorld, { recursive: true });
      fs.mkdirSync(svProj, { recursive: true });
      const wEntry = (root, slug, body) => fs.writeFileSync(path.join(root, `${slug}.md`), `---\nid: ${slug}\nkind: fact\nstatus: active\nscope: world\n---\n\n${body}\n`);
      for (const s of ["sv-a", "sv-b", "sv-c"]) wEntry(svWorld, s, `stable ${s}`);
      wEntry(svProj, "sv-d", "stable d");
      const svKP = { enabled: true, hotOverlayEnabled: true, projectOnWrite: false, maxReadBytes: 1000000, l2OutputRoot: "repo", projectionMode: "topo", canonicalReadMode: "projection_with_legacy_fallback", hotOverlay: { maxEntries: 2, maxTokens: 2000000, deadlineMs: 30000 } };
      const svSettings = { ...DEFAULT_SEDIMENT_SETTINGS, knowledgeProjector: svKP };
      // (1) stable-view reader is UNBOUNDED: dir refs WITHOUT a files allow-list.
      const svStores = await readKnowledgeStableViewStores({ abrainHome: svTarget.abrainHome, projectId: svTarget.projectId, settings: svSettings });
      assert(svStores.length === 2, `stable-view should return project+world stores: ${JSON.stringify(svStores.map((s) => s.label))}`);
      assert(svStores.every((s) => s.files === undefined), "stable-view stores must NOT carry a bounded files allow-list");
      assert(svStores.some((s) => s.label === "knowledge-stable-world") && svStores.some((s) => s.label === "knowledge-stable-project"), `stable-view labels wrong: ${JSON.stringify(svStores.map((s) => s.label))}`);
      // (2) scanStore reads ALL world stable-view files despite the root being under l2/.
      const { scanStore } = req("./memory/parser.js");
      const worldStable = svStores.find((s) => s.label === "knowledge-stable-world");
      const scanned = await scanStore(worldStable, svTarget.abrainHome, { maxEntries: 1000, includeWorld: true });
      assert(scanned.length === 3, `stable-view world scan must read all 3 entries (noHomeExclusions), got ${scanned.length}`);
      // (3) contrast: the bounded OVERLAY reader (maxEntries=2) caps the SAME dirs to 2.
      const ovStores2 = await readKnowledgeProjectionStores({ abrainHome: svTarget.abrainHome, projectId: svTarget.projectId, settings: svSettings });
      const ovTotal = ovStores2.flatMap((s) => s.files || []);
      assert(ovTotal.length === 2, `overlay reader must cap to maxEntries=2 over same dirs, got ${ovTotal.length}`);
    }

    // Regression: memory_search returned [] because memory.embedding switched to the
    // dedicated baseUrl/apiKey form (no `provider`), and selectStage0Pool's guard only
    // checked `provider` → stage0 disabled → stage1Skip took an unranked corpus slice →
    // late-ordered slugs never reached stage2. embeddingConfigured must accept the
    // dedicated form (model + baseUrl) so dense ranking stays on.
    {
      const { embeddingConfigured } = req("./memory/llm-search.js");
      assert(embeddingConfigured({ model: "doubao-embedding-vision", baseUrl: "https://x/v1", apiKey: "k" }) === true, "embeddingConfigured must accept dedicated baseUrl config (production form, no provider)");
      assert(embeddingConfigured({ model: "m", provider: "p" }) === true, "embeddingConfigured must accept registry provider config");
      assert(embeddingConfigured({ model: "m" }) === false, "embeddingConfigured must reject model with no route (no provider, no baseUrl)");
      assert(embeddingConfigured({ baseUrl: "https://x/v1" }) === false, "embeddingConfigured must reject baseUrl with no model");
      assert(embeddingConfigured({}) === false, "embeddingConfigured must reject empty config");
    }

    // Audit log remains project-local (forensic), even though entry markdown went to abrain.
    const auditRows = fs.readFileSync(path.join(root, ".pi-astack", "sediment", "audit.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    const correlatedAudit = auditRows.find((row) => row.operation === "create" && row.target === `project:${writerTarget2.projectId}:writer-correlation-fixture`);
    assert(correlatedAudit?.lane === "auto_write", "writer audit row should include lane");
    assert(correlatedAudit?.session_id === "session-smoke", "writer audit row should include session_id");
    assert(correlatedAudit?.correlation_id === "corr-smoke", "writer audit row should include correlation_id");
    assert(correlatedAudit?.candidate_id === "corr-smoke:c1", "writer audit row should include candidate_id");

    // Writer auto-creates the abrain projects/<id>/ kind subdir if missing.
    const missingTarget = setupAbrainTarget("writer-creates-dir");
    // Wipe the projects/<id>/ subdir to verify writer recreates it on demand.
    fs.rmSync(path.join(missingTarget.abrainHome, "projects", missingTarget.projectId), { recursive: true, force: true });
    const projectRootForCreate = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-no-abrain-"));
    const createdRootWrite = await writeProjectEntry({
      title: "Writer Creates Abrain Root",
      kind: "fact",
      confidence: 5,
      compiledTruth: "The sediment writer creates the abrain projects/<id>/ directory on demand when it is missing.",
    }, { projectRoot: projectRootForCreate, abrainHome: missingTarget.abrainHome, projectId: missingTarget.projectId, settings: { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: false }, dryRun: false });
    assert(createdRootWrite.status === "created", `writer should create missing abrain projects/<id>/: ${createdRootWrite.reason}`);
    assert(fs.existsSync(path.join(missingTarget.abrainHome, "projects", missingTarget.projectId)), "writer did not create abrain projects/<id>/ on demand");

    // Post-cutover: dedupe scans the abrain projects/<id>/ tree, not <projectRoot>/.pensieve/.
    const duplicate = await detectProjectDuplicate(path.join(writerTarget1.abrainHome, "projects", writerTarget1.projectId), "Writer Fixture");
    assert(duplicate.duplicate, "dedupe failed to detect written entry");

    const branch = [
      { type: "message", id: "a1", timestamp: "2026-05-08T00:00:00Z", message: { role: "user", content: "hello" } },
      { type: "message", id: "b2", timestamp: "2026-05-08T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "world" }] } },
    ];
    await saveCheckpoint(root, { lastProcessedEntryId: "a1" });
    const window = buildRunWindow(branch, await loadCheckpoint(root), { ...DEFAULT_SEDIMENT_SETTINGS, minWindowChars: 0 });
    assert(window.candidateEntries === 1 && window.lastEntryId === "b2", "checkpoint window failed");

    // Regression: per-session checkpoint isolation. Two sessions sharing
    // the same project root must NOT clobber each other's last-processed
    // entry id. Subprocess / ephemeral pi (sessionId=undefined) MUST NOT
    // persist any state.
    const concRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-conc-"));
    fs.mkdirSync(path.join(concRoot, ".pensieve"), { recursive: true });
    await saveSessionCheckpoint(concRoot, "session-A", { lastProcessedEntryId: "entryA-99" });
    await saveSessionCheckpoint(concRoot, "session-B", { lastProcessedEntryId: "entryB-42" });
    const cpA = await loadSessionCheckpoint(concRoot, "session-A");
    const cpB = await loadSessionCheckpoint(concRoot, "session-B");
    assert(cpA.lastProcessedEntryId === "entryA-99", `session A checkpoint corrupted by session B: ${cpA.lastProcessedEntryId}`);
    assert(cpB.lastProcessedEntryId === "entryB-42", `session B checkpoint corrupted by session A: ${cpB.lastProcessedEntryId}`);
    const cpUnknown = await loadSessionCheckpoint(concRoot, "session-C-never-saved");
    assert(!cpUnknown.lastProcessedEntryId, "unknown session must return empty checkpoint, not steal another session's slot");
    // Ephemeral mode: undefined sessionId is no-op for both load and save.
    await saveSessionCheckpoint(concRoot, undefined, { lastProcessedEntryId: "ephemeral-leak" });
    const cpAAfterEphemeral = await loadSessionCheckpoint(concRoot, "session-A");
    assert(cpAAfterEphemeral.lastProcessedEntryId === "entryA-99", "ephemeral save must not affect any persisted session slot");
    const cpEph = await loadSessionCheckpoint(concRoot, undefined);
    assert(!cpEph.lastProcessedEntryId, "ephemeral load must return empty checkpoint regardless of file content");
    // Verify on-disk shape: schema_version 2 + sessions map with both keys.
    const cpDiskRaw = JSON.parse(fs.readFileSync(path.join(concRoot, ".pi-astack", "sediment", "checkpoint.json"), "utf-8"));
    assert(cpDiskRaw.schema_version === 2, `expected checkpoint schema_version=2, got ${cpDiskRaw.schema_version}`);
    assert(cpDiskRaw.sessions && cpDiskRaw.sessions["session-A"]?.lastProcessedEntryId === "entryA-99", "on-disk session A slot missing");
    assert(cpDiskRaw.sessions["session-B"]?.lastProcessedEntryId === "entryB-42", "on-disk session B slot missing");

    // Regression: legacy audit file merge produces exactly one `\n`
    // between rows, not zero (which would fuse JSONL lines) and not two
    // (which would inject blank rows). Specifically reproduces the bug
    // where ensureSedimentLegacyMigrated added an unconditional `\n`
    // separator on top of canonical's existing trailing `\n`.
    const mergeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-merge-"));
    fs.mkdirSync(path.join(mergeRoot, ".pensieve", ".state"), { recursive: true });
    fs.mkdirSync(path.join(mergeRoot, ".pi-astack", "sediment"), { recursive: true });
    // R9: mergeRoot needs .git/ so the R9 gitignore-ensure assertion below
    // can verify .gitignore auto-append on git repos. ensureProjectGitignoredOnce
    // checks `<root>/.git` existence (no need for full repo).
    fs.mkdirSync(path.join(mergeRoot, ".git"), { recursive: true });
    // Canonical already has a row (terminated by \n).
    fs.writeFileSync(
      path.join(mergeRoot, ".pi-astack", "sediment", "audit.jsonl"),
      JSON.stringify({ timestamp: "2026-05-08T15:00:00.000+08:00", operation: "canonical" }) + "\n",
    );
    // Legacy has one row (also terminated by \n).
    fs.writeFileSync(
      path.join(mergeRoot, ".pensieve", ".state", "sediment-events.jsonl"),
      JSON.stringify({ timestamp: "2026-05-08T14:55:00.000+08:00", operation: "legacy" }) + "\n",
    );
    // Trigger migration via any audit-touching call.
    await req("./sediment/writer.js").appendAudit(mergeRoot, { operation: "new", timestamp: "2026-05-08T15:01:00.000+08:00" });
    const mergedRaw = fs.readFileSync(path.join(mergeRoot, ".pi-astack", "sediment", "audit.jsonl"), "utf-8");
    const mergedLines = mergedRaw.split("\n");
    // Expect exactly: canonical, legacy, new, "" (trailing) — total 4.
    assert(mergedLines.length === 4, `expected 4 lines (3 rows + trailing newline), got ${mergedLines.length}: ${JSON.stringify(mergedLines)}`);
    assert(mergedLines[3] === "", `last element after split should be empty (trailing newline), got: ${JSON.stringify(mergedLines[3])}`);
    for (let i = 0; i < 3; i++) {
      assert(mergedLines[i].length > 0, `merged line ${i} should be non-empty, got: ${JSON.stringify(mergedLines[i])}`);
      const parsed = JSON.parse(mergedLines[i]);
      assert(parsed.operation, `merged line ${i} should be parseable JSONL with operation`);
    }
    assert(JSON.parse(mergedLines[0]).operation === "canonical", "merged: existing canonical row preserved at top");
    assert(JSON.parse(mergedLines[1]).operation === "legacy", "merged: legacy row appended after canonical");
    assert(JSON.parse(mergedLines[2]).operation === "new", "merged: new appendAudit landed after migration");
    assert(!fs.existsSync(path.join(mergeRoot, ".pensieve", ".state", "sediment-events.jsonl")), "legacy audit file removed after merge");

    // Round 9 P0 (sonnet R9-5 fix): appendAudit must auto-append
    // `.pi-astack/` to project .gitignore on first touch (only when
    // projectRoot is a git repo). mergeRoot is git init'd above for
    // this test fixture, so a .gitignore must now exist with the entry.
    const mergeGitignore = path.join(mergeRoot, ".gitignore");
    assert(
      fs.existsSync(mergeGitignore),
      `R9 P0: appendAudit on git repo must auto-create .gitignore with .pi-astack/ entry`,
    );
    const giContent = fs.readFileSync(mergeGitignore, "utf-8");
    assert(
      /\n?\.pi-astack\/?\n/.test(giContent) || /^\.pi-astack\/?$/m.test(giContent),
      `R9 P0: .gitignore must contain .pi-astack/ entry, got:\n${giContent}`,
    );

    // R9 P0 negative: non-git repo must NOT have .gitignore created.
    const nonGitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-nongit-audit-"));
    fs.mkdirSync(path.join(nonGitRoot, ".pensieve", ".state"), { recursive: true });
    await req("./sediment/writer.js").appendAudit(nonGitRoot, { operation: "probe" });
    assert(
      !fs.existsSync(path.join(nonGitRoot, ".gitignore")),
      `R9 P0: appendAudit on non-git project must NOT create .gitignore`,
    );
    fs.rmSync(nonGitRoot, { recursive: true, force: true });

    // Regression: v1 schema (raw {lastProcessedEntryId}) auto-upgrades on
    // first read. v1 with no sessionId lands in the LEGACY slot and is
    // adopted by the first session that writes (then cleared).
    const v1Root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-v1-"));
    fs.mkdirSync(path.join(v1Root, ".pi-astack", "sediment"), { recursive: true });
    fs.mkdirSync(path.join(v1Root, ".pensieve"), { recursive: true });
    fs.writeFileSync(
      path.join(v1Root, ".pi-astack", "sediment", "checkpoint.json"),
      JSON.stringify({ lastProcessedEntryId: "legacy-77", updatedAt: "2026-05-08T10:00:00.000+08:00" }, null, 2),
    );
    const v1Loaded = await loadSessionCheckpoint(v1Root, "new-session");
    assert(v1Loaded.lastProcessedEntryId === "legacy-77", `v1 LEGACY slot not adopted by new session, got ${v1Loaded.lastProcessedEntryId}`);
    await saveSessionCheckpoint(v1Root, "new-session", { lastProcessedEntryId: "new-78" });
    const v1AfterAdoption = JSON.parse(fs.readFileSync(path.join(v1Root, ".pi-astack", "sediment", "checkpoint.json"), "utf-8"));
    assert(!v1AfterAdoption.sessions["_legacy"], "_legacy slot must be cleared after adoption");
    assert(v1AfterAdoption.sessions["new-session"]?.lastProcessedEntryId === "new-78", "v1 carry-over not persisted under new session");

    const marker = `MEMORY:
title: Explicit Candidate
kind: fact
confidence: 4
---
# Explicit Candidate

This is a valid explicit marker body.
END_MEMORY`;
    assert(parseExplicitMemoryBlocks(marker).length === 1, "explicit marker parse failed");

    // Regression: MEMORY: blocks inside fenced code (``` or ~~~) must be
    // skipped — those are docs/demos, not directives. Bare top-level blocks
    // are still captured. A legitimate body MAY contain code samples without
    // corrupting the parse.
    const fencedDemo = [
      "Here is the format I'd document for users:",
      "",
      "```",
      "MEMORY:",
      "title: Demo Inside Fence",
      "kind: fact",
      "confidence: 3",
      "---",
      "# Demo Inside Fence",
      "This must NOT be captured.",
      "END_MEMORY",
      "```",
      "",
      "And same with tildes:",
      "",
      "~~~",
      "MEMORY:",
      "title: Demo Inside Tildes",
      "kind: fact",
      "---",
      "# Demo Inside Tildes",
      "Also NOT captured.",
      "END_MEMORY",
      "~~~",
      "",
      "But this real one at top level should be captured, even though",
      "its body contains a fenced code sample:",
      "",
      "MEMORY:",
      "title: Real Insight With Code Body",
      "kind: fact",
      "confidence: 4",
      "---",
      "# Real Insight With Code Body",
      "",
      "Example usage:",
      "",
      "```python",
      "print('hello')",
      "```",
      "",
      "That is the gist.",
      "END_MEMORY",
    ].join("\n");
    const fencedDrafts = parseExplicitMemoryBlocks(fencedDemo);
    assert(
      fencedDrafts.length === 1 && fencedDrafts[0].title === "Real Insight With Code Body",
      `expected exactly one captured draft ("Real Insight With Code Body"), got ${fencedDrafts.length}: ${fencedDrafts.map(d=>d.title).join(", ")}`,
    );
    for (const banned of ["Demo Inside Fence", "Demo Inside Tildes"]) {
      assert(!fencedDrafts.some(d => d.title === banned), `fenced MEMORY block "${banned}" leaked into drafts`);
    }

    // Regression: fence state must reset at transcript entry boundaries.
    // A prior message may contain an unmatched code fence; that must not
    // flip the fence parity for a later assistant message and cause a
    // fenced MEMORY format example to be written as a real memory.
    const crossEntryFenceDrift = [
      "--- ENTRY old 2026-05-11T00:00:00Z message/assistant ---",
      "```",
      "an older message left a fence unmatched in the run window",
      "--- ENTRY new 2026-05-11T00:00:01Z message/assistant ---",
      "This is documentation only:",
      "",
      "```text",
      "MEMORY:",
      "title: Fenced Example Must Not Persist",
      "kind: fact",
      "confidence: 7",
      "---",
      "# Fenced Example Must Not Persist",
      "This example must not be captured.",
      "END_MEMORY",
      "```",
      "",
      "But this real top-level block should be captured:",
      "",
      "MEMORY:",
      "title: Cross Entry Real Insight",
      "kind: fact",
      "confidence: 4",
      "---",
      "# Cross Entry Real Insight",
      "This real top-level memory should still be captured.",
      "END_MEMORY",
    ].join("\n");
    const crossEntryDrafts = parseExplicitMemoryBlocks(crossEntryFenceDrift);
    assert(crossEntryDrafts.length === 1 && crossEntryDrafts[0].title === "Cross Entry Real Insight", `entry-local fence reset failed: ${crossEntryDrafts.map(d => d.title).join(", ")}`);

    const llmSummary = summarizeLlmExtractorResult({ ok: true, model: "x/y", rawText: "SKIP", extraction: { count: 0, drafts: [] } }, { maxCandidates: 3, rawPreviewChars: 10 });
    assert(llmSummary.quality.reason === "skip" && llmSummary.quality.passed, "llm summary skip gate failed");

    // === Safety/storage checks retained after ADR 0016 ==================
    // Only sensitive-info and storage-integrity checks remain hard gates.

    // Sensitive-info sanitizer patterns — JWT, PEM, AWS access key, conn URL.
    // Credentials are redacted to typed placeholders, not used to abort the
    // whole sediment run.
    {
      const assertRedacted = (label, result, rawNeedle, placeholderRe = /\[SECRET:[^\]]+\]/) => {
        assert(result.ok, `${label} should sanitize successfully: ${JSON.stringify(result)}`);
        assert(result.text && placeholderRe.test(result.text), `${label} should contain typed placeholder: ${JSON.stringify(result)}`);
        assert(!result.text.includes(rawNeedle), `${label} leaked raw secret: ${JSON.stringify(result)}`);
        assert(result.replacements.some((r) => r.startsWith("credential:")), `${label} missing credential replacement marker: ${JSON.stringify(result)}`);
      };

      const jwtRaw = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
      assertRedacted("jwt_token", sanitizeForMemory(`Authorization: Bearer ${jwtRaw}`), jwtRaw);
      const pemRaw = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOwIBAAJBAL...\n-----END RSA PRIVATE KEY-----";
      assertRedacted("pem_private_key", sanitizeForMemory(pemRaw), "BEGIN RSA PRIVATE KEY");
      const pemHeaderOnlyRaw = "-----BEGIN OPENSSH PRIVATE KEY-----";
      assertRedacted("pem_private_key header-only", sanitizeForMemory(`partial ${pemHeaderOnlyRaw}`), "BEGIN OPENSSH PRIVATE KEY");
      const awsRaw = "AKIA" + "IOSFODNN7EXAMPLE";
      assertRedacted("aws_access_key", sanitizeForMemory(`${awsRaw} is the access key`), awsRaw);
      const dbRaw = "mongodb://user:p4ssw0rd@host.example/dbname";
      assertRedacted("connection_url", sanitizeForMemory(`db: ${dbRaw}`), dbRaw);
      const neo4jRaw = "neo4j+s://user:p4ssw0rd@aura.example.net/db";
      assertRedacted("generic credential URL scheme", sanitizeForMemory(`graph: ${neo4jRaw}`), neo4jRaw, /\[SECRET:connection_url\]/);
      const sqlalchemyRaw = "sqlalchemy+psycopg2://svc:p4ssw0rd@db.example/app";
      assertRedacted("driver-prefixed credential URL scheme", sanitizeForMemory(`dsn: ${sqlalchemyRaw}`), sqlalchemyRaw, /\[SECRET:connection_url\]/);
      const localDsn = sanitizeForMemory("redis://localhost:6379 is the local cache endpoint");
      assert(!localDsn.replacements.some((r) => r.startsWith("credential:")), `local DSN without userinfo must not be treated as credential URL: ${JSON.stringify(localDsn)}`);
      // Negative: ordinary IP/email/$HOME paths still get non-secret scrub only.
      const benign = sanitizeForMemory("user@example.com on 127.0.0.1 at /home/worker/projects");
      assert(benign.ok && !benign.replacements.some((r) => r.startsWith("credential:")), `benign content should pass without credential marker: ${JSON.stringify(benign)}`);

      // Round 8 P1 (opus R8 audit): credential pattern coverage gaps.
      // Each of these used to bypass the gate — now must be redacted.
      const bearerRaw = "ya29.a0AfH6SMBxxxxxxxxxxxxxxxxxxxxxxx";
      const bearerResult = sanitizeForMemory(`curl -H 'Authorization: Bearer ${bearerRaw}'`);
      assertRedacted("bearer_token", bearerResult, bearerRaw, /Bearer \[SECRET:bearer_token\]/);
      assert(bearerResult.text.includes("Bearer [SECRET:bearer_token]"), `bearer replacement must preserve header shape: ${JSON.stringify(bearerResult)}`);
      const slackToken = "xox" + "b-12345678901-1234567890-AbCdEfGhIjKlMnOpQrStUvWx";
      assertRedacted("slack_token", sanitizeForMemory(`slackbot config: ${slackToken}`), slackToken);
      const googleRaw = "AIzaSyB1234567890ABCDEFGHIJKLMNOPQRSTUV";
      const googleResult = sanitizeForMemory(`GOOGLE_API_KEY=${googleRaw}`);
      assertRedacted("google_api_key", googleResult, googleRaw, /\[SECRET:google_api_key\]/);
      assert(googleResult.text.includes("GOOGLE_API_KEY=[SECRET:google_api_key]"), `google assignment should keep vendor-specific placeholder: ${JSON.stringify(googleResult)}`);
      const stripeKey = "sk" + "_live_4eC39HqLyjWDarjtT1zdp7dc";
      const stripeResult = sanitizeForMemory(`STRIPE_SECRET_KEY=${stripeKey}`);
      assertRedacted("stripe_key", stripeResult, stripeKey, /\[SECRET:stripe_key\]/);
      assert(stripeResult.text.includes("STRIPE_SECRET_KEY=[SECRET:stripe_key]"), `stripe assignment should keep vendor-specific placeholder: ${JSON.stringify(stripeResult)}`);
      const httpRaw = "https://admin:hunter2@private.git.example.com/repo.git";
      assertRedacted("http basic auth URL", sanitizeForMemory(`clone: ${httpRaw}`), httpRaw, /\[SECRET:connection_url\]/);
      const passwdRaw = "superSecretPassword12345";
      const passwdResult = sanitizeForMemory(`server config: passwd: ${passwdRaw}`);
      assertRedacted("passwd keyword", passwdResult, passwdRaw, /passwd: \[SECRET:generic_secret_assignment\]/);
      assert(passwdResult.text.includes("passwd: [SECRET:generic_secret_assignment]"), `generic assignment must preserve key/value shape: ${JSON.stringify(passwdResult)}`);
      const punctPasswordRaw = "p@ss!word!hunter2";
      assertRedacted("punctuated long password", sanitizeForMemory(`password=${punctPasswordRaw}`), punctPasswordRaw, /password=\[SECRET:generic_secret_assignment\]/);
      const colonPasswordRaw = "secret:fooBarBaz12345";
      assertRedacted("colon long password", sanitizeForMemory(`password: ${colonPasswordRaw}`), colonPasswordRaw, /password: \[SECRET:generic_secret_assignment\]/);
      const punctApiKeyRaw = "tok@en123def456ghi789";
      assertRedacted("punctuated api key", sanitizeForMemory(`api_key: ${punctApiKeyRaw}`), punctApiKeyRaw, /api_key: \[SECRET:generic_secret_assignment\]/);
      const shortPasswordRaw = "abc12345";
      const shortPasswordResult = sanitizeForMemory(`password: ${shortPasswordRaw}`);
      assertRedacted("short password keyword", shortPasswordResult, shortPasswordRaw, /password: \[SECRET:short_secret_assignment\]/);
      const benignPasswordState = sanitizeForMemory("password: required before continuing");
      assert(!benignPasswordState.replacements.some((r) => r.startsWith("credential:")), `short secret heuristic must not redact benign state words: ${JSON.stringify(benignPasswordState)}`);
      const homoglyphPassword = sanitizeForMemory("pa\u0455\u0455word=abc123secret");
      assert(homoglyphPassword.ok && homoglyphPassword.text === "[SECRET:short_secret_assignment]", `homoglyph password keyword bypass must redact containing line: ${JSON.stringify(homoglyphPassword)}`);

      // Round 8 P1 (opus R8 audit): zero-width / bidi-control bypass
      // forms must NOT defeat keyword scanning. Insert U+200B between
      // "pass" and "word" — fallback redacts the containing line.
      const zwsp = sanitizeForMemory("config\u200B: pass\u200Bword: superSecretPassword12345");
      assert(zwsp.ok && zwsp.text === "[SECRET:generic_secret_assignment]", `zero-width-space bypass must redact containing line: ${JSON.stringify(zwsp)}`);
      const zwspMulti = sanitizeForMemory(["keep this durable context", "config\u200B: pass\u200Bword: superSecretPassword12345", "keep this too"].join("\n"));
      assert(
        zwspMulti.ok && zwspMulti.text === ["keep this durable context", "[SECRET:generic_secret_assignment]", "keep this too"].join("\n"),
        `zero-width-space bypass must redact only the affected line: ${JSON.stringify(zwspMulti)}`,
      );
      const zwspPem = sanitizeForMemory([
        "before pem context",
        "-----BEGIN\u200B RSA PRIVATE KEY-----",
        "MIIBOwIBAAJBALABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
        "-----END RSA PRIVATE KEY-----",
        "after pem context",
      ].join("\n"));
      assert(
        zwspPem.ok && !zwspPem.text.includes("MIIBOwIBAAJBAL") && zwspPem.text.includes("before pem context") && zwspPem.text.includes("after pem context"),
        `zero-width PEM bypass must redact block body without dropping surrounding context: ${JSON.stringify(zwspPem)}`,
      );
    }

    // compiledTruth body containing a bare `---` line gets escaped
    //     so it no longer matches the frontmatter delimiter regex on read.
    {
      const g6Root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-g6-"));
      fs.mkdirSync(path.join(g6Root, ".pensieve"), { recursive: true });
      execFileSync("git", ["init"], { cwd: g6Root, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "pi@example.test"], { cwd: g6Root });
      execFileSync("git", ["config", "user.name", "pi smoke"], { cwd: g6Root });
      const g6Target = setupAbrainTarget("frontmatter-breakout");
      const r = await writeProjectEntry({
        title: "Frontmatter Break Out",
        kind: "fact",
        confidence: 5,
        compiledTruth: [
          "Body section A.",
          "",
          "---",
          "",
          "Body section B (after bare hr).",
        ].join("\n"),
      }, { projectRoot: g6Root, abrainHome: g6Target.abrainHome, projectId: g6Target.projectId, settings: { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: false }, dryRun: false });
      assert(r.status === "created", `frontmatter breakout write failed: ${r.reason}`);
      const written = fs.readFileSync(r.path, "utf-8");
      // Re-parse the file: the surviving frontmatter must have exactly
      // ONE closing `---` (the real one), and the second body-side hr
      // must be the escaped form (" ---" with a leading space).
      const fm2 = splitFrontmatter(written);
      assert(fm2.frontmatterText.length > 0, "frontmatter breakout read-back: frontmatter parse failed");
      assert(/^title: /m.test(fm2.frontmatterText), "frontmatter breakout frontmatter missing title (parser ate too far)");
      assert(/^ ---$/m.test(fm2.body), `frontmatter breakout body must contain escaped hr (" ---"), got:\n${fm2.body}`);
      assert(!/^---$/m.test(fm2.body), `frontmatter breakout body still has bare frontmatter delimiter: ${fm2.body}`);
    }

    // triggerPhrases pass through sanitizer; credentials are redacted to
    // placeholders instead of rejecting the whole write.
    {
      const g8Root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-g8-"));
      fs.mkdirSync(path.join(g8Root, ".pensieve"), { recursive: true });
      execFileSync("git", ["init"], { cwd: g8Root, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "pi@example.test"], { cwd: g8Root });
      execFileSync("git", ["config", "user.name", "pi smoke"], { cwd: g8Root });
      const g8Target = setupAbrainTarget("phrase-leak");
      const rawTriggerSecret = "sk-abcdef0123456789abcdef0123456789";
      const redacted = await writeProjectEntry({
        title: "Phrase Leak",
        kind: "fact",
        confidence: 5,
        compiledTruth: "Body that is fine on its own and long enough to pass validation.",
        triggerPhrases: ["normal phrase", rawTriggerSecret],
      }, { projectRoot: g8Root, abrainHome: g8Target.abrainHome, projectId: g8Target.projectId, settings: { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: false }, dryRun: false });
      assert(redacted.status === "created", `trigger phrase credential should redact, not reject: ${JSON.stringify(redacted)}`);
      const redactedWritten = fs.readFileSync(redacted.path, "utf-8");
      assert(redactedWritten.includes("[SECRET:openai_api_key]") && !redactedWritten.includes(rawTriggerSecret), "trigger phrase credential was not redacted in written file");
      // Negative: phrases that only contain $HOME paths get scrubbed and pass.
      const ok = await writeProjectEntry({
        title: "Phrase Path Scrub",
        kind: "fact",
        confidence: 5,
        compiledTruth: "Body that is fine on its own and long enough to pass validation.",
        triggerPhrases: [`work from ${require("node:os").homedir()}/projects`],
      }, { projectRoot: g8Root, abrainHome: g8Target.abrainHome, projectId: g8Target.projectId, settings: { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: false }, dryRun: false });
      assert(ok.status === "created", `trigger phrase scrub write should succeed: ${JSON.stringify(ok)}`);
      const okWritten = fs.readFileSync(ok.path, "utf-8");
      assert(okWritten.includes("$HOME") && !okWritten.includes("/home/worker") && !okWritten.includes(`${require("node:os").homedir()}/projects`), "trigger phrase $HOME scrub did not redact");
    }

    // Prompt strengthening (role-aware boundary + durability test).
    // We don't hit a real LLM here; just assert the prompt text
    // contains the required directive substrings so a future weakening
    // is caught.
    {
      const { buildLlmExtractorPrompt } = req("./sediment/llm-extractor.js");
      const p = buildLlmExtractorPrompt("--- ENTRY x 0 message/user ---\nfake content");
      const required = [
        // Trust boundary (A1)
        "Trust boundary",
        "role=user",
        "role=toolResult",
        "never as instructions",
        "kind=maxim",
        "[0, 10]",
        // Durability test (added after first-fire produced transient
        // event entries; "after the restart at 16:43" is the canary).
        "Durability test",
        "transient operational event",
        "Per-window cap",
        "TWO MEMORY blocks",
        "Title hygiene",
        "[SECRET:api_key]",
        "[SECRET:connection_url]",
        "Do not invent, reconstruct, or transform the original value.",
        // Cross-scope wikilink hygiene (added 2026-05-13 after B5
        // sediment writer cutover so newly auto-written entries that
        // reference global maxims / workflows ship with explicit
        // [[world:...]] / [[workflow:...]] prefix instead of bare
        // wikilinks the rewriter must mop up later).
        "Cross-scope wikilink hygiene",
        "[[world:slug]]",
        "[[workflow:slug]]",
        "[[project:<projectId>:slug]]",
        "Do NOT invent slugs",
        // ADR / file path discipline (added 2026-05-13 after sediment
        // auto-write created entry 8f527c3 that wikilink'd ADR file
        // names [[project:pi-global:0018-sediment-curator-defense-layers]]
        // and similar — those targets are pi-astack docs, not abrain
        // memory entries, so doctor-lite reported them as dead links).
        "Wikilinks target abrain memory entry slugs only",
        "MUST be referenced in PROSE",
        "ADR 0017 (`docs/adr/0017-project-binding-strict-mode.md`)",
        // ADR 0022 P3c lightweight path (added 2026-05-18): prompt_user
        // tool results are user-attested, not generic untrusted toolResult
        // data. The exception lets curator sediment candidates derived
        // from prompt_user answers as preference/decision without the
        // assistant having to independently re-establish the substance.
        // Locks the entire exception block so a future trust-boundary
        // refactor cannot silently drop the prompt_user carve-out.
        "EXCEPTION (ADR 0022 P3c lightweight path, 2026-05-18)",
        "message/toolResult:prompt_user",
        "USER-ATTESTED",
        "the structured dialog IS",
        "User picks 'Next.js' in a framework prompt",
        // Defense in depth: prompt_user 'Other' free-form text MUST still
        // go through the credential/secret sanitizer. The exception is
        // about trust budget for SUBSTANCE, not for SECRET DISCLOSURE.
        "Still apply the credential/secret sanitizer",
        "not as a license to leak secrets",
        // ADR 0022 INV-M (R8 2026-05-18, GPT-5.5 xhigh P1#2): prompt_user is
        // EVIDENCE not a sediment trigger. Anchors the "don't generalize
        // binary Yes/No into broader preferences" clause so curator prompt
        // can't silently lose this safeguard.
        "`prompt_user` is EVIDENCE, NOT a sediment",
        "NOT command a memory write",
        "binary 'Yes/No' confirmations",
        // ADR 0022 INV-N (R8 2026-05-18, GPT-5.5 xhigh P1#3 + DEEPSEEK P1#2):
        // G2 provenance split. Anchors the "do NOT promote LLM-facing
        // prompt_user answers into MEMORY-ABOUT-ME" boundary so future
        // Lane G G2 landing can't double-count trust.
        "slash will route",
        "through internal `askPromptUser` service",
        "MEMORY-ABOUT-ME equivalents",
      ];
      for (const needle of required) {
        assert(p.includes(needle), `prompt missing required marker: ${JSON.stringify(needle)}`);
      }
    }

    // === curator prompt: cross-scope wikilink hygiene (B5 follow-up) =====
    // Added 2026-05-13 alongside extractor prompt's same directive: the
    // curator decides update/merge compiled_truth, so it can also
    // introduce new wikilinks. Lock the directive in source so future
    // prompt weakening (or a refactor that drops the soft constraint)
    // is caught at smoke time.
    {
      const { buildCuratorPrompt } = req("./sediment/curator.js");
      const cp = buildCuratorPrompt(
        { title: "Curator Smoke", kind: "fact", confidence: 5, compiledTruth: "fixture body for curator prompt assertion" },
        [],
      );
      const curatorRequired = [
        "Cross-scope wikilink hygiene",
        "[[world:slug]]",
        "[[workflow:slug]]",
        "[[project:<projectId>:slug]]",
        "Preserve existing wikilinks verbatim",
        "Do not invent slugs",
        // Update vs create discipline (added 2026-05-13 after curator
        // P0 in abrain commit 2e8924d: candidate was a downstream
        // observation, curator did update instead of create+derives_from,
        // dropping evidence/fix/principle sections).
        "Update vs create discipline",
        "prefer CREATE over UPDATE",
        "Update body-preservation contract",
        "PRESERVE the neighbor's Evidence, Fix, Principle",
        "trigger_phrases on update: UNION",
        // ADR / file path discipline added 2026-05-13.
        "Wikilink target discipline",
        "MUST be referenced in PROSE",
        "[SECRET:<type>] placeholders",
        "never replace them with raw values",
        // Scope on non-create operations (R5 2026-05-14 fix):
        // update/merge/archive/supersede/delete schemas now include
        // "scope"?: "world" — was previously only on create.
        '"scope"?: "world"',
        // 2026-05-15 audit fix: create scope binding directive. The
        // invented-slug HARD CONSTRAINT is kept; the world-from-non-world
        // derivation ban was REMOVED 2026-06-06 (mechanical-guard cleanup R1)
        // and replaced with cross-scope auto-qualification guidance.
        "HARD CONSTRAINT (2026-05-15)",
        "every derives_from slug MUST be one of the neighbor slugs",
        // R1/A1 (2026-06-06): cross-scope provenance is now allowed and
        // auto-qualified; the prompt announces this instead of the old ban.
        "auto-qualifies that edge to project:<id>:slug",
      ];
      for (const needle of curatorRequired) {
        assert(cp.includes(needle), `curator prompt missing required marker: ${JSON.stringify(needle)}`);
      }
    }

    // === curator parseDecision: create-scope binding (2026-05-15 audit) =====
    // Roadmap had "Curator scope binding (create branch)" as backlog:
    // non-create ops enforced neighbor-scope match via validateScope, but
    // create silently passed any derives_from slug through, including
    // hallucinated ones, and let world create derive from project-scope
    // neighbors (leaking project context into world store). Same fix
    // also closes deepseek audit [LOW] re: derives_from existence check.
    {
      const { parseDecision, CuratorRejectError } = req("./sediment/curator.js");
      const neighbors = new Map([
        ["world-maxim-a", "world"],
        ["project-fact-x", "project"],
      ]);
      const p = (obj) => parseDecision(JSON.stringify(obj), neighbors);
      const expectThrows = (obj, substr) => {
        let threw = false;
        let msg = "";
        try { p(obj); } catch (e) { threw = true; msg = e.message; }
        assert(threw, `parseDecision should throw for ${JSON.stringify(obj)}`);
        assert(msg.includes(substr), `error should include ${JSON.stringify(substr)}, got: ${msg}`);
      };
      // Round-3 (2026-05-19) follow-up of round-2 P1-2: every
      // LLM-policy-violation throw must be a typed CuratorRejectError so
      // the audit row carries a grep-able `reason` code instead of
      // collapsing into generic `curator_error`. expectCode pins both
      // the type and the exact code per throw site.
      const expectCode = (obj, expectedCode, label) => {
        let err = null;
        try { p(obj); } catch (e) { err = e; }
        assert(err instanceof CuratorRejectError,
          `${label}: expected CuratorRejectError, got ${err && err.constructor && err.constructor.name}: ${err && err.message}`);
        assert(err.code === expectedCode,
          `${label}: code should be '${expectedCode}', got '${err.code}'`);
      };

      // baseline: plain create with no derives_from passes
      const ok1 = p({ op: "create", rationale: "new entry" });
      assert(ok1.op === "create" && !ok1.derives_from, `plain create should pass: ${JSON.stringify(ok1)}`);

      // project create may derive from either scope
      assert(p({ op: "create", derives_from: ["project-fact-x"] }).op === "create", "project<-project ok");
      assert(p({ op: "create", derives_from: ["world-maxim-a"] }).op === "create", "project<-world ok (legit specialization)");

      // world create may now derive from ANY scope (mechanical-guard cleanup
      // R1/A1, 2026-06-06): the former world_create_from_non_world_source throw
      // was removed. parseDecision keeps the edge BARE; qualifyCrossScopeEdges
      // (asserted below) does the scoped-prefix rewrite at the curate layer.
      assert(p({ op: "create", scope: "world", derives_from: ["world-maxim-a"] }).scope === "world", "world<-world ok");
      {
        const r = p({ op: "create", scope: "world", derives_from: ["project-fact-x"] });
        assert(r.op === "create" && r.scope === "world", "world<-project now parses (no throw)");
        assert(JSON.stringify(r.derives_from) === JSON.stringify(["project-fact-x"]), `parseDecision keeps derives_from bare, got ${JSON.stringify(r.derives_from)}`);
      }
      assert(p({ op: "create", scope: "world", derives_from: ["world-maxim-a", "project-fact-x"] }).op === "create", "world<-mixed now parses (no throw)");

      // hallucinated slugs rejected on both project and world create
      expectThrows({ op: "create", derives_from: ["invented-slug"] }, "not an allowed neighbor");
      expectThrows({ op: "create", scope: "world", derives_from: ["made-up"] }, "not an allowed neighbor");

      // === qualifyCrossScopeEdges: cross-scope provenance is QUALIFIED, not rejected =====
      // (mechanical-guard cleanup R1, 2026-06-06) The former
      // world_create_from_non_world_source guard is gone. A world create that
      // derives from a project precursor is kept as honest provenance and the
      // edge is qualified to project:<id>:slug at the curate layer.
      {
        const { qualifyCrossScopeEdges } = req("./sediment/curator.js");
        const q = qualifyCrossScopeEdges(
          p({ op: "create", scope: "world", derives_from: ["project-fact-x"] }),
          neighbors,
          "pi-global",
        );
        assert(JSON.stringify(q.derives_from) === JSON.stringify(["project:pi-global:project-fact-x"]),
          `world<-project edge should be qualified to project:pi-global:project-fact-x, got ${JSON.stringify(q.derives_from)}`);
        const q2 = qualifyCrossScopeEdges(
          p({ op: "create", scope: "world", derives_from: ["world-maxim-a"] }),
          neighbors,
          "pi-global",
        );
        assert(JSON.stringify(q2.derives_from) === JSON.stringify(["world-maxim-a"]),
          `world<-world edge should stay bare, got ${JSON.stringify(q2.derives_from)}`);
        const q3 = qualifyCrossScopeEdges(
          p({ op: "create", scope: "world", derives_from: ["project-fact-x"] }),
          neighbors,
          undefined,
        );
        assert(JSON.stringify(q3.derives_from) === JSON.stringify(["project-fact-x"]),
          `projectId undefined -> project slug stays bare, got ${JSON.stringify(q3.derives_from)}`);
      }

      // invented_neighbor_slug across every op that accepts a slug.
      expectCode(
        { op: "create", derives_from: ["made-up-slug"] },
        "invented_neighbor_slug",
        "create derives_from invented slug",
      );
      expectCode(
        { op: "update", slug: "made-up-slug", patch: {}, timeline_note: "n" },
        "invented_neighbor_slug",
        "update on invented slug",
      );
      expectCode(
        { op: "merge", target: "made-up", sources: ["project-fact-x"], compiled_truth: "x", timeline_note: "n" },
        "invented_neighbor_slug",
        "merge target invented",
      );
      // target = legit project neighbor; source = invented — trips
      // invented_neighbor_slug BEFORE the scope loop. (Post-R2 the scope
      // check auto-corrects instead of throwing, but invented_neighbor_slug
      // still fires first, so this still pins the invented-source path.)
      expectCode(
        { op: "merge", target: "project-fact-x", sources: ["made-up"], compiled_truth: "x", timeline_note: "n" },
        "invented_neighbor_slug",
        "merge source invented",
      );
      expectCode(
        { op: "archive", slug: "made-up-slug", reason: "x" },
        "invented_neighbor_slug",
        "archive invented slug",
      );
      expectCode(
        { op: "supersede", old_slug: "made-up", reason: "x" },
        "invented_neighbor_slug",
        "supersede old invented",
      );
      expectCode(
        { op: "supersede", old_slug: "project-fact-x", new_slug: "made-up", reason: "x" },
        "invented_neighbor_slug",
        "supersede new invented",
      );
      expectCode(
        { op: "delete", slug: "made-up", mode: "soft", reason: "x" },
        "invented_neighbor_slug",
        "delete invented slug",
      );

      // malformed_curator_op: structural issues, distinct from invented slugs.
      expectCode(
        { op: "frobnicate", slug: "world-maxim-a" },
        "malformed_curator_op",
        "unsupported op",
      );
      // merge with valid (project) target+sources but missing compiled_truth.
      // validateScope passes (omitted scope, project neighbor), then the
      // missing-compiled_truth guard fires.
      expectCode(
        { op: "merge", target: "project-fact-x", sources: ["project-fact-x"], timeline_note: "n" },
        "malformed_curator_op",
        "merge missing compiled_truth",
      );
      // Non-object JSON payload (LLM emitted an array or scalar) — the
      // unwrap step itself succeeds, then the type guard at parseDecision
      // entry fires. Note: unparseable JSON (e.g. truncated transport)
      // stays under generic `curator_error` because retry can succeed.
      {
        let err = null;
        try { parseDecision(JSON.stringify(["not", "an", "object"]), neighbors); } catch (e) { err = e; }
        assert(err instanceof CuratorRejectError && err.code === "malformed_curator_op",
          `array payload should throw CuratorRejectError(malformed_curator_op), got ${err && err.constructor && err.constructor.name}: ${err && err.code}`);
      }

      // sanity: unparseable JSON STAYS at plain Error (transport-edge
      // failure, not LLM policy violation — outer catch routes it to
      // generic curator_error so retry remains meaningful).
      {
        let err = null;
        try { parseDecision("this is not json at all !!", neighbors); } catch (e) { err = e; }
        assert(err && !(err instanceof CuratorRejectError),
          `unparseable JSON should remain plain Error so it falls to generic curator_error; got: ${err && err.constructor && err.constructor.name}`);
      }
    }

    // === curator parseDecision: workflow-lane read/write asymmetry guard (2026-05-19) =====
    // sub2api audit row 32 case: curator chose op=update slug=run-when-releasing,
    // writer (updateProjectEntry/findProjectEntryFile) skips workflows/ subdir,
    // returned entry_not_found, candidate's claim silently dropped. The decoder
    // now rejects any write op targeting a workflow-lane neighbor, forcing the
    // upper curator_error catch in curateProjectDraft to convert the decision
    // to op=skip (no entry_not_found audit row, no silent data loss).
    {
      const { parseDecision, isWorkflowNeighborEntry, neighborLaneFor, CuratorRejectError } = req("./sediment/curator.js");

      // 1. detector recognises all three signals.
      //    NOTE (2026-05-19 round-2 review): storeRoot is now load-bearing
      //    for signal 3 (path probe is store-relative, not absolute). Every
      //    mock entry must set storeRoot to mirror what parser.ts emits.
      const wfByFrontmatter = {
        slug: "run-when-x",
        frontmatter: { scope: "workflow", kind: "workflow" },
        legacyKind: "workflow",
        scope: "project",
        storeRoot: "/home/u/.abrain/projects/p",
        sourcePath: "/home/u/.abrain/projects/p/workflows/run-when-x.md",
      };
      assert(isWorkflowNeighborEntry(wfByFrontmatter) === true, "frontmatter.scope=workflow should detect");

      const wfByLegacyKind = {
        slug: "legacy-pipe",
        frontmatter: { scope: "project" },
        legacyKind: "workflow",
        scope: "project",
        storeRoot: "/home/u/.abrain/projects/p",
        sourcePath: "/home/u/.abrain/projects/p/knowledge/legacy-pipe.md",
      };
      assert(isWorkflowNeighborEntry(wfByLegacyKind) === true, "legacyKind=workflow should detect");

      const wfByPath = {
        slug: "by-path",
        frontmatter: { scope: "project" },
        scope: "project",
        storeRoot: "/home/u/.abrain",
        sourcePath: "/home/u/.abrain/workflows/by-path.md",
      };
      assert(isWorkflowNeighborEntry(wfByPath) === true, "sourcePath /workflows/ should detect");

      const notWf = {
        slug: "plain-fact",
        frontmatter: { scope: "project" },
        scope: "project",
        storeRoot: "/home/u/.abrain/projects/p",
        sourcePath: "/home/u/.abrain/projects/p/knowledge/plain-fact.md",
      };
      assert(isWorkflowNeighborEntry(notWf) === false, "plain knowledge entry should NOT detect as workflow");

      // 1b. Store-relative path probe regression (Opus P2-1 round-2): when
      //     an ancestor of storeRoot is literally named "workflows" (e.g.
      //     $HOME=/var/workflows/alice), entries OUTSIDE the store's
      //     workflows/ subdir must NOT be misclassified.
      const ancestorTrap = {
        slug: "ancestor-trap",
        frontmatter: { scope: "project" },
        scope: "project",
        storeRoot: "/var/workflows/alice/.abrain/projects/p",
        sourcePath: "/var/workflows/alice/.abrain/projects/p/knowledge/x.md",
      };
      assert(isWorkflowNeighborEntry(ancestorTrap) === false,
        "ancestor dir named 'workflows' must NOT trip detector (store-relative probe)");

      //     And the same store CAN still detect a genuine workflows/
      //     entry under it.
      const ancestorTrapButReal = {
        ...ancestorTrap,
        slug: "real",
        sourcePath: "/var/workflows/alice/.abrain/projects/p/workflows/real.md",
      };
      assert(isWorkflowNeighborEntry(ancestorTrapButReal) === true,
        "real workflows/ entry under same trap-store must still detect");

      //     Defensive: sourcePath outside storeRoot (path.relative would
      //     emit '..' prefix) must not match.
      const escaped = {
        slug: "escaped",
        frontmatter: { scope: "project" },
        scope: "project",
        storeRoot: "/home/u/.abrain/projects/p",
        sourcePath: "/somewhere/else/workflows/escaped.md",
      };
      assert(isWorkflowNeighborEntry(escaped) === false,
        "sourcePath escaping storeRoot must NOT detect via path probe");

      //     Defensive: missing storeRoot disables path probe but keeps
      //     frontmatter signals.
      const noStoreRootButFm = {
        slug: "nsr-fm",
        frontmatter: { scope: "workflow" },
        scope: "project",
        sourcePath: "/anywhere/workflows/nsr-fm.md",
      };
      assert(isWorkflowNeighborEntry(noStoreRootButFm) === true,
        "missing storeRoot + frontmatter.scope=workflow must still detect via signal 1");
      const noStoreRootNoFm = {
        slug: "nsr",
        frontmatter: { scope: "project" },
        scope: "project",
        sourcePath: "/anywhere/workflows/nsr.md",
      };
      assert(isWorkflowNeighborEntry(noStoreRootNoFm) === false,
        "missing storeRoot disables signal 3 (no frontmatter fallback to false-positive on)");

      // 2. neighborLaneFor returns lane labels
      assert(neighborLaneFor(wfByFrontmatter) === "workflow", "wf entry -> lane=workflow");
      assert(neighborLaneFor(notWf) === "project", "plain project entry -> lane=project");
      const worldEntry = {
        ...notWf,
        scope: "world",
        storeRoot: "/home/u/.abrain",
        sourcePath: "/home/u/.abrain/knowledge/m.md",
      };
      assert(neighborLaneFor(worldEntry) === "world", "world entry -> lane=world");

      // 3. parseDecision rejects every write op targeting workflow-lane neighbor
      const wfNeighbors = new Map([
        ["run-when-releasing", "workflow"],
        ["some-fact", "project"],
        ["some-maxim", "world"],
      ]);
      const pWf = (obj) => parseDecision(JSON.stringify(obj), wfNeighbors);
      const expectWfThrows = (obj, opLabel) => {
        let threw = false;
        let err = null;
        try { pWf(obj); } catch (e) { threw = true; err = e; }
        assert(threw, `parseDecision should throw for ${opLabel}: ${JSON.stringify(obj)}`);
        const msg = err && err.message || "";
        assert(msg.includes("workflow-lane neighbor"), `${opLabel} error should mention workflow-lane: ${msg}`);
        assert(msg.includes("run-when-releasing"), `${opLabel} error should name the workflow slug: ${msg}`);
        // 2026-05-19 round-2 (Opus P1-2 + gpt-5.5 P2): policy rejects must
        // surface a typed CuratorRejectError with code 'workflow_lane_read_only'
        // so audit log row keeps reason granularity (not generic curator_error).
        assert(err instanceof CuratorRejectError, `${opLabel} should throw CuratorRejectError, got: ${err && err.constructor && err.constructor.name}`);
        assert(err.code === "workflow_lane_read_only", `${opLabel} reject code should be 'workflow_lane_read_only', got: ${err.code}`);
      };
      expectWfThrows({ op: "update", slug: "run-when-releasing", patch: { confidence: 8 }, timeline_note: "n" }, "update");
      expectWfThrows({ op: "supersede", old_slug: "run-when-releasing", reason: "x" }, "supersede-old");
      expectWfThrows({ op: "archive", slug: "run-when-releasing", reason: "x" }, "archive");
      expectWfThrows({ op: "delete", slug: "run-when-releasing", mode: "soft", reason: "x" }, "delete");
      expectWfThrows({ op: "merge", target: "run-when-releasing", sources: ["some-fact"], compiled_truth: "c", timeline_note: "n" }, "merge target");
      expectWfThrows({ op: "merge", target: "some-fact", sources: ["run-when-releasing"], compiled_truth: "c", timeline_note: "n" }, "merge source");
      // 3b. supersede new_slug guard (Opus P1-1 round-2): decoder must also
      //     reject when the workflow appears as the REPLACEMENT, not just
      //     the target. Previously only validateScope(oldSlug) ran, so a
      //     `{op:supersede, old:some-fact, new:run-when-releasing}` would
      //     pass and write a semantically wrong superseded_by edge.
      expectWfThrows(
        { op: "supersede", old_slug: "some-fact", new_slug: "run-when-releasing", reason: "x" },
        "supersede-new",
      );

      // 3c. scope-mismatch is now AUTO-CORRECTED, not rejected (mechanical-
      //     guard cleanup R2/A2, 2026-06-06): the neighbor's physical scope is
      //     ground truth, so parseDecision threads effectiveScopeFor(slug) into
      //     the op's scope. The former scope_mismatch_* throws are gone.
      const mixedNeighbors = new Map([
        ["world-only", "world"],
        ["project-only", "project"],
      ]);
      const pm = (obj) => parseDecision(JSON.stringify(obj), mixedNeighbors);
      // curator declared scope:world on a PROJECT neighbor -> auto-corrected to
      // project (scope omitted) so the writer routes to the project store.
      {
        const r = pm({ op: "update", scope: "world", slug: "project-only", patch: {}, timeline_note: "x" });
        assert(r.op === "update" && r.scope === undefined, `scope:world on project neighbor should auto-correct to project (scope undefined), got ${JSON.stringify(r.scope)}`);
      }
      // curator omitted scope on a WORLD neighbor -> auto-corrected to world.
      {
        const r = pm({ op: "update", slug: "world-only", patch: {}, timeline_note: "x" });
        assert(r.op === "update" && r.scope === "world", `omitted scope on world neighbor should auto-correct to world, got ${JSON.stringify(r.scope)}`);
      }
      // R2/F2 (2026-06-06): merge across mixed scopes is malformed (one store).
      {
        let mErr = null;
        try { pm({ op: "merge", target: "world-only", sources: ["project-only"], compiled_truth: "x", timeline_note: "n" }); } catch (e) { mErr = e; }
        assert(mErr instanceof CuratorRejectError && mErr.code === "malformed_curator_op",
          `merge across mixed scopes should reject malformed_curator_op, got ${mErr && mErr.code}`);
      }
      // R1/R2 (2026-06-06): supersede on a world neighbor auto-corrects scope to
      // world AND qualifies a cross-scope (project) newSlug edge.
      {
        const { qualifyCrossScopeEdges: qEdgesSup } = req("./sediment/curator.js");
        const sup = pm({ op: "supersede", old_slug: "world-only", new_slug: "project-only", reason: "x" });
        assert(sup.op === "supersede" && sup.scope === "world", `supersede on world neighbor should auto-correct scope to world, got ${JSON.stringify(sup.scope)}`);
        const supQ = qEdgesSup(sup, mixedNeighbors, "pi-global");
        assert(supQ.newSlug === "project:pi-global:project-only", `supersede cross-scope newSlug should qualify to project:pi-global:project-only, got ${JSON.stringify(supQ.newSlug)}`);
      }

      // 4. op=skip is unaffected (workflow can be cited in skip rationale)
      const skipOk = pWf({ op: "skip", reason: "workflow already covers", rationale: "run-when-releasing Task 4 covers this" });
      assert(skipOk.op === "skip", "op=skip should pass even when discussing a workflow neighbor");

      // 5. op=create with derives_from pointing at workflow IS allowed
      //    (legit graph relation: downstream knowledge observation built on workflow premise)
      const createOk = pWf({ op: "create", derives_from: ["run-when-releasing"], rationale: "downstream observation" });
      assert(createOk.op === "create" && createOk.derives_from && createOk.derives_from[0] === "run-when-releasing",
        `create with derives_from:[workflow-slug] should pass: ${JSON.stringify(createOk)}`);

      // 6. world create CAN now derive from workflow (mechanical-guard cleanup
      //    R1/A1, 2026-06-06): the former world_create_from_non_world_source
      //    throw was removed. parseDecision keeps the edge bare;
      //    qualifyCrossScopeEdges later rewrites it to workflow:<slug>.
      const wcOk = pWf({ op: "create", scope: "world", derives_from: ["run-when-releasing"] });
      assert(wcOk.op === "create" && wcOk.scope === "world" && wcOk.derives_from[0] === "run-when-releasing",
        `world<-workflow create should now pass with bare edge: ${JSON.stringify(wcOk)}`);
      const { qualifyCrossScopeEdges: qEdgesWf } = req("./sediment/curator.js");
      const wcQ = qEdgesWf(wcOk, new Map([["run-when-releasing", "workflow"]]), "pi-global");
      assert(wcQ.derives_from[0] === "workflow:run-when-releasing",
        `world<-workflow edge should qualify to workflow:run-when-releasing, got ${JSON.stringify(wcQ.derives_from)}`);
    }

    // === end-to-end: workflow neighbor flows through parser → lane label ===
    // 2026-05-19 round-2 review (Opus P2-3 + gpt-5.5 P2): the per-function
    // assertions above use hand-built MemoryEntry mocks. If parser frontmatter
    // emission or the workflow writer's id/scope keys ever drift, the mocks
    // would still pass while production silently regresses. This integration
    // wedge writes a real workflow entry via writeAbrainWorkflow (B1 lane),
    // loads it back through the parser, and checks neighborLaneFor() returns
    // 'workflow' from the parsed shape.
    {
      const ieTarget = setupAbrainTarget("integration-workflow-detect");
      const ieMemorySettings = (() => {
        const s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
        s.includeWorld = false;
        return s;
      })();
      const ieRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-wf-detect-"));
      // parser.resolveStores reads abrainHome from process.env.ABRAIN_ROOT,
      // and resolveActiveProject reads the binding from cwd/.abrain-project.json.
      // Bind the temp project so loadEntries can find the abrain project store,
      // then point ABRAIN_ROOT at the temp abrainHome for the duration of this
      // wedge.
      await bindAbrainProject({
        abrainHome: ieTarget.abrainHome,
        cwd: ieRoot,
        projectId: ieTarget.projectId,
        now: "2026-05-19T22:00:00.000+08:00",
      });
      const savedAbrainRoot = process.env.ABRAIN_ROOT;
      const savedResolveSedimentSettings = sedimentSettings.resolveSedimentSettings;
      process.env.ABRAIN_ROOT = ieTarget.abrainHome;
      sedimentSettings.resolveSedimentSettings = () => {
        const base = savedResolveSedimentSettings();
        return { ...base, knowledgeProjector: { ...base.knowledgeProjector, canonicalReadMode: "legacy" } };
      };
      try {
        // Write a project-scoped workflow via the canonical B1 writer.
        const wfWritten = await writeAbrainWorkflow(
          {
            title: "Run when releasing (smoke)",
            slug: "run-when-releasing-smoke",
            projectId: ieTarget.projectId,
            trigger: "smoke: detect workflow lane via parser",
            body: "Task blueprint body.",
            tags: ["workflow", "smoke"],
          },
          { abrainHome: ieTarget.abrainHome, settings: { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: false } },
        );
        assert(wfWritten.status === "created" && wfWritten.lane === "workflow",
          `writeAbrainWorkflow should create the workflow: ${JSON.stringify(wfWritten)}`);

        // Load via parser (memory.parser.loadEntries) and locate the slug.
        const { loadEntries } = req("./memory/parser.js");
        const { isWorkflowNeighborEntry, neighborLaneFor } = req("./sediment/curator.js");
        const entries = await loadEntries(ieRoot, ieMemorySettings);
        const wfEntry = entries.find((e) => e.slug === "run-when-releasing-smoke");
        assert(wfEntry, `parser should surface the workflow entry; got slugs: ${entries.map((e) => e.slug).join(", ")}`);
        assert(isWorkflowNeighborEntry(wfEntry) === true,
          `parsed workflow entry must trip detector; sourcePath=${wfEntry.sourcePath}, storeRoot=${wfEntry.storeRoot}, legacyKind=${wfEntry.legacyKind}, fm.scope=${JSON.stringify(wfEntry.frontmatter && wfEntry.frontmatter.scope)}`);
        assert(neighborLaneFor(wfEntry) === "workflow",
          `parsed workflow entry must map to lane=workflow; got ${neighborLaneFor(wfEntry)}`);

        // Sanity: a sibling knowledge entry on the same store does NOT trip.
        const sib = await writeProjectEntry(
          { title: "Sibling Fact", kind: "fact", status: "active", confidence: 5, compiledTruth: "Sibling body for the lane-detector smoke (sufficiently long to pass validation).", timelineNote: "seed", sessionId: "smoke-wf-detect" },
          { projectRoot: ieRoot, abrainHome: ieTarget.abrainHome, projectId: ieTarget.projectId, settings: { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: false } },
        );
        assert(sib.status === "created", `sibling knowledge write must succeed: ${JSON.stringify(sib)}`);
        const entries2 = await loadEntries(ieRoot, ieMemorySettings);
        const sibEntry = entries2.find((e) => e.slug === "sibling-fact");
        assert(sibEntry, `parser should surface the sibling fact`);
        assert(isWorkflowNeighborEntry(sibEntry) === false,
          `sibling knowledge entry MUST NOT trip detector; sourcePath=${sibEntry.sourcePath}, storeRoot=${sibEntry.storeRoot}`);
        assert(neighborLaneFor(sibEntry) === "project",
          `sibling knowledge entry must map to lane=project; got ${neighborLaneFor(sibEntry)}`);

        // ADR0039 A6 (R3 4xT0): legacy-read tripwire instrument must be wired and
        // anomaly-free outside projection_only. The two loadEntries calls above
        // surfaced entries from the abrain-project legacy store (non-projection_only
        // mode), so the counter is exercised; anomalies must be 0 (anomaly only
        // fires under projection_only). Post-flip, a separate dossier asserts the
        // legacy-winner count drops to 0.
        const { getLegacyColdReadStats } = req("./memory/parser.js");
        const a6 = getLegacyColdReadStats();
        assert(a6 && typeof a6.total === "number" && typeof a6.last === "number" && typeof a6.anomalies === "number",
          `A6 getLegacyColdReadStats must expose {total,last,anomalies}; got ${JSON.stringify(a6)}`);
        assert(a6.anomalies === 0,
          `A6 legacy_cold_access anomalies must be 0 outside projection_only; got ${a6.anomalies}`);
      } finally {
        sedimentSettings.resolveSedimentSettings = savedResolveSedimentSettings;
        if (savedAbrainRoot === undefined) delete process.env.ABRAIN_ROOT;
        else process.env.ABRAIN_ROOT = savedAbrainRoot;
      }
    }

    // === curator prompt embeds workflow-lane rule (2026-05-19) ============
    // Pin the directive markers so future prompt refactors don't silently
    // drop the rule (the decoder still enforces, but without the prompt
    // hint the LLM wastes a decision per workflow-touching candidate).
    {
      const { buildCuratorPrompt, isWorkflowNeighborEntry } = req("./sediment/curator.js");
      const wfNeighbor = {
        slug: "run-when-releasing",
        scope: "project",
        kind: "fact",
        legacyKind: "workflow",
        status: "provisional",
        confidence: 5,
        title: "release flow",
        compiledTruth: "checklist body",
        timeline: ["2026-05-15 | smoke | captured"],
        frontmatter: { scope: "workflow", kind: "workflow" },
        sourcePath: "/home/u/.abrain/projects/p/workflows/run-when-releasing.md",
      };
      const plainNeighbor = {
        slug: "some-fact",
        scope: "project",
        kind: "fact",
        status: "active",
        confidence: 5,
        title: "plain",
        compiledTruth: "plain body",
        timeline: [],
        frontmatter: { scope: "project" },
        sourcePath: "/home/u/.abrain/projects/p/knowledge/some-fact.md",
      };
      const draft = { title: "c", kind: "fact", compiledTruth: "candidate body" };
      const prompt = buildCuratorPrompt(draft, [wfNeighbor, plainNeighbor]);
      const required = [
        "Workflow-lane neighbors",
        "do NOT emit op=update / op=supersede / op=merge / op=archive / op=delete with a workflow-lane slug",
        "scope: workflow (READ-ONLY reference",
        // make sure plain neighbor still gets a normal scope line
        "scope: project",
      ];
      for (const needle of required) {
        assert(prompt.includes(needle), `curator prompt missing workflow-lane marker: ${JSON.stringify(needle)} \n--- prompt head ---\n${prompt.slice(0, 800)}`);
      }
      // sanity: the plain neighbor's scope line must NOT be polluted by
      // the workflow READ-ONLY suffix (only workflow entries get it).
      const plainLineMatch = prompt.match(/^## some-fact\nscope: ([^\n]+)$/m);
      assert(plainLineMatch && plainLineMatch[1] === "project",
        `plain neighbor's scope line should be 'scope: project', got: ${plainLineMatch && plainLineMatch[1]}`);
      // and isWorkflowNeighborEntry is reachable for callers that want
      // pre-filter logic (currently we keep workflow neighbors visible).
      assert(isWorkflowNeighborEntry(wfNeighbor) === true, "detector must agree with prompt branch");
      assert(isWorkflowNeighborEntry(plainNeighbor) === false, "detector must NOT misclassify plain neighbor");
    }

    // === writer trigger_phrases UNION =====
    // Mechanical UNION ensures curator update with new trigger_phrases
    // preserves existing retrieval anchors (never replaces).
    // Added 2026-05-13 after the 521405b curator P0 sequence.
    {
      const dwTarget = setupAbrainTarget("defense-writer");
      const dwRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-defense-writer-"));

      // Seed an entry with a substantial body + trigger_phrases.
      const longBody = "# Defense Smoke\n\n" + Array.from({ length: 30 }, (_, i) => `Evidence row ${i}: a sentence of moderate length that contributes to overall body weight.`).join("\n\n");
      const seed = await writeProjectEntry(
        { title: "Defense Smoke", kind: "fact", status: "active", confidence: 5, compiledTruth: longBody, triggerPhrases: ["alpha phrase", "beta phrase", "gamma phrase"], timelineNote: "seed", sessionId: "smoke-defense" },
        { projectRoot: dwRoot, abrainHome: dwTarget.abrainHome, projectId: dwTarget.projectId, settings: { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: false } },
      );
      assert(seed.status === "created", `seed write should succeed: ${JSON.stringify(seed)}`);
      const seedBody = fs.readFileSync(seed.path, "utf-8");
      assert(/alpha phrase/.test(seedBody) && /gamma phrase/.test(seedBody), `seed should embed trigger_phrases:\n${seedBody.slice(0, 400)}`);

      // trigger_phrases UNION: update with only "delta phrase" + an
      //     existing one in differing casing → final must include all
      //     existing + delta, no replace.
      const preserveBody = "# Defense Smoke\n\n" + Array.from({ length: 24 }, (_, i) => `Evidence row ${i}: a sentence of moderate length that contributes to overall body weight.`).join("\n\n");
      const unionRes = await updateProjectEntry(
        "defense-smoke",
        { triggerPhrases: ["ALPHA Phrase", "delta phrase"], compiledTruth: preserveBody, sessionId: "smoke-defense", timelineNote: "union test" },
        { projectRoot: dwRoot, abrainHome: dwTarget.abrainHome, projectId: dwTarget.projectId, settings: { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: false } },
      );
      assert(unionRes.status === "updated", `union update must succeed, got: ${JSON.stringify(unionRes)}`);
      const unionWritten = fs.readFileSync(unionRes.path, "utf-8");
      // alpha phrase preserved (original casing wins), beta + gamma preserved,
      // delta phrase added, no duplicate of ALPHA Phrase. yaml renderer
      // emits strings as `- "..."` (quoted-string list items) so the regex
      // accepts both quoted and unquoted forms.
      const tpLine = (p) => new RegExp(`^\\s+- (?:"|')?${p}(?:"|')?\\s*$`, "m");
      assert(tpLine("alpha phrase").test(unionWritten), `UNION must preserve original 'alpha phrase' casing:\n${unionWritten.slice(0, 600)}`);
      assert(tpLine("beta phrase").test(unionWritten), `UNION must preserve 'beta phrase':\n${unionWritten.slice(0, 600)}`);
      assert(tpLine("gamma phrase").test(unionWritten), `UNION must preserve 'gamma phrase':\n${unionWritten.slice(0, 600)}`);
      assert(tpLine("delta phrase").test(unionWritten), `UNION must add 'delta phrase':\n${unionWritten.slice(0, 600)}`);
      assert(!/ALPHA Phrase/m.test(unionWritten), `UNION must NOT duplicate 'alpha' in different casing:\n${unionWritten.slice(0, 600)}`);
      // Count: should be exactly 4 entries (alpha, beta, gamma, delta).
      const phraseLines = unionWritten.match(/^\s+- (?:"|')?(alpha|beta|gamma|delta) phrase(?:"|')?\s*$/gm) || [];
      assert(phraseLines.length === 4, `UNION should produce exactly 4 trigger_phrases, got ${phraseLines.length}: ${JSON.stringify(phraseLines)}`);

      // scalar trigger_phrases form: handwritten legacy entries may
      // have `trigger_phrases: "only one"` (scalar string) not multi-line
      // array. UNION must preserve the scalar value, not silently drop.
      const scalarTarget = setupAbrainTarget("defense-scalar");
      const scalarRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-defense-scalar-"));
      // Seed a 'legacy' entry directly on disk (writer would normalize
      // to array form, so we hand-craft the file shape).
      const scalarSlug = "legacy-scalar-tp";
      const scalarDir = path.join(scalarTarget.abrainHome, "projects", scalarTarget.projectId, "knowledge");
      fs.mkdirSync(scalarDir, { recursive: true });
      const scalarSeed = [
        "---",
        `id: project:${scalarTarget.projectId}:${scalarSlug}`,
        "scope: project",
        "kind: fact",
        "status: active",
        "confidence: 5",
        "schema_version: 1",
        'title: "Legacy Scalar TP"',
        "created: 2026-05-12T10:00:00.000+08:00",
        "updated: 2026-05-12T10:00:00.000+08:00",
        "trigger_phrases: legacy-only-anchor",  // SCALAR form
        "---",
        "",
        "# Legacy Scalar TP",
        "",
        "Body content to keep under any reasonable shrink threshold.",
        "",
        "## Timeline",
        "",
        "- 2026-05-12T10:00:00.000+08:00 | seed | captured | hand-crafted legacy scalar form",
      ].join("\n");
      fs.writeFileSync(path.join(scalarDir, `${scalarSlug}.md`), scalarSeed);
      // Update with a new trigger phrase → should UNION with the
      // existing scalar 'legacy-only-anchor', not replace it.
      const scalarUpdate = await updateProjectEntry(scalarSlug,
        { triggerPhrases: ["new-anchor"], compiledTruth: "# Legacy Scalar TP\n\nBody content to keep under any reasonable shrink threshold.\n\nMinor refinement.", sessionId: "smoke-scalar", timelineNote: "scalar union" },
        { projectRoot: scalarRoot, abrainHome: scalarTarget.abrainHome, projectId: scalarTarget.projectId, settings: { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: false } },
      );
      assert(scalarUpdate.status === "updated", `scalar UNION update must succeed, got: ${JSON.stringify(scalarUpdate)}`);
      const scalarAfter = fs.readFileSync(scalarUpdate.path, "utf-8");
      assert(/legacy-only-anchor/.test(scalarAfter), `scalar UNION must preserve original 'legacy-only-anchor' (not silently dropped):\n${scalarAfter.slice(0, 600)}`);
      assert(/new-anchor/.test(scalarAfter), `scalar UNION must add new-anchor:\n${scalarAfter.slice(0, 600)}`);
    }

    // === A3 writer rename-on-update =========================================
    // Rename is project-scope-only and scope-aware: owning-project bare refs
    // rewrite, qualified project refs rewrite everywhere, and other bare refs
    // stay unchanged.
    {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-a3-rename-project-"));
      const target = setupAbrainTarget("a3-rename-p");
      const otherProjectId = "a3-rename-q";
      fs.mkdirSync(path.join(target.abrainHome, "projects", otherProjectId, "knowledge"), { recursive: true });
      fs.mkdirSync(path.join(target.abrainHome, "knowledge"), { recursive: true });
      execFileSync("git", ["init"], { cwd: target.abrainHome, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "pi@example.test"], { cwd: target.abrainHome });
      execFileSync("git", ["config", "user.name", "pi smoke"], { cwd: target.abrainHome });
      fs.writeFileSync(path.join(target.abrainHome, ".gitignore"), ".state/\n");

      const oldSlug = "old-a3-rename-entry";
      const newSlug = "new-a3-rename-entry";
      const ownerDir = path.join(target.abrainHome, "projects", target.projectId, "knowledge");
      const otherDir = path.join(target.abrainHome, "projects", otherProjectId, "knowledge");
      const ownerPath = path.join(ownerDir, `${oldSlug}.md`);
      const ownerRefPath = path.join(ownerDir, "owner-ref.md");
      const otherRefPath = path.join(otherDir, "other-ref.md");
      const worldRefPath = path.join(target.abrainHome, "knowledge", "world-ref.md");
      fs.mkdirSync(ownerDir, { recursive: true });
      const entryMarkdown = [
        "---",
        `id: project:${target.projectId}:${oldSlug}`,
        "scope: project",
        "kind: fact",
        "status: active",
        "confidence: 5",
        "schema_version: 1",
        'title: "Old A3 Rename Entry"',
        "created: 2026-06-17T10:00:00.000+08:00",
        "updated: 2026-06-17T10:00:00.000+08:00",
        "---",
        "",
        "# Old A3 Rename Entry",
        "",
        `Self link [[${oldSlug}#anchor|self label]] should rename inside the moved entry.`,
        "",
        "## Timeline",
        "",
        "- 2026-06-17T10:00:00.000+08:00 | seed | captured | seed",
        "",
      ].join("\n");
      const ownerRefMarkdown = [
        "---",
        "id: project:a3-rename-p:owner-ref",
        "scope: project",
        "kind: fact",
        "status: active",
        "confidence: 5",
        "schema_version: 1",
        "title: Owner Ref",
        "created: 2026-06-17T10:00:00.000+08:00",
        "updated: 2026-06-17T10:00:00.000+08:00",
        "derives_from:",
        `  - ${oldSlug}`,
        `  - project:${target.projectId}:${oldSlug}`,
        "---",
        "",
        "# Owner Ref",
        "",
        `Owner bare [[${oldSlug}]] and qualified [[project:${target.projectId}:${oldSlug}]] refs should rename.`,
        "",
        "## Timeline",
        "",
        "- 2026-06-17T10:00:00.000+08:00 | seed | captured | seed",
        "",
      ].join("\n");
      const otherRefMarkdown = [
        "---",
        "id: project:a3-rename-q:other-ref",
        "scope: project",
        "kind: fact",
        "status: active",
        "confidence: 5",
        "schema_version: 1",
        "title: Other Ref",
        "created: 2026-06-17T10:00:00.000+08:00",
        "updated: 2026-06-17T10:00:00.000+08:00",
        "derives_from:",
        `  - project:${target.projectId}:${oldSlug}`,
        "---",
        "",
        "# Other Ref",
        "",
        `Other bare [[${oldSlug}]] must stay bare, but qualified [[project:${target.projectId}:${oldSlug}]] should rename.`,
        "",
        "## Timeline",
        "",
        "- 2026-06-17T10:00:00.000+08:00 | seed | captured | seed",
        "",
      ].join("\n");
      const worldRefMarkdown = [
        "---",
        "id: world:world-ref",
        "scope: world",
        "kind: fact",
        "status: active",
        "confidence: 5",
        "schema_version: 1",
        "title: World Ref",
        "created: 2026-06-17T10:00:00.000+08:00",
        "updated: 2026-06-17T10:00:00.000+08:00",
        "references:",
        `  - project:${target.projectId}:${oldSlug}`,
        "---",
        "",
        "# World Ref",
        "",
        `World qualified [[project:${target.projectId}:${oldSlug}]] should rename; bare [[${oldSlug}]] should stay.`,
        "",
        "## Timeline",
        "",
        "- 2026-06-17T10:00:00.000+08:00 | seed | captured | seed",
        "",
      ].join("\n");
      fs.writeFileSync(ownerPath, entryMarkdown);
      fs.writeFileSync(ownerRefPath, ownerRefMarkdown);
      fs.writeFileSync(otherRefPath, otherRefMarkdown);
      fs.writeFileSync(worldRefPath, worldRefMarkdown);
      execFileSync("git", ["add", "."], { cwd: target.abrainHome });
      execFileSync("git", ["commit", "-q", "-m", "seed a3 rename fixture"], { cwd: target.abrainHome });

      const renameResult = await updateProjectEntry(
        oldSlug,
        {
          newSlug,
          compiledTruth: "# Old A3 Rename Entry\n\nSelf link [[old-a3-rename-entry#anchor|self label]] should rename inside the moved entry. Updated body.",
          sessionId: "smoke-a3-rename",
        },
        { projectRoot, abrainHome: target.abrainHome, projectId: target.projectId, settings: { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: true } },
      );
      assert(renameResult.status === "updated" && renameResult.slug === newSlug, `rename update must succeed: ${JSON.stringify(renameResult)}`);
      assert(!fs.existsSync(ownerPath), "old path must be removed after rename");
      assert(fs.existsSync(renameResult.path), "new path must exist after rename");
      const moved = fs.readFileSync(renameResult.path, "utf-8");
      assert(new RegExp(`^id: project:${target.projectId}:${newSlug}$`, "m").test(moved), `moved entry id must use new slug:\n${moved.slice(0, 500)}`);
      assert(moved.includes(`[[${newSlug}#anchor|self label]]`), `moved entry self link should preserve anchor/alias:\n${moved}`);
      assert(/\| renamed \| old-a3-rename-entry → new-a3-rename-entry$/m.test(moved), `moved entry timeline must record renamed action:\n${moved}`);

      const ownerAfter = fs.readFileSync(ownerRefPath, "utf-8");
      assert(ownerAfter.includes(`[[${newSlug}]]`) && ownerAfter.includes(`[[project:${target.projectId}:${newSlug}]]`), `owner refs should rewrite bare + qualified:\n${ownerAfter}`);
      assert(ownerAfter.includes(`  - ${newSlug}`) && ownerAfter.includes(`  - project:${target.projectId}:${newSlug}`), `owner relations should rewrite bare + qualified:\n${ownerAfter}`);
      const otherAfter = fs.readFileSync(otherRefPath, "utf-8");
      assert(otherAfter.includes(`Other bare [[${oldSlug}]] must stay bare`), `other project bare ref must not rewrite:\n${otherAfter}`);
      assert(otherAfter.includes(`[[project:${target.projectId}:${newSlug}]]`) && otherAfter.includes(`  - project:${target.projectId}:${newSlug}`), `other project qualified refs should rewrite:\n${otherAfter}`);
      const worldAfter = fs.readFileSync(worldRefPath, "utf-8");
      assert(worldAfter.includes(`[[project:${target.projectId}:${newSlug}]]`) && worldAfter.includes(`  - project:${target.projectId}:${newSlug}`), `world qualified refs should rewrite:\n${worldAfter}`);
      assert(worldAfter.includes(`bare [[${oldSlug}]] should stay`), `world bare ref must not rewrite:\n${worldAfter}`);
      const gitStatus = execFileSync("git", ["-C", target.abrainHome, "status", "--porcelain"], { encoding: "utf-8" });
      assert(gitStatus.trim() === "", `rename transaction should leave clean git worktree, got:\n${gitStatus}`);
    }

    // === A3 runtime recovery for leftover rename transaction ================
    {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-a3-rename-recovery-project-"));
      const target = setupAbrainTarget("a3-recovery-p");
      const ownerDir = path.join(target.abrainHome, "projects", target.projectId, "knowledge");
      fs.mkdirSync(ownerDir, { recursive: true });
      fs.mkdirSync(path.join(target.abrainHome, "knowledge"), { recursive: true });
      execFileSync("git", ["init"], { cwd: target.abrainHome, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "pi@example.test"], { cwd: target.abrainHome });
      execFileSync("git", ["config", "user.name", "pi smoke"], { cwd: target.abrainHome });
      fs.writeFileSync(path.join(target.abrainHome, ".gitignore"), ".state/\n");

      const oldSlug = "old-a3-recovery-entry";
      const newSlug = "new-a3-recovery-entry";
      const oldPath = path.join(ownerDir, `${oldSlug}.md`);
      const newPath = path.join(ownerDir, `${newSlug}.md`);
      const refPath = path.join(ownerDir, "recovery-ref.md");
      const oldRaw = [
        "---",
        `id: project:${target.projectId}:${oldSlug}`,
        "scope: project",
        "kind: fact",
        "status: active",
        "confidence: 5",
        "schema_version: 1",
        "title: Old A3 Recovery Entry",
        "created: 2026-06-17T10:00:00.000+08:00",
        "updated: 2026-06-17T10:00:00.000+08:00",
        "---",
        "",
        "# Old A3 Recovery Entry",
        "",
        "Original body.",
        "",
        "## Timeline",
        "",
        "- 2026-06-17T10:00:00.000+08:00 | seed | captured | seed",
        "",
      ].join("\n");
      const refRaw = [
        "---",
        "id: project:a3-recovery-p:recovery-ref",
        "scope: project",
        "kind: fact",
        "status: active",
        "confidence: 5",
        "schema_version: 1",
        "title: Recovery Ref",
        "created: 2026-06-17T10:00:00.000+08:00",
        "updated: 2026-06-17T10:00:00.000+08:00",
        "relates_to:",
        `  - ${oldSlug}`,
        "---",
        "",
        "# Recovery Ref",
        "",
        `Ref [[${oldSlug}]] should be restored by recovery rollback.`,
        "",
        "## Timeline",
        "",
        "- 2026-06-17T10:00:00.000+08:00 | seed | captured | seed",
        "",
      ].join("\n");
      fs.writeFileSync(oldPath, oldRaw);
      fs.writeFileSync(refPath, refRaw);
      execFileSync("git", ["add", "."], { cwd: target.abrainHome });
      execFileSync("git", ["commit", "-q", "-m", "seed a3 recovery fixture"], { cwd: target.abrainHome });
      const baseHead = execFileSync("git", ["-C", target.abrainHome, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();

      const newRaw = oldRaw.replace(`id: project:${target.projectId}:${oldSlug}`, `id: project:${target.projectId}:${newSlug}`).replace("# Old A3 Recovery Entry", "# New A3 Recovery Entry");
      const refNewRaw = refRaw.replaceAll(oldSlug, newSlug);
      const markerPath = await writeRenameTransactionMarker({
        target: { scope: "project", projectId: target.projectId, oldSlug, newSlug },
        baseHead,
        entryOldPath: oldPath,
        entryNewPath: newPath,
        entryNewContent: newRaw,
        expectedNewId: `project:${target.projectId}:${newSlug}`,
        fileChanges: [{ path: refPath, newContent: refNewRaw }],
        vectorStaleSlugs: [oldSlug, newSlug],
      }, { abrainHome: target.abrainHome });
      fs.writeFileSync(newPath, newRaw);
      fs.writeFileSync(refPath, refNewRaw);
      fs.mkdirSync(path.join(target.abrainHome, ".state", "memory"), { recursive: true });
      const indexPath = path.join(target.abrainHome, ".state", "memory", "embeddings.json");
      const idx = new VectorIndex(indexPath, "smoke-model", 3);
      idx.upsert(newSlug, "h-new", [[1, 0, 0]], `project:${target.projectId}`, "s");
      idx.save();

      const recoveryResult = await writeProjectEntry({
        title: "Write After A3 Recovery",
        kind: "fact",
        confidence: 5,
        compiledTruth: "This write should be rejected once after rollback.",
      }, { projectRoot, abrainHome: target.abrainHome, projectId: target.projectId, settings: { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: false }, dryRun: false });
      assert(recoveryResult.status === "rejected" && recoveryResult.reason === "rename_transaction_rolled_back", `recovery should reject current write once, got: ${JSON.stringify(recoveryResult)}`);
      assert(!fs.existsSync(markerPath), "rename transaction marker should be removed by recovery");
      assert(fs.existsSync(oldPath), "old path should remain after recovery rollback");
      assert(!fs.existsSync(newPath), "new path should be removed by recovery rollback");
      const refAfter = fs.readFileSync(refPath, "utf-8");
      assert(refAfter.includes(`[[${oldSlug}]]`) && refAfter.includes(`  - ${oldSlug}`), `refs should be restored to old slug:\n${refAfter}`);
      const idxAfter = new VectorIndex(indexPath, "smoke-model", 3).load();
      assert(idxAfter.topN([1, 0, 0], 5, { allowSlugs: new Set([oldSlug]) }).some((r) => r.slug === oldSlug), "vector rollback should restore old slug vector");
      assert(!idxAfter.topN([1, 0, 0], 5, { allowSlugs: new Set([newSlug]) }).some((r) => r.slug === newSlug), "vector rollback should remove new slug vector");
      const gitStatus = execFileSync("git", ["-C", target.abrainHome, "status", "--porcelain"], { encoding: "utf-8" });
      assert(gitStatus.trim() === "", `recovery rollback should leave clean git worktree, got:\n${gitStatus}`);
    }

    // === slug-from-title bug fix ===========================================
    // First-fire 2026-05-08 produced an entry with title "Sediment Audit
    // Rows Can Be Distinguished by extractor/reason Combinations" — the
    // writer used normalizeBareSlug(title) which interprets `/` as a
    // path separator and only kept "reason Combinations". Slug landed as
    // `reason-combinations` (lossy + ambiguous). Writer + dedupe both now
    // call slugify(title) directly. This regression locks in the fix.
    {
      const slugBugRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-slugbug-"));
      fs.mkdirSync(path.join(slugBugRoot, ".pensieve"), { recursive: true });
      execFileSync("git", ["init"], { cwd: slugBugRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "pi@example.test"], { cwd: slugBugRoot });
      execFileSync("git", ["config", "user.name", "pi smoke"], { cwd: slugBugRoot });
      const slugBugTarget = setupAbrainTarget("slug-bug-regression");
      const titleWithSlash = "Audit Rows Distinguished by extractor/reason Combinations";
      const w = await writeProjectEntry({
        title: titleWithSlash,
        kind: "fact",
        confidence: 5,
        compiledTruth: "Body content for the slug-from-title regression.",
      }, { projectRoot: slugBugRoot, abrainHome: slugBugTarget.abrainHome, projectId: slugBugTarget.projectId, settings: { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: false }, dryRun: false });
      assert(w.status === "created", `slug-bug write failed: ${w.reason}`);
      // Expected: slug derived from full title with / replaced by -.
      assert(
        w.slug === "audit-rows-distinguished-by-extractor-reason-combinations",
        `slug must include both sides of '/' as words, got: ${w.slug}`,
      );
      // Negative: must NOT be the truncated form from the bug.
      assert(w.slug !== "reason-combinations", `slug truncation bug regressed: ${w.slug}`);
      // Dedupe should also see the same full slug (scan abrain target, not legacy .pensieve).
      const { detectProjectDuplicate } = req("./sediment/dedupe.js");
      const dup = await detectProjectDuplicate(path.join(slugBugTarget.abrainHome, "projects", slugBugTarget.projectId), titleWithSlash);
      assert(dup.duplicate && dup.reason === "slug_exact", `dedupe must see same title: ${JSON.stringify(dup)}`);
    }

    // === Sediment status footer state machine ============================
    // The user-spec'd FSM:
    //   session_start -> idle
    //   agent_start in (completed|failed) -> idle
    //   agent_start in running -> running (unchanged)
    //   agent_end transitions running -> completed/failed.
    //
    // We can exercise the helper functions directly via the test
    // export. The hooks themselves are pi-runtime-bound and tested
    // live (smoke can't fake pi.on); here we lock in the helper logic.
    {
      const sedimentMod = req("./sediment/index.js");
      // Internal helpers aren't exported individually — we test via
      // the public reset and the rendered status string format.
      const { renderSedimentStatus } = sedimentMod;
      // renderSedimentStatus may not be exported; verify by rendering
      // through the public path instead. Skip if not exported.
      if (typeof renderSedimentStatus === "function") {
        const idle = renderSedimentStatus("idle");
        const running = renderSedimentStatus("running", "auto-write");
        const completed = renderSedimentStatus("completed", "3 entries");
        const failed = renderSedimentStatus("failed", "LLM error");
        // commit 9700de5 (2026-05-12 refactor: compact footer status display)
        // simplified prefixes from "💤 sediment idle" → "💤 sediment" etc.,
        // letting emoji convey the state instead of an English word. State is
        // now distinguished by emoji + detail field, not by literal state name.
        // Smoke assertions updated to match the new contract.
        assert(idle.includes("💤") && idle.includes("sediment"), `idle render missing emoji+sediment: ${idle}`);
        assert(running.includes("📝") && running.includes("auto-write"), `running render: ${running}`);
        assert(completed.includes("✅") && completed.includes("3 entries"), `completed render: ${completed}`);
        assert(failed.includes("⚠️") && failed.includes("LLM error"), `failed render: ${failed}`);
      }
    }

    // === A2 integration: direct auto-write substrate via mock modelRegistry ===
    // After ADR 0016, there is no readiness/rate/sampling/rolling gate in
    // this path. Extractor output goes through schema validation + curator/
    // write substrate; git/audit are rollback.
    {
      const { _resetAutoWriteStateForTests } = req("./sediment/index.js");
      _resetAutoWriteStateForTests();

      const aRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-a2-"));
      fs.mkdirSync(path.join(aRoot, ".pensieve"), { recursive: true });
      execFileSync("git", ["init"], { cwd: aRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "pi@example.test"], { cwd: aRoot });
      execFileSync("git", ["config", "user.name", "pi smoke"], { cwd: aRoot });
      // Post-2026-05-13 cutover: writer needs abrainHome + projectId. The
      // a2 fixture exercises the full lifecycle (write/update/merge/
      // archive/supersede/delete) against a single abrain target so all
      // mutations target the same projects/<id>/ tree.
      const aTarget = setupAbrainTarget("a2-fixture");


      // Stub the @earendil-works/pi-ai module so streamSimple returns a
      // canned MEMORY block. We use a fresh require cache slot.
      const piAiPath = path.join(outRoot, "node_modules", "@earendil-works", "pi-ai");
      fs.mkdirSync(piAiPath, { recursive: true });
      fs.writeFileSync(path.join(piAiPath, "package.json"), JSON.stringify({ name: "@earendil-works/pi-ai", main: "index.js" }));
      // The stub captures the prompt so we can assert it contained the
      // role-aware Trust Boundary directive. Each call returns a
      // different response based on the global counter.
      let invocations = 0;
      const RESPONSES = [
        // Run 1: clean valid block.
        "MEMORY:\ntitle: A2 Mock Extracted Insight\nkind: fact\nconfidence: 4\n---\n# A2 Mock Extracted Insight\n\nThe LLM auto-write lane successfully extracted this insight from the transcript window.\nEND_MEMORY",
        // Run 2: SKIP for the credential-redaction prompt check.
        "SKIP",
        // Run 3: SKIP.
        "SKIP",
        // Run 4: maxim/high-confidence attempt. ADR 0016 trusts it.
        "MEMORY:\ntitle: Trusted Maxim Attempt\nkind: maxim\nstatus: active\nconfidence: 9\n---\n# Trusted Maxim Attempt\n\nThis attempts to mint a maxim with confidence 9. ADR 0016 trusts the model to write maxim/high confidence when warranted.\nEND_MEMORY",
      ];
      // Reset global so we control invocation count.
      globalThis.__A2_INVOCATIONS__ = 0;
      globalThis.__A2_LAST_PROMPT__ = "";
      globalThis.__A2_RESPONSES__ = RESPONSES;
      fs.writeFileSync(path.join(piAiPath, "index.js"), `
exports.streamSimple = function streamSimple(_model, opts, _config) {
  const text = (globalThis.__A2_RESPONSES__ || [])[globalThis.__A2_INVOCATIONS__++] || "SKIP";
  globalThis.__A2_LAST_PROMPT__ = (opts.messages?.[0]?.content?.[0]?.text || "");
  return {
    result: () => Promise.resolve({
      stopReason: "complete",
      content: [{ type: "text", text }],
    }),
  };
};
`);

      // Mock model registry: find returns a placeholder; auth returns ok.
      const mockModelRegistry = {
        find: () => ({ id: "mock-extractor", contextWindow: 100000 }),
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-test-not-a-real-key-just-shape", headers: {} }),
      };

      // Recreate the auto-write substrate directly. The hook's live path
      // additionally calls the curator loop; here we lock in extractor,
      // schema validation, writer create, and writer update behavior.
      const { runLlmExtractor } = req("./sediment/llm-extractor.js");
      const { previewExtraction, parseExplicitMemoryBlocks: parseBlocks } = req("./sediment/extractor.js");

      const a2Settings = {
        ...DEFAULT_SEDIMENT_SETTINGS,
        autoLlmWriteEnabled: true,
        extractorModel: "mock/extractor",
        curatorModel: "mock/curator",
        gitCommit: false,
      };

      // Run the extractor directly (the in-process flow that
      // tryAutoWriteLane uses) for response[0]: valid block.
      const r1 = await runLlmExtractor("--- ENTRY 1 t1 message/assistant ---\nWe figured out X.", {
        settings: a2Settings,
        modelRegistry: mockModelRegistry,
      });
      assert(r1.ok && r1.rawText && r1.rawText.includes("A2 Mock Extracted Insight"), `r1 mock should return valid block: ${JSON.stringify(r1)}`);
      // Round 10: sanitizer must run as an INPUT redaction boundary.
      // windowText containing a credential may still reach the LLM provider,
      // but only after the raw token is replaced with a typed placeholder.
      const rawGithubToken = "ghp_" + "1234567890abcdefghijklmnopqrstuv";
      const rSecret = await runLlmExtractor(
        `--- ENTRY X t1 message/user ---\nMy github token is ${rawGithubToken}. Help me debug.`,
        { settings: a2Settings, modelRegistry: mockModelRegistry },
      );
      assert(rSecret.ok, `window with credential should redact and continue, got: ${JSON.stringify(rSecret)}`);
      assert(
        globalThis.__A2_LAST_PROMPT__.includes("[SECRET:github_token]") && !globalThis.__A2_LAST_PROMPT__.includes(rawGithubToken),
        "mock LLM prompt must contain placeholder and not raw credential",
      );
      assert(
        rSecret.preSanitizeRedacted && rSecret.preSanitizeReplacements?.includes("credential:github_token"),
        `extractor result should expose pre-LLM redaction metadata: ${JSON.stringify(rSecret)}`,
      );
      const rSecretSummary = summarizeLlmExtractorResult(rSecret, { maxCandidates: 3, rawPreviewChars: 100 });
      assert(
        rSecretSummary.quality.reason === "skip" && rSecretSummary.quality.preSanitizeRedacted && rSecretSummary.quality.preSanitizeReplacements?.includes("credential:github_token"),
        `audit summary should record redaction without credential_in_window abort semantics: ${JSON.stringify(rSecretSummary)}`,
      );
      const authErrorToken = "ghp_" + "abcdefghijklmnopqrstuv1234567890";
      const authErrorResult = await runLlmExtractor("--- ENTRY 1 t message/assistant ---\nhello", {
        settings: a2Settings,
        modelRegistry: {
          find: () => ({ id: "mock-extractor" }),
          getApiKeyAndHeaders: async () => ({ ok: false, error: `bad auth ${authErrorToken}` }),
        },
      });
      assert(
        !authErrorResult.ok && authErrorResult.error?.includes("[SECRET:github_token]") && !authErrorResult.error.includes(authErrorToken),
        `extractor auth errors must be sanitized before audit summary: ${JSON.stringify(authErrorResult)}`,
      );

      // rawTextPreview on an LLM response that echoes back a credential
      // must redact the secret span with a typed placeholder, not store the
      // raw value in audit.jsonl.
      const anthropicEchoRaw = "sk-ant-" + "api03-AbCdEfGhIjKlMnOpQrStUv";
      const sumEcho = summarizeLlmExtractorResult(
        { ok: true, model: "x/y", rawText: `I see your key ${anthropicEchoRaw}`, extraction: { count: 0, drafts: [] } },
        { maxCandidates: 3, rawPreviewChars: 200 },
      );
      assert(
        sumEcho.quality.rawTextPreview && sumEcho.quality.rawTextPreview.includes("[SECRET:anthropic_api_key]") && !sumEcho.quality.rawTextPreview.includes(anthropicEchoRaw),
        `rawTextPreview echoing a credential must redact the secret span, got: ${sumEcho.quality.rawTextPreview}`,
      );
      const sumEchoTinyPreview = summarizeLlmExtractorResult(
        { ok: true, model: "x/y", rawText: `I see your key ${anthropicEchoRaw}`, extraction: { count: 0, drafts: [] } },
        { maxCandidates: 3, rawPreviewChars: 24 },
      );
      assert(
        sumEchoTinyPreview.quality.rawTextPreview && !sumEchoTinyPreview.quality.rawTextPreview.includes("sk-ant-"),
        `rawTextPreview must sanitize before truncating partial tokens, got: ${sumEchoTinyPreview.quality.rawTextPreview}`,
      );
      // Benign preview is preserved (no false positive)
      const sumBenign = summarizeLlmExtractorResult(
        { ok: true, model: "x/y", rawText: "MEMORY:\ntitle: ok\n---\nnothing secret here at all\nEND_MEMORY", extraction: { count: 0, drafts: [] } },
        { maxCandidates: 3, rawPreviewChars: 100 },
      );
      assert(
        sumBenign.quality.rawTextPreview && !sumBenign.quality.rawTextPreview.includes("[SECRET:"),
        `benign preview must NOT be redacted (false positive), got: ${sumBenign.quality.rawTextPreview}`,
      );
      // Verify the prompt contained the Trust Boundary directive.
      assert(globalThis.__A2_LAST_PROMPT__.includes("Trust boundary"), "prompt to mock LLM missing Trust boundary directive");
      // Parse + schema-only validation. Semantic hard gates are gone.
      const drafts1 = parseBlocks(r1.rawText);
      const preview1 = previewExtraction(drafts1);
      assert(preview1.drafts[0].validationErrors.length === 0, `r1 should pass schema validation: ${JSON.stringify(preview1)}`);
      // Write through the production path.
      const w1 = await writeProjectEntry({
        ...drafts1[0],
        sessionId: "smoke-a2",
        timelineNote: "smoke A2 e2e",
      }, { projectRoot: aRoot, abrainHome: aTarget.abrainHome, projectId: aTarget.projectId, settings: a2Settings, dryRun: false });
      assert(w1.status === "created", `r1 write failed: ${w1.reason}`);
      const r1Written = fs.readFileSync(w1.path, "utf-8");
      assert(/^status: provisional$/m.test(r1Written), `r1 omitted status should default to provisional, got:\n${r1Written}`);
      assert(/^confidence: 4$/m.test(r1Written), `r1 confidence preserved at 4`);
      assert(/^created: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?[+-]\d{2}:\d{2}$/m.test(r1Written), `r1 created must be ISO datetime, got:\n${r1Written}`);
      assert(/^updated: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?[+-]\d{2}:\d{2}$/m.test(r1Written), `r1 updated must be ISO datetime, got:\n${r1Written}`);
      assert(/^- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?[+-]\d{2}:\d{2} \| smoke-a2 \| captured \| smoke A2 e2e$/m.test(r1Written), `r1 timeline must use ISO datetime, got:\n${r1Written}`);

      // Response[2]: SKIP. Caller should treat as no candidates.
      const r2 = await runLlmExtractor("--- ENTRY 2 t2 message/assistant ---\nNothing notable.", {
        settings: a2Settings,
        modelRegistry: mockModelRegistry,
      });
      assert(r2.ok && r2.rawText === "SKIP", `r2 SKIP path: ${JSON.stringify(r2)}`);

      // Response[3]: maxim+confidence=9. Schema-only validation allows it.
      const r3 = await runLlmExtractor("--- ENTRY 3 t3 message/assistant ---\nWe should ALWAYS do X.", {
        settings: a2Settings,
        modelRegistry: mockModelRegistry,
      });
      assert(r3.ok && r3.rawText.includes("Trusted Maxim Attempt"), "r3 should return maxim attempt");
      const drafts3 = parseBlocks(r3.rawText);
      const preview3 = previewExtraction(drafts3);
      assert(preview3.drafts[0].validationErrors.length === 0, `r3 must pass schema-only validation: ${JSON.stringify(preview3)}`);
      const w3 = await writeProjectEntry({
        ...drafts3[0],
        sessionId: "smoke-a2",
        timelineNote: "trusted maxim smoke",
      }, { projectRoot: aRoot, abrainHome: aTarget.abrainHome, projectId: aTarget.projectId, settings: a2Settings, dryRun: false });
      assert(w3.status === "created", `r3 default llm mode must create: ${JSON.stringify(w3)}`);
      const r3Written = fs.readFileSync(w3.path, "utf-8");
      assert(/^kind: maxim$/m.test(r3Written) && /^status: active$/m.test(r3Written) && /^confidence: 9$/m.test(r3Written), `r3 maxim/status/confidence not preserved:\n${r3Written}`);

      // ADR 0016 update substrate: existing memory can evolve instead of
      // append-only duplicate creation. Update compiled truth, status,
      // confidence, and append an ISO timestamped timeline row.
      const update = await updateProjectEntry(w1.slug, {
        status: "active",
        confidence: 8,
        compiledTruth: "# A2 Mock Extracted Insight\n\nThe curator updated this existing memory instead of creating a parallel duplicate.",
        sessionId: "smoke-a2",
        timelineNote: "curator update smoke",
      }, { projectRoot: aRoot, abrainHome: aTarget.abrainHome, projectId: aTarget.projectId, settings: a2Settings, dryRun: false });
      assert(update.status === "updated", `updateProjectEntry should update existing entry: ${JSON.stringify(update)}`);
      const updatedWritten = fs.readFileSync(update.path, "utf-8");
      assert(/^status: active$/m.test(updatedWritten), `update should preserve patched status active:\n${updatedWritten}`);
      assert(/^confidence: 8$/m.test(updatedWritten), `update should preserve patched confidence 8:\n${updatedWritten}`);
      assert(updatedWritten.includes("curator updated this existing memory") || updatedWritten.includes("The curator updated this existing memory"), `update compiled truth missing:\n${updatedWritten}`);
      assert(/^- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?[+-]\d{2}:\d{2} \| smoke-a2 \| updated \| curator update smoke$/m.test(updatedWritten), `update timeline must append ISO updated row:\n${updatedWritten}`);

      const merged = await mergeProjectEntries(w1.slug, [w1.slug, w3.slug], {
        compiledTruth: "# A2 Mock Extracted Insight\n\nThe curator merged two related memories into one best current compiled truth.",
        reason: "merge substrate smoke",
        sessionId: "smoke-a2",
      }, { projectRoot: aRoot, abrainHome: aTarget.abrainHome, projectId: aTarget.projectId, settings: a2Settings, dryRun: false });
      assert(merged.length === 2 && merged[0].status === "merged" && merged[1].status === "archived", `mergeProjectEntries should update target and archive non-target source: ${JSON.stringify(merged)}`);
      const mergedWritten = fs.readFileSync(merged[0].path, "utf-8");
      assert(/^derives_from:\n  - trusted-maxim-attempt$/m.test(mergedWritten), `merge should set derives_from relation:\n${mergedWritten}`);
      assert(/^- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?[+-]\d{2}:\d{2} \| smoke-a2 \| merged \| merge substrate smoke$/m.test(mergedWritten), `merge timeline missing:\n${mergedWritten}`);

      const archived = await archiveProjectEntry(w1.slug, { projectRoot: aRoot, abrainHome: aTarget.abrainHome, projectId: aTarget.projectId, settings: a2Settings, dryRun: false, reason: "archive substrate smoke", sessionId: "smoke-a2" });
      assert(archived.status === "archived", `archiveProjectEntry should archive existing entry: ${JSON.stringify(archived)}`);
      const archivedWritten = fs.readFileSync(archived.path, "utf-8");
      assert(/^status: archived$/m.test(archivedWritten), `archive should mark status archived:\n${archivedWritten}`);
      assert(/^- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?[+-]\d{2}:\d{2} \| smoke-a2 \| archived \| archive substrate smoke$/m.test(archivedWritten), `archive timeline missing:\n${archivedWritten}`);

      // === ADR 0025 §4.6 archive_at lifecycle regression ===
      //
      // Three transitions must hold on the writer:
      //   (a) NON-ARCHIVED → ARCHIVED stamps archive_at = now
      //   (b) ARCHIVED → ARCHIVED (subsequent update) PRESERVES it
      //   (c) ARCHIVED → NON-ARCHIVED (reactivation) CLEARS it
      //
      // (a) Just-archived entry must carry an ISO archive_at field.
      const archiveAtMatchA = archivedWritten.match(/^archive_at: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?[+-]\d{2}:\d{2})$/m);
      assert(archiveAtMatchA, `(a) archive should stamp archive_at:\n${archivedWritten}`);
      const stampedArchiveAt = archiveAtMatchA[1];

      // (b) Subsequent update to an already-archived entry must NOT slide
      // the archive_at forward, otherwise the future N-day soft-delete
      // reviewer window can never close.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const archivedAgain = await updateProjectEntry(w1.slug, {
        timelineNote: "touch archived entry to verify archive_at sticks",
        timelineAction: "updated",
      }, {
        projectRoot: aRoot,
        abrainHome: aTarget.abrainHome,
        projectId: aTarget.projectId,
        settings: a2Settings,
        dryRun: false,
      });
      assert(archivedAgain.status === "updated", `(b) update on archived entry should succeed: ${JSON.stringify(archivedAgain)}`);
      const archivedAgainWritten = fs.readFileSync(archivedAgain.path, "utf-8");
      const archiveAtMatchB = archivedAgainWritten.match(/^archive_at: (.+)$/m);
      assert(archiveAtMatchB, `(b) second update should preserve archive_at:\n${archivedAgainWritten}`);
      assert(archiveAtMatchB[1] === stampedArchiveAt, `(b) archive_at must NOT slide forward on subsequent update: was ${stampedArchiveAt}, now ${archiveAtMatchB[1]}`);

      // (c) Reactivation via update(status:"active") must clear archive_at.
      // (Reactivation flow is what the not-yet-implemented ADR §4.6
      // archive-reactivation-reviewer will eventually trigger. The field
      // contract must already be right today so the reviewer can be
      // written against a stable shape later.)
      const reactivated = await updateProjectEntry(w1.slug, {
        status: "active",
        timelineNote: "reactivate archived entry",
        timelineAction: "reactivated",
      }, {
        projectRoot: aRoot,
        abrainHome: aTarget.abrainHome,
        projectId: aTarget.projectId,
        settings: a2Settings,
        dryRun: false,
      });
      assert(reactivated.status === "updated", `(c) reactivation update should succeed: ${JSON.stringify(reactivated)}`);
      const reactivatedWritten = fs.readFileSync(reactivated.path, "utf-8");
      assert(/^status: active$/m.test(reactivatedWritten), `(c) reactivation should flip status back to active:\n${reactivatedWritten}`);
      assert(!/^archive_at:/m.test(reactivatedWritten), `(c) reactivation must clear archive_at:\n${reactivatedWritten}`);

      // Re-archive after reactivation: archive_at must be stamped fresh
      // (NOT carried over from the prior stamp, which is no longer
      // semantically valid for the new archive episode).
      await new Promise((resolve) => setTimeout(resolve, 50));
      const reArchived = await archiveProjectEntry(w1.slug, {
        projectRoot: aRoot, abrainHome: aTarget.abrainHome, projectId: aTarget.projectId,
        settings: a2Settings, dryRun: false, reason: "re-archive after reactivation", sessionId: "smoke-a2",
      });
      assert(reArchived.status === "archived", `(d) re-archive should succeed: ${JSON.stringify(reArchived)}`);
      const reArchivedWritten = fs.readFileSync(reArchived.path, "utf-8");
      const archiveAtMatchD = reArchivedWritten.match(/^archive_at: (.+)$/m);
      assert(archiveAtMatchD, `(d) re-archive should stamp archive_at:\n${reArchivedWritten}`);
      assert(archiveAtMatchD[1] !== stampedArchiveAt, `(d) re-archive must stamp fresh archive_at, not carry over ${stampedArchiveAt}`);

      const superseded = await supersedeProjectEntry(w1.slug, { projectRoot: aRoot, abrainHome: aTarget.abrainHome, projectId: aTarget.projectId, settings: a2Settings, dryRun: false, newSlug: w3.slug, reason: "supersede substrate smoke", sessionId: "smoke-a2" });
      assert(superseded.status === "superseded", `supersedeProjectEntry should supersede existing entry: ${JSON.stringify(superseded)}`);
      const supersededWritten = fs.readFileSync(superseded.path, "utf-8");
      assert(/^status: superseded$/m.test(supersededWritten), `supersede should mark status superseded:\n${supersededWritten}`);
      assert(/^superseded_by:\n  - trusted-maxim-attempt$/m.test(supersededWritten), `supersede should set superseded_by relation:\n${supersededWritten}`);
      assert(/^- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?[+-]\d{2}:\d{2} \| smoke-a2 \| superseded \| superseded by trusted-maxim-attempt: supersede substrate smoke$/m.test(supersededWritten), `supersede timeline missing:\n${supersededWritten}`);

      const softDeleted = await deleteProjectEntry(w3.slug, { projectRoot: aRoot, abrainHome: aTarget.abrainHome, projectId: aTarget.projectId, settings: a2Settings, dryRun: false, reason: "delete substrate smoke", sessionId: "smoke-a2" });
      assert(softDeleted.status === "deleted" && softDeleted.deleteMode === "soft" && fs.existsSync(softDeleted.path), `soft delete should archive existing entry without unlinking it: ${JSON.stringify(softDeleted)}`);
      const softDeletedWritten = fs.readFileSync(softDeleted.path, "utf-8");
      assert(/^status: archived$/m.test(softDeletedWritten), `soft delete should mark status archived:\n${softDeletedWritten}`);
      assert(/^- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?[+-]\d{2}:\d{2} \| smoke-a2 \| deleted \| soft delete: delete substrate smoke$/m.test(softDeletedWritten), `soft delete timeline missing:\n${softDeletedWritten}`);

      const hardDeleted = await deleteProjectEntry(w3.slug, { projectRoot: aRoot, abrainHome: aTarget.abrainHome, projectId: aTarget.projectId, settings: a2Settings, dryRun: false, mode: "hard", reason: "hard delete substrate smoke" });
      assert(hardDeleted.status === "deleted" && hardDeleted.deleteMode === "hard" && !fs.existsSync(hardDeleted.path), `hard delete should unlink existing entry: ${JSON.stringify(hardDeleted)}`);

      // === B5 cutover regression: tryAutoWriteLane closure-arg threading ===
      //
      // 2026-05-13 opus code review found that `tryAutoWriteLane` is a
      // module-level function that referenced bare `abrainHome` /
      // `projectId` names that ONLY exist inside the agent_end listener
      // closure. Production smoke missed it because every existing fixture
      // calls the writer functions directly. This case drives the
      // extractor → curator → writer integration path so the closure-arg
      // wiring stays locked. ts.transpileModule() does not do name
      // resolution, so a missing arg surfaces only at runtime.
      {
        const { _tryAutoWriteLaneForTests } = req("./sediment/index.js");
        // Reset the per-window stub state and inject a fresh response.
        globalThis.__A2_INVOCATIONS__ = 0;
        globalThis.__A2_RESPONSES__ = [
          "MEMORY:\ntitle: TryAutoWrite Lane Wiring\nkind: fact\nconfidence: 4\n---\n# TryAutoWrite Lane Wiring\n\nThis insight exists only to drive tryAutoWriteLane through the curator + writer integration path so the closure-arg threading invariant stays locked.\nEND_MEMORY",
        ];
        // RunWindow shape matches `interface RunWindow` in
        // extensions/sediment/checkpoint.ts. `text` is the only field
        // runLlmExtractor reads downstream; the others must be present
        // for type discipline but aren't read by the lane code below.
        const tryWinText = "--- ENTRY 1 try1 message/assistant ---\nWe figured out something insightful about tryAutoWriteLane that we want to capture.";
        const tryWin = {
          entries: [
            { type: "message", id: "try1", timestamp: "2026-05-13T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "We figured out something insightful about tryAutoWriteLane." }] } },
          ],
          text: tryWinText,
          chars: tryWinText.length,
          totalBranchEntries: 1,
          candidateEntries: 1,
          includedEntries: 1,
          checkpointFound: false,
          lastEntryId: "try1",
        };
        const outcome = await _tryAutoWriteLaneForTests({
          cwd: aRoot,
          sessionId: "smoke-trywire",
          settings: a2Settings,
          window: tryWin,
          modelRegistry: mockModelRegistry,
          signal: undefined,
          correlationId: "smoke-trywire:auto",
          abrainHome: aTarget.abrainHome,
          projectId: aTarget.projectId,
        });
        // The fingerprint we care about: NO `ReferenceError`. If the
        // closure-arg threading regresses, outcome.kind === "threw" with
        // `error: "abrainHome is not defined"` (or projectId variant).
        // Any other kind — wrote / ineligible / llm_skip / llm_error —
        // means the lane reached its decision point without crashing.
        if (outcome.kind === "threw") {
          assert(
            !/abrainHome is not defined|projectId is not defined/i.test(String(outcome.error || "")),
            `tryAutoWriteLane regressed on closure-arg threading: ${outcome.error}`,
          );
        }
        assert(
          ["wrote", "ineligible", "llm_skip", "llm_error", "threw"].includes(outcome.kind),
          `tryAutoWriteLane outcome.kind must be a known variant, got: ${outcome.kind}`,
        );

        // raw_text persisted to audit must use sanitized text, not the
        // pre-redaction LLM response. This covers sanitizeAndTruncateRawForAudit,
        // a separate path from llm rawTextPreview.
        const echoedAnthropic = "sk-ant-" + "api03-AbCdEfGhIjKlMnOpQrStUv";
        globalThis.__A2_INVOCATIONS__ = 0;
        globalThis.__A2_RESPONSES__ = [`No memory candidate, but echoed ${echoedAnthropic}`];
        const rawOutcome = await _tryAutoWriteLaneForTests({
          cwd: aRoot,
          sessionId: "smoke-raw-redact",
          settings: a2Settings,
          window: tryWin,
          modelRegistry: mockModelRegistry,
          signal: undefined,
          correlationId: "smoke-raw-redact:auto",
          abrainHome: aTarget.abrainHome,
          projectId: aTarget.projectId,
        });
        assert(rawOutcome.kind === "llm_skip", `raw redaction fixture should produce llm_skip, got: ${JSON.stringify(rawOutcome)}`);
        assert(
          rawOutcome.rawTextStored && rawOutcome.rawTextStored.includes("[SECRET:anthropic_api_key]") && !rawOutcome.rawTextStored.includes(echoedAnthropic),
          `raw_text audit storage must redact echoed secret, got: ${rawOutcome.rawTextStored}`,
        );
        assert(
          rawOutcome.rawTextRedacted === true && rawOutcome.rawTextRedactionReason?.includes("credential:anthropic_api_key"),
          `raw_text redaction metadata must include reason, got: ${JSON.stringify(rawOutcome)}`,
        );
      }

      // === Tier-1 direct lane (ADR 0028 R1'/R2'; supersedes the 2026-06-07
      // escalation-seed design — dc5de52 removed the seed-bridge) ===
      // A high-confidence user-EXPRESSED durable CREATE signal is owned by the
      // classifier (disjoint authority): it commits DETERMINISTICALLY via the
      // Tier-1 direct writer BEFORE any extractor/curator LLM call, so an
      // extractor SKIP can no longer lose it. Verifies: direct write + VERBATIM
      // body + zero extractor invocations, the structural gating predicate
      // (typing/confidence/provenance/no-target), and the deterministic
      // validation gate on degenerate bodies.
      {
        const { _tryAutoWriteLaneForTests, _shouldAdvanceAfterAutoOutcomeForTests } = req("./sediment/index.js");
        const userQuote = "所有 git.alfadb.cn 的 git 仓库必须使用 glab 工具管理，禁用裸 git/curl API";
        // window.text MUST contain the verbatim user_quote so the attribution guard
        // (only seed when the quote is grounded in the window) passes.
        const seedWinText = `--- ENTRY 1 r1 message/user ---\n全局规则：${userQuote}`;
        const mkWinFor = (turnId, text) => ({
          entries: [{ type: "message", id: turnId, timestamp: "2026-06-07T00:00:01Z", message: { role: "user", content: [{ type: "text", text }] } }],
          text, chars: text.length, totalBranchEntries: 1,
          candidateEntries: 1, includedEntries: 1, checkpointFound: false, lastEntryId: turnId,
        });
        const mkWin = () => mkWinFor("r1", seedWinText);
        const qualifyingSignal = {
          signal_found: true, typing: "durable", confidence: 9, correction_intent: "new preference",
          scope_description: "All git.alfadb.cn repos must use glab across all projects/sessions",
          user_quote: userQuote, target_entry_slug: null,
          // ADR 0028 v1.1: the Tier-1 gate is now the deterministic AX-PROVENANCE
          // class (set by correction-pipeline.deriveProvenance from turn.role).
          provenance: "user-expressed",
          rule_scope: "global",
        };
        const laneArgs = (sessionId, correctionSignal, window = mkWin()) => ({
          cwd: aRoot, sessionId, settings: a2Settings, window,
          modelRegistry: mockModelRegistry, signal: undefined, correlationId: `${sessionId}:auto`,
          abrainHome: aTarget.abrainHome, projectId: aTarget.projectId, correctionSignal,
        });

        // (1) qualifying signal + extractor would SKIP -> Tier-1 direct write,
        //     verbatim body, ZERO extractor invocations (R1' disjoint authority)
        globalThis.__A2_INVOCATIONS__ = 0; globalThis.__A2_RESPONSES__ = ["SKIP"];
        const direct = await _tryAutoWriteLaneForTests(laneArgs("smoke-tier1-fire", qualifyingSignal));
        assert(direct.kind === "tier1_direct", `Tier-1 signal must take the deterministic direct lane, got: ${direct.kind}`);
        assert(direct.result.status === "created" && direct.result.ruleScope === "global", `direct write should create a global rule, got: ${JSON.stringify(direct.result)}`);
        assert(direct.draft.body === userQuote, `direct rule body must be VERBATIM user_quote, got: ${direct.draft.body}`);
        assert(direct.draft.kind === "preference", `direct rule kind should be 'preference', got: ${direct.draft.kind}`);
        assert(fs.readFileSync(direct.result.path, "utf-8").includes(userQuote), `rule file must contain the verbatim quote`);
        assert(globalThis.__A2_INVOCATIONS__ === 0, `direct lane must not consult the extractor (0 LLM), got: ${globalThis.__A2_INVOCATIONS__}`);
        assert(!fs.existsSync(path.join(aTarget.abrainHome, "l1", "events")), "default-off constraint event writer must not touch L1 events");
        assert(!fs.existsSync(path.join(aTarget.abrainHome, ".state", "sediment", "constraint-events")), "default-off constraint event writer must not touch runtime state");

        // Missing rule_scope must stay conservative: project-scoped by default,
        // because accidental global prompt pollution is more expensive.
        const defaultScopeQuote = "本项目中，缺少 rule_scope 的 Tier-1 信号必须默认写入项目规则。";
        const defaultScopeWinText = `--- ENTRY 1 r1b message/user ---\n项目规则：${defaultScopeQuote}`;
        const { rule_scope: _omittedRuleScope, ...missingRuleScopeSignal } = {
          ...qualifyingSignal,
          user_quote: defaultScopeQuote,
          scope_description: "This project should default missing rule_scope to project rules",
        };
        globalThis.__A2_INVOCATIONS__ = 0; globalThis.__A2_RESPONSES__ = ["SKIP"];
        const defaultScope = await _tryAutoWriteLaneForTests(laneArgs("smoke-tier1-default-project", missingRuleScopeSignal, mkWinFor("r1b", defaultScopeWinText)));
        assert(defaultScope.kind === "tier1_direct", `Tier-1 signal without rule_scope must still direct-write, got: ${defaultScope.kind}`);
        assert(defaultScope.result.status === "created" && defaultScope.result.ruleScope === "project", `missing rule_scope must default to project, got: ${JSON.stringify(defaultScope.result)}`);
        assert(globalThis.__A2_INVOCATIONS__ === 0, `default-scope direct lane must not consult the extractor (0 LLM), got: ${globalThis.__A2_INVOCATIONS__}`);

        // (1b) opt-in runtime event writer: appends content-addressed L1 evidence while legacy Tier-1 behavior still runs.
        const eventTarget = setupAbrainTarget("constraint-evidence-runtime-smoke");
        const eventSettings = { ...a2Settings, constraintEvidenceEventWriter: { enabled: true } };
        const eventQuote = "所有项目中，Constraint Evidence Event writer 必须通过显式 JSON 开关控制。";
        const eventSignal = { ...qualifyingSignal, user_quote: eventQuote, scope_description: "All projects must keep the event writer behind an explicit JSON switch" };
        const eventWinText = `--- ENTRY 1 ev1 message/user ---\n全局规则：${eventQuote}`;
        const eventWin = {
          entries: [{ type: "message", id: "ev1", timestamp: "2026-06-19T12:00:00.000Z", message: { role: "user", content: [{ type: "text", text: eventWinText }] } }],
          text: eventWinText, chars: eventWinText.length, totalBranchEntries: 1,
          candidateEntries: 1, includedEntries: 1, checkpointFound: false, lastEntryId: "ev1",
        };
        const eventArgs = (correlationId) => ({
          cwd: aRoot, sessionId: "smoke-tier1-event", settings: eventSettings, window: eventWin,
          modelRegistry: mockModelRegistry, signal: undefined, correlationId,
          abrainHome: eventTarget.abrainHome, projectId: eventTarget.projectId, correctionSignal: eventSignal,
        });
        globalThis.__A2_INVOCATIONS__ = 0; globalThis.__A2_RESPONSES__ = ["SKIP"];
        const eventFirst = await _tryAutoWriteLaneForTests(eventArgs("smoke-tier1-event:auto-a"));
        globalThis.__A2_INVOCATIONS__ = 0; globalThis.__A2_RESPONSES__ = ["SKIP"];
        const eventSecond = await _tryAutoWriteLaneForTests(eventArgs("smoke-tier1-event:auto-b"));
        assert(eventFirst.kind === "tier1_direct" && eventFirst.result.status === "created", `enabled event writer must keep legacy create path, got: ${JSON.stringify(eventFirst)}`);
        assert(eventSecond.kind === "tier1_direct" && eventSecond.result.status === "deduped", `replayed signal must keep legacy dedup path, got: ${JSON.stringify(eventSecond)}`);
        const eventFiles = [];
        const eventRoot = path.join(eventTarget.abrainHome, "l1", "events");
        const walkEventFiles = (dir) => {
          for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, child.name);
            if (child.isDirectory()) walkEventFiles(full);
            if (child.isFile()) eventFiles.push(path.relative(eventRoot, full).split(path.sep).join("/"));
          }
        };
        walkEventFiles(eventRoot);
        assert(eventFiles.length === 1, `enabled writer must write one idempotent L1 event file, got: ${eventFiles.join(",")}`);
        const runtimeAuditPath = path.join(eventTarget.abrainHome, ".state", "sediment", "constraint-events", "runtime", "append-audit.jsonl");
        const runtimeStatusPath = path.join(eventTarget.abrainHome, ".state", "sediment", "constraint-events", "runtime", "projection-status.jsonl");
        assert(fs.existsSync(runtimeAuditPath), "enabled writer runtime audit missing");
        assert(fs.existsSync(runtimeStatusPath), "enabled writer runtime status missing");
        const runtimeAuditRows = fs.readFileSync(runtimeAuditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
        assert(runtimeAuditRows.length === 2, `runtime audit should record both append attempts, got: ${runtimeAuditRows.length}`);
        assert(runtimeAuditRows[0].status === "appended" && runtimeAuditRows[1].status === "idempotent_duplicate", `runtime audit should show append then duplicate, got: ${JSON.stringify(runtimeAuditRows)}`);
        const tier1AuditPath = path.join(aRoot, ".pi-astack", "sediment", "audit.jsonl");
        const tier1Audit = fs.readFileSync(tier1AuditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((row) => row.session_id === "smoke-tier1-event" && row.operation === "tier1_direct_write");
        assert(tier1Audit.length === 2 && tier1Audit.every((row) => row.constraint_evidence_event), `tier1 audit must include event summaries when enabled: ${JSON.stringify(tier1Audit)}`);

        const eventOnlyTarget = setupAbrainTarget("constraint-evidence-event-first-only-smoke");
        const eventOnlySettings = {
          ...a2Settings,
          constraintEvidenceEventWriter: {
            enabled: true,
            mode: "event_first",
            legacyFallbackOnEventFailure: false,
            legacyRuleWriteOnSuccessfulEvent: false,
          },
        };
        const eventOnlyQuote = "所有 Constraint 新信号必须先进入 L1 Evidence Event，旧规则写入只作为显式回滚路径。";
        const eventOnlySignal = { ...qualifyingSignal, user_quote: eventOnlyQuote, scope_description: "All Constraint signals should be captured in L1 before legacy rule writes" };
        const eventOnlyWinText = `--- ENTRY 1 ev2 message/user ---\n全局规则：${eventOnlyQuote}`;
        const eventOnlyWin = {
          entries: [{ type: "message", id: "ev2", timestamp: "2026-06-20T12:00:00.000Z", message: { role: "user", content: [{ type: "text", text: eventOnlyWinText }] } }],
          text: eventOnlyWinText, chars: eventOnlyWinText.length, totalBranchEntries: 1,
          candidateEntries: 1, includedEntries: 1, checkpointFound: false, lastEntryId: "ev2",
        };
        globalThis.__A2_INVOCATIONS__ = 0; globalThis.__A2_RESPONSES__ = ["SKIP"];
        const eventOnly = await _tryAutoWriteLaneForTests({
          cwd: aRoot, sessionId: "smoke-tier1-event-only", settings: eventOnlySettings, window: eventOnlyWin,
          modelRegistry: mockModelRegistry, signal: undefined, correlationId: "smoke-tier1-event-only:auto",
          abrainHome: eventOnlyTarget.abrainHome, projectId: eventOnlyTarget.projectId, correctionSignal: eventOnlySignal,
        });
        assert(eventOnly.kind === "tier1_direct" && eventOnly.result.status === "deduped" && eventOnly.result.reason?.startsWith("constraint_compiler_publication_pending"), `event-only append must remain pending until compiler publication durability, got: ${JSON.stringify(eventOnly)}`);
        assert(_shouldAdvanceAfterAutoOutcomeForTests(eventOnly) === false, "event-only append advanced the checkpoint before compiler publication");
        assert(fs.existsSync(path.join(eventOnlyTarget.abrainHome, "l1", "events")), "event-only mode must write L1 events");
        assert(!fs.existsSync(path.join(eventOnlyTarget.abrainHome, "rules")), "event-only mode must not write legacy rules");
        let eventOnlyTier1Audit = fs.readFileSync(tier1AuditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((row) => row.session_id === "smoke-tier1-event-only" && row.operation === "tier1_direct_write");
        assert(eventOnlyTier1Audit.length === 1 && eventOnlyTier1Audit[0].event_first_skipped_legacy_rule_write === true && eventOnlyTier1Audit[0].signal_consumed === false, `pending event-only audit must hold consumption: ${JSON.stringify(eventOnlyTier1Audit)}`);

        const eventOnlyPublicationAudit = path.join(eventOnlyTarget.abrainHome, ".state", "sediment", "constraint-shadow", "auto-refresh", "audit.jsonl");
        writeFile(eventOnlyPublicationAudit, `${JSON.stringify({
          schemaVersion: "constraint-shadow-auto-refresh/v1",
          observedAtUtc: "2026-06-20T12:01:00.000Z",
          ok: true,
          status: "completed",
          sourceEventId: eventOnly.result.dedupedAgainst,
          publication: { status: "local_durable", commit: "a".repeat(40), localCommit: "index_converged", drainStatus: "index_converged", canonical: true },
        })}\n`);
        globalThis.__A2_INVOCATIONS__ = 0; globalThis.__A2_RESPONSES__ = ["SKIP"];
        const eventOnlyDurable = await _tryAutoWriteLaneForTests({
          cwd: aRoot, sessionId: "smoke-tier1-event-only", settings: eventOnlySettings, window: eventOnlyWin,
          modelRegistry: mockModelRegistry, signal: undefined, correlationId: "smoke-tier1-event-only:auto-restart",
          abrainHome: eventOnlyTarget.abrainHome, projectId: eventOnlyTarget.projectId, correctionSignal: eventOnlySignal,
        });
        assert(eventOnlyDurable.kind === "tier1_direct" && eventOnlyDurable.result.reason?.startsWith("constraint_compiler_publication_durable"), `durable compiler correlation was not consumed after restart: ${JSON.stringify(eventOnlyDurable)}`);
        assert(_shouldAdvanceAfterAutoOutcomeForTests(eventOnlyDurable) === true, "durable compiler publication did not release the held checkpoint");
        eventOnlyTier1Audit = fs.readFileSync(tier1AuditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((row) => row.session_id === "smoke-tier1-event-only" && row.operation === "tier1_direct_write");
        assert(eventOnlyTier1Audit.length === 2 && eventOnlyTier1Audit[1].signal_consumed === true, `durable event-only audit did not mark consumption: ${JSON.stringify(eventOnlyTier1Audit)}`);

        // (2) non-qualifying (task-local, conf 6) -> not Tier-1 -> extractor path -> llm_skip
        globalThis.__A2_INVOCATIONS__ = 0; globalThis.__A2_RESPONSES__ = ["SKIP"];
        const taskLocal = await _tryAutoWriteLaneForTests(laneArgs("smoke-tier1-tasklocal", { signal_found: true, typing: "task-local", confidence: 6, user_quote: userQuote, target_entry_slug: null }));
        assert(taskLocal.kind === "llm_skip", `task-local signal must NOT take the direct lane, got: ${taskLocal.kind}`);

        // (3) durable but NO provenance (and empty quote) -> structural gate fails -> llm_skip
        globalThis.__A2_INVOCATIONS__ = 0; globalThis.__A2_RESPONSES__ = ["SKIP"];
        const noQuote = await _tryAutoWriteLaneForTests(laneArgs("smoke-tier1-noquote", { signal_found: true, typing: "durable", confidence: 9, user_quote: "", target_entry_slug: null }));
        assert(noQuote.kind === "llm_skip", `durable signal without user-expressed provenance must NOT direct-write, got: ${noQuote.kind}`);

        // (4) durable WITH target_entry_slug (an UPDATE, not a create) -> not Tier-1 -> llm_skip
        globalThis.__A2_INVOCATIONS__ = 0; globalThis.__A2_RESPONSES__ = ["SKIP"];
        const hasTarget = await _tryAutoWriteLaneForTests(laneArgs("smoke-tier1-target", { signal_found: true, typing: "durable", confidence: 9, user_quote: userQuote, target_entry_slug: "some-existing-rule" }));
        assert(hasTarget.kind === "llm_skip", `signal targeting an existing entry (update) must NOT direct-create, got: ${hasTarget.kind}`);

        // (5) disjoint authority (R1'): even when the extractor WOULD emit a
        //     covering draft, the Tier-1 lane commits first and never consults it
        globalThis.__A2_INVOCATIONS__ = 0;
        globalThis.__A2_RESPONSES__ = [`MEMORY:\ntitle: glab rule\nkind: preference\nconfidence: 8\n---\n# glab rule\n\n${userQuote}\nEND_MEMORY`];
        const covered = await _tryAutoWriteLaneForTests(laneArgs("smoke-tier1-cover", qualifyingSignal));
        assert(covered.kind === "tier1_direct", `Tier-1 owns directive candidates regardless of extractor output, got: ${covered.kind}`);
        assert(covered.result.status === "deduped" && (covered.result.reason ?? "").startsWith("semantic_duplicate"), `restated rule must dedup against (1)'s write, got: ${JSON.stringify(covered.result)}`);
        assert(globalThis.__A2_INVOCATIONS__ === 0, `extractor must not be consulted on the direct lane, got: ${globalThis.__A2_INVOCATIONS__}`);

        // (6) provenance != user-expressed (README/tool content-in-transcript trap) -> NOT Tier-1 -> llm_skip
        globalThis.__A2_INVOCATIONS__ = 0; globalThis.__A2_RESPONSES__ = ["SKIP"];
        const ungrounded = await _tryAutoWriteLaneForTests(laneArgs("smoke-tier1-ungrounded", { signal_found: true, typing: "durable", confidence: 9, user_quote: userQuote, scope_description: "x", target_entry_slug: null, provenance: "content-in-transcript" }));
        assert(ungrounded.kind === "llm_skip", `a content-in-transcript (non user-expressed) directive must NOT direct-write a Tier-1 rule, got: ${ungrounded.kind}`);

        // (7) degenerate body (quote<10 chars, empty scope) -> direct lane fires but
        //     the DETERMINISTIC validation gate rejects (ADR 0028 §11: deterministic
        //     safety gates may stop a Tier-1 write; with R6' there is no staging
        //     net — the held checkpoint + R3' recall audit are the nets)
        globalThis.__A2_INVOCATIONS__ = 0; globalThis.__A2_RESPONSES__ = ["SKIP"];
        const tinyText = "--- ENTRY 1 r1 message/user ---\n用glab";
        const tinyWin = { entries: [{ type: "message", id: "r1", timestamp: "2026-06-07T00:00:01Z", message: { role: "user", content: [{ type: "text", text: tinyText }] } }], text: tinyText, chars: tinyText.length, totalBranchEntries: 1, candidateEntries: 1, includedEntries: 1, checkpointFound: false, lastEntryId: "r1" };
        const tooShort = await _tryAutoWriteLaneForTests({ cwd: aRoot, sessionId: "smoke-tier1-short", settings: a2Settings, window: tinyWin, modelRegistry: mockModelRegistry, signal: undefined, correlationId: "smoke-tier1-short:auto", abrainHome: aTarget.abrainHome, projectId: aTarget.projectId, correctionSignal: { signal_found: true, typing: "durable", confidence: 9, user_quote: "用glab", scope_description: "", target_entry_slug: null, provenance: "user-expressed" } });
        assert(tooShort.kind === "tier1_direct" && tooShort.result.status === "rejected" && tooShort.result.reason === "validation_error_body", `a <10-char body must be rejected by the deterministic validation gate, got: ${JSON.stringify({ kind: tooShort.kind, result: tooShort.result && { status: tooShort.result.status, reason: tooShort.result.reason } })}`);
      }

      // === ADR 0025 multi-view replay writer dispatch ==================
      // The replay lane used to stop at a writeApprovedToBrain stub that
      // only audited candidate_lost:true. Pin the shared dispatcher so an
      // approved replay decision performs the same op→writer mapping as
      // the original auto-write path.
      {
        const replayCreate = await executeCuratorDecisionToBrain({
          decision: { op: "create", rationale: "replay create smoke" },
          draft: {
            title: "Replay Dispatcher Create Smoke",
            kind: "fact",
            status: "active",
            confidence: 8,
            compiledTruth: "# Replay Dispatcher Create Smoke\n\nThe replay dispatcher writes approved create decisions to the brain.",
          },
          projectRoot: aRoot,
          abrainHome: aTarget.abrainHome,
          projectId: aTarget.projectId,
          settings: a2Settings,
          auditContext: { lane: "replay", sessionId: "smoke-replay", correlationId: "smoke-replay:create", candidateId: "smoke-replay:create:c1" },
          sessionId: "smoke-replay",
          createTimelineNote: "multi-view replay create smoke",
        });
        assert(replayCreate.length === 1 && replayCreate[0].status === "created", `replay dispatcher create should write brain: ${JSON.stringify(replayCreate)}`);
        const replayCreateWritten = fs.readFileSync(replayCreate[0].path, "utf-8");
        assert(/^- .* \| smoke-replay \| captured \| multi-view replay create smoke$/m.test(replayCreateWritten), `replay create timeline missing:\n${replayCreateWritten}`);

        // ADR 0028 §12.3 dual-read regression (3-T0 review P1): a PERSISTED
        // multiview-staging decision written before the inject-mode rename
        // reaches executeCuratorDecisionToBrain WITHOUT passing parseDecision
        // (which would have normalized it). The writer-side fallback must read
        // the legacy `tier` key — if it ever regresses to the `?? "listed"`
        // default, an old staged ALWAYS rule would silently demote to listed.
        const replayLegacyRule = await executeCuratorDecisionToBrain({
          decision: { op: "create", zone: "rules", tier: "always", ruleScope: "global", rationale: "legacy-tier replay dual-read smoke" },
          draft: {
            title: "Legacy Tier Replay Rule",
            kind: "preference",
            status: "active",
            confidence: 9,
            compiledTruth: "所有 legacy replay 决策必须保持 inject-mode 双读兼容。",
          },
          projectRoot: aRoot,
          abrainHome: aTarget.abrainHome,
          projectId: aTarget.projectId,
          settings: a2Settings,
          auditContext: { lane: "replay", sessionId: "smoke-replay", correlationId: "smoke-replay:legacy-tier", candidateId: "smoke-replay:legacy-tier:c1" },
          sessionId: "smoke-replay",
          createTimelineNote: "legacy tier dual-read smoke",
        });
        assert(replayLegacyRule.length === 1 && replayLegacyRule[0].status === "created", `legacy-tier rules create should write: ${JSON.stringify(replayLegacyRule)}`);
        const legacyRulePath = path.join(aTarget.abrainHome, "rules", "always", "legacy-tier-replay-rule.md");
        assert(fs.existsSync(legacyRulePath), `legacy \`tier:"always"\` decision must land in rules/always (not demote to listed): ${replayLegacyRule[0].path}`);
        assert(fs.readFileSync(legacyRulePath, "utf-8").includes('inject_mode: "always"'), "rewritten frontmatter must use the canonical inject_mode key");

        const replayUpdate = await executeCuratorDecisionToBrain({
          decision: {
            op: "update",
            slug: replayCreate[0].slug,
            patch: {
              compiledTruth: "# Replay Dispatcher Create Smoke\n\nThe replay dispatcher also writes approved update decisions to the brain.",
              confidence: 9,
            },
            rationale: "replay update smoke",
          },
          draft: {
            title: "Replay Dispatcher Create Smoke",
            kind: "fact",
            status: "active",
            confidence: 9,
            compiledTruth: "unused candidate body for update",
          },
          projectRoot: aRoot,
          abrainHome: aTarget.abrainHome,
          projectId: aTarget.projectId,
          settings: a2Settings,
          auditContext: { lane: "replay", sessionId: "smoke-replay", correlationId: "smoke-replay:update", candidateId: "smoke-replay:update:c1" },
          sessionId: "smoke-replay",
          updateTimelineNote: "multi-view replay update smoke",
        });
        assert(replayUpdate.length === 1 && replayUpdate[0].status === "updated", `replay dispatcher update should write brain: ${JSON.stringify(replayUpdate)}`);
        const replayUpdateWritten = fs.readFileSync(replayUpdate[0].path, "utf-8");
        assert(replayUpdateWritten.includes("approved update decisions"), `replay update body missing:\n${replayUpdateWritten}`);
        assert(/^confidence: 9$/m.test(replayUpdateWritten), `replay update confidence missing:\n${replayUpdateWritten}`);
        assert(/^- .* \| smoke-replay \| updated \| multi-view replay update smoke$/m.test(replayUpdateWritten), `replay update timeline missing:\n${replayUpdateWritten}`);

        const replaySkip = await executeCuratorDecisionToBrain({
          decision: { op: "skip", reason: "replay_skip_smoke" },
          draft: { title: "Replay Skip Smoke", kind: "fact", compiledTruth: "skip body" },
          projectRoot: aRoot,
          abrainHome: aTarget.abrainHome,
          projectId: aTarget.projectId,
          settings: a2Settings,
          auditContext: { lane: "replay", sessionId: "smoke-replay", correlationId: "smoke-replay:skip", candidateId: "smoke-replay:skip:c1" },
          sessionId: "smoke-replay",
        });
        assert(replaySkip.length === 1 && replaySkip[0].status === "skipped" && replaySkip[0].reason === "replay_skip_smoke", `replay dispatcher skip should not write brain: ${JSON.stringify(replaySkip)}`);

        const worldCreate = await executeCuratorDecisionToBrain({
          decision: { op: "create", scope: "world", rationale: "world replay create smoke" },
          draft: {
            title: "Replay Dispatcher World Smoke",
            kind: "fact",
            status: "active",
            confidence: 8,
            compiledTruth: "# Replay Dispatcher World Smoke\n\nWorld-scope replay writes and updates must preserve world frontmatter.",
          },
          projectRoot: aRoot,
          abrainHome: aTarget.abrainHome,
          projectId: aTarget.projectId,
          settings: a2Settings,
          auditContext: { lane: "replay", sessionId: "smoke-replay", correlationId: "smoke-replay:world-create", candidateId: "smoke-replay:world-create:c1" },
          sessionId: "smoke-replay",
          createTimelineNote: "multi-view replay world create smoke",
        });
        assert(worldCreate.length === 1 && worldCreate[0].status === "created", `replay dispatcher world create should write brain: ${JSON.stringify(worldCreate)}`);
        let worldWritten = fs.readFileSync(worldCreate[0].path, "utf-8");
        assert(/^id: world:replay-dispatcher-world-smoke$/m.test(worldWritten) && /^scope: world$/m.test(worldWritten) && !/^project_id:/m.test(worldWritten), `world create frontmatter mismatch:\n${worldWritten}`);

        const worldUpdate = await executeCuratorDecisionToBrain({
          decision: {
            op: "update",
            scope: "world",
            slug: worldCreate[0].slug,
            patch: { confidence: 9, compiledTruth: "# Replay Dispatcher World Smoke\n\nWorld-scope update kept this entry in knowledge/." },
            rationale: "world replay update smoke",
          },
          draft: { title: "Replay Dispatcher World Smoke", kind: "fact", compiledTruth: "unused world update draft" },
          projectRoot: aRoot,
          abrainHome: aTarget.abrainHome,
          projectId: aTarget.projectId,
          settings: a2Settings,
          auditContext: { lane: "replay", sessionId: "smoke-replay", correlationId: "smoke-replay:world-update", candidateId: "smoke-replay:world-update:c1" },
          sessionId: "smoke-replay",
          updateTimelineNote: "multi-view replay world update smoke",
        });
        assert(worldUpdate.length === 1 && worldUpdate[0].status === "updated", `replay dispatcher world update should write brain: ${JSON.stringify(worldUpdate)}`);
        worldWritten = fs.readFileSync(worldUpdate[0].path, "utf-8");
        assert(/^id: world:replay-dispatcher-world-smoke$/m.test(worldWritten) && /^scope: world$/m.test(worldWritten) && !/^project_id:/m.test(worldWritten), `world update must preserve world frontmatter:\n${worldWritten}`);
        assert(/^confidence: 9$/m.test(worldWritten), `world update confidence missing:\n${worldWritten}`);

        const gitFailTarget = setupAbrainTarget("a2-git-fail-fixture");
        const gitFailSettings = { ...a2Settings, gitCommit: true };
        const gitFailCreate = await executeCuratorDecisionToBrain({
          decision: { op: "create", rationale: "git fail smoke" },
          draft: { title: "Replay Dispatcher Git Fail Smoke", kind: "fact", status: "active", confidence: 8, compiledTruth: "# Replay Dispatcher Git Fail Smoke\n\nCreate should reject when git commit is required but abrainHome is not a git repo." },
          projectRoot: aRoot,
          abrainHome: gitFailTarget.abrainHome,
          projectId: gitFailTarget.projectId,
          settings: gitFailSettings,
          auditContext: { lane: "replay", sessionId: "smoke-replay", correlationId: "smoke-replay:git-fail-create", candidateId: "smoke-replay:git-fail-create:c1" },
          sessionId: "smoke-replay",
        });
        assert(gitFailCreate.length === 1 && gitFailCreate[0].status === "rejected" && gitFailCreate[0].reason === "git_commit_failed", `create git failure should reject: ${JSON.stringify(gitFailCreate)}`);

        const gitFailExisting = await writeProjectEntry({
          title: "Replay Dispatcher Git Fail Existing",
          kind: "fact",
          status: "active",
          confidence: 8,
          compiledTruth: "# Replay Dispatcher Git Fail Existing\n\nSeed without git commit so update can exercise dispatcher failure handling.",
        }, {
          projectRoot: aRoot,
          abrainHome: gitFailTarget.abrainHome,
          projectId: gitFailTarget.projectId,
          settings: { ...a2Settings, gitCommit: false },
          dryRun: false,
        });
        assert(gitFailExisting.status === "created", `git fail seed should create: ${JSON.stringify(gitFailExisting)}`);
        let gitFailThrew = false;
        try {
          await executeCuratorDecisionToBrain({
            decision: { op: "update", slug: gitFailExisting.slug, patch: { confidence: 9 }, rationale: "git fail update smoke" },
            draft: { title: "Replay Dispatcher Git Fail Existing", kind: "fact", compiledTruth: "unused" },
            projectRoot: aRoot,
            abrainHome: gitFailTarget.abrainHome,
            projectId: gitFailTarget.projectId,
            settings: gitFailSettings,
            auditContext: { lane: "replay", sessionId: "smoke-replay", correlationId: "smoke-replay:git-fail-update", candidateId: "smoke-replay:git-fail-update:c1" },
            sessionId: "smoke-replay",
          });
        } catch (e) {
          gitFailThrew = /git_commit_failed/.test(String(e && e.message || e));
        }
        assert(!gitFailThrew, `update git failure should now reject without throwing from dispatcher`);
        const gitFailAfterUpdate = fs.readFileSync(gitFailExisting.path, "utf-8");
        assert(/^confidence: 8$/m.test(gitFailAfterUpdate), `update git failure should roll back file content to original confidence:\n${gitFailAfterUpdate}`);

        const gitFailDeleteSeed = await writeProjectEntry({
          title: "Replay Dispatcher Git Fail Delete",
          kind: "fact",
          status: "active",
          confidence: 7,
          compiledTruth: "# Replay Dispatcher Git Fail Delete\n\nSeed without git commit so hard delete rollback can be exercised.",
        }, {
          projectRoot: aRoot,
          abrainHome: gitFailTarget.abrainHome,
          projectId: gitFailTarget.projectId,
          settings: { ...a2Settings, gitCommit: false },
          dryRun: false,
        });
        assert(gitFailDeleteSeed.status === "created" && fs.existsSync(gitFailDeleteSeed.path), `git fail delete seed should create: ${JSON.stringify(gitFailDeleteSeed)}`);
        const gitFailDelete = await deleteProjectEntry(gitFailDeleteSeed.slug, {
          projectRoot: aRoot,
          abrainHome: gitFailTarget.abrainHome,
          projectId: gitFailTarget.projectId,
          settings: gitFailSettings,
          dryRun: false,
          mode: "hard",
          reason: "git fail delete smoke",
          sessionId: "smoke-replay",
        });
        assert(gitFailDelete.status === "rejected" && gitFailDelete.reason === "git_commit_failed" && fs.existsSync(gitFailDeleteSeed.path), `hard delete git failure should reject and restore file: ${JSON.stringify(gitFailDelete)}`);

        // Full replay loop regression: approved replay writes brain and
        // deletes staging only after writer success; writer throw keeps
        // the original staging entry for retry; origin mismatch keeps the
        // entry out of the current project.
        const replayRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-replay-loop-"));
        const oldReplayAbrainRoot = process.env.ABRAIN_ROOT;
        process.env.ABRAIN_ROOT = replayRoot;
        try {
          const { writeMultiviewPending, loadMultiviewPending, deleteMultiviewPending } = req("./sediment/multiview-staging-io.js");
          const replaySettings = JSON.parse(JSON.stringify(a2Settings));
          replaySettings.multiView = {
            proposerProviders: [],
            reviewerProviders: ["mock/reviewer"],
            fallbackProviders: [],
            costBudgetPerOpUsd: 0.05,
          };
          const loopModelRegistry = {
            find: () => ({ id: "mock-reviewer", contextWindow: 100000 }),
            getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-test-not-real", headers: {} }),
          };

          globalThis.__A2_INVOCATIONS__ = 0;
          globalThis.__A2_RESPONSES__ = [
            JSON.stringify({ op: "create", scope: "project", confidence: 9, reasoning: "pass1 confirm create" }),
            JSON.stringify({ verdict: "confirm_proposer", rationale: "pass2 confirms proposer" }),
          ];
          writeMultiviewPending({
            slug: "multiview-pending-loop-success",
            kind: "multiview-pending",
            status: "provisional",
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            origin_project_id: aTarget.projectId,
            origin_project_root: aRoot,
            originating_device: "smoke",
            multiview_state: "reviewer_unavailable",
            retry_attempts: 0,
            trigger_reason: "create_high_confidence",
            proposer_decision: { op: "create", rationale: "loop success proposer" },
            proposer_raw_text: "loop success proposer raw",
            candidate_snapshot: { title: "Replay Loop Success Smoke", kind: "fact", status: "active", confidence: 9, compiledTruth: "# Replay Loop Success Smoke\n\nApproved replay loop writes this candidate." },
            correction_signal: null,
            neighbor_slugs: [],
          });
          let wroteLoop = 0;
          const loopSuccess = await replayMultiviewPending({
            settings: replaySettings,
            modelRegistry: loopModelRegistry,
            currentProjectId: aTarget.projectId,
            currentProjectRoot: aRoot,
            loadNeighborsBySlug: async () => [],
            writeApprovedToBrain: async (decision, candidate) => {
              wroteLoop++;
              const written = await executeCuratorDecisionToBrain({
                decision,
                draft: candidate,
                projectRoot: aRoot,
                abrainHome: aTarget.abrainHome,
                projectId: aTarget.projectId,
                settings: a2Settings,
                auditContext: { lane: "replay", sessionId: "smoke-replay-loop", correlationId: "smoke-replay-loop:success", candidateId: "smoke-replay-loop:success:c1" },
                sessionId: "smoke-replay-loop",
                createTimelineNote: "multi-view replay loop smoke",
              });
              const rejected = written.find((result) => result.status === "rejected");
              if (rejected) throw new Error(rejected.reason || "writer rejected");
            },
          });
          assert(loopSuccess.succeeded === 1 && loopSuccess.errors === 0 && wroteLoop === 1, `replay loop success should write once: ${JSON.stringify(loopSuccess)} wrote=${wroteLoop}`);
          assert(!loadMultiviewPending().entries.some((entry) => entry.slug === "multiview-pending-loop-success"), `successful replay should delete staging`);
          const loopPath = path.join(aTarget.abrainHome, "projects", aTarget.projectId, "knowledge", "replay-loop-success-smoke.md");
          assert(fs.existsSync(loopPath), `successful replay should create brain entry at ${loopPath}`);

          globalThis.__A2_INVOCATIONS__ = 0;
          globalThis.__A2_RESPONSES__ = [
            JSON.stringify({ op: "create", scope: "project", confidence: 9, reasoning: "pass1 confirm create" }),
            JSON.stringify({ verdict: "confirm_proposer", rationale: "pass2 confirms proposer" }),
          ];
          writeMultiviewPending({
            slug: "multiview-pending-loop-throw",
            kind: "multiview-pending",
            status: "provisional",
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            origin_project_id: aTarget.projectId,
            origin_project_root: aRoot,
            originating_device: "smoke",
            multiview_state: "reviewer_unavailable",
            retry_attempts: 0,
            trigger_reason: "create_high_confidence",
            proposer_decision: { op: "create", rationale: "loop throw proposer" },
            proposer_raw_text: "loop throw proposer raw",
            candidate_snapshot: { title: "Replay Loop Throw Smoke", kind: "fact", status: "active", confidence: 9, compiledTruth: "# Replay Loop Throw Smoke\n\nWriter throws so staging must remain." },
            correction_signal: null,
            neighbor_slugs: [],
          });
          const loopThrow = await replayMultiviewPending({
            settings: replaySettings,
            modelRegistry: loopModelRegistry,
            currentProjectId: aTarget.projectId,
            currentProjectRoot: aRoot,
            loadNeighborsBySlug: async () => [],
            writeApprovedToBrain: async () => { throw new Error("intentional writer failure"); },
          });
          assert(loopThrow.errors === 1 && loopThrow.succeeded === 0, `writer throw should be replay error: ${JSON.stringify(loopThrow)}`);
          let throwEntry = loadMultiviewPending().entries.find((entry) => entry.slug === "multiview-pending-loop-throw");
          assert(throwEntry && throwEntry.retry_attempts === 0 && throwEntry.writer_retry_attempts === 1 && /intentional writer failure/.test(throwEntry.last_writer_error || "") && !!throwEntry.next_retry_not_before_iso, `writer throw should keep original staging and record writer backoff without consuming reviewer budget: ${JSON.stringify(throwEntry)}`);
          const loopBackoff = await replayMultiviewPending({
            settings: replaySettings,
            modelRegistry: loopModelRegistry,
            currentProjectId: aTarget.projectId,
            currentProjectRoot: aRoot,
            loadNeighborsBySlug: async () => { throw new Error("backoff should skip before reviewer load"); },
            writeApprovedToBrain: async () => { throw new Error("backoff should skip before writer"); },
          });
          assert(loopBackoff.skipped_backoff === 1 && loopBackoff.attempted === 0 && loopBackoff.errors === 0, `writer backoff should skip without LLM/write or budget: ${JSON.stringify(loopBackoff)}`);

          writeMultiviewPending({
            slug: "multiview-pending-loop-owned-behind-backoff",
            kind: "multiview-pending",
            status: "provisional",
            created: new Date(Date.now() + 1_000).toISOString(),
            updated: new Date().toISOString(),
            origin_project_id: aTarget.projectId,
            origin_project_root: aRoot,
            originating_device: "smoke",
            multiview_state: "reviewer_unavailable",
            retry_attempts: 0,
            trigger_reason: "create_high_confidence",
            proposer_decision: { op: "create", rationale: "owned behind backoff proposer" },
            proposer_raw_text: "owned behind backoff raw",
            candidate_snapshot: { title: "Replay Loop Owned Behind Backoff", kind: "fact", status: "active", confidence: 9, compiledTruth: "# Replay Loop Owned Behind Backoff\n\nReady owned entry must not be starved by older backoff entries." },
            correction_signal: null,
            neighbor_slugs: [],
          });
          globalThis.__A2_INVOCATIONS__ = 0;
          globalThis.__A2_RESPONSES__ = [
            JSON.stringify({ op: "create", scope: "project", confidence: 9, reasoning: "pass1 confirm create" }),
            JSON.stringify({ verdict: "confirm_proposer", rationale: "pass2 confirms proposer" }),
          ];
          let ownedBehindBackoffWrote = false;
          const ownedBehindBackoff = await replayMultiviewPending({
            settings: replaySettings,
            modelRegistry: loopModelRegistry,
            currentProjectId: aTarget.projectId,
            currentProjectRoot: aRoot,
            loadNeighborsBySlug: async () => [],
            writeApprovedToBrain: async () => { ownedBehindBackoffWrote = true; },
          });
          assert(ownedBehindBackoff.skipped_backoff === 1 && ownedBehindBackoff.succeeded === 1 && ownedBehindBackoff.attempted === 1 && ownedBehindBackoffWrote === true, `ready entry should process behind older backoff entry: ${JSON.stringify(ownedBehindBackoff)}`);
          assert(!loadMultiviewPending().entries.some((entry) => entry.slug === "multiview-pending-loop-owned-behind-backoff"), `owned behind backoff should delete after success`);

          throwEntry = loadMultiviewPending().entries.find((entry) => entry.slug === "multiview-pending-loop-throw");
          throwEntry.next_retry_not_before_iso = new Date(Date.now() - 1_000).toISOString();
          writeMultiviewPending(throwEntry);
          let writerOnlyLoadedNeighbors = false;
          let writerOnlyWrote = false;
          const writerOnlyRetry = await replayMultiviewPending({
            settings: replaySettings,
            modelRegistry: loopModelRegistry,
            currentProjectId: aTarget.projectId,
            currentProjectRoot: aRoot,
            loadNeighborsBySlug: async () => { writerOnlyLoadedNeighbors = true; throw new Error("approved writer-only retry should skip reviewer load"); },
            writeApprovedToBrain: async (decision) => { writerOnlyWrote = decision.op === "create"; },
          });
          assert(writerOnlyRetry.succeeded === 1 && writerOnlyWrote === true && writerOnlyLoadedNeighbors === false, `approved_decision should retry writer only without re-review: ${JSON.stringify(writerOnlyRetry)} loaded=${writerOnlyLoadedNeighbors} wrote=${writerOnlyWrote}`);
          assert(!loadMultiviewPending().entries.some((entry) => entry.slug === "multiview-pending-loop-throw"), `writer-only retry success should delete staging`);

          globalThis.__A2_INVOCATIONS__ = 0;
          globalThis.__A2_RESPONSES__ = [
            JSON.stringify({ op: "create", scope: "project", confidence: 9, reasoning: "pass1 wants create but pass2 will fail" }),
            "not json pass2",
          ];
          writeMultiviewPending({
            slug: "multiview-pending-loop-restaged",
            kind: "multiview-pending",
            status: "provisional",
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            origin_project_id: aTarget.projectId,
            origin_project_root: aRoot,
            originating_device: "smoke",
            multiview_state: "reviewer_unavailable",
            retry_attempts: 0,
            trigger_reason: "create_high_confidence",
            proposer_decision: { op: "create", rationale: "loop restaged proposer" },
            proposer_raw_text: "loop restaged proposer raw",
            candidate_snapshot: { title: "Replay Loop Restaged Smoke", kind: "fact", status: "active", confidence: 9, compiledTruth: "# Replay Loop Restaged Smoke\n\nReplay reviewer fails again so original staging attempt count should advance." },
            correction_signal: null,
            neighbor_slugs: [],
          });
          const beforeRestagedSlugs = new Set(loadMultiviewPending().entries.map((entry) => entry.slug));
          const loopRestaged = await replayMultiviewPending({
            settings: replaySettings,
            modelRegistry: loopModelRegistry,
            currentProjectId: aTarget.projectId,
            currentProjectRoot: aRoot,
            loadNeighborsBySlug: async () => [],
            writeApprovedToBrain: async () => { throw new Error("re_staged path should not write"); },
          });
          assert(loopRestaged.re_staged === 1 && loopRestaged.errors === 0 && loopRestaged.auditRows.some((row) => row.slug === "multiview-pending-loop-restaged" && row.outcome === "re_staged" && row.new_attempts === 1), `re_staged path should audit attempt bump: ${JSON.stringify(loopRestaged)}`);
          const afterRestagedEntries = loadMultiviewPending().entries;
          const restagedOriginal = afterRestagedEntries.find((entry) => entry.slug === "multiview-pending-loop-restaged");
          assert(restagedOriginal && restagedOriginal.retry_attempts === 1, `re_staged path should bump original attempts: ${JSON.stringify(restagedOriginal)}`);
          const newRestagedSlugs = afterRestagedEntries.map((entry) => entry.slug).filter((slug) => !beforeRestagedSlugs.has(slug));
          assert(newRestagedSlugs.length === 0, `re_staged path should delete duplicate staging: ${JSON.stringify(newRestagedSlugs)}`);
          assert(deleteMultiviewPending("multiview-pending-loop-restaged") === true, `re_staged smoke cleanup failed`);

          writeMultiviewPending({
            slug: "multiview-pending-loop-other-project",
            kind: "multiview-pending",
            status: "provisional",
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            origin_project_id: "other-project",
            origin_project_root: "/tmp/other-project-root",
            originating_device: "smoke",
            multiview_state: "reviewer_unavailable",
            retry_attempts: 0,
            trigger_reason: "create_high_confidence",
            proposer_decision: { op: "create", rationale: "wrong project proposer" },
            proposer_raw_text: "wrong project raw",
            candidate_snapshot: { title: "Replay Loop Wrong Project", kind: "fact", status: "active", confidence: 9, compiledTruth: "# Replay Loop Wrong Project\n\nMust not write into current project." },
            correction_signal: null,
            neighbor_slugs: [],
          });
          let mismatchWrote = false;
          const mismatch = await replayMultiviewPending({
            settings: replaySettings,
            modelRegistry: loopModelRegistry,
            currentProjectId: aTarget.projectId,
            currentProjectRoot: aRoot,
            loadNeighborsBySlug: async () => [],
            writeApprovedToBrain: async () => { mismatchWrote = true; },
          });
          assert(mismatch.deferred_other_project === 1 && mismatch.errors === 0 && mismatch.auditRows.length === 0 && mismatchWrote === false, `origin mismatch should defer without write/error/per-entry audit spam: ${JSON.stringify(mismatch)} wrote=${mismatchWrote}`);
          assert(loadMultiviewPending().entries.some((entry) => entry.slug === "multiview-pending-loop-other-project"), `origin mismatch should keep staging for owning project`);
          writeMultiviewPending({
            slug: "multiview-pending-loop-owned-behind-other-project",
            kind: "multiview-pending",
            status: "provisional",
            created: new Date(Date.now() + 1_000).toISOString(),
            updated: new Date().toISOString(),
            origin_project_id: aTarget.projectId,
            origin_project_root: aRoot,
            originating_device: "smoke",
            multiview_state: "reviewer_unavailable",
            retry_attempts: 0,
            trigger_reason: "create_high_confidence",
            proposer_decision: { op: "create", rationale: "owned behind mismatch proposer" },
            proposer_raw_text: "owned behind mismatch raw",
            candidate_snapshot: { title: "Replay Loop Owned Behind Mismatch", kind: "fact", status: "active", confidence: 9, compiledTruth: "# Replay Loop Owned Behind Mismatch\n\nOwned entry must not be starved by older other-project entries." },
            correction_signal: null,
            neighbor_slugs: [],
          });
          globalThis.__A2_INVOCATIONS__ = 0;
          globalThis.__A2_RESPONSES__ = [
            JSON.stringify({ op: "create", scope: "project", confidence: 9, reasoning: "pass1 confirm create" }),
            JSON.stringify({ verdict: "confirm_proposer", rationale: "pass2 confirms proposer" }),
          ];
          let ownedBehindWrote = false;
          const ownedBehind = await replayMultiviewPending({
            settings: replaySettings,
            modelRegistry: loopModelRegistry,
            currentProjectId: aTarget.projectId,
            currentProjectRoot: aRoot,
            loadNeighborsBySlug: async () => [],
            writeApprovedToBrain: async () => { ownedBehindWrote = true; },
          });
          assert(ownedBehind.deferred_other_project === 1 && ownedBehind.succeeded === 1 && ownedBehindWrote === true, `owned entry should process behind other-project entry: ${JSON.stringify(ownedBehind)}`);
          assert(!loadMultiviewPending().entries.some((entry) => entry.slug === "multiview-pending-loop-owned-behind-other-project"), `owned behind mismatch should delete after success`);
          assert(loadMultiviewPending().entries.some((entry) => entry.slug === "multiview-pending-loop-other-project"), `other-project entry should remain after owned entry drains`);
          assert(deleteMultiviewPending("multiview-pending-loop-other-project") === true, `origin mismatch smoke cleanup failed`);

          const staleCreated = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
          const missingOriginRoot = path.join(replayRoot, "missing-origin-project-root");
          writeMultiviewPending({
            slug: "multiview-pending-loop-stale-missing-origin",
            kind: "multiview-pending",
            status: "provisional",
            created: staleCreated,
            updated: staleCreated,
            origin_project_id: "missing-origin-project",
            origin_project_root: missingOriginRoot,
            originating_device: "smoke",
            multiview_state: "reviewer_unavailable",
            retry_attempts: 0,
            trigger_reason: "create_high_confidence",
            proposer_decision: { op: "create", rationale: "stale missing origin proposer" },
            proposer_raw_text: "stale missing origin raw",
            candidate_snapshot: { title: "Replay Stale Missing Origin", kind: "fact", status: "active", confidence: 9, compiledTruth: "# Replay Stale Missing Origin\n\nOld other-project entry whose captured root no longer exists should be soft-archived." },
            correction_signal: null,
            neighbor_slugs: [],
          });
          writeMultiviewPending({
            slug: "multiview-pending-loop-owned-behind-stale-missing-origin",
            kind: "multiview-pending",
            status: "provisional",
            created: new Date(Date.now() + 1_000).toISOString(),
            updated: new Date().toISOString(),
            origin_project_id: aTarget.projectId,
            origin_project_root: aRoot,
            originating_device: "smoke",
            multiview_state: "reviewer_unavailable",
            retry_attempts: 0,
            trigger_reason: "create_high_confidence",
            proposer_decision: { op: "create", rationale: "owned behind stale missing origin proposer" },
            proposer_raw_text: "owned behind stale missing origin raw",
            candidate_snapshot: { title: "Replay Owned Behind Stale Missing Origin", kind: "fact", status: "active", confidence: 9, compiledTruth: "# Replay Owned Behind Stale Missing Origin\n\nOwned entry must still process after stale missing-origin cleanup." },
            correction_signal: null,
            neighbor_slugs: [],
          });
          globalThis.__A2_INVOCATIONS__ = 0;
          globalThis.__A2_RESPONSES__ = [
            JSON.stringify({ op: "create", scope: "project", confidence: 9, reasoning: "pass1 confirm create" }),
            JSON.stringify({ verdict: "confirm_proposer", rationale: "pass2 confirms proposer" }),
          ];
          let staleMissingWrote = false;
          const staleMissing = await replayMultiviewPending({
            settings: replaySettings,
            modelRegistry: loopModelRegistry,
            currentProjectId: aTarget.projectId,
            currentProjectRoot: aRoot,
            loadNeighborsBySlug: async () => [],
            writeApprovedToBrain: async () => { staleMissingWrote = true; },
          });
          const abandonedDir = path.join(replayRoot, ".state", "sediment", "staging", "abandoned");
          const abandonedFiles = fs.existsSync(abandonedDir) ? fs.readdirSync(abandonedDir) : [];
          assert(staleMissing.terminal_stale === 1 && staleMissing.succeeded === 1 && staleMissing.deferred_other_project === 0 && staleMissing.errors === 0 && staleMissingWrote === true, `stale missing-origin should archive while owned entry still processes: ${JSON.stringify(staleMissing)} wrote=${staleMissingWrote}`);
          assert(!loadMultiviewPending().entries.some((entry) => entry.slug === "multiview-pending-loop-stale-missing-origin"), `stale missing-origin should leave live pending queue`);
          assert(abandonedFiles.some((file) => file.endsWith("-multiview-pending-loop-stale-missing-origin.json")), `stale missing-origin should be soft-archived to abandoned/: ${JSON.stringify(abandonedFiles)}`);
          assert(!loadMultiviewPending().entries.some((entry) => entry.slug === "multiview-pending-loop-owned-behind-stale-missing-origin"), `owned behind stale missing-origin should delete after success`);

          const liveOtherProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-live-other-project-"));
          writeMultiviewPending({
            slug: "multiview-pending-loop-stale-live-other-project",
            kind: "multiview-pending",
            status: "provisional",
            created: staleCreated,
            updated: staleCreated,
            origin_project_id: "live-other-project",
            origin_project_root: liveOtherProjectRoot,
            originating_device: "smoke",
            multiview_state: "reviewer_unavailable",
            retry_attempts: 0,
            trigger_reason: "create_high_confidence",
            proposer_decision: { op: "create", rationale: "stale live other project proposer" },
            proposer_raw_text: "stale live other project raw",
            candidate_snapshot: { title: "Replay Stale Live Other Project", kind: "fact", status: "active", confidence: 9, compiledTruth: "# Replay Stale Live Other Project\n\nOld other-project entry with an existing origin root still belongs to that project." },
            correction_signal: null,
            neighbor_slugs: [],
          });
          let liveOtherProjectWrote = false;
          const liveOtherProject = await replayMultiviewPending({
            settings: replaySettings,
            modelRegistry: loopModelRegistry,
            currentProjectId: aTarget.projectId,
            currentProjectRoot: aRoot,
            loadNeighborsBySlug: async () => [],
            writeApprovedToBrain: async () => { liveOtherProjectWrote = true; },
          });
          assert(liveOtherProject.deferred_other_project === 1 && liveOtherProject.terminal_stale === 0 && liveOtherProject.errors === 0 && liveOtherProject.auditRows.length === 0 && liveOtherProjectWrote === false, `stale live other-project should still defer silently: ${JSON.stringify(liveOtherProject)} wrote=${liveOtherProjectWrote}`);
          assert(loadMultiviewPending().entries.some((entry) => entry.slug === "multiview-pending-loop-stale-live-other-project"), `stale live other-project should remain pending for its owning project`);
          assert(deleteMultiviewPending("multiview-pending-loop-stale-live-other-project") === true, `stale live other-project smoke cleanup failed`);

          // ── S1: fail-closed project resolution (no-origin must NOT misfile) ──
          // A project-scope candidate with NO captured origin must not be written
          // into the ambient/current project (that misfiled the kihh `ayhz0001`
          // decision into pi-global). It must be soft-archived as
          // terminal_no_origin. Driven through the approved_decision fast-path so
          // the final decision's scope is deterministic (no reviewer mock).
          writeMultiviewPending({
            slug: "multiview-pending-loop-no-origin",
            kind: "multiview-pending",
            status: "provisional",
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            // intentionally NO origin_project_id / origin_project_root
            originating_device: "smoke",
            multiview_state: "reviewer_unavailable",
            retry_attempts: 0,
            trigger_reason: "create_high_confidence",
            proposer_decision: { op: "create", rationale: "no origin proposer" },
            proposer_raw_text: "no origin raw",
            approved_decision: { op: "create", rationale: "no origin approved (project scope)" },
            candidate_snapshot: { title: "Replay No Origin Project", kind: "fact", status: "active", confidence: 9, compiledTruth: "# Replay No Origin Project\n\nUnpinned project candidate must not be misfiled into the ambient project." },
            correction_signal: null,
            neighbor_slugs: [],
          });
          let noOriginWrote = false;
          const noOrigin = await replayMultiviewPending({
            settings: replaySettings,
            modelRegistry: loopModelRegistry,
            currentProjectId: aTarget.projectId,
            currentProjectRoot: aRoot,
            loadNeighborsBySlug: async () => [],
            writeApprovedToBrain: async () => { noOriginWrote = true; },
          });
          assert(noOrigin.terminal_no_origin === 1 && noOrigin.succeeded === 0 && noOrigin.errors === 0 && noOriginWrote === false, `S1: unpinned project candidate must not write to ambient project (terminal_no_origin): ${JSON.stringify(noOrigin)} wrote=${noOriginWrote}`);
          assert(!loadMultiviewPending().entries.some((entry) => entry.slug === "multiview-pending-loop-no-origin"), `S1: unpinned project candidate should be soft-archived (removed from pending)`);

          // ── S1 counter-case: world-scope no-origin MUST still write ──
          // World entries live in the global store; origin binding is irrelevant.
          // The gate must NOT over-defer them (otherwise a reviewer-promoted world
          // insight captured in an unbound session would be silently lost).
          writeMultiviewPending({
            slug: "multiview-pending-loop-no-origin-world",
            kind: "multiview-pending",
            status: "provisional",
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            originating_device: "smoke",
            multiview_state: "reviewer_unavailable",
            retry_attempts: 0,
            trigger_reason: "create_high_confidence",
            proposer_decision: { op: "create", scope: "world", rationale: "no origin world proposer" },
            proposer_raw_text: "no origin world raw",
            approved_decision: { op: "create", scope: "world", rationale: "no origin approved (world scope)" },
            candidate_snapshot: { title: "Replay No Origin World", kind: "fact", status: "active", confidence: 9, compiledTruth: "# Replay No Origin World\n\nWorld candidate with no origin must still be written to the global store." },
            correction_signal: null,
            neighbor_slugs: [],
          });
          let worldNoOriginWrote = false;
          const worldNoOrigin = await replayMultiviewPending({
            settings: replaySettings,
            modelRegistry: loopModelRegistry,
            currentProjectId: aTarget.projectId,
            currentProjectRoot: aRoot,
            loadNeighborsBySlug: async () => [],
            writeApprovedToBrain: async () => { worldNoOriginWrote = true; },
          });
          assert(worldNoOrigin.succeeded === 1 && worldNoOrigin.terminal_no_origin === 0 && worldNoOriginWrote === true, `S1: world-scope candidate with no origin must still be written: ${JSON.stringify(worldNoOrigin)} wrote=${worldNoOriginWrote}`);

          // ── S1 partial-origin: id set but root unset must ALSO be unplaceable ──
          // classifyProjectPlacement requires BOTH origin fields; a half-pinned
          // entry cannot prove its owning project and must not be misfiled.
          writeMultiviewPending({
            slug: "multiview-pending-loop-partial-origin",
            kind: "multiview-pending",
            status: "provisional",
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            origin_project_id: aTarget.projectId,
            // intentionally NO origin_project_root
            originating_device: "smoke",
            multiview_state: "reviewer_unavailable",
            retry_attempts: 0,
            trigger_reason: "create_high_confidence",
            proposer_decision: { op: "create", rationale: "partial origin proposer" },
            proposer_raw_text: "partial origin raw",
            approved_decision: { op: "create", rationale: "partial origin approved (project scope)" },
            candidate_snapshot: { title: "Replay Partial Origin", kind: "fact", status: "active", confidence: 9, compiledTruth: "# Replay Partial Origin\n\nPartial origin (id without root) must not be treated as placeable." },
            correction_signal: null,
            neighbor_slugs: [],
          });
          let partialWrote = false;
          const partialOrigin = await replayMultiviewPending({
            settings: replaySettings,
            modelRegistry: loopModelRegistry,
            currentProjectId: aTarget.projectId,
            currentProjectRoot: aRoot,
            loadNeighborsBySlug: async () => [],
            writeApprovedToBrain: async () => { partialWrote = true; },
          });
          assert(partialOrigin.terminal_no_origin === 1 && partialWrote === false, `S1: partial origin (id without root) must be unplaceable / no-write: ${JSON.stringify(partialOrigin)} wrote=${partialWrote}`);

          // ── S1 regression guard: unpinned GLOBAL rule create must still write ──
          // A rules-zone create with ruleScope:global routes to the GLOBAL rules
          // store (curator-decision-writer.ts), not a project — it has no misfile
          // risk, so the project-binding gate must NOT abandon it.
          writeMultiviewPending({
            slug: "multiview-pending-loop-no-origin-global-rule",
            kind: "multiview-pending",
            status: "provisional",
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            originating_device: "smoke",
            multiview_state: "reviewer_unavailable",
            retry_attempts: 0,
            trigger_reason: "create_rules_zone",
            proposer_decision: { op: "create", zone: "rules", ruleScope: "global", rationale: "no origin global rule proposer" },
            proposer_raw_text: "no origin global rule raw",
            approved_decision: { op: "create", zone: "rules", ruleScope: "global", rationale: "no origin approved (global rule)" },
            candidate_snapshot: { title: "Replay No Origin Global Rule", kind: "preference", status: "active", confidence: 9, compiledTruth: "# Replay No Origin Global Rule\n\nGlobal rule routes to the global store; must be written regardless of origin binding." },
            correction_signal: null,
            neighbor_slugs: [],
          });
          let globalRuleWrote = false;
          const globalRule = await replayMultiviewPending({
            settings: replaySettings,
            modelRegistry: loopModelRegistry,
            currentProjectId: aTarget.projectId,
            currentProjectRoot: aRoot,
            loadNeighborsBySlug: async () => [],
            writeApprovedToBrain: async () => { globalRuleWrote = true; },
          });
          assert(globalRule.succeeded === 1 && globalRule.terminal_no_origin === 0 && globalRuleWrote === true, `S1: unpinned global rule create must still be written (global store, not project): ${JSON.stringify(globalRule)} wrote=${globalRuleWrote}`);
        } finally {
          if (oldReplayAbrainRoot === undefined) delete process.env.ABRAIN_ROOT;
          else process.env.ABRAIN_ROOT = oldReplayAbrainRoot;
        }
      }

      _resetAutoWriteStateForTests();
    }

    const world = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-abrain-"));
    process.env.ABRAIN_ROOT = world;
    fs.mkdirSync(path.join(world, "facts"), { recursive: true });
    writeFile(path.join(world, "facts", "w.md"), makeEntry({ title: "World Fact", extraFrontmatter: "scope: world\n" }).replace("scope: project\n", ""));
    const worldGraph = await rebuildGraphIndex(path.join(world, "facts", "w.md"), DEFAULT_SETTINGS, undefined, world);
    assert(worldGraph.graph_path === ".state/index/graph.json", "world graph path mismatch");

    // === abrain workflows lane writer (B1) ==================================
    // Strategy: use a fresh fake abrain home (already git-inited here), exercise
    // writeAbrainWorkflow for: cross-project route, project-specific route,
    // validation failures, sanitize redaction, dedupe collision, audit row,
    // git commit observation. Stays offline (no real network / LLM).
    {
      const wfHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-wf-"));
      // abrain repo must be a git repo for gitCommitAbrain.
      execFileSync("git", ["-C", wfHome, "init", "-q"]);
      execFileSync("git", ["-C", wfHome, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", wfHome, "config", "user.name", "pi-astack smoke"]);
      const wfSettings = { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: true };

      // 1) cross-project workflow → ~/.abrain/workflows/<slug>.md
      const wfX = await writeAbrainWorkflow(
        {
          title: "Run when reviewing code",
          trigger: "用户说 review / 代码审查 / 检查代码",
          body: "## Task Blueprint\n\n### Task 1: Identify hotspots\n- Read recent commits\n- Spot signal/noise\n\n### Task 2: Produce review notes\n- Reference taste-review knowledge",
          crossProject: true,
          tags: ["workflow", "review"],
          sessionId: "smoke-wf-1",
        },
        { abrainHome: wfHome, settings: wfSettings },
      );
      assert(wfX.status === "created", `cross-project workflow should create, got ${JSON.stringify(wfX)}`);
      assert(wfX.crossProject === true, `wfX.crossProject must be true`);
      assert(wfX.lane === "workflow", `wfX.lane must be 'workflow', got ${wfX.lane}`);
      assert(wfX.path === path.join(wfHome, "workflows", "run-when-reviewing-code.md"), `unexpected cross-project path: ${wfX.path}`);
      assert(fs.existsSync(wfX.path), `cross-project workflow file missing: ${wfX.path}`);
      const wfXText = fs.readFileSync(wfX.path, "utf-8");
      assert(/^id: workflow:run-when-reviewing-code$/m.test(wfXText), `cross-project id missing:\n${wfXText}`);
      assert(/^cross_project: true$/m.test(wfXText), `cross_project: true missing`);
      assert(/^scope: workflow$/m.test(wfXText), `scope: workflow missing`);
      assert(/^kind: workflow$/m.test(wfXText), `kind: workflow missing`);
      assert(/## Timeline\s*\n- .* smoke-wf-1/m.test(wfXText), `Timeline session id missing`);

      // 2) project-specific workflow → ~/.abrain/projects/<id>/workflows/<slug>.md
      // Note: writer does not auto-create projects/<id>/, mkdir -p inside atomicWrite handles it.
      const wfP = await writeAbrainWorkflow(
        {
          title: "Update Claude plugins",
          trigger: "用户要求更新插件 / upgrade plugins",
          body: "Run `claude plugins marketplace update`; verify success message.",
          projectId: "home-dot-claude",
          tags: ["workflow", "claude", "plugins"],
          sessionId: "smoke-wf-2",
        },
        { abrainHome: wfHome, settings: wfSettings },
      );
      assert(wfP.status === "created", `project workflow should create, got ${JSON.stringify(wfP)}`);
      assert(wfP.crossProject === false, `wfP.crossProject must be false, got ${wfP.crossProject}`);
      assert(wfP.projectId === "home-dot-claude", `wfP.projectId mismatch`);
      assert(wfP.path === path.join(wfHome, "projects", "home-dot-claude", "workflows", "update-claude-plugins.md"), `unexpected project path: ${wfP.path}`);
      const wfPText = fs.readFileSync(wfP.path, "utf-8");
      assert(/^id: project:home-dot-claude:workflow:update-claude-plugins$/m.test(wfPText), `project-scoped id missing:\n${wfPText}`);
      assert(/^cross_project: false$/m.test(wfPText), `cross_project: false missing`);
      assert(/^project_id: home-dot-claude$/m.test(wfPText), `project_id field missing`);

      // 3) validation: missing trigger
      const v1 = await writeAbrainWorkflow(
        { title: "x", trigger: "", body: "x".repeat(50), crossProject: true },
        { abrainHome: wfHome, settings: wfSettings },
      );
      assert(v1.status === "rejected" && v1.reason === "validation_error", `empty trigger must reject: ${JSON.stringify(v1)}`);
      assert(v1.validationErrors.some((e) => e.field === "trigger"), `validationErrors must include trigger`);

      // 4) validation: missing projectId when crossProject=false (default)
      const v2 = await writeAbrainWorkflow(
        { title: "y", trigger: "t", body: "y".repeat(50) },
        { abrainHome: wfHome, settings: wfSettings },
      );
      assert(v2.status === "rejected" && v2.reason === "validation_error", `missing projectId must reject`);
      assert(v2.validationErrors.some((e) => e.field === "projectId"), `validationErrors must include projectId`);

      // 5) validation: body too short
      const v3 = await writeAbrainWorkflow(
        { title: "z", trigger: "t", body: "short", crossProject: true },
        { abrainHome: wfHome, settings: wfSettings },
      );
      assert(v3.status === "rejected" && v3.validationErrors.some((e) => e.field === "body"), `short body must reject`);

      // 6) sanitize: AWS access key in body → redact and continue
      const awsWorkflowRaw = "AKIA" + "IOSFODNN7EXAMPLE";
      const sec = await writeAbrainWorkflow(
        {
          title: "leaks aws key",
          trigger: "never",
          body: `Run with ${awsWorkflowRaw} which is a fake-looking AWS key pattern.`,
          crossProject: true,
        },
        { abrainHome: wfHome, settings: wfSettings },
      );
      assert(sec.status === "created", `sanitize should redact AWS-pattern body and create: ${JSON.stringify(sec)}`);
      const secWritten = fs.readFileSync(sec.path, "utf-8");
      assert(secWritten.includes("[SECRET:aws_access_key]") && !secWritten.includes(awsWorkflowRaw), `workflow body secret not redacted: ${secWritten}`);

      // 7) dedupe: writing same slug twice → second rejected with duplicate_slug
      const dup = await writeAbrainWorkflow(
        {
          title: "Run when reviewing code",
          trigger: "same as wf1",
          body: "A different body that's long enough to pass validation.",
          crossProject: true,
        },
        { abrainHome: wfHome, settings: wfSettings },
      );
      assert(dup.status === "rejected" && dup.reason === "duplicate_slug", `duplicate slug must reject: ${JSON.stringify(dup)}`);

      // 8) dry-run: does not write
      const dr = await writeAbrainWorkflow(
        {
          title: "Sync upstream",
          trigger: "upstream sync request",
          body: "Pull, rebase, push. Verify CI green before promoting.",
          crossProject: true,
        },
        { abrainHome: wfHome, settings: wfSettings, dryRun: true },
      );
      assert(dr.status === "dry_run", `dry-run status mismatch: ${JSON.stringify(dr)}`);
      assert(!fs.existsSync(dr.path), `dry-run should not write file: ${dr.path}`);

      // 9) audit rows: ~/.abrain/.state/sediment/audit.jsonl exists and contains expected ops
      const auditPath = path.join(wfHome, ".state", "sediment", "audit.jsonl");
      assert(fs.existsSync(auditPath), `audit jsonl missing: ${auditPath}`);
      const auditRows = fs.readFileSync(auditPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      const ops = auditRows.map((r) => r.operation);
      assert(ops.includes("create"), `audit must include create op, got ${ops.join(",")}`);
      assert(ops.includes("reject"), `audit must include reject op (validation/sanitize/dedupe)`);
      assert(ops.includes("dry_run"), `audit must include dry_run op`);
      assert(auditRows.every((r) => r.lane === "workflow"), `every audit row must have lane=workflow, got: ${[...new Set(auditRows.map((r) => r.lane))].join(",")}`);
      const createRow = auditRows.find((r) => r.operation === "create" && r.cross_project === true);
      assert(createRow, `expected at least one create row with cross_project=true`);
      assert(createRow.git_commit && /^[0-9a-f]{40}$/.test(createRow.git_commit), `create row should carry git_commit sha, got ${createRow.git_commit}`);

      // 10) git history: at least 2 workflow: commits in abrain repo
      const gitLog = execFileSync("git", ["-C", wfHome, "log", "--pretty=%s"], { encoding: "utf-8" });
      const workflowCommits = gitLog.split("\n").filter((s) => s.startsWith("workflow: ")).length;
      assert(workflowCommits >= 2, `expected ≥2 workflow commits in abrain git log, got ${workflowCommits}:\n${gitLog}`);
    }

    // === Lane G writer (ADR 0021 G1: writeAbrainAboutMe + router + fence extractor) =====
    // Strategy: fresh abrain home (git inited). Exercise writeAbrainAboutMe
    // for the 3 happy regions + validation + router rules + sanitize +
    // dedupe + git rollback + audit + fence extractor.
    {
      const amHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-am-"));
      execFileSync("git", ["-C", amHome, "init", "-q"]);
      execFileSync("git", ["-C", amHome, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", amHome, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", amHome, "config", "commit.gpgsign", "false"]);
      // staging needs a project dir to land observations/staging/ under
      fs.mkdirSync(path.join(amHome, "projects", "smoke-project"), { recursive: true });
      const amSettings = { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: true };

      // ---- router: pure unit checks first (no I/O) ----------------------
      assert(Array.isArray(LANE_G_ALLOWED_REGIONS) && LANE_G_ALLOWED_REGIONS.includes("identity") && LANE_G_ALLOWED_REGIONS.includes("skills") && LANE_G_ALLOWED_REGIONS.includes("habits") && LANE_G_ALLOWED_REGIONS.includes("staging"), "LANE_G_ALLOWED_REGIONS must include 4 regions");
      assert(ROUTING_CONFIDENCE_THRESHOLD === 0.6, `threshold must be 0.6 per ADR 0014 §3.5, got ${ROUTING_CONFIDENCE_THRESHOLD}`);
      // valid decision passes
      validateRouteDecision({ lane: "about_me", chosen_region: "identity", route_candidates: ["identity"], routing_reason: "r", routing_confidence: 0.9 });
      // rule 4: hard exclusion
      let r4err = null;
      try { validateRouteDecision({ lane: "about_me", chosen_region: "knowledge", route_candidates: ["knowledge"], routing_reason: "r", routing_confidence: 0.9 }); }
      catch (e) { r4err = e; }
      assert(r4err && r4err.name === "RouterError" && r4err.rule === 4, `rule 4 must reject knowledge: ${r4err}`);
      // rule 1: not in allowlist (synthetic invalid region)
      let r1err = null;
      try { validateRouteDecision({ lane: "about_me", chosen_region: "observations", route_candidates: ["observations"], routing_reason: "r", routing_confidence: 0.9 }); }
      catch (e) { r1err = e; }
      assert(r1err && r1err.rule === 1, `rule 1 must reject 'observations'`);
      // rule 2: chosen not in candidates
      let r2err = null;
      try { validateRouteDecision({ lane: "about_me", chosen_region: "identity", route_candidates: ["skills"], routing_reason: "r", routing_confidence: 0.9 }); }
      catch (e) { r2err = e; }
      assert(r2err && r2err.rule === 2, `rule 2 must reject chosen∉candidates`);
      // rule 3: low confidence + non-staging
      let r3err = null;
      try { validateRouteDecision({ lane: "about_me", chosen_region: "identity", route_candidates: ["identity"], routing_reason: "r", routing_confidence: 0.4 }); }
      catch (e) { r3err = e; }
      assert(r3err && r3err.rule === 3, `rule 3 must reject low confidence into non-staging`);
      // rule 6: missing reason
      let r6err = null;
      try { validateRouteDecision({ lane: "about_me", chosen_region: "identity", route_candidates: ["identity"], routing_reason: "", routing_confidence: 0.9 }); }
      catch (e) { r6err = e; }
      assert(r6err && r6err.rule === 6, `rule 6 must reject empty reason`);
      // applyStagingDowngrade: low conf → staging, preserves original in candidates
      const downgraded = applyStagingDowngrade({ lane: "about_me", chosen_region: "identity", route_candidates: ["identity", "habits"], routing_reason: "sample", routing_confidence: 0.3 });
      assert(downgraded.chosen_region === "staging", `low conf should downgrade to staging, got ${downgraded.chosen_region}`);
      assert(downgraded.route_candidates.includes("identity"), `downgrade must preserve original choice in candidates`);
      assert(/downgraded:/.test(downgraded.routing_reason), `downgrade reason must annotate the downgrade`);
      // applyStagingDowngrade: high conf passes through unchanged
      const passed = applyStagingDowngrade({ lane: "about_me", chosen_region: "identity", route_candidates: ["identity"], routing_reason: "r", routing_confidence: 0.9 });
      assert(passed.chosen_region === "identity" && passed.routing_confidence === 0.9, `high conf must pass through unchanged`);

      // ---- writer: identity happy path ----------------------------------
      const am1 = await writeAbrainAboutMe(
        {
          title: "I prefer fail-closed designs",
          body: "I consistently choose designs that refuse to operate on missing inputs rather than silently degrading. Examples: vault unlock, sediment write rejection.",
          region: "identity",
          routingConfidence: 0.95,
          routeCandidates: ["identity"],
          routingReason: "strong-self-narrative-signal",
          triggerPhrases: ["fail-closed", "fail-open"],
          tags: ["design", "values"],
          sessionId: "smoke-am-1",
        },
        { abrainHome: amHome, settings: amSettings },
      );
      assert(am1.status === "created", `identity happy path: ${JSON.stringify(am1)}`);
      assert(am1.lane === "about_me", `lane must be about_me, got ${am1.lane}`);
      assert(am1.region === "identity", `region must be identity, got ${am1.region}`);
      assert(am1.path === path.join(amHome, "identity", "i-prefer-fail-closed-designs.md"), `unexpected identity path: ${am1.path}`);
      assert(fs.existsSync(am1.path), `identity file must exist`);
      const am1Text = fs.readFileSync(am1.path, "utf-8");
      assert(/^id: about-me:identity:i-prefer-fail-closed-designs$/m.test(am1Text), `identity id missing:\n${am1Text}`);
      // P0-1 audit fix 2026-05-15: scope MUST be the canonical "world"
      // (memory/types.ts Scope binary), not "about_me" — the read-side
      // parseEntry only accepts world|project and would silently drop
      // any other value. region carries the Lane G sub-classification.
      assert(/^scope: world$/m.test(am1Text), `Lane G non-staging entries must have scope: world (P0-1):\n${am1Text}`);
      assert(!/^scope: about_me$/m.test(am1Text), `legacy scope: about_me must NOT appear (P0-1 regression)`);
      assert(/^kind: maxim$/m.test(am1Text), `identity should map to kind=maxim`);
      assert(/^lane: about_me$/m.test(am1Text), `lane: about_me missing in frontmatter`);
      assert(/^region: identity$/m.test(am1Text), `region: identity missing in frontmatter`);
      // P1-5 audit fix: routing_confidence is float-shaped 2dp, not
      // "0.95" / "1" / "0.5" inconsistency.
      assert(/^routing_confidence: 0\.95$/m.test(am1Text), `routing_confidence must be 0.95 (2dp float):\n${am1Text}`);
      assert(/^routing_reason: strong-self-narrative-signal$/m.test(am1Text), `routing_reason missing`);
      assert(/## Timeline\s*\n- .* smoke-am-1/.test(am1Text), `timeline session missing`);

      // ---- writer: skills happy path → kind=fact ----
      const am2 = await writeAbrainAboutMe(
        {
          title: "I am proficient in TypeScript",
          body: "Daily driver for 4 years; comfortable with conditional types, mapped types, and complex generic constraints. Faster than Python or Go for me on most tasks.",
          region: "skills",
          routingConfidence: 0.85,
          routeCandidates: ["skills"],
          routingReason: "explicit-skill-inventory",
          sessionId: "smoke-am-2",
        },
        { abrainHome: amHome, settings: amSettings },
      );
      assert(am2.status === "created" && am2.region === "skills", `skills happy: ${JSON.stringify(am2)}`);
      const am2Text = fs.readFileSync(am2.path, "utf-8");
      assert(/^kind: fact$/m.test(am2Text), `skills should map to kind=fact`);
      assert(am2.path === path.join(amHome, "skills", "i-am-proficient-in-typescript.md"), `unexpected skills path: ${am2.path}`);

      // ---- writer: habits happy path → kind=pattern ----
      const am3 = await writeAbrainAboutMe(
        {
          title: "I run smoke before commit",
          body: "After every code change I run the affected smoke script before staging the commit; I treat smoke pass as the minimum gate, not lint.",
          region: "habits",
          routingConfidence: 0.7,
          routeCandidates: ["habits"],
          routingReason: "observed-pattern-recurrent",
          sessionId: "smoke-am-3",
        },
        { abrainHome: amHome, settings: amSettings },
      );
      assert(am3.status === "created" && am3.region === "habits", `habits happy: ${JSON.stringify(am3)}`);
      const am3Text = fs.readFileSync(am3.path, "utf-8");
      assert(/^kind: pattern$/m.test(am3Text), `habits should map to kind=pattern`);

      // ---- writer: validation_error (short body) ----
      const amVE = await writeAbrainAboutMe(
        { title: "x", body: "short", region: "identity", routingConfidence: 0.9, routeCandidates: ["identity"], routingReason: "r" },
        { abrainHome: amHome, settings: amSettings },
      );
      assert(amVE.status === "rejected" && amVE.reason === "validation_error", `short body must reject: ${JSON.stringify(amVE)}`);
      assert(amVE.validationErrors.some((e) => e.field === "body"), `validationErrors must include body field`);

      // ---- writer: validation_error (staging missing project) ----
      const amVS = await writeAbrainAboutMe(
        { title: "staging without project", body: "x".repeat(50), region: "staging", routingConfidence: 0.5, routeCandidates: ["staging"], routingReason: "low-conf-sample" },
        { abrainHome: amHome, settings: amSettings },
      );
      assert(amVS.status === "rejected" && amVS.validationErrors.some((e) => e.field === "stagingProjectId"), `staging w/o project must reject`);

      // ---- writer: Lane G must reject writing to knowledge ----
      // After P0-2 audit fix (2026-05-15) the validateAboutMeDraft region
      // enum check fires BEFORE the router, so attempts to write to
      // knowledge/workflows/projects/vault are rejected as
      // validation_error (fail-fast) instead of route_rejected. The
      // router's rule 4 (LANE_G_HARD_EXCLUDED_REGIONS) is still tested
      // directly via validateRouteDecision in the router unit checks
      // above, so we have defense-in-depth: two independent guards.
      const amRR = await writeAbrainAboutMe(
        { title: "abusing knowledge as region", body: "x".repeat(50), region: "knowledge", routingConfidence: 0.9, routeCandidates: ["knowledge"], routingReason: "attempt-to-leak" },
        { abrainHome: amHome, settings: amSettings },
      );
      assert(amRR.status === "rejected" && amRR.reason === "validation_error", `Lane G must reject knowledge as validation_error (P0-2): ${JSON.stringify(amRR)}`);
      assert(amRR.validationErrors.some((e) => e.field === "region"), `validation must flag region field`);

      // ---- writer: route_rejected (rule 2: chosen ∉ candidates) ----
      // After P0-2 region enum is enforced upstream, the writer can only
      // route_reject via the router's rule 2 (the rule 3 confidence gate
      // is auto-resolved by applyStagingDowngrade). Synthetic case where
      // chosen=identity but candidates only contains skills — simulates
      // a malformed router decision (future G3 LLM output bug). The
      // staging anchor (stagingProjectId + epoch) is supplied so the
      // route_rejected sample lands in projects/<id>/staging/rejected/.
      const amR2 = await writeAbrainAboutMe(
        { title: "chosen not in candidates", body: "x".repeat(50), region: "identity", routingConfidence: 0.9, routeCandidates: ["skills"], routingReason: "synthetic-malformed", stagingProjectId: "smoke-project", stagingSessionEpoch: 1700000000000 },
        { abrainHome: amHome, settings: amSettings },
      );
      assert(amR2.status === "rejected" && amR2.reason === "route_rejected", `chosen∉candidates must route_reject: ${JSON.stringify(amR2)}`);
      assert(amR2.routeRejected && amR2.routeRejected.rule === 2, `routeRejected.rule must be 2, got ${JSON.stringify(amR2.routeRejected)}`);

      // P2-A audit fix 2026-05-16: rejected sample filename must contain
      // the 4-segment shape `<date>--<pid>--<epoch>--<Date.now()>.md`.
      // The earlier P0-3 fix relies on Date.now() suffix to defeat same
      // pid+epoch+date collisions; regressing to a 3-segment filename
      // would silently overwrite.
      const rejectedDir = path.join(amHome, "projects", "smoke-project", "observations", "staging", "rejected");
      assert(fs.existsSync(rejectedDir), `rejected dir must exist after route_rejected with stagingProjectId: ${rejectedDir}`);
      const rejectedFiles = fs.readdirSync(rejectedDir).filter((f) => f.endsWith(".md"));
      assert(rejectedFiles.length >= 1, `rejected dir must hold ≥1 file, got ${rejectedFiles.length}`);
      // Pattern: YYYY-MM-DD--<pid>--<epoch>--<ms>.md (4 `--` segments).
      // P1-B audit fix 2026-05-16 round 3 regression: filename ends with
      // an 8-hex crypto suffix (`--${randomBytes(4).toString("hex")}.md`)
      // so concurrent same-ms writes don't collide.
      assert(
        rejectedFiles.every((f) => /^\d{4}-\d{2}-\d{2}--\d+--\d+--\d+--[0-9a-f]{8}\.md$/.test(f)),
        `rejected filenames must have 5-segment shape <date>--<pid>--<epoch>--<ms>--<hex8>.md (P0-3 + P1-B), got: ${rejectedFiles.join(", ")}`,
      );

      // P1-E audit fix 2026-05-16 regression: route_rejected without
      // stagingProjectId must land in <abrainHome>/.state/sediment/
      // orphan-rejects/ rather than silently dropping the input.
      const amR2Orphan = await writeAbrainAboutMe(
        { title: "chosen not in candidates orphan", body: "x".repeat(50), region: "identity", routingConfidence: 0.9, routeCandidates: ["skills"], routingReason: "synthetic-orphan" /* no stagingProjectId */ },
        { abrainHome: amHome, settings: amSettings },
      );
      assert(amR2Orphan.status === "rejected" && amR2Orphan.reason === "route_rejected", `orphan route_reject expected: ${JSON.stringify(amR2Orphan)}`);
      const orphanDir = path.join(amHome, ".state", "sediment", "orphan-rejects");
      assert(fs.existsSync(orphanDir), `orphan-rejects dir must be created when stagingProjectId absent (P1-E): ${orphanDir}`);
      const orphanFiles = fs.readdirSync(orphanDir).filter((f) => f.endsWith(".md"));
      assert(orphanFiles.length >= 1, `orphan-rejects must hold ≥1 sample, got ${orphanFiles.length}`);

      // P1-C audit fix 2026-05-16 regression: out-of-range / non-finite
      // routingConfidence must fail-fast as validation_error — symmetric
      // with the region enum gate, so the router doesn't burn a sample.
      const amBadConf1 = await writeAbrainAboutMe(
        { title: "conf out of range", body: "x".repeat(50), region: "identity", routingConfidence: 1.5, routeCandidates: ["identity"], routingReason: "r" },
        { abrainHome: amHome, settings: amSettings },
      );
      assert(amBadConf1.status === "rejected" && amBadConf1.reason === "validation_error", `conf=1.5 must validation_error (P1-C): ${JSON.stringify(amBadConf1)}`);
      assert(amBadConf1.validationErrors.some((e) => e.field === "routingConfidence"), `validationErrors must flag routingConfidence field`);
      const amBadConf2 = await writeAbrainAboutMe(
        { title: "conf nan", body: "x".repeat(50), region: "identity", routingConfidence: NaN, routeCandidates: ["identity"], routingReason: "r" },
        { abrainHome: amHome, settings: amSettings },
      );
      assert(amBadConf2.status === "rejected" && amBadConf2.reason === "validation_error", `conf=NaN must validation_error (P1-C): ${JSON.stringify(amBadConf2)}`);

      // P2-D audit fix 2026-05-16: ADR 0021 invariant #4 — Lane G never
      // writes vault. Region="vault" is now blocked by region enum, but
      // a direct positive smoke pins the contract so future loosening
      // of the enum can't silently re-enable it.
      const amVaultReject = await writeAbrainAboutMe(
        { title: "sneak vault into about-me", body: "x".repeat(50), region: "vault", routingConfidence: 0.9, routeCandidates: ["vault"], routingReason: "attempt-vault-leak" },
        { abrainHome: amHome, settings: amSettings },
      );
      assert(amVaultReject.status === "rejected" && amVaultReject.reason === "validation_error" && amVaultReject.validationErrors.some((e) => e.field === "region"), `region=vault must reject (ADR 0021 inv #4): ${JSON.stringify(amVaultReject)}`);

      // P0-A audit fix 2026-05-16 regression: staging happy path must
      // include Date.now() in the filename. Two staging writes with the
      // SAME pid + sessionEpoch + date land in DIFFERENT files (not
      // silent overwrite). Previously the filename was
      // `<date>--<pid>--<epoch>.md` and the second write would rename
      // over the first via atomicWrite.
      const stagingDir = path.join(amHome, "projects", "smoke-project", "observations", "staging");
      const stagingBefore = fs.existsSync(stagingDir) ? fs.readdirSync(stagingDir).filter((f) => f.endsWith(".md")).length : 0;
      const amStg1 = await writeAbrainAboutMe(
        { title: "first low-conf sample", body: "x".repeat(50), region: "identity", routingConfidence: 0.3, routeCandidates: ["identity", "habits"], routingReason: "first-ambiguous", stagingProjectId: "smoke-project", stagingSessionEpoch: 1700000000099 },
        { abrainHome: amHome, settings: amSettings },
      );
      const amStg2 = await writeAbrainAboutMe(
        { title: "second low-conf sample", body: "y".repeat(50), region: "identity", routingConfidence: 0.3, routeCandidates: ["identity", "habits"], routingReason: "second-ambiguous", stagingProjectId: "smoke-project", stagingSessionEpoch: 1700000000099 /* same epoch! */ },
        { abrainHome: amHome, settings: amSettings },
      );
      assert(amStg1.status === "created" && amStg2.status === "created", `both staging writes must succeed: ${JSON.stringify({a:amStg1, b:amStg2})}`);
      assert(amStg1.path !== amStg2.path, `P0-A: same-epoch staging writes MUST have distinct paths, got identical: ${amStg1.path}`);
      const stagingAfter = fs.readdirSync(stagingDir).filter((f) => f.endsWith(".md")).length;
      assert(stagingAfter - stagingBefore >= 2, `staging dir must hold both writes (no silent overwrite): before=${stagingBefore} after=${stagingAfter}`);
      // Both must match 5-segment filename shape (P1-B regression: hex suffix).
      const stgFiles = fs.readdirSync(stagingDir).filter((f) => f.endsWith(".md"));
      assert(
        stgFiles.every((f) => /^\d{4}-\d{2}-\d{2}--\d+--\d+--\d+--[0-9a-f]{8}\.md$/.test(f)),
        `staging filenames must be 5-segment <date>--<pid>--<epoch>--<ms>--<hex8>.md (P0-A + P1-B): ${stgFiles.join(", ")}`,
      );

      // P0-1 audit fix 2026-05-16 round 3 regression: router downgrade
      // to staging when caller did NOT supply stagingProjectId must be
      // returned as a validation_error (NOT an unhandled throw). G2
      // wire-up triggers this on every low-confidence fence because the
      // extractor doesn't supply stagingProjectId.
      let amDowngradeCrash = null;
      let amDowngradeRes = null;
      try {
        amDowngradeRes = await writeAbrainAboutMe(
          {
            title: "low conf without project anchor",
            body: "x".repeat(50),
            region: "identity",
            routingConfidence: 0.3,  // < threshold → router downgrades to staging
            routeCandidates: ["identity"],
            routingReason: "ambiguous-no-project",
            /* no stagingProjectId, no stagingSessionEpoch — G2 fence path */
          },
          { abrainHome: amHome, settings: amSettings },
        );
      } catch (e) {
        amDowngradeCrash = e;
      }
      assert(amDowngradeCrash === null, `P0-1: router-downgrade path with missing stagingProjectId MUST return result, not throw: ${amDowngradeCrash && amDowngradeCrash.message}`);
      assert(amDowngradeRes && amDowngradeRes.status === "rejected" && amDowngradeRes.reason === "validation_error", `P0-1: downgrade-missing-project must be validation_error: ${JSON.stringify(amDowngradeRes)}`);
      assert(amDowngradeRes.validationErrors && amDowngradeRes.validationErrors.some((e) => e.field === "stagingProjectId"), `P0-1: validationErrors must flag stagingProjectId field`);

      // ---- writer: low confidence → auto-downgrade to staging ----
      const amLC = await writeAbrainAboutMe(
        {
          title: "I might prefer functional style sometimes",
          body: "This is a wobbly signal: I write FP-ish code on Tuesdays and OOP on Fridays. Could be situational, could be identity, sediment isn't sure.",
          region: "identity",
          routingConfidence: 0.4,
          routeCandidates: ["identity", "habits"],
          routingReason: "ambiguous-aboutness",
          stagingProjectId: "smoke-project",
          stagingSessionEpoch: 1700000000000,
          sessionId: "smoke-am-lc",
        },
        { abrainHome: amHome, settings: amSettings },
      );
      assert(amLC.status === "created", `low-conf downgrade to staging should create: ${JSON.stringify(amLC)}`);
      assert(amLC.region === "staging", `region must be staging after downgrade, got ${amLC.region}`);
      assert(/observations\/staging\//.test(amLC.path) || /observations\\staging\\/.test(amLC.path), `staging path must contain observations/staging/: ${amLC.path}`);
      const stagingText = fs.readFileSync(amLC.path, "utf-8");
      // P0-1 audit fix: staging entries are physically under projects/<id>/
      // so they're project-scoped (so review-staging walker / facade can
      // filter them out from facade results per spec §3.5).
      assert(/^scope: project$/m.test(stagingText), `staging frontmatter must have scope: project (P0-1):\n${stagingText}`);
      assert(/^region: staging$/m.test(stagingText), `staging frontmatter region missing`);
      // route_candidates must preserve original choice for downstream review
      assert(/route_candidates:\s*\n\s*-\s*identity/m.test(stagingText), `staging entry must preserve original 'identity' in candidates`);

      // ---- writer: dedupe across zones (identity slug vs skills same slug) ----
      const amD1 = await writeAbrainAboutMe(
        { title: "Cross-zone slug collision sample", body: "x".repeat(50), region: "identity", routingConfidence: 0.9, routeCandidates: ["identity"], routingReason: "r" },
        { abrainHome: amHome, settings: amSettings },
      );
      assert(amD1.status === "created", `first cross-zone write should create`);
      const amD2 = await writeAbrainAboutMe(
        { title: "Cross-zone slug collision sample", body: "x".repeat(50), region: "skills", routingConfidence: 0.9, routeCandidates: ["skills"], routingReason: "r" },
        { abrainHome: amHome, settings: amSettings },
      );
      assert(amD2.status === "rejected" && amD2.reason === "duplicate_slug", `same slug across zones must reject: ${JSON.stringify(amD2)}`);

      // ---- writer: sanitize secret in body → redacted + created ----
      const fakeKey = "AKIA" + "IOSFODNN7EXAMPLE";
      const amSec = await writeAbrainAboutMe(
        {
          title: "I keep my AWS creds in env vars",
          body: `As a rule I never commit raw access keys; example pattern to avoid: ${fakeKey} in source code.`,
          region: "habits",
          routingConfidence: 0.9,
          routeCandidates: ["habits"],
          routingReason: "explicit-security-habit",
        },
        { abrainHome: amHome, settings: amSettings },
      );
      assert(amSec.status === "created", `sanitize should redact + create: ${JSON.stringify(amSec)}`);
      const amSecText = fs.readFileSync(amSec.path, "utf-8");
      assert(amSecText.includes("[SECRET:aws_access_key]") && !amSecText.includes(fakeKey), `body secret must be redacted`);

      // ---- P0-2 audit fix 2026-05-15: writer rejects region=undefined ----
      // ExtractedAboutMeDraft.region is `?: AboutMeRegion` (optional),
      // so the G2 fence-extractor wire-up could feed region=undefined.
      // validateAboutMeDraft must catch this with a clear validation_error
      // instead of letting kindByRegion[undefined] silently produce a
      // frontmatter `kind: undefined` literal.
      const amBadRegion = await writeAbrainAboutMe(
        { title: "missing region", body: "x".repeat(50), /* region: */ routingConfidence: 0.9, routeCandidates: ["identity"], routingReason: "r" },
        { abrainHome: amHome, settings: amSettings },
      );
      assert(amBadRegion.status === "rejected" && amBadRegion.reason === "validation_error", `missing region must reject as validation_error, got: ${JSON.stringify(amBadRegion)}`);
      assert(amBadRegion.validationErrors.some((e) => e.field === "region"), `validationErrors must include region field`);
      // Also reject a region=string-but-not-in-enum (e.g. lowercase typo
      // that bypassed the extractor by being injected programmatically).
      const amBadRegion2 = await writeAbrainAboutMe(
        { title: "bad region literal", body: "x".repeat(50), region: "projects", routingConfidence: 0.9, routeCandidates: ["projects"], routingReason: "r" },
        { abrainHome: amHome, settings: amSettings },
      );
      assert(amBadRegion2.status === "rejected" && amBadRegion2.reason === "validation_error", `bogus region must reject as validation_error before router, got: ${JSON.stringify(amBadRegion2)}`);

      // ---- writer: dry-run does not write ----
      const amDR = await writeAbrainAboutMe(
        { title: "dry run sample", body: "x".repeat(50), region: "identity", routingConfidence: 0.9, routeCandidates: ["identity"], routingReason: "r" },
        { abrainHome: amHome, settings: amSettings, dryRun: true },
      );
      assert(amDR.status === "dry_run", `dry-run status mismatch: ${JSON.stringify(amDR)}`);
      assert(!fs.existsSync(amDR.path), `dry-run must not write file: ${amDR.path}`);

      // ---- audit: lane=about_me, git commits with 'about-me:' prefix ----
      const amAuditPath = path.join(amHome, ".state", "sediment", "audit.jsonl");
      assert(fs.existsSync(amAuditPath), `about-me audit jsonl missing`);
      const amAuditRows = fs.readFileSync(amAuditPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      assert(amAuditRows.every((r) => r.lane === "about_me"), `every Lane G audit row must be lane=about_me, got: ${[...new Set(amAuditRows.map((r) => r.lane))].join(",")}`);
      const ops = new Set(amAuditRows.map((r) => r.operation));
      assert(ops.has("create") && ops.has("reject") && ops.has("route_rejected") && ops.has("dry_run"), `audit must cover create/reject/route_rejected/dry_run, got: ${[...ops].join(",")}`);
      const amGitLog = execFileSync("git", ["-C", amHome, "log", "--pretty=%s"], { encoding: "utf-8" });
      const aboutMeCommits = amGitLog.split("\n").filter((s) => s.startsWith("about-me: ")).length;
      assert(aboutMeCommits >= 3, `expected ≥3 about-me commits, got ${aboutMeCommits}:\n${amGitLog}`);

      // ---- fence extractor: parse MEMORY-ABOUT-ME blocks ----
      const transcript = [
        "Some pre-amble text.",
        "",
        "MEMORY-ABOUT-ME:",
        "title: I prefer explicit over implicit",
        "region: identity",
        "confidence: 0.9",
        "trigger_phrases: explicit, implicit",
        "tags: design, taste",
        "---",
        "# I prefer explicit over implicit",
        "",
        "In every code review I default to flagging implicit coercion / implicit type widening / implicit error swallowing.",
        "END_MEMORY",
        "",
        "More transcript.",
        "",
        "```",
        "MEMORY-ABOUT-ME:",
        "title: this is inside a fenced block",
        "region: identity",
        "---",
        "this should NOT be extracted as a fence is open",
        "END_MEMORY",
        "```",
        "",
        "MEMORY-ABOUT-ME:",
        "title: bad region typo",
        "region: identitiy", // typo, should be skipped
        "---",
        "should be dropped by region whitelist guard",
        "END_MEMORY",
      ].join("\n");
      const fences = parseExplicitAboutMeBlocks(transcript);
      assert(fences.length === 1, `should extract exactly 1 valid fence (other 2 dropped): got ${fences.length}\n${JSON.stringify(fences, null, 2)}`);
      assert(fences[0].title === "I prefer explicit over implicit", `title mismatch: ${fences[0].title}`);
      assert(fences[0].region === "identity", `region mismatch: ${fences[0].region}`);
      assert(fences[0].routingConfidence === 0.9, `confidence mismatch: ${fences[0].routingConfidence}`);
      assert(Array.isArray(fences[0].triggerPhrases) && fences[0].triggerPhrases.includes("explicit"), `triggerPhrases parse failed`);
      assert(Array.isArray(fences[0].tags) && fences[0].tags.includes("design"), `tags parse failed`);
      const fencePreview = previewAboutMeExtraction(fences);
      assert(fencePreview.count === 1 && fencePreview.drafts[0].headerFields.includes("region"), `preview shape mismatch`);

      // ---- fence extractor: empty input + only-fenced-code input → 0 fences ----
      assert(parseExplicitAboutMeBlocks("").length === 0, `empty input should yield 0 fences`);
      assert(parseExplicitAboutMeBlocks("```\nMEMORY-ABOUT-ME:\ntitle: x\nregion: identity\n---\nbody\nEND_MEMORY\n```\n").length === 0, `only-fenced-code should yield 0 fences`);

      // ---- P2-11 audit fix 2026-05-15: parseEntry round-trip ----
      // The Lane G writer produces frontmatter that the memory/parser.ts
      // read-side must understand. Previously this gap let P0-1 (scope:
      // about_me silently dropped) slip past G1 fixture. Round-trip the
      // identity / skills / habits entries we just wrote and assert the
      // parsed view exposes:
      //   - canonical scope ("world" for identity/skills/habits)
      //   - canonical kind (maxim/fact/pattern — from kindByRegion)
      //   - region preserved in entry.frontmatter (Lane G sub-class)
      //   - routing_confidence reads back as a float (string-typed in
      //     frontmatter dict because parseFrontmatter doesn't coerce,
      //     but should round-trip the 2dp shape).
      const { parseEntry } = req("./memory/parser.js");
      const worldStore = { scope: "world", root: amHome, label: "world" };
      const projectStore = { scope: "project", root: path.join(amHome, "projects", "smoke-project"), label: "abrain-project" };

      const am1Parsed = await parseEntry(am1.path, worldStore, amHome);
      assert(am1Parsed, `parseEntry must yield identity entry: ${am1.path}`);
      assert(am1Parsed.scope === "world", `identity entry must read back as scope:world, got ${am1Parsed.scope}`);
      assert(am1Parsed.kind === "maxim", `identity entry must read back as kind=maxim, got ${am1Parsed.kind}`);
      assert(am1Parsed.slug === "i-prefer-fail-closed-designs", `identity slug mismatch: ${am1Parsed.slug}`);
      assert(am1Parsed.frontmatter && am1Parsed.frontmatter.region === "identity", `parseEntry must surface region=identity in frontmatter dict, got: ${JSON.stringify(am1Parsed.frontmatter && am1Parsed.frontmatter.region)}`);
      assert(am1Parsed.frontmatter && am1Parsed.frontmatter.lane === "about_me", `parseEntry must surface lane=about_me, got: ${JSON.stringify(am1Parsed.frontmatter && am1Parsed.frontmatter.lane)}`);
      assert(!am1Parsed.legacyKind, `identity entry must NOT have legacyKind (kind=maxim is canonical), got: ${am1Parsed.legacyKind}`);

      const am2Parsed = await parseEntry(am2.path, worldStore, amHome);
      assert(am2Parsed && am2Parsed.scope === "world" && am2Parsed.kind === "fact", `skills entry round-trip mismatch: ${JSON.stringify(am2Parsed)}`);
      assert(am2Parsed.frontmatter.region === "skills", `skills entry frontmatter.region mismatch`);

      const am3Parsed = await parseEntry(am3.path, worldStore, amHome);
      assert(am3Parsed && am3Parsed.scope === "world" && am3Parsed.kind === "pattern", `habits entry round-trip mismatch: ${JSON.stringify(am3Parsed)}`);
      assert(am3Parsed.frontmatter.region === "habits", `habits entry frontmatter.region mismatch`);

      // Staging entry: project-scoped (lives under projects/<id>/observations/staging/)
      const amLCParsed = await parseEntry(amLC.path, projectStore, amHome);
      assert(amLCParsed, `staging entry must parse: ${amLC.path}`);
      assert(amLCParsed.scope === "project", `staging entry must read back as scope:project, got ${amLCParsed.scope}`);
      assert(amLCParsed.frontmatter.region === "staging", `staging entry must have region: staging in frontmatter`);

      // ---- P2-B + P2-C audit fix 2026-05-16: full-pipeline scanStore ----
      // Pin ADR 0021 invariants #6 (Lane G entries discoverable in
      // world walker) + #7 (staging excluded from facade). Without
      // these, a future regression of WORLD_EXTRA_IGNORE_DIRS or
      // STAGING_IGNORE_REL_PATHS would slip past the per-component
      // smoke layers.
      const { scanStore } = req("./memory/parser.js");
      const memSettings = { includeWorld: true, defaultLimit: 20, maxLimit: 50, maxEntries: 2000, projectBoost: 1.5, shortTermTtlDays: 30, search: { stagePool: 8, stage1Limit: 4, stage2Limit: 4, model: undefined } };

      // P2-C: world walker must surface identity/skills/habits entries.
      const worldEntries = await scanStore({ scope: "world", root: amHome, label: "world" }, amHome, memSettings);
      const worldSlugs = new Set(worldEntries.map((e) => e.slug));
      assert(worldSlugs.has("i-prefer-fail-closed-designs"), `world scan MUST surface identity entry slug (ADR 0021 inv #6): got ${[...worldSlugs].join(", ")}`);
      assert(worldSlugs.has("i-am-proficient-in-typescript"), `world scan MUST surface skills entry slug`);
      assert(worldSlugs.has("i-run-smoke-before-commit"), `world scan MUST surface habits entry slug`);
      // P2-B: world scan MUST NOT include staging entries (they live
      // under projects/<id>/ which is in WORLD_EXTRA_IGNORE_DIRS).
      assert(
        !worldEntries.some((e) => e.frontmatter && e.frontmatter.region === "staging"),
        `world scan MUST NOT include staging entries: ${worldEntries.filter((e) => e.frontmatter && e.frontmatter.region === "staging").map((e) => e.slug).join(", ")}`,
      );

      // P2-B: project walker MUST exclude observations/staging/ entries.
      // (Project store root = ~/.abrain/projects/<id>/; staging entries
      // are at observations/staging/. Without STAGING_IGNORE_REL_PATHS
      // they'd land in memory_search rerank candidates.)
      const projectEntries = await scanStore({ scope: "project", root: path.join(amHome, "projects", "smoke-project"), label: "abrain-project" }, amHome, memSettings);
      // P2-C audit fix 2026-05-16 round 3: dual-layer detection. Original
      // check used `entry.frontmatter.region === "staging"` which would
      // false-negative if parseEntry returned null (degraded frontmatter
      // → silent pass). Path-based check catches walker leaks even when
      // parsing failed downstream.
      const stagingByFrontmatter = projectEntries.filter((e) => e.frontmatter && e.frontmatter.region === "staging");
      assert(
        stagingByFrontmatter.length === 0,
        `project scan MUST exclude staging entries by frontmatter (ADR 0021 inv #7): found ${stagingByFrontmatter.length}: ${stagingByFrontmatter.map((e) => e.slug).join(", ")}`,
      );
      const stagingByPath = projectEntries.filter((e) => /[/\\]observations[/\\]staging[/\\]/.test(e.sourcePath || ""));
      assert(
        stagingByPath.length === 0,
        `project scan MUST exclude staging entries by sourcePath (P2-C dual-layer): found ${stagingByPath.length}: ${stagingByPath.map((e) => e.sourcePath).join(", ")}`,
      );
      // Sanity: at least amStg1/amStg2 staging files are on disk in this
      // store root, so a 0-result scan really proves the exclusion (not
      // "there are no files to find").
      const projectStagingDirNow = path.join(amHome, "projects", "smoke-project", "observations", "staging");
      const onDiskStagingMd = fs.readdirSync(projectStagingDirNow).filter((f) => f.endsWith(".md")).length;
      assert(onDiskStagingMd >= 2, `precondition: at least 2 staging .md must exist on disk to make exclusion test meaningful (got ${onDiskStagingMd})`);

      // P1-A audit fix 2026-05-16 round 3 regression: listFilesWithRg is
      // a GENERIC markdown enumerator (lint.ts / migrate.ts also use it).
      // staging exclusion must be opt-in via opts.excludeStaging — NOT
      // hardcoded. Verify by calling listFilesWithRg WITHOUT excludeStaging
      // on the project root; staging files MUST appear in the result
      // (because lint / migrate / future review-staging need them).
      const { listFilesWithRg } = req("./memory/parser.js");
      const projectRoot = path.join(amHome, "projects", "smoke-project");
      const filesAll = await listFilesWithRg(projectRoot);
      // listFilesWithRg may return null if rg is unavailable; smoke env
      // has rg so we expect a list. If rg missing, skip this assertion
      // (walker fallback path is separately tested above).
      if (Array.isArray(filesAll)) {
        const stagingInAll = filesAll.filter((f) => /observations\/staging\//.test(f.replace(/\\/g, "/")));
        assert(stagingInAll.length >= 1, `P1-A: listFilesWithRg without excludeStaging MUST include staging files (generic enumerator not polluted), got 0 staging files out of ${filesAll.length}`);
        const filesExcl = await listFilesWithRg(projectRoot, undefined, { excludeStaging: true });
        if (Array.isArray(filesExcl)) {
          const stagingInExcl = filesExcl.filter((f) => /observations\/staging\//.test(f.replace(/\\/g, "/")));
          assert(stagingInExcl.length === 0, `P1-A: listFilesWithRg with excludeStaging MUST drop staging files, got ${stagingInExcl.length}`);
        }
      }

      // P1-C audit fix 2026-05-16 round 3 regression: ensureAbrainState­
      // Gitignored must write `.state/` to abrainHome/.gitignore when
      // missing, and be idempotent on subsequent calls. brain-layout.ts
      // is not in transpileExtensions dirs (abrain extension transpile
      // has separate smoke files), but it has zero external deps EXCEPT
      // for `../_shared/runtime` (P1-2 round 4 audit: helper moved to
      // shared layer for single source of truth). We write the ad-hoc
      // .js at <outRoot>/abrain/brain-layout.js so the relative
      // `../_shared/runtime` import resolves to the already-transpiled
      // _shared/runtime.js (from transpileExtensions).
      const brainLayoutTsPath = path.join(repoRoot, "extensions", "abrain", "brain-layout.ts");
      const brainLayoutOutDir = path.join(outRoot, "abrain");
      fs.mkdirSync(brainLayoutOutDir, { recursive: true });
      const brainLayoutOutPath = path.join(brainLayoutOutDir, "brain-layout.js");
      const blSrc = fs.readFileSync(brainLayoutTsPath, "utf-8");
      const blOut = ts.transpileModule(blSrc, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          esModuleInterop: true,
          skipLibCheck: true,
        },
      }).outputText;
      fs.writeFileSync(brainLayoutOutPath, blOut, "utf-8");
      const { ensureAbrainStateGitignored } = require(brainLayoutOutPath);
      // Fresh abrain home (writable .gitignore guaranteed not to contain .state/).
      const giHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-gi-"));
      const r1 = ensureAbrainStateGitignored(giHome);
      assert(r1.updated === true, `P1-C: first call must update .gitignore: ${JSON.stringify(r1)}`);
      const giContent1 = fs.readFileSync(path.join(giHome, ".gitignore"), "utf-8");
      assert(/(^|\n)\.state\/?(\n|$)/.test(giContent1), `P1-C: .gitignore must contain .state/ line:\n${giContent1}`);
      const r2 = ensureAbrainStateGitignored(giHome);
      assert(r2.updated === false, `P1-C: second call must be no-op (idempotent): ${JSON.stringify(r2)}`);
      const giContent2 = fs.readFileSync(path.join(giHome, ".gitignore"), "utf-8");
      assert(giContent1 === giContent2, `P1-C: idempotent call must not change file content`);
      // Pre-existing non-empty .gitignore must be appended, not overwritten.
      const giHome2 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-gi-"));
      fs.writeFileSync(path.join(giHome2, ".gitignore"), "node_modules/\n", "utf-8");
      ensureAbrainStateGitignored(giHome2);
      const giContent3 = fs.readFileSync(path.join(giHome2, ".gitignore"), "utf-8");
      assert(giContent3.includes("node_modules/") && /(^|\n)\.state\/?(\n|$)/.test(giContent3), `P1-C: must preserve existing content + append .state/:\n${giContent3}`);

      // P1-1 audit fix 2026-05-16 (round 4 deepseek-v4-pro): about-me
      // git rollback path has identical code to writeAbrainWorkflow's
      // orphan-cleanup (writer.ts:~2411-2433) but NO smoke fixture forced
      // gitCommit to fail. Without this regression test, a future bug in
      // the rollback path (wrong path.relative arg, mis-typed fs.unlink
      // target, etc.) would silently slip through. Mirrors the workflow
      // orphan-cleanup smoke at ~L4790 of this file.
      //
      // Strategy: write to a tmpdir that is NOT git-inited; gitCommit:
      // true forces gitCommitAbrainAboutMe's `git -C <abrainHome> add`
      // to fail → git === null → rollback branch fires.
      const amFailRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-am-orphan-"));
      // do NOT git init: gitCommitAbrainAboutMe's `git add` will fail
      // because amFailRoot is not a git repo.
      const amFailSettings = { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: true };
      const amOrphan = await writeAbrainAboutMe(
        {
          title: "Orphan Cleanup Probe AboutMe",
          body: "this body is long enough for about-me validation gate (≥20 chars)",
          region: "identity",
          routingConfidence: 0.9,
          routeCandidates: ["identity"],
          routingReason: "orphan-test",
          sessionId: "smoke-am-orphan",
        },
        { abrainHome: amFailRoot, settings: amFailSettings },
      );
      assert(
        amOrphan.status === "rejected" && amOrphan.reason === "git_commit_failed",
        `P1-1: gitCommit-null path must reject + cleanup, got: ${JSON.stringify(amOrphan)}`,
      );
      // File must be unlinked (no orphan on disk).
      const amOrphanTarget = path.join(amFailRoot, "identity", "orphan-cleanup-probe-aboutme.md");
      assert(
        !fs.existsSync(amOrphanTarget),
        `P1-1: orphan file must be cleaned, but still exists: ${amOrphanTarget}`,
      );
      // Audit row must record the orphan cleanup with about_me lane.
      const amOrphanAuditPath = path.join(amFailRoot, ".state", "sediment", "audit.jsonl");
      assert(fs.existsSync(amOrphanAuditPath), `P1-1: audit jsonl must exist after orphan cleanup`);
      const amOrphanRows = fs.readFileSync(amOrphanAuditPath, "utf-8").trim().split("\n").filter(Boolean).map(JSON.parse);
      const amOrphanRow = amOrphanRows.find((r) => r.reason === "git_commit_failed_orphan_cleaned");
      assert(
        amOrphanRow,
        `P1-1: audit must contain git_commit_failed_orphan_cleaned row, got: ${amOrphanRows.map((r) => r.operation + "/" + (r.reason || "")).join(",")}`,
      );
      assert(amOrphanRow.lane === "about_me", `P1-1: rollback audit row must carry lane=about_me, got: ${amOrphanRow.lane}`);
      fs.rmSync(amFailRoot, { recursive: true, force: true });
    }

    // === Lane G G2 (ADR 0021 G2, 2026-05-20) =============================
    // /about-me slash command helpers: arg parsing + title derivation +
    // fence builder + extractor round-trip + agent_end Lane G defaults.
    {
      // ---- parseAboutMeArgs: flag parsing edge cases ------------------
      assert(typeof parseAboutMeArgs === "function", `parseAboutMeArgs must be exported from sediment/index`);
      assert(typeof deriveAboutMeTitle === "function", `deriveAboutMeTitle must be exported from sediment/index`);
      assert(typeof buildAboutMeFence === "function", `buildAboutMeFence must be exported from sediment/index`);

      // empty input
      const pa0 = parseAboutMeArgs("");
      assert(pa0.body === "" && pa0.region === undefined && pa0.title === undefined, `empty args: ${JSON.stringify(pa0)}`);

      // plain body, no flags
      const pa1 = parseAboutMeArgs("I prefer fail-closed designs");
      assert(pa1.body === "I prefer fail-closed designs" && pa1.region === undefined, `plain body: ${JSON.stringify(pa1)}`);

      // --region= flag at start
      const pa2 = parseAboutMeArgs("--region=skills I am proficient in TypeScript");
      assert(pa2.region === "skills" && pa2.body === "I am proficient in TypeScript", `region flag start: ${JSON.stringify(pa2)}`);

      // --region= flag in middle (still word-boundary)
      const pa3 = parseAboutMeArgs("I am proficient --region=skills in TypeScript");
      assert(pa3.region === "skills" && pa3.body === "I am proficient in TypeScript", `region flag mid: ${JSON.stringify(pa3)}`);

      // --title="quoted phrase"
      const pa4 = parseAboutMeArgs('--title="My Custom Title" --region=identity body text here');
      assert(pa4.title === "My Custom Title" && pa4.region === "identity" && pa4.body === "body text here", `quoted title: ${JSON.stringify(pa4)}`);

      // --title='single quotes' too
      const pa5 = parseAboutMeArgs("--title='single q' --region=habits a habit body");
      assert(pa5.title === "single q" && pa5.region === "habits" && pa5.body === "a habit body", `single-quoted title: ${JSON.stringify(pa5)}`);

      // --title bare word (no quotes)
      const pa6 = parseAboutMeArgs("--title=BareTitle some body");
      assert(pa6.title === "BareTitle" && pa6.body === "some body", `bare title: ${JSON.stringify(pa6)}`);

      // Flag-like substring INSIDE a word (no preceding space): MUST NOT be
      // treated as a flag. Documents the (?:^|\s) word-boundary contract.
      const pa7 = parseAboutMeArgs("prefix--region=identity body");
      assert(pa7.region === undefined && pa7.body === "prefix--region=identity body", `flag must require preceding space: ${JSON.stringify(pa7)}`);

      // Both flags + interleaved body
      const pa8 = parseAboutMeArgs("first --region=identity middle --title=T1 last");
      assert(pa8.region === "identity" && pa8.title === "T1" && pa8.body === "first middle last", `interleaved: ${JSON.stringify(pa8)}`);

      // ---- deriveAboutMeTitle: derive from body --------------------------
      assert(deriveAboutMeTitle("Hello world") === "Hello world", `derive plain`);
      assert(deriveAboutMeTitle("# Markdown heading\n\nbody") === "Markdown heading", `derive strips leading #`);
      assert(deriveAboutMeTitle("   leading spaces here\nmore") === "leading spaces here", `derive strips leading spaces`);
      const longLine = "a".repeat(120);
      const longDerived = deriveAboutMeTitle(longLine);
      assert(longDerived.length === 80, `derive truncates to 80, got ${longDerived.length}`);
      assert(deriveAboutMeTitle("") === "about-me", `empty body falls back to 'about-me'`);
      assert(deriveAboutMeTitle("   \n\n   ") === "about-me", `whitespace-only body falls back`);

      // ---- buildAboutMeFence: round-trip through parseExplicitAboutMeBlocks
      // ADR 0021 G2 invariant: the slash handler's fence output must be
      // bit-for-bit recognizable by the same parser the agent_end pipeline
      // runs. A fence-build / fence-parse mismatch would mean every
      // /about-me invocation gets silently dropped by sediment.
      const rt1 = buildAboutMeFence({
        title: "I prefer fail-closed designs",
        region: "identity",
        body: "I consistently choose designs that refuse to operate on missing inputs rather than silently degrading.",
      });
      const rt1Blocks = parseExplicitAboutMeBlocks(rt1);
      assert(rt1Blocks.length === 1, `round-trip: expected 1 fence, got ${rt1Blocks.length}\n${rt1}`);
      assert(rt1Blocks[0].title === "I prefer fail-closed designs", `round-trip title: ${rt1Blocks[0].title}`);
      assert(rt1Blocks[0].region === "identity", `round-trip region: ${rt1Blocks[0].region}`);
      assert(rt1Blocks[0].body.startsWith("I consistently choose"), `round-trip body: ${rt1Blocks[0].body}`);

      // Round-trip preserves region for all 3 valid Lane G regions
      for (const region of ["identity", "skills", "habits"]) {
        const fence = buildAboutMeFence({
          title: `Test title for ${region}`,
          region,
          body: `This is the about-me body for the ${region} region, padded to twenty plus chars.`,
        });
        const blocks = parseExplicitAboutMeBlocks(fence);
        assert(blocks.length === 1 && blocks[0].region === region, `region=${region} round-trip: ${JSON.stringify(blocks)}`);
      }

      // Fence inside a fenced code block must be IGNORED (Lane G inv #5
      // = Lane A's trust boundary). Pasting an /about-me example into a
      // markdown code block must not silently write an entry.
      const inFence = ["```", buildAboutMeFence({ title: "trapped", region: "identity", body: "this should not extract because it sits inside fenced code" }), "```"].join("\n");
      assert(parseExplicitAboutMeBlocks(inFence).length === 0, `fence-in-code must NOT extract`);

      // ---- agent_end Lane G defaults: simulate the wire-up via writer ----
      // index.ts L1240+ (agent_end Lane G block) builds an AboutMeDraft
      // from an ExtractedAboutMeDraft with these defaults:
      //   routingConfidence: fence.routingConfidence ?? 1.0
      //   routeCandidates: [region]
      //   routingReason: fallback string
      //   stagingProjectId: <active project id>
      //   stagingSessionEpoch: Date.now() (per agent_end batch)
      // Verify that a fence WITHOUT explicit confidence/reason results
      // in a written entry with confidence=1.00 and the expected fallback
      // reason. This is the contract sediment guarantees to the slash.
      const g2Home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-g2-"));
      execFileSync("git", ["-C", g2Home, "init", "-q"]);
      execFileSync("git", ["-C", g2Home, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", g2Home, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", g2Home, "config", "commit.gpgsign", "false"]);
      fs.mkdirSync(path.join(g2Home, "projects", "g2-project"), { recursive: true });
      const g2Settings = { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: true };

      // Simulate what agent_end Lane G does: extract → build AboutMeDraft
      // with the same defaults → write.
      const slashFence = buildAboutMeFence({
        title: "G2 slash round-trip",
        region: "identity",
        body: "This entry was authored through the /about-me slash command path, verified end-to-end in smoke.",
      });
      const extracted = parseExplicitAboutMeBlocks(slashFence);
      assert(extracted.length === 1, `G2 wire-up: extractor must yield 1 fence`);
      const e = extracted[0];
      const wireupSessionEpoch = Date.now();
      const written = await writeAbrainAboutMe(
        {
          title: e.title,
          body: e.body,
          region: e.region,
          // EXACT defaults the agent_end Lane G block applies (sediment/index.ts).
          // routingReason is FIXED to the canonical G1 string — it is a routing
          // rationale, NOT a timeline narrative. timelineNote comes from the
          // fence (or extractor default).
          routingConfidence: e.routingConfidence ?? 1.0,
          routeCandidates: [e.region],
          routingReason: "user-attested via MEMORY-ABOUT-ME fence (G1)",
          triggerPhrases: e.triggerPhrases,
          tags: e.tags,
          status: e.status,
          timelineNote: e.timelineNote,
          sessionId: "smoke-g2-wireup",
          stagingProjectId: "g2-project",
          stagingSessionEpoch: wireupSessionEpoch,
        },
        { abrainHome: g2Home, settings: g2Settings, auditContext: { lane: "about_me", sessionId: "smoke-g2-wireup", correlationId: "about_me-test-1", candidateId: "about_me-test-1:c1" } },
      );
      assert(written.status === "created" && written.region === "identity", `G2 wire-up write failed: ${JSON.stringify(written)}`);
      const wireupText = fs.readFileSync(written.path, "utf-8");
      assert(/^routing_confidence: 1\.00$/m.test(wireupText), `G2 default confidence must be 1.00 (user-attested fence):\n${wireupText}`);
      // routingReason is FIXED for G1 fence path (canonical attestation
      // rationale, not the timeline narrative). G3 LLM classifier will
      // populate a real rationale later.
      // Note: yamlString wraps any string with non-[A-Za-z0-9_.:/@+-] chars
      // (the canonical G1 reason has spaces + parens, so it lands quoted).
      assert(/^routing_reason: "user-attested via MEMORY-ABOUT-ME fence \(G1\)"$/m.test(wireupText), `G2 default reason must be canonical G1 string:\n${wireupText}`);
      // timelineNote IS the extractor default ("explicit MEMORY-ABOUT-ME block")
      // and shows up in the Timeline section, NOT in routing_reason.
      assert(/## Timeline\s*\n- .* \| smoke-g2-wireup \| created \| explicit MEMORY-ABOUT-ME block/m.test(wireupText), `G2 timeline note must come from extractor default:\n${wireupText}`);
      assert(/route_candidates:\s*\n\s*-\s*identity/m.test(wireupText), `G2 default candidates = [region]`);
      assert(/^lane: about_me$/m.test(wireupText), `G2 lane must be about_me`);
      assert(/^region: identity$/m.test(wireupText), `G2 region must be identity`);

      // ---- agent_end Lane G defaults: low-confidence fence triggers staging
      // A fence carrying `confidence: 0.4` should auto-downgrade to staging.
      // The wire-up MUST supply stagingProjectId + stagingSessionEpoch so
      // the writer doesn't throw (P0-1 audit-fix surface pre-registered).
      const lcFence = [
        "MEMORY-ABOUT-ME:",
        "title: G2 low-conf fence",
        "region: identity",
        "confidence: 0.4",
        "---",
        "This is an ambiguous identity-or-habit signal authored through /about-me; router should downgrade to staging.",
        "END_MEMORY",
      ].join("\n");
      const lcExtracted = parseExplicitAboutMeBlocks(lcFence);
      assert(lcExtracted.length === 1 && lcExtracted[0].routingConfidence === 0.4, `low-conf fence parse: ${JSON.stringify(lcExtracted)}`);
      const lc = lcExtracted[0];
      const lcWritten = await writeAbrainAboutMe(
        {
          title: lc.title,
          body: lc.body,
          region: lc.region,
          routingConfidence: lc.routingConfidence ?? 1.0,
          routeCandidates: [lc.region],
          routingReason: "user-attested via MEMORY-ABOUT-ME fence (G1)",
          timelineNote: lc.timelineNote,
          sessionId: "smoke-g2-lc",
          stagingProjectId: "g2-project",
          stagingSessionEpoch: wireupSessionEpoch,
        },
        { abrainHome: g2Home, settings: g2Settings, auditContext: { lane: "about_me", sessionId: "smoke-g2-lc", correlationId: "about_me-test-2", candidateId: "about_me-test-2:c1" } },
      );
      assert(lcWritten.status === "created" && lcWritten.region === "staging", `low-conf fence must downgrade to staging: ${JSON.stringify(lcWritten)}`);
      assert(/observations\/staging\//.test(lcWritten.path), `low-conf staging path: ${lcWritten.path}`);

      // ---- audit row shape: agent_end Lane G writes a `lane: about_me`
      // audit row with `operation: about_me_extract` etc. We can't drive
      // the real agent_end here, but we CAN verify the writer's audit
      // surface (the audit rows it appends per write) carries lane=about_me
      // — which is what the Lane G audit row aggregates over.
      const g2AuditPath = path.join(g2Home, ".state", "sediment", "audit.jsonl");
      const g2AuditRows = fs.readFileSync(g2AuditPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      assert(g2AuditRows.every((r) => r.lane === "about_me"), `G2 writer audit rows must all carry lane=about_me`);
      assert(g2AuditRows.some((r) => r.operation === "create" && r.region === "identity"), `G2 expected create row for identity`);
      assert(g2AuditRows.some((r) => r.operation === "create" && r.region === "staging"), `G2 expected create row for staging (downgrade)`);

      fs.rmSync(g2Home, { recursive: true, force: true });
    }

    // === per-repo migration --go (B4) ====================================
    // End-to-end: build a fake parent repo with .pensieve mix (modern entry,
    // legacy short-term entry without schema_version, project-specific
    // pipeline, cross-project pipeline, derived index file to skip), build
    // a fake abrain repo, run runMigrationGo, assert routing + normalization
    // + commits + source-side dirty/untracked tolerance. Stays offline.
    {
      const goParent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-go-parent-"));
      execFileSync("git", ["-C", goParent, "init", "-q"]);
      execFileSync("git", ["-C", goParent, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", goParent, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", goParent, "config", "commit.gpgsign", "false"]);

      // modern v1 maxim
      writeFile(
        path.join(goParent, ".pensieve", "maxims", "test-rule.md"),
        makeEntry({ title: "Test Rule", kind: "maxim" }),
      );
      // legacy short-term entry: no schema_version, no kind, weird path
      writeFile(
        path.join(goParent, ".pensieve", "short-term", "maxims", "legacy.md"),
        `---
type: maxim
title: Legacy Rule
status: active
created: 2026-05-08
---
# Legacy Rule

Body.
`,
      );
      // legacy Pensieve bootstrap seed (extract disposition): canonical copy
      // lives in global abrain knowledge; migrate-go prunes it from the
      // project repo and never duplicates it into projects/<id>/.
      writeFile(
        path.join(goParent, ".pensieve", "knowledge", "taste-review", "content.md"),
        `---
id: taste-review-content
type: knowledge
title: 代码品味审查知识库
status: active
created: 2026-02-28
updated: 2026-02-28
---
# 代码品味审查知识库

Original Pensieve seed content.
`,
      );
      // legacy Pensieve bootstrap seed (obsolete disposition): design no
      // longer matches current pi-astack auto-sediment design; migrate-go
      // prunes without a global replacement.
      writeFile(
        path.join(goParent, ".pensieve", "pipelines", "run-when-committing.md"),
        `---
id: run-when-committing
type: pipeline
title: 提交 Pipeline
name: run-when-committing
status: active
created: 2026-02-28
updated: 2026-02-28
---
# 提交 Pipeline

Original Pensieve seed pipeline body.
`,
      );
      // pipeline: project-specific (no cross_project flag)
      writeFile(
        path.join(goParent, ".pensieve", "pipelines", "run-when-coding.md"),
        `---
title: Run when coding
trigger: 用户要求写代码
status: active
created: 2026-05-08
---
# Run when coding

**Trigger**: 用户要求写代码

## Task Blueprint

1. Read the request carefully.
2. Plan, then implement.
`,
      );
      // pipeline: cross-project (cross_project: true)
      writeFile(
        path.join(goParent, ".pensieve", "pipelines", "run-when-reviewing.md"),
        `---
title: Run when reviewing
trigger: review request
cross_project: true
status: active
created: 2026-05-08
---
# Run when reviewing

This is a cross-project review pipeline body with enough content.
`,
      );
      // derived index/state files: markdownFilesForTarget already filters
      // them via IGNORE_DIRS + rg --glob exclusions, so they don't show up
      // as either migrated or skipped. Root-level state.md is a legacy
      // support page that rg does see; dry-run marks it skipped, and --go
      // must preserve that behavior instead of migrating it as knowledge.
      writeFile(path.join(goParent, ".pensieve", ".index", "graph.json"), "{}");
      writeFile(path.join(goParent, ".pensieve", ".state", "checkpoint.md"), "derived state file (not user content)");
      writeFile(path.join(goParent, ".pensieve", "state.md"), "# Pensieve Project State\n\nSupport file, not a user memory entry.\n");

      execFileSync("git", ["-C", goParent, "add", "-A"]);
      execFileSync("git", ["-C", goParent, "commit", "-q", "-m", "init pensieve"]);

      const goAbrain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-go-abrain-"));
      execFileSync("git", ["-C", goAbrain, "init", "-q"]);
      execFileSync("git", ["-C", goAbrain, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", goAbrain, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", goAbrain, "config", "commit.gpgsign", "false"]);
      writeFile(path.join(goAbrain, "README.md"), "# abrain home (smoke)\n");
      execFileSync("git", ["-C", goAbrain, "add", "-A"]);
      execFileSync("git", ["-C", goAbrain, "commit", "-q", "-m", "init abrain"]);
      await bindMigrationProject(goParent, goAbrain, "test-project");

      const goOpts = {
        pensieveTarget: path.join(goParent, ".pensieve"),
        abrainHome: goAbrain,
        projectId: "test-project",
        cwd: goParent,
        settings: DEFAULT_SETTINGS,
        migrationTimestamp: "2026-05-12T10:00:00.000+08:00",
      };

      // 1) Preflight allows dirty parent / dirty .pensieve.
      // Post-B5, .pensieve is a legacy input snapshot; requiring tracked+clean
      // source state blocks exactly the repos migration is meant to retire.
      fs.writeFileSync(path.join(goParent, "dirty-file.txt"), "oops");
      fs.appendFileSync(path.join(goParent, ".pensieve", "maxims", "test-rule.md"), "\nDirty source note.\n");
      const dirty = await preflightMigrationGo(goOpts);
      assert(dirty.ok === true, `dirty parent should not fail preflight anymore: ${dirty.failures.join("; ")}`);
      assert(dirty.parentRepoWasClean === false, `dirty preflight should record parentRepoWasClean=false`);
      fs.unlinkSync(path.join(goParent, "dirty-file.txt"));
      execFileSync("git", ["-C", goParent, "checkout", "--", ".pensieve/maxims/test-rule.md"]);

      // 2) Preflight rejects when abrain dirty
      fs.writeFileSync(path.join(goAbrain, "dirty-file.txt"), "oops");
      const abrainDirty = await runMigrationGo(goOpts);
      assert(abrainDirty.ok === false, `dirty abrain must fail preflight`);
      assert(
        abrainDirty.preconditionFailures.some((f) => /abrain.*not clean/i.test(f)),
        `dirty abrain failure should mention abrain: ${abrainDirty.preconditionFailures.join("; ")}`,
      );
      fs.unlinkSync(path.join(goAbrain, "dirty-file.txt"));

      // P0 fix (2026-05-14): extract-disposition seeds require the canonical
      // global copy to exist in abrain before the seed can be pruned. Create
      // it and commit so the migration proceeds cleanly.
      fs.mkdirSync(path.join(goAbrain, "knowledge"), { recursive: true });
      fs.writeFileSync(
        path.join(goAbrain, "knowledge", "taste-review-content.md"),
        "---\nkind: fact\n---\n# Taste Review Content\n\nContent here.\n",
      );
      execFileSync("git", ["-C", goAbrain, "add", "-A"]);
      execFileSync("git", ["-C", goAbrain, "commit", "-q", "-m", "seed canonical copy"]);

      // 3) Happy path migration
      const result = await runMigrationGo(goOpts);
      assert(result.ok, `migration should succeed, got failures: ${JSON.stringify(result.preconditionFailures)}`);
      assert(result.projectId === "test-project", `projectId mismatch: ${result.projectId}`);
      assert(result.projectIdSource === "strict-binding", `projectIdSource should be strict-binding, got ${result.projectIdSource}`);
      assert(result.movedCount === 2, `expected 2 knowledge entries moved, got ${result.movedCount} (entries=${JSON.stringify(result.entries)})`);
      assert(result.workflowCount === 2, `expected 2 workflows routed, got ${result.workflowCount}`);
      assert(result.failedCount === 0, `expected 0 failures, got ${result.failedCount}`);
      // Derived .index/.state files are pre-filtered by markdownFilesForTarget
      // (parser.ts IGNORE_DIRS + listFilesWithRg --glob), so they're invisible
      // to migrate-go and never show up as migrated OR skipped. Root-level
      // state.md is visible but unsupported, matching dry-run's skipped row.
      // Legacy Pensieve bootstrap seeds are counted as skipped too, but are
      // pruned from the project repo instead of copied into projects/<id>/.
      // The canonical global copy was created above so the extract seed can be pruned.
      // 3 skips = state.md + 1 extract seed (taste-review) + 1 obsolete seed (run-when-committing).
      assert(result.skippedCount === 3, `support state.md + legacy seeds should be skipped, got ${result.skippedCount} skips: ${JSON.stringify(result.entries)}`);
      assert(result.seedPrunedCount === 2, `expected 2 legacy seeds pruned (1 extract + 1 obsolete), got ${result.seedPrunedCount}: ${JSON.stringify(result.entries)}`);
      assert(
        !result.entries.some((e) => /\.state|\.index/.test(e.source)),
        `no entry should reference .state/.index source: ${JSON.stringify(result.entries)}`,
      );
      const stateSkip = result.entries.find((e) => e.source === "state.md" && e.action === "skipped");
      assert(stateSkip && /support file outside memory entry directories/.test(stateSkip.reason || ""), `state.md should be skipped as support file: ${JSON.stringify(result.entries)}`);
      // Extract disposition: seed pruned + target points at global abrain canonical copy.
      const seedPrunedExtract = result.entries.find((e) => e.source === path.join("knowledge", "taste-review", "content.md") && e.action === "pruned");
      assert(seedPrunedExtract && /canonical copy lives at global abrain/.test(seedPrunedExtract.reason || ""), `extract-disposition seed should be pruned with global pointer: ${JSON.stringify(result.entries)}`);
      assert(seedPrunedExtract.target === path.join("knowledge", "taste-review-content.md"), `extract seed target should point at global knowledge: ${JSON.stringify(seedPrunedExtract)}`);
      // Obsolete disposition: seed pruned + no global target; reason explains why.
      const seedPrunedObsolete = result.entries.find((e) => e.source === path.join("pipelines", "run-when-committing.md") && e.action === "pruned");
      assert(seedPrunedObsolete && /\(obsolete:/.test(seedPrunedObsolete.reason || ""), `obsolete-disposition seed should be pruned with obsolete reason: ${JSON.stringify(result.entries)}`);
      assert(seedPrunedObsolete.target === "", `obsolete seed must not advertise a global target, got: ${JSON.stringify(seedPrunedObsolete)}`);
      // Derived/support files remain in .pensieve/ (untouched by migration).
      assert(
        fs.existsSync(path.join(goParent, ".pensieve", ".index", "graph.json")),
        `.index/graph.json should remain in .pensieve (not touched by migration)`,
      );
      assert(
        fs.existsSync(path.join(goParent, ".pensieve", ".state", "checkpoint.md")),
        `.state/checkpoint.md should remain in .pensieve (not touched by migration)`,
      );
      assert(
        fs.existsSync(path.join(goParent, ".pensieve", "state.md")),
        `root state.md support file should remain in .pensieve (not migrated)`,
      );
      assert(
        !fs.existsSync(path.join(goAbrain, "projects", "test-project", "knowledge", "state.md")),
        `root state.md support file must not be migrated into abrain knowledge/`,
      );
      assert(
        !fs.existsSync(path.join(goParent, ".pensieve", "knowledge", "taste-review", "content.md")),
        `extract-disposition seed should be pruned from project .pensieve`,
      );
      assert(
        !fs.existsSync(path.join(goAbrain, "projects", "test-project", "knowledge", "taste-review-content.md")),
        `extract-disposition seed must not be migrated into project knowledge/`,
      );
      assert(
        !fs.existsSync(path.join(goParent, ".pensieve", "pipelines", "run-when-committing.md")),
        `obsolete-disposition seed should be pruned from project .pensieve`,
      );
      assert(
        !fs.existsSync(path.join(goAbrain, "projects", "test-project", "workflows", "run-when-committing.md")),
        `obsolete-disposition seed must not be migrated into project workflows/`,
      );
      assert(
        !fs.existsSync(path.join(goAbrain, "workflows", "run-when-committing.md")),
        `obsolete-disposition seed must not be migrated into global workflows/ either`,
      );

      // 4) Knowledge entries moved to abrain projects dir
      const modernTarget = path.join(goAbrain, "projects", "test-project", "maxims", "test-rule.md");
      const legacyTarget = path.join(goAbrain, "projects", "test-project", "maxims", "legacy.md");
      assert(fs.existsSync(modernTarget), `modern entry should land at ${modernTarget}`);
      assert(fs.existsSync(legacyTarget), `legacy entry should land at ${legacyTarget}`);
      assert(!fs.existsSync(path.join(goParent, ".pensieve", "maxims", "test-rule.md")), `source should be removed from .pensieve`);
      assert(!fs.existsSync(path.join(goParent, ".pensieve", "short-term", "maxims", "legacy.md")), `legacy source should be removed`);

      // 5) Legacy entry normalized: gained schema_version, scope, kind,
      // confidence, schema_version line; gained migrated-from-legacy timeline.
      const legacyText = fs.readFileSync(legacyTarget, "utf-8");
      assert(/^schema_version: 1$/m.test(legacyText), `legacy missing schema_version:1\n${legacyText}`);
      assert(/^scope: project$/m.test(legacyText), `legacy missing scope: project`);
      assert(/^kind: maxim$/m.test(legacyText), `legacy kind should be maxim (mapped from type)`);
      assert(/^id: project:test-project:legacy$/m.test(legacyText), `legacy id mismatch`);
      assert(/migrated-from-legacy/.test(legacyText), `legacy missing migration timeline note`);
      assert(/^## Timeline$/m.test(legacyText), `legacy missing ## Timeline heading`);

      // 6) Modern entry preserved (re-normalized) and still has a migration
      // timeline entry, but original frontmatter values survived.
      const modernText = fs.readFileSync(modernTarget, "utf-8");
      assert(/^id: project:test-project:test-rule$/m.test(modernText), `modern id mismatch:\n${modernText}`);
      assert(/^kind: maxim$/m.test(modernText), `modern kind preserved`);
      assert(/migrated-from-legacy/.test(modernText), `modern entry should also gain migration timeline marker`);
      // Round 7 P0-B (sonnet audit fix): legacy timeline rows must appear
      // BEFORE the migration meta-row (chronological order). The modern
      // fixture (makeEntry) has a single legacy row `- 2026-05-08 | smoke
      // | captured | ok` followed by the migration row; verify ordering.
      {
        const tlSection = modernText.split(/^## Timeline\s*$/m)[1] || "";
        const lines = tlSection.split("\n").filter((l) => l.startsWith("- "));
        assert(lines.length >= 2, `modern entry should have at least 2 timeline rows after migration, got: ${JSON.stringify(lines)}`);
        // First non-empty timeline row must be the legacy smoke row (oldest).
        assert(
          /smoke \| captured \| ok/.test(lines[0]),
          `legacy timeline row should come FIRST (oldest), got: ${lines[0]}`,
        );
        // Last timeline row must be the migration meta-row (newest).
        assert(
          /migrated-from-legacy/.test(lines[lines.length - 1]),
          `migration meta-row should come LAST (newest), got: ${lines[lines.length - 1]}`,
        );
      }

      // 7) Pipeline routing: project-specific → ~/.abrain/projects/<id>/workflows/
      const wfProj = path.join(goAbrain, "projects", "test-project", "workflows", "run-when-coding.md");
      assert(fs.existsSync(wfProj), `project workflow should land at ${wfProj}`);
      const wfProjText = fs.readFileSync(wfProj, "utf-8");
      assert(/^kind: workflow$/m.test(wfProjText), `workflow kind missing`);
      assert(/^cross_project: false$/m.test(wfProjText), `project workflow should have cross_project: false`);

      // 8) Pipeline routing: cross-project → ~/.abrain/workflows/
      const wfCross = path.join(goAbrain, "workflows", "run-when-reviewing.md");
      assert(fs.existsSync(wfCross), `cross-project workflow should land at ${wfCross}`);
      const wfCrossText = fs.readFileSync(wfCross, "utf-8");
      assert(/^cross_project: true$/m.test(wfCrossText), `cross-project workflow should have cross_project: true`);

      // 9) Parent repo commit: "chore: migrate .pensieve → ~/.abrain/projects/..."
      const parentLog = execFileSync("git", ["-C", goParent, "log", "--pretty=%s"], { encoding: "utf-8" });
      assert(/^chore: migrate \.pensieve → ~\/\.abrain\/projects\/test-project/m.test(parentLog), `parent commit message mismatch:\n${parentLog}`);
      assert(result.parentCommitSha && /^[0-9a-f]{40}$/.test(result.parentCommitSha), `parent commit sha invalid: ${result.parentCommitSha}`);

      // Round 8 P1 (sonnet R8 audit fix): a single migrate_go audit row
      // must be written to ~/.abrain/.state/sediment/audit.jsonl with
      // per-entry source→target mapping (first 200 entries), so crash
      // mid-migration leaves forensic trail.
      const migAuditPath = path.join(goAbrain, ".state", "sediment", "audit.jsonl");
      assert(fs.existsSync(migAuditPath), `migrate_go audit log must exist at ${migAuditPath}`);
      const migAuditRows = fs.readFileSync(migAuditPath, "utf-8").trim().split("\n").filter(Boolean).map(JSON.parse);
      const migRow = migAuditRows.find((r) => r.operation === "migrate_go" && r.projectId === "test-project");
      assert(migRow, `migrate_go audit row missing; rows=${migAuditRows.map((r) => r.operation).join(",")}`);
      assert(migRow.movedCount === result.movedCount, `audit movedCount mismatch: ${migRow.movedCount} vs result ${result.movedCount}`);
      assert(migRow.workflowCount === result.workflowCount, `audit workflowCount mismatch: ${migRow.workflowCount} vs result ${result.workflowCount}`);
      assert(migRow.skippedCount === result.skippedCount, `audit skippedCount mismatch: ${migRow.skippedCount} vs result ${result.skippedCount}`);
      assert(migRow.seedPrunedCount === result.seedPrunedCount, `audit seedPrunedCount mismatch: ${migRow.seedPrunedCount} vs result ${result.seedPrunedCount}`);
      assert(Array.isArray(migRow.entries) && migRow.entries.length > 0, `audit entries array missing`);
      assert(migRow.entries.every((e) => e.source && e.action), `audit entries must each carry source+action; got=${JSON.stringify(migRow.entries[0])}`);
      assert(migRow.parentPreSha === result.parentPreSha, `audit parentPreSha mismatch`);
      assert(migRow.lane === "system", `audit lane should be 'system' for migration meta event, got: ${migRow.lane}`);

      // 10) Abrain repo commit: workflows commit themselves individually +
      // the migrate(in) commit captures knowledge entries.
      const abrainLog = execFileSync("git", ["-C", goAbrain, "log", "--pretty=%s"], { encoding: "utf-8" });
      assert(/^migrate\(in\): test-project/m.test(abrainLog), `abrain commit message missing:\n${abrainLog}`);
      assert(/^workflow: run-when-coding$/m.test(abrainLog), `project workflow commit missing:\n${abrainLog}`);
      assert(/^workflow: run-when-reviewing$/m.test(abrainLog), `cross-project workflow commit missing:\n${abrainLog}`);

      // 11) Summary string sanity
      const summary = formatMigrationGoSummary(result, goParent);
      assert(/Migration complete/.test(summary), `summary should announce completion`);
      assert(/projectId=test-project/.test(summary), `summary should include projectId`);
      assert(/Rollback/.test(summary), `summary should mention rollback`);

      // 11a) Spec §3 step 6 — index rebuild on abrain projects/<id>/ side
      // must run before the abrain commit, so memory_list / facade see the
      // freshly-migrated entries without manual /memory rebuild.
      assert(result.graphRebuilt && typeof result.graphRebuilt.nodeCount === "number", `result.graphRebuilt must be populated, got ${JSON.stringify(result.graphRebuilt)}`);
      // 3 nodes = 2 knowledge entries + 1 project-specific workflow under
      // projects/<id>/workflows/. Cross-project workflow lives outside the
      // project at ~/.abrain/workflows/ and is not counted here.
      assert(result.graphRebuilt.nodeCount === 3, `expected 3 graph nodes (2 knowledge + 1 project workflow), got ${result.graphRebuilt.nodeCount}`);
      assert(result.markdownIndexRebuilt && typeof result.markdownIndexRebuilt.entryCount === "number", `result.markdownIndexRebuilt must be populated`);
      assert(result.markdownIndexRebuilt.entryCount === 3, `expected 3 markdown index entries, got ${result.markdownIndexRebuilt.entryCount}`);
      assert(fs.existsSync(path.join(goAbrain, "projects", "test-project", ".index", "graph.json")), `abrain graph.json must exist after migration`);
      assert(fs.existsSync(path.join(goAbrain, "projects", "test-project", "_index.md")), `abrain _index.md must exist after migration`);
      assert(/graph index rebuilt/.test(summary), `summary should mention graph rebuild`);
      assert(/markdown index rebuilt/.test(summary), `summary should mention markdown index rebuild`);

      // 11a.1) doctor-lite must recognize abrain project targets as the
      // post-migration store, not feed them back through the legacy .pensieve
      // migration planner. Otherwise it reports freshly migrated entries as
      // "pending migrations" and downgrades a healthy abrain target.
      const abrainDoctor = await runDoctorLite(path.join(goAbrain, "projects", "test-project"), DEFAULT_SETTINGS, undefined, goParent);
      assert(abrainDoctor.targetKind === "abrain_project", `doctor-lite should classify abrain project target, got ${abrainDoctor.targetKind}`);
      assert(abrainDoctor.projectId === "test-project", `doctor-lite projectId mismatch: ${abrainDoctor.projectId}`);
      assert(abrainDoctor.migration.applicable === false, `abrain doctor migration should be not-applicable: ${JSON.stringify(abrainDoctor.migration)}`);
      assert(abrainDoctor.migration.pendingCount === 0, `abrain doctor must not report pending migrations: ${JSON.stringify(abrainDoctor.migration)}`);
      assert(abrainDoctor.status === "pass", `healthy abrain project doctor should pass, got ${JSON.stringify(abrainDoctor)}`);
      assert(abrainDoctor.sediment.operationCounts.migrate_go === 1, `abrain doctor should read filtered abrain-side migrate_go audit stats: ${JSON.stringify(abrainDoctor.sediment.operationCounts)}`);
      const abrainDoctorText = formatDoctorLiteReport(abrainDoctor);
      assert(/Target kind: abrain_project \(test-project\)/.test(abrainDoctorText), `formatted doctor report should include target kind: ${abrainDoctorText}`);
      assert(/Not applicable: target is abrain project test-project/.test(abrainDoctorText), `formatted doctor report should mark migration not applicable: ${abrainDoctorText}`);

      // 11b) Rollback hint uses pre-migration SHAs (not HEAD~1) so it works
      // even with N+1 abrain commits (N workflow + 1 migrate-in).
      assert(result.parentPreSha && /^[0-9a-f]{40}$/.test(result.parentPreSha), `parentPreSha must be a valid SHA: ${result.parentPreSha}`);
      assert(result.abrainPreSha && /^[0-9a-f]{40}$/.test(result.abrainPreSha), `abrainPreSha must be a valid SHA: ${result.abrainPreSha}`);
      assert(summary.includes(result.parentPreSha), `summary rollback must reference parentPreSha ${result.parentPreSha}`);
      assert(summary.includes(result.abrainPreSha), `summary rollback must reference abrainPreSha ${result.abrainPreSha}`);
      assert(!/HEAD~1(?!.*pre-migration SHA not captured)/.test(summary), `summary must not use HEAD~1 in rollback (it's wrong for N+1 abrain commits):\n${summary}`);

      // 11c) The captured pre-SHAs must actually be the pre-migration HEAD,
      // i.e. the commit immediately before the migrate-in commit chain. Reset
      // to those SHAs must restore the original .pensieve layout.
      const abrainHeadAfter = execFileSync("git", ["-C", goAbrain, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
      assert(abrainHeadAfter !== result.abrainPreSha, `abrain HEAD should have advanced past pre-sha`);
      // Simulate rollback and verify .pensieve content comes back on parent side
      execFileSync("git", ["-C", goParent, "reset", "--hard", result.parentPreSha]);
      assert(
        fs.existsSync(path.join(goParent, ".pensieve", "maxims", "test-rule.md")),
        `rollback to parentPreSha must restore .pensieve/maxims/test-rule.md`,
      );
      assert(
        fs.existsSync(path.join(goParent, ".pensieve", "pipelines", "run-when-coding.md")),
        `rollback must restore .pensieve/pipelines/run-when-coding.md`,
      );
      execFileSync("git", ["-C", goAbrain, "reset", "--hard", result.abrainPreSha]);
      assert(
        fs.existsSync(path.join(goAbrain, "projects", "test-project", "_project.json")),
        `rollback to abrainPreSha must preserve the pre-existing B4.5 project registry`,
      );
      assert(
        !fs.existsSync(path.join(goAbrain, "projects", "test-project", "maxims", "test-rule.md")),
        `rollback to abrainPreSha must remove migrated knowledge entries`,
      );
      assert(
        !fs.existsSync(path.join(goAbrain, "projects", "test-project", "workflows", "run-when-coding.md")),
        `rollback to abrainPreSha must remove project workflow added by migration`,
      );
      assert(
        !fs.existsSync(path.join(goAbrain, "workflows", "run-when-reviewing.md")),
        `rollback must remove cross-project workflow added by migration`,
      );

      // 12) Idempotency / Forward-only protection.
      //
      // After 11c rollback, both repos are back at pre-migration state, so
      // we re-run migration to get back to migrated state — then verify a
      // *third* run fails preflight cleanly because .pensieve no longer has
      // user entries (only derived .index/.state files remain, which
      // migrate-go ignores). This protects against accidental empty-migration
      // commits.
      const reapply = await runMigrationGo(goOpts);
      assert(reapply.ok, `re-apply after rollback must succeed, got: ${JSON.stringify(reapply.preconditionFailures)}`);
      const second = await runMigrationGo(goOpts);
      assert(second.ok === false, `second run must not succeed`);
      assert(
        second.preconditionFailures.some((f) => /no user entries to migrate/.test(f)),
        `second run should fail with no-user-entries: ${second.preconditionFailures.join("; ")}`,
      );
    }

    // === per-repo migration --go: dirty/untracked source tolerance ========
    {
      const dParent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-dirty-parent-"));
      execFileSync("git", ["-C", dParent, "init", "-q"]);
      execFileSync("git", ["-C", dParent, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", dParent, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", dParent, "config", "commit.gpgsign", "false"]);
      writeFile(path.join(dParent, ".pensieve", "maxims", "dirty-rule.md"), makeEntry({ title: "Dirty Rule", kind: "maxim" }));
      execFileSync("git", ["-C", dParent, "add", "-A"]);
      execFileSync("git", ["-C", dParent, "commit", "-q", "-m", "init dirty pensieve"]);

      const dAbrain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-dirty-abrain-"));
      execFileSync("git", ["-C", dAbrain, "init", "-q"]);
      execFileSync("git", ["-C", dAbrain, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", dAbrain, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", dAbrain, "config", "commit.gpgsign", "false"]);
      writeFile(path.join(dAbrain, "README.md"), "# abrain dirty smoke\n");
      execFileSync("git", ["-C", dAbrain, "add", "-A"]);
      execFileSync("git", ["-C", dAbrain, "commit", "-q", "-m", "init abrain"]);
      await bindMigrationProject(dParent, dAbrain, "dirty-project");

      fs.appendFileSync(path.join(dParent, ".pensieve", "maxims", "dirty-rule.md"), "\nDirty source note.\n");
      writeFile(path.join(dParent, "dirty-file.txt"), "outside staged change\n");
      writeFile(path.join(dParent, ".pensieve", "state.md"), "# staged support file\n");
      execFileSync("git", ["-C", dParent, "add", "dirty-file.txt", ".pensieve/state.md"]);

      const dirtyResult = await runMigrationGo({
        pensieveTarget: path.join(dParent, ".pensieve"),
        abrainHome: dAbrain,
        cwd: dParent,
        settings: DEFAULT_SETTINGS,
        migrationTimestamp: "2099-05-12T11:00:00.000+08:00",
      });
      assert(dirtyResult.ok, `dirty source migration should succeed: ${JSON.stringify(dirtyResult)}`);
      assert(dirtyResult.parentRepoWasClean === false, `dirty source result should record parentRepoWasClean=false`);
      assert(dirtyResult.commitErrors.length === 0, `dirty source should have no commit errors: ${dirtyResult.commitErrors.join("; ")}`);
      const dirtyTarget = path.join(dAbrain, "projects", "dirty-project", "maxims", "dirty-rule.md");
      assert(fs.existsSync(dirtyTarget), `dirty source target should exist at ${dirtyTarget}`);
      const dirtyText = fs.readFileSync(dirtyTarget, "utf-8");
      assert(/Dirty source note/.test(dirtyText), `dirty working-tree content must be migrated:\n${dirtyText}`);
      const dirtyUpdated = dirtyText.match(/^updated: (.+)$/m)?.[1] || "";
      assert(!/2026-05-08/.test(dirtyUpdated), `dirty tracked updated should use fs.mtime, not stale git/frontmatter time: ${dirtyUpdated}\n${dirtyText}`);
      assert(!fs.existsSync(path.join(dParent, ".pensieve", "maxims", "dirty-rule.md")), `dirty source should be removed after migration`);
      assert(dirtyResult.parentCommitSha && /^[0-9a-f]{40}$/.test(dirtyResult.parentCommitSha), `dirty parent commit sha invalid: ${dirtyResult.parentCommitSha}`);
      const dirtyParentShow = execFileSync("git", ["-C", dParent, "show", "--name-only", "--pretty=", dirtyResult.parentCommitSha], { encoding: "utf-8" });
      assert(/\.pensieve\/maxims\/dirty-rule\.md/.test(dirtyParentShow), `parent cleanup commit should include migrated source deletion:\n${dirtyParentShow}`);
      assert(!/dirty-file\.txt/.test(dirtyParentShow), `parent cleanup commit must not include outside staged file:\n${dirtyParentShow}`);
      assert(!/\.pensieve\/state\.md/.test(dirtyParentShow), `parent cleanup commit must not include staged support file:\n${dirtyParentShow}`);
      const dirtyStatus = execFileSync("git", ["-C", dParent, "status", "--porcelain"], { encoding: "utf-8" });
      assert(/^A  dirty-file\.txt/m.test(dirtyStatus), `outside staged file should remain staged after migration:\n${dirtyStatus}`);
      assert(/^A  \.pensieve\/state\.md/m.test(dirtyStatus), `staged support file should remain staged after migration:\n${dirtyStatus}`);
      const dirtySummary = formatMigrationGoSummary(dirtyResult, dParent);
      assert(/git revert -n/.test(dirtySummary), `dirty rollback should suggest non-committing revert:\n${dirtySummary}`);
      assert(/abrain is the only full copy/.test(dirtySummary), `dirty rollback must warn about dirty source copy:\n${dirtySummary}`);
      assert(!dirtySummary.includes(`git reset --hard ${dirtyResult.parentPreSha}`), `dirty rollback must not suggest parent reset --hard:\n${dirtySummary}`);
    }

    // === per-repo migration --go: true untracked/ignored source entries ===
    {
      const uParent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-untracked-parent-"));
      execFileSync("git", ["-C", uParent, "init", "-q"]);
      execFileSync("git", ["-C", uParent, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", uParent, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", uParent, "config", "commit.gpgsign", "false"]);
      writeFile(path.join(uParent, "README.md"), "# parent\n");
      writeFile(path.join(uParent, ".gitignore"), ".pensieve/\n");
      execFileSync("git", ["-C", uParent, "add", "-A"]);
      execFileSync("git", ["-C", uParent, "commit", "-q", "-m", "init parent with ignored pensieve"]);

      const uAbrain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-untracked-abrain-"));
      execFileSync("git", ["-C", uAbrain, "init", "-q"]);
      execFileSync("git", ["-C", uAbrain, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", uAbrain, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", uAbrain, "config", "commit.gpgsign", "false"]);
      writeFile(path.join(uAbrain, "README.md"), "# abrain untracked smoke\n");
      execFileSync("git", ["-C", uAbrain, "add", "-A"]);
      execFileSync("git", ["-C", uAbrain, "commit", "-q", "-m", "init abrain"]);
      await bindMigrationProject(uParent, uAbrain, "untracked-project");

      // Reproduce repos like ~/work/base/sub2api: .pensieve itself carries
      // `.gitignore: *`, so ordinary rg-based scans see only odd support
      // leftovers such as state.md. Migration must explicitly include ignored
      // files because .pensieve is the legacy input snapshot.
      writeFile(path.join(uParent, ".pensieve", ".gitignore"), "*\n");
      writeFile(path.join(uParent, ".pensieve", "state.md"), "# State support file\n");
      writeFile(path.join(uParent, ".pensieve", "maxims", "untracked-rule.md"), makeEntry({ title: "Untracked Rule", kind: "maxim" }));
      const ignoredDryRun = await planMigrationDryRun(
        path.join(uParent, ".pensieve"),
        DEFAULT_SETTINGS,
        undefined,
        uParent,
        { abrainHome: uAbrain, projectId: "untracked-project" },
      );
      assert(ignoredDryRun.migrateCount === 1, `dry-run should see ignored .pensieve entry, got ${JSON.stringify(ignoredDryRun)}`);
      assert(ignoredDryRun.skipped.some((s) => s.source_path.endsWith(".pensieve/state.md")), `dry-run should still skip root state.md support file: ${JSON.stringify(ignoredDryRun)}`);
      const untrackedResult = await runMigrationGo({
        pensieveTarget: path.join(uParent, ".pensieve"),
        abrainHome: uAbrain,
        cwd: uParent,
        settings: DEFAULT_SETTINGS,
        migrationTimestamp: "2026-05-12T11:30:00.000+08:00",
      });
      assert(untrackedResult.ok, `ignored .pensieve untracked source migration should succeed: ${JSON.stringify(untrackedResult)}`);
      assert(untrackedResult.parentRepoWasClean === true, `ignored .pensieve entries should not make git status dirty`);
      assert(untrackedResult.untrackedSourceCount === 1, `ignored/untracked source count should be 1, got ${untrackedResult.untrackedSourceCount}`);
      assert(untrackedResult.parentCommitSha === null, `ignored/untracked-only source should not create parent commit: ${untrackedResult.parentCommitSha}`);
      assert(!fs.existsSync(path.join(uParent, ".pensieve", "maxims", "untracked-rule.md")), `untracked source should be removed from legacy .pensieve`);
      assert(fs.existsSync(path.join(uAbrain, "projects", "untracked-project", "maxims", "untracked-rule.md")), `untracked source should be written to abrain`);
      const untrackedSummary = formatMigrationGoSummary(untrackedResult, uParent);
      assert(/untracked\/ignored sources migrated: 1/.test(untrackedSummary), `untracked summary should count ignored source:\n${untrackedSummary}`);
      assert(/no migration commit to undo/.test(untrackedSummary), `untracked summary should say parent has no commit:\n${untrackedSummary}`);
      assert(/recover them from the abrain migrated copies/.test(untrackedSummary), `untracked rollback should warn to recover from abrain before reset:\n${untrackedSummary}`);
      assert(!untrackedSummary.includes(`git reset --hard ${untrackedResult.parentPreSha}`), `ignored/untracked rollback must not suggest parent reset --hard:\n${untrackedSummary}`);
    }

    // === per-repo migration --go: timestamp recovery (git/fs/fm triangulation) ===
    //
    // analyzeEntry resolves `created` to min(fm.created, git-author-first,
    // fs.birthtime) and `updated` to max(git-author-last, fm.updated,
    // fs.mtime-when-untracked). Without this triangulation every legacy
    // entry would migrate as "created today", destroying LLM time-aware
    // ranking signal. The four fixtures below cover:
    //   (1) fm.created "future"   → future fm is rejected; created is no later than git-first
    //   (2) fm.created absent     → created is no later than git-first (fs.birthtime may be earlier)
    //   (3) fm.created "ancient"  → fm wins (author claims very early date)
    //   (4) tracked-but-modified  → updated picks git author-last (commit 2)
    {
      const tParent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-tstamp-parent-"));
      execFileSync("git", ["-C", tParent, "init", "-q"]);
      execFileSync("git", ["-C", tParent, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", tParent, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", tParent, "config", "commit.gpgsign", "false"]);

      // (1) fm.created = far-future date; future fm must not win. The
      //     chosen created value is min(git-first, fs.birthtime), so on
      //     filesystems with birthtime it can be a few ms before git-first.
      writeFile(
        path.join(tParent, ".pensieve", "decisions", "future-fm.md"),
        `---
title: Future fm date
kind: decision
status: active
confidence: 5
schema_version: 1
created: 2099-01-01
updated: 2099-01-01
---
# Future fm date

Body.
`,
      );
      // (2) No fm.created / fm.updated; git-first / git-last are the only
      //     signals (besides fs).
      writeFile(
        path.join(tParent, ".pensieve", "decisions", "no-fm-dates.md"),
        `---
title: No fm dates
kind: decision
status: active
confidence: 5
schema_version: 1
---
# No fm dates

Body.
`,
      );
      // (3) Author claims ancient date in fm; min() must honor it.
      writeFile(
        path.join(tParent, ".pensieve", "decisions", "ancient-fm.md"),
        `---
title: Ancient fm date
kind: decision
status: active
confidence: 5
schema_version: 1
created: 2020-01-15
updated: 2020-01-15
---
# Ancient fm date

Body.
`,
      );
      // (3b) Mixed-timezone fm.created: +08:00 midnight vs UTC midnight
      // would invert under lexicographic string sort (`+00:00` < `+08:00`)
      // but the +08:00 instant is actually 8h EARLIER. pickByEpoch must
      // use Date.parse() for correct comparison. We pick a date EARLY
      // enough that fm wins over git/fs regardless.
      writeFile(
        path.join(tParent, ".pensieve", "decisions", "tz-mixed.md"),
        `---
title: TZ mixed
kind: decision
status: active
confidence: 5
schema_version: 1
created: 2020-06-01T00:00:00+08:00
---
# TZ mixed

Body.
`,
      );
      // (4) Will be committed twice; updated should equal the second
      //     commit's author-date, not the first.
      writeFile(
        path.join(tParent, ".pensieve", "decisions", "twice-edited.md"),
        `---
title: Twice edited
kind: decision
status: active
confidence: 5
schema_version: 1
---
# Twice edited

First body.
`,
      );
      execFileSync("git", ["-C", tParent, "add", "-A"]);
      execFileSync("git", ["-C", tParent, "commit", "-q", "-m", "init pensieve (commit 1)"]);
      // %aI is second-resolution; force a tick so commit 2 falls in a
      // strictly later second than commit 1.
      await new Promise((r) => setTimeout(r, 1100));
      // Second commit: only edit `twice-edited.md` so its git-last differs
      // from its git-first.
      writeFile(
        path.join(tParent, ".pensieve", "decisions", "twice-edited.md"),
        `---
title: Twice edited
kind: decision
status: active
confidence: 5
schema_version: 1
---
# Twice edited

Second body (after edit).
`,
      );
      execFileSync("git", ["-C", tParent, "add", "-A"]);
      execFileSync("git", ["-C", tParent, "commit", "-q", "-m", "edit twice-edited (commit 2)"]);
      // One more tick before the late-added file's commit, so its git-first
      // is strictly later than the prior two commits.
      await new Promise((r) => setTimeout(r, 1100));

      // Capture git-first/git-last per file using the same %aI we read
      // from migrate-go, so assertions are not flaky against subprocess
      // timing.
      const gitTime = (relFile, args) => {
        const out = execFileSync(
          "git",
          ["-C", tParent, "log", ...args, "--pretty=format:%aI", "--", relFile],
          { encoding: "utf-8" },
        ).trim().split("\n").filter(Boolean);
        return out[0] ?? "";
      };
      // All git timestamp queries MUST happen BEFORE runMigrationGo,
      // because the migration's parent-repo commit (which `git rm`s
      // each migrated source) counts as a touch of the file and
      // would shift git-last forward to the migration commit time.
      // collectGitAuthorTimes (called inside runMigrationGo) snapshots
      // pre-migration state; assertions must compare against the same
      // snapshot.
      const futureGitFirst = gitTime(".pensieve/decisions/future-fm.md", ["--reverse", "--diff-filter=A"]);
      const futureGitLast = gitTime(".pensieve/decisions/future-fm.md", []);
      const noFmGitFirst = gitTime(".pensieve/decisions/no-fm-dates.md", ["--reverse", "--diff-filter=A"]);
      const noFmGitLast = gitTime(".pensieve/decisions/no-fm-dates.md", []);
      const twiceGitFirst = gitTime(".pensieve/decisions/twice-edited.md", ["--reverse", "--diff-filter=A"]);
      const twiceGitLast = gitTime(".pensieve/decisions/twice-edited.md", []);
      assert(futureGitFirst, "git first commit missing for future-fm.md (fixture broken)");
      assert(noFmGitFirst && noFmGitLast, "git first/last missing for no-fm-dates.md");
      assert(twiceGitFirst && twiceGitLast && twiceGitFirst < twiceGitLast, `twice-edited git-first must precede git-last, got ${twiceGitFirst} vs ${twiceGitLast}`);

      const tAbrain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-tstamp-abrain-"));
      execFileSync("git", ["-C", tAbrain, "init", "-q"]);
      execFileSync("git", ["-C", tAbrain, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", tAbrain, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", tAbrain, "config", "commit.gpgsign", "false"]);
      writeFile(path.join(tAbrain, "README.md"), "# abrain home (smoke timestamp)\n");
      execFileSync("git", ["-C", tAbrain, "add", "-A"]);
      execFileSync("git", ["-C", tAbrain, "commit", "-q", "-m", "init abrain"]);
      await bindMigrationProject(tParent, tAbrain, "tstamp-test");

      // Now add a late entry after the binding commit. This fixture is
      // committed before migration so timestamp recovery can assert that
      // git-first comes from the late commit. True untracked-source migration
      // is covered in the dedicated block above.
      writeFile(
        path.join(tParent, ".pensieve", "decisions", "untracked.md"),
        `---
title: Untracked entry
kind: decision
status: active
confidence: 5
schema_version: 1
---
# Untracked entry

Body.
`,
      );
      // Commit it on its own so it lands AFTER the binding commit;
      // git-first will then resolve to this very commit, exercising the
      // "committed-but-not-in-initial-pensieve" branch. True untracked
      // fs-only behavior is covered by the dedicated untracked-source
      // migration smoke above.
      execFileSync("git", ["-C", tParent, "add", "-A"]);
      execFileSync("git", ["-C", tParent, "commit", "-q", "-m", "add late untracked entry"]);
      const untrackedGitFirst = gitTime(".pensieve/decisions/untracked.md", ["--reverse", "--diff-filter=A"]);
      assert(untrackedGitFirst, "git first commit missing for untracked.md after late commit");

      const migrationTs = "2099-12-31T23:59:59.000+08:00";
      const tResult = await runMigrationGo({
        pensieveTarget: path.join(tParent, ".pensieve"),
        abrainHome: tAbrain,
        projectId: "tstamp-test",
        cwd: tParent,
        settings: DEFAULT_SETTINGS,
        migrationTimestamp: migrationTs,
      });
      assert(tResult.ok, `tstamp migration must succeed: ${JSON.stringify(tResult.preconditionFailures)}`);
      assert(tResult.movedCount === 6, `expected 6 knowledge entries moved (5 decisions + 1 late), got ${tResult.movedCount}`);

      const readEntry = (slug) => fs.readFileSync(
        path.join(tAbrain, "projects", "tstamp-test", "decisions", `${slug}.md`),
        "utf-8",
      );
      const fmField = (text, field) => {
        const m = text.match(new RegExp(`^${field}: (.+)$`, "m"));
        return m ? m[1].replace(/^"|"$/g, "") : null;
      };
      const assertCreatedNotAfter = (actual, reference, label) => {
        const a = Date.parse(actual);
        const r = Date.parse(reference);
        assert(Number.isFinite(a) && Number.isFinite(r) && a <= r, `${label} created should be no later than ${reference}, got ${actual}`);
      };

      // (1) future-fm: created must not be future fm (2099-01-01).
      //     updated must equal git-last — NOT the future-dated
      //     fm.updated 2099-01-01 (caught by the future-date guard in
      //     resolveUpdated, which caps at min(migrationTimestamp,
      //     real-now)). `futureGitLast` was captured pre-migration
      //     above; do not re-query here (migration commit would shift
      //     git-last forward).
      const futureText = readEntry("future-fm");
      const futureCreated = fmField(futureText, "created");
      const futureUpdated = fmField(futureText, "updated");
      assertCreatedNotAfter(futureCreated, futureGitFirst, "future-fm");
      assert(!futureCreated.startsWith("2099"), `future-fm created must not leak 2099 fm value: ${futureCreated}`);
      // Strong assertion: updated must EXACTLY equal git-last (which is
      // bounded by real time). Both "2099-01-01" (fm leak) and
      // "2099-12-31" (migration-ts leak) would fail this.
      assert(futureUpdated === futureGitLast, `future-fm updated must be git-last ${futureGitLast}, got ${futureUpdated}`);
      assert(!futureUpdated.startsWith("2099"), `future-fm updated must NOT carry 2099 (future-date guard failure): ${futureUpdated}`);

      // (2) no-fm-dates: created = min(git-first, fs.birthtime), updated = git-last.
      const noFmText = readEntry("no-fm-dates");
      assertCreatedNotAfter(fmField(noFmText, "created"), noFmGitFirst, "no-fm-dates");
      assert(fmField(noFmText, "updated") === noFmGitLast, `no-fm-dates updated should be git-last ${noFmGitLast}`);
      assert(!fmField(noFmText, "created").startsWith("2099"), `no-fm-dates created must not be migration ts`);

      // (3) ancient-fm: created = fm 2020-01-15 (much earlier than any git
      //     commit happening "now"). min() must honor the author claim.
      const ancientText = readEntry("ancient-fm");
      const ancientCreated = fmField(ancientText, "created");
      assert(ancientCreated.startsWith("2020-01-15"), `ancient-fm created should start 2020-01-15, got ${ancientCreated}`);
      // updated for ancient: max(git-last, fm.updated=2020-01-15). git-last
      // is "now" and dominates.
      const ancientUpdated = fmField(ancientText, "updated");
      assert(!ancientUpdated.startsWith("2020-"), `ancient-fm updated should be max(git-last, fm.updated), got ${ancientUpdated}`);

      // (4) twice-edited: created = min(git-first, fs.birthtime), updated = git-last
      //     (commit 2). Critical: updated must NOT equal created.
      const twiceText = readEntry("twice-edited");
      const twiceCreated = fmField(twiceText, "created");
      const twiceUpdated = fmField(twiceText, "updated");
      assertCreatedNotAfter(twiceCreated, twiceGitFirst, "twice-edited");
      assert(twiceUpdated === twiceGitLast, `twice-edited updated should be git-last ${twiceGitLast}, got ${twiceUpdated}`);
      assert(twiceUpdated > twiceCreated, `twice-edited updated must be > created (git history): ${twiceCreated} vs ${twiceUpdated}`);

      // (3b) tz-mixed: fm.created = 2020-06-01T00:00:00+08:00 is earlier
      //      than any git/fs time. pickByEpoch (UTC epoch) must select fm
      //      as min. Crucially, lexicographic string sort would pick
      //      git-author-first ("2026-...") as smaller after the leading
      //      year mismatch wraps, but here the year already disambiguates
      //      — the deeper assertion is that the +08:00 instant maps to
      //      2020-05-31T16:00:00Z (8h before UTC midnight) and that's
      //      what we end up writing in the normalized frontmatter (Date
      //      object → formatLocalIsoTimestamp normalizes to local tz).
      const tzMixedText = readEntry("tz-mixed");
      const tzMixedCreated = fmField(tzMixedText, "created");
      assert(tzMixedCreated.startsWith("2020-"), `tz-mixed created should start with 2020-, got ${tzMixedCreated}`);

      // (5) late-added untracked.md: git-first = late commit; the key
      //     non-regression assertion is that created/updated are NEVER
      //     the migrationTimestamp 2099-12-31 (which would mean git/fs
      //     resolution silently failed).
      const untrackedText = readEntry("untracked");
      const untrackedCreated = fmField(untrackedText, "created");
      const untrackedUpdated = fmField(untrackedText, "updated");
      assertCreatedNotAfter(untrackedCreated, untrackedGitFirst, "untracked-late");
      assert(!untrackedCreated.startsWith("2099-12"), `untracked-late created must not be migration ts: ${untrackedCreated}`);
      assert(!untrackedUpdated.startsWith("2099-12"), `untracked-late updated must not be migration ts: ${untrackedUpdated}`);
    }

    // === per-repo migration --go: boundary scenarios (sonnet audit P2) ====
    //
    // Extra scenarios on top of the main happy/preflight/idempotency
    // assertions: (a) slug collision on the abrain side surfaces in
    // failedCount + a clear reason, (b) ADR 0017 strict binding refuses
    // an unbound repo even when a git remote exists, and (c) strict-bound
    // projectId migrates successfully.

    // (a) slug collision: abrain already has a maxim with the same slug.
    {
      const cParent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-collide-parent-"));
      execFileSync("git", ["-C", cParent, "init", "-q"]);
      execFileSync("git", ["-C", cParent, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", cParent, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", cParent, "config", "commit.gpgsign", "false"]);
      writeFile(path.join(cParent, ".pensieve", "maxims", "shared-rule.md"), makeEntry({ title: "Shared Rule", kind: "maxim" }));
      execFileSync("git", ["-C", cParent, "add", "-A"]);
      execFileSync("git", ["-C", cParent, "commit", "-q", "-m", "init"]);

      const cAbrain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-collide-abrain-"));
      execFileSync("git", ["-C", cAbrain, "init", "-q"]);
      execFileSync("git", ["-C", cAbrain, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", cAbrain, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", cAbrain, "config", "commit.gpgsign", "false"]);
      // Seed abrain with a pre-existing entry at the migration target path.
      writeFile(
        path.join(cAbrain, "projects", "collide-test", "maxims", "shared-rule.md"),
        makeEntry({ title: "Shared Rule (existing)", kind: "maxim" }),
      );
      execFileSync("git", ["-C", cAbrain, "add", "-A"]);
      execFileSync("git", ["-C", cAbrain, "commit", "-q", "-m", "init w/ collision"]);
      await bindMigrationProject(cParent, cAbrain, "collide-test");

      const result = await runMigrationGo({
        pensieveTarget: path.join(cParent, ".pensieve"),
        abrainHome: cAbrain,
        projectId: "collide-test",
        cwd: cParent,
        settings: DEFAULT_SETTINGS,
        migrationTimestamp: "2026-05-12T10:00:00.000+08:00",
      });
      assert(result.ok === false, `collision-case migration must be partial/failed, got ok=true`);
      assert(result.failedCount === 1, `expected 1 failure on collision, got ${result.failedCount} (entries=${JSON.stringify(result.entries)})`);
      const failed = result.entries.find((e) => e.action === "failed");
      assert(failed, `must have a failed entry report`);
      assert(/already exists|exists/i.test(failed.reason || ""), `collision reason should mention existing target: ${failed.reason}`);
      assert(result.movedCount === 0, `no entry should move when its sole entry collides`);
      // Post-2026-05-13 sediment cutover: `.pensieve/MIGRATED_TO_ABRAIN`
      // guard fully removed. Migration no longer writes any flag file;
      // identity / post-migration state is conveyed by strict binding
      // (.abrain-project.json + abrainHome/projects/<id>/_project.json).
      assert(!fs.existsSync(path.join(cParent, ".pensieve", "MIGRATED_TO_ABRAIN")), `MIGRATED_TO_ABRAIN guard must not exist (removed in 2026-05-13 cutover)`);
      const summary = formatMigrationGoSummary(result, cParent);
      assert(/partially completed/.test(summary), `partial summary should not say complete-only: ${summary}`);
      assert(/partial migration/.test(summary), `partial summary should explain failed entries remain for retry: ${summary}`);
      // Pre-existing entry is untouched (no overwrite of existing data).
      const existingText = fs.readFileSync(path.join(cAbrain, "projects", "collide-test", "maxims", "shared-rule.md"), "utf-8");
      assert(/Shared Rule \(existing\)/.test(existingText), `pre-existing entry must not be overwritten by collision case`);

      // --- partial migration retry: after the operator resolves the
      //     collision (typically: archive / move the abrain-side entry),
      //     re-running `/memory migrate --go` must succeed with the
      //     remaining .pensieve entry now landing in abrain. This is the
      //     workflow the partial-summary line points users at.
      //
      // The retry path is the user-visible recovery mechanism. Without
      // it tested, a regression that leaves migrate-go thinking it has
      // already migrated a partial repo (e.g. by writing a stray state
      // flag) would strand .pensieve entries permanently.
      {
        // Operator resolves the collision by unlinking the abrain-side
        // pre-existing entry. (In production: archive or supersede;
        // unlink is the simplest reproducible flavor for smoke.)
        const abrainSide = path.join(cAbrain, "projects", "collide-test", "maxims", "shared-rule.md");
        execFileSync("git", ["-C", cAbrain, "rm", "-q", path.relative(cAbrain, abrainSide)]);
        execFileSync("git", ["-C", cAbrain, "commit", "-q", "-m", "smoke: resolve collision by removing pre-existing entry"]);

        const retryResult = await runMigrationGo({
          pensieveTarget: path.join(cParent, ".pensieve"),
          abrainHome: cAbrain,
          projectId: "collide-test",
          cwd: cParent,
          settings: DEFAULT_SETTINGS,
          migrationTimestamp: "2026-05-13T12:30:00.000+08:00",
        });
        assert(retryResult.ok === true, `partial-migration retry must succeed after collision resolved, got: ${JSON.stringify(retryResult.preconditionFailures || retryResult)}`);
        assert(retryResult.movedCount >= 1, `retry should move the previously-failed entry, movedCount=${retryResult.movedCount}`);
        assert(retryResult.failedCount === 0, `retry should have zero failures, got: ${JSON.stringify(retryResult.entries.filter((e) => e.action === "failed"))}`);
        // The entry that previously failed must now exist in abrain.
        assert(fs.existsSync(abrainSide), `partial retry must land the previously-failed entry at ${abrainSide}`);
        // After full success, B5 cutover removes guard: NO MIGRATED_TO_ABRAIN flag.
        assert(!fs.existsSync(path.join(cParent, ".pensieve", "MIGRATED_TO_ABRAIN")), `partial retry success must not resurrect MIGRATED_TO_ABRAIN guard (removed in B5 cutover)`);
        // Summary on retry should be non-partial (no "partial migration" warning).
        const retrySummary = formatMigrationGoSummary(retryResult, cParent);
        assert(!/partial migration/.test(retrySummary), `retry summary must not mention partial: ${retrySummary}`);
      }
    }

    // (a.2) large-batch migration: audit row entries truncated at 200,
    //       entries_total + entries_truncated reflect full size.
    //
    // The audit row inlines per-entry mapping for forensic traceability
    // ("which .pensieve file became which abrain target"), but a single
    // jsonl line containing 5000 entries breaks `jq` / `cat` workflows
    // and bloats disk. migrate-go.ts:1160 caps inline at 200 and
    // surfaces the actual size via entries_total + entries_truncated.
    // Without a smoke locking the contract, a future refactor could
    // silently switch to inlining everything (regression: audit lines
    // grow unbounded) or to truncating without the boolean flag
    // (regression: operators can't tell whether they're looking at a
    // complete or partial mapping).
    {
      const bigParent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-bigaudit-parent-"));
      execFileSync("git", ["-C", bigParent, "init", "-q"]);
      execFileSync("git", ["-C", bigParent, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", bigParent, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", bigParent, "config", "commit.gpgsign", "false"]);
      // Seed 201 entries (cap + 1) under .pensieve/. Legacy supported
      // directories per inferLegacyArea (migrate.ts:88) are { maxims,
      // decisions, knowledge, staging, archive }; `facts` is NOT one of
      // them (fact-kind entries live under `knowledge/`). Spread across
      // two legacy dirs so audit also reflects routing diversity.
      const knowledgeDir = path.join(bigParent, ".pensieve", "knowledge");
      const maximsDir = path.join(bigParent, ".pensieve", "maxims");
      fs.mkdirSync(knowledgeDir, { recursive: true });
      fs.mkdirSync(maximsDir, { recursive: true });
      const TOTAL = 201;
      const MAXIMS_COUNT = 30;
      for (let i = 0; i < TOTAL; i++) {
        const isMaxim = i < MAXIMS_COUNT;
        const dir = isMaxim ? maximsDir : knowledgeDir;
        const slug = isMaxim ? `bigaudit-maxim-${String(i).padStart(3, "0")}` : `bigaudit-fact-${String(i).padStart(3, "0")}`;
        const title = isMaxim ? `Bigaudit Maxim ${i}` : `Bigaudit Fact ${i}`;
        fs.writeFileSync(path.join(dir, `${slug}.md`), makeEntry({ title, kind: isMaxim ? "maxim" : "fact" }));
      }
      execFileSync("git", ["-C", bigParent, "add", "-A"]);
      execFileSync("git", ["-C", bigParent, "commit", "-q", "-m", "seed 201 entries"]);

      const bigAbrain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-bigaudit-abrain-"));
      execFileSync("git", ["-C", bigAbrain, "init", "-q"]);
      execFileSync("git", ["-C", bigAbrain, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", bigAbrain, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", bigAbrain, "config", "commit.gpgsign", "false"]);
      execFileSync("git", ["-C", bigAbrain, "commit", "-q", "--allow-empty", "-m", "init"]);
      await bindMigrationProject(bigParent, bigAbrain, "bigaudit-proj");

      const bigResult = await runMigrationGo({
        pensieveTarget: path.join(bigParent, ".pensieve"),
        abrainHome: bigAbrain,
        projectId: "bigaudit-proj",
        cwd: bigParent,
        settings: DEFAULT_SETTINGS,
        migrationTimestamp: "2026-05-13T12:35:00.000+08:00",
      });
      assert(bigResult.ok === true, `large-batch migration must succeed, got: ${JSON.stringify(bigResult.preconditionFailures)}`);
      assert(bigResult.movedCount === TOTAL, `large-batch should move all ${TOTAL} entries, got: ${bigResult.movedCount}`);

      // Verify the migrate_go audit row in abrain side audit.jsonl.
      const bigAuditPath = path.join(bigAbrain, ".state", "sediment", "audit.jsonl");
      assert(fs.existsSync(bigAuditPath), `abrain-side audit jsonl must exist at ${bigAuditPath}`);
      const bigAuditRows = fs.readFileSync(bigAuditPath, "utf-8").trim().split("\n").filter(Boolean).map(JSON.parse);
      const migrateRow = bigAuditRows.find((r) => r.operation === "migrate_go" && r.projectId === "bigaudit-proj");
      assert(migrateRow, `expected migrate_go audit row for bigaudit-proj`);
      assert(migrateRow.entries_total === TOTAL, `entries_total should reflect full size ${TOTAL}, got ${migrateRow.entries_total}`);
      assert(migrateRow.entries_truncated === true, `entries_truncated must be true when total > 200, got ${migrateRow.entries_truncated}`);
      assert(Array.isArray(migrateRow.entries) && migrateRow.entries.length === 200, `inline entries array must be capped at 200, got length=${migrateRow.entries?.length}`);
      // movedCount on row equals movedCount on result equals TOTAL
      assert(migrateRow.movedCount === TOTAL, `audit movedCount must match result, got ${migrateRow.movedCount}`);
      // Inline mapping retains structured per-entry fields (action/route/slug)
      const sample = migrateRow.entries[0];
      assert(typeof sample.action === "string" && typeof sample.slug === "string" && typeof sample.route === "string", `inline entry should retain action/slug/route fields, got: ${JSON.stringify(sample)}`);
    }

    // (b) ADR 0017: unbound repo refuses even with SSH remote
    {
      const rParent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-remote-parent-"));
      execFileSync("git", ["-C", rParent, "init", "-q"]);
      execFileSync("git", ["-C", rParent, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", rParent, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", rParent, "config", "commit.gpgsign", "false"]);
      // SSH-form remote is deliberately present; it must NOT be used for
      // project identity after B4.5.
      execFileSync("git", ["-C", rParent, "remote", "add", "origin", "git@github.com:alfadb/uamp.git"]);
      writeFile(path.join(rParent, ".pensieve", "maxims", "remote-test.md"), makeEntry({ title: "Remote ID Test", kind: "maxim" }));
      execFileSync("git", ["-C", rParent, "add", "-A"]);
      execFileSync("git", ["-C", rParent, "commit", "-q", "-m", "init"]);

      const rAbrain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-remote-abrain-"));
      execFileSync("git", ["-C", rAbrain, "init", "-q"]);
      execFileSync("git", ["-C", rAbrain, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", rAbrain, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", rAbrain, "config", "commit.gpgsign", "false"]);
      writeFile(path.join(rAbrain, "README.md"), "# abrain (remote-id smoke)\n");
      execFileSync("git", ["-C", rAbrain, "add", "-A"]);
      execFileSync("git", ["-C", rAbrain, "commit", "-q", "-m", "init"]);

      const boundOther = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-bound-other-"));
      execFileSync("git", ["-C", boundOther, "init", "-q"]);
      execFileSync("git", ["-C", boundOther, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", boundOther, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", boundOther, "config", "commit.gpgsign", "false"]);
      execFileSync("git", ["-C", boundOther, "commit", "-q", "--allow-empty", "-m", "init"]);
      await bindMigrationProject(boundOther, rAbrain, "bound-other");

      // ADR 0017 / B4.5: migration MUST refuse an unbound target repo even
      // when the command cwd is another repo that is already bound. Identity
      // is anchored on pensieveTarget's owning repo, not slash-command cwd.
      const result = await runMigrationGo({
        pensieveTarget: path.join(rParent, ".pensieve"),
        abrainHome: rAbrain,
        projectId: "bound-other",
        cwd: boundOther,
        settings: DEFAULT_SETTINGS,
        migrationTimestamp: "2026-05-12T10:00:00.000+08:00",
      });
      assert(!result.ok, `unbound repo must fail, got ok=true`);
      assert(
        result.preconditionFailures.some((f) => /project binding status=manifest_missing/.test(f)),
        `missing binding failure must mention manifest_missing, got: ${result.preconditionFailures.join("; ")}`,
      );
      assert(
        !fs.existsSync(path.join(rAbrain, "projects", "alfadb-uamp", "maxims", "remote-test.md")),
        `entry must NOT be migrated via git-remote inference`,
      );

      const badTarget = await runMigrationGo({
        pensieveTarget: rParent,
        abrainHome: rAbrain,
        cwd: boundOther,
        settings: DEFAULT_SETTINGS,
        migrationTimestamp: "2026-05-12T10:00:00.000+08:00",
      });
      assert(!badTarget.ok, `non-.pensieve target must fail, got ok=true`);
      assert(
        badTarget.preconditionFailures.some((f) => /must be the project \.pensieve directory/.test(f)),
        `non-.pensieve target failure should be explicit, got: ${badTarget.preconditionFailures.join("; ")}`,
      );
    }

    // (c) .pensieve must be a real directory, not a symlink to another repo.
    {
      const sParent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-symlink-parent-"));
      execFileSync("git", ["-C", sParent, "init", "-q"]);
      execFileSync("git", ["-C", sParent, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", sParent, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", sParent, "config", "commit.gpgsign", "false"]);
      const sForeign = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-symlink-foreign-"));
      writeFile(path.join(sForeign, ".pensieve", "maxims", "foreign.md"), makeEntry({ title: "Foreign Symlink Entry", kind: "maxim" }));
      fs.symlinkSync(path.join(sForeign, ".pensieve"), path.join(sParent, ".pensieve"), "dir");
      execFileSync("git", ["-C", sParent, "add", "-A"]);
      execFileSync("git", ["-C", sParent, "commit", "-q", "-m", "init symlink pensieve"]);

      const sAbrain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-symlink-abrain-"));
      execFileSync("git", ["-C", sAbrain, "init", "-q"]);
      execFileSync("git", ["-C", sAbrain, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", sAbrain, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", sAbrain, "config", "commit.gpgsign", "false"]);
      writeFile(path.join(sAbrain, "README.md"), "# abrain (symlink smoke)\n");
      execFileSync("git", ["-C", sAbrain, "add", "-A"]);
      execFileSync("git", ["-C", sAbrain, "commit", "-q", "-m", "init"]);
      await bindMigrationProject(sParent, sAbrain, "symlink-test");

      const result = await runMigrationGo({
        pensieveTarget: path.join(sParent, ".pensieve"),
        abrainHome: sAbrain,
        projectId: "symlink-test",
        cwd: sParent,
        settings: DEFAULT_SETTINGS,
        migrationTimestamp: "2026-05-12T10:00:00.000+08:00",
      });
      assert(!result.ok, `symlink .pensieve must fail, got ok=true`);
      assert(
        result.preconditionFailures.some((f) => /not a symlink/.test(f)),
        `symlink failure should be explicit, got: ${result.preconditionFailures.join("; ")}`,
      );
      assert(fs.existsSync(path.join(sForeign, ".pensieve", "maxims", "foreign.md")), `foreign entry must not be removed through symlink`);
      assert(!fs.existsSync(path.join(sAbrain, "projects", "symlink-test", "maxims", "foreign-symlink-entry.md")), `foreign entry must not migrate through symlink`);
    }

    // (d) strict-bound projectId succeeds; HTTPS remote is ignored
    {
      const rParent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-https-parent-"));
      execFileSync("git", ["-C", rParent, "init", "-q"]);
      execFileSync("git", ["-C", rParent, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", rParent, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", rParent, "config", "commit.gpgsign", "false"]);
      execFileSync("git", ["-C", rParent, "remote", "add", "origin", "https://github.com/alfadb/kihh.git"]);
      writeFile(path.join(rParent, ".pensieve", "maxims", "https-test.md"), makeEntry({ title: "HTTPS Remote ID Test", kind: "maxim" }));
      execFileSync("git", ["-C", rParent, "add", "-A"]);
      execFileSync("git", ["-C", rParent, "commit", "-q", "-m", "init"]);

      const rAbrain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-https-abrain-"));
      execFileSync("git", ["-C", rAbrain, "init", "-q"]);
      execFileSync("git", ["-C", rAbrain, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", rAbrain, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", rAbrain, "config", "commit.gpgsign", "false"]);
      writeFile(path.join(rAbrain, "README.md"), "# abrain (https-remote-id smoke)\n");
      execFileSync("git", ["-C", rAbrain, "add", "-A"]);
      execFileSync("git", ["-C", rAbrain, "commit", "-q", "-m", "init"]);
      await bindMigrationProject(rParent, rAbrain, "alfadb-kihh");

      const result = await runMigrationGo({
        pensieveTarget: path.join(rParent, ".pensieve"),
        abrainHome: rAbrain,
        projectId: "alfadb-kihh",
        cwd: rParent,
        settings: DEFAULT_SETTINGS,
        migrationTimestamp: "2026-05-12T10:00:00.000+08:00",
      });
      assert(result.ok, `strict-bound projectId case should succeed: ${JSON.stringify(result.preconditionFailures)}`);
      assert(result.projectIdSource === "strict-binding", `projectIdSource must be strict-binding, got ${result.projectIdSource}`);
      assert(result.projectId === "alfadb-kihh", `projectId from strict binding should be 'alfadb-kihh', got '${result.projectId}'`);
      assert(
        fs.existsSync(path.join(rAbrain, "projects", "alfadb-kihh", "maxims", "https-test.md")),
        `entry must land under projects/alfadb-kihh/`,
      );
    }

    // (e) parent-side commit narrowing (pathspec=".pensieve"): unrelated
    //     `.pi-astack/` working-tree changes (mimics sediment auto-commit
    //     staging that's been gitignored) must NOT be swept into the
    //     migration commit. This is the regression guard for the
    //     gitCommitAll pathspec parameter (was missing in 37f03a6).
    {
      const dParent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-narrow-parent-"));
      execFileSync("git", ["-C", dParent, "init", "-q"]);
      execFileSync("git", ["-C", dParent, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", dParent, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", dParent, "config", "commit.gpgsign", "false"]);
      // `.pi-astack/` is normally gitignored in real repos (per pi convention).
      // Match that here so parent preflight stays clean.
      writeFile(path.join(dParent, ".gitignore"), ".pi-astack/\n");
      writeFile(path.join(dParent, ".pensieve", "maxims", "narrow.md"), makeEntry({ title: "Narrow Add Test", kind: "maxim" }));
      execFileSync("git", ["-C", dParent, "add", "-A"]);
      execFileSync("git", ["-C", dParent, "commit", "-q", "-m", "init"]);

      const dAbrain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-narrow-abrain-"));
      execFileSync("git", ["-C", dAbrain, "init", "-q"]);
      execFileSync("git", ["-C", dAbrain, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", dAbrain, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", dAbrain, "config", "commit.gpgsign", "false"]);
      writeFile(path.join(dAbrain, "README.md"), "# abrain (narrow-add smoke)\n");
      execFileSync("git", ["-C", dAbrain, "add", "-A"]);
      execFileSync("git", ["-C", dAbrain, "commit", "-q", "-m", "init"]);
      await bindMigrationProject(dParent, dAbrain, "narrow-test");

      // Write `.pi-astack/` noise AFTER binding and before migration — it's
      // gitignored so preflight `git status --porcelain` returns clean.
      // With the old `git add -A`, this would have been silently ignored
      // by gitignore too; the regression value here is that the migration
      // commit's file list comes from a pathspec-narrowed `git add --
      // .pensieve`, not a wide `add -A` that *could* sweep newly added
      // files. We assert that property directly.
      writeFile(path.join(dParent, ".pi-astack", "sediment", "concurrent-noise.jsonl"), `{"unrelated":true}\n`);

      const result = await runMigrationGo({
        pensieveTarget: path.join(dParent, ".pensieve"),
        abrainHome: dAbrain,
        projectId: "narrow-test",
        cwd: dParent,
        settings: DEFAULT_SETTINGS,
        migrationTimestamp: "2026-05-12T10:00:00.000+08:00",
      });
      assert(result.ok, `narrow-add case should succeed: ${JSON.stringify(result.preconditionFailures)}`);
      // Parent migration commit must only touch .pensieve/.
      const parentCommitFiles = execFileSync("git", ["-C", dParent, "show", "--name-only", "--format=", "HEAD"], { encoding: "utf-8" }).trim().split(/\n+/).filter(Boolean);
      assert(
        parentCommitFiles.length > 0 && parentCommitFiles.every((f) => f.startsWith(".pensieve")),
        `parent migration commit must only touch .pensieve/, got: ${JSON.stringify(parentCommitFiles)}`,
      );
      // `.pi-astack/` content still exists on disk but is unstaged / untracked.
      assert(
        fs.existsSync(path.join(dParent, ".pi-astack", "sediment", "concurrent-noise.jsonl")),
        `.pi-astack noise file should still exist on disk after migration`,
      );
    }

    // (f) abrain side starts as brand-new `git init`; ADR 0017 binding
    //     bootstrap creates the first abrain HEAD (registry commit) before
    //     migration, so preflight must capture a concrete abrainPreSha.
    {
      const eParent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-empty-abrain-parent-"));
      execFileSync("git", ["-C", eParent, "init", "-q"]);
      execFileSync("git", ["-C", eParent, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", eParent, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", eParent, "config", "commit.gpgsign", "false"]);
      writeFile(path.join(eParent, ".pensieve", "maxims", "empty-abrain.md"), makeEntry({ title: "Empty Abrain Test", kind: "maxim" }));
      execFileSync("git", ["-C", eParent, "add", "-A"]);
      execFileSync("git", ["-C", eParent, "commit", "-q", "-m", "init"]);

      const eAbrain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-empty-abrain-abrain-"));
      execFileSync("git", ["-C", eAbrain, "init", "-q"]);
      execFileSync("git", ["-C", eAbrain, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", eAbrain, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", eAbrain, "config", "commit.gpgsign", "false"]);
      // NO initial commit on abrain side before binding — brand-new repo with no HEAD.
      await bindMigrationProject(eParent, eAbrain, "empty-abrain-test");

      const result = await runMigrationGo({
        pensieveTarget: path.join(eParent, ".pensieve"),
        abrainHome: eAbrain,
        projectId: "empty-abrain-test",
        cwd: eParent,
        settings: DEFAULT_SETTINGS,
        migrationTimestamp: "2026-05-12T10:00:00.000+08:00",
      });
      // Migration itself should still succeed (the abrain commit creates
      // the first HEAD on that side).
      assert(result.ok, `empty-abrain case should succeed: ${JSON.stringify(result.preconditionFailures)}`);
      // Binding bootstrap created a registry commit before migration, so
      // abrainPreSha is now concrete under B4.5 strict binding.
      assert(typeof result.abrainPreSha === "string" && /^[0-9a-f]{40}$/.test(result.abrainPreSha), `abrainPreSha should be a valid SHA after binding bootstrap, got ${result.abrainPreSha}`);
      assert(typeof result.parentPreSha === "string" && /^[0-9a-f]{40}$/.test(result.parentPreSha), `parentPreSha should still be a valid SHA, got ${result.parentPreSha}`);
      const summary = formatMigrationGoSummary(result, eParent);
      assert(!/pre-migration SHA not captured|HEAD~1.*⚠|⚠.*HEAD~1|abrain.*not captured/i.test(summary), `summary should not warn about missing abrainPreSha after binding, got: ${summary}`);
    }

    // (g) mixed batch: 2 entries where 1 collides on abrain side and 1
    //     succeeds. Verify movedCount=1 / failedCount=1 simultaneously,
    //     parent commit still happens (the survivor was git rm'd), and
    //     the colliding entry stays in .pensieve untouched (sonnet C7 #3).
    {
      const fParent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-mixed-parent-"));
      execFileSync("git", ["-C", fParent, "init", "-q"]);
      execFileSync("git", ["-C", fParent, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", fParent, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", fParent, "config", "commit.gpgsign", "false"]);
      writeFile(path.join(fParent, ".pensieve", "maxims", "will-collide.md"), makeEntry({ title: "Will Collide", kind: "maxim" }));
      writeFile(path.join(fParent, ".pensieve", "maxims", "will-succeed.md"), makeEntry({ title: "Will Succeed", kind: "maxim" }));
      execFileSync("git", ["-C", fParent, "add", "-A"]);
      execFileSync("git", ["-C", fParent, "commit", "-q", "-m", "init"]);

      const fAbrain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-mixed-abrain-"));
      execFileSync("git", ["-C", fAbrain, "init", "-q"]);
      execFileSync("git", ["-C", fAbrain, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", fAbrain, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", fAbrain, "config", "commit.gpgsign", "false"]);
      // Plant ONE colliding entry on abrain side (matches will-collide).
      writeFile(
        path.join(fAbrain, "projects", "mixed-test", "maxims", "will-collide.md"),
        makeEntry({ title: "Will Collide (existing)", kind: "maxim" }),
      );
      execFileSync("git", ["-C", fAbrain, "add", "-A"]);
      execFileSync("git", ["-C", fAbrain, "commit", "-q", "-m", "init w/ one collision"]);
      await bindMigrationProject(fParent, fAbrain, "mixed-test");

      const result = await runMigrationGo({
        pensieveTarget: path.join(fParent, ".pensieve"),
        abrainHome: fAbrain,
        projectId: "mixed-test",
        cwd: fParent,
        settings: DEFAULT_SETTINGS,
        migrationTimestamp: "2026-05-12T10:00:00.000+08:00",
      });
      assert(result.ok === false, `mixed partial case must report ok=false when failedCount>0`);
      assert(result.movedCount === 1, `expected movedCount=1, got ${result.movedCount}`);
      assert(result.failedCount === 1, `expected failedCount=1, got ${result.failedCount}`);
      assert(result.parentCommitSha, `parent commit must still happen for the survivor, got ${result.parentCommitSha}`);
      assert(result.abrainCommitSha, `abrain commit must still happen for the survivor, got ${result.abrainCommitSha}`);
      assert(!fs.existsSync(path.join(fParent, ".pensieve", "MIGRATED_TO_ABRAIN")), `mixed partial migration must not write MIGRATED_TO_ABRAIN guard`);
      // Survivor: removed from .pensieve, present in abrain.
      assert(
        !fs.existsSync(path.join(fParent, ".pensieve", "maxims", "will-succeed.md")),
        `will-succeed.md should be git-rm'd from .pensieve`,
      );
      assert(
        fs.existsSync(path.join(fAbrain, "projects", "mixed-test", "maxims", "will-succeed.md")),
        `will-succeed.md should land under abrain/projects/mixed-test/maxims/`,
      );
      // Collider: still in .pensieve (NOT removed since write failed),
      // and the pre-existing abrain copy is unchanged.
      assert(
        fs.existsSync(path.join(fParent, ".pensieve", "maxims", "will-collide.md")),
        `will-collide.md should remain in .pensieve when its target collides (no destructive cleanup)`,
      );
      const existingText = fs.readFileSync(path.join(fAbrain, "projects", "mixed-test", "maxims", "will-collide.md"), "utf-8");
      assert(/Will Collide \(existing\)/.test(existingText), `pre-existing colliding entry must not be overwritten: ${existingText.slice(0, 120)}`);
    }

    // (h) Stale-lock reclaim: verify both writer locks recover when the
    //     previous holder crashed without releasing. Round 5 audit
    //     (deepseek-v4-pro) found that acquireLock + acquireAbrainWorkflow-
    //     Lock had no reclaim path — a kill -9 mid-write caused permanent
    //     deadlock until manual `rm sediment.lock`.
    //
    //     Test matrix (each lock):
    //       - stale lock (mtime > SEDIMENT_LOCK_STEAL_AFTER_MS=30s) → reclaimed, write succeeds
    //       - fresh lock (mtime < 30s) → NOT reclaimed, write times out
    {
      const gParent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-stale-lock-parent-"));
      execFileSync("git", ["-C", gParent, "init", "-q"]);
      execFileSync("git", ["-C", gParent, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", gParent, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", gParent, "config", "commit.gpgsign", "false"]);
      execFileSync("git", ["-C", gParent, "commit", "-q", "--allow-empty", "-m", "init"]);

      const gAbrain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-stale-lock-abrain-"));
      execFileSync("git", ["-C", gAbrain, "init", "-q"]);
      execFileSync("git", ["-C", gAbrain, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", gAbrain, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", gAbrain, "config", "commit.gpgsign", "false"]);
      execFileSync("git", ["-C", gAbrain, "commit", "-q", "--allow-empty", "-m", "init"]);

      const lockSettings = { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: false, lockTimeoutMs: 1000 };

      // --- Case g.1: stale sediment.lock (abrain side) gets reclaimed ---
      // Post-2026-05-13 cutover: sediment.lock moved from
      // <projectRoot>/.pi-astack/sediment/locks/ to
      // <abrainHome>/.state/sediment/locks/ so concurrent writes from
      // multiple projects sharing one abrain home serialize against the
      // SAME lock (the abrain git index head is the shared resource).
      {
        const g1Target = setupAbrainTarget("stale-lock-reclaim");
        const sedimentLockPath = path.join(g1Target.abrainHome, ".state", "sediment", "locks", "sediment.lock");
        fs.mkdirSync(path.dirname(sedimentLockPath), { recursive: true });
        fs.writeFileSync(sedimentLockPath, JSON.stringify({ pid: 999999, created_at: "2026-05-12T00:00:00.000+08:00" }));
        // Set mtime to 60s ago (well past the 30s SEDIMENT_LOCK_STEAL_AFTER_MS).
        const past = (Date.now() - 60_000) / 1000;
        fs.utimesSync(sedimentLockPath, past, past);

        const w = await writeProjectEntry(
          { title: "Stale Lock Reclaim Test", kind: "maxim", confidence: 5, compiledTruth: "This validates that a crashed-holder sediment.lock is reclaimed after the steal-after threshold." },
          { projectRoot: gParent, abrainHome: g1Target.abrainHome, projectId: g1Target.projectId, settings: lockSettings, dryRun: false },
        );
        assert(w.status === "created" || w.status === "updated", `stale sediment.lock should be reclaimed, got status=${w.status} reason=${w.reason}`);
      }

      // --- Case g.2: fresh sediment.lock blocks write (timeout) ---
      // Note: writeProjectEntry catches lock-timeout internally and returns
      // status:"rejected" + reason containing the timeout message, rather
      // than throwing. We assert on that shape, not on a thrown exception.
      {
        const gParent2 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-fresh-lock-parent-"));
        execFileSync("git", ["-C", gParent2, "init", "-q"]);
        execFileSync("git", ["-C", gParent2, "config", "user.email", "smoke@pi-astack.local"]);
        execFileSync("git", ["-C", gParent2, "config", "user.name", "pi-astack smoke"]);
        execFileSync("git", ["-C", gParent2, "config", "commit.gpgsign", "false"]);
        execFileSync("git", ["-C", gParent2, "commit", "-q", "--allow-empty", "-m", "init"]);
        const g2Target = setupAbrainTarget("fresh-lock-block");

        const sedimentLockPath = path.join(g2Target.abrainHome, ".state", "sediment", "locks", "sediment.lock");
        fs.mkdirSync(path.dirname(sedimentLockPath), { recursive: true });
        fs.writeFileSync(sedimentLockPath, JSON.stringify({ pid: process.pid, created_at: "2026-05-12T10:00:00.000+08:00" }));
        // Leave mtime fresh (just now). acquireLock should refuse to steal
        // and the outer try/catch in writeProjectEntry should surface a
        // status:"rejected" with reason="sediment lock timeout".

        const r = await writeProjectEntry(
          { title: "Fresh Lock Block Test", kind: "maxim", confidence: 5, compiledTruth: "This validates that a fresh sediment.lock is NOT stolen and write reports a lock timeout in result.reason." },
          { projectRoot: gParent2, abrainHome: g2Target.abrainHome, projectId: g2Target.projectId, settings: lockSettings, dryRun: false },
        );
        assert(r.status === "rejected", `fresh sediment.lock must NOT be reclaimed; expected rejected, got status=${r.status}`);
        assert(/sediment lock timeout/i.test(r.reason || ""), `expected sediment lock timeout in reason, got: ${r.reason}`);
        // Lock file is still on disk (we didn't crash, we just blocked).
        assert(
          fs.existsSync(sedimentLockPath),
          `fresh sediment.lock should remain on disk after a blocked write attempt`,
        );
        fs.rmSync(gParent2, { recursive: true, force: true });
      }

      // --- Case g.3: stale workflow.lock (abrain side) gets reclaimed ---
      {
        const workflowLockPath = path.join(gAbrain, ".state", "sediment", "locks", "workflow.lock");
        fs.mkdirSync(path.dirname(workflowLockPath), { recursive: true });
        fs.writeFileSync(workflowLockPath, JSON.stringify({ pid: 999999, created_at: "2026-05-12T00:00:00.000+08:00" }));
        const past = (Date.now() - 60_000) / 1000;
        fs.utimesSync(workflowLockPath, past, past);

        const w = await writeAbrainWorkflow(
          {
            title: "Stale Workflow Lock Reclaim",
            trigger: "smoke trigger phrase",
            body: "## Task Blueprint\n\nValidate stale workflow.lock reclaim.",
            crossProject: true,
            tags: ["smoke"],
            sessionId: "smoke-stale-workflow",
          },
          { abrainHome: gAbrain, settings: lockSettings },
        );
        assert(w.status === "created" || w.status === "updated", `stale workflow.lock should be reclaimed, got status=${w.status} reason=${w.reason}`);
      }

      // --- Case g.4: fresh workflow.lock blocks write (timeout) ---
      // Same shape as g.2: writeAbrainWorkflow surfaces lock timeout as
      // status:"rejected" with reason, not as a thrown exception.
      {
        const gAbrain2 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-fresh-workflow-abrain-"));
        execFileSync("git", ["-C", gAbrain2, "init", "-q"]);
        execFileSync("git", ["-C", gAbrain2, "config", "user.email", "smoke@pi-astack.local"]);
        execFileSync("git", ["-C", gAbrain2, "config", "user.name", "pi-astack smoke"]);
        execFileSync("git", ["-C", gAbrain2, "config", "commit.gpgsign", "false"]);
        execFileSync("git", ["-C", gAbrain2, "commit", "-q", "--allow-empty", "-m", "init"]);

        const workflowLockPath = path.join(gAbrain2, ".state", "sediment", "locks", "workflow.lock");
        fs.mkdirSync(path.dirname(workflowLockPath), { recursive: true });
        fs.writeFileSync(workflowLockPath, JSON.stringify({ pid: process.pid, created_at: "2026-05-12T10:00:00.000+08:00" }));

        const r = await writeAbrainWorkflow(
          {
            title: "Fresh Workflow Lock Block",
            trigger: "smoke trigger phrase",
            body: "## Task Blueprint\n\nValidate that fresh workflow.lock blocks.",
            crossProject: true,
            tags: ["smoke"],
            sessionId: "smoke-fresh-workflow-block",
          },
          { abrainHome: gAbrain2, settings: lockSettings },
        );
        assert(r.status === "rejected", `fresh workflow.lock must NOT be reclaimed; expected rejected, got status=${r.status}`);
        assert(/workflow lock timeout|abrain workflow lock timeout/i.test(r.reason || ""), `expected workflow lock timeout in reason, got: ${r.reason}`);
        assert(
          fs.existsSync(workflowLockPath),
          `fresh workflow.lock should remain on disk after a blocked write attempt`,
        );
        fs.rmSync(gAbrain2, { recursive: true, force: true });
      }

      // --- Case g.5: writeAbrainWorkflow TOCTOU race — lock-held dedupe re-check ---
      // Round 6 deepseek-v4-pro P0: simulate two concurrent writers that both
      // pass the pre-lock existsSync, then the file is created before the
      // second writer takes the lock. The second writer MUST detect the
      // duplicate inside the lock and reject with reason="duplicate_slug_race",
      // not silently overwrite via atomicWrite → fs.rename.
      {
        const gAbrain3 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-workflow-toctou-abrain-"));
        execFileSync("git", ["-C", gAbrain3, "init", "-q"]);
        execFileSync("git", ["-C", gAbrain3, "config", "user.email", "smoke@pi-astack.local"]);
        execFileSync("git", ["-C", gAbrain3, "config", "user.name", "pi-astack smoke"]);
        execFileSync("git", ["-C", gAbrain3, "config", "commit.gpgsign", "false"]);
        execFileSync("git", ["-C", gAbrain3, "commit", "-q", "--allow-empty", "-m", "init"]);

        // Pre-create target so the lock-held existsSync trips on entry.
        const slug = "run-when-toctou-race";
        const wfDir = path.join(gAbrain3, "workflows");
        fs.mkdirSync(wfDir, { recursive: true });
        const target = path.join(wfDir, `${slug}.md`);
        const preExisting = `---\nid: ${slug}\nkind: pipeline\n---\n# pre-existing\n`;
        fs.writeFileSync(target, preExisting);

        // To exercise the *lock-held* path (not the cheap pre-lock check),
        // we patch writer-internal file existence visibility by removing the
        // target *just before* the pre-lock check sees it, then putting it
        // back. The simplest way to do that in a JS smoke is to use a slug
        // the pre-lock check won't see: we re-rename pre and post.
        const stash = target + ".stash";
        fs.renameSync(target, stash);

        // Schedule re-creation right at lock-acquire time. Since writer's
        // pre-lock existsSync runs synchronously before any awaits in this
        // smoke loop, we manually re-create the target right after kicking
        // off the write but before the lock-held check by yielding once.
        const writePromise = writeAbrainWorkflow(
          {
            title: "TOCTOU race second writer",
            slug,
            trigger: "smoke trigger phrase for race",
            body: "## Task Blueprint\n\nSecond writer for TOCTOU race.",
            crossProject: true,
            tags: ["smoke"],
            sessionId: "smoke-workflow-toctou",
          },
          { abrainHome: gAbrain3, settings: { ...lockSettings, gitCommit: false } },
        );
        // Yield to the microtask queue so writer reaches lint/normalize
        // phase, then place the file back so the lock-held existsSync trips.
        await new Promise((r) => setImmediate(r));
        fs.renameSync(stash, target);

        const r = await writePromise;
        assert(
          r.status === "rejected",
          `writeAbrainWorkflow TOCTOU race must reject second writer; got status=${r.status}`,
        );
        // The reason may be either "duplicate_slug" (pre-lock check caught it)
        // or "duplicate_slug_race" (lock-held re-check caught it). Both are
        // correct — dedupe MUST trigger somewhere. What we explicitly assert
        // against is silent overwrite.
        // Either "duplicate_slug" (pre-lock check caught it) or
        // "duplicate_slug_race" (lock-held re-check caught it) is correct.
        // In practice this smoke exercises the *race* path because the
        // target is renamed away before the pre-lock existsSync and put
        // back during the lock-acquire await window. The byte-identical
        // file assert below is the canonical guarantee.
        assert(
          /duplicate_slug/.test(r.reason || ""),
          `TOCTOU race rejection should mention duplicate_slug, got reason=${r.reason}`,
        );
        // Verify the pre-existing file is byte-identical — i.e., NOT overwritten.
        const onDisk = fs.readFileSync(target, "utf-8");
        assert(
          onDisk === preExisting,
          `TOCTOU race: pre-existing workflow file was overwritten! diff length original=${preExisting.length} after=${onDisk.length}`,
        );
        fs.rmSync(gAbrain3, { recursive: true, force: true });
      }
    }

    // === h: smoke gaps surfaced in Round 6 sonnet coverage audit =========
    //
    // sonnet's 14-command smoke matrix flagged two user-facing paths with
    // ZERO smoke coverage:
    //   - /memory check-backlinks  — checkBacklinks + formatBacklinkReport
    //   - migrate-go frontmatter-unparseable branch (migrate-go.ts:597)
    // Both are reachable by users today; either silently regressing means
    // "the assert that catches it doesn't exist". Fill the gaps.
    {
      const { checkBacklinks, formatBacklinkReport } = req("./memory/graph.js");
      const { DEFAULT_SETTINGS: memSettings } = req("./memory/settings.js");
      const { runMigrationGo } = req("./memory/migrate-go.js");

      // --- Case h.1: checkBacklinks reports dead [[wikilink]] correctly ---
      // Fixture: one entry that links to a non-existent slug — the report
      // must surface deadLinkCount > 0 and formatBacklinkReport must mention
      // the missing slug.
      {
        const tgt = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-backlinks-"));
        const decisionsDir = path.join(tgt, "decisions");
        fs.mkdirSync(decisionsDir, { recursive: true });
        const fm = [
          "---",
          "id: live-entry",
          "scope: project",
          "kind: decision",
          "status: live",
          "confidence: 7",
          "schema_version: 1",
          "title: Live entry pointing at a ghost",
          "created: '2026-05-12T12:00:00.000+08:00'",
          "updated: '2026-05-12T12:00:00.000+08:00'",
          "---",
          "",
          "# Live entry pointing at a ghost",
          "",
          "## Compiled Truth",
          "",
          "See [[ghost-entry-does-not-exist]] for context.",
          "",
          "## Timeline",
          "",
          "- 2026-05-12: created",
          "",
        ].join("\n");
        fs.writeFileSync(path.join(decisionsDir, "live-entry.md"), fm);

        const report = await checkBacklinks(tgt, memSettings, undefined, tgt);
        assert(
          report.deadLinkCount > 0,
          `checkBacklinks should report deadLinkCount > 0 for [[ghost-entry-does-not-exist]], got ${report.deadLinkCount}`,
        );
        assert(
          Array.isArray(report.issues) && report.issues.some((i) => i.problem === "dead_link" && /ghost-entry/.test(i.to)),
          `checkBacklinks issues should include dead_link to ghost-entry, got ${JSON.stringify(report.issues)}`,
        );
        const formatted = formatBacklinkReport(report);
        assert(
          /ghost-entry-does-not-exist/.test(formatted),
          `formatBacklinkReport output should mention the dead slug, got: ${formatted.slice(0, 200)}`,
        );
        fs.rmSync(tgt, { recursive: true, force: true });
      }

      // --- Case h.2: checkBacklinks zero-dead-links baseline ---
      // Same fixture shape but link points at an existing entry —
      // deadLinkCount must be 0. Catches false-positive regressions.
      {
        const tgt = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-backlinks-clean-"));
        const decisionsDir = path.join(tgt, "decisions");
        fs.mkdirSync(decisionsDir, { recursive: true });
        const writeEntry = (slug, body) =>
          fs.writeFileSync(
            path.join(decisionsDir, `${slug}.md`),
            [
              "---",
              `id: ${slug}`,
              "scope: project",
              "kind: decision",
              "status: live",
              "confidence: 7",
              "schema_version: 1",
              `title: ${slug}`,
              "created: '2026-05-12T12:00:00.000+08:00'",
              "updated: '2026-05-12T12:00:00.000+08:00'",
              "---",
              "",
              `# ${slug}`,
              "",
              "## Compiled Truth",
              "",
              body,
              "",
              "## Timeline",
              "",
              "- 2026-05-12: created",
              "",
            ].join("\n"),
          );
        writeEntry("alpha", "See [[beta]] for context.");
        writeEntry("beta", "References [[alpha]] back.");

        const report = await checkBacklinks(tgt, memSettings, undefined, tgt);
        assert(
          report.deadLinkCount === 0,
          `checkBacklinks clean fixture should report deadLinkCount=0, got ${report.deadLinkCount}`,
        );
        fs.rmSync(tgt, { recursive: true, force: true });
      }

      // --- Case h.2b: cross-scope wikilink resolution (abrain project) ---
      //
      // When target lives at <abrainHome>/projects/<id>/, wikilinks
      // pointing at slugs absent in the project but PRESENT in global
      // abrain knowledge/ or workflows/ must NOT count as dead links.
      // Without this, every project entry that references one of the 4
      // global Linus maxims (e.g. `[[reduce-complexity-...]]`) fires a
      // false-positive deadLink error in doctor-lite after migration.
      {
        const { buildGraphSnapshot, checkBacklinks } = req("./memory/graph.js");
        const csAbrain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-crossscope-abrain-"));
        process.env.ABRAIN_ROOT = csAbrain;
        try {
          const projectId = "cs-test";
          const projDir = path.join(csAbrain, "projects", projectId);
          const kDir = path.join(csAbrain, "knowledge");
          const wDir = path.join(csAbrain, "workflows");
          for (const d of [projDir, kDir, wDir]) fs.mkdirSync(d, { recursive: true });

          // global knowledge entry — the wikilink target.
          writeFile(
            path.join(kDir, "global-maxim.md"),
            `---\nid: world:global-maxim\nscope: world\nkind: maxim\nschema_version: 1\ntitle: Global maxim\nstatus: active\nconfidence: 7\n---\n# Global maxim\n\nBody.\n\n## Timeline\n\n- 2026-05-13 | seed | bootstrapped\n`,
          );
          // global workflow entry.
          writeFile(
            path.join(wDir, "global-workflow.md"),
            `---\nid: workflow:global-workflow\nscope: workflow\nkind: workflow\nschema_version: 1\ntitle: Global workflow\nstatus: active\nconfidence: 5\ncross_project: true\n---\n# Global workflow\n\nBody.\n\n## Timeline\n\n- 2026-05-13 | seed | bootstrapped\n`,
          );
          // project entry: 3 wikilinks — 1 cross-scope hit (knowledge),
          // 1 cross-scope hit (workflow), 1 truly dead. The 3rd one is
          // the dead-link control: it must STILL fire after cross-scope
          // fallback so we don't blanket-suppress legitimate dead links.
          writeFile(
            path.join(projDir, "decisions", "linker.md"),
            `---\nid: project:${projectId}:linker\nscope: project\nkind: decision\nschema_version: 1\ntitle: Linker\nstatus: active\nconfidence: 5\n---\n# Linker\n\nSee [[global-maxim]] and [[global-workflow]] and [[ghost-truly-missing]].\n\n## Timeline\n\n- 2026-05-13 | author | drafted\n`,
          );

          const snap = await buildGraphSnapshot(projDir, memSettings, undefined, projDir);
          assert(
            snap.stats.cross_scope_links.length === 2,
            `cross_scope_links should be 2 (global-maxim + global-workflow), got ${snap.stats.cross_scope_links.length}: ${JSON.stringify(snap.stats.cross_scope_links)}`,
          );
          assert(
            snap.stats.dead_links.length === 1 && snap.stats.dead_links[0].to === "ghost-truly-missing",
            `dead_links should still report ghost-truly-missing only, got ${JSON.stringify(snap.stats.dead_links)}`,
          );
          const crossSlugs = snap.stats.cross_scope_links.map((l) => l.to).sort();
          assert(
            JSON.stringify(crossSlugs) === JSON.stringify(["global-maxim", "global-workflow"]),
            `cross_scope_links targets should be the two globals, got ${JSON.stringify(crossSlugs)}`,
          );

          // checkBacklinks (which doctor-lite uses) must mirror the
          // snapshot: only ghost-truly-missing is reported as dead_link.
          const bl = await checkBacklinks(projDir, memSettings, undefined, projDir);
          assert(
            bl.deadLinkCount === 1,
            `checkBacklinks deadLinkCount should be 1 (cross-scope absorbed 2), got ${bl.deadLinkCount}`,
          );

          // --- legacy .pensieve path: cross-scope must NOT engage there.
          //     Wikilinks in a legacy target should still go to dead_links
          //     because abrainProjectContext returns null outside abrain.
          const legacyParent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-crossscope-legacy-"));
          const legacyTgt = path.join(legacyParent, ".pensieve");
          fs.mkdirSync(path.join(legacyTgt, "decisions"), { recursive: true });
          writeFile(
            path.join(legacyTgt, "decisions", "legacy-link.md"),
            `---\ntitle: Legacy link\nkind: decision\nschema_version: 1\nstatus: active\nconfidence: 5\ncreated: 2026-05-12\n---\n# Legacy link\n\nSee [[global-maxim]].\n\n## Timeline\n\n- 2026-05-12 | author | drafted\n`,
          );
          const legacySnap = await buildGraphSnapshot(legacyTgt, memSettings, undefined, legacyParent);
          assert(
            legacySnap.stats.cross_scope_links.length === 0,
            `legacy .pensieve target must NOT engage cross-scope fallback, got ${JSON.stringify(legacySnap.stats.cross_scope_links)}`,
          );
          assert(
            legacySnap.stats.dead_links.length === 1 && legacySnap.stats.dead_links[0].to === "global-maxim",
            `legacy .pensieve wikilink should fire as dead link, got ${JSON.stringify(legacySnap.stats.dead_links)}`,
          );
          fs.rmSync(legacyParent, { recursive: true, force: true });
        } finally {
          delete process.env.ABRAIN_ROOT;
          fs.rmSync(csAbrain, { recursive: true, force: true });
        }
      }

      // --- Case h.2c: parseWikilinkTarget prefix recognition ---
      //
      // wikilink scope hint parsing: bare slug, known scope prefix
      // (world:/workflow:/project:<id>:), abrain:// URL forms, and
      // user-defined typed-link prefixes (person:/company:) that should
      // be treated as 'unknown' scope. All bare-slug extraction must
      // remain stable across forms.
      {
        const { parseWikilinkTarget } = req("./memory/parser.js");
        const cases = [
          ["foo", { slug: "foo" }],
          ["world:foo", { slug: "foo", scope: "world" }],
          ["workflow:foo", { slug: "foo", scope: "workflow" }],
          ["project:pi-global:foo", { slug: "foo", scope: "project", qualifier: "pi-global" }],
          ["person:alfadb", { slug: "alfadb", scope: "unknown", qualifier: "person" }],
          ["company:openai", { slug: "openai", scope: "unknown", qualifier: "company" }],
          ["abrain://world/patterns/use-at-file-for-long-prompts", { slug: "use-at-file-for-long-prompts", scope: "world" }],
          ["abrain://workflow/run-when-x", { slug: "run-when-x", scope: "workflow" }],
          ["abrain://projects/other-id/decisions/foo", { slug: "foo", scope: "project", qualifier: "other-id" }],
          ["foo|alias", { slug: "foo" }],            // alias stripped
          ["foo#anchor", { slug: "foo" }],           // anchor stripped
          ["world:foo|alias", { slug: "foo", scope: "world" }],
          ["[[world:foo]]", { slug: "foo", scope: "world" }],  // brackets stripped
          ["", { slug: "" }],
          ["   ", { slug: "" }],
          // bare slug containing colon-like char but no recognised prefix:
          // legacy `normalizeBareSlug` semantics — strip everything up to
          // last colon and slugify the remainder.
          ["weird:colon:thing", { slug: "thing", scope: "unknown", qualifier: "weird" }],
        ];
        for (const [input, expected] of cases) {
          const got = parseWikilinkTarget(input);
          for (const key of Object.keys(expected)) {
            assert(
              got[key] === expected[key],
              `parseWikilinkTarget(${JSON.stringify(input)}).${key}: expected ${JSON.stringify(expected[key])}, got ${JSON.stringify(got[key])} (full: ${JSON.stringify(got)})`,
            );
          }
        }
      }

      // --- Case h.2d: graph routes explicit prefix to the right zone ---
      //
      // Explicit `[[world:foo]]` resolves against ~/.abrain/knowledge/;
      // a typo'd `[[world:missing]]` is a genuine dead-link. Explicit
      // `[[workflow:bar]]` resolves against ~/.abrain/workflows/.
      // Unknown-prefix `[[person:x]]` does NOT cross-scope fall back
      // (the prefix itself declares it's not a regular slug).
      {
        const { buildGraphSnapshot } = req("./memory/graph.js");
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-explicit-prefix-"));
        process.env.ABRAIN_ROOT = home;
        try {
          const projectId = "explicit-test";
          const projDir = path.join(home, "projects", projectId);
          const kDir = path.join(home, "knowledge");
          const wDir = path.join(home, "workflows");
          for (const d of [projDir, kDir, wDir]) fs.mkdirSync(d, { recursive: true });
          writeFile(
            path.join(kDir, "global-fact.md"),
            `---\nid: world:global-fact\nscope: world\nkind: fact\nschema_version: 1\ntitle: Global fact\nstatus: active\nconfidence: 7\n---\n# Global fact\n\nBody.\n\n## Timeline\n\n- 2026-05-13 | seed | bootstrapped\n`,
          );
          writeFile(
            path.join(wDir, "global-flow.md"),
            `---\nid: workflow:global-flow\nscope: workflow\nkind: workflow\nschema_version: 1\ntitle: Global flow\nstatus: active\nconfidence: 5\ncross_project: true\n---\n# Global flow\n\nBody.\n\n## Timeline\n\n- 2026-05-13 | seed | bootstrapped\n`,
          );
          writeFile(
            path.join(projDir, "decisions", "linker.md"),
            `---\nid: project:${projectId}:linker\nscope: project\nkind: decision\nschema_version: 1\ntitle: Linker\nstatus: active\nconfidence: 5\n---\n# Linker\n\nExplicit:\n- [[world:global-fact]]      (hits world zone)\n- [[world:does-not-exist]]    (genuine dead even with explicit prefix)\n- [[workflow:global-flow]]    (hits workflow zone)\n- [[person:alfadb]]            (unknown prefix; not fallback)\n\n## Timeline\n\n- 2026-05-13 | author | drafted\n`,
          );
          const snap = await buildGraphSnapshot(projDir, memSettings, undefined, projDir);
          const cs = snap.stats.cross_scope_links.map((l) => l.to).sort();
          const dl = snap.stats.dead_links.map((l) => l.to).sort();
          assert(
            JSON.stringify(cs) === JSON.stringify(["global-fact", "global-flow"]),
            `explicit prefix routing: cross_scope should be [global-fact, global-flow], got ${JSON.stringify(cs)}`,
          );
          assert(
            JSON.stringify(dl) === JSON.stringify(["alfadb", "does-not-exist"]),
            `explicit prefix routing: dead_links should be [alfadb, does-not-exist] (unknown prefix + explicit-typo), got ${JSON.stringify(dl)}`,
          );
        } finally {
          delete process.env.ABRAIN_ROOT;
          fs.rmSync(home, { recursive: true, force: true });
        }
      }

      // --- Case h.2e: rewrite-cross-scope (D-decision rewriter) ---
      //
      // End-to-end rewriter: body wikilinks + frontmatter relations
      // (list-of-scalar, list-of-object {to: ...}, abrain:// URL form),
      // code-block / inline-code skip, idempotence on second pass.
      {
        const { scanRewritePlan, applyRewritePlan } = req("./memory/rewrite-cross-scope.js");
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-rewrite-"));
        process.env.ABRAIN_ROOT = home;
        try {
          const projectId = "rw-test";
          const projDir = path.join(home, "projects", projectId);
          const kDir = path.join(home, "knowledge");
          const wDir = path.join(home, "workflows");
          for (const d of [projDir, kDir, wDir]) fs.mkdirSync(d, { recursive: true });
          writeFile(
            path.join(kDir, "gmax.md"),
            `---\nid: world:gmax\nscope: world\nkind: maxim\nschema_version: 1\ntitle: G-Max\nstatus: active\nconfidence: 7\n---\n# G-Max\n\nBody.\n\n## Timeline\n\n- 2026-05-13 | seed | bootstrapped\n`,
          );
          writeFile(
            path.join(wDir, "gflow.md"),
            `---\nid: workflow:gflow\nscope: workflow\nkind: workflow\nschema_version: 1\ntitle: G-Flow\nstatus: active\nconfidence: 5\ncross_project: true\n---\n# G-Flow\n\nBody.\n\n## Timeline\n\n- 2026-05-13 | seed | bootstrapped\n`,
          );
          // Project-internal entry, used to verify bare-slug-but-also-
          // project-local is NOT rewritten.
          writeFile(
            path.join(projDir, "knowledge", "local-foo.md"),
            `---\nid: project:${projectId}:local-foo\nscope: project\nkind: fact\nschema_version: 1\ntitle: Local foo\nstatus: active\nconfidence: 5\n---\n# Local foo\n\nBody.\n\n## Timeline\n\n- 2026-05-13 | author | drafted\n`,
          );
          // Entry with every rewritable shape that pi-global empirically
          // uses. The `relations:` wrapper key with list-of-object
          // `{to: slug, type: ...}` form is NOT covered — pi-global has
          // zero of those, and parser.ts doesn't read it as a relation
          // source either; rewriter only touches keys in RELATION_KEYS.
          //
          // (a) body bare wikilink hitting world
          // (b) body bare wikilink hitting workflow
          // (c) body bare wikilink hitting project-local (NOT rewritten)
          // (d) body explicit prefix (already done; NOT rewritten)
          // (e) body wikilink inside fenced code (NOT rewritten)
          // (f) body wikilink inside inline code (NOT rewritten)
          // (g) body bare wikilink hitting NOTHING (genuine dead; left as-is)
          // (h) fm derives_from list-of-scalars hitting world
          // (i) fm relates_to abrain:// URL form
          // (j) fm applied_in list-of-scalars hitting workflow (D-keys list)
          writeFile(
            path.join(projDir, "decisions", "mixed.md"),
            [
              `---`,
              `id: project:${projectId}:mixed`,
              `scope: project`,
              `kind: decision`,
              `schema_version: 1`,
              `title: Mixed`,
              `status: active`,
              `confidence: 5`,
              `derives_from:`,
              `  - gmax`,                      // (h) → world:gmax
              `  - local-foo`,                  // project-local; not rewritten
              `  - world:gmax`,                 // already explicit; not rewritten
              `relates_to:`,
              `  - abrain://world/patterns/gmax`,  // (i) URL → world:gmax
              `applied_in:`,
              `  - gflow`,                      // (j) → workflow:gflow
              `---`,
              `# Mixed`,
              ``,
              `Body:`,
              `- [[gmax]] (a)`,
              `- [[gflow]] (b)`,
              `- [[local-foo]] (c project-local)`,
              `- [[world:gmax]] (d already explicit)`,
              `- [[ghost-not-anywhere]] (g genuine dead)`,
              ``,
              "```",
              "// code block — these MUST NOT be rewritten:",
              "// [[gmax]] [[gflow]]",
              "```",
              ``,
              "Inline `[[gmax]]` (f) must also be skipped.",
              ``,
              `## Timeline`,
              ``,
              `- 2026-05-13 | author | drafted`,
              ``,
            ].join("\n"),
          );

          const plan = await scanRewritePlan({ projectDir: projDir, abrainHome: home, settings: memSettings });

          // Expected body changes: (a) gmax → world:gmax; (b) gflow → workflow:gflow.
          // Code-block + inline-code [[gmax]] occurrences MUST NOT count.
          const bodyChanges = plan.entries.flatMap((e) => e.changes).filter((c) => c.location === "body");
          assert(bodyChanges.length === 2, `expected 2 body changes, got ${bodyChanges.length}: ${JSON.stringify(bodyChanges)}`);
          const bodyAfters = bodyChanges.map((c) => c.after).sort();
          assert(
            JSON.stringify(bodyAfters) === JSON.stringify(["[[workflow:gflow]]", "[[world:gmax]]"]),
            `body rewrites incorrect: ${JSON.stringify(bodyAfters)}`,
          );

          // Expected frontmatter changes:
          //   derives_from: gmax → world:gmax
          //   relates_to:  abrain://world/patterns/gmax → world:gmax
          //   relations.to: gflow → workflow:gflow
          const fmChanges = plan.entries.flatMap((e) => e.changes).filter((c) => c.location === "frontmatter");
          assert(fmChanges.length === 3, `expected 3 frontmatter changes, got ${fmChanges.length}: ${JSON.stringify(fmChanges)}`);
          const fmFields = fmChanges.map((c) => `${c.field}:${c.after}`).sort();
          assert(
            JSON.stringify(fmFields) === JSON.stringify([
              "applied_in:workflow:gflow",
              "derives_from:world:gmax",
              "relates_to:world:gmax",
            ]),
            `frontmatter rewrites incorrect: ${JSON.stringify(fmFields)}`,
          );

          // Apply.
          const apply = await applyRewritePlan(plan);
          assert(apply.filesWritten === 1, `expected 1 file written, got ${apply.filesWritten}`);

          // Re-read the written file and verify code-block content is
          // untouched (the literal `[[gmax]]` inside the fenced block
          // must persist).
          const after = fs.readFileSync(path.join(projDir, "decisions", "mixed.md"), "utf-8");
          assert(
            /^\/\/ \[\[gmax\]\] \[\[gflow\]\]/m.test(after),
            `fenced code-block wikilinks must be preserved verbatim:\n${after}`,
          );
          assert(
            /Inline `\[\[gmax\]\]`/.test(after),
            `inline-code wikilink must be preserved verbatim:\n${after}`,
          );
          // (g) genuine dead link must survive.
          assert(
            /\[\[ghost-not-anywhere\]\]/.test(after),
            `genuine dead wikilink must be preserved (not eaten):\n${after}`,
          );

          // Idempotence: second scan must produce zero changes.
          const plan2 = await scanRewritePlan({ projectDir: projDir, abrainHome: home, settings: memSettings });
          assert(
            plan2.totalChanges === 0,
            `idempotence broken: second scan produced ${plan2.totalChanges} changes: ${JSON.stringify(plan2.entries.flatMap((e) => e.changes))}`,
          );
        } finally {
          delete process.env.ABRAIN_ROOT;
          fs.rmSync(home, { recursive: true, force: true });
        }
      }

      // --- Case h.3: migrate-go frontmatter-unparseable note path ---
      // Fixture: a .pensieve entry with frontmatter that's structurally
      // present (delimited by ---) but where parseFrontmatter returns an
      // empty object (e.g. lines that aren't `key: value` scalars). The
      // migration must NOT skip the entry — it must migrate with notes
      // containing "frontmatter-unparseable", per migrate-go.ts:597.
      {
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-fm-unparse-parent-"));
        const abrain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-fm-unparse-abrain-"));
        for (const r of [parent, abrain]) {
          execFileSync("git", ["-C", r, "init", "-q"]);
          execFileSync("git", ["-C", r, "config", "user.email", "smoke@pi-astack.local"]);
          execFileSync("git", ["-C", r, "config", "user.name", "pi-astack smoke"]);
          execFileSync("git", ["-C", r, "config", "commit.gpgsign", "false"]);
          execFileSync("git", ["-C", r, "commit", "-q", "--allow-empty", "-m", "init"]);
        }
        const pensieve = path.join(parent, ".pensieve");
        const decisionsDir = path.join(pensieve, "decisions");
        fs.mkdirSync(decisionsDir, { recursive: true });
        // Frontmatter delimiters present, but body between them does not
        // yield key:value pairs (just a stray non-scalar comment line).
        const badYaml = [
          "---",
          "# stray comment, no key:value pairs at all",
          "---",
          "",
          "# An entry with intact body but blank parseable frontmatter",
          "",
          "## Compiled Truth",
          "",
          "This should still migrate; analyzeEntry must flag the note.",
          "",
          "## Timeline",
          "",
          "- 2026-05-12: created",
          "",
        ].join("\n");
        fs.writeFileSync(path.join(decisionsDir, "unparseable-frontmatter.md"), badYaml);
        execFileSync("git", ["-C", parent, "add", "."]);
        execFileSync("git", ["-C", parent, "commit", "-q", "-m", "seed unparseable entry"]);
        await bindMigrationProject(parent, abrain, "smoke-fm-unparseable");

        const result = await runMigrationGo({
          pensieveTarget: pensieve,
          abrainHome: abrain,
          projectId: "smoke-fm-unparseable",
          cwd: parent,
          settings: DEFAULT_SETTINGS,
          migrationTimestamp: "2026-05-12T12:00:00.000+08:00",
        });
        assert(result.ok === true, `migrate-go should succeed despite unparseable frontmatter, got: ${JSON.stringify(result, null, 2).slice(0, 400)}`);
        const entry = (result.entries || []).find((e) => /unparseable-frontmatter/.test(e.source || ""));
        assert(entry, `migrate-go should report the unparseable entry; entry sources=${JSON.stringify(result.entries?.map((e) => e.source))}`);
        assert(
          Array.isArray(entry.normalizationNotes) && entry.normalizationNotes.includes("frontmatter-unparseable"),
          `unparseable entry must carry normalizationNotes=['frontmatter-unparseable'], got=${JSON.stringify(entry.normalizationNotes)}`,
        );
        assert(entry.action === "migrated", `unparseable entry should still be migrated (notes is informational), got action=${entry.action}`);
        fs.rmSync(parent, { recursive: true, force: true });
        fs.rmSync(abrain, { recursive: true, force: true });
      }

      // --- Case h.4: post-migration writes land in abrain, NOT .pensieve ---
      //
      // History: Round 7 P0-D introduced a `.pensieve/MIGRATED_TO_ABRAIN`
      // guard file so the (then-still-.pensieve-writing) sediment writer
      // would refuse to write to an already-migrated repo. The 2026-05-13
      // sediment cutover removed the guard entirely — sediment writer
      // unconditionally writes into `<abrainHome>/projects/<projectId>/`
      // and the legacy `.pensieve/` is read-only on the migration source
      // side. The guard became dead code (no remaining reader).
      //
      // The replacement contract (this case): after a successful migrate-go,
      //   (1) writeProjectEntry succeeds and writes into the abrain projects
      //       dir, NOT into the post-migrate `.pensieve/`
      //   (2) no `.pensieve/MIGRATED_TO_ABRAIN` flag file exists
      //   (3) the project-side `.pensieve/` tree is untouched by the new
      //       write (legacy entries that survived migration are not
      //       resurrected, deleted entries stay deleted)
      {
        const gParent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-postmigrate-parent-"));
        const gAbrain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-postmigrate-abrain-"));
        for (const r of [gParent, gAbrain]) {
          execFileSync("git", ["-C", r, "init", "-q"]);
          execFileSync("git", ["-C", r, "config", "user.email", "smoke@pi-astack.local"]);
          execFileSync("git", ["-C", r, "config", "user.name", "pi-astack smoke"]);
          execFileSync("git", ["-C", r, "config", "commit.gpgsign", "false"]);
          execFileSync("git", ["-C", r, "commit", "-q", "--allow-empty", "-m", "init"]);
        }
        const pensieve = path.join(gParent, ".pensieve");
        fs.mkdirSync(path.join(pensieve, "maxims"), { recursive: true });
        fs.writeFileSync(path.join(pensieve, "maxims", "x.md"), makeEntry({ title: "X", kind: "maxim" }));
        execFileSync("git", ["-C", gParent, "add", "."]);
        execFileSync("git", ["-C", gParent, "commit", "-q", "-m", "seed"]);
        await bindMigrationProject(gParent, gAbrain, "postmigrate-proj");
        const goRes = await runMigrationGo({
          pensieveTarget: pensieve,
          abrainHome: gAbrain,
          projectId: "postmigrate-proj",
          cwd: gParent,
          settings: DEFAULT_SETTINGS,
          migrationTimestamp: "2026-05-12T12:00:00.000+08:00",
        });
        assert(goRes.ok === true, `postmigrate setup migrate-go must succeed: ${JSON.stringify(goRes.preconditionFailures)}`);

        // (2) No flag file should be written after the 2026-05-13 cutover.
        const flagPath = path.join(gParent, ".pensieve", "MIGRATED_TO_ABRAIN");
        assert(!fs.existsSync(flagPath), `post-2026-05-13 cutover: MIGRATED_TO_ABRAIN must NOT be written, found at ${flagPath}`);

        // (1) writeProjectEntry succeeds on a migrated repo and lands in abrain.
        const postRes = await writeProjectEntry(
          {
            title: "Post-migration write",
            kind: "fact",
            status: "provisional",
            confidence: 5,
            compiledTruth: "# Post-migration write\n\nsediment writes after migration land in abrain, not in the legacy .pensieve/.",
            timelineNote: "smoke-postmigrate",
            sessionId: "smoke-postmigrate",
          },
          { projectRoot: gParent, abrainHome: gAbrain, projectId: "postmigrate-proj", settings: { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: false }, auditContext: { lane: "explicit" } },
        );
        assert(postRes.status === "created", `post-migration writeProjectEntry must create (cutover), got status=${postRes.status} reason=${postRes.reason}`);
        // Entry file lives in abrain projects dir.
        assert(
          postRes.path.startsWith(path.join(gAbrain, "projects", "postmigrate-proj") + path.sep),
          `post-migration write must land in abrain projects dir, got: ${postRes.path}`,
        );
        // (3) The legacy .pensieve/ side must NOT have a fresh entry file.
        assert(
          !fs.existsSync(path.join(gParent, ".pensieve", "facts", "post-migration-write.md")),
          `post-migration write must not also resurrect a copy under .pensieve/`,
        );

        fs.rmSync(gParent, { recursive: true, force: true });
        fs.rmSync(gAbrain, { recursive: true, force: true });
      }

      // --- Case h.5: compareTimestamps TZ-aware semantics ---
      //
      // Round 7 P1 (sonnet audit fix): three call sites (parser dedup
      // tiebreak, llm-search sortForIndex, lint T5) used to lexicographically
      // compare timestamp strings. That breaks across two common cases:
      //   (a) mixed precision: "2026-05-13" (date-only, UTC midnight) vs
      //       "2026-05-13T00:30:00.000+08:00" (= UTC 2026-05-12T16:30,
      //       actually OLDER). String compare returns date-only < full-ISO
      //       => abrain entry wins, but it's actually 7.5h older.
      //   (b) cross-TZ: "2026-05-13T12:00:00.000+08:00" (= UTC 04:00) vs
      //       "2026-05-13T06:00:00.000-05:00" (= UTC 11:00, newer).
      //       String compare puts the +08:00 first; UTC time says -05:00
      //       is newer.
      //
      // Verify compareTimestamps fixes both, and that lexicographic compare
      // would have given the wrong answer (so we know the test is
      // actually exercising the fix path).
      {
        const { compareTimestamps } = req("./memory/utils.js");
        // Case (a): date-only is UTC midnight, full-ISO with +08:00
        // at 00:30 local is UTC 16:30 prior day — older.
        const a1 = "2026-05-13";
        const a2 = "2026-05-13T00:30:00.000+08:00";
        assert(a1.localeCompare(a2) < 0, `precondition: string compare should sort date-only < full-ISO`);
        assert(compareTimestamps(a1, a2) > 0, `compareTimestamps should know date-only UTC midnight > UTC 16:30 prior day, got: ${compareTimestamps(a1, a2)}`);

        // Case (b): cross-TZ — +08:00 noon vs -05:00 morning.
        const b1 = "2026-05-13T12:00:00.000+08:00";  // UTC 04:00
        const b2 = "2026-05-13T06:00:00.000-05:00";  // UTC 11:00 (newer)
        assert(b1.localeCompare(b2) > 0, `precondition: string compare should sort +08:00 noon > -05:00 morning`);
        assert(compareTimestamps(b1, b2) < 0, `compareTimestamps should know -05:00 morning is newer, got: ${compareTimestamps(b1, b2)}`);

        // Identity / undefined handling
        assert(compareTimestamps("2026-05-13", "2026-05-13") === 0, `equal timestamps should compare 0`);
        assert(compareTimestamps(undefined, "2026-05-13") > 0, `undefined should sort last (positive)`);
        assert(compareTimestamps("2026-05-13", undefined) < 0, `defined < undefined`);
        assert(compareTimestamps(undefined, undefined) === 0, `both undefined equal`);
        // Unparseable garbage shouldn't NaN-pollute the sort — garbage should sort last.
        assert(compareTimestamps("not-a-date", "2026-05-13") > 0, `unparseable should sort last (positive)`);
      }

      // --- Case h.6: updateProjectEntry RMW lock-scope (Round 8 P0 fix) ---
      //
      // gpt-5.5 R8 audit P0: updateProjectEntry used to do find+read+merge+lint
      // OUTSIDE the sediment lock and only atomicWrite INSIDE the lock. A
      // concurrent hard-delete in between would unlink the target, then the
      // late atomicWrite would resurrect the entry from a stale raw snapshot.
      // Verify that running with a hard-delete pre-staged to fire "during" the
      // update (we simulate this with sequential async ops in the same
      // process; the lock semantics are validated by the fact that delete
      // commits while update is blocked on acquireLock) does NOT resurrect
      // the entry.
      {
        const raceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-rmw-race-"));
        const raceTarget = setupAbrainTarget("rmw-race");
        // Seed an entry.
        const seedRes = await writeProjectEntry(
          { title: "RMW Race Probe", kind: "fact", status: "active", confidence: 5, compiledTruth: "# RMW Race Probe\n\noriginal body content for race test.", timelineNote: "smoke seed", sessionId: "smoke-rmw" },
          { projectRoot: raceRoot, abrainHome: raceTarget.abrainHome, projectId: raceTarget.projectId, settings: { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: false }, auditContext: { lane: "explicit" } },
        );
        assert(seedRes.status === "created", `seed write should create, got: ${seedRes.status} / ${seedRes.reason}`);
        const targetPath = seedRes.path;
        assert(fs.existsSync(targetPath), `seed entry file should exist at ${targetPath}`);

        // Schedule both update + hard-delete concurrently. The first to
        // acquire the lock proceeds; the second observes the post-state.
        // With the R8 fix, hard-delete-then-update outcome: target gone
        // AND update returns rejected entry_not_found (lookup under lock
        // sees no file). Without the fix, update would resurrect the file.
        const updatePromise = updateProjectEntry(
          "rmw-race-probe",
          { compiledTruth: "# RMW Race Probe\n\nNEW BODY — should not resurrect a deleted entry.", sessionId: "smoke-rmw", timelineNote: "smoke update" },
          { projectRoot: raceRoot, abrainHome: raceTarget.abrainHome, projectId: raceTarget.projectId, settings: { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: false }, auditContext: { lane: "explicit" } },
        );
        const deletePromise = deleteProjectEntry(
          "rmw-race-probe",
          { projectRoot: raceRoot, abrainHome: raceTarget.abrainHome, projectId: raceTarget.projectId, settings: DEFAULT_SEDIMENT_SETTINGS, mode: "hard", reason: "smoke race", sessionId: "smoke-rmw", auditContext: { lane: "explicit" } },
        );
        const [updRes, delRes] = await Promise.all([updatePromise, deletePromise]);

        // Whichever wins the lock first, the post-state MUST be consistent:
        //   Scenario A (delete wins lock first): file gone + update rejected
        //   Scenario B (update wins lock first): file present with NEW BODY +
        //                                         delete then sees file gone or hard-deletes
        // Round 9 P0 (opus R9-3 fix): the original h.6 assertion was
        // too loose. It accepted `updRes.status === "updated"` whenever
        // the file existed at end-of-race — BUT the bug fingerprint is
        // exactly that: when delete reports deleted, file should NOT
        // exist. Resurrection bug: delete unlinks → update lock acquired
        // after delete → atomicWrite reapplies stale-read merge → file
        // reappears with NEW BODY. The old smoke read "NEW BODY present"
        // as proof of "update won lock first", but it's equally
        // consistent with resurrection. Tighten: enforce that delete
        // status and file existence are MUTUALLY EXCLUSIVE.
        const fileExists = fs.existsSync(targetPath);
        const onDisk = fileExists ? fs.readFileSync(targetPath, "utf-8") : null;

        // Invariant 1: delete reporting "deleted" + file existing = resurrection
        if (delRes.status === "deleted" && fileExists) {
          throw new Error(
            `RMW resurrection: delete reported status=deleted but file STILL EXISTS at ${targetPath}\n` +
            `disk content: ${onDisk?.slice(0, 300)}\n` +
            `updRes=${JSON.stringify(updRes)}\ndelRes=${JSON.stringify(delRes)}`,
          );
        }

        // Invariant 2: when file deleted, update must have status "rejected"
        // (delete-won-first; update saw missing file inside lock) OR
        // "updated" (update-won-first; lock-internal atomicWrite happened
        // before delete grabbed lock and unlinked).
        if (!fileExists) {
          if (updRes.status !== "rejected" && updRes.status !== "updated") {
            throw new Error(`unexpected update status when file deleted: ${updRes.status}/${updRes.reason}`);
          }
          // Stronger: if updRes is "rejected", reason must be entry_not_found
          if (updRes.status === "rejected" && updRes.reason !== "entry_not_found") {
            throw new Error(
              `update rejected for unexpected reason in race: ${updRes.reason} ` +
              `(expected entry_not_found when delete-won-first)`,
            );
          }
        } else {
          // File exists. Two valid cases:
          //   (a) update-won-first, then delete saw missing file in its
          //       merge step — delete should be status="absent" or have
          //       not reached its lock yet. delRes.status === "deleted"
          //       with file present is invariant-1 violation, already caught.
          //   (b) update-won-first, delete genuinely failed (e.g. lock
          //       contention timed out). Body must be NEW (merge applied).
          assert(
            /NEW BODY/.test(onDisk),
            `file exists post-race but body is not the merged NEW BODY: ${onDisk.slice(0, 300)}`,
          );
          assert(
            !/original body content for race test/.test(onDisk),
            `file exists with original (pre-update) body — update never ran: ${onDisk.slice(0, 200)}`,
          );
          assert(
            updRes.status === "updated",
            `if file exists with NEW BODY, update must have status=updated, got: ${updRes.status}`,
          );
          // R9: delete should NOT report "deleted" — file is there.
          assert(
            delRes.status !== "deleted",
            `file present but delete reported status=deleted: invariant violation`,
          );
        }

        fs.rmSync(raceRoot, { recursive: true, force: true });
      }

      // --- Case h.7: writeAbrainWorkflow status enum validation (R8 P1) ---
      //
      // gpt-5.5 R8 audit: validateWorkflowDraft only checked
      // `typeof status === "string"`, letting arbitrary strings land in
      // the workflow's frontmatter. Now must reject status NOT in
      // ENTRY_STATUSES.
      {
        const wfRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-wf-enum-"));
        // R9 P1 (opus P2-5 + deepseek P1-3 surface): smoke fixture needs
        // either git init OR settings.gitCommit=false. The new R9 P1
        // orphan-cleanup behavior rejects writes whose gitCommit returns
        // null (orphan file is unlinked + audit row written), so wfRoot
        // without .git was previously "created" with gitCommit=null and
        // now correctly returns rejected/git_commit_failed.
        const wfSettings = { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: false };
        const wfBad = await writeAbrainWorkflow(
          {
            title: "Bad Status Workflow",
            trigger: "on test",
            body: "this body is long enough for workflow validation gate",
            crossProject: true,
            status: "deleted",  // not in ENTRY_STATUSES
          },
          { abrainHome: wfRoot, settings: wfSettings, auditContext: { lane: "workflow" } },
        );
        assert(wfBad.status === "rejected", `bad workflow status must reject, got: ${wfBad.status}`);
        assert(
          /status/i.test(wfBad.reason || "") || /validation/i.test(wfBad.reason || ""),
          `bad workflow status rejection should mention validation, got: ${wfBad.reason}`,
        );

        // Positive: legitimate status enum value must succeed.
        const wfOk = await writeAbrainWorkflow(
          {
            title: "Good Status Workflow",
            trigger: "on test",
            body: "this body is long enough for workflow validation gate",
            crossProject: true,
            status: "active",
          },
          { abrainHome: wfRoot, settings: wfSettings, auditContext: { lane: "workflow" } },
        );
        assert(wfOk.status === "created", `good workflow status should create: ${wfOk.status} / ${wfOk.reason}`);

        // --- R9 P1 (deepseek P1-3): gitCommit null -> orphan cleanup ---
        // Init wfRoot as a git repo so gitCommit attempts run. But there
        // is no remote and the repo is fresh, so git commit will succeed.
        // To force gitCommitAbrain to return null, point gitCommit to a
        // non-git path — simulate by writing into a directory missing .git
        // BUT enabling gitCommit so gitCommitAbrain's `git add` will fail.
        const wfFailRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-wf-orphan-"));
        // do NOT git init: gitCommitAbrain's `git -C <root> add ...` will
        // fail because <root> is not a git repo.
        const wfFailSettings = { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: true };
        const wfOrphan = await writeAbrainWorkflow(
          {
            title: "Orphan Cleanup Probe",
            trigger: "on test",
            body: "this body is long enough for workflow validation gate",
            crossProject: true,
            status: "active",
          },
          { abrainHome: wfFailRoot, settings: wfFailSettings, auditContext: { lane: "workflow" } },
        );
        assert(
          wfOrphan.status === "rejected" && wfOrphan.reason === "git_commit_failed",
          `R9 P1: gitCommit-null path must reject + cleanup, got: ${JSON.stringify(wfOrphan)}`,
        );
        // R9 P1: file must be unlinked (no orphan on disk)
        const orphanTarget = path.join(wfFailRoot, "workflows", "orphan-cleanup-probe.md");
        assert(
          !fs.existsSync(orphanTarget),
          `R9 P1: orphan file must be cleaned, but still exists: ${orphanTarget}`,
        );
        // R9 P1: audit row must record the orphan cleanup
        const wfAuditPath = path.join(wfFailRoot, ".state", "sediment", "audit.jsonl");
        if (fs.existsSync(wfAuditPath)) {
          const rows = fs.readFileSync(wfAuditPath, "utf-8").trim().split("\n").filter(Boolean).map(JSON.parse);
          const orphanRow = rows.find((r) => r.reason === "git_commit_failed_orphan_cleaned");
          assert(orphanRow, `R9 P1: audit must contain git_commit_failed_orphan_cleaned row, got: ${rows.map((r) => r.operation + "/" + (r.reason || "")).join(",")}`);
        }
        fs.rmSync(wfFailRoot, { recursive: true, force: true });
        fs.rmSync(wfRoot, { recursive: true, force: true });
      }

      // --- Case h.8: frontmatterPatch protected key denylist (R8 P1) ---
      //
      // gpt-5.5 R8 audit: updateProjectEntry used to let frontmatterPatch
      // overwrite system-managed keys (id/scope/kind/status/confidence/etc).
      // Now must throw an Error mentioning the protected key.
      {
        const denyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-fmpatch-deny-"));
        const denyTarget = setupAbrainTarget("fmpatch-deny");
        const seed = await writeProjectEntry(
          { title: "Patch Denylist Probe", kind: "fact", status: "active", confidence: 5, compiledTruth: "# Patch Denylist Probe\n\nsome body content here.", timelineNote: "seed", sessionId: "smoke-deny" },
          { projectRoot: denyRoot, abrainHome: denyTarget.abrainHome, projectId: denyTarget.projectId, settings: DEFAULT_SEDIMENT_SETTINGS, auditContext: { lane: "explicit" } },
        );
        assert(seed.status === "created", `seed write should create: ${seed.status}`);

        // Attempt to override `kind` (a protected key) via frontmatterPatch.
        // The throw inside mergeUpdateMarkdown is caught by updateProjectEntry's
        // lock-internal try/catch which converts it to status="rejected" +
        // reason carrying the error message — NOT an awaited throw.
        const denyKind = await updateProjectEntry(
          "patch-denylist-probe",
          { compiledTruth: "# Patch Denylist Probe\n\nupdated body content here.", sessionId: "smoke-deny", frontmatterPatch: { kind: "workflow" } },
          { projectRoot: denyRoot, abrainHome: denyTarget.abrainHome, projectId: denyTarget.projectId, settings: DEFAULT_SEDIMENT_SETTINGS, auditContext: { lane: "explicit" } },
        );
        assert(denyKind.status === "rejected", `frontmatterPatch protected key 'kind' must be rejected, got: ${denyKind.status}`);
        assert(
          /protected key 'kind'/.test(denyKind.reason || ""),
          `protected key rejection should mention 'kind', got reason: ${denyKind.reason}`,
        );

        // Bad key shape (newline injection attempt) must also be rejected.
        const denyBadKey = await updateProjectEntry(
          "patch-denylist-probe",
          { compiledTruth: "# Patch Denylist Probe\n\nupdated body content here.", sessionId: "smoke-deny", frontmatterPatch: { "good\ninjected": "x" } },
          { projectRoot: denyRoot, abrainHome: denyTarget.abrainHome, projectId: denyTarget.projectId, settings: DEFAULT_SEDIMENT_SETTINGS, auditContext: { lane: "explicit" } },
        );
        assert(denyBadKey.status === "rejected", `frontmatterPatch bad key shape must be rejected, got: ${denyBadKey.status}`);
        assert(
          /invalid characters/.test(denyBadKey.reason || ""),
          `bad key shape rejection should mention invalid characters, got reason: ${denyBadKey.reason}`,
        );

        // trigger_phrases is protected because it must go through the
        // dedicated triggerPhrases union + sanitizer path, not raw
        // frontmatterPatch replacement.
        const denyTriggerPhrases = await updateProjectEntry(
          "patch-denylist-probe",
          { compiledTruth: "# Patch Denylist Probe\n\nupdated body content here.", sessionId: "smoke-deny", frontmatterPatch: { trigger_phrases: ["replace anchors"] } },
          { projectRoot: denyRoot, abrainHome: denyTarget.abrainHome, projectId: denyTarget.projectId, settings: DEFAULT_SEDIMENT_SETTINGS, auditContext: { lane: "explicit" } },
        );
        assert(denyTriggerPhrases.status === "rejected", `frontmatterPatch protected key 'trigger_phrases' must be rejected, got: ${denyTriggerPhrases.status}`);
        assert(
          /protected key 'trigger_phrases'/.test(denyTriggerPhrases.reason || ""),
          `trigger_phrases protected-key rejection should mention trigger_phrases, got reason: ${denyTriggerPhrases.reason}`,
        );

        // Non-protected key still works (positive case).
        const okPatch = await updateProjectEntry(
          "patch-denylist-probe",
          { compiledTruth: "# Patch Denylist Probe\n\nupdated body content here.", sessionId: "smoke-deny", frontmatterPatch: { tags: ["r8-smoke"] } },
          { projectRoot: denyRoot, abrainHome: denyTarget.abrainHome, projectId: denyTarget.projectId, settings: DEFAULT_SEDIMENT_SETTINGS, auditContext: { lane: "explicit" } },
        );
        assert(okPatch.status === "updated", `non-protected frontmatterPatch should succeed: ${okPatch.status} / ${okPatch.reason}`);
        const onDisk = fs.readFileSync(okPatch.path, "utf-8");
        assert(/^tags:/m.test(onDisk), `non-protected patch should write 'tags:' to frontmatter; got: ${onDisk.slice(0, 400)}`);
        fs.rmSync(denyRoot, { recursive: true, force: true });
      }

      // 2026-05-15 multi-LLM audit (memory subsystem): roadmap listed
      // "sediment update/merge unknown frontmatter preservation" as a
      // backlog item lacking systematic coverage. writer.ts has the
      // mechanism (`...frontmatter` spread in `nextFrontmatter` +
      // `renderFrontmatter(_, originalOrder)`) but no fixture exercised
      // the round-trip. This block does — if any future refactor drops
      // unknown keys, smoke fails loudly.
      {
        const preRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-fm-preserve-"));
        const preTarget = setupAbrainTarget("fm-preserve");
        const preOpts = { projectRoot: preRoot, abrainHome: preTarget.abrainHome, projectId: preTarget.projectId, settings: DEFAULT_SEDIMENT_SETTINGS, auditContext: { lane: "explicit" } };

        // Step 1: seed an entry via the normal writer path.
        const seed = await writeProjectEntry(
          { title: "Frontmatter Preservation Probe", kind: "fact", status: "active", confidence: 5, compiledTruth: "# Frontmatter Preservation Probe\n\nseed body content here.", timelineNote: "seed", sessionId: "smoke-fmp" },
          preOpts,
        );
        assert(seed.status === "created", `fm-preserve seed must create: ${seed.status} / ${seed.reason}`);

        // Step 2: simulate the situation we actually need to defend
        // against — a legacy / hand-written entry that carries unknown
        // frontmatter fields (e.g. tags, source, custom_url, a multi-
        // line array) that aren't in the canonical writer schema. We
        // inject them directly into the on-disk file because the public
        // writer API does not accept arbitrary unknown keys at create
        // time (only via frontmatterPatch on update). This mirrors how
        // migrate-go imports preserve unknown fields from legacy
        // .pensieve entries.
        const seedRaw = fs.readFileSync(seed.path, "utf-8");
        const injected = seedRaw.replace(
          /^---\n/,
          "---\nlegacy_source: hand-written\nlegacy_custom_url: https://example.org/x\nlegacy_tags:\n  - alpha\n  - beta\nlegacy_complex:\n  - nested-a\n  - nested-b\n  - nested-c\n",
        );
        assert(injected !== seedRaw, "injection sentinel marker missing");
        fs.writeFileSync(seed.path, injected);

        // Step 3: update with NO frontmatterPatch — unknown keys must
        // survive the read-modify-write cycle. This is the headline
        // contract: "update body, don't lose anything from frontmatter."
        const upd1 = await updateProjectEntry(
          "frontmatter-preservation-probe",
          { compiledTruth: "# Frontmatter Preservation Probe\n\nfirst update body.", sessionId: "smoke-fmp" },
          preOpts,
        );
        assert(upd1.status === "updated", `fm-preserve update 1 must succeed: ${upd1.status} / ${upd1.reason}`);
        const disk1 = fs.readFileSync(seed.path, "utf-8");
        assert(/^legacy_source: hand-written$/m.test(disk1), `unknown scalar 'legacy_source' must survive update; got:\n${disk1.slice(0, 600)}`);
        assert(/^legacy_custom_url: https:\/\/example\.org\/x$/m.test(disk1), `unknown scalar 'legacy_custom_url' must survive update; got:\n${disk1.slice(0, 600)}`);
        assert(/^legacy_tags:\n  - alpha\n  - beta$/m.test(disk1), `unknown array 'legacy_tags' must survive (incl. order); got:\n${disk1.slice(0, 600)}`);
        assert(/^legacy_complex:\n  - nested-a\n  - nested-b\n  - nested-c$/m.test(disk1), `unknown 3-element array 'legacy_complex' must survive; got:\n${disk1.slice(0, 600)}`);

        // Step 4: update WITH a non-protected frontmatterPatch —
        // unknown keys must STILL survive alongside the new tag.
        const upd2 = await updateProjectEntry(
          "frontmatter-preservation-probe",
          { compiledTruth: "# Frontmatter Preservation Probe\n\nsecond update body.", sessionId: "smoke-fmp", frontmatterPatch: { tags: ["new-tag"] } },
          preOpts,
        );
        assert(upd2.status === "updated", `fm-preserve update 2 must succeed: ${upd2.status} / ${upd2.reason}`);
        const disk2 = fs.readFileSync(seed.path, "utf-8");
        assert(/^legacy_source: hand-written$/m.test(disk2), `unknown scalar must survive after frontmatterPatch too; got:\n${disk2.slice(0, 600)}`);
        assert(/^legacy_tags:\n  - alpha\n  - beta$/m.test(disk2), `unknown array must survive after frontmatterPatch too; got:\n${disk2.slice(0, 600)}`);
        assert(/^tags:\n  - new-tag$/m.test(disk2), `new patched 'tags' must be written; got:\n${disk2.slice(0, 600)}`);

        // Step 5: protected keys must NOT be duplicated or garbled by
        // the update + unknown-preservation interaction — i.e. only one
        // `kind:` line, one `status:` line, etc. (Earlier writer bug
        // could have left two `updated:` lines after merging.)
        for (const key of ["id", "scope", "kind", "status", "confidence", "schema_version", "title", "created", "updated"]) {
          const occurrences = disk2.split("\n").filter((l) => new RegExp(`^${key}:`).test(l)).length;
          assert(occurrences === 1, `protected key '${key}' must appear exactly once in frontmatter, found ${occurrences}; on-disk:\n${disk2.slice(0, 600)}`);
        }

        // Step 6: roundtrip via parser — the entry must still be parsable
        // as a valid MemoryEntry, kind/status normalized, unknown fields
        // visible in entry.frontmatter for downstream tools (doctor).
        const { parseEntry } = req("./memory/parser.js");
        const parsed = await parseEntry(seed.path, { scope: "project", root: preTarget.abrainHome, label: "abrain-project" }, preRoot);
        assert(parsed, `parseEntry must yield an entry after update with unknown fm; sourcePath=${seed.path}`);
        assert(parsed.kind === "fact", `kind survives parseEntry: ${parsed.kind}`);
        assert(parsed.status === "active", `status survives parseEntry: ${parsed.status}`);
        assert(parsed.frontmatter.legacy_source === "hand-written", `parser exposes unknown scalar via .frontmatter: ${JSON.stringify(parsed.frontmatter.legacy_source)}`);
        assert(Array.isArray(parsed.frontmatter.legacy_tags) && parsed.frontmatter.legacy_tags.length === 2, `parser exposes unknown array via .frontmatter: ${JSON.stringify(parsed.frontmatter.legacy_tags)}`);

        fs.rmSync(preRoot, { recursive: true, force: true });
      }
    }

    // === ADR 0026 §3.4 P1.A: outcome-ledger read + summarize + brief wiring ===
    //
    // Three things to lock:
    //   1. readOutcomeLedger() honors ABRAIN_ROOT and tolerates corrupt rows
    //   2. summarizeEntryActivity() counts decisive/confirmatory/retrieved-unused
    //      correctly, respects the 30-day window, and emits zero records
    //      for slugs absent from the ledger.
    //   3. buildDecisionBriefPrompt() injects the activity into the prompt
    //      under "RECENT USAGE OF THESE ENTRIES".
    {
      const { collectOutcomes, readOutcomeLedger, summarizeEntryActivity, writeOutcomeLedger } = req("./sediment/outcome-collector.js");
      const { buildDecisionBriefPrompt, buildDecisionSearchQuery } = req("./memory/decide.js");

      const ledgerAbrain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-ledger-"));
      const savedAbrainRoot = process.env.ABRAIN_ROOT;
      process.env.ABRAIN_ROOT = ledgerAbrain;
      try {
        // Empty ledger — readOutcomeLedger must return [] without throwing.
        const emptyRows = readOutcomeLedger();
        assert(Array.isArray(emptyRows) && emptyRows.length === 0, `readOutcomeLedger on missing file should return [], got ${JSON.stringify(emptyRows)}`);

        // Seed a ledger with mixed sources, valid + corrupt rows, and one
        // out-of-window row (older than 30 days).
        const sedimentDir = path.join(ledgerAbrain, ".state", "sediment");
        fs.mkdirSync(sedimentDir, { recursive: true });
        const now = Date.now();
        const recent = (offsetDays) => new Date(now - offsetDays * 24 * 60 * 60 * 1000).toISOString();
        const ledgerLines = [
          JSON.stringify({ ts: recent(1), session_id: "s1", entry_slug: "prefer-pnpm", source: "memory-footnote", used: "decisive", counterfactual: "would have used yarn", retrieval_count: 1 }),
          JSON.stringify({ ts: recent(2), session_id: "s1", entry_slug: "prefer-pnpm", source: "tool-result", retrieval_count: 3 }),
          JSON.stringify({ ts: recent(5), session_id: "s2", entry_slug: "prefer-pnpm", source: "memory-footnote", used: "decisive", counterfactual: "same", retrieval_count: 1 }),
          JSON.stringify({ ts: recent(7), session_id: "s3", entry_slug: "prefer-pnpm", source: "memory-footnote", used: "confirmatory", counterfactual: "would have decided same way", retrieval_count: 1 }),
          JSON.stringify({ ts: recent(10), session_id: "s4", entry_slug: "ci-github-actions", source: "memory-footnote", used: "retrieved-unused", counterfactual: "not relevant to current task", retrieval_count: 1 }),
          JSON.stringify({ ts: recent(45), session_id: "sold", entry_slug: "prefer-pnpm", source: "memory-footnote", used: "decisive", counterfactual: "out-of-window", retrieval_count: 1 }),
          "<<<corrupt non-json line>>>",
          "",
          JSON.stringify({ ts: recent(3), entry_slug: "", source: "memory-footnote", retrieval_count: 1 }), // missing session_id but valid entry_slug="" is also dropped by isValidSlug? No, here entry_slug="" so it should still be read but summarize will not match anything in slugs list anyway.
        ];
        fs.writeFileSync(path.join(sedimentDir, "outcome-ledger.jsonl"), ledgerLines.join("\n") + "\n");

        const rows = readOutcomeLedger();
        assert(rows.length >= 7, `readOutcomeLedger should parse all valid rows and skip the corrupt one; got ${rows.length}`);
        assert(rows.some((r) => r.entry_slug === "prefer-pnpm" && r.used === "decisive"), `read rows must include the decisive prefer-pnpm row`);

        // Summarize within the 30-day window for three slugs:
        //   prefer-pnpm   → 2 decisive + 1 confirmatory (in window), 0 retrieved-unused,
        //                  total_retrievals = 3 (tool-result only; footnote
        //                  self-reports are counted in the usage buckets, not
        //                  double-counted as tool retrievals)
        //                  (45-day-old row excluded)
        //   ci-github-actions → 0 decisive, 0 confirmatory, 1 retrieved-unused, total=0
        //   cold-slug-never-seen → all zeros
        const stats = summarizeEntryActivity(rows, ["prefer-pnpm", "ci-github-actions", "cold-slug-never-seen"], 30);
        assert(stats.length === 3, `summarizeEntryActivity should return one record per input slug, got ${stats.length}`);
        assert(stats[0].slug === "prefer-pnpm", `slug order should match input`);

        const pnpm = stats[0];
        assert(pnpm.decisive_count === 2, `prefer-pnpm decisive_count should be 2 (45-day-old excluded), got ${pnpm.decisive_count}`);
        assert(pnpm.confirmatory_count === 1, `prefer-pnpm confirmatory_count should be 1, got ${pnpm.confirmatory_count}`);
        assert(pnpm.retrieved_unused_count === 0, `prefer-pnpm retrieved_unused_count should be 0, got ${pnpm.retrieved_unused_count}`);
        assert(pnpm.decisive_streak === 2, `prefer-pnpm decisive_streak should count the latest consecutive decisive tail, got ${pnpm.decisive_streak}`);
        assert(pnpm.possible_echo_chamber === false, `prefer-pnpm should not trip echo breaker below streak threshold: ${JSON.stringify(pnpm)}`);
        assert(pnpm.total_retrievals === 3, `prefer-pnpm total_retrievals should count tool-result rows only (3), got ${pnpm.total_retrievals}`);
        assert(typeof pnpm.last_seen === "string" && pnpm.last_seen.length > 10, `prefer-pnpm should have a last_seen timestamp`);

        const ciSlug = stats[1];
        assert(ciSlug.retrieved_unused_count === 1, `ci-github-actions retrieved_unused_count should be 1, got ${ciSlug.retrieved_unused_count}`);
        assert(ciSlug.decisive_count === 0, `ci-github-actions decisive_count should be 0`);
        assert(ciSlug.total_retrievals === 0, `ci-github-actions total_retrievals should ignore footnote-only rows, got ${ciSlug.total_retrievals}`);

        const cold = stats[2];
        assert(cold.decisive_count === 0 && cold.confirmatory_count === 0 && cold.total_retrievals === 0, `cold slug should be all-zero, got ${JSON.stringify(cold)}`);
        assert(cold.decisive_streak === 0 && cold.possible_echo_chamber === false, `cold slug should not trip echo breaker, got ${JSON.stringify(cold)}`);
        assert(cold.last_seen === undefined, `cold slug should have undefined last_seen`);

        const echoRows = [6, 5, 4, 3, 2].map((offsetDays, i) => ({
          ts: recent(offsetDays),
          session_id: `echo-${i}`,
          entry_slug: "echo-prone-entry",
          source: "memory-footnote",
          used: "decisive",
          counterfactual: `decisive ${i}`,
          retrieval_count: 1,
        }));
        const echoStats = summarizeEntryActivity(echoRows, ["echo-prone-entry"], 30)[0];
        assert(echoStats.decisive_streak === 5, `echo-prone entry should have decisive_streak=5, got ${JSON.stringify(echoStats)}`);
        assert(echoStats.possible_echo_chamber === true, `echo-prone entry should trip possible_echo_chamber, got ${JSON.stringify(echoStats)}`);
        const interruptedEcho = summarizeEntryActivity([
          ...echoRows,
          { ts: recent(1), session_id: "echo-stop", entry_slug: "echo-prone-entry", source: "memory-footnote", used: "retrieved-unused", counterfactual: "not relevant now", retrieval_count: 1 },
        ], ["echo-prone-entry"], 30)[0];
        assert(interruptedEcho.decisive_streak === 0 && interruptedEcho.possible_echo_chamber === false, `non-decisive tail should reset echo streak, got ${JSON.stringify(interruptedEcho)}`);

        // Verify collectOutcomes can attribute memory_decide tool results
        // back to concrete entry slugs, including the structured
        // decisionBriefId. This locks the ADR 0026 read→outcome feedback
        // loop added after memory_decide started returning only brief text.
        const decidedBranch = [
          {
            type: "message",
            message: {
              role: "toolResult",
              toolName: "memory_decide",
              content: [{
                type: "text",
                text: JSON.stringify({
                  ok: true,
                  brief: "Prefer pnpm.",
                  _meta: {
                    entrySlugs: ["prefer-pnpm", "ci-github-actions"],
                    decisionBriefId: "decision-brief-smoke-1",
                  },
                }),
              }],
            },
          },
        ];
        const decidedOutcomes = collectOutcomes(decidedBranch, "session-memory-decide-smoke");
        assert(decidedOutcomes.dropped.length === 0, `memory_decide tool-result should not produce dropped footnotes: ${JSON.stringify(decidedOutcomes.dropped)}`);
        assert(decidedOutcomes.rows.length === 2, `memory_decide should yield one tool-result row per unique slug, got ${JSON.stringify(decidedOutcomes.rows)}`);
        for (const slug of ["prefer-pnpm", "ci-github-actions"]) {
          const row = decidedOutcomes.rows.find((r) => r.entry_slug === slug);
          assert(row, `missing memory_decide outcome row for ${slug}: ${JSON.stringify(decidedOutcomes.rows)}`);
          assert(row.source === "tool-result", `memory_decide row source must be tool-result: ${JSON.stringify(row)}`);
          assert(row.event_id === "decision:decision-brief-smoke-1", `memory_decide row must get stable decision event_id: ${JSON.stringify(row)}`);
          assert(row.retrieval_count === 1, `memory_decide row should count one retrieval per unique slug per tool result, got ${JSON.stringify(row)}`);
          assert(row.decision_brief_id === "decision-brief-smoke-1", `memory_decide row must preserve decision_brief_id: ${JSON.stringify(row)}`);
        }

        const footnoteBranch = [
          {
            type: "message",
            message: {
              role: "assistant",
              content: "```memory-footnote\nentry: prefer-pnpm\nused: decisive\ndecision_brief_id: decision-brief-smoke-1\ncounterfactual: would have used yarn\n```",
            },
          },
        ];
        const footnoteOutcomes = collectOutcomes(footnoteBranch, "session-memory-decide-smoke");
        assert(footnoteOutcomes.rows.length === 1, `decision footnote should yield one row: ${JSON.stringify(footnoteOutcomes)}`);
        assert(footnoteOutcomes.rows[0].decision_brief_id === "decision-brief-smoke-1", `footnote row must preserve decision_brief_id: ${JSON.stringify(footnoteOutcomes.rows[0])}`);
        assert(footnoteOutcomes.rows[0].event_id && footnoteOutcomes.rows[0].event_id.includes("decision-brief-smoke-1"), `footnote row should include stable event_id: ${JSON.stringify(footnoteOutcomes.rows[0])}`);

        const shiftedFootnoteBranch = [
          { type: "message", message: { role: "user", content: "unrelated earlier message inserted by branch rewrite" } },
          footnoteBranch[0],
        ];
        const shiftedFootnoteOutcomes = collectOutcomes(shiftedFootnoteBranch, "session-memory-decide-smoke");
        assert(shiftedFootnoteOutcomes.rows[0].event_id === footnoteOutcomes.rows[0].event_id, `decision footnote event_id must not drift when branch index shifts: before=${JSON.stringify(footnoteOutcomes.rows[0])} after=${JSON.stringify(shiftedFootnoteOutcomes.rows[0])}`);

        const plainFootnoteBranch = [
          { type: "message", message: { role: "assistant", content: "```memory-footnote\nentry: prefer-pnpm\nused: confirmatory\ncounterfactual: same decision\n```" } },
        ];
        const shiftedPlainFootnoteBranch = [
          { type: "message", message: { role: "user", content: "unrelated earlier message inserted by branch rewrite" } },
          plainFootnoteBranch[0],
        ];
        const plainFootnoteRows = collectOutcomes(plainFootnoteBranch, "session-plain-footnote-drift-smoke").rows;
        const shiftedPlainFootnoteRows = collectOutcomes(shiftedPlainFootnoteBranch, "session-plain-footnote-drift-smoke").rows;
        assert(plainFootnoteRows[0].event_id === shiftedPlainFootnoteRows[0].event_id, `plain footnote event_id must not drift when branch index shifts: before=${JSON.stringify(plainFootnoteRows[0])} after=${JSON.stringify(shiftedPlainFootnoteRows[0])}`);

        const secretFootnoteRows = collectOutcomes([
          { type: "message", message: { role: "assistant", content: "```memory-footnote\nentry: prefer-pnpm\nused: decisive\ncounterfactual: would use ghp_1234567890abcdefghijklmnopqrstuv\n```" } },
        ], "session-secret-footnote-smoke").rows;
        assert(secretFootnoteRows.length === 1, `secret footnote should still parse after sanitization: ${JSON.stringify(secretFootnoteRows)}`);
        assert(!JSON.stringify(secretFootnoteRows).includes("ghp_1234567890abcdefghijklmnopqrstuv") && JSON.stringify(secretFootnoteRows).includes("[SECRET:github_token]"), `footnote counterfactual must be sanitized before ledger: ${JSON.stringify(secretFootnoteRows)}`);
        const droppedSecret = collectOutcomes([
          { type: "message", message: { role: "assistant", content: "```memory-footnote\nentry: <slug>\nused: decisive\ncounterfactual: ghp_1234567890abcdefghijklmnopqrstuv\n```" } },
        ], "session-secret-footnote-drop-smoke").dropped;
        assert(droppedSecret.length === 1 && !JSON.stringify(droppedSecret).includes("ghp_1234567890abcdefghijklmnopqrstuv") && JSON.stringify(droppedSecret).includes("[SECRET:github_token]"), `dropped footnote preview must be sanitized: ${JSON.stringify(droppedSecret)}`);

        const searchBranch = [
          {
            type: "message",
            message: {
              role: "toolResult",
              toolName: "memory_search",
              content: [{ type: "text", text: JSON.stringify([{ slug: "prefer-pnpm" }]) }],
            },
          },
        ];
        const shiftedSearchBranch = [
          { type: "message", message: { role: "user", content: "unrelated earlier message inserted by branch rewrite" } },
          searchBranch[0],
        ];
        const searchRows = collectOutcomes(searchBranch, "session-search-index-drift-smoke").rows;
        const shiftedSearchRows = collectOutcomes(shiftedSearchBranch, "session-search-index-drift-smoke").rows;
        assert(searchRows[0].event_id === shiftedSearchRows[0].event_id, `tool-result fallback event_id must not drift when branch index shifts: before=${JSON.stringify(searchRows[0])} after=${JSON.stringify(shiftedSearchRows[0])}`);

        // Live agent_end sees the full branch every turn. writeOutcomeLedger
        // must durably dedupe so repeated full-branch scans only add new
        // evidence, not earlier events again.
        fs.writeFileSync(path.join(sedimentDir, "outcome-ledger.jsonl"), "");
        writeOutcomeLedger(decidedOutcomes.rows, "/tmp/pi-astack-smoke-project");
        const longerBranch = [
          ...decidedBranch,
          {
            type: "message",
            message: {
              role: "toolResult",
              toolName: "memory_get",
              content: [{ type: "text", text: JSON.stringify({ slug: "cold-slug-never-seen" }) }],
            },
          },
        ];
        writeOutcomeLedger(collectOutcomes(longerBranch, "session-memory-decide-smoke").rows, "/tmp/pi-astack-smoke-project");
        const dedupedRows = readOutcomeLedger().filter((r) => r.session_id === "session-memory-decide-smoke" && r.source === "tool-result");
        assert(dedupedRows.length === 3, `writeOutcomeLedger should dedupe prior full-branch rows and add only the new event, got ${JSON.stringify(dedupedRows)}`);

        // Verify memory_decide retrieval query includes all decision inputs,
        // not only `context`. This guards ADR 0026 recall quality: option
        // names and constraints are often the only strings that match prior
        // memories.
        const query = buildDecisionSearchQuery({
          context: "choosing deployment target for a small Next.js app",
          options: ["Vercel", "Fly.io"],
          constraints: "must support cron jobs and monorepo deploys",
        });
        assert(/choosing deployment target/.test(query), `decision search query must include context; query was:\n${query}`);
        assert(/Vercel/.test(query) && /Fly\.io/.test(query), `decision search query must include options; query was:\n${query}`);
        assert(/cron jobs/.test(query) && /monorepo deploys/.test(query), `decision search query must include constraints; query was:\n${query}`);
        assert(/Chinese\/English/.test(query), `decision search query should preserve cross-language retrieval instruction; query was:\n${query}`);

        // Verify prompt builder injects the section. We don't grade the
        // LLM output — we only assert the activity table renders into
        // the prompt with the right slug → counts mapping. The LLM is the
        // weighting layer, per ADR 0024 §3.
        const prompt = buildDecisionBriefPrompt({
          context: "choosing package manager for new React project",
          options: ["pnpm", "yarn"],
          constraints: "",
          entries: [
            { slug: "prefer-pnpm", title: "Prefer pnpm", kind: "preference", status: "active", confidence: 9, compiledTruth: "User prefers pnpm.", retrievalLowConfidence: true, retrievalVerdict: "none" },
            { slug: "ci-github-actions", title: "CI on Actions", kind: "decision", status: "active", confidence: 7, compiledTruth: "User uses GH Actions." },
            { slug: "cold-slug-never-seen", title: "Cold", kind: "fact", status: "active", confidence: 4, compiledTruth: "Cold fact." },
          ],
          activity: [...stats, echoStats],
          activityWindowDays: 30,
        });
        assert(/RECENT USAGE OF THESE ENTRIES/.test(prompt), `prompt must include RECENT USAGE section header`);
        assert(/prefer-pnpm: decisive=2, confirmatory=1, decisive_streak=2, total_retrievals=3/.test(prompt), `prompt should show prefer-pnpm counts in canonical format; prompt was:\n${prompt}`);
        assert(/ci-github-actions: retrieved_unused=1/.test(prompt) && !/ci-github-actions:.*total_retrievals=1/.test(prompt), `prompt should show ci-github-actions footnote usage without fake retrieval count; prompt was:\n${prompt}`);
        assert(/cold-slug-never-seen: no signals/.test(prompt), `cold slug should be tagged 'no signals' in prompt`);
        assert(/possible_echo_chamber=true/.test(prompt) && /pending reconfirmation/.test(prompt), `prompt must surface echo-chamber breaker and downgrade instruction; prompt was:\n${prompt}`);
        assert(/total_retrievals counts tool invocations, not unique sessions/.test(prompt), `prompt must warn that total_retrievals can be inflated by repeated searches: ${prompt}`);
        assert(/metadata: status=/.test(prompt) && /confidence=/.test(prompt), `prompt must expose memory status/confidence metadata to support uncertainty instructions: ${prompt}`);
        assert(/retrieval: verdict=none \| low_confidence=true/.test(prompt), `prompt must expose low-confidence retrieval quality to memory_decide synthesis: ${prompt}`);
        assert(/low_confidence=true, treat that memory as a weak/.test(prompt), `prompt must instruct memory_decide synthesis to discount low-confidence retrievals: ${prompt}`);
        assert(/CONTRADICTION CHECK INPUTS/.test(prompt) && /prefer-pnpm: kind=preference/.test(prompt), `prompt must expose high-confidence active memories for contradiction detection: ${prompt}`);
        assert(/No direct\s+contradiction detected/.test(prompt), `prompt must require an explicit contradiction-check section: ${prompt}`);
        assert(/Do NOT apply hard thresholds/.test(prompt), `prompt must instruct LLM to weight by judgment not threshold (ADR 0024 §3 AI-Native)`);

        // All-zero activity path: prompt should still emit a clarifying
        // sentence rather than silently dropping the section.
        const zeroPrompt = buildDecisionBriefPrompt({
          context: "x",
          options: [],
          constraints: "",
          entries: [{ slug: "cold-slug-never-seen", title: "Cold", kind: "fact", compiledTruth: "Cold fact." }],
          activity: [stats[2]],
          activityWindowDays: 30,
        });
        assert(/no outcome history recorded for any of these entries in the last 30 days/.test(zeroPrompt), `all-zero activity must render a clarifying sentence not a blank section`);
      } finally {
        if (savedAbrainRoot === undefined) delete process.env.ABRAIN_ROOT;
        else process.env.ABRAIN_ROOT = savedAbrainRoot;
        fs.rmSync(ledgerAbrain, { recursive: true, force: true });
      }
    }

    console.log(JSON.stringify({ ok: true, transpiledFiles: count, tools: [...tools.keys()], commands: [...commands.keys()] }, null, 2));
  } finally {
    if (savedSettingsPath === undefined) delete process.env.PI_ASTACK_SETTINGS_PATH;
    else process.env.PI_ASTACK_SETTINGS_PATH = savedSettingsPath;
    if (process.env.PI_ASTACK_KEEP_SMOKE_TMP !== "1") fs.rmSync(outRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
