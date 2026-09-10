// Hands a captured utterance to the FastAPI backend over loopback HTTP.
//
// WinHTTP rather than libcurl so the daemon has zero third-party dependencies —
// it builds with nothing but the Windows SDK.

#pragma once

#include <string>

namespace jarvis {

struct BackendResult {
    bool ok = false;
    int status = 0;
    std::string body;
    std::string error;
};

class BackendClient {
public:
    BackendClient(std::wstring host, int port) : host_(std::move(host)), port_(port) {}

    // POSTs a WAV body to `path` as audio/wav.
    BackendResult post_wav(const std::wstring& path, const std::string& wav) const;

private:
    std::wstring host_;
    int port_;
};

}  // namespace jarvis
