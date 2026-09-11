package builds.yashwanth.jarvis

import android.content.Context
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import com.k2fsa.sherpa.onnx.GeneratedAudio
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsVitsModelConfig
import java.io.File
import java.util.concurrent.Executors

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
          numThreads = 2,
          debug = false,
        ),
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

  /** Mono PCM16 little-endian samples + the model's sample rate. */
  fun synthesize(context: Context, text: String, pace: Float): Pair<ByteArray, Int> {
    val audio: GeneratedAudio = engine(context).generate(text = text, sid = 0, speed = pace)
    val samples = audio.samples // Float32 in [-1, 1]
    val pcm = ByteArray(samples.size * 2)
    var i = 0
    for (sample in samples) {
      val clamped = sample.coerceIn(-1f, 1f)
      val value = (clamped * 32767f).toInt()
      pcm[i++] = (value and 0xFF).toByte()
      pcm[i++] = ((value shr 8) and 0xFF).toByte()
    }
    return pcm to audio.sampleRate
  }
}

/**
 * The `window.JarvisTts` bridge the WebView calls into (see
 * `frontend/src/lib/nativeTts.ts`).
 *
 * `synthesize` runs off the UI thread -- generation takes real time (roughly a
 * phrase's spoken length divided by two on a mid-range phone CPU) -- and
 * delivers by request id through `evalJs`, matching the pattern
 * `JarvisNotifications` and `MainActivity.attachNotificationBridge` already use
 * for the WebView-to-native direction.
 */
class JarvisTtsBridge(
  private val context: Context,
  private val evalJs: (String) -> Unit,
) {
  private val pool = Executors.newSingleThreadExecutor()

  @JavascriptInterface
  fun isReady(): Boolean = SherpaTts.ready(context)

  @JavascriptInterface
  fun synthesize(requestId: String, text: String, pace: Double) {
    pool.execute {
      try {
        val (pcm, rate) = SherpaTts.synthesize(context, text, pace.toFloat())
        val encoded = Base64.encodeToString(pcm, Base64.NO_WRAP)
        evalJs("window.__jarvisTtsDeliver && window.__jarvisTtsDeliver('$requestId','$encoded',$rate)")
      } catch (error: Throwable) {
        Log.e(TAG, "synthesis failed: ${error.message}", error)
        val message = (error.message ?: "synthesis failed").replace("'", " ")
        evalJs("window.__jarvisTtsError && window.__jarvisTtsError('$requestId','$message')")
      }
    }
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
