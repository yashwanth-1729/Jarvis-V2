"""Quiesced, verified backup and restoration for runtime SQLite files."""

from __future__ import annotations

import asyncio
import hashlib
import os
import sqlite3
import uuid
from dataclasses import dataclass
from pathlib import Path

from app.agent_runtime.database import RuntimeDatabase, SCHEMA_VERSION


@dataclass(frozen=True, slots=True)
class BackupManifest:
    path: Path
    sha256: str
    schema_version: int
    bytes: int


def _inspect(path: Path) -> tuple[int, str]:
    conn = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    try:
        version = int(conn.execute("PRAGMA user_version").fetchone()[0])
        integrity = str(conn.execute("PRAGMA integrity_check").fetchone()[0])
    finally:
        conn.close()
    return version, integrity


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _sqlite_backup(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    src = sqlite3.connect(f"file:{source.as_posix()}?mode=ro", uri=True)
    dst = sqlite3.connect(destination)
    try:
        src.backup(dst)
        dst.commit()
    finally:
        dst.close()
        src.close()


async def backup_quiesced(database: RuntimeDatabase, destination: Path) -> BackupManifest:
    """Create a SQLite-consistent backup; caller must stop the runtime first."""
    if database._connection is not None:  # noqa: SLF001 - maintenance owner
        raise RuntimeError("Disconnect the runtime database before backup")
    if not database.path.is_file():
        raise FileNotFoundError(database.path)
    await asyncio.to_thread(_sqlite_backup, database.path, destination)
    version, integrity = await asyncio.to_thread(_inspect, destination)
    if integrity != "ok" or version > SCHEMA_VERSION:
        destination.unlink(missing_ok=True)
        raise RuntimeError(
            f"Backup verification failed (integrity={integrity!r}, schema={version})"
        )
    return BackupManifest(
        path=destination,
        sha256=await asyncio.to_thread(_sha256, destination),
        schema_version=version,
        bytes=destination.stat().st_size,
    )


async def restore_quiesced(
    database: RuntimeDatabase, backup: Path, *, expected_sha256: str
) -> None:
    """Verify then atomically restore a known backup into a stopped runtime."""
    if database._connection is not None:  # noqa: SLF001
        raise RuntimeError("Disconnect the runtime database before restore")
    actual = await asyncio.to_thread(_sha256, backup)
    if actual != expected_sha256:
        raise RuntimeError("Backup checksum does not match the approved manifest")
    version, integrity = await asyncio.to_thread(_inspect, backup)
    if integrity != "ok" or version > SCHEMA_VERSION:
        raise RuntimeError(
            f"Backup cannot be restored (integrity={integrity!r}, schema={version})"
        )

    staged = database.path.with_name(f".{database.path.name}.restore-{uuid.uuid4().hex}.tmp")
    await asyncio.to_thread(_sqlite_backup, backup, staged)
    staged_version, staged_integrity = await asyncio.to_thread(_inspect, staged)
    if staged_integrity != "ok" or staged_version != version:
        staged.unlink(missing_ok=True)
        raise RuntimeError("Staged restore failed verification")
    database.path.parent.mkdir(parents=True, exist_ok=True)
    os.replace(staged, database.path)
    # A quiesced target should have no live WAL; remove only exact sidecars so
    # stale frames from the replaced file cannot attach to the restored DB.
    for suffix in ("-wal", "-shm"):
        Path(str(database.path) + suffix).unlink(missing_ok=True)
