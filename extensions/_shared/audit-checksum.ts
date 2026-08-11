/**
 * Keyless deterministic audit checksums (replaces the removed local audit
 * HMAC layer, ADR 0027 C6).
 *
 * Single-user threat model: local data security is the user's responsibility.
 * These checksums are NOT authentication — anyone can recompute them. They are
 * deterministic fingerprints for correlation / deduplication / change
 * detection across processes, with domain framing so a digest can never be
 * cross-replayed between namespaces. There is no key material, no key file,
 * no mode/owner/symlink verification, and no ephemeral fallback: the same
 * (domain, value) always produces the same digest in every process.
 */

import { createHash } from "node:crypto";

function frame(value: string | Buffer): Buffer {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return Buffer.concat([length, bytes]);
}

export interface AuditRollingChecksum {
  readonly algorithm: "sha256";
  update(label: string, value: string | Buffer): void;
  digestHex(): string;
}

export function createAuditRollingChecksum(domain: string): AuditRollingChecksum {
  const hash = createHash("sha256");
  hash.update(frame("pi-astack/audit-rolling-checksum/v1"));
  hash.update(frame(domain));
  let finalized: string | undefined;
  return {
    algorithm: "sha256",
    update(label: string, value: string | Buffer): void {
      if (finalized) throw new Error("audit rolling checksum is already finalized");
      hash.update(frame(label));
      hash.update(frame(value));
    },
    digestHex(): string {
      if (!finalized) finalized = hash.digest("hex");
      return finalized;
    },
  };
}

/** Deterministic keyless checksum of (domain, value). Same inputs always
 *  produce the same digest in every process; the domain separates
 *  correlation namespaces so a digest can never be cross-replayed. */
export function auditChecksumHex(domain: string, value: string | Buffer): { algorithm: "sha256"; digest: string } {
  const hash = createHash("sha256");
  hash.update(frame("pi-astack/audit-checksum/v1"));
  hash.update(frame(domain));
  hash.update(frame("value"));
  hash.update(frame(value));
  return { algorithm: "sha256", digest: hash.digest("hex") };
}
