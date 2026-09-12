/**
 * The manifest: one small, signed, versioned index listing every data object,
 * its revision, and its ciphertext hash. This is the actual coordination
 * point of SLDT -- per-object encryption alone can't detect rollback or a
 * store silently handing back stale state; only a monotonically-increasing,
 * hash-chained, HMAC-signed index can.
 */

import { canonicalJson } from "./canonicalJson.js";
import { hmacSha256Hex, hmacSha256Verify, sha256Hex } from "./crypto.js";
import { ReplayDetected, TamperDetected } from "./errors.js";

export interface ManifestObjectEntry {
  revision: number;
  hash: string;
  type: string;
  /** True once this object has been tombstoned; the entry itself is never removed (see sync.ts deletion semantics). */
  deleted: boolean;
}

export interface ManifestData {
  revision: number;
  previousManifestHash: string | null;
  objects: Record<string, ManifestObjectEntry>;
}

export interface SignedManifest {
  data: ManifestData;
  signature: string;
}

export function emptyManifest(): ManifestData {
  return { revision: 0, previousManifestHash: null, objects: {} };
}

export async function signManifest(data: ManifestData, authKey: Uint8Array): Promise<SignedManifest> {
  const signature = await hmacSha256Hex(authKey, canonicalJson(data));
  return { data, signature };
}

/**
 * Verify HMAC and reject replay/rollback. Throws rather than returning a
 * boolean: both failure modes are "stop touching local data," never a
 * recoverable condition the caller should paper over.
 */
export async function verifyManifest(
  signed: SignedManifest,
  authKey: Uint8Array,
  lastSeenRevision: number,
): Promise<void> {
  const valid = await hmacSha256Verify(authKey, canonicalJson(signed.data), signed.signature);
  if (!valid) {
    throw new TamperDetected();
  }
  if (signed.data.revision < lastSeenRevision) {
    throw new ReplayDetected(lastSeenRevision, signed.data.revision);
  }
}

/** Hash of a signed manifest, used as the next manifest's `previousManifestHash` link. */
export async function hashManifest(signed: SignedManifest): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalJson(signed)));
}

export function serializeManifest(signed: SignedManifest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(signed));
}

export function deserializeManifest(bytes: Uint8Array): SignedManifest {
  const parsed = JSON.parse(new TextDecoder().decode(bytes));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof parsed.signature !== "string" ||
    typeof parsed.data !== "object"
  ) {
    throw new TamperDetected("manifest payload is not well-formed");
  }
  return parsed as SignedManifest;
}
