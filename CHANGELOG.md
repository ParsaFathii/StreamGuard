# Changelog

Copyright © 2026 Parsa Fathi — Apache-2.0

All notable changes to StreamGuard are documented here. Versions follow a
staged generation plan; every tag was buildable and its test suites green at
the time it was cut. Dates are UTC.

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

