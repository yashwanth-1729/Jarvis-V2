package builds.yashwanth.jarvis

import android.content.Context
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsVitsModelConfig
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

private const val TAG = "JarvisTts"

/** One on-device voice's asset filenames, relative to assets/piper/. */
private data class VoiceSpec(val modelAsset: String, val tokensAsset: String)

/**
 * Registered on-device voices, keyed by the same id used everywhere else in
 * the app (Piper's `<lang>_<REGION>-<name>-<quality>` naming, matching
 * `backend/app/core/config.py`'s `jarvis_piper_model` /
 * `jarvis_piper_telugu_model`).
 *
 * English's tokens file is named plain `tokens.txt` -- a holdover from when
 * it was the only voice and sherpa-onnx's own tarball ships it that way.
 * Every voice added since gets its own `<id>.tokens.txt` name instead, since
 * a second `tokens.txt` would collide (see setup_piper_telugu.ps1).
 */
private val VOICES = mapOf(
  "en_US-ryan-high" to VoiceSpec("en_US-ryan-high.onnx", "tokens.txt"),
  "te_IN-padmavathi-medium" to VoiceSpec(
    "te_IN-padmavathi-medium.onnx",
    "te_IN-padmavathi-medium.tokens.txt",
  ),
)

/**
 * On-device speech for languages with a local Piper voice, run natively via
 * sherpa-onnx. English speaks `en_US-ryan-high` unconditionally (Sarvam is
 * only ever a fallback for it); Telugu's `te_IN-padmavathi-medium` is used
 * only when the user opts in (see `telugu_tts_engine` /
 * `PREF_TELUGU_TTS_ENGINE` on the backend) -- Sarvam is Telugu's default.
 *
 * Chaquopy's Python backend can't do this itself -- neither onnxruntime nor
 * Piper's phonemizer has an arm64/Android wheel -- so this is plain Kotlin
 * calling sherpa-onnx's prebuilt native library (see build.gradle.kts). Voices
 * ship inside the APK under assets/piper/ (fetched by
 * backend/tools/android/setup_piper.ps1 and setup_piper_telugu.ps1, both
 * gitignored) and are copied out to a real filesystem path once, since sherpa
 * needs actual file paths for the model, tokens and espeak-ng-data -- not the
 * asset manager's virtual ones. espeak-ng-data is shared across every voice
 * (it is Piper's language-independent phonemizer data set), so it is only
 * ever provisioned and loaded once regardless of how many voices are used.
 */
object SherpaTts {
  // Only ONE native engine resident at a time, keyed by which voice it is.
  // Was a map holding every voice ever used concurrently ("a session that
  // never touches Telugu never pays to load its model") -- crashed the whole
  // native process the moment a second voice (e.g. Telugu, on top of an
  // already-loaded English) was loaded: confirmed live via logcat, no Java
  // exception, just "Process ... has died" seconds after the second
  // OfflineTts() construction. Two resident VITS models is apparently not
  // safe (or not affordable memory-wise) in this sherpa-onnx build. Switching
  // voices now releases the previous engine first -- costs a reload if the
  // user bounces between languages, but that's a real cost, not a crash.
  private var currentVoiceId: String? = null
  private var currentEngine: OfflineTts? = null
  private val loadLock = Any()

  /**
   * Inference threads for ONE synthesis call.
   *
   * Multiple synthesis calls now run concurrently (see
   * `JarvisTtsBridge.POOL_SIZE`), and this small VITS model showed little
   * benefit past a couple of threads -- measured on-device, one call alone
   * ran at essentially the same real-time factor (~0.65-0.68x) whether given
   * 3 or 4 threads. Two per call, three calls at once (6 of 8 cores) covers a
   * three-phrase reply without every phrase waiting for a free slot, at
   * roughly the same total throughput as fewer, thread-hungrier jobs.
   */
  private const val NUM_THREADS = 2

  private fun dir(context: Context) = File(context.filesDir, "tts")

  /**
   * Copy the bundled voices out of read-only assets to a real path, once per
   * voice not yet on disk.
   *
   * Runs the full-tree copy again if ANY registered voice's model file is
   * still missing -- covers both a fresh install and an existing install that
   * only ever provisioned English before Telugu's assets were added by a
   * later app update. `copyAsset` overwrites, so re-running it after English
   * is already provisioned just re-copies English's files alongside adding
   * Telugu's; harmless, and only ever happens once per newly-added voice.
   */
  private fun provision(context: Context) {
    val d = dir(context)
    if (VOICES.values.all { File(d, it.modelAsset).exists() }) return
    d.mkdirs()
    copyAsset(context, "piper", d)
    Log.i(TAG, "voices provisioned -> ${d.absolutePath}")
  }

  private fun copyAsset(context: Context, path: String, dest: File) {
    val children = context.assets.list(path) ?: emptyArray()
    if (children.isEmpty()) { // a leaf: no children means it's a file, not a directory
      context.assets.open(path).use { input ->
        dest.outputStream().use { input.copyTo(it) }
      }
      return
    }
    dest.mkdirs()
    for (child in children) copyAsset(context, "$path/$child", File(dest, child))
  }

  private fun engine(context: Context, voiceId: String): OfflineTts {
    currentEngine?.let { if (currentVoiceId == voiceId) return it }
    synchronized(loadLock) {
      currentEngine?.let { if (currentVoiceId == voiceId) return it }
      val spec = VOICES[voiceId] ?: error("unknown voice id: $voiceId")
      val d = dir(context).absolutePath
      val config = OfflineTtsConfig(
        model = OfflineTtsModelConfig(
          vits = OfflineTtsVitsModelConfig(
            model = "$d/${spec.modelAsset}",
            tokens = "$d/${spec.tokensAsset}",
            dataDir = "$d/espeak-ng-data",
          ),
          numThreads = NUM_THREADS,
          debug = false,
        ),
        // One sentence per generation batch, so `stream` gets a callback --
        // and the listener gets audio -- after every sentence rather than
        // once at the end of the whole phrase.
        maxNumSentences = 1,
      )
      // Free the previous voice's native engine BEFORE constructing the new
      // one -- two OfflineTts instances alive at once crashes the native
      // process (see class doc). try/catch: release() on an engine with any
      // in-flight generate() call is unverified territory; a failure here
      // must not block loading the voice the caller actually asked for.
      currentEngine?.let {
        try { it.release() } catch (e: Throwable) { Log.w(TAG, "release() of previous voice failed", e) }
      }
      currentEngine = null
      // No AssetManager passed: the model was already copied to a real path
      // above, so this takes sherpa's file-path constructor rather than its
      // (slower, one-shot) load-from-APK-assets one.
      val instance = OfflineTts(config = config)
      currentEngine = instance
      currentVoiceId = voiceId
      return instance
    }
  }

  /**
   * Provision and load one voice's model, off the caller's thread if needed.
   *
   * Safe to call repeatedly and from multiple threads -- `engine()` is
   * synchronized and caches each loaded voice, so every call after a given
   * voice's first successful load is free. Returns false (never throws) on
   * any failure -- an unknown id, or a missing/corrupt voice -- so the caller
   * just falls back to Sarvam for that language.
   */
  fun ready(context: Context, voiceId: String): Boolean {
    return try {
      provision(context)
      engine(context, voiceId)
      true
    } catch (error: Throwable) {
      Log.e(TAG, "load failed for $voiceId: ${error.message}", error)
      false
    }
  }

  /** Mono PCM16 little-endian samples + the model's sample rate, all at once. */
  fun synthesize(context: Context, voiceId: String, text: String, pace: Float): Pair<ByteArray, Int> {
    val audio = engine(context, voiceId).generate(text = text, sid = 0, speed = pace)
    return pcm16(audio.samples) to audio.sampleRate
  }

  /**
   * Synthesize sentence by sentence, handing each sentence's PCM16 to
   * [onSentence] the moment it exists.
   *
   * This is what makes a long reply play continuously. Whole-phrase synthesis
   * produced nothing until the entire phrase was done -- for a 200-character
   * phrase, many seconds of silence after a short opener had already
   * finished. With `maxNumSentences = 1` sherpa calls back after every
   * sentence, so playback starts on the first one while the rest generate.
   *
   * [onSentence] returns false to stop generating: sherpa keeps going only
   * while the callback's result is non-zero (`should_continue` in
   * offline-tts-vits-impl.h), which is how an interrupted reply stops using
   * the CPU mid-phrase instead of finishing work nobody will hear.
   */
  fun stream(
    context: Context,
    voiceId: String,
    text: String,
    pace: Float,
    onSentence: (ByteArray, Int) -> Boolean,
  ) {
    val engine = engine(context, voiceId)
    val rate = engine.sampleRate()
    engine.generateWithCallback(text = text, sid = 0, speed = pace) { samples ->
      if (onSentence(pcm16(samples), rate)) 1 else 0
    }
  }

  private fun pcm16(samples: FloatArray): ByteArray {
    val pcm = ByteArray(samples.size * 2)
    var i = 0
    for (sample in samples) {
      val value = (sample.coerceIn(-1f, 1f) * 32767f).toInt()
      pcm[i++] = (value and 0xFF).toByte()
      pcm[i++] = ((value shr 8) and 0xFF).toByte()
    }
    return pcm
  }
}

/**
 * The `window.JarvisTts` bridge the WebView calls into (see
 * `frontend/src/lib/nativeTts.ts`).
 *
 * Up to two phrases synthesize concurrently (see [POOL_SIZE]). Results go
 * back by request id through `evalJs`, matching the pattern
 * `JarvisNotifications` and `MainActivity.attachNotificationBridge` already use
 * for the WebView-to-native direction.
 */
class JarvisTtsBridge(
  private val context: Context,
  private val evalJs: (String) -> Unit,
) {
  companion object {
    /**
     * How many phrases synthesize at once.
     *
     * Was 3, on the theory that letting phrase N+1 build while phrase N is
     * still building would close the dead-air gap between phrases. On-device
     * A/B measurement (2026-09-12) showed the opposite: `speechQueue.ts`
     * plays phrases in strict arrival order regardless of which finishes
     * synthesizing first, so a concurrently-synthesizing later phrase is
     * never heard any sooner for it -- it only steals CPU from whichever
     * phrase is actually gating playback right now. Measured on this
     * hardware: a 114-char phrase synthesized at 61ms/char under 3-way
     * concurrency vs 50ms/char running alone; a 54-char phrase at 69ms/char
     * concurrent vs 36ms/char alone. Serial synthesis is strictly faster for
     * the phrase that matters, with no downside once it stopped being able
     * to help.
     *
     * The actual fix for the gap is keeping phrases small enough that one
     * phrase's synthesis time fits inside the previous phrase's playback
     * time -- see `NATIVE_TTS_MAX_CHUNK_CHARS` in the backend's
     * `realtime.py`. This just stops concurrency from making the critical
     * phrase slower than it needs to be.
     */
    private const val POOL_SIZE = 1
  }

  private val pool = Executors.newFixedThreadPool(POOL_SIZE)

  /**
   * Bumped by [cancelAll]. Work queued under an older value is skipped, and
   * work already generating stops at its next sentence -- otherwise a reply
   * the user interrupted keeps the single worker busy and delays the next.
   */
  private val epoch = AtomicInteger()

  /** Ready check for a specific voice id (see `SherpaTts.VOICES`). */
  @JavascriptInterface
  fun isReady(voiceId: String): Boolean = SherpaTts.ready(context, voiceId)

  /** Whole-phrase synthesis, delivered once. Kept for diagnostics. */
  @JavascriptInterface
  fun synthesize(requestId: String, voiceId: String, text: String, pace: Double) {
    pool.execute {
      try {
        val (pcm, rate) = SherpaTts.synthesize(context, voiceId, text, pace.toFloat())
        val encoded = Base64.encodeToString(pcm, Base64.NO_WRAP)
        evalJs("window.__jarvisTtsDeliver && window.__jarvisTtsDeliver('$requestId','$encoded',$rate)")
      } catch (error: Throwable) {
        fail(requestId, error)
      }
    }
  }

  /**
   * Streamed synthesis: one `__jarvisTtsChunk` per sentence as it is
   * generated, then `__jarvisTtsDone`. This is what voice mode uses.
   */
  @JavascriptInterface
  fun synthesizeStream(requestId: String, voiceId: String, text: String, pace: Double) {
    val mine = epoch.get()
    // TEMPORARY diagnostic (2026-09-12, remove after the Piper gap
    // investigation): reconstruct the real on-device timeline -- when this
    // phrase was handed to the bridge, how long it waited for a free pool
    // thread, when each sentence's audio was actually ready, and total
    // phrase time. Filter with: adb logcat -s JarvisTts
    val queuedAt = SystemClock.elapsedRealtime()
    Log.i(TAG, "req=$requestId QUEUED voice=$voiceId chars=${text.length} pool_active=${(pool as java.util.concurrent.ThreadPoolExecutor).activeCount}")
    pool.execute {
      if (epoch.get() != mine) return@execute
      val startedAt = SystemClock.elapsedRealtime()
      Log.i(TAG, "req=$requestId WORKER_START waited_ms=${startedAt - queuedAt} thread=${Thread.currentThread().name}")
      var sentenceIdx = 0
      try {
        SherpaTts.stream(context, voiceId, text, pace.toFloat()) { pcm, rate ->
          if (epoch.get() != mine) return@stream false
          sentenceIdx += 1
          val now = SystemClock.elapsedRealtime()
          Log.i(TAG, "req=$requestId SENTENCE#$sentenceIdx ready_at_ms=${now - queuedAt} since_worker_start_ms=${now - startedAt} bytes=${pcm.size}")
          val encoded = Base64.encodeToString(pcm, Base64.NO_WRAP)
          evalJs("window.__jarvisTtsChunk && window.__jarvisTtsChunk('$requestId','$encoded',$rate)")
          true
        }
        if (epoch.get() == mine) {
          val doneAt = SystemClock.elapsedRealtime()
          Log.i(TAG, "req=$requestId DONE total_ms=${doneAt - queuedAt} sentences=$sentenceIdx")
          evalJs("window.__jarvisTtsDone && window.__jarvisTtsDone('$requestId')")
        }
      } catch (error: Throwable) {
        fail(requestId, error)
      }
    }
  }

  /** Abandon every queued and in-progress synthesis. */
  @JavascriptInterface
  fun cancelAll() {
    epoch.incrementAndGet()
  }

  private fun fail(requestId: String, error: Throwable) {
    Log.e(TAG, "synthesis failed: ${error.message}", error)
    val message = (error.message ?: "synthesis failed").replace("'", " ")
    evalJs("window.__jarvisTtsError && window.__jarvisTtsError('$requestId','$message')")
  }

  /**
   * Load English's model ahead of the first request, so the first reply of
   * the session doesn't pay the load cost. Fire-and-forget; a slow or failed
   * warm-up is invisible except in logcat, and `isReady`/`synthesize` retry the
   * load on demand regardless.
   *
   * Telugu is not warmed here: it is opt-in and rare (Sarvam is its default),
   * so most sessions would pay to load a model they never use. It loads
   * lazily on its own first request instead -- see `SherpaTts.ready`.
   */
  fun warm() {
    pool.execute { SherpaTts.ready(context, "en_US-ryan-high") }
  }
}
