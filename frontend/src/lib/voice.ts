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

export async function transcribe(
  clip: Blob,
  signal?: AbortSignal,
): Promise<TranscriptResult> {
  const extension = clip.type.includes("ogg")
    ? "ogg"
    : clip.type.includes("mp4")
      ? "m4a"
      : "webm";

  const form = new FormData();
  form.append("file", clip, `clip.${extension}`);

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
