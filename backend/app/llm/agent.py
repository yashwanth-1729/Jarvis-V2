"""The JARVIS agent loop.

Streams a single user turn to completion: text deltas, reasoning, tool
executions and their results all come back as a flat sequence of events that
the API layer forwards to the browser as SSE.

The loop is provider-neutral — it speaks the OpenAI-shaped message format
defined in `app.providers.base` and never imports a vendor SDK directly, so
switching chat providers (v3) touches only the provider module.

Two robustness properties matter here:

* **Never leaves a dangling tool call.** Every ``tool_call`` the model emits
  gets exactly one matching ``tool`` message, even when the handler throws,
  because ``execute_tool`` converts failures into error outcomes.
* **Never replays a broken history.** Slicing a conversation mid tool-cycle
  would leave a ``tool`` message with no preceding ``tool_calls``, which the
  API rejects — so history is trimmed at safe boundaries only.
"""

from __future__ import annotations

import json
import logging
from typing import Any, AsyncIterator

from app.core.config import settings
from app.db import crud
from app.llm.prompts import CONTEXT_PREAMBLE, SYSTEM_PROMPT
from app.llm.tools import OPENAI_TOOLS, execute_tool
from app.providers import get_chat_provider
from app.providers.base import ProviderError
from app.services.context import build_context_snapshot

logger = logging.getLogger("jarvis.agent")


# ---------------------------------------------------------------------------
# History
# ---------------------------------------------------------------------------

def _has_tool_role(message: dict[str, Any]) -> bool:
    return message.get("role") == "tool"


def _trim_to_safe_boundary(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop leading messages until the history starts on a real user turn.

    A ``tool`` message whose originating ``tool_calls`` were trimmed away is a
    400 from any OpenAI-compatible endpoint.
    """
    for index, message in enumerate(messages):
        if message.get("role") == "user" and not _has_tool_role(message):
            return messages[index:]
    return []


def _repair_tool_arguments(message: dict[str, Any]) -> dict[str, Any]:
    """Normalize any stored tool-call arguments so the turn survives replay.

    Belt-and-braces for history written before arguments were normalized on the
    write path: a single malformed blob otherwise 400s every future request in
    the conversation, with no way out but clearing the transcript.
    """
    calls = message.get("tool_calls")
    if not isinstance(calls, list):
        return message

    repaired = []
    for call in calls:
        function = dict(call.get("function") or {})
        parsed, error = _parse_arguments(function.get("arguments") or "")
        if error is not None:
            logger.warning(
                "Repairing malformed stored arguments for tool %r", function.get("name")
            )
        function["arguments"] = json.dumps(parsed if parsed is not None else {})
        repaired.append({**call, "function": function})

    return {**message, "tool_calls": repaired}


async def _load_history() -> list[dict[str, Any]]:
    rows = await crud.recent_chat_messages(settings.jarvis_history_limit)
    messages: list[dict[str, Any]] = []
    for row in rows:
        payload = row.get("blocks")
        # Rows written by an earlier provider format are skipped rather than
        # replayed into a shape the current provider cannot parse.
        if isinstance(payload, dict) and payload.get("role"):
            messages.append(_repair_tool_arguments(payload))
        elif row["text"].strip():
            messages.append({"role": row["role"], "content": row["text"]})
    return _trim_to_safe_boundary(messages)


async def _build_system_message() -> dict[str, Any]:
    snapshot = await build_context_snapshot()
    return {
        "role": "system",
        "content": f"{SYSTEM_PROMPT}\n\n{CONTEXT_PREAMBLE}\n\n{snapshot}",
    }


def _parse_arguments(raw: str) -> tuple[dict[str, Any] | None, str | None]:
    """Parse a tool-call argument blob, returning (args, error)."""
    if not raw or not raw.strip():
        return {}, None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        return None, f"arguments were not valid JSON ({exc.msg})"
    if not isinstance(parsed, dict):
        return None, "arguments must be a JSON object"
    return parsed, None


def _assistant_message(
    content: str, calls: list[tuple[Any, dict[str, Any] | None]]
) -> dict[str, Any]:
    """Serialize an assistant turn back into the wire format.

    ``arguments`` is re-serialized from the *parsed* value rather than echoed
    verbatim. A truncated or malformed argument blob (the model running out of
    budget mid-call, say) is rejected by the API on every subsequent request
    once it is in the history — which would poison the conversation
    permanently. Normalising here keeps the transcript replayable; the model
    still learns the call failed from its tool message.
    """
    message: dict[str, Any] = {"role": "assistant", "content": content or ""}
    if calls:
        message["tool_calls"] = [
            {
                "id": call.id,
                "type": "function",
                "function": {
                    "name": call.name,
                    "arguments": json.dumps(arguments if arguments is not None else {}),
                },
            }
            for call, arguments in calls
        ]
    return message


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

async def run_turn(user_message: str) -> AsyncIterator[dict[str, Any]]:
    """Execute one user turn, yielding events as they happen."""
    user_text = user_message.strip()
    if not user_text:
        yield {"type": "error", "data": {"message": "Empty message."}}
        return

    user_payload = {"role": "user", "content": user_text}
    await crud.append_chat_message("user", user_text, user_payload)

    try:
        provider = get_chat_provider()
    except ProviderError as exc:
        yield {"type": "error", "data": {"message": str(exc)}}
        return

    history = await _load_history()
    messages: list[dict[str, Any]] = [await _build_system_message(), *history]

    refreshed: set[str] = set()
    assistant_text_parts: list[str] = []
    usage_total: dict[str, int] = {}
    finish_reason: str | None = None

    yield {"type": "start", "data": {"model": provider.model, "provider": provider.name}}

    try:
        for _ in range(settings.jarvis_max_tool_iterations):
            # Tool-call ids are assigned by the provider during streaming; the
            # UI keys its execution log on them.
            async for chunk in provider.stream(messages, OPENAI_TOOLS):
                if chunk.kind == "text":
                    yield {"type": "text", "data": {"text": chunk.text}}
                elif chunk.kind == "reasoning":
                    yield {"type": "thinking", "data": {"text": chunk.text}}
                elif chunk.kind == "tool_call_started" and chunk.tool_call:
                    yield {
                        "type": "tool_use",
                        "data": {"id": chunk.tool_call.id, "name": chunk.tool_call.name},
                    }

            result = provider.last_result()
            finish_reason = result.finish_reason

            for key, value in (result.usage or {}).items():
                usage_total[key] = usage_total.get(key, 0) + value

            if result.content:
                assistant_text_parts.append(result.content)

            # Parse before serializing the assistant turn, so the history only
            # ever contains argument blobs the API will accept on replay.
            parsed_calls = [
                (call, *_parse_arguments(call.arguments)) for call in result.tool_calls
            ]

            assistant = _assistant_message(
                result.content, [(call, args) for call, args, _ in parsed_calls]
            )
            await crud.append_chat_message("assistant", result.content, assistant)
            messages.append(assistant)

            if not result.tool_calls:
                if finish_reason == "length" and not result.content:
                    # Reasoning consumed the whole budget before any visible
                    # text — say so rather than showing an empty reply.
                    yield {
                        "type": "error",
                        "data": {
                            "message": (
                                "The model used its entire token budget on reasoning "
                                "before answering. Raise JARVIS_MAX_TOKENS in "
                                "backend/.env (currently "
                                f"{settings.jarvis_max_tokens})."
                            )
                        },
                    }
                break

            for call, arguments, parse_error in parsed_calls:
                if parse_error is not None:
                    outcome_text = f"{call.name} was called with invalid input — {parse_error}."
                    ok = False
                else:
                    outcome = await execute_tool(call.name, arguments)
                    outcome_text = outcome.content
                    ok = not outcome.is_error
                    refreshed |= outcome.refresh

                yield {
                    "type": "tool_result",
                    "data": {
                        "id": call.id,
                        "name": call.name,
                        "ok": ok,
                        "summary": outcome_text[:600],
                        "display": None if parse_error else outcome.display,
                    },
                }
                if not parse_error and outcome.refresh:
                    yield {"type": "refresh", "data": {"domains": sorted(outcome.refresh)}}

                tool_message = {
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": outcome_text,
                }
                await crud.append_chat_message("user", "", tool_message)
                messages.append(tool_message)
        else:
            yield {
                "type": "error",
                "data": {
                    "message": (
                        f"Stopped after {settings.jarvis_max_tool_iterations} tool rounds "
                        "to avoid a runaway loop. Ask me to continue if that was premature."
                    )
                },
            }

    except ProviderError as exc:
        yield {"type": "error", "data": {"message": str(exc)}}
        return
    except Exception as exc:  # noqa: BLE001
        logger.exception("Agent turn failed")
        yield {"type": "error", "data": {"message": f"Agent failure: {exc}"}}
        return

    yield {
        "type": "done",
        "data": {
            "stop_reason": finish_reason,
            "refresh": sorted(refreshed),
            "usage": usage_total,
            "text": "".join(assistant_text_parts),
        },
    }
