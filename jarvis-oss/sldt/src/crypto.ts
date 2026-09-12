/**
 * Symmetric crypto primitives, built entirely on Web Crypto (`globalThis.crypto.subtle`).
 *
 * Deliberately no third-party AES implementation: every runtime this library
 * targets -- Tauri's webview, an Android webview, plain Node for tests --
 * already ships a native, audited AES-GCM. Pulling in a JS one would be a
 * strictly worse implementation for a strictly worse reason (portability we
 * already have).
 */

import { DecryptionFailed } from "./errors.js";

const AES_KEY_LENGTH_BITS = 256;
const GCM_NONCE_BYTES = 12; // 96-bit nonce is the AES-GCM standard size; anything else needs extra derivation steps we don't want.
const GCM_TAG_BITS = 128;

/** Fixed-size buckets plaintext is padded up to before encryption, to blunt size-based traffic analysis on the store. */
const PAD_BUCKETS_BYTES = [256, 1024, 4096, 16384, 65536];

export interface EncryptedEnvelope {
  /** Base64 96-bit nonce, fresh per encryption -- never reused under the same key. */
  nonce: string;
  /** Base64 ciphertext, GCM tag included (Web Crypto appends it). */
  ciphertext: string;
}

export async function importAesKey(rawKey: Uint8Array): Promise<CryptoKey> {
  if (rawKey.byteLength * 8 !== AES_KEY_LENGTH_BITS) {
    throw new Error(`AES key must be ${AES_KEY_LENGTH_BITS / 8} bytes, got ${rawKey.byteLength}`);
  }
  return crypto.subtle.importKey("raw", toArrayBuffer(rawKey), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export function padPlaintext(plaintext: Uint8Array): Uint8Array {
  const bucket = PAD_BUCKETS_BYTES.find((size) => plaintext.byteLength + 4 <= size);
  const targetSize = bucket ?? Math.ceil((plaintext.byteLength + 4) / 65536) * 65536;
  const padded = new Uint8Array(targetSize);
  const view = new DataView(padded.buffer);
  view.setUint32(0, plaintext.byteLength, false);
  padded.set(plaintext, 4);
  return padded;
}

export function unpadPlaintext(padded: Uint8Array): Uint8Array {
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  const length = view.getUint32(0, false);
  return padded.slice(4, 4 + length);
}

export async function encryptObject(
  key: CryptoKey,
  plaintext: Uint8Array,
): Promise<EncryptedEnvelope> {
  const nonce = crypto.getRandomValues(new Uint8Array(GCM_NONCE_BYTES));
  const padded = padPlaintext(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(nonce), tagLength: GCM_TAG_BITS },
    key,
    toArrayBuffer(padded),
  );
  return {
    nonce: toBase64(nonce),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptObject(
  key: CryptoKey,
  envelope: EncryptedEnvelope,
  objectId: string,
): Promise<Uint8Array> {
  const nonce = fromBase64(envelope.nonce);
  const ciphertext = fromBase64(envelope.ciphertext);
  try {
    const padded = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(nonce), tagLength: GCM_TAG_BITS },
      key,
      toArrayBuffer(ciphertext),
    );
    return unpadPlaintext(new Uint8Array(padded));
  } catch {
    throw new DecryptionFailed(objectId);
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return toHex(new Uint8Array(digest));
}

export async function hmacSha256Hex(key: Uint8Array, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, toArrayBuffer(utf8(message)));
  return toHex(new Uint8Array(signature));
}

export async function hmacSha256Verify(
  key: Uint8Array,
  message: string,
  expectedHex: string,
): Promise<boolean> {
  const actual = await hmacSha256Hex(key, message);
  return timingSafeEqualHex(actual, expectedHex);
}

/** Constant-time-ish comparison so signature verification doesn't leak match length via timing. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64"));
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
