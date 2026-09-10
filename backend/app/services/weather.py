"""Weather, from a source that needs no account.

Open-Meteo: no key, no signup, and reachable with the `httpx` already in the
dependency list — which matters more than it sounds. Every dependency has to be
pinned by hand for the Android build and native wheels cross-compiled one at a
time, so a weather provider needing an SDK would cost a day of that. This costs
nothing.

Two calls: a name to coordinates, then coordinates to a forecast. Both are
shaped here into one payload the UI can render directly, because the panel
should not be parsing vendor JSON and neither should the model.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

logger = logging.getLogger("jarvis.weather")

GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"

TIMEOUT = 20.0

#: WMO weather interpretation codes -> (words, icon key).
#:
#: The icon key is deliberately a small closed vocabulary rather than the raw
#: code: the panel needs to pick one of a handful of drawings, and mapping 30
#: codes to 9 shapes here keeps that decision out of the component.
_CODES: dict[int, tuple[str, str]] = {
    0: ("Clear sky", "clear"),
    1: ("Mainly clear", "clear"),
    2: ("Partly cloudy", "partly-cloudy"),
    3: ("Overcast", "cloudy"),
    45: ("Fog", "fog"),
    48: ("Freezing fog", "fog"),
    51: ("Light drizzle", "drizzle"),
    53: ("Drizzle", "drizzle"),
    55: ("Heavy drizzle", "drizzle"),
    56: ("Freezing drizzle", "drizzle"),
    57: ("Freezing drizzle", "drizzle"),
    61: ("Light rain", "rain"),
    63: ("Rain", "rain"),
    65: ("Heavy rain", "rain"),
    66: ("Freezing rain", "rain"),
    67: ("Freezing rain", "rain"),
    71: ("Light snow", "snow"),
    73: ("Snow", "snow"),
    75: ("Heavy snow", "snow"),
    77: ("Snow grains", "snow"),
    80: ("Rain showers", "showers"),
    81: ("Rain showers", "showers"),
    82: ("Violent rain showers", "showers"),
    85: ("Snow showers", "snow"),
    86: ("Heavy snow showers", "snow"),
    95: ("Thunderstorm", "thunder"),
    96: ("Thunderstorm with hail", "thunder"),
    99: ("Thunderstorm with hail", "thunder"),
}


def describe(code: int | None) -> tuple[str, str]:
    return _CODES.get(int(code) if code is not None else -1, ("Unknown", "cloudy"))


class WeatherError(RuntimeError):
    """Anything that stops a forecast being produced, phrased for the user."""


async def _get(client: httpx.AsyncClient, url: str, params: dict[str, Any]) -> dict[str, Any]:
    response = await client.get(url, params=params, timeout=TIMEOUT)
    response.raise_for_status()
    return response.json()


async def lookup(place: str) -> dict[str, Any]:
    """Resolve a place name to coordinates and a display name."""
    async with httpx.AsyncClient() as client:
        payload = await _get(
            client, GEOCODE_URL, {"name": place, "count": 1, "language": "en"}
        )
    results = payload.get("results") or []
    if not results:
        raise WeatherError(
            f"Could not find anywhere called '{place}'. Try a nearby larger town."
        )
    hit = results[0]
    # Deduplicated, because a country geocodes to itself at every level and
    # "Australia, Australia" is what reaches the screen otherwise.
    seen: list[str] = []
    for part in (hit.get("name"), hit.get("admin1"), hit.get("country")):
        text = str(part).strip() if part else ""
        if text and text not in seen:
            seen.append(text)
    return {
        "latitude": hit["latitude"],
        "longitude": hit["longitude"],
        "label": ", ".join(seen),
        "short": hit.get("name") or place,
    }


async def forecast(place: str | None = None, days: int = 5) -> dict[str, Any]:
    """Current conditions plus a short forecast, ready to render.

    `place` is optional on purpose. Requiring it is what produced a forecast for
    the Bahamas when the user asked about "current" weather in Nellore: a
    required string field with no way to say "here" leaves the model inventing
    a word, and every word geocodes to somewhere. Omitted, or given anything
    meaning "here", it resolves to the user's remembered position instead.
    """
    from app.services import location

    located = await location.resolve(place)

    async with httpx.AsyncClient() as client:
        raw = await _get(
            client,
            FORECAST_URL,
            {
                "latitude": located["latitude"],
                "longitude": located["longitude"],
                "current": (
                    "temperature_2m,apparent_temperature,relative_humidity_2m,"
                    "wind_speed_10m,wind_direction_10m,weather_code,is_day,"
                    "precipitation,surface_pressure"
                ),
                "daily": (
                    "weather_code,temperature_2m_max,temperature_2m_min,"
                    "precipitation_probability_max,sunrise,sunset"
                ),
                "timezone": "auto",
                "forecast_days": max(1, min(days, 7)),
            },
        )

    current = raw.get("current") or {}
    units = raw.get("current_units") or {}
    daily = raw.get("daily") or {}
    condition, icon = describe(current.get("weather_code"))

    def day_at(index: int) -> dict[str, Any]:
        code = (daily.get("weather_code") or [None])[index]
        words, shape = describe(code)
        return {
            "date": (daily.get("time") or [None])[index],
            "high": (daily.get("temperature_2m_max") or [None])[index],
            "low": (daily.get("temperature_2m_min") or [None])[index],
            "rain_chance": (daily.get("precipitation_probability_max") or [None])[index],
            "condition": words,
            "icon": shape,
        }

    return {
        "location": located["label"],
        "place": located["short"],
        "timezone": raw.get("timezone"),
        "temperature": current.get("temperature_2m"),
        "feels_like": current.get("apparent_temperature"),
        "humidity": current.get("relative_humidity_2m"),
        "wind_speed": current.get("wind_speed_10m"),
        "wind_direction": current.get("wind_direction_10m"),
        "precipitation": current.get("precipitation"),
        "pressure": current.get("surface_pressure"),
        "condition": condition,
        "icon": icon,
        "is_day": bool(current.get("is_day", 1)),
        "units": {
            "temperature": units.get("temperature_2m", "°C"),
            "wind": units.get("wind_speed_10m", "km/h"),
        },
        "sunrise": (daily.get("sunrise") or [None])[0],
        "sunset": (daily.get("sunset") or [None])[0],
        "forecast": [day_at(i) for i in range(len(daily.get("time") or []))],
    }


def summarize(data: dict[str, Any]) -> str:
    """One paragraph for the model to speak from.

    The panel gets the structured payload; this is what the model reads. Kept
    short on purpose -- a spoken reply should be two sentences, and handing the
    model a table invites it to recite one.
    """
    unit = data["units"]["temperature"]
    lines = [
        f"{data['location']}: {data['temperature']}{unit}, {data['condition'].lower()}, "
        f"feels like {data['feels_like']}{unit}.",
        f"Humidity {data['humidity']}%, wind {data['wind_speed']} {data['units']['wind']}.",
    ]
    if data["forecast"]:
        today = data["forecast"][0]
        lines.append(
            f"Today {today['low']}–{today['high']}{unit}, "
            f"{today['rain_chance']}% chance of rain."
        )
    if len(data["forecast"]) > 1:
        tomorrow = data["forecast"][1]
        lines.append(
            f"Tomorrow {tomorrow['condition'].lower()}, "
            f"{tomorrow['low']}–{tomorrow['high']}{unit}."
        )
    return " ".join(lines)
