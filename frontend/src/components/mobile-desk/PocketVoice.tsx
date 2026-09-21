"use client";

import * as React from "react";
import { AudioLines, Mic, MicOff, Square, X } from "lucide-react";
import type { LanguageOption, VoiceOption, VoiceSessionState } from "@/types";
import { VoiceSculpture } from "./VoiceSculpture";

/** Presentation only. VoiceMode retains the existing session and audio lifecycle. */
export function PocketVoice({ state, level, status, hint, userText, reply, error, language, languages, voice, voices, muted, bargeIn, onLanguage, onVoice, onMute, onBargeIn, onInterrupt, onClose }: {
  state: VoiceSessionState; level: number; status: string; hint: string; userText?: string; reply?: string; error: string | null;
  language: string; languages: LanguageOption[]; voice: string; voices: VoiceOption[]; muted: boolean; bargeIn: boolean;
  onLanguage: (value: string) => void; onVoice: (value: string) => void; onMute: () => void; onBargeIn: () => void; onInterrupt: () => void; onClose: () => void;
}) {
  const root = React.useRef<HTMLDivElement>(null);
  const [paused, setPaused] = React.useState(false);
  React.useEffect(() => {
    const update = () => setPaused(document.hidden);
    update(); document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  React.useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = root.current;
    panel?.querySelector<HTMLButtonElement>("button")?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const nodes = [...(panel?.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled)') || [])];
      const first = nodes[0]; const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    panel?.addEventListener("keydown", trap);
    return () => { panel?.removeEventListener("keydown", trap); if (previous?.isConnected) previous.focus(); };
  }, []);
  const active = (state === "hearing" && !muted) || state === "speaking";
  const audioLevel = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
  return <div ref={root} className="pocket-live" data-paused={paused} role="dialog" aria-modal="true" aria-label="Voice conversation">
    <header><div><AudioLines size={22} /><strong>JARVIS</strong></div><button className="desk-icon-button glass" onClick={onClose} aria-label="End voice conversation"><X size={22} /></button></header>
    <div className="pocket-live-preferences">
      {languages.length > 0 && <label>Reply language<select value={language} onChange={e => onLanguage(e.target.value)}>{languages.map(option => <option key={option.code} value={option.code}>{option.native}</option>)}</select></label>}
      {voices.length > 0 && <label>Speaking voice<select value={voice} onChange={e => onVoice(e.target.value)}>{voices.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>}
    </div>
    <div className="pocket-live-body">
      <div className="pocket-live-state" data-state={state}><VoiceSculpture state={state} level={level} muted={muted} /><h2 role="status">{status}</h2><p>{hint}</p>
        <div className="pocket-level" aria-label="Audio level" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(audioLevel * 100)}>{[.45,.75,1,.7,.5,.9,.65].map((weight,i) => <i key={i} style={{ transform: `scaleY(${active ? .15 + audioLevel * weight * 2 : .13})` }} />)}</div>
      </div>
      {(userText || reply) && <div className="pocket-transcript glass">{userText && <p><small>You</small>{userText}</p>}{reply && <p><small>JARVIS</small>{reply}</p>}</div>}
      {error && <p className="desk-error" role="alert">{error}</p>}
    </div>
    <footer><div className="pocket-live-actions"><button className="glass" onClick={onMute} aria-pressed={muted}>{muted ? <MicOff size={22} /> : <Mic size={22} />}{muted ? "Unmute" : "Mute & send"}</button><button className="glass" onClick={onInterrupt} disabled={state !== "speaking" && state !== "thinking"}><Square size={20} />Stop reply</button></div><button className="pocket-barge" role="switch" aria-checked={bargeIn} onClick={onBargeIn}><span>Allow voice interruption</span><span>{bargeIn ? "On" : "Off"}</span></button></footer>
  </div>;
}
