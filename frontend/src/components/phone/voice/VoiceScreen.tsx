"use client";

import * as React from "react";
import { AnimatePresence, motion, useIsPresent } from "framer-motion";
import { CaretDown, Check, HandPalm, Keyboard, Microphone, MicrophoneSlash, Stop, Translate, Waveform, WarningCircle, X } from "@phosphor-icons/react";

import { CLOUD_ENGINE_LANGUAGES, ENGINE_BY_LANGUAGE, useVoiceSession } from "@/lib/useVoiceSession";
import type { RefreshDomain, VoiceSessionState } from "@/types";
import { useBackLayer } from "../lib/backStack";
import { haptic } from "../lib/haptics";
import { usePhone } from "../PhoneContext";
import { Scramble } from "../ui/Scramble";
import { Sheet } from "../ui/Sheet";
import { Tap } from "../ui/Tap";
import { isVoiceDemo, useDemoVoice } from "./demoVoice";
import { Orb } from "./Orb";
import { OrbGL } from "./OrbGL";

/** The bloom is a 100px circle grown from the dock orb until it covers the screen. */
const BLOOM = 100;

function measureBloom() {
  if (typeof window === "undefined") return { x: 0, y: 0, cover: 20 };
  const origin = document.querySelector(".ph-dock-orb")?.getBoundingClientRect();
  const x = origin ? origin.left + origin.width / 2 : window.innerWidth / 2;
  const y = origin ? origin.top + origin.height / 2 : window.innerHeight - 60;
  const reach = Math.max(
    Math.hypot(x, y),
    Math.hypot(window.innerWidth - x, y),
    Math.hypot(x, window.innerHeight - y),
    Math.hypot(window.innerWidth - x, window.innerHeight - y),
  );
  return { x, y, cover: ((reach * 2) / BLOOM) * 1.08 };
}

const LABEL: Record<VoiceSessionState, string> = {
  idle: "OFFLINE",
  connecting: "CONNECTING",
  listening: "LISTENING",
  hearing: "HEARING YOU",
  thinking: "THINKING",
  speaking: "SPEAKING",
};

/** The glow canvas; the sphere itself (and the element that flies) is smaller. */
const ORB_SIZE = 300;
const SPHERE = 180;

/**
 * JARVIS, out loud. VoiceMode's session logic, presented for a phone: the
 * whole screen blooms out of the dock orb, the orb itself flies to the
 * centre, and everything on screen follows the real session.
 */
export function VoiceScreen() {
  const { app, openChat } = usePhone();
  const { setVoiceOpen, handleAgentRefresh, setSurface } = app;
  const close = React.useCallback(() => setVoiceOpen(false), [setVoiceOpen]);
  const onRefresh = React.useCallback((domains: string[]) => handleAgentRefresh(domains as RefreshDomain[]), [handleAgentRefresh]);
  // Development-only scripted session (?voice-demo); a production build
  // always runs the real one.
  const [demo] = React.useState(isVoiceDemo);
  // Leaving stops the session (and the microphone) at once, not after the
  // exit animation; coming back during the exit starts a fresh one.
  const present = useIsPresent();
  const real = useVoiceSession({ open: present && !demo, onClose: close, onRefresh, onSurface: setSurface, reactiveLevel: false });
  const scripted = useDemoVoice(demo);
  const voice = demo ? scripted : real;
  useBackLayer(present, close);

  const [glReady, setGlReady] = React.useState(false);
  const [picker, setPicker] = React.useState<"language" | "voice" | null>(null);
  // Bloom from wherever the dock orb sits on this phone.
  const [bloom] = React.useState(measureBloom);

  const { state, micMuted: muted, bargeIn } = voice;
  const listeningMuted = muted && (state === "listening" || state === "hearing");
  const speaking = state === "speaking";
  const label = listeningMuted ? "MIC MUTED" : LABEL[state];
  const hint = listeningMuted
    ? "Unmute to keep talking"
    : speaking
      ? bargeIn ? "Talk over me to interrupt" : "Mic pauses until I finish"
      : state === "thinking"
        ? voice.progress || "Working on it"
        : state === "listening"
          ? "Just talk. I’m listening."
          : state === "hearing"
            ? "Go on…"
            : state === "idle"
              ? "Voice is not running"
              : "Waking up";

  React.useEffect(() => {
    if (state === "speaking") haptic("gesture");
    else if (state === "thinking") haptic("select");
  }, [state]);

  const lastUserExchange = [...voice.exchanges].reverse().find((exchange) => exchange.role === "user");
  const lastUser = lastUserExchange?.text;
  const lastJarvis = voice.exchanges.at(-1)?.role === "jarvis" ? voice.exchanges.at(-1)?.text : undefined;
  const reply = voice.live || lastJarvis || "";
  const languageLabel = voice.languages.find((option) => option.code === voice.language)?.native ?? voice.language;
  const showVoicePicker = !CLOUD_ENGINE_LANGUAGES.has(voice.language) && voice.voices.length > 0;
  const voiceLabel = voice.voices.find((option) => option.id === voice.voice)?.label ?? voice.voice;

  const typeInstead = () => {
    close();
    openChat();
  };

  return (
    <motion.div className="ph-voice" data-theme="dark" data-state={listeningMuted ? "muted" : state} role="dialog" aria-modal="true" aria-label="Voice conversation" initial="closed" animate="open" exit="closed">
      <motion.div
        className="ph-voice-bloom"
        style={{ left: bloom.x - BLOOM / 2, top: bloom.y - BLOOM / 2, width: BLOOM, height: BLOOM }}
        variants={{
          closed: { scale: 0.5, transition: { duration: 0.36, ease: [0.4, 0, 1, 1] } },
          open: { scale: bloom.cover, transition: { duration: 0.62, ease: [0.16, 1, 0.3, 1] } },
        }}
      />
      <motion.div
        className="ph-voice-content"
        variants={{
          closed: { opacity: 0, transition: { duration: 0.16 } },
          open: { opacity: 1, transition: { duration: 0.3, delay: 0.14 } },
        }}
      >
        <div className="ph-voice-aura" aria-hidden="true" />
        <header className="ph-voice-top">
          <Tap className="ph-icon-btn ph-icon-btn-glass" aria-label="End voice conversation" onClick={close} feel="select">
            <X size={22} weight="bold" />
          </Tap>
          <div className="ph-voice-prefs">
            {voice.languages.length > 0 && (
              <Tap className="ph-pref" onClick={() => setPicker("language")} aria-label={`Reply language: ${languageLabel}`}>
                <Translate size={16} weight="bold" /> {languageLabel} <CaretDown size={12} weight="bold" />
              </Tap>
            )}
            {showVoicePicker && (
              <Tap className="ph-pref" onClick={() => setPicker("voice")} aria-label={`Speaking voice: ${voiceLabel}`}>
                <Waveform size={16} weight="bold" /> {voiceLabel} <CaretDown size={12} weight="bold" />
              </Tap>
            )}
          </div>
        </header>
      </motion.div>

      <div className="ph-voice-stage">
        <motion.button
          type="button"
          layoutId="jarvis-orb"
          className="ph-voice-orb"
          data-gl={glReady}
          style={{ width: SPHERE, height: SPHERE }}
          transition={{ type: "spring", stiffness: 210, damping: 26 }}
          aria-label={speaking ? "Interrupt JARVIS" : label.toLowerCase()}
          whileTap={{ scale: 0.94 }}
          onClick={() => {
            if (speaking || state === "thinking") {
              haptic("heavy");
              voice.interrupt();
            } else {
              haptic("tap");
            }
          }}
        >
          <Orb size={SPHERE} state={listeningMuted ? "muted" : state} className="ph-voice-orb-css" />
          <OrbGL
            className="ph-voice-orb-gl"
            size={ORB_SIZE}
            state={state}
            muted={muted}
            levelRef={voice.levelRef}
            outputLevel={voice.outputLevel}
            onReady={setGlReady}
          />
        </motion.button>

        <motion.div
          className="ph-voice-readout"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0, transition: { delay: 0.28, type: "spring", stiffness: 300, damping: 28 } }}
          exit={{ opacity: 0, transition: { duration: 0.12 } }}
        >
          <Scramble text={label} className="ph-voice-label" />
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.p key={hint} className="ph-voice-hint" role="status" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2 }}>
              {hint}
            </motion.p>
          </AnimatePresence>
        </motion.div>
      </div>

      <motion.div
        className="ph-voice-transcript"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, transition: { delay: 0.3 } }}
        exit={{ opacity: 0, transition: { duration: 0.12 } }}
      >
        <AnimatePresence initial={false}>
          {lastUserExchange && (
            // Keyed on the utterance, not its text: partial transcripts of the
            // same question update in place instead of re-animating.
            <motion.p key={lastUserExchange.id} className="ph-voice-you" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              “{lastUser}”
            </motion.p>
          )}
        </AnimatePresence>
        {reply ? <KineticReply text={reply} live={Boolean(voice.live)} /> : !lastUser && state !== "connecting" && <p className="ph-voice-idle">Say something like “what’s on today?”</p>}
        <AnimatePresence>
          {voice.error && (
            <motion.p className="ph-voice-error" role="alert" initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
              <WarningCircle size={18} weight="fill" /> {voice.error}
            </motion.p>
          )}
        </AnimatePresence>
      </motion.div>

      <motion.footer
        className="ph-voice-controls"
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0, transition: { delay: 0.2, type: "spring", stiffness: 320, damping: 28 } }}
        exit={{ opacity: 0, y: 30, transition: { duration: 0.14 } }}
      >
        <div className="ph-voice-buttons">
          <Tap className="ph-voice-side" onClick={voice.interrupt} disabled={!speaking && state !== "thinking"} aria-label="Stop reply" feel="heavy">
            <Stop size={24} weight="fill" />
            <span>Stop</span>
          </Tap>
          <Tap
            className="ph-voice-main"
            data-muted={muted}
            aria-pressed={muted}
            aria-label={muted ? "Unmute" : "Mute and send what you said"}
            squish={0.9}
            feel={muted ? "toggle-on" : "toggle-off"}
            onClick={() => voice.setMuted(!muted)}
          >
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span key={muted ? "off" : "on"} initial={{ scale: 0.4, rotate: -40, opacity: 0 }} animate={{ scale: 1, rotate: 0, opacity: 1 }} exit={{ scale: 0.4, rotate: 40, opacity: 0 }} transition={{ type: "spring", stiffness: 500, damping: 26 }}>
                {muted ? <MicrophoneSlash size={30} weight="fill" /> : <Microphone size={30} weight="fill" />}
              </motion.span>
            </AnimatePresence>
          </Tap>
          <Tap className="ph-voice-side" onClick={typeInstead} aria-label="Type instead">
            <Keyboard size={24} weight="fill" />
            <span>Type</span>
          </Tap>
        </div>
        <span className="ph-voice-main-label">{muted ? "Tap to unmute" : "Tap to mute & send"}</span>
        <button
          type="button"
          role="switch"
          aria-checked={bargeIn}
          className="ph-barge"
          data-on={bargeIn}
          onClick={() => {
            haptic(bargeIn ? "toggle-off" : "toggle-on");
            voice.setBargeIn(!bargeIn);
          }}
        >
          <HandPalm size={16} weight="fill" />
          Voice interruption
          <span className="ph-barge-state">{bargeIn ? "ON" : "OFF"}</span>
        </button>
      </motion.footer>

      <Sheet open={picker === "language"} onClose={() => setPicker(null)} title="Reply language" eyebrow="JARVIS speaks">
        <ul className="ph-options">
          {voice.languages.map((option) => {
            const on = option.code === voice.language;
            return (
              <li key={option.code}>
                <Tap className="ph-option" data-on={on} feel="select" onClick={() => {
                  voice.changeLanguage(option.code);
                  setPicker(null);
                }}>
                  <span className="ph-option-main">
                    <strong>{option.native}</strong>
                    <small>{option.label} · {ENGINE_BY_LANGUAGE[option.code] ?? "Sarvam"}</small>
                  </span>
                  {on && <Check size={20} weight="bold" />}
                </Tap>
              </li>
            );
          })}
        </ul>
      </Sheet>
      <Sheet open={picker === "voice"} onClose={() => setPicker(null)} title="Speaking voice" eyebrow="Pick a vibe">
        {(["female", "male"] as const).map((gender) => {
          const group = voice.voices.filter((option) => option.gender === gender);
          if (!group.length) return null;
          return (
            <div key={gender} className="ph-option-group">
              <span className="ph-eyebrow">{gender === "female" ? "Female" : "Male"}</span>
              <ul className="ph-options">
                {group.map((option) => {
                  const on = option.id === voice.voice;
                  return (
                    <li key={option.id}>
                      <Tap className="ph-option" data-on={on} feel="select" onClick={() => {
                        voice.changeVoice(option.id);
                        setPicker(null);
                      }}>
                        <span className="ph-option-main">
                          <strong>{option.label}</strong>
                          {option.note && <small>{option.note}</small>}
                        </span>
                        {on && <Check size={20} weight="bold" />}
                      </Tap>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </Sheet>
    </motion.div>
  );
}

/** JARVIS's words, each popping in as its audio starts. */
function KineticReply({ text, live }: { text: string; live: boolean }) {
  const words = text.split(/\s+/).filter(Boolean);
  const tail = words.slice(-48);
  const offset = words.length - tail.length;
  return (
    <p className="ph-voice-reply" data-live={live}>
      {tail.map((word, index) => (
        <motion.span
          key={offset + index}
          className="ph-voice-word"
          initial={{ opacity: 0, y: 10, scale: 0.92 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
        >
          {word}{" "}
        </motion.span>
      ))}
      {live && <span className="ph-voice-caret" aria-hidden="true" />}
    </p>
  );
}
