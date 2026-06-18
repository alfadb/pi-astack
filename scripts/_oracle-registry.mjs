// 共享 oracle/smoke registry stub。chat provider 仍从 agent/models.json 解析；
// embedding endpoint 从 pi-astack-settings.json → memory.embedding 解析，避免
// 非 chat 模型进入通用模型清单。
//
// 用法: const { registry, embedKey } = makeOracleRegistry(MODELS_JSON);
//       if (!embedKey) { console.log("SKIP — no embedding key"); process.exit(0); }
//       ... llmSearchEntriesWithVerdict(corpus, params, settings, registry)
import fs from "node:fs";
import { execSync } from "node:child_process";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { embeddingConfig } from "./_embedding-config.mjs";

export function makeOracleRegistry(modelsJsonPath) {
  const real = ModelRegistry.create(AuthStorage.create(), modelsJsonPath);
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
  return { registry, real, MODELS, resolveKey, embedBase, embedKey };
}
