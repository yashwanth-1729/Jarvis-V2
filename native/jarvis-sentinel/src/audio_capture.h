// Always-on microphone capture via WASAPI.
//
// This is the whole reason the daemon is C++ rather than Python: it runs for
// the entire time the machine is awake. The loop below is event-driven (the
// audio engine signals when a packet is ready, we never poll), converts to
// 16 kHz mono PCM16, and pushes into a ring. No allocation happens per packet
// after warm-up, so the steady-state cost is a memcpy and a resample.

#pragma once

#include <atomic>
#include <string>
#include <thread>

#include "ring_buffer.h"

namespace jarvis {

constexpr std::uint32_t kTargetSampleRate = 16000;

class AudioCapture {
public:
    explicit AudioCapture(RingBuffer& ring) : ring_(ring) {}
    ~AudioCapture();

    AudioCapture(const AudioCapture&) = delete;
    AudioCapture& operator=(const AudioCapture&) = delete;

    // Spawns the capture thread and waits for it to reach a running state.
    // Returns false with `error()` set if the device could not be opened —
    // otherwise a failure here would leave the daemon looking healthy while
    // deaf, and only surface on the first trigger.
    bool start();
    void stop();

    bool running() const { return running_.load(); }
    const std::string& error() const { return error_; }

private:
    void run();

    RingBuffer& ring_;
    std::thread thread_;
    std::atomic<bool> running_{false};
    //: Set once the device is actually streaming, so `start()` can distinguish
    //: "thread launched" from "microphone open".
    std::atomic<bool> opened_{false};
    std::atomic<bool> started_{false};
    std::string error_;
};

}  // namespace jarvis
