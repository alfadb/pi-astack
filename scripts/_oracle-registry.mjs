// 共享 oracle/smoke registry stub —— 模型无关, 从 agent/models.json 的
// providers.<p>.{baseUrl, apiKey} 解析并注入。apiKey 支持 pi 的 config-value
// 三种形态: "!command"(跑 shell 取 stdout, 现行: !jq 从 ~/.pi/secrets.json 读)、
// "$ENV"(环境变量, 旧形态)、字面量。
//
// 为什么: realRegistry(ModelRegistry.create + AuthStorage)对部分 provider 的
// getApiKeyAndHeaders 走 AuthStorage 优先路径, 而 oracle 脚本应"模型选择仅成本建议、
// 与具体厂商解耦", 故这里统一从 models.json 直接解析 baseUrl+apiKey(与 embedding
// stub 同路), 任何已配 key 的 provider 都能跑。
//
// 用法: const { registry, embedKey } = makeOracleRegistry(MODELS_JSON);
//       if (!embedKey) { console.log("SKIP — no embedding key"); process.exit(0); }
//       ... llmSearchEntriesWithVerdict(corpus, params, settings, registry)
import fs from "node:fs";
import { execSync } from "node:child_process";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

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
