import assert from "node:assert/strict";
import { SpeechQueue } from "../src/lib/speechQueue";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let decode: ((value: AudioBuffer) => void) | null = null;
const sources: FakeSource[] = [];
class FakeSource {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  startAt = -1;
  stopped = false;
  connect() {}
  disconnect() {}
  start(at: number) { this.startAt = at; }
  stop() { this.stopped = true; }
}
const buffer = { duration: 0.1 } as AudioBuffer;
class FakeContext {
  state = "running";
  currentTime = 0;
  destination = {};
  async resume() {}
  async close() {}
  decodeAudioData() { return new Promise<AudioBuffer>((resolve) => { decode = resolve; }); }
  createBufferSource() { const source = new FakeSource(); sources.push(source); return source; }
  createBuffer(_channels: number, size: number, rate: number) {
    return { duration: size/rate, getChannelData: () => new Float32Array(size) };
  }
}
Object.assign(globalThis, { window: { AudioContext: FakeContext } });

async function main() {
  let idle = 0;
  const captions: string[] = [];
  const played: number[] = [];
  const queue = new SpeechQueue(() => idle++, (text) => captions.push(text), () => {}, (seq) => played.push(seq));
  queue.begin();
  const obsolete = queue.push(new ArrayBuffer(2), "obsolete", 1);
  await wait(0);
  queue.stop();
  const finishOldDecode = decode as unknown as (value: AudioBuffer) => void;
  finishOldDecode(buffer);
  await obsolete;
  assert.equal(sources.length, 0, "audio decoded after stop must not schedule");
  assert.deepEqual(captions, []);

  queue.begin();
  await queue.push(new ArrayBuffer(4800), "first", 1, 24000);
  await queue.push(new ArrayBuffer(4800), "", 2, 24000);
  assert.equal(sources[1].startAt, sources[0].startAt + 0.1, "PCM packets use consecutive audio-clock slots");
  await wait(150);
  assert.deepEqual(captions, ["first"], "caption revealed once per phrase");
  sources[0].onended?.();
  sources[1].onended?.();
  await wait(500);
  assert.equal(idle, 0, "a network gap must not reopen the microphone before turn_end");
  queue.finish();
  await wait(500);
  assert.equal(idle, 1);
  assert.deepEqual(played, [1, 2], "playback completion returns flow-control credits");

  queue.begin();
  await queue.push(new ArrayBuffer(4800), "cancelled", 3, 24000);
  queue.stop();
  await wait(30);
  assert.ok(sources[2].stopped);
  assert.deepEqual(captions, ["first"], "cancelled reveal timer must not fire");
  assert.equal(queue.busy, false);

  // Streamed phrase (on-device Piper): pieces play as they arrive, gapless,
  // and an item pushed after the stream opened waits for it to close.
  queue.begin();
  const base = sources.length;
  const stream = queue.pushStream("streamed");
  const after = queue.push(new ArrayBuffer(4800), "after", 4, 24000);
  stream.append(new ArrayBuffer(4800), 24000);
  await wait(10);
  stream.append(new ArrayBuffer(4800), 24000);
  await wait(10);
  assert.equal(sources.length, base + 2, "stream pieces schedule as they arrive, before the stream ends");
  assert.equal(sources[base + 1].startAt, sources[base].startAt + 0.1, "stream pieces are gapless on the audio clock");
  assert.equal(queue.busy, true, "an open stream keeps the queue busy (half-duplex holds)");
  stream.end();
  await after;
  assert.equal(sources[base + 2].startAt, sources[base + 1].startAt + 0.1, "the next item follows the stream in slot order");
  await wait(500);
  assert.deepEqual(captions.slice(-2), ["streamed", "after"], "stream reveals its text once, before what follows");
  assert.deepEqual(played, [1, 2], "streamed pieces return no playback credits");

  // A stream that produced no audio still shows its text and never blocks.
  queue.begin();
  const dead = queue.pushStream("never voiced");
  const next = queue.push(new ArrayBuffer(4800), "next", 5, 24000);
  dead.fail(new Error("synthesis failed"));
  await next;
  await wait(500);
  assert.deepEqual(captions.slice(-2), ["never voiced", "next"], "failed stream reveals its text, then the queue moves on");

  // stop() tells an open stream's producer to give up, and late pieces are dropped.
  queue.begin();
  let abandoned = 0;
  const open = queue.pushStream("open", () => abandoned++);
  const beforeStop = sources.length;
  queue.stop();
  assert.equal(abandoned, 1, "stop() abandons an open stream exactly once");
  open.append(new ArrayBuffer(4800), 24000);
  open.end();
  await wait(20);
  assert.equal(sources.length, beforeStop, "pieces after stop() never play");
  assert.equal(queue.busy, false);

  queue.dispose();
  console.log("PASS: decode cancellation, PCM ordering, caption timing, half-duplex hold, playback credits, stop cleanup, streamed phrases");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
