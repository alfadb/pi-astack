#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const memoryExt = (await jiti.import(path.join(root, "extensions/memory/index.ts"))).default;
const dispatch = await jiti.import(path.join(root, "extensions/dispatch/index.ts"));
const workflow = await jiti.import(path.join(root, "extensions/workflow/dsl.ts"));
const compat = await jiti.import(path.join(root, "extensions/_shared/tool-name-compat.ts"));

let total = 0;
let failed = 0;
function check(condition, message) {
  total += 1;
  console.log(`  ${condition ? "ok  " : "FAIL"}  ${message}`);
  if (!condition) failed += 1;
}

const tools = new Map();
const hooks = new Map();
memoryExt({
  registerTool(tool) { tools.set(tool.name, tool); },
  registerCommand() {},
  on(event, handler) {
    if (!hooks.has(event)) hooks.set(event, []);
    hooks.get(event).push(handler);
  },
});

console.log("memory tool rename contract");
console.log("\n[root registration and Facade]");
check(tools.has("memory_search") && tools.has("abrain_get"), "root registers memory_search + abrain_get");
check(!tools.has("memory_get"), "root neither registers nor aliases memory_get");
const getEntry = tools.get("abrain_get");
const prepared = getEntry.prepareArguments({ id: "missing-probe", includeRelated: true });
check(prepared.slug === "missing-probe" && prepared.options.include_related === true, "abrain_get preserves slug/options prepareArguments contract");
const missing = await getEntry.execute("rename-smoke", prepared, new AbortController().signal, undefined, { cwd: root });
const missingPayload = JSON.parse(missing.content[0].text);
check(missing.isError === true && missingPayload.slug === "missing-probe" && /memory entry not found/.test(missingPayload.error), "abrain_get preserves Facade not-found return/error semantics");

console.log("\n[central canonicalization and child activation]");
check(compat.canonicalizeToolName("memory_get") === "abrain_get", "central old-name canonicalization maps to abrain_get");
check(JSON.stringify(compat.canonicalizeToolNames(["memory_get", "abrain_get", "read"])) === JSON.stringify(["abrain_get", "read"]), "central canonicalization deduplicates after migration");
const childTools = dispatch.resolveSubAgentTools("memory_search,memory_get,memory_decide");
check(JSON.stringify(childTools) === JSON.stringify(["memory_search", "abrain_get", "memory_decide"]), "dispatch child CSV activates only the canonical name");
check(!dispatch.resolveSubAgentTools(undefined).includes("memory_get") && dispatch.resolveSubAgentTools(undefined).includes("abrain_get"), "dispatch child default advertises only abrain_get");
const parsedWorkflow = workflow.parseWorkflowJson(JSON.stringify({
  schema_version: 1,
  name: "legacy-tools",
  stages: [{ id: "read", kind: "agent", prompt: "read", tools: ["memory_search", "memory_get", "abrain_get"] }],
}));
check(JSON.stringify(parsedWorkflow.doc?.stages?.[0]?.tools) === JSON.stringify(["memory_search", "abrain_get"]), "persisted workflow tools load as canonical names");
check(workflow.READONLY_TOOLS.has("abrain_get") && !workflow.READONLY_TOOLS.has("memory_get"), "workflow allowlist advertises only abrain_get");
check(compat.isMemoryEntryReadToolName("memory_get") && compat.isMemoryEntryReadToolName("abrain_get"), "historical readers recognize both names");

console.log("\n[generated system prompt]");
const beforeHandlers = hooks.get("before_agent_start") ?? [];
let generatedPrompt = "";
for (const handler of beforeHandlers) {
  const result = await handler({ systemPrompt: "BASE", prompt: "" }, {});
  if (result?.systemPrompt?.includes("memory-footnote protocol")) generatedPrompt = result.systemPrompt;
}
check(generatedPrompt.includes("abrain_get"), "main generated prompt names abrain_get");
check(!generatedPrompt.includes("memory_get"), "main generated prompt omits memory_get");

console.log("\n[Anthropic provider payload snapshot]");
const runtime = await ModelRuntime.create({ modelsPath: null });
await runtime.setRuntimeApiKey("anthropic", "rename-smoke-key");
const builtIn = runtime.getModel("anthropic", "claude-sonnet-5");
let payload;
if (builtIn) {
  const localModel = { ...builtIn, baseUrl: "http://127.0.0.1:9" };
  await runtime.completeSimple(localModel, {
    messages: [{ role: "user", content: "payload snapshot", timestamp: Date.now() }],
    tools: [tools.get("memory_search"), tools.get("abrain_get")].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  }, {
    maxTokens: 1,
    maxRetries: 0,
    timeoutMs: 500,
    onPayload(value) { payload = value; },
  });
}
const snapshotNames = Array.isArray(payload?.tools) ? payload.tools.map((tool) => tool.name) : [];
check(JSON.stringify(snapshotNames) === JSON.stringify(["memory_search", "abrain_get"]), "serialized provider request contains memory_search + abrain_get");
check(!snapshotNames.includes("memory_get"), "serialized provider request contains no legacy name pair");

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} - ${total - failed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
