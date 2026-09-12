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

/**
 * On-device English speech: the same high-tier Piper voice (`en_US-ryan-high`)
 * desktop speaks with, run natively here via sherpa-onnx.
 *
 * Chaquopy's Python backend can't do this itself -- neither onnxruntime nor
 * Piper's phonemizer has an arm64/Android wheel -- so this is plain Kotlin
 * calling sherpa-onnx's prebuilt native library (see build.gradle.kts). The
 * voice ships inside the APK under assets/piper/ (fetched by
 * backend/tools/android/setup_piper.ps1, gitignored) and is copied out to a
 * real filesystem path once, since sherpa needs actual file paths for the
 * model, tokens and espeak-ng-data -- not the asset manager's virtual ones.
 */
object SherpaTts {
  @Volatile private var tts: OfflineTts? = null
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

  /** Copy the bundled voice out of read-only assets to a real path, once. */
  private fun provision(context: Context) {
    val d = dir(context)
    if (File(d, "en_US-ryan-high.onnx").exists()) return
    d.mkdirs()
    copyAsset(context, "piper", d)
    Log.i(TAG, "voice provisioned -> ${d.absolutePath}")
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

  private fun engine(context: Context): OfflineTts {
    tts?.let { return it }
    synchronized(loadLock) {
      tts?.let { return it }
      val d = dir(context).absolutePath
      val config = OfflineTtsConfig(
        model = OfflineTtsModelConfig(
          vits = OfflineTtsVitsModelConfig(
            model = "$d/en_US-ryan-high.onnx",
            tokens = "$d/tokens.txt",
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
      // No AssetManager passed: the model was already copied to a real path
      // above, so this takes sherpa's file-path constructor rather than its
      // (slower, one-shot) load-from-APK-assets one.
      val instance = OfflineTts(config = config)
      tts = instance
      return instance
    }
  }

  /**
   * Provision and load the model, off the caller's thread if needed.
   *
   * Safe to call repeatedly and from multiple threads -- `engine()` is
   * synchronized and caches the loaded model, so every call after the first
   * successful one is free. Returns false (never throws) on any failure, so a
   * missing or corrupt voice just means English keeps using Sarvam.
   */
  fun ready(context: Context): Boolean {
    return try {
      provision(context)
      engine(context)
      true
    } catch (error: Throwable) {
      Log.e(TAG, "load failed: ${error.message}", error)
      false
    }
  }

  /** Mono PCM16 little-endian samples + the model's sample rate, all at once. */
  fun synthesize(context: Context, text: String, pace: Float): Pair<ByteArray, Int> {
    val audio = engine(context).generate(text = text, sid = 0, speed = pace)
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
  fun stream(context: Context, text: String, pace: Float, onSentence: (ByteArray, Int) -> Boolean) {
    val engine = engine(context)
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

  @JavascriptInterface
  fun isReady(): Boolean = SherpaTts.ready(context)

  /** Whole-phrase synthesis, delivered once. Kept for diagnostics. */
  @JavascriptInterface
  fun synthesize(requestId: String, text: String, pace: Double) {
    pool.execute {
      try {
        val (pcm, rate) = SherpaTts.synthesize(context, text, pace.toFloat())
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
  fun synthesizeStream(requestId: String, text: String, pace: Double) {
    val mine = epoch.get()
    // TEMPORARY diagnostic (2026-09-12, remove after the Piper gap
    // investigation): reconstruct the real on-device timeline -- when this
    // phrase was handed to the bridge, how long it waited for a free pool
    // thread, when each sentence's audio was actually ready, and total
    // phrase time. Filter with: adb logcat -s JarvisTts
    val queuedAt = SystemClock.elapsedRealtime()
    Log.i(TAG, "req=$requestId QUEUED chars=${text.length} pool_active=${(pool as java.util.concurrent.ThreadPoolExecutor).activeCount}")
    pool.execute {
      if (epoch.get() != mine) return@execute
      val startedAt = SystemClock.elapsedRealtime()
      Log.i(TAG, "req=$requestId WORKER_START waited_ms=${startedAt - queuedAt} thread=${Thread.currentThread().name}")
      var sentenceIdx = 0
      try {
        SherpaTts.stream(context, text, pace.toFloat()) { pcm, rate ->
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
   * Load the model ahead of the first request, so the first English reply of
   * the session doesn't pay the load cost. Fire-and-forget; a slow or failed
   * warm-up is invisible except in logcat, and `isReady`/`synthesize` retry the
   * load on demand regardless.
   */
  fun warm() {
    pool.execute { SherpaTts.ready(context) }
  }
}
