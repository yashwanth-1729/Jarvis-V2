"""Tool definitions and execution handlers.

Each tool has three parts:

1. a **Pydantic model** — validates and coerces whatever the model emits before
   it reaches the database;
2. a **JSON schema** in ``TOOL_SCHEMAS`` — what the Anthropic API sees;
3. a **handler** — async function returning ``ToolOutcome``.

``TOOL_SCHEMAS`` is a module-level constant and is emitted in a stable order, so
the tool block stays byte-identical across requests and the prompt cache keeps
hitting.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal

from pydantic import BaseModel, Field, ValidationError, field_validator

from app.core.timeutil import normalize_datetime
from app.db import crud
from app.services import proactive

logger = logging.getLogger("jarvis.tools")

# Which dashboard panels a tool invalidates. The chat stream forwards these to
# the browser so it can refetch exactly what changed.
Domain = Literal["tasks", "schedule", "ideas", "memories", "brief"]


@dataclass(slots=True)
class ToolOutcome:
    """Result of one tool execution."""

    content: str                       # text handed back to the model
    is_error: bool = False
    refresh: set[str] = field(default_factory=set)
    display: dict[str, Any] | None = None  # compact payload for the UI's tool log


# ---------------------------------------------------------------------------
# Pydantic input models
# ---------------------------------------------------------------------------

class AddTaskInput(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    due_date: str | None = None
    priority: str | None = None
    category: str | None = None

    @field_validator("title")
    @classmethod
    def _strip_title(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("title cannot be blank")
        return cleaned


class UpdateTaskStatusInput(BaseModel):
    task_id: int = Field(ge=1)
    status: str


class GetDashboardSummaryInput(BaseModel):
    pass


class SaveIdeaOrNoteInput(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    content: str = Field(default="", max_length=20_000)
    category: str | None = None


class SearchMemoryInput(BaseModel):
    query: str = Field(min_length=1, max_length=300)


class GenerateProactiveBriefInput(BaseModel):
    pass


class AddScheduleEventInput(BaseModel):
    event_name: str = Field(min_length=1, max_length=300)
    time_start: str
    time_end: str | None = None
    location: str | None = None
    notes: str | None = None


# ---------------------------------------------------------------------------
# Handlers
# ---------------------------------------------------------------------------

async def _handle_add_task(payload: AddTaskInput) -> ToolOutcome:
    task = await crud.create_task(
        title=payload.title,
        due_date=payload.due_date,
        priority=payload.priority,
        category=payload.category,
    )
    due = task["due_date"] or "no due date"
    warning = ""
    if payload.due_date and not task["due_date"]:
        warning = (
            f" (warning: due_date '{payload.due_date}' was not a recognizable "
            "datetime and was dropped — re-add it as YYYY-MM-DDTHH:MM:SS)"
        )
    return ToolOutcome(
        content=(
            f"Created task #{task['id']}: '{task['title']}' "
            f"[{task['priority']}/{task['category']}] due {due}.{warning}"
        ),
        refresh={"tasks", "brief"},
        display={"id": task["id"], "title": task["title"], "priority": task["priority"], "due": due},
    )


async def _handle_update_task_status(payload: UpdateTaskStatusInput) -> ToolOutcome:
    task = await crud.update_task_status(payload.task_id, payload.status)
    if task is None:
        return ToolOutcome(
            content=(
                f"No task with id {payload.task_id} exists. "
                "Call get_dashboard_summary to see the current task IDs."
            ),
            is_error=True,
        )
    return ToolOutcome(
        content=f"Task #{task['id']} '{task['title']}' is now {task['status']}.",
        refresh={"tasks", "brief"},
        display={"id": task["id"], "title": task["title"], "status": task["status"]},
    )


async def _handle_get_dashboard_summary(_: GetDashboardSummaryInput) -> ToolOutcome:
    open_tasks = await crud.list_tasks(statuses=("PENDING", "IN_PROGRESS"))
    today = await crud.todays_schedule()
    upcoming = await crud.upcoming_schedule(days=7)
    ideas = await crud.list_ideas(statuses=("DRAFT", "ACTIVE"))
    counts = await crud.count_tasks_by_status()
    overdue = await crud.overdue_tasks()

    lines = [
        f"Task counts — pending: {counts['PENDING']}, in progress: "
        f"{counts['IN_PROGRESS']}, completed: {counts['COMPLETED']}, overdue: {len(overdue)}.",
        "",
        "OPEN TASKS:",
    ]
    if open_tasks:
        lines += [
            f"  #{t['id']} [{t['priority']}/{t['status']}] {t['title']} "
            f"(category: {t['category']}, due: {t['due_date'] or 'none'})"
            for t in open_tasks
        ]
    else:
        lines.append("  none")

    lines += ["", "TODAY'S SCHEDULE:"]
    if today:
        lines += [
            f"  #{e['id']} {e['time_start']}"
            f"{' - ' + e['time_end'] if e['time_end'] else ''} {e['event_name']}"
            f"{' @ ' + e['location'] if e['location'] else ''}"
            for e in today
        ]
    else:
        lines.append("  nothing scheduled today")

    lines += ["", "UPCOMING (next 7 days):"]
    if upcoming:
        lines += [f"  #{e['id']} {e['time_start']} {e['event_name']}" for e in upcoming]
    else:
        lines.append("  nothing scheduled")

    lines += ["", "ACTIVE IDEAS / NOTES:"]
    if ideas:
        lines += [
            f"  #{i['id']} [{i['status']}] {i['title']}"
            f"{' — tags: ' + i['tags'] if i['tags'] else ''}"
            for i in ideas
        ]
    else:
        lines.append("  none")

    return ToolOutcome(
        content="\n".join(lines),
        display={
            "open_tasks": len(open_tasks),
            "today_events": len(today),
            "ideas": len(ideas),
            "overdue": len(overdue),
        },
    )


async def _handle_save_idea_or_note(payload: SaveIdeaOrNoteInput) -> ToolOutcome:
    category = (payload.category or "").strip().upper()

    # PRIVATE / LONG_TERM / GOAL / PREFERENCE route to durable memory; anything
    # else is captured as an idea card on the dashboard.
    if category in crud.MEMORY_CATEGORIES:
        memory = await crud.upsert_memory(
            key_concept=payload.title, content=payload.content, category=category
        )
        return ToolOutcome(
            content=(
                f"Stored memory #{memory['id']} under key concept "
                f"'{memory['key_concept']}' [{memory['category']}]."
            ),
            refresh={"memories"},
            display={
                "kind": "memory",
                "id": memory["id"],
                "title": memory["key_concept"],
                "category": memory["category"],
            },
        )

    idea = await crud.create_idea(
        title=payload.title,
        description=payload.content,
        tags=category.lower() if category else "",
        status="ACTIVE",
    )
    return ToolOutcome(
        content=f"Saved idea #{idea['id']}: '{idea['title']}' [{idea['status']}].",
        refresh={"ideas"},
        display={"kind": "idea", "id": idea["id"], "title": idea["title"], "status": idea["status"]},
    )


async def _handle_search_memory(payload: SearchMemoryInput) -> ToolOutcome:
    results = await crud.search_memories_and_ideas(payload.query)
    total = sum(len(bucket) for bucket in results.values())

    if total == 0:
        return ToolOutcome(
            content=f"No stored memories, ideas or tasks match '{payload.query}'.",
            display={"query": payload.query, "hits": 0},
        )

    lines = [f"{total} result(s) for '{payload.query}':"]
    if results["memories"]:
        lines.append("\nMEMORIES:")
        lines += [
            f"  #{m['id']} [{m['category']}] {m['key_concept']}: {m['content'][:400]}"
            for m in results["memories"]
        ]
    if results["ideas"]:
        lines.append("\nIDEAS:")
        lines += [
            f"  #{i['id']} [{i['status']}] {i['title']}: {i['description'][:300]}"
            for i in results["ideas"]
        ]
    if results["tasks"]:
        lines.append("\nTASKS:")
        lines += [
            f"  #{t['id']} [{t['priority']}/{t['status']}] {t['title']} (due: {t['due_date'] or 'none'})"
            for t in results["tasks"]
        ]

    return ToolOutcome(content="\n".join(lines), display={"query": payload.query, "hits": total})


async def _handle_generate_proactive_brief(_: GenerateProactiveBriefInput) -> ToolOutcome:
    brief = await proactive.build_brief()
    return ToolOutcome(
        content=(
            f"Proactive brief ({brief['urgent_count']} urgent item(s) across "
            f"{brief['considered']} open commitments):\n{brief['summary_text']}"
        ),
        refresh={"brief"},
        display={"urgent_count": brief["urgent_count"], "bullets": brief["bullets"]},
    )


async def _handle_add_schedule_event(payload: AddScheduleEventInput) -> ToolOutcome:
    if normalize_datetime(payload.time_start) is None:
        return ToolOutcome(
            content=(
                f"'{payload.time_start}' is not a valid start time. "
                "Pass an absolute datetime as YYYY-MM-DDTHH:MM:SS."
            ),
            is_error=True,
        )

    event = await crud.create_schedule_event(
        event_name=payload.event_name,
        time_start=payload.time_start,
        time_end=payload.time_end,
        location=payload.location,
        notes=payload.notes,
    )
    if event is None:  # defensive; normalize_datetime already passed above
        return ToolOutcome(content="Failed to create the schedule event.", is_error=True)

    window = event["time_start"] + (f" - {event['time_end']}" if event["time_end"] else "")
    where = f" @ {event['location']}" if event["location"] else ""
    return ToolOutcome(
        content=f"Scheduled #{event['id']}: '{event['event_name']}' {window}{where}.",
        refresh={"schedule", "brief"},
        display={"id": event["id"], "event": event["event_name"], "when": window},
    )


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

@dataclass(frozen=True, slots=True)
class ToolSpec:
    name: str
    description: str
    input_schema: dict[str, Any]
    model: type[BaseModel]
    handler: Callable[[Any], Awaitable[ToolOutcome]]


_DATETIME_HINT = (
    "Absolute local datetime as YYYY-MM-DDTHH:MM:SS. Resolve relative phrases "
    "like 'tomorrow' yourself against the current date in the state block; never "
    "pass a relative phrase."
)

TOOL_REGISTRY: tuple[ToolSpec, ...] = (
    ToolSpec(
        name="add_task",
        description=(
            "Create a task on the user's task board. Call this whenever the user "
            "commits to doing something, asks to be reminded, or dumps a list of "
            "to-dos — one call per distinct task. Returns the new task's ID."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "Short imperative description of the task, e.g. 'Call the bank about the mortgage rate'.",
                },
                "due_date": {
                    "type": "string",
                    "description": f"When the task is due. {_DATETIME_HINT} Omit if the user gave no deadline.",
                },
                "priority": {
                    "type": "string",
                    "enum": ["HIGH", "MEDIUM", "LOW"],
                    "description": "HIGH for deadlines inside 48h or explicitly urgent work, LOW for someday/maybe. Defaults to MEDIUM.",
                },
                "category": {
                    "type": "string",
                    "description": "Free-form grouping label, e.g. WORK, HEALTH, FINANCE, HOME. Defaults to GENERAL.",
                },
            },
            "required": ["title"],
        },
        model=AddTaskInput,
        handler=_handle_add_task,
    ),
    ToolSpec(
        name="update_task_status",
        description=(
            "Move an existing task to a new status. Call this when the user says "
            "something is done, started, or needs reopening. The task_id must be a "
            "real ID you have seen — call get_dashboard_summary first if unsure."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "task_id": {"type": "integer", "description": "ID of the task to update."},
                "status": {
                    "type": "string",
                    "enum": ["PENDING", "IN_PROGRESS", "COMPLETED"],
                    "description": "The new status.",
                },
            },
            "required": ["task_id", "status"],
        },
        model=UpdateTaskStatusInput,
        handler=_handle_update_task_status,
    ),
    ToolSpec(
        name="get_dashboard_summary",
        description=(
            "Read the full current state: all pending and in-progress tasks with "
            "their IDs, today's schedule, the next 7 days of events, and active "
            "ideas. Call this before referencing any task or event ID you have not "
            "already seen in this conversation, or when the user asks what is on "
            "their plate."
        ),
        input_schema={"type": "object", "properties": {}, "required": []},
        model=GetDashboardSummaryInput,
        handler=_handle_get_dashboard_summary,
    ),
    ToolSpec(
        name="save_idea_or_note",
        description=(
            "Persist an idea, note, or durable fact about the user. Use category "
            "LONG_TERM / GOAL / PREFERENCE / PRIVATE to write to long-term memory "
            "(keyed on the title — re-saving the same title updates it in place); "
            "use any other category, or omit it, to file the entry as an idea card "
            "on the dashboard. Call this whenever the user says 'remember that…' or "
            "shares a project idea worth keeping."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "The key concept or idea name. Acts as the memory key, so keep it stable across updates.",
                },
                "content": {
                    "type": "string",
                    "description": "The full note body, idea description, or fact to remember.",
                },
                "category": {
                    "type": "string",
                    "description": "LONG_TERM, GOAL, PREFERENCE or PRIVATE to store as memory. Any other value (or omitted) files it as an idea card.",
                },
            },
            "required": ["title", "content"],
        },
        model=SaveIdeaOrNoteInput,
        handler=_handle_save_idea_or_note,
    ),
    ToolSpec(
        name="search_memory",
        description=(
            "Case-insensitive search across stored memories, ideas and task titles. "
            "Call this when the user refers to something from the past ('that thing "
            "I mentioned about the visa') or when you need an ID for a record you "
            "cannot see in the current state block."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Keyword or phrase to look for. Prefer one or two distinctive words over a full sentence.",
                }
            },
            "required": ["query"],
        },
        model=SearchMemoryInput,
        handler=_handle_search_memory,
    ),
    ToolSpec(
        name="generate_proactive_brief",
        description=(
            "Evaluate every open commitment — overdue tasks, imminent events, "
            "high-priority work — and produce a freshly ranked three-bullet action "
            "summary, which is also pushed to the dashboard banner. Call this when "
            "the user asks 'what's up', 'what should I focus on', or for a "
            "start-of-day briefing."
        ),
        input_schema={"type": "object", "properties": {}, "required": []},
        model=GenerateProactiveBriefInput,
        handler=_handle_generate_proactive_brief,
    ),
    ToolSpec(
        name="add_schedule_event",
        description=(
            "Put an event on the user's calendar with a concrete start time. Use "
            "this for meetings, appointments and time-blocked work — anything that "
            "occupies a slot rather than being a to-do. Use add_task instead when "
            "there is a deadline but no fixed time slot."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "event_name": {"type": "string", "description": "Name of the event."},
                "time_start": {"type": "string", "description": f"Start time. {_DATETIME_HINT}"},
                "time_end": {
                    "type": "string",
                    "description": f"End time, if known. {_DATETIME_HINT}",
                },
                "location": {"type": "string", "description": "Where it happens, if known."},
                "notes": {"type": "string", "description": "Agenda, prep notes, or context."},
            },
            "required": ["event_name", "time_start"],
        },
        model=AddScheduleEventInput,
        handler=_handle_add_schedule_event,
    ),
)

# What gets sent to the provider, in OpenAI function-calling shape (which is
# what Sarvam's /v1/chat/completions speaks). Built once, in a stable order, so
# the serialized tool block never shifts between turns.
OPENAI_TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": spec.name,
            "description": spec.description,
            "parameters": spec.input_schema,
        },
    }
    for spec in TOOL_REGISTRY
]

#: Vendor-neutral view, kept for provider implementations that want the raw
#: schema rather than the OpenAI envelope (e.g. a future Anthropic provider).
TOOL_SCHEMAS: list[dict[str, Any]] = [
    {"name": spec.name, "description": spec.description, "input_schema": spec.input_schema}
    for spec in TOOL_REGISTRY
]

_BY_NAME: dict[str, ToolSpec] = {spec.name: spec for spec in TOOL_REGISTRY}


async def execute_tool(name: str, raw_input: dict[str, Any] | None) -> ToolOutcome:
    """Validate and run one tool call. Never raises — failures come back as
    ``is_error`` outcomes so the model can recover inside the same turn."""
    spec = _BY_NAME.get(name)
    if spec is None:
        return ToolOutcome(
            content=f"Unknown tool '{name}'. Available tools: {', '.join(_BY_NAME)}.",
            is_error=True,
        )

    try:
        payload = spec.model.model_validate(raw_input or {})
    except ValidationError as exc:
        details = "; ".join(
            f"{'.'.join(str(p) for p in err['loc']) or 'input'}: {err['msg']}"
            for err in exc.errors()
        )
        return ToolOutcome(content=f"Invalid input for {name} — {details}", is_error=True)

    try:
        return await spec.handler(payload)
    except Exception as exc:  # noqa: BLE001 — tool failures must not kill the turn
        logger.exception("Tool %s failed", name)
        return ToolOutcome(content=f"{name} failed: {exc}", is_error=True)
