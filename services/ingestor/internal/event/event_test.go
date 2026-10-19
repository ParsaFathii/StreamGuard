// Copyright © 2026 Parsa Fathi — Apache-2.0

package event

import (
        "encoding/json"
        "fmt"
        "strings"
        "testing"
        "time"
)

var now = time.Date(2026, 1, 15, 12, 0, 0, 0, time.UTC)

func validJSON() string {
        return `{
                "event_id": "9f0c2d1e-1111-4000-8000-abcdefabcdef",
                "schema_version": 1,
                "event_time": "2026-01-15T11:59:30.000Z",
                "source_id": "sim-app-01",
                "source_type": "app",
                "severity": "low",
                "category": "auth",
                "message": "login failed for user",
                "attributes": {"action": "login_failed", "error": true},
                "correlation_id": "corr-1",
                "trace_id": "trace-1",
                "actor": "attacker@example.com"
        }`
}

func TestDecodeValid(t *testing.T) {
        ev, rej := Decode([]byte(validJSON()), now)
        if rej != nil {
                t.Fatalf("unexpected rejection: %+v", rej)
        }
        if ev.EventID != "9f0c2d1e-1111-4000-8000-abcdefabcdef" || ev.SchemaVersion != 1 ||
                ev.SourceID != "sim-app-01" || ev.SourceType != "app" || ev.Severity != "low" ||
                ev.Category != "auth" || ev.Message != "login failed for user" ||
                ev.Attr("action") != "login_failed" || ev.CorrelationID != "corr-1" ||
                ev.TraceID != "trace-1" || ev.Actor != "attacker@example.com" {
                t.Fatalf("bad decode: %+v", ev)
        }
        if !ev.EventTime.Equal(time.Date(2026, 1, 15, 11, 59, 30, 0, time.UTC)) {
                t.Fatalf("bad event_time: %v", ev.EventTime)
        }
}

func TestDecodeMinimal(t *testing.T) {
        min := `{"event_id":"e1","schema_version":1,"event_time":"2026-01-15T12:00:00Z","source_id":"s","source_type":"system","severity":"info","category":"system","message":"ok"}`
        ev, rej := Decode([]byte(min), now)
        if rej != nil {
                t.Fatalf("unexpected rejection: %+v", rej)
        }
        if ev.Attributes != nil {
                t.Fatalf("attributes should be nil when absent")
        }
        if ev.Attr("anything") != "" {
                t.Fatalf("Attr on nil map should be empty")
        }
}

func TestDecodeRejectMatrix(t *testing.T) {
        base := func(mutate func(map[string]any)) string {
                var m map[string]any
                if err := json.Unmarshal([]byte(validJSON()), &m); err != nil {
                        t.Fatal(err)
                }
                mutate(m)
                b, _ := json.Marshal(m)
                return string(b)
        }
        drop := func(m map[string]any, k string) { delete(m, k) }
        cases := []struct {
                name string
                in   string
                code string
        }{
                {"malformed json", `{"event_id":`, "INVALID_JSON"},
                {"not an object", `["array"]`, "INVALID_JSON"},
                {"unknown field", base(func(m map[string]any) { m["unexpected_field"] = 1 }), "INVALID_JSON"},
                {"missing event_id", base(func(m map[string]any) { drop(m, "event_id") }), "MISSING_FIELD"},
                {"missing schema_version", base(func(m map[string]any) { drop(m, "schema_version") }), "MISSING_FIELD"},
                {"schema_version 2", base(func(m map[string]any) { m["schema_version"] = 2 }), "BAD_SCHEMA_VERSION"},
                {"schema_version wrong type", base(func(m map[string]any) { m["schema_version"] = "1" }), "INVALID_JSON"},
                {"missing event_time", base(func(m map[string]any) { drop(m, "event_time") }), "MISSING_FIELD"},
                {"bad timestamp", base(func(m map[string]any) { m["event_time"] = "2026/01/15 12:00" }), "BAD_TIMESTAMP"},
                {"timestamp not iso", base(func(m map[string]any) { m["event_time"] = "yesterday" }), "BAD_TIMESTAMP"},
                {"missing source_id", base(func(m map[string]any) { drop(m, "source_id") }), "MISSING_FIELD"},
                {"source_id bad chars", base(func(m map[string]any) { m["source_id"] = "src with space!" }), "BAD_SOURCE_ID"},
                {"source_id too long", base(func(m map[string]any) { m["source_id"] = strings.Repeat("a", 65) }), "BAD_SOURCE_ID"},
                {"missing source_type", base(func(m map[string]any) { drop(m, "source_type") }), "MISSING_FIELD"},
                {"bad source_type", base(func(m map[string]any) { m["source_type"] = "iot" }), "BAD_SOURCE_TYPE"},
                {"missing severity", base(func(m map[string]any) { drop(m, "severity") }), "MISSING_FIELD"},
                {"bad severity", base(func(m map[string]any) { m["severity"] = "extreme" }), "BAD_SEVERITY"},
                {"missing category", base(func(m map[string]any) { drop(m, "category") }), "MISSING_FIELD"},
                {"bad category", base(func(m map[string]any) { m["category"] = "weird" }), "BAD_CATEGORY"},
                {"missing message", base(func(m map[string]any) { drop(m, "message") }), "MISSING_FIELD"},
                {"empty message", base(func(m map[string]any) { m["message"] = "" }), "MISSING_FIELD"},
                {"whitespace-only message", base(func(m map[string]any) { m["message"] = "   \t " }), "BAD_MESSAGE"},
                {"message too long", base(func(m map[string]any) { m["message"] = strings.Repeat("x", 513) }), "BAD_MESSAGE"},
                {"correlation_id too long", base(func(m map[string]any) { m["correlation_id"] = strings.Repeat("c", 129) }), "FIELD_TOO_LONG"},
                {"trace_id too long", base(func(m map[string]any) { m["trace_id"] = strings.Repeat("t", 129) }), "FIELD_TOO_LONG"},
                {"actor too long", base(func(m map[string]any) { m["actor"] = strings.Repeat("a", 129) }), "FIELD_TOO_LONG"},
                {"attributes not object", base(func(m map[string]any) { m["attributes"] = []string{"a"} }), "BAD_ATTRIBUTES"},
                {"attributes string", base(func(m map[string]any) { m["attributes"] = "nope" }), "BAD_ATTRIBUTES"},
        }
        for _, tc := range cases {
                t.Run(tc.name, func(t *testing.T) {
                        _, rej := Decode([]byte(tc.in), now)
                        if rej == nil {
                                t.Fatalf("expected rejection %s, got valid", tc.code)
                        }
                        if rej.Code != tc.code {
                                t.Fatalf("code = %s (%s), want %s", rej.Code, rej.Message, tc.code)
                        }
                })
        }
}

func TestDecodeFutureSkew(t *testing.T) {
        cases := []struct {
                offset time.Duration
                code   string
        }{
                {9 * time.Minute, ""},                    // allowed skew
                {10*time.Minute - time.Second, ""},       // just inside
                {10*time.Minute + time.Second, "FUTURE_TIMESTAMP"},
                {time.Hour, "FUTURE_TIMESTAMP"},
        }
        for _, tc := range cases {
                ts := now.Add(tc.offset).Format("2006-01-02T15:04:05.000Z")
                body := fmt.Sprintf(`{"event_id":"e","schema_version":1,"event_time":%q,"source_id":"s","source_type":"app","severity":"info","category":"auth","message":"m"}`, ts)
                _, rej := Decode([]byte(body), now)
                if tc.code == "" && rej != nil {
                        t.Fatalf("offset %v: unexpected rejection %+v", tc.offset, rej)
                }
                if tc.code != "" && (rej == nil || rej.Code != tc.code) {
                        t.Fatalf("offset %v: want %s got %+v", tc.offset, tc.code, rej)
                }
        }
}

func TestDecodeTimestampNormalization(t *testing.T) {
        // non-UTC offset is accepted and normalized to UTC
        body := `{"event_id":"e","schema_version":1,"event_time":"2026-01-15T14:00:00+02:00","source_id":"s","source_type":"app","severity":"info","category":"auth","message":"m"}`
        ev, rej := Decode([]byte(body), now)
        if rej != nil {
                t.Fatalf("unexpected rejection: %+v", rej)
        }
        if ev.EventTime.UTC().Format("2006-01-02T15:04") != "2026-01-15T12:00" {
                t.Fatalf("normalization failed: %v", ev.EventTime)
        }
}

func TestDecodeOversize(t *testing.T) {
        big := make(map[string]any)
        if err := json.Unmarshal([]byte(validJSON()), &big); err != nil {
                t.Fatal(err)
        }
        big["attributes"] = map[string]any{"blob": strings.Repeat("y", MaxEventBytes)}
        b, _ := json.Marshal(big)
        _, rej := Decode(b, now)
        if rej == nil || rej.Code != "EVENT_TOO_LARGE" {
                t.Fatalf("want EVENT_TOO_LARGE, got %+v", rej)
        }
}

func TestDecodeBoundarySizes(t *testing.T) {
        // exactly 4KB event: must pass the byte gate; message at exactly 512 runes passes.
        msg := strings.Repeat("μ", MaxMessageRunes) // multibyte: rune count is what matters
        body := fmt.Sprintf(`{"event_id":"e","schema_version":1,"event_time":"2026-01-15T12:00:00Z","source_id":"s","source_type":"app","severity":"info","category":"auth","message":"%s"}`, msg)
        if _, rej := Decode([]byte(body), now); rej != nil {
                t.Fatalf("512-rune message rejected: %+v", rej)
        }
        msg513 := strings.Repeat("a", MaxMessageRunes+1)
        body = fmt.Sprintf(`{"event_id":"e","schema_version":1,"event_time":"2026-01-15T12:00:00Z","source_id":"s","source_type":"app","severity":"info","category":"auth","message":"%s"}`, msg513)
        if _, rej := Decode([]byte(body), now); rej == nil {
                t.Fatalf("513-rune message accepted")
        }
        // event byte size exactly at limit
        pad := MaxEventBytes - 300
        body = fmt.Sprintf(`{"event_id":"e","schema_version":1,"event_time":"2026-01-15T12:00:00Z","source_id":"s","source_type":"app","severity":"info","category":"auth","message":"m","attributes":{"pad":"%s"}}`, strings.Repeat("z", pad))
        if _, rej := Decode([]byte(body), now); rej != nil {
                t.Fatalf("event at 4KB boundary rejected: %+v (len=%d)", rej, len(body))
        }
}

func TestDecodeUnicode(t *testing.T) {
        body := `{"event_id":"e","schema_version":1,"event_time":"2026-01-15T12:00:00Z","source_id":"س","source_type":"app","severity":"info","category":"auth","message":"ورود کاربر با موفقیت انجام شد"}`
        if _, rej := Decode([]byte(body), now); rej == nil || rej.Code != "BAD_SOURCE_ID" {
                t.Fatalf("non-ASCII source_id should be rejected: %+v", rej)
        }
        body = `{"event_id":"e","schema_version":1,"event_time":"2026-01-15T12:00:00Z","source_id":"s","source_type":"app","severity":"info","category":"auth","message":"ورود کاربر با موفقیت انجام شد و پیام طولانی برای تست یونیکد است"}` 
        if ev, rej := Decode([]byte(body), now); rej != nil {
                t.Fatalf("unicode message rejected: %+v", rej)
        } else if ev.Message == "" {
                t.Fatalf("message lost")
        }
}

func TestSeverityHelpers(t *testing.T) {
        if MaxSeverity("low", "critical") != "critical" || MaxSeverity("high", "low") != "high" {
                t.Fatalf("MaxSeverity broken")
        }
        if SeverityRank("info") != 0 || SeverityRank("critical") != 4 || SeverityRank("bogus") != -1 {
                t.Fatalf("SeverityRank broken")
        }
        if !ValidSeverity("medium") || ValidSeverity("urgent") {
                t.Fatalf("ValidSeverity broken")
        }
}

func TestPartialEventOnRejection(t *testing.T) {
        // event_id parseable but severity invalid: partial event returned with rejection
        body := `{"event_id":"keep-me","schema_version":1,"event_time":"2026-01-15T12:00:00Z","source_id":"s","source_type":"app","severity":"nope","category":"auth","message":"m"}`
        ev, rej := Decode([]byte(body), now)
        if rej == nil || rej.Code != "BAD_SEVERITY" {
                t.Fatalf("want BAD_SEVERITY got %+v", rej)
        }
        if ev == nil || ev.EventID != "keep-me" {
                t.Fatalf("expected partial event with event_id kept, got %+v", ev)
        }
}

func TestAttrStringify(t *testing.T) {
        ev, rej := Decode([]byte(validJSON()), now)
        if rej != nil {
                t.Fatal(rej)
        }
        if ev.Attr("error") != "true" { // JSON boolean -> "true"
                t.Fatalf("Attr(error) = %q", ev.Attr("error"))
        }
        if ev.Attr("missing") != "" {
                t.Fatalf("missing attr should be empty")
        }
        if !ev.IsErrorLike() {
                t.Fatalf("error=true should be error-like")
        }
        ev.Severity = "critical"
        ev.Attributes = nil
        if !ev.IsErrorLike() {
                t.Fatalf("critical severity should be error-like")
        }
        ev.Severity = "info"
        if ev.IsErrorLike() {
                t.Fatalf("info without error attr is not error-like")
        }
}
