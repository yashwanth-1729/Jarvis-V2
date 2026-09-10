"""Structured, local-first memory intelligence for JARVIS.

The synced ``memories.content`` column remains portable Markdown.  A small,
fixed YAML-compatible front matter block carries machine metadata, which means
older Supabase tables and clients can transport the richer record without a
destructive remote schema migration.  Plain legacy rows remain valid and are
decorated with conservative defaults when read.

Retrieval is deliberately local and dependency-free.  The memory set is small,
so exact phrases, Unicode tokens, fuzzy concept similarity, temporal validity,
type, confidence, importance and recency can be fused in Python faster than a
network embedding round trip.  A future embedding adapter can contribute one
more score without replacing this always-available path.
"""

from __future__ import annotations

import json
import hashlib
import math
import re
import uuid
from datetime import datetime, timedelta
from difflib import SequenceMatcher
from typing import Any, Iterable

from app.core.config import settings
from app.core.timeutil import now, now_iso, parse_datetime
from app.db.database import db

FRONT_MATTER_VERSION = 2
MEMORY_TYPES = (
    "WORKING",
    "EPISODIC",
    "SEMANTIC",
    "PROCEDURAL",
    "PROSPECTIVE",
    "REFLECTIVE",
)
MEMORY_STATUSES = ("ACTIVE", "CANDIDATE", "SUPERSEDED", "ARCHIVED")

_META_ORDER = (
    "jarvis_memory",
    "type",
    "status",
    "confidence",
    "importance",
    "source_kind",
    "source_ref",
    "valid_from",
    "supersedes_uid",
    "pinned",
    "evidence_count",
    "tags",
    "history",
)
_TOKEN = re.compile(r"[^\W_]+", re.UNICODE)
_STOP = {
    "a", "an", "and", "are", "as", "at", "be", "do", "for", "from",
    "have", "i", "in", "is", "it", "me", "my", "of", "on", "or", "that",
    "the", "this", "to", "was", "what", "when", "where", "who", "with",
    "you", "your",
}
_TYPE_HINTS: dict[str, set[str]] = {
    "SEMANTIC": {"know", "fact", "prefer", "preference", "like", "about", "who"},
    "PROCEDURAL": {"rule", "always", "usually", "workflow", "how", "whenever"},
    "EPISODIC": {"happened", "last", "yesterday", "did", "event", "experience"},
    "PROSPECTIVE": {"goal", "plan", "intend", "future", "want"},
    "WORKING": {"currently", "now", "temporary", "until", "active"},
    "REFLECTIVE": {"pattern", "summary", "learned", "trend"},
}
_ACTION_WORDS = {
    "added", "changed", "created", "deleted", "did", "done", "edited",
    "removed", "saved", "updated", "what", "when",
}
_vault_fingerprint: tuple[tuple[str, str, str], ...] | None = None


def _clamp(value: Any, default: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(number):
        return default
    return max(0.0, min(1.0, number))


def infer_type(category: str | None, expires_at: str | None) -> str:
    """Lossless default classification for pre-upgrade rows."""
    if expires_at:
        return "PROCEDURAL"
    if (category or "").upper() == "GOAL":
        return "PROSPECTIVE"
    return "SEMANTIC"


def default_metadata(
    *, category: str | None = None, expires_at: str | None = None,
    created_at: str | None = None,
) -> dict[str, Any]:
    return {
        "jarvis_memory": FRONT_MATTER_VERSION,
        "type": infer_type(category, expires_at),
        "status": "ACTIVE",
        "confidence": 1.0,
        "importance": 0.65,
        "source_kind": "legacy" if created_at else "explicit",
        "source_ref": None,
        "valid_from": created_at or now_iso(),
        "supersedes_uid": None,
        "pinned": False,
        "evidence_count": 1,
        "tags": [],
        "history": [],
    }


def _normalise_metadata(meta: dict[str, Any], defaults: dict[str, Any]) -> dict[str, Any]:
    merged = {**defaults, **meta, "jarvis_memory": FRONT_MATTER_VERSION}
    kind = str(merged.get("type") or "").upper()
    merged["type"] = kind if kind in MEMORY_TYPES else defaults["type"]
    status = str(merged.get("status") or "").upper()
    merged["status"] = status if status in MEMORY_STATUSES else "ACTIVE"
    merged["confidence"] = _clamp(merged.get("confidence"), defaults["confidence"])
    merged["importance"] = _clamp(merged.get("importance"), defaults["importance"])
    merged["pinned"] = bool(merged.get("pinned", False))
    try:
        merged["evidence_count"] = max(1, int(merged.get("evidence_count") or 1))
    except (TypeError, ValueError):
        merged["evidence_count"] = 1
    merged["tags"] = [str(item)[:80] for item in (merged.get("tags") or []) if str(item).strip()][:16]
    merged["history"] = list(merged.get("history") or [])[-8:]
    return merged


def decode_content(
    stored: str | None, *, category: str | None = None,
    expires_at: str | None = None, created_at: str | None = None,
) -> tuple[str, dict[str, Any]]:
    """Return Markdown body and metadata from a legacy or v2 value."""
    text = str(stored or "")
    defaults = default_metadata(category=category, expires_at=expires_at, created_at=created_at)
    if not text.startswith("---\n"):
        return text, defaults
    marker = text.find("\n---\n", 4)
    if marker < 0:
        return text, defaults
    raw_meta = text[4:marker]
    parsed: dict[str, Any] = {}
    try:
        for line in raw_meta.splitlines():
            key, separator, raw_value = line.partition(":")
            if not separator:
                continue
            parsed[key.strip()] = json.loads(raw_value.strip())
    except (TypeError, ValueError, json.JSONDecodeError):
        return text, defaults
    if parsed.get("jarvis_memory") != FRONT_MATTER_VERSION:
        return text, defaults
    return text[marker + 5 :], _normalise_metadata(parsed, defaults)


def encode_content(body: str, metadata: dict[str, Any]) -> str:
    """Encode fixed-order JSON scalars as valid YAML front matter."""
    meta = _normalise_metadata(metadata, default_metadata())
    lines = ["---"]
    for key in _META_ORDER:
        lines.append(f"{key}: {json.dumps(meta.get(key), ensure_ascii=False, separators=(',', ':'))}")
    lines.extend(("---", str(body).strip()))
    return "\n".join(lines)


def decorate_row(row: dict[str, Any]) -> dict[str, Any]:
    """Expose rich fields while keeping the stored Markdown envelope private."""
    body, meta = decode_content(
        row.get("content"), category=row.get("category"),
        expires_at=row.get("expires_at"), created_at=row.get("created_at"),
    )
    return {
        **row,
        "content": body,
        "memory_type": meta["type"],
        "memory_status": meta["status"],
        "confidence": meta["confidence"],
        "importance": meta["importance"],
        "source_kind": meta["source_kind"],
        "source_ref": meta["source_ref"],
        "valid_from": meta["valid_from"],
        "supersedes_uid": meta["supersedes_uid"],
        "pinned": meta["pinned"],
        "evidence_count": meta["evidence_count"],
        "tags": meta["tags"],
        "revision_count": len(meta["history"]),
        "_memory_meta": meta,
    }


def storage_value(
    body: str, *, existing: dict[str, Any] | None = None,
    memory_type: str | None = None, memory_status: str | None = None,
    confidence: float | None = None, importance: float | None = None,
    source_kind: str | None = None, source_ref: str | None = None,
    valid_from: str | None = None, supersedes_uid: str | None = None,
    pinned: bool | None = None, tags: Iterable[str] | None = None,
) -> str:
    """Create or revise a memory while retaining a short correction history."""
    if existing:
        old_body, meta = decode_content(
            existing.get("content"), category=existing.get("category"),
            expires_at=existing.get("expires_at"), created_at=existing.get("created_at"),
        )
        if old_body.strip() and old_body.strip() != body.strip():
            history = list(meta.get("history") or [])
            history.append({
                "content": old_body[:4000],
                "updated_at": existing.get("updated_at"),
                "source_kind": meta.get("source_kind"),
                "source_ref": meta.get("source_ref"),
            })
            meta["history"] = history[-8:]
    else:
        meta = default_metadata()
    updates = {
        "type": memory_type,
        "status": memory_status,
        "confidence": confidence,
        "importance": importance,
        "source_kind": source_kind,
        "source_ref": source_ref,
        "valid_from": valid_from,
        "supersedes_uid": supersedes_uid,
        "pinned": pinned,
        "tags": list(tags) if tags is not None else None,
    }
    for key, value in updates.items():
        if value is not None:
            meta[key] = value
    return encode_content(body, meta)


def _tokens(text: str) -> set[str]:
    return {token.casefold() for token in _TOKEN.findall(text) if len(token) > 1 and token.casefold() not in _STOP}


def _age_score(value: str | None, current: datetime) -> float:
    parsed = parse_datetime(value)
    if parsed is None:
        return 0.0
    days = max(0.0, (current - parsed).total_seconds() / 86_400)
    return math.exp(-days / 180.0)


def _is_current(row: dict[str, Any], current: datetime, include_candidates: bool) -> bool:
    if row["memory_status"] == "CANDIDATE":
        return include_candidates
    if row["memory_status"] != "ACTIVE":
        return False
    valid_from = parse_datetime(row.get("valid_from"))
    expires = parse_datetime(row.get("expires_at"))
    return not (valid_from and valid_from > current) and not (expires and expires <= current)


def _score(row: dict[str, Any], query: str, query_tokens: set[str], current: datetime) -> float:
    title = str(row.get("key_concept") or "")
    body = str(row.get("content") or "")
    title_fold = title.casefold()
    body_fold = body.casefold()
    tag_text = " ".join(str(tag) for tag in row.get("tags") or [])
    phrase = query.strip().casefold()
    title_tokens = _tokens(title)
    body_tokens = _tokens(body)
    tag_tokens = _tokens(tag_text)
    title_overlap = len(query_tokens & title_tokens) / max(1, len(query_tokens))
    body_overlap = len(query_tokens & body_tokens) / max(1, len(query_tokens))
    tag_overlap = len(query_tokens & tag_tokens) / max(1, len(query_tokens))
    score = title_overlap * 4.0 + body_overlap * 2.2 + tag_overlap * 2.7
    if phrase and phrase in title_fold:
        score += 3.0
    elif phrase and phrase in body_fold:
        score += 1.8
    if phrase and title_fold:
        score += SequenceMatcher(None, phrase[:180], title_fold[:180]).ratio() * 0.8
    hinted = _TYPE_HINTS.get(row["memory_type"], set())
    if query_tokens & hinted:
        score += 0.9
    standing_rule = row["memory_type"] == "PROCEDURAL" and (row["pinned"] or row["importance"] >= 0.7)
    if standing_rule:
        score = max(score, 0.72)
    # Confidence and importance rank relevant results; they must never make an
    # unrelated fact relevant by themselves. An empty query is the one useful
    # exception (dashboard/debug callers asking for a compact general set).
    if score < 0.15 and (query_tokens or phrase) and not standing_rule:
        return 0.0
    if row["memory_status"] == "CANDIDATE":
        score *= 0.75
    score += float(row["importance"]) * 0.55 + float(row["confidence"]) * 0.45
    score += _age_score(row.get("updated_at"), current) * (0.45 if row["memory_type"] in {"WORKING", "EPISODIC"} else 0.16)
    if row["pinned"]:
        score += 1.2
    return score


async def retrieve(query: str, *, limit: int = 8, include_candidates: bool = False) -> list[dict[str, Any]]:
    """Rank current memories against a turn without any network dependency."""
    raw = await db.fetch_all("SELECT * FROM memories ORDER BY updated_at DESC LIMIT 1000")
    current = now()
    query_tokens = _tokens(query)
    ranked: list[tuple[float, dict[str, Any]]] = []
    for item in raw:
        row = decorate_row(item)
        if not _is_current(row, current, include_candidates):
            continue
        score = _score(row, query, query_tokens, current)
        if score >= 0.62:
            ranked.append((score, row))
    ranked.sort(key=lambda item: (item[0], item[1].get("updated_at") or ""), reverse=True)
    # Maximal marginal relevance: after the best hit, strongly overlapping
    # memories pay a duplicate penalty. This stops several rewrites of one fact
    # from crowding every other useful fact out of the small prompt budget.
    selected: list[dict[str, Any]] = []
    remaining = list(ranked)
    while remaining and len(selected) < max(1, limit):
        best_index = 0
        best_value = float("-inf")
        for index, (score, row) in enumerate(remaining):
            tokens = _tokens(f"{row.get('key_concept', '')} {row.get('content', '')}")
            similarity = 0.0
            for chosen in selected:
                chosen_tokens = _tokens(f"{chosen.get('key_concept', '')} {chosen.get('content', '')}")
                union = tokens | chosen_tokens
                if union:
                    similarity = max(similarity, len(tokens & chosen_tokens) / len(union))
            value = score - similarity * 0.85
            if value > best_value:
                best_index, best_value = index, value
        _, chosen = remaining.pop(best_index)
        selected.append(chosen)
    if selected:
        stamp = now_iso()
        await db.execute_many(
            """
            INSERT INTO memory_access (memory_uid, access_count, last_accessed_at)
            VALUES (?, 1, ?)
            ON CONFLICT(memory_uid) DO UPDATE SET
                access_count = memory_access.access_count + 1,
                last_accessed_at = excluded.last_accessed_at
            """,
            [(row["uid"], stamp) for row in selected if row.get("uid")],
        )
    return selected


def _safe_summary(arguments: dict[str, Any] | None) -> str:
    safe: dict[str, Any] = {}
    for key, value in (arguments or {}).items():
        folded = key.casefold()
        if any(secret in folded for secret in ("password", "secret", "token", "api_key", "credential")):
            safe[key] = "[redacted]"
        elif isinstance(value, str):
            safe[key] = value[:500]
        elif isinstance(value, (int, float, bool)) or value is None:
            safe[key] = value
        elif isinstance(value, list):
            safe[key] = value[:20]
    return json.dumps(safe, ensure_ascii=False, separators=(",", ":"))[:4000]


def action_label(tool_name: str, arguments: dict[str, Any] | None) -> str:
    labels = {
        "add_task": "Create task",
        "update_task": "Edit task",
        "update_task_status": "Change task status",
        "bulk_delete_tasks": "Delete matching tasks",
        "add_schedule_event": "Create schedule block",
        "update_schedule_event": "Edit schedule block",
        "delete_record": "Delete record",
        "save_idea_or_note": "Save knowledge",
        "set_reminder": "Create reminder",
        "configure_notifications": "Change notification policy",
        "set_language": "Change spoken language",
    }
    base = labels.get(tool_name, tool_name.replace("_", " ").strip().title())
    args = arguments or {}
    subject = args.get("title") or args.get("event_name") or args.get("matching") or args.get("text")
    return f"{base}: {str(subject).strip()[:100]}" if subject else base


async def record_action(
    tool_name: str, arguments: dict[str, Any] | None, *, source_turn_ref: str | None,
    ok: bool, result: str,
) -> str:
    """Append one named action. Reads and failures are valuable evidence too."""
    uid = str(uuid.uuid4())
    stamp = now_iso()
    await db.execute(
        """
        INSERT INTO action_events
            (uid, action_name, action_type, status, source_turn_ref,
             input_summary, result_summary, started_at, completed_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            uid, action_label(tool_name, arguments), tool_name,
            "SUCCEEDED" if ok else "FAILED", source_turn_ref,
            _safe_summary(arguments), str(result)[:2000], stamp, stamp, stamp,
        ),
    )
    cutoff = (now() - timedelta(days=90)).isoformat(timespec="seconds")
    await db.execute("DELETE FROM action_events WHERE created_at < ?", (cutoff,))
    return uid


async def retrieve_actions(query: str, limit: int = 5) -> list[dict[str, Any]]:
    query_tokens = _tokens(query)
    if not query_tokens & _ACTION_WORDS:
        return []
    rows = await db.fetch_all(
        "SELECT * FROM action_events ORDER BY created_at DESC LIMIT 250"
    )
    ranked: list[tuple[int, dict[str, Any]]] = []
    for row in rows:
        text = f"{row['action_name']} {row['input_summary']} {row['result_summary']}"
        overlap = len(query_tokens & _tokens(text))
        if overlap or query_tokens <= _ACTION_WORDS:
            ranked.append((overlap, row))
    ranked.sort(key=lambda item: (item[0], item[1]["created_at"]), reverse=True)
    return [row for _, row in ranked[:limit]]


async def capture_inferred_candidate(user_text: str, source_ref: str | None = None) -> dict[str, Any] | None:
    """Capture only high-signal self-statements; everything else stays transient.

    This is the conservative half of hybrid learning.  Explicit remember/save
    requests are handled by the agent tool and become active immediately.
    """
    text = " ".join((user_text or "").split())
    folded = text.casefold()
    if not text or len(text) > 600:
        return None
    if any(phrase in folded for phrase in ("remember this", "remember that", "save this", "store this", "i want you to")):
        return None

    patterns = (
        ("SEMANTIC", "PREFERENCE", r"\b(?:i prefer|i like|i dislike|i hate|my favou?rite)\b", "Inferred preference"),
        ("SEMANTIC", "LONG_TERM", r"\bmy [a-z][a-z ]{1,40} is\b", "Inferred personal fact"),
        ("PROCEDURAL", "PREFERENCE", r"\b(?:from now on|always|whenever|never)\b", "Inferred standing rule"),
        ("PROSPECTIVE", "GOAL", r"\b(?:my goal is|i plan to|i intend to)\b", "Inferred goal"),
    )
    selected = next((item for item in patterns if re.search(item[2], folded)), None)
    if selected is None:
        return None
    memory_type, category, _, label = selected

    raw = await db.fetch_all("SELECT * FROM memories ORDER BY updated_at DESC LIMIT 500")
    for item in raw:
        body, meta = decode_content(
            item.get("content"), category=item.get("category"),
            expires_at=item.get("expires_at"), created_at=item.get("created_at"),
        )
        if body.casefold() == text.casefold():
            if str(meta.get("status")) != "CANDIDATE":
                return None
            meta["evidence_count"] = int(meta.get("evidence_count") or 1) + 1
            meta["confidence"] = min(0.94, float(meta.get("confidence") or 0.7) + 0.06)
            stamp = now_iso()
            await db.execute(
                "UPDATE memories SET content = ?, updated_at = ? WHERE id = ?",
                (encode_content(body, meta), stamp, item["id"]),
            )
            updated = await db.fetch_one("SELECT * FROM memories WHERE id = ?", (item["id"],))
            await refresh_markdown_vault()
            return decorate_row(updated) if updated else None

    stamp = now_iso()
    expires = (now() + timedelta(days=30)).isoformat(timespec="seconds")
    metadata = default_metadata(created_at=stamp)
    metadata.update({
        "type": memory_type,
        "status": "CANDIDATE",
        "confidence": 0.72,
        "importance": 0.55,
        "source_kind": "inferred_user_turn",
        "source_ref": source_ref,
    })
    uid = str(uuid.uuid4())
    memory_id = await db.execute(
        """
        INSERT INTO memories
            (uid, key_concept, category, content, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (uid, f"{label}: {text[:72]}", category, encode_content(text, metadata), expires, stamp, stamp),
    )
    row = await db.fetch_one("SELECT * FROM memories WHERE id = ?", (memory_id,))
    await refresh_markdown_vault()
    return decorate_row(row) if row else None


async def refresh_markdown_vault() -> None:
    """Materialise a readable desktop Markdown view without becoming storage.

    Android remains IndexedDB-authoritative.  Writing files inside its private
    Python sandbox would add no useful capability, so only desktop maintains
    this projection.
    """
    global _vault_fingerprint
    if settings.jarvis_client_owned_data:
        return
    raw = await db.fetch_all("SELECT * FROM memories ORDER BY updated_at DESC")
    fingerprint = tuple(
        (
            str(row.get("uid") or row.get("id")),
            str(row.get("updated_at") or ""),
            hashlib.sha256(str(row.get("content") or "").encode("utf-8")).hexdigest(),
        )
        for row in raw
    )
    if fingerprint == _vault_fingerprint:
        return

    vault = settings.db_file.parent / "memory-vault"
    vault.mkdir(parents=True, exist_ok=True)
    expected: set[str] = {"README.md"}
    groups: dict[str, list[dict[str, Any]]] = {kind: [] for kind in MEMORY_TYPES}
    for item in raw:
        row = decorate_row(item)
        groups[row["memory_type"]].append(row)
        uid = str(row.get("uid") or row.get("id"))
        filename = f"{uid}.md"
        expected.add(filename)
        front = {
            "uid": uid,
            "title": row["key_concept"],
            "type": row["memory_type"],
            "status": row["memory_status"],
            "category": row["category"],
            "confidence": row["confidence"],
            "importance": row["importance"],
            "expires_at": row.get("expires_at"),
            "pinned": row["pinned"],
            "updated_at": row["updated_at"],
        }
        text = ["---"]
        text.extend(f"{key}: {json.dumps(value, ensure_ascii=False)}" for key, value in front.items())
        text.extend(("---", "", f"# {row['key_concept']}", "", row["content"], ""))
        target = vault / filename
        temporary = target.with_suffix(".md.tmp")
        temporary.write_text("\n".join(text), encoding="utf-8")
        temporary.replace(target)

    index = [
        "# JARVIS memory vault",
        "",
        "Generated from the structured local database. Edit memories in JARVIS; this folder is a readable projection.",
        "",
    ]
    for kind in MEMORY_TYPES:
        if not groups[kind]:
            continue
        index.extend((f"## {kind.title()}", ""))
        for row in groups[kind]:
            uid = str(row.get("uid") or row.get("id"))
            index.append(f"- [{row['key_concept']}]({uid}.md) — {row['memory_status'].lower()}")
        index.append("")
    (vault / "README.md").write_text("\n".join(index), encoding="utf-8")
    for path in vault.glob("*.md"):
        if path.name not in expected:
            path.unlink()
    _vault_fingerprint = fingerprint
