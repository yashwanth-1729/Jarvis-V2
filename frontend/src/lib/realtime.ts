import { SpeechQueue } from "@/lib/speechQueue";
import { API_BASE } from "@/lib/api";
import { isNativeTtsAvailable, synthesizeNative } from "@/lib/nativeTts";
import type { VoiceSessionState } from "@/types";

/**
 * English's speaking-rate nudge, applied to on-device synthesis.
 *
 * Must track `Language("en-IN", ...).pace` in `backend/app/core/languages.py`
 * (currently 1.04) -- this is the client-side mirror for the one case where
 * the client, not the backend, drives Piper (see the `"phrase"` case below).
 */
const ENGLISH_PACE = 1.04;

/* ==========================================================================
 * Capture + voice activity detection
 * ==========================================================================
 * Raw PCM rather than MediaRecorder, for two reasons: we need a pre-roll
 * buffer so the first syllable is not clipped when the threshold trips, and we
 * need the samples anyway to emit WAV (the speech API rejects WebM).
 * ======================================================================== */

const TARGET_RATE = 16000;
const FRAME = 2048;
const PREROLL_MS = 320; // audio kept from *before* speech was detected

/* --- Endpointing ---------------------------------------------------------
 * Listening happens in two tiers, which is what lets it be both patient and
 * responsive at once:
 *
 *   SEGMENT_SILENCE_MS  a short pause closes the current *segment*. It is sent
 *                       for transcription immediately, but the turn does NOT
 *                       end — the user is still talking. This is the speed win:
 *                       transcription overlaps with speech instead of starting
 *                       only once the user has finished.
 *
 *   TURN_SILENCE_*_MS   a pause with nothing further ends the turn. Two
 *                       values, chosen once the transcript reveals whether the
 *                       sentence sounded finished: short when it plainly did,
 *                       patient when it trailed off. A single value cannot be
 *                       both, and the wait dominates perceived latency — the
 *                       work itself is around two seconds.
 *
 * Saying "period" / "that's it" ends the turn the moment that segment comes
 * back from transcription, rather than waiting out either timer.
 * ---------------------------------------------------------------------- */
const SEGMENT_SILENCE_MS = 700;

/**
 * How long to wait after speech stops before deciding the turn is over.
 *
 * A single value cannot be right. Long enough to think mid-sentence is far too
 * long to sit through once you have plainly finished, and the difference is
 * most of the perceived latency: the work itself takes about two seconds, so a
 * flat five-second wait more than triples it.
 *
 * So the wait depends on how finished the sentence *sounds*. The bias is
 * deliberately toward patience — being cut off mid-thought is a far worse
 * experience than waiting an extra second — which is why anything ambiguous
 * gets the long timer.
 */
const TURN_SILENCE_COMPLETE_MS = 1_200;
const TURN_SILENCE_OPEN_MS = 4_000;

/** Words that almost always have more sentence coming after them. */
const TRAILING_OFF = new Set([
  "and", "but", "so", "or", "then", "because", "if", "when", "while", "that",
  "which", "with", "for", "to", "the", "a", "an", "my", "of", "on", "at", "in",
  "is", "was", "like", "um", "uh", "er", "hmm", "well", "actually", "maybe",
]);

/**
 * Does this transcript sound like a finished thought?
 *
 * Heuristic on purpose. Real endpointing models exist, but they are another
 * network round trip in the exact place we are trying to save time, and the
 * cost of the two errors is wildly asymmetric: waiting too long is mildly
 * annoying, cutting someone off mid-sentence makes the assistant feel broken.
 * Everything below therefore fails toward "not finished".
 */
export function soundsComplete(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  // Explicit punctuation from the recogniser settles it outright.
  if (/[.!?]$/.test(trimmed)) return true;

  const words = trimmed.toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter(Boolean);
  if (words.length < 3) return false; // "what about" — almost certainly mid-sentence

  // A dangling connective is the clearest signal of an unfinished thought.
  if (TRAILING_OFF.has(words[words.length - 1])) return false;

  return true;
}
const MIN_UTTERANCE_MS = 260; // shorter than this is a cough, not a sentence
const MAX_UTTERANCE_MS = 25_000; // vendor caps a single clip; cut before it does

/** Energy above the running noise floor required to count as speech. */
const SPEECH_FACTOR = 2.6;
const ABSOLUTE_FLOOR = 0.008;

/* --- Barge-in ------------------------------------------------------------
 * Interrupting while JARVIS talks is the single most echo-prone path in the
 * app: the speakers feed straight back into the mic, and a naive detector
 * fires on JARVIS's own voice and cuts him off after one word. Three
 * independent guards, all of which must pass:
 *   1. a much higher energy bar than normal speech detection
 *   2. sustained voice, not a single frame spike
 *   3. a grace period after playback starts, so echo cancellation can converge
 * Headphones make all of this moot; speakers are the hard case.
 * ---------------------------------------------------------------------- */
const BARGE_IN_FACTOR = 9.0;
const BARGE_IN_SUSTAIN_MS = 340;
const BARGE_IN_GRACE_MS = 800;
const BARGE_IN_ABSOLUTE_FLOOR = 0.05;

/** How long the queue must stay empty before we believe playback has ended.
 *  Without this, the gap between two chunks momentarily looks like silence and
 *  the mic re-arms at the low threshold — straight into an echo loop. */


/**
 * How long the mic stays deaf after the last audio finishes.
 *
 * Speech does not stop at the sample boundary: a room rings, a phone speaker
 * decays, and the final consonant of a reply arrives at the mic a beat after
 * the buffer is done. Re-arming on the same frame the audio ends captures that
 * tail as the user beginning to talk, and the turn that follows is JARVIS
 * answering itself.
 */
const PLAYBACK_SETTLE_MS = 420;

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const c = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, c < 0 ? c * 0x8000 : c * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

async function resampleToWav(
  chunks: Float32Array[],
  sourceRate: number,
): Promise<Blob> {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const merged = new Float32Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    merged.set(chunk, cursor);
    cursor += chunk.length;
  }

  if (sourceRate === TARGET_RATE) return encodeWav(merged, TARGET_RATE);

  const frames = Math.max(1, Math.round((merged.length / sourceRate) * TARGET_RATE));
  const offline = new OfflineAudioContext(1, frames, TARGET_RATE);
  const buffer = offline.createBuffer(1, merged.length, sourceRate);
  buffer.copyToChannel(merged, 0);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return encodeWav(rendered.getChannelData(0), TARGET_RATE);
}

interface MicOptions {
  onUtterance: (clip: Blob, speechEndedAt: number, complete?: boolean) => void;
  onSpeechStart: () => void;
  onLevel: (level: number) => void;
  /** True while JARVIS is speaking, so the detector can raise its bar. */
  isSpeaking: () => boolean;
  /** When false the mic ignores input entirely during playback (half-duplex).
   *  The reliable choice on laptop speakers, where echo defeats detection. */
  bargeInEnabled: () => boolean;
  onBargeIn: () => void;
}

class Microphone {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;

  private ring: Float32Array[] = [];
  private ringFrames = 0;
  private capturing: Float32Array[] = [];
  private speaking = false;
  private silenceFrames = 0;
  private lastSilenceFrames = 0;
  private capturedFrames = 0;
  private noiseFloor = 0.01;
  private paused = false;
  private captureEpoch = 0;
  private sampleRate = TARGET_RATE;
  private minimumFrames = 0;

  // Barge-in state
  private playbackStartedAt = 0;
  private playbackEndedAt = 0;
  private voiceRunMs = 0;
  private wasPlayback = false;

  constructor(private readonly options: MicOptions) {}

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });

    const AudioContextCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    const context = new AudioContextCtor();
    this.context = context;
    if (context.state === "suspended") await context.resume();

    this.source = context.createMediaStreamSource(this.stream);
    // ScriptProcessor is deprecated but is the only node available everywhere
    // without shipping a separate AudioWorklet module through the bundler.
    this.processor = context.createScriptProcessor(FRAME, 1, 1);

    const rate = context.sampleRate;
    const prerollFrames = Math.round((PREROLL_MS / 1000) * rate);
    const silenceLimit = Math.round((SEGMENT_SILENCE_MS / 1000) * rate);
    const minFrames = Math.round((MIN_UTTERANCE_MS / 1000) * rate);
    const maxFrames = Math.round((MAX_UTTERANCE_MS / 1000) * rate);
    this.sampleRate = rate;
    this.minimumFrames = minFrames;

    this.processor.onaudioprocess = (event) => {
      if (this.paused) return;
      const input = event.inputBuffer.getChannelData(0);
      const frame = new Float32Array(input.length);
      frame.set(input);

      let sum = 0;
      for (let i = 0; i < frame.length; i += 1) sum += frame[i] * frame[i];
      const rms = Math.sqrt(sum / frame.length);
      this.options.onLevel(Math.min(1, rms * 12));

      const frameMs = (frame.length / rate) * 1000;
      const playback = this.options.isSpeaking();

      // Note when playback began, so the grace period can be measured.
      if (playback && !this.wasPlayback) {
        this.playbackStartedAt = performance.now();
        this.voiceRunMs = 0;
      }
      // Note when playback stopped, while the transition is still visible:
      // `wasPlayback` is overwritten on the next line, so testing it after
      // that point can never be true.
      if (!playback && this.wasPlayback) this.playbackEndedAt = performance.now();
      this.wasPlayback = playback;

      // Only learn the room's noise floor when nothing else is making sound.
      // Adapting during playback would teach the detector that JARVIS's own
      // voice is "normal", which wrecks the threshold for the next turn.
      if (!this.speaking && !playback) {
        this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;
      }

      // Half-duplex: while JARVIS talks the mic is simply deaf, and it stays
      // deaf for PLAYBACK_SETTLE_MS afterwards so the decaying tail of its own
      // voice is not captured as the user starting to speak. Nothing can cut
      // playback short, at the cost of having to wait your turn.
      const settling =
        !playback && performance.now() - this.playbackEndedAt < PLAYBACK_SETTLE_MS;
      if ((playback || settling) && !this.options.bargeInEnabled()) {
        this.voiceRunMs = 0;
        // The meter is fed from the same frames, and letting it run here made
        // the core pulse to JARVIS's own voice — it looked like it was
        // listening to itself, because it was.
        this.options.onLevel(0);
        return;
      }

      let isVoice: boolean;
      if (playback) {
        const threshold = Math.max(
          this.noiseFloor * BARGE_IN_FACTOR,
          BARGE_IN_ABSOLUTE_FLOOR,
        );
        this.voiceRunMs = rms > threshold ? this.voiceRunMs + frameMs : 0;
        const settled =
          performance.now() - this.playbackStartedAt > BARGE_IN_GRACE_MS;
        isVoice = settled && this.voiceRunMs >= BARGE_IN_SUSTAIN_MS;
      } else {
        this.voiceRunMs = 0;
        isVoice = rms > Math.max(this.noiseFloor * SPEECH_FACTOR, ABSOLUTE_FLOOR);
      }

      if (!this.speaking) {
        this.ring.push(frame);
        this.ringFrames += frame.length;
        while (this.ringFrames > prerollFrames && this.ring.length > 1) {
          this.ringFrames -= this.ring[0].length;
          this.ring.shift();
        }

        if (isVoice) {
          if (playback) {
            // Confirmed barge-in: stop playback, then capture normally.
            this.options.onBargeIn();
            this.voiceRunMs = 0;
          }
          this.speaking = true;
          this.silenceFrames = 0;
          this.capturing = [...this.ring];
          this.capturedFrames = this.ringFrames;
          this.ring = [];
          this.ringFrames = 0;
          this.options.onSpeechStart();
        }
        return;
      }

      this.capturing.push(frame);
      this.capturedFrames += frame.length;
      this.silenceFrames = isVoice ? 0 : this.silenceFrames + frame.length;

      if (this.silenceFrames >= silenceLimit || this.capturedFrames >= maxFrames) {
        this.lastSilenceFrames = this.silenceFrames;
        const captured = this.capturing;
        const frames = this.capturedFrames;
        this.speaking = false;
        this.capturing = [];
        this.capturedFrames = 0;
        this.silenceFrames = 0;

        if (frames >= minFrames) {
          const endedAt = performance.now() - (this.lastSilenceFrames / rate) * 1000;
          const epoch = this.captureEpoch;
          void resampleToWav(captured, rate).then((clip) => {
            if (epoch === this.captureEpoch && !this.paused) this.options.onUtterance(clip, endedAt);
          });
        }
      }
    };

    this.source.connect(this.processor);
    // ScriptProcessor only fires while connected to the graph; a zero-gain sink
    // keeps it running without routing the mic to the speakers.
    const mute = context.createGain();
    mute.gain.value = 0;
    this.processor.connect(mute);
    mute.connect(context.destination);
  }

  /**
   * Disable the physical input track and close speech at the exact button press.
   * Returns true when a captured utterance is being encoded and submitted.
   */
  finishAndMute(): boolean {
    const captured = this.capturing;
    const frames = this.capturedFrames;
    const hadSpeech = this.speaking && frames >= this.minimumFrames;
    const endedAt = performance.now();

    this.captureEpoch += 1;
    const epoch = this.captureEpoch;
    this.paused = true;
    this.stream?.getAudioTracks().forEach((track) => { track.enabled = false; });
    this.options.onLevel(0);
    this.ring = [];
    this.ringFrames = 0;
    this.speaking = false;
    this.capturing = [];
    this.capturedFrames = 0;
    this.silenceFrames = 0;

    if (!hadSpeech) return false;
    void resampleToWav(captured, this.sampleRate).then((clip) => {
      if (epoch === this.captureEpoch) this.options.onUtterance(clip, endedAt, true);
    });
    return true;
  }

  /** Re-enable input; session state still decides whether detection is paused. */
  setTrackEnabled(enabled: boolean): void {
    this.stream?.getAudioTracks().forEach((track) => { track.enabled = enabled; });
  }

  /** Suspend detection (used while a turn is being transcribed). */
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) {
      this.captureEpoch++;
      this.ring = [];
      this.ringFrames = 0;
      this.speaking = false;
      this.capturing = [];
      this.capturedFrames = 0;
      this.silenceFrames = 0;
    }
  }

  stop(): void {
    this.paused = true;
    this.captureEpoch++;
    if (this.processor) {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
      this.processor = null;
    }
    this.source?.disconnect();
    this.source = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    void this.context?.close();
    this.context = null;
  }
}

/* ==========================================================================
 * Playback queue — gapless, interruptible
 * ======================================================================== */

/* ==========================================================================
 * Session
 * ======================================================================== */

export interface VoiceSessionHandlers {
  onProgress?: (message: string) => void;
  onState: (state: VoiceSessionState) => void;
  onTranscript: (text: string) => void;
  onDelta: (text: string) => void;
  onTurnEnd: (text: string) => void;
  onTool: (name: string, ok: boolean, display?: unknown) => void;
  /** An instrument panel named by intent, before the answer arrives. */
  onSurface?: (kind: string, data?: Record<string, unknown>) => void;
  onRefresh: (domains: string[]) => void;
  onError: (message: string) => void;
  onLevel: (level: number) => void;
  /** A new question is starting; commit whatever the last reply had shown. */
  onTurnStart: () => void;
  /** Server-confirmed language, including changes made by voice. */
  onLanguage: (code: string) => void;
  /** Server-confirmed speaking voice, including changes made by voice. */
  onVoice: (id: string) => void;
}

export class VoiceSession {
  private socket: WebSocket | null = null;
  private mic: Microphone | null = null;
  private queue: SpeechQueue;
  private state: VoiceSessionState = "connecting";
  private closed = false;
  /**
   * Whether the user may talk over JARVIS.
   *
   * Off by default: the mic is deaf for as long as JARVIS is speaking, and for
   * a moment after. Barge-in is a nice capability and a poor default — an open
   * mic during playback hears JARVIS through the speaker, and on a phone held
   * in the hand that is loud enough to trip the detector, so the assistant
   * interrupts itself mid-sentence and then transcribes its own voice as the
   * next question. Waiting your turn is the reliable behaviour; the toggle is
   * still there for anyone who wants the other one.
   */
  private bargeIn = false;
  private muted = false;
  /** Server-assigned id of the current turn; audio from older turns is dropped. */
  private turnGen = 0;
  private responsePending = false;
  private lastSpeechEnd = 0;
  private lastSpeechStart = 0;
  private playbackReported = false;
  /** Fires when the user has been silent long enough to close the turn. */
  private turnEndTimer: ReturnType<typeof setTimeout> | null = null;
  private recognitionTimer: ReturnType<typeof setTimeout> | null = null;

  private clearRecognitionWait(): void {
    if (this.recognitionTimer !== null) clearTimeout(this.recognitionTimer);
    this.recognitionTimer = null;
  }

  private waitForRecognition(): void {
    this.clearRecognitionWait();
    this.handlers.onProgress?.("Recognizing speech…");
    this.recognitionTimer = setTimeout(() => {
      this.recognitionTimer = null;
      if (this.closed) return;
      this.handlers.onError("Speech recognition did not respond. Please try speaking again.");
      // Cancels the server's recognition worker too; old audio must not become
      // a delayed command after the user has started a replacement question.
      this.interrupt();
    }, 27_000);
  }

  /** Toggle talking-over. Off is half-duplex and immune to speaker echo. */
  setBargeIn(enabled: boolean): void {
    this.bargeIn = enabled;
  }

  constructor(private readonly handlers: VoiceSessionHandlers) {
    this.queue = new SpeechQueue(
      () => {
        // Audio finished playing; only then is it really our turn to listen.
        if (!this.responsePending && !this.closed) this.setState("listening");
      },
      (text) => this.handlers.onDelta(text),
      // Sound is leaving the speaker this instant — this is what turns the
      // core red, so it matches the voice rather than leading it.
      () => {
        this.setState("speaking");
        if (!this.playbackReported && this.socket?.readyState === WebSocket.OPEN) {
          this.playbackReported = true;
          if (this.lastSpeechEnd > 0) this.socket.send(JSON.stringify({
            type: "playback_started", gen: this.turnGen,
            speech_end_ms: performance.now() - this.lastSpeechEnd,
          }));
        }
      },
      (seq) => {
        if (this.socket?.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify({ type: "audio_played", gen: this.turnGen, seq }));
        }
      },
    );
  }

  private setState(next: VoiceSessionState) {
    if (this.state === next) return;
    this.state = next;
    // Detection stays live while speaking so barge-in works; it pauses only
    // while we are transcribing the clip we already have.
    this.mic?.setPaused(this.muted || next === "thinking");
    this.handlers.onState(next);
  }

  get current(): VoiceSessionState {
    return this.state;
  }

  async start(): Promise<void> {
    this.setState("connecting");

    // Advertise the on-device English voice only when it is actually ready
    // (Android with the model provisioned); the server then sends English
    // chunks as `"phrase"` text instead of synthesizing them via Sarvam. This
    // is a per-connection decision made once, here -- a native engine that
    // fails mid-session degrades per-phrase (see the `"phrase"` case below),
    // not by falling back to a second server round-trip.
    const nativeEnglish = isNativeTtsAvailable() ? "&english_tts=client" : "";
    const url = `${API_BASE.replace(/^http/, "ws")}/api/voice/session?audio=pcm16${nativeEnglish}`;
    const socket = new WebSocket(url);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("Could not reach the voice service."));
    });

    socket.onmessage = (event) => {
      void this.onMessage(event).catch((error: unknown) => {
        this.handlers.onError(error instanceof Error ? error.message : "Speech playback failed.");
        this.interrupt();
      });
    };
    socket.onclose = () => {
      this.clearRecognitionWait();
      if (!this.closed) {
        this.queue.stop();
        this.mic?.stop();
        this.handlers.onError("Voice session ended.");
        this.setState("idle");
      }
    };

    this.mic = new Microphone({
      onLevel: this.handlers.onLevel,
      isSpeaking: () => this.responsePending || this.queue.busy || this.state === "speaking",
      bargeInEnabled: () => this.bargeIn,
      onSpeechStart: () => {
        this.lastSpeechStart = performance.now();
        this.cancelTurnEnd();
        if (this.state === "listening") this.setState("hearing");
      },
      onBargeIn: () => this.interrupt(),
      onUtterance: (clip, endedAt, complete) => void this.sendUtterance(clip, endedAt, complete),
    });

    try {
      await this.mic.start();
      if (this.muted) this.mic.finishAndMute();
    } catch (error) {
      const denied =
        error instanceof DOMException &&
        (error.name === "NotAllowedError" || error.name === "SecurityError");
      throw new Error(
        denied
          ? "Microphone permission denied. Allow it in your browser's site settings."
          : "Could not access the microphone.",
      );
    }

    this.setState("listening");
  }

  private async onMessage(event: MessageEvent): Promise<void> {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(event.data as string);
    } catch {
      return;
    }

    // Refreshes describe real tool mutations and must survive interruption.
    // Other obsolete turn events must not reopen a panel or restart playback.
    if (typeof payload.gen === "number" && payload.gen < this.turnGen && payload.type !== "refresh") return;
    switch (payload.type) {
      case "state": {
        const value = payload.value as VoiceSessionState;
        // Trust local playback for the listening handover, so we do not start
        // listening while audio is still in the queue.
        if (value === "listening") {
          this.clearRecognitionWait();
          this.cancelTurnEnd();
          this.handlers.onProgress?.("");
          this.responsePending = false;
          this.queue.finish();
          if (this.queue.busy || this.state === "speaking") return;
        }
        // "speaking" is a fact only this client can know: the server can tell
        // us it began synthesising, but the audio still has to be generated,
        // sent, decoded and reach the front of the queue. Honouring a remote
        // "speaking" turns the core red the moment the user stops talking.
        if (value === "speaking") return;
        this.setState(value);
        break;
      }
      case "transcript": {
        this.clearRecognitionWait();
        this.handlers.onProgress?.("Working on it");
        const heard = String(payload.text ?? "");
        this.handlers.onTranscript(heard);
        // First evidence of what was actually said. A finished-sounding
        // sentence ends the turn quickly; anything trailing off keeps the
        // patient timer it was armed with.
        if (this.turnEndTimer !== null && soundsComplete(heard)) {
          this.armTurnEnd(TURN_SILENCE_COMPLETE_MS);
        }
        break;
      }
      case "delta":
        // Text deltas arrive seconds before their audio does. Showing them
        // immediately makes the caption race the voice, which reads as lag —
        // so they only drive the "still generating" hint, not the transcript.
        break;
      case "caption":
        // Synthesis failed for this sentence; show it so nothing is lost.
        this.handlers.onDelta(String(payload.text ?? ""));
        break;
      case "turn":
        this.clearRecognitionWait();
        this.handlers.onProgress?.("Working on it");
        // The server has moved on to a new question. Anything still queued or
        // still arriving belongs to the previous one.
        this.turnGen = Number(payload.gen ?? 0);
        this.playbackReported = false;
        this.cancelTurnEnd();
        this.queue.begin();
        this.responsePending = true;
        this.handlers.onTurnStart();
        this.setState("thinking");
        break;
      case "audio": {
        // A chunk already on the wire when the turn changed would otherwise
        // play the tail of the previous answer ahead of this one.
        if (Number(payload.gen ?? 0) < this.turnGen) break;
        // Deliberately NOT setState("speaking") here — the chunk has only
        // *arrived*. It still has to decode and wait its turn in the queue, so
        // flipping now turns the core red before a sound comes out. The queue
        // reports the real start.
        const binary = atob(String(payload.data ?? ""));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        await this.queue.push(
          bytes.buffer, String(payload.text ?? ""), Number(payload.seq ?? 0),
          payload.format === "pcm16" ? Number(payload.sample_rate) : undefined,
        );
        break;
      }
      case "phrase": {
        // English chunk the server skipped synthesizing, because this session
        // advertised a native voice at connect time (see `start()`). Reserve
        // this chunk's place in the queue NOW, synchronously, exactly like the
        // "audio" case above does by calling `push()` before any await --
        // otherwise a slow on-device synthesis could land after a later
        // chunk's (possibly Sarvam, possibly native) audio and reorder
        // playback. If synthesis fails, `pushDeferred` falls back to its
        // normal failure path: the caption is still revealed, silently
        // without audio, exactly as a real TTS failure already degrades.
        if (Number(payload.gen ?? 0) < this.turnGen) break;
        const text = String(payload.text ?? "");
        await this.queue.pushDeferred(
          () => synthesizeNative(text, ENGLISH_PACE)
            .then((speech) => ({ audio: speech.pcm, sampleRate: speech.sampleRate })),
          text,
        );
        break;
      }
      case "surface":
        this.handlers.onSurface?.(String(payload.kind ?? ""), payload);
        break;
      case "tool":
        // `display` carries the surface descriptor, so a spoken request
        // reshapes the screen exactly as a typed one does.
        this.handlers.onTool(
          String(payload.name ?? ""),
          Boolean(payload.ok),
          payload.display,
        );
        break;
      case "language":
        this.handlers.onLanguage(String(payload.value ?? ""));
        break;
      case "voice":
        this.handlers.onVoice(String(payload.value ?? ""));
        break;
      case "refresh":
        this.handlers.onRefresh((payload.domains as string[]) ?? []);
        break;
      case "turn_end":
        this.responsePending = false;
        this.queue.finish();
        this.handlers.onTurnEnd(String(payload.text ?? ""));
        break;
      case "error":
        this.handlers.onError(String(payload.message ?? "Something went wrong."));
        if (payload.input_failed === true) this.interrupt();
        break;
      case "progress":
        if (payload.stage === "recognizing") this.handlers.onProgress?.("Recognizing speech…");
        break;
      default:
        break;
    }
  }

  /**
   * Open a new turn, discarding whatever is left of the previous reply.
   *
   * Chunks are scheduled back-to-back on the audio clock, so the tail of a
   * reply is often still *queued* when the user asks the next question — and
   * the barge-in gate deliberately does not fire on every utterance, because
   * it is tuned to ignore speaker echo. Without this flush that leftover keeps
   * its slot and plays first, so the closing line of the previous answer is
   * heard immediately *before* the answer to the new question.
   */
  private beginTurn(): void {
    this.cancelTurnEnd();
    this.queue.begin();
    this.responsePending = true;
    this.turnGen++;
    // Let the UI commit whatever the last reply had shown before its text is
    // replaced by the new turn's.
    this.handlers.onTurnStart();
    this.setState("thinking");
  }

  private async sendUtterance(
    clip: Blob,
    speechEndedAt: number,
    complete = false,
  ): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const socket = this.socket;
    const buffer = await clip.arrayBuffer();
    if (this.closed || this.socket !== socket || socket.readyState !== WebSocket.OPEN || this.responsePending) return;
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    // A *segment*, not a finished turn: the server transcribes it right away
    // and holds the text. The turn ends either on a stop word or on the long
    // silence timer armed below.
    this.socket.send(JSON.stringify({
      type: complete ? "utterance" : "segment",
      audio: btoa(binary),
    }));
    this.waitForRecognition();
    this.lastSpeechEnd = speechEndedAt;
    if (complete) {
      this.cancelTurnEnd();
      this.responsePending = true;
      this.queue.begin();
      this.setState("thinking");
    } else if (this.lastSpeechStart <= speechEndedAt) {
      this.armTurnEnd();
    }
  }

  /**
   * User microphone control. Muting during speech commits exactly what has
   * already been captured as a complete turn; muting after a completed segment
   * closes its waiting turn immediately. No new session or provider call is
   * created when the microphone is unmuted.
   */
  setMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    if (!this.mic) return;

    if (muted) {
      const waitingForMore = this.turnEndTimer !== null;
      this.cancelTurnEnd();
      const captured = this.mic.finishAndMute();
      if (!captured && waitingForMore) this.commitTurn();
      return;
    }

    this.mic.setTrackEnabled(true);
    this.mic.setPaused(this.state === "thinking");
    if (this.state === "hearing" && !this.responsePending) this.setState("listening");
  }

  private commitTurn(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || this.responsePending) return;
    this.socket.send(JSON.stringify({ type: "end_turn" }));
    this.responsePending = true;
    this.queue.begin();
    this.setState("thinking");
  }

  /**
   * Restart the silence timer that closes the turn.
   *
   * Called first when a segment is sent — before anything is known about
   * what was said, so it uses the patient timer — and again when the
   * transcript arrives, which is the first moment there is any evidence
   * about whether the sentence finished.
   */
  private armTurnEnd(delay: number = TURN_SILENCE_OPEN_MS): void {
    if (this.turnEndTimer !== null) clearTimeout(this.turnEndTimer);
    this.turnEndTimer = setTimeout(() => {
      this.turnEndTimer = null;
      this.commitTurn();
    }, Math.max(0, this.lastSpeechEnd + delay - performance.now()));
  }

  private cancelTurnEnd(): void {
    if (this.turnEndTimer !== null) {
      clearTimeout(this.turnEndTimer);
      this.turnEndTimer = null;
    }
  }

  /** Cut JARVIS off mid-sentence. */
  interrupt(): void {
    this.clearRecognitionWait();
    this.handlers.onProgress?.("");
    this.cancelTurnEnd();
    this.turnGen++;
    this.responsePending = false;
    this.queue.stop();
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "interrupt" }));
    }
    this.setState("listening");
  }

  say(text: string): void {
    this.lastSpeechEnd = 0;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "text", text }));
      this.beginTurn();
    }
  }

  /** Switch the language JARVIS replies in. Input stays auto-detected. */
  setLanguage(code: string): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "language", value: code }));
    }
  }

  /** Switch the speaking voice. Takes effect on the next synthesized chunk. */
  setVoice(id: string): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "voice", value: id }));
    }
  }

  stop(): void {
    this.closed = true;
    this.clearRecognitionWait();
    this.cancelTurnEnd();
    this.mic?.stop();
    this.mic = null;
    this.queue.dispose();
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) this.socket.close();
    this.socket = null;
    this.state = "idle";
  }
}
