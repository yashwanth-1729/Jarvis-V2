/**
 * LIVE TEST -- makes real network calls to api.github.com and to a locally
 * running write proxy. NOT part of `npm test`, NOT run automatically by
 * anything, and NOT free of side effects: it writes real objects (encrypted
 * ciphertext, harmless if leaked) to whatever repo `GITHUB_REPO` names.
 *
 * Requires, before running:
 *   1. A real GitHub repo (public, so unauthenticated reads work), empty or
 *      not -- this writes only under the `sldt/` path prefix.
 *   2. The write proxy (../../proxy) running locally with a PAT scoped to
 *      that repo's Contents: Read and write, nothing else.
 *   3. Env vars for THIS script: GITHUB_REPO (owner/repo), GITHUB_BRANCH
 *      (optional, default main), SLDT_PROXY_URL (default
 *      http://localhost:8787).
 *
 * Run:
 *   npx tsx live-tests/githubRoundTrip.ts
 *
 * This is a disposable-repo fixture, not a place to leave real data: the
 * intended cleanup is deleting the whole test repo afterward, not per-row
 * deletion (SLDT's own design keeps tombstones in manifest history on
 * purpose -- see manifest.ts -- so "delete the row" isn't really a thing).
 */

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";

import { resetConnectionForTests } from "../src/browserStore.js";
import { SldtClient, generateDeviceId } from "../src/client.js";
import { createGitHubStore } from "../src/githubClient.js";
import { generateDatasetId, generateSecret, type Identity } from "../src/identity.js";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? `  -> ${detail}` : ""}`);
  }
}

function freshIndexedDb(): void {
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  resetConnectionForTests();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries `clientB.sync()` until `objectId` shows up in `pulled`, or gives up.
 *
 * Necessary, discovered the hard way: unlike a lost CAS *write* race (which
 * `syncOnce`'s own retry loop already handles with backoff), a *stale read*
 * of an unchanged-looking manifest returns successfully with `pulled: []` --
 * there is no error for the protocol to retry on, because nothing about the
 * response looked wrong. GitHub's Contents API can serve a manifest that
 * hasn't caught up to a just-published write for several seconds. Any real
 * deployment already tolerates this via periodic background pulls (see the
 * paid app's own "slow periodic pull while open"); this just makes that
 * pattern explicit for a one-shot test instead of failing on the very next
 * poll a real app would have made a few seconds later anyway.
 */
async function syncUntilPulled(
  client: SldtClient,
  objectId: string,
  { attempts = 6, delayMs = 3000 } = {},
): Promise<Awaited<ReturnType<SldtClient["sync"]>>> {
  let last: Awaited<ReturnType<SldtClient["sync"]>> | null = null;
  for (let i = 0; i < attempts; i++) {
    last = await client.sync();
    if (last.pulled.includes(objectId)) return last;
    if (i < attempts - 1) await sleep(delayMs);
  }
  return last!;
}

async function main() {
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || "main";
  const proxyBaseUrl = process.env.SLDT_PROXY_URL || "http://localhost:8787";
  if (!repo) {
    console.error("GITHUB_REPO env var is required, e.g. someuser/sldt-storage");
    process.exit(2);
  }

  console.log(`Live test against ${repo}@${branch} via proxy ${proxyBaseUrl}\n`);

  const identity: Identity = { datasetId: generateDatasetId(), secret: generateSecret() };
  // Nested under "sldt/" -- the proxy's default SLDT_PATH_PREFIX only allows
  // writes there. The timestamped suffix keeps repeated runs from colliding
  // with a stale manifest from a previous run.
  const pathPrefix = `sldt/live-test-${Date.now()}/`;

  // The library's real design reads a public repo with no credential at all
  // (see githubClient.ts's directRead). That's still what production code
  // does. This test script alone authenticates its OWN reads with the same
  // token the proxy uses for writes, purely so a debugging session that
  // makes many requests doesn't burn through GitHub's public unauthenticated
  // limit (60/hour) while iterating -- confirmed live: a run partway through
  // this test session hit exactly that limit.
  const readToken = process.env.GITHUB_TOKEN;
  const authenticatedFetch: typeof fetch = readToken
    ? ((input, init) =>
        fetch(input, {
          ...init,
          headers: { ...(init?.headers ?? {}), Authorization: `token ${readToken}` },
        })) as typeof fetch
    : fetch;

  const store = createGitHubStore({ repo, branch, pathPrefix, proxyBaseUrl, fetchImpl: authenticatedFetch });

  // --- device A: create, push ---
  freshIndexedDb();
  const deviceA = generateDeviceId();
  const clientA = await SldtClient.create({ identity, store, deviceId: deviceA });
  const objectId = `tasks:${crypto.randomUUID()}`;
  clientA.upsert(objectId, "task", { title: "live round trip", createdBy: deviceA });

  console.log("== device A: pushing to the real repo ==");
  const pushResult = await clientA.sync();
  check("push reported no unexpected shape (pushed includes our object)", pushResult.pushed.includes(objectId));
  check("push saw no corrupted objects", pushResult.corrupted.length === 0);

  // --- device B: fresh IndexedDB, pull from the real repo ---
  freshIndexedDb();
  const deviceB = generateDeviceId();
  const clientB = await SldtClient.create({ identity, store, deviceId: deviceB });

  console.log("\n== device B: pulling from the real repo ==");
  const pullResult = await syncUntilPulled(clientB, objectId);
  check("pull picked up device A's object", pullResult.pulled.includes(objectId));
  const pulledRecord = clientB.get(objectId);
  check("decrypted payload matches what device A wrote", (pulledRecord?.payload as { title: string })?.title === "live round trip");
  check("decrypted payload's createdBy matches device A's id", (pulledRecord?.payload as { createdBy: string })?.createdBy === deviceA);

  // --- device A: delete, push tombstone ---
  console.log("\n== device A: deleting, pushing the tombstone ==");
  clientA.delete(objectId, { deletedAt: new Date().toISOString() });
  const deletePush = await clientA.sync();
  check("delete push reported no error shape (pushed includes the tombstone)", deletePush.pushed.includes(objectId));

  // --- device B: pull the tombstone ---
  console.log("\n== device B: pulling the tombstone ==");
  const deletePull = await syncUntilPulled(clientB, objectId);
  check("device B received the tombstone", clientB.get(objectId)?.deleted === true);
  check("delete pull is reported", deletePull.pulled.includes(objectId));

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(
    `\nCleanup: this run wrote under path prefix "${pathPrefix}" in ${repo}. ` +
      `Nothing to delete row-by-row (tombstones are supposed to persist) -- ` +
      `delete the whole test repo when you're done with it.`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Live test crashed:", error);
  process.exit(1);
});
