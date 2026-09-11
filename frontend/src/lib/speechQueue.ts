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

  /** Schedule a decoded buffer onto the audio clock, right after whatever precedes it. */
  private schedule(context: AudioContext, buffer: AudioBuffer, generation: number, text: string, seq: number): void {
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
      this.onPlayed(seq);
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
      if (!this.context) this.context = new window.AudioContext();
      const context = this.context;
      if (context.state === "suspended") await context.resume();
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
   * Reserve this chunk's place in playback order now, but produce its audio
   * lazily inside the chain.
   *
   * For on-device synthesis (native English TTS on Android): synthesis takes
   * real time, and calling `push()` only after it finishes would let a slow
   * chunk's audio land on the chain *after* a faster later chunk's -- silently
   * reordering playback. Calling `pushDeferred` instead reserves the slot the
   * instant the caller sees this chunk (synchronously, before `producer` ever
   * runs), exactly as `push()` reserves its slot before WAV decoding finishes;
   * `producer` then runs serially at its turn in the existing chain.
   */
  pushDeferred(
    producer: () => Promise<{ audio: ArrayBuffer; sampleRate?: number }>,
    text: string,
    seq = 0,
  ): Promise<void> {
    const generation = this.generation;
    this.cancelIdle();
    this.pending++;
    const work = this.chain.then(async () => {
      if (generation !== this.generation) return;
      if (!this.context) this.context = new window.AudioContext();
      const context = this.context;
      if (context.state === "suspended") await context.resume();
      if (generation !== this.generation) return;
      const { audio, sampleRate } = await producer();
      if (generation !== this.generation) return;
      const buffer = await this.decode(context, audio, sampleRate);
      if (generation !== this.generation) return;
      this.schedule(context, buffer, generation, text, seq);
    }).catch((error: unknown) => {
      if (generation === this.generation) {
        if (text) this.onReveal(text);
        this.onPlayed(seq);
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
