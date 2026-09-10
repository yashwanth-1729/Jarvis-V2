// Fixed-capacity ring of 16 kHz mono samples, shared between the capture
// thread and whichever thread services a trigger.
//
// The point of the ring is pre-roll: by the time a hotkey fires (or a wake
// word is detected) the first syllable has already happened. Keeping a few
// seconds of the recent past means the utterance is not clipped at the front.

#pragma once

#include <cstddef>
#include <cstdint>
#include <mutex>
#include <vector>

namespace jarvis {

class RingBuffer {
public:
    explicit RingBuffer(std::size_t capacity)
        : buffer_(capacity, 0), capacity_(capacity) {}

    void write(const std::int16_t* samples, std::size_t count) {
        std::lock_guard<std::mutex> lock(mutex_);
        for (std::size_t i = 0; i < count; ++i) {
            buffer_[head_] = samples[i];
            head_ = (head_ + 1) % capacity_;
            if (filled_ < capacity_) ++filled_;
        }
    }

    // Most recent `count` samples, oldest first. Returns fewer if the ring has
    // not filled yet.
    std::vector<std::int16_t> tail(std::size_t count) const {
        std::lock_guard<std::mutex> lock(mutex_);
        const std::size_t take = count < filled_ ? count : filled_;
        std::vector<std::int16_t> out(take);
        // Walk back `take` samples from the write head, wrapping.
        std::size_t start = (head_ + capacity_ - take) % capacity_;
        for (std::size_t i = 0; i < take; ++i) {
            out[i] = buffer_[(start + i) % capacity_];
        }
        return out;
    }

    void clear() {
        std::lock_guard<std::mutex> lock(mutex_);
        head_ = 0;
        filled_ = 0;
    }

private:
    mutable std::mutex mutex_;
    std::vector<std::int16_t> buffer_;
    std::size_t capacity_;
    std::size_t head_ = 0;
    std::size_t filled_ = 0;
};

}  // namespace jarvis
