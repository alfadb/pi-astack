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

// 5. PR-3/P0.2 (ADR 0028 §6 unique-turn mapping — INVERTS the pre-PR-3
//    "user wins" priority): same quote in BOTH a user turn and a tool turn
//    is role-AMBIGUOUS -> fail-closed OUT of user_message, demoted to the
//    conservative content-in-transcript sink, with multi_match diagnostics.
{
  const r = deriveProvenance(win([
    turn("toolResult", "[toolResult:read] always use glab"),
    turn("user", "always use glab"),
  ]), "always use glab");
  assert(r.provenance === "content-in-transcript" && r.quote_source === "transcript_content", `cross-role user+tool -> fail-closed to content-in-transcript, got ${JSON.stringify(r)}`);
  assert(r.multi_match === true && JSON.stringify(r.matched_roles) === JSON.stringify(["user", "transcript"]), `cross-role diagnostics recorded, got ${JSON.stringify(r)}`);
}

// 5b. PR-3: assistant ECHO of a user directive -> cross-role ambiguity ->
//     fail-closed to assistant-observed (accepted recall cost; R3' recall
//     audit is the visible net — see deriveProvenance header).
{
  const r = deriveProvenance(win([
    turn("user", "以后用 pnpm"),
    turn("assistant", "好的，以后用 pnpm，已记住"),
  ]), "以后用 pnpm");
  assert(r.provenance === "assistant-observed" && r.quote_source === "assistant" && r.multi_match === true, `user+assistant echo -> fail-closed to assistant-observed, got ${JSON.stringify(r)}`);
  // deepseek R1 N2: matched_roles is the forensics key for the echo
  // subclass ("why didn't my directive reach Tier-1") — lock it.
  assert(JSON.stringify(r.matched_roles) === JSON.stringify(["user", "assistant"]), `echo matched_roles records both roles, got ${JSON.stringify(r)}`);
}

// 5f. PR-7 provenance isolation: a goal continuation message rides the USER
//     role but is machine-composed — the `[pi-goal-continuation]` prefix
//     demotes it to the assistant-origin bucket (INV-IMPLICIT-GROUND-TRUTH).
{
  const r = deriveProvenance(win([
    turn("user", "[pi-goal-continuation goal_id=g-ab12] 以后用 pnpm 跑完剩余 smoke"),
  ]), "以后用 pnpm 跑完剩余 smoke");
  assert(r.provenance === "assistant-observed" && r.quote_source === "assistant", `continuation-prefixed user turn -> assistant-observed, got ${JSON.stringify(r)}`);
}

// 5g. real user directive + continuation echo of it -> cross-role fail-closed
//     (the REAL user turn still cannot be laundered INTO Tier-1 by the
//     machine turn, and vice versa — demote direction only).
{
  const r = deriveProvenance(win([
    turn("user", "以后用 pnpm"),
    turn("user", "[pi-goal-continuation goal_id=g-ab12] 以后用 pnpm — 继续"),
  ]), "以后用 pnpm");
  assert(r.provenance === "assistant-observed" && r.multi_match === true, `user + continuation echo -> fail-closed, got ${JSON.stringify(r)}`);
  assert(JSON.stringify(r.matched_roles) === JSON.stringify(["user", "assistant"]), `matched_roles records machine bucket, got ${JSON.stringify(r)}`);
}

// 5e. opus R1 N2: assistant+tool WITHOUT user -> cross-role, transcript
//     sink wins over assistant (locks the demote priority branch that 5d
//     cannot isolate because 5d includes a user match).
{
  const r = deriveProvenance(win([
    turn("toolResult", "[toolResult:read] always pin versions"),
    turn("assistant", "per the README, always pin versions"),
  ]), "always pin versions");
  assert(r.provenance === "content-in-transcript" && r.quote_source === "transcript_content" && r.multi_match === true, `tool+assistant -> transcript sink, got ${JSON.stringify(r)}`);
}

// 5c. PR-3: quote in MULTIPLE user-role turns ONLY -> role-unambiguous ->
//     stays user_message (repeated statement = stronger signal), with
//     multi_match=true surfaced for audit.
{
  const r = deriveProvenance(win([
    turn("user", "以后用 pnpm"),
    turn("user", "再说一遍：以后用 pnpm"),
  ]), "以后用 pnpm");
  assert(r.provenance === "user-expressed" && r.quote_source === "user_message" && r.multi_match === true, `multi user-role -> user_message + multi_match, got ${JSON.stringify(r)}`);
}

// 5d. PR-3: all three role classes match -> transcript sink wins over
//     assistant (deterministic demote priority).
{
  const r = deriveProvenance(win([
    turn("user", "always pin versions"),
    turn("toolResult", "[toolResult:read] README: always pin versions"),
    turn("assistant", "the README says always pin versions"),
  ]), "always pin versions");
  assert(r.provenance === "content-in-transcript" && r.matched_roles.length === 3, `three-role match -> transcript sink, got ${JSON.stringify(r)}`);
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
