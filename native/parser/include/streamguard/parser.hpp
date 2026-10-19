// Copyright © 2026 Parsa Fathi — Apache-2.0
// SPDX-License-Identifier: Apache-2.0
//
// StreamGuard native event parser — public C++ API (C++20).
//
// Parses and strictly validates ONE StreamGuard event (CONTRACT.md §Event Schema,
// schema_version 1). Input is a JSON document of at most kMaxInputBytes bytes.
//
// OWNERSHIP: every `std::string_view` member of EventRecord points INTO the buffer
// passed to parse_event() and stays valid only while that buffer is alive. Call
// EventRecord::to_owned() to obtain a self-contained, fully decoded copy
// (allocates; may throw std::bad_alloc).
//
// STRING ESCAPES: field views hold the raw JSON string body (text between the
// quotes). If a view contains a backslash it still carries escape sequences;
// decode it with unescape_json_string(). The parser itself always validates the
// DECODED value (an escaped spelling of an enum value, e.g. "\u0061pp", is valid).
//
// THREAD-SAFETY: parse_event() and all free functions are pure (no global mutable
// state) and safe to call concurrently from any number of threads on any inputs.
//
// EXCEPTIONS: parse_event() is noexcept — failures are reported via
// ParseResult::error (status + byte offset + bounded human message).

#ifndef STREAMGUARD_PARSER_HPP
#define STREAMGUARD_PARSER_HPP

#include <array>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace sg::parser {

// ---- Limits (enforced; see README for the full contract mapping) ----
inline constexpr std::size_t kMaxInputBytes = 4096;        // whole payload, checked before any scanning
inline constexpr std::size_t kMaxMessageChars = 512;       // Unicode code points, after normalization
inline constexpr std::size_t kMaxSourceIdBytes = 64;       // decoded bytes, charset [A-Za-z0-9._-]
inline constexpr std::size_t kMaxOptionalIdBytes = 128;    // decoded bytes, correlation/trace/actor
inline constexpr std::size_t kMaxAttributeEntries = 128;   // inline (non-allocating) attribute index
inline constexpr int kMaxJsonNestingDepth = 128;           // defensive limit, incl. inside attributes
inline constexpr std::size_t kErrorFieldBytes = 48;        // max bytes stored of an offending field name

enum class ParseStatus : std::uint8_t {
    Ok,
    InvalidJson,      // malformed JSON (RFC 8259 subset) or trailing garbage
    SchemaViolation,  // right JSON, wrong shape/value for the event schema
    OversizedInput,   // input longer than kMaxInputBytes (checked before scanning)
    InvalidTimestamp, // event_time not matching the strict UTC format
    InvalidEnum,      // source_type / severity / category / origin not in its enum
    MissingField,     // required field absent
    EncodingError,    // input is not well-formed UTF-8 (Unicode 15)
};

enum class JsonValueType : std::uint8_t {
    String, Number, Bool, Null, Object, Array,
};

// Error detail. `message` is NUL-terminated, at most 127 chars, control characters
// sanitized to '?'. `field` holds the decoded field name when applicable.
struct ErrorInfo {
    ParseStatus status = ParseStatus::Ok;
    std::size_t byte_offset = 0;   // JSON/encoding errors: exact byte; schema errors: start of the offending value; missing fields: 0
    char message[128] = {};
    char field[kErrorFieldBytes] = {};
};

// One indexed attribute (shallow map entry; views into the input).
// key:   raw JSON key text without quotes (may contain escapes if it has a '\\').
// value: raw value text; for JsonValueType::String this EXCLUDES the surrounding
//        quotes (escapes intact); for other types it is the full literal source text.
struct AttributeEntry {
    std::string_view key;
    std::string_view value;
    JsonValueType type = JsonValueType::Null;
};

// Bounded, allocation-free index of the top-level keys of the attributes object.
// If the object has more than kMaxAttributeEntries keys, only the first
// kMaxAttributeEntries are indexed and `truncated` is set; attributes_raw always
// holds the complete object and scan_attribute() searches it completely.
struct AttributeMap {
    std::array<AttributeEntry, kMaxAttributeEntries> entries = {};
    std::size_t count = 0;
    bool truncated = false;
};

// Validated event. All string members are views into the parse input (raw JSON
// string bodies — see "STRING ESCAPES" above). Valid only for status == Ok.
struct EventRecord {
    std::string_view event_id;    // non-empty (no format constraint; see README)
    std::int32_t schema_version = 0;  // validated == 1
    std::chrono::system_clock::time_point event_time{};  // UTC
    std::string_view source_id;
    std::string_view source_type;   // one of app|infra|system|security|synthetic
    std::string_view severity;      // one of info|low|medium|high|critical
    std::string_view category;      // one of auth|network|application|data|system|config|security
    std::string_view message;       // as transmitted; the NORMALIZED form is validated
    std::size_t message_chars = 0;  // code points of the normalized message (1..512)
    std::string_view attributes_raw;  // exact source span of the attributes object
    AttributeMap attributes;
    bool has_attributes = false;

    bool has_correlation_id = false;
    std::string_view correlation_id;
    bool has_trace_id = false;
    std::string_view trace_id;
    bool has_actor = false;
    std::string_view actor;
    bool has_origin = false;          // origin is system-set per contract: absence is valid,
    std::string_view origin;          // but a present value must be synthetic|external

    std::int64_t event_time_unix_ms() const noexcept;  // ms since Unix epoch (UTC)

    // Fast path: searches the inline map only (first kMaxAttributeEntries keys).
    // Returns nullptr when absent from the index — if attributes.truncated is set,
    // use scan_attribute() for a complete search.
    const AttributeEntry* find_attribute(std::string_view key) const noexcept;

    // Complete search: inline map, then (if truncated) a bounded re-scan of
    // attributes_raw. Copies the found entry into `out`.
    bool scan_attribute(std::string_view key, AttributeEntry& out) const noexcept;

    // Self-contained, fully decoded copy (allocates; may throw std::bad_alloc).
    // The attribute map in the copy is COMPLETE (no 128-entry cap).
    struct OwnedEventRecord to_owned() const;
};

struct OwnedAttributeEntry {
    std::string key;    // decoded
    std::string value;  // decoded for strings, raw source text otherwise
    JsonValueType type = JsonValueType::Null;
};

// Self-contained event record — no views into the parse input.
struct OwnedEventRecord {
    std::string event_id;
    std::int32_t schema_version = 0;
    std::chrono::system_clock::time_point event_time{};
    std::string source_id;
    std::string source_type;
    std::string severity;
    std::string category;
    std::string message;            // decoded, as transmitted
    std::string message_normalized; // decoded + normalize_message applied
    std::string attributes_raw;     // exact source span (raw JSON)
    bool has_attributes = false;
    std::vector<OwnedAttributeEntry> attributes;  // complete top-level index

    bool has_correlation_id = false;
    std::string correlation_id;
    bool has_trace_id = false;
    std::string trace_id;
    bool has_actor = false;
    std::string actor;
    bool has_origin = false;
    std::string origin;

    std::int64_t event_time_unix_ms() const noexcept;
    const OwnedAttributeEntry* find_attribute(std::string_view key) const noexcept;  // linear, complete
};

struct ParseResult {
    ParseStatus status = ParseStatus::Ok;
    EventRecord event;   // meaningful only when status == Ok
    ErrorInfo error;     // meaningful only when status != Ok
};

// Parse + strictly validate one event. Pure, thread-safe, noexcept.
// Order of checks: input size -> whole-input UTF-8 -> single-pass JSON scan with
// per-field schema validation (first error wins, reported left-to-right) ->
// required-field presence (canonical contract order). See README for the exact
// status mapping of every rule.
ParseResult parse_event(std::string_view input) noexcept;

// Trim leading/trailing whitespace and collapse internal runs of ASCII whitespace
// (space, \t, \n, \r, \v, \f) to a single space. If no collapsing is needed,
// returns a subview of `raw` (zero copy). Otherwise writes into `buf` (capacity
// `buf_cap`; raw.size() bytes always suffice) and returns a view into `buf`.
// If collapsing is needed but buf is too small, degrades to the trimmed,
// uncollapsed view of `raw` (documented best-effort; never fails).
std::string_view normalize_message(std::string_view raw, char* buf, std::size_t buf_cap) noexcept;

// Decode a raw JSON string body (text between quotes; escapes must be well-formed
// or the function returns false). Decoded output is valid UTF-8 and always fits in
// raw.size() bytes. Returns false (out_len untouched) on invalid escapes or if
// buf_cap is too small.
bool unescape_json_string(std::string_view raw, char* buf, std::size_t buf_cap,
                          std::size_t& out_len) noexcept;

// Number of Unicode code points in a well-formed UTF-8 view (counts non-continuation
// bytes; on malformed input this is an upper bound of the intended count).
std::size_t count_utf8_chars(std::string_view s) noexcept;

// Well-formed UTF-8 validation (Unicode 15: rejects overlongs, surrogates
// U+D800..U+DFFF, code points > U+10FFFF, truncated sequences, stray bytes).
// Returns true when valid; otherwise false and *error_offset is the byte index.
bool is_valid_utf8(std::string_view s, std::size_t& error_offset) noexcept;

// Stable, human-readable name of a status (mirrors the C ABI sg_status_name).
const char* parse_status_name(ParseStatus s) noexcept;

}  // namespace sg::parser

#endif  // STREAMGUARD_PARSER_HPP
