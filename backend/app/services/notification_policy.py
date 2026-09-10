"""Persistent user policy for native and in-app notification selection."""

from __future__ import annotations

import json
from typing import Any

from app.db import crud

DEFAULT_POLICY: dict[str, Any] = {
    "version": 1,
    "enabled": True,
    "deadline_tasks": True,
    "college": False,
    "routine": False,
    "blocks": False,
    "reminders": False,
    "include": [],
    "exclude": [],
}

_BOOL_KEYS = ("enabled", "deadline_tasks", "college", "routine", "blocks", "reminders")


def normalize(value: Any) -> dict[str, Any]:
    """Return a complete, bounded policy even when persisted JSON is old/bad."""
    source = value if isinstance(value, dict) else {}
    policy = dict(DEFAULT_POLICY)
    for key in _BOOL_KEYS:
        if isinstance(source.get(key), bool):
            policy[key] = source[key]
    for key in ("include", "exclude"):
        raw = source.get(key)
        if isinstance(raw, list):
            policy[key] = sorted(
                {str(item).strip() for item in raw if str(item).strip()}
            )[:500]
    # A specific mute always wins over a specific allow.
    policy["include"] = [
        item for item in policy["include"] if item not in policy["exclude"]
    ]
    return policy


async def load() -> dict[str, Any]:
    raw = await crud.get_preference(crud.PREF_NOTIFICATION_POLICY)
    if not raw:
        return dict(DEFAULT_POLICY)
    try:
        return normalize(json.loads(raw))
    except (TypeError, ValueError):
        return dict(DEFAULT_POLICY)


async def save(policy: dict[str, Any]) -> dict[str, Any]:
    normalized = normalize(policy)
    await crud.set_preference(
        crud.PREF_NOTIFICATION_POLICY,
        json.dumps(normalized, separators=(",", ":"), sort_keys=True),
    )
    return normalized


async def allow_specific(reference: str, *, enable: bool = True) -> dict[str, Any]:
    policy = await load()
    if enable:
        policy["enabled"] = True
    policy["exclude"] = [item for item in policy["exclude"] if item != reference]
    policy["include"] = sorted({*policy["include"], reference})
    return await save(policy)


def describe(policy: dict[str, Any]) -> str:
    if not policy["enabled"]:
        return "all notifications off"
    active = []
    if policy["deadline_tasks"]:
        active.append("deadline tasks")
    if policy["college"]:
        active.append("college classes")
    if policy["routine"]:
        active.append("routines")
    if policy["blocks"]:
        active.append("Blocks")
    if policy["reminders"]:
        active.append("all reminders")
    if policy["include"]:
        active.append(f"{len(policy['include'])} specifically enabled item(s)")
    summary = ", ".join(active) if active else "no categories"
    if policy["exclude"]:
        summary += f"; {len(policy['exclude'])} specifically muted item(s)"
    return summary


def permits(policy: dict[str, Any], reference: str, category: str) -> bool:
    """Whether one concrete alarm survives master/category/item controls."""
    current = normalize(policy)
    if not current["enabled"] or reference in current["exclude"]:
        return False
    return reference in current["include"] or bool(current.get(category, False))
