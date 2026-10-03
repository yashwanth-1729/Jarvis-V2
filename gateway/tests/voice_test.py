"""Speech endpoints: plan gates (voice, Telugu), metering, pass-through.

    .venv/Scripts/python.exe tests/voice_test.py
"""

from __future__ import annotations

import base64

from _support import Harness, auth, check, run, stream_response, wav_bytes

import httpx

from app.db import usage

TELUGU = "నమస్కారం, ఈ రోజు మీ షెడ్యూల్ ఇది"
ENGLISH_WITH_A_TELUGU_WORD = "Say నమస్కారం to your grandmother when you visit her this weekend"
AUDIO = [b"ID3\x04fake-mp3-frame-1", b"fake-mp3-frame-2", b"fake-mp3-frame-3"]


def stt_body(language: str | None = "en", seconds: float = 2.0,
             model: str = "x-ai/grok-stt-1.0") -> dict:
    body = {"model": model, "input_audio": {
        "data": base64.b64encode(wav_bytes(seconds)).decode("ascii"), "format": "wav"}}
    if language:
        body["language"] = language
    return body


def tts_body(text: str = "x" * 100, language: str | None = "en",
             model: str = "hexgrad/kokoro-82m", voice: str = "af_sky") -> dict:
    body = {"model": model, "input": text, "voice": voice, "response_format": "mp3", "speed": 1.15}
    if language:
        body["language"] = language
    return body


def answer(request: httpx.Request) -> httpx.Response:
    if request.url.path.endswith("/audio/transcriptions"):
        return httpx.Response(200, json={"text": "hello", "language": "en"})
    response = stream_response(AUDIO)
    response.headers["content-type"] = "audio/mpeg"
    return response


async def stt(h: Harness, body: dict, headers: dict | None = None) -> httpx.Response:
    return await h.client.post("/api/v1/audio/transcriptions",
                               headers={**auth(), **(headers or {})}, json=body)


async def tts(h: Harness, body: dict, headers: dict | None = None) -> httpx.Response:
    return await h.client.post("/api/v1/audio/speech",
                               headers={**auth(), **(headers or {})}, json=body)


async def test_voice_blocked_on_spawn() -> None:
    async with Harness() as h:
        h.upstream.handler = answer
        r = await stt(h, stt_body())
        error = r.json().get("error", {})
        check("STT on spawn -> 403 feature_locked",
              r.status_code == 403 and error.get("code") == "feature_locked", r.text)
        check("403 names the feature and the plan that unlocks it",
              error.get("feature") == "voice_en" and error.get("required_plan") == "side_quest", error)
        r = await tts(h, tts_body())
        check("TTS on spawn -> 403", r.status_code == 403, r.text)
        check("nothing forwarded, nothing charged",
              h.upstream.requests == [] and await h.rows(usage) == [])


async def test_voice_allowed_on_side_quest() -> None:
    async with Harness() as h:
        h.upstream.handler = answer
        await h.grant(plan="side_quest")

        body = stt_body()
        r = await stt(h, body)
        check("STT on side_quest -> 200 with the upstream JSON",
              r.status_code == 200 and r.json() == {"text": "hello", "language": "en"}, r.text)
        check("STT body forwarded unchanged (language kept: an OpenRouter field)",
              h.upstream.json() == body)
        row = (await h.rows(usage))[-1]
        # 2.0 s (exact, from the WAV header) x $0.00003/s = $0.00006 -> 52.8 -> 53
        check("STT metered by duration: 2.0 s, 53 milli",
              row["audio_seconds"] == 2.0 and row["milli_aura"] == 53 and row["endpoint"] == "stt", row)

        r = await tts(h, tts_body())
        check("TTS on side_quest -> 200", r.status_code == 200, r.text)
        check("audio streamed back intact as audio/mpeg",
              r.content == b"".join(AUDIO) and r.headers["content-type"] == "audio/mpeg", r.headers)
        row = (await h.rows(usage))[-1]
        # 100 chars x $2.4/1M = $0.00024 -> 211.2 -> 212
        check("Kokoro metered per character: 100 chars, 212 milli",
              row["chars"] == 100 and row["milli_aura"] == 212 and row["status"] == "ok", row)

        r = await tts(h, tts_body("y" * 100, language="hi", model="x-ai/grok-voice-tts-1.0",
                                  voice="eve"))
        check("Grok voice (Hindi) allowed on side_quest", r.status_code == 200, r.text)
        row = (await h.rows(usage))[-1]
        # 100 x $57/1M = $0.0057 -> 5,016
        check("Grok voice metered at $57/1M chars: 5,016 milli", row["milli_aura"] == 5016, row)

        r = await tts(h, tts_body(ENGLISH_WITH_A_TELUGU_WORD, language=None))
        check("English text with one Telugu word is not treated as Telugu", r.status_code == 200,
              r.text)


async def test_telugu_needs_main_character() -> None:
    async with Harness() as h:
        h.upstream.handler = answer
        await h.grant(plan="side_quest")
        r = await stt(h, stt_body(language="te"))
        error = r.json().get("error", {})
        check("Telugu STT on side_quest -> 403 voice_te / main_character",
              r.status_code == 403 and error.get("feature") == "voice_te"
              and error.get("required_plan") == "main_character", r.text)
        r = await stt(h, stt_body(language=None), headers={"X-Holo-Language": "te-IN"})
        check("Telugu via X-Holo-Language header also gated", r.status_code == 403, r.text)
        r = await tts(h, tts_body(TELUGU, language="te", model="x-ai/grok-voice-tts-1.0",
                                  voice="eve"))
        check("Telugu TTS (language field) on side_quest -> 403", r.status_code == 403, r.text)
        r = await tts(h, tts_body(TELUGU, language=None, model="x-ai/grok-voice-tts-1.0",
                                  voice="eve"))
        check("Telugu-script TTS without a language field still gated", r.status_code == 403,
              r.text)
        check("no Telugu request was forwarded", h.upstream.requests == [])

        await h.grant(plan="main_character")
        r = await stt(h, stt_body(language="te"))
        check("Telugu STT on main_character -> 200", r.status_code == 200, r.text)
        body = tts_body(TELUGU, language="te", model="x-ai/grok-voice-tts-1.0", voice="eve")
        r = await tts(h, body)
        check("Telugu TTS on main_character -> 200", r.status_code == 200, r.text)
        forwarded = h.upstream.json()
        check("TTS `language` stripped before forwarding", "language" not in forwarded, forwarded)
        check("rest of the TTS body forwarded unchanged",
              forwarded == {k: v for k, v in body.items() if k != "language"}, forwarded)
        check("usage row records the language", (await h.rows(usage))[-1]["language"] == "te")


async def test_audio_metering_details() -> None:
    async with Harness() as h:
        await h.grant(plan="side_quest")
        h.upstream.handler = lambda r: httpx.Response(
            200, json={"text": "hi", "usage": {"seconds": 3.5}},
        )
        await stt(h, stt_body(seconds=2.0))
        row = (await h.rows(usage))[-1]
        # The provider's own 3.5 s beats the 2.0 s estimate: 3.5 x $0.00003 -> 93
        check("STT uses the provider's reported seconds when present",
              row["audio_seconds"] == 3.5 and row["milli_aura"] == 93, row)

        h.upstream.handler = lambda r: httpx.Response(200, json={"text": "hm"})
        await stt(h, stt_body(seconds=0.25))
        row = (await h.rows(usage))[-1]
        check("STT bills at least min_seconds (1 s -> 27 milli)", row["milli_aura"] == 27, row)

        r = await stt(h, stt_body(model="openai/gpt-6-luna"))
        check("chat model on the STT endpoint -> 400 model_not_allowed",
              r.status_code == 400 and r.json()["error"]["code"] == "model_not_allowed", r.text)
        r = await tts(h, tts_body(model="google/gemini-3.1-flash-tts-preview"))
        check("unlisted TTS model -> 400", r.status_code == 400, r.text)
        r = await stt(h, {"model": "x-ai/grok-stt-1.0"})
        check("STT without input_audio -> 400", r.status_code == 400, r.text)
        r = await tts(h, tts_body("z" * 4001))
        check("TTS input over TTS_MAX_CHARS -> 400 input_too_long",
              r.status_code == 400 and r.json()["error"]["code"] == "input_too_long", r.text)

        h.upstream.handler = lambda r: httpx.Response(503, json={"error": {"message": "busy"}})
        r = await tts(h, tts_body())
        row = (await h.rows(usage))[-1]
        check("TTS upstream 5xx passed through and not charged",
              r.status_code == 503 and row["milli_aura"] == 0 and row["status"] == "upstream_error",
              (r.status_code, row))


if __name__ == "__main__":
    run([
        test_voice_blocked_on_spawn,
        test_voice_allowed_on_side_quest,
        test_telugu_needs_main_character,
        test_audio_metering_details,
    ])
