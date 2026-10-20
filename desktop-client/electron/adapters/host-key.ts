import { createHash } from "node:crypto";

/**
 * How a host key is named and fingerprinted.
 *
 * OpenSSH writes a key type with its algorithm in front of it — "ssh-
 * ed25519", "ecdsa-sha2-nistp256" — and a fingerprint as the SHA256 of the
 * key in base64, without the padding.  Two adapters read that: the one
 * that asks a host for its key, and the one that compares it with an
 * entry in known_hosts.  Each of them wrote the rule out.
 */

/** The algorithm of a key type, without the prefix OpenSSH puts in front. */
export function hostKeyAlgorithm(keyType: string): string {
  return keyType.replace(/^ssh-/, "").replace(/^ecdsa-/, "").toUpperCase();
}

/** The fingerprint of a key, as OpenSSH prints it. */
export function hostKeyFingerprint(key: string): string {
  return `SHA256:${createHash("sha256").update(Buffer.from(key, "base64")).digest("base64").replace(/=+$/, "")}`;
}
