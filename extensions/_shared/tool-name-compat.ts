export const ABRAIN_GET_TOOL_NAME = "abrain_get" as const;
export const LEGACY_MEMORY_GET_TOOL_NAME = "memory_get" as const;

/** Canonicalize persisted or caller-supplied tool names before activation. */
export function canonicalizeToolName(name: string): string {
  return name === LEGACY_MEMORY_GET_TOOL_NAME ? ABRAIN_GET_TOOL_NAME : name;
}

/** Canonicalize and exact-deduplicate tool names while preserving order. */
export function canonicalizeToolNames(names: readonly string[]): string[] {
  const canonical: string[] = [];
  const seen = new Set<string>();
  for (const rawName of names) {
    const name = canonicalizeToolName(rawName);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    canonical.push(name);
  }
  return canonical;
}

/** Canonicalize dispatch-style comma-separated tool input. */
export function canonicalizeToolCsv(tools: string): string {
  return canonicalizeToolNames(tools.split(",").map((name) => name.trim()).filter(Boolean)).join(",");
}

/** Historical session/evidence readers accept both pre- and post-migration names. */
export function isMemoryEntryReadToolName(name: string): boolean {
  return name === ABRAIN_GET_TOOL_NAME || name === LEGACY_MEMORY_GET_TOOL_NAME;
}
