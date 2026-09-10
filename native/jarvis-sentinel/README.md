# JARVIS Sentinel

An always-on microphone daemon that lets you talk to JARVIS **without a browser
tab open**.

## Why this is C++ and the rest of the backend is not

Nothing in the existing backend was rewritten. Python never touched a
microphone — capture, VAD and resampling all happen in the browser
(`frontend/src/lib/realtime.ts`), and the backend only ever sees a finished WAV.
There was no slow Python audio code to replace.

What was missing is a process that can hold the microphone open *for as long as
the machine is awake*. That is the one place the language choice actually
decides feasibility:

| | Python | C++ (this daemon) |
|---|---|---|
| Resident memory, idle | ~40–60 MB (interpreter + deps) | ~2–5 MB |
| Per-frame cost @ 50 fps | interpreter dispatch + GIL | a memcpy and a resample |
| Latency jitter | GC pauses land in the audio path | none |

Everything else in v2 — STT, TTS, the agent loop — is network-bound. C++ would
buy nothing there, so it is not used there.

## What it does

1. Opens the default microphone via **WASAPI in shared mode**, so the browser
   can still use the mic at the same time.
2. Keeps a **6-second rolling ring buffer** at 16 kHz mono. The trigger fires
   *after* you have started talking, so ~1.2 s of pre-roll is prepended and the
   first syllable is never clipped.
3. On **Ctrl+Alt+J** (global — works with any window focused), records until you
   stop speaking, using the same adaptive-noise-floor VAD as the browser.
4. Encodes a WAV and POSTs it to `/api/sentinel/utterance`, which transcribes it
   and runs one full agent turn.

## Dependencies

**None.** WASAPI, WinHTTP and `RegisterHotKey` all ship with Windows. No vcpkg,
no ONNX Runtime, no Porcupine key.

## Build

You need a C++ toolchain and CMake — neither is currently installed on this
machine. Either works:

```powershell
winget install --id Kitware.CMake -e --accept-package-agreements ; winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

Then, from a **new** terminal (so the installers are on `PATH`):

```powershell
cmake -S native/jarvis-sentinel -B native/jarvis-sentinel/build ; cmake --build native/jarvis-sentinel/build --config Release
```

The binary lands at `native/jarvis-sentinel/build/bin/Release/jarvis-sentinel.exe`.

## Run

Start the backend first, then:

```powershell
.\native\jarvis-sentinel\build\bin\Release\jarvis-sentinel.exe --port 8000
```

Press **Ctrl+Alt+J** from anywhere and talk. `Ctrl+C` quits.

## Where the wake word goes

`main.cpp` uses a hotkey as its trigger because a hotkey is exact, costs
nothing, and never false-fires — so the daemon is useful on day one. The audio
path beneath it (ring buffer, VAD, 16 kHz mono frames) is exactly what a
wake-word model consumes.

To add "Hey JARVIS", feed the same frames the VAD sees into a detector and call
`capture_utterance` on a hit. Two options, both dropping into that one seam:

- **Porcupine** — most accurate, free for personal use, needs an access key.
- **openWakeWord + ONNX Runtime** — fully offline and keyless, heavier to build.

## Porting off Windows

Only two files are platform-specific: `audio_capture.cpp` (swap WASAPI for
PortAudio or PipeWire) and `backend_client.cpp` (swap WinHTTP for libcurl). The
ring buffer, VAD and WAV encoder are plain C++17.
