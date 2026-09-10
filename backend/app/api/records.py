"""Direct editing of the boards, without going through the agent.

Everything on screen was previously read-only unless you talked to JARVIS about
it. That is fine for "add a task to call the dentist" and absurd for fixing a
typo, so this exposes the same four stores the tools operate on:

    tasks  ·  schedules  ·  ideas  ·  memories

Deliberately the *same* `crud` functions the tool handlers call, not a parallel
implementation. The rules about what an edit means — completing a task removes
it from the board, a delete leaves a tombstone so sync cannot resurrect it,
priorities coerce rather than reject — have to hold identically whether the
change came from a person or the model. Two implementations would drift, and
the drift would only show up days later as a row that came back from the dead.

Only meaningful on desktop. When the client owns the data (mobile) the frontend
writes to IndexedDB directly and never calls these; see
`frontend/src/lib/localMutations.ts`, which mirrors the same semantics for the
same reason.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from app.api.schemas import (
    IdeaCreate,
    IdeaOut,
    IdeaUpdate,
    MemoryCreate,
    MemoryOut,
    MemoryUpdate,
    NotePageSave,
    ScheduleEventCreate,
    ScheduleEventOut,
    ScheduleEventUpdate,
    TaskCreate,
    TaskOut,
    TaskUpdate,
)
from app.db import crud
from app.db.database import db

logger = logging.getLogger("jarvis.api.records")

router = APIRouter(prefix="/api", tags=["records"])


def _present(payload, *, drop: set[str] = frozenset()) -> dict:
    """Only the fields the caller actually sent.

    `exclude_unset` is what makes a partial update partial: without it, every
    unmentioned field arrives as None and a rename would blank the rest of the
    record.
    """
    return {
        key: value
        for key, value in payload.model_dump(exclude_unset=True).items()
        if key not in drop
    }



#: Path identifier -> table, for the uid resolver below.
_TABLES = {"task": "tasks", "event": "schedules", "idea": "ideas", "memory": "memories"}


async def _rowid(kind: str, ident: str) -> int:
    """Resolve a path identifier that may be a uid or a rowid.

    A rowid is not a stable name for a record here, and treating it as one
    produced a bug that looked impossible: deleting a task you were looking at
    answered "No task with id N."

    The reason is the client-owned-data working copy. Seeding it runs
    ``DELETE FROM tasks`` followed by an INSERT of the synced columns -- and
    ``SYNC_COLUMNS`` does not include ``id``, so SQLite assigns brand new
    rowids every single time. Seeding happens on launch and after every hand
    edit; one device log showed twenty reseeds in two days. Any screen holding
    an id from before a reseed is addressing a number that has since moved to a
    different row, or to no row at all.

    ``uid`` is the identity that survives, so the client now sends that and this
    turns it back into whatever rowid the working copy currently uses. Plain
    integers still work unchanged, which keeps the desktop and the existing
    tests on exactly the path they were on.
    """
    text = str(ident).strip()
    table = _TABLES[kind]

    if text.isdigit():
        return int(text)

    row = await db.fetch_one(f"SELECT id FROM {table} WHERE uid = ?", (text,))
    if row is None:
        raise HTTPException(404, f"No {kind} with uid {text}.")
    return int(row["id"])


# --- tasks -----------------------------------------------------------------

@router.post("/tasks", response_model=TaskOut, status_code=201)
async def create_task(payload: TaskCreate) -> TaskOut:
    task = await crud.create_task(
        title=payload.title,
        due_date=payload.due_date,
        priority=payload.priority,
        category=payload.category,
    )
    return TaskOut(**task)


@router.patch("/tasks/{task_id}", response_model=TaskOut)
async def update_task(task_id: str, payload: TaskUpdate) -> TaskOut:
    fields = _present(payload, drop={"clear_due_date"})
    if payload.clear_due_date:
        fields["due_date"] = None

    change = await crud.update_task(await _rowid("task", task_id), **fields)
    if change.task is None:
        raise HTTPException(404, f"No task with id {task_id}.")
    if change.cleared:
        # Completing removes the task, so there is no row left to return. Say
        # so plainly rather than handing back a record that no longer exists.
        raise HTTPException(
            409,
            f"'{change.task['title']}' was completed and cleared off the board.",
        )
    return TaskOut(**change.task)


@router.delete("/tasks/{task_id}", status_code=204)
async def delete_task(task_id: str) -> None:
    if await crud.delete_task(await _rowid("task", task_id)) is None:
        raise HTTPException(404, f"No task with id {task_id}.")


# --- schedule --------------------------------------------------------------

@router.post("/schedule", response_model=ScheduleEventOut, status_code=201)
async def create_event(payload: ScheduleEventCreate) -> ScheduleEventOut:
    event = await crud.create_schedule_event(**payload.model_dump())
    return ScheduleEventOut(**event)


@router.patch("/schedule/{event_id}", response_model=ScheduleEventOut)
async def update_event(event_id: str, payload: ScheduleEventUpdate) -> ScheduleEventOut:
    event = await crud.update_schedule_event(await _rowid("event", event_id), **_present(payload))
    if event is None:
        raise HTTPException(404, f"No schedule event with id {event_id}.")
    return ScheduleEventOut(**event)


@router.delete("/schedule/{event_id}", status_code=204)
async def delete_event(event_id: str) -> None:
    if await crud.delete_schedule_event(await _rowid("event", event_id)) is None:
        raise HTTPException(404, f"No schedule event with id {event_id}.")


# --- ideas -----------------------------------------------------------------

@router.post("/ideas", response_model=IdeaOut, status_code=201)
async def create_idea(payload: IdeaCreate) -> IdeaOut:
    idea = await crud.create_idea(
        title=payload.title,
        description=payload.description,
        tags=payload.tags,
        status=payload.status,
        page_uid=payload.page_uid,
    )
    return IdeaOut(**idea)


@router.patch("/ideas/{idea_id}", response_model=IdeaOut)
async def update_idea(idea_id: str, payload: IdeaUpdate) -> IdeaOut:
    idea = await crud.update_idea(await _rowid("idea", idea_id), **_present(payload))
    if idea is None:
        raise HTTPException(404, f"No idea with id {idea_id}.")
    return IdeaOut(**idea)


@router.delete("/ideas/{idea_id}", status_code=204)
async def delete_idea(idea_id: str) -> None:
    if await crud.delete_idea(await _rowid("idea", idea_id)) is None:
        raise HTTPException(404, f"No idea with id {idea_id}.")


# --- memories --------------------------------------------------------------

@router.post("/memories", response_model=MemoryOut, status_code=201)
async def create_memory(payload: MemoryCreate) -> MemoryOut:
    # upsert, not insert: memories are keyed by concept, and saving the same
    # concept twice should correct it rather than leave two contradictory rows
    # for the model to pick between.
    memory = await crud.upsert_memory(
        key_concept=payload.key_concept,
        content=payload.content,
        category=payload.category,
        expires_at=payload.expires_at,
        memory_type=payload.memory_type,
        memory_status=payload.memory_status,
        confidence=payload.confidence,
        importance=payload.importance,
        pinned=payload.pinned,
        tags=payload.tags,
    )
    return MemoryOut(**memory)


@router.patch("/memories/{memory_id}", response_model=MemoryOut)
async def update_memory(memory_id: str, payload: MemoryUpdate) -> MemoryOut:
    memory = await crud.update_memory(await _rowid("memory", memory_id), **_present(payload))
    if memory is None:
        raise HTTPException(404, f"No memory with id {memory_id}.")
    return MemoryOut(**memory)


@router.delete("/memories/{memory_id}", status_code=204)
async def delete_memory(memory_id: str) -> None:
    if await crud.delete_memory(await _rowid("memory", memory_id)) is None:
        raise HTTPException(404, f"No memory with id {memory_id}.")


@router.post("/note-pages")
async def save_note_page(payload: NotePageSave) -> dict:
    if not payload.title.strip():
        raise HTTPException(422, "Give this page a name.")
    return await crud.save_note_page(payload.uid, payload.title, payload.kind)


@router.delete("/note-pages/{page_uid}", status_code=204)
async def delete_note_page(page_uid: str) -> None:
    if not await crud.delete_note_page(page_uid):
        raise HTTPException(404, "Only custom Notes pages can be deleted.")
