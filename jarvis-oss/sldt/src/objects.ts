/**
 * The encrypted-object envelope: what actually gets written to
 * `objects/<objectId>.enc`. Each record is its own object -- not one big
 * blob -- so a corrupted or conflicting record only ever costs you that one
 * record, and sync can proceed incrementally instead of all-or-nothing.
 */

import { decryptObject, encryptObject, sha256Hex, utf8, utf8Decode, type EncryptedEnvelope } from "./crypto.js";

export interface ObjectRecord {
  objectId: string;
  /** Per-object revision, bumped on every local edit. This is what `resolveConflict` compares, independent of the manifest's own revision counter. */
  revision: number;
  deviceId: string;
  type: string;
  /** Tombstone flag. A deleted record keeps its place in history -- see sync.ts for why it's never actually removed. */
  deleted: boolean;
  /** Arbitrary application payload (task fields, a note body, whatever). Absent/ignored when `deleted`. */
  payload: unknown;
}

export interface EncodedObject {
  envelope: EncryptedEnvelope;
  /** SHA-256 of the ciphertext bytes -- what the manifest entry's `hash` field records, so integrity can be checked before decryption is even attempted. */
  ciphertextHash: string;
}

export async function encodeObject(key: CryptoKey, record: ObjectRecord): Promise<EncodedObject> {
  const plaintext = utf8(JSON.stringify(record));
  const envelope = await encryptObject(key, plaintext);
  // Hash the exact bytes that get written to the store, not a
  // recombination of the envelope's fields -- so integrity checking never
  // needs to parse JSON to do its job (see hashCiphertextBytes below).
  const ciphertextHash = await sha256Hex(serializeEnvelope(envelope));
  return { envelope, ciphertextHash };
}

export async function decodeObject(
  key: CryptoKey,
  envelope: EncryptedEnvelope,
  objectId: string,
): Promise<ObjectRecord> {
  const plaintext = await decryptObject(key, envelope, objectId);
  return JSON.parse(utf8Decode(plaintext)) as ObjectRecord;
}

export function serializeEnvelope(envelope: EncryptedEnvelope): Uint8Array {
  return utf8(JSON.stringify(envelope));
}

export function deserializeEnvelope(bytes: Uint8Array): EncryptedEnvelope {
  return JSON.parse(utf8Decode(bytes)) as EncryptedEnvelope;
}

/**
 * Hash of the raw stored bytes, deliberately with no JSON parsing on this
 * path -- corrupted/bit-rotted bytes must fail the hash comparison and get
 * reported as `CorruptObject`, not throw a `SyntaxError` out of a JSON
 * parser and crash the whole sync cycle.
 */
export async function hashCiphertextBytes(bytes: Uint8Array): Promise<string> {
  return sha256Hex(bytes);
}
