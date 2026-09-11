/** A phrase whose audio arrives in pieces (on-device streamed synthesis). */
export interface SpeechStream {
  /** Queue the next piece; it plays straight after the previous one. */
  append(audio: ArrayBuffer, sampleRate: number): void;
  /** No more pieces are coming. */
  end(): void;
  /** Synthesis failed; whatever arrived still plays, the rest is dropped. */
  fail(error: Error): void;
}

interface OpenStream {
  wake: () => void;
  abandon?: () => void;
}

/** Ordered audio-clock playback. Stop invalidates decoding as well as sources. */
export class SpeechQueue {
  private context: AudioContext | null = null;
  private nextStart = 0;
  private active = new Set<AudioBufferSourceNode>();
  private pending = 0;
  private generation = 0;
  private chain: Promise<void> = Promise.resolve();
  private complete = true;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private reveals = new Set<ReturnType<typeof setTimeout>>();
  /** Streams still open: woken by every piece, and released by `stop()`. */
  private streams = new Set<OpenStream>();

  constructor(
    private readonly onIdle: () => void,
    private readonly onReveal: (text: string) => void,
    private readonly onPlaybackStart: () => void = () => {},
    private readonly onPlayed: (seq: number) => void = () => {},
  ) {}

  get busy(): boolean { return this.pending > 0 || this.active.size > 0; }

  private cancelIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private scheduleIdle(): void {
    this.cancelIdle();
    if (!this.complete || this.busy) return;
    const generation = this.generation;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (generation === this.generation && this.complete && !this.busy) this.onIdle();
    }, 450);
  }

  begin(): void { this.stop(); this.complete = false; }
  finish(): void { this.complete = true; this.scheduleIdle(); }

  private async audioContext(): Promise<AudioContext> {
    if (!this.context) this.context = new window.AudioContext();
    if (this.context.state === "suspended") await this.context.resume();
    return this.context;
  }

  /** Decode either raw PCM16 (given a sample rate) or an encoded WAV/etc. blob. */
  private async decode(context: AudioContext, audio: ArrayBuffer, sampleRate?: number): Promise<AudioBuffer> {
    if (sampleRate !== undefined) {
      if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 48000 || audio.byteLength % 2 || !audio.byteLength) {
        throw new Error("Invalid speech audio packet.");
      }
      const buffer = context.createBuffer(1, audio.byteLength / 2, sampleRate);
      const samples = buffer.getChannelData(0);
      const view = new DataView(audio);
      for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
      return buffer;
    }
    return context.decodeAudioData(audio);
  }

  /**
   * Schedule a decoded buffer onto the audio clock, right after whatever
   * precedes it. `report` sends the playback credit for `seq` when it ends;
   * streamed pieces have no server-side credit to return.
   */
  private schedule(
    context: AudioContext, buffer: AudioBuffer, generation: number, text: string, seq: number, report = true,
  ): void {
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + 0.02, this.nextStart);
    this.nextStart = startAt + buffer.duration;
    this.active.add(source);
    const timer = setTimeout(() => {
      this.reveals.delete(timer);
      if (generation !== this.generation) return;
      this.onPlaybackStart();
      if (text) this.onReveal(text);
    }, Math.max(0, (startAt - context.currentTime) * 1000));
    this.reveals.add(timer);
    source.onended = () => {
      source.disconnect();
      if (generation !== this.generation) return;
      this.active.delete(source);
      if (report) this.onPlayed(seq);
      this.scheduleIdle();
    };
    source.start(startAt);
  }

  push(audio: ArrayBuffer, text: string, seq = 0, sampleRate?: number): Promise<void> {
    const generation = this.generation;
    this.cancelIdle();
    this.pending++;
    // Serial decoding preserves arrival order even when later WAVs decode faster.
    const work = this.chain.then(async () => {
      if (generation !== this.generation) return;
      const context = await this.audioContext();
      if (generation !== this.generation) return;
      const buffer = await this.decode(context, audio, sampleRate);
      if (generation !== this.generation) return;
      this.schedule(context, buffer, generation, text, seq);
    }).catch((error: unknown) => {
      if (generation === this.generation) {
        if (text) this.onReveal(text);
        this.onPlayed(seq); // release server credit even on decoder failure
        throw error;
      }
    }).finally(() => {
      if (generation === this.generation) {
        this.pending--;
        this.scheduleIdle();
      }
    });
    this.chain = work.catch(() => {});
    return work;
  }

  /**
   * Reserve a playback slot now for audio that will arrive in pieces.
   *
   * For on-device synthesis (Piper on Android), which produces a phrase one
   * sentence at a time. The slot is taken synchronously, in arrival order, so
   * a phrase can never be overtaken by a later one; when its turn comes each
   * piece is scheduled straight after the previous on the audio clock -- the
   * first sentence plays while the rest are still being generated, instead
   * of the whole phrase being synthesized before any of it is heard. The next
   * item in the queue starts only once `end()` or `fail()` closes this one.
   *
   * Never rejects: a phrase that produced no audio still reveals its text, and
   * one that failed part-way keeps what was already heard. `onAbandon` runs if
   * `stop()` discards the stream while it is still open, so its producer can
   * stop generating audio no one will hear.
   */
  pushStream(text: string, onAbandon?: () => void): SpeechStream {
    const generation = this.generation;
    this.cancelIdle();
    this.pending++;
    const pieces: Array<{ audio: ArrayBuffer; sampleRate: number }> = [];
    let ended = false;
    let spoken = false;
    let resume: (() => void) | null = null;
    const open: OpenStream = {
      wake: () => {
        const next = resume;
        resume = null;
        next?.();
      },
      abandon: onAbandon,
    };
    this.streams.add(open);

    const work = this.chain.then(async () => {
      if (generation !== this.generation) return;
      const context = await this.audioContext();
      while (generation === this.generation) {
        const piece = pieces.shift();
        if (piece) {
          const buffer = await this.decode(context, piece.audio, piece.sampleRate);
          if (generation !== this.generation) return;
          this.schedule(context, buffer, generation, spoken ? "" : text, 0, false);
          spoken = true;
          continue;
        }
        if (ended) break;
        await new Promise<void>((wake) => { resume = wake; });
      }
    }).catch(() => {
      // A bad piece ends the phrase early; what already played stands.
    }).finally(() => {
      this.streams.delete(open);
      if (generation === this.generation) {
        if (!spoken && text) this.onReveal(text);
        this.pending--;
        this.scheduleIdle();
      }
    });
    this.chain = work;

    return {
      append: (audio, sampleRate) => {
        if (ended || generation !== this.generation) return;
        pieces.push({ audio, sampleRate });
        open.wake();
      },
      end: () => {
        ended = true;
        open.wake();
      },
      fail: () => {
        ended = true;
        open.wake();
      },
    };
  }

  stop(): void {
    this.generation++;
    this.cancelIdle();
    this.complete = true;
    for (const timer of this.reveals) clearTimeout(timer);
    this.reveals.clear();
    for (const source of this.active) {
      source.onended = null;
      try { source.stop(); } catch { /* already ended */ }
      source.disconnect();
    }
    this.active.clear();
    // Release open streams: each producer is told once, and each waiting loop
    // is woken so it can see the new generation and exit.
    const abandon = new Set<() => void>();
    for (const open of this.streams) {
      if (open.abandon) abandon.add(open.abandon);
      open.wake();
    }
    this.streams.clear();
    for (const callback of abandon) callback();
    this.pending = 0;
    this.nextStart = 0;
    this.chain = Promise.resolve();
  }

  dispose(): void {
    this.stop();
    void this.context?.close();
    this.context = null;
  }
}
