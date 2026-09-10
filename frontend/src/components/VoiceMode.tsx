"use client";

import { AudioLines, ChevronDown, CircleAlert, Languages, Mic, MicOff, X } from "lucide-react";
import dynamic from "next/dynamic";
import * as React from "react";

import { HudRings, HudTelemetry } from "@/components/HudLayer";
import { VoiceSession } from "@/lib/realtime";
import { intentSurface, readSurface, type SurfaceDescriptor } from "@/lib/surfaces";
import { fetchVoiceConfig, setVoiceLanguage, setVoiceSpeaker } from "@/lib/voice";
import { cn } from "@/lib/utils";
import type {
  LanguageOption,
  VoiceExchange,
  VoiceOption,
  VoiceSessionState,
} from "@/types";

/**
 * three.js is ~145 kB of the bundle and is only ever needed once voice mode is
 * open, so it loads on demand rather than delaying the dashboard's first paint.
 * `ssr: false` because the component touches WebGL and `window` directly.
 */
const JarvisCore = dynamic(
  () => import("@/components/three/JarvisCore").then((m) => m.JarvisCore),
  { ssr: false },
);

const STATUS_COPY: Record<VoiceSessionState, string> = {
  idle: "Offline",
  connecting: "Connecting…",
  listening: "Listening",
  hearing: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
};

const STATUS_HINT: Record<VoiceSessionState, string> = {
  idle: "",
  connecting: "Waking up",
  listening: "Just talk — no button needed",
  hearing: "Go on…",
  thinking: "Working on it",
  // Overridden at the render site: what is true here depends on whether
  // barge-in is on, and by default it is not.
  speaking: "One moment",
};

let exchangeCounter = 0;
const nextId = () => `x${Date.now()}-${exchangeCounter++}`;

interface VoiceModeProps {
  open: boolean;
  onClose: () => void;
  onRefresh: (domains: string[]) => void;
  /** A spoken request that named an interface to open. */
  onSurface?: (surface: SurfaceDescriptor) => void;
  /**
   * Whether an instrument panel is currently over the HUD.
   *
   * The panel is not a child of this component — it is a sibling that stacks
   * above it — so the HUD has to be told, rather than being able to see it.
   * Knowing lets the core get out of the way instead of being covered up.
   */
  panelOpen?: boolean;
}

/**
 * The "JARVIS mode" surface: a continuous spoken conversation. Capture, turn
 * detection and playback are handled by `VoiceSession`; this component is the
 * presentation of that state machine.
 */
export function VoiceMode({
  open,
  onClose,
  onRefresh,
  onSurface,
  panelOpen = false,
}: VoiceModeProps) {
  const [state, setState] = React.useState<VoiceSessionState>("idle");
  const [level, setLevel] = React.useState(0);
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
   * until then. The core moves aside, the line draws, the rectangle unfolds
   * and the numbers land while the answer is being spoken, not before it.
   */
  const pendingSurface = React.useRef<SurfaceDescriptor | null>(null);
  const speakingRef = React.useRef(false);

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
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const onRefreshRef = React.useRef(onRefresh);
  onRefreshRef.current = onRefresh;
  const onSurfaceRef = React.useRef(onSurface);
  onSurfaceRef.current = onSurface;

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
        setExchanges((current) => [
          ...current,
          { id: nextId(), role: "jarvis", text: spoken },
        ]);
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
      onLevel: (value) => !disposed && setLevel(value),
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
        liveRef.current = liveRef.current
          ? `${liveRef.current} ${text.trim()}`
          : text.trim();
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
    };
  }, [open]);

  /* ----------------------------------------------------------------- effects */

  React.useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [exchanges, live]);

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

  if (!open) return null;

  const speaking = state === "speaking";
  const busy = state === "connecting" || state === "thinking";
  const listeningMuted = micMuted && (state === "listening" || state === "hearing");
  const statusCopy = listeningMuted ? "Mic muted" : STATUS_COPY[state];
  // One accent drives the whole HUD, so the frame, the readout and the core all
  // turn together the instant JARVIS starts speaking.
  const accent = speaking ? "#ff2a2a" : "#22b8ff";
  const lastUser = [...exchanges].reverse().find((e) => e.role === "user");

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="JARVIS"
      className="voice-stage fixed inset-0 z-50 animate-fade-in overflow-hidden bg-[#03060d]"
      style={{ ["--hud" as string]: accent }}
    >
      {/* Depth: a colour wash that follows the accent, plus a vignette so the
          core is the brightest thing on screen. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 transition-colors duration-700"
        style={{
          background: `radial-gradient(circle at 50% 46%, ${accent}1f 0%, transparent 62%)`,
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(circle at 50% 46%, transparent 30%, rgba(3,6,13,0.92) 100%)",
        }}
      />

      {/* The core itself.
          A panel opening does not move it and does not shrink it. Shrinking
          was tried and looked exactly as bad as it sounds — the core is the
          subject of this screen, and a subject that scurries out of the way
          every time something appears reads as nervous rather than composed.
          It simply settles back a little, so the panel's glass has something
          calmer behind it to be transparent against.
          Opacity only, over a long beat, so the change is felt and not seen. */}
      <div
        className={cn(
          "absolute inset-0",
          // Opacity only. The canvas must never be scaled or translated: it is
          // opaque in practice (the bloom pass composites through a
          // full-screen quad), so any transform that stops it covering the
          // viewport turns it into a visible black rectangle. The core moving
          // aside is done inside three.js, by flying the camera.
          "transition-opacity duration-[420ms] ease-[cubic-bezier(0.33,1,0.68,1)]",
          "motion-reduce:transition-none",
          panelOpen ? "opacity-[0.62]" : "opacity-100",
        )}
      >
        <JarvisCore
          state={state}
          level={level}
          aside={panelOpen}
          className="absolute inset-0 h-full w-full"
        />
      </div>

      {/* Scanlines — cheap, and the single strongest "this is a HUD" cue. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.22] mix-blend-overlay"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, rgba(255,255,255,0.10) 0px, rgba(255,255,255,0.10) 1px, transparent 1px, transparent 3px)",
        }}
      />

      <HudRings accent={accent} level={level} />
      <HudFrame accent={accent} />
      <HudTelemetry
        accent={accent}
        state={state}
        level={level}
        language={language}
        voice={voice}
      />

      {/* ------------------------------------------------------------ top */}
      <header
        className={
          "absolute inset-x-0 top-0 flex flex-wrap items-center gap-x-4 gap-y-2 px-6 pb-5 " +
          "pt-[max(1.25rem,env(safe-area-inset-top))]"
        }
      >
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className={cn("h-1.5 w-1.5 rounded-full", busy && "animate-breathe")}
            style={{ background: accent, boxShadow: `0 0 10px ${accent}` }}
          />
          <span
            className="font-mono text-xs uppercase tracking-[0.42em] text-white/90"
            style={{ textShadow: `0 0 16px ${accent}` }}
          >
            Jarvis
          </span>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {languages.length > 0 && (
            <HudSelect
              icon={<Languages className="h-3 w-3" />}
              label="Reply language"
              value={language}
              onChange={changeLanguage}
              accent={accent}
              groups={[
                {
                  options: languages.map((option) => ({
                    value: option.code,
                    label: option.native,
                    hint: option.native === option.label ? undefined : option.label,
                  })),
                },
              ]}
            />
          )}

          {voices.length > 0 && (
            <HudSelect
              icon={<AudioLines className="h-3 w-3" />}
              label="Speaking voice"
              value={voice}
              onChange={changeVoice}
              accent={accent}
              groups={(["female", "male"] as const)
                .map((gender) => ({
                  label: gender === "female" ? "Female" : "Male",
                  options: voices
                    .filter((option) => option.gender === gender)
                    .map((option) => ({
                      value: option.id,
                      label: option.label,
                      hint: option.note,
                    })),
                }))
                // A group with no voices would render a heading over nothing.
                .filter((group) => group.options.length > 0)}
            />
          )}

          <HudChip
            active={micMuted}
            accent={micMuted ? "#ff5252" : accent}
            onClick={() => {
              const next = !micMuted;
              setMicMuted(next);
              sessionRef.current?.setMuted(next);
            }}
            role="switch"
            aria-checked={micMuted}
            aria-label={micMuted ? "Unmute microphone" : "Mute microphone and send speech"}
            title={
              micMuted
                ? "Resume listening"
                : "Mute. If you are speaking, send what you have said immediately."
            }
          >
            {micMuted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
            {micMuted ? "Muted" : "Mic"}
          </HudChip>

          {/* Laptop speakers can echo into the mic and cut a reply short; this
              makes the mic deaf during playback. */}
          <HudChip
            active={bargeIn}
            accent={accent}
            onClick={() => setBargeIn((value) => !value)}
            role="switch"
            aria-checked={bargeIn}
            title={
              bargeIn
                ? "Talking over JARVIS interrupts him. Turn off if replies cut out early."
                : "Half-duplex — JARVIS finishes before listening again."
            }
          >
            Interrupt {bargeIn ? "on" : "off"}
          </HudChip>

          <HudChip accent={accent} onClick={onClose} title="Exit (Esc)">
            <X className="h-3 w-3" />
            Exit
          </HudChip>
        </div>
      </header>

      {/* --------------------------------------------------------- centre */}
      {/* Clicking the core interrupts — the whole sphere is the control. */}
      <button
        type="button"
        onClick={() => speaking && sessionRef.current?.interrupt()}
        disabled={!speaking}
        aria-label={speaking ? "Interrupt JARVIS" : statusCopy}
        className={cn(
          "absolute left-1/2 top-1/2 h-[46vmin] w-[46vmin] -translate-x-1/2 -translate-y-1/2 rounded-full",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30",
          speaking ? "cursor-pointer" : "cursor-default",
        )}
      />

      {/* Status, sitting under the core. It still lifts clear of the sheet on a
          phone, because otherwise it is simply behind the glass and unreadable
          — but it moves slowly enough to read as settling rather than dodging. */}
      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 flex flex-col items-center gap-2 px-6",
          "transition-[top,opacity] duration-[900ms] ease-[cubic-bezier(0.33,1,0.68,1)]",
          "motion-reduce:transition-none",
          panelOpen
            ? "top-[24%] opacity-70 lg:top-[calc(50%+24vmin)] lg:opacity-100"
            : "top-[calc(50%+24vmin)] opacity-100",
        )}
      >
        <p
          className="font-mono text-sm uppercase tracking-[0.5em] transition-colors duration-500"
          style={{ color: accent, textShadow: `0 0 20px ${accent}` }}
        >
          {statusCopy}
        </p>
        <p className="max-w-md text-center text-sm text-white/45">
          {listeningMuted
            ? "Tap the muted microphone to listen again"
            : state === "speaking"
            ? bargeIn
              ? "Talk over me to interrupt"
              : "Mic is off until I finish"
            : state === "thinking" && progress ? progress : STATUS_HINT[state]}
        </p>
      </div>

      {/* --------------------------------------------------------- bottom */}
      {/* A subtitle readout, not a chat log: the last thing you said and what
          JARVIS is saying back, nothing more. */}
      <div
        className={
          "absolute inset-x-0 bottom-0 px-6 pt-16 " +
          "pb-[max(1.75rem,env(safe-area-inset-bottom))]"
        }
      >
        <div className="mx-auto flex max-w-3xl flex-col items-center gap-3 text-center">
          {/* Your words and JARVIS's are rendered identically — same size, same
              face, same balancing. Only opacity separates them, which is enough
              to tell speakers apart without demoting yours to a caption. */}
          {lastUser && (
            <p className="animate-fade-in text-balance text-sm font-light leading-relaxed tracking-wide text-white/30 md:text-base">
              {lastUser.text}
            </p>
          )}

          {/* Subtitle weight, not headline weight. The core is the subject; the
              words are a caption under it. Light, tracked, and well short of
              full opacity so they sit in the image rather than on top of it. */}
          {(live || exchanges.at(-1)?.role === "jarvis") && (
            <p className="animate-fade-in text-balance text-base font-light leading-relaxed tracking-wide text-white/65 md:text-lg">
              {live || exchanges.at(-1)?.text}
              {live && (
                <span
                  aria-hidden
                  className="ml-1 inline-block h-4 w-px animate-breathe align-middle"
                  style={{ background: accent }}
                />
              )}
            </p>
          )}

          {exchanges.length === 0 && !live && state !== "connecting" && (
            <p className="text-base font-light tracking-wide text-white/40">
              I&rsquo;m listening, sir.
            </p>
          )}

          {error && (
            <div
              role="alert"
              className="mt-1 flex items-start gap-2 rounded border border-[#ff2a2a]/40 bg-[#ff2a2a]/10 px-3 py-2 text-left text-sm text-white/90"
            >
              <CircleAlert className="mt-px h-4 w-4 shrink-0 text-[#ff6b6b]" />
              <span className="min-w-0 break-words">{error}</span>
            </div>
          )}

          <p className="mt-2 font-mono text-2xs tracking-widest text-white/25">
            say <span className="text-white/45">&ldquo;period&rdquo;</span> to send
            <span className="mx-2 opacity-40">·</span>
            <kbd className="rounded-[3px] border border-white/15 px-1 py-px">space</kbd>{" "}
            interrupt
            <span className="mx-2 opacity-40">·</span>
            <kbd className="rounded-[3px] border border-white/15 px-1 py-px">esc</kbd>{" "}
            exit
          </p>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/** Corner brackets + edge ticks. Pure decoration, but it is what makes a dark
 *  screen read as an instrument rather than a modal. */
function HudFrame({ accent }: { accent: string }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {[
        "left-4 top-4 border-l border-t",
        "right-4 top-4 border-r border-t",
        "left-4 bottom-4 border-b border-l",
        "right-4 bottom-4 border-b border-r",
      ].map((position) => (
        <span
          key={position}
          className={cn("absolute h-10 w-10 transition-colors duration-700", position)}
          style={{ borderColor: `${accent}66` }}
        />
      ))}
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="absolute left-1/2 h-px w-16 -translate-x-1/2 transition-colors duration-700"
          style={{ top: `${18 + index * 3}px`, background: `${accent}${index === 0 ? "55" : "22"}` }}
        />
      ))}
    </div>
  );
}

function HudChip({
  children,
  accent,
  active = false,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  accent: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex cursor-pointer items-center gap-1.5 rounded-sm border px-2.5 py-1",
        "font-mono text-2xs uppercase tracking-[0.18em] backdrop-blur-sm",
        "transition-colors duration-200",
        active ? "text-white" : "text-white/55 hover:text-white/90",
        className,
      )}
      style={{
        borderColor: active ? `${accent}88` : "rgba(255,255,255,0.14)",
        background: active ? `${accent}1a` : "rgba(255,255,255,0.03)",
      }}
      {...props}
    >
      {active && (
        <span
          aria-hidden
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: accent, boxShadow: `0 0 8px ${accent}` }}
        />
      )}
      {children}
    </button>
  );
}

export interface HudChoice {
  value: string;
  label: string;
  /** Secondary text, shown dimmer beside the label. */
  hint?: string;
}

export interface HudChoiceGroup {
  label?: string;
  options: HudChoice[];
}

/**
 * A listbox that obeys the HUD's theme instead of the operating system's.
 *
 * This was a native `<select>`. The closed control styled fine, but the *open*
 * list is drawn by the platform -- on the Android WebView a white sheet with
 * black text, dropped into the middle of a dark blue HUD. No amount of CSS on
 * `<option>` reaches it; the popup simply is not ours to style. So the list is
 * rebuilt here, which is also the only way to show the live accent (blue while
 * listening, red while speaking) inside it.
 *
 * Rebuilding a native control means re-earning what it gave for free: keyboard
 * navigation, screen-reader semantics, and a way out. All three are below.
 */
function HudSelect({
  icon,
  label,
  value,
  groups,
  onChange,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  groups: HudChoiceGroup[];
  onChange: (value: string) => void;
  accent: string;
}) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const [box, setBox] = React.useState<React.CSSProperties>({});

  const flat = React.useMemo(() => groups.flatMap((group) => group.options), [groups]);
  const selected = flat.find((option) => option.value === value);
  // Highlight follows the keyboard; it starts on whatever is already chosen so
  // the first arrow press moves from there rather than from the top.
  const [active, setActive] = React.useState(() =>
    Math.max(0, flat.findIndex((option) => option.value === value)),
  );

  React.useEffect(() => {
    if (open) setActive(Math.max(0, flat.findIndex((option) => option.value === value)));
  }, [open, flat, value]);

  // Close on an outside press or on Escape. A custom popup that can only be
  // dismissed by choosing something is a trap; the native control always had
  // both of these.
  React.useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    // Capture, so Escape closes the list before the voice overlay reads it as
    // "close the whole HUD".
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  /**
   * Pin the panel to the viewport rather than to the trigger's right edge.
   *
   * Right-aligning worked on a wide screen and failed on a phone: these
   * controls sit near the left of a 375px HUD, so a 240px panel hung 15px off
   * the left of the screen with its first character cut off. Fixed coordinates,
   * clamped to the viewport, are the only version that holds at both sizes --
   * and being fixed also lifts it clear of any ancestor that clips overflow.
   */
  const place = React.useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const margin = 8;
    const width = Math.min(240, window.innerWidth - margin * 2);
    const left = Math.min(
      Math.max(margin, rect.right - width),
      window.innerWidth - width - margin,
    );
    const below = window.innerHeight - rect.bottom - margin;
    const above = rect.top - margin;
    // Drop upward when the space below is too cramped to be usable.
    const dropUp = below < 180 && above > below;
    setBox({
      position: "fixed",
      width,
      left,
      maxHeight: Math.max(140, Math.min(320, (dropUp ? above : below) - 6)),
      ...(dropUp
        ? { bottom: window.innerHeight - rect.top + 6 }
        : { top: rect.bottom + 6 }),
    });
  }, []);

  React.useLayoutEffect(() => {
    if (!open) return;
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  React.useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const commit = (next: string) => {
    onChange(next);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onTriggerKey = (event: React.KeyboardEvent) => {
    if (!open && (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => Math.min(flat.length - 1, i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(flat.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (flat[active]) commit(flat[active].value);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${selected?.label ?? "none"}`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKey}
        className={cn(
          "flex min-h-[36px] items-center gap-1.5 rounded-sm border px-2 py-1",
          "backdrop-blur-sm transition-colors duration-150",
          "focus-visible:outline-none focus-visible:ring-1",
        )}
        style={{
          borderColor: open ? `${accent}88` : "rgba(255,255,255,0.14)",
          background: open ? `${accent}14` : "rgba(255,255,255,0.03)",
          ["--tw-ring-color" as string]: accent,
        }}
      >
        <span style={{ color: open ? accent : "rgba(255,255,255,0.45)" }} aria-hidden>
          {icon}
        </span>
        <span className="font-mono text-2xs uppercase tracking-[0.18em] text-white/75">
          {selected?.label ?? "—"}
        </span>
        <ChevronDown
          aria-hidden
          className={cn(
            "h-3 w-3 transition-transform duration-200",
            open && "rotate-180",
          )}
          style={{ color: open ? accent : "rgba(255,255,255,0.35)" }}
        />
      </button>

      {open && (
        <div
          ref={listRef}
          role="listbox"
          aria-label={label}
          tabIndex={-1}
          className={cn(
            "z-50 overflow-y-auto overscroll-contain rounded-md border p-1",
            "backdrop-blur-xl animate-hud-drop",
          )}
          style={{
            ...box,
            borderColor: `${accent}55`,
            // Glass: the HUD behind it stays visible, tinted by the live accent
            // rather than by a fixed colour, so this panel turns red mid-reply
            // along with everything else.
            background: `linear-gradient(180deg, ${accent}1a 0%, rgba(3,6,13,0.92) 55%)`,
            boxShadow: `0 18px 50px -12px rgba(0,0,0,0.85), 0 0 0 1px ${accent}22, inset 0 1px 0 ${accent}22`,
          }}
        >
          {groups.map((group, groupIndex) => (
            <div key={group.label ?? groupIndex}>
              {group.label && (
                <div className="px-2 pb-1 pt-2 font-mono text-[0.6rem] uppercase tracking-[0.3em] text-white/35">
                  {group.label}
                </div>
              )}
              {group.options.map((option) => {
                const index = flat.indexOf(option);
                const isSelected = option.value === value;
                const isActive = index === active;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    data-active={isActive}
                    onClick={() => commit(option.value)}
                    onPointerMove={() => setActive(index)}
                    // 44px: this is used on a phone, where the native list gave
                    // full-width rows and this must not be fiddlier than what
                    // it replaced.
                    className={cn(
                      "flex min-h-[44px] w-full items-center gap-2 rounded-sm px-2 text-left",
                      "transition-colors duration-150",
                    )}
                    style={{
                      background: isActive ? `${accent}1f` : "transparent",
                      color: isSelected ? "#fff" : "rgba(255,255,255,0.72)",
                    }}
                  >
                    <span
                      aria-hidden
                      className="h-1 w-1 shrink-0 rounded-full transition-opacity duration-150"
                      style={{
                        background: accent,
                        boxShadow: `0 0 8px ${accent}`,
                        opacity: isSelected ? 1 : 0,
                      }}
                    />
                    <span className="font-mono text-2xs uppercase tracking-[0.16em]">
                      {option.label}
                    </span>
                    {option.hint && (
                      <span className="ml-auto truncate pl-2 text-[0.65rem] text-white/40">
                        {option.hint}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
