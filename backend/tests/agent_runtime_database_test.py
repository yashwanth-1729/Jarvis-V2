"""P10 isolated durable-runtime database checks."""

from __future__ import annotations

import asyncio
import io
import sqlite3
import sys
import tempfile
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")


async def main() -> int:
    from app.agent_runtime.database import RuntimeDatabase

    root = Path(tempfile.mkdtemp(prefix="jarvis_runtime_db_test_"))
    path = root / "runtime.db"
    database = RuntimeDatabase(path)
    await database.connect()
    assert database._connection is not None  # noqa: SLF001 - storage invariant fixture
    conn = database._connection  # noqa: SLF001
    tables = {row[0] for row in await (await conn.execute("SELECT name FROM sqlite_master WHERE type='table'")).fetchall()}
    journal = (await (await conn.execute("PRAGMA journal_mode")).fetchone())[0]
    synchronous = int((await (await conn.execute("PRAGMA synchronous")).fetchone())[0])
    foreign_keys = int((await (await conn.execute("PRAGMA foreign_keys")).fetchone())[0])
    version = int((await (await conn.execute("PRAGMA user_version")).fetchone())[0])
    await database.disconnect()

    checks = [
        ("control-plane tables exist", {"runtime_sessions", "agent_runs", "agent_steps", "agent_events"} <= tables),
        ("personal tables are absent", not ({"tasks", "schedules", "memories", "chat_messages"} & tables)),
        ("WAL is enabled", str(journal).lower() == "wal"),
        ("critical writes use synchronous FULL", synchronous == 2),
        ("foreign keys are enforced", foreign_keys == 1),
        ("schema version is explicit", version == 3),
    ]

    newer = root / "newer.db"
    raw = sqlite3.connect(newer)
    raw.execute("PRAGMA user_version = 99")
    raw.close()
    rejected = False
    try:
        await RuntimeDatabase(newer).connect()
    except RuntimeError:
        rejected = True
    checks.append(("newer schema is refused without wipe", rejected))

    for label, passed in checks:
        print(f"  [{'PASS' if passed else 'FAIL'}] {label}")
    print("\n" + "=" * 60)
    print(f"{sum(ok for _, ok in checks)}/{len(checks)} checks passed")
    return 0 if all(ok for _, ok in checks) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
