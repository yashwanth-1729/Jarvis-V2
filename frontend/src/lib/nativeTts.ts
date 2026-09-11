/**
 * On-device English speech for the Android build.
 *
 * The phone runs the JARVIS backend under Chaquopy, where Piper's ONNX stack
 * has no arm64 wheel, so English cannot be synthesized in Python there. Instead
 * the native shell exposes a `window.JarvisTts` bridge backed by sherpa-onnx,
 * which runs the *same* high-tier Piper voice (`en_US-ryan-high`) on the phone
 * CPU. This module is the WebView side of that bridge.
 *
 * It is inert everywhere the bridge is absent — desktop, web, and any Android
 * build that has not provisioned the model — so callers can ask
 * `isNativeTtsAvailable()` first and fall back to the normal backend audio path
 * (Sarvam) with no special-casing. The produced audio is PCM16 mono, ready to
 * hand straight to `SpeechQueue.push(buffer, text, seq, sampleRate)`.
 *
 * The bridge call is asynchronous: `addJavascriptInterface` methods must return
 * promptly, and synthesis takes ~1s, so the Kotlin side renders on a worker
 * thread and calls back into the page. We hand it a request id and resolve the
 * matching promise when the delivery hook fires.
 */

interface NativeTtsBridge {
  /** Fire-and-forget: synthesize `text`, then deliver by request id. */
  synthesize(requestId: string, text: string, pace: number): void;
  /** True once the model and espeak-ng-data are loaded and ready. */
  isReady(): boolean;
}

declare global {
  interface Window {
    JarvisTts?: NativeTtsBridge;
    /** Delivery hooks the Kotlin bridge calls via evaluateJavascript. */
    __jarvisTtsDeliver?: (requestId: string, base64Pcm: string, sampleRate: number) => void;
    __jarvisTtsError?: (requestId: string, message: string) => void;
  }
}

export interface NativeSpeech {
  /** Mono PCM16 little-endian, ready for SpeechQueue.push. */
  pcm: ArrayBuffer;
  sampleRate: number;
}

interface Pending {
  resolve: (value: NativeSpeech) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();
let counter = 0;
let hooksInstalled = false;

/** Longest we wait for one utterance before giving up and falling back. */
const SYNTH_TIMEOUT_MS = 12_000;

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function installHooks(): void {
  if (hooksInstalled || typeof window === "undefined") return;
  hooksInstalled = true;

  window.__jarvisTtsDeliver = (requestId, base64Pcm, sampleRate) => {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    try {
      entry.resolve({ pcm: base64ToArrayBuffer(base64Pcm), sampleRate });
    } catch (error) {
      entry.reject(error instanceof Error ? error : new Error("bad native audio"));
    }
  };

  window.__jarvisTtsError = (requestId, message) => {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.reject(new Error(message || "native TTS failed"));
  };
}

/** Whether on-device English synthesis is available in this shell right now. */
export function isNativeTtsAvailable(): boolean {
  if (typeof window === "undefined") return false;
  const bridge = window.JarvisTts;
  if (!bridge) return false;
  try {
    return bridge.isReady();
  } catch {
    return false;
  }
}

/**
 * Synthesize English speech on-device. Rejects (never hangs) if the bridge is
 * absent, errors, or does not answer within the timeout, so the caller can fall
 * back to the backend audio path.
 */
export function synthesizeNative(text: string, pace = 1.0): Promise<NativeSpeech> {
  const bridge = typeof window !== "undefined" ? window.JarvisTts : undefined;
  if (!bridge) return Promise.reject(new Error("native TTS bridge unavailable"));
  installHooks();

  const clean = text.trim();
  if (!clean) return Promise.reject(new Error("nothing to speak"));

  counter += 1;
  const requestId = `${Date.now()}-${counter}`;
  return new Promise<NativeSpeech>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(requestId)) reject(new Error("native TTS timed out"));
    }, SYNTH_TIMEOUT_MS);
    pending.set(requestId, { resolve, reject, timer });
    try {
      bridge.synthesize(requestId, clean, pace);
    } catch (error) {
      pending.delete(requestId);
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error("native TTS call failed"));
    }
  });
}
