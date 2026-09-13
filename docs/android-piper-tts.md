# Android: on-device Piper TTS (sherpa-onnx)

**Status (2026-09-13):** English shipped and verified on-device (see
explanations.md's 2026-09-11/12 entries — provisioning, streaming,
gap-diagnosis and the concurrency/chunk-size tuning all happened after this
doc was first written, so its code samples below are historical design notes,
not the current implementation. Read the real files instead: `JarvisTts.kt`,
`nativeTts.ts`, `realtime.ts`, `realtime.py`.). **Telugu's on-device voice
(`te_IN-padmavathi-medium`) was added 2026-09-13, code-complete and
self-consistent (Python backend tests pass, frontend typechecks, Kotlin
reviewed by hand against the AAR's documented API) but not yet built or run on
a device** — this machine has no Android SDK installed, so `./gradlew` could
not compile it. Treat it as unverified until someone builds and runs it once.

## Why native, not Chaquopy

The phone runs the backend under Chaquopy on `arm64-v8a`. Piper's Python stack
(`onnxruntime` + the espeak phonemizer) has no arm64/Android wheel on PyPI, so
`pip install piper-tts` cannot work there (the same wall that forced the
hand-cross-compiled `pydantic_core`). sherpa-onnx ships **prebuilt arm64 native
libraries + a Kotlin API** that run the identical Piper VITS weights on the phone
CPU. So on-device TTS is produced natively in Kotlin and handed to the existing
WebView voice pipeline as PCM16 — everything else (half-duplex mic, caption
timing, ordering) is unchanged.

Decision recorded in explanations.md: **max Piper model on both platforms**, so
Android's English voice is the same high tier as desktop — `en_US-ryan-high`.
Telugu has no equivalent "which tier" decision to make: `te_IN-padmavathi-medium`
is the only Telugu voice this project has evaluated at all (see the Telugu TTS
Arena project's findings), so desktop and Android use the same one.

## One-command setup (run this first)

```powershell
./backend/tools/android/setup_piper.ps1          # English + the shared AAR + espeak-ng-data
./backend/tools/android/setup_piper_telugu.ps1   # Telugu, run after the above
```

The first script fetches the two large binaries neither voice can do without —
neither is in git — and places them:

- `sherpa-onnx-1.13.8.aar` → `frontend/src-tauri/gen/android/app/libs/`
- the `vits-piper-en_US-ryan-high` bundle → `.../app/src/main/assets/piper/`,
  which is `en_US-ryan-high.onnx` + `tokens.txt` + `espeak-ng-data/` (all three
  in one download — the high tier, same weights as desktop).

The second script adds Telugu on top: `te_IN-padmavathi-medium.onnx` (reused
from `backend/models/piper/` if already downloaded there for the desktop
voice, else fetched from the same HuggingFace source) plus a
`te_IN-padmavathi-medium.tokens.txt` it derives locally from the voice's
`phoneme_id_map` — no such tarball exists in sherpa-onnx's own release, so
there was nothing to download for a `tokens.txt` the way English got one.
`espeak-ng-data` is not re-fetched: it is Piper's shared, language-independent
phonemizer data, so English's copy already covers Telugu's `te` phonemes too.

Bundling into `assets/` means each voice ships inside the APK and works
offline from first launch (no runtime download). The AAR and the whole
`assets/piper/` folder are gitignored. Re-running either script is safe; both
skip what is already in place.

On first launch the Kotlin engine copies `assets/piper/` to `filesDir/tts/`
once per voice not yet copied (espeak-ng-data and each model must live on a
real filesystem path, not be read through the asset manager). It no-ops until
a given voice's copy exists, so that voice falls back to Sarvam only on the
very first run before its copy completes — and adding Telugu to an
already-installed app re-copies the tree once more on that device's next
launch to pick up the new voice, alongside English's files it already had.

## Gradle (`frontend/src-tauri/gen/android/app/build.gradle.kts`)

One line, already in place, shared by every voice — a second voice needs no
Gradle change, only more assets:

```kotlin
implementation(files("libs/sherpa-onnx-1.13.8.aar"))
```

The AAR carries the `arm64-v8a` `.so` files; `abiFilters` is already limited to
`arm64-v8a`, which matches. No `pip` changes — this is entirely native/Kotlin.

## Kotlin bridge — `.../builds/yashwanth/jarvis/JarvisTts.kt`

Read the file directly rather than a doc snapshot of it — it has moved on from
a single hardcoded voice to a small registry (`SherpaTts.VOICES: Map<voiceId,
VoiceSpec>`), one lazily-loaded `OfflineTts` per voice id, keyed the same way
`app/core/config.py`'s `jarvis_piper_model` / `jarvis_piper_telugu_model` are.
Mirrors the `JarvisNotifications` bridge for the WebView-to-native direction:
loads a voice's model lazily on a worker thread, converts sherpa's
`FloatArray` samples to PCM16, and delivers base64 back to the WebView by
request id. Adding a third voice means: register it in `VOICES`, add its files
via a `setup_piper_<name>.ps1` script, and register its id in
`nativeTts.ts`'s `NATIVE_VOICE_IDS` — nothing else in the bridge changes.

## Register it (`MainActivity.kt`, in `attachNotificationBridge` after the WebView is found)

```kotlin
webView.addJavascriptInterface(
  JarvisTtsBridge(applicationContext) { js -> webView.post { webView.evaluateJavascript(js, null) } },
  "JarvisTts",
)
ttsBridge.warm()
```

## Frontend wiring (`frontend/src/lib/realtime.ts`, `nativeTts.ts`)

The client already accepts PCM: `SpeechQueue.push(buffer, text, seq, sampleRate)`.
For a language with a ready on-device voice, the client synthesizes locally
and pushes instead of playing the backend's audio for that phrase:

1. At connect (`VoiceSession.start()`), advertise each on-device voice that is
   actually ready as its own WebSocket query flag —
   `isNativeTtsAvailable("en-IN")` → `english_tts=client`,
   `isNativeTtsAvailable("te-IN")` → `telugu_tts=client`. English's flag alone
   means "always use it" (Sarvam is only its fallback); Telugu's flag only
   means "ask me" — the backend additionally checks the user's
   `telugu_tts_engine` opt-in (default `"sarvam"`) before ever sending a
   Telugu `"phrase"`.
2. Server-side (`app/api/realtime.py`'s `synthesize()`), a chunk becomes a
   `_ClientPhrase(text, language)` — no audio rendered, no Sarvam credit spent
   — instead of real audio when that language's client flag is set (and, for
   Telugu, the opt-in is also on). The `"phrase"` WebSocket message carries
   `language` so the client knows which voice/pace to use.
3. Client-side, the `"phrase"` case looks up the pace for `payload.language`
   (`NATIVE_PACE`, mirroring each `Language(...).pace` in
   `app/core/languages.py`) and calls `streamNative(text, pace, onChunk,
   language)`, which resolves `language` to a voice id via
   `NATIVE_VOICE_IDS` and calls `window.JarvisTts.synthesizeStream(requestId,
   voiceId, text, pace)`. On reject, the phrase's caption still reveals; no
   fallback re-request to the backend happens mid-turn (matching how a Sarvam
   synthesis failure is already handled).

## Verification checklist (on a build machine + device)

- [ ] AAR resolves; `npm run android` builds for `arm64-v8a`.
- [ ] First launch copies each provisioned voice's model/tokens/espeak-ng-data
      into `filesDir/tts/`.
- [ ] `window.JarvisTts.isReady("en_US-ryan-high")` returns true after
      provisioning.
- [ ] An English voice turn is spoken by ryan-high, not Sarvam (confirm offline:
      airplane mode after provisioning, English still speaks).
- [ ] With the Telugu toggle left on Sarvam (the default), a Telugu turn still
      uses Sarvam even though the device has the model provisioned.
- [ ] With the Telugu toggle switched to the local voice,
      `window.JarvisTts.isReady("te_IN-padmavathi-medium")` returns true and a
      Telugu turn is spoken by padmavathi, not Sarvam (confirm offline too).
- [ ] Half-duplex, captions and ordering behave as before, for both voices.
- [ ] Cold-synth latency acceptable for each voice; if the first phrase lags,
      warm that voice at startup (`SherpaTts.ready(context, voiceId)` on a
      thread) -- only English is warmed automatically today (see
      `JarvisTtsBridge.warm`), since Telugu is opt-in and rare.
