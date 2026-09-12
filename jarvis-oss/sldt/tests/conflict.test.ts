/**
 * Deterministic conflict resolution.
 *
 *     npx tsx tests/conflict.test.ts
 */

import { resolveConflict } from "../src/conflict.js";
import { check, summarize } from "./_harness.js";

function main() {
  const higher = { revision: 5, deviceId: "device-a" };
  const lower = { revision: 3, deviceId: "device-b" };
  check("higher revision wins regardless of deviceId", resolveConflict(higher, lower) === higher);
  check("order of arguments doesn't matter", resolveConflict(lower, higher) === higher);

  const tieA = { revision: 4, deviceId: "aaaa" };
  const tieB = { revision: 4, deviceId: "zzzz" };
  check("equal revision ties break on deviceId, deterministically", resolveConflict(tieA, tieB) === tieB);
  check("tie-break is order-independent", resolveConflict(tieB, tieA) === tieB);

  const same = { revision: 4, deviceId: "same-device" };
  check("resolving identical candidates is stable", resolveConflict(same, { ...same }).deviceId === "same-device");

  summarize("conflict.test.ts");
}

main();
