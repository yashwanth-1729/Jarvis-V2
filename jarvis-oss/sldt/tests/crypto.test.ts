/**
 * AES-256-GCM encryption, padding, hashing.
 *
 *     npx tsx tests/crypto.test.ts
 */

import {
  decryptObject,
  encryptObject,
  importAesKey,
  padPlaintext,
  sha256Hex,
  unpadPlaintext,
  utf8,
  utf8Decode,
} from "../src/crypto.js";
import { DecryptionFailed } from "../src/errors.js";
import { check, checkThrows, summarize } from "./_harness.js";

async function main() {
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const key = await importAesKey(rawKey);

  const plaintext = utf8("the quick brown fox jumps over the lazy dog");
  const envelope = await encryptObject(key, plaintext);
  check("nonce is present", envelope.nonce.length > 0);
  check("ciphertext is present", envelope.ciphertext.length > 0);
  check("ciphertext differs from plaintext", envelope.ciphertext !== Buffer.from(plaintext).toString("base64"));

  const decrypted = await decryptObject(key, envelope, "test-object");
  check("decrypted round-trips to original plaintext", utf8Decode(decrypted) === utf8Decode(plaintext));

  const envelope2 = await encryptObject(key, plaintext);
  check("two encryptions of the same plaintext use different nonces", envelope.nonce !== envelope2.nonce);
  check(
    "two encryptions of the same plaintext produce different ciphertext",
    envelope.ciphertext !== envelope2.ciphertext,
  );

  const wrongRawKey = crypto.getRandomValues(new Uint8Array(32));
  const wrongKey = await importAesKey(wrongRawKey);
  await checkThrows(
    "decrypting with the wrong key fails",
    () => decryptObject(wrongKey, envelope, "test-object"),
    (error) => error instanceof DecryptionFailed,
  );

  const tampered = { ...envelope, ciphertext: envelope.ciphertext.slice(0, -4) + "AAAA" };
  await checkThrows(
    "decrypting tampered ciphertext fails (GCM auth tag)",
    () => decryptObject(key, tampered, "test-object"),
    (error) => error instanceof DecryptionFailed,
  );

  // Padding: same-bucket plaintexts should pad to the same length, hiding
  // small size differences from anyone who can only see ciphertext length.
  const short = padPlaintext(utf8("a"));
  const longer = padPlaintext(utf8("a".repeat(200)));
  check("both short plaintexts pad into the 256-byte bucket", short.byteLength === 256 && longer.byteLength === 256);
  check("unpadding recovers the exact original short plaintext", utf8Decode(unpadPlaintext(short)) === "a");
  check(
    "unpadding recovers the exact original longer plaintext",
    utf8Decode(unpadPlaintext(longer)) === "a".repeat(200),
  );

  const hash1 = await sha256Hex(utf8("hello"));
  const hash2 = await sha256Hex(utf8("hello"));
  const hash3 = await sha256Hex(utf8("hello!"));
  check("sha256Hex is deterministic", hash1 === hash2);
  check("sha256Hex differs for different input", hash1 !== hash3);
  check("sha256Hex produces 64 hex chars", hash1.length === 64);

  summarize("crypto.test.ts");
}

main();
