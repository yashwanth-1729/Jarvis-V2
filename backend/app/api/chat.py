"""POST /api/chat — Server-Sent Events stream of one agent turn.

Wire format (one SSE frame per agent event):

    event: text
    data: {"text": "Added "}

Event types: ``start``, ``text``, ``thinking``, ``tool_use``, ``tool_result``,
``refresh``, ``error``, ``done``.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import AsyncIterator

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from app.api.schemas import ChatMessageOut, ChatRequest
from app.core.config import settings
from app.db import crud
from app.llm.agent import run_turn

logger = logging.getLogger("jarvis.api.chat")

router = APIRouter(prefix="/api/chat", tags=["chat"])

SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    # Stops nginx and friends from buffering the stream into oblivion.
    "X-Accel-Buffering": "no",
}


def _frame(event_type: str, data: dict) -> str:
    return f"event: {event_type}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


async def _event_stream(message: str, request: Request) -> AsyncIterator[str]:
    try:
        async for event in run_turn(message):
            if await request.is_disconnected():
                logger.info("Client disconnected mid-turn; abandoning stream.")
                return
            yield _frame(event["type"], event.get("data", {}))
    except asyncio.CancelledError:  # client went away
        raise
    except Exception as exc:  # noqa: BLE001 — never leak a traceback into the stream
        logger.exception("Chat stream failed")
        yield _frame("error", {"message": f"Unexpected server error: {exc}"})
        yield _frame("done", {"stop_reason": "error", "refresh": [], "usage": {}})


@router.post("")
async def chat(payload: ChatRequest, request: Request) -> StreamingResponse:
    return StreamingResponse(
        _event_stream(payload.message, request),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )


@router.get("/history", response_model=list[ChatMessageOut])
async def history(limit: int = 100) -> list[ChatMessageOut]:
    """Replay the visible conversation so a browser refresh does not lose it.

    Only user text and assistant prose are returned — tool-result turns are
    stored for model replay but are not part of the readable transcript.
    """
    bounded = max(1, min(limit, settings.jarvis_history_limit * 10))
    rows = await crud.recent_chat_messages(bounded)
    return [
        ChatMessageOut(
            id=row["id"], role=row["role"], text=row["text"], created_at=row["created_at"]
        )
        for row in rows
        if row["text"].strip()
    ]


@router.delete("/history", status_code=204)
async def clear_history() -> None:
    await crud.clear_chat_history()
