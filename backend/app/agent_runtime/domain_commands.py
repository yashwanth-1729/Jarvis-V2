"""Durable outbox for commands owned by personal-data stores, never direct writes."""
from __future__ import annotations

import json
from typing import Any, Literal

from app.agent_runtime.database import RuntimeDatabase
from app.agent_runtime.repository import RuntimeRepository, _now

CommandStatus = Literal['PENDING', 'DELIVERED', 'APPLIED', 'ALREADY_APPLIED', 'CONFLICT', 'REJECTED', 'UNAVAILABLE']


class DomainCommandService:
    def __init__(self, database: RuntimeDatabase) -> None:
        self.database = database
        self.repository = RuntimeRepository(database)

    async def enqueue(self, *, operation_id: str, run_id: str, destination_owner: Literal['BACKEND', 'CLIENT'], command: dict[str, Any], target_uid: str | None = None, expected_revision: str | None = None, approval_id: str | None = None) -> dict[str, Any]:
        stamp = _now()
        async with self.database.transaction() as conn:
            existing = await (await conn.execute('SELECT * FROM domain_commands WHERE operation_id = ?', (operation_id,))).fetchone()
            encoded = json.dumps(command, sort_keys=True, separators=(',', ':'))
            if existing is not None:
                if existing['run_id'] != run_id or existing['command_json'] != encoded:
                    raise ValueError('operation_id belongs to different durable command')
                return dict(existing)
            await conn.execute('''INSERT INTO domain_commands (operation_id, run_id, destination_owner, target_uid, expected_revision, command_json, approval_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)''', (operation_id, run_id, destination_owner, target_uid, expected_revision, encoded, approval_id, stamp))
            await self.repository._append_event(conn, run_id, 'domain_command.queued', {'operation_id': operation_id, 'destination_owner': destination_owner}, stamp)
        return await self.get(operation_id)

    async def pending_for_owner(self, destination_owner: Literal['BACKEND', 'CLIENT']) -> list[dict[str, Any]]:
        conn = self._conn()
        rows = await (await conn.execute("SELECT * FROM domain_commands WHERE destination_owner = ? AND status IN ('PENDING', 'DELIVERED') ORDER BY created_at", (destination_owner,))).fetchall()
        return [dict(row) for row in rows]

    async def acknowledge(self, operation_id: str, *, status: CommandStatus, result: dict[str, Any] | None = None) -> dict[str, Any]:
        if status not in {'APPLIED', 'ALREADY_APPLIED', 'CONFLICT', 'REJECTED', 'UNAVAILABLE'}:
            raise ValueError('acknowledgement must be a terminal owner result')
        stamp = _now()
        async with self.database.transaction() as conn:
            row = await (await conn.execute('SELECT * FROM domain_commands WHERE operation_id = ?', (operation_id,))).fetchone()
            if row is None:
                raise KeyError(operation_id)
            if row['status'] in {'APPLIED', 'ALREADY_APPLIED'}:
                return dict(row)
            await conn.execute('UPDATE domain_commands SET status = ?, result_json = ?, acknowledged_at = ? WHERE operation_id = ?', (status, json.dumps(result or {}, sort_keys=True), stamp, operation_id))
            await self.repository._append_event(conn, row['run_id'], 'domain_command.acknowledged', {'operation_id': operation_id, 'status': status}, stamp)
        return await self.get(operation_id)

    async def get(self, operation_id: str) -> dict[str, Any]:
        row = await (await self._conn().execute('SELECT * FROM domain_commands WHERE operation_id = ?', (operation_id,))).fetchone()
        if row is None:
            raise KeyError(operation_id)
        return dict(row)

    def _conn(self):
        if self.database._connection is None:  # noqa: SLF001
            raise RuntimeError('RuntimeDatabase.connect() has not been awaited')
        return self.database._connection  # noqa: SLF001
