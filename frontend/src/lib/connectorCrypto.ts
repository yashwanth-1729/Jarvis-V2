/**
 * Client-side encryption for connector secrets (OAuth refresh tokens, MCP API
 * keys) before they are synced.
 *
 * The user chose to sync secrets so a Google sign-in on the laptop also works
 * on the phone. Supabase must only ever hold ciphertext, so each secret is
 * sealed here with AES-256-GCM under a key derived (PBKDF2-SHA-256) from a
 * sync passphrase the user types once per device. The passphrase is kept in
 * this device's localStorage -- the same trust level as the OpenRouter key
 * already stored there -- and never leaves the device.
 *
 * Envelope: `v1:` + base64(JSON { s: salt, i: iv, c: ciphertext }), all
 * base64. A fresh salt and IV per secret; the salt travels with it, so any
 * device with the same passphrase can open it.
 */

const PASSPHRASE_KEY = "jarvis.connectors.passphrase";
const ITERATIONS = 310_000;

export class WrongPassphrase extends Error {
  constructor() {
    super("This secret was sealed with a different sync passphrase.");
    this.name = "WrongPassphrase";
  }
}

export function getPassphrase(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(PASSPHRASE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setPassphrase(value: string): void {
  try {
    if (value) window.localStorage.setItem(PASSPHRASE_KEY, value);
    else window.localStorage.removeItem(PASSPHRASE_KEY);
  } catch {
    // Storage unavailable: secrets simply cannot be opened on this device.
  }
}

function toB64(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function fromB64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: ITERATIONS },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Seal a JSON-serialisable secret. Throws if no passphrase is set. */
export async function seal(secret: unknown, passphrase = getPassphrase()): Promise<string> {
  if (!passphrase) throw new Error("Set a sync passphrase first.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const plain = new TextEncoder().encode(JSON.stringify(secret));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, plain as BufferSource),
  );
  return "v1:" + btoa(JSON.stringify({ s: toB64(salt), i: toB64(iv), c: toB64(cipher) }));
}

/** Open a sealed secret. Throws WrongPassphrase if it will not authenticate. */
export async function open<T = Record<string, unknown>>(
  envelope: string,
  passphrase = getPassphrase(),
): Promise<T> {
  if (!envelope.startsWith("v1:")) throw new Error("Unknown secret format.");
  if (!passphrase) throw new WrongPassphrase();
  const { s, i, c } = JSON.parse(atob(envelope.slice(3))) as { s: string; i: string; c: string };
  const key = await deriveKey(passphrase, fromB64(s));
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(i) as BufferSource }, key, fromB64(c) as BufferSource,
    );
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    throw new WrongPassphrase();
  }
}
