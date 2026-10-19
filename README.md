# StreamGuard Ingestor Core

Copyright © 2026 Parsa Fathi — Apache-2.0

StreamGuard is a real-time event ingestion, processing, monitoring and
security analytics platform. This repository currently contains the **core
foundation** of the Go ingestion service:

- **Event model + strict validation** (`services/ingestor/internal/event`) —
  versioned schema (v1), enum checks, ISO 8601 UTC timestamps, bounded sizes,
  source-id pattern, future-skew limit. Rejections are represented explicitly,
  never silently dropped.
- **Storage** (`internal/store`) — a `Store` interface with a thread-safe
  in-memory implementation (tests, ephemeral runs) and a PostgreSQL
  implementation (parameterized SQL only, startup migrations under an
  advisory lock).
- **Configuration** (`internal/config`) — environment-driven config with
  validation and secret redaction.
- **Logging** (`internal/logging`) — structured JSON logging.

Status: unit tests green (`go test ./...` within `services/ingestor`).

Roadmap: detection rules and correlation, a bounded processing pipeline with
backpressure, incident management with a validated lifecycle, a complete HTTP
API with RBAC and live updates, a web console, Python analytics/ML, an
optional native parser, and full deployment tooling. See `CHANGELOG.md` (added
at release stabilization) for the version history.

## Build & test

```bash
cd services/ingestor
go build ./...
go test ./...
```

## License

Apache License 2.0 — see `LICENSE`. Copyright © 2026 Parsa Fathi.
