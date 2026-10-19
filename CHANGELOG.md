# Changelog

Copyright © 2026 Parsa Fathi — Apache-2.0

All notable changes to StreamGuard are documented here. Versions follow a
staged generation plan; every tag was buildable and its test suites green at
the time it was cut. Dates are UTC.

## [10.3.2] — 2026-10-19

Final maintenance release (generation 10 stabilization).

- Added `VERSION` file as the single version source; unified version strings
  across package metadata (`web/package.json`, analytics, service health).
- Final audit pass: license headers verified across all source files, broken
  link sweep in README/docs (EN + FA), secret scan of the tree before publish.
- Docs: corrected release-pipeline wording in `ARCHITECTURE.md` §11 and the
  Persian counterpart; README "Testing" section numbers synced with final runs.

## [10.3.1] — 2026-10-19

Maintenance release — packaging hygiene and build-context correctness.

- Added `.dockerignore` for the web console and service build contexts
  (smaller, faster, more reproducible container builds; no stray local
  databases in build context).
- Analytics sdist completeness: verified `pyproject.toml` includes README and
  package data; `python -m build --sdist` contents checked.
- Makefile: new `make dist` target (release artifacts + SHA256SUMS into
  `dist/`), used by the release workflow.

## [10.3.0] — 2026-10-19

Release stabilization: documentation, assets and packaging.

- Complete bilingual documentation set: English (README, ARCHITECTURE,
  SECURITY, CONTRIBUTING, THIRD_PARTY_NOTICES, component READMEs) and Persian
  (`docs/fa/` — 14 documents).
- Real screenshots (10) and animated demos (4 GIFs) captured from the running
  application into `docs/assets/` and referenced from both READMEs — live
  attack on the event wall, incident triage lifecycle, AI-assisted
  investigation, English⇆Persian console.
- Release automation validated: tag↔CHANGELOG consistency check, multi-platform
  Go binaries, C++ artifacts, Python sdist, SHA256SUMS, SPDX SBOM.

## [10.2.0] — 2026-10-19

Reliability, security and compatibility improvements.

- Session cookie hardening in the console edition: explicit `SameSite=Lax`
  and `Path` scoping on the session cookie.
- Go service: configurable LLM timeout (`LLM_TIMEOUT`, default 60s); provider
  errors surfaced unchanged.
- Console API client: 401 responses clear the cached session instead of
  retrying, so expired authentication degrades gracefully to the login view.
- Documented the demo-vs-Go `INVALID_TRANSITION` unification (both 400,
  matching the contract) found during the Persian documentation cross-review.

## [10.1.0] — 2026-10-19

Validated operational improvements from the multi-pass test cycles.

- `scripts/verify-release.sh`: one-command local pre-push verification running
  every suite the release workflow requires (Go race, C++ tests + sanitizers,
  Python tests + determinism diff, web lint + typecheck, VERSION↔CHANGELOG
  consistency).
- `docs/TESTING.md`: the testing log and methodology, including the nine real
  defects the suites caught (brute-force chronology, Isolation Forest leaf
  adjustment, correlation key semantics, C++ use-after-free and timestamp
  overflow, live-stream batch crash, UI polish, INVALID_TRANSITION divergence,
  backend endpoint gaps) — with fixes and honest non-claims.
- Makefile `e2e` hardening: health-check retry loop (up to 10s) before
  generating traffic, guaranteed cleanup trap on failure.

## [10.0.0] — 2026-10-19

Integrated platform baseline: all components together, full documentation.

- Monorepo complete: Go reference service, Python analytics, C++ parser, web
  console (demo + Go-backed modes), Docker Compose stack, CI/CD.
- CI (GitHub Actions) green across: Go (vet/build/race tests + PostgreSQL
  integration job), C++ (tests + ASan/UBSan/LSan), Python (tests with
  determinism check), web (lint + typecheck + build), security scanning,
  container builds, and a real-process E2E job (ingest → detection → incident).

## [9.0.0] — 2026-10-19

Integration maturity, compatibility improvements and operational tooling.

- Root `Makefile` (build/test/lint/sanitize/bench/e2e/demo/dist/clean).
- CI workflows (`ci.yml`, `release.yml`) and Dependabot configuration.
- Docker Compose stack (PostgreSQL + ingestor + analytics sidecar + console)
  and multi-stage Dockerfiles for all components.

## [8.0.0] — 2026-10-19

Native performance component and deployment quality.

- `native/parser`: portable C++20 strict event parser/validator, C ABI
  (`libsgcapi.so`), 530 assertions, clean under AddressSanitizer +
  UBSan + LeakSanitizer.
- Honest benchmark (2-vCPU sandbox): 416k fully-validated events/s vs 1.13M/s
  naive-scan baseline — the measured cost of strict validation, not a
  marketing number. Year range 1678..2261 enforced (nanosecond
  `time_point` representability — found by UBSan, fixed with boundary tests).

## [7.0.0] — 2026-10-19

Python analytics package with reproducible ML evaluation.

- `streamguard_analytics`: strict schemas, EWMA baselines (α=0.3, z>3),
  seeded Isolation Forest (100 trees, ψ=64, depth 8, threshold 0.61),
  9 scenario + 5 edge-case labeled datasets (seed 42), zero-division-safe
  evaluation (precision/recall/F1/FPR + confusion), Ollama-compatible LLM
  provider adapter (untrusted-data wrapping), HTTP sidecar + CLI.
- 190 tests, identical results across 3 consecutive runs and across separate
  processes (byte-identical JSON) — determinism proven, not claimed.
- Honest per-method results published in `analytics/README.md` §7 (including
  method blind spots: z-score onset-only detection, isolation-forest misses on
  wide-cloud noisy data).

## [6.0.0] — 2026-10-19

Complete web console — StreamGuard Console (demo edition).

- 14-section React/TypeScript single-page console (Next.js): Operations
  Overview, Event Explorer, Live Event Stream, Detection Rules, Detections,
  Incident Queue, Incident Investigation, Correlation Explorer, ML Analytics,
  AI Investigation Assistant, Ingestion Sources, System Health, Audit History,
  Settings.
- Full-stack embedded edition: Next.js API routes implementing the platform
  contract on SQLite/Prisma — auth/RBAC, authenticated rate-limited ingestion,
  validation, the 7 detection rules, correlation, incident lifecycle, ML
  (EWMA + Isolation Forest ports), metrics (Prometheus text), audit, retention
  (incident evidence protected), AI investigation via the configured provider.
- Live updates with dual transport: socket.io relay for the demo edition and
  SSE mode (`NEXT_PUBLIC_LIVE_TRANSPORT=sse`) for the Go reference service —
  identical channels (`event:new` batched, `detection:new`, `incident:*`,
  `stats`, `simulator`) and payload shapes; English + Persian (RTL) UI;
  dark-first original design; keyboard shortcuts; responsive (bottom tab bar
  on mobile); explicit loading/error/empty/stale/disconnected states.
- Backend verification: 121/121 endpoint checks across 5 full passes (fixes
  between passes: sources derived from real aggregates, retention response
  shape + always-audited runs, audit filter validation), all 10 simulator
  scenarios produce their expected detections and incidents.
- Strict TypeScript: `tsc --noEmit` clean from first landing (query-result
  access, Sheet side typing, unknown-count narrowing, i18n dictionary typing —
  translations typed as same-shape string maps, not English literals).

## [5.0.0] — 2026-10-19

Go service complete: full HTTP API, RBAC everywhere, live SSE.

- `internal/api`: every contract endpoint — auth (login/logout/session),
  ingest (sessions or `X-Ingest-Key`, rate-limited, idempotent), events
  (validated filters, pagination), rules (PATCH + audit), detections,
  incidents (validated lifecycle, notes, events), analytics (overview,
  timeseries, ml, evaluate), AI investigate (evidence-grounded, honest 503s),
  simulator, sources, health, metrics, audit, settings, retention-run.
- `GET /api/stream`: SSE hub (per-client buffers, drop-slowest, keepalive,
  Last-Event-ID replay) emitting the same channels/payloads as the console
  relay.
- `cmd/ingestor` (graceful shutdown, drain ≤10s) and `cmd/sggen`
  (deterministic generator CLI).
- Engine bugs found and fixed during API integration testing (kept in the
  record honestly): brute-force scenario emitted the successful login as the
  oldest event so SG-RULE-003 legitimately never fired (generator chronology
  fixed); Isolation Forest missed the standard Liu et al. `c(size)` leaf
  adjustment, marking near-duplicate feature rows anomalous (331 false
  positives on the labeled dataset — fixed); sequence-rule correlation key
  was global instead of per-actor (fixed).
- Full suite green under `-race` (unit, API httptest with RBAC matrix,
  lifecycle matrix, rule table tests, SSE, ML determinism, LLM fakes).

## [4.0.0] — 2026-10-19

Incident management, audit trail, authentication and the LLM adapter.

- Incident lifecycle state machine with exhaustively validated transitions,
  resolution summaries, status history.
- Append-only audit log (login/logout, rule changes, incident updates/notes,
  AI investigations, simulator runs, settings, retention).
- Auth: bcrypt users, HMAC-signed opaque sessions, ingest keys, per-key/user
  sliding-window rate limits; RBAC helpers (ADMIN/ANALYST/VIEWER).
- LLM provider adapter (Ollama-compatible): strict evidence grounding, facts
  vs hypotheses, untrusted-data wrapping of event text, JSON validation,
  honest timeouts — advisory only, never state-changing.

## [3.0.0] — 2026-10-19

Detection rules, correlation engine and the deterministic generator.

- The 7 seeded rules (SG-RULE-001..007) with count/ratio/sequence/exists
  conditions, sliding windows, cooldown and suppression.
- Correlation: open-incident attach vs new `INC-00000N`, late-event flagging.
- Deterministic seeded event generator (10 scenarios) + labeled ML dataset.

## [2.0.0] — 2026-10-19

Processing pipeline, bounded queues, idempotency, metrics.

- Bounded queue (1024) + worker pool (2..16) with backpressure (429 +
  Retry-After when full), context cancellation, graceful drain.
- Idempotent processing (skip already-processed events), latency measurement,
  Prometheus-format metrics with documented names/units.
- SSE hub foundations (per-client buffered channels, drop-slowest policy).

## [1.0.0] — 2026-10-19

Core event model, validation and storage.

- Versioned event schema (v1) with strict validation: enums, ISO 8601 UTC
  timestamps, bounded sizes (4 KB event / 100 batch), source-id pattern,
  future-skew limit; rejects recorded, never silently dropped.
- Store interface with thread-safe in-memory implementation and PostgreSQL
  implementation (parameterized SQL only, startup migrations under an
  advisory lock).
- Environment configuration with validation and secret redaction; structured
  JSON logging.
