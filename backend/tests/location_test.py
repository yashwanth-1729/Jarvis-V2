""""Here" has to mean somewhere.

Asked for the current weather with no city named, JARVIS did this:

    GET geocoding-api.open-meteo.com/v1/search?name=current
      -> latitude=25.408 longitude=-76.78397     (an island in the Bahamas)

and read those conditions out to someone in Nellore. Nothing raised, nothing
logged a warning, and the reply was fluent — which is why it went unnoticed
until the coordinates were read off the log by hand.

The cause was a schema, not a prompt: `location` was a required string with no
way to express "where I am", so the model filled it with the nearest word to
hand. A geocoder will always find something for any word.

Offline — the network is stubbed, so this costs nothing and can run on every
change.

    .venv/Scripts/python.exe tests/location_test.py
"""

from __future__ import annotations

import asyncio
import io
import os
import sys
import tempfile
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

SCRATCH = Path(tempfile.gettempdir()) / "jarvis_location_test.db"
for suffix in ("", "-wal", "-shm"):
    Path(str(SCRATCH) + suffix).unlink(missing_ok=True)
os.environ["JARVIS_DB_PATH"] = str(SCRATCH)

from app.core.config import get_settings  # noqa: E402

get_settings.cache_clear()
import app.core.config as cfg  # noqa: E402

cfg.settings = get_settings()

import app.db.database as dbmod  # noqa: E402

dbmod.db = dbmod.Database(cfg.settings.db_file, 5)
import app.db.crud as crud  # noqa: E402

crud.db = dbmod.db

from app.services import location, weather  # noqa: E402
import app.llm.tools as tools  # noqa: E402

tools.crud = crud

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


# --------------------------------------------------------------------- stubs
GEOCODED: list[str] = []
IP_CALLS: list[int] = []

BAHAMAS = {
    "latitude": 25.408,
    "longitude": -76.78397,
    "label": "Bahamas",
    "short": "Bahamas",
}
NELLORE = {
    "latitude": 14.44992,
    "longitude": 79.98697,
    "label": "Nellore, Andhra Pradesh, India",
    "short": "Nellore",
}


async def fake_lookup(place: str) -> dict:
    """Stands in for the geocoder, including its willingness to find anything."""
    GEOCODED.append(place)
    if place.strip().lower() in {"current", "here", "my location"}:
        return dict(BAHAMAS)  # exactly what the real one returned
    if place.strip().lower() == "nellore":
        return dict(NELLORE)
    raise weather.WeatherError(f"Could not find anywhere called '{place}'.")


async def fake_from_ip() -> dict:
    IP_CALLS.append(1)
    return {
        "latitude": 14.44,
        "longitude": 79.98,
        "label": "Nellore, Andhra Pradesh, India",
        "source": "ip",
    }


async def main() -> None:
    await dbmod.db.connect()
    weather.lookup = fake_lookup  # type: ignore[assignment]
    location.from_ip = fake_from_ip  # type: ignore[assignment]

    try:
        print("== the words that are not places ==")
        for word in ("current", "Current", "here", "my location", "  HERE  ", "", None):
            check(f"{word!r} is a placeholder", location.is_placeholder(word))
        for word in ("Nellore", "Bengaluru", "New York"):
            check(f"{word!r} is a real place", not location.is_placeholder(word))

        print("\n== the geocoder is never asked about them ==")
        GEOCODED.clear()
        resolved = await location.resolve("current")
        check("'current' does not reach the geocoder", GEOCODED == [], GEOCODED)
        check("  ...and does not land in the Bahamas",
              abs(resolved["latitude"] - 25.408) > 1, resolved)
        check("  ...it resolves to where the user is",
              resolved["label"].startswith("Nellore"), resolved["label"])
        check("  ...via the IP fallback", len(IP_CALLS) == 1, IP_CALLS)

        print("\n== a named place still wins ==")
        GEOCODED.clear()
        named = await location.resolve("Nellore")
        check("a real name is geocoded", GEOCODED == ["Nellore"], GEOCODED)
        check("  ...and marked as named", named["source"] == "named", named["source"])

        print("\n== a GPS fix is remembered and preferred ==")
        await location.remember(12.9716, 77.5946, "Bengaluru, Karnataka, India", "gps")
        stored = await location.remembered()
        check("the fix round-trips", stored and stored["label"].startswith("Bengaluru"), stored)
        check("  ...as gps", stored and stored["source"] == "gps", stored)

        before = len(IP_CALLS)
        again = await location.resolve(None)
        check("no location named uses the stored fix",
              again["label"].startswith("Bengaluru"), again["label"])
        check("  ...without another IP lookup", len(IP_CALLS) == before, IP_CALLS)
        check("  ...and shortens the label for speech",
              again["short"] == "Bengaluru", again["short"])

        print("\n== the tool no longer requires a place ==")
        schema = next(t for t in tools.TOOL_REGISTRY if t.name == "get_weather")
        check("location is not required", schema.input_schema["required"] == [],
              schema.input_schema["required"])
        model = tools.GetWeatherInput()
        check("the model validates with no location at all", model.location is None)
        check("  ...and still defaults the day count", model.days == 5, model.days)

        print("\n== a stale fix beats a wrong one ==")
        # Every lookup failing must not resurrect the guessing behaviour.
        async def no_ip() -> None:
            IP_CALLS.append(1)
            return None

        location.from_ip = no_ip  # type: ignore[assignment]
        await crud.set_preference(
            location.PREFERENCE_KEY,
            '{"latitude": 14.4, "longitude": 79.9, "label": "Nellore", '
            '"source": "ip", "updated_at": "2020-01-01T00:00:00"}',
        )
        fallback = await location.here()
        check("a year-old record is still returned",
              fallback and fallback["label"] == "Nellore", fallback)

        print("\n== nothing known, nothing invented ==")
        await crud.set_preference(location.PREFERENCE_KEY, "")
        try:
            await location.resolve(None)
            check("resolving with nothing known raises", False, "it returned")
        except weather.WeatherError as exc:
            check("resolving with nothing known raises", True)
            check("  ...and says how to fix it", "city" in str(exc).lower(), str(exc))
    finally:
        await dbmod.db.disconnect()


asyncio.run(main())
print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
