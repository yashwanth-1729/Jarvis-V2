"use client";

import * as React from "react";
import { AnimatePresence, motion, useDragControls, useIsPresent, type PanInfo } from "framer-motion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowUp,
  CaretDown,
  CircleNotch,
  Copy,
  Microphone,
  SpeakerHigh,
  SpeakerSlash,
  Stop,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";

import { StreamedProse } from "@/components/StreamedProse";
import { playAudio, stopAudio, synthesize } from "@/lib/voice";
import type { ChatMessage } from "@/types";
import { useBackLayer } from "../lib/backStack";
import { haptic } from "../lib/haptics";
import { useChat, useNav } from "../PhoneContext";
import { KineticText, stagger } from "../ui/Bits";
import { Tap } from "../ui/Tap";
import { Icon3D, type Icon3DName } from "../ui/Icon3D";
import { HoloFace } from "../voice/HoloFace";

const PROMPTS: Array<{ title: string; text: string; tone: string; icon: Icon3DName }> = [
  { title: "Plan my day", text: "What should I focus on today?", tone: "lime", icon: "target" },
  { title: "What's on?", text: "What's on my schedule?", tone: "sky", icon: "plan" },
  { title: "Think it through", text: "Help me think through an idea", tone: "pink", icon: "bulb" },
  { title: "What you know", text: "What do you remember about me?", tone: "lilac", icon: "memory" },
];

const coarse = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

/**
 * The typed conversation, as a full-screen sheet you can swipe away.
 *
 * Two layers: the outer one slides in and out with a compositor animation
 * (a `transform` string, so the slide stays smooth while the messages
 * mount), the inner one follows the finger when you drag it down.
 */
export function ChatScreen() {
  const chat = useChat();
  const { closeChat } = useNav();
  // Registered while present: a sheet reopened mid-exit gets a fresh entry.
  const present = useIsPresent();
  useBackLayer(present, closeChat);
  // Closing mid-dictation must not leave the microphone recording.
  const { cancelDictation } = chat;
  React.useEffect(() => {
    if (!present) cancelDictation();
  }, [present, cancelDictation]);
  const drag = useDragControls();
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const composerRef = React.useRef<HTMLTextAreaElement>(null);
  const pinned = React.useRef(true);
  const [away, setAway] = React.useState(false);
  const [confirmClear, setConfirmClear] = React.useState(false);

  const { messages, input, setInput, streaming, historyLoaded, micState, voiceError, voiceEnabled } = chat;

  // Grow the composer with its text, up to a few lines.
  React.useLayoutEffect(() => {
    const field = composerRef.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${Math.min(140, Math.max(24, field.scrollHeight))}px`;
  }, [input]);

  // Follow new text only while the reader is already at the bottom.
  React.useEffect(() => {
    const node = scrollRef.current;
    if (node && pinned.current) node.scrollTop = node.scrollHeight;
  });

  const onScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 90;
    pinned.current = atBottom;
    if (away === atBottom) setAway(!atBottom);
  };

  const send = (text: string) => {
    if (!text.trim() || streaming) return;
    haptic("tap");
    pinned.current = true;
    setAway(false);
    void chat.send(text);
  };

  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.y > 130 || info.velocity.y > 700) closeChat();
  };

  const showIntro = historyLoaded && messages.length === 0;

  return (
    <motion.div
      className="ph-chat"
      role="dialog"
      aria-modal="true"
      aria-label="Chat with JARVIS"
      initial={{ transform: "translateY(100%)" }}
      animate={{ transform: "translateY(0%)" }}
      exit={{ transform: "translateY(100%)", transition: { duration: 0.3, ease: [0.4, 0, 1, 1] } }}
      transition={{ type: "spring", stiffness: 380, damping: 40, mass: 0.9 }}
    >
      <motion.div
        className="ph-chat-inner"
        drag="y"
        dragControls={drag}
        dragListener={false}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0.04, bottom: 0.9 }}
        onDragEnd={onDragEnd}
      >
        <header className="ph-chat-head" onPointerDown={(event) => drag.start(event)}>
          <span className="ph-chat-grip" aria-hidden="true" />
          <Tap className="ph-icon-btn" aria-label="Close chat" onClick={closeChat} feel="select">
            <CaretDown size={22} weight="bold" />
          </Tap>
          <div className="ph-chat-who">
            <HoloFace size={36} state={streaming ? "thinking" : "idle"} />
            <span>
              <strong>JARVIS</strong>
              <small data-busy={streaming}>{streaming ? "cooking a reply…" : "online"}</small>
            </span>
          </div>
          <Tap className="ph-icon-btn" aria-label="Clear conversation" onClick={() => setConfirmClear(true)} disabled={!messages.length}>
            <Trash size={20} weight="bold" />
          </Tap>
        </header>

        <AnimatePresence>
          {confirmClear && (
            <motion.div className="ph-chat-confirm" role="alert" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}>
              <p>Wipe this chat? The saved history goes too.</p>
              <div>
                <Tap className="ph-btn ph-btn-small" onClick={() => setConfirmClear(false)}>Keep</Tap>
                <Tap
                  className="ph-btn ph-btn-small ph-btn-danger"
                  feel="warning"
                  onClick={() => {
                    setConfirmClear(false);
                    void chat.reset();
                  }}
                >
                  Wipe it
                </Tap>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div ref={scrollRef} className="ph-chat-scroll" onScroll={onScroll}>
          {showIntro ? (
            <div className="ph-chat-intro">
              <span className="ph-pop-in">
                <HoloFace size={96} state="listening" />
              </span>
              <KineticText as="h2" text="What's the move?" className="ph-chat-hello" />
              <p className="ph-fade-in">
                Plan the day, untangle a thought, or stash something for later.
              </p>
              <div className="ph-prompts">
                {PROMPTS.map(({ title, text, tone, icon }, index) => (
                  <div key={title} className="ph-drop-in" style={{ ...stagger(index + 5), "--tilt": index % 2 ? "3deg" : "-3deg" } as React.CSSProperties}>
                    <Tap className="ph-prompt" data-tone={tone} onClick={() => send(text)} squish={0.94}>
                      <Icon3D name={icon} size={34} />
                      <strong>{title}</strong>
                      <small>{text}</small>
                    </Tap>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <ol className="ph-messages">
              {!historyLoaded && <li className="ph-chat-loading"><CircleNotch size={18} className="ph-spin" /> Loading your chat…</li>}
              {messages.map((message) => (
                <Message key={message.id} message={message} canSpeak={voiceEnabled} />
              ))}
            </ol>
          )}
        </div>

        <AnimatePresence>
          {away && (
            <motion.div
              className="ph-chat-jump-wrap"
              initial={{ opacity: 0, transform: "translateY(10px) scale(0.6)" }}
              animate={{ opacity: 1, transform: "translateY(0px) scale(1)" }}
              exit={{ opacity: 0, transform: "translateY(10px) scale(0.6)" }}
              transition={{ type: "spring", stiffness: 520, damping: 30 }}
            >
              <Tap
                className="ph-chat-jump"
                aria-label="Jump to the latest message"
                onClick={() => {
                  pinned.current = true;
                  setAway(false);
                  scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
                }}
              >
                <ArrowDown size={20} weight="bold" />
              </Tap>
            </motion.div>
          )}
        </AnimatePresence>

        <footer className="ph-composer">
          <AnimatePresence>
            {voiceError && (
              <motion.p className="ph-composer-error" role="alert" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }}>
                <WarningCircle size={16} weight="fill" /> {voiceError}
              </motion.p>
            )}
          </AnimatePresence>
          <div className="ph-composer-box" data-mic={micState} data-busy={streaming}>
            {voiceEnabled && (
              <Tap
                className="ph-composer-mic"
                data-rec={micState === "recording"}
                aria-pressed={micState === "recording"}
                aria-label={micState === "recording" ? "Stop dictating" : "Dictate a message"}
                disabled={streaming || micState === "transcribing"}
                feel={micState === "recording" ? "toggle-off" : "toggle-on"}
                onClick={() => void chat.toggleMic()}
              >
                {micState === "transcribing" ? <CircleNotch size={20} className="ph-spin" /> : <Microphone size={20} weight="fill" />}
              </Tap>
            )}
            <textarea
              ref={composerRef}
              rows={1}
              aria-label="Message JARVIS"
              placeholder={micState === "recording" ? "Listening… tap the mic to stop" : micState === "transcribing" ? "Turning that into text…" : "Message JARVIS…"}
              value={input}
              maxLength={20000}
              disabled={streaming}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !coarse()) {
                  event.preventDefault();
                  send(input);
                }
              }}
            />
            <AnimatePresence mode="popLayout" initial={false}>
              {streaming ? (
                <motion.span key="stop" initial={{ opacity: 0, transform: "rotate(-90deg) scale(0.5)" }} animate={{ opacity: 1, transform: "rotate(0deg) scale(1)" }} exit={{ opacity: 0, transform: "rotate(90deg) scale(0.5)" }} transition={{ type: "spring", stiffness: 520, damping: 28 }}>
                  <Tap className="ph-send ph-send-stop" aria-label="Stop generating" onClick={chat.stop} feel="heavy">
                    <Stop size={18} weight="fill" />
                  </Tap>
                </motion.span>
              ) : (
                <motion.span key="send" initial={{ opacity: 0, transform: "rotate(90deg) scale(0.5)" }} animate={{ opacity: 1, transform: "rotate(0deg) scale(1)" }} exit={{ opacity: 0, transform: "rotate(-90deg) scale(0.5)" }} transition={{ type: "spring", stiffness: 520, damping: 28 }}>
                  <Tap className="ph-send" aria-label="Send message" onClick={() => send(input)} disabled={!input.trim() || micState !== "idle"} feel={false} squish={0.85}>
                    <ArrowUp size={20} weight="bold" />
                  </Tap>
                </motion.span>
              )}
            </AnimatePresence>
          </div>
        </footer>
      </motion.div>
    </motion.div>
  );
}

function Message({ message, canSpeak }: { message: ChatMessage; canSpeak: boolean }) {
  const isUser = message.role === "user";
  // A typed turn often lands in one delta, so freshness is measured here:
  // hold the word cascade for as long as it runs, then hand over to markdown.
  const [settling, setSettling] = React.useState(false);
  const shown = React.useRef("");
  React.useEffect(() => {
    if (isUser || !message.text || message.text === shown.current) return;
    const words = message.text.split(/\s+/).length;
    shown.current = message.text;
    setSettling(true);
    const step = words <= 1 ? 0 : Math.min(90, Math.max(28, 900 / words));
    const timer = window.setTimeout(() => setSettling(false), Math.min(words * step, 1600) + 380);
    return () => window.clearTimeout(timer);
  }, [message.text, isUser]);

  if (isUser) {
    return (
      <li className="ph-msg ph-msg-user ph-bubble-in">
        <p>{message.text}</p>
      </li>
    );
  }

  const empty = !message.text && !message.error;
  return (
    <li className="ph-msg ph-msg-jarvis ph-rise">
      <span className="ph-msg-name">JARVIS</span>
      {empty && message.streaming && <Thinking />}
      {message.text && (
        <div className="ph-prose">
          {message.streaming || settling ? <StreamedProse text={message.text} /> : <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>}
        </div>
      )}
      {message.error && (
        <p className="ph-msg-error" role="alert">
          <WarningCircle size={16} weight="fill" /> {message.error}
        </p>
      )}
      {!message.streaming && message.text.trim() && (
        <div className="ph-msg-actions">
          {canSpeak && <SpeakButton text={message.text} />}
          <Tap
            className="ph-msg-action"
            aria-label="Copy reply"
            feel="select"
            onClick={() => {
              void navigator.clipboard?.writeText(message.text).then(
                () => toast("Copied", { duration: 1400 }),
                () => toast.error("Copy is not allowed here"),
              );
            }}
          >
            <Copy size={16} weight="bold" />
          </Tap>
        </div>
      )}
    </li>
  );
}

/** Three bouncing dots in three colours while JARVIS works (a CSS loop). */
function Thinking() {
  return (
    <span className="ph-thinking" role="status" aria-label="JARVIS is working">
      <i />
      <i />
      <i />
    </span>
  );
}

function SpeakButton({ text }: { text: string }) {
  const [state, setState] = React.useState<"idle" | "loading" | "playing">("idle");
  const abortRef = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => abortRef.current?.abort(), []);
  const toggle = async () => {
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
  };
  return (
    <Tap className="ph-msg-action" data-on={state !== "idle"} aria-label={state === "playing" ? "Stop reading" : "Read this aloud"} feel="select" onClick={() => void toggle()}>
      {state === "loading" ? <CircleNotch size={16} className="ph-spin" /> : state === "playing" ? <SpeakerSlash size={16} weight="bold" /> : <SpeakerHigh size={16} weight="bold" />}
    </Tap>
  );
}
