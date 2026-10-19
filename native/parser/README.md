# StreamGuard Native Parser (C++20)

Copyright © 2026 Parsa Fathi — Apache-2.0

A portable, dependency-free C++20 library for the performance-sensitive first
stage of StreamGuard's ingestion path: strict parsing and validation of event
JSON payloads against the StreamGuard event schema (schema version 1).

## Responsibility

`sg::parser::parse_event` takes one event payload as a `std::string_view` and
performs, in a single pass with no heap allocations:

- RFC 8259 JSON tokenization (subset: objects, arrays, strings with escapes
  including `\uXXXX` surrogate pairs, numbers, `true`/`false`/`null`)
- strict schema validation: required fields, `schema_version == 1`, enum checks
  (`source_type`, `severity`, `category`), `source_id` pattern
  `^[a-zA-Z0-9._-]{1,64}$`, message length 1..512 (UTF-8 code points),
  attributes payload ≤ 4 KB, unknown top-level fields rejected, duplicate keys
  rejected
- ISO 8601 UTC timestamp parsing (`YYYY-MM-DDTHH:MM:SS(.mmm)?Z`, no offsets)
  with calendar validation (leap years, month/day ranges) and a representable
  range check (see below)
- full UTF-8 validation of the input (well-formed sequences; rejects overlong
  encodings, lone surrogates, truncated sequences)

It does **not** do rule evaluation, storage or network I/O — those belong to
the Go service.

## Contracts

**Input:** one JSON object, ≤ 4096 bytes (`kMaxInputBytes`), UTF-8. Inputs
larger than the cap are rejected with `OversizedInput` *before* any scanning.

**Output:** `ParseResult { status, event, error }`. On `Ok`, `event` holds
zero-copy `string_view`s into the input (documented ownership: views are valid
only while the input buffer lives; call `EventRecord::to_owned()` for a
self-contained copy with decoded strings). `event_time` is a
`std::chrono::system_clock::time_point` (UTC).

**Error representation:** `ParseStatus` (`Ok`, `InvalidJson`, `SchemaViolation`,
`OversizedInput`, `InvalidTimestamp`, `InvalidEnum`, `MissingField`,
`EncodingError`) plus `ErrorInfo { status, byte_offset, message ≤ 128 chars,
field }`.

**Timestamp range:** `system_clock::time_point` on common platforms stores
nanoseconds in a signed 64-bit integer, so only ~1677-09-21..2262-04-11 is
representable. The parser accepts years **1678..2261** and rejects anything
outside that window with `InvalidTimestamp` (instead of invoking signed
overflow UB — this was found by UBSan during development and fixed).

**Memory ownership:** no raw owning pointers; RAII only; `parse_event` is
`noexcept`; internal scratch is stack-fixed. The C ABI wrapper
(`sg_parse`/`sg_free`) returns a heap result the caller frees with `sg_free` —
valgrind/ASan clean.

**Thread safety:** pure functions, no global or shared mutable state — safe to
call concurrently from any number of threads on any inputs.

## Build & test

Requires a C++20 compiler (GCC 12+ / Clang 16+; developed against GCC 14.2).

```bash
make all        # static lib + C ABI shared lib
make test       # 530 assertions
make sanitize   # same suite under AddressSanitizer + UndefinedBehaviorSanitizer + LeakSanitizer
make bench      # deterministic corpus benchmark
```

## Benchmark (honest numbers)

Corpus: 12,000 events (10,000 valid / 2,000 invalid), 219..4,296 bytes, mean
2,218 bytes, generated from a fixed seed. 5 runs, median + p95 reported.
Hardware: 2 vCPU cloud sandbox (x86-64), GCC 14.2, `-O2`.

| Mode | Throughput | Median | p95 |
|---|---|---|---|
| Full parse + strict validation | 416,218 events/s | 2,364 ns | 4,025 ns |
| Baseline (naive field scan, no validation) | 1,125,061 events/s | 876 ns | 1,015 ns |

Interpretation: the fully validating parser runs at ~416k events/s/core; the
"baseline" is a naive substring field extractor that does none of the schema,
calendar, UTF-8 or size checks. The comparison quantifies the cost of strict
validation, not a claim that the baseline is a usable parser. Run `make bench`
yourself to reproduce; numbers vary by hardware.

## Integration path with the Go service

The C ABI (`include/streamguard/capi.h`, `libsgcapi.so`) is the stable
integration surface. The Go ingestion service keeps a pure-Go fallback parser
as its default; linking the native parser is an optional, benchmark-justified
optimization behind a build tag (see `services/ingestor` README). The library
is also usable standalone from any C-compatible language.

## Test coverage summary

520 → **530 assertions** across: valid minimal/full events, pretty-printed and
reordered JSON, escaped enums/messages (incl. `\uXXXX`), Persian/CJK/emoji
UTF-8, invalid UTF-8 (overlong, lone surrogate, truncated), malformed JSON
variants, missing each required field, every invalid enum, timestamp matrix
(leap days, month/day/hour boundaries, offsets rejected, non-representable
years rejected, boundary years 1678/2261 accepted), size boundaries (512-char
messages, 4 KB attributes, 4096-byte inputs), duplicate keys, unknown fields,
oversized-input fast rejection, ownership (`to_owned()` survives input
destruction), and a threaded smoke (8 threads × mixed valid/invalid).
