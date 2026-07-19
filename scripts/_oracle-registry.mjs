// 共享 oracle/smoke registry stub。chat provider 仍从 agent/models.json 解析；
// embedding endpoint 从 pi-astack-settings.json → memory.embedding 解析，避免
// 非 chat 模型进入通用模型清单。
//
// pi 0.80.10: ModelRegistry.create(AuthStorage.create(), path) 已移除。
// 公开契约 = ModelRuntime.create({ modelsPath }) + new ModelRegistry(runtime)。
//
// 用法: const { registry, embedKey } = await makeOracleRegistry(MODELS_JSON);
//       if (!embedKey) { console.log("SKIP — no embedding key"); process.exit(0); }
//       ... llmSearchEntriesWithVerdict(corpus, params, settings, registry)
import fs from "node:fs";
import { execSync } from "node:child_process";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { embeddingConfig } from "./_embedding-config.mjs";

/**
 * Build a ModelRegistry-compatible facade for oracle/smoke scripts.
 * Awaits ModelRuntime.create so models.json is loaded before first find().
 */
export async function makeOracleRegistry(modelsJsonPath) {
  const runtime = await ModelRuntime.create({ modelsPath: modelsJsonPath });
  const real = new ModelRegistry(runtime);
  const MODELS = JSON.parse(fs.readFileSync(modelsJsonPath, "utf8"));
  const resolveKey = (provider) => {
    const ref = MODELS.providers?.[provider]?.apiKey || "";
    if (!ref) return "";
    if (ref.startsWith("!")) {
      try {
        return execSync(ref.slice(1), { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch {
        return "";
      }
    }
    return ref.startsWith("$") ? (process.env[ref.slice(1)] || "") : ref;
  };
  const embedding = embeddingConfig();
  const embedBase = embedding.baseUrl;
  const embedKey = embedding.apiKey;
  const registry = {
    // embedding 走专用 stub；chat 走 real.find 拿正确 model 对象。
    find: (p, id) => (p === "embedding" ? { __embed: true, provider: p, id, baseUrl: embedBase } : real.find(p, id)),
    getApiKeyAndHeaders: async (m) => {
      if (m && m.__embed) return { ok: true, apiKey: embedKey };
      const key = m && m.provider ? resolveKey(m.provider) : "";
      return key ? { ok: true, apiKey: key, headers: {} } : real.getApiKeyAndHeaders(m);
    },
  };
  return { registry, real, runtime, MODELS, resolveKey, embedBase, embedKey };
}
