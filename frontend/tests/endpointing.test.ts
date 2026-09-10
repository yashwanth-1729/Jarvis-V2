/**
 * When does JARVIS decide you have finished speaking?
 *
 * This heuristic chooses between ending the turn in ~1.2s and waiting ~4s, so
 * it is the single biggest lever on how the assistant *feels*. The two errors
 * are not equal: waiting too long is mildly annoying, cutting someone off
 * mid-sentence makes the whole thing feel broken. Every ambiguous case below
 * therefore expects patience.
 *
 *     npx tsx --tsconfig tsconfig.json tests/endpointing.test.ts
 */

import { soundsComplete } from "@/lib/realtime";

let passed = 0;
let failed = 0;

function check(text: string, expectQuick: boolean, why: string): void {
  const quick = soundsComplete(text);
  const ok = quick === expectQuick;
  ok ? passed++ : failed++;
  const verdict = quick ? "quick" : "patient";
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${verdict.padEnd(7)} ${JSON.stringify(text).padEnd(38)} ${why}`);
}

console.log("\n== finished thoughts should end the turn quickly ==");
check("what is on now", true, "complete question");
check("add a task to call the bank", true, "complete instruction");
check("What's next?", true, "explicit punctuation");
check("delete the C session tonight", true, "complete instruction");
check("tell me my monday schedule", true, "complete request");

console.log("\n== trailing off must stay patient ==");
check("remind me to", false, "dangling preposition");
check("block thursday for the", false, "dangling article");
check("i need to um", false, "filler");
check("add a task and", false, "dangling conjunction");
check("move it because", false, "dangling conjunction");

console.log("\n== too short to judge stays patient ==");
check("what about", false, "two words, likely mid-sentence");
check("yes", false, "single word");
check("cancel it", false, "two words");
check("", false, "empty");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
