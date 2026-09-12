/**
 * Identity and key derivation.
 *
 * There is no login system and no password reset -- the recovery code *is*
 * the account. Everything here follows from that: derive don't persist, and
 * never let a single raw KDF output serve two purposes (encryption and
 * authentication) without domain separation, or a weakness in one leaks into
 * the other.
 */

import { argon2id } from "hash-wasm";
import { fromBase64, toBase64, utf8 } from "./crypto.js";

const RECOVERY_CODE_PREFIX = "SLDT";
const ARGON2_OUTPUT_BYTES = 64; // 32 for the AES-256 key, 32 for the HMAC auth key.
const ARGON2_ITERATIONS = 3;
const ARGON2_MEMORY_KIB = 65536; // 64 MiB -- memory-hard enough to resist GPU brute force even if datasetId leaks.
const ARGON2_PARALLELISM = 1;

export interface Identity {
  /** Public, random. Doubles as the object-store path prefix -- fine to leak, it names the dataset, not the secret. */
  datasetId: string;
  /** Private, high-entropy. Never written to disk; re-supplied or re-derived every session. */
  secret: string;
}

export interface DerivedKeys {
  /** Raw 32-byte AES-256-GCM key material. */
  encryptionKey: Uint8Array;
  /** Raw 32-byte HMAC-SHA-256 key material -- domain-separated from the encryption key. */
  authKey: Uint8Array;
}

export function generateDatasetId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return toBase64Url(bytes);
}

export function generateSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return toBase64Url(bytes);
}

export function formatRecoveryCode(identity: Identity): string {
  return `${RECOVERY_CODE_PREFIX}:${identity.datasetId}:${identity.secret}`;
}

export function parseRecoveryCode(code: string): Identity {
  const parts = code.trim().split(":");
  if (parts.length !== 3 || parts[0] !== RECOVERY_CODE_PREFIX) {
    throw new Error("malformed recovery code -- expected SLDT:<datasetId>:<secret>");
  }
  const [, datasetId, secret] = parts;
  if (!datasetId || !secret) {
    throw new Error("malformed recovery code -- missing datasetId or secret");
  }
  return { datasetId, secret };
}

/**
 * Derive the encryption key and auth key from an identity. `datasetId` is the
 * Argon2 salt: public but unique per-account, which is exactly what a salt
 * needs to be (it defeats rainbow tables without needing to be secret).
 */
export async function deriveKeys(identity: Identity): Promise<DerivedKeys> {
  const saltBytes = utf8(identity.datasetId);
  const salt =
    saltBytes.byteLength >= 16 ? saltBytes.slice(0, 32) : padSalt(saltBytes);
  const output = await argon2id({
    password: identity.secret,
    salt,
    iterations: ARGON2_ITERATIONS,
    memorySize: ARGON2_MEMORY_KIB,
    parallelism: ARGON2_PARALLELISM,
    hashLength: ARGON2_OUTPUT_BYTES,
    outputType: "binary",
  });
  return {
    encryptionKey: output.slice(0, 32),
    authKey: output.slice(32, 64),
  };
}

function padSalt(bytes: Uint8Array): Uint8Array {
  const padded = new Uint8Array(16);
  padded.set(bytes.slice(0, 16));
  return padded;
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const withPadding = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  return fromBase64(withPadding);
}
