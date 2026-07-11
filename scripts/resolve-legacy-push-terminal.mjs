#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(root, { interopDefault: true, moduleCache: false });
const runtime = jiti(path.join(root, "extensions/_shared/canonical-git-runtime.ts"));
const recovery = jiti(path.join(root, "extensions/_shared/convergence-recovery.ts"));
const resolver = jiti(path.join(root, "extensions/_shared/legacy-terminal-resolver.ts"));
const transport = jiti(path.join(root, "extensions/_shared/canonical-git-transport.ts"));
const { sha256Hex } = jiti(path.join(root, "extensions/_shared/jcs.ts"));
const l1 = jiti(path.join(root, "extensions/_shared/l1-schema-registry.ts"));

const allowed = new Set(["abrain", "settings", "legacy-episode-id", "intent-event-id", "terminal-event-id"]);
const values = new Map();
const args = process.argv.slice(2);
const preflight = args.filter((value) => value === "--preflight").length === 1;
if (args.filter((value) => value === "--preflight").length > 1) throw new Error("duplicate --preflight is forbidden");
const paired = args.filter((value) => value !== "--preflight");
for (let index = 0; index < paired.length; index += 2) {
  const token = paired[index];
  const value = paired[index + 1];
  if (!token?.startsWith("--") || !value || value.startsWith("--")) throw new Error("resolver requires exact --name value pairs");
  const name = token.slice(2);
  if (!allowed.has(name) || values.has(name)) throw new Error(`unknown or duplicate resolver argument: --${name}`);
  values.set(name, value);
}
for (const name of allowed) if (!values.has(name)) throw new Error(`--${name} is required`);
if (args.some((item) => item === "--all" || item.includes("*"))) throw new Error("bulk, wildcard, and automatic legacy resolution are forbidden");

const abrainHome = await fs.promises.realpath(path.resolve(values.get("abrain")));
const settingsPath = path.resolve(values.get("settings"));
const settings = runtime.resolveCanonicalGitRuntimeSettings(settingsPath);
if (!settings.valid || !settings.transport) throw new Error(`canonical transport settings are ${settings.reason}`);
const legacyEpisodeId = values.get("legacy-episode-id");
const intentEventId = values.get("intent-event-id");
const terminalEventId = values.get("terminal-event-id");
const legacy = resolver.validateExactLegacyTerminal({
  legacyEpisodeId,
  intentEventId,
  terminalEventId,
  scan: await l1.scanWholeL1Validated({ abrainHome }),
  repo: abrainHome,
});
const scope = {
  repo_id: sha256Hex(abrainHome),
  remote: settings.transport.remote,
  ref_name: settings.transport.refName,
  target_commit: legacy.targetCommit,
  remote_url_id: settings.transport.endpointSha256,
  transport_policy_id: settings.transport.transportPolicyId,
};
if (preflight) {
  const session = await transport.CanonicalGitTransportSession.create({ repo: abrainHome, policy: settings.transport });
  await session.close();
  process.stdout.write(`${JSON.stringify({
    status: "preflight-valid",
    mutation: false,
    legacy_episode_id: legacy.legacyEpisodeId,
    intent_event_id: legacy.intentEventId,
    terminal_event_id: legacy.terminalEventId,
    target_commit: legacy.targetCommit,
    remote_url_id: scope.remote_url_id,
    transport_policy_id: scope.transport_policy_id,
    credential_resolution_fingerprint: settings.transport.credentialResolution.credentialResolutionFingerprint,
  })}\n`);
} else {
  const result = await resolver.resolveLegacyPushTerminal({
    abrainHome,
    legacyEpisodeId,
    intentEventId,
    terminalEventId,
    scope,
    transportFactory: () => transport.CanonicalGitTransportSession.create({ repo: abrainHome, policy: settings.transport }),
  });
  process.stdout.write(`${JSON.stringify({ status: "attested", candidate_event_id: result.candidateEventId, attestation_event_id: result.attestationEventId, observed_tip: result.observedTip, relation: result.relation })}\n`);
}
