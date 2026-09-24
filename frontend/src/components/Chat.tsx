"use client";

import {
  CircleAlert,
  ArrowUpRight,
  CornerDownLeft,
  Eraser,
  Loader2,
  Mic,
  Square,
  Volume2,
  VolumeX,
} from "lucide-react";
import * as React from "react";

import type { SurfaceDescriptor } from "@/lib/surfaces";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { StreamedProse } from "@/components/StreamedProse";
import { BrandMark } from "@/components/BrandMark";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useChatSession } from "@/lib/useChatSession";
import { playAudio, stopAudio, synthesize } from "@/lib/voice";
import { cn, formatTime } from "@/lib/utils";
import type { ChatMessage, RefreshDomain } from "@/types";

const SUGGESTIONS = ["What should I focus on today?", "What's on my schedule?", "Help me think through an idea"];

interface ChatProps {
  onRefresh: (domains: RefreshDomain[]) => void;
  /**
   * A tool result that names an interface to open.
   *
   * `display` was already captured here and never rendered. Rather than build a
   * second channel, it now carries a `surface` and is lifted to the page, which
   * owns what the screen becomes.
   */
  onSurface: (surface: SurfaceDescriptor) => void;
}

/**
 * The desktop console. The conversation itself (history, streaming, dictation,
 * clearing) lives in `useChatSession`, shared with the phone's chat screen.
 */
export function Chat({ onRefresh, onSurface }: ChatProps) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const composerRef = React.useRef<HTMLTextAreaElement>(null);
  const pinnedRef = React.useRef(true);

  const {
    messages,
    input,
    setInput,
    streaming,
    historyLoaded,
    voiceEnabled,
    micState,
    voiceError,
    send,
    stop,
    reset,
    toggleMic,
  } = useChatSession({
    onRefresh,
    onSurface,
    onTurnStart: () => {
      pinnedRef.current = true;
    },
    onTurnEnd: () => composerRef.current?.focus(),
    onDictated: () => composerRef.current?.focus(),
  });

  /* --------------------------------------------------------------- scrolling */

  // Only auto-scroll when the user is already at the bottom, so scrolling up to
  // read something is not fought by every incoming token.
  const handleScroll = React.useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    pinnedRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
  }, []);

  React.useEffect(() => {
    if (!pinnedRef.current) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  });

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send(input);
    }
  }

  /* ------------------------------------------------------------------ render */

  const showIntro = historyLoaded && messages.length === 0;
  const busyMic = micState !== "idle";

  return (
    <section
      aria-label="JARVIS console"
      className="mobile-ui chat-page relative flex h-full min-h-0 flex-col border-r border-line bg-surface-1/70"
    >
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-line px-4">
        <div className="chat-heading"><BrandMark /><div><strong>JARVIS</strong><small>{streaming ? "Working on it…" : "A little clarity, whenever you need it."}</small></div></div>
        <span
          aria-hidden
          className={cn(
            "h-1 w-1 rounded-full",
            streaming ? "animate-breathe bg-accent" : "bg-line-strong",
          )}
        />
        <Button
          variant="ghost"
          size="xs"
          onClick={() => void reset()}
          disabled={!messages.length}
          className="ml-auto"
          title="Clear conversation"
        >
          <Eraser className="h-3 w-3" />
          Clear
        </Button>
      </header>

      <ScrollArea
        ref={scrollRef}
        onScroll={handleScroll}
        className="chat-scroll min-h-0 flex-1 px-4 py-4"
      >
        {showIntro ? (
          <Intro onPick={(value) => void send(value)} />
        ) : (
          <div className="chat-messages space-y-6">
            {messages.map((message) => (
              <MessageBlock
                key={message.id}
                message={message}
                canSpeak={voiceEnabled}
              />
            ))}
          </div>
        )}
      </ScrollArea>

      <footer className="shrink-0 border-t border-line bg-surface-1 p-3">
        {voiceError && (
          <div
            role="alert"
            className="mb-2 flex items-start gap-2 rounded border border-critical/30 bg-critical/10 px-2.5 py-1.5 text-xs text-ink"
          >
            <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0 text-critical" />
            <span className="min-w-0 break-words">{voiceError}</span>
          </div>
        )}

        <div
          className={cn(
            "chat-composer rounded-lg border bg-surface-2 transition-colors duration-150",
            "focus-within:border-accent/40",
            micState === "recording"
              ? "border-critical/50"
              : streaming
                ? "border-accent/25"
                : "border-line",
          )}
        >
          <Textarea
            ref={composerRef}
            aria-label="Message JARVIS"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            maxLength={20000}
            placeholder={
              micState === "recording"
                ? "Listening… tap the mic again to stop"
                : "Message JARVIS…"
            }
            // 16px on small screens: iOS auto-zooms any focused input below
            // that, which yanks the whole layout on every message.
            className="max-h-48 px-3 pb-1 pt-2.5 text-[16px] md:text-base"
            disabled={streaming}
          />
          <div className="chat-composer-actions flex items-center gap-2 px-2 pb-2">
            {voiceEnabled && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => void toggleMic()}
                disabled={streaming || micState === "transcribing"}
                aria-pressed={micState === "recording"}
                aria-label={
                  micState === "recording" ? "Stop recording" : "Record a voice message"
                }
                title={micState === "recording" ? "Stop recording" : "Dictate"}
                className={cn(
                  micState === "recording" && "bg-critical/15 text-critical",
                  micState === "transcribing" && "text-accent",
                )}
              >
                {micState === "transcribing" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Mic
                    className={cn(
                      "h-3.5 w-3.5",
                      micState === "recording" && "animate-breathe",
                    )}
                  />
                )}
              </Button>
            )}

            <span className="hidden font-mono text-2xs text-ink-faint lg:inline">
              {micState === "recording" ? (
                <span className="text-critical">recording…</span>
              ) : micState === "transcribing" ? (
                "transcribing…"
              ) : (
                <>
                  <kbd className="rounded-[3px] border border-line px-1 py-px">↵</kbd> send
                  <span className="mx-1 opacity-40">·</span>
                  <kbd className="rounded-[3px] border border-line px-1 py-px">⇧↵</kbd> newline
                </>
              )}
            </span>

            <div className="ml-auto">
              {streaming ? (
                <Button size="xs" variant="secondary" onClick={stop} title="Stop generating" aria-label="Stop generating">
                  <Square className="h-2.5 w-2.5 fill-current" />
                  Stop
                </Button>
              ) : (
                <Button
                  size="xs"
                  variant="primary"
                  onClick={() => void send(input)}
                  disabled={!input.trim() || busyMic}
                  title="Send (Enter)"
                  aria-label="Send message"
                >
                  Send<CornerDownLeft className="h-3 w-3" />
                </Button>
              )}
            </div>
          </div>
        </div>
      </footer>
    </section>
  );
}

/* -------------------------------------------------------------------------- */

function Intro({ onPick }: { onPick: (value: string) => void }) {
  return (
    <div className="chat-intro flex flex-col">
      <BrandMark />
      <h2>What&apos;s on your mind?</h2>
      <p>Plan your day, explore an idea, or get something done. I&apos;m here.</p>
      <ul className="chat-suggestions">
        {SUGGESTIONS.map((suggestion) => (
          <li key={suggestion}>
            <button
              type="button"
              onClick={() => onPick(suggestion)}
            >
              <span className="min-w-0">{suggestion}</span>
              <ArrowUpRight className="h-4 w-4 shrink-0" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SpeakButton({ text }: { text: string }) {
  const [state, setState] = React.useState<"idle" | "loading" | "playing">("idle");
  const abortRef = React.useRef<AbortController | null>(null);

  React.useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  async function toggle() {
    if (state === "playing") {
      stopAudio();
      setState("idle");
      return;
    }
    if (state === "loading") return;

    setState("loading");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const clip = await synthesize(text, controller.signal);
      if (controller.signal.aborted) return;
      setState("playing");
      playAudio(clip, () => setState("idle"));
    } catch {
      setState("idle");
    } finally {
      abortRef.current = null;
    }
  }

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={() => void toggle()}
      aria-label={state === "playing" ? "Stop playback" : "Read this reply aloud"}
      title={state === "playing" ? "Stop" : "Read aloud"}
      className={cn("ml-auto", state !== "idle" && "text-accent")}
    >
      {state === "loading" ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : state === "playing" ? (
        <VolumeX className="h-3 w-3" />
      ) : (
        <Volume2 className="h-3 w-3" />
      )}
    </Button>
  );
}

/**
 * Three dots, breathing, while JARVIS works.
 *
 * A spinner says "loading"; dots say "thinking", which is the truer statement
 * — a tool call and a model deciding what to do are both the same thing from
 * out here. Staggered by 160ms so they read as a wave rather than a blink,
 * and built from opacity alone so it costs nothing to leave running for the
 * ten seconds a search can take.
 */
function Working() {
  return (
    <div
      className="flex items-center gap-2 py-1"
      role="status"
      aria-label="JARVIS is working"
    >
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          aria-hidden
          className="h-1.5 w-1.5 rounded-full bg-accent/70 motion-safe:animate-breathe"
          style={{ animationDelay: `${index * 160}ms` }}
        />
      ))}
    </div>
  );
}

function MessageBlock({
  message,
  canSpeak,
}: {
  message: ChatMessage;
  canSpeak: boolean;
}) {
  const isUser = message.role === "user";

  /**
   * Whether this reply is still arriving on screen.
   *
   * Not the same as `message.streaming`, and that distinction is the whole
   * reason the cascade did not show. A typed turn is unstreamed on purpose —
   * it finishes sooner and hits the prefix cache — so the entire answer lands
   * in one delta and `streaming` has already flipped to false by the time
   * there is any text to render. Keying the animation off it meant the text
   * went straight to the markdown branch and simply appeared.
   *
   * So freshness is measured here instead: when text first arrives, hold the
   * animated view for as long as the cascade runs, then hand over to markdown
   * for the settled message.
   */
  const [settling, setSettling] = React.useState(false);
  const shown = React.useRef("");

  React.useEffect(() => {
    if (isUser || !message.text || message.text === shown.current) return;
    const words = message.text.split(/\s+/).length;
    shown.current = message.text;
    setSettling(true);
    // Must outlast the cascade in StreamedProse, or the markdown swap happens
    // mid-animation and the tail of the reply snaps into place.
    const step = words <= 1 ? 0 : Math.min(90, Math.max(28, 900 / words));
    const timer = window.setTimeout(
      () => setSettling(false),
      Math.min(words * step, 1600) + 380,
    );
    return () => window.clearTimeout(timer);
  }, [message.text, isUser]);

  /**
   * Nothing to show yet — so say so.
   *
   * This used to include `!toolCalls.length`, which was correct while the tool
   * log rendered: once a tool started, the log itself was the sign of life and
   * a spinner beside it would have been redundant. Removing the log left the
   * condition behind, so the moment a tool began the indicator switched off
   * and the reply became a blank space until the answer arrived — the longest
   * part of the turn showed nothing at all.
   *
   * Working-ness is about whether there is anything on screen, not about
   * whether a tool happens to be running.
   */
  const isEmptyAssistant = !isUser && !message.text && !message.error;

  if (isUser) {
    return (
      <div className="chat-message chat-user">
        <div className="mb-1 flex items-baseline gap-2">
          <span className="eyebrow text-ink-dim">You</span>
          <span className="tnum font-mono text-2xs text-ink-faint">
            {formatTime(message.createdAt)}
          </span>
        </div>
        <p className="whitespace-pre-wrap break-words rounded-lg rounded-tl-[3px] border border-line bg-surface-2 px-3 py-2 text-base leading-relaxed text-ink">
          {message.text}
        </p>
      </div>
    );
  }

  return (
    <div className="chat-message chat-assistant">
      <div className="mb-1 flex items-center gap-2">
        <span className="eyebrow text-accent">Jarvis</span>
        {message.streaming && (
          <span aria-hidden className="h-1 w-1 animate-breathe rounded-full bg-accent" />
        )}
        {canSpeak && !message.streaming && message.text.trim() && (
          <SpeakButton text={message.text} />
        )}
      </div>

      {/* Flush-left prose with a hairline spine — reads as a transcript, not a
          chat bubble, which suits a tool the user works inside all day. */}
      <div className="border-l border-line pl-3">
        {/* The reasoning trace is gone from the transcript too, for the same
            reason as the tool log: it is JARVIS working, not JARVIS
            answering. It is still streamed and still stored — nothing is lost,
            it simply no longer sits above every reply. */}

        {/* No tool log. Which tool ran, with what arguments, is JARVIS's
            business — the user asked a question and wants the answer, and a
            list of internal machinery above it reads as debug output left on
            by mistake. The tool results still drive the interface; they just
            no longer narrate themselves. */}

        {message.text &&
          (message.streaming || settling ? (
            // Still arriving: word-by-word, and no markdown. A half-written
            // `**bold` is not valid markdown, and re-parsing the document on
            // every delta to discover that is slow and visibly unstable.
            <div className="prose-jarvis break-words">
              <StreamedProse text={message.text} />
            </div>
          ) : (
            <div className="prose-jarvis break-words">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
            </div>
          ))}

        {isEmptyAssistant && message.streaming && <Working />}

        {message.error && (
          <div
            role="alert"
            className="mt-2 flex items-start gap-2 rounded border border-critical/30 bg-critical/10 px-2.5 py-2 text-xs leading-relaxed text-ink"
          >
            <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0 text-critical" />
            <span className="break-words">{message.error}</span>
          </div>
        )}
      </div>
    </div>
  );
}
