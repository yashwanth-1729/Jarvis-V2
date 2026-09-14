-- JARVIS durable agent control plane, schema version 2.
-- This database is never part of client-owned personal-data seed/drain/sync.

CREATE TABLE IF NOT EXISTS runtime_sessions (
    id            TEXT PRIMARY KEY,
    principal_id  TEXT NOT NULL,
    device_id     TEXT NOT NULL,
    title         TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_runs (
    id                 TEXT PRIMARY KEY,
    session_id         TEXT NOT NULL REFERENCES runtime_sessions(id),
    client_request_id  TEXT NOT NULL,
    request_hash       TEXT NOT NULL,
    schema_version     INTEGER NOT NULL CHECK (schema_version = 1),
    status             TEXT NOT NULL CHECK (status IN (
        'QUEUED', 'RUNNING', 'WAITING_USER', 'WAITING_APPROVAL',
        'WAITING_RESOURCE', 'PAUSED', 'RECOVERING', 'CANCEL_REQUESTED',
        'COMPLETED', 'FAILED', 'CANCELLED'
    )),
    input_json         TEXT NOT NULL,
    policy_snapshot    TEXT NOT NULL,
    budget_snapshot    TEXT NOT NULL,
    owner_generation   INTEGER NOT NULL DEFAULT 0 CHECK (owner_generation >= 0),
    lease_owner        TEXT,
    lease_expires_at   TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    started_at         TEXT,
    finished_at        TEXT,
    UNIQUE (session_id, client_request_id)
);

CREATE TABLE IF NOT EXISTS agent_steps (
    id                TEXT PRIMARY KEY,
    run_id            TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    ordinal           INTEGER NOT NULL CHECK (ordinal >= 0),
    step_type         TEXT NOT NULL CHECK (step_type IN (
        'TOOL', 'ASK_USER', 'VERIFY', 'FINALIZE'
    )),
    status            TEXT NOT NULL CHECK (status IN (
        'PENDING', 'READY', 'RUNNING', 'WAITING', 'VERIFIED',
        'FAILED', 'UNCERTAIN', 'SKIPPED'
    )),
    acceptance_json   TEXT NOT NULL DEFAULT '{}',
    dependencies_json TEXT NOT NULL DEFAULT '[]',
    workflow_version  TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    UNIQUE (run_id, ordinal)
);

CREATE TABLE IF NOT EXISTS agent_events (
    event_id     TEXT PRIMARY KEY,
    run_id       TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    seq          INTEGER NOT NULL CHECK (seq >= 1),
    event_type   TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    UNIQUE (run_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_admission
    ON agent_runs (status, lease_expires_at, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_runs_session
    ON agent_runs (session_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_steps_run_status
    ON agent_steps (run_id, status, ordinal);
CREATE INDEX IF NOT EXISTS idx_agent_events_replay
    ON agent_events (run_id, seq);

CREATE TABLE IF NOT EXISTS runtime_migration_history (
    version     INTEGER PRIMARY KEY,
    applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT OR IGNORE INTO runtime_migration_history(version) VALUES (2);

PRAGMA user_version = 2;
