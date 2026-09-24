"use client";

import * as React from "react";

import { VoiceSession } from "@/lib/realtime";
import { intentSurface, readSurface, type SurfaceDescriptor } from "@/lib/surfaces";
import { fetchVoiceConfig, setVoiceLanguage, setVoiceSpeaker } from "@/lib/voice";
import type { LanguageOption, VoiceExchange, VoiceOption, VoiceSessionState } from "@/types";

/**
 * Which engine actually speaks each reply language, shown as shadow text
 * under the language picker's options -- the picker used to also carry
 * separate engine-choice buttons ("Sarvam" / "Local voice" for Telugu, a
 * disabled "On-device voice" chip for English); those are gone, replaced by
 * this hint, since the engine is no longer a user choice at all under the
 * cloud voice stack.
 *
 * Must match `backend/app/providers/__init__.py`'s actual routing:
 * English and Hindi -> Kokoro (via OpenRouter's /audio/speech), Telugu ->
 * Grok TTS (also via OpenRouter). Every other language keeps speaking
 * through Sarvam (`get_tts_provider`'s catch-all), which is the default
 * this map falls back to for any code not listed here.
 */
export const ENGINE_BY_LANGUAGE: Record<string, string> = {
  "en-IN": "Kokoro",
  "hi-IN": "Kokoro",
  "te-IN": "Grok",
};

/** Languages whose "Speaking voice" (Sarvam's Priya/Ritu/Kavya/…) picker
 * would be misleading to show -- each already has its own fixed voice
 * baked into its own engine (see ENGINE_BY_LANGUAGE), not a Sarvam voice id. */
export const CLOUD_ENGINE_LANGUAGES = new Set(Object.keys(ENGINE_BY_LANGUAGE));

let exchangeCounter = 0;
const nextId = () => `x${Date.now()}-${exchangeCounter++}`;

export interface VoiceSessionOptions {
  open: boolean;
  onClose: () => void;
  onRefresh: (domains: string[]) => void;
  /** A spoken request that named an interface to open. */
  onSurface?: (surface: SurfaceDescriptor) => void;
  /**
   * Re-render on every microphone level report (~20 per second).
   *
   * The HUD draws its meter from React state, so it keeps the default. A
   * presentation that animates from `levelRef` inside its own frame loop
   * passes false and avoids re-rendering the whole screen for every frame
   * of audio.
   */
  reactiveLevel?: boolean;
}

/**
 * The "JARVIS mode" session: a continuous spoken conversation.
 *
 * Capture, turn detection and playback are handled by `VoiceSession`; this
 * hook is that state machine as React state, shared by every presentation
 * (the desktop HUD and the phone's voice screen) so the two can never drift
 * apart on how a turn is committed, when a panel is released or how the
 * language picker follows a spoken command.
 */
export function useVoiceSession({
  open,
  onClose,
  onRefresh,
  onSurface,
  reactiveLevel = true,
}: VoiceSessionOptions) {
  const [state, setState] = React.useState<VoiceSessionState>("idle");
  const [level, setLevel] = React.useState(0);
  const levelRef = React.useRef(0);
  const [exchanges, setExchanges] = React.useState<VoiceExchange[]>([]);
  const [live, setLive] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [progress, setProgress] = React.useState("");
  // Off by default: the mic stays shut until JARVIS has finished speaking.
  //
  // An open mic during playback hears JARVIS through the speaker, and on a
  // phone that is easily loud enough to trip the detector — so it interrupts
  // itself mid-sentence and then transcribes its own voice as the next
  // question. The toggle stays for anyone who wants to talk over it.
  const [bargeIn, setBargeIn] = React.useState(false);
  const [micMuted, setMicMuted] = React.useState(false);
  const [languages, setLanguages] = React.useState<LanguageOption[]>([]);
  const [language, setLanguage] = React.useState("en-IN");
  const [voices, setVoices] = React.useState<VoiceOption[]>([]);
  const [voice, setVoice] = React.useState("priya");

  const sessionRef = React.useRef<VoiceSession | null>(null);
  const reactiveLevelRef = React.useRef(reactiveLevel);
  reactiveLevelRef.current = reactiveLevel;

  /**
   * A panel waiting for JARVIS to actually start talking.
   *
   * Surfaces arrive well before the voice does. An intent-named panel is
   * emitted the moment the request is understood, and a tool result lands as
   * soon as the tool returns — both seconds ahead of the first audio, because
   * synthesis has not happened yet. Opening on arrival meant the readout
   * deployed into silence and the reply caught up with it later.
   *
   * The session enters "speaking" at the exact moment the first chunk's audio
   * begins (`onPlaybackStart` -> setState("speaking")), so the panel is held
   * until then.
   */
  const pendingSurface = React.useRef<SurfaceDescriptor | null>(null);
  const speakingRef = React.useRef(false);
  const onRefreshRef = React.useRef(onRefresh);
  onRefreshRef.current = onRefresh;
  const onSurfaceRef = React.useRef(onSurface);
  onSurfaceRef.current = onSurface;

  const releaseSurface = React.useCallback((surface: SurfaceDescriptor) => {
    if (speakingRef.current) {
      onSurfaceRef.current?.(surface);
      return;
    }
    pendingSurface.current = surface;
  }, []);

  // A turn can finish without a single audible chunk — synthesis failing, or
  // the reply being muted for length. The panel must not be lost with it.
  const flushSurface = React.useCallback(() => {
    const held = pendingSurface.current;
    pendingSurface.current = null;
    if (held) onSurfaceRef.current?.(held);
  }, []);

  React.useEffect(() => {
    speakingRef.current = state === "speaking";
    if (state === "speaking") flushSurface();
    // "listening" ends a turn; anything still held never got a voice to ride.
    if (state === "listening") flushSurface();
  }, [state, flushSurface]);

  // Mirrors `live` for reads inside callbacks, and holds the server's final
  // text as a fallback for when synthesis produced nothing at all.
  const liveRef = React.useRef("");
  const finalRef = React.useRef("");

  /* ---------------------------------------------------------------- session */

  React.useEffect(() => {
    if (!open) return;

    let disposed = false;
    setError(null);
    setProgress("");
    setExchanges([]);
    setLive("");
    setMicMuted(false);

    const commitReply = () => {
      const spoken = liveRef.current.trim() || finalRef.current.trim();
      liveRef.current = "";
      finalRef.current = "";
      setLive("");
      if (spoken) {
        setExchanges((current) => [...current, { id: nextId(), role: "jarvis", text: spoken }]);
      }
    };

    const session = new VoiceSession({
      onProgress: (message) => {
        if (disposed) return;
        setProgress(message);
        if (message === "Recognizing speech…") setError(null);
      },
      onState: (next) => {
        if (disposed) return;
        setState(next);
        // Playback has finished — only now is the reply complete on screen.
        if (next === "listening") commitReply();
      },
      onLevel: (value) => {
        if (disposed) return;
        levelRef.current = value;
        if (reactiveLevelRef.current) setLevel(value);
      },
      // A new question supersedes the last reply before its audio finished, so
      // "listening" never arrived to commit it. Commit it here instead, or it
      // is silently dropped from the transcript.
      onTurnStart: () => !disposed && commitReply(),
      // Sent once per speech segment as a running total, so a long question
      // arrives in several updates. Replace the trailing user line rather than
      // appending, or one sentence becomes three bubbles.
      onTranscript: (text) => {
        if (disposed || !text.trim()) return;
        setExchanges((current) => {
          const last = current.at(-1);
          if (last?.role === "user") {
            return [...current.slice(0, -1), { ...last, text }];
          }
          return [...current, { id: nextId(), role: "user", text }];
        });
        liveRef.current = "";
        setLive("");
      },
      // Fires as each chunk's audio *starts*, so the caption tracks the voice.
      onDelta: (text) => {
        if (disposed || !text.trim()) return;
        liveRef.current = liveRef.current ? `${liveRef.current} ${text.trim()}` : text.trim();
        setLive(liveRef.current);
      },
      onTurnEnd: (text) => {
        // Held back until playback ends; the audio is still catching up.
        if (!disposed) finalRef.current = text;
      },
      onTool: (name, ok, display) => {
        // Asking out loud is the primary path, so the panels must open
        // from it too — not only when someone types.
        if (!ok) return;
        const surface = readSurface(name, display);
        if (surface) releaseSurface(surface);
      },
      onSurface: (kind, data) => {
        const intent = intentSurface(kind, data ?? {});
        if (intent) releaseSurface(intent);
      },
      onRefresh: (domains) => onRefreshRef.current(domains),
      onError: (message) => !disposed && setError(message),
      // Also fires when the language is changed by voice, so the picker
      // reflects "speak Telugu" without the user touching it.
      onLanguage: (code) => !disposed && code && setLanguage(code),
      // Likewise for "use a girl's voice" — the picker follows the spoken command.
      onVoice: (id) => !disposed && id && setVoice(id),
    });

    sessionRef.current = session;
    session.start().catch((err: unknown) => {
      if (disposed) return;
      setError(err instanceof Error ? err.message : "Could not start voice mode.");
      setState("idle");
    });

    return () => {
      disposed = true;
      session.stop();
      sessionRef.current = null;
      levelRef.current = 0;
    };
  }, [open, releaseSurface]);

  /* ----------------------------------------------------------------- effects */

  React.useEffect(() => {
    sessionRef.current?.setBargeIn(bargeIn);
  }, [bargeIn, state]);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchVoiceConfig()
      .then((config) => {
        if (cancelled) return;
        setLanguages(config.languages ?? []);
        if (config.language) setLanguage(config.language);
        setVoices(config.voices ?? []);
        if (config.voice) setVoice(config.voice);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open]);

  const changeLanguage = React.useCallback((code: string) => {
    setLanguage(code);
    // Push over the socket for immediate effect, and persist so the choice
    // survives a reload and is shared with the text console.
    sessionRef.current?.setLanguage(code);
    void setVoiceLanguage(code).catch(() => undefined);
  }, []);

  const changeVoice = React.useCallback((id: string) => {
    setVoice(id);
    sessionRef.current?.setVoice(id);
    void setVoiceSpeaker(id).catch(() => undefined);
  }, []);

  const setMuted = React.useCallback((next: boolean) => {
    setMicMuted(next);
    sessionRef.current?.setMuted(next);
  }, []);

  const interrupt = React.useCallback(() => {
    sessionRef.current?.interrupt();
  }, []);

  /** JARVIS's own playback level, 0-1, for presentations that animate to it. */
  const outputLevel = React.useCallback(() => sessionRef.current?.outputLevel() ?? 0, []);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.code === "Space" && state === "speaking") {
        event.preventDefault();
        sessionRef.current?.interrupt();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, state]);

  return {
    state,
    level,
    levelRef,
    outputLevel,
    exchanges,
    live,
    error,
    progress,
    bargeIn,
    setBargeIn,
    micMuted,
    setMuted,
    languages,
    language,
    changeLanguage,
    voices,
    voice,
    changeVoice,
    interrupt,
  };
}

export type VoiceSessionModel = ReturnType<typeof useVoiceSession>;
