# Reasoning Normalization Preamble v1

Per ADR 0025 §4.1.3 and §4.4.2 — this preamble is prepended to every
sediment LLM prompt that participates in classification or verification
(active-correction classifier, multi-view pass-1 proposer, multi-view
pass-2 reviewer). Different base models (Claude/GPT/DeepSeek/etc.) have
different default reasoning surfaces; this preamble normalizes the
output structure so downstream comparison (multi-view verification,
classifier-health meta-check, prompt iteration dossier) can compare
apples-to-apples instead of style-vs-substance.

## Reasoning structure (fixed order — DO NOT REARRANGE)

Your reasoning trace MUST follow this five-stage progression across all
classification dimensions:

1. **QUOTE** — verbatim quote from the input that grounds your reasoning.
   No paraphrase. No reconstruction. If you cannot quote, that itself is
   a signal that the input does not support a confident decision.

2. **CLAIM** — the one-sentence claim you are weighing. State it positively;
   the alternative comes next, not as a hedge here.

3. **ALTERNATIVE** — the strongest one-sentence case AGAINST the claim
   above, using only the quoted material. Treat this as a real argument,
   not a strawman. If you cannot produce a real alternative, your claim
   may be premature; reduce confidence.

4. **UNCERTAINTY** — what specifically would change your mind? Name a
   concrete observation that, if present, would flip the decision. If
   you cannot name one, say so explicitly — that itself is a signal.

5. **RESOLVING EVIDENCE** — the specific evidence that resolved the
   choice in favor of the claim over the alternative. Must reference
   the quoted material in stage 1, not generic phrases.

## Why this matters

Multi-view verification (ADR 0025 §4.4) compares proposer and reviewer
reasoning traces structurally. If both LLMs follow this preamble, the
reviewer can isolate "where did the proposer's reasoning diverge from
mine?" instead of "why does the proposer write so differently from me?"

Classifier health meta-check (ADR 0025 §4.3.3) measures quote rate,
alternative-mention rate, and self-critique concreteness. This preamble
makes those measurements meaningful — without the structural commitment,
"alternative mentioned" could mean "the word 'however' appeared somewhere".

## What this preamble does NOT do

- It does NOT enforce a JSON schema. Schema validation is a separate
  layer (per-prompt output sections). The preamble shapes prose, not
  syntax.
- It does NOT replace per-prompt-specific instructions. Each downstream
  prompt adds its own task-specific structure on top of this preamble.
- It does NOT command a particular conclusion. You may still output
  SKIP, signal_found=false, DEFER, etc. The preamble shapes HOW you
  argue, not WHAT you conclude.

---

(End of reasoning-normalization-preamble-v1. The task-specific prompt
follows below.)
