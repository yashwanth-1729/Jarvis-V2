# Android: on-device Piper English TTS (sherpa-onnx)

**Status:** frontend bridge client shipped (`frontend/src/lib/nativeTts.ts`, typechecks).
The native half below is written and ready but **must be built on a machine with
the Android NDK/SDK + a device** — it was not compiled or run in the session that
wrote it. Do not add the Kotlin/Gradle changes until the AAR and model are in
place, or the Android build fails to resolve `com.k2fsa.sherpa.onnx`.

## Why native, not Chaquopy

The phone runs the backend under Chaquopy on `arm64-v8a`. Piper's Python stack
(`onnxruntime` + the espeak phonemizer) has no arm64/Android wheel on PyPI, so
`pip install piper-tts` cannot work there (the same wall that forced the
hand-cross-compiled `pydantic_core`). sherpa-onnx ships **prebuilt arm64 native
libraries + a Kotlin API** that run the identical Piper VITS weights on the phone
CPU. So English TTS on mobile is produced natively in Kotlin and handed to the
existing WebView voice pipeline as PCM16 — everything else (half-duplex mic,
caption timing, ordering) is unchanged.

Decision recorded in explanations.md: **max Piper model on both platforms**, so
Android uses the same high tier as desktop — `en_US-ryan-high`.

## Files the engine needs (place under `filesDir/tts/`)

sherpa-onnx needs three things:

1. `en_US-ryan-high.onnx` — the high-tier voice (same weights as desktop).
2. `tokens.txt` — phoneme→id map for that model.
3. `espeak-ng-data/` — shared phonemizer data (same for every Piper voice).

Get a sherpa-ready bundle from the sherpa-onnx `tts-models` release:
`https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models` →
`vits-piper-en_US-ryan-high.tar.bz2` (it contains the `.onnx` + `tokens.txt`).
If only a `-medium` ryan bundle is published there, generate `tokens.txt` for the
high `.onnx` with sherpa-onnx's Piper export script (it reads the rhasspy
`.onnx.json` we already have at `backend/models/piper/en_US-ryan-high.onnx.json`).
`espeak-ng-data.tar.bz2` is a separate download in the same release.

**Provisioning:** these total ~130 MB. Download-on-first-run into `filesDir/tts/`
(keeps the APK small; needs one online launch) rather than bundling in assets.
The Kotlin engine below no-ops until the files exist, so English falls back to
Sarvam until the first successful fetch.

## Gradle (`frontend/src-tauri/gen/android/app/build.gradle.kts`)

Drop the prebuilt AAR into `app/libs/` (download `sherpa-onnx-<ver>.aar` from the
sherpa-onnx releases) and add:

```kotlin
dependencies {
    // ...existing...
    implementation(files("libs/sherpa-onnx.aar"))
}
```

The AAR carries the `arm64-v8a` `.so` files; `abiFilters` is already limited to
`arm64-v8a`, which matches. No `pip` changes — this is entirely native/Kotlin.

## Kotlin bridge — `.../builds/yashwanth/jarvis/JarvisTts.kt`

Mirrors the `JarvisNotifications` bridge. Loads the model lazily on a worker
thread, converts sherpa's `FloatArray` samples to PCM16, and delivers base64 back
to the WebView by request id.

```kotlin
package builds.yashwanth.jarvis

import android.content.Context
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsVitsModelConfig
import java.io.File
import java.util.concurrent.Executors

private const val TAG = "JarvisTts"

/** Loads the Piper voice once and synthesizes PCM16 off the UI thread. */
object SherpaTts {
  @Volatile private var tts: OfflineTts? = null

  private fun dir(context: Context) = File(context.filesDir, "tts")

  /** Ready only when all three inputs are present and the model has loaded. */
  fun ready(context: Context): Boolean {
    val d = dir(context)
    val ok = File(d, "en_US-ryan-high.onnx").exists() &&
      File(d, "tokens.txt").exists() &&
      File(d, "espeak-ng-data").isDirectory
    if (!ok) return false
    return try { engine(context); true } catch (e: Throwable) {
      Log.e(TAG, "load failed: ${e.message}"); false
    }
  }

  @Synchronized private fun engine(context: Context): OfflineTts {
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
    return OfflineTts(config = config).also { tts = it }
  }

  /** PCM16 little-endian mono + sample rate. `pace` is rate (bigger = faster). */
  fun synthesize(context: Context, text: String, pace: Float): Pair<ByteArray, Int> {
    val audio = engine(context).generate(text = text, sid = 0, speed = pace)
    val samples = audio.samples // FloatArray in [-1, 1]
    val pcm = ByteArray(samples.size * 2)
    var j = 0
    for (s in samples) {
      val v = (s.coerceIn(-1f, 1f) * 32767f).toInt()
      pcm[j++] = (v and 0xFF).toByte()
      pcm[j++] = ((v shr 8) and 0xFF).toByte()
    }
    return pcm to audio.sampleRate
  }
}

/** The `window.JarvisTts` bridge. `evalJs` runs a string in the WebView. */
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
        val b64 = Base64.encodeToString(pcm, Base64.NO_WRAP)
        evalJs("window.__jarvisTtsDeliver && window.__jarvisTtsDeliver('$requestId','$b64',$rate)")
      } catch (e: Throwable) {
        val msg = (e.message ?: "synthesis failed").replace("'", " ")
        evalJs("window.__jarvisTtsError && window.__jarvisTtsError('$requestId','$msg')")
      }
    }
  }
}
```

## Register it (`MainActivity.kt`, in `attachNotificationBridge` after the WebView is found)

```kotlin
webView.addJavascriptInterface(
  JarvisTtsBridge(applicationContext) { js -> webView.post { webView.evaluateJavascript(js, null) } },
  "JarvisTts",
)
```

## Frontend wiring (`frontend/src/lib/realtime.ts`)

The client already accepts PCM: `SpeechQueue.push(buffer, text, seq, sampleRate)`.
For **English on Android**, synthesize locally and push, instead of playing the
backend's audio for that phrase:

1. When `isNativeTtsAvailable()` and the turn's language is English, tell the
   backend to stream **text only** for TTS (add a per-turn flag on the voice
   WebSocket, e.g. `english_tts: "client"`), so it does not also render Sarvam
   audio. Non-English and desktop keep the existing backend audio path.
2. As each English phrase arrives as text, call
   `synthesizeNative(phrase, pace)` and `speechQueue.push(pcm, phrase, seq, sampleRate)`.
   On reject, fall back to requesting backend audio for that phrase.

Backend change: in `app/api/realtime.py`, when the client advertises
`english_tts=client`, skip server TTS for English turns and emit the phrase text
with its sequence so the client can synthesize and keep ordering. Everything
non-English is unchanged.

## Verification checklist (on a build machine + device)

- [ ] AAR resolves; `npm run android` builds for `arm64-v8a`.
- [ ] First launch downloads model/tokens/espeak-ng-data into `filesDir/tts/`.
- [ ] `window.JarvisTts.isReady()` returns true after provisioning.
- [ ] An English voice turn is spoken by ryan-high, not Sarvam (confirm offline:
      airplane mode after provisioning, English still speaks).
- [ ] A Telugu turn still uses Sarvam.
- [ ] Half-duplex, captions and ordering behave as before.
- [ ] Cold-synth latency acceptable; if the first phrase lags, warm the engine at
      startup (call `SherpaTts.ready` on a thread after provisioning).
