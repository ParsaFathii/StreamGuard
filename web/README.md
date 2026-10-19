# StreamGuard Console (web)

Copyright © 2026 Parsa Fathi — Apache-2.0

The React/TypeScript single-page console for StreamGuard: 14 sections
(Operations Overview, Event Explorer, Live Stream, Detection Rules,
Detections, Incident Queue, Incident Investigation, Correlation, ML Analytics,
AI Assistant, Sources, System Health, Audit History, Settings), full English +
Persian (RTL) UI, dark-first design, keyboard-friendly, responsive.

Built with Next.js (App Router), Tailwind CSS, shadcn/ui patterns, TanStack
Query, Zustand, recharts, socket.io (demo transport).

## Two run modes

### 1. Console demo edition (default) — fully self-contained

The console ships with an **embedded engine** (Next.js API routes + SQLite via
Prisma) implementing the full platform contract: authentication/RBAC,
ingestion, validation, the 7 detection rules, correlation, incident lifecycle,
ML (EWMA + Isolation Forest), metrics, audit, retention, and the AI
investigation endpoint (uses the environment's configured AI provider).

```bash
bun install
bun run db:push        # create SQLite schema
bun run seed           # demo users, rules, ~4-5h of engine-generated history
bun run dev            # http://localhost:3000

# live stream relay (socket.io):
cd mini-services/stream && bun run dev
```

Demo users: `admin/admin123` (ADMIN), `analyst/analyst123` (ANALYST),
`viewer/viewer123` (VIEWER). Demo ingest key: `sg-demo-ingest-key-2026`.
All simulator data is labeled `origin=synthetic` in every view.

### 2. Go-backed mode (reference deployment)

Point the same UI at the Go service (SSE live transport):

```bash
NEXT_PUBLIC_API_BASE=http://localhost:8080 \
NEXT_PUBLIC_LIVE_TRANSPORT=sse \
bun run dev
```

See the root `docker-compose.yml` for the full stack (PostgreSQL + Go +
analytics sidecar + this console in Go-backed mode).

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | `file:./db/console.db` | SQLite path (embedded edition) |
| `NEXT_PUBLIC_API_BASE` | *(empty)* | Go service base URL (Go-backed mode) |
| `NEXT_PUBLIC_LIVE_TRANSPORT` | `socketio` | `socketio` (demo) or `sse` (Go) |
| `STREAM_BIND` *(relay)* | `127.0.0.1` | Bind address for `mini-services/stream`; set `0.0.0.0` for containers/remote demos |

## Scripts

- `bun run dev` — development server (:3000)
- `bun run lint` — ESLint
- `bun run db:push` / `bun run db:generate` — Prisma schema/client
- `bun run seed` — seed demo users, rules, settings and generated history
- `bun run build` / `bun run start` — production build/run

## Live transport details

- Demo edition: `io("/?XTransformPort=3003")` — the relay service
  (`mini-services/stream`) receives server-side POSTs on `/emit` and fans out
  to browsers. The relay binds loopback only by default (internal service);
  `STREAM_BIND=0.0.0.0` makes it reachable from other hosts/containers.
- Go-backed mode: `EventSource(`${API_BASE}/api/stream`)` — SSE events named
  after the channels (`event:new`, `detection:new`, `incident:new`,
  `incident:update`, `stats`, `simulator`) with identical payload shapes.
- `event:new` payloads are batches: `{events: [...], count, ts}`.

## Note on credentials

The seeded users and ingest key are demo-grade by design (labeled as such in
the UI and docs). The console demo edition is for evaluation and training.
For production deployments use the Go reference service with your own
credentials and secrets.
