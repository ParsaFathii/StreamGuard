# Changelog

Copyright © 2026 Parsa Fathi — Apache-2.0

All notable changes to StreamGuard are documented here. Versions follow a
staged generation plan; every tag was buildable and its test suites green at
the time it was cut. Dates are UTC.

## [10.4.0] — 2026-10-19

Console quality pass + operations features. Two change sets: the three-role
expert review fixes (web console race/contract/UX, previously landed on main
as `fix(web)`) and a beyond-spec operations hardening pass, both verified by
a 10x API regression (24+10 checks x 10 = 340/340, zero flakes), 4-way
concurrent race stress and full EN/FA/mobile E2E.

Review fixes (web console):

- Rule-engine TOCTOU: cooldown check + detection insert are now one atomic
  section per engine (global promise-chain lock, `engine/lock.ts`); ingest
  idempotency races surface as per-row duplicates instead of P2002 500s.
- `GET /api/incidents?sort=severity`: 500 (Prisma 6 rejects multi-key orderBy
  objects) and lexical severity order both fixed — array-form orderBy and
  rank order (critical>high>medium>low>info) everywhere, including exports.
- `/api/metrics` now requires a session (VIEWER+). Retention sweeps purge
  orphaned Detection rows, recompute incident counters from surviving rows,
  clean ValidationFailure + expired sessions, and scan the protected set
  exhaustively (no take-cap). Strict ISO-8601 `event_time` (ms + Z|±hh:mm).
  Uniform 500 shape via an apiRoute wrapper; scaffold `/api/route.ts` deleted.
- Schema indexes (ValidationFailure ts; Incident createdAt + rule/correlation;
  Event traceId + actor/eventTime + source/eventTime; Detection
  rule/status/createdAt), WAL, redundant IngestKey index dropped.
- UX/RTL/a11y: incident cards and mobile event cards rebuilt (44px targets,
  full messages); FA charts mirrored with named dual axes; untranslated
  chips localized; AA contrast fixes; JSON viewer wraps; focus restoration
  on dialog close; overview lists no longer clip.

New operations features (console edition):

- **Evidence export** on every list endpoint: `format=csv|json` + `limit`
  (1..5000, default 2000) → file download (RFC 4180 CSV with UTF-8 BOM,
  CRLF, quote-doubling; JSON envelope) in the endpoint's filter/sort order;
  every export is audited (`export` action) so evidence leaving the system
  is traceable. UI: Export dropdown in Events, Detections, Incident Queue and
  Audit (hidden in Go-backed mode).
- **SQLite backups**: daily automatic snapshots via `VACUUM INTO`
  (consistent under WAL), rotation keeps the newest 7 in `db/backups/`,
  state persisted in Setting key `backup` (restart/HMR-safe), triggered by
  ingest + the stats loop; ADMIN `GET/POST /api/system/backups` + a Settings
  panel (list, schedule state, create-now) with a documented manual restore
  procedure. Audited (`backup.auto` / `backup.create`).
- **Printable reports**: dedicated print window for incident case files
  (summary, status history, notes, up to 100 linked events with an honest
  "showing a of b", detections, AI block when present) and AI investigation
  reports — header with prepared-by/generated-at, confidentiality footer.
- **Live relative time**: shared 30 s ticker (one interval for any number of
  rows) + weeks/months/years granularity, EN + FA.
- **Brand/PWA**: real icon set (16/32/192/512 + maskable + apple-touch,
  generated from the console mark), `manifest.webmanifest`, deterministic
  1200x630 OG/Twitter card, replacing the data-URI favicon.
- **Hardening**: security headers (nosniff, DENY, strict-origin referrer,
  permissions-policy, HSTS), `typescript.ignoreBuildErrors: false` (tsc is
  clean; CI keeps a dedicated typecheck job), dev indicator disabled (it
  covered the FA mobile "More" tab-bar button under `next dev`).
- Audit actions extended: `export`, `backup.create`, `backup.auto`;
  `CONTRACT.md` (the console API contract) is now part of the repository
  under `web/`, documenting exports, backups and the audit action set.

Version strings unified across VERSION, CHANGELOG head, web + stream package
metadata, `API_VERSION` (+ app-shell fallbacks), Go `Version`/`VersionDefault`
(+ api_test assertions), analytics `__version__`/pyproject/README, and the
latest-state references in README/ARCHITECTURE/FA release docs.

## [10.3.2] — 2026-10-19

Final maintenance release — release audit fixes and version unification.

- `web/package.json` metadata restored to the product identity
  (`streamguard-console` v10.3.2, Apache-2.0, description) — a re-sync had
  reverted it to the Next.js scaffold defaults; caught by the final
  repository audit.
- VERSION file bumped to 10.3.2; version strings verified consistent across
  VERSION, CHANGELOG head, web package metadata, analytics package
  (`__version__`/pyproject) and both `/api/health` implementations.
- Final audit pass completed: copyright headers verified across all Go/C++/
  Python/TypeScript sources; relative links in all Markdown (EN + FA) resolve;
  no secrets or credentials in the tree (demo credentials are labeled as such);
  `.gitignore`/`.dockerignore` cover build outputs, local databases and env
  files.
- Fixed a real TOCTOU race in the rule engine found by CI (flaky
  `TestDuplicateProcessingIsIdempotent`): the cooldown check and detection
  insert are now one atomic section per engine (6/6 stress runs green under
  `-race`; full suite green).
- CI determinism check now strips wall-clock durations before comparing pytest
  runs (timing noise, not results, was failing the diff).
- `.gitleaks.toml`: allowlist for the intentional, documented demo credentials
  and test-fixture strings; real secret patterns still fail the scan.
- PostgreSQL store bugs found by the CI integration job (invisible to the
  memstore unit tests): `QueryEvents` emitted `LIMIT` inside the `WHERE`
  clause (invalid SQL) and `IncidentEvents` used unqualified columns in its
  join (ambiguous `event_id`) — both fixed and covered by the integration
  suite in CI.
- Security toolchain hardening: Go 1.26.9 (stdlib net/http GO-2026-6617),
  pgx v5.11.0, x/text v0.43.0, x/crypto v0.58.0 — `govulncheck ./...` now
  exits clean. Web container image pinned to bun 1.3 (bun 1.1 cannot parse
  the Next 16 Turbopack runtime chunk; the same build is green under 1.3).

## [10.3.1] — 2026-10-19

Maintenance release — packaging hygiene and build-context correctness.

- Root `.dockerignore` (all three images build from the repo root context):
  excludes VCS, CI config, node_modules, build outputs, local databases, logs
  and env files — smaller, faster, more reproducible container builds with no
  stray local state.
- Makefile `make dist` target: multi-platform Go binaries (linux/darwin ×
  amd64/arm64), native parser artifacts, Python sdist and a SHA256SUMS file in
  `dist/` — the same artifact set the release workflow publishes.
- Verified the analytics sdist carries README and pyproject metadata
  (`streamguard_analytics-10.3.2.tar.gz` contents checked).

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

