// Copyright © 2026 Parsa Fathi — Apache-2.0
// SPDX-License-Identifier: Apache-2.0
//
// StreamGuard native event parser — implementation.
//
// Single-pass, allocation-free, hand-written JSON scanner (RFC 8259 subset) with
// strict schema validation for the StreamGuard event contract (schema_version 1).
// Everything works on string_views into the caller's input: no copies, no heap.
// Error codes only — no exceptions are used for control flow (parse_event() is
// noexcept; a defensive catch-all guards the noexcept promise against bugs).

#include "streamguard/parser.hpp"

#include <cstdio>

namespace sg::parser {
namespace {

// ---------------------------------------------------------------- enum tables
constexpr std::string_view kSourceTypes[] = {"app", "infra", "system", "security", "synthetic"};
constexpr std::string_view kSeverities[] = {"info", "low", "medium", "high", "critical"};
constexpr std::string_view kCategories[] = {"auth", "network", "application", "data", "system", "config", "security"};
constexpr std::string_view kOrigins[] = {"synthetic", "external"};

bool in_enum(std::string_view v, const std::string_view* set, std::size_t n) noexcept {
    for (std::size_t i = 0; i < n; ++i) {
        if (set[i] == v) {
            return true;
        }
    }
    return false;
}

// ------------------------------------------------------------- small helpers
constexpr std::uint32_t kBadCodePoint = 0x110000;  // sentinel: invalid \u escape

bool is_digit(char c) noexcept { return c >= '0' && c <= '9'; }

// Parses exactly 4 hex digits; s.size() >= 4 is a caller guarantee.
std::uint32_t hex4(std::string_view s) noexcept {
    std::uint32_t v = 0;
    for (std::size_t i = 0; i < 4; ++i) {
        const char c = s[i];
        std::uint32_t d;
        if (c >= '0' && c <= '9') {
            d = static_cast<std::uint32_t>(c - '0');
        } else if (c >= 'a' && c <= 'f') {
            d = static_cast<std::uint32_t>(c - 'a') + 10U;
        } else if (c >= 'A' && c <= 'F') {
            d = static_cast<std::uint32_t>(c - 'A') + 10U;
        } else {
            return kBadCodePoint;
        }
        v = (v << 4U) | d;
    }
    return v;
}

std::size_t utf8_encode(std::uint32_t cp, char* out) noexcept {
    if (cp < 0x80U) {
        out[0] = static_cast<char>(cp);
        return 1;
    }
    if (cp < 0x800U) {
        out[0] = static_cast<char>(0xC0U | (cp >> 6U));
        out[1] = static_cast<char>(0x80U | (cp & 0x3FU));
        return 2;
    }
    if (cp < 0x10000U) {
        out[0] = static_cast<char>(0xE0U | (cp >> 12U));
        out[1] = static_cast<char>(0x80U | ((cp >> 6U) & 0x3FU));
        out[2] = static_cast<char>(0x80U | (cp & 0x3FU));
        return 3;
    }
    out[0] = static_cast<char>(0xF0U | (cp >> 18U));
    out[1] = static_cast<char>(0x80U | ((cp >> 12U) & 0x3FU));
    out[2] = static_cast<char>(0x80U | ((cp >> 6U) & 0x3FU));
    out[3] = static_cast<char>(0x80U | (cp & 0x3FU));
    return 4;
}

// Copies at most max_chars bytes of src into dst (cap includes NUL), replacing
// control characters with '?' and NUL-terminating.
void sanitized_copy(char* dst, std::size_t cap, std::string_view src, std::size_t max_chars) noexcept {
    std::size_t m = src.size() < max_chars ? src.size() : max_chars;
    if (m > cap - 1) {
        m = cap - 1;
    }
    std::size_t n = 0;
    for (std::size_t i = 0; i < m; ++i) {
        const char c = src[i];
        dst[n++] = (c >= 0x20 && c != 0x7F) ? c : '?';
    }
    dst[n] = '\0';
}

void set_error(ErrorInfo& e, ParseStatus st, std::size_t off, const char* msg,
               std::string_view field) noexcept {
    e.status = st;
    e.byte_offset = off;
    std::size_t n = 0;
    for (std::size_t i = 0; msg[i] != '\0' && n < sizeof(e.message) - 1; ++i) {
        const char c = msg[i];
        e.message[n++] = (c >= 0x20 && c != 0x7F) ? c : '?';
    }
    e.message[n] = '\0';
    n = 0;
    for (std::size_t i = 0; i < field.size() && n < sizeof(e.field) - 1; ++i) {
        const char c = field[i];
        e.field[n++] = (c >= 0x20 && c != 0x7F) ? c : '?';
    }
    e.field[n] = '\0';
}

// ------------------------------------------------------------------- scanner
// Minimal single-pass JSON scanner over a string_view. Fails via error codes
// (static message + byte offset); never throws, never allocates.
struct Scanner {
    std::string_view in;
    std::size_t pos = 0;
    const char* err = nullptr;  // static message; nullptr while no error
    std::size_t err_pos = 0;

    bool fail(const char* m, std::size_t at) noexcept {
        err = m;
        err_pos = at;
        return false;
    }
    bool eof() const noexcept { return pos >= in.size(); }
    char peek() const noexcept { return pos < in.size() ? in[pos] : '\0'; }
    void skip_ws() noexcept {
        while (pos < in.size()) {
            const char c = in[pos];
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                ++pos;
            } else {
                break;
            }
        }
    }
    bool expect(char c, const char* msg) noexcept {
        skip_ws();
        if (peek() != c) {
            return fail(msg, pos);
        }
        ++pos;
        return true;
    }

    // Scans a JSON string; caller guarantees peek() == '"'. On success `raw` is
    // the text between the quotes and pos is past the closing quote. Validates
    // escapes (incl. \uXXXX surrogate pairing) and rejects raw control chars.
    bool scan_string(std::string_view& raw) noexcept {
        const std::size_t qpos = pos;
        ++pos;
        const std::size_t b = pos;
        for (;;) {
            if (pos >= in.size()) {
                return fail("unterminated string", qpos);
            }
            const unsigned char c = static_cast<unsigned char>(in[pos]);
            if (c == '"') {
                raw = in.substr(b, pos - b);
                ++pos;
                return true;
            }
            if (c < 0x20) {
                return fail("raw control character in string", pos);
            }
            if (c == '\\') {
                ++pos;
                if (pos >= in.size()) {
                    return fail("unterminated escape sequence", pos - 1);
                }
                const char e = in[pos];
                switch (e) {
                case '"': case '\\': case '/': case 'b': case 'f': case 'n': case 'r': case 't':
                    ++pos;
                    break;
                case 'u': {
                    if (pos + 5 > in.size()) {
                        return fail("truncated \\u escape", pos - 1);
                    }
                    const std::uint32_t cp = hex4(in.substr(pos + 1, 4));
                    if (cp == kBadCodePoint) {
                        return fail("invalid \\u escape (bad hex digit)", pos + 1);
                    }
                    if (cp >= 0xD800U && cp <= 0xDBFFU) {  // high surrogate: pair required
                        const std::size_t lp = pos + 5;     // expected '\\' of "\uXXXX"
                        if (lp + 6 > in.size() || in[lp] != '\\' || in[lp + 1] != 'u') {
                            return fail("unpaired high surrogate \\u escape", pos + 1);
                        }
                        const std::uint32_t lo = hex4(in.substr(lp + 2, 4));
                        if (lo == kBadCodePoint || lo < 0xDC00U || lo > 0xDFFFU) {
                            return fail("invalid low surrogate \\u escape", lp + 2);
                        }
                        pos = lp + 6;
                        break;
                    }
                    if (cp >= 0xDC00U && cp <= 0xDFFFU) {
                        return fail("unpaired low surrogate \\u escape", pos + 1);
                    }
                    pos += 5;  // 'u' + 4 hex digits
                    break;
                }
                default:
                    return fail("invalid escape character", pos);
                }
                continue;
            }
            ++pos;  // multibyte UTF-8: whole input validated beforehand
        }
    }

    // Strict RFC 8259 number grammar (no leading zeros, no bare '.'/'e').
    bool scan_number(std::string_view& tok) noexcept {
        const std::size_t start = pos;
        if (peek() == '-') {
            ++pos;
        }
        if (eof() || !is_digit(in[pos])) {
            return fail("invalid number", start);
        }
        if (in[pos] == '0') {
            ++pos;
            if (!eof() && is_digit(in[pos])) {
                return fail("invalid number (leading zero)", pos);
            }
        } else {
            while (!eof() && is_digit(in[pos])) {
                ++pos;
            }
        }
        if (peek() == '.') {
            ++pos;
            if (eof() || !is_digit(in[pos])) {
                return fail("invalid number (missing fraction digits)", pos);
            }
            while (!eof() && is_digit(in[pos])) {
                ++pos;
            }
        }
        const char ec = peek();
        if (ec == 'e' || ec == 'E') {
            ++pos;
            if (peek() == '+' || peek() == '-') {
                ++pos;
            }
            if (eof() || !is_digit(in[pos])) {
                return fail("invalid number (missing exponent digits)", pos);
            }
            while (!eof() && is_digit(in[pos])) {
                ++pos;
            }
        }
        tok = in.substr(start, pos - start);
        return true;
    }

    bool scan_literal(std::string_view lit) noexcept {
        if (pos + lit.size() > in.size() || in.substr(pos, lit.size()) != lit) {
            return fail("invalid literal", pos);
        }
        pos += lit.size();
        return true;
    }

    // Skips one arbitrary JSON value (objects, arrays, strings, numbers, literals).
    bool skip_value(int depth) noexcept {
        if (depth > kMaxJsonNestingDepth) {
            return fail("JSON nesting too deep", pos);
        }
        skip_ws();
        if (eof()) {
            return fail("unexpected end of input", pos);
        }
        const char c = in[pos];
        switch (c) {
        case '{': {
            ++pos;
            bool first = true;
            for (;;) {
                skip_ws();
                if (peek() == '}') {
                    ++pos;
                    return true;
                }
                if (!first) {
                    if (peek() != ',') {
                        return fail("expected ',' or '}'", pos);
                    }
                    ++pos;
                    skip_ws();
                    if (peek() == '}') {
                        return fail("trailing comma in object", pos);
                    }
                }
                if (peek() != '"') {
                    return fail("expected object key", pos);
                }
                std::string_view kraw;
                if (!scan_string(kraw)) {
                    return false;
                }
                if (!expect(':', "expected ':'")) {
                    return false;
                }
                if (!skip_value(depth + 1)) {
                    return false;
                }
                first = false;
            }
        }
        case '[': {
            ++pos;
            bool first = true;
            for (;;) {
                skip_ws();
                if (peek() == ']') {
                    ++pos;
                    return true;
                }
                if (!first) {
                    if (peek() != ',') {
                        return fail("expected ',' or ']'", pos);
                    }
                    ++pos;
                    skip_ws();
                    if (peek() == ']') {
                        return fail("trailing comma in array", pos);
                    }
                }
                if (!skip_value(depth + 1)) {
                    return false;
                }
                first = false;
            }
        }
        case '"': {
            std::string_view raw;
            return scan_string(raw);
        }
        case 't':
            return scan_literal("true");
        case 'f':
            return scan_literal("false");
        case 'n':
            return scan_literal("null");
        default:
            if (c == '-' || is_digit(c)) {
                std::string_view tok;
                return scan_number(tok);
            }
            return fail("unexpected character", pos);
        }
    }
};

// Classifies a JSON value by its first byte (value is well-formed JSON here).
JsonValueType classify_value(char c) noexcept {
    switch (c) {
    case '"': return JsonValueType::String;
    case '{': return JsonValueType::Object;
    case '[': return JsonValueType::Array;
    case 't': case 'f': return JsonValueType::Bool;
    case 'n': return JsonValueType::Null;
    default: return JsonValueType::Number;
    }
}

// Walks a JSON object; `sc` must be at (whitespace before) the '{'. For every
// entry it calls on_entry(kpos, kraw, vstart); the callback MUST consume exactly
// one value starting at vstart (typically sc.skip_value(1)). Returns false when
// the walk hits a JSON error (sc.err set) OR when the callback returns false
// (sc.err untouched — the callback owns that failure). May propagate exceptions
// thrown by the callback (used by to_owned).
template <typename F>
bool walk_object(Scanner& sc, F&& on_entry) {
    if (!sc.expect('{', "expected '{'")) {
        return false;
    }
    bool first = true;
    for (;;) {
        sc.skip_ws();
        if (sc.peek() == '}') {
            ++sc.pos;
            return true;
        }
        if (!first) {
            if (sc.peek() != ',') {
                return sc.fail("expected ',' or '}'", sc.pos);
            }
            ++sc.pos;
            sc.skip_ws();
            if (sc.peek() == '}') {
                return sc.fail("trailing comma in object", sc.pos);
            }
        }
        const std::size_t kpos = sc.pos;
        if (sc.peek() != '"') {
            return sc.fail("expected object key", sc.pos);
        }
        std::string_view kraw;
        if (!sc.scan_string(kraw)) {
            return false;
        }
        if (!sc.expect(':', "expected ':'")) {
            return false;
        }
        sc.skip_ws();
        if (!on_entry(kpos, kraw, sc.pos)) {
            return false;
        }
        first = false;
    }
}

// Decodes (and validates) a raw JSON string body into buf. See public
// unescape_json_string(). Applied both to scanner-validated spans (double
// validation — cheap, and only for escaped strings) and to arbitrary input.
bool decode_string_validated(std::string_view raw, char* buf, std::size_t cap,
                             std::size_t& out_len) noexcept {
    const std::size_t n = raw.size();
    std::size_t o = 0;
    std::size_t i = 0;
    while (i < n) {
        const char c = raw[i];
        if (c != '\\') {
            if (o >= cap) {
                return false;
            }
            buf[o++] = c;
            ++i;
            continue;
        }
        ++i;
        if (i >= n) {
            return false;
        }
        const char e = raw[i++];
        switch (e) {
        case '"': case '\\': case '/':
            if (o >= cap) {
                return false;
            }
            buf[o++] = e;
            break;
        case 'b': case 'f': case 'n': case 'r': case 't': {
            if (o >= cap) {
                return false;
            }
            const char map = (e == 'b') ? '\b' : (e == 'f') ? '\f' : (e == 'n') ? '\n' : (e == 'r') ? '\r' : '\t';
            buf[o++] = map;
            break;
        }
        case 'u': {
            if (i + 4 > n) {
                return false;
            }
            std::uint32_t cp = hex4(raw.substr(i, 4));
            if (cp == kBadCodePoint) {
                return false;
            }
            i += 4;
            if (cp >= 0xD800U && cp <= 0xDBFFU) {
                if (i + 6 > n || raw[i] != '\\' || raw[i + 1] != 'u') {
                    return false;
                }
                const std::uint32_t lo = hex4(raw.substr(i + 2, 4));
                if (lo == kBadCodePoint || lo < 0xDC00U || lo > 0xDFFFU) {
                    return false;
                }
                cp = 0x10000U + ((cp - 0xD800U) << 10U) + (lo - 0xDC00U);
                i += 6;
            } else if (cp >= 0xDC00U && cp <= 0xDFFFU) {
                return false;
            }
            char tmp[4];
            const std::size_t k = utf8_encode(cp, tmp);
            if (o + k > cap) {
                return false;
            }
            for (std::size_t t = 0; t < k; ++t) {
                buf[o++] = tmp[t];
            }
            break;
        }
        default:
            return false;
        }
    }
    out_len = o;
    return true;
}

// Decodes a raw string body into an owned string (fast path: no escapes).
// Allocates — only used by to_owned()/the C ABI, never by parse_event().
std::string decode_to_string(std::string_view raw) {
    if (raw.find('\\') == std::string_view::npos) {
        return std::string(raw);
    }
    std::string out(raw.size(), '\0');
    std::size_t n = 0;
    if (decode_string_validated(raw, out.data(), out.size(), n)) {
        out.resize(n);
        return out;
    }
    return std::string(raw);  // unreachable for parse-validated input; defensive
}

// Escape-aware equality of a raw JSON key vs a plain (decoded) query key.
// tmp must be at least the raw key length (kMaxInputBytes covers all cases).
bool raw_key_equals(std::string_view raw_key, std::string_view plain, char* tmp,
                    std::size_t tmp_cap) noexcept {
    if (raw_key.find('\\') == std::string_view::npos) {
        return raw_key == plain;
    }
    std::size_t n = 0;
    if (!decode_string_validated(raw_key, tmp, tmp_cap, n)) {
        return false;
    }
    return std::string_view(tmp, n) == plain;
}

// ---------------------------------------------------- domain-specific checks
// ^[a-zA-Z0-9._-]{1,64}$ on the DECODED id (ASCII-only set => bytes == chars).
bool valid_source_id(std::string_view s) noexcept {
    if (s.empty() || s.size() > kMaxSourceIdBytes) {
        return false;
    }
    for (const char c : s) {
        const bool okch = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
                           c == '.' || c == '_' || c == '-';
        if (!okch) {
            return false;
        }
    }
    return true;
}

// Strict "YYYY-MM-DDTHH:MM:SS(.mmm)?Z" — UTC 'Z' only (offsets like +02:00 are
// rejected), 'T'/'Z' uppercase only, fraction exactly 3 digits, no leap second
// (:60), calendar validated via std::chrono year_month_day (Feb 30 etc. fail).
bool parse_iso8601_utc(std::string_view s, std::chrono::system_clock::time_point& out) noexcept {
    const std::size_t n = s.size();
    if (n != 20 && n != 24) {
        return false;
    }
    const bool frac = (n == 24);
    if (s[4] != '-' || s[7] != '-' || s[10] != 'T' || s[13] != ':' || s[16] != ':') {
        return false;
    }
    if (frac) {
        if (s[19] != '.' || s[23] != 'Z') {
            return false;
        }
    } else if (s[19] != 'Z') {
        return false;
    }
    int d[14];
    const std::size_t digits[14] = {0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18};
    for (std::size_t k = 0; k < 14; ++k) {
        const char c = s[digits[k]];
        if (!is_digit(c)) {
            return false;
        }
        d[k] = c - '0';
    }
    int ms = 0;
    if (frac) {
        for (std::size_t k = 20; k <= 22; ++k) {
            if (!is_digit(s[k])) {
                return false;
            }
        }
        ms = (s[20] - '0') * 100 + (s[21] - '0') * 10 + (s[22] - '0');
    }
    const int year = d[0] * 1000 + d[1] * 100 + d[2] * 10 + d[3];
    const int month = d[4] * 10 + d[5];
    const int day = d[6] * 10 + d[7];
    const int hour = d[8] * 10 + d[9];
    const int minute = d[10] * 10 + d[11];
    const int second = d[12] * 10 + d[13];
    if (hour > 23 || minute > 59 || second > 59) {
        return false;
    }
    // system_clock::time_point on common platforms holds nanoseconds in a
    // signed 64-bit count: the representable window is ~1677-09..2262-04.
    // Years outside [1678, 2261] would overflow the time_point arithmetic
    // (UB, caught by UBSan) — reject them cleanly instead.
    if (year < 1678 || year > 2261) {
        return false;
    }
    const auto ymd = std::chrono::year(year) / std::chrono::month(static_cast<unsigned>(month)) /
                     std::chrono::day(static_cast<unsigned>(day));
    if (!ymd.ok()) {
        return false;
    }
    const std::chrono::sys_days days(ymd);
    out = days + std::chrono::hours(hour) + std::chrono::minutes(minute) + std::chrono::seconds(second) +
          std::chrono::milliseconds(ms);
    return true;
}

// Stack scratch space for decode/normalize steps inside the parse (never heap).
struct Scratch {
    char value[4096];  // decoded value of the field being processed
    char norm[4096];   // normalized message
    char tmp[4096];    // second decode buffer (attribute duplicate-key compare)
    char key[64];      // decoded top-level field name (known names are <= 15 chars;
                       // a decoded name > 63 bytes is necessarily an unknown field)
};

// ------------------------------------------------------------------- parsing
// Returns false with res.error/res.status filled on any failure. Callbacks in
// here do not throw; the (not noexcept) signature lets parse_event()'s defensive
// catch-all handle any broken invariant gracefully.
bool parse_event_object(Scanner& sc, Scratch& s, ParseResult& res) {
    auto schema_fail = [&](ParseStatus st, std::size_t at, const char* msg, std::string_view field) {
        set_error(res.error, st, at, msg, field);
        res.status = st;
        return false;
    };
    auto json_fail = [&]() {
        set_error(res.error, ParseStatus::InvalidJson, sc.err_pos, sc.err ? sc.err : "invalid JSON", "");
        res.status = ParseStatus::InvalidJson;
        return false;
    };
    // Shared failure exit: JSON error (sc.err set) or a schema error the callback
    // already recorded in res (sc.err untouched).
    auto exit_failed = [&]() {
        if (sc.err != nullptr) {
            return json_fail();
        }
        return false;
    };

    sc.skip_ws();
    if (sc.peek() != '{') {
        return schema_fail(ParseStatus::InvalidJson, sc.pos, "expected top-level JSON object", "");
    }

    std::uint32_t seen = 0;  // bitmask over the 15 known fields
    auto dup = [&](std::size_t kpos, std::string_view name) {
        return schema_fail(ParseStatus::SchemaViolation, kpos, "duplicate field", name);
    };

    // Common: scan a string value, decode into s.value. Classification is
    // precise: a parseable JSON value of the wrong type -> SchemaViolation;
    // an unparseable value -> InvalidJson (scanner error).
    auto expect_string = [&](std::size_t vpos, std::string_view fname, std::string_view& raw,
                             std::string_view& dec) -> bool {
        if (sc.peek() != '"') {
            if (sc.peek() == 'n') {
                if (!sc.scan_literal("null")) {
                    return false;  // bad literal -> InvalidJson
                }
                schema_fail(ParseStatus::SchemaViolation, vpos, "null is not allowed for this field",
                           fname);
                return false;
            }
            if (sc.skip_value(1)) {
                schema_fail(ParseStatus::SchemaViolation, vpos, "expected string value", fname);
            }
            return false;  // skip_value failed -> InvalidJson
        }
        if (!sc.scan_string(raw)) {
            return false;  // sc.err set -> InvalidJson
        }
        std::size_t n = 0;
        decode_string_validated(raw, s.value, sizeof(s.value), n);  // cannot fail post-scan
        dec = std::string_view(s.value, n);
        return true;
    };

    auto enum_fail = [&](std::size_t vpos, std::string_view fname, std::string_view val,
                         const char* expected) {
        char ex[40];
        sanitized_copy(ex, sizeof(ex), val, 32);
        char msg[128];
        std::snprintf(msg, sizeof(msg), "invalid %.*s value '%.32s' (expected %s)",
                      static_cast<int>(fname.size() < 24 ? fname.size() : 24), fname.data(), ex, expected);
        return schema_fail(ParseStatus::InvalidEnum, vpos, msg, fname);
    };

    const bool ok = walk_object(sc, [&](std::size_t kpos, std::string_view kraw, std::size_t vstart) {
        std::size_t klen = 0;
        if (!decode_string_validated(kraw, s.key, sizeof(s.key), klen)) {
            // Decoded name longer than 63 bytes: cannot be one of the 15 known
            // fields (all <= 15 chars) -> unknown; report truncated raw name.
            char name[kErrorFieldBytes];
            sanitized_copy(name, sizeof(name), kraw, kErrorFieldBytes - 1);
            set_error(res.error, ParseStatus::SchemaViolation, kpos, "unknown field (name too long)",
                      name);
            res.status = ParseStatus::SchemaViolation;
            return false;
        }
        const std::string_view key(s.key, klen);

        // --- required fields ----------------------------------------------
        if (key == "event_id") {
            if (seen & (1U << 0)) return dup(kpos, key);
            seen |= 1U << 0;
            std::string_view raw, dec;
            if (!expect_string(vstart, key, raw, dec)) return false;
            if (dec.empty()) {
                return schema_fail(ParseStatus::SchemaViolation, vstart,
                                   "event_id must be a non-empty string", key);
            }
            res.event.event_id = raw;
            return true;
        }
        if (key == "schema_version") {
            if (seen & (1U << 1)) return dup(kpos, key);
            seen |= 1U << 1;
            const char c = sc.peek();
            if (c == 'n') {
                if (!sc.scan_literal("null")) {
                    return false;  // bad literal -> InvalidJson
                }
                return schema_fail(ParseStatus::SchemaViolation, vstart,
                                   "null is not allowed for this field", key);
            }
            if (c != '-' && !is_digit(c)) {
                // parseable-but-wrong-type -> SchemaViolation; unparseable -> InvalidJson
                if (sc.skip_value(1)) {
                    return schema_fail(ParseStatus::SchemaViolation, vstart, "expected integer value",
                                       key);
                }
                return false;
            }
            std::string_view tok;
            if (!sc.scan_number(tok)) return false;  // InvalidJson
            if (tok != "1") {
                return schema_fail(ParseStatus::SchemaViolation, vstart, "schema_version must be 1", key);
            }
            res.event.schema_version = 1;
            return true;
        }
        if (key == "event_time") {
            if (seen & (1U << 2)) return dup(kpos, key);
            seen |= 1U << 2;
            std::string_view raw, dec;
            if (!expect_string(vstart, key, raw, dec)) return false;
            if (!parse_iso8601_utc(dec, res.event.event_time)) {
                char ex[40];
                sanitized_copy(ex, sizeof(ex), dec, 32);
                char msg[128];
                std::snprintf(msg, sizeof(msg),
                              "invalid event_time '%.32s' (expected YYYY-MM-DDTHH:MM:SS(.mmm)?Z, UTC 'Z' only)",
                              ex);
                return schema_fail(ParseStatus::InvalidTimestamp, vstart, msg, key);
            }
            return true;
        }
        if (key == "source_id") {
            if (seen & (1U << 3)) return dup(kpos, key);
            seen |= 1U << 3;
            std::string_view raw, dec;
            if (!expect_string(vstart, key, raw, dec)) return false;
            if (!valid_source_id(dec)) {
                char ex[40];
                sanitized_copy(ex, sizeof(ex), dec, 32);
                char msg[128];
                std::snprintf(msg, sizeof(msg),
                              "invalid source_id '%.32s' (must match ^[a-zA-Z0-9._-]{1,64}$)", ex);
                return schema_fail(ParseStatus::SchemaViolation, vstart, msg, key);
            }
            res.event.source_id = raw;
            return true;
        }
        if (key == "source_type") {
            if (seen & (1U << 4)) return dup(kpos, key);
            seen |= 1U << 4;
            std::string_view raw, dec;
            if (!expect_string(vstart, key, raw, dec)) return false;
            if (!in_enum(dec, kSourceTypes, std::size(kSourceTypes))) {
                return enum_fail(vstart, key, dec, "app|infra|system|security|synthetic");
            }
            res.event.source_type = raw;
            return true;
        }
        if (key == "severity") {
            if (seen & (1U << 5)) return dup(kpos, key);
            seen |= 1U << 5;
            std::string_view raw, dec;
            if (!expect_string(vstart, key, raw, dec)) return false;
            if (!in_enum(dec, kSeverities, std::size(kSeverities))) {
                return enum_fail(vstart, key, dec, "info|low|medium|high|critical");
            }
            res.event.severity = raw;
            return true;
        }
        if (key == "category") {
            if (seen & (1U << 6)) return dup(kpos, key);
            seen |= 1U << 6;
            std::string_view raw, dec;
            if (!expect_string(vstart, key, raw, dec)) return false;
            if (!in_enum(dec, kCategories, std::size(kCategories))) {
                return enum_fail(vstart, key, dec, "auth|network|application|data|system|config|security");
            }
            res.event.category = raw;
            return true;
        }
        if (key == "message") {
            if (seen & (1U << 7)) return dup(kpos, key);
            seen |= 1U << 7;
            std::string_view raw, dec;
            if (!expect_string(vstart, key, raw, dec)) return false;
            const std::string_view norm = normalize_message(dec, s.norm, sizeof(s.norm));
            const std::size_t chars = count_utf8_chars(norm);
            if (chars == 0 || chars > kMaxMessageChars) {
                char msg[128];
                std::snprintf(msg, sizeof(msg),
                              "message must contain 1..512 characters after whitespace normalization (got %zu)",
                              chars);
                return schema_fail(ParseStatus::SchemaViolation, vstart, msg, key);
            }
            res.event.message = raw;
            res.event.message_chars = chars;
            return true;
        }

        // --- optional string fields ----------------------------------------
        if (key == "correlation_id" || key == "trace_id" || key == "actor") {
            const bool iscorr = key == "correlation_id";
            const bool istrace = key == "trace_id";
            const unsigned bit = iscorr ? 8U : (istrace ? 9U : 10U);
            if (seen & (1U << bit)) return dup(kpos, key);
            seen |= 1U << bit;
            std::string_view raw, dec;
            if (!expect_string(vstart, key, raw, dec)) return false;
            if (dec.size() > kMaxOptionalIdBytes) {
                char msg[128];
                std::snprintf(msg, sizeof(msg), "%.*s must be at most 128 bytes (got %zu)",
                              static_cast<int>(key.size()), key.data(), dec.size());
                return schema_fail(ParseStatus::SchemaViolation, vstart, msg, key);
            }
            if (iscorr) {
                res.event.correlation_id = raw;
                res.event.has_correlation_id = true;
            } else if (istrace) {
                res.event.trace_id = raw;
                res.event.has_trace_id = true;
            } else {
                res.event.actor = raw;
                res.event.has_actor = true;
            }
            return true;
        }
        if (key == "origin") {
            // origin is stamped by the SYSTEM per contract: absence is valid.
            if (seen & (1U << 11)) return dup(kpos, key);
            seen |= 1U << 11;
            std::string_view raw, dec;
            if (!expect_string(vstart, key, raw, dec)) return false;
            if (!in_enum(dec, kOrigins, std::size(kOrigins))) {
                return enum_fail(vstart, key, dec, "synthetic|external");
            }
            res.event.origin = raw;
            res.event.has_origin = true;
            return true;
        }

        // --- attributes ------------------------------------------------------
        if (key == "attributes") {
            if (seen & (1U << 12)) return dup(kpos, key);
            seen |= 1U << 12;
            if (sc.peek() != '{') {
                // same precise classification as expect_string
                if (sc.peek() == 'n') {
                    if (!sc.scan_literal("null")) {
                        return false;  // bad literal -> InvalidJson
                    }
                } else if (!sc.skip_value(1)) {
                    return false;  // unparseable -> InvalidJson
                }
                return schema_fail(ParseStatus::SchemaViolation, vstart,
                                   "attributes must be a JSON object", key);
            }
            const std::size_t astart = sc.pos;
            const bool aok = walk_object(sc, [&](std::size_t akpos, std::string_view akraw,
                                                 std::size_t avstart) {
                // duplicate-key detection among already-indexed entries
                // (decoded-aware: "a" vs "\u0061" are the same key)
                for (std::size_t i = 0; i < res.event.attributes.count; ++i) {
                    const AttributeEntry& e = res.event.attributes.entries[i];
                    if (e.key == akraw) {
                        set_error(res.error, ParseStatus::SchemaViolation, akpos,
                                  "duplicate attribute key", akraw);
                        res.status = ParseStatus::SchemaViolation;
                        return false;
                    }
                    const bool ce = akraw.find('\\') != std::string_view::npos;
                    const bool ee = e.key.find('\\') != std::string_view::npos;
                    if (!ce && !ee) {
                        continue;  // different raw spellings, neither escaped
                    }
                    std::size_t n1 = 0;
                    std::size_t n2 = 0;
                    const std::string_view cur =
                        ce && decode_string_validated(akraw, s.tmp, sizeof(s.tmp), n1)
                            ? std::string_view(s.tmp, n1)
                            : akraw;
                    const std::string_view prev =
                        ee && decode_string_validated(e.key, s.value, sizeof(s.value), n2)
                            ? std::string_view(s.value, n2)
                            : e.key;
                    if (cur == prev) {
                        set_error(res.error, ParseStatus::SchemaViolation, akpos,
                                  "duplicate attribute key", akraw);
                        res.status = ParseStatus::SchemaViolation;
                        return false;
                    }
                }
                if (!sc.skip_value(1)) {
                    return false;  // InvalidJson
                }
                std::string_view vspan = sc.in.substr(avstart, sc.pos - avstart);
                const JsonValueType vt = classify_value(sc.in[avstart]);
                if (vt == JsonValueType::String) {
                    vspan = vspan.substr(1, vspan.size() - 2);  // strip quotes
                }
                if (res.event.attributes.count < kMaxAttributeEntries) {
                    res.event.attributes.entries[res.event.attributes.count++] = {akraw, vspan, vt};
                } else {
                    res.event.attributes.truncated = true;
                }
                return true;
            });
            if (!aok) {
                return exit_failed();  // sc.err (JSON) or res (duplicate key) already set
            }
            res.event.attributes_raw = sc.in.substr(astart, sc.pos - astart);
            res.event.has_attributes = true;
            // Redundant while kMaxInputBytes == 4096 (the whole-payload cap
            // subsumes it); kept explicit so the contract rule survives a
            // future change of kMaxInputBytes.
            if (res.event.attributes_raw.size() > kMaxInputBytes) {
                return schema_fail(ParseStatus::SchemaViolation, astart,
                                   "stringified attributes exceed 4096 bytes", key);
            }
            return true;
        }

        // --- unknown top-level field -----------------------------------------
        set_error(res.error, ParseStatus::SchemaViolation, kpos, "unknown field", key);
        res.status = ParseStatus::SchemaViolation;
        return false;
    });

    if (!ok) {
        return exit_failed();
    }

    // required-field presence, reported in canonical contract order
    struct Required {
        const char* name;
        unsigned bit;
    };
    static constexpr Required kRequired[] = {
        {"event_id", 0},   {"schema_version", 1}, {"event_time", 2}, {"source_id", 3},
        {"source_type", 4}, {"severity", 5},      {"category", 6},   {"message", 7},
    };
    for (const Required& r : kRequired) {
        if (!(seen & (1U << r.bit))) {
            return schema_fail(ParseStatus::MissingField, 0, "missing required field", r.name);
        }
    }

    sc.skip_ws();
    if (sc.pos < sc.in.size()) {
        sc.fail("trailing garbage after JSON value", sc.pos);
        return json_fail();
    }
    return true;
}

}  // namespace

// ------------------------------------------------------------------ public API
ParseResult parse_event(std::string_view input) noexcept {
    ParseResult res;
    if (input.size() > kMaxInputBytes) {
        // Enforced before ANY scanning of the payload.
        set_error(res.error, ParseStatus::OversizedInput, 0, "input exceeds maximum size of 4096 bytes",
                  "");
        res.status = ParseStatus::OversizedInput;
        return res;
    }
    std::size_t uerr = 0;
    if (!is_valid_utf8(input, uerr)) {
        set_error(res.error, ParseStatus::EncodingError, uerr, "invalid UTF-8 sequence", "");
        res.status = ParseStatus::EncodingError;
        return res;
    }
    Scanner sc;
    sc.in = input;
    Scratch s;
    try {
        // Nothing below allocates or throws by design; the catch is a defensive
        // guard for the noexcept promise (e.g. against a broken invariant).
        if (!parse_event_object(sc, s, res)) {
            return res;
        }
    } catch (...) {
        set_error(res.error, ParseStatus::InvalidJson, 0,
                  "internal error: unexpected exception during parse", "");
        res.status = ParseStatus::InvalidJson;
        return res;
    }
    res.status = ParseStatus::Ok;
    return res;
}

bool is_valid_utf8(std::string_view s, std::size_t& error_offset) noexcept {
    const std::size_t n = s.size();
    std::size_t i = 0;
    while (i < n) {
        const unsigned char b = static_cast<unsigned char>(s[i]);
        std::size_t len;
        unsigned char lo = 0x80;  // allowed range of the 2nd byte
        unsigned char hi = 0xBF;
        if (b < 0x80) {
            ++i;
            continue;
        }
        if (b >= 0xC2 && b <= 0xDF) {
            len = 2;
        } else if (b == 0xE0) {
            len = 3;
            lo = 0xA0;  // excludes overlong E0 80..9F
        } else if ((b >= 0xE1 && b <= 0xEC) || b == 0xEE || b == 0xEF) {
            len = 3;
        } else if (b == 0xED) {
            len = 3;
            hi = 0x9F;  // excludes UTF-16 surrogates U+D800..U+DFFF
        } else if (b == 0xF0) {
            len = 4;
            lo = 0x90;  // excludes overlong F0 80..8F
        } else if (b >= 0xF1 && b <= 0xF3) {
            len = 4;
        } else if (b == 0xF4) {
            len = 4;
            hi = 0x8F;  // excludes > U+10FFFF
        } else {
            error_offset = i;  // stray continuation, 0xC0/0xC1 (overlong), 0xF5..0xFF
            return false;
        }
        if (i + len > n) {
            error_offset = i;  // truncated sequence
            return false;
        }
        const unsigned char b1 = static_cast<unsigned char>(s[i + 1]);
        if (b1 < lo || b1 > hi) {
            error_offset = i;
            return false;
        }
        for (std::size_t k = 2; k < len; ++k) {
            const unsigned char bk = static_cast<unsigned char>(s[i + k]);
            if ((bk & 0xC0) != 0x80) {
                error_offset = i;
                return false;
            }
        }
        i += len;
    }
    return true;
}

std::size_t count_utf8_chars(std::string_view s) noexcept {
    std::size_t count = 0;
    for (const unsigned char c : s) {
        if ((c & 0xC0) != 0x80) {
            ++count;  // ASCII or lead byte
        }
    }
    return count;
}

std::string_view normalize_message(std::string_view raw, char* buf, std::size_t buf_cap) noexcept {
    const auto is_ws = [](char c) noexcept {
        return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\v' || c == '\f';
    };
    std::size_t b = 0;
    std::size_t e = raw.size();
    while (b < e && is_ws(raw[b])) {
        ++b;
    }
    while (e > b && is_ws(raw[e - 1])) {
        --e;
    }
    const std::string_view trimmed = raw.substr(b, e - b);

    // detect an internal run of 2+ whitespace characters
    bool need_collapse = false;
    for (std::size_t i = 0; i + 1 < trimmed.size(); ++i) {
        if (is_ws(trimmed[i]) && is_ws(trimmed[i + 1])) {
            need_collapse = true;
            break;
        }
    }
    if (!need_collapse) {
        return trimmed;  // zero copy
    }
    if (buf == nullptr || buf_cap < trimmed.size()) {
        return trimmed;  // documented best-effort degradation (trim only)
    }
    std::size_t o = 0;
    std::size_t i = 0;
    while (i < trimmed.size()) {
        if (is_ws(trimmed[i])) {
            while (i < trimmed.size() && is_ws(trimmed[i])) {
                ++i;
            }
            buf[o++] = ' ';
        } else {
            buf[o++] = trimmed[i++];
        }
    }
    return std::string_view(buf, o);
}

bool unescape_json_string(std::string_view raw, char* buf, std::size_t buf_cap,
                          std::size_t& out_len) noexcept {
    return decode_string_validated(raw, buf, buf_cap, out_len);
}

const char* parse_status_name(ParseStatus s) noexcept {
    switch (s) {
    case ParseStatus::Ok: return "Ok";
    case ParseStatus::InvalidJson: return "InvalidJson";
    case ParseStatus::SchemaViolation: return "SchemaViolation";
    case ParseStatus::OversizedInput: return "OversizedInput";
    case ParseStatus::InvalidTimestamp: return "InvalidTimestamp";
    case ParseStatus::InvalidEnum: return "InvalidEnum";
    case ParseStatus::MissingField: return "MissingField";
    case ParseStatus::EncodingError: return "EncodingError";
    }
    return "Unknown";
}

std::int64_t EventRecord::event_time_unix_ms() const noexcept {
    return std::chrono::duration_cast<std::chrono::milliseconds>(event_time.time_since_epoch()).count();
}

const AttributeEntry* EventRecord::find_attribute(std::string_view key) const noexcept {
    char tmp[kMaxInputBytes];
    for (std::size_t i = 0; i < attributes.count; ++i) {
        if (raw_key_equals(attributes.entries[i].key, key, tmp, sizeof(tmp))) {
            return &attributes.entries[i];
        }
    }
    return nullptr;
}

bool EventRecord::scan_attribute(std::string_view key, AttributeEntry& out) const noexcept {
    if (const AttributeEntry* e = find_attribute(key)) {
        out = *e;
        return true;
    }
    if (!has_attributes || !attributes.truncated) {
        return false;
    }
    // Re-scan the raw span for keys beyond the 128-entry inline index.
    // The span was validated during parsing, so walk failures cannot occur on
    // records produced by a successful parse_event().
    char tmp[kMaxInputBytes];
    Scanner sc;
    sc.in = attributes_raw;
    bool found = false;
    walk_object(sc, [&](std::size_t /*kpos*/, std::string_view kraw, std::size_t vstart) {
        if (found) {
            return false;  // early exit: stop the walk
        }
        if (!sc.skip_value(1)) {
            return false;
        }
        if (raw_key_equals(kraw, key, tmp, sizeof(tmp))) {
            std::string_view vspan = sc.in.substr(vstart, sc.pos - vstart);
            const JsonValueType vt = classify_value(sc.in[vstart]);
            if (vt == JsonValueType::String) {
                vspan = vspan.substr(1, vspan.size() - 2);
            }
            out = AttributeEntry{kraw, vspan, vt};
            found = true;
        }
        return true;
    });
    return found;
}

std::int64_t OwnedEventRecord::event_time_unix_ms() const noexcept {
    return std::chrono::duration_cast<std::chrono::milliseconds>(event_time.time_since_epoch()).count();
}

const OwnedAttributeEntry* OwnedEventRecord::find_attribute(std::string_view key) const noexcept {
    for (const OwnedAttributeEntry& e : attributes) {
        if (e.key == key) {
            return &e;
        }
    }
    return nullptr;
}

OwnedEventRecord EventRecord::to_owned() const {
    OwnedEventRecord o;
    o.event_id = decode_to_string(event_id);
    o.schema_version = schema_version;
    o.event_time = event_time;
    o.source_id = decode_to_string(source_id);
    o.source_type = decode_to_string(source_type);
    o.severity = decode_to_string(severity);
    o.category = decode_to_string(category);
    o.message = decode_to_string(message);
    {
        std::string tmp(o.message.size() + 1, '\0');
        const std::string_view nv = normalize_message(o.message, tmp.data(), tmp.size());
        o.message_normalized.assign(nv);
    }
    o.has_attributes = has_attributes;
    o.attributes_raw.assign(attributes_raw);
    if (has_attributes) {
        // Re-walk the raw span to collect a COMPLETE map (no 128-entry cap).
        // The span was validated during parsing; a walk failure here means the
        // record did not come from a successful parse_event() — entries gathered
        // so far are kept, which is the honest partial result.
        Scanner sc;
        sc.in = attributes_raw;
        walk_object(sc, [&o, &sc](std::size_t /*kpos*/, std::string_view kraw, std::size_t vstart) {
            if (!sc.skip_value(1)) {
                return false;
            }
            std::string_view vspan = sc.in.substr(vstart, sc.pos - vstart);
            const JsonValueType vt = classify_value(sc.in[vstart]);
            if (vt == JsonValueType::String) {
                vspan = vspan.substr(1, vspan.size() - 2);
            }
            OwnedAttributeEntry e;
            e.key = decode_to_string(kraw);
            e.value = (vt == JsonValueType::String) ? decode_to_string(vspan) : std::string(vspan);
            e.type = vt;
            o.attributes.push_back(std::move(e));
            return true;
        });
    }
    o.has_correlation_id = has_correlation_id;
    o.correlation_id = decode_to_string(correlation_id);
    o.has_trace_id = has_trace_id;
    o.trace_id = decode_to_string(trace_id);
    o.has_actor = has_actor;
    o.actor = decode_to_string(actor);
    o.has_origin = has_origin;
    o.origin = decode_to_string(origin);
    return o;
}

}  // namespace sg::parser
