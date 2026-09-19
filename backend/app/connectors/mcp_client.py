"""A minimal Model Context Protocol client: Streamable HTTP and stdio.

Only the subset JARVIS uses -- ``initialize``, ``tools/list``, ``tools/call``
-- over JSON-RPC 2.0. Written here rather than taking the official SDK because
the SDK's dependency tree would also have to build under Chaquopy on Android,
and this subset needs nothing beyond httpx and asyncio (see docs/connectors.md).

* **HTTP** (both devices): each JSON-RPC message is a POST to the server URL.
  The answer is either a JSON body or an SSE stream whose ``data:`` lines carry
  JSON-RPC messages; the one whose ``id`` matches is the reply. A session id
  from ``Mcp-Session-Id`` is echoed on later requests.
* **stdio** (laptop only): the server is a child process; messages are one
  JSON object per line on stdin/stdout.

Server output is untrusted: tool results are returned as plain text for the
caller to label, and nothing a server sends can change what JARVIS allows.
"""

from __future__ import annotations

import asyncio
import contextlib
import itertools
import json
import logging
import os
import shutil
from dataclasses import dataclass, field
from typing import Any

import httpx

logger = logging.getLogger("jarvis.connectors.mcp")

#: The protocol revision we ask for. Servers answer with the one they speak;
#: every revision since 2025-03-26 shares the three methods used here.
PROTOCOL_VERSION = "2025-06-18"
CLIENT_INFO = {"name": "JARVIS", "version": "3"}
#: Tool results longer than this are truncated before reaching the model.
MAX_RESULT_CHARS = 6000


class McpError(RuntimeError):
    """A server could not be reached, or answered with a JSON-RPC error."""


@dataclass(slots=True)
class McpTool:
    name: str
    description: str
    input_schema: dict[str, Any]
    #: From the tool's MCP annotations. Only an explicit ``readOnlyHint: true``
    #: runs without the user's confirmation.
    read_only: bool = False


@dataclass(slots=True)
class ServerConfig:
    id: str
    name: str
    transport: str  # "http" | "stdio"
    url: str = ""
    headers: dict[str, str] = field(default_factory=dict)
    command: str = ""
    args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    enabled: bool = True
    disabled_tools: list[str] = field(default_factory=list)

    @classmethod
    def from_payload(cls, raw: dict[str, Any]) -> "ServerConfig":
        transport = str(raw.get("transport") or ("stdio" if raw.get("command") else "http"))
        if transport not in ("http", "stdio"):
            raise ValueError(f"unknown transport {transport!r}")
        return cls(
            id=str(raw["id"]),
            name=str(raw.get("name") or raw["id"]),
            transport=transport,
            url=str(raw.get("url") or ""),
            headers={str(k): str(v) for k, v in (raw.get("headers") or {}).items()},
            command=str(raw.get("command") or ""),
            args=[str(a) for a in (raw.get("args") or [])],
            env={str(k): str(v) for k, v in (raw.get("env") or {}).items()},
            enabled=bool(raw.get("enabled", True)),
            disabled_tools=[str(t) for t in (raw.get("disabled_tools") or [])],
        )


def _parse_tools(result: dict[str, Any]) -> list[McpTool]:
    tools = []
    for raw in result.get("tools") or []:
        name = raw.get("name")
        if not name:
            continue
        annotations = raw.get("annotations") or {}
        schema = raw.get("inputSchema") or {"type": "object", "properties": {}}
        if schema.get("type") != "object":
            schema = {"type": "object", "properties": {}}
        tools.append(McpTool(
            name=str(name),
            description=str(raw.get("description") or raw.get("title") or name)[:1000],
            input_schema=schema,
            read_only=annotations.get("readOnlyHint") is True,
        ))
    return tools


def result_text(result: dict[str, Any]) -> tuple[str, bool]:
    """(text, is_error) from a ``tools/call`` result."""
    parts: list[str] = []
    for item in result.get("content") or []:
        kind = item.get("type")
        if kind == "text":
            parts.append(str(item.get("text", "")))
        elif kind == "resource":
            resource = item.get("resource") or {}
            parts.append(str(resource.get("text") or resource.get("uri") or ""))
        elif kind in ("image", "audio"):
            parts.append(f"[{kind} content, {item.get('mimeType', 'unknown type')}]")
    if not parts and result.get("structuredContent") is not None:
        parts.append(json.dumps(result["structuredContent"], ensure_ascii=False))
    text = "\n".join(p for p in parts if p).strip() or "(no content)"
    if len(text) > MAX_RESULT_CHARS:
        text = text[:MAX_RESULT_CHARS] + "\n[truncated]"
    return text, bool(result.get("isError"))


class _Session:
    """Shared JSON-RPC bookkeeping for both transports."""

    def __init__(self, config: ServerConfig) -> None:
        self.config = config
        self._ids = itertools.count(1)
        self.server_info: dict[str, Any] = {}

    async def request(self, method: str, params: dict[str, Any] | None = None,
                      timeout: float = 30.0) -> dict[str, Any]:
        raise NotImplementedError

    async def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        raise NotImplementedError

    async def close(self) -> None:
        return None

    async def initialize(self) -> None:
        result = await self.request("initialize", {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": CLIENT_INFO,
        })
        self.server_info = result.get("serverInfo") or {}
        await self.notify("notifications/initialized")

    async def list_tools(self) -> list[McpTool]:
        tools: list[McpTool] = []
        cursor: str | None = None
        for _ in range(20):  # a server paginating forever is not our problem
            result = await self.request("tools/list", {"cursor": cursor} if cursor else {})
            tools.extend(_parse_tools(result))
            cursor = result.get("nextCursor")
            if not cursor:
                break
        return tools

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> tuple[str, bool]:
        result = await self.request("tools/call", {"name": name, "arguments": arguments},
                                    timeout=120.0)
        return result_text(result)

    @staticmethod
    def _unwrap(message: dict[str, Any]) -> dict[str, Any]:
        if "error" in message:
            error = message["error"] or {}
            raise McpError(f"server error {error.get('code')}: {error.get('message')}")
        return message.get("result") or {}


class HttpSession(_Session):
    def __init__(self, config: ServerConfig, transport: httpx.AsyncBaseTransport | None = None) -> None:
        super().__init__(config)
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(30.0, connect=8.0), transport=transport,
            follow_redirects=True,
        )
        self._session_id: str | None = None
        self._protocol: str | None = None

    def _headers(self) -> dict[str, str]:
        headers = {
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
            **self.config.headers,
        }
        if self._session_id:
            headers["Mcp-Session-Id"] = self._session_id
        if self._protocol:
            headers["MCP-Protocol-Version"] = self._protocol
        return headers

    async def _post(self, message: dict[str, Any], timeout: float) -> httpx.Response:
        try:
            response = await self._client.post(
                self.config.url, json=message, headers=self._headers(), timeout=timeout,
            )
        except httpx.HTTPError as exc:
            raise McpError(f"could not reach {self.config.name}: {type(exc).__name__}") from exc
        if response.headers.get("mcp-session-id"):
            self._session_id = response.headers["mcp-session-id"]
        if response.status_code in (401, 403):
            raise McpError(f"{self.config.name} refused the credentials (HTTP {response.status_code})")
        if response.status_code >= 400:
            raise McpError(f"{self.config.name} answered HTTP {response.status_code}")
        return response

    async def request(self, method: str, params: dict[str, Any] | None = None,
                      timeout: float = 30.0) -> dict[str, Any]:
        message_id = next(self._ids)
        response = await self._post(
            {"jsonrpc": "2.0", "id": message_id, "method": method, "params": params or {}},
            timeout,
        )
        content_type = response.headers.get("content-type", "")
        if "text/event-stream" in content_type:
            reply = _reply_from_sse(response.text, message_id)
        else:
            try:
                body = response.json()
            except ValueError as exc:
                raise McpError(f"{self.config.name} sent a non-JSON reply") from exc
            reply = next((m for m in body if m.get("id") == message_id), None) if isinstance(body, list) else body
        if not isinstance(reply, dict):
            raise McpError(f"{self.config.name} sent no reply to {method}")
        result = self._unwrap(reply)
        if method == "initialize":
            self._protocol = str(result.get("protocolVersion") or PROTOCOL_VERSION)
        return result

    async def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        with contextlib.suppress(McpError):
            await self._post({"jsonrpc": "2.0", "method": method, "params": params or {}}, 10.0)

    async def close(self) -> None:
        if self._session_id:
            with contextlib.suppress(httpx.HTTPError):
                await self._client.delete(self.config.url, headers=self._headers(), timeout=5.0)
        await self._client.aclose()


def _reply_from_sse(text: str, message_id: int) -> dict[str, Any] | None:
    data_lines: list[str] = []
    for line in text.splitlines() + [""]:
        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
        elif not line.strip() and data_lines:
            try:
                message = json.loads("\n".join(data_lines))
            except ValueError:
                message = None
            data_lines = []
            if isinstance(message, dict) and message.get("id") == message_id:
                return message
    return None


class StdioSession(_Session):
    """A local server process. Laptop only -- Android cannot spawn one."""

    def __init__(self, config: ServerConfig) -> None:
        super().__init__(config)
        self._process: asyncio.subprocess.Process | None = None
        self._pending: dict[int, asyncio.Future] = {}
        self._reader: asyncio.Task | None = None

    async def start(self) -> None:
        executable = shutil.which(self.config.command) or self.config.command
        env = {**os.environ, **self.config.env}
        try:
            self._process = await asyncio.create_subprocess_exec(
                executable, *self.config.args,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL, env=env,
                limit=8 * 1024 * 1024,
            )
        except (OSError, ValueError) as exc:
            raise McpError(f"could not start {self.config.command!r}: {exc}") from exc
        self._reader = asyncio.create_task(self._read_loop())

    async def _read_loop(self) -> None:
        assert self._process and self._process.stdout
        try:
            while True:
                line = await self._process.stdout.readline()
                if not line:
                    break
                try:
                    message = json.loads(line)
                except ValueError:
                    continue  # servers sometimes log to stdout; not ours to parse
                if isinstance(message, dict) and "id" in message and message["id"] in self._pending:
                    future = self._pending.pop(message["id"])
                    if not future.done():
                        future.set_result(message)
        finally:
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(McpError(f"{self.config.name} exited"))
            self._pending.clear()

    async def _write(self, message: dict[str, Any]) -> None:
        if not self._process or not self._process.stdin or self._process.returncode is not None:
            raise McpError(f"{self.config.name} is not running")
        self._process.stdin.write((json.dumps(message) + "\n").encode("utf-8"))
        await self._process.stdin.drain()

    async def request(self, method: str, params: dict[str, Any] | None = None,
                      timeout: float = 30.0) -> dict[str, Any]:
        message_id = next(self._ids)
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[message_id] = future
        await self._write({"jsonrpc": "2.0", "id": message_id, "method": method, "params": params or {}})
        try:
            reply = await asyncio.wait_for(future, timeout)
        except asyncio.TimeoutError as exc:
            self._pending.pop(message_id, None)
            raise McpError(f"{self.config.name} did not answer {method} in {timeout:.0f}s") from exc
        return self._unwrap(reply)

    async def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        await self._write({"jsonrpc": "2.0", "method": method, "params": params or {}})

    async def close(self) -> None:
        if self._reader:
            self._reader.cancel()
        if self._process and self._process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                self._process.terminate()
            with contextlib.suppress(asyncio.TimeoutError, ProcessLookupError):
                await asyncio.wait_for(self._process.wait(), 3.0)
            if self._process.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    self._process.kill()


async def open_session(config: ServerConfig, *, allow_stdio: bool,
                       transport: httpx.AsyncBaseTransport | None = None) -> _Session:
    """Connect and initialize. Raises McpError with a readable reason."""
    if config.transport == "stdio":
        if not allow_stdio:
            raise McpError(f"{config.name} is a local (command) server; it runs on the laptop only")
        session: _Session = StdioSession(config)
        await session.start()  # type: ignore[attr-defined]
    else:
        if not config.url.startswith(("https://", "http://")):
            raise McpError(f"{config.name} has no valid URL")
        session = HttpSession(config, transport=transport)
    try:
        await asyncio.wait_for(session.initialize(), 30.0)
    except asyncio.TimeoutError as exc:
        await session.close()
        raise McpError(f"{config.name} did not finish connecting in 30s") from exc
    except Exception:
        await session.close()
        raise
    return session
