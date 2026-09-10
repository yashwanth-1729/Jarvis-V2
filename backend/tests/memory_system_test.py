"""Focused checks for systematic memory, using an isolated database."""

from __future__ import annotations

import asyncio
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

ROOT = Path(tempfile.mkdtemp(prefix="jarvis-memory-test-"))
os.environ["JARVIS_DB_PATH"] = str(ROOT / "memory.db")
os.environ["JARVIS_SCHEDULER_ENABLED"] = "false"

# Simulate a real pre-upgrade database so v6 proves it preserves plain text.
legacy = sqlite3.connect(ROOT / "memory.db")
legacy.execute(
    """
    CREATE TABLE memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT, key_concept TEXT,
        category TEXT, content TEXT, expires_at TEXT, created_at TEXT, updated_at TEXT
    )
    """
)
legacy.execute(
    "INSERT INTO memories (uid,key_concept,category,content,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    ("legacy-memory", "Legacy fact", "LONG_TERM", "Original plain text", "2026-01-01T10:00:00", "2026-01-01T10:00:00"),
)
legacy.execute("PRAGMA user_version = 5")
legacy.commit()
legacy.close()

from app.core.config import get_settings  # noqa: E402

get_settings.cache_clear()
import app.db.database as dbmod  # noqa: E402

dbmod.db = dbmod.Database(get_settings().db_file, 2)
import app.db.crud as crud  # noqa: E402
from app.llm.tools import execute_tool  # noqa: E402
from app.services import memory  # noqa: E402

crud.db = dbmod.db
memory.db = dbmod.db


async def main() -> None:
    await dbmod.db.connect()
    try:
        migrated = await dbmod.db.fetch_one("SELECT content FROM memories WHERE uid = 'legacy-memory'")
        assert migrated and migrated["content"].endswith("Original plain text")
        first = await crud.upsert_memory(
            "Home city",
            "## Location\n\nI live in Nellore.",
            "LONG_TERM",
            memory_type="SEMANTIC",
            importance=0.8,
            tags=["Nellore", "location"],
        )
        assert first["content"].startswith("## Location")
        assert first["memory_type"] == "SEMANTIC"
        raw = await dbmod.db.fetch_one("SELECT content FROM memories WHERE id = ?", (first["id"],))
        assert raw and raw["content"].startswith("---\njarvis_memory: 2\n")

        revised = await crud.upsert_memory(
            "Home city",
            "## Location\n\nI live in Tirupati.",
            "LONG_TERM",
            memory_type="SEMANTIC",
            source_kind="explicit_correction",
        )
        assert revised["revision_count"] == 1
        assert "Tirupati" in revised["content"] and "Nellore" not in revised["content"]

        await crud.upsert_memory(
            "Answer language",
            "Reply in English unless I explicitly switch languages.",
            "PREFERENCE",
            memory_type="PROCEDURAL",
            pinned=True,
            importance=0.9,
        )
        relevant = await memory.retrieve("Where do I live?", limit=3)
        assert relevant[0]["key_concept"] == "Home city"
        assert any(item["memory_type"] == "PROCEDURAL" for item in relevant)

        candidate = await memory.capture_inferred_candidate("I prefer concise status updates")
        assert candidate and candidate["memory_status"] == "CANDIDATE"
        ordinary = await memory.retrieve("concise status updates", include_candidates=False)
        assert all(item["memory_status"] != "CANDIDATE" for item in ordinary)
        review = await memory.retrieve("concise status updates", include_candidates=True)
        assert any(item["memory_status"] == "CANDIDATE" for item in review)

        outcome = await execute_tool(
            "add_task",
            {"title": "Review memory architecture", "priority": "HIGH"},
            source_turn_ref="turn-test",
        )
        assert not outcome.is_error
        actions = await memory.retrieve_actions("What task did you create?")
        assert actions and "Review memory architecture" in actions[0]["action_name"]

        snapshot = await __import__("app.services.context", fromlist=["build_context_snapshot"]).build_context_snapshot(
            full_schedule=False, user_text="Where do I live?"
        )
        assert "RELEVANT MEMORY" in snapshot and "Tirupati" in snapshot
        assert "concise status updates" not in snapshot

        vault = get_settings().db_file.parent / "memory-vault"
        assert (vault / "README.md").exists()
        assert (vault / f"{first['uid']}.md").exists()
        print("memory system: 15 checks passed")
    finally:
        await dbmod.db.disconnect()


asyncio.run(main())
