"""Persistent voice session: segmented ASR, streamed agent, bounded speech stages.

New clients negotiate ?audio=pcm16 to receive incremental 100 ms PCM packets.
Older clients retain phrase WAV delivery. All turn events carry generation IDs.
Half-duplex remains the client default; optional interruption cancels pending work.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import io
import logging
import re
import time
import wave
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.core.config import settings
from app.core.languages import AUTO_DETECT, DEFAULT_LANGUAGE, is_supported
from app.core.voices import DEFAULT_VOICE
from app.core.voices import is_supported as voice_supported
from app.db import crud
from app.llm.agent import run_turn
from app.providers import get_stt_provider, get_tts_provider
from app.services import speech, voice_metrics
from app.services.voice_pipeline import SpeechPipeline
from app.providers.base import AudioPacket, ProviderError, ProviderOutOfCredit

logger = logging.getLogger("jarvis.api.realtime")

router = APIRouter(tags=["voice"])


@router.get("/api/voice/metrics")
async def voice_latency_metrics() -> dict:
    return voice_metrics.snapshot()

# Split after sentence-ending punctuation, or on a hard line break.
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+|\n+")

# The first chunk is deliberately allowed to be short: time-to-first-word
# dominates how responsive the conversation feels.
FIRST_CHUNK_MIN_CHARS = 16

#: Hard ceiling on the *first* spoken chunk.
#:
#: Synthesis latency is linear in text length — measured against the live API:
#: 8 chars 0.63s, 29 chars 0.97s, 69 chars 1.70s, 127 chars 2.85s, i.e. roughly
#: 0.4s fixed plus 0.019s per character. Every one of those seconds is dead air,
#: because nothing can play until the first chunk comes back.
#:
#: Later chunks are synthesized while earlier ones play, so their latency is
#: hidden and they stay long (better prosody). Only the first is capped, and it
#: is broken at a clause boundary so it still sounds like speech.
FIRST_CHUNK_MAX_CHARS = 48

#: Ceiling for an opener that had to absorb a too-short first sentence.
#:
#: Higher than the plain cap on purpose. "Yes sir." and "బాస్." cannot be
#: spoken alone — see `_first_chunk` — so they are folded into the clause that
#: follows, and the result is naturally longer than an opener that stood by
#: itself. Holding it to 48 meant the merge usually failed and nothing was
#: spoken until the whole reply had been generated, which traded a bad opener
#: for a slow one.
FIRST_CHUNK_MERGED_MAX_CHARS = 96

#: The longest utterance to hand the vendor in one piece.
#:
#: This is a *pacing* control, not a payload limit, and it is the fix for a
#: complaint that stood for months: "one line is slow, the second is very fast,
#: and the third waits for unknown reasons."
#:
#: Neural TTS normalises prosody across whatever utterance it is given. Ask it
#: for eight characters and it speaks them deliberately, stretched, every
#: consonant landed; ask it for two hundred and fifty and it compresses to fit.
#: Both sound fine alone. Played back-to-back they sound like two different
#: people, and that is precisely what was happening -- the splitter enforced a
#: *minimum* of 90 characters and no maximum at all, and its merge rule glued
#: a short sentence onto the next one, so a single reply could run
#:
#:     "Yes sir."                                            (8 chars, slow)
#:     "I have moved the Java class to Thursday, and the ...  (214 chars, fast)
#:
#: The same unboundedness caused the pauses. Synthesis time scales with length,
#: chunks must be delivered in order, so one long chunk stalls every chunk
#: behind it -- and if its audio finishes before the next arrives, the listener
#: hears the queue run dry.
#:
#: Bounding the top end puts every spoken chunk in one length regime, so the
#: rate stops wobbling and no single chunk can stall the queue. The opener is
#: deliberately exempt: it is the only chunk whose synthesis the user waits
#: through, and a short first line reads as natural rather than rushed.
#:
#: Raised from 165, which was cutting inside sentences and cost more than it
#: bought. A sentence handed to the vendor in two pieces is synthesized as two
#: utterances: the first half lands on a falling, finished intonation exactly
#: where the thought should carry on, and the second starts as though it were
#: a new sentence. It made JARVIS audibly less human than the version before
#: the cap existed, which simply spoke whole sentences.
#:
#: So the ceiling is now high enough that ordinary speech never reaches it —
#: a two-sentence spoken reply does not run to 320 characters — and the merge
#: rule below still stops the tiny-fragment case that made the *rate* wobble.
#: What remains is a guard against a genuine run-on with no punctuation to cut
#: at, where an unbounded chunk would stall every chunk queued behind it.
MAX_CHUNK_CHARS = 320

#: Where to aim when cutting an over-long chunk, so pieces cluster rather than
#: leaving a long head and a two-word tail.
TARGET_CHUNK_CHARS = 120

#: Clause boundaries, best first — where a long opening sentence can be cut
#: without the result sounding truncated.
_CLAUSE_BREAK = re.compile(r"[,;:—–]\s")

# Hard bounds. A spoken turn that runs long is worse than one that is cut off —
# the user is sitting there listening, unable to skim.
TURN_TIMEOUT_SECONDS = 75.0
RECOGNITION_TIMEOUT_SECONDS = 22.0
MAX_SPOKEN_CHUNKS = 8

# Formatting characters that must never reach either the speaker or the
# on-screen caption. Stripped per delta, which is safe because none of them
# carry meaning in speech even when a pair straddles two deltas.
_MARKUP = re.compile(r"[*_`#>|]+")

#: Spoken end-of-turn markers. Saying one of these ends the utterance, so the
#: user controls when they are finished instead of racing a silence timer.
#: Matched only at the very end, so "that's it for today" mid-sentence is safe.
_STOP_WORDS = (
    "period", "full stop", "thats it", "that's it", "over", "done",
    "go ahead", "answer now",
)
_TRAILING_PUNCT = re.compile(r"[\s.,!?।]+$")


def strip_stop_word(text: str) -> tuple[str, bool]:
    """Remove a trailing end-of-turn marker. Returns (text, was_present).

    Speech recognition renders a spoken "period" as the word, sometimes with
    punctuation attached, so both are trimmed before matching.
    """
    cleaned = _TRAILING_PUNCT.sub("", text.strip())
    lowered = cleaned.lower()

    for word in _STOP_WORDS:
        if lowered.endswith(word):
            head = cleaned[: len(cleaned) - len(word)]
            head = _TRAILING_PUNCT.sub("", head)
            # A bare "period" with nothing before it is not a question; treat it
            # as an empty utterance rather than sending the word to the model.
            return head.strip(), True

    return text.strip(), False


def _first_chunk(buffer: str) -> tuple[str, str]:
    """Carve the opening fragment to speak, and return what is left.

    Returns ``("", buffer)`` when there is not yet enough text to commit to.

    The goal is the shortest natural-sounding opener, because synthesis time —
    and therefore the silence before JARVIS answers — scales with its length.
    Preference order: a finished sentence, else a clause boundary, else a hard
    cut at a word break once the text is clearly longer than the cap.
    """
    text = buffer.lstrip()
    if not text:
        return "", buffer

    sentence = _SENTENCE_END.search(text)

    # 1. A short complete sentence is the ideal opener — "Yes sir." synthesizes
    #    in 0.63s. It still needs a floor, though, which it did not have.
    #
    #    Without one, a reply that opens by addressing the user makes the
    #    address the entire first utterance: "బాస్." on its own, five
    #    characters. Two things then go wrong at once. The vendor normalises
    #    prosody per utterance, so five characters are stretched and spoken
    #    slowly and deliberately; and the whole rest of the answer is left in
    #    one long chunk behind it, which takes seconds to synthesize and is
    #    then delivered compressed. Heard end to end that is "boss" … a long
    #    silence … then the answer, rushed.
    #
    #    A finished sentence does always *sound* finished. It just must not be
    #    so short that it is all pause and no content.
    if (
        sentence
        and FIRST_CHUNK_MIN_CHARS <= sentence.end() <= FIRST_CHUNK_MAX_CHARS
    ):
        return text[: sentence.end()].strip(), text[sentence.end() :]

    # 1b. Too short to stand alone: fold it into whatever follows, so the
    #     address and the first real clause are spoken as one breath.
    if sentence and sentence.end() < FIRST_CHUNK_MIN_CHARS:
        following = _SENTENCE_END.search(text[sentence.end() :])
        if following:
            cut = sentence.end() + following.end()
            if cut <= FIRST_CHUNK_MERGED_MAX_CHARS:
                return text[:cut].strip(), text[cut:]
        for match in _CLAUSE_BREAK.finditer(text[:FIRST_CHUNK_MAX_CHARS]):
            if match.start() >= FIRST_CHUNK_MIN_CHARS:
                return text[: match.end()].strip(), text[match.end() :]
        # Nothing usable yet — wait for more text rather than speaking a word.
        return "", buffer

    # 2. Otherwise cut at the EARLIEST clause boundary past a small floor.
    #    Earliest, not latest: the whole point is to start talking sooner, and
    #    "Yes sir," is a better opener than the longest fragment that fits.
    for match in _CLAUSE_BREAK.finditer(text[:FIRST_CHUNK_MAX_CHARS]):
        if match.start() >= FIRST_CHUNK_MIN_CHARS:
            return text[: match.end()].strip(), text[match.end() :]

    # 3. A long opening sentence with no usable break: speak the whole thing.
    if sentence:
        return text[: sentence.end()].strip(), text[sentence.end() :]

    # 4. Nothing natural to cut at yet. Deliberately no word-break fallback —
    #    cutting mid-phrase ("...and a") sounds broken, which is worse than the
    #    fraction of a second saved.
    return "", buffer


def _split_sentences(buffer: str, minimum: int) -> tuple[list[str], str]:
    """Pull complete sentences off the front of ``buffer``.

    Returns the sentences ready to speak and whatever remains unterminated.
    A sentence shorter than ``minimum`` is held back and merged with the next
    one, so the speech is not chopped into unnatural fragments.
    """
    ready: list[str] = []
    rest = buffer
    while True:
        match = _SENTENCE_END.search(rest)
        if not match:
            break
        candidate = rest[: match.end()].strip()
        if len(candidate) < minimum:
            # Too short to speak on its own — wait for more text, unless the
            # remainder already contains another boundary we can merge past.
            following = _SENTENCE_END.search(rest[match.end() :])
            if not following:
                break
            merged_end = match.end() + following.end()
            merged = rest[:merged_end].strip()
            # Merging is for avoiding fragments, not for building a monologue.
            # Past the cap the cure is worse than the disease: the pair would
            # be spoken noticeably faster than its neighbours and would stall
            # every chunk queued behind it.
            if len(merged) > MAX_CHUNK_CHARS:
                rest = rest[match.end() :]
            else:
                candidate = merged
                rest = rest[merged_end:]
        else:
            rest = rest[match.end() :]
        if candidate:
            ready.append(candidate)
    return ready, rest


def _bound(chunk: str, limit: int = MAX_CHUNK_CHARS) -> list[str]:
    """Cut an over-long chunk into pieces that sit in one length regime.

    Prefers clause punctuation, then a word boundary near the target, and only
    falls back to a hard cut if a single run of text has neither -- which in
    practice means a URL or an unbroken identifier.
    """
    text = chunk.strip()
    if len(text) <= limit:
        return [text] if text else []

    pieces: list[str] = []
    while len(text) > limit:
        window = text[:limit]

        # Best: a clause boundary at or after the target, so pieces are even.
        cut = 0
        for match in _CLAUSE_BREAK.finditer(window):
            if match.end() >= TARGET_CHUNK_CHARS:
                cut = match.end()
                break
            cut = match.end()  # keep the latest one seen, in case none reach it

        # Next best: the last space in the window.
        if cut < TARGET_CHUNK_CHARS // 2:
            space = window.rfind(" ")
            cut = space + 1 if space > 0 else 0

        # Last resort: cut at the limit. Only reachable for unbroken text.
        if cut <= 0:
            cut = limit

        piece = text[:cut].strip()
        if piece:
            pieces.append(piece)
        text = text[cut:].lstrip()

    if text:
        # A very short tail is worse than a slightly long previous piece, so it
        # is folded back rather than spoken as a fragment.
        if pieces and len(text) < 24:
            pieces[-1] = f"{pieces[-1]} {text}".strip()
        else:
            pieces.append(text)
    return pieces


def _wav_seconds(audio: bytes) -> float:
    """Playback length of a WAV clip, or 0.0 if it cannot be read."""
    try:
        with wave.open(io.BytesIO(audio)) as source:
            rate = source.getframerate()
            return source.getnframes() / rate if rate else 0.0
    except Exception:  # noqa: BLE001 - a log line must never break the turn
        return 0.0


def _strip_markup(text: str) -> str:
    """Remove formatting characters from a streaming delta, in place."""
    return _MARKUP.sub("", text)


def _speakable(text: str) -> str:
    """Strip anything the model may still emit that should not be pronounced."""
    cleaned = re.sub(r"```.*?```", " ", text, flags=re.DOTALL)
    cleaned = _MARKUP.sub("", cleaned)
    cleaned = re.sub(r"^\s*[-•]\s*", "", cleaned, flags=re.MULTILINE)
    # "1. foo" reads as "one dot foo"; drop the enumeration marker.
    cleaned = re.sub(r"^\s*\d+[.)]\s+", "", cleaned, flags=re.MULTILINE)
    return re.sub(r"\s+", " ", cleaned).strip()


class VoiceSession:
    """One connected client. Owns the turn task and the send lock."""

    def __init__(self, socket: WebSocket) -> None:
        self.socket = socket
        self.turn: asyncio.Task[None] | None = None
        self._send_lock = asyncio.Lock()
        self._generation = 0
        self.language = DEFAULT_LANGUAGE
        #: Set when the vendor account is empty. Nothing this session does will
        #: change that, so further audio is dropped rather than re-sent.
        self.halted = False
        self.voice = DEFAULT_VOICE
        self.incremental_audio = getattr(socket, "query_params", {}).get("audio") == "pcm16"
        self._audio_slots = asyncio.Semaphore(20)
        self._outstanding_audio: set[int] = set()
        #: Transcribed segments of the utterance currently being spoken.
        self._heard: list[str] = []
        self._input_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=4)
        self._input_worker: asyncio.Task | None = None
        self._input_failed = False

    async def reset_input(self) -> None:
        if self._input_worker is not None:
            self._input_worker.cancel()
            await asyncio.gather(self._input_worker, return_exceptions=True)
            self._input_worker = None
        while not self._input_queue.empty():
            self._input_queue.get_nowait()
        self._heard.clear()
        self._input_failed = False

    async def enqueue_input(self, message: dict[str, Any]) -> None:
        if self._input_worker is None or self._input_worker.done():
            self._input_worker = asyncio.create_task(self._process_input())
        try:
            self._input_queue.put_nowait(message)
        except asyncio.QueueFull:
            # Never act on a command with missing words (especially negations).
            await self.reset_input()
            await self.cancel_turn()
            await self.send({"type": "error", "message": "Recognition could not keep up. Please repeat the request."})
            await self.send({"type": "state", "value": "listening", "gen": self._generation})

    async def _process_input(self) -> None:
        while True:
            message = await self._input_queue.get()
            kind = message.get("type")
            try:
                if kind in ("segment", "utterance"):
                    await self.on_segment(message.get("audio") or "")
                    if kind == "utterance":
                        await self.end_turn()
                elif kind == "end_turn":
                    await self.end_turn()
                elif kind == "text":
                    spoken = str(message.get("text") or "").strip()
                    if spoken:
                        self._input_failed = False
                        await self.send({"type": "transcript", "text": spoken})
                        await self.start_turn(spoken)
            except asyncio.CancelledError:
                raise
            except Exception:
                self._input_failed = True
                self._heard.clear()
                logger.exception("Voice input failed")
                await self.send({"type": "error", "input_failed": True, "message": "Could not process that speech. Please repeat the request."})
                await self.send({"type": "state", "value": "listening"})

    async def load_preferences(self) -> None:
        """Pick up stored settings, which the UI or a spoken command writes."""
        self.language = await speech.current_language()
        self.voice = (await speech.current_voice()).id

    async def send(self, payload: dict[str, Any], generation: int | None = None) -> None:
        # A single writer at a time: the turn task and the receive loop can
        # both emit, and interleaved frames would corrupt the stream.
        async with self._send_lock:
            if generation is not None:
                if generation != self._generation:
                    return
                payload = {**payload, "gen": generation}
            try:
                await self.socket.send_json(payload)
            except (WebSocketDisconnect, RuntimeError):
                raise asyncio.CancelledError from None

    async def cancel_turn(self) -> None:
        """Barge-in: abandon the in-flight turn and any pending synthesis."""
        # Whatever was heard belongs to the abandoned turn; carrying it into the
        # next utterance would prepend a fragment of the old question.
        self._heard.clear()
        self._generation += 1
        task = self.turn
        self.turn = None
        if task and not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass

    # -- the turn -----------------------------------------------------------

    async def handle_turn(self, text: str, generation: int) -> None:
        """Run one agent turn and speak the reply as it is generated."""
        tts = None
        try:
            tts = get_tts_provider()
        except ProviderError as exc:
            await self.send({"type": "error", "message": str(exc)}, generation)

        await self.send({"type": "state", "value": "thinking"}, generation)

        # Server timings begin at commitment, AFTER transcription. They do not
        # represent microphone end-to-speaker latency. Logged rather than
        # guessed, because the three stages have very different costs and only
        # measurement says which one to attack.
        turn_started = time.perf_counter()
        first_text_at: float | None = None
        first_audio_at: float | None = None

        # Each queued item carries the exact text its audio speaks, so the
        # client can reveal captions in step with playback instead of racing
        # ahead of it.
        seq = 0
        packet_seq = 0
        buffer = ""
        spoken_any = False
        reply_parts: list[str] = []
        revealed: set[int] = set()

        async def emit(payload: dict[str, Any]) -> None:
            await self.send(payload, generation)

        async def synthesize(chunk: str, language: str, voice: str):
            started = time.perf_counter()
            first = True
            async for packet in speech.stream(chunk, language, voice, incremental=self.incremental_audio):
                if first:
                    logger.info("voice tts-first-packet: gen=%d ms=%.0f", generation, (time.perf_counter()-started)*1000)
                    voice_metrics.record("tts_first_packet_ms", (time.perf_counter()-started)*1000)
                    first = False
                yield packet

        async def deliver(index: int, spoken_text: str, packet: Any) -> None:
            nonlocal first_audio_at, packet_seq
            if generation != self._generation:
                return
            if isinstance(packet, Exception):
                logger.warning("TTS phrase failed: %s", packet)
                # Do not repeat the caption if some of this phrase already played.
                if index not in revealed:
                    await emit({"type": "caption", "text": spoken_text})
                await emit({"type": "error", "message": "Speech was interrupted by a synthesis error; the reply is available as text."})
                return
            if self.incremental_audio:
                await self._audio_slots.acquire()
            packet_seq += 1
            if self.incremental_audio:
                self._outstanding_audio.add(packet_seq)
            first_audio_at = first_audio_at or time.perf_counter()
            payload = {
                "type": "audio", "seq": packet_seq,
                "text": spoken_text if index not in revealed else "",
                "data": base64.b64encode(packet.audio).decode("ascii"),
            }
            if isinstance(packet, AudioPacket):
                payload.update(format="pcm16", sample_rate=packet.sample_rate)
            revealed.add(index)
            await emit(payload)

        pipeline = SpeechPipeline(synthesize, deliver)

        async def queue(chunk: str, bound: bool = True) -> None:
            nonlocal seq, spoken_any
            speech_text = _speakable(chunk)
            if not speech_text:
                return
            if bound and len(speech_text) > MAX_CHUNK_CHARS:
                for piece in _bound(speech_text):
                    await queue(piece, bound=False)
                return
            if seq >= MAX_SPOKEN_CHUNKS:
                await emit({"type": "caption", "text": speech_text})
                return
            spoken_any = True
            seq += 1
            # Snapshot preferences at submission, so in-flight phrases cannot
            # change language because a later settings event arrived.
            await pipeline.submit(seq, speech_text, self.language, self.voice)

        def _report_timings() -> None:
            """One line per turn: where the time actually went.

            Wrapped because measurement must never be able to break the thing
            it measures. An earlier version of this code took voice down
            entirely with an UnboundLocalError -- a diagnostic that costs you
            the feature is worse than no diagnostic.
            """
            try:
                total = time.perf_counter() - turn_started
                think = (first_text_at - turn_started) if first_text_at else None
                speak = (first_audio_at - turn_started) if first_audio_at else None
                if think is not None:
                    voice_metrics.record("commit_to_text_ms", think * 1000)
                if speak is not None:
                    voice_metrics.record("commit_to_audio_sent_ms", speak * 1000)
                logger.info(
                    "voice turn: think=%s first-audio=%s total=%.2fs",
                    f"{think:.2f}s" if think else "-",
                    f"{speak:.2f}s" if speak else "-",
                    total,
                )
            except Exception:  # pragma: no cover - never fail a turn for a log line
                logger.debug("timing report failed", exc_info=True)

        try:
            async for event in run_turn(text, voice=True, language=self.language):
                if generation != self._generation:
                    return

                kind = event["type"]
                data = event.get("data", {})

                if kind == "text":
                    if first_text_at is None:
                        first_text_at = time.perf_counter()
                    buffer += data["text"]
                    reply_parts.append(data["text"])
                    # Captions are cleaned too — the user should read what they
                    # hear, not the asterisks the model happened to emit.
                    visible = _strip_markup(data["text"])
                    if visible:
                        await emit({"type": "delta", "text": visible})

                    # Get the *first* chunk out as fast as possible: it is the
                    # only one whose synthesis the user actually waits through.
                    if not spoken_any:
                        opener, remainder = _first_chunk(buffer)
                        if opener:
                            await queue(opener, bound=False)
                            buffer = remainder

                    if spoken_any:
                        ready, buffer = _split_sentences(
                            buffer, settings.jarvis_tts_chunk_chars
                        )
                        for chunk in ready:
                            await queue(chunk)
                    # NOTE: no "speaking" state is announced here. Queuing a
                    # chunk only means synthesis has *started* — the audio has
                    # not been generated, sent, decoded or played yet. Claiming
                    # "speaking" now lights the UI up the instant the user stops
                    # talking, seconds before any sound. Only the client knows
                    # when a buffer actually reaches the speaker, so the client
                    # owns that transition.


                elif kind == "tool_result":
                    # `display` rides along so a spoken request can reshape the
                    # screen. Asking out loud is the primary way this is used,
                    # so the voice path must carry the same surface descriptor
                    # the typed path does -- otherwise the panels only ever
                    # appear for people who type, which is backwards.
                    await emit(
                        {
                            "type": "tool",
                            "name": data["name"],
                            "ok": data["ok"],
                            "display": data.get("display"),
                        }
                    )
                    # A spoken "switch to Telugu" or "use a girl's voice" must
                    # take effect from the very next synthesized chunk, not the
                    # next turn.
                    if data["name"] in ("set_language", "set_voice") and data["ok"]:
                        await self.load_preferences()
                        await emit({"type": "language", "value": self.language})
                        await emit({"type": "voice", "value": self.voice})
                elif kind == "surface":
                    # Intent-derived, emitted before the model answers, so the
                    # panel is already up while JARVIS is still talking.
                    # The whole descriptor, not just `kind` — `day` carries
                    # the offset that makes "what's on tomorrow" open on
                    # tomorrow. Forwarding only the kind silently dropped it,
                    # so a spoken request always opened on today.
                    await emit({"type": "surface", **data})

                elif kind == "refresh":
                    await emit({"type": "refresh", "domains": data["domains"]})
                elif kind == "error":
                    await emit({"type": "error", "message": data["message"]})

            # Anything left after the stream ends is a final, unterminated line.
            if buffer.strip():
                await queue(buffer)
            await pipeline.finish()
            _report_timings()

            if generation == self._generation:
                # Send the cleaned form: the transcript should read as what was
                # said, not carry markup the listener never heard.
                await emit(
                    {"type": "turn_end", "text": _speakable("".join(reply_parts))}
                )
                await emit({"type": "state", "value": "listening"})

        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.exception("Voice turn failed")
            await emit({"type": "error", "message": f"Turn failed: {exc}"})
            await emit({"type": "turn_end", "text": _speakable("".join(reply_parts))})
            await emit({"type": "state", "value": "listening"})

        finally:
            await pipeline.close()

    async def _guarded_turn(self, text: str, generation: int) -> None:
        """Run a turn under a hard deadline.

        Without this a pathological turn — a slow vendor, a runaway reply, a
        stalled synthesis — leaves the user staring at "Thinking" indefinitely
        with no way back to listening.
        """
        try:
            await asyncio.wait_for(
                self.handle_turn(text, generation), TURN_TIMEOUT_SECONDS
            )
        except asyncio.TimeoutError:
            logger.warning("Voice turn exceeded %.0fs; abandoning", TURN_TIMEOUT_SECONDS)
            if generation == self._generation:
                await self.send(
                    {
                        "type": "error",
                        "message": "That one took too long — ask me again?",
                    }
                )
                await self.send({"type": "turn_end", "text": ""}, generation)
                await self.send({"type": "state", "value": "listening"}, generation)
        except asyncio.CancelledError:
            raise

    async def start_turn(self, text: str) -> None:
        await self.cancel_turn()
        self._generation += 1
        self._audio_slots = asyncio.Semaphore(20)
        self._outstanding_audio.clear()
        generation = self._generation
        # Tell the client which turn is now current. Audio for the previous
        # reply can still be in flight over the socket, and playing it would
        # put the tail of the last answer in front of this one.
        await self.send({"type": "turn", "gen": generation})
        self.turn = asyncio.create_task(self._guarded_turn(text, generation))

    # -- input --------------------------------------------------------------

    async def on_segment(self, encoded: str) -> None:
        """Transcribe one segment of a still-in-progress utterance.

        The client closes a segment after a short pause and keeps listening, so
        this runs *while the user is still talking*. That takes transcription
        off the critical path — by the time they stop, everything but the last
        segment is already text.

        The turn ends here only if the segment ends with a stop word; otherwise
        it waits for the client's long-silence `end_turn`.
        """
        if self.halted or self._input_failed:
            return
        try:
            audio = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError):
            self._input_failed = True
            self._heard.clear()
            await self.send({"type": "error", "message": "Malformed audio payload."})
            return
        if not audio:
            return
        if len(audio) > settings.max_audio_bytes:
            self._input_failed = True
            self._heard.clear()
            await self.send({"type": "error", "message": "That clip was too long."})
            return

        stt_started = time.perf_counter()
        try:
            stt = get_stt_provider()
            logger.info("stt started: bytes=%d", len(audio))
            await self.send({"type": "progress", "stage": "recognizing"})
            async with asyncio.timeout(RECOGNITION_TIMEOUT_SECONDS):
                result = await stt.transcribe(
                    audio, filename="segment.wav", content_type="audio/wav"
                )
        except ProviderOutOfCredit as exc:
            # Every spoken segment hits transcription, so an empty account
            # turns one conversation into a stream of identical failures --
            # the device log showed fourteen 402s in ninety seconds. Say it
            # once and stop listening, rather than letting the user keep
            # talking into something that cannot answer.
            await self.send({"type": "error", "message": str(exc)})
            await self.send({"type": "state", "value": "idle"})
            self.halted = True
            return
        except (ProviderError, TimeoutError) as exc:
            self._input_failed = True
            self._heard.clear()
            logger.warning("stt failed: %s after %.2fs", type(exc).__name__, time.perf_counter() - stt_started)
            message = str(exc) or "Speech recognition timed out. Please try speaking again."
            await self.send({"type": "error", "input_failed": True, "message": message})
            await self.send({"type": "state", "value": "listening"})
            return

        # "…period" / "…that's it" is the user declaring they are finished. It
        # is punctuation, not part of the question, so it never reaches the
        # model — and it ends the turn immediately instead of waiting out the
        # silence timer.
        voice_metrics.record("stt_ms", (time.perf_counter() - stt_started)*1000)
        logger.info("stt: %.2fs for %d bytes, transcript_chars=%d", time.perf_counter() - stt_started, len(audio), len(result.text))

        text, finished = strip_stop_word(result.text)
        if text:
            self._heard.append(text)
            await self._follow_spoken_language(result)

        # Echo the running transcript so the screen keeps up with the speaker.
        combined = " ".join(self._heard).strip()
        if combined:
            await self.send({"type": "transcript", "text": combined})
        else:
            await self.send({"type": "error", "input_failed": True, "message": "I couldn't make out any words. Please try again."})
            await self.send({"type": "state", "value": "listening"})

        if finished:
            logger.info("Turn ended by stop word")
            await self.end_turn()

    #: How sure the transcriber must be before the session changes language.
    #:
    #: Sarvam reports a probability per utterance. Short replies -- "ok",
    #: "haan", a name -- score low and look like whichever language the
    #: phonemes happen to resemble, so a low bar makes the session flip about
    #: mid-conversation. High enough that a full sentence clears it easily and
    #: a grunt does not.
    LANGUAGE_SWITCH_CONFIDENCE = 0.75

    async def _follow_spoken_language(self, result: Any) -> None:
        """Adopt the language the user just spoke, if they clearly switched.

        Silent when nothing changed, which is almost every turn.
        """
        spoken = getattr(result, "language_code", None)
        confidence = getattr(result, "confidence", None)

        if not spoken or spoken == AUTO_DETECT:
            return
        if spoken == self.language:
            return
        if not is_supported(spoken):
            # Detected something real that this build cannot speak. Staying put
            # is the honest outcome; switching would mean replying in a voice
            # that does not exist.
            logger.info("Heard %s, which is not a supported reply language", spoken)
            return
        if confidence is not None and confidence < self.LANGUAGE_SWITCH_CONFIDENCE:
            logger.info(
                "Heard %s at %.2f confidence; below the switch threshold",
                spoken, confidence,
            )
            return

        previous = self.language
        self.language = spoken
        await crud.set_preference("voice_language", spoken)
        # The selector must not disagree with the voice. Telling the client is
        # what keeps the label and the speech the same thing.
        await self.send({"type": "language", "value": spoken})
        logger.info(
            "Language followed the speaker: %s -> %s (%.2f)",
            previous, spoken, confidence if confidence is not None else -1.0,
        )

    async def end_turn(self) -> None:
        """Close the utterance and run whatever has accumulated."""
        if self.halted:
            self._heard.clear()
            return
        if self._input_failed:
            self._heard.clear()
            self._input_failed = False
            await self.send({"type": "state", "value": "listening"})
            return
        combined = " ".join(self._heard).strip()
        self._heard.clear()

        if not combined:
            # Silence, noise, or a bare stop word — back to listening rather
            # than burning a model call on nothing.
            await self.send({"type": "state", "value": "listening"})
            return

        await self.start_turn(combined)


@router.websocket("/api/voice/session")
async def voice_session(websocket: WebSocket) -> None:
    await websocket.accept()

    if not settings.jarvis_voice_enabled or not settings.has_api_key:
        await websocket.send_json(
            {"type": "error", "message": "Voice is not configured on this server."}
        )
        await websocket.close()
        return

    session = VoiceSession(websocket)
    await session.load_preferences()
    await session.send({"type": "language", "value": session.language})
    await session.send({"type": "voice", "value": session.voice})
    await session.send({"type": "state", "value": "listening"})

    try:
        while True:
            # The receive loop never blocks on a turn — turns run as tasks, so
            # an interrupt can land mid-reply and cancel it.
            message = await websocket.receive_json()
            kind = message.get("type")

            if kind in ("segment", "end_turn", "utterance", "text"):
                # ASR stays ordered in its worker; controls and playback credits
                # never wait for a remote transcription HTTP response.
                await session.enqueue_input(message)
            elif kind == "language":
                requested = str(message.get("value") or "")
                if is_supported(requested):
                    await crud.set_preference(crud.PREF_VOICE_LANGUAGE, requested)
                    await session.load_preferences()
                    await session.send({"type": "language", "value": session.language})
            elif kind == "voice":
                requested = str(message.get("value") or "")
                if voice_supported(requested):
                    await crud.set_preference(crud.PREF_VOICE_SPEAKER, requested)
                    await session.load_preferences()
                    await session.send({"type": "voice", "value": session.voice})
            elif kind == "playback_started":
                if message.get("gen") == session._generation:
                    elapsed = message.get("speech_end_ms")
                    if isinstance(elapsed, (int, float)):
                        voice_metrics.record("speech_end_to_playback_ms", elapsed)
            elif kind == "audio_played":
                if message.get("gen") == session._generation:
                    seq = message.get("seq")
                    if isinstance(seq, int) and seq in session._outstanding_audio:
                        session._outstanding_audio.remove(seq)
                        session._audio_slots.release()
            elif kind == "interrupt":
                await session.reset_input()
                await session.cancel_turn()
                await session.send({"type": "state", "value": "listening", "gen": session._generation})
            elif kind == "ping":
                await session.send({"type": "pong"})

    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    except Exception:  # noqa: BLE001
        logger.exception("Voice session error")
    finally:
        await session.reset_input()
        await session.cancel_turn()
