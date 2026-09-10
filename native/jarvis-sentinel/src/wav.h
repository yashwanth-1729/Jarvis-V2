// Minimal RIFF/PCM16 writer.
//
// The backend's speech-to-text path rejects WebM and expects a plain WAV — the
// browser client already learned this the hard way — so the daemon hands over
// exactly the same format: 16 kHz, mono, signed 16-bit little-endian.

#pragma once

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace jarvis {

inline void append_u32(std::string& out, std::uint32_t value) {
    char bytes[4];
    bytes[0] = static_cast<char>(value & 0xFF);
    bytes[1] = static_cast<char>((value >> 8) & 0xFF);
    bytes[2] = static_cast<char>((value >> 16) & 0xFF);
    bytes[3] = static_cast<char>((value >> 24) & 0xFF);
    out.append(bytes, 4);
}

inline void append_u16(std::string& out, std::uint16_t value) {
    char bytes[2];
    bytes[0] = static_cast<char>(value & 0xFF);
    bytes[1] = static_cast<char>((value >> 8) & 0xFF);
    out.append(bytes, 2);
}

inline std::string encode_wav(const std::vector<std::int16_t>& samples,
                              std::uint32_t sample_rate) {
    const std::uint32_t data_bytes =
        static_cast<std::uint32_t>(samples.size() * sizeof(std::int16_t));

    std::string wav;
    wav.reserve(44 + data_bytes);

    wav.append("RIFF", 4);
    append_u32(wav, 36 + data_bytes);  // chunk size = header remainder + payload
    wav.append("WAVE", 4);

    wav.append("fmt ", 4);
    append_u32(wav, 16);                      // PCM fmt chunk length
    append_u16(wav, 1);                       // format = PCM
    append_u16(wav, 1);                       // channels = mono
    append_u32(wav, sample_rate);
    append_u32(wav, sample_rate * 2);         // byte rate (mono, 2 bytes/sample)
    append_u16(wav, 2);                       // block align
    append_u16(wav, 16);                      // bits per sample

    wav.append("data", 4);
    append_u32(wav, data_bytes);
    if (!samples.empty()) {
        wav.append(reinterpret_cast<const char*>(samples.data()), data_bytes);
    }
    return wav;
}

}  // namespace jarvis
