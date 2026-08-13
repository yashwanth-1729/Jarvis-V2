"use client";

import {
  CircleAlert,
  CornerDownLeft,
  Eraser,
  Loader2,
  Mic,
  Square,
  Volume2,
  VolumeX,
} from "lucide-react";
import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { ThinkingBlock, ToolCallLog } from "@/components/ToolCallLog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ShaderBackground } from "@/components/ui/simplex-noise-first-contact";
import { clearChatHistory, fetchChatHistory, streamChat } from "@/lib/api";
import {
  fetchVoiceConfig,
  isRecordingSupported,
  playAudio,
  startRecording,
  stopAudio,
  synthesize,
  transcribe,
  type Recording,
} from "@/lib/voice";
import { cn, formatTime } from "@/lib/utils";
import type { ChatMessage, MicState, RefreshDomain, ToolCall } from "@/types";

const SUGGESTIONS = [
  "What should I focus on today?",
  "Remind me to renew the domain Friday 10am — high priority",
  "Block Thursday 14:00–15:00 for the design review",
  "Remember that I prefer morning meetings",
];

let messageCounter = 0;
const nextId = () => `m${Date.now()}-${messageCounter++}`;

interface ChatProps {
  onRefresh: (domains: RefreshDomain[]) => void;
}

export function Chat({ onRefresh }: ChatProps) {
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [input, setInput] = React.useState("");
  const [streaming, setStreaming] = React.useState(false);
  const [historyLoaded, setHistoryLoaded] = React.useState(false);

  const [voiceEnabled, setVoiceEnabled] = React.useState(false);
  const [micState, setMicState] = React.useState<MicState>("idle");
  const [voiceError, setVoiceError] = React.useState<string | null>(null);

  const abortRef = React.useRef<AbortController | null>(null);
  const recordingRef = React.useRef<Recording | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const composerRef = React.useRef<HTMLTextAreaElement>(null);
  const pinnedRef = React.useRef(true);

  /* ---------------------------------------------------------------- history */

  React.useEffect(() => {
    let cancelled = false;
    fetchChatHistory()
      .then((rows) => {
        if (cancelled) return;
        setMessages(
          rows.map((row) => ({
            id: `h${row.id}`,
            role: row.role,
            text: row.text,
            createdAt: row.created_at,
          })),
        );
      })
      .catch(() => {
        /* An unreachable backend is surfaced by the dashboard pane already. */
      })
      .finally(() => {
        if (!cancelled) setHistoryLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /* ------------------------------------------------------------------ voice */

  React.useEffect(() => {
    let cancelled = false;
    fetchVoiceConfig()
      .then((config) => {
        if (!cancelled) setVoiceEnabled(config.enabled && isRecordingSupported());
      })
      .catch(() => {
        if (!cancelled) setVoiceEnabled(false);
      });
    return () => {
      cancelled = true;
      recordingRef.current?.cancel();
      stopAudio();
    };
  }, []);

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

  /* ------------------------------------------------------------------ stream */

  const patchAssistant = React.useCallback(
    (id: string, update: (message: ChatMessage) => ChatMessage) => {
      setMessages((current) =>
        current.map((message) => (message.id === id ? update(message) : message)),
      );
    },
    [],
  );

  const send = React.useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || streaming) return;

      const assistantId = nextId();
      setInput("");
      setStreaming(true);
      pinnedRef.current = true;

      setMessages((current) => [
        ...current,
        { id: nextId(), role: "user", text, createdAt: new Date().toISOString() },
        {
          id: assistantId,
          role: "assistant",
          text: "",
          thinking: "",
          toolCalls: [],
          streaming: true,
          createdAt: new Date().toISOString(),
        },
      ]);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        for await (const event of streamChat(text, controller.signal)) {
          switch (event.type) {
            case "text":
              patchAssistant(assistantId, (m) => ({ ...m, text: m.text + event.data.text }));
              break;

            case "thinking":
              patchAssistant(assistantId, (m) => ({
                ...m,
                thinking: (m.thinking ?? "") + event.data.text,
              }));
              break;

            case "tool_use":
              patchAssistant(assistantId, (m) => ({
                ...m,
                toolCalls: [
                  ...(m.toolCalls ?? []),
                  { id: event.data.id, name: event.data.name, state: "running" } as ToolCall,
                ],
              }));
              break;

            case "tool_result":
              patchAssistant(assistantId, (m) => ({
                ...m,
                toolCalls: (m.toolCalls ?? []).map((call) =>
                  call.id === event.data.id
                    ? {
                        ...call,
                        state: event.data.ok ? "ok" : "error",
                        summary: event.data.summary,
                        display: event.data.display,
                      }
                    : call,
                ),
              }));
              break;

            case "refresh":
              onRefresh(event.data.domains);
              break;

            case "error":
              patchAssistant(assistantId, (m) => ({ ...m, error: event.data.message }));
              break;

            case "done":
              if (event.data.refresh.length) onRefresh(event.data.refresh);
              break;

            default:
              break;
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          const message =
            error instanceof Error ? error.message : "The chat stream failed unexpectedly.";
          patchAssistant(assistantId, (m) => ({ ...m, error: message }));
        }
      } finally {
        abortRef.current = null;
        setStreaming(false);
        patchAssistant(assistantId, (m) => ({ ...m, streaming: false }));
        composerRef.current?.focus();
      }
    },
    [onRefresh, patchAssistant, streaming],
  );

  /* -------------------------------------------------------------------- mic */

  const toggleMic = React.useCallback(async () => {
    setVoiceError(null);

    if (micState === "recording") {
      const recording = recordingRef.current;
      recordingRef.current = null;
      if (!recording) {
        setMicState("idle");
        return;
      }
      setMicState("transcribing");
      try {
        const clip = await recording.stop();
        const result = await transcribe(clip);
        const spoken = result.text.trim();
        if (!spoken) {
          setVoiceError("Nothing was heard in that clip.");
        } else {
          // Append rather than replace, so dictation can extend a typed draft.
          setInput((current) => (current ? `${current.trimEnd()} ${spoken}` : spoken));
          composerRef.current?.focus();
        }
      } catch (error) {
        setVoiceError(
          error instanceof Error ? error.message : "Could not transcribe that clip.",
        );
      } finally {
        setMicState("idle");
      }
      return;
    }

    if (micState !== "idle") return;

    try {
      stopAudio();
      recordingRef.current = await startRecording();
      setMicState("recording");
    } catch (error) {
      const denied =
        error instanceof DOMException &&
        (error.name === "NotAllowedError" || error.name === "SecurityError");
      setVoiceError(
        denied
          ? "Microphone permission denied. Enable it in your browser's site settings."
          : error instanceof Error
            ? error.message
            : "Could not access the microphone.",
      );
      setMicState("idle");
    }
  }, [micState]);

  /* ------------------------------------------------------------------ misc */

  function stop() {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  }

  async function reset() {
    if (streaming) stop();
    stopAudio();
    await clearChatHistory().catch(() => undefined);
    setMessages([]);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
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
      className="relative flex h-full min-h-0 flex-col border-r border-line bg-surface-1/70"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="eyebrow">Console</span>
        <span
          aria-hidden
          className={cn(
            "h-1 w-1 rounded-full",
            streaming ? "animate-breathe bg-ember" : "bg-line-strong",
          )}
        />
        <Button
          variant="ghost"
          size="xs"
          onClick={reset}
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
        className="mask-fade-y min-h-0 flex-1 px-4 py-4"
      >
        {showIntro ? (
          <Intro onPick={(value) => void send(value)} />
        ) : (
          <div className="space-y-5">
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
            "rounded-lg border bg-surface-2 transition-colors duration-150",
            "focus-within:border-ember/40",
            micState === "recording"
              ? "border-critical/50"
              : streaming
                ? "border-ember/25"
                : "border-line",
          )}
        >
          <Textarea
            ref={composerRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            maxLength={20000}
            placeholder={
              micState === "recording"
                ? "Listening… tap the mic again to stop"
                : "Ask JARVIS, or dump a to-do list…"
            }
            // 16px on small screens: iOS auto-zooms any focused input below
            // that, which yanks the whole layout on every message.
            className="max-h-48 px-3 pb-1 pt-2.5 text-[16px] md:text-base"
            disabled={streaming}
          />
          <div className="flex items-center gap-2 px-2 pb-2">
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
                  micState === "transcribing" && "text-ember",
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

            <span className="font-mono text-2xs text-ink-faint">
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
                <Button size="xs" variant="secondary" onClick={stop} title="Stop generating">
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
                >
                  Send
                  <CornerDownLeft className="h-3 w-3" />
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
    <div className="flex h-full flex-col justify-center">
      {/* The shader is allowed to be visible here — an empty console is the one
          place in the product with room for atmosphere. */}
      <div className="relative mb-6 overflow-hidden rounded-lg border border-line">
        <div className="absolute inset-0 opacity-[0.5]">
          <ShaderBackground className="h-full w-full" speed={0.55} />
        </div>
        <div
          aria-hidden
          className="absolute inset-0 bg-gradient-to-t from-surface-1 via-surface-1/70 to-transparent"
        />
        <div className="relative px-4 py-7">
          <p className="font-display text-lg font-semibold tracking-tight text-ink">
            At your service.
          </p>
          <p className="mt-1 max-w-[32ch] text-sm leading-relaxed text-ink-dim">
            Tell me what you need and I&apos;ll put it on the board — tasks,
            calendar blocks, ideas, or things worth remembering. Type it or speak
            it.
          </p>
        </div>
      </div>

      <p className="eyebrow mb-2">Try</p>
      <ul className="space-y-px overflow-hidden rounded border border-line">
        {SUGGESTIONS.map((suggestion) => (
          <li key={suggestion}>
            <button
              type="button"
              onClick={() => onPick(suggestion)}
              className={cn(
                "flex w-full cursor-pointer items-center gap-2 border-b border-line bg-surface-1 px-3 py-2.5 text-left",
                "text-sm text-ink-dim transition-colors duration-150 last:border-0",
                "hover:bg-surface-2 hover:text-ink",
              )}
            >
              <CornerDownLeft className="h-3 w-3 shrink-0 text-ink-faint" />
              <span className="min-w-0">{suggestion}</span>
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
      className={cn("ml-auto", state !== "idle" && "text-ember")}
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

function MessageBlock({
  message,
  canSpeak,
}: {
  message: ChatMessage;
  canSpeak: boolean;
}) {
  const isUser = message.role === "user";
  const isEmptyAssistant =
    !isUser && !message.text && !message.error && !(message.toolCalls ?? []).length;

  if (isUser) {
    return (
      <div className="animate-fade-in">
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
    <div className="animate-fade-in">
      <div className="mb-1 flex items-center gap-2">
        <span className="eyebrow text-ember">Jarvis</span>
        {message.streaming && (
          <span aria-hidden className="h-1 w-1 animate-breathe rounded-full bg-ember" />
        )}
        {canSpeak && !message.streaming && message.text.trim() && (
          <SpeakButton text={message.text} />
        )}
      </div>

      {/* Flush-left prose with a hairline spine — reads as a transcript, not a
          chat bubble, which suits a tool the user works inside all day. */}
      <div className="border-l border-line pl-3">
        {message.thinking && (
          <ThinkingBlock text={message.thinking} live={Boolean(message.streaming)} />
        )}

        {(message.toolCalls ?? []).length > 0 && (
          <ToolCallLog calls={message.toolCalls ?? []} />
        )}

        {message.text && (
          <div className="prose-jarvis break-words">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
          </div>
        )}

        {isEmptyAssistant && message.streaming && (
          <div className="flex items-center gap-2 py-0.5 text-xs text-ink-faint">
            <Loader2 className="h-3 w-3 animate-spin" />
            Working…
          </div>
        )}

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
