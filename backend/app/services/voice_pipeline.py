"""Ordered, bounded speech stages with structured cancellation."""
from __future__ import annotations

import asyncio
from contextlib import aclosing
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any


class SpeechPipeline:
    def __init__(
        self, synthesize: Callable[[str, str, str], AsyncIterator[Any]],
        deliver: Callable[[int, str, Any], Awaitable[None]],
    ) -> None:
        self.synthesize = synthesize
        self.deliver = deliver
        self.jobs: asyncio.Queue = asyncio.Queue(maxsize=2)
        self.slots = asyncio.Semaphore(2)
        self.tasks: set[asyncio.Task] = set()
        self.sender = asyncio.create_task(self._send())

    async def submit(self, index: int, text: str, language: str, voice: str) -> None:
        await self._while_sending(self.slots.acquire())
        packets: asyncio.Queue = asyncio.Queue(maxsize=8)
        async def produce() -> None:
            try:
                async with aclosing(self.synthesize(text, language, voice)) as stream:
                    async for packet in stream:
                        await packets.put(packet)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                await packets.put(exc)
            finally:
                # Cancellation must never block trying to insert into a full queue.
                if not asyncio.current_task().cancelling():
                    await packets.put(None)
        task = asyncio.create_task(produce())
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        await self.jobs.put((index, text, packets))

    async def _send(self) -> None:
        while (job := await self.jobs.get()) is not None:
            index, text, packets = job
            try:
                while (packet := await packets.get()) is not None:
                    await self.deliver(index, text, packet)
            finally:
                self.slots.release()

    async def _while_sending(self, operation) -> None:
        waiter = asyncio.create_task(operation)
        try:
            await asyncio.wait([waiter, self.sender], return_when=asyncio.FIRST_COMPLETED)
            if self.sender.done():
                await self.sender
                raise RuntimeError("Speech sender has already stopped")
            await waiter
        finally:
            if not waiter.done():
                waiter.cancel()
                await asyncio.gather(waiter, return_exceptions=True)

    async def finish(self) -> None:
        if self.sender.done():
            await self.sender
            return
        await self.jobs.put(None)
        await self.sender

    async def close(self) -> None:
        tasks = [self.sender, *self.tasks]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
