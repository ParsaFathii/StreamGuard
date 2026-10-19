# StreamGuard — Testing Log & Methodology

Copyright © 2026 Parsa Fathi — Apache-2.0

This document records how StreamGuard was actually tested during development:
the cycles run, the results, and — most importantly — the real defects the
tests caught and how they were fixed. Nothing here is aspirational; every
number was produced by a command that ran. Persian companion:
[`docs/fa/TESTING_FA.md`](fa/TESTING_FA.md).

## Methodology

Each subsystem followed the same loop, repeated until stable (typically 2–5
passes; the demo backend ran 5 full passes, the browser verification multiple
tours):

```
IMPLEMENT → BUILD → TEST → RUN → INSPECT LOGS → FIND DEFECTS
        → IMPROVE → TEST AGAIN → REGRESSION TEST
```

Independent suites ran in parallel where isolation allowed (Go / C++ / Python
/ web lint-typecheck); resource-sensitive sanitizer and benchmark runs ran
serialized. Hardware for all local numbers: 2-vCPU x86-64 cloud sandbox,
Go 1.23.4, GCC 14.2, Python 3.12.15, Bun 1.3.14.

## Results summary

| Suite | Command | Result |
|---|---|---|
| Go (all 15 packages) | `go test ./... -race -count=1` | **all pass** under the race detector |
| Go regression | `go test ./... -count=2` | pass |
| Go + PostgreSQL | `go test -tags integration ./internal/store/...` (CI service container) | CI job `go-postgres` |
| C++ parser | `make test` | **530 assertions, 0 failed** (×3 stability runs) |
| C++ sanitizers | `make sanitize` | clean under ASan + UBSan + LeakSanitizer |
| Python analytics | `pytest tests/ -q` | **190 passed**, ×3 runs with identical output (determinism proof); byte-identical JSON across processes |
| Console backend | full-endpoint curl harness | **121/121 checks**, 5 full passes |
| Console UI | browser verification (real gateway path) | 14/14 sections, zero console errors; mobile 390×844; EN/FA; sticky footer verified programmatically |
| Real-process E2E | `make e2e` | ingestor + `sggen --scenario brute_force` → SG-RULE-001 detection + incidents verified through the real HTTP path; SSE stream captured live; graceful shutdown logs verified |

## Real defects found by the tests (and fixed)

This is the honest part — every test suite earned its keep:

1. **Brute-force scenario chronology (Go, product bug).** The E2E test
   expected an SG-RULE-003 (failures-then-success sequence) detection; none
   appeared. Root cause: the generator emitted the successful login as the
   *oldest* event, so chronologically the success preceded the failures and
   the sequence rule legitimately never fired. Fixed the generator (failures
   older, success newest) in both `brute_force` and `mixed_attack`.
2. **Isolation Forest leaf adjustment (Go, ML bug).** The labeled evaluation
   reported precision 0.018 with **331 false positives**: the implementation
   returned just the depth at multi-point leaves, missing the standard Liu et
   al. `c(size)` adjustment. With mostly-constant features (4 of 5), normal
   near-duplicate rows got artificially short paths and everything looked
   anomalous. Fixed with the standard formulation; the labeled dataset now
   evaluates cleanly.
3. **Sequence-rule correlation key (Go, semantics bug).** Correlation grouped
   sequence-rule events globally instead of per-actor, producing incident
   titles like "Suspicious Auth Sequence — global". Fixed to correlate by
   actor, matching the rule's documented semantics.
4. **C++ use-after-free (test bug, caught by ASan).** `parse_event(e.str())`
   bound result views to a temporary `std::string` destroyed at the end of the
   statement. Fixed with named locals; the library's documented ownership
   contract was correct.
5. **C++ timestamp overflow (product bug, caught by UBSan).** Year-0000
   timestamps overflowed `system_clock::time_point` arithmetic at nanosecond
   resolution (signed 64-bit). The parser now enforces the representable
   range 1678..2261 with boundary tests (1677/2262/9999 rejected, 1678/2261
   accepted).
6. **Console live-stream batch crash (product bug, caught by browser
   verification).** The event wall treated each `event:new` message as a
   single event while the backend emits batches (`{events:[…], count, ts}`) —
   running a scenario while the wall was open produced a React error overlay.
   Fixed with payload normalization handling both shapes.
7. **Console UI polish (caught by VLM-assisted review, fixed and re-verified):**
   truncated user chip, inconsistent KPI secondary-metric alignment,
   non-color-coded severity counts, mixed health-chip styles, cramped sidebar
   footer, cluttered chart axes. Post-fix review: 9/10, all checkpoints pass.
8. **`INVALID_TRANSITION` status divergence (found by the Persian docs
   cross-review).** The Go service returned 409 for same-status transitions
   while the demo backend returned 400. Unified to 400 per the contract, with
   the test updated.
9. **Console backend gaps (found between verification passes):** `/api/sources`
   fell back to registry data instead of deriving from real aggregates;
   retention-run responses missed the `deletedCount` field the UI reads and
   skipped audit on zero-deletion runs; `/api/audit` accepted arbitrary filter
   values silently returning empty lists. All fixed and re-verified.

## What is deliberately NOT claimed

- No production-traffic ML accuracy — evaluation numbers are from synthetic
  labeled scenarios and are labeled as such everywhere they appear.
- PostgreSQL integration is exercised in CI, not in the original development
  sandbox (no docker there) — stated in the README limitations.
- The in-memory Go store is non-durable by design and documented.
- CI workflows are written to be runnable and standard; their green status is
  expected from the green local equivalents, and any CI failure on GitHub
  would be fixed as a maintenance release rather than hidden.

## Reproducing

```bash
make test        # go (race) + C++ + python + web lint/typecheck
make sanitize    # C++ ASan/UBSan/LSan
make e2e         # real-process end-to-end
./scripts/verify-release.sh   # everything the release workflow requires
```
