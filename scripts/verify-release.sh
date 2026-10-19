#!/usr/bin/env bash
# Copyright © 2026 Parsa Fathi — Apache-2.0
# Local pre-push verification: run every component suite the release workflow
# requires. Exits non-zero on the first failure. Usage: ./scripts/verify-release.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/gotoolchain/bin:$PATH"

fail() { echo "VERIFY FAIL: $1" >&2; exit 1; }

echo "==> Go: vet + build + race tests"
( cd services/ingestor && go vet ./... && go build ./... && go test ./... -race -count=1 ) || fail "Go suite"

echo "==> C++: build + tests + sanitizers"
( cd native/parser && make all && make test && make sanitize ) || fail "C++ suite"

echo "==> Python: tests + determinism check"
# Strip wall-clock durations before comparing — determinism is about results.
strip_dur() { sed -E 's/ in [0-9]+\.[0-9]+s$//; s/^[0-9]+\.[0-9]+s//' "$1"; }
( cd analytics && \
  python3 -m pytest tests/ -q > /tmp/sg-py1.txt && tail -1 /tmp/sg-py1.txt && \
  python3 -m pytest tests/ -q > /tmp/sg-py2.txt && \
  diff <(strip_dur /tmp/sg-py1.txt) <(strip_dur /tmp/sg-py2.txt) ) || fail "Python suite"
echo "    deterministic: identical results across runs (durations stripped)"

echo "==> Web: lint + typecheck"
( cd web && bun run lint && bunx tsc --noEmit ) || fail "Web suite"

echo "==> CHANGELOG head matches VERSION"
[ -f VERSION ] || fail "VERSION file missing"
V="$(cat VERSION)"
HEAD="$(grep -m1 '^## ' CHANGELOG.md | sed 's/^## \[\(.*\)\].*/\1/')"
[ "$V" = "$HEAD" ] || fail "VERSION ($V) != CHANGELOG head ($HEAD)"

echo "VERIFY OK — all suites green at v$V"
