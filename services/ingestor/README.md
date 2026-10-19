# StreamGuard Ingestor — Go Reference Service

Copyright © 2026 Parsa Fathi — Apache-2.0

The production-oriented backend of StreamGuard: authenticated event ingestion,
strict validation, a bounded processing pipeline, deterministic detection
rules, correlation, incident management, SSE live updates, ML endpoints and an
optional evidence-grounded local AI investigation endpoint.

Part of the [StreamGuard](../../README.md) platform. API/data contract: see the
root README §API and `ARCHITECTURE.md`.

## Build & run

```bash
go build ./...
go run ./cmd/ingestor            # :8080, in-memory store
# or with PostgreSQL:
POSTGRES_DSN=postgres://user:pass@host:5432/db go run ./cmd/ingestor
```

Without `POSTGRES_DSN` the service runs on an in-memory store and logs
`STORE=memory ... data is not durable`. Schema migrations apply automatically
at startup (advisory lock; `internal/store/schema.sql`).

Deterministic event generator CLI:

```bash
go run ./cmd/sggen --scenario brute_force --url http://127.0.0.1:8080 --key sg-demo-ingest-key-2026
go run ./cmd/sggen --scenario traffic_burst --count 140 --seed 7 --url ... --key ...
```

Seeded on first start (insert-if-absent): demo users `admin/admin123` (ADMIN),
`analyst/analyst123` (ANALYST), `viewer/viewer123` (VIEWER); ingest key
`demo-key-01` with value from `INGEST_KEY` (default `sg-demo-ingest-key-2026`);
the 7 contract detection rules; default settings. **Change all of these in any
real deployment.**

## Configuration

| Env | Default | Notes |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `POSTGRES_DSN` | — | empty → in-memory store |
| `SESSION_SECRET` | dev default | HMAC secret — set in production |
| `INGEST_KEY` | `sg-demo-ingest-key-2026` | value behind `X-Ingest-Key` |
| `RATE_LIMIT_PER_MIN` | `60` | per key/user ingest rate limit |
| `MAX_BATCH` | `100` | max events per batch |
| `RETENTION_HOURS` | `72` | TTL; incident evidence protected |
| `CORRELATION_WINDOW_SECONDS` | `600` | correlation window |
| `LLM_BASE_URL` | `http://127.0.0.1:11434` | Ollama-compatible endpoint |
| `LLM_MODEL` | `llama3.2` | model name |
| `ANALYTICS_URL` | — | optional Python analytics sidecar |

## Endpoints

Implements the platform contract (see root README §API summary): auth
(login/logout/session), ingest, events (+filters, detail), rules (+PATCH,
audit), detections, incidents (+lifecycle PATCH, notes, events), analytics
(overview/timeseries/ml/evaluate), AI investigate (optional; 503 when disabled
or provider down), simulator (scenarios/scenario/tick/reset), sources, health,
metrics (Prometheus text), audit (ADMIN), settings, retention-run, and
`GET /api/stream` (SSE: `event:new` batches, `detection:new`, `incident:new`,
`incident:update`, `stats`, `simulator`; keepalive 15s; Last-Event-ID replay).

SSE `event:new` payload shape (batched): `{"events":[...],"count":N,"ts":"..."}`
with compact event rows — the same shape the console demo edition emits over
socket.io, so the web console works against either transport.

## Architecture (packages)

```
cmd/ingestor     main wiring + graceful shutdown (drain ≤10s)
cmd/sggen        deterministic generator CLI
internal/api     HTTP layer (stdlib ServeMux patterns), RBAC middleware, seed
internal/config  env config + validation, secret redaction
internal/event   event model + strict validation (sizes, enums, ISO8601 UTC)
internal/store   Store interface; PostgreSQL (pgx, parameterized, migrations)
                 + thread-safe MemStore (tests, ephemeral runs)
internal/pipeline bounded queue (1024) + worker pool (2..16), idempotent
                 processing, latency measurement, backpressure (429)
internal/rules   7 seeded rules; count/ratio/sequence/exists; cooldown +
                 suppression
internal/correlate open-incident attach vs new INC-00000N; late-event flag
internal/incident lifecycle state machine (validated transitions)
internal/auth    bcrypt users, HMAC sessions, ingest keys, rate limiting
internal/audit   append-only audit log
internal/sse     hub; per-client buffered channels; drop-slowest on overflow
internal/ml      EWMA baselines + seeded Isolation Forest + labeled evaluation
internal/llm     Ollama-compatible provider; strict evidence grounding; honest
                 503s; prompt-injection resistant
internal/metrics Prometheus text format
internal/logging structured JSON logs with secret redaction
internal/sim     deterministic scenarios + labeled ML dataset (seed 42)
```

### Processing semantics (honest)

- `202` from ingest = accepted + stored (+ queued for processing). It does not
  prove rule evaluation completed — check detections/incidents or SSE.
- Idempotency: duplicate `event_id` acknowledged, not re-stored, not
  re-processed.
- Pipeline: at-least-once within a process; in-memory store loses state on
  restart (documented). With PostgreSQL, event inserts are transactional and
  idempotent by primary key.
- Backpressure: full queue → `429` + `Retry-After`.
- Graceful shutdown: SIGINT/SIGTERM → stop accepting → drain (≤10s) → close.

## Testing

```bash
go vet ./...
go test ./... -race -count=1        # unit + API (httptest on MemStore)
go test -tags integration -count=1 ./internal/store/...   # needs POSTGRES_DSN
```

Status at time of writing: all packages green under `-race` on the development
sandbox (2 vCPU). The API suite covers the RBAC matrix, ingest validation
paths (auth/size/batch/rate/idempotency), event filters + invalid-filter 400s,
rule PATCH validation + audit, the incident transition matrix, analytics
shapes, ML evaluation determinism, SSE subscribe/receive, and a simulator E2E
(brute_force → SG-RULE-001 + SG-RULE-003 detections + incidents). PostgreSQL
integration tests run in CI (see `.github/workflows/ci.yml`, job
`go-postgres`).

Notable bugs found by these tests during development (fixed): the
brute-force scenario originally emitted the successful login as the oldest
event so the sequence rule (SG-RULE-003) legitimately never fired — fixed the
generator chronology; the Isolation Forest missed the standard `c(size)` leaf
adjustment, which made near-duplicate feature rows score as anomalous
(331 false positives on the labeled dataset) — fixed with the Liu et al.
formulation; sequence-rule correlation key was global instead of per-actor —
fixed.

## Optional: native C++ parser

The event validation path can use the C++ parser (`native/parser`) through the
C ABI behind a build tag. The default build uses the pure-Go validator in
`internal/event` — no native toolchain required. See `native/parser/README.md`
for the parser's own benchmarks (the strict validator runs at ~416k events/s
per core in the C++ implementation; the pure-Go path is the portable default).
