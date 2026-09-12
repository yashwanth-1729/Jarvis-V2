/**
 * Manifest signing, canonical serialization, tamper and replay detection.
 *
 *     npx tsx tests/manifest.test.ts
 */

import { canonicalJson } from "../src/canonicalJson.js";
import { ReplayDetected, TamperDetected } from "../src/errors.js";
import { emptyManifest, signManifest, verifyManifest, type ManifestData } from "../src/manifest.js";
import { check, checkThrows, summarize } from "./_harness.js";

async function main() {
  const authKey = crypto.getRandomValues(new Uint8Array(32));

  // Canonical JSON must not care about key insertion order -- two devices
  // building "the same" manifest object literal in a different key order
  // must sign identical bytes.
  const a = { z: 1, a: { nested: true, another: [3, 2, 1] } };
  const b = { a: { another: [3, 2, 1], nested: true }, z: 1 };
  check("canonicalJson is insensitive to key order", canonicalJson(a) === canonicalJson(b));

  const data: ManifestData = {
    ...emptyManifest(),
    revision: 1,
    objects: { obj1: { revision: 1, hash: "abc123", type: "task", deleted: false } },
  };
  const signed = await signManifest(data, authKey);

  await verifyManifest(signed, authKey, 0); // should not throw
  check("verifyManifest accepts a validly signed manifest", true);

  const wrongKey = crypto.getRandomValues(new Uint8Array(32));
  await checkThrows(
    "verifyManifest rejects a manifest signed with a different key",
    () => verifyManifest(signed, wrongKey, 0),
    (error) => error instanceof TamperDetected,
  );

  const forged = { ...signed, data: { ...signed.data, revision: 999 } };
  await checkThrows(
    "verifyManifest rejects a manifest whose data was altered after signing",
    () => verifyManifest(forged, authKey, 0),
    (error) => error instanceof TamperDetected,
  );

  await checkThrows(
    "verifyManifest rejects a manifest at a lower revision than last seen (replay/rollback)",
    () => verifyManifest(signed, authKey, 5),
    (error) => error instanceof ReplayDetected,
  );

  await verifyManifest(signed, authKey, 1); // equal revision is fine, not a replay
  check("verifyManifest accepts a manifest at exactly the last-seen revision", true);

  summarize("manifest.test.ts");
}

main();
