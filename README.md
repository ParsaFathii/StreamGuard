# StreamGuard

**Real-Time Event Processing, Security Analytics and AI-Assisted Incident Investigation**

[![CI](https://github.com/ParsaFathii/StreamGuard/actions/workflows/ci.yml/badge.svg)](https://github.com/ParsaFathii/StreamGuard/actions/workflows/ci.yml)

Copyright © 2026 Parsa Fathi — Apache-2.0

StreamGuard ingests event streams, validates and normalizes them, applies
deterministic detection rules, correlates related detections into incidents,
and supports investigation workflows with searchable event history, live
streams, statistical/ML anomaly analytics and an **optional, evidence-grounded
local AI assistant**.

This is a real, working system: every pipeline stage is testable, every
displayed number comes from real data, synthetic data is always labeled, and
the platform remains fully functional when optional AI components are disabled.

```
Event Sources ──▶ Ingestion API ──▶ Validation ──▶ Processing Pipeline
                                                     │
                          Detection Rules ◀──────────┤──────────▶ Stream Analytics
                                                     │
                                        Correlation Engine
                                                     │
                                        Incident Manager ──▶ PostgreSQL
                                                     │
                                  Web Console ◀── Incident API ──▶ Python ML
                                                     │
                                        Optional Local LLM
```

## Use cases

- **Security monitoring** — repeated authentication failures, credential
  stuffing patterns, authorization failures, unexpected configuration changes.
- **Operational monitoring** — request-rate bursts, error-rate spikes, service
  anomalies via statistical baselines and Isolation Forest.
- **Incident response** — a validated incident lifecycle, correlation of
  related detections, evidence timelines, investigation notes, audit trail.
- **Evaluation and training** — deterministic, seeded scenarios (brute force,
  traffic burst, error storm, …) with known expected outcomes; reproducible ML
  evaluation with labeled datasets.

## What's in this repository

| Path | Component | Language | Role |
|---|---|---|---|
| `services/ingestor` | Go reference service | Go 1.23 | ingestion API, processing pipeline, rules, correlation, incidents, SSE, metrics |
| `analytics` | analytics package | Python 3.12 | EWMA baselines, Isolation Forest, reproducible evaluation, LLM provider adapter, HTTP sidecar |
| `native/parser` | native parser | C++20 | strict, fast event JSON parsing/validation with C ABI (optional acceleration) |
| `web` | StreamGuard Console | TypeScript/React (Next.js) | 14-section investigation UI; demo edition (embedded engine) or Go-backed mode |
| `deploy/docker` + `docker-compose.yml` | deployment | Docker | full stack: PostgreSQL + Go + analytics sidecar + console |
| `docs` | documentation | EN + FA (فارسی) | architecture, guides, screenshots, GIFs |
| `.github/workflows` | CI/CD | GitHub Actions | tests, sanitizers, security scans, containers, E2E, releases |

## Prerequisites

- **Full stack deployment:** Docker + Docker Compose (easiest), or: Go 1.26+ (toolchain pinned in go.mod),
  PostgreSQL 16+, Python 3.12+, Bun 1.1+ (for the console), a C++20 compiler
  (only if you build the native parser).
- **Console demo edition only:** Bun 1.1+ (SQLite is embedded — no external
  database).
- Optional: a local [Ollama](https://ollama.com)-compatible LLM endpoint for
  the AI investigation assistant.

## Quick start

### Option A — full stack with Docker Compose

```bash
docker compose up --build
# Console (Go-backed mode):  http://localhost:3000
# Go API health:             http://localhost:8080/api/health
# Analytics sidecar:         http://localhost:8090/health
```

### Option B — Go service from source

```bash
cd services/ingestor
go build ./...
go run ./cmd/ingestor            # :8080, in-memory store (no POSTGRES_DSN)
# in another shell — generate a deterministic attack scenario:
go run ./cmd/sggen --scenario brute_force --url http://127.0.0.1:8080 --key sg-demo-ingest-key-2026
```

With PostgreSQL: `POSTGRES_DSN=postgres://user:pass@host:5432/db go run ./cmd/ingestor`
(schema migrations apply automatically at startup).

### Option C — console demo edition (self-contained)

```bash
cd web
bun install
bun run db:push && bun run seed   # SQLite + ~4-5h of seeded history via the engine
bun run dev                        # http://localhost:3000
# live-stream relay (socket.io):
cd mini-services/stream && bun run dev
```

Sign in with demo users (demo-grade, seeded):

| Username | Password | Role |
|---|---|---|
| `admin` | `admin123` | ADMIN — everything incl. settings, audit, reset |
| `analyst` | `analyst123` | ANALYST — investigation, rules, incidents, AI |
| `viewer` | `viewer123` | VIEWER — read-only |

Demo ingest key for testing the HTTP ingestion path:
`sg-demo-ingest-key-2026` (use as `X-Ingest-Key` header).

## Configuration (Go service)

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `POSTGRES_DSN` | *(empty)* | PostgreSQL DSN; empty → in-memory store (non-durable, logged) |
| `SESSION_SECRET` | dev default | HMAC secret for session cookies — **set in production** |
| `INGEST_KEY` | `sg-demo-ingest-key-2026` | ingest key value for `X-Ingest-Key` auth |
| `RATE_LIMIT_PER_MIN` | `60` | ingest requests per minute per key/user |
| `MAX_BATCH` | `100` | max events per ingest batch |
| `RETENTION_HOURS` | `72` | event TTL (incident evidence protected) |
| `CORRELATION_WINDOW_SECONDS` | `600` | correlation window |
| `LLM_BASE_URL` | `http://127.0.0.1:11434` | Ollama-compatible endpoint for the AI assistant |
| `LLM_MODEL` | `llama3.2` | model name |
| `ANALYTICS_URL` | *(empty)* | Python analytics sidecar URL (optional) |

## Event schema (version 1)

```jsonc
{
  "event_id": "uuid-v4",            // required — idempotency key
  "schema_version": 1,              // required — must be 1
  "event_time": "2026-01-15T10:30:00.000Z", // required — ISO 8601 UTC, original time
  "source_id": "prod-web-02",       // required — ^[a-zA-Z0-9._-]{1,64}$
  "source_type": "infra",           // app | infra | system | security | synthetic
  "severity": "high",               // info | low | medium | high | critical
  "category": "auth",               // auth | network | application | data | system | config | security
  "message": "Failed login for user_admin",  // 1..512 chars
  "attributes": { "action": "login_failed" }, // optional, ≤ 4 KB stringified
  "correlation_id": "optional",     // optional
  "trace_id": "optional",           // optional
  "actor": "user_admin"             // optional
}
```

Server adds: `ingest_time`, `status` (`VALIDATED`/`REJECTED`/`PROCESSED`),
`origin` (`synthetic`/`external`). Validation is strict; rejects are recorded
(never silently discarded) with a truncated sample. Duplicates by `event_id`
are idempotently acknowledged. Limits: 4 KB/event, 100 events/batch,
256 KB request body, 60 req/min.

```bash
curl -X POST http://localhost:8080/api/ingest \
  -H 'content-type: application/json' \
  -H 'X-Ingest-Key: sg-demo-ingest-key-2026' \
  -d '{"batch":[{"event_id":"...","schema_version":1,"event_time":"2026-01-15T10:30:00Z","source_id":"sim-app-01","source_type":"app","severity":"info","category":"application","message":"healthcheck ok"}]}'
# → 202 {"accepted":1,"duplicates":0,"rejected":0,"eventIds":[...],...}
```

## API summary

All endpoints enforce server-side RBAC. Full contract: `ARCHITECTURE.md` +
service READMEs.

- `POST /api/auth/login|logout`, `GET /api/auth/session`
- `POST /api/ingest` — batch/single ingestion (session ADMIN/ANALYST or ingest key)
- `GET /api/events` (+ filters: q, severity, category, source, time range,
  correlation/trace/incident/rule ids, status, origin, pagination),
  `GET /api/events/{id}`
- `GET /api/rules`, `PATCH /api/rules/{id}` (ANALYST+), `GET /api/rules/{id}/audit` (ADMIN)
- `GET /api/detections` (filters)
- `GET /api/incidents`, `GET /api/incidents/{id}`, `PATCH /api/incidents/{id}`
  (validated lifecycle transitions), `POST /api/incidents/{id}/notes`,
  `GET /api/incidents/{id}/events`
- `GET /api/analytics/overview|timeseries|ml`, `POST /api/analytics/ml/evaluate`
- `POST /api/ai/investigate` (ANALYST+, optional, evidence-grounded)
- `GET /api/simulator/scenarios`, `POST /api/simulator/scenario|tick|reset`
- `GET /api/sources`, `GET /api/health`, `GET /api/metrics` (Prometheus text),
  `GET /api/audit` (ADMIN), `GET|PATCH /api/settings`,
  `POST /api/system/retention-run`, `GET /api/stream` (SSE, Go edition)

## Detection rules (seeded)

| Rule | Fires when | Severity |
|---|---|---|
| SG-RULE-001 Repeated Authentication Failures | ≥ 5 failed logins, same actor, 120 s | high |
| SG-RULE-002 Abnormal Request Rate | > 120 requests/min, same source | medium |
| SG-RULE-003 Suspicious Auth Sequence | ≥ 3 failures then success, same actor, 5 min | high |
| SG-RULE-004 Error Rate Spike | error ratio > 30% (≥ 20 events), 5 min | medium |
| SG-RULE-005 Repeated Authorization Failures | ≥ 3 authz failures, same actor, 5 min | medium |
| SG-RULE-006 Unexpected Configuration Change | config change on infra/prod source | high |
| SG-RULE-007 Ingestion Validation Failures | ≥ 10 rejected events, 60 s | low |

Rules are editable at runtime (threshold/window/cooldown/severity/enabled) with
version bumps and full audit history.

## Incident workflow

`NEW → TRIAGED → INVESTIGATING → RESOLVED → CLOSED` (validated transitions
only, reopen paths defined; resolution requires a summary). Related detections
are correlated by rule + actor/source within the configurable window (default
10 min); repeated equivalent detections attach to the open incident instead of
creating duplicates. Every change records who/when. The AI assistant is
advisory and can never resolve or modify anything.

## Machine learning

- **EWMA baselines** (α = 0.3, one-sided z-score, anomaly z > 3) per-source.
- **Isolation Forest** (100 trees, subsample 64, depth 8, score threshold
  0.61, seeded — deterministic) over per-minute feature vectors:
  `[rate, error_ratio, failed_auth_ratio, unique_actors, avg_severity_weight]`.
- **Reproducible evaluation** on labeled synthetic scenarios (seed 42):
  precision/recall/F1/FPR + confusion per method (rules vs z-score vs
  isolation forest). Example (Python package, synthetic data — not production
  claims): isolation forest precision 1.0 across all 14 datasets with recall
  1.00 on brute_force and 0.95 on latency_spike, but 0.30 on error_storm and
  0.0 on wide-cloud noisy data where z-score wins — method tradeoffs are
  documented, not hidden. Run it yourself:
  `python3 -m streamguard_analytics evaluate --dataset all`.

## Local LLM assistant (optional)

Point `LLM_BASE_URL` at any Ollama-compatible server. The assistant receives
only an assembled evidence bundle (incident + ≤ 50 events + rule definitions +
ML context), must separate facts from hypotheses, must not invent data, and
returns a structured report (facts / rule findings / ML findings / hypotheses /
next steps / references). Event text is wrapped as untrusted data
(prompt-injection resistant). Provider failures return honest errors; **no
cloud fallback**. Everything works without it.

## Testing

Every component ships real tests; run them all:

```bash
make test      # go (race) + C++ + python + web lint/typecheck
make sanitize  # C++ ASan/UBSan/LSan
make e2e       # real-process: ingestor + sggen brute_force → verified detection + incident
```

Actual results at time of writing (recorded during development, hardware:
2-vCPU cloud sandbox):

- **Go:** all 15 packages pass `go test ./... -race` (unit, API httptest, RBAC
  matrix, lifecycle matrix, rule table tests, pipeline concurrency, SSE, ML
  determinism, LLM adapter fakes) + PostgreSQL integration suite in CI.
- **C++:** 530 assertions, clean under AddressSanitizer + UBSan + LeakSan.
  Benchmark (honest, 2-vCPU sandbox): 416k fully-validated events/s vs 1.13M/s
  naive-scan baseline — the cost of strict validation, quantified.
- **Python:** 190 tests, identical results across 3 consecutive runs
  (determinism proof), byte-identical outputs across processes.
- **Console backend:** 121/121 endpoint checks across 5 full verification
  passes (all 10 simulator scenarios → expected detections/incidents).
- **CI:** parallel jobs per component + secret scanning + vulnerability checks
  + container builds + an E2E job that proves ingest → detect → incident
  against a real process.

See `docs/TESTING.md` and `docs/fa/TESTING_FA.md` (فارسی) for the multi-pass
test log narrative.

## Security

See `SECURITY.md` (threat model, reporting process). Highlights: server-side
RBAC everywhere, bcrypt + HMAC sessions, rate-limited authenticated ingestion,
strict input validation with recorded rejects, parameterized SQL only, secret
redaction in logs, prompt-injection-resistant AI, no secrets in the repo.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `STORE=memory` warning at startup | expected without `POSTGRES_DSN`; set the DSN for durable storage |
| `503 AI_DISABLED` on `/api/ai/investigate` | AI is off by design until enabled in settings (and provider configured) |
| `503` provider error from AI | check `LLM_BASE_URL`/model is running (`ollama list`); no cloud fallback by design |
| `429` on ingest | rate limit (60/min default) — wait or raise `RATE_LIMIT_PER_MIN` |
| Console shows no live updates (demo edition) | the socket.io relay must run: `cd mini-services/stream && bun run dev` |
| `INC` numbering after reset | incidents number sequentially from INC-000001 after a demo reset |
| Postgres migration lock wait | another instance is migrating; it resolves itself |

## Limitations (honest)

- In-memory Go store is non-durable; use PostgreSQL for persistence.
- ML evaluation numbers are from synthetic labeled scenarios, not production
  traffic; they demonstrate reproducibility and method tradeoffs.
- PostgreSQL integration tests require CI (or a local Postgres) — not run in
  the sandbox used for development.
- The native C++ parser is an optional build-tag integration in the Go service;
  the default parser is pure Go.
- Demo credentials are intentionally weak and labeled as such — the demo
  edition is for evaluation, not production.

## Contributing & releases

See `CONTRIBUTING.md` (development setup, verification expectations per
component, ground rules) and `CHANGELOG.md` (staged version history v1.x →
v10.4.0 with what genuinely changed at each step). Releases are automated via
`.github/workflows/release.yml`: a release publishes only if the full test
suite passes and the tag matches the CHANGELOG head.

## The console in motion

Captured from the real running application (demo edition, simulator data —
labeled `origin=synthetic` everywhere in the UI):

| | |
|---|---|
| **Live attack on the event wall** — a brute-force scenario streams in over socket.io, detections and incidents appear in real time | **Incident triage** — queue → triage → investigating → investigation note, lifecycle validated server-side |
| ![Live attack](docs/assets/demo-live-attack.gif) | ![Incident triage](docs/assets/demo-incident-triage.gif) |
| **AI-assisted investigation** — evidence-grounded report with facts vs hypotheses vs next steps | **Bilingual console** — English ⇆ فارسی with full RTL |
| ![AI investigation](docs/assets/demo-ai-investigation.gif) | ![Language toggle](docs/assets/demo-language-toggle.gif) |

Section screenshots: [operations overview](docs/assets/01-overview.png) ·
[live stream](docs/assets/02-live-stream.png) ·
[event explorer](docs/assets/03-event-explorer.png) ·
[detection rules](docs/assets/04-detection-rules.png) ·
[incident queue](docs/assets/05-incident-queue.png) ·
[incident investigation](docs/assets/06-incident-investigation.png) ·
[ML analytics](docs/assets/07-ml-analytics.png) ·
[AI assistant](docs/assets/08-ai-assistant.png) ·
[system health](docs/assets/09-system-health.png) ·
[ingestion sources](docs/assets/10-sources.png)

## Documentation

- English: this README, `ARCHITECTURE.md`, `SECURITY.md`, `CONTRIBUTING.md`,
  `CHANGELOG.md`, `docs/TESTING.md`, component READMEs (`services/ingestor`,
  `analytics`, `native/parser`, `web`).
- Persian (فارسی): complete set under `docs/fa/` —
  [README_FA.md](docs/fa/README_FA.md) و راهنماهای نصب، کاربری، معماری،
  شِما، API، قواعد تشخیص، پاسخ به رخداد، یادگیری ماشین، هوش مصنوعی محلی،
  امنیت، توسعه، تست و انتشار.

---

StreamGuard — Copyright © 2026 Parsa Fathi. Licensed under the Apache License,
Version 2.0. Third-party notices: `THIRD_PARTY_NOTICES.md`.
