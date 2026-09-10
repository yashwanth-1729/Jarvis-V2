/** Offline: no microphone, provider, database or network requests. */
import assert from "node:assert/strict";
import { VoiceSession } from "../src/lib/realtime";

async function main() {
  const sent: Record<string, unknown>[] = [];
  const transcripts: string[] = [];
  const errors: string[] = [];
  const session = new VoiceSession({
    onState() {}, onLevel() {}, onDelta() {}, onTurnStart() {}, onTurnEnd() {},
    onTool() {}, onRefresh() {}, onLanguage() {}, onVoice() {},
    onError: (message) => errors.push(message),
    onTranscript: (text) => transcripts.push(text),
  });
  // Exercise production event handling without opening a socket or microphone.
  const internal = session as unknown as {
    socket: unknown; responsePending: boolean;
    recognitionTimer: ReturnType<typeof setTimeout> | null;
    onMessage(event: { data: string }): Promise<void>;
    sendUtterance(clip: Blob, endedAt: number, complete: boolean): Promise<void>;
  };
  internal.socket = { readyState: WebSocket.OPEN, send: (text: string) => sent.push(JSON.parse(text)), close() {} };
  const deliver = (payload: object) => internal.onMessage({data: JSON.stringify(payload)});
  try {
    await internal.sendUtterance(new Blob(["fixture"]), performance.now(), true);
    assert.equal(session.current, "thinking");
    assert.notEqual(internal.recognitionTimer, null);
    await deliver({type: "error", input_failed: true, message: "Recognition failed"});
    assert.equal(session.current, "listening");
    assert.equal(internal.responsePending, false);
    assert.equal(internal.recognitionTimer, null);
    assert.equal(sent.at(-1)?.type, "interrupt", "failed input cancels server recognition");
    assert.equal(errors.length, 1);

    await internal.sendUtterance(new Blob(["replacement"]), performance.now(), true);
    await deliver({type: "transcript", text: "New question"});
    assert.deepEqual(transcripts, ["New question"]);
    assert.equal(internal.recognitionTimer, null);
    await deliver({type: "state", value: "listening"});
    assert.equal(session.current, "listening");
    assert.equal(internal.responsePending, false);
    console.log("PASS: failed recognition cancels input; next question displays transcript; wait clears");
  } finally { session.stop(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
