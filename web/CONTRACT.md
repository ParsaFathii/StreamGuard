# StreamGuard — Unified API & Data Contract (v1)

This is the SINGLE SOURCE OF TRUTH for all StreamGuard implementations (Next.js demo edition and Go reference edition). Both backends implement the same contract; the React UI works against either one.

- Demo edition: Next.js API routes at `/api/*` (embedded engine, SQLite)
- Go reference edition: `services/ingestor`, serves the same paths under `/api/*` on :8080 (PostgreSQL)
- All timestamps: ISO 8601 UTC strings (`2026-01-01T12:00:00.000Z`). Internal storage: UTC.
- All responses JSON. Errors: `{ "error": { "code": "MACHINE_CODE", "message": "human readable" } }` with proper HTTP status.
- List endpoints: `{ "data": [...], "page": number, "pageSize": number, "total": number }` (bounded, default pageSize 25, max 100).
- Auth: `sg_session` HttpOnly cookie (HMAC-signed token, demo-grade, documented as such) + optional `Authorization: Bearer <token>` for API/ingest use.

## Roles

- `ADMIN` — everything: user management, settings, rules, incidents, audit, reset
- `ANALYST` — events, detections, rules (enable/disable + edit thresholds), incidents (triage/investigate/resolve/close + notes), AI investigate, analytics, sources, health
- `VIEWER` — read-only: events, detections, incidents (read), analytics, health, rules (read)

Demo users (seeded): `admin` / `admin123` (ADMIN), `analyst` / `analyst123` (ANALYST), `viewer` / `viewer123` (VIEWER).

Backend MUST enforce roles on every route (not only in the frontend). Sensitive actions are audited.

## Event Schema (schema_version = 1)

```jsonc
{
  "event_id": "uuid-v4",            // required, idempotency key, unique
  "schema_version": 1,              // required, must be 1
  "event_time": "ISO-8601-UTC",     // required, original occurrence time (not >10min future skew allowed)
  "source_id": "sim-app-01",        // required, 1..64 chars, [a-zA-Z0-9._-]
  "source_type": "app",             // required, one of: app|infra|system|security|synthetic
  "severity": "info",               // required, one of: info|low|medium|high|critical
  "category": "auth",               // required, one of: auth|network|application|data|system|config|security
  "message": "normalized text",     // required, 1..512 chars, normalized message
  "attributes": { },                // optional, JSON object, stringified <= 4KB, no nested secrets
  "correlation_id": "optional-id",  // optional, <=128 chars
  "trace_id": "optional-id",        // optional, <=128 chars
  "actor": "user-or-service",       // optional, <=128 chars (account/actor identifier)
  "origin": "synthetic"             // set by SYSTEM: synthetic|external (data-origin marker)
}
```

Server-side fields (not client-supplied): `ingest_time`, `status` (`VALIDATED` | `REJECTED` | `PROCESSED`), `rejection_reason`.

Validation rules (server-enforced):
- Max payload: single event 4KB; batch request body 256KB; max batch size 100 events
- Reject with recorded `ValidationFailure` row: unknown/missing fields (schema_version != 1, bad enums, bad timestamp, oversized, invalid JSON). NEVER silently discard.
- Duplicate `event_id`: idempotent accept — return 200 with `duplicate: true`, do not double-store, do not re-run detection for it.
- Rate limit: 60 ingest requests/min per key (429 with retry-after). Ingest requires session (ADMIN/ANALYST) OR valid ingest key (`X-Ingest-Key` header; seeded demo key id `demo-key-01`).

## Detection Rules (seeded, all fields required)

| id | name | description | selector | condition | threshold/window | severity | cooldown | correlation key |
|----|------|-------------|----------|-----------|------------------|----------|----------|-----------------|
| SG-RULE-001 | Repeated Authentication Failures | >=5 failed auth events for same actor | category=auth, attributes.action=login_failed | count(actor) | 5 / 120s | high | 300s | actor |
| SG-RULE-002 | Abnormal Request Rate | >120 request events/min from one source | category=network, attributes.kind=request | count(source_id) | 120 / 60s | medium | 120s | source_id |
| SG-RULE-003 | Suspicious Auth Sequence | >=3 auth failures followed by success for same actor within 5 min | category=auth, sequence(login_failed x3, login_success) | sequence actor | 3 fails + 1 success / 300s | high | 300s | actor |
| SG-RULE-004 | Error Rate Spike | error ratio >30% over 5 min per source (min 20 events) | category=application, severity in (medium,high,critical) or attributes.error=true | ratio | 0.30 / 300s | medium | 300s | source_id |
| SG-RULE-005 | Repeated Authorization Failures | >=3 authz failures same actor in 5 min | category=security, attributes.action=access_denied | count(actor) | 3 / 300s | medium | 300s | actor |
| SG-RULE-006 | Unexpected Configuration Change | config change on source_type=infra or source_id starts with prod- | category=config, attributes.action=change | exists | 1 / 0s | high | 0s | source_id |
| SG-RULE-007 | Ingestion Validation Failures | >=10 rejected events in 60s | internal (validation failures) | count | 10 / 60s | low | 600s | global |

Rule model: `{ id, name, description, enabled, selector: {category?, severity?, sourceIdPrefix?, attribute?: {key,value}}, condition: {type: count|ratio|sequence|exists, threshold, windowSeconds, metric}, severity, cooldownSeconds, suppression: boolean, version: int, updatedAt }`. Every rule change is written to `RuleAudit`.

## Detections

`{ id, ruleId, eventId (triggering event), incidentId?, severity, score (0..1 confidence-ish strength metric), title, detail: {matchedCount, windowSeconds, actor?, sourceId?, sampleEventIds[]}, status: ACTIVE|SUPPRESSED, createdAt }`

- A rule fires → check cooldown (same rule + correlation key) → if within cooldown, suppression increments (no duplicate detection), else create Detection.
- Detection then goes to Correlation.

## Correlation → Incidents

Correlation key per rule (see table above, e.g. `actor` for auth rules, `source_id` for rate rules).
- Find OPEN (not RESOLVED/CLOSED) incident with same `ruleId` + `correlationKey` AND `updatedAt` within `correlationWindowSeconds` (600s default, configurable in settings) → attach detection + events to it, bump severity to max, update timestamps.
- Else create new Incident.
- Late events (event_time older than window) still attach but flagged `late: true` in incident detail.

Incident model:
`{ id: "INC-000001" (sequential, zero-padded), title, severity, status, ruleId, correlationKey, correlationKeyLabel, eventCount, detectionCount, firstEventTime, lastEventTime, createdAt, updatedAt, resolvedAt?, closedAt?, assignedTo?, resolutionSummary?, statusHistory: [{status, at, actor, note?}] }`

Incident lifecycle (validated transitions ONLY, enforced server-side):
- NEW → TRIAGED, INVESTIGATING, RESOLVED, CLOSED
- TRIAGED → INVESTIGATING, RESOLVED, CLOSED
- INVESTIGATING → RESOLVED, CLOSED (and back to TRIAGED)
- RESOLVED → CLOSED, INVESTIGATING (reopen)
- CLOSED → (terminal; reopen only via INVESTIGATING by ADMIN)
Invalid transition → 400 `INVALID_TRANSITION`. Every transition + assignment + resolution is audited (actor + timestamp + from/to). Resolving requires `resolutionSummary` (min 10 chars). AI reports NEVER auto-resolve incidents.

Incident notes: `{ id, incidentId, author, body (<=4000), createdAt }`.

## API Endpoints (all under /api)

### Auth
- `POST /api/auth/login` {username, password} → {user} + sets `sg_session` cookie. Audited.
- `POST /api/auth/logout` → {ok:true}. Audited.
- `GET  /api/auth/session` → {user: {username, role, displayName}} | 401

### Ingestion (ADMIN/ANALYST session OR X-Ingest-Key)
- `POST /api/ingest` — body: single event object OR `{ "batch": [events...] }`
  → `202 { accepted: n, duplicates: n, rejected: n, eventIds: [...], duplicateIds: [...], rejectedItems: [{index, reason}] }`
  → `413` oversized, `429` rate limited, `400` malformed body

### Events (all roles)
- `GET /api/events` — filters (all optional, validated): `q` (message/actor search, min 2 chars), `severity` (multi, csv), `category`, `sourceId`, `sourceType`, `from`, `to` (ISO), `correlationId`, `traceId`, `incidentId`, `ruleId`, `status`, `origin`, `page`, `pageSize`. Invalid filter value → 400 with which param.
- Evidence export: add `format=csv|json` + `limit` (1..5000, default 2000) → file download (Content-Disposition attachment; CSV is RFC 4180 with UTF-8 BOM; JSON is `{kind, exportedAt, count, data}`). Same filters/sort as the list; every export is audited (`export`).
- `GET /api/events/[id]` → full event (attributes parsed as object)

### Rules
- `GET /api/rules` (all roles) → rules + lastFiredAt + fireCount (24h)
- `PATCH /api/rules/[id]` (ANALYST+) — {enabled?, threshold?, windowSeconds?, severity?, cooldownSeconds?} → validates ranges (threshold 1..10000, window 10..3600s, cooldown 0..3600s), bumps version, writes RuleAudit. VIEWER → 403.
- `GET /api/rules/[id]/audit` (ADMIN) → rule change history

### Detections
- `GET /api/detections` — filters: ruleId, severity, incidentId, status, from, to, page, pageSize. Evidence export: `format=csv|json` + `limit` (audited).

### Incidents
- `GET /api/incidents` — filters: status, severity, ruleId, assignedTo, q, page, pageSize; sort=createdAt|severity|updatedAt (severity ordered by rank info<low<medium<high<critical, newest first within a rank). Evidence export: `format=csv|json` + `limit` (honors sort=severity rank order; audited).
- `GET /api/incidents/[id]` → incident + events (first 200, id+summary) + detections + notes + aiReports (id/ts only) + statusHistory
- `PATCH /api/incidents/[id]` (ANALYST+) — {status?, assignedTo?, resolutionSummary?} → validates transition + RBAC. VIEWER → 403.
- `POST /api/incidents/[id]/notes` (ANALYST+) {body}
- `GET /api/incidents/[id]/events` — paginated incident events

### Analytics
- `GET /api/analytics/overview` → {
    totals: {events24h, events7d, detections24h, incidentsOpen, incidents24h, rejected24h, duplicates24h},
    ingestRatePerMin: [{minute, count}] (last 60 min),
    severityBreakdown24h: {info, low, medium, high, critical},
    categoryBreakdown24h: {...},
    topSources24h: [{sourceId, count}] (top 8),
    processing: {avgLatencyMs24h, p95LatencyMs24h, lastProcessedAt},
    health: {db: up|down, ws: up|down, llm: ok|disabled|error, queueDepth: 0}
  }
- `GET /api/analytics/timeseries?metric=events|detections|rejected&points=60&bucket=minute` → [{bucketStart, value}]
- `GET /api/analytics/ml` → {
    modelVersion: "iforest-ts-1.2.0", method: "Isolation Forest + EWMA z-score",
    anomalyTimeline: [{bucketStart, rate, errorRatio, failedAuthRatio, uniqueActors, zscore, iforestScore, isAnomaly}] (last 120 min),
    currentBaselines: [{sourceId, ewmaRate, stddev, currentRate, zscore, status: normal|elevated|anomalous}],
    lastEvaluation?: {ts, datasetSize, metrics: {iforest: {precision, recall, f1, fpr}, zscore: {...}, rules: {...}}}
  }
- `POST /api/analytics/ml/evaluate` (ANALYST+) → runs reproducible labeled evaluation (fixed seed), stores MlRun, returns per-method metrics {precision, recall, f1, fpr, confusion: {tp,fp,tn,fn}} + dataset info. Deterministic.

### AI Investigation Assistant (ANALYST+, requires settings.aiEnabled)
- `POST /api/ai/investigate` {incidentId, question?} → {
    report: {
      summary, facts: string[], ruleFindings: string[], mlFindings: string[],
      hypotheses: string[], nextSteps: string[], references: {incidentId, eventIds[], ruleIds[]}
    },
    provider: {name, model, status: ok|error|disabled}, durationMs
  }
- Grounding is MANDATORY: the backend assembles an evidence bundle (incident + up to 50 events + rule definitions + ML context) and instructs the LLM to use ONLY that evidence; event text is wrapped as untrusted data (prompt-injection resistant); the response is post-processed/validated (JSON shape). If provider fails → 503 {error} honestly; system stays fully usable without AI.
- AI can NOT change rules, incidents, or anything. Read-only advisory. Audited.

### Simulator (demo edition; ANALYST+; ALL simulator data labeled origin=synthetic)
- `GET  /api/simulator/scenarios` → [{id, name, description, expectedDetections: [ruleIds], expectedIncidentSeverity}]
- `POST /api/simulator/scenario` {scenarioId, seed?} → {runId, generated: n, eventIds, expectedDetections, note}
  Scenarios (deterministic, seeded): `clean_baseline`, `brute_force`, `credential_stuffing`, `traffic_burst`, `latency_spike`, `error_storm`, `config_change`, `authz_failures`, `malformed_batch`, `mixed_attack`
- `POST /api/simulator/tick` {count? (1..50, default 12)} → generates normal activity, returns generated ids
- `POST /api/simulator/reset` (ADMIN) → wipes events/detections/incidents/audit? (keep users, rules), re-seeds baseline, audited

### Sources
- `GET /api/sources` → [{id, name, type, origin, events24h, lastEventAt, status: active|idle|error, description}] — derived from real event data (no fake entries)

### System
- `GET /api/health` → {status: ok|degraded, version, uptimeSec, checks: {db, ws, llm}, queue: {depth, processed24h, rejected24h}, retention: {policy, lastRunAt, deletedCount}}
- `GET /api/metrics` → Prometheus text format (see Metrics). Requires a session (VIEWER+); anonymous scraping is not supported.
- `GET /api/audit` (ADMIN) — filters: actor, action, targetType, from, to, page. Actions audited: login, logout, rule.update, incident.update, incident.note, ai.investigate, simulator.run, settings.update, demo.reset, retention.run, ingest (key-based, sampled), export, backup.create, backup.auto. Audit export supports `format=csv|json` + `limit` (exporting the audit trail is itself audited).
- `GET /api/settings` (all roles; secrets never returned) → {aiEnabled, aiProvider: "sandbox-zai"|"ollama"|..., correlationWindowSeconds, retentionHours, maxBatchSize, rateLimitPerMin, languageDefault}
- `PATCH /api/settings` (ADMIN) — same fields, validated, audited
- `GET /api/system/backups` (ADMIN) → {dir, keep, scheduleHours, lastRunAt, lastResult, backups: [{name, sizeBytes, createdAt}]}
- `POST /api/system/backups` (ADMIN) → snapshot now (`VACUUM INTO`), audited as `backup.create`; 500 `BACKUP_FAILED` with reason on failure

## Metrics (Prometheus text format, /api/metrics)

```
# TYPE streamguard_events_received_total counter
streamguard_events_received_total{origin="synthetic"} 1234
# accepted / rejected / duplicates counters, validation_failures_total,
# processing_latency_ms (summary: avg/p95 from Metric table), detections_total{rule_id=...},
# incidents_total{status=...}, incidents_open gauge, ingest_requests_total{code=...},
# llm_requests_total, llm_failures_total, ws_connections gauge, queue_depth gauge, uptime_seconds gauge
```
Values computed from DB aggregates (durable) + process-local counters (documented: reset on restart).

## Retention (configurable, observable, safe)

- Setting `retentionHours` (default 72). Cleanup pass on demand via `POST /api/system/retention-run` (ADMIN) + automatic check at most every 5 min triggered by ingest (cheap).
- NEVER delete events attached to non-CLOSED incidents (protected-link scan is exhaustive, not capped). Deletions counted in metrics + audit (`retention.run` with deletedCount, detectionsDeleted, validationFailuresDeleted, sessionsSwept).
- A sweep also purges Detection rows of deleted events (they would dangle), recomputes the affected incidents' eventCount/detectionCount, deletes ValidationFailure rows older than the same cutoff, and sweeps expired sessions.

## Backups (SQLite snapshots, rotating)

- Automatic: at most once every 24 h (state persisted in Setting key `backup` so restarts/HMR don't reset the clock), triggered by ingest and the stats loop. Manual: `POST /api/system/backups` (ADMIN).
- Snapshots use SQLite `VACUUM INTO` — consistent under WAL while traffic continues; the file is also compacted. Rotation keeps the newest 7 (`sg-backup-*.db` in `<db-dir>/backups/`); older files are pruned. Every run is audited (`backup.auto` / `backup.create`).
- Restore is deliberately manual (never automatic): stop the app → replace the DB file with the backup → delete `-wal`/`-shm` sidecars → start the app.

## Real-time (socket.io, port 3003, mini-service)

Browser connects: `io("/?XTransformPort=3003")` with reconnection; UI shows connection state (live/stale/disconnected + lastEventAt).
Next.js API routes notify the service via server-side `fetch("http://127.0.0.1:3003/emit", {method:"POST", body: JSON.stringify({channel, payload})})`.

Channels (server→client):
- `event:new` — payload: compact event (id, eventTime, severity, category, sourceId, actor, message truncated 140) — throttled: batched every 400ms
- `detection:new` — payload: detection summary
- `incident:new` / `incident:update` — payload: incident summary
- `stats` — payload: overview counters (every 5s)
- `simulator` — payload: {runId, scenarioId, phase} 

Service also exposes HTTP: `GET /health` (for /api/health checks), `POST /emit` (internal only — binds 127.0.0.1), connection count tracked.

## ML Methods (deterministic, reproducible, honest)

- **EWMA baseline**: per (source) rate r_t; baseline = EWMA(α=0.3); z = (r_t − baseline)/σ̂ (σ̂ = EWMA of |dev|); anomaly if z > 3.
- **Isolation Forest** (pure implementation, seeded RNG, 100 trees, subsample 64, max depth ceil(log2(64))): features per minute-bucket per source: [event_rate, error_ratio, failed_auth_ratio, unique_actors, avg_severity_weight]. Score = mean path-length normalization c(n); anomaly if score > 0.61 (tunable, documented).
- **Evaluation**: labeled synthetic dataset (scenarios with known ground truth at minute-bucket granularity), methods compared: rules-only, z-score, iforest. Metrics: precision/recall/F1/FPR + confusion. Fixed seed → reproducible. No fabricated numbers; model version recorded with every run and finding.

## Version & Identity

- Product version: managed via CHANGELOG + package metadata; final target v10.4.0
- API version header: `X-StreamGuard-Version: <version>` on all responses
- UI must show version + data-origin banner: "SIMULATOR DATA — synthetic events" whenever any displayed data includes origin=synthetic (persistent chip in header + per-list markers)
