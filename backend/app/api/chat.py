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

_HEARTBEAT_SECONDS = 8.0


def _frame(event_type: str, data: dict) -> str:
    return f"event: {event_type}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


async def _agent_events(message: str) -> AsyncIterator[dict]:
    """Yield agent events plus visible keepalives during a slow provider call."""
    iterator = run_turn(message).__aiter__()
    pending: asyncio.Task | None = None
    try:
        while True:
            pending = asyncio.create_task(anext(iterator))
            while True:
                try:
                    event = await asyncio.wait_for(
                        asyncio.shield(pending), timeout=_HEARTBEAT_SECONDS
                    )
                    break
                except asyncio.TimeoutError:
                    yield {
                        "type": "progress",
                        "data": {"message": "Still working on the full response…"},
                    }
            pending = None
            yield event
    except StopAsyncIteration:
        return
    finally:
        if pending is not None and not pending.done():
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
        await iterator.aclose()


async def _event_stream(message: str, request: Request) -> AsyncIterator[str]:
    terminal_sent = False
    try:
        async with asyncio.timeout(settings.jarvis_chat_turn_timeout):
            async for event in _agent_events(message):
                if await request.is_disconnected():
                    logger.info("Client disconnected mid-turn; abandoning stream.")
                    return
                terminal_sent = terminal_sent or event["type"] == "done"
                yield _frame(event["type"], event.get("data", {}))
    except TimeoutError:
        logger.warning(
            "Chat turn exceeded %.0fs; closing stream", settings.jarvis_chat_turn_timeout
        )
        yield _frame(
            "error",
            {
                "message": (
                    "Sarvam did not finish this turn in time. Any tool changes already "
                    "shown were saved; review them before retrying."
                )
            },
        )
    except asyncio.CancelledError:  # client went away
        raise
    except Exception as exc:  # noqa: BLE001 — never leak a traceback into the stream
        logger.exception("Chat stream failed")
        yield _frame("error", {"message": f"Unexpected server error: {exc}"})

    # `run_turn` historically returned immediately after provider/configuration
    # errors. The HTTP body eventually closed, but clients had no explicit
    # terminal frame and some WebViews kept the composer in its working state.
    if not terminal_sent and not await request.is_disconnected():
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
