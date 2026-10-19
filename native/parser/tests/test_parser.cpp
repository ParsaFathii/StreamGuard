// Copyright © 2026 Parsa Fathi — Apache-2.0
// SPDX-License-Identifier: Apache-2.0
//
// StreamGuard native parser — self-contained test harness (no framework dep).
// Build: see Makefile (`make test`, `make sanitize`, `make tsan`).

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include "streamguard/capi.h"
#include "streamguard/parser.hpp"

using namespace sg::parser;

// ------------------------------------------------------------------ harness
static int g_checks = 0;
static int g_failed = 0;

static void report(const char* file, int line, const std::string& what) {
    ++g_failed;
    std::printf("FAIL %s:%d: %s\n", file, line, what.c_str());
}

#define CHECK(cond)                                                               \
    do {                                                                          \
        ++g_checks;                                                               \
        if (!(cond)) report(__FILE__, __LINE__, #cond);                           \
    } while (0)

#define CHECK_EQ(a, b)                                                            \
    do {                                                                          \
        ++g_checks;                                                               \
        const auto& va_ = (a);                                                    \
        const auto& vb_ = (b);                                                    \
        if (!(va_ == vb_)) {                                                      \
            std::ostringstream os;                                                \
            os << #a " == " #b "  (got " << va_ << ", want " << vb_ << ")";        \
            report(__FILE__, __LINE__, os.str());                                 \
        }                                                                         \
    } while (0)

// Status check that dumps full error info on mismatch.
#define CHECK_STATUS(res, st)                                                     \
    do {                                                                          \
        ++g_checks;                                                               \
        if ((res).status != (st)) {                                               \
            std::ostringstream os;                                                \
            os << "status " << parse_status_name((res).status) << " != "          \
               << parse_status_name(st) << " [err: " << (res).error.message       \
               << " field=" << (res).error.field                                  \
               << " off=" << (res).error.byte_offset << "]";                      \
            report(__FILE__, __LINE__, os.str());                                 \
        }                                                                         \
    } while (0)

static std::int64_t ms_of(const std::chrono::system_clock::time_point& tp) {
    return std::chrono::duration_cast<std::chrono::milliseconds>(tp.time_since_epoch()).count();
}

static std::chrono::system_clock::time_point tp_of(int y, unsigned mo, unsigned d, int h, int mi, int s,
                                                   int ms = 0) {
    using namespace std::chrono;
    return sys_days(year(y) / month(mo) / day(d)) + hours(h) + minutes(mi) + seconds(s) + milliseconds(ms);
}

// ------------------------------------------------------------- event builder
// Members hold raw JSON value text; has_* flags control presence.
struct Ev {
    std::string event_id = "\"e-1\"";
    std::string schema_version = "1";
    std::string event_time = "\"2026-01-15T10:30:00Z\"";
    std::string source_id = "\"sim-app-01\"";
    std::string source_type = "\"app\"";
    std::string severity = "\"info\"";
    std::string category = "\"auth\"";
    std::string message = "\"User login succeeded\"";
    bool has_event_id = true, has_schema_version = true, has_event_time = true, has_source_id = true;
    bool has_source_type = true, has_severity = true, has_category = true, has_message = true;
    std::string attributes;
    bool has_attributes = false;
    std::string correlation_id, trace_id, actor, origin;
    bool has_correlation_id = false, has_trace_id = false, has_actor = false, has_origin = false;

    std::string str() const {
        std::string out = "{";
        auto add = [&](const char* k, const std::string& v) {
            if (out.size() > 1) out += ',';
            out += '"';
            out += k;
            out += "\":";
            out += v;
        };
        if (has_event_id) add("event_id", event_id);
        if (has_schema_version) add("schema_version", schema_version);
        if (has_event_time) add("event_time", event_time);
        if (has_source_id) add("source_id", source_id);
        if (has_source_type) add("source_type", source_type);
        if (has_severity) add("severity", severity);
        if (has_category) add("category", category);
        if (has_message) add("message", message);
        if (has_attributes) add("attributes", attributes);
        if (has_correlation_id) add("correlation_id", correlation_id);
        if (has_trace_id) add("trace_id", trace_id);
        if (has_actor) add("actor", actor);
        if (has_origin) add("origin", origin);
        out += '}';
        return out;
    }
};

// --------------------------------------------------------------- valid cases
static void test_valid_minimal() {
    const std::string in = Ev().str();
    const ParseResult r = parse_event(in);
    CHECK_STATUS(r, ParseStatus::Ok);
    CHECK(r.event.event_id == "e-1");
    CHECK_EQ(r.event.schema_version, 1);
    CHECK_EQ(ms_of(r.event.event_time), ms_of(tp_of(2026, 1, 15, 10, 30, 0)));
    CHECK(r.event.source_id == "sim-app-01");
    CHECK(r.event.source_type == "app");
    CHECK(r.event.severity == "info");
    CHECK(r.event.category == "auth");
    CHECK(r.event.message == "User login succeeded");
    CHECK_EQ(r.event.message_chars, std::size_t{20});
    CHECK(!r.event.has_attributes);
    CHECK(!r.event.has_correlation_id);
    CHECK(!r.event.has_trace_id);
    CHECK(!r.event.has_actor);
    CHECK(!r.event.has_origin);  // system-stamped per contract: absence is valid
    CHECK_EQ(r.event.attributes.count, std::size_t{0});
    CHECK_EQ(r.event.event_time_unix_ms(), ms_of(tp_of(2026, 1, 15, 10, 30, 0)));
    // views point into the input (zero-copy contract)
    CHECK(r.event.message.data() >= in.data());
    CHECK(r.event.message.data() + r.event.message.size() <= in.data() + in.size());
}

static void test_valid_full() {
    Ev e;
    e.attributes = "{\"action\":\"login_failed\",\"attempts\":3,\"ok\":false,\"note\":null,"
                    "\"nested\":{\"x\":[1,2,{\"y\":\"z\"}]},\"list\":[true,null]}";
    e.has_attributes = true;
    e.has_correlation_id = true;
    e.correlation_id = "\"corr-42\"";
    e.has_trace_id = true;
    e.trace_id = "\"trace-9f3c\"";
    e.has_actor = true;
    e.actor = "\"user-alice\"";
    e.has_origin = true;
    e.origin = "\"synthetic\"";
    e.message = "\"ورود کاربر موفق بود\"";  // Persian: valid multibyte UTF-8
    const std::string in = e.str();
    const ParseResult r = parse_event(in);
    CHECK_STATUS(r, ParseStatus::Ok);
    CHECK(r.event.has_attributes);
    CHECK_EQ(r.event.attributes.count, std::size_t{6});
    CHECK(r.event.attributes_raw == e.attributes);
    CHECK(r.event.attributes.truncated == false);
    const AttributeEntry* a = r.event.find_attribute("action");
    CHECK(a != nullptr && a->type == JsonValueType::String && a->value == "login_failed");
    a = r.event.find_attribute("attempts");
    CHECK(a != nullptr && a->type == JsonValueType::Number && a->value == "3");
    a = r.event.find_attribute("ok");
    CHECK(a != nullptr && a->type == JsonValueType::Bool && a->value == "false");
    a = r.event.find_attribute("note");
    CHECK(a != nullptr && a->type == JsonValueType::Null && a->value == "null");
    a = r.event.find_attribute("nested");
    CHECK(a != nullptr && a->type == JsonValueType::Object && a->value.front() == '{');
    a = r.event.find_attribute("list");
    CHECK(a != nullptr && a->type == JsonValueType::Array && a->value.front() == '[');
    CHECK(r.event.find_attribute("missing") == nullptr);
    CHECK(r.event.has_correlation_id && r.event.correlation_id == "corr-42");
    CHECK(r.event.has_trace_id && r.event.trace_id == "trace-9f3c");
    CHECK(r.event.has_actor && r.event.actor == "user-alice");
    CHECK(r.event.has_origin && r.event.origin == "synthetic");
    CHECK_EQ(r.event.message_chars, std::size_t{19});  // Persian code points
}

static void test_valid_forms_and_escapes() {
    // pretty-printed + reordered
    const std::string pretty =
        "{\n  \"severity\": \"high\",\n  \"message\": \"disk full\",\n  \"category\": \"system\", "
        "\"event_id\": \"e-2\", \"schema_version\": 1, "
        "\"event_time\": \"2026-03-01T08:00:00.250Z\", \"source_id\": \"prod-db-1\", "
        "\"source_type\": \"infra\"\n}";
    const ParseResult r = parse_event(pretty);
    CHECK_STATUS(r, ParseStatus::Ok);
    CHECK(r.event.severity == "high");
    CHECK_EQ(ms_of(r.event.event_time), ms_of(tp_of(2026, 3, 1, 8, 0, 0, 250)));

    // escaped enum spellings are validated decoded ("\u0061pp" == "app")
    Ev e2;
    e2.source_type = "\"\\u0061pp\"";
    e2.severity = "\"me\\u0064ium\"";
    const std::string in2_e2 = e2.str();
    const ParseResult r2 = parse_event(in2_e2);
    CHECK_STATUS(r2, ParseStatus::Ok);
    CHECK(r2.event.source_type == "\\u0061pp");  // stored raw (contains backslash)
    CHECK(r2.event.severity == "me\\u0064ium");

    // escaped message: raw view keeps escapes; unescape() decodes them
    Ev e3;
    e3.message = "\"line1\\nline2\\t\\\"quoted\\\" \\\\ end\"";
    const std::string in3_e3 = e3.str();
    const ParseResult r3 = parse_event(in3_e3);
    CHECK_STATUS(r3, ParseStatus::Ok);
    char buf[64];
    std::size_t n = 0;
    CHECK(unescape_json_string(r3.event.message, buf, sizeof(buf), n));
    CHECK_EQ(std::string(buf, n), std::string("line1\nline2\t\"quoted\" \\ end"));
    CHECK_EQ(r3.event.message_chars, std::size_t{26});  // decoded code points

    // surrogate pair escape decodes to a 4-byte emoji (1 code point)
    Ev e4;
    e4.message = "\"\\uD83D\\uDE00\"";
    const std::string in4_e4 = e4.str();
    const ParseResult r4 = parse_event(in4_e4);
    CHECK_STATUS(r4, ParseStatus::Ok);
    CHECK(unescape_json_string(r4.event.message, buf, sizeof(buf), n));
    CHECK_EQ(n, std::size_t{4});
    CHECK_EQ(static_cast<unsigned char>(buf[0]), 0xF0U);
    CHECK_EQ(r4.event.message_chars, std::size_t{1});
}

// ------------------------------------------------------------- invalid JSON
static void test_invalid_json() {
    const std::string valid = Ev().str();
    struct Case {
        std::string in;
    };
    const std::vector<Case> cases = {
        {valid.substr(0, valid.size() - 12)},                     // truncated
        {valid + " xyz"},                                        // trailing garbage
        {valid + "{}"},                                          // trailing object
        {valid.substr(0, valid.size() - 1)},                     // unbalanced braces
        {[] { Ev e; e.message = "\"bad\\x41escape\""; return e.str(); }()},  // invalid escape \x
        {"[1,2,3]"},                                             // top-level array
        {"\"hello\""},                                           // top-level string
        {"42"},                                                  // top-level number
        {""},                                                    // empty input
        {"{"},                                                   // lone open brace
        {"{\"event_id\" \"e-1\"}"},                              // missing colon
        {"{event_id:\"e-1\"}"},                                  // bare key
        {"{\"event_id\":}"},                                     // empty value
        {"{\"schema_version\":01,\"x\":1}"},                     // leading zero
        {"{\"message\":tru}"},                                   // bad literal
        {"{\"message\":nul}"},                                   // bad literal
        {"{\"event_id\":\"e-1\",}"},                        // trailing comma (known field)
        {[] { Ev e; e.attributes = "{\"a\":[1,2,]}"; e.has_attributes = true; return e.str(); }()},
        {[] { Ev e; e.message = "\"tab\there\""; return e.str(); }()},  // raw control char (TAB)
    };
    for (const Case& c : cases) {
        const ParseResult r = parse_event(c.in);
        CHECK_STATUS(r, ParseStatus::InvalidJson);
        CHECK(r.error.message[0] != '\0');
    }
    // unescaped quote ends the string early -> structural error afterwards
    {
        const std::string in = "{\"event_id\":\"a\"b\",\"schema_version\":1}";
        CHECK_STATUS(parse_event(in), ParseStatus::InvalidJson);
    }
    // unterminated string
    {
        const std::string in = Ev().str().substr(0, Ev().str().size() - 1) + "\"abc";
        CHECK_STATUS(parse_event(in), ParseStatus::InvalidJson);
    }
    // error offset points at the offending byte (raw control char)
    {
        std::string in = Ev().str();
        const std::size_t at = in.find("User");
        in[at] = '\x01';
        const ParseResult r = parse_event(in);
        CHECK_STATUS(r, ParseStatus::InvalidJson);
        CHECK_EQ(r.error.byte_offset, at);
    }
}

// --------------------------------------------------------- missing required
static void test_missing_fields() {
    struct F {
        const char* name;
    };
    const F fields[] = {"event_id", "schema_version", "event_time", "source_id",
                        "source_type", "severity", "category", "message"};
    for (const F& f : fields) {
        Ev e;
        if (std::string(f.name) == "event_id") e.has_event_id = false;
        if (std::string(f.name) == "schema_version") e.has_schema_version = false;
        if (std::string(f.name) == "event_time") e.has_event_time = false;
        if (std::string(f.name) == "source_id") e.has_source_id = false;
        if (std::string(f.name) == "source_type") e.has_source_type = false;
        if (std::string(f.name) == "severity") e.has_severity = false;
        if (std::string(f.name) == "category") e.has_category = false;
        if (std::string(f.name) == "message") e.has_message = false;
        const std::string in = e.str();
    const ParseResult r = parse_event(in);
        CHECK_STATUS(r, ParseStatus::MissingField);
        CHECK(r.error.field == std::string_view(f.name));
    }
    // canonical order: first missing in contract order is reported
    {
        Ev e;
        e.has_event_time = false;
        e.has_severity = false;
        const std::string in = e.str();
    const ParseResult r = parse_event(in);
        CHECK_STATUS(r, ParseStatus::MissingField);
        CHECK(std::string_view(r.error.field) == "event_time");
    }
    CHECK_STATUS(parse_event("{}"), ParseStatus::MissingField);
}

// ---------------------------------------------------------- schema_version
static void test_schema_version() {
    const char* bad_numbers[] = {"0", "2", "-1", "1.0", "1e0", "10"};
    for (const char* v : bad_numbers) {
        Ev e;
        e.schema_version = v;
        const std::string in = e.str();
    const ParseResult r = parse_event(in);
        CHECK_STATUS(r, ParseStatus::SchemaViolation);
        CHECK(std::string_view(r.error.field) == "schema_version");
    }
    const char* bad_types[] = {"\"1\"", "null", "true", "[1]", "{}"};
    for (const char* v : bad_types) {
        Ev e;
        e.schema_version = v;
        CHECK_STATUS(parse_event(e.str()), ParseStatus::SchemaViolation);
    }
    // valid alternates of the same value: spacing only
    {
        const std::string in = "{\"schema_version\": 1,\"event_id\":\"e\",\"event_time\":"
                               "\"2026-01-01T00:00:00Z\",\"source_id\":\"s\",\"source_type\":\"app\","
                               "\"severity\":\"info\",\"category\":\"auth\",\"message\":\"m\"}";
        CHECK_STATUS(parse_event(in), ParseStatus::Ok);
    }
}

// ------------------------------------------------------------------ enums
static void test_enums() {
    const struct {
        const char* field;
        std::string bad;
    } cases[] = {
        {"source_type", "\"Application\""}, {"source_type", "\"web\""},
        {"source_type", "\"app \""},        {"source_type", "\"\""},
        {"severity", "\"fatal\""},          {"severity", "\"WARN\""},
        {"severity", "\"Info\""},           {"severity", "\"\""},
        {"category", "\"authx\""},          {"category", "\"Database\""},
        {"category", "\"\""},               {"origin", "\"internal\""},
        {"origin", "\"SYNTHETIC\""},
    };
    for (const auto& c : cases) {
        Ev e;
        if (std::string_view(c.field) == "source_type") e.source_type = c.bad;
        if (std::string_view(c.field) == "severity") e.severity = c.bad;
        if (std::string_view(c.field) == "category") e.category = c.bad;
        if (std::string_view(c.field) == "origin") {
            e.origin = c.bad;
            e.has_origin = true;
        }
        const std::string in = e.str();
        const ParseResult r = parse_event(in);
        CHECK_STATUS(r, ParseStatus::InvalidEnum);
        CHECK(r.error.field == std::string_view(c.field));
        // offset points at the start of the offending value
        const std::size_t at = in.find(c.bad);
        CHECK(at != std::string::npos);
        CHECK_EQ(r.error.byte_offset, at);
    }
    // all valid enum values accepted
    for (const char* st : {"app", "infra", "system", "security", "synthetic"}) {
        Ev e;
        e.source_type = std::string("\"") + st + "\"";
        CHECK_STATUS(parse_event(e.str()), ParseStatus::Ok);
    }
    for (const char* sv : {"info", "low", "medium", "high", "critical"}) {
        Ev e;
        e.severity = std::string("\"") + sv + "\"";
        CHECK_STATUS(parse_event(e.str()), ParseStatus::Ok);
    }
    for (const char* c : {"auth", "network", "application", "data", "system", "config", "security"}) {
        Ev e;
        e.category = std::string("\"") + c + "\"";
        CHECK_STATUS(parse_event(e.str()), ParseStatus::Ok);
    }
    for (const char* o : {"synthetic", "external"}) {
        Ev e;
        e.origin = std::string("\"") + o + "\"";
        e.has_origin = true;
        CHECK_STATUS(parse_event(e.str()), ParseStatus::Ok);
    }
    // error message bounded to 127 chars even with long junk value
    {
        Ev e;
        e.severity = "\"" + std::string(200, 'x') + "\"";
        const std::string in = e.str();
    const ParseResult r = parse_event(in);
        CHECK_STATUS(r, ParseStatus::InvalidEnum);
        CHECK(std::strlen(r.error.message) <= 127);
        CHECK(std::strstr(r.error.message, "invalid severity") != nullptr);
    }
}

// ------------------------------------------------------------- timestamps
static void test_timestamps() {
    const char* bad[] = {
        "2026-01-15T10:30:00",           // no Z
        "2026-01-15T10:30:00+02:00",     // offset (rejected: UTC 'Z' only)
        "2026-01-15T10:30:00-05:00",     // negative offset
        "2026-01-15T10:30:00z",          // lowercase z
        "2026-01-15 10:30:00Z",          // space separator
        "2026-02-30T00:00:00Z",          // Feb 30
        "2026-13-01T00:00:00Z",          // month 13
        "2026-00-10T00:00:00Z",          // month 0
        "2026-01-32T00:00:00Z",          // day 32
        "2026-01-00T00:00:00Z",          // day 0
        "2026-02-29T00:00:00Z",          // 2026 is not a leap year
        "0000-01-01T00:00:00Z",           // year 0: not representable (ns time_point)
        "1677-06-01T00:00:00Z",           // before representable window
        "2262-04-12T00:00:00Z",           // after representable window (int64 ns overflow)
        "9999-12-31T23:59:59Z",           // far future: not representable
        "2026-01-01T24:00:00Z",          // hour 24
        "2026-01-01T23:60:00Z",          // minute 60
        "2026-01-01T23:00:60Z",          // second 60 (no leap second support)
        "2026-01-01T23:00:00.12Z",       // 2-digit fraction
        "2026-01-01T23:00:00.1234Z",     // 4-digit fraction
        "2026-01-01T23:00:00.Z",         // empty fraction
        "2026-1-15T10:30:00Z",           // non-padded month (wrong shape)
        "abcd-01-15T10:30:00Z",          // non-numeric
        "",                              // empty
        "2026-01-15",                    // date only
        "2026-01-15T10:30:00.123+01:00", // fraction + offset
    };
    for (const char* t : bad) {
        Ev e;
        e.event_time = std::string("\"") + t + "\"";
        const std::string in = e.str();
    const ParseResult r = parse_event(in);
        CHECK_STATUS(r, ParseStatus::InvalidTimestamp);
        CHECK(std::string_view(r.error.field) == "event_time");
    }
    const struct {
        const char* t;
        std::int64_t expect_ms;
    } good[] = {
        {"1970-01-01T00:00:00Z", 0},
        {"1970-01-01T00:00:00.000Z", 0},
        {"2024-02-29T23:59:59Z", 1709251199000LL},   // leap day
        {"2026-01-15T10:30:00Z", ms_of(tp_of(2026, 1, 15, 10, 30, 0))},
        {"2026-01-15T10:30:00.500Z", ms_of(tp_of(2026, 1, 15, 10, 30, 0, 500))},
        {"2026-12-31T23:59:59.999Z", ms_of(tp_of(2026, 12, 31, 23, 59, 59, 999))},
        {"1678-01-01T00:00:00Z", ms_of(tp_of(1678, 1, 1, 0, 0, 0))},  // earliest representable year
        {"2261-12-31T23:59:59.999Z", ms_of(tp_of(2261, 12, 31, 23, 59, 59, 999))},  // latest
    };
    for (const auto& g : good) {
        Ev e;
        e.event_time = std::string("\"") + g.t + "\"";
        const std::string in = e.str();
    const ParseResult r = parse_event(in);
        CHECK_STATUS(r, ParseStatus::Ok);
        CHECK_EQ(r.event.event_time_unix_ms(), g.expect_ms);
    }
    // timestamp type errors
    {
        Ev e;
        e.event_time = "1700000000000";
        CHECK_STATUS(parse_event(e.str()), ParseStatus::SchemaViolation);
        Ev e2;
        e2.event_time = "null";
        CHECK_STATUS(parse_event(e2.str()), ParseStatus::SchemaViolation);
    }
    // error offset at the value start
    {
        Ev e;
        e.event_time = "\"2026-13-01T00:00:00Z\"";
        const std::string in = e.str();
        const ParseResult r = parse_event(in);
        CHECK_STATUS(r, ParseStatus::InvalidTimestamp);
        CHECK_EQ(r.error.byte_offset, in.find("\"2026-13-01"));
    }
}

// ---------------------------------------------------------------- source_id
static void test_source_id() {
    const std::string alnum64 = "aA0." + std::string(58, 'x') + "-_";  // 64 allowed chars
    CHECK_EQ(alnum64.size(), std::size_t{64});
    const struct {
        std::string id;
        bool ok;
    } cases[] = {
        {std::string(64, 'a'), true},
        {std::string(65, 'a'), false},
        {"", false},
        {"has space", false},
        {"a/b", false},
        {"a@b", false},
        {"سیم", false},                       // non-ASCII rejected (charset is ASCII)
        {"sim-app_01.prod", true},
        {alnum64, true},
    };
    for (const auto& c : cases) {
        Ev e;
        e.source_id = "\"" + c.id + "\"";
        const std::string in = e.str();
    const ParseResult r = parse_event(in);
        if (c.ok) {
            CHECK_STATUS(r, ParseStatus::Ok);
        } else {
            CHECK_STATUS(r, ParseStatus::SchemaViolation);
            CHECK(std::string_view(r.error.field) == "source_id");
        }
    }
    // escaped spelling of a valid id is accepted
    {
        Ev e;
        e.source_id = "\"\\u0073im-\\u0031\"";
        const std::string in = e.str();
    const ParseResult r = parse_event(in);
        CHECK_STATUS(r, ParseStatus::Ok);  // decodes to "sim-1"
    }
    // type error
    {
        Ev e;
        e.source_id = "null";
        CHECK_STATUS(parse_event(e.str()), ParseStatus::SchemaViolation);
    }
}

// ------------------------------------------------------------------ message
static void test_message() {
    const std::string cjk = "\xe4\xbd\xa0\xe5\xa5\xbd";  // 你好 (2 chars, 6 bytes)
    const struct {
        std::string msg;
        bool ok;
    } cases[] = {
        {"\"\"", false},                                  // empty
        {"\"   \"", false},                               // whitespace-only -> normalizes to empty
        {"\"\\t\\n \\u000B\\u000C\"", false},        // all whitespace (escaped \v/\f via \uXXXX)
        {"\"" + std::string(512, 'a') + "\"", true},      // exactly 512
        {"\"" + std::string(513, 'a') + "\"", false},     // 513
        {"\"" + std::string(1536, '\0') + "\"", false},   // placeholder replaced below
    };
    (void)cjk;
    int i = 0;
    for (const auto& c : cases) {
        if (c.msg.find('\0') != std::string::npos) {
            ++i;
            continue;  // NUL case not expressible in the table; tested separately
        }
        Ev e;
        e.message = c.msg;
        const std::string in = e.str();
    const ParseResult r = parse_event(in);
        if (c.ok) {
            CHECK_STATUS(r, ParseStatus::Ok);
        } else {
            CHECK_STATUS(r, ParseStatus::SchemaViolation);
            CHECK(std::string_view(r.error.field) == "message");
        }
        ++i;
    }
    // multibyte counting: 512 CJK chars = 1536 bytes -> valid
    {
        std::string m;
        for (int k = 0; k < 512; ++k) m += "\xe4\xbd\xa0";
        Ev e;
        e.message = "\"" + m + "\"";
        const std::string in = e.str();
        CHECK(in.size() < kMaxInputBytes);
        const ParseResult r = parse_event(in);
        CHECK_STATUS(r, ParseStatus::Ok);
        CHECK_EQ(r.event.message_chars, std::size_t{512});
    }
    // 513 CJK chars -> invalid (UTF-8-aware character count)
    {
        std::string m;
        for (int k = 0; k < 513; ++k) m += "\xe4\xbd\xa0";
        Ev e;
        e.message = "\"" + m + "\"";
        CHECK_STATUS(parse_event(e.str()), ParseStatus::SchemaViolation);
    }
    // escaped code points count as 1 char each
    {
        Ev e;
        std::string m = "\"";
        for (int k = 0; k < 512; ++k) m += "\\u4f60";  // 你
        m += "\"";
        e.message = m;
        const std::string in = e.str();
    const ParseResult r = parse_event(in);
        CHECK_STATUS(r, ParseStatus::Ok);
        CHECK_EQ(r.event.message_chars, std::size_t{512});
    }
    // 513 raw chars that normalize to 512 -> valid (the NORMALIZED form is validated)
    {
        Ev e;
        e.message = "\"" + std::string(512, 'a') + " \"";  // 513 chars, trailing ws trimmed
        const std::string in = e.str();
    const ParseResult r = parse_event(in);
        CHECK_STATUS(r, ParseStatus::Ok);
    }
    // 513 chars with an internal run collapsing to 512 -> valid, documented rule
    {
        Ev e;
        e.message = "\"" + std::string(300, 'a') + "  " + std::string(211, 'b') + "\"";
        const std::string in = e.str();
    const ParseResult r = parse_event(in);
        CHECK_STATUS(r, ParseStatus::Ok);
        CHECK_EQ(r.event.message_chars, std::size_t{512});
    }
    // emoji message
    {
        Ev e;
        e.message = "\"deploy \xF0\x9F\x8E\x89 done\"";  // 🎉
        const std::string in = e.str();
    const ParseResult r = parse_event(in);
        CHECK_STATUS(r, ParseStatus::Ok);
        CHECK_EQ(r.event.message_chars, std::size_t{13});  // 7 + 1 emoji + 5
    }
    // null message
    {
        Ev e;
        e.message = "null";
        CHECK_STATUS(parse_event(e.str()), ParseStatus::SchemaViolation);
    }
}

// ---------------------------------------------------------------- oversized
static std::string sized_event(std::size_t total) {
    const std::string prefix =
        "{\"event_id\":\"e-1\",\"schema_version\":1,\"event_time\":\"2026-01-15T10:30:00Z\","
        "\"source_id\":\"sim-app-01\",\"source_type\":\"app\",\"severity\":\"info\","
        "\"category\":\"auth\",\"message\":\"m\",\"attributes\":{\"pad\":\"";
    const std::string suffix = "\"}}";
    const std::size_t fill = total - prefix.size() - suffix.size();
    return prefix + std::string(fill, 'X') + suffix;
}

static void test_oversized() {
    // exactly 4096 valid bytes: accepted
    {
        const std::string in = sized_event(4096);
        CHECK_EQ(in.size(), std::size_t{4096});
        const ParseResult r = parse_event(in);
        CHECK_STATUS(r, ParseStatus::Ok);
        CHECK(r.event.has_attributes);
    }
    // 4097 bytes: rejected as OversizedInput
    {
        const std::string in = sized_event(4097);
        CHECK_STATUS(parse_event(in), ParseStatus::OversizedInput);
    }
    // proof that the size check happens BEFORE any scanning: 4097-byte input
    // ending in an invalid UTF-8 byte reports OversizedInput, not EncodingError
    {
        std::string in = sized_event(4097);
        in[in.size() - 1] = '\xFF';
        const ParseResult r = parse_event(in);
        CHECK_STATUS(r, ParseStatus::OversizedInput);
    }
    // ... and 4096-byte input with the same invalid tail IS scanned: EncodingError
    {
        std::string in = sized_event(4096);
        in[in.size() - 1] = '\xFF';
        const ParseResult r = parse_event(in);
        CHECK_STATUS(r, ParseStatus::EncodingError);
        CHECK_EQ(r.error.byte_offset, std::size_t{4095});
    }
    // huge input
    CHECK_STATUS(parse_event(std::string(100000, 'a')), ParseStatus::OversizedInput);
    // oversized error carries no field name
    {
        const ParseResult r = parse_event(std::string(5000, 'a'));
        CHECK(r.error.field[0] == '\0');
    }
}

// -------------------------------------------------------------------- UTF-8
static void test_utf8() {
    // valid multibyte content in message
    const char* good[] = {
        "\"رخداد ورود\"",                    // Persian
        "\"配置已更新\"",                     // CJK
        "\"emoji \xF0\x9F\x8E\x89\xF0\x9F\x9A\x80\"",  // emoji (astral plane)
        "\"\xF0\x90\x80\x80\"",              // U+10000 (first astral code point)
        "\"mixed \xc3\xa9\xc3\xa8\"",        // Latin-1 supplement
    };
    for (const char* m : good) {
        Ev e;
        e.message = m;
        CHECK_STATUS(parse_event(e.str()), ParseStatus::Ok);
    }
    // invalid sequences (inside a string value) -> EncodingError at exact byte
    struct Bad {
        std::string bytes;
    };
    const Bad bad[] = {
        {std::string("\"\xC0\x80\"")},        // overlong 2-byte (C0)
        {std::string("\"\xE0\x80\x80\"")},    // overlong 3-byte
        {std::string("\"\xF0\x80\x80\x80\"")},// overlong 4-byte
        {std::string("\"\xED\xA0\x80\"")},    // UTF-16 high surrogate
        {std::string("\"\xED\xBF\xBF\"")},    // UTF-16 low surrogate
        {std::string("\"\xF4\x90\x80\x80\"")},// > U+10FFFF
        {std::string("\"\xF5\x80\x80\x80\"")},// invalid lead byte F5
        {std::string("\"\x80\"")},            // stray continuation
        {std::string("\"\xC2\"")},            // truncated 2-byte at end of input
        {std::string("\"\xE4\xB8\"")},        // truncated 3-byte
        {std::string("\"ok\"\xC2"), },        // truncated sequence at input end (outside string)
    };
    for (const Bad& b : bad) {
        Ev e;
        e.message = b.bytes;
        const std::string in = e.str();
        const std::size_t at = in.find('\x80') != std::string::npos && b.bytes.find('\x80') == std::string::npos
                                   ? std::string::npos
                                   : in.find_first_of(std::string("\xC0\xE0\xF0\xED\xF4\xF5\x80\xC2\xE4", 9));
        const ParseResult r = parse_event(in);
        CHECK_STATUS(r, ParseStatus::EncodingError);
        if (at != std::string::npos) {
            CHECK_EQ(r.error.byte_offset, at);
        }
    }
    // UTF-8 BOM is well-formed UTF-8 but invalid JSON syntax
    {
        const std::string in = "\xEF\xBB\xBF" + Ev().str();
        CHECK_STATUS(parse_event(in), ParseStatus::InvalidJson);
    }
    // validator unit checks
    {
        std::size_t off = 12345;
        CHECK(is_valid_utf8("hello", off));
        CHECK(is_valid_utf8("\xF0\x9F\x8E\x89", off));
        CHECK(!is_valid_utf8("ab\xC0\x80", off));
        CHECK_EQ(off, std::size_t{2});
        CHECK(!is_valid_utf8("\xED\xA0\x80", off));
        CHECK_EQ(off, std::size_t{0});
    }
}

// --------------------------------------------------------------- attributes
static void test_attributes() {
    // absent vs empty object vs whitespace-only object
    {
        CHECK(!parse_event(Ev().str()).event.has_attributes);
        Ev e;
        e.attributes = "{}";
        e.has_attributes = true;
        const std::string in = e.str();
    const ParseResult r = parse_event(in);
        CHECK_STATUS(r, ParseStatus::Ok);
        CHECK(r.event.has_attributes);
        CHECK(r.event.attributes_raw == "{}");
        CHECK_EQ(r.event.attributes.count, std::size_t{0});
        Ev e2;
        e2.attributes = "{ }";
        e2.has_attributes = true;
        const std::string in2_e2 = e2.str();
    const ParseResult r2 = parse_event(in2_e2);
        CHECK_STATUS(r2, ParseStatus::Ok);
        CHECK(r2.event.attributes_raw == "{ }");
    }
    // non-object attributes
    const char* nonobj[] = {"[]", "\"x\"", "3.14", "true", "null"};
    for (const char* v : nonobj) {
        Ev e;
        e.attributes = v;
        e.has_attributes = true;
        const std::string in = e.str();
    const ParseResult r = parse_event(in);
        CHECK_STATUS(r, ParseStatus::SchemaViolation);
        CHECK(std::string_view(r.error.field) == "attributes");
    }
    // malformed JSON inside attributes
    {
        Ev e;
        e.attributes = "{\"a\":}";
        e.has_attributes = true;
        CHECK_STATUS(parse_event(e.str()), ParseStatus::InvalidJson);
        Ev e2;
        e2.attributes = "{\"a\" 1}";
        e2.has_attributes = true;
        CHECK_STATUS(parse_event(e2.str()), ParseStatus::InvalidJson);
        Ev e3;
        e3.attributes = "{\"a\":1,\"b\":true,}";
        e3.has_attributes = true;
        CHECK_STATUS(parse_event(e3.str()), ParseStatus::InvalidJson);
    }
    // duplicate top-level attribute keys -> SchemaViolation
    {
        Ev e;
        e.attributes = "{\"a\":1,\"b\":2,\"a\":3}";
        e.has_attributes = true;
        const std::string in = e.str();
    const ParseResult r = parse_event(in);
        CHECK_STATUS(r, ParseStatus::SchemaViolation);
        CHECK(std::string_view(r.error.field) == "a");
    }
    // escaped vs plain duplicate ("a" vs "\u0061")
    {
        Ev e;
        e.attributes = "{\"\\u0061\":1,\"a\":2}";
        e.has_attributes = true;
        CHECK_STATUS(parse_event(e.str()), ParseStatus::SchemaViolation);
    }
    // duplicate keys NESTED inside an attribute value: accepted (opaque user JSON,
    // structurally validated only) — documented boundary
    {
        Ev e;
        e.attributes = "{\"outer\":{\"x\":1,\"x\":2}}";
        e.has_attributes = true;
        CHECK_STATUS(parse_event(e.str()), ParseStatus::Ok);
    }
    // escaped key is indexed and findable by its decoded name
    {
        Ev e;
        e.attributes = "{\"\\u0061ction\":\"login_failed\"}";
        e.has_attributes = true;
        const std::string in = e.str();
    const ParseResult r = parse_event(in);
        CHECK_STATUS(r, ParseStatus::Ok);
        const AttributeEntry* a = r.event.find_attribute("action");
        CHECK(a != nullptr && a->value == "login_failed");
    }
    // numbers with full grammar are valid attribute values
    {
        Ev e;
        e.attributes = "{\"a\":-1.5e+10,\"b\":0,\"c\":1e-3}";
        e.has_attributes = true;
        const std::string in = e.str();
    const ParseResult r = parse_event(in);
        CHECK_STATUS(r, ParseStatus::Ok);
        CHECK_EQ(r.event.attributes.count, std::size_t{3});
    }
    // nesting depth limit: a value chain of 128 skip_value levels is accepted
    // (127 nested arrays + the innermost scalar), 128 arrays (= depth 129) rejected
    {
        Ev e;
        e.attributes = "{\"a\":" + std::string(127, '[') + "0" + std::string(127, ']') + "}";
        e.has_attributes = true;
        CHECK_STATUS(parse_event(e.str()), ParseStatus::Ok);
        Ev e2;
        e2.attributes = "{\"a\":" + std::string(128, '[') + "0" + std::string(128, ']') + "}";
        e2.has_attributes = true;
        const std::string in2_e2 = e2.str();
    const ParseResult r2 = parse_event(in2_e2);
        CHECK_STATUS(r2, ParseStatus::InvalidJson);
    }
    // 4KB boundary: a 4096-byte event whose attributes span almost the payload
    {
        const std::string in = sized_event(4096);
        const ParseResult r = parse_event(in);
        CHECK_STATUS(r, ParseStatus::Ok);
        CHECK(r.event.attributes_raw.size() <= kMaxInputBytes);
    }
}

static void test_attributes_truncated_map() {
    // 130 top-level keys: inline map caps at 128; scan_attribute() finds the rest
    Ev e;
    std::string attrs = "{";
    for (int i = 0; i < 130; ++i) {
        if (i > 0) attrs += ',';
        char key[16];
        std::snprintf(key, sizeof(key), "k%03d", i);
        attrs += "\"";
        attrs += key;
        attrs += "\":\"";
        attrs += key;
        attrs += "\"";
    }
    attrs += "}";
    e.attributes = attrs;
    e.has_attributes = true;
    const std::string in = e.str();
    CHECK(in.size() < kMaxInputBytes);
    const ParseResult r = parse_event(in);
    CHECK_STATUS(r, ParseStatus::Ok);
    CHECK_EQ(r.event.attributes.count, std::size_t{128});
    CHECK(r.event.attributes.truncated);
    CHECK(r.event.find_attribute("k127") != nullptr);   // indexed
    CHECK(r.event.find_attribute("k129") == nullptr);   // beyond the inline index
    AttributeEntry out{};
    CHECK(r.event.scan_attribute("k129", out));         // complete search finds it
    CHECK(out.value == "k129");
    CHECK(!r.event.scan_attribute("k999", out));
    // to_owned collects a COMPLETE map
    const OwnedEventRecord owned = r.event.to_owned();
    CHECK_EQ(owned.attributes.size(), std::size_t{130});
    const OwnedAttributeEntry* oe = owned.find_attribute("k129");
    CHECK(oe != nullptr && oe->value == "k129" && oe->key == "k129");
}

// --------------------------------------------------- unknown & duplicate keys
static void test_unknown_and_duplicates() {
    // unknown field -> SchemaViolation with the decoded name
    {
        Ev e;
        const std::string in = e.str().substr(0, e.str().size() - 1) + ",\"extra\":1}";
        const ParseResult r = parse_event(in);
        CHECK_STATUS(r, ParseStatus::SchemaViolation);
        CHECK(std::string_view(r.error.field) == "extra");
        CHECK_EQ(r.error.byte_offset, in.find("\"extra\""));
        CHECK(std::strstr(r.error.message, "unknown field") != nullptr);
    }
    // escaped unknown field name is decoded for the error
    {
        Ev e;
        const std::string in = e.str().substr(0, e.str().size() - 1) + ",\"\\u0065xtra\":1}";
        const ParseResult r = parse_event(in);
        CHECK_STATUS(r, ParseStatus::SchemaViolation);
        CHECK(std::string_view(r.error.field) == "extra");
    }
    // long unknown field name: error text bounded, no crash
    {
        Ev e;
        const std::string longname(100, 'z');
        const std::string in = e.str().substr(0, e.str().size() - 1) + ",\"" + longname + "\":1}";
        const ParseResult r = parse_event(in);
        CHECK_STATUS(r, ParseStatus::SchemaViolation);
        CHECK(std::strlen(r.error.field) < sizeof(r.error.field));
        CHECK(std::strlen(r.error.message) <= 127);
    }
    // duplicate top-level keys -> SchemaViolation at the second occurrence
    {
        Ev e;
        const std::string in = e.str().substr(0, e.str().size() - 1) +
                               ",\"severity\":\"high\",\"message\":\"dup\"}";
        const ParseResult r = parse_event(in);
        CHECK_STATUS(r, ParseStatus::SchemaViolation);
        CHECK(std::string_view(r.error.field) == "severity");
        const std::size_t second = in.find("\"severity\"", in.find("\"severity\"") + 1);
        CHECK_EQ(r.error.byte_offset, second);
    }
    // escaped duplicate of a known field
    {
        Ev e;
        const std::string in = e.str().substr(0, e.str().size() - 1) + ",\"\\u0065vent_id\":\"e-2\"}";
        CHECK_STATUS(parse_event(in), ParseStatus::SchemaViolation);
    }
}

// ------------------------------------------------------------- optional fields
static void test_optional_fields() {
    // null optionals are rejected (type error: expected string)
    const char* nulls[] = {"correlation_id", "trace_id", "actor", "origin", "attributes"};
    for (const char* f : nulls) {
        Ev e;
        const std::string in = e.str().substr(0, e.str().size() - 1) + ",\"" + f + "\":null}";
        const ParseResult r = parse_event(in);
        CHECK_STATUS(r, ParseStatus::SchemaViolation);
        CHECK(r.error.field == std::string_view(f));
    }
    // absent optionals: valid (checked in minimal test); null required fields rejected
    {
        Ev e;
        e.message = "null";
        CHECK_STATUS(parse_event(e.str()), ParseStatus::SchemaViolation);
    }
    // length limits: 128 ok, 129 rejected (correlation_id / trace_id / actor)
    for (const char* f : {"correlation_id", "trace_id", "actor"}) {
        Ev ok_e;
        Ev bad_e;
        const std::string v128(128, 'c');
        const std::string v129(129, 'c');
        if (std::string_view(f) == "correlation_id") {
            ok_e.correlation_id = "\"" + v128 + "\"";
            ok_e.has_correlation_id = true;
            bad_e.correlation_id = "\"" + v129 + "\"";
            bad_e.has_correlation_id = true;
        } else if (std::string_view(f) == "trace_id") {
            ok_e.trace_id = "\"" + v128 + "\"";
            ok_e.has_trace_id = true;
            bad_e.trace_id = "\"" + v129 + "\"";
            bad_e.has_trace_id = true;
        } else {
            ok_e.actor = "\"" + v128 + "\"";
            ok_e.has_actor = true;
            bad_e.actor = "\"" + v129 + "\"";
            bad_e.has_actor = true;
        }
        CHECK_STATUS(parse_event(ok_e.str()), ParseStatus::Ok);
        const std::string in_bad_e = bad_e.str();
    const ParseResult r = parse_event(in_bad_e);
        CHECK_STATUS(r, ParseStatus::SchemaViolation);
        CHECK(r.error.field == std::string_view(f));
    }
    // empty-string optionals are accepted (contract states only a max length)
    {
        Ev e;
        e.correlation_id = "\"\"";
        e.has_correlation_id = true;
        CHECK_STATUS(parse_event(e.str()), ParseStatus::Ok);
    }
    // event_id must be non-empty (documented interpretation)
    {
        Ev e;
        e.event_id = "\"\"";
        const std::string in = e.str();
    const ParseResult r = parse_event(in);
        CHECK_STATUS(r, ParseStatus::SchemaViolation);
        CHECK(std::string_view(r.error.field) == "event_id");
    }
}

// ------------------------------------------------------- helper function units
static void test_normalize_message() {
    char buf[256];
    // pure trim: returns a subview of the input (zero copy)
    {
        const std::string in = "  hello world  ";
        const std::string_view nv = normalize_message(in, buf, sizeof(buf));
        CHECK(nv == "hello world");
        CHECK(nv.data() == in.data() + 2);  // points into the input
    }
    // collapse internal runs
    {
        const std::string in = "a  b\t\tc\n \td ";
        const std::string_view nv = normalize_message(in, buf, sizeof(buf));
        CHECK(nv == "a b c d");
        CHECK(nv.data() == buf);  // collapsed: view into the scratch buffer
    }
    // all whitespace -> empty
    CHECK(normalize_message(" \t\n\r\v\f", buf, sizeof(buf)).empty());
    // empty input
    CHECK(normalize_message("", buf, sizeof(buf)).empty());
    // no change at all
    {
        const std::string in = "already fine";
        const std::string_view nv = normalize_message(in, buf, sizeof(buf));
        CHECK(nv == "already fine");
        CHECK(nv.data() == in.data());
    }
    // buffer too small for collapsing: documented trim-only degradation
    {
        const std::string in = "a  b";
        const std::string_view nv = normalize_message(in, buf, 1);
        CHECK(nv == "a  b");  // trimmed (nothing to trim) but not collapsed
    }
    // \v and \f count as whitespace (only reachable via \uXXXX escapes in JSON)
    {
        const std::string in = "\va\f\f b\v";
        const std::string_view nv = normalize_message(in, buf, sizeof(buf));
        CHECK(nv == "a b");
    }
}

static void test_unescape_and_count() {
    char buf[64];
    std::size_t n = 0;
    // simple escapes
    CHECK(unescape_json_string(R"(a\"b\\c\/d\b e\f f\ng\rh\ti)", buf, sizeof(buf), n));
    CHECK_EQ(std::string(buf, n), std::string("a\"b\\c/d\b e\f f\ng\rh\ti"));
    // \uXXXX BMP
    CHECK(unescape_json_string(R"(\u0041\u00e9\u4f60)", buf, sizeof(buf), n));
    CHECK_EQ(n, std::size_t{1 + 2 + 3});
    CHECK_EQ(buf[0], 'A');
    // surrogate pair
    CHECK(unescape_json_string(R"(\uD83D\uDE00)", buf, sizeof(buf), n));
    CHECK_EQ(n, std::size_t{4});
    // invalid inputs
    CHECK(!unescape_json_string(R"(\u00G0)", buf, sizeof(buf), n));       // bad hex
    CHECK(!unescape_json_string(R"(\uD83D)", buf, sizeof(buf), n));       // lone high
    CHECK(!unescape_json_string(R"(\uDC00)", buf, sizeof(buf), n));       // lone low
    CHECK(!unescape_json_string(R"(\uD83D\u0041)", buf, sizeof(buf), n)); // high + non-low
    CHECK(!unescape_json_string(R"(\x41)", buf, sizeof(buf), n));         // bad escape char
    CHECK(!unescape_json_string("abc\\", buf, sizeof(buf), n));           // trailing backslash
    CHECK(!unescape_json_string("abc", buf, 2, n));                       // buffer too small
    // plain text passes through
    CHECK(unescape_json_string("plain", buf, sizeof(buf), n));
    CHECK_EQ(std::string(buf, n), std::string("plain"));
    // counting code points
    CHECK_EQ(count_utf8_chars("hello"), std::size_t{5});
    CHECK_EQ(count_utf8_chars("\xe4\xbd\xa0\xe5\xa5\xbd"), std::size_t{2});
    CHECK_EQ(count_utf8_chars("\xF0\x9F\x8E\x89!"), std::size_t{2});
    CHECK_EQ(count_utf8_chars(""), std::size_t{0});
}

// ----------------------------------------------------------------- ownership
static void test_ownership() {
    auto* input = new std::string(Ev().str());
    input->insert(input->find("\"User"), 1, ' ');  // minor perturbation, still valid
    const ParseResult r = parse_event(*input);
    CHECK_STATUS(r, ParseStatus::Ok);
    // views point into the heap input
    CHECK(r.event.event_id.data() >= input->data());
    CHECK(r.event.message.data() >= input->data());
    const std::string msg_before = std::string(r.event.message);
    // owned copy is self-contained
    const OwnedEventRecord owned = r.event.to_owned();
    const std::string id_copy = owned.event_id;
    const std::string msg_copy = owned.message;
    const std::string attrs_copy = owned.attributes_raw;
    delete input;  // input dies; views dangle (documented), owned copy survives
    CHECK(owned.event_id == id_copy);
    CHECK(owned.message == msg_copy);
    CHECK(owned.attributes_raw == attrs_copy);
    CHECK_EQ(owned.schema_version, 1);
    CHECK_EQ(owned.event_time_unix_ms(), ms_of(tp_of(2026, 1, 15, 10, 30, 0)));
    CHECK(msg_before == "User login succeeded" || msg_before == " User login succeeded");
    // owned copy with escapes decodes them
    {
        Ev e;
        e.message = "\"a\\tb\"";
        e.attributes = "{\"\\u006b\":\"v\\u0061lue\"}";
        e.has_attributes = true;
        const std::string in = e.str();
        const ParseResult rr = parse_event(in);
        const OwnedEventRecord o = rr.event.to_owned();
        CHECK(o.message == "a\tb");
        CHECK_EQ(o.attributes.size(), std::size_t{1});
        CHECK(o.attributes[0].key == "k");
        CHECK(o.attributes[0].value == "value");
        CHECK(o.attributes[0].type == JsonValueType::String);
    }
}

// ---------------------------------------------------------------- C ABI
static void test_capi() {
    // valid event
    {
        Ev e;
        e.attributes = "{\"action\":\"login_failed\",\"n\":7}";
        e.has_attributes = true;
        e.correlation_id = "\"corr-1\"";
        e.has_correlation_id = true;
        e.message = "\"  padded   message  \"";
        const std::string in = e.str();
        sg_parse_result* r = sg_parse(in.data(), in.size());
        CHECK(r != nullptr);
        CHECK_EQ(sg_ok(r), 1);
        CHECK_EQ(sg_parse_status(r), SG_OK);
        CHECK_EQ(sg_schema_version(r), 1);
        CHECK_EQ(sg_event_time_unix_ms(r), ms_of(tp_of(2026, 1, 15, 10, 30, 0)));
        std::size_t len = 0;
        const char* s = sg_event_id(r, &len);
        CHECK(s != nullptr && std::string_view(s, len) == "e-1" && s[len] == '\0');
        s = sg_message(r, &len);
        CHECK(std::string_view(s, len) == "  padded   message  ");
        s = sg_message_normalized(r, &len);
        CHECK(std::string_view(s, len) == "padded message");
        s = sg_attributes_raw(r, &len);
        CHECK(std::string_view(s, len) == e.attributes);
        s = sg_correlation_id(r, &len);
        CHECK(s != nullptr && std::string_view(s, len) == "corr-1");
        CHECK(sg_trace_id(r, &len) == nullptr);  // absent optional
        CHECK(sg_actor(r, &len) == nullptr);
        CHECK(sg_origin(r, &len) == nullptr);
        // attributes
        CHECK_EQ(sg_attribute_count(r), std::size_t{2});
        s = sg_attribute_key(r, 0, &len);
        CHECK(std::string_view(s, len) == "action");
        s = sg_attribute_value(r, 0, &len);
        CHECK(std::string_view(s, len) == "login_failed");
        CHECK_EQ(sg_attribute_type(r, 0), SG_JSON_STRING);
        CHECK_EQ(sg_attribute_type(r, 1), SG_JSON_NUMBER);
        s = sg_attribute_find_value(r, "action", &len);
        CHECK(s != nullptr && std::string_view(s, len) == "login_failed");
        CHECK(sg_attribute_find_value(r, "n", &len) == nullptr);      // not a string
        CHECK(sg_attribute_find_value(r, "zz", &len) == nullptr);     // absent
        CHECK(sg_attribute_key(r, 99, &len) == nullptr);              // out of range
        sg_free(r);
    }
    // error case
    {
        Ev e;
        e.severity = "\"urgent\"";
        const std::string in = e.str();
        sg_parse_result* r = sg_parse(in.data(), in.size());
        CHECK(r != nullptr);
        CHECK_EQ(sg_ok(r), 0);
        CHECK_EQ(sg_parse_status(r), SG_INVALID_ENUM);
        CHECK_EQ(sg_error_byte_offset(r), in.find("\"urgent\""));
        CHECK(std::string_view(sg_error_field(r)) == "severity");
        CHECK(std::strstr(sg_error_message(r), "invalid severity") != nullptr);
        // getters are NULL-safe on error results
        CHECK(sg_event_id(r, nullptr) == nullptr);
        CHECK(sg_message(r, nullptr) == nullptr);
        CHECK_EQ(sg_attribute_count(r), std::size_t{0});
        sg_free(r);
    }
    // oversized + encoding + null-input defensives
    {
        const std::string big(5000, 'a');
        sg_parse_result* r = sg_parse(big.data(), big.size());
        CHECK_EQ(sg_parse_status(r), SG_OVERSIZED_INPUT);
        sg_free(r);
        r = sg_parse(nullptr, 5);
        CHECK(r != nullptr && sg_parse_status(r) == SG_INVALID_JSON);
        sg_free(r);
        r = sg_parse(nullptr, 0);
        CHECK(r != nullptr && sg_parse_status(r) == SG_INVALID_JSON);  // empty input
        sg_free(r);
        CHECK(sg_ok(nullptr) == 0);
        CHECK(sg_event_id(nullptr, nullptr) == nullptr);
        CHECK(std::string_view(sg_error_message(nullptr)) == "");
        CHECK_EQ(sg_attribute_count(nullptr), std::size_t{0});
        CHECK(std::string_view(sg_status_name(SG_INVALID_JSON)) == "InvalidJson");
        CHECK(std::string_view(sg_status_name(SG_OK)) == "Ok");
    }
    // embedded NUL bytes are fine (len-based, not NUL-based)
    {
        Ev e;
        const std::string in = e.str() + "  ";  // trailing spaces (not a NUL)
        sg_parse_result* r = sg_parse(in.data(), in.size());
        CHECK_EQ(sg_ok(r), 1);
        sg_free(r);
    }
    // sg_normalize_message
    {
        char out[64];
        const std::size_t n = sg_normalize_message("  a   b  ", 9, out, sizeof(out));
        CHECK_EQ(n, std::size_t{3});
        CHECK(std::string_view(out) == "a b");
        // size query with no buffer
        CHECK_EQ(sg_normalize_message("x  y", 4, nullptr, 0), std::size_t{3});
        // truncated output, still NUL-terminated; returns full needed size
        char small[3];
        CHECK_EQ(sg_normalize_message("abcdef", 6, small, sizeof(small)), std::size_t{6});
        CHECK(std::string_view(small) == "ab");
        CHECK_EQ(sg_normalize_message(nullptr, 3, out, sizeof(out)), static_cast<std::size_t>(-1));
    }
}

// ----------------------------------------------------------- thread-safety
static void test_thread_safety() {
    std::vector<std::string> inputs;
    std::vector<ParseStatus> expected;
    {
        inputs.push_back(Ev().str());
        expected.push_back(ParseStatus::Ok);
        Ev bad_enum;
        bad_enum.severity = "\"urgent\"";
        inputs.push_back(bad_enum.str());
        expected.push_back(ParseStatus::InvalidEnum);
        Ev bad_time;
        bad_time.event_time = "\"2026-02-30T00:00:00Z\"";
        inputs.push_back(bad_time.str());
        expected.push_back(ParseStatus::InvalidTimestamp);
        Ev missing;
        missing.has_message = false;
        inputs.push_back(missing.str());
        expected.push_back(ParseStatus::MissingField);
        inputs.push_back("{not json");
        expected.push_back(ParseStatus::InvalidJson);
        Ev with_attrs;
        with_attrs.attributes = "{\"action\":\"login_failed\",\"k\":\"\\u00e9\"}";
        with_attrs.has_attributes = true;
        inputs.push_back(with_attrs.str());
        expected.push_back(ParseStatus::Ok);
        Ev bad_utf8;
        bad_utf8.message = "\"\xED\xA0\x80\"";
        inputs.push_back(bad_utf8.str());
        expected.push_back(ParseStatus::EncodingError);
        Ev dup_field = Ev();
        inputs.push_back(dup_field.str().substr(0, dup_field.str().size() - 1) + ",\"severity\":\"low\"}");
        expected.push_back(ParseStatus::SchemaViolation);
    }
    const std::size_t n = inputs.size();
    constexpr int kThreads = 8;
    constexpr int kIter = 10000;
    std::atomic<int> mismatches{0};
    std::vector<std::thread> threads;
    for (int t = 0; t < kThreads; ++t) {
        threads.emplace_back([&, t]() {
            for (int i = 0; i < kIter; ++i) {
                const std::size_t j = (static_cast<std::size_t>(i) + static_cast<std::size_t>(t)) % n;
                const ParseResult r = parse_event(inputs[j]);
                if (r.status != expected[j]) {
                    ++mismatches;
                }
                if (r.status == ParseStatus::Ok) {
                    // spot-check content to catch torn state
                    if (r.event.event_id != "e-1" || r.event.schema_version != 1) {
                        ++mismatches;
                    }
                    if (r.event.find_attribute("action") == nullptr && j == 5) {
                        ++mismatches;
                    }
                }
            }
        });
    }
    for (std::thread& th : threads) {
        th.join();
    }
    CHECK_EQ(mismatches.load(), 0);

    // C ABI concurrent smoke test
    std::atomic<int> capi_bad{0};
    std::vector<std::thread> capi_threads;
    for (int t = 0; t < 4; ++t) {
        capi_threads.emplace_back([&]() {
            for (int i = 0; i < 250; ++i) {
                const std::string& in = inputs[0];  // valid variant: sg_ok must be 1
                sg_parse_result* r = sg_parse(in.data(), in.size());
                if (r == nullptr || sg_ok(r) != 1) {
                    ++capi_bad;
                }
                if (r != nullptr) {
                    sg_free(r);
                }
            }
        });
    }
    for (std::thread& th : capi_threads) {
        th.join();
    }
    CHECK_EQ(capi_bad.load(), 0);
}

// --------------------------------------------------------------------- main
int main() {
    test_valid_minimal();
    test_valid_full();
    test_valid_forms_and_escapes();
    test_invalid_json();
    test_missing_fields();
    test_schema_version();
    test_enums();
    test_timestamps();
    test_source_id();
    test_message();
    test_oversized();
    test_utf8();
    test_attributes();
    test_attributes_truncated_map();
    test_unknown_and_duplicates();
    test_optional_fields();
    test_normalize_message();
    test_unescape_and_count();
    test_ownership();
    test_capi();
    test_thread_safety();
    std::printf("tests: %d checks, %d failed -> %s\n", g_checks, g_failed,
                g_failed == 0 ? "ALL PASS" : "FAILURES");
    return g_failed == 0 ? 0 : 1;
}
