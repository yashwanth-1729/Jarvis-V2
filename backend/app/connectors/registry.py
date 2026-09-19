"""Live connectors, exposed to the agent as ordinary ``ToolSpec`` tools.

The client hands over definitions and decrypted secrets (``configure``); this
module connects, lists MCP tools, and builds the specs. ``tools.py`` appends
``specs()`` to its registry and asks ``lookup()`` for names it does not own.

Specs are rebuilt only on ``configure``, in a stable order, so the tool block
stays byte-identical between turns (the prompt cache depends on it).
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.connectors import google as g
from app.connectors.mcp_client import McpError, McpTool, ServerConfig, open_session
from app.core.config import settings

logger = logging.getLogger("jarvis.connectors")


# --------------------------------------------------------------------------- state
@dataclass(slots=True)
class McpServerState:
    config: ServerConfig
    session: Any = None
    tools: list[McpTool] = field(default_factory=list)
    error: str = ""


_google: g.GoogleConnector | None = None
_google_error: str = ""
_servers: dict[str, McpServerState] = {}
_specs: tuple = ()
_by_name: dict[str, Any] = {}
_routes: list[tuple[re.Pattern[str], frozenset[str]]] = []
#: server id -> OAuth bundle refreshed since the client last collected it.
_rotated: dict[str, dict[str, Any]] = {}
_lock = asyncio.Lock()


# ------------------------------------------------------------------- tool inputs
class _Search(BaseModel):
    query: str = Field(min_length=1, max_length=300)
    limit: int = Field(default=8, ge=1, le=20)


class _MessageId(BaseModel):
    message_id: str = Field(min_length=1, max_length=200)


class _Compose(BaseModel):
    to: str = Field(min_length=3, max_length=500)
    subject: str = Field(default="", max_length=300)
    body: str = Field(min_length=1, max_length=20000)
    cc: str = Field(default="", max_length=500)


class _Send(_Compose):
    confirmed: bool = False


class _Range(BaseModel):
    start: str
    end: str
    query: str = ""


class _CreateEvent(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    start: str
    end: str
    location: str = ""
    description: str = ""
    attendees: list[str] = Field(default_factory=list)
    confirmed: bool = False


class _DeleteEvent(BaseModel):
    event_id: str = Field(min_length=1, max_length=300)
    confirmed: bool = False


class _FileId(BaseModel):
    file_id: str = Field(min_length=1, max_length=300)


class _AnyInput(BaseModel):
    """MCP tools bring their own JSON schema; the server validates arguments."""
    model_config = ConfigDict(extra="allow")


def _schema(model: type[BaseModel]) -> dict[str, Any]:
    schema = model.model_json_schema()
    schema.pop("title", None)
    for prop in (schema.get("properties") or {}).values():
        prop.pop("title", None)
    return schema


_DT = "Local datetime YYYY-MM-DDTHH:MM:SS."


# ----------------------------------------------------------------- google specs
def _google_specs() -> list[Any]:
    from app.llm.tools import ToolOutcome, ToolSpec

    connector = _google
    if connector is None:
        return []

    def wrap(fn):
        async def handler(payload: Any) -> ToolOutcome:
            try:
                return ToolOutcome(content=await fn(payload))
            except g.GoogleError as exc:
                return ToolOutcome(content=str(exc), is_error=True)
        return handler

    specs: list[Any] = []
    if "gmail" in connector.services:
        async def send(p: _Send) -> str:
            if not p.confirmed:
                return (
                    "NOT SENT. Read this back to the user and ask for a yes: "
                    f"email to {p.to}{' cc ' + p.cc if p.cc else ''}, subject {p.subject!r}, "
                    f"saying: {p.body[:400]!r}. Only after they agree, call gmail_send again "
                    "with the same fields and confirmed=true."
                )
            return await connector.gmail_send(p.to, p.subject, p.body, p.cc)

        specs += [
            ToolSpec("gmail_search", "Search the user's Gmail. Uses Gmail search syntax "
                     "(from:, subject:, is:unread, newer_than:2d). Returns ids, senders, subjects, snippets.",
                     _schema(_Search), _Search,
                     wrap(lambda p: connector.gmail_search(p.query, p.limit)), "connector", "low"),
            ToolSpec("gmail_read", "Read one Gmail message in full by id (from gmail_search).",
                     _schema(_MessageId), _MessageId,
                     wrap(lambda p: connector.gmail_read(p.message_id)), "connector", "low"),
            ToolSpec("gmail_draft", "Save an email as a Gmail draft. Nothing is sent. Prefer this "
                     "when the user wants to review before sending.",
                     _schema(_Compose), _Compose,
                     wrap(lambda p: connector.gmail_draft(p.to, p.subject, p.body, p.cc)), "connector", "medium"),
            ToolSpec("gmail_send", "Send an email from the user's Gmail. First call without "
                     "confirmed to get the read-back; send only after the user says yes.",
                     _schema(_Send), _Send, wrap(send), "connector", "high"),
        ]
    if "calendar" in connector.services:
        async def create(p: _CreateEvent) -> str:
            if p.attendees and not p.confirmed:
                return (
                    f"NOT CREATED. This invites {', '.join(p.attendees)} -- they will get an email. "
                    f"Confirm with the user: {p.title!r} {p.start} to {p.end}. Then call again with confirmed=true."
                )
            return await connector.calendar_create(p.title, p.start, p.end, p.location,
                                                   p.description, p.attendees)

        async def delete(p: _DeleteEvent) -> str:
            if not p.confirmed:
                event = await connector.calendar_get(p.event_id)
                when = (event.get("start") or {}).get("dateTime") or (event.get("start") or {}).get("date")
                return (f"NOT DELETED. Ask the user to confirm deleting {event.get('summary', '(no title)')!r} "
                        f"at {when} from Google Calendar, then call again with confirmed=true.")
            return await connector.calendar_delete(p.event_id)

        specs += [
            ToolSpec("calendar_list_events", "List events in the user's GOOGLE Calendar between two "
                     f"datetimes, optionally matching text. {_DT} This is Google Calendar, separate "
                     "from JARVIS's own schedule.",
                     _schema(_Range), _Range,
                     wrap(lambda p: connector.calendar_list(p.start, p.end, p.query)), "connector", "low"),
            ToolSpec("calendar_create_event", f"Add an event to the user's Google Calendar. {_DT} "
                     "Events with attendees need confirmed=true after the user agrees.",
                     _schema(_CreateEvent), _CreateEvent, wrap(create), "connector", "medium"),
            ToolSpec("calendar_delete_event", "Delete a Google Calendar event by id. First call "
                     "without confirmed; delete only after the user says yes.",
                     _schema(_DeleteEvent), _DeleteEvent, wrap(delete), "connector", "high"),
        ]
    if "drive" in connector.services:
        specs += [
            ToolSpec("drive_search", "Find files in the user's Google Drive by name or content.",
                     _schema(_Search), _Search,
                     wrap(lambda p: connector.drive_search(p.query, p.limit)), "connector", "low"),
            ToolSpec("drive_read", "Read a Google Drive file's text by id (Docs, Sheets, Slides, text files).",
                     _schema(_FileId), _FileId,
                     wrap(lambda p: connector.drive_read(p.file_id)), "connector", "low"),
        ]
    return specs


# -------------------------------------------------------------------- mcp specs
def _safe(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_]", "_", name)[:40].strip("_") or "server"


def _mcp_specs(state: McpServerState) -> list[Any]:
    from app.llm.tools import ToolOutcome, ToolSpec

    specs = []
    prefix = f"mcp__{_safe(state.config.name)}__"
    for tool in state.tools:
        if tool.name in state.config.disabled_tools:
            continue
        name = (prefix + _safe(tool.name))[:64]

        def make(tool: McpTool = tool):
            async def handler(payload: _AnyInput) -> ToolOutcome:
                arguments = payload.model_dump()
                confirmed = bool(arguments.pop("confirmed", False))
                if not tool.read_only and not confirmed:
                    return ToolOutcome(content=(
                        f"NOT RUN. {tool.name} on {state.config.name} can change things. Tell the user "
                        f"what it will do with {arguments!r} and ask. Call again with confirmed=true only "
                        "after they agree."
                    ))
                if state.session is None:
                    return ToolOutcome(content=f"{state.config.name} is not connected: {state.error}", is_error=True)
                try:
                    text, is_error = await state.session.call_tool(tool.name, arguments)
                except McpError as exc:
                    return ToolOutcome(content=str(exc), is_error=True)
                return ToolOutcome(content=g.untrusted(f"{state.config.name} result", text), is_error=is_error)
            return handler

        schema = dict(tool.input_schema)
        if not tool.read_only:
            schema = {**schema, "properties": {
                **(schema.get("properties") or {}),
                "confirmed": {"type": "boolean", "description": "true only after the user agreed"},
            }}
        description = f"[{state.config.name}] {tool.description}"
        if not tool.read_only:
            description += " (Changes things: needs the user's yes, then confirmed=true.)"
        specs.append(ToolSpec(name, description[:1000], schema, _AnyInput, make(),
                              "connector", "low" if tool.read_only else "high"))
    return specs


# ------------------------------------------------------------------ routing
_GOOGLE_ROUTES = {
    "gmail": r"\b(e-?mails?|mails?|gmail|inbox|unread|draft|reply to|send (a |an )?(message|note) to)\b",
    "calendar": r"\b(google calendar|calendar|meeting|invite|appointment|event)\b",
    "drive": r"\b(drive|google docs?|document|doc|sheet|spreadsheet|slides?|file)\b",
}


def _rebuild() -> None:
    global _specs, _by_name, _routes
    specs: list[Any] = _google_specs()
    routes: list[tuple[re.Pattern[str], frozenset[str]]] = []
    if _google is not None:
        for service, pattern in _GOOGLE_ROUTES.items():
            names = frozenset(s.name for s in specs if s.name.startswith(
                {"gmail": "gmail_", "calendar": "calendar_", "drive": "drive_"}[service]))
            if names:
                routes.append((re.compile(pattern, re.I), names))
    for server_id in sorted(_servers):
        state = _servers[server_id]
        server_specs = _mcp_specs(state)
        specs += server_specs
        if server_specs:
            words = {w for w in re.split(r"[^a-z0-9]+", state.config.name.lower()) if len(w) > 2}
            pattern = r"\b(" + "|".join(sorted(map(re.escape, words)) or ["mcp"]) + r")\b"
            routes.append((re.compile(pattern, re.I), frozenset(s.name for s in server_specs)))
    _specs = tuple(specs)
    _by_name = {spec.name: spec for spec in specs}
    _routes = routes


def specs() -> tuple:
    return _specs


def lookup(name: str) -> Any:
    return _by_name.get(name)


def route_names(*texts: str) -> set[str]:
    """Connector tool names whose keywords appear in the turn's text."""
    matched: set[str] = set()
    for text in texts:
        if not text:
            continue
        for pattern, names in _routes:
            if pattern.search(text):
                matched |= names
    return matched


# ---------------------------------------------------------------- configure
async def configure(payload: dict[str, Any]) -> dict[str, Any]:
    """Replace the live connector set with what the client sent.

    ``payload = {"google": {...} | None, "mcp": [server, ...]}``. Secrets in it
    are kept in memory only.
    """
    global _google, _google_error
    async with _lock:
        google_cfg = payload.get("google") or None
        if _google is not None:
            await _google.close()
            _google = None
        _google_error = ""
        if google_cfg and google_cfg.get("refresh_token") and google_cfg.get("client_id"):
            _google = g.GoogleConnector(
                str(google_cfg["client_id"]), str(google_cfg.get("client_secret") or ""),
                str(google_cfg["refresh_token"]), list(google_cfg.get("services") or g.SCOPES),
                email=str(google_cfg.get("email") or ""),
            )

        for state in _servers.values():
            if state.session is not None:
                await state.session.close()
        _servers.clear()
        configs = []
        for raw in payload.get("mcp") or []:
            try:
                config = ServerConfig.from_payload(raw)
            except (KeyError, ValueError) as exc:
                logger.warning("Skipping malformed MCP server definition: %s", exc)
                continue
            if config.enabled:
                configs.append(config)

        async def connect(config: ServerConfig) -> McpServerState:
            state = McpServerState(config)
            try:
                state.session = await open_session(
                    config, allow_stdio=not settings.jarvis_android,
                    on_rotate=lambda bundle, sid=config.id: _rotated.__setitem__(sid, bundle),
                )
                state.tools = await state.session.list_tools()
            except (McpError, OSError) as exc:
                state.error = str(exc)
                if state.session is not None:
                    await state.session.close()
                    state.session = None
            return state

        for state in await asyncio.gather(*(connect(c) for c in configs)):
            _servers[state.config.id] = state
        _rebuild()
        logger.info(
            "Connectors configured: google=%s, mcp=%s",
            ",".join(_google.services) if _google else "off",
            ", ".join(f"{s.config.name}({len(s.tools)} tools{'; ' + s.error if s.error else ''})"
                      for s in _servers.values()) or "none",
        )
        return status()


def status() -> dict[str, Any]:
    return {
        "google": ({"connected": True, "email": _google.email, "services": _google.services}
                   if _google else {"connected": False, "error": _google_error}),
        "mcp": [
            {"id": s.config.id, "name": s.config.name, "connected": s.session is not None,
             "error": s.error, "tools": [{"name": t.name, "description": t.description[:200],
                                          "read_only": t.read_only,
                                          "enabled": t.name not in s.config.disabled_tools}
                                         for t in s.tools]}
            for s in _servers.values()
        ],
        "tool_count": len(_specs),
    }


def collect_rotated() -> dict[str, dict[str, Any]]:
    """OAuth bundles renewed since the last call, keyed by server id (handed out once)."""
    out = dict(_rotated)
    _rotated.clear()
    return out


async def close() -> None:
    await configure({})


async def probe_server(raw: dict[str, Any]) -> dict[str, Any]:
    """Connect to one server definition without keeping it (Settings' Test button)."""
    try:
        config = ServerConfig.from_payload(raw)
        session = await open_session(config, allow_stdio=not settings.jarvis_android)
    except (McpError, KeyError, ValueError, OSError) as exc:
        return {"ok": False, "error": str(exc), "tools": []}
    try:
        tools = await session.list_tools()
        return {"ok": True, "server": session.server_info,
                "tools": [{"name": t.name, "description": t.description[:200], "read_only": t.read_only}
                          for t in tools]}
    except McpError as exc:
        return {"ok": False, "error": str(exc), "tools": []}
    finally:
        await session.close()
