/**
 * Footer status key registry for pi-astack extensions.
 *
 * pi renders extension statuses in the footer sorted by key
 * (localeCompare, ascending) — see
 * pi-coding-agent/dist/modes/interactive/components/footer.js. There is
 * no priority parameter on `ctx.ui.setStatus()`, so display order is
 * fully determined by the key string.
 *
 * Convention: `NN-<extension-name>` where NN is a zero-padded 2-digit
 * prefix. We pad to 2 digits and leave gaps (01 / 02 / 03 rather than
 * 1 / 2 / 3) so a new extension can slot between siblings without
 * renumbering. String-sort keeps `01a-foo` < `02-bar`, etc.
 *
 * Display order rationale — follows the event timeline so the footer
 * reads left-to-right as "environment → turn → end-of-turn":
 *
 *   00  multi-instance peer/risk visibility and stale-context guard.
 *                      Updated from session/tool lifecycle events.
 *
 *   01  model-curator  environment readiness (which models are usable
 *                      in this session). Set once at session_start.
 *
 *   02  dispatch       main-session tool lifecycle (idle/running/
 *                      completed/failed). Updated per dispatch_*
 *                      tool call.
 *
 *   03  abrain-rules   session-start rule injection status. Set once at
 *                      session_start; affects the next agent call.
 *
 *   04  sediment       agent_end background extraction status. Updated
 *                      per turn after the LLM returns.
 *
 *   05  tool-contract  provider payload contract status and rare protocol
 *                      mismatch alarms. Mostly idle/diagnostic; sorts after
 *                      end-of-turn sediment because it concerns final LLM
 *                      request/response shape rather than environment setup.
 *
 * To add a new extension:
 *   1. Pick an unused 2-digit prefix that fits the timeline.
 *   2. Add an entry here so the registry stays the single source of
 *      truth — never hardcode a `setStatus(...)` key in the extension.
 */

export const FOOTER_STATUS_KEYS = {
  multiInstance: "00-multi-instance",
  modelCurator: "01-model-curator",
  dispatch:     "02-dispatch",
  abrainRules:  "03-abrain-rules",
  sediment:     "04-sediment",
  constraintCompile: "04a-constraint-compile",
  toolContract: "05-tool-contract",
  openaiServiceTier: "05a-openai-service-tier",
} as const;

export type FooterStatusKey =
  (typeof FOOTER_STATUS_KEYS)[keyof typeof FOOTER_STATUS_KEYS];
