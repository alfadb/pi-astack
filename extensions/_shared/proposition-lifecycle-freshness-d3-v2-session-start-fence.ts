/// <reference types="node" />
/**
 * ADR0040 D3-v2 session_start managed rule-fence parser (R3.4).
 *
 * Parses existing BEGIN..END managed regions with balanced nesting.
 * Foreign/mixed/malformed fences are sanitized from in-memory systemPrompt /
 * provider text only — never written to session files and never trigger
 * taint/rollback. Sanitizer removes only managed regions and never mutates
 * any byte outside those regions.
 */
export const D3_V2_SESSION_START_SOURCE_MARKER =
  "source=proposition-lifecycle-freshness-d3-v2" as const;
export const BEGIN_ABRAIN_RULES = "<!-- BEGIN_ABRAIN_RULES";
export const END_ABRAIN_RULES = "<!-- END_ABRAIN_RULES -->";
export const RULES_SECTION_REMOVED_MARKER = "[ABRAIN_RULES_SECTION_REMOVED]";

const HASH = /^[0-9a-f]{64}$/;

export interface D3V2FenceAttrs {
  session: string | null;
  session_id: string | null;
  activation_nonce: string | null;
  activation_object_hash: string | null;
  source: string | null;
  selection: string | null;
  head: string | null;
  proof: string | null;
  stable: string | null;
  adapter_manifest: string | null;
  raw_attr: string;
}

export interface D3V2ParsedFence {
  start: number;
  end: number;
  full: string;
  body: string;
  attrs: D3V2FenceAttrs;
  well_formed: boolean;
  nested: boolean;
  unclosed: boolean;
}

export type D3V2ManagedSuffixKind =
  | { kind: "absent" }
  | { kind: "own"; fence: D3V2ParsedFence }
  | { kind: "foreign"; fence: D3V2ParsedFence }
  | { kind: "mixed"; fences: D3V2ParsedFence[] }
  | { kind: "malformed"; fences: D3V2ParsedFence[] };

export interface D3V2OwnFenceExpectation {
  session_id: string;
  activation_nonce: string;
  activation_object_hash: string;
  selection: string;
  head: string;
  proof: string;
  stable: string;
  adapter_manifest: string;
  viewMd: string;
}

interface Marker {
  kind: "begin" | "end";
  index: number;
  length: number;
  attrRaw: string;
}

/**
 * Scan text for outermost managed regions using balanced BEGIN/END nesting.
 * Nested BEGINs inside an outer region make that region nested+malformed.
 * Unclosed BEGINs extend the managed region to end-of-string.
 */
export function parseAllAbrainRuleFences(text: string): D3V2ParsedFence[] {
  if (!text || !text.includes(BEGIN_ABRAIN_RULES)) return [];
  const markers = collectMarkers(text);
  if (markers.length === 0) return [];

  const fences: D3V2ParsedFence[] = [];
  let i = 0;
  while (i < markers.length) {
    const m = markers[i]!;
    if (m.kind === "end") {
      // Orphan END — not a managed region start; leave for outer content.
      i += 1;
      continue;
    }
    // Outermost BEGIN
    const begin = m;
    let depth = 1;
    let nested = false;
    let endIndex = -1;
    let endLength = 0;
    let j = i + 1;
    for (; j < markers.length; j += 1) {
      const cur = markers[j]!;
      if (cur.kind === "begin") {
        depth += 1;
        nested = true;
      } else {
        depth -= 1;
        if (depth === 0) {
          endIndex = cur.index;
          endLength = cur.length;
          break;
        }
      }
    }
    const unclosed = depth !== 0;
    const regionEnd = unclosed ? text.length : endIndex + endLength;
    const afterBegin = begin.index + begin.length;
    // Body excludes the outer BEGIN tag and, when closed, the matching END tag.
    // Nested content (including nested BEGIN/END tags) remains inside body.
    const bodyEnd = unclosed ? text.length : endIndex;
    const rawBody = text.slice(afterBegin, bodyEnd);
    const body = rawBody.replace(/^\n/, "").replace(/\n$/, "");
    fences.push({
      start: begin.index,
      end: regionEnd,
      full: text.slice(begin.index, regionEnd),
      body,
      attrs: parseFenceAttrs(begin.attrRaw),
      well_formed: !nested && !unclosed,
      nested,
      unclosed,
    });
    if (unclosed) break;
    // Continue after this outermost region.
    i = j + 1;
  }
  return fences;
}

export function classifyManagedSuffix(
  text: string,
  expected: D3V2OwnFenceExpectation | null,
): D3V2ManagedSuffixKind {
  const fences = parseAllAbrainRuleFences(text);
  if (fences.length === 0) return { kind: "absent" };
  if (fences.some((f) => !f.well_formed)) return { kind: "malformed", fences };
  if (fences.length > 1) return { kind: "mixed", fences };
  const fence = fences[0]!;
  if (!expected) return { kind: "foreign", fence };
  if (isOwnExactFence(fence, expected)) return { kind: "own", fence };
  return { kind: "foreign", fence };
}

export function isOwnExactFence(fence: D3V2ParsedFence, expected: D3V2OwnFenceExpectation): boolean {
  if (!fence.well_formed) return false;
  const a = fence.attrs;
  if (a.session !== expected.activation_nonce) return false;
  if (a.session_id !== expected.session_id) return false;
  if (a.activation_nonce !== expected.activation_nonce) return false;
  if (a.activation_object_hash !== expected.activation_object_hash) return false;
  if (a.source !== D3_V2_SESSION_START_SOURCE_MARKER.replace(/^source=/, "")
    && a.source !== "proposition-lifecycle-freshness-d3-v2") return false;
  if (a.selection !== expected.selection) return false;
  if (a.head !== expected.head) return false;
  if (a.proof !== expected.proof) return false;
  if (a.stable !== expected.stable) return false;
  if (a.adapter_manifest !== expected.adapter_manifest) return false;
  const expectedBody = expected.viewMd.replace(/^\n/, "").replace(/\n$/, "");
  const actualBody = fence.body.replace(/^\n/, "").replace(/\n$/, "");
  if (actualBody !== expectedBody) return false;
  return fence.full === composeD3V2ExactFence(expected);
}

export function composeD3V2ExactFence(expected: D3V2OwnFenceExpectation): string {
  const header = [
    `${BEGIN_ABRAIN_RULES}`,
    `session=${expected.activation_nonce}`,
    `session_id=${expected.session_id}`,
    `activation_nonce=${expected.activation_nonce}`,
    `activation_object_hash=${expected.activation_object_hash}`,
    D3_V2_SESSION_START_SOURCE_MARKER,
    `selection=${expected.selection}`,
    `head=${expected.head}`,
    `proof=${expected.proof}`,
    `stable=${expected.stable}`,
    `adapter_manifest=${expected.adapter_manifest}`,
    `(auto-managed by sediment, do not edit by hand) -->`,
  ].join(" ");
  const body = expected.viewMd.endsWith("\n") || expected.viewMd.length === 0
    ? expected.viewMd
    : `${expected.viewMd}\n`;
  return `${header}\n${body}${END_ABRAIN_RULES}`;
}

/**
 * Remove all outermost managed BEGIN..END regions from in-memory text.
 * Never mutates any byte outside those regions (no whitespace collapse).
 * Does not write session/files.
 */
export function sanitizeManagedRuleFences(text: string): string {
  if (!text || !text.includes(BEGIN_ABRAIN_RULES)) return text;
  const fences = parseAllAbrainRuleFences(text);
  if (fences.length === 0) return text;
  let out = text;
  for (let i = fences.length - 1; i >= 0; i -= 1) {
    const f = fences[i]!;
    out = out.slice(0, f.start) + out.slice(f.end);
  }
  return out;
}

/**
 * Strip ONLY the selected activation fence (matched by activation_nonce in session=).
 * Used by context-packer / llm-extractor so unselected/foreign markers stay as evidence.
 * Outside-fence bytes are preserved exactly; only the matched region is replaced with
 * a removal marker.
 */
export function stripSelectedActivationRuleFence(
  text: string,
  activationNonce: string | undefined | null,
): string {
  if (!text || !activationNonce) return text;
  if (!HASH.test(activationNonce) && !/^[0-9a-f]+$/.test(activationNonce)) return text;
  const fences = parseAllAbrainRuleFences(text);
  if (fences.length === 0) return text;
  let out = text;
  for (let i = fences.length - 1; i >= 0; i -= 1) {
    const f = fences[i]!;
    const nonce = f.attrs.session ?? f.attrs.activation_nonce;
    if (nonce === activationNonce) {
      out = `${out.slice(0, f.start)}\n${RULES_SECTION_REMOVED_MARKER}\n${out.slice(f.end)}`;
    }
  }
  return out;
}

export function parseFenceAttrs(attrRaw: string): D3V2FenceAttrs {
  const attrs: D3V2FenceAttrs = {
    session: null,
    session_id: null,
    activation_nonce: null,
    activation_object_hash: null,
    source: null,
    selection: null,
    head: null,
    proof: null,
    stable: null,
    adapter_manifest: null,
    raw_attr: attrRaw,
  };
  const re = /([A-Za-z_][A-Za-z0-9_]*)=([^\s>]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrRaw)) !== null) {
    const key = m[1]!;
    const value = m[2]!;
    switch (key) {
      case "session": attrs.session = value; break;
      case "session_id": attrs.session_id = value; break;
      case "activation_nonce": attrs.activation_nonce = value; break;
      case "activation_object_hash": attrs.activation_object_hash = value; break;
      case "source": attrs.source = value; break;
      case "selection": attrs.selection = value; break;
      case "head": attrs.head = value; break;
      case "proof": attrs.proof = value; break;
      case "stable": attrs.stable = value; break;
      case "adapter_manifest": attrs.adapter_manifest = value; break;
      default: break;
    }
  }
  return attrs;
}

function collectMarkers(text: string): Marker[] {
  const markers: Marker[] = [];
  let offset = 0;
  while (offset < text.length) {
    const beginIdx = text.indexOf(BEGIN_ABRAIN_RULES, offset);
    const endIdx = text.indexOf(END_ABRAIN_RULES, offset);
    if (beginIdx < 0 && endIdx < 0) break;
    if (beginIdx >= 0 && (endIdx < 0 || beginIdx < endIdx)) {
      // Parse BEGIN tag through closing "-->"
      const close = text.indexOf("-->", beginIdx + BEGIN_ABRAIN_RULES.length);
      if (close < 0) {
        // Malformed open tag — treat remaining as begin marker attr empty, length to EOF handled by region.
        markers.push({
          kind: "begin",
          index: beginIdx,
          length: text.length - beginIdx,
          attrRaw: text.slice(beginIdx + BEGIN_ABRAIN_RULES.length),
        });
        break;
      }
      const fullLen = close + 3 - beginIdx;
      const attrRaw = text.slice(beginIdx + BEGIN_ABRAIN_RULES.length, close);
      markers.push({ kind: "begin", index: beginIdx, length: fullLen, attrRaw });
      offset = beginIdx + fullLen;
      continue;
    }
    markers.push({ kind: "end", index: endIdx, length: END_ABRAIN_RULES.length, attrRaw: "" });
    offset = endIdx + END_ABRAIN_RULES.length;
  }
  return markers;
}
