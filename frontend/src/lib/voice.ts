import { API_BASE, ApiError } from "@/lib/api";
import type { TranscriptResult, VoiceConfig } from "@/types";

/** Ordered by preference; the first supported type wins. */
const CANDIDATE_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

export function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return CANDIDATE_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

export function isRecordingSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

export function fetchVoiceConfig(): Promise<VoiceConfig> {
  return fetch(`${API_BASE}/api/voice/config`, { cache: "no-store" }).then((r) => {
    if (!r.ok) throw new ApiError("Voice config unavailable", r.status);
    return r.json() as Promise<VoiceConfig>;
  });
}

/** Persist the spoken-output language. Shared with the `set_language` tool, so
 *  the picker and "speak Telugu" write the same preference. */
export async function setVoiceLanguage(language: string): Promise<void> {
  const response = await fetch(`${API_BASE}/api/voice/language`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ language }),
  });
  if (!response.ok) throw new ApiError("Could not change language", response.status);
}

/** Persist the speaking voice. Shared with the `set_voice` tool, so the picker
 *  and "use a girl's voice" write the same preference. */
export async function setVoiceSpeaker(voice: string): Promise<void> {
  const response = await fetch(`${API_BASE}/api/voice/voice`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ voice }),
  });
  if (!response.ok) throw new ApiError("Could not change voice", response.status);
}

/**
 * Captures microphone audio until `stop()` is called, then resolves with the
 * recorded blob. The media stream's tracks are always stopped, so the browser's
 * recording indicator clears even if the caller throws.
 */
export interface Recording {
  stop: () => Promise<Blob>;
  cancel: () => void;
  mimeType: string;
}

export async function startRecording(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  recorder.start();

  const releaseStream = () => stream.getTracks().forEach((track) => track.stop());

  return {
    mimeType: recorder.mimeType || mimeType || "audio/webm",
    cancel() {
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } finally {
        releaseStream();
      }
    },
    stop() {
      return new Promise<Blob>((resolve, reject) => {
        recorder.onstop = () => {
          releaseStream();
          const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
          if (blob.size === 0) reject(new Error("No audio was captured."));
          else resolve(blob);
        };
        recorder.onerror = () => {
          releaseStream();
          reject(new Error("Recording failed."));
        };
        if (recorder.state === "inactive") recorder.onstop?.(new Event("stop"));
        else recorder.stop();
      });
    },
  };
}

/** Little-endian WAV (RIFF) header + 16-bit PCM body. */
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
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeText(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/**
 * Convert a recorded clip to 16 kHz mono WAV.
 *
 * `MediaRecorder` only emits compressed containers (WebM/Opus on Chrome and
 * Firefox, MP4/AAC on Safari), and the speech API rejects them. Decoding to raw
 * PCM in the browser and re-encoding as WAV sends a format every vendor
 * accepts, avoids a server-side ffmpeg dependency, and shrinks the upload —
 * 16 kHz mono is the standard STT input rate, so downsampling loses nothing.
 */
export async function toWav(clip: Blob, targetRate = 16000): Promise<Blob> {
  const AudioContextCtor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioContextCtor) throw new Error("This browser cannot process audio.");

  const context = new AudioContextCtor();
  let decoded: AudioBuffer;
  try {
    decoded = await context.decodeAudioData(await clip.arrayBuffer());
  } finally {
    void context.close();
  }

  // Some browsers clamp OfflineAudioContext's rate; fall back to the source
  // rate rather than failing the whole recording.
  const rate = Math.min(Math.max(targetRate, 8000), decoded.sampleRate);
  const frames = Math.max(1, Math.ceil(decoded.duration * rate));

  let rendered: AudioBuffer;
  try {
    const offline = new OfflineAudioContext(1, frames, rate);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    rendered = await offline.startRendering();
  } catch {
    const offline = new OfflineAudioContext(
      1,
      Math.max(1, Math.ceil(decoded.duration * decoded.sampleRate)),
      decoded.sampleRate,
    );
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    rendered = await offline.startRendering();
  }

  return encodeWav(rendered.getChannelData(0), rendered.sampleRate);
}

export async function transcribe(
  clip: Blob,
  signal?: AbortSignal,
): Promise<TranscriptResult> {
  const wav = await toWav(clip);

  const form = new FormData();
  form.append("file", wav, "clip.wav");

  const response = await fetch(`${API_BASE}/api/voice/transcribe`, {
    method: "POST",
    body: form,
    signal,
  });

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (typeof body?.detail === "string") detail = body.detail;
    } catch {
      /* not JSON */
    }
    throw new ApiError(detail, response.status);
  }
  return (await response.json()) as TranscriptResult;
}

export async function synthesize(
  text: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const response = await fetch(`${API_BASE}/api/voice/speak`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  });

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (typeof body?.detail === "string") detail = body.detail;
    } catch {
      /* not JSON */
    }
    throw new ApiError(detail, response.status);
  }
  return await response.blob();
}

/**
 * One shared <audio> element for the whole app, so starting playback anywhere
 * stops whatever was already speaking. Object URLs are revoked on replacement
 * to avoid leaking blobs across a long session.
 */
let sharedAudio: HTMLAudioElement | null = null;
let currentUrl: string | null = null;

export function playAudio(blob: Blob, onEnded?: () => void): HTMLAudioElement {
  stopAudio();
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  sharedAudio = audio;
  currentUrl = url;
  audio.onended = () => {
    onEnded?.();
    stopAudio();
  };
  void audio.play().catch(() => {
    onEnded?.();
    stopAudio();
  });
  return audio;
}

export function stopAudio(): void {
  if (sharedAudio) {
    sharedAudio.pause();
    sharedAudio.onended = null;
    sharedAudio = null;
  }
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }
}
