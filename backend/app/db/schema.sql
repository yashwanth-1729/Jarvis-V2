-- ---------------------------------------------------------------------------
-- JARVIS v1 schema.  All DATETIME columns hold local-time naive ISO-8601
-- strings ('YYYY-MM-DDTHH:MM:SS') so they sort lexicographically and can be
-- range-scanned straight off the indices below.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
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


CREATE TABLE IF NOT EXISTS schedules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_name  TEXT     NOT NULL,
    time_start  DATETIME NOT NULL,
    time_end    DATETIME,
    location    TEXT,
    notes       TEXT,
    created_at  DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_schedules_start ON schedules (time_start);


CREATE TABLE IF NOT EXISTS memories (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    key_concept  TEXT     NOT NULL,
    category     TEXT     NOT NULL DEFAULT 'LONG_TERM'
                          CHECK (category IN ('LONG_TERM', 'GOAL', 'PREFERENCE', 'PRIVATE')),
    content      TEXT     NOT NULL,
    created_at   DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')),
    updated_at   DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_memories_category ON memories (category);
CREATE INDEX IF NOT EXISTS idx_memories_updated  ON memories (updated_at DESC);


CREATE TABLE IF NOT EXISTS ideas (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT     NOT NULL,
    description  TEXT     NOT NULL DEFAULT '',
    tags         TEXT     NOT NULL DEFAULT '',
    status       TEXT     NOT NULL DEFAULT 'DRAFT'
                          CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')),
    created_at   DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')),
    updated_at   DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_ideas_status  ON ideas (status);
CREATE INDEX IF NOT EXISTS idx_ideas_updated ON ideas (updated_at DESC);


CREATE TABLE IF NOT EXISTS proactive_briefs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    summary_text  TEXT     NOT NULL,
    urgent_count  INTEGER  NOT NULL DEFAULT 0,
    generated_at  DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_briefs_generated ON proactive_briefs (generated_at DESC);


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
