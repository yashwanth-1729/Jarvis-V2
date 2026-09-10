"""Where the user is, remembered — so "what's the weather" means somewhere real.

This exists because of a measured failure. Asked for the current weather with
no city named, the model filled the required `location` field with the literal
word "current", the geocoder resolved it to an island in the Bahamas, and
JARVIS confidently read out 25.4N / -76.8W conditions to someone sitting in
Nellore:

    GET geocoding-api.open-meteo.com/v1/search?name=current
      -> latitude=25.408 longitude=-76.78397

Nothing errored. A required string field with no notion of "here" guarantees
the model invents one, and a geocoder will always find *something*. So the tool
stops requiring a place, and this module answers the question instead.

Three sources, best first:

* **GPS**, pushed from the client after the device grants permission. Precise,
  and the only one that follows the user when they travel.
* **IP**, resolved server-side with no key and no permission dialog. City
  accuracy, which for weather is the whole answer — nobody needs street-level
  precision to know if it will rain.
* **Whatever was last remembered**, which covers being offline and covers the
  phone being indoors with no fix.

The result is stored in `preferences` rather than a new table because it is one
row that is overwritten, never queried in bulk, and the existing sync engine
does not need to carry it.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx

from app.core.timeutil import now
from app.db import crud

logger = logging.getLogger("jarvis.location")

PREFERENCE_KEY = "home_location"

REVERSE_URL = "https://api.bigdatacloud.net/data/reverse-geocode-client"
IP_URLS = ("https://ipapi.co/json/", "http://ip-api.com/json/")

TIMEOUT = 12.0

#: A GPS fix is worth trusting for a while; an IP guess goes stale the moment
#: the user changes network, so it is re-resolved far more eagerly.
FRESH_SECONDS = {"gps": 6 * 60 * 60, "ip": 45 * 60, "manual": 365 * 24 * 60 * 60}

#: Words the model reaches for when it has no city to name. Every one of these
#: geocodes to somewhere — "current" is in the Bahamas, "here" is in Belgium —
#: so they have to be caught before the lookup, not after.
PLACEHOLDERS = {
    "current",
    "current location",
    "current place",
    "here",
    "home",
    "my area",
    "my city",
    "my location",
    "my place",
    "my position",
    "local",
    "locally",
    "nearby",
    "outside",
    "present location",
    "this location",
    "this place",
    "unknown",
    "user location",
    "where i am",
    "where i live",
}


def is_placeholder(place: str | None) -> bool:
    """True when `place` is a way of saying "here" rather than a real place."""
    if not place:
        return True
    cleaned = place.strip().strip(".,!?").lower()
    if not cleaned:
        return True
    return cleaned in PLACEHOLDERS


async def _get(url: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True) as client:
        response = await client.get(url, params=params or {})
        response.raise_for_status()
        return response.json()


def _label(*parts: Any) -> str:
    seen: list[str] = []
    for part in parts:
        text = str(part).strip() if part else ""
        if text and text not in seen:
            seen.append(text)
    return ", ".join(seen)


async def reverse(latitude: float, longitude: float) -> str:
    """Coordinates to a human label. Falls back to the coordinates themselves.

    A failed reverse lookup must never lose the fix — the numbers are the part
    that matters, the name is a courtesy.
    """
    try:
        payload = await _get(
            REVERSE_URL,
            {"latitude": latitude, "longitude": longitude, "localityLanguage": "en"},
        )
    except Exception as exc:  # noqa: BLE001 - a label is optional, the fix is not
        logger.warning("reverse geocode failed: %s", exc)
        return f"{latitude:.3f}, {longitude:.3f}"

    label = _label(
        payload.get("city") or payload.get("locality"),
        payload.get("principalSubdivision"),
        payload.get("countryName"),
    )
    return label or f"{latitude:.3f}, {longitude:.3f}"


async def from_ip() -> dict[str, Any] | None:
    """City-level position with no permission prompt and no key.

    Two providers because both are free tiers with daily caps, and the failure
    mode of having neither is JARVIS not knowing where it is.
    """
    for url in IP_URLS:
        try:
            payload = await _get(url)
        except Exception as exc:  # noqa: BLE001
            logger.warning("ip lookup failed at %s: %s", url, exc)
            continue

        latitude = payload.get("latitude", payload.get("lat"))
        longitude = payload.get("longitude", payload.get("lon"))
        if latitude is None or longitude is None:
            continue

        label = _label(
            payload.get("city"),
            payload.get("region") or payload.get("regionName"),
            payload.get("country_name") or payload.get("country"),
        )
        return {
            "latitude": float(latitude),
            "longitude": float(longitude),
            "label": label or f"{float(latitude):.3f}, {float(longitude):.3f}",
            "source": "ip",
        }
    return None


async def remember(
    latitude: float,
    longitude: float,
    label: str,
    source: str = "gps",
    accuracy: float | None = None,
) -> dict[str, Any]:
    """Store a fix as the place JARVIS means when nobody names one."""
    record = {
        "latitude": round(float(latitude), 5),
        "longitude": round(float(longitude), 5),
        "label": label,
        "source": source,
        "accuracy": accuracy,
        "updated_at": now().isoformat(timespec="seconds"),
    }
    await crud.set_preference(PREFERENCE_KEY, json.dumps(record))
    logger.info("location remembered: %s (%s)", label, source)
    return record


async def remembered() -> dict[str, Any] | None:
    raw = await crud.get_preference(PREFERENCE_KEY)
    if not raw:
        return None
    try:
        record = json.loads(raw)
    except (TypeError, ValueError):
        logger.warning("stored location is not readable; ignoring it")
        return None
    if "latitude" not in record or "longitude" not in record:
        return None
    return record


def _age_seconds(record: dict[str, Any]) -> float:
    stamp = record.get("updated_at")
    if not stamp:
        return float("inf")
    try:
        from datetime import datetime

        written = datetime.fromisoformat(stamp)
    except (TypeError, ValueError):
        return float("inf")
    current = now()
    if written.tzinfo is None and current.tzinfo is not None:
        written = written.replace(tzinfo=current.tzinfo)
    return (current - written).total_seconds()


def is_fresh(record: dict[str, Any]) -> bool:
    limit = FRESH_SECONDS.get(str(record.get("source")), FRESH_SECONDS["ip"])
    return _age_seconds(record) < limit


async def here(refresh: bool = False) -> dict[str, Any] | None:
    """The user's position: remembered if fresh, re-resolved by IP if not.

    A stale record is still returned when every lookup fails. Yesterday's city
    is a far better answer than the Bahamas.
    """
    stored = await remembered()
    if stored and not refresh and is_fresh(stored):
        return stored

    # A GPS fix outranks an IP guess even when it has aged past its window —
    # only re-resolve by IP if there is nothing better, or the caller insisted.
    if stored and stored.get("source") == "gps" and not refresh:
        return stored

    located = await from_ip()
    if located:
        return await remember(
            located["latitude"],
            located["longitude"],
            located["label"],
            source="ip",
        )
    return stored


async def resolve(place: str | None) -> dict[str, Any]:
    """Turn whatever the model said into coordinates.

    A real place name is geocoded. Anything meaning "here" — including nothing
    at all — resolves to the remembered position instead of being handed to a
    geocoder that will cheerfully find an island.
    """
    from app.services import weather

    if not is_placeholder(place):
        located = await weather.lookup(str(place))
        located["source"] = "named"
        return located

    position = await here()
    if not position:
        raise weather.WeatherError(
            "I don't know where you are yet, and no location was named. Say the "
            "city — or open JARVIS and allow location access once, and I'll "
            "remember it."
        )
    return {
        "latitude": position["latitude"],
        "longitude": position["longitude"],
        "label": position["label"],
        "short": str(position["label"]).split(",")[0].strip() or position["label"],
        "source": position.get("source", "ip"),
    }
