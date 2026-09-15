"""Exact-effect approvals and local pairing tokens for durable runtime work."""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from app.agent_runtime.contracts import (
    ApprovalDecision,
    ApprovalRequest,
    EffectClass,
)
from app.agent_runtime.repository import RuntimeRepository, _now


class AuthenticationError(PermissionError):
    pass


class AuthorizationError(PermissionError):
    pass


class ApprovalError(PermissionError):
    pass


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def approval_hash(request: ApprovalRequest) -> str:
    """Hash every material target/content/precondition field, never just a tool name."""
    return hashlib.sha256(_canonical(request.model_dump(mode="json")).encode("utf-8")).hexdigest()


def _expiry(seconds: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat(
        timespec="seconds"
    ).replace("+00:00", "Z")


class LocalAuthenticator:
    """Memory-only pairing sessions; no long-lived token is placed in a URL/log."""

    def __init__(self, bootstrap_secret: str) -> None:
        self._bootstrap_hash = hashlib.sha256(bootstrap_secret.encode("utf-8")).digest()
        self._sessions: dict[str, tuple[bytes, str, datetime]] = {}

    def pair(self, bootstrap_secret: str, *, principal_id: str, ttl_seconds: int = 300) -> str:
        candidate = hashlib.sha256(bootstrap_secret.encode("utf-8")).digest()
        if not hmac.compare_digest(candidate, self._bootstrap_hash):
            raise AuthenticationError("Invalid local pairing secret")
        session_id, secret = uuid.uuid4().hex, secrets.token_urlsafe(32)
        self._sessions[session_id] = (
            hashlib.sha256(secret.encode("utf-8")).digest(),
            principal_id,
            datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds),
        )
        return f"{session_id}.{secret}"

    def authenticate(self, bearer: str) -> str:
        try:
            session_id, secret = bearer.split(".", 1)
            expected, principal_id, expires = self._sessions[session_id]
        except (KeyError, ValueError):
            raise AuthenticationError("Unknown local session") from None
        if datetime.now(timezone.utc) >= expires:
            self._sessions.pop(session_id, None)
            raise AuthenticationError("Expired local session")
        actual = hashlib.sha256(secret.encode("utf-8")).digest()
        if not hmac.compare_digest(actual, expected):
            raise AuthenticationError("Invalid local session")
        return principal_id


class ApprovalService:
    """Three distinct gates: authenticate externally, authorize here, consume approval."""

    SENSITIVE = {
        EffectClass.EXTERNAL_COMMIT,
        EffectClass.DESTRUCTIVE,
        EffectClass.PRIVILEGE_CHANGE,
    }

    def __init__(self, repository: RuntimeRepository, *, policy_version: str = "approval-v1") -> None:
        self.repository = repository
        self.policy_version = policy_version

    async def _authorize_run(self, conn, run_id: str, principal_id: str) -> None:  # noqa: ANN001
        cursor = await conn.execute(
            """SELECT s.principal_id FROM agent_runs r
               JOIN runtime_sessions s ON s.id = r.session_id WHERE r.id = ?""",
            (run_id,),
        )
        row = await cursor.fetchone()
        await cursor.close()
        if row is None or row[0] != principal_id:
            raise AuthorizationError("Principal is not authorized for this run")

    async def propose(
        self,
        *,
        run_id: str,
        principal_id: str,
        request: ApprovalRequest,
        expires_in_seconds: int = 300,
    ) -> dict[str, Any]:
        if request.effect_class not in self.SENSITIVE:
            raise ApprovalError("This effect class does not require an exact approval")
        if expires_in_seconds < 1 or expires_in_seconds > 3600:
            raise ApprovalError("Approval expiry must be between 1 second and 1 hour")
        request_hash = approval_hash(request)
        approval_id, stamp = f"approval_{uuid.uuid4().hex}", _now()
        async with self.repository.database.transaction() as conn:
            await self._authorize_run(conn, run_id, principal_id)
            await conn.execute(
                """INSERT INTO agent_approvals
                   (id, run_id, operation_id, principal_id, request_hash, effect_class,
                    summary, request_json, policy_version, status, expires_at, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)""",
                (
                    approval_id, run_id, request.operation_id, principal_id, request_hash,
                    request.effect_class.value, request.summary, _canonical(request.model_dump(mode="json")),
                    self.policy_version, _expiry(expires_in_seconds), stamp,
                ),
            )
            await self.repository._append_event(  # noqa: SLF001 - same control-plane transaction
                conn, run_id, "approval.pending",
                {"approval_id": approval_id, "operation_id": request.operation_id,
                 "effect_class": request.effect_class.value, "summary": request.summary}, stamp,
            )
        return await self.get(approval_id)

    async def decide(self, approval_id: str, *, principal_id: str, decision: ApprovalDecision) -> dict[str, Any]:
        stamp = _now()
        async with self.repository.database.transaction() as conn:
            cursor = await conn.execute("SELECT * FROM agent_approvals WHERE id = ?", (approval_id,))
            row = await cursor.fetchone()
            await cursor.close()
            if row is None or row["principal_id"] != principal_id:
                raise AuthorizationError("Principal cannot decide this approval")
            if row["status"] != "PENDING":
                raise ApprovalError("Approval is no longer pending")
            if row["expires_at"] <= stamp:
                await conn.execute("UPDATE agent_approvals SET status = 'EXPIRED' WHERE id = ?", (approval_id,))
                raise ApprovalError("Approval expired")
            status = "GRANTED" if decision is ApprovalDecision.GRANT else "DENIED"
            await conn.execute(
                "UPDATE agent_approvals SET status = ?, decided_at = ? WHERE id = ?",
                (status, stamp, approval_id),
            )
            await self.repository._append_event(
                conn, row["run_id"], f"approval.{status.lower()}", {"approval_id": approval_id}, stamp
            )
        return await self.get(approval_id)

    async def consume_for_dispatch(
        self, approval_id: str, *, run_id: str, principal_id: str, request: ApprovalRequest
    ) -> dict[str, Any]:
        """Single-use dispatch gate; changed material request invalidates approval."""
        stamp, current_hash = _now(), approval_hash(request)
        async with self.repository.database.transaction() as conn:
            cursor = await conn.execute("SELECT * FROM agent_approvals WHERE id = ?", (approval_id,))
            row = await cursor.fetchone()
            await cursor.close()
            if row is None or row["run_id"] != run_id or row["principal_id"] != principal_id:
                raise AuthorizationError("Approval does not belong to this principal and run")
            if row["request_hash"] != current_hash:
                await conn.execute("UPDATE agent_approvals SET status = 'INVALIDATED' WHERE id = ?", (approval_id,))
                await self.repository._append_event(
                    conn, run_id, "approval.invalidated", {"approval_id": approval_id, "reason": "changed_effect"}, stamp
                )
                raise ApprovalError("Effect changed; a new approval is required")
            if row["status"] != "GRANTED" or row["expires_at"] <= stamp:
                if row["status"] == "GRANTED" and row["expires_at"] <= stamp:
                    await conn.execute("UPDATE agent_approvals SET status = 'EXPIRED' WHERE id = ?", (approval_id,))
                raise ApprovalError("Approval is not currently dispatchable")
            await conn.execute(
                "UPDATE agent_approvals SET status = 'CONSUMED', consumed_at = ? WHERE id = ?",
                (stamp, approval_id),
            )
            await self.repository._append_event(
                conn, run_id, "approval.consumed", {"approval_id": approval_id, "operation_id": request.operation_id}, stamp
            )
        return await self.get(approval_id)

    async def get(self, approval_id: str) -> dict[str, Any]:
        conn = self.repository.database._connection  # noqa: SLF001
        if conn is None:
            raise RuntimeError("RuntimeDatabase.connect() has not been awaited")
        cursor = await conn.execute("SELECT * FROM agent_approvals WHERE id = ?", (approval_id,))
        row = await cursor.fetchone()
        await cursor.close()
        if row is None:
            raise KeyError(approval_id)
        return dict(row)
