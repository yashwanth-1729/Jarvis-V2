"""Provider protocols and the vendor-neutral types that cross them.

The wire format is OpenAI-shaped chat completions, because that is what Sarvam
(v1) speaks natively and what most vendors expose. A future Anthropic provider
translates at its own boundary rather than leaking Messages-API shapes upward.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Literal, Protocol, Sequence, runtime_checkable


class ProviderError(RuntimeError):
    """Base for provider failures that should reach the user as a message."""


class ProviderNotConfigured(ProviderError):
    """Missing credentials or an unknown provider name."""


class ProviderAuthError(ProviderError):
    """Credentials rejected by the vendor."""


class ProviderRateLimited(ProviderError):
    """Vendor asked us to slow down."""


class ProviderOutOfCredit(ProviderError):
    """The account has no balance left.

    Distinct from rate limiting, which waiting fixes, and from an auth error,
    which a new key fixes. Nothing the app does will help — and the difference
    matters at the call site: a 402 should stop the voice loop from re-sending
    every utterance into a wall, where a 429 genuinely should be retried.
    """


class ProviderUnavailable(ProviderError):
    """Network failure or a vendor-side 5xx."""


# ---------------------------------------------------------------------------
# Chat
# ---------------------------------------------------------------------------

@dataclass(slots=True)
class ToolCall:
    """A resolved tool invocation, reassembled from streaming deltas."""

    id: str
    name: str
    arguments: str  # raw JSON string exactly as the model emitted it
    index: int = 0


ChunkKind = Literal["text", "reasoning", "tool_call_started"]


@dataclass(slots=True)
class ChatChunk:
    """One increment from a streaming completion."""

    kind: ChunkKind
    text: str = ""
    tool_call: ToolCall | None = None


@dataclass(slots=True)
class ChatResult:
    """Terminal state of one completion."""

    content: str = ""
    reasoning: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    finish_reason: str | None = None
    usage: dict[str, int] = field(default_factory=dict)

    @property
    def wants_tools(self) -> bool:
        return bool(self.tool_calls)


@runtime_checkable
class ChatProvider(Protocol):
    """Streaming chat completions with tool calling."""

    name: str
    model: str

    def stream(
        self,
        messages: Sequence[dict[str, Any]],
        tools: Sequence[dict[str, Any]] | None = None,
        model: str | None = None,
        max_tokens: int | None = None,
        incremental: bool = True,
    ) -> AsyncIterator[ChatChunk]:
        """Yield chunks as they arrive.

        The final :class:`ChatResult` is retrieved from :meth:`last_result`
        after the iterator is exhausted, mirroring the SDK `get_final_message`
        pattern and keeping the iterator's item type uniform.

        ``incremental=False`` asks for the whole completion in one response and
        yields it as a single chunk. The interface is identical either way, so
        callers that do not care about partial output need no special case.

        It is not merely a convenience. Measured against the live endpoint with
        an identical prompt::

            streaming      first token 0.57s, total 2.47s,    0 of 9,014 cached
            non-streaming  first token   —  , total 1.61s, 8,960 of 9,014 cached

        The provider does not apply its prefix cache to streaming requests, so a
        streamed turn re-processes the entire prompt every time. Where partial
        output is not being shown to anyone -- a round that only decides which
        tool to call -- streaming costs time and money for nothing.
        """
        ...

    def last_result(self) -> ChatResult:
        ...


# ---------------------------------------------------------------------------
# Speech
# ---------------------------------------------------------------------------

@dataclass(slots=True)
class Transcript:
    text: str
    language_code: str | None = None
    confidence: float | None = None


@runtime_checkable
class STTProvider(Protocol):
    name: str
    model: str

    async def transcribe(
        self,
        audio: bytes,
        filename: str = "audio.webm",
        content_type: str = "audio/webm",
        language_code: str | None = None,
    ) -> Transcript:
        ...


@dataclass(slots=True)
class Speech:
    audio: bytes
    content_type: str = "audio/wav"


@dataclass(slots=True)
class AudioPacket:
    """Mono signed little-endian 16-bit PCM; packet boundaries are sample aligned."""

    audio: bytes
    sample_rate: int


@runtime_checkable
class StreamingTTSProvider(Protocol):
    def stream_speech(
        self, text: str, language_code: str | None = None,
        speaker: str | None = None, pace: float | None = None,
    ) -> AsyncIterator[AudioPacket]:
        ...


@runtime_checkable
class TTSProvider(Protocol):
    name: str
    model: str

    #: Hard cap the vendor enforces on a single request.
    max_chars: int

    async def synthesize(
        self,
        text: str,
        language_code: str | None = None,
        speaker: str | None = None,
        pace: float | None = None,
    ) -> Speech:
        ...
