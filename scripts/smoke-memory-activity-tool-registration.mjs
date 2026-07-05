#!/usr/bin/env node
/** Smoke: memory_activity is registered as an LLM-facing memory extension tool. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import {
  canonicalJson,
  contentAddressedEventPath,
  sha256Hex,
  writeProjectActivityProjection,
} from "./project-activity-l2.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url);

const failures = [];
let total = 0;
async function check(name, fn) {
  total += 1;
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err && err.stack ? err.stack : err}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

function cryptoNonce(value) {
  return sha256Hex(JSON.stringify(value || {})).slice(0, 16);
}

function envelopeFor(body) {
  const bodyHash = sha256Hex(canonicalJson(body));
  return {
    schema: "knowledge-evidence-envelope/v1",
    canonicalization: "RFC8785-JCS",
    hash_alg: "sha256",
    event_id: bodyHash,
    body_hash: bodyHash,
    body,
  };
}

function writeEvent(abrainHome, body) {
  const envelope = envelopeFor(body);
  const file = contentAddressedEventPath(abrainHome, envelope.event_id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(envelope)}\n`, "utf8");
  return envelope.event_id;
}

function knowledgeBody(overrides = {}) {
  return {
    event_schema_version: "knowledge-evidence-event/v1",
    event_type: "knowledge_entry_observed",
    created_at_utc: "2026-07-03T00:00:00.000Z",
    device_id: "smoke-device",
    producer_nonce: cryptoNonce(overrides),
    causal_parents: [],
    session_id: "smoke-session",
    turn_id: "smoke-turn",
    actor: { role: "assistant", id: "sediment" },
    source: { channel: "agent_end", source_ref: "smoke" },
    intent: { domain_hint: "knowledge", operation_hint: "create" },
    scope: { kind: "project", project_id: "pi-global" },
    payload: {
      slug: "smoke-activity-tool-registration",
      title: "Smoke Activity Tool Registration",
      kind: "fact",
      status: "active",
      provenance: "smoke",
      confidence: 5,
      compiled_truth: "# Smoke Activity Tool Registration\n\nSmoke body.",
      trigger_phrases: [],
      derives_from: [],
    },
    sanitizer: { sanitizer_name: "smoke", sanitizer_version: "v1", status: "passed", replacements_count: 0 },
    legacy_parallel_write: { attempted: false, status: "smoke" },
    producer: { name: "sediment.knowledge-event-writer", version: "smoke" },
    ...overrides,
  };
}

function makeFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "abrain-memory-activity-tool-registration-smoke-"));
  writeEvent(home, knowledgeBody({ created_at_utc: "2026-07-03T00:00:00.000Z", scope: { kind: "project", project_id: "pi-global" } }));
  writeEvent(home, knowledgeBody({
    created_at_utc: "2026-07-02T00:00:00.000Z",
    scope: { kind: "project", project_id: "pi-global" },
    payload: { ...knowledgeBody().payload, slug: "pi-global-second", title: "Pi Global Second" },
  }));
  writeEvent(home, knowledgeBody({
    created_at_utc: "2026-07-01T00:00:00.000Z",
    scope: { kind: "project", project_id: "pi-router" },
    payload: { ...knowledgeBody().payload, slug: "router-activity-tool", title: "Router Activity Tool" },
  }));
  writeEvent(home, knowledgeBody({
    created_at_utc: "2026-06-30T00:00:00.000Z",
    scope: { kind: "world" },
    payload: { ...knowledgeBody().payload, slug: "world-activity-tool", title: "World Activity Tool" },
  }));
  writeProjectActivityProjection({ abrainHome: home, asOfUtc: "2026-07-04T00:00:00.000Z", windows: [7, 30] });
  return home;
}

function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const stat = fs.statSync(full);
        out.push({ rel: path.relative(root, full).split(path.sep).join("/"), size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

function captureTools(activate) {
  const tools = new Map();
  const commands = new Map();
  const events = [];
  activate({
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, options) { commands.set(name, options); },
    on(event, handler) { events.push({ event, handler }); },
  });
  return { tools, commands, events };
}

function assertOnlyPublicActivityParams(tool) {
  const props = tool.parameters?.properties;
  assert(props && typeof props === "object", "memory_activity must declare parameters.properties");
  const names = Object.keys(props).sort();
  assert(JSON.stringify(names) === JSON.stringify(["includeExcerpt", "limit", "windowDays"]), `unexpected schema params: ${names.join(", ")}`);
  assert(!Object.prototype.hasOwnProperty.call(props, "abrainRoot"), "schema must not expose abrainRoot");
  assert(!Object.prototype.hasOwnProperty.call(props, "viewRoot"), "schema must not expose viewRoot");
}

function assertGuidance(tool) {
  const text = [tool.description, ...(tool.promptGuidelines || [])].join("\n").toLowerCase();
  for (const needle of [
    "recent activity",
    "attention timeline",
    "project allocation",
    "what the user has been busy with",
    "evidence-event counts",
    "not wall-clock",
    "preferences",
    "rules",
    "durable knowledge",
    "semantic memory retrieval",
  ]) {
    assert(text.includes(needle), `description/promptGuidelines missing boundary text: ${needle}`);
  }
  assert(text.includes("memory_search") || text.includes("memory_decide"), "guidance must route semantic/preference retrieval to memory_search or memory_decide");
}

console.log("memory activity tool registration smoke");

const prevDisabled = process.env.PI_ABRAIN_DISABLED;
const prevAbrainRoot = process.env.ABRAIN_ROOT;
const fixtureHome = makeFixture();
process.env.ABRAIN_ROOT = fixtureHome;
delete process.env.PI_ABRAIN_DISABLED;

let captured;
try {
  const memoryModule = await jiti.import(path.join(repoRoot, "extensions/memory/index.ts"));
  const activate = memoryModule.default || memoryModule;

  await check("memory extension registers memory_activity as an LLM-facing tool", async () => {
    assert(typeof activate === "function", `expected activate function, got ${typeof activate}`);
    captured = captureTools(activate);
    assert(captured.tools.has("memory_activity"), `registered tools: ${[...captured.tools.keys()].join(", ")}`);
  });

  await check("memory_activity schema exposes only public LLM arguments", async () => {
    const tool = captured.tools.get("memory_activity");
    assert(tool, "memory_activity missing");
    assertOnlyPublicActivityParams(tool);
  });

  await check("memory_activity guidance is narrow and excludes semantic memory retrieval", async () => {
    const tool = captured.tools.get("memory_activity");
    assert(tool, "memory_activity missing");
    assertGuidance(tool);
  });

  await check("captured memory_activity prepareArguments/execute reads temp ABRAIN_ROOT and returns ToolResult", async () => {
    const tool = captured.tools.get("memory_activity");
    assert(tool, "memory_activity missing");
    const before = JSON.stringify(listFiles(fixtureHome));
    const params = tool.prepareArguments({ window_days: 30, limit: 2, include_excerpt: false, abrainRoot: os.homedir(), viewRoot: os.homedir() });
    assert(params.windowDays === 30, `windowDays normalized incorrectly: ${JSON.stringify(params)}`);
    assert(params.limit === 2, `limit normalized incorrectly: ${JSON.stringify(params)}`);
    assert(params.includeExcerpt === false, `includeExcerpt normalized incorrectly: ${JSON.stringify(params)}`);
    assert(!("abrainRoot" in params), "prepareArguments must not pass through abrainRoot");
    assert(!("viewRoot" in params), "prepareArguments must not pass through viewRoot");

    const result = await tool.execute("smoke-memory-activity", params, new AbortController().signal, undefined, {});
    const after = JSON.stringify(listFiles(fixtureHome));
    assert(result && typeof result === "object", "execute must return an object");
    assert(Array.isArray(result.content), "ToolResult.content must be an array");
    assert(result.content[0]?.type === "text" && typeof result.content[0]?.text === "string", "ToolResult.content[0] must be text");
    assert(result.details && typeof result.details === "object", "ToolResult.details must carry structured payload");
    assert(result.details.ok === true, `details.ok expected true got ${JSON.stringify(result.details)}`);
    assert(Array.isArray(result.details.topProjects) && result.details.topProjects.length > 0, "details.topProjects must have data");
    assert(result.details.topProjects[0].project === "pi-global", `top project expected pi-global got ${result.details.topProjects[0]?.project}`);
    assert(String(result.details.latestDir || "").startsWith(path.join(fixtureHome, "l2", "views", "activity")), `execute did not read temp ABRAIN_ROOT: ${result.details.latestDir}`);
    assert(!("excerpt" in result.details), "excerpt should be omitted when includeExcerpt=false");
    assert(before === after, "memory_activity execute changed file set, size, or mtime");
  });
} finally {
  fs.rmSync(fixtureHome, { recursive: true, force: true });
  if (prevDisabled === undefined) delete process.env.PI_ABRAIN_DISABLED;
  else process.env.PI_ABRAIN_DISABLED = prevDisabled;
  if (prevAbrainRoot === undefined) delete process.env.ABRAIN_ROOT;
  else process.env.ABRAIN_ROOT = prevAbrainRoot;
}

console.log(failures.length === 0
  ? `PASS - ${total} checks (memory activity tool registration).`
  : `FAIL - ${failures.length}/${total} checks failed.`);
process.exit(failures.length === 0 ? 0 : 1);
