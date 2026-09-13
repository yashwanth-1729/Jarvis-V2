"""BYOK: the client hands the runtime its own provider keys.

Sarvam's key path already existed; this pins the extension that lets Gemini's
key travel the same way -- entered once in Settings, sent on every connect,
held only in memory. The one behavior worth testing carefully is the
"desktop carve-out": a blank key from a first-contact call must not silently
erase a key that's already working (this exact bug shipped once, for Sarvam,
before that carve-out existed -- see /api/local/credentials's docstring), and
that same protection must now cover Gemini identically rather than being a
Sarvam-only special case.

    .venv/Scripts/python.exe tests/credentials_test.py
"""

from __future__ import annotations

import io
import os
import sys
import tempfile
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

SCRATCH = Path(tempfile.gettempdir()) / "jarvis_credentials_test.db"
for suffix in ("", "-wal", "-shm"):
    Path(str(SCRATCH) + suffix).unlink(missing_ok=True)
os.environ["JARVIS_DB_PATH"] = str(SCRATCH)
# CRITICAL: this test starts the real app lifespan (TestClient runs it),
# which starts the sync loop if not disabled here. Without this, a machine
# with real Supabase credentials in backend/.env pushes this test's
# throwaway local data to the LIVE project and deletes real rows via
# tombstones -- this actually happened once. Never remove this line.
os.environ["JARVIS_SYNC_ENABLED"] = "false"
os.environ["JARVIS_SCHEDULER_ENABLED"] = "false"
# This endpoint only answers for a client-owned-data runtime (desktop/Android
# webview sync architecture) -- see localstore.py::_require_client_owned.
os.environ["JARVIS_CLIENT_OWNED_DATA"] = "true"

from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402
from app.core.config import settings  # noqa: E402

passed = 0
failed = 0


def check(label: str, ok: bool, detail: object = "") -> None:
    global passed, failed
    if ok:
        passed += 1
        print(f"  PASS  {label}")
    else:
        failed += 1
        print(f"  FAIL  {label}  {detail}")


with TestClient(main.app) as client:
    print("== setting each key independently ==")
    settings.sarvam_api_key = ""
    settings.gemini_api_key = ""

    resp = client.post("/api/local/credentials", json={"sarvam_api_key": "sarvam-key-1"})
    check("sarvam-only POST -> 200", resp.status_code == 200, resp.text)
    check("sarvam reported configured", resp.json()["configured"] is True)
    check("gemini untouched, still unconfigured", resp.json()["gemini_configured"] is False)
    check("settings actually updated", settings.sarvam_api_key == "sarvam-key-1")
    check("gemini settings untouched", settings.gemini_api_key == "")

    resp = client.post("/api/local/credentials", json={"gemini_api_key": "gemini-key-1"})
    check("gemini-only POST -> 200", resp.status_code == 200, resp.text)
    check("gemini reported configured", resp.json()["gemini_configured"] is True)
    check("sarvam still reported configured (untouched by this call)", resp.json()["configured"] is True)
    check("gemini settings actually updated", settings.gemini_api_key == "gemini-key-1")
    check("sarvam settings still holds its earlier value", settings.sarvam_api_key == "sarvam-key-1")

    print("\n== setting both keys in one call ==")
    settings.sarvam_api_key = ""
    settings.gemini_api_key = ""
    resp = client.post(
        "/api/local/credentials",
        json={"sarvam_api_key": "sarvam-key-2", "gemini_api_key": "gemini-key-2"},
    )
    check("both POST -> 200", resp.status_code == 200, resp.text)
    check("both reported configured", resp.json() == {"configured": True, "gemini_configured": True})
    check(
        "both settings updated",
        settings.sarvam_api_key == "sarvam-key-2" and settings.gemini_api_key == "gemini-key-2",
    )

    print("\n== desktop carve-out: a blank key must not erase a working one ==")
    settings.jarvis_android = False
    settings.sarvam_api_key = "already-working-sarvam"
    settings.gemini_api_key = "already-working-gemini"

    resp = client.post("/api/local/credentials", json={"sarvam_api_key": "", "gemini_api_key": ""})
    check("blank-both POST -> 200", resp.status_code == 200, resp.text)
    check(
        "desktop: blank sarvam key does not clear the working one",
        settings.sarvam_api_key == "already-working-sarvam",
    )
    check(
        "desktop: blank gemini key does not clear the working one either",
        settings.gemini_api_key == "already-working-gemini",
    )
    check("both still reported as configured, not cleared", resp.json() == {"configured": True, "gemini_configured": True})

    print("\n== android: a blank key still means \"clear it\", both providers ==")
    settings.jarvis_android = True
    settings.sarvam_api_key = "already-working-sarvam"
    settings.gemini_api_key = "already-working-gemini"

    resp = client.post("/api/local/credentials", json={"sarvam_api_key": "", "gemini_api_key": ""})
    check("android blank-both POST -> 200", resp.status_code == 200, resp.text)
    check("android: blank sarvam key clears it", settings.sarvam_api_key == "")
    check("android: blank gemini key clears it too", settings.gemini_api_key == "")
    check("both reported as cleared", resp.json() == {"configured": False, "gemini_configured": False})
    settings.jarvis_android = False

    print("\n== omitting a key entirely leaves it alone and reports its current state ==")
    settings.sarvam_api_key = "untouched-sarvam"
    settings.gemini_api_key = ""
    resp = client.post("/api/local/credentials", json={})
    check("empty payload -> 200", resp.status_code == 200, resp.text)
    check("sarvam's actual state is reported even though this call didn't mention it", resp.json()["configured"] is True)
    check("gemini's actual state is reported the same way", resp.json()["gemini_configured"] is False)
    check("neither settings value was touched", settings.sarvam_api_key == "untouched-sarvam" and settings.gemini_api_key == "")

    # Leave no real-looking key material sitting in process memory after this file exits.
    settings.sarvam_api_key = ""
    settings.gemini_api_key = ""

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
