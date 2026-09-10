"""Where the device says it is.

The backend cannot ask for a GPS fix — it has no radio and no permission
dialog. Only the client can, so the flow runs one way: the app asks the
platform, the platform asks the user, and whatever comes back is posted here
once and remembered. Everything server-side (weather today, the scheduler's
sunrise handling later) then reads one stored position instead of each feature
inventing its own idea of "here".

If the fix never arrives — permission denied, indoors with no signal, a webview
that does not implement the geolocation prompt — nothing breaks. The stored
position falls back to an IP lookup that needs no permission and no key, which
is city-accurate, and city-accurate is the entire requirement for weather.

    GET  /api/location          what JARVIS currently believes
    POST /api/location          push a fix from the device
    POST /api/location/name     set it by hand, when the device will not say
    POST /api/location/refresh  re-resolve by IP, ignoring what is stored
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services import location

logger = logging.getLogger("jarvis.api.location")

router = APIRouter(prefix="/api/location", tags=["location"])


class LocationFix(BaseModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    #: Metres, as the Geolocation API reports it. Kept so a wildly imprecise
    #: fix can be recognised later rather than trusted as if it were GPS.
    accuracy: float | None = Field(default=None, ge=0)
    #: Set when the user typed a place rather than the device measuring one.
    label: str | None = Field(default=None, max_length=160)


class LocationOut(BaseModel):
    latitude: float
    longitude: float
    label: str
    source: str
    accuracy: float | None = None
    updated_at: str | None = None


@router.get("", response_model=LocationOut | None)
async def read_location() -> dict | None:
    """The remembered position, resolving one by IP if there is none yet."""
    return await location.here()


@router.post("", response_model=LocationOut)
async def push_location(fix: LocationFix) -> dict:
    """Store a fix from the device. Precise, and it follows the user."""
    label = (fix.label or "").strip()
    if not label:
        label = await location.reverse(fix.latitude, fix.longitude)

    return await location.remember(
        fix.latitude,
        fix.longitude,
        label,
        source="manual" if fix.label else "gps",
        accuracy=fix.accuracy,
    )


class LocationName(BaseModel):
    name: str = Field(min_length=1, max_length=120)


@router.post("/name", response_model=LocationOut)
async def name_location(request: LocationName) -> dict:
    """Geocode a place the user typed and keep it as their location.

    The manual escape hatch. A permission the user declined once is awkward to
    re-request on Android, and typing "Nellore" once is a complete answer.
    """
    from app.services import weather

    if location.is_placeholder(request.name):
        raise HTTPException(
            status_code=422,
            detail=f"'{request.name}' is not a place. Name a town or city.",
        )
    try:
        found = await weather.lookup(request.name)
    except weather.WeatherError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    return await location.remember(
        found["latitude"], found["longitude"], found["label"], source="manual"
    )


@router.post("/refresh", response_model=LocationOut)
async def refresh_location() -> dict:
    """Re-resolve by IP even if something fresher is stored."""
    resolved = await location.here(refresh=True)
    if not resolved:
        raise HTTPException(
            status_code=503,
            detail="Could not work out where you are. Name the city instead.",
        )
    return resolved
