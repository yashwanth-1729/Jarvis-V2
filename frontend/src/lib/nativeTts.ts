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
 * (Sarvam) with no special-casing.
 *
 * Audio is *streamed*: the Kotlin side calls back once per sentence as it is
 * generated (PCM16 mono), then once more when the phrase is done. A phrase is
 * therefore heard from its first sentence rather than after the whole phrase
 * has been synthesized — the same shape as Sarvam's streamed audio, which is
 * why Telugu never had gaps.
 */

interface NativeTtsBridge {
  /** Fire-and-forget: stream `text` sentence by sentence, by request id. */
  synthesizeStream(requestId: string, text: string, pace: number): void;
  /** Abandon every queued and in-progress synthesis. */
  cancelAll(): void;
  /** True once the model and espeak-ng-data are loaded and ready. */
  isReady(): boolean;
}

declare global {
  interface Window {
    JarvisTts?: NativeTtsBridge;
    /** Delivery hooks the Kotlin bridge calls via evaluateJavascript. */
    __jarvisTtsChunk?: (requestId: string, base64Pcm: string, sampleRate: number) => void;
    __jarvisTtsDone?: (requestId: string) => void;
    __jarvisTtsError?: (requestId: string, message: string) => void;
  }
}

interface Pending {
  onChunk: (pcm: ArrayBuffer, sampleRate: number) => void;
  resolve: () => void;
  reject: (reason: Error) => void;
}

const pending = new Map<string, Pending>();
let counter = 0;
let hooksInstalled = false;

/**
 * How long the bridge may deliver *nothing at all* before every open request
 * is failed.
 *
 * Deliberately a stall detector, not a per-request deadline. Synthesis runs on
 * one native worker, in order, so a phrase late in a long reply spends most of
 * its life waiting behind the phrases ahead of it. The old 12s per-request
 * timeout counted that waiting: the third phrase of a medium reply timed out
 * while its turn had not even come, was dropped silently, and the rejection
 * interrupted the rest of the reply. Progress on *any* request proves the
 * worker is alive; only a worker that has gone quiet is failed.
 */
const STALL_MS = 20_000;

let lastProgress = 0;
let watchdog: ReturnType<typeof setInterval> | null = null;

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function failAll(error: Error): void {
  for (const [id, entry] of pending) {
    pending.delete(id);
    entry.reject(error);
  }
}

function startWatchdog(): void {
  if (watchdog !== null) return;
  watchdog = setInterval(() => {
    if (!pending.size) {
      if (watchdog !== null) clearInterval(watchdog);
      watchdog = null;
      return;
    }
    if (performance.now() - lastProgress > STALL_MS) failAll(new Error("native TTS stalled"));
  }, 1000);
}

function installHooks(): void {
  if (hooksInstalled || typeof window === "undefined") return;
  hooksInstalled = true;

  window.__jarvisTtsChunk = (requestId, base64Pcm, sampleRate) => {
    lastProgress = performance.now();
    const entry = pending.get(requestId);
    if (!entry) return;
    try {
      entry.onChunk(base64ToArrayBuffer(base64Pcm), sampleRate);
    } catch (error) {
      pending.delete(requestId);
      entry.reject(error instanceof Error ? error : new Error("bad native audio"));
    }
  };

  window.__jarvisTtsDone = (requestId) => {
    lastProgress = performance.now();
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    entry.resolve();
  };

  window.__jarvisTtsError = (requestId, message) => {
    lastProgress = performance.now();
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    entry.reject(new Error(message || "native TTS failed"));
  };
}

/** Whether on-device English synthesis is available in this shell right now. */
export function isNativeTtsAvailable(): boolean {
  if (typeof window === "undefined") return false;
  const bridge = window.JarvisTts;
  if (!bridge || typeof bridge.synthesizeStream !== "function") return false;
  try {
    return bridge.isReady();
  } catch {
    return false;
  }
}

/**
 * Synthesize English speech on-device, one sentence at a time.
 *
 * `onChunk` receives each sentence's PCM16 as soon as it exists. Resolves when
 * the phrase is finished; rejects (never hangs) if the bridge is absent,
 * errors, stalls, or `cancelNative()` is called.
 */
export function streamNative(
  text: string,
  pace: number,
  onChunk: (pcm: ArrayBuffer, sampleRate: number) => void,
): Promise<void> {
  const bridge = typeof window !== "undefined" ? window.JarvisTts : undefined;
  if (!bridge) return Promise.reject(new Error("native TTS bridge unavailable"));
  installHooks();

  const clean = text.trim();
  if (!clean) return Promise.resolve();

  counter += 1;
  const requestId = `${Date.now()}-${counter}`;
  return new Promise<void>((resolve, reject) => {
    // A fresh burst of work starts the stall clock; joining work already in
    // flight must not reset it, or a wedged worker would never be noticed.
    if (!pending.size) lastProgress = performance.now();
    pending.set(requestId, { onChunk, resolve, reject });
    startWatchdog();
    try {
      bridge.synthesizeStream(requestId, clean, pace);
    } catch (error) {
      pending.delete(requestId);
      reject(error instanceof Error ? error : new Error("native TTS call failed"));
    }
  });
}

/**
 * Drop every on-device synthesis in flight: the reply they belong to has been
 * abandoned (interrupt, new turn, session closed). Frees the native worker for
 * the next reply instead of leaving it to finish audio no one will hear.
 */
export function cancelNative(): void {
  failAll(new Error("native TTS cancelled"));
  try {
    window.JarvisTts?.cancelAll();
  } catch {
    // Bridge gone; nothing left to cancel.
  }
}
