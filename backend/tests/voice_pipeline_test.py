"""Offline regression tests: ordering, boundedness, cancellation and wire format.
Run: .venv/Scripts/python -B tests/voice_pipeline_test.py
No application database or real provider requests are used.
"""
import asyncio
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
from app.providers.base import AudioPacket, ProviderError, Speech, Transcript
from app.providers.sarvam import SarvamTTS, SarvamSTT
from app.services.voice_pipeline import SpeechPipeline
from app.services import speech, voice_metrics
from app.api import realtime


class PipelineTests(unittest.IsolatedAsyncioTestCase):
    async def test_recognition_timeout_returns_to_listening_without_partial_command(self):
        events = []
        cancelled = asyncio.Event()
        class Socket:
            query_params = {}
            async def send_json(self, payload): events.append(payload)
        class STT:
            async def transcribe(self, *args, **kwargs):
                try: await asyncio.Event().wait()
                finally: cancelled.set()
        session = realtime.VoiceSession(Socket())
        session._heard = ["delete all tasks"]
        with patch.object(realtime, "get_stt_provider", return_value=STT()), patch.object(realtime, "RECOGNITION_TIMEOUT_SECONDS", 0.02):
            await asyncio.wait_for(session.on_segment("YQ=="), 1)
        self.assertTrue(cancelled.is_set())
        self.assertEqual(session._heard, [])
        self.assertTrue(any(e.get("input_failed") for e in events))
        self.assertEqual(events[-1], {"type": "state", "value": "listening"})
        await session.end_turn()
        self.assertIsNone(session.turn)

    async def test_audio_input_transcript_answer_and_audio_are_ordered(self):
        events = []
        class Socket:
            query_params = {}
            async def send_json(self, payload): events.append(payload)
        class STT:
            async def transcribe(self, *args, **kwargs):
                return Transcript("The sky is blue.")
        async def agent(*args, **kwargs):
            yield {"type": "text", "data": {"text": "Yes, that is correct."}}
        async def synth(*args, **kwargs): yield Speech(b"test-audio")
        session = realtime.VoiceSession(Socket())
        with patch.object(realtime, "get_stt_provider", return_value=STT()), patch.object(realtime, "run_turn", agent), patch.object(speech, "stream", synth):
            await session.on_segment("YQ==")
            await session.end_turn()
            await asyncio.wait_for(session.turn, 1)
        types = [e["type"] for e in events]
        self.assertLess(types.index("transcript"), types.index("turn"))
        self.assertLess(types.index("turn"), types.index("audio"))
        self.assertEqual(events[-1]["value"], "listening")

    async def test_slow_asr_is_cancellable_and_does_not_block_enqueue(self):
        started = asyncio.Event()
        cancelled = asyncio.Event()
        class Socket:
            query_params = {}
            async def send_json(self, payload): pass
        class STT:
            async def transcribe(self, *args, **kwargs):
                started.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    cancelled.set()
        session = realtime.VoiceSession(Socket())
        with patch.object(realtime, "get_stt_provider", return_value=STT()):
            await session.enqueue_input({"type": "segment", "audio": "YQ=="})
            await asyncio.wait_for(started.wait(), 1)
            await asyncio.wait_for(session.enqueue_input({"type": "end_turn"}), 0.1)
            await asyncio.wait_for(session.reset_input(), 0.1)
        self.assertTrue(cancelled.is_set())
        self.assertTrue(session._input_queue.empty())
        self.assertEqual(session._heard, [])

    async def test_failed_asr_cannot_execute_a_partial_command(self):
        class Socket:
            query_params = {}
            async def send_json(self, payload): pass
        class STT:
            async def transcribe(self, *args, **kwargs): raise ProviderError("failed")
        session = realtime.VoiceSession(Socket())
        session._heard = ["delete the tasks"]
        with patch.object(realtime, "get_stt_provider", return_value=STT()):
            await session.on_segment("YQ==")
        await session.end_turn()
        self.assertIsNone(session.turn)
        self.assertEqual(session._heard, [])

    async def test_audio_delivers_while_agent_is_waiting(self):
        sent = asyncio.Event()
        resume_agent = asyncio.Event()
        events = []
        class Socket:
            query_params = {}
            async def send_json(self, payload):
                events.append(payload)
                if payload["type"] == "audio": sent.set()
        async def agent(*args, **kwargs):
            yield {"type": "text", "data": {"text": "Here is your requested answer. "}}
            await resume_agent.wait()
        async def synth(*args, **kwargs):
            yield Speech(b"test-wav")
        session = realtime.VoiceSession(Socket())
        with patch.object(realtime, "run_turn", agent), patch.object(speech, "stream", synth):
            task = asyncio.create_task(session.handle_turn("hello", 0))
            try:
                await asyncio.wait_for(sent.wait(), 1)
                self.assertFalse(task.done(), "audio must not wait for the next agent event")
                resume_agent.set()
                await task
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        audio = [e for e in events if e["type"] == "audio"]
        self.assertEqual(audio[0]["seq"], 1)
        self.assertTrue(all(e["gen"] == 0 for e in events))
        self.assertEqual(events[-2]["type"], "turn_end")

    async def test_faster_second_phrase_cannot_overtake_first(self):
        gate = asyncio.Event()
        delivered = []
        async def synth(text, *_):
            if text == "one": await gate.wait()
            yield text
        async def deliver(index, text, packet): delivered.append((index, packet))
        pipeline = SpeechPipeline(synth, deliver)
        try:
            await pipeline.submit(1, "one", "en-IN", "priya")
            await pipeline.submit(2, "two", "en-IN", "priya")
            await asyncio.sleep(0)
            self.assertEqual(delivered, [])
            gate.set()
            await pipeline.finish()
            self.assertEqual(delivered, [(1, "one"), (2, "two")])
        finally: await pipeline.close()

    async def test_backpressure_is_bounded_and_close_cancels_producers(self):
        generated = 0
        closed = asyncio.Event()
        blocked = asyncio.Event()
        async def synth(*_):
            nonlocal generated
            try:
                for index in range(10000):
                    generated += 1
                    yield index
            finally: closed.set()
        async def deliver(*_): await blocked.wait()
        pipeline = SpeechPipeline(synth, deliver)
        await pipeline.submit(1, "one", "en-IN", "priya")
        await asyncio.sleep(0.02)
        self.assertLessEqual(generated, 10)  # 8 buffered + delivering + pending put
        await asyncio.wait_for(pipeline.close(), 1)
        self.assertTrue(closed.is_set())

    async def test_synthesis_failure_stays_in_phrase_order(self):
        delivered = []
        async def synth(text, *_):
            if text == "one": raise ProviderError("unavailable")
            yield text
        async def deliver(index, text, packet): delivered.append((index, packet))
        pipeline = SpeechPipeline(synth, deliver)
        try:
            await pipeline.submit(1, "one", "en-IN", "priya")
            await pipeline.submit(2, "two", "en-IN", "priya")
            await pipeline.finish()
            self.assertIsInstance(delivered[0][1], ProviderError)
            self.assertEqual(delivered[1], (2, "two"))
        finally: await pipeline.close()

    async def test_sender_failure_does_not_leave_submit_hanging(self):
        async def synth(*_): yield "audio"
        async def deliver(*_): raise RuntimeError("socket failed")
        pipeline = SpeechPipeline(synth, deliver)
        try:
            await pipeline.submit(1, "one", "en-IN", "priya")
            await asyncio.sleep(0.01)
            with self.assertRaisesRegex(RuntimeError, "socket failed"):
                await asyncio.wait_for(pipeline.submit(2, "two", "en-IN", "priya"), 1)
        finally: await pipeline.close()

    async def test_pcm_window_blocks_until_playback_credit_returns(self):
        sent = []
        reached_window = asyncio.Event()
        class Socket:
            query_params = {"audio": "pcm16"}
            async def send_json(self, payload):
                if payload["type"] == "audio":
                    sent.append(payload)
                    if len(sent) == 20: reached_window.set()
        async def agent(*args, **kwargs):
            yield {"type": "text", "data": {"text": "Here is your requested answer. "}}
        async def synth(*args, **kwargs):
            for _ in range(25): yield AudioPacket(bytes(4800), 24000)
        session = realtime.VoiceSession(Socket())
        with patch.object(realtime, "run_turn", agent), patch.object(speech, "stream", synth):
            task = asyncio.create_task(session.handle_turn("hello", 0))
            try:
                await asyncio.wait_for(reached_window.wait(), 1)
                await asyncio.sleep(0.01)
                self.assertEqual(len(sent), 20)
                for _ in range(5): session._audio_slots.release()
                await asyncio.wait_for(task, 1)
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        self.assertEqual([p["seq"] for p in sent], list(range(1, 26)))
        self.assertEqual(sum(bool(p["text"]) for p in sent), 1)

    async def test_generation_is_checked_after_acquiring_send_lock(self):
        sent = []
        class Socket:
            query_params = {}
            async def send_json(self, payload): sent.append(payload)
        session = realtime.VoiceSession(Socket())
        await session._send_lock.acquire()
        pending = asyncio.create_task(session.send({"type": "audio"}, 0))
        await asyncio.sleep(0)
        session._generation = 1
        session._send_lock.release()
        await pending
        self.assertEqual(sent, [])


class FragmentedPCM(httpx.AsyncByteStream):
    async def __aiter__(self):
        yield b"\x01"
        yield b"\x00" * 5000
        yield b"\x00" * 3


class ProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_recognition_retries_are_short_and_bounded(self):
        requests = []
        def handle(request):
            requests.append(request)
            raise httpx.ReadTimeout("")
        provider = SarvamSTT()
        provider._client = httpx.AsyncClient(base_url="https://test.invalid", transport=httpx.MockTransport(handle))
        try:
            with self.assertRaisesRegex(ProviderError, "Speech recognition could not finish"):
                await provider.transcribe(b"audio")
            self.assertEqual(len(requests), 2)
            self.assertEqual(requests[0].extensions["timeout"]["read"], 8)
            self.assertEqual(requests[0].extensions["timeout"]["connect"], 5)
        finally: await provider.aclose()

    async def test_pcm_sample_boundaries_and_stream_request(self):
        requests = []
        def handle(request):
            requests.append(request)
            return httpx.Response(200, headers={"content-type": "audio/pcm"}, stream=FragmentedPCM())
        provider = SarvamTTS()
        provider._client = httpx.AsyncClient(base_url="https://test.invalid", transport=httpx.MockTransport(handle))
        try:
            packets = [packet async for packet in provider.stream_speech("Hello there.", "en-IN", "priya", 1)]
            self.assertEqual(sum(len(p.audio) for p in packets), 5004)
            self.assertTrue(all(len(p.audio) % 2 == 0 for p in packets))
            self.assertEqual(str(requests[0].url), "https://test.invalid/text-to-speech/stream")
            self.assertIn(b'"output_audio_codec":"linear16"', requests[0].content)
            self.assertIn(b'"language_code":"en-IN"', requests[0].content)
        finally: await provider.aclose()

    async def test_fallback_only_before_first_audio(self):
        class Provider:
            async def stream_speech(self, *args):
                raise ProviderError("no stream")
                yield
        async def fallback(*args): return Speech(b"wav")
        # Patch the routed provider, not the Sarvam getter specifically: English
        # now resolves through `_provider_for` (Piper on desktop), so the
        # fallback contract is exercised by replacing whatever it returns.
        with patch.object(speech, "_provider_for", return_value=Provider()), patch.object(speech, "speak", fallback):
            packets = [p async for p in speech.stream("hello", "en-IN", "priya")]
            self.assertEqual(packets[0].audio, b"wav")
        class Partial:
            async def stream_speech(self, *args):
                yield AudioPacket(bytes(2), 24000)
                raise ProviderError("broken mid-phrase")
        with patch.object(speech, "_provider_for", return_value=Partial()), patch.object(speech, "speak", side_effect=AssertionError("must not replay")):
            with self.assertRaises(ProviderError):
                async for _ in speech.stream("hello", "en-IN", "priya"): pass

    def test_metrics_are_bounded_and_ignore_unknown_fields(self):
        voice_metrics._samples.clear()
        for index in range(150): voice_metrics.record("stt_ms", index)
        voice_metrics.record("prompt_text", 20)
        voice_metrics.record("stt_ms", float("nan"))
        stats = voice_metrics.snapshot()["stages"]
        self.assertNotIn("prompt_text", stats)
        self.assertEqual(stats["stt_ms"], {"count": 100, "p50": 99, "p90": 139, "p99": 148})


if __name__ == "__main__": unittest.main(verbosity=2)
