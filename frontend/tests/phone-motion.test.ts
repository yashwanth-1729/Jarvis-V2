/** Offline checks for the phone's motion helpers and the live background's
 * event bus. No browser, network, credentials or user records.
 *
 *   npx tsx tests/phone-motion.test.ts
 */
import assert from "node:assert/strict";

import { emitFx, fxActivity, fxScene, onFx, onFxScene, setFxActivity, setFxScene, type FxEvent } from "../src/components/phone/fx/fxBus";
import { spring } from "../src/components/phone/lib/motion";

let failed = 0;
function check(name: string, run: () => void) {
  try {
    run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${error instanceof Error ? error.message : String(error)}`);
  }
}

function stops(easing: string): number[] {
  const inner = /^linear\((.*)\)$/.exec(easing)?.[1];
  assert.ok(inner, `not a linear() easing: ${easing.slice(0, 40)}`);
  return inner.split(",").map((value) => Number(value.trim()));
}

check("spring easing starts at 0, ends at 1, and has a sane duration", () => {
  const { easing, duration } = spring(520, 34);
  const values = stops(easing);
  assert.equal(values[0], 0);
  assert.equal(values.at(-1), 1);
  assert.ok(values.length >= 20, "too few stops to look like a spring");
  assert.ok(duration > 150 && duration < 1500, `duration ${duration}ms`);
});

check("an underdamped spring overshoots, an overdamped one does not", () => {
  const bouncy = stops(spring(420, 20).easing);
  const soft = stops(spring(200, 60).easing);
  assert.ok(Math.max(...bouncy) > 1.05, "bouncy spring never overshot");
  assert.ok(Math.max(...soft) <= 1.0005, "overdamped spring overshot");
  for (let i = 1; i < soft.length; i += 1) assert.ok(soft[i] >= soft[i - 1] - 1e-9, "overdamped spring went backwards");
});

check("springs are cached per configuration", () => {
  assert.equal(spring(300, 25), spring(300, 25));
  assert.notEqual(spring(300, 25), spring(300, 26));
});

check("fx events carry an explicit position or element centre", () => {
  const seen: FxEvent[] = [];
  const off = onFx((event) => seen.push(event));
  emitFx("success", { x: 0.25, y: 0.75 });
  emitFx("tab", { x: 0.5, y: 0.5 }, -1);
  off();
  emitFx("tap", { x: 0.1, y: 0.1 });
  assert.equal(seen.length, 2, "listener kept receiving after unsubscribing");
  assert.deepEqual(seen[0], { kind: "success", x: 0.25, y: 0.75, direction: undefined });
  assert.equal(seen[1].direction, -1);
});

check("activity: the strongest level wins and zero clears it", () => {
  setFxActivity("stream", 0.75);
  setFxActivity("sync", 0.25);
  assert.equal(fxActivity(), 0.75);
  setFxActivity("stream", 0);
  assert.equal(fxActivity(), 0.25);
  setFxActivity("sync", 0);
  assert.equal(fxActivity(), 0);
  setFxActivity("spike", 4);
  assert.equal(fxActivity(), 1, "levels are capped at 1");
  setFxActivity("spike", 0);
});

check("scene changes notify once and only on a real change", () => {
  const scenes: string[] = [];
  const off = onFxScene((scene) => scenes.push(scene));
  setFxScene("tasks");
  setFxScene("tasks");
  setFxScene("plan");
  off();
  setFxScene("today");
  assert.deepEqual(scenes, ["tasks", "plan"]);
  assert.equal(fxScene(), "today");
});

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
