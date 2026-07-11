import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fsSync from "node:fs";
import * as fsp from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { canonicalizeJcs, sha256Hex } from "./jcs";

const execFileAsync = promisify(execFile);
const OID_RE = /^[0-9a-f]{40,64}$/;
const REF_RE = /^refs\/heads\/[A-Za-z0-9._\/-]+$/;
const ADAPTER_PATH = path.join(__dirname, "credential-broker-adapter.mjs");
const POLICY_DOMAIN = "pi-astack/canonical-git-transport-policy/v2";
const CREDENTIAL_RESOLUTION_DOMAIN = "pi-astack/credential-resolution/v1";
const CREDENTIAL_MATCHING_POLICY_VERSION = "git-credential-urlmatch/v1" as const;
const CREDENTIAL_SCOPE_ORDER = ["unscoped", "host", "path-prefix", "exact-repo"] as const;
type CredentialScopeName = typeof CREDENTIAL_SCOPE_ORDER[number];
type CredentialEntryKind = "reset" | "shell-snippet";

export interface CredentialEntryPolicy {
  kind: CredentialEntryKind;
  valueSha256: string;
}

export interface CredentialScopePolicy {
  scope: CredentialScopeName;
  provenanceSha256: string;
  rawEntryCount: number;
  rawEntries: readonly CredentialEntryPolicy[];
}

export interface CredentialResolutionPolicy {
  source: "global";
  matchingPolicyVersion: typeof CREDENTIAL_MATCHING_POLICY_VERSION;
  includeCount: number;
  scopes: readonly CredentialScopePolicy[];
  effectiveHelperCount: number;
  effectiveHelpers: readonly CredentialEntryPolicy[];
  credentialResolutionFingerprint: string;
}

export interface CanonicalTransportPolicy {
  remote: "origin";
  refName: "refs/heads/main";
  endpointSha256: string;
  credentialResolution: CredentialResolutionPolicy;
  rewritePolicy: "forbidden";
  redirectPolicy: "forbidden";
  promptPolicy: "forbidden";
  transportPolicyId: string;
}

export interface CanonicalEndpointContext {
  protocol: string;
  host: string;
  path: string;
  origin: string;
  pathPrefix: string;
  literal: string;
}

export interface TransportCommandResult {
  exitCode: number;
  stdoutSha256: string;
  stderrSha256: string;
}

export interface StableRemoteProof {
  tipBefore: string;
  fetchedOid: string;
  tipAfter: string;
  remoteContainsTarget: boolean;
  relation: "equal" | "descendant" | "absent";
  commands: readonly TransportCommandResult[];
}

export class CanonicalGitTransportError extends Error {
  readonly code: string;
  readonly stage: string;
  readonly retryable: boolean;
  readonly transportAttempted: boolean;
  readonly commandExitCode: number | null;
  readonly stdoutSha256: string | null;
  readonly stderrSha256: string | null;

  constructor(code: string, message: string, options: {
    stage?: string;
    retryable?: boolean;
    transportAttempted?: boolean;
    commandExitCode?: number | null;
    stdoutSha256?: string | null;
    stderrSha256?: string | null;
  } = {}) {
    super(`${code}: ${message}`);
    this.name = "CanonicalGitTransportError";
    this.code = code;
    this.stage = options.stage ?? "pretransport";
    this.retryable = options.retryable === true;
    this.transportAttempted = options.transportAttempted === true;
    this.commandExitCode = options.commandExitCode ?? null;
    this.stdoutSha256 = options.stdoutSha256 ?? null;
    this.stderrSha256 = options.stderrSha256 ?? null;
  }
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function credentialEntryDescriptor(entry: CredentialEntryPolicy): Record<string, unknown> {
  return { kind: entry.kind, value_sha256: entry.valueSha256 };
}

function credentialScopeDescriptor(scope: CredentialScopePolicy): Record<string, unknown> {
  return {
    scope: scope.scope,
    provenance_sha256: scope.provenanceSha256,
    raw_entry_count: scope.rawEntryCount,
    raw_entries: scope.rawEntries.map(credentialEntryDescriptor),
  };
}

export function credentialResolutionDescriptor(
  endpoint: Pick<CanonicalEndpointContext, "protocol" | "host" | "path">,
  resolution: Omit<CredentialResolutionPolicy, "credentialResolutionFingerprint" | "source">,
): Record<string, unknown> {
  return {
    domain: CREDENTIAL_RESOLUTION_DOMAIN,
    source: "global",
    matching_policy_version: resolution.matchingPolicyVersion,
    endpoint: { protocol: endpoint.protocol, host: endpoint.host, path: endpoint.path },
    include_count: resolution.includeCount,
    scopes: resolution.scopes.map(credentialScopeDescriptor),
    effective_helper_count: resolution.effectiveHelperCount,
    effective_chain: resolution.effectiveHelpers.map(credentialEntryDescriptor),
  };
}

export function deriveCredentialResolutionFingerprint(
  endpoint: Pick<CanonicalEndpointContext, "protocol" | "host" | "path">,
  resolution: Omit<CredentialResolutionPolicy, "credentialResolutionFingerprint" | "source">,
): string {
  return sha256Hex(canonicalizeJcs(credentialResolutionDescriptor(endpoint, resolution) as never));
}

export function transportPolicyDescriptor(policy: Omit<CanonicalTransportPolicy, "transportPolicyId">): Record<string, unknown> {
  return {
    domain: POLICY_DOMAIN,
    remote: policy.remote,
    ref_name: policy.refName,
    endpoint_sha256: policy.endpointSha256,
    credential_resolution: {
      source: policy.credentialResolution.source,
      matching_policy_version: policy.credentialResolution.matchingPolicyVersion,
      include_count: policy.credentialResolution.includeCount,
      scopes: policy.credentialResolution.scopes.map(credentialScopeDescriptor),
      effective_helper_count: policy.credentialResolution.effectiveHelperCount,
      effective_helpers: policy.credentialResolution.effectiveHelpers.map(credentialEntryDescriptor),
      credential_resolution_fingerprint: policy.credentialResolution.credentialResolutionFingerprint,
    },
    rewrite_policy: policy.rewritePolicy,
    redirect_policy: policy.redirectPolicy,
    prompt_policy: policy.promptPolicy,
  };
}

export function deriveTransportPolicyId(policy: Omit<CanonicalTransportPolicy, "transportPolicyId">): string {
  return sha256Hex(canonicalizeJcs(transportPolicyDescriptor(policy) as never));
}

function validateCredentialEntry(value: unknown): CredentialEntryPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CanonicalGitTransportError("TRANSPORT_POLICY_INVALID", "credential entry must be an object");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort(compareAscii).join("\0") !== ["kind", "valueSha256"].join("\0")
    || (raw.kind !== "reset" && raw.kind !== "shell-snippet")
    || typeof raw.valueSha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.valueSha256)) {
    throw new CanonicalGitTransportError("TRANSPORT_POLICY_INVALID", "credential entry differs from the pinned contract");
  }
  return Object.freeze({ kind: raw.kind, valueSha256: raw.valueSha256 });
}

function validateCredentialResolution(value: unknown): CredentialResolutionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CanonicalGitTransportError("TRANSPORT_POLICY_INVALID", "credential resolution must be an object");
  const raw = value as Record<string, unknown>;
  const keys = ["credentialResolutionFingerprint", "effectiveHelperCount", "effectiveHelpers", "includeCount", "matchingPolicyVersion", "scopes", "source"];
  if (Object.keys(raw).sort(compareAscii).join("\0") !== keys.join("\0")
    || raw.source !== "global" || raw.matchingPolicyVersion !== CREDENTIAL_MATCHING_POLICY_VERSION
    || !Number.isInteger(raw.includeCount) || (raw.includeCount as number) < 0
    || !Number.isInteger(raw.effectiveHelperCount) || (raw.effectiveHelperCount as number) < 1
    || typeof raw.credentialResolutionFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(raw.credentialResolutionFingerprint)
    || !Array.isArray(raw.scopes) || raw.scopes.length !== CREDENTIAL_SCOPE_ORDER.length
    || !Array.isArray(raw.effectiveHelpers)) {
    throw new CanonicalGitTransportError("TRANSPORT_POLICY_INVALID", "credential resolution differs from the pinned contract");
  }
  const scopes = raw.scopes.map((value, index): CredentialScopePolicy => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new CanonicalGitTransportError("TRANSPORT_POLICY_INVALID", "credential scope must be an object");
    const scope = value as Record<string, unknown>;
    const scopeKeys = ["provenanceSha256", "rawEntries", "rawEntryCount", "scope"];
    if (Object.keys(scope).sort(compareAscii).join("\0") !== scopeKeys.join("\0")
      || scope.scope !== CREDENTIAL_SCOPE_ORDER[index]
      || typeof scope.provenanceSha256 !== "string" || !/^[0-9a-f]{64}$/.test(scope.provenanceSha256)
      || !Number.isInteger(scope.rawEntryCount) || (scope.rawEntryCount as number) < 0
      || !Array.isArray(scope.rawEntries) || scope.rawEntries.length !== scope.rawEntryCount) {
      throw new CanonicalGitTransportError("TRANSPORT_POLICY_INVALID", "credential scope differs from the pinned lattice");
    }
    return Object.freeze({
      scope: scope.scope as CredentialScopeName,
      provenanceSha256: scope.provenanceSha256,
      rawEntryCount: scope.rawEntryCount as number,
      rawEntries: Object.freeze(scope.rawEntries.map(validateCredentialEntry)),
    });
  });
  const effectiveHelpers = raw.effectiveHelpers.map(validateCredentialEntry);
  if (effectiveHelpers.length !== raw.effectiveHelperCount || effectiveHelpers.some((entry) => entry.kind !== "shell-snippet")) {
    throw new CanonicalGitTransportError("TRANSPORT_POLICY_INVALID", "effective credential helper chain is invalid");
  }
  return Object.freeze({
    source: "global",
    matchingPolicyVersion: CREDENTIAL_MATCHING_POLICY_VERSION,
    includeCount: raw.includeCount as number,
    scopes: Object.freeze(scopes),
    effectiveHelperCount: raw.effectiveHelperCount as number,
    effectiveHelpers: Object.freeze(effectiveHelpers),
    credentialResolutionFingerprint: raw.credentialResolutionFingerprint as string,
  });
}

export function validateTransportPolicy(value: unknown): CanonicalTransportPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CanonicalGitTransportError("TRANSPORT_POLICY_INVALID", "transport policy must be an object");
  const raw = value as Record<string, unknown>;
  const expectedKeys = ["credentialResolution", "endpointSha256", "promptPolicy", "redirectPolicy", "refName", "remote", "rewritePolicy", "transportPolicyId"];
  if (Object.keys(raw).sort(compareAscii).join("\0") !== expectedKeys.join("\0")) throw new CanonicalGitTransportError("TRANSPORT_POLICY_INVALID", "transport policy keys differ from the pinned v2 contract");
  const credentialResolution = validateCredentialResolution(raw.credentialResolution);
  if (
    raw.remote !== "origin" || raw.refName !== "refs/heads/main"
    || typeof raw.endpointSha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.endpointSha256)
    || raw.rewritePolicy !== "forbidden" || raw.redirectPolicy !== "forbidden" || raw.promptPolicy !== "forbidden"
    || typeof raw.transportPolicyId !== "string" || !/^[0-9a-f]{64}$/.test(raw.transportPolicyId)
  ) throw new CanonicalGitTransportError("TRANSPORT_POLICY_INVALID", "transport policy values differ from the pinned v2 contract");
  const policy = { ...raw, credentialResolution } as unknown as CanonicalTransportPolicy;
  const { transportPolicyId: _ignored, ...withoutId } = policy;
  if (deriveTransportPolicyId(withoutId) !== policy.transportPolicyId) throw new CanonicalGitTransportError("TRANSPORT_POLICY_ID_MISMATCH", "transport policy id does not match its canonical descriptor");
  return Object.freeze(policy);
}

function baseEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const forbidden = new Set(["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "CURL_CA_BUNDLE", "SSL_CERT_FILE", "SSL_CERT_DIR"]);
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_") && !forbidden.has(key) && value !== undefined) env[key] = value;
  return { ...env, LANG: "C", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false", SSH_ASKPASS: "/bin/false" };
}

async function cleanLocalGit(repo: string, args: readonly string[], encoding: BufferEncoding = "utf8"): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repo, "--literal-pathspecs", ...args], {
    env: { ...baseEnvironment(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    encoding,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15_000,
  });
  return String(stdout);
}

export function canonicalEndpointContext(raw: string): CanonicalEndpointContext {
  if (raw.includes("\0") || /[\r\n]/.test(raw)) throw new CanonicalGitTransportError("REMOTE_ENDPOINT_INVALID", "remote endpoint contains control bytes");
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new CanonicalGitTransportError("REMOTE_ENDPOINT_INVALID", "remote endpoint is not an absolute URL"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw new CanonicalGitTransportError("REMOTE_ENDPOINT_INVALID", "remote endpoint must be credential-free literal HTTPS without query or fragment");
  }
  if (parsed.toString() !== raw) throw new CanonicalGitTransportError("REMOTE_ENDPOINT_NONCANONICAL", "remote endpoint literal is not WHATWG-canonical");
  if (!parsed.pathname.startsWith("/") || parsed.pathname === "/" || parsed.pathname.endsWith("/")) {
    throw new CanonicalGitTransportError("REMOTE_ENDPOINT_INVALID", "remote endpoint must name one non-directory repository path");
  }
  const protocol = parsed.protocol.slice(0, -1);
  const host = parsed.host;
  const credentialPath = parsed.pathname.slice(1);
  const slash = parsed.pathname.lastIndexOf("/");
  const origin = `${parsed.protocol}//${parsed.host}`;
  const pathPrefix = slash <= 0 ? origin : `${origin}${parsed.pathname.slice(0, slash)}`;
  return Object.freeze({ protocol, host, path: credentialPath, origin, pathPrefix, literal: raw });
}

function splitNullConfig(stdout: Buffer): Array<{ key: string; value: Buffer }> {
  const rows: Array<{ key: string; value: Buffer }> = [];
  let start = 0;
  for (let index = 0; index <= stdout.length; index += 1) {
    if (index < stdout.length && stdout[index] !== 0) continue;
    if (index === start) { start = index + 1; continue; }
    const row = stdout.subarray(start, index);
    const newline = row.indexOf(0x0a);
    if (newline <= 0) throw new CanonicalGitTransportError("CREDENTIAL_CONFIG_PARSE_FAILED", "expanded global config row is malformed");
    let key: string;
    try { key = new TextDecoder("utf-8", { fatal: true }).decode(row.subarray(0, newline)); }
    catch { throw new CanonicalGitTransportError("CREDENTIAL_CONFIG_PARSE_FAILED", "expanded global config key is not UTF-8"); }
    rows.push({ key, value: Buffer.from(row.subarray(newline + 1)) });
    start = index + 1;
  }
  return rows;
}

async function resolveLiteralEndpoint(repo: string, policy: CanonicalTransportPolicy): Promise<CanonicalEndpointContext> {
  const remoteRows = (await cleanLocalGit(repo, ["config", "--local", "--get-all", "remote.origin.url"])).split("\n").filter(Boolean);
  if (remoteRows.length !== 1) throw new CanonicalGitTransportError("REMOTE_ENDPOINT_COUNT", "local origin must contain one URL");
  const endpoint = canonicalEndpointContext(remoteRows[0]!);
  if (sha256Hex(endpoint.literal) !== policy.endpointSha256) throw new CanonicalGitTransportError("REMOTE_ENDPOINT_HASH_MISMATCH", "local origin endpoint does not match the production endpoint id");
  const unsafeConfig = [
    await cleanLocalGit(repo, ["config", "--local", "--includes", "--null", "--name-only", "--list"]),
    await cleanLocalGit(repo, ["config", "--worktree", "--includes", "--null", "--name-only", "--list"]),
  ].join("\0");
  const unsafeNames = unsafeConfig.split("\0").filter(Boolean).map((name) => name.toLowerCase()).filter((name) => (
    name.startsWith("url.") || name === "credential.helper" || name.startsWith("credential.")
    || name === "core.askpass" || name === "core.hookspath" || name === "include.path" || name.startsWith("includeif.")
    || name === "http.proxy" || name.startsWith("http.")
  ));
  if (unsafeNames.length) throw new CanonicalGitTransportError("REMOTE_LOCAL_CONFIG_FORBIDDEN", "local/worktree rewrites, credentials, hooks, includes, and HTTP/TLS overrides are forbidden");
  const resolution = policy.credentialResolution;
  const { credentialResolutionFingerprint: _fingerprint, source: _source, ...withoutFingerprint } = resolution;
  const actualFingerprint = deriveCredentialResolutionFingerprint(endpoint, withoutFingerprint);
  if (actualFingerprint !== resolution.credentialResolutionFingerprint) {
    throw new CanonicalGitTransportError("CREDENTIAL_RESOLUTION_FINGERPRINT_MISMATCH", "pinned credential resolution does not bind this canonical endpoint context");
  }
  return endpoint;
}

function expectedScopeProvenance(endpoint: CanonicalEndpointContext): readonly string[] {
  return Object.freeze([sha256Hex(""), sha256Hex(endpoint.origin), sha256Hex(endpoint.pathPrefix), sha256Hex(endpoint.literal)]);
}

function classifyCredentialScope(key: string, endpoint: CanonicalEndpointContext): CredentialScopeName | "unrelated" | "unpinned" {
  if (key === "credential.helper") return "unscoped";
  if (!key.startsWith("credential.") || !key.endsWith(".helper")) return "unrelated";
  const literal = key.slice("credential.".length, -".helper".length);
  let parsed: URL;
  try { parsed = new URL(literal); } catch { return "unrelated"; }
  if (parsed.protocol.slice(0, -1) !== endpoint.protocol || parsed.host !== endpoint.host || parsed.username || parsed.password || parsed.search || parsed.hash) return "unrelated";
  const normalized = parsed.pathname === "/" ? `${parsed.protocol}//${parsed.host}` : parsed.toString();
  if (normalized === endpoint.origin) return "host";
  if (normalized === endpoint.pathPrefix) return "path-prefix";
  if (normalized === endpoint.literal) return "exact-repo";
  const candidatePath = parsed.pathname === "/" ? "" : parsed.pathname.slice(1);
  if (candidatePath && (endpoint.path === candidatePath || endpoint.path.startsWith(`${candidatePath}/`))) return "unpinned";
  return "unrelated";
}

async function readPinnedGlobalHelpers(endpoint: CanonicalEndpointContext, policy: CredentialResolutionPolicy, globalConfigPath?: string): Promise<readonly Buffer[]> {
  const args = globalConfigPath
    ? ["config", "--file", globalConfigPath, "--includes", "--null", "--list"]
    : ["config", "--global", "--includes", "--null", "--list"];
  let stdout = Buffer.alloc(0);
  const rows: Array<{ key: string; value: Buffer }> = [];
  const byScope = new Map<CredentialScopeName, Buffer[]>(CREDENTIAL_SCOPE_ORDER.map((scope) => [scope, []]));
  const effective: Buffer[] = [];
  try {
    try {
      const result = await execFileAsync("git", args, { env: baseEnvironment(), encoding: "buffer", maxBuffer: 8 * 1024 * 1024, timeout: 10_000 });
      stdout = result.stdout as Buffer;
    } catch {
      throw new CanonicalGitTransportError("CREDENTIAL_CONFIG_READ_FAILED", "expanded global credential config could not be read");
    }
    rows.push(...splitNullConfig(stdout));
    const includeCount = rows.filter((row) => row.key === "include.path" || row.key.startsWith("includeif.") && row.key.endsWith(".path")).length;
    if (includeCount !== policy.includeCount) throw new CanonicalGitTransportError("CREDENTIAL_INCLUDE_COUNT_MISMATCH", "expanded global include count drifted");
    for (const row of rows) {
      const scope = classifyCredentialScope(row.key, endpoint);
      if (scope === "unpinned") throw new CanonicalGitTransportError("CREDENTIAL_SCOPE_UNPINNED", "a matching path scope is outside the pinned credential lattice");
      if (scope !== "unrelated") byScope.get(scope)!.push(row.value);
    }
    const provenance = expectedScopeProvenance(endpoint);
    for (let scopeIndex = 0; scopeIndex < CREDENTIAL_SCOPE_ORDER.length; scopeIndex += 1) {
      const scopeName = CREDENTIAL_SCOPE_ORDER[scopeIndex]!;
      const expected = policy.scopes[scopeIndex]!;
      const actual = byScope.get(scopeName)!;
      if (expected.scope !== scopeName || expected.provenanceSha256 !== provenance[scopeIndex]) throw new CanonicalGitTransportError("CREDENTIAL_SCOPE_PROVENANCE_MISMATCH", "credential scope provenance drifted");
      if (actual.length !== expected.rawEntryCount) throw new CanonicalGitTransportError("CREDENTIAL_SCOPE_COUNT_MISMATCH", `credential ${scopeName} raw entry count drifted`);
      for (let entryIndex = 0; entryIndex < actual.length; entryIndex += 1) {
        const value = actual[entryIndex]!;
        let decoded: string;
        try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(value); }
        catch { throw new CanonicalGitTransportError("CREDENTIAL_HELPER_UTF8_INVALID", "global helper is not exact UTF-8"); }
        const kind: CredentialEntryKind = value.length === 0 ? "reset" : value[0] === 0x21 ? "shell-snippet" : (() => { throw new CanonicalGitTransportError("CREDENTIAL_HELPER_KIND_MISMATCH", "global helper kind drifted"); })();
        if (decoded.includes("\0") || expected.rawEntries[entryIndex]?.kind !== kind || expected.rawEntries[entryIndex]?.valueSha256 !== sha256Hex(value)) {
          throw new CanonicalGitTransportError("CREDENTIAL_HELPER_HASH_MISMATCH", "global helper order, kind, or bytes drifted");
        }
        if (kind === "reset") {
          for (const helper of effective) helper.fill(0);
          effective.splice(0);
        } else effective.push(Buffer.from(value));
      }
    }
    if (effective.length !== policy.effectiveHelperCount || effective.length !== policy.effectiveHelpers.length) throw new CanonicalGitTransportError("CREDENTIAL_EFFECTIVE_COUNT_MISMATCH", "effective helper chain count drifted");
    for (let index = 0; index < effective.length; index += 1) {
      const expected = policy.effectiveHelpers[index]!;
      if (expected.kind !== "shell-snippet" || expected.valueSha256 !== sha256Hex(effective[index]!)) throw new CanonicalGitTransportError("CREDENTIAL_EFFECTIVE_HASH_MISMATCH", "effective helper chain drifted");
    }
    return Object.freeze(effective.map((helper) => Buffer.from(helper)));
  } finally {
    stdout.fill(0);
    for (const row of rows) row.value.fill(0);
    for (const values of byScope.values()) for (const value of values) value.fill(0);
    for (const helper of effective) helper.fill(0);
  }
}

export function validateCredentialProtocol(protocol: Buffer, endpoint: CanonicalEndpointContext): Readonly<Record<string, string>> {
  if (protocol.length === 0 || protocol.length > 1024 * 1024 || protocol.includes(0) || protocol.includes(0x0d)) throw new CanonicalGitTransportError("BROKER_CREDENTIAL_PROTOCOL_INVALID", "credential protocol contains invalid control bytes");
  for (const byte of protocol) if (byte < 0x20 && byte !== 0x0a) throw new CanonicalGitTransportError("BROKER_CREDENTIAL_PROTOCOL_INVALID", "credential protocol contains invalid control bytes");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(protocol);
  // Git consumes the caller's blank-line terminator and sends each helper one
  // record ending in exactly one LF. That helper-side wire shape is canonical;
  // a second LF or any bytes after it are trailing, unparsed content.
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n\n")) throw new CanonicalGitTransportError("BROKER_CREDENTIAL_PROTOCOL_INVALID", "credential protocol is not one canonical helper record");
  const allowed = new Set(["protocol", "host", "path", "username", "password", "password_expiry_utc", "oauth_refresh_token", "authtype", "credential", "wwwauth[]", "url"]);
  const fields: Record<string, string> = {};
  for (const line of text.slice(0, -1).split("\n")) {
    const equals = line.indexOf("=");
    const key = equals < 1 ? "" : line.slice(0, equals);
    const value = equals < 1 ? "" : line.slice(equals + 1);
    if (!allowed.has(key) || Object.prototype.hasOwnProperty.call(fields, key)) throw new CanonicalGitTransportError("BROKER_CREDENTIAL_PROTOCOL_INVALID", "credential protocol contains unknown or duplicate fields");
    fields[key] = value;
  }
  if (fields.protocol !== endpoint.protocol || fields.host !== endpoint.host || fields.path !== endpoint.path) {
    throw new CanonicalGitTransportError("BROKER_ENDPOINT_CONTEXT_MISMATCH", "credential protocol endpoint context differs from the pinned literal endpoint");
  }
  if (fields.url !== undefined && fields.url !== endpoint.literal) throw new CanonicalGitTransportError("BROKER_ENDPOINT_CONTEXT_MISMATCH", "credential url differs from the pinned literal endpoint");
  return Object.freeze(fields);
}

function redactedTransportSha256(bytes: Buffer, endpoint: string): string {
  const redacted = bytes.toString("utf8")
    .split(endpoint).join("<endpoint>")
    .replace(/https:\/\/[^\s/@:]+:[^\s/@]+@/gi, "https://<credential>@")
    .replace(/https:\/\/[^\s/@]+@/gi, "https://<credential>@");
  return sha256Hex(redacted);
}

function shellQuote(value: string): string {
  if (!value || /[^A-Za-z0-9_@%+=:,./-]/.test(value)) throw new CanonicalGitTransportError("ADAPTER_ARGUMENT_UNSAFE", "broker adapter argument is not shell-safe");
  return value;
}

async function readSocketRequest(socket: net.Socket): Promise<{ header: any; body: Buffer }> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    let header: any;
    let bodyOffset = -1;
    const fail = (error: unknown) => { socket.removeAllListeners("data"); buffered.fill(0); reject(error); };
    socket.on("error", fail);
    socket.on("data", (chunk) => {
      const next = Buffer.concat([buffered, Buffer.from(chunk)]);
      buffered.fill(0);
      buffered = next;
      if (bodyOffset < 0) {
        const newline = buffered.indexOf(0x0a);
        if (newline < 0) {
          if (buffered.length > 8192) fail(new CanonicalGitTransportError("BROKER_PROTOCOL_INVALID", "broker request header is too large"));
          return;
        }
        try { header = JSON.parse(buffered.subarray(0, newline).toString("utf8")); } catch { fail(new CanonicalGitTransportError("BROKER_PROTOCOL_INVALID", "broker request header is invalid")); return; }
        if (!Number.isInteger(header?.bytes) || header.bytes < 0 || header.bytes > 16 * 1024 * 1024) { fail(new CanonicalGitTransportError("BROKER_PROTOCOL_INVALID", "broker request byte count is invalid")); return; }
        bodyOffset = newline + 1;
      }
      const received = buffered.length - bodyOffset;
      if (received > header.bytes) { fail(new CanonicalGitTransportError("BROKER_PROTOCOL_INVALID", "broker request contains trailing bytes")); return; }
      if (received === header.bytes) {
        socket.removeListener("error", fail);
        socket.removeAllListeners("data");
        const body = Buffer.from(buffered.subarray(bodyOffset));
        buffered.fill(0);
        resolve({ header, body });
      }
    });
  });
}

async function invokeHelper(helper: Buffer, operation: string, protocol: Buffer): Promise<{ ok: boolean; stdout: Buffer; exitCode: number; stderrSha256: string }> {
  if (!["get", "store", "erase"].includes(operation)) throw new CanonicalGitTransportError("BROKER_OPERATION_INVALID", "credential operation is not allowed");
  const script = Buffer.concat([helper.subarray(1), Buffer.from(` ${operation}\n`, "ascii")]);
  return new Promise((resolve, reject) => {
    let settled = false;
    const stdout: Buffer[] = [];
    const stderrHash = createHash("sha256");
    const wipeScript = () => script.fill(0);
    const fail = (error: unknown) => {
      wipeScript();
      for (const chunk of stdout) chunk.fill(0);
      if (!settled) { settled = true; reject(error); }
    };
    let child;
    try { child = spawn("/bin/sh", ["-c", "eval \"$(cat <&3)\""], { env: baseEnvironment(), stdio: ["pipe", "pipe", "pipe", "pipe"] }); }
    catch (error) { fail(error); return; }
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderrHash.update(chunk));
    child.once("error", fail);
    child.once("close", (code) => {
      wipeScript();
      if (settled) { for (const chunk of stdout) chunk.fill(0); return; }
      settled = true;
      const output = Buffer.concat(stdout);
      for (const chunk of stdout) chunk.fill(0);
      resolve({ ok: code === 0, stdout: output, exitCode: code ?? -1, stderrSha256: stderrHash.digest("hex") });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(protocol);
    const scriptFd = child.stdio[3];
    if (!scriptFd || !("end" in scriptFd)) {
      child.kill();
      fail(new CanonicalGitTransportError("BROKER_SCRIPT_FD_UNAVAILABLE", "independent script pipe is unavailable"));
      return;
    }
    (scriptFd as NodeJS.WritableStream).on?.("error", fail);
    (scriptFd as NodeJS.WritableStream).end(script, wipeScript);
  });
}

interface RawGitResult {
  exitCode: number;
  stdout: Buffer;
  stderrSha256: string;
  stdoutSha256: string;
  retryableNetwork: boolean;
}

export class CanonicalGitTransportSession {
  readonly repo: string;
  readonly endpoint: string;
  readonly policy: CanonicalTransportPolicy;
  private readonly endpointContext: CanonicalEndpointContext;
  private readonly helpers: readonly Buffer[];
  private readonly tlsVerify: boolean;
  private readonly capability = randomBytes(32).toString("hex");
  private readonly tmpDir: string;
  private readonly socketPath: string;
  private readonly configPath: string;
  private server?: net.Server;
  private revoked = false;

  private constructor(args: { repo: string; endpoint: CanonicalEndpointContext; policy: CanonicalTransportPolicy; helpers: readonly Buffer[]; tmpDir: string; tlsVerify: boolean }) {
    this.repo = args.repo;
    this.endpoint = args.endpoint.literal;
    this.endpointContext = args.endpoint;
    this.policy = args.policy;
    this.helpers = args.helpers;
    this.tlsVerify = args.tlsVerify;
    this.tmpDir = args.tmpDir;
    this.socketPath = path.join(args.tmpDir, "broker.sock");
    this.configPath = path.join(args.tmpDir, "gitconfig");
  }

  static async create(options: { repo: string; policy: CanonicalTransportPolicy; globalConfigPath?: string; allowInsecureTestTls?: boolean }): Promise<CanonicalGitTransportSession> {
    if (process.platform !== "linux" || !fsSync.existsSync("/proc/self/fd")) throw new CanonicalGitTransportError("BROKER_OS_UNSUPPORTED", "Linux /proc fd execution is required");
    const policy = validateTransportPolicy(options.policy);
    const repo = await fsp.realpath(path.resolve(options.repo));
    let helpers: readonly Buffer[] = [];
    let tmpDir: string | undefined;
    let session: CanonicalGitTransportSession | undefined;
    try {
      if (options.allowInsecureTestTls && process.env.PI_ASTACK_ENABLE_TEST_HOOKS !== "1") throw new CanonicalGitTransportError("TEST_HOOK_DISABLED", "insecure TLS is fixture-only");
      const endpoint = await resolveLiteralEndpoint(repo, policy);
      helpers = await readPinnedGlobalHelpers(endpoint, policy.credentialResolution, options.globalConfigPath);
      tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-astack-git-transport-"));
      await fsp.chmod(tmpDir, 0o700);
      session = new CanonicalGitTransportSession({ repo, endpoint, policy, helpers, tmpDir, tlsVerify: !options.allowInsecureTestTls });
      await session.start();
      return session;
    } catch (error) {
      if (session) await session.close();
      else {
        for (const helper of helpers) helper.fill(0);
        if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }
  }

  private async start(): Promise<void> {
    this.server = net.createServer({ allowHalfOpen: true }, async (socket) => {
      socket.on("error", () => undefined);
      try {
        const { header, body } = await readSocketRequest(socket);
        if (this.revoked || header.capability !== this.capability || !Number.isInteger(header.index) || header.index < 0 || header.index >= this.helpers.length || !["get", "store", "erase"].includes(header.operation)) {
          throw new CanonicalGitTransportError("BROKER_CAPABILITY_REJECTED", "credential broker capability or request was rejected");
        }
        let result: Awaited<ReturnType<typeof invokeHelper>>;
        try {
          validateCredentialProtocol(body, this.endpointContext);
          result = await invokeHelper(this.helpers[header.index]!, header.operation, body);
        } finally { body.fill(0); }
        const response = Buffer.concat([Buffer.from(`${JSON.stringify({ ok: result.ok, bytes: result.stdout.length, exit_code: result.exitCode, stderr_sha256: result.stderrSha256 })}\n`), result.stdout]);
        socket.end(response, () => { response.fill(0); result.stdout.fill(0); });
      } catch (error) {
        const digest = sha256Hex(error instanceof Error ? error.message : String(error));
        socket.end(`${JSON.stringify({ ok: false, bytes: 0, exit_code: 5, stderr_sha256: digest })}\n`);
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, () => resolve());
    });
    await fsp.chmod(this.socketPath, 0o600);
    const node = shellQuote(process.execPath);
    const adapter = shellQuote(ADAPTER_PATH);
    const socket = shellQuote(this.socketPath);
    const cap = shellQuote(this.capability);
    const lines = ["[credential]", "\tuseHttpPath = true"];
    for (let index = 0; index < this.helpers.length; index += 1) lines.push(`\thelper = !${node} ${adapter} ${socket} ${cap} ${index}`);
    await fsp.writeFile(this.configPath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fsp.chmod(this.configPath, 0o600);
  }

  private async git(args: readonly string[], stage: string, timeout = 60_000, input?: Buffer): Promise<RawGitResult> {
    if (this.revoked) throw new CanonicalGitTransportError("TRANSPORT_REVOKED", "transport session is revoked", { stage });
    const env = {
      ...baseEnvironment(),
      GIT_CONFIG_GLOBAL: this.configPath,
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
    };
    return new Promise((resolve, reject) => {
      const child = spawn("git", ["-C", this.repo, "--literal-pathspecs", "-c", "core.hooksPath=/dev/null", "-c", "http.followRedirects=false", "-c", `http.sslVerify=${this.tlsVerify ? "true" : "false"}`, "-c", "credential.useHttpPath=true", "-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args], {
        env,
        stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stderrBytes = 0;
      const stderrClassifier: Buffer[] = [];
      let stderrClassifierBytes = 0;
      const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
      child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > 64 * 1024 * 1024) { child.kill("SIGKILL"); return; }
        stderr.push(Buffer.from(chunk));
        if (stderrClassifierBytes < 64 * 1024) {
          const kept = Buffer.from(chunk).subarray(0, 64 * 1024 - stderrClassifierBytes);
          stderrClassifier.push(kept);
          stderrClassifierBytes += kept.length;
        }
      });
      if (input) child.stdin.end(input);
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(timer);
        const output = Buffer.concat(stdout);
        const stderrOutput = Buffer.concat(stderr);
        const classifierText = Buffer.concat(stderrClassifier).toString("utf8");
        const retryableNetwork = /could not resolve host|failed to connect|connection (?:timed out|reset)|network is unreachable|temporary failure|remote end hung up unexpectedly|http 50[234]|tls connection was non-properly terminated/i.test(classifierText)
          && !/authentication failed|permission denied|repository not found|non-fast-forward|protected branch|rejected/i.test(classifierText);
        for (const chunk of stderrClassifier) chunk.fill(0);
        const stdoutSha256 = redactedTransportSha256(output, this.endpoint);
        const stderrSha256 = redactedTransportSha256(stderrOutput, this.endpoint);
        stderrOutput.fill(0);
        for (const chunk of stderr) chunk.fill(0);
        resolve({ exitCode: code ?? -1, stdout: output, stdoutSha256, stderrSha256, retryableNetwork });
      });
    });
  }

  private parseTip(result: RawGitResult, stage: string): string {
    if (result.exitCode !== 0) throw commandFailure(stage, result);
    const text = result.stdout.toString("utf8").trim();
    const rows = text ? text.split("\n") : [];
    if (rows.length !== 1) throw new CanonicalGitTransportError("REMOTE_REF_UNSTABLE", "remote did not advertise one exact ref", commandEvidence(stage, result));
    const fields = rows[0]!.split(/\s+/);
    if (fields.length !== 2 || fields[1] !== this.policy.refName || !OID_RE.test(fields[0]!)) throw new CanonicalGitTransportError("REMOTE_REF_INVALID", "remote advertisement is malformed", commandEvidence(stage, result));
    return fields[0]!;
  }

  private async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const result = await this.git(["merge-base", "--is-ancestor", ancestor, descendant], "proof_ancestry", 10_000);
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw commandFailure("proof_ancestry", result);
  }

  async stableProof(targetCommit: string): Promise<StableRemoteProof> {
    if (!OID_RE.test(targetCommit)) throw new CanonicalGitTransportError("PUSH_TARGET_INVALID", "target commit is not an object id");
    if (!REF_RE.test(this.policy.refName) || this.policy.refName.includes("..")) throw new CanonicalGitTransportError("REMOTE_REF_INVALID", "configured ref is unsafe");
    const commands: TransportCommandResult[] = [];
    const beforeResult = await this.git(["ls-remote", "--refs", this.endpoint, this.policy.refName], "proof_tip_before");
    commands.push(commandResult(beforeResult));
    const tipBefore = this.parseTip(beforeResult, "proof_tip_before");
    beforeResult.stdout.fill(0);
    const fetchResult = await this.git(["fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", this.endpoint, this.policy.refName], "proof_object_fetch");
    commands.push(commandResult(fetchResult));
    if (fetchResult.exitCode !== 0) throw commandFailure("proof_object_fetch", fetchResult);
    fetchResult.stdout.fill(0);
    const objectResult = await this.git(["cat-file", "-e", `${tipBefore}^{commit}`], "proof_object");
    commands.push(commandResult(objectResult));
    if (objectResult.exitCode !== 0) throw commandFailure("proof_object", objectResult);
    objectResult.stdout.fill(0);
    const afterResult = await this.git(["ls-remote", "--refs", this.endpoint, this.policy.refName], "proof_tip_after");
    commands.push(commandResult(afterResult));
    const tipAfter = this.parseTip(afterResult, "proof_tip_after");
    afterResult.stdout.fill(0);
    if (tipBefore !== tipAfter) throw new CanonicalGitTransportError("REMOTE_TIP_CHANGED", "remote tip changed during stable proof", commandEvidence("proof_tip_after", afterResult));
    const contains = tipAfter === targetCommit || await this.isAncestor(targetCommit, tipAfter);
    return Object.freeze({
      tipBefore,
      fetchedOid: tipBefore,
      tipAfter,
      remoteContainsTarget: contains,
      relation: !contains ? "absent" : tipAfter === targetCommit ? "equal" : "descendant",
      commands: Object.freeze(commands),
    });
  }

  async push(targetCommit: string): Promise<{ command: TransportCommandResult; exitCode: number; retryableNetwork: boolean }> {
    if (!OID_RE.test(targetCommit)) throw new CanonicalGitTransportError("PUSH_TARGET_INVALID", "target commit is not an object id");
    const result = await this.git(["push", "--porcelain", this.endpoint, `${targetCommit}:${this.policy.refName}`], "push");
    const response = { command: commandResult(result), exitCode: result.exitCode, retryableNetwork: result.retryableNetwork };
    result.stdout.fill(0);
    return response;
  }

  async _helperForTests(index: number, operation: "get" | "store" | "erase", protocol: Buffer): Promise<{ ok: boolean; stdout: Buffer; exitCode: number; stderrSha256: string }> {
    if (process.env.PI_ASTACK_ENABLE_TEST_HOOKS !== "1") throw new CanonicalGitTransportError("TEST_HOOK_DISABLED", "credential test hook is disabled");
    return invokeHelper(this.helpers[index]!, operation, protocol);
  }

  async _credentialForTests(operation: "get" | "store" | "erase", protocol: Buffer): Promise<{ exitCode: number; stdout: Buffer; stdoutSha256: string; stderrSha256: string }> {
    if (process.env.PI_ASTACK_ENABLE_TEST_HOOKS !== "1") throw new CanonicalGitTransportError("TEST_HOOK_DISABLED", "credential test hook is disabled");
    const command = operation === "get" ? "fill" : operation === "store" ? "approve" : "reject";
    const result = await this.git(["credential", command], `credential_${operation}`, 30_000, protocol);
    return result;
  }

  _debugPathsForTests(): { tmpDir: string; configPath: string; socketPath: string } {
    if (process.env.PI_ASTACK_ENABLE_TEST_HOOKS !== "1") throw new CanonicalGitTransportError("TEST_HOOK_DISABLED", "transport path test hook is disabled");
    return { tmpDir: this.tmpDir, configPath: this.configPath, socketPath: this.socketPath };
  }

  async close(): Promise<void> {
    if (this.revoked) return;
    this.revoked = true;
    for (const helper of this.helpers) helper.fill(0);
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve())).catch(() => undefined);
    await fsp.rm(this.tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function commandResult(result: RawGitResult): TransportCommandResult {
  return { exitCode: result.exitCode, stdoutSha256: result.stdoutSha256, stderrSha256: result.stderrSha256 };
}

function commandEvidence(stage: string, result: RawGitResult) {
  return { stage, transportAttempted: false, commandExitCode: result.exitCode, stdoutSha256: result.stdoutSha256, stderrSha256: result.stderrSha256 };
}

function commandFailure(stage: string, result: RawGitResult): CanonicalGitTransportError {
  const retryable = result.exitCode !== 0 && result.retryableNetwork;
  return new CanonicalGitTransportError(retryable ? "NETWORK_TRANSIENT" : "REMOTE_PROOF_FAILED", "remote command failed", { ...commandEvidence(stage, result), retryable });
}

export async function withCanonicalGitTransport<T>(options: {
  repo: string;
  policy: CanonicalTransportPolicy;
  globalConfigPath?: string;
}, fn: (session: CanonicalGitTransportSession) => Promise<T>): Promise<T> {
  const session = await CanonicalGitTransportSession.create(options);
  try { return await fn(session); } finally { await session.close(); }
}
