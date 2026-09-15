"""Durable worker with generation-fenced ownership, cancellation and recovery.

Still fixture-only and read-only (P12's scope): the one thing this worker
does is call a deterministic, side-effect-free `observe()`. P13 adds the
machinery every future adapter needs -- lease claim/renewal, cancellation
that races safely against in-flight writes, and startup recovery -- proven
here where the "operation" is trivially safe to re-run, before any adapter
with a real external effect is allowed to plug in (playbook 10.7).
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from app.agent_runtime.repository import RuntimeRepository, TransitionConflict

TERMINAL_STATUSES = {"COMPLETED", "FAILED", "CANCELLED"}


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

    #: How long a claimed run may go without a heartbeat before another
    #: worker (or this same worker, after a restart) may reclaim it as
    #: stale. Deliberately generous for a synchronous fixture call; a real
    #: adapter would renew well before this via `RuntimeRepository.renew_lease`.
    DEFAULT_LEASE_SECONDS = 30

    def __init__(
        self,
        repository: RuntimeRepository,
        adapter: ReadOnlyFixtureAdapter,
        *,
        worker_id: str = "worker-default",
    ) -> None:
        self.repository = repository
        self.adapter = adapter
        self.worker_id = worker_id

    async def run(self, run_id: str, *, lease_seconds: int | None = None) -> dict:
        lease_seconds = lease_seconds or self.DEFAULT_LEASE_SECONDS
        run = await self.repository.get_run(run_id)
        if run["status"] in TERMINAL_STATUSES:
            return run
        if run["status"] == "CANCEL_REQUESTED":
            # Cancelled before this worker ever claimed it: no step exists,
            # so there is nothing to mark uncertain -- straight to CANCELLED.
            return await self._finalize_cancelled(run_id, expected_generation=run["owner_generation"])
        if run["status"] != "QUEUED":
            raise RuntimeError(f"read-only worker cannot admit run in {run['status']}")

        try:
            claimed = await self.repository.claim_run(
                run_id, worker_id=self.worker_id, lease_seconds=lease_seconds
            )
        except TransitionConflict:
            # Lost the admission race to another worker, or it was cancelled
            # between the read above and this claim attempt. Either way this
            # worker does not own it -- report current truth, write nothing.
            return await self.repository.get_run(run_id)

        return await self._execute(claimed)

    async def recover_stale_runs(self, *, lease_seconds: int | None = None) -> list[dict]:
        """Startup reconciliation: reclaim and resume every stale RUNNING run.

        Per the recovery matrix (playbook 10.5), what happens next depends on
        the last durable fact for that run's one step:

        - no step yet -> resume normally, same as a fresh claim.
        - step READY/RUNNING with no committed result -> this adapter's
          observation is read-only and deterministic, so re-running it is
          explicitly the safe case the matrix allows ("re-run if observation
          freshness/policy permits"). A future adapter with an external,
          non-idempotent effect must NOT reuse this branch as-is.
        - step already VERIFIED -> the crash was between verifying the step
          and finalizing the run; only the run's own COMPLETED transition
          was missing, so this never re-invokes the adapter.
        """
        lease_seconds = lease_seconds or self.DEFAULT_LEASE_SECONDS
        recovered = []
        for run in await self.repository.list_runs_by_status("RUNNING"):
            try:
                claimed = await self.repository.reclaim_stale_run(
                    run["id"], worker_id=self.worker_id, lease_seconds=lease_seconds
                )
            except TransitionConflict:
                continue  # lease still active, or someone else reclaimed it first
            recovered.append(await self._resume(claimed))
        return recovered

    async def _resume(self, run: dict) -> dict:
        steps = await self.repository.list_steps(run["id"])
        if not steps:
            return await self._execute(run)
        step = steps[-1]
        if step["status"] == "VERIFIED":
            try:
                return await self.repository.transition_with_event(
                    run["id"],
                    expected_status="RUNNING",
                    new_status="COMPLETED",
                    event_type="run.completed",
                    payload={"status": "COMPLETED", "recovered": True},
                    expected_generation=run["owner_generation"],
                )
            except TransitionConflict:
                return await self.repository.get_run(run["id"])
        if step["status"] in {"FAILED", "UNCERTAIN", "SKIPPED"}:
            # Already a durable terminal fact for this step; nothing left for
            # this worker to do that the original failure/cancellation path
            # did not already record.
            return await self.repository.get_run(run["id"])
        # READY or RUNNING with no committed result: safe to (re-)execute.
        return await self._execute(run, existing_step=step)

    async def _execute(self, run: dict, *, existing_step: dict | None = None) -> dict:
        run_id = run["id"]
        generation = run["owner_generation"]
        request = json.loads(run["input_json"])
        query = str(request["input"]["text"])

        try:
            if existing_step is None:
                step = await self.repository.create_step(
                    run_id,
                    ordinal=0,
                    step_type="TOOL",
                    acceptance={"kind": "non_empty_observation"},
                    workflow_version=self.WORKFLOW_VERSION,
                    expected_generation=generation,
                )
            else:
                step = existing_step
            if step["status"] == "READY":
                step = await self.repository.transition_step_with_event(
                    run_id,
                    step["id"],
                    expected_status="READY",
                    new_status="RUNNING",
                    event_type="step.running",
                    payload={"step_id": step["id"]},
                    expected_generation=generation,
                )
        except TransitionConflict:
            return await self._reconcile_lost_write(run_id, uncertain_step_id=None, observation=None)

        try:
            observation = await self.adapter.observe(query)
            if not observation.strip():
                raise ValueError("Read-only observation was empty")
        except Exception as exc:  # noqa: BLE001 - terminal fixture outcome
            try:
                await self.repository.transition_step_with_event(
                    run_id,
                    step["id"],
                    expected_status="RUNNING",
                    new_status="FAILED",
                    event_type="step.failed",
                    payload={"step_id": step["id"], "error": str(exc)[:1000]},
                    expected_generation=generation,
                )
                return await self.repository.transition_with_event(
                    run_id,
                    expected_status="RUNNING",
                    new_status="FAILED",
                    event_type="run.failed",
                    payload={"status": "FAILED", "error": str(exc)[:1000]},
                    expected_generation=generation,
                )
            except TransitionConflict:
                return await self._reconcile_lost_write(run_id, uncertain_step_id=step["id"], observation=None)

        try:
            await self.repository.transition_step_with_event(
                run_id,
                step["id"],
                expected_status="RUNNING",
                new_status="VERIFIED",
                event_type="step.verified",
                payload={"step_id": step["id"], "observation": observation[:4000]},
                expected_generation=generation,
            )
            return await self.repository.transition_with_event(
                run_id,
                expected_status="RUNNING",
                new_status="COMPLETED",
                event_type="run.completed",
                payload={"status": "COMPLETED", "summary": observation[:1000]},
                expected_generation=generation,
            )
        except TransitionConflict:
            # The observation genuinely happened (it is in `observation`
            # above) but this worker could not durably commit it as VERIFIED
            # -- most likely a `request_cancel` arrived mid-flight, since that
            # is the only thing that changes run status without bumping
            # `owner_generation`. Never force COMPLETED here: report the
            # uncertainty and let cancellation (or a future reclaim) resolve it.
            return await self._reconcile_lost_write(run_id, uncertain_step_id=step["id"], observation=observation)

    async def _reconcile_lost_write(
        self, run_id: str, *, uncertain_step_id: str | None, observation: str | None
    ) -> dict:
        """A generation-fenced write failed mid-`_execute`. Find out why and settle honestly.

        Two causes are possible: a competing worker's reclaim moved this run
        to a newer generation (nothing left for this worker to do -- it must
        not touch the run again), or a `request_cancel` arrived (this worker
        should finish cancelling it, marking any in-flight step UNCERTAIN
        rather than silently dropping or force-completing it).
        """
        run = await self.repository.get_run(run_id)
        if run["status"] == "CANCEL_REQUESTED":
            return await self._finalize_cancelled(
                run_id,
                expected_generation=run["owner_generation"],
                uncertain_step_id=uncertain_step_id,
                observation=observation,
            )
        return run

    async def _finalize_cancelled(
        self,
        run_id: str,
        *,
        expected_generation: int,
        uncertain_step_id: str | None = None,
        observation: str | None = None,
    ) -> dict:
        if uncertain_step_id is not None:
            try:
                await self.repository.transition_step_with_event(
                    run_id,
                    uncertain_step_id,
                    expected_status="RUNNING",
                    new_status="UNCERTAIN",
                    event_type="step.uncertain",
                    payload={
                        "step_id": uncertain_step_id,
                        "reason": "cancelled before its result could be durably verified",
                        "observation": (observation or "")[:4000],
                    },
                    expected_generation=expected_generation,
                    require_run_status="CANCEL_REQUESTED",
                )
            except TransitionConflict:
                pass  # already resolved (e.g. reclaimed by a newer generation); proceed
        try:
            return await self.repository.transition_with_event(
                run_id,
                expected_status="CANCEL_REQUESTED",
                new_status="CANCELLED",
                event_type="run.cancelled",
                payload={"status": "CANCELLED"},
                expected_generation=expected_generation,
            )
        except TransitionConflict:
            return await self.repository.get_run(run_id)
