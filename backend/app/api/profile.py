"""GET/PUT /api/profile: the public edition's onboarding answers.

See ``app/services/profile.py``. Mounted from ``app/api/records.py`` so it
shares the ``/api`` prefix.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from app.services import profile

router = APIRouter(prefix="/profile", tags=["profile"])


@router.get("", summary="The user's onboarding profile, or null")
async def get_profile() -> dict[str, Any] | None:
    return profile.load()


@router.put("", summary="Save the onboarding profile (shapes the assistant's persona)")
async def put_profile(payload: dict[str, Any]) -> dict[str, Any]:
    return profile.save(payload)


@router.delete("", status_code=204, summary="Forget the onboarding profile")
async def delete_profile() -> None:
    profile.clear()
