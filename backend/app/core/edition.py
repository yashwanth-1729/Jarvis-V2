"""What the public edition may do that differs from the personal build.

The personal JARVIS runs on its owner's machine and phone, with their keys and
full control of the computer. The public edition (docs/public-edition.md)
runs for strangers: it must never drive a desktop, touch files or call a
personal connector. Tools are therefore an *allow*-list there, so a personal
tool added later stays out of the public build until someone decides
otherwise, rather than leaking in by default.
"""

from __future__ import annotations

from app.core.config import settings

#: Everything a phone assistant for the public needs: the board, the
#: schedule, reminders, memory, notes, the brief, weather, the open web, voice
#: and language, notification preferences and undo. Search and fetch run from
#: the user's own phone with no key.
PUBLIC_TOOLS: frozenset[str] = frozenset({
    "add_schedule_event",
    "add_task",
    "bulk_delete_notes",
    "bulk_delete_schedule",
    "bulk_delete_tasks",
    "configure_notifications",
    "delete_record",
    "fetch_url",
    "generate_proactive_brief",
    "get_dashboard_summary",
    "get_weather",
    "save_idea_or_note",
    "search_memory",
    "set_language",
    "set_reminder",
    "set_routine",
    "set_voice",
    "undo_last_change",
    "update_idea",
    "update_schedule_event",
    "update_task",
    "update_task_status",
    "web_search",
})


def is_public() -> bool:
    return settings.is_public_edition


def tool_allowed(name: str) -> bool:
    """Whether the agent may offer or run ``name`` in this edition."""
    return not is_public() or name in PUBLIC_TOOLS


def filter_tool_specs(specs: list[dict]) -> list[dict]:
    """Drop the OpenAI-shaped tool specs this edition does not allow."""
    if not is_public():
        return specs
    return [spec for spec in specs if tool_allowed(_spec_name(spec))]


def _spec_name(spec: dict) -> str:
    function = spec.get("function")
    if isinstance(function, dict):
        return str(function.get("name", ""))
    return str(spec.get("name", ""))
