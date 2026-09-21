/** Offline presentation tests only. No microphone, provider calls or user records. */
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PocketVoice } from "../src/components/mobile-desk/PocketVoice";

const noop = () => {};
const base: React.ComponentProps<typeof PocketVoice> = {
  state: "listening", level: 0, status: "Listening", hint: "Just talk.",
  language: "en-IN", languages: [], voice: "", voices: [], muted: false,
  bargeIn: false, error: null, onLanguage: noop, onVoice: noop, onMute: noop,
  onBargeIn: noop, onInterrupt: noop, onClose: noop,
};
const render = (extra: Partial<typeof base> = {}) => renderToStaticMarkup(<PocketVoice {...base} {...extra} />);
const idle = render();
assert.match(idle, /role="dialog" aria-modal="true" aria-label="Voice conversation"/);
assert.match(idle, /role="switch" aria-checked="false"/);
assert.match(idle, /disabled=""[^>]*>.*?Stop reply/s);
assert.doesNotMatch(idle, /Speaking voice/);
assert.match(render({ level: 9 }), /aria-valuenow="100"/);
assert.match(render({ level: -1 }), /aria-valuenow="0"/);
assert.match(render({ muted: true }), /Unmute/);
assert.match(render({ error: "Connection unavailable" }), /role="alert">Connection unavailable/);
const speaking = render({ state: "speaking", status: "Speaking", userText: "Question <one>", reply: "Answer <two>" });
assert.doesNotMatch(speaking, /disabled=""/);
assert.match(speaking, /Question &lt;one&gt;/);
assert.match(speaking, /Answer &lt;two&gt;/);
assert.doesNotMatch(speaking, /<canvas|<audio/);
assert.match(render({ state: "thinking" }), /pocket-sculpture" data-state="thinking"/);
assert.match(render({ state: "hearing", level: .8 }), /scale\(1\.06\)/);
assert.match(render({ state: "hearing", level: .8, muted: true }), /scale\(1\)/);
assert.match(render({ state: "thinking", level: .8 }), /scale\(1\)/);
assert.doesNotMatch(render({ level: Number.NaN }), /NaN/);
assert.match(speaking, /sea-glass-loop\.png/);
console.log("Pocket voice: 18 offline presentation assertions passed.");
