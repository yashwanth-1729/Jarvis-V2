#include "backend_client.h"

#include <windows.h>
#include <winhttp.h>

#include <cstdio>
#include <vector>

namespace jarvis {

BackendResult BackendClient::post_wav(const std::wstring& path,
                                      const std::string& wav) const {
    BackendResult result;

    HINTERNET session = WinHttpOpen(L"jarvis-sentinel/1.0",
                                    WINHTTP_ACCESS_TYPE_NO_PROXY,
                                    WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (session == nullptr) {
        result.error = "WinHttpOpen failed";
        return result;
    }

    // Generous timeouts: the backend transcribes and runs a model turn before
    // it answers, and a premature abort would look like a daemon bug.
    WinHttpSetTimeouts(session, 5000, 5000, 30000, 60000);

    HINTERNET connection =
        WinHttpConnect(session, host_.c_str(), static_cast<INTERNET_PORT>(port_), 0);
    if (connection == nullptr) {
        result.error = "WinHttpConnect failed";
        WinHttpCloseHandle(session);
        return result;
    }

    HINTERNET request = WinHttpOpenRequest(connection, L"POST", path.c_str(), nullptr,
                                           WINHTTP_NO_REFERER,
                                           WINHTTP_DEFAULT_ACCEPT_TYPES, 0);
    if (request == nullptr) {
        result.error = "WinHttpOpenRequest failed";
        WinHttpCloseHandle(connection);
        WinHttpCloseHandle(session);
        return result;
    }

    const wchar_t* headers = L"Content-Type: audio/wav\r\n";
    BOOL sent = WinHttpSendRequest(
        request, headers, static_cast<DWORD>(-1),
        const_cast<char*>(wav.data()), static_cast<DWORD>(wav.size()),
        static_cast<DWORD>(wav.size()), 0);

    if (sent && WinHttpReceiveResponse(request, nullptr)) {
        DWORD status = 0;
        DWORD size = sizeof(status);
        WinHttpQueryHeaders(request,
                            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                            WINHTTP_HEADER_NAME_BY_INDEX, &status, &size,
                            WINHTTP_NO_HEADER_INDEX);
        result.status = static_cast<int>(status);
        result.ok = status >= 200 && status < 300;

        DWORD available = 0;
        while (WinHttpQueryDataAvailable(request, &available) && available > 0) {
            std::vector<char> chunk(available);
            DWORD read = 0;
            if (!WinHttpReadData(request, chunk.data(), available, &read)) break;
            result.body.append(chunk.data(), read);
        }
    } else {
        char message[96];
        std::snprintf(message, sizeof(message), "request failed (err=%lu)",
                      static_cast<unsigned long>(GetLastError()));
        result.error = message;
    }

    WinHttpCloseHandle(request);
    WinHttpCloseHandle(connection);
    WinHttpCloseHandle(session);
    return result;
}

}  // namespace jarvis
