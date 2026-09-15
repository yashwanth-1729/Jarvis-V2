"""Initial one-at-a-time durable worker with a read-only fixture adapter."""

from __future__ import annotations

import json
from dataclasses import dataclass

from app.agent_runtime.repository import RuntimeRepository


@dataclass(slots=True)
class ReadOnlyFixtureAdapter:
    """Deterministic observation source used to prove the runtime lifecycle."""

    fixtures: dict[str, str]
    calls: int = 0

    async def observe(self, query: str) -> str:
        self.calls += 1
        if query not in self.fixtures:
            raise LookupError(f"No read-only fixture exists for {query!r}")
        return self.fixtures[query]


class ReadOnlyWorker:
    WORKFLOW_VERSION = "readonly-fixture-v1"

    def __init__(self, repository: RuntimeRepository, adapter: ReadOnlyFixtureAdapter) -> None:
        self.repository = repository
        self.adapter = adapter

    async def run(self, run_id: str) -> dict:
        run = await self.repository.get_run(run_id)
        if run["status"] in {"COMPLETED", "FAILED", "CANCELLED"}:
            return run
        if run["status"] != "QUEUED":
            raise RuntimeError(f"read-only worker cannot admit run in {run['status']}")

        run = await self.repository.transition_with_event(
            run_id,
            expected_status="QUEUED",
            new_status="RUNNING",
            event_type="run.running",
            payload={"status": "RUNNING", "workflow_version": self.WORKFLOW_VERSION},
        )
        request = json.loads(run["input_json"])
        query = str(request["input"]["text"])
        step = await self.repository.create_step(
            run_id,
            ordinal=0,
            step_type="TOOL",
            acceptance={"kind": "non_empty_observation"},
            workflow_version=self.WORKFLOW_VERSION,
        )
        await self.repository.transition_step_with_event(
            run_id,
            step["id"],
            expected_status="READY",
            new_status="RUNNING",
            event_type="step.running",
            payload={"step_id": step["id"]},
        )
        try:
            observation = await self.adapter.observe(query)
            if not observation.strip():
                raise ValueError("Read-only observation was empty")
        except Exception as exc:  # noqa: BLE001 - terminal fixture outcome
            await self.repository.transition_step_with_event(
                run_id,
                step["id"],
                expected_status="RUNNING",
                new_status="FAILED",
                event_type="step.failed",
                payload={"step_id": step["id"], "error": str(exc)[:1000]},
            )
            return await self.repository.transition_with_event(
                run_id,
                expected_status="RUNNING",
                new_status="FAILED",
                event_type="run.failed",
                payload={"status": "FAILED", "error": str(exc)[:1000]},
            )

        await self.repository.transition_step_with_event(
            run_id,
            step["id"],
            expected_status="RUNNING",
            new_status="VERIFIED",
            event_type="step.verified",
            payload={"step_id": step["id"], "observation": observation[:4000]},
        )
        return await self.repository.transition_with_event(
            run_id,
            expected_status="RUNNING",
            new_status="COMPLETED",
            event_type="run.completed",
            payload={"status": "COMPLETED", "summary": observation[:1000]},
        )
