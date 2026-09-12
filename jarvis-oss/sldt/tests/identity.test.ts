/**
 * Identity, recovery codes, and key derivation.
 *
 *     npx tsx tests/identity.test.ts
 */

import {
  deriveKeys,
  formatRecoveryCode,
  generateDatasetId,
  generateSecret,
  parseRecoveryCode,
  type Identity,
} from "../src/identity.js";
import { check, summarize } from "./_harness.js";

async function main() {
  const identity: Identity = { datasetId: generateDatasetId(), secret: generateSecret() };

  check("datasetId is non-empty", identity.datasetId.length > 0);
  check("secret is non-empty", identity.secret.length > 0);
  check("datasetId and secret differ", identity.datasetId !== identity.secret);

  const code = formatRecoveryCode(identity);
  check("recovery code has SLDT prefix", code.startsWith("SLDT:"));

  const roundTripped = parseRecoveryCode(code);
  check("recovery code round-trips datasetId", roundTripped.datasetId === identity.datasetId);
  check("recovery code round-trips secret", roundTripped.secret === identity.secret);

  let malformedRejected = false;
  try {
    parseRecoveryCode("not-a-valid-code");
  } catch {
    malformedRejected = true;
  }
  check("malformed recovery code is rejected", malformedRejected);

  const keys = await deriveKeys(identity);
  check("encryption key is 32 bytes", keys.encryptionKey.byteLength === 32);
  check("auth key is 32 bytes", keys.authKey.byteLength === 32);
  check(
    "encryption key and auth key differ (domain separation)",
    Buffer.from(keys.encryptionKey).toString("hex") !== Buffer.from(keys.authKey).toString("hex"),
  );

  const sameIdentityKeys = await deriveKeys(identity);
  check(
    "deriving keys twice from the same identity is deterministic",
    Buffer.from(keys.encryptionKey).equals(Buffer.from(sameIdentityKeys.encryptionKey)) &&
      Buffer.from(keys.authKey).equals(Buffer.from(sameIdentityKeys.authKey)),
  );

  const otherIdentity: Identity = { datasetId: generateDatasetId(), secret: generateSecret() };
  const otherKeys = await deriveKeys(otherIdentity);
  check(
    "different identities derive different keys",
    !Buffer.from(keys.encryptionKey).equals(Buffer.from(otherKeys.encryptionKey)),
  );

  const wrongSecret: Identity = { datasetId: identity.datasetId, secret: generateSecret() };
  const wrongSecretKeys = await deriveKeys(wrongSecret);
  check(
    "same datasetId with wrong secret derives different keys",
    !Buffer.from(keys.encryptionKey).equals(Buffer.from(wrongSecretKeys.encryptionKey)),
  );

  summarize("identity.test.ts");
}

main();
