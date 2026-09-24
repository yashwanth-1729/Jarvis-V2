"use client";

import * as React from "react";

import { clearChatHistory, fetchChatHistory, streamChat } from "@/lib/api";
import { intentSurface, readSurface, type SurfaceDescriptor } from "@/lib/surfaces";
import {
  fetchVoiceConfig,
  isRecordingSupported,
  startRecording,
  stopAudio,
  transcribe,
  type Recording,
} from "@/lib/voice";
import type { ChatMessage, MicState, RefreshDomain, ToolCall } from "@/types";

let messageCounter = 0;
const nextId = () => `m${Date.now()}-${messageCounter++}`;

export interface ChatSessionOptions {
  onRefresh: (domains: RefreshDomain[]) => void;
  /**
   * A tool result that names an interface to open.
   *
   * `display` was already captured here and never rendered. Rather than build a
   * second channel, it now carries a `surface` and is lifted to the page, which
   * owns what the screen becomes.
   */
  onSurface: (surface: SurfaceDescriptor) => void;
  /** The user's message is on screen and a reply is about to stream. */
  onTurnStart?: () => void;
  /** The turn finished, failed or was stopped. */
  onTurnEnd?: () => void;
  /** Dictated words were appended to the draft. */
  onDictated?: () => void;
}

/**
 * The typed conversation: history, streaming turns, dictation and clearing.
 *
 * Shared by the desktop console and the phone's chat screen so both follow the
 * same event handling (tool results opening surfaces, refresh domains reaching
 * the dashboard, errors staying attached to their reply).
 */
export function useChatSession({ onRefresh, onSurface, onTurnStart, onTurnEnd, onDictated }: ChatSessionOptions) {
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [input, setInput] = React.useState("");
  const [streaming, setStreaming] = React.useState(false);
  const [historyLoaded, setHistoryLoaded] = React.useState(false);

  const [voiceEnabled, setVoiceEnabled] = React.useState(false);
  const [micState, setMicState] = React.useState<MicState>("idle");
  const [voiceError, setVoiceError] = React.useState<string | null>(null);

  const abortRef = React.useRef<AbortController | null>(null);
  const recordingRef = React.useRef<Recording | null>(null);
  // Callbacks are read through refs so `send` keeps one identity per
  // streaming state, whatever the parent passes on each render.
  const callbacks = React.useRef({ onRefresh, onSurface, onTurnStart, onTurnEnd, onDictated });
  callbacks.current = { onRefresh, onSurface, onTurnStart, onTurnEnd, onDictated };

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
      callbacks.current.onTurnStart?.();

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

            // Server heartbeat: receiving it keeps the stream alive while the
            // working indicator continues to represent work.
            case "progress":
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

            case "tool_result": {
              const surface = readSurface(event.data.name, event.data.display);
              if (surface) callbacks.current.onSurface(surface);
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
            }

            case "surface": {
              const intent = intentSurface(
                String(event.data.kind ?? ""),
                event.data as unknown as Record<string, unknown>,
              );
              if (intent) callbacks.current.onSurface(intent);
              break;
            }

            case "refresh":
              callbacks.current.onRefresh(event.data.domains);
              break;

            case "error":
              patchAssistant(assistantId, (m) => ({ ...m, error: event.data.message }));
              break;

            case "done":
              if (event.data.refresh.length) callbacks.current.onRefresh(event.data.refresh);
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
        callbacks.current.onTurnEnd?.();
      }
    },
    [patchAssistant, streaming],
  );

  /**
   * A panel asking a follow-up question on the user's behalf.
   *
   * "Read it for me" on a search result has to start a real turn, not fake one
   * — that is what makes the panels instruments rather than displays. Routed as
   * a window event because the panel is mounted beside the conversation rather
   * than inside it.
   */
  React.useEffect(() => {
    const onAsk = (event: Event) => {
      const message = (event as CustomEvent<string>).detail;
      if (typeof message === "string" && message.trim()) void send(message);
    };
    window.addEventListener("jarvis:ask", onAsk);
    return () => window.removeEventListener("jarvis:ask", onAsk);
  }, [send]);

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
          callbacks.current.onDictated?.();
        }
      } catch (error) {
        setVoiceError(error instanceof Error ? error.message : "Could not transcribe that clip.");
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

  /** Drop a dictation in progress without transcribing it. */
  const cancelDictation = React.useCallback(() => {
    recordingRef.current?.cancel();
    recordingRef.current = null;
    setMicState("idle");
  }, []);

  const stop = React.useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  }, []);

  const reset = React.useCallback(async () => {
    if (streaming) stop();
    stopAudio();
    await clearChatHistory().catch(() => undefined);
    setMessages([]);
  }, [stop, streaming]);

  return {
    messages,
    input,
    setInput,
    streaming,
    historyLoaded,
    voiceEnabled,
    micState,
    voiceError,
    setVoiceError,
    send,
    stop,
    reset,
    toggleMic,
    cancelDictation,
  };
}

export type ChatSessionModel = ReturnType<typeof useChatSession>;
