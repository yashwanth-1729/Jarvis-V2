/**
 * `sldtConfig.ts`: localStorage-backed settings persistence, and the
 * sessionStorage-backed handling of the account secret (see that module's
 * own doc for why sessionStorage, not a bare variable or localStorage).
 * Runs in plain Node, so a minimal `window.localStorage`/`sessionStorage`
 * is polyfilled first -- this file has no existing convention for that (no
 * test here needed a `window` before), unlike IndexedDB, which
 * `fake-indexeddb/auto` already covers elsewhere.
 *
 *     npx tsx tests/sldtConfig.test.ts
 */

import {
  applyRecoveryCode,
  buildSldtRemote,
  clearSessionSecret,
  clearSldtSettings,
  generateNewIdentity,
  getSldtSettings,
  getSyncBackend,
  hasSessionSecret,
  setSessionSecret,
  setSldtSettings,
  setSyncBackend,
} from "../src/lib/sldtConfig.js";

// Import declarations are hoisted and evaluate before any other top-level
// code in this file regardless of source order, so this polyfill still runs
// before `main()` calls anything -- `sldtConfig.ts` only ever touches
// `window` lazily, inside function bodies, never at its own module-eval time.
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

(globalThis as unknown as { window: { localStorage: MemoryStorage; sessionStorage: MemoryStorage } }).window = {
  localStorage: new MemoryStorage(),
  sessionStorage: new MemoryStorage(),
};

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.error(`  FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

function main() {
  check("default backend is supabase", getSyncBackend() === "supabase");

  setSyncBackend("sldt");
  check("backend choice round-trips", getSyncBackend() === "sldt");

  check("no settings yet", getSldtSettings() === null);
  check("no session secret yet", !hasSessionSecret());
  check("buildSldtRemote is null with nothing configured", buildSldtRemote() === null);

  const { identity, recoveryCode } = generateNewIdentity();
  check("recovery code has the SLDT prefix", recoveryCode.startsWith("SLDT:"));
  check("generated identity has a datasetId and secret", identity.datasetId.length > 0 && identity.secret.length > 0);

  setSldtSettings({
    datasetId: identity.datasetId,
    repo: "someuser/sldt-data",
    branch: "main",
    pathPrefix: "sldt/",
    writeMode: "direct",
    proxyUrl: null,
    directToken: "fake-token",
  });
  const settings = getSldtSettings();
  check("settings round-trip", settings?.repo === "someuser/sldt-data" && settings?.writeMode === "direct");

  check("buildSldtRemote still null without a session secret", buildSldtRemote() === null);

  setSessionSecret(identity.secret);
  check("session secret is set", hasSessionSecret());
  const remote = buildSldtRemote();
  check("buildSldtRemote returns a Remote once fully configured", remote !== null);
  check("the built remote's id is namespaced by datasetId", remote?.id === `sldt:${identity.datasetId}`);

  clearSessionSecret();
  check("clearSessionSecret actually clears it", !hasSessionSecret());
  check("buildSldtRemote is null again after clearing the secret", buildSldtRemote() === null);

  // --- pairing via a pasted recovery code ---
  const paired = applyRecoveryCode(recoveryCode);
  check("applyRecoveryCode recovers the same datasetId", paired.datasetId === identity.datasetId);
  check("applyRecoveryCode sets the session secret as a side effect", hasSessionSecret());

  clearSldtSettings();
  check("clearSldtSettings actually clears settings", getSldtSettings() === null);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
