"""P11 migration rollback and verified backup/restore fixtures."""

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
    import aiosqlite
    from app.agent_runtime import migrations
    from app.agent_runtime.database import RuntimeDatabase
    from app.agent_runtime.maintenance import backup_quiesced, restore_quiesced
    from app.agent_runtime.repository import RuntimeRepository

    root = Path(tempfile.mkdtemp(prefix="jarvis_runtime_migration_test_"))
    legacy = root / "legacy.db"
    raw = sqlite3.connect(legacy)
    raw.execute("PRAGMA user_version = 1")
    raw.commit()
    raw.close()
    upgraded = RuntimeDatabase(legacy)
    await upgraded.connect()
    assert upgraded._connection is not None  # noqa: SLF001
    version = int((await (await upgraded._connection.execute("PRAGMA user_version")).fetchone())[0])  # noqa: SLF001
    history = await (await upgraded._connection.execute("SELECT version FROM runtime_migration_history")).fetchall()  # noqa: SLF001
    await upgraded.disconnect()

    interrupted = root / "interrupted.db"
    conn = await aiosqlite.connect(interrupted, isolation_level=None)
    await conn.execute("PRAGMA user_version = 1")
    async def fail_after_write(connection):  # noqa: ANN001
        await connection.execute("CREATE TABLE must_roll_back(value TEXT)")
        raise RuntimeError("injected migration interruption")
    rolled_back = False
    try:
        await migrations.apply(conn, migrations={2: fail_after_write}, target_version=2)
    except RuntimeError:
        row = await (await conn.execute("SELECT name FROM sqlite_master WHERE name='must_roll_back'")).fetchone()
        current = int((await (await conn.execute("PRAGMA user_version")).fetchone())[0])
        rolled_back = row is None and current == 1
    await conn.close()

    source = RuntimeDatabase(root / "source.db")
    await source.connect()
    repo = RuntimeRepository(source)
    await repo.create_session(session_id="session-backup-0001", principal_id="owner", device_id="device")
    await source.disconnect()
    manifest = await backup_quiesced(source, root / "backups" / "runtime-v4.db")

    target = RuntimeDatabase(root / "restored.db")
    await restore_quiesced(target, manifest.path, expected_sha256=manifest.sha256)
    await target.connect()
    assert target._connection is not None  # noqa: SLF001
    restored = await (await target._connection.execute("SELECT id FROM runtime_sessions")).fetchall()  # noqa: SLF001
    await target.disconnect()

    checksum_rejected = False
    try:
        await restore_quiesced(target, manifest.path, expected_sha256="0" * 64)
    except RuntimeError:
        checksum_rejected = True

    checks = [
        ("v1 upgrades exclusively to current schema", version == 4 and [row[0] for row in history] == [2, 3, 4]),
        ("interrupted migration rolls back DDL and version", rolled_back),
        ("backup has verified manifest", manifest.schema_version == 4 and manifest.bytes > 0),
        ("restored database retains durable records", [row[0] for row in restored] == ["session-backup-0001"]),
        ("restore rejects wrong checksum", checksum_rejected),
    ]
    for label, passed in checks:
        print(f"  [{'PASS' if passed else 'FAIL'}] {label}")
    print("\n" + "=" * 60)
    print(f"{sum(ok for _, ok in checks)}/{len(checks)} checks passed")
    return 0 if all(ok for _, ok in checks) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
