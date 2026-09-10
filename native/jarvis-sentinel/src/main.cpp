// JARVIS Sentinel — an always-on listener that lives outside the browser.
//
// Today JARVIS can only hear you while a tab is open, focused, and holding a
// microphone permission. This daemon removes that constraint: it holds the mic
// open at near-idle cost, keeps a few seconds of rolling pre-roll, and on a
// trigger it captures the utterance and hands the WAV to the FastAPI backend.
//
// The trigger is deliberately pluggable. A global hotkey ships first because it
// is exact, costs nothing, and never false-fires; the audio path underneath it
// is precisely what a wake-word model will consume, so swapping the trigger
// later touches one function and nothing else.

#include <windows.h>

#include <atomic>
#include <chrono>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <thread>
#include <vector>

#include "audio_capture.h"
#include "backend_client.h"
#include "ring_buffer.h"
#include "vad.h"
#include "wav.h"

namespace {

constexpr int kHotkeyId = 1;
constexpr std::size_t kPreRollMs = 1200;
constexpr std::size_t kFrameSamples = 320;  // 20ms at 16 kHz

std::atomic<bool> g_shutdown{false};

BOOL WINAPI console_handler(DWORD signal) {
    if (signal == CTRL_C_EVENT || signal == CTRL_CLOSE_EVENT) {
        g_shutdown.store(true);
        PostQuitMessage(0);
        return TRUE;
    }
    return FALSE;
}

void log(const char* format, ...) {
    // Timestamped so the daemon's log lines interleave readably with uvicorn's.
    SYSTEMTIME now;
    GetLocalTime(&now);
    std::printf("%02d:%02d:%02d | sentinel | ", now.wHour, now.wMinute, now.wSecond);

    va_list args;
    va_start(args, format);
    std::vprintf(format, args);
    va_end(args);
    std::printf("\n");
    std::fflush(stdout);
}

// Capture from the moment the trigger fires until the speaker stops, then
// prepend the pre-roll so the first syllable is not clipped.
std::vector<std::int16_t> capture_utterance(jarvis::RingBuffer& ring, jarvis::Vad& vad) {
    using clock = std::chrono::steady_clock;

    const std::size_t pre_roll_samples =
        (jarvis::kTargetSampleRate * kPreRollMs) / 1000;
    std::vector<std::int16_t> utterance = ring.tail(pre_roll_samples);

    vad.reset();
    const auto started = clock::now();
    auto last_speech = started;
    bool heard_anything = false;
    std::size_t consumed = 0;

    while (!g_shutdown.load()) {
        // Sleep one frame, then take whatever the capture thread produced.
        std::this_thread::sleep_for(std::chrono::milliseconds(20));

        std::vector<std::int16_t> frame = ring.tail(kFrameSamples);
        if (frame.size() < kFrameSamples) continue;

        const bool speech = vad.push(frame.data(), frame.size());
        utterance.insert(utterance.end(), frame.begin(), frame.end());
        consumed += frame.size();

        const auto now = clock::now();
        if (speech) {
            heard_anything = true;
            last_speech = now;
        }

        const auto since_speech =
            std::chrono::duration_cast<std::chrono::milliseconds>(now - last_speech).count();
        const auto total =
            std::chrono::duration_cast<std::chrono::milliseconds>(now - started).count();

        if (heard_anything && since_speech > vad.config().silence_ms) break;
        if (total > vad.config().max_utterance_ms) break;
        // Nothing at all after a couple of seconds: the trigger was a misfire.
        if (!heard_anything && total > 2500) return {};
    }

    (void)consumed;
    return utterance;
}

}  // namespace

int main(int argc, char** argv) {
    std::wstring host = L"127.0.0.1";
    int port = 8000;

    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--port" && i + 1 < argc) {
            port = std::atoi(argv[++i]);
        } else if (arg == "--host" && i + 1 < argc) {
            const std::string value = argv[++i];
            host.assign(value.begin(), value.end());
        } else if (arg == "--help") {
            std::printf(
                "jarvis-sentinel [--host 127.0.0.1] [--port 8000]\n\n"
                "Always-on microphone daemon. Press Ctrl+Alt+J to talk to JARVIS\n"
                "from anywhere, with no browser tab focused.\n");
            return 0;
        }
    }

    SetConsoleCtrlHandler(console_handler, TRUE);

    // ~6s of rolling history. Cheap: 16 kHz mono PCM16 is 32 KB/s.
    jarvis::RingBuffer ring(jarvis::kTargetSampleRate * 6);
    jarvis::AudioCapture capture(ring);
    jarvis::Vad vad;
    jarvis::BackendClient backend(host, port);

    if (!capture.start()) {
        log("could not open the microphone: %s",
            capture.error().empty() ? "device did not start" : capture.error().c_str());
        log("check Settings > Privacy > Microphone, and that a capture device is present");
        return 1;
    }
    log("microphone open (16 kHz mono, shared mode)");

    // MOD_NOREPEAT stops a held chord from firing a burst of turns.
    if (!RegisterHotKey(nullptr, kHotkeyId, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, 'J')) {
        log("could not register Ctrl+Alt+J (error %lu) — is another app using it?",
            static_cast<unsigned long>(GetLastError()));
        capture.stop();
        return 1;
    }

    log("listening. Ctrl+Alt+J to talk, Ctrl+C to quit.");
    log("backend -> http://127.0.0.1:%d/api/sentinel/utterance", port);

    MSG message;
    while (!g_shutdown.load() && GetMessageW(&message, nullptr, 0, 0) != 0) {
        if (message.message != WM_HOTKEY || message.wParam != kHotkeyId) continue;

        // The capture thread has not stopped; it keeps filling the ring while
        // this runs, which is what makes the pre-roll possible.
        if (!capture.running()) {
            log("audio capture died: %s", capture.error().c_str());
            break;
        }

        log("triggered — listening for your voice");
        std::vector<std::int16_t> utterance = capture_utterance(ring, vad);

        if (utterance.empty()) {
            log("nothing said; ignoring");
            continue;
        }

        const double seconds =
            static_cast<double>(utterance.size()) / jarvis::kTargetSampleRate;
        const std::string wav = jarvis::encode_wav(utterance, jarvis::kTargetSampleRate);
        log("captured %.1fs (%zu KB), sending", seconds, wav.size() / 1024);

        const jarvis::BackendResult result =
            backend.post_wav(L"/api/sentinel/utterance", wav);

        if (result.ok) {
            log("backend accepted it: %s", result.body.substr(0, 200).c_str());
        } else if (!result.error.empty()) {
            log("could not reach the backend (%s) — is uvicorn running?",
                result.error.c_str());
        } else {
            log("backend refused it (HTTP %d): %s", result.status,
                result.body.substr(0, 200).c_str());
        }
    }

    log("shutting down");
    UnregisterHotKey(nullptr, kHotkeyId);
    capture.stop();
    return 0;
}
