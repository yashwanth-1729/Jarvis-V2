-- ---------------------------------------------------------------------------
-- JARVIS database schema. All DATETIME columns hold local-time naive ISO-8601
-- strings ('YYYY-MM-DDTHH:MM:SS') so they sort lexicographically and can be
-- range-scanned straight off the indices below.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    uid         TEXT,                       -- device-independent sync identity
    title       TEXT     NOT NULL,
    category    TEXT     NOT NULL DEFAULT 'GENERAL',
    priority    TEXT     NOT NULL DEFAULT 'MEDIUM'
                         CHECK (priority IN ('HIGH', 'MEDIUM', 'LOW')),
    status      TEXT     NOT NULL DEFAULT 'PENDING'
                         CHECK (status IN ('PENDING', 'IN_PROGRESS', 'COMPLETED')),
    due_date    DATETIME,
    created_at  DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')),
    updated_at  DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_due  ON tasks (status, due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_priority    ON tasks (priority);
CREATE INDEX IF NOT EXISTS idx_tasks_created     ON tasks (created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_uid ON tasks (uid);


-- Three kinds of entry share this table:
--   COLLEGE  weekly class timetable        -> day_of_week + start_time/end_time
--   ROUTINE  recurring personal blocks     -> day_of_week + start_time/end_time
--   SESSION  a one-off booking at a time   -> time_start/time_end
-- Recurring rows therefore leave time_start NULL, which is why it is nullable.
CREATE TABLE IF NOT EXISTS schedules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    uid         TEXT,                       -- device-independent sync identity
    event_name  TEXT     NOT NULL,
    kind        TEXT     NOT NULL DEFAULT 'SESSION'
                         CHECK (kind IN ('COLLEGE', 'ROUTINE', 'SESSION')),
    time_start  DATETIME,
    time_end    DATETIME,
    day_of_week INTEGER  CHECK (day_of_week BETWEEN 0 AND 6),  -- 0 = Monday
    start_time  TEXT,                                          -- 'HH:MM'
    end_time    TEXT,
    location    TEXT,
    notes       TEXT,
    created_at  DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')),
    updated_at  DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_schedules_start  ON schedules (time_start);
CREATE INDEX IF NOT EXISTS idx_schedules_kind   ON schedules (kind);
CREATE INDEX IF NOT EXISTS idx_schedules_weekly ON schedules (day_of_week, start_time);
CREATE UNIQUE INDEX IF NOT EXISTS idx_schedules_uid ON schedules (uid);


CREATE TABLE IF NOT EXISTS memories (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    uid          TEXT,                      -- device-independent sync identity
    key_concept  TEXT     NOT NULL,
    category     TEXT     NOT NULL DEFAULT 'LONG_TERM'
                          CHECK (category IN ('LONG_TERM', 'GOAL', 'PREFERENCE')),
    content      TEXT     NOT NULL,
    expires_at   TEXT,
    created_at   DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')),
    updated_at   DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_memories_category ON memories (category);
CREATE INDEX IF NOT EXISTS idx_memories_updated  ON memories (updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_uid ON memories (uid);

-- Retrieval telemetry is local and disposable. It must not update the synced
-- memory row merely because JARVIS read it, or every voice turn would create a
-- cross-device write conflict.
CREATE TABLE IF NOT EXISTS memory_access (
    memory_uid       TEXT PRIMARY KEY,
    access_count     INTEGER NOT NULL DEFAULT 0,
    last_accessed_at TEXT NOT NULL
);

-- Meaningful tool executions form the raw episodic ledger. They are retained
-- for 90 days and can be queried when the user asks what JARVIS changed. The
-- durable conclusions distilled from them live in synced memory records.
CREATE TABLE IF NOT EXISTS action_events (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    uid              TEXT UNIQUE NOT NULL,
    action_name      TEXT NOT NULL,
    action_type      TEXT NOT NULL,
    status           TEXT NOT NULL CHECK (status IN ('SUCCEEDED', 'FAILED')),
    source_turn_ref  TEXT,
    input_summary    TEXT NOT NULL DEFAULT '{}',
    result_summary   TEXT NOT NULL DEFAULT '',
    started_at       TEXT NOT NULL,
    completed_at     TEXT NOT NULL,
    created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_action_events_created
    ON action_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_events_type
    ON action_events (action_type, created_at DESC);


CREATE TABLE IF NOT EXISTS ideas (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    uid          TEXT,                      -- device-independent sync identity
    title        TEXT     NOT NULL,
    description  TEXT     NOT NULL DEFAULT '',
    page_uid     TEXT,
    tags         TEXT     NOT NULL DEFAULT '',
    status       TEXT     NOT NULL DEFAULT 'DRAFT'
                          CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')),
    created_at   DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')),
    updated_at   DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_ideas_status  ON ideas (status);
CREATE INDEX IF NOT EXISTS idx_ideas_updated ON ideas (updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ideas_uid ON ideas (uid);


CREATE TABLE IF NOT EXISTS note_pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'CUSTOM' CHECK (kind IN ('LONG_TERM', 'TEMPORARY', 'OTHER', 'CUSTOM')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS note_pages_pending_insert AFTER INSERT ON note_pages BEGIN
    INSERT INTO sync_pending (table_name, uid) VALUES ('note_pages', NEW.uid)
    ON CONFLICT(table_name, uid) DO NOTHING;
END;
CREATE TRIGGER IF NOT EXISTS note_pages_pending_update AFTER UPDATE ON note_pages BEGIN
    INSERT INTO sync_pending (table_name, uid) VALUES ('note_pages', NEW.uid)
    ON CONFLICT(table_name, uid) DO NOTHING;
END;

CREATE TABLE IF NOT EXISTS proactive_briefs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    summary_text  TEXT     NOT NULL,
    urgent_count  INTEGER  NOT NULL DEFAULT 0,
    generated_at  DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_briefs_generated ON proactive_briefs (generated_at DESC);


-- Small key/value store for user settings that must outlive a session and be
-- writable from both the UI and a voice command (e.g. spoken language).
CREATE TABLE IF NOT EXISTS preferences (
    key         TEXT PRIMARY KEY,
    value       TEXT     NOT NULL,
    updated_at  DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime'))
);


-- Conversation persistence. `blocks` stores the raw Anthropic content-block
-- array as JSON so a restarted process can replay the exact turn structure
-- (tool_use / tool_result / thinking) back to the model.
CREATE TABLE IF NOT EXISTS chat_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    role        TEXT     NOT NULL CHECK (role IN ('user', 'assistant')),
    text        TEXT     NOT NULL DEFAULT '',
    blocks      TEXT,
    created_at  DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_chat_created ON chat_messages (id);


-- ---------------------------------------------------------------------------
-- Sync bookkeeping.  Mirrored in migrations.py::_v2_sync_identity for databases
-- that predate it; the two definitions must stay identical.
-- ---------------------------------------------------------------------------

-- A deleted row leaves no trace locally, which is indistinguishable from a row
-- that has not synced in yet.  Without these, every pull would faithfully
-- restore whatever the user just deleted.
CREATE TABLE IF NOT EXISTS sync_tombstones (
    table_name  TEXT     NOT NULL,
    uid         TEXT     NOT NULL,
    deleted_at  DATETIME NOT NULL,
    PRIMARY KEY (table_name, uid)
);

CREATE INDEX IF NOT EXISTS idx_tombstones_deleted ON sync_tombstones (deleted_at);

-- Watermarks: how far each direction of the sync has got.
CREATE TABLE IF NOT EXISTS sync_state (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  DATETIME NOT NULL
);


-- What still needs publishing to the mirror.
--
-- Deliberately a set, not a timestamp cursor: "have I sent this row" is a fact
-- about local state, and inferring it from a clock breaks whenever the clock
-- moves -- forward (a peer's future-stamped row strands every later edit) or
-- backward (an NTP correction puts new rows below the watermark). Both fail
-- silently. Mirrored in migrations.py::_v3_pending_set.
CREATE TABLE IF NOT EXISTS sync_pending (
    table_name  TEXT NOT NULL,
    uid         TEXT NOT NULL,
    PRIMARY KEY (table_name, uid)
);

CREATE TRIGGER IF NOT EXISTS tasks_mark_pending_ins AFTER INSERT ON tasks
WHEN NEW.uid IS NOT NULL
BEGIN
    INSERT INTO sync_pending (table_name, uid) VALUES ('tasks', NEW.uid)
    ON CONFLICT(table_name, uid) DO NOTHING;
END;

CREATE TRIGGER IF NOT EXISTS tasks_mark_pending_upd AFTER UPDATE ON tasks
WHEN NEW.uid IS NOT NULL
BEGIN
    INSERT INTO sync_pending (table_name, uid) VALUES ('tasks', NEW.uid)
    ON CONFLICT(table_name, uid) DO NOTHING;
END;

CREATE TRIGGER IF NOT EXISTS schedules_mark_pending_ins AFTER INSERT ON schedules
WHEN NEW.uid IS NOT NULL
BEGIN
    INSERT INTO sync_pending (table_name, uid) VALUES ('schedules', NEW.uid)
    ON CONFLICT(table_name, uid) DO NOTHING;
END;

CREATE TRIGGER IF NOT EXISTS schedules_mark_pending_upd AFTER UPDATE ON schedules
WHEN NEW.uid IS NOT NULL
BEGIN
    INSERT INTO sync_pending (table_name, uid) VALUES ('schedules', NEW.uid)
    ON CONFLICT(table_name, uid) DO NOTHING;
END;

CREATE TRIGGER IF NOT EXISTS memories_mark_pending_ins AFTER INSERT ON memories
WHEN NEW.uid IS NOT NULL
BEGIN
    INSERT INTO sync_pending (table_name, uid) VALUES ('memories', NEW.uid)
    ON CONFLICT(table_name, uid) DO NOTHING;
END;

CREATE TRIGGER IF NOT EXISTS memories_mark_pending_upd AFTER UPDATE ON memories
WHEN NEW.uid IS NOT NULL
BEGIN
    INSERT INTO sync_pending (table_name, uid) VALUES ('memories', NEW.uid)
    ON CONFLICT(table_name, uid) DO NOTHING;
END;

CREATE TRIGGER IF NOT EXISTS ideas_mark_pending_ins AFTER INSERT ON ideas
WHEN NEW.uid IS NOT NULL
BEGIN
    INSERT INTO sync_pending (table_name, uid) VALUES ('ideas', NEW.uid)
    ON CONFLICT(table_name, uid) DO NOTHING;
END;

CREATE TRIGGER IF NOT EXISTS ideas_mark_pending_upd AFTER UPDATE ON ideas
WHEN NEW.uid IS NOT NULL
BEGIN
    INSERT INTO sync_pending (table_name, uid) VALUES ('ideas', NEW.uid)
    ON CONFLICT(table_name, uid) DO NOTHING;
END;

-- Reminders and the announcement outbox ------------------------------------
--
-- What makes the schedule act rather than merely exist. `reminders` holds
-- one-shots the user asks for; `announcements` is what JARVIS has decided to
-- say, and doubles as the record that it already said it.
--
-- The UNIQUE below is the whole anti-repeat mechanism. A polling scheduler sees
-- the same class as "due" on every tick, and remembering what fired in memory
-- forgets across a restart. Letting the database refuse the duplicate means no
-- future rewrite of the loop can announce the same occurrence twice.
--
-- Neither table syncs: no `uid`, no pending-set triggers. Two devices sharing
-- one outbox would both fire the same reminder and tell the person twice.

CREATE TABLE IF NOT EXISTS reminders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    text        TEXT NOT NULL,
    due_at      DATETIME NOT NULL,
    -- Set only on the early-notice row of a default (non-instant) reminder:
    -- the moment the user actually asked about, e.g. a 5pm class, while
    -- `due_at` on that row is 5pm minus the lead time. Lets the fire-time
    -- message say "in 15 minutes, at 5:00 PM" instead of repeating `due_at`.
    -- NULL for an instant reminder and for the exact-time row of a default
    -- one, both of which just speak `text` plain.
    target_at   DATETIME,
    created_at  DATETIME NOT NULL,
    fired_at    DATETIME
);

CREATE INDEX IF NOT EXISTS idx_reminders_pending
    ON reminders (due_at) WHERE fired_at IS NULL;

CREATE TABLE IF NOT EXISTS announcements (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    kind          TEXT NOT NULL CHECK (kind IN ('reminder', 'schedule', 'task')),
    ref_id        INTEGER,
    occurrence_at DATETIME NOT NULL,
    text          TEXT NOT NULL,
    urgency       INTEGER NOT NULL DEFAULT 0,
    created_at    DATETIME NOT NULL,
    delivered_at  DATETIME,
    UNIQUE (kind, ref_id, occurrence_at)
);

CREATE INDEX IF NOT EXISTS idx_announcements_undelivered
    ON announcements (created_at) WHERE delivered_at IS NULL;
