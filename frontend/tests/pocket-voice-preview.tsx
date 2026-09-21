/** Isolated visual fixture: no microphone, provider calls, storage or app controller.
 * Run: node --import tsx tests/pocket-voice-preview.tsx
 */
import * as React from "react";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { PocketVoice } from "../src/components/mobile-desk/PocketVoice";
import type { VoiceSessionState } from "../src/types";

const states: VoiceSessionState[] = ["listening", "hearing", "thinking", "speaking"];
const noop = () => {};
createServer((req, res) => {
  const url = new URL(req.url!, "http://127.0.0.1:8102");
  if (url.pathname === "/mobile/sea-glass-loop.png") {
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(readFileSync(resolve("public/mobile/sea-glass-loop.png"))); return;
  }
  const state = states.find(value => value === url.searchParams.get("state")) || "listening";
  const title = { listening: "Listening", hearing: "I’m listening", thinking: "Thinking it through", speaking: "Speaking" }[state as "listening" | "hearing" | "thinking" | "speaking"];
  const html = renderToStaticMarkup(<div className="desk-shell" data-theme={url.searchParams.get("theme") === "light" ? "light" : "dark"}>
    <PocketVoice state={state} level={state === "hearing" || state === "speaking" ? .65 : 0} status={title} hint="Isolated animation preview. No audio session is running." error={null} language="en-IN" languages={[]} voice="" voices={[]} muted={false} bargeIn={false} onLanguage={noop} onVoice={noop} onMute={noop} onBargeIn={noop} onInterrupt={noop} onClose={noop} />
  </div>);
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<!doctype html><html><head><title>Voice motion fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}*{box-sizing:border-box}button{border:0;background:none;color:inherit}h2,p{margin:0}:root{--font-desk:system-ui}${readFileSync(resolve("src/app/mobile/mobile-desk.css"), "utf8")}</style></head><body>${html}</body></html>`);
}).listen(8102, "127.0.0.1", () => console.log("Voice visual fixture: http://127.0.0.1:8102/?state=thinking (no audio or data)"));
