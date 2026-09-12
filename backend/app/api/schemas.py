"""Request/response models shared by the API routers.

These mirror `frontend/src/types/index.ts` — keep the two in sync.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=20_000)


class ChatMessageOut(BaseModel):
    id: int
    role: Literal["user", "assistant"]
    text: str
    created_at: str


class TaskOut(BaseModel):
    id: int
    #: The sync identity, and the only identity that survives a reseed.
    #:
    #: On a client-owned-data device the working copy is rebuilt by DELETE +
    #: INSERT without ids, so SQLite hands out fresh rowids every time -- and
    #: that happens on launch and after every hand edit. A screen still holding
    #: a pre-reseed `id` then addresses a row that no longer carries that
    #: number, and deleting it answers "No task with id N" about a record
    #: sitting in plain sight. `uid` does not move.
    uid: str | None = None
    title: str
    category: str
    priority: Literal["HIGH", "MEDIUM", "LOW"]
    status: Literal["PENDING", "IN_PROGRESS", "COMPLETED"]
    due_date: str | None = None
    created_at: str
    updated_at: str


class ScheduleEventOut(BaseModel):
    id: int
    #: The sync identity, and the only identity that survives a reseed.
    #:
    #: On a client-owned-data device the working copy is rebuilt by DELETE +
    #: INSERT without ids, so SQLite hands out fresh rowids every time -- and
    #: that happens on launch and after every hand edit. A screen still holding
    #: a pre-reseed `id` then addresses a row that no longer carries that
    #: number, and deleting it answers "No task with id N" about a record
    #: sitting in plain sight. `uid` does not move.
    uid: str | None = None
    event_name: str
    #: COLLEGE and ROUTINE recur weekly and carry day_of_week + start_time;
    #: SESSION is a one-off and carries time_start.
    kind: Literal["COLLEGE", "ROUTINE", "SESSION"] = "SESSION"
    time_start: str | None = None
    time_end: str | None = None
    day_of_week: int | None = None
    start_time: str | None = None
    end_time: str | None = None
    location: str | None = None
    notes: str | None = None
    created_at: str
    #: Server-rendered display fields, so the client never has to branch on kind.
    day_name: str = ""
    display_start: str = ""
    display_end: str = ""
    window: str = ""


class ScheduleConflictOut(BaseModel):
    a_id: int
    b_id: int
    a_label: str
    b_label: str
    detail: str


class GroupedScheduleOut(BaseModel):
    """The schedule tab's three sections."""

    college: list[ScheduleEventOut] = Field(default_factory=list)
    routine: list[ScheduleEventOut] = Field(default_factory=list)
    session: list[ScheduleEventOut] = Field(default_factory=list)
    #: Overlapping pairs, so the UI can flag double-bookings.
    conflicts: list[ScheduleConflictOut] = Field(default_factory=list)


class IdeaOut(BaseModel):
    page_uid: str | None = None
    id: int
    #: The sync identity, and the only identity that survives a reseed.
    #:
    #: On a client-owned-data device the working copy is rebuilt by DELETE +
    #: INSERT without ids, so SQLite hands out fresh rowids every time -- and
    #: that happens on launch and after every hand edit. A screen still holding
    #: a pre-reseed `id` then addresses a row that no longer carries that
    #: number, and deleting it answers "No task with id N" about a record
    #: sitting in plain sight. `uid` does not move.
    uid: str | None = None
    title: str
    description: str
    tags: str
    status: Literal["DRAFT", "ACTIVE", "ARCHIVED"]
    created_at: str
    updated_at: str


class MemoryOut(BaseModel):
    expires_at: str | None = None
    id: int
    #: The sync identity, and the only identity that survives a reseed.
    #:
    #: On a client-owned-data device the working copy is rebuilt by DELETE +
    #: INSERT without ids, so SQLite hands out fresh rowids every time -- and
    #: that happens on launch and after every hand edit. A screen still holding
    #: a pre-reseed `id` then addresses a row that no longer carries that
    #: number, and deleting it answers "No task with id N" about a record
    #: sitting in plain sight. `uid` does not move.
    uid: str | None = None
    key_concept: str
    category: str
    content: str
    memory_type: Literal["WORKING", "EPISODIC", "SEMANTIC", "PROCEDURAL", "PROSPECTIVE", "REFLECTIVE"] = "SEMANTIC"
    memory_status: Literal["ACTIVE", "CANDIDATE", "SUPERSEDED", "ARCHIVED"] = "ACTIVE"
    confidence: float = 1.0
    importance: float = 0.65
    source_kind: str = "explicit"
    source_ref: str | None = None
    valid_from: str | None = None
    supersedes_uid: str | None = None
    pinned: bool = False
    evidence_count: int = 1
    tags: list[str] = Field(default_factory=list)
    revision_count: int = 0
    created_at: str
    updated_at: str


class BriefOut(BaseModel):
    id: int | None = None
    summary_text: str
    urgent_count: int
    generated_at: str | None = None
    bullets: list[str] = Field(default_factory=list)


class TaskCounts(BaseModel):
    PENDING: int = 0
    IN_PROGRESS: int = 0
    COMPLETED: int = 0
    OVERDUE: int = 0


class DashboardOut(BaseModel):
    note_pages: list[dict] = Field(default_factory=list)
    generated_at: str
    counts: TaskCounts
    brief: BriefOut
    tasks: list[TaskOut]
    today: list[ScheduleEventOut]
    upcoming: list[ScheduleEventOut]
    #: The same entries bucketed into the three kinds, for the schedule tab.
    schedule: GroupedScheduleOut = Field(default_factory=GroupedScheduleOut)
    ideas: list[IdeaOut]
    memories: list[MemoryOut]


class ToggleTaskRequest(BaseModel):
    task_id: int = Field(ge=1)
    status: Literal["PENDING", "IN_PROGRESS", "COMPLETED"] | None = Field(
        default=None,
        description="Target status. Omit to cycle PENDING -> IN_PROGRESS -> COMPLETED -> PENDING.",
    )


class ToggleTaskResponse(BaseModel):
    task: TaskOut
    #: True when completing the task removed it from the board, so the client
    #: should drop the row rather than re-render it as done.
    cleared: bool = False
    counts: TaskCounts
    brief: BriefOut


class HealthOut(BaseModel):
    status: Literal["ok"]
    version: str
    model: str
    database: str
    api_key_configured: bool
    details: dict[str, Any] = Field(default_factory=dict)


# --- Voice -----------------------------------------------------------------

class SpeakRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    language_code: str | None = None


class TranscriptOut(BaseModel):
    text: str
    language_code: str | None = None
    confidence: float | None = None


class LanguageOut(BaseModel):
    code: str
    label: str
    native: str


class LanguageStateOut(LanguageOut):
    pass


class SetLanguageRequest(BaseModel):
    language: str = Field(min_length=2, max_length=16)


class SentinelReplyOut(BaseModel):
    """What the native daemon gets back after handing over an utterance."""

    heard: str
    reply: str
    spoke: bool


class VoiceOut(BaseModel):
    id: str
    label: str
    gender: Literal["female", "male"]
    note: str


class SetVoiceRequest(BaseModel):
    voice: str = Field(min_length=2, max_length=40)


class VoiceConfigOut(BaseModel):
    enabled: bool
    stt_provider: str
    tts_provider: str
    #: Current spoken-output language (BCP-47). Speech input is always
    #: auto-detected, so this governs replies only.
    language: str
    max_audio_mb: float
    languages: list[LanguageOut] = Field(default_factory=list)
    #: Currently selected speaking voice.
    voice: str = ""
    voices: list[VoiceOut] = Field(default_factory=list)


# --- Direct editing ---------------------------------------------------------
#
# The agent could always create and change these; a person looking at the board
# could not. Every field is optional on update so a rename does not have to
# resend a whole record, and so "clear the deadline" stays expressible —
# `due_date: null` means remove it, while omitting the key means leave it.

class TaskCreate(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    due_date: str | None = None
    priority: Literal["HIGH", "MEDIUM", "LOW"] = "MEDIUM"
    category: str | None = None


class TaskUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=300)
    due_date: str | None = None
    #: True clears the deadline. Needed because `due_date: null` is
    #: indistinguishable from "not supplied" once it reaches the handler.
    clear_due_date: bool = False
    priority: Literal["HIGH", "MEDIUM", "LOW"] | None = None
    category: str | None = None
    status: Literal["PENDING", "IN_PROGRESS", "COMPLETED"] | None = None


class ScheduleEventCreate(BaseModel):
    event_name: str = Field(min_length=1, max_length=300)
    kind: Literal["COLLEGE", "ROUTINE", "SESSION"] = "SESSION"
    day_of_week: int | None = Field(default=None, ge=0, le=6)
    start_time: str | None = None
    end_time: str | None = None
    time_start: str | None = None
    time_end: str | None = None
    location: str | None = None
    notes: str | None = None


class ScheduleEventUpdate(BaseModel):
    event_name: str | None = Field(default=None, min_length=1, max_length=300)
    kind: Literal["COLLEGE", "ROUTINE", "SESSION"] | None = None
    day_of_week: int | None = Field(default=None, ge=0, le=6)
    start_time: str | None = None
    end_time: str | None = None
    time_start: str | None = None
    time_end: str | None = None
    location: str | None = None
    notes: str | None = None


class IdeaCreate(BaseModel):
    page_uid: str | None = None
    title: str = Field(min_length=1, max_length=300)
    description: str = ""
    tags: str = ""
    status: Literal["DRAFT", "ACTIVE", "ARCHIVED"] = "DRAFT"


class IdeaUpdate(BaseModel):
    page_uid: str | None = None
    title: str | None = Field(default=None, min_length=1, max_length=300)
    description: str | None = None
    tags: str | None = None
    status: Literal["DRAFT", "ACTIVE", "ARCHIVED"] | None = None


class MemoryCreate(BaseModel):
    expires_at: str | None = None
    key_concept: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1)
    category: Literal["LONG_TERM", "GOAL", "PREFERENCE"] = "LONG_TERM"
    memory_type: Literal["WORKING", "EPISODIC", "SEMANTIC", "PROCEDURAL", "PROSPECTIVE", "REFLECTIVE"] | None = None
    memory_status: Literal["ACTIVE", "CANDIDATE"] = "ACTIVE"
    confidence: float = Field(default=1.0, ge=0, le=1)
    importance: float = Field(default=0.65, ge=0, le=1)
    pinned: bool = False
    tags: list[str] = Field(default_factory=list)


class MemoryUpdate(BaseModel):
    expires_at: str | None = None
    key_concept: str | None = Field(default=None, min_length=1, max_length=200)
    content: str | None = Field(default=None, min_length=1)
    category: Literal["LONG_TERM", "GOAL", "PREFERENCE"] | None = None
    memory_type: Literal["WORKING", "EPISODIC", "SEMANTIC", "PROCEDURAL", "PROSPECTIVE", "REFLECTIVE"] | None = None
    memory_status: Literal["ACTIVE", "CANDIDATE", "SUPERSEDED", "ARCHIVED"] | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)
    importance: float | None = Field(default=None, ge=0, le=1)
    pinned: bool | None = None
    tags: list[str] | None = None


class NotePageSave(BaseModel):
    uid: str | None = Field(default=None, max_length=100)
    title: str = Field(min_length=1, max_length=80)
    kind: Literal["LONG_TERM", "TEMPORARY", "OTHER", "CUSTOM"] = "CUSTOM"


# --- Reminders and announcements -------------------------------------------

class ReminderCreate(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    due_at: str


class ReminderUpdate(BaseModel):
    text: str | None = Field(default=None, min_length=1, max_length=500)
    due_at: str | None = None


class ReminderOut(BaseModel):
    id: int
    text: str
    due_at: str
    #: The exact moment this early-notice row stands in for, e.g. a 5pm class
    #: when `due_at` is 4:45pm. None for an instant reminder and for the
    #: exact-time row of a default one -- both just speak `text` plain.
    target_at: str | None = None
    created_at: str
    fired_at: str | None = None


class AnnouncementOut(BaseModel):
    id: int
    #: 'reminder' | 'schedule' | 'task'
    kind: str
    ref_id: int | None = None
    occurrence_at: str
    text: str
    urgency: int
    created_at: str
    delivered_at: str | None = None


class AnnouncementsResponse(BaseModel):
    announcements: list[AnnouncementOut] = Field(default_factory=list)


class AcknowledgeRequest(BaseModel):
    ids: list[int] = Field(default_factory=list, max_length=100)
