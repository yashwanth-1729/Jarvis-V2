"""The public edition: no provider key, everything through the HOLO gateway.

Offline: a fake HTTP transport stands in for the gateway, and no real
provider, Supabase or user data is touched. Covers what docs/public-edition.md
promises for phase 1:

* the agent offers and runs only the public tool allow-list;
* model, speech-to-text and text-to-speech calls go to ``<gateway>/api/v1``
  with the user's session token, never a provider key;
* text-to-speech tells the gateway the language, so Telugu can be gated;
* /api/local/credentials accepts only the session, and /sync-bootstrap never
  hands out a service key;
* the public edition is always on the cloud voice stack.

    .venv/Scripts/python.exe tests/public_edition_test.py
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx  # noqa: E402

FAILURES: list[str] = []


def check(label: str, ok: bool, detail: object = "") -> None:
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}" + (f" -- {detail}" if not ok and detail != "" else ""))
    if not ok:
        FAILURES.append(label)


async def main() -> None:
    from app.core import edition
    from app.core.config import Settings, settings
    from app.providers import openrouter
    from app.providers.base import ProviderNotConfigured
    from app.api import localstore

    saved = {
        name: getattr(settings, name)
        for name in (
            "jarvis_edition", "holo_gateway_url", "holo_session_token",
            "openrouter_api_key", "jarvis_client_owned_data",
        )
    }
    try:
        print("personal edition is untouched")
        settings.jarvis_edition = "personal"
        check("every tool allowed in personal", edition.tool_allowed("run_command") and edition.tool_allowed("add_task"))
        specs = [{"type": "function", "function": {"name": n}} for n in ("run_command", "add_task")]
        check("personal keeps the full tool list", edition.filter_tool_specs(specs) == specs)
        check("personal talks to OpenRouter itself", openrouter._api_base() == openrouter.API_BASE)

        print("public edition: tools")
        settings.jarvis_edition = "public"
        kept = [s["function"]["name"] for s in edition.filter_tool_specs(specs)]
        check("public drops run_command, keeps add_task", kept == ["add_task"], kept)
        for name in ("install_app", "launch_app", "read_file", "write_file", "browser_open", "ui_click", "clipboard_get"):
            check(f"{name} not allowed", not edition.tool_allowed(name))
        for name in ("add_task", "set_reminder", "set_routine", "web_search", "undo_last_change", "get_weather"):
            check(f"{name} allowed", edition.tool_allowed(name))

        check("no system tools in public, whatever the platform", settings.system_tools_enabled is False)

        print("public edition: credentials")
        settings.jarvis_client_owned_data = True
        settings.openrouter_api_key = "owner-key-must-not-change"
        settings.holo_gateway_url = "https://gw.example.test/"
        result = await localstore.credentials({"openrouter_api_key": "smuggled", "holo_session_token": "user-jwt"})
        check("session token stored", settings.holo_session_token == "user-jwt")
        check("provider key not accepted", settings.openrouter_api_key == "owner-key-must-not-change")
        check("reports the session", result.get("session") is True and result.get("openrouter_configured") is True, result)
        boot = await localstore.sync_bootstrap()
        check("sync-bootstrap hands out no service key", boot == {"supabase_url": "", "supabase_key": ""}, boot)

        print("public edition: provider calls go to the gateway with the session")
        check("base URL is the gateway", openrouter._api_base() == "https://gw.example.test/api/v1", openrouter._api_base())
        check("auth is the session token", openrouter._headers() == {"Authorization": "Bearer user-jwt"})

        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            if request.url.path.endswith("/audio/speech"):
                return httpx.Response(200, content=b"ID3fake-mp3", headers={"content-type": "audio/mpeg"})
            return httpx.Response(404)

        openrouter._test_transport = httpx.MockTransport(handler)
        openrouter._client = None
        try:
            await openrouter.OpenRouterTTS().synthesize("నమస్తే", language_code="te-IN")
        except Exception as exc:  # noqa: BLE001 - only the request matters here
            print(f"    (synthesize raised {type(exc).__name__}: {exc}; checking the request anyway)")
        request = seen[0] if seen else None
        check("one TTS request sent", request is not None)
        if request is not None:
            body = json.loads(request.content)
            check("sent to the gateway host", request.url.host == "gw.example.test", request.url)
            check("on the mirrored path", request.url.path == "/api/v1/audio/speech", request.url.path)
            check("bearer is the session", request.headers.get("authorization") == "Bearer user-jwt")
            check("language travels for the Telugu gate", body.get("language") == "te", body)
            check("no provider key anywhere", "owner-key" not in request.headers.get("authorization", ""))

        print("public edition: gateway refusals become actionable errors")
        from app.providers.base import ProviderAuthError, ProviderOutOfCredit, ProviderRateLimited

        def refusal(status: int, error: dict) -> Exception | None:
            response = httpx.Response(status, json={"error": error})
            try:
                openrouter._raise_for_status(response, response.content)
            except Exception as exc:  # noqa: BLE001 - the type is the assertion
                return exc
            return None

        out = refusal(402, {"code": "insufficient_aura", "refills_at": "2026-11-03T06:00:00+00:00"})
        check("402 is out-of-credit with the refill date", isinstance(out, ProviderOutOfCredit) and "2026-11-03" in str(out), out)
        out = refusal(403, {"code": "feature_locked", "feature": "voice_te", "required_plan": "main_character"})
        check("feature lock names the plan", isinstance(out, ProviderOutOfCredit) and "Main Character" in str(out), out)
        out = refusal(401, {"code": "token_expired"})
        check("expired session asks to sign in", isinstance(out, ProviderAuthError) and "sign in" in str(out), out)
        out = refusal(429, {"code": "daily_cap_reached"})
        check("daily cap is a rate limit", isinstance(out, ProviderRateLimited) and "today" in str(out), out)
        check("no message mentions an API key", all("API key" not in str(refusal(c, {"code": k})) for c, k in ((401, "invalid_token"), (403, "feature_locked"))))

        print("public edition: signed out")
        settings.holo_session_token = ""
        try:
            openrouter._require_key()
            check("signed out raises", False)
        except ProviderNotConfigured as exc:
            check("signed out asks to sign in", "Sign in" in str(exc), exc)
        check("no session means voice is off", settings.has_openrouter_key is False)

        print("public edition is cloud-only")
        forced = Settings.model_validate({"JARVIS_EDITION": "public", "JARVIS_VOICE_STACK": "legacy"})
        check("legacy stack is overridden to cloud", forced.jarvis_voice_stack == "cloud", forced.jarvis_voice_stack)
        personal = Settings.model_validate({"JARVIS_EDITION": "personal", "JARVIS_VOICE_STACK": "legacy"})
        check("personal keeps its stack choice", personal.jarvis_voice_stack == "legacy", personal.jarvis_voice_stack)
    finally:
        for name, value in saved.items():
            setattr(settings, name, value)
        openrouter._test_transport = None
        openrouter._client = None

    print()
    print(f"{len(FAILURES)} failure(s)" if FAILURES else "all public edition checks passed")
    sys.exit(1 if FAILURES else 0)


if __name__ == "__main__":
    asyncio.run(main())
