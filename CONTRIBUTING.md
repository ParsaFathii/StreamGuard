# Contributing to StreamGuard

Copyright © 2026 Parsa Fathi. Contributions are licensed under Apache-2.0.

## How to contribute

1. Fork the repository and create a topic branch from `main`.
2. Make your change with tests.
3. Run the relevant verification suites (below).
4. Open a pull request using the PR template and describe the change honestly,
   including what you tested and what you did not.

## Ground rules

- **Honesty over green badges.** Never weaken an assertion to make a test pass,
  never claim a test ran when it did not, never fabricate benchmark or accuracy
  numbers. If something is untested, say so.
- **Contract stability.** The API/data contract (`CONTRACT` semantics documented
  in `ARCHITECTURE.md` and the service READMEs) is shared by the Go service, the
  Python analytics package and the web console. Breaking changes require a
  version bump and a CHANGELOG entry.
- **No secrets.** Never commit tokens, keys or private data. Logs must redact
  authorization headers, cookies and ingest keys.
- **Copyright header.** Every source file carries
  `Copyright © 2026 Parsa Fathi — Apache-2.0`.
- **Third-party code** keeps its own license notice and is recorded in
  `THIRD_PARTY_NOTICES.md`.

## Development environment

Requirements: Go 1.23+, Python 3.12+, a C++20 compiler (GCC 12+/Clang 16+),
Bun 1.1+ for the web console.

```bash
# Go reference service (in-memory store; set POSTGRES_DSN for PostgreSQL)
cd services/ingestor
go build ./...
go test ./... -race

# Deterministic event generator smoke
go run ./cmd/ingestor &            # :8080
go run ./cmd/sggen --scenario brute_force --url http://127.0.0.1:8080 --key sg-demo-ingest-key-2026

# C++ parser
cd native/parser
make all && make test && make sanitize

# Python analytics
cd analytics
python3 -m pytest tests/
python3 -m streamguard_analytics evaluate --dataset all

# Web console (demo edition, embedded engine)
cd web
bun install
bun run db:push && bun run seed
bun run dev
```

Docker Compose deployment: see `README.md` §Deployment.

## Verification expectations per component

| Component | Required before merging |
|---|---|
| `services/ingestor` | `go vet ./...`, `go test ./... -race`, manual endpoint check if API changed |
| `native/parser` | `make test`, `make sanitize` |
| `analytics` | `pytest tests/` (deterministic — identical results on re-run) |
| `web` | `bun run lint`, type check, manual browser pass for UI changes |

For performance-sensitive changes, include before/after measurements with the
methodology used.

## Reporting issues

Use the issue templates (bug report / feature request). Security issues follow
`SECURITY.md` — never public issues.

## Release process (maintainers)

Releases follow the staged versioning plan in `CHANGELOG.md`. Every release:
update version metadata, run full test suites, update CHANGELOG, tag, verify the
tag builds. CI must be green; a failed test blocks the release.
