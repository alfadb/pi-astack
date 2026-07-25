/**
 * Shared pure helpers for ADR 0044 edge protocol shadow dossier/smoke.
 *
 * Terminal assistant = natural agent_end turn boundary.
 * Pi JSONL assistant with stopReason=toolUse is mid-loop tool call, NOT agent_end.
 */
import fs from "node:fs";
import { createHash } from "node:crypto";

/**
 * Natural agent_end boundary: assistant whose stopReason is not toolUse.
 * Includes stop / length / error / aborted / missing stopReason (non-toolUse).
 */
export function isTerminalAssistantMessage(message) {
  if (!message || message.role !== "assistant") return false;
  return message.stopReason !== "toolUse";
}

/**
 * From one real Pi JSONL: pick ONE main chain.
 * Prefer the latest *terminal* assistant leaf (stopReason !== 'toolUse'),
 * walk id/parentId to root. If the active branch ends in toolUse with no
 * terminal leaf, return null (do not fabricate).
 * Never mutates message bodies.
 */
export function collectMainChainFromSession(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const byId = new Map();
  let order = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj?.type !== "message" || !obj.id || !obj.message || typeof obj.message !== "object") continue;
    byId.set(String(obj.id), {
      id: String(obj.id),
      parentId: obj.parentId == null ? null : String(obj.parentId),
      timestamp: typeof obj.timestamp === "string" ? obj.timestamp : "2026-07-24T00:00:00.000Z",
      message: obj.message,
      order: order++,
    });
  }
  if (byId.size === 0) return null;
  const hasChild = new Set();
  for (const node of byId.values()) {
    if (node.parentId) hasChild.add(node.parentId);
  }
  // Only terminal assistant leaves count as natural agent_end tips.
  const terminalLeaves = [];
  for (const node of byId.values()) {
    if (hasChild.has(node.id)) continue;
    if (!isTerminalAssistantMessage(node.message)) continue;
    terminalLeaves.push(node);
  }
  if (terminalLeaves.length === 0) return null;
  // Prefer latest by timestamp; break ties by file order.
  terminalLeaves.sort((a, b) => {
    const ta = Date.parse(a.timestamp) || 0;
    const tb = Date.parse(b.timestamp) || 0;
    if (ta !== tb) return tb - ta;
    return b.order - a.order;
  });
  const leaf = terminalLeaves[0];
  const chainNodes = [];
  const guard = new Set();
  let cur = leaf.id;
  while (cur && byId.has(cur) && !guard.has(cur)) {
    guard.add(cur);
    chainNodes.push(byId.get(cur));
    cur = byId.get(cur).parentId;
  }
  chainNodes.reverse();
  if (chainNodes.length === 0) return null;
  const terminalTurnIndices = [];
  for (let i = 0; i < chainNodes.length; i += 1) {
    if (isTerminalAssistantMessage(chainNodes[i].message)) terminalTurnIndices.push(i);
  }
  if (terminalTurnIndices.length === 0) return null;
  const sourceTag = createHash("sha256").update(filePath).digest("hex").slice(0, 12);
  return {
    chainNodes,
    /** @deprecated use terminalTurnIndices — kept as alias for report fields */
    assistantTurnIndices: terminalTurnIndices,
    terminalTurnIndices,
    assistant_turns: terminalTurnIndices.length,
    terminal_assistant_turns: terminalTurnIndices.length,
    byte_length: Buffer.byteLength(JSON.stringify(chainNodes.map((n) => n.message)), "utf8"),
    source_category: "pi_session_jsonl",
    source_tag: sourceTag,
    leaf_depth: chainNodes.length,
  };
}
