"use client";

import * as React from "react";

import type { VoiceSessionModel } from "@/lib/useVoiceSession";
import type { VoiceExchange, VoiceSessionState } from "@/types";

/**
 * Development only: a scripted voice session for checking the voice screen's
 * look and motion without a microphone, socket or provider. Enabled with
 * `?voice-demo` on a development build; production code never calls it.
 */
const SCRIPT: Array<{ state: VoiceSessionState; ms: number }> = [
  { state: "connecting", ms: 1200 },
  { state: "listening", ms: 2200 },
  { state: "hearing", ms: 2600 },
  { state: "thinking", ms: 2200 },
  { state: "speaking", ms: 5200 },
];
const QUESTION = "What's left on my plate today?";
const ANSWER = "You've got the DBMS assignment, which is already late, then the phone redesign. Gym and guitar clash tonight, so pick one.";

export function isVoiceDemo(): boolean {
  return process.env.NODE_ENV === "development" && typeof window !== "undefined" && new URLSearchParams(window.location.search).has("voice-demo");
}

export function useDemoVoice(active: boolean): VoiceSessionModel {
  const [state, setState] = React.useState<VoiceSessionState>("connecting");
  const [exchanges, setExchanges] = React.useState<VoiceExchange[]>([]);
  const [live, setLive] = React.useState("");
  const [muted, setMutedState] = React.useState(false);
  const [bargeIn, setBargeIn] = React.useState(false);
  const [language, setLanguage] = React.useState("en-IN");
  const [voice, setVoice] = React.useState("priya");
  const levelRef = React.useRef(0);
  const outputRef = React.useRef(0);

  React.useEffect(() => {
    if (!active) return;
    let step = 0;
    let timer = 0;
    let ticker = 0;
    const run = () => {
      const { state: next, ms } = SCRIPT[step % SCRIPT.length];
      setState(next);
      window.clearInterval(ticker);
      if (next === "hearing") {
        let words = 0;
        const parts = QUESTION.split(" ");
        ticker = window.setInterval(() => {
          levelRef.current = 0.35 + Math.random() * 0.55;
          words = Math.min(parts.length, words + 1);
          const text = parts.slice(0, words).join(" ");
          setExchanges((current) => {
            const last = current.at(-1);
            return last?.role === "user" ? [...current.slice(0, -1), { ...last, text }] : [...current, { id: `u${step}`, role: "user", text }];
          });
        }, 260);
      } else if (next === "speaking") {
        let words = 0;
        const parts = ANSWER.split(" ");
        ticker = window.setInterval(() => {
          outputRef.current = 0.25 + Math.random() * 0.5;
          words = Math.min(parts.length, words + 2);
          setLive(parts.slice(0, words).join(" "));
        }, 280);
      } else {
        levelRef.current = 0;
        outputRef.current = 0;
        if (next === "listening" && step > 0) {
          setLive("");
          setExchanges((current) => [...current, { id: `j${step}`, role: "jarvis" as const, text: ANSWER }].slice(-6));
        }
      }
      step = step === SCRIPT.length - 1 ? 1 : step + 1;
      timer = window.setTimeout(run, ms);
    };
    run();
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(ticker);
    };
  }, [active]);

  return {
    state,
    level: 0,
    levelRef,
    outputLevel: () => outputRef.current,
    exchanges,
    live,
    error: null,
    progress: state === "thinking" ? "Checking your schedule…" : "",
    bargeIn,
    setBargeIn,
    micMuted: muted,
    setMuted: setMutedState,
    languages: [
      { code: "en-IN", label: "English", native: "English" },
      { code: "hi-IN", label: "Hindi", native: "हिन्दी" },
      { code: "te-IN", label: "Telugu", native: "తెలుగు" },
      { code: "ta-IN", label: "Tamil", native: "தமிழ்" },
    ],
    language,
    changeLanguage: setLanguage,
    voices: [
      { id: "priya", label: "Priya", gender: "female", note: "Warm" },
      { id: "arjun", label: "Arjun", gender: "male", note: "Calm" },
    ],
    voice,
    changeVoice: setVoice,
    interrupt: () => setState("listening"),
  };
}
