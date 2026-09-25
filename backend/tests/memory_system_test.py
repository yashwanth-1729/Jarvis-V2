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

        # Re-saving by title keeps whatever the caller did not repeat.
        await crud.upsert_memory(
            "Morning rule", "No calls before 9am.", "PREFERENCE",
            memory_type="PROCEDURAL", pinned=True, importance=0.95, tags=["calls"],
        )
        await execute_tool("save_idea_or_note", {
            "title": "Morning rule", "content": "No calls before 10am.",
            "category": "PREFERENCE", "pinned": False, "tags": [],
        })
        kept = next(item for item in await crud.list_memories() if item["key_concept"] == "Morning rule")
        assert kept["pinned"] and kept["importance"] == 0.95 and kept["tags"] == ["calls"]
        assert kept["memory_type"] == "PROCEDURAL" and "10am" in kept["content"]
        await execute_tool("save_idea_or_note", {
            "title": "Exam week", "content": "Short replies.",
            "category": "PREFERENCE", "expires_at": "2099-01-01T00:00:00",
        })
        await execute_tool("save_idea_or_note", {
            "title": "Exam week", "content": "Short replies, no jokes.", "category": "PREFERENCE",
        })
        temporary = next(item for item in await crud.list_memories() if item["key_concept"] == "Exam week")
        assert temporary["expires_at"] == "2099-01-01T00:00:00"
        kept = await crud.upsert_memory("Morning rule", "No calls before 10am.", memory_status="CANDIDATE")
        assert kept["memory_status"] == "ACTIVE"
        kept = await crud.upsert_memory("Morning rule", "")
        assert "10am" in kept["content"] and kept["category"] == "PREFERENCE"

        # Automatic capture: statements about the user, not throwaways.
        for noise in ("never mind", "I always forget my keys lol", "ugh my wifi is so slow today", "is my alarm set?"):
            assert await memory.capture_inferred_candidate(noise) is None, noise
        for fact in ("I live in Hyderabad now", "I'm vegetarian", "always reply in Telugu", "amma's birthday is on the 14th"):
            assert await memory.capture_inferred_candidate(fact), fact

        # Telugu words tokenize whole, so a Telugu question finds a Telugu memory.
        await crud.upsert_memory("\u0c05\u0c2e\u0c4d\u0c2e \u0c2a\u0c41\u0c1f\u0c4d\u0c1f\u0c3f\u0c28\u0c30\u0c4b\u0c1c\u0c41", "14 October", "LONG_TERM")
        telugu = await memory.retrieve("\u0c2e\u0c3e \u0c05\u0c2e\u0c4d\u0c2e \u0c2a\u0c41\u0c1f\u0c4d\u0c1f\u0c3f\u0c28\u0c30\u0c4b\u0c1c\u0c41 \u0c0e\u0c2a\u0c4d\u0c2a\u0c41\u0c21\u0c41", limit=3)
        assert any(item["content"] == "14 October" for item in telugu)

        # Record search matches words, not the whole query as one substring.
        await crud.create_idea(title="Startup pitch deck", description="Slides for the investor meeting", tags="", status="ACTIVE")
        for query in ("pitch deck ideas", "investor slides"):
            found = await crud.search_memories_and_ideas(query)
            assert any(idea["title"] == "Startup pitch deck" for idea in found["ideas"]), query
        assert not (await crud.search_memories_and_ideas("quantum banana"))["ideas"]

        vault = get_settings().db_file.parent / "memory-vault"
        assert (vault / "README.md").exists()
        assert (vault / f"{first['uid']}.md").exists()
        print("memory system: 35 checks passed")
    finally:
        await dbmod.db.disconnect()


asyncio.run(main())
