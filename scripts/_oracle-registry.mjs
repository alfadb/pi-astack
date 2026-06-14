// 共享 oracle/smoke registry stub —— 模型无关, 从 agent/models.json 的
// providers.<p>.{baseUrl, apiKey} 解析(apiKey 是 $ENV ref)并注入。
//
// 为什么: realRegistry(ModelRegistry.create + AuthStorage)不展开 models.json 里
// 的 $ENV apiKey ref —— 只有 AuthStorage 里登记过的 provider(实测 deepseek/anthropic)
// 能解析, 其余 chat provider(moonshotai/minimax/openai/...)getApiKeyAndHeaders 返回
// 空 key → 401。脚本本应"模型选择仅成本建议、与具体厂商解耦", 故这里统一从 models.json
// 解析 baseUrl+apiKey(与 embedding stub 同路), 任何已配 key 的 provider 都能跑。
//
// 用法: const { registry, embedKey } = makeOracleRegistry(MODELS_JSON);
//       if (!embedKey) { console.log("SKIP — no embedding key"); process.exit(0); }
//       ... llmSearchEntriesWithVerdict(corpus, params, settings, registry)
import fs from "node:fs";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

export function makeOracleRegistry(modelsJsonPath) {
  const real = ModelRegistry.create(AuthStorage.create(), modelsJsonPath);
  const MODELS = JSON.parse(fs.readFileSync(modelsJsonPath, "utf8"));
  const resolveKey = (provider) => {
    const ref = MODELS.providers?.[provider]?.apiKey || "";
    return ref.startsWith("$") ? (process.env[ref.slice(1)] || "") : ref;
  };
  const embedBase = MODELS.providers?.embedding?.baseUrl;
  const embedKey = resolveKey("embedding");
  const registry = {
    // embedding 走 stub(model-curator 动态注册, 静态 registry 不含); chat 走 real.find
    // 拿正确 model 对象(baseUrl/能力位), apiKey 由 getApiKeyAndHeaders 从 models.json 注入。
    find: (p, id) => (p === "embedding" ? { __embed: true, provider: p, id, baseUrl: embedBase } : real.find(p, id)),
    getApiKeyAndHeaders: async (m) => {
      if (m && m.__embed) return { ok: true, apiKey: embedKey };
      const key = m && m.provider ? resolveKey(m.provider) : "";
      return key ? { ok: true, apiKey: key, headers: {} } : real.getApiKeyAndHeaders(m);
    },
  };
  return { registry, real, MODELS, resolveKey, embedBase, embedKey };
}
