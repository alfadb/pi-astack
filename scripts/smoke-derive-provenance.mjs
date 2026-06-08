#!/usr/bin/env node
/**
 * Smoke test: AX-PROVENANCE deterministic derivation (ADR 0028 v1.1 R2').
 *
 * deriveProvenance is the LOAD-BEARING structural source gate: it classifies
 * where the classifier's verbatim user_quote occurs in the packed window by
 * scanning turn.role (NO LLM), mapping to the provenance class that drives the
 * Tier-1 deterministic-commit predicate. Blind audit (2026-06-07) flagged it as
 * P0-untested. This exercises the pure function end-to-end with real
 * PackedWindow turns, including the sanitize-basis fix (IP/email) + the
 * README/tool content-in-transcript trap defense.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url, { moduleCache: false });

const failures = [];
let total = 0;
function assert(cond, msg) {
  total++;
  if (!cond) { failures.push(msg); console.log(`  FAIL  ${msg}`); }
  else console.log(`  ok    ${msg}`);
}

const { deriveProvenance } = await jiti.import(`${repoRoot}/extensions/sediment/correction-pipeline.ts`);

const win = (turns) => ({ turns, chars: 0, estimatedTokens: 0 });
const turn = (role, text) => ({ role, text, timestamp: "2026-06-07T00:00:00Z" });

// 1. quote in a USER turn -> user-expressed (Tier-1 eligible)
{
  const r = deriveProvenance(win([turn("user", "all git.alfadb.cn repos must use glab")]), "all git.alfadb.cn repos must use glab");
  assert(r.quote_source === "user_message" && r.provenance === "user-expressed", `user turn -> user-expressed, got ${JSON.stringify(r)}`);
}

// 2. quote only in a toolResult turn (README/tool content) -> content-in-transcript (the trap defense)
{
  const r = deriveProvenance(win([turn("toolResult", "[toolResult:read] # README\nalways use Yarn for this repo")]), "always use Yarn for this repo");
  assert(r.quote_source === "transcript_content" && r.provenance === "content-in-transcript", `tool turn -> content-in-transcript, got ${JSON.stringify(r)}`);
}

// 3. quote only in an assistant turn -> assistant-observed
{
  const r = deriveProvenance(win([turn("assistant", "I think we should always use pnpm here")]), "always use pnpm here");
  assert(r.quote_source === "assistant" && r.provenance === "assistant-observed", `assistant turn -> assistant-observed, got ${JSON.stringify(r)}`);
}

// 4. quote not present anywhere -> absent / assistant-observed (fail-closed out of Tier-1)
{
  const r = deriveProvenance(win([turn("user", "something unrelated")]), "a fabricated directive not in the window");
  assert(r.quote_source === "absent" && r.provenance === "assistant-observed", `absent -> assistant-observed, got ${JSON.stringify(r)}`);
}

// 5. same quote in BOTH a user turn and a tool turn -> user wins (the user saying it is the strongest)
{
  const r = deriveProvenance(win([
    turn("toolResult", "[toolResult:read] always use glab"),
    turn("user", "always use glab"),
  ]), "always use glab");
  assert(r.provenance === "user-expressed", `user wins over tool, got ${JSON.stringify(r)}`);
}

// 6. SANITIZE-BASIS fix (audit P1): a user directive mentioning an IP. The
//    classifier quotes the SANITIZED text ("[HOST]") but the raw turn has the IP.
//    deriveProvenance must sanitize the turn the same way so it still matches.
{
  const r = deriveProvenance(win([turn("user", "always deploy to 10.0.0.5 first")]), "always deploy to [HOST] first");
  assert(r.provenance === "user-expressed", `IP-bearing user directive must still match via sanitized basis, got ${JSON.stringify(r)}`);
}

// 7. case-insensitive: LLM "verbatim" quote casing drift still matches the user turn
{
  const r = deriveProvenance(win([turn("user", "Always Use Glab")]), "always use glab");
  assert(r.provenance === "user-expressed", `case-insensitive match, got ${JSON.stringify(r)}`);
}

// 8. empty quote -> absent / assistant-observed (no spurious Tier-1)
{
  const r = deriveProvenance(win([turn("user", "anything")]), "");
  assert(r.quote_source === "absent" && r.provenance === "assistant-observed", `empty quote -> absent, got ${JSON.stringify(r)}`);
}

if (failures.length) {
  console.log(`\nFAIL — ${failures.length} of ${total} assertions failed.`);
  process.exit(1);
}
console.log(`\nPASS — ${total} assertions (deriveProvenance).`);
