#include "audio_capture.h"

#include <windows.h>

#include <audioclient.h>
#include <mmdeviceapi.h>
// MinGW does not pull these in via audioclient.h the way the MSVC SDK does,
// and they define WAVE_FORMAT_IEEE_FLOAT / KSDATAFORMAT_SUBTYPE_IEEE_FLOAT.
#include <ksmedia.h>
#include <mmreg.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <vector>

namespace jarvis {
namespace {

constexpr REFERENCE_TIME kBufferDuration = 2 * 10000000;  // 2s, in 100ns units

// KSDATAFORMAT_SUBTYPE_IEEE_FLOAT, spelled out rather than linked.
// MinGW declares the symbol in <ksmedia.h> but ships no library exporting it,
// so referencing it fails at link time. The value is fixed by the Windows ABI.
const GUID kSubtypeIeeeFloat = {
    0x00000003, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71}};

// Release a COM pointer and null it, so cleanup paths stay readable.
template <typename T>
void safe_release(T*& ptr) {
    if (ptr != nullptr) {
        ptr->Release();
        ptr = nullptr;
    }
}

// Mix down to mono and resample to 16 kHz.
//
// The engine hands us whatever the device is running at — almost always 44.1 or
// 48 kHz float32 stereo. Linear interpolation is more than adequate here: the
// consumer is a speech recognizer with a 16 kHz band limit, not a listener.
void to_mono_16k(const float* input,
                 std::size_t frames,
                 std::uint32_t channels,
                 std::uint32_t source_rate,
                 std::vector<std::int16_t>& out) {
    if (frames == 0 || channels == 0) return;

    const double ratio = static_cast<double>(source_rate) / kTargetSampleRate;
    const std::size_t out_frames =
        static_cast<std::size_t>(static_cast<double>(frames) / ratio);
    out.clear();
    out.reserve(out_frames);

    for (std::size_t i = 0; i < out_frames; ++i) {
        const double position = static_cast<double>(i) * ratio;
        const std::size_t index = static_cast<std::size_t>(position);
        if (index + 1 >= frames) break;
        const double frac = position - static_cast<double>(index);

        // Average the channels at both taps, then interpolate between them.
        double a = 0.0;
        double b = 0.0;
        for (std::uint32_t c = 0; c < channels; ++c) {
            a += input[index * channels + c];
            b += input[(index + 1) * channels + c];
        }
        a /= channels;
        b /= channels;

        const double sample = a + (b - a) * frac;
        const double clamped = std::max(-1.0, std::min(1.0, sample));
        out.push_back(static_cast<std::int16_t>(clamped * 32767.0));
    }
}

}  // namespace

AudioCapture::~AudioCapture() { stop(); }

bool AudioCapture::start() {
    if (started_.load()) return running_.load();
    started_.store(true);
    running_.store(true);
    error_.clear();
    thread_ = std::thread(&AudioCapture::run, this);

    // Device setup is a handful of synchronous COM calls; if it is going to
    // fail it fails immediately. Poll briefly so `start()` can report it.
    for (int i = 0; i < 40 && error_.empty() && running_.load(); ++i) {
        std::this_thread::sleep_for(std::chrono::milliseconds(25));
        if (opened_.load()) return true;
    }
    return opened_.load();
}

void AudioCapture::stop() {
    running_.store(false);
    if (thread_.joinable()) thread_.join();
    started_.store(false);
    opened_.store(false);
}

void AudioCapture::run() {
    // The capture thread owns its own COM apartment.
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool com_initialized = SUCCEEDED(hr);

    IMMDeviceEnumerator* enumerator = nullptr;
    IMMDevice* device = nullptr;
    IAudioClient* client = nullptr;
    IAudioCaptureClient* capture = nullptr;
    WAVEFORMATEX* mix_format = nullptr;
    HANDLE ready_event = nullptr;

    auto fail = [&](const char* what, HRESULT code) {
        char message[192];
        std::snprintf(message, sizeof(message), "%s failed (hr=0x%08lX)", what,
                      static_cast<unsigned long>(code));
        error_ = message;
        running_.store(false);
    };

    hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                          __uuidof(IMMDeviceEnumerator),
                          reinterpret_cast<void**>(&enumerator));
    if (FAILED(hr)) { fail("CoCreateInstance(MMDeviceEnumerator)", hr); goto cleanup; }

    // eCapture + eConsole = "the microphone Windows would use for a call".
    hr = enumerator->GetDefaultAudioEndpoint(eCapture, eConsole, &device);
    if (FAILED(hr)) { fail("GetDefaultAudioEndpoint", hr); goto cleanup; }

    hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                          reinterpret_cast<void**>(&client));
    if (FAILED(hr)) { fail("IMMDevice::Activate", hr); goto cleanup; }

    hr = client->GetMixFormat(&mix_format);
    if (FAILED(hr)) { fail("GetMixFormat", hr); goto cleanup; }

    // Shared mode keeps the mic usable by other apps (including the browser) at
    // the same time — an exclusive grab would break the existing voice mode.
    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                            AUDCLNT_STREAMFLAGS_EVENTCALLBACK, kBufferDuration, 0,
                            mix_format, nullptr);
    if (FAILED(hr)) { fail("IAudioClient::Initialize", hr); goto cleanup; }

    ready_event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (ready_event == nullptr) { fail("CreateEvent", HRESULT_FROM_WIN32(GetLastError())); goto cleanup; }

    hr = client->SetEventHandle(ready_event);
    if (FAILED(hr)) { fail("SetEventHandle", hr); goto cleanup; }

    hr = client->GetService(__uuidof(IAudioCaptureClient),
                            reinterpret_cast<void**>(&capture));
    if (FAILED(hr)) { fail("GetService(IAudioCaptureClient)", hr); goto cleanup; }

    hr = client->Start();
    if (FAILED(hr)) { fail("IAudioClient::Start", hr); goto cleanup; }

    // The device is live from here; `start()` is waiting on this.
    opened_.store(true);

    {
        const std::uint32_t channels = mix_format->nChannels;
        const std::uint32_t rate = mix_format->nSamplesPerSec;
        // Shared-mode capture is float32 on every modern device, but a device
        // reporting 16-bit PCM must still work, so both paths are handled.
        const bool is_float =
            mix_format->wFormatTag == WAVE_FORMAT_IEEE_FLOAT ||
            (mix_format->wFormatTag == WAVE_FORMAT_EXTENSIBLE &&
             IsEqualGUID(reinterpret_cast<WAVEFORMATEXTENSIBLE*>(mix_format)->SubFormat,
                         kSubtypeIeeeFloat));

        std::vector<float> scratch;
        std::vector<std::int16_t> converted;

        while (running_.load()) {
            // 200ms is a generous ceiling; a healthy engine signals every ~10ms.
            if (WaitForSingleObject(ready_event, 200) != WAIT_OBJECT_0) continue;

            UINT32 packet = 0;
            while (SUCCEEDED(capture->GetNextPacketSize(&packet)) && packet > 0) {
                BYTE* data = nullptr;
                UINT32 frames = 0;
                DWORD flags = 0;

                if (FAILED(capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) {
                    break;
                }

                if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0) {
                    // The engine says this packet is silence; feed zeros so the
                    // ring's timeline stays continuous.
                    scratch.assign(static_cast<std::size_t>(frames) * channels, 0.0f);
                } else if (is_float) {
                    const float* samples = reinterpret_cast<const float*>(data);
                    scratch.assign(samples,
                                   samples + static_cast<std::size_t>(frames) * channels);
                } else {
                    // 16-bit PCM device: normalise into the same float path.
                    const std::int16_t* samples = reinterpret_cast<const std::int16_t*>(data);
                    const std::size_t count = static_cast<std::size_t>(frames) * channels;
                    scratch.resize(count);
                    for (std::size_t i = 0; i < count; ++i) {
                        scratch[i] = static_cast<float>(samples[i]) / 32768.0f;
                    }
                }

                to_mono_16k(scratch.data(), frames, channels, rate, converted);
                if (!converted.empty()) {
                    ring_.write(converted.data(), converted.size());
                }

                capture->ReleaseBuffer(frames);
            }
        }
    }

    client->Stop();

cleanup:
    if (ready_event != nullptr) CloseHandle(ready_event);
    if (mix_format != nullptr) CoTaskMemFree(mix_format);
    safe_release(capture);
    safe_release(client);
    safe_release(device);
    safe_release(enumerator);
    if (com_initialized) CoUninitialize();
    running_.store(false);
}

}  // namespace jarvis
