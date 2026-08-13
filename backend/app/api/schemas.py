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
    title: str
    category: str
    priority: Literal["HIGH", "MEDIUM", "LOW"]
    status: Literal["PENDING", "IN_PROGRESS", "COMPLETED"]
    due_date: str | None = None
    created_at: str
    updated_at: str


class ScheduleEventOut(BaseModel):
    id: int
    event_name: str
    time_start: str
    time_end: str | None = None
    location: str | None = None
    notes: str | None = None
    created_at: str


class IdeaOut(BaseModel):
    id: int
    title: str
    description: str
    tags: str
    status: Literal["DRAFT", "ACTIVE", "ARCHIVED"]
    created_at: str
    updated_at: str


class MemoryOut(BaseModel):
    id: int
    key_concept: str
    category: Literal["LONG_TERM", "GOAL", "PREFERENCE", "PRIVATE"]
    content: str
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
    generated_at: str
    counts: TaskCounts
    brief: BriefOut
    tasks: list[TaskOut]
    today: list[ScheduleEventOut]
    upcoming: list[ScheduleEventOut]
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


class VoiceConfigOut(BaseModel):
    enabled: bool
    stt_provider: str
    tts_provider: str
    language: str
    max_audio_mb: float
