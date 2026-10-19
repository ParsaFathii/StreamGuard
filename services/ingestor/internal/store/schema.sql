-- StreamGuard ingestor schema (PostgreSQL).
-- Applied at startup under an advisory lock; every statement is idempotent.
-- All application queries are parameterized; no string interpolation.
-- Nullable timestamps are written as the sentinel '0001-01-01 00:00:00+00'
-- (Go zero time) and read back with COALESCE to the same sentinel, so the
-- Go layer can rely on time.Time zero values without NULL scanning.

CREATE TABLE IF NOT EXISTS users (
    username      TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('ADMIN','ANALYST','VIEWER')),
    display_name  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    username   TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS ingest_keys (
    id    TEXT PRIMARY KEY,
    value TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL DEFAULT '',
    active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS events (
    event_id        TEXT PRIMARY KEY,
    schema_version  INT NOT NULL,
    event_time      TIMESTAMPTZ NOT NULL,
    source_id       TEXT NOT NULL,
    source_type     TEXT NOT NULL,
    severity        TEXT NOT NULL,
    category        TEXT NOT NULL,
    message         TEXT NOT NULL,
    attributes      JSONB,
    correlation_id  TEXT NOT NULL DEFAULT '',
    trace_id        TEXT NOT NULL DEFAULT '',
    actor           TEXT NOT NULL DEFAULT '',
    origin          TEXT NOT NULL DEFAULT '',
    ingest_time     TIMESTAMPTZ NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('VALIDATED','REJECTED','PROCESSED')),
    rejection_reason TEXT NOT NULL DEFAULT '',
    latency_ms      BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_event_time ON events (event_time DESC);
CREATE INDEX IF NOT EXISTS idx_events_ingest_time ON events (ingest_time);
CREATE INDEX IF NOT EXISTS idx_events_source ON events (source_id);
CREATE INDEX IF NOT EXISTS idx_events_actor ON events (actor) WHERE actor <> '';

CREATE TABLE IF NOT EXISTS validation_failures (
    id     TEXT PRIMARY KEY,
    ts     TIMESTAMPTZ NOT NULL,
    reason TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_vf_ts ON validation_failures (ts DESC);

CREATE TABLE IF NOT EXISTS rules (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    selector        JSONB NOT NULL DEFAULT '{}',
    condition       JSONB NOT NULL DEFAULT '{}',
    severity        TEXT NOT NULL,
    cooldown_seconds INT NOT NULL DEFAULT 0,
    suppression     BOOLEAN NOT NULL DEFAULT TRUE,
    version         INT NOT NULL DEFAULT 1,
    updated_at      TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS rule_audit (
    id      TEXT PRIMARY KEY,
    ts      TIMESTAMPTZ NOT NULL,
    rule_id TEXT NOT NULL,
    actor   TEXT NOT NULL,
    changes JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_rule_audit_rule ON rule_audit (rule_id, ts DESC);

CREATE TABLE IF NOT EXISTS detections (
    id              TEXT PRIMARY KEY,
    rule_id         TEXT NOT NULL,
    event_id        TEXT NOT NULL DEFAULT '',
    incident_id     TEXT NOT NULL DEFAULT '',
    correlation_key TEXT NOT NULL DEFAULT '',
    severity        TEXT NOT NULL,
    score           DOUBLE PRECISION NOT NULL DEFAULT 0,
    title           TEXT NOT NULL DEFAULT '',
    detail          JSONB NOT NULL DEFAULT '{}',
    status          TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUPPRESSED')),
    created_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_det_rule_key ON detections (rule_id, correlation_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_det_created ON detections (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_det_incident ON detections (incident_id) WHERE incident_id <> '';

CREATE TABLE IF NOT EXISTS incidents (
    id                 TEXT PRIMARY KEY,
    title              TEXT NOT NULL,
    severity           TEXT NOT NULL,
    status             TEXT NOT NULL CHECK (status IN ('NEW','TRIAGED','INVESTIGATING','RESOLVED','CLOSED')),
    rule_id            TEXT NOT NULL,
    correlation_key    TEXT NOT NULL DEFAULT '',
    correlation_label  TEXT NOT NULL DEFAULT '',
    event_count        INT NOT NULL DEFAULT 0,
    detection_count    INT NOT NULL DEFAULT 0,
    first_event_time   TIMESTAMPTZ,
    last_event_time    TIMESTAMPTZ,
    assigned_to        TEXT NOT NULL DEFAULT '',
    resolution_summary TEXT NOT NULL DEFAULT '',
    created_at         TIMESTAMPTZ NOT NULL,
    updated_at         TIMESTAMPTZ NOT NULL,
    resolved_at        TIMESTAMPTZ,
    closed_at          TIMESTAMPTZ,
    status_history     JSONB NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_incidents_rule_key ON incidents (rule_id, correlation_key, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_created ON incidents (created_at DESC);

CREATE TABLE IF NOT EXISTS incident_events (
    incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    event_id    TEXT NOT NULL,
    late        BOOLEAN NOT NULL DEFAULT FALSE,
    attached_at TIMESTAMPTZ NOT NULL
        DEFAULT '0001-01-01 00:00:00+00',
    PRIMARY KEY (incident_id, event_id)
);
-- No FK on event_id on purpose: retention deletes events while the link rows
-- survive (dangling links are skipped on read), matching MemStore semantics.

CREATE TABLE IF NOT EXISTS notes (
    id          TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    author      TEXT NOT NULL,
    body        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_incident ON notes (incident_id, created_at);

CREATE TABLE IF NOT EXISTS ai_reports (
    id              TEXT PRIMARY KEY,
    incident_id     TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    provider_status TEXT NOT NULL DEFAULT '',
    ts              TIMESTAMPTZ NOT NULL,
    report          JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_ai_incident ON ai_reports (incident_id, ts);

CREATE TABLE IF NOT EXISTS audit_log (
    id          TEXT PRIMARY KEY,
    ts          TIMESTAMPTZ NOT NULL,
    actor       TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT '',
    action      TEXT NOT NULL,
    target_type TEXT NOT NULL DEFAULT '',
    target_id   TEXT NOT NULL DEFAULT '',
    details     JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log (ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (action);

CREATE TABLE IF NOT EXISTS settings (
    id                        INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    ai_enabled                BOOLEAN NOT NULL DEFAULT TRUE,
    ai_provider               TEXT NOT NULL DEFAULT 'ollama',
    correlation_window_seconds INT NOT NULL DEFAULT 600,
    retention_hours           INT NOT NULL DEFAULT 72,
    max_batch_size            INT NOT NULL DEFAULT 100,
    rate_limit_per_min        INT NOT NULL DEFAULT 60,
    language_default          TEXT NOT NULL DEFAULT 'en'
);

CREATE TABLE IF NOT EXISTS ml_runs (
    id           BIGSERIAL PRIMARY KEY,
    ts           TIMESTAMPTZ NOT NULL,
    seed         INT NOT NULL,
    dataset_size INT NOT NULL,
    methods      JSONB NOT NULL DEFAULT '{}',
    dataset_info JSONB NOT NULL DEFAULT '{}'
);

CREATE SEQUENCE IF NOT EXISTS incident_seq START 1;
