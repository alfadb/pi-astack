import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "pi-astack-settings.json");

function readSettingsEmbedding() {
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
    return settings.memory?.embedding ?? {};
  } catch {
    return {};
  }
}

function resolveSecretRef(raw) {
  if (!raw || typeof raw !== "string") return "";
  if (raw.startsWith("!")) {
    try {
      return execSync(raw.slice(1), { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "";
    }
  }
  if (raw.startsWith("${") && raw.endsWith("}")) return process.env[raw.slice(2, -1)] || "";
  if (raw.startsWith("$")) return process.env[raw.slice(1)] || "";
  return raw;
}

export function embeddingConfig() {
  const embedding = readSettingsEmbedding();
  return {
    baseUrl: typeof embedding.baseUrl === "string" ? embedding.baseUrl : "",
    apiKey: resolveSecretRef(embedding.apiKey),
    model: typeof embedding.model === "string" ? embedding.model : "",
    dim: Number(embedding.dim || 2048),
    batchSize: Number(embedding.batchSize || 10),
    tpmLimit: Number(embedding.tpmLimit || 600_000),
    timeoutMs: Number(embedding.timeoutMs || 60_000),
    maxRetries: Number(embedding.maxRetries || 3),
    multiVector: Boolean(embedding.multiVector),
    multiVectorMaxChunks: Number(embedding.multiVectorMaxChunks || 4),
  };
}
