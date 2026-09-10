// Energy voice-activity detection with an adaptive noise floor.
//
// Mirrors the browser VAD in `frontend/src/lib/realtime.ts` on purpose: the two
// should agree about what counts as speech, so an utterance captured by the
// daemon behaves like one captured in the tab. Speech is declared when RMS
// exceeds the running noise floor by a factor, and the floor only adapts while
// the room is quiet — otherwise a long sentence slowly raises the bar until it
// deafens itself.

#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

namespace jarvis {

class Vad {
public:
    struct Config {
        float speech_factor = 2.6f;    // how far above the floor counts as speech
        float absolute_floor = 0.008f; // never trigger on near-silence
        int   silence_ms = 700;        // hang-up delay once speech stops
        int   max_utterance_ms = 15000;
    };

    Vad() = default;
    // Split from the default constructor rather than using a `= {}` default
    // argument: GCC 16 rejects brace-initialising a nested aggregate there.
    explicit Vad(const Config& config) : config_(config) {}

    static float rms(const std::int16_t* samples, std::size_t count) {
        if (count == 0) return 0.0f;
        double sum = 0.0;
        for (std::size_t i = 0; i < count; ++i) {
            const double v = static_cast<double>(samples[i]) / 32768.0;
            sum += v * v;
        }
        return static_cast<float>(std::sqrt(sum / static_cast<double>(count)));
    }

    // Feed one frame; returns true while the frame is considered speech.
    bool push(const std::int16_t* samples, std::size_t count) {
        const float level = rms(samples, count);
        const float threshold =
            std::max(config_.absolute_floor, noise_floor_ * config_.speech_factor);
        const bool speech = level > threshold;

        // Adapt only on quiet frames, and slowly.
        if (!speech) {
            noise_floor_ = noise_floor_ * 0.95f + level * 0.05f;
        }
        last_level_ = level;
        return speech;
    }

    float level() const { return last_level_; }
    const Config& config() const { return config_; }

    void reset() {
        noise_floor_ = 0.01f;
        last_level_ = 0.0f;
    }

private:
    Config config_{};
    float noise_floor_ = 0.01f;
    float last_level_ = 0.0f;
};

}  // namespace jarvis
