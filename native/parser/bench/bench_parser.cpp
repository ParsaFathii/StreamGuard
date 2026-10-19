// Copyright © 2026 Parsa Fathi — Apache-2.0
// SPDX-License-Identifier: Apache-2.0
//
// StreamGuard native parser benchmark.
//
// Deterministic corpus (fixed seed, splitmix64): 10,000 valid events sized
// ~300B..4KB plus 2,000 invalid events of mixed failure classes. Measures full
// parse+validate throughput and per-event latency (median/p95), and compares
// against an honest BASELINE: a naive substring field extractor that finds
// top-level fields without any validation (no UTF-8 pass, no enum/timestamp/
// length checks, no escape handling, accepts garbage). The baseline is the
// floor of any "just find the fields" implementation, NOT an equal-quality
// parser.
//
// Methodology: 5 runs; each run does (a) one throughput pass (whole-corpus
// wall clock, no per-event clock) and (b) one latency pass (steady_clock
// around each event; clock-read overhead is included in the ns figures).
// events_per_sec is the median across runs; p95_ns / median_ns are the medians
// of the per-run percentiles. Output lines are machine-readable:
//   BENCH parse_full events_per_sec=... p95_ns=... median_ns=...
//   BENCH parse_baseline events_per_sec=... p95_ns=... median_ns=...

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <string>
#include <string_view>
#include <vector>

#include "streamguard/parser.hpp"

using namespace sg::parser;

namespace {

// ------------------------------------------------------------ deterministic RNG
struct Rng {
    std::uint64_t s;
    explicit Rng(std::uint64_t seed) : s(seed) {}
    std::uint64_t next() {
        s += 0x9E3779B97F4A7C15ULL;
        std::uint64_t z = s;
        z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
        z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
        return z ^ (z >> 31);
    }
    std::uint32_t below(std::uint32_t n) { return static_cast<std::uint32_t>(next() % n); }
};

// ------------------------------------------------------------------- corpus
enum class Kind { Valid, BadEnum, BadTime, MissingSeverity, TruncJson, BadUtf8, UnknownField, Oversized };

const char* const kSev[] = {"info", "low", "medium", "high", "critical"};
const char* const kCat[] = {"auth", "network", "application", "data", "system", "config", "security"};
const char* const kSty[] = {"app", "infra", "system", "security", "synthetic"};

std::string pad_str(std::size_t n) { return std::string(n, 'x'); }

std::string make_event(Rng& rng, Kind kind) {
    static int seq = 0;
    ++seq;
    const std::uint32_t target = 300 + rng.below(3797);  // ~300..4096 bytes

    char time_buf[32];
    const unsigned mo = 1 + rng.below(12);
    const unsigned da = 1 + rng.below(28);
    std::snprintf(time_buf, sizeof(time_buf), "2026-%02u-%02uT%02u:%02u:%02u.000Z", mo, da,
                  rng.below(24), rng.below(60), rng.below(60));

    std::string src = "sim-";
    src += kSty[rng.below(5)];
    src += "-0";
    src += static_cast<char>('1' + static_cast<int>(rng.below(8)));

    std::string msg = "event ";
    msg += std::to_string(seq);
    msg += " ";
    msg += kSev[rng.below(5)];
    msg += " on ";
    msg += src;
    while (msg.size() < 40 + rng.below(60)) {
        msg += " payload text";
    }
    if (kind == Kind::BadUtf8) {
        msg += " \xED\xA0\x80 seq";  // lone-surrogate encoding: invalid UTF-8
    }

    std::string body = "\"event_id\":\"bench-" + std::to_string(seq) +
                       "\",\"schema_version\":1,\"event_time\":\"" + time_buf + "\"";
    if (kind != Kind::MissingSeverity) {
        body += ",\"severity\":\"" + std::string(kind == Kind::BadEnum ? "urgent" : kSev[rng.below(5)]) +
                "\"";
    }
    body += ",\"source_id\":\"" + src + "\",\"source_type\":\"" + kSty[rng.below(5)] +
            "\",\"category\":\"" + kCat[rng.below(7)] + "\",\"message\":\"" + msg +
            "\",\"correlation_id\":\"corr-" + std::to_string(rng.below(1000)) + "\"";

    std::string attrs = "{\"action\":\"tick\",\"seq\":" + std::to_string(seq);
    if (rng.below(2) == 0) {
        attrs += ",\"meta\":{\"region\":\"eu-1\",\"az\":2,\"tags\":[\"a\",\"b\"]}";
    }
    if (rng.below(3) == 0) {
        attrs += ",\"latency_ms\":" + std::to_string(rng.below(900));
    }
    attrs += ",\"pad\":\"" + pad_str(16);

    std::string event = "{" + body + ",\"attributes\":" + attrs;
    // size tuning: grow the pad so the final event approximates `target`
    const std::size_t closing = 3;  // '"}}'
    const std::size_t have = event.size() + closing;
    if (kind == Kind::Oversized) {
        const std::size_t want = 4097 + rng.below(200);
        if (want > have) {
            event += pad_str(want - have);
        }
    } else if (static_cast<std::size_t>(target) > have) {
        event += pad_str(static_cast<std::size_t>(target) - have);
    }
    event += "\"}}";

    if (kind == Kind::BadTime) {
        const std::size_t p = event.find("\"event_time\":\"") + 15;
        event.replace(p, 24, "2026-13-40T99:99:99Z");  // invalid calendar + hour
    }
    if (kind == Kind::UnknownField) {
        event.insert(event.size() - 1, ",\"extra_field\":123");
    }
    if (kind == Kind::TruncJson) {
        event.resize(event.size() * 3 / 5);
    }
    return event;
}

// ------------------------------------------------------- naive baseline scan
// The honest baseline: finds top-level fields by substring search with zero
// validation. It accepts garbage the real parser rejects; it only measures
// the cost of locating field values in the buffer.
struct BaselineRecord {
    std::string_view event_id, schema_version, event_time, source_id, source_type, severity, category,
        message;
};

void baseline_scan(std::string_view in, const std::vector<std::string>& patterns, BaselineRecord& out) {
    std::string_view* const fields[] = {&out.event_id,  &out.schema_version, &out.event_time,
                                        &out.source_id, &out.source_type,    &out.severity,
                                        &out.category,  &out.message};
    for (std::size_t i = 0; i < patterns.size(); ++i) {
        std::size_t p = in.find(patterns[i]);
        if (p == std::string_view::npos) {
            *fields[i] = {};
            continue;
        }
        p += patterns[i].size();
        while (p < in.size() && (in[p] == ' ' || in[p] == ':')) {
            ++p;
        }
        if (p < in.size() && in[p] == '"') {
            const std::size_t q = in.find('"', p + 1);
            *fields[i] = (q == std::string_view::npos) ? std::string_view{} : in.substr(p + 1, q - p - 1);
        } else {
            std::size_t q = p;
            while (q < in.size() && in[q] != ',' && in[q] != '}') {
                ++q;
            }
            *fields[i] = in.substr(p, q - p);
        }
    }
}

double median_of(std::vector<double> v) {
    std::sort(v.begin(), v.end());
    return v.empty() ? 0.0 : v[v.size() / 2];
}

}  // namespace

int main() {
    Rng rng(0xC0FFEEULL);
    std::vector<std::string> corpus;
    corpus.reserve(12000);
    for (int i = 0; i < 10000; ++i) {
        corpus.push_back(make_event(rng, Kind::Valid));
    }
    for (int i = 0; i < 500; ++i) corpus.push_back(make_event(rng, Kind::BadEnum));
    for (int i = 0; i < 400; ++i) corpus.push_back(make_event(rng, Kind::BadTime));
    for (int i = 0; i < 300; ++i) corpus.push_back(make_event(rng, Kind::MissingSeverity));
    for (int i = 0; i < 300; ++i) corpus.push_back(make_event(rng, Kind::TruncJson));
    for (int i = 0; i < 200; ++i) corpus.push_back(make_event(rng, Kind::BadUtf8));
    for (int i = 0; i < 200; ++i) corpus.push_back(make_event(rng, Kind::Oversized));
    for (int i = 0; i < 100; ++i) corpus.push_back(make_event(rng, Kind::UnknownField));

    std::size_t bytes_min = corpus[0].size();
    std::size_t bytes_max = 0;
    std::size_t bytes_sum = 0;
    for (const std::string& e : corpus) {
        bytes_min = e.size() < bytes_min ? e.size() : bytes_min;
        bytes_max = e.size() > bytes_max ? e.size() : bytes_max;
        bytes_sum += e.size();
    }
    std::printf("BENCH corpus events=%zu valid=10000 invalid=2000 bytes_min=%zu bytes_max=%zu "
                "bytes_mean=%zu\n",
                corpus.size(), bytes_min, bytes_max, bytes_sum / corpus.size());

    using Clock = std::chrono::steady_clock;

    // warmup (2 passes): caches, branch predictors
    for (int w = 0; w < 2; ++w) {
        std::uint64_t sink = 0;
        for (const std::string& e : corpus) {
            sink += static_cast<std::uint64_t>(parse_event(e).status);
        }
        if (sink == 0xFFFFFFFFFFFFFFFFULL) {
            std::printf(" ");  // keeps the pure calls observable
        }
    }

    // ---- full parse+validate ----
    std::vector<double> eps_runs;
    std::vector<double> p95_runs;
    std::vector<double> med_runs;
    for (int run = 0; run < 5; ++run) {
        std::uint64_t sink = 0;
        const auto t0 = Clock::now();
        for (const std::string& e : corpus) {
            sink += static_cast<std::uint64_t>(parse_event(e).status);
        }
        const auto t1 = Clock::now();
        if (sink == 0xFFFFFFFFFFFFFFFFULL) {
            std::printf(" ");
        }
        const double secs = std::chrono::duration<double>(t1 - t0).count();
        eps_runs.push_back(static_cast<double>(corpus.size()) / secs);

        std::vector<double> ns;
        ns.reserve(corpus.size());
        for (const std::string& e : corpus) {
            const auto s0 = Clock::now();
            const ParseResult r = parse_event(e);
            const auto s1 = Clock::now();
            if (r.status == ParseStatus::Ok && r.event.schema_version != 1) {
                std::printf(" ");  // never true; keeps results observable
            }
            ns.push_back(std::chrono::duration<double, std::nano>(s1 - s0).count());
        }
        std::sort(ns.begin(), ns.end());
        med_runs.push_back(ns[ns.size() / 2]);
        p95_runs.push_back(ns[(ns.size() * 95) / 100]);
    }
    std::printf("BENCH parse_full events_per_sec=%.0f p95_ns=%.0f median_ns=%.0f\n",
                median_of(eps_runs), median_of(p95_runs), median_of(med_runs));

    // ---- baseline: naive substring field extraction ----
    std::vector<std::string> patterns;
    for (const char* f : {"event_id", "schema_version", "event_time", "source_id", "source_type",
                          "severity", "category", "message"}) {
        patterns.push_back(std::string("\"") + f + "\"");
    }
    for (int w = 0; w < 2; ++w) {
        std::size_t sink2 = 0;
        for (const std::string& e : corpus) {
            BaselineRecord b;
            baseline_scan(e, patterns, b);
            sink2 += b.event_id.size() + b.severity.size();
        }
        if (sink2 == 1) {
            std::printf(" ");
        }
    }
    eps_runs.clear();
    p95_runs.clear();
    med_runs.clear();
    for (int run = 0; run < 5; ++run) {
        std::size_t sink2 = 0;
        const auto t0 = Clock::now();
        for (const std::string& e : corpus) {
            BaselineRecord b;
            baseline_scan(e, patterns, b);
            sink2 += b.event_id.size() + b.severity.size();
        }
        const auto t1 = Clock::now();
        if (sink2 == 1) {
            std::printf(" ");
        }
        const double secs = std::chrono::duration<double>(t1 - t0).count();
        eps_runs.push_back(static_cast<double>(corpus.size()) / secs);

        std::vector<double> ns;
        ns.reserve(corpus.size());
        for (const std::string& e : corpus) {
            const auto s0 = Clock::now();
            BaselineRecord b;
            baseline_scan(e, patterns, b);
            const auto s1 = Clock::now();
            ns.push_back(std::chrono::duration<double, std::nano>(s1 - s0).count());
        }
        std::sort(ns.begin(), ns.end());
        med_runs.push_back(ns[ns.size() / 2]);
        p95_runs.push_back(ns[(ns.size() * 95) / 100]);
    }
    std::printf("BENCH parse_baseline events_per_sec=%.0f p95_ns=%.0f median_ns=%.0f\n",
                median_of(eps_runs), median_of(p95_runs), median_of(med_runs));
    return 0;
}
