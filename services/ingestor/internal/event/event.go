// Copyright © 2026 Parsa Fathi — Apache-2.0

// Package event defines the StreamGuard event schema (schema_version 1),
// its strict validation and normalization. JSON tags follow the ingest
// contract exactly (snake_case): event_id, schema_version, event_time,
// source_id, source_type, severity, category, message, attributes,
// correlation_id, trace_id, actor plus server-side origin, ingest_time,
// status, rejection_reason.
package event

import (
        "bytes"
        "encoding/json"
        "fmt"
        "regexp"
        "time"
        "unicode/utf8"
)

// SchemaVersion is the only supported event schema version.
const SchemaVersion = 1

// Size limits from the contract.
const (
        MaxEventBytes   = 4 * 1024        // single event (stringified) <= 4KB
        MaxBodyBytes    = 256 * 1024      // batch request body <= 256KB
        MaxBatchSize    = 100             // max events per batch
        MaxMessageRunes = 512             // message 1..512 chars
        MaxIDFieldLen   = 128             // correlation_id / trace_id / actor
        MaxSourceIDLen  = 64              // source_id 1..64
        MaxEventIDLen   = 128             // event_id (idempotency key)
        MaxAttrBytes    = 4 * 1024        // attributes object stringified
        MaxFutureSkew   = 10 * time.Minute // allowed clock skew into the future
)

// Severities in ascending order of weight.
var Severities = []string{"info", "low", "medium", "high", "critical"}

// Categories is the closed set of event categories.
var Categories = []string{"auth", "network", "application", "data", "system", "config", "security"}

// SourceTypes is the closed set of source types.
var SourceTypes = []string{"app", "infra", "system", "security", "synthetic"}

// Origins are data-origin markers set by the SYSTEM (never by clients).
var Origins = []string{"synthetic", "external"}

// Statuses for stored events.
var Statuses = []string{"VALIDATED", "REJECTED", "PROCESSED"}

var sourceIDRe = regexp.MustCompile(`^[a-zA-Z0-9._-]{1,64}$`)

// Event is the canonical event record. Client-supplied fields are populated
// by Decode; server-side fields (Origin, IngestTime, Status,
// RejectionReason, LatencyMs) are set by the system.
type Event struct {
        EventID        string         `json:"event_id"`
        SchemaVersion  int            `json:"schema_version"`
        EventTime      time.Time      `json:"event_time"`
        SourceID       string         `json:"source_id"`
        SourceType     string         `json:"source_type"`
        Severity       string         `json:"severity"`
        Category       string         `json:"category"`
        Message        string         `json:"message"`
        Attributes     map[string]any `json:"attributes"`
        CorrelationID  string         `json:"correlation_id"`
        TraceID        string         `json:"trace_id"`
        Actor          string         `json:"actor"`
        Origin         string         `json:"origin"`
        IngestTime     time.Time      `json:"ingest_time"`
        Status         string         `json:"status"`
        RejectionReason string        `json:"rejection_reason"`
        LatencyMs      int64          `json:"latency_ms,omitempty"`
}

// Rejection describes why an event failed validation. It is recorded as a
// ValidationFailure row (never silently discarded).
type Rejection struct {
        Code    string `json:"code"`
        Message string `json:"message"`
}

func (r *Rejection) Error() string { return r.Code + ": " + r.Message }

func rej(code, format string, args ...any) *Rejection {
        return &Rejection{Code: code, Message: fmt.Sprintf(format, args...)}
}

// ValidSeverity reports whether s is a known severity.
func ValidSeverity(s string) bool { return inSet(Severities, s) }

// ValidCategory reports whether s is a known category.
func ValidCategory(s string) bool { return inSet(Categories, s) }

// ValidSourceType reports whether s is a known source type.
func ValidSourceType(s string) bool { return inSet(SourceTypes, s) }

// ValidOrigin reports whether s is a known origin.
func ValidOrigin(s string) bool { return inSet(Origins, s) }

// ValidStatus reports whether s is a known stored-event status.
func ValidStatus(s string) bool { return inSet(Statuses, s) }

// SeverityRank maps a severity to its weight (info=0 .. critical=4).
// Unknown severities rank lowest.
func SeverityRank(s string) int {
        for i, v := range Severities {
                if v == s {
                        return i
                }
        }
        return -1
}

// MaxSeverity returns the higher of two severities.
func MaxSeverity(a, b string) string {
        if SeverityRank(a) >= SeverityRank(b) {
                return a
        }
        return b
}

func inSet(set []string, s string) bool {
        for _, v := range set {
                if v == s {
                        return true
                }
        }
        return false
}

// wire is the client-supplied shape. Unknown fields are rejected.
type wire struct {
        EventID       string          `json:"event_id"`
        SchemaVersion *int            `json:"schema_version"`
        EventTime     string          `json:"event_time"`
        SourceID      string          `json:"source_id"`
        SourceType    string          `json:"source_type"`
        Severity      string          `json:"severity"`
        Category      string          `json:"category"`
        Message       string          `json:"message"`
        Attributes    json.RawMessage `json:"attributes"`
        CorrelationID string          `json:"correlation_id"`
        TraceID       string          `json:"trace_id"`
        Actor         string          `json:"actor"`
}

// Decode parses and validates a single event JSON document. On success it
// returns the event (client fields only; server fields unset) and nil.
// On failure it returns a best-effort partial event (nil when the JSON is
// unparseable) and a *Rejection describing the first violation.
func Decode(data []byte, now time.Time) (*Event, *Rejection) {
        if len(data) > MaxEventBytes {
                return nil, rej("EVENT_TOO_LARGE", "event is %d bytes, max %d", len(data), MaxEventBytes)
        }
        var w wire
        dec := json.NewDecoder(bytes.NewReader(data))
        dec.DisallowUnknownFields()
        if err := dec.Decode(&w); err != nil {
                return nil, rej("INVALID_JSON", "malformed event JSON: %v", err)
        }
        ev := &Event{
                EventID:       w.EventID,
                SourceID:      w.SourceID,
                SourceType:    w.SourceType,
                Severity:      w.Severity,
                Category:      w.Category,
                Message:       w.Message,
                CorrelationID: w.CorrelationID,
                TraceID:       w.TraceID,
                Actor:         w.Actor,
        }
        if r := validateWire(&w, ev, now); r != nil {
                return ev, r
        }
        return ev, nil
}

func validateWire(w *wire, ev *Event, now time.Time) *Rejection {
        if w.EventID == "" {
                return rej("MISSING_FIELD", "event_id is required")
        }
        if len(w.EventID) > MaxEventIDLen {
                return rej("FIELD_TOO_LONG", "event_id exceeds %d characters", MaxEventIDLen)
        }
        if w.SchemaVersion == nil {
                return rej("MISSING_FIELD", "schema_version is required")
        }
        if *w.SchemaVersion != SchemaVersion {
                return rej("BAD_SCHEMA_VERSION", "schema_version must be %d, got %d", SchemaVersion, *w.SchemaVersion)
        }
        ev.SchemaVersion = *w.SchemaVersion
        if w.EventTime == "" {
                return rej("MISSING_FIELD", "event_time is required")
        }
        ts, err := time.Parse(time.RFC3339Nano, w.EventTime)
        if err != nil {
                return rej("BAD_TIMESTAMP", "event_time %q is not ISO-8601: %v", w.EventTime, err)
        }
        ts = ts.UTC()
        if ts.After(now.Add(MaxFutureSkew)) {
                return rej("FUTURE_TIMESTAMP", "event_time %s is more than %s in the future", w.EventTime, MaxFutureSkew)
        }
        ev.EventTime = ts
        if w.SourceID == "" {
                return rej("MISSING_FIELD", "source_id is required")
        }
        if !sourceIDRe.MatchString(w.SourceID) {
                return rej("BAD_SOURCE_ID", "source_id %q must match ^[a-zA-Z0-9._-]{1,64}$", w.SourceID)
        }
        if w.SourceType == "" {
                return rej("MISSING_FIELD", "source_type is required")
        }
        if !ValidSourceType(w.SourceType) {
                return rej("BAD_SOURCE_TYPE", "source_type %q must be one of %v", w.SourceType, SourceTypes)
        }
        if w.Severity == "" {
                return rej("MISSING_FIELD", "severity is required")
        }
        if !ValidSeverity(w.Severity) {
                return rej("BAD_SEVERITY", "severity %q must be one of %v", w.Severity, Severities)
        }
        if w.Category == "" {
                return rej("MISSING_FIELD", "category is required")
        }
        if !ValidCategory(w.Category) {
                return rej("BAD_CATEGORY", "category %q must be one of %v", w.Category, Categories)
        }
        if w.Message == "" {
                return rej("MISSING_FIELD", "message is required")
        }
        msg := trimNormalized(w.Message)
        if n := utf8.RuneCountInString(msg); n < 1 || n > MaxMessageRunes {
                return rej("BAD_MESSAGE", "message must be 1..%d characters, got %d", MaxMessageRunes, n)
        }
        ev.Message = msg
        for name, v := range map[string]string{
                "correlation_id": w.CorrelationID,
                "trace_id":       w.TraceID,
                "actor":          w.Actor,
        } {
                if len(v) > MaxIDFieldLen {
                        return rej("FIELD_TOO_LONG", "%s exceeds %d characters", name, MaxIDFieldLen)
                }
        }
        if len(w.Attributes) > 0 {
                if len(w.Attributes) > MaxAttrBytes {
                        return rej("EVENT_TOO_LARGE", "attributes stringified exceed %d bytes", MaxAttrBytes)
                }
                var attrs map[string]any
                if err := json.Unmarshal(w.Attributes, &attrs); err != nil {
                        return rej("BAD_ATTRIBUTES", "attributes must be a JSON object: %v", err)
                }
                ev.Attributes = attrs
        }
        return nil
}

// trimNormalized trims outer whitespace only; inner content is preserved
// (message is already expected to be normalized by producers).
func trimNormalized(s string) string {
        for len(s) > 0 && (s[0] == ' ' || s[0] == '\t' || s[0] == '\n' || s[0] == '\r') {
                s = s[1:]
        }
        for len(s) > 0 {
                c := s[len(s)-1]
                if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
                        s = s[:len(s)-1]
                } else {
                        break
                }
        }
        return s
}

// Attr returns a stringified attribute value ("" when absent).
func (e *Event) Attr(key string) string {
        if e.Attributes == nil {
                return ""
        }
        v, ok := e.Attributes[key]
        if !ok {
                return ""
        }
        if s, ok := v.(string); ok {
                return s
        }
        b, err := json.Marshal(v)
        if err != nil {
                return ""
        }
        return string(b)
}

// MarshalJSON emits ONLY the client-suppliable ingest shape (snake_case,
// no server-side fields). Used by the deterministic generator (sggen).
func (e *Event) MarshalJSON() ([]byte, error) {
        m := map[string]any{
                "event_id":       e.EventID,
                "schema_version": e.SchemaVersion,
                "event_time":     e.EventTime.UTC().Format("2006-01-02T15:04:05.000Z"),
                "source_id":      e.SourceID,
                "source_type":    e.SourceType,
                "severity":       e.Severity,
                "category":       e.Category,
                "message":        e.Message,
        }
        if e.Attributes != nil {
                m["attributes"] = e.Attributes
        }
        if e.CorrelationID != "" {
                m["correlation_id"] = e.CorrelationID
        }
        if e.TraceID != "" {
                m["trace_id"] = e.TraceID
        }
        if e.Actor != "" {
                m["actor"] = e.Actor
        }
        return json.Marshal(m)
}

// IsErrorLike reports whether the event counts as an "error" for the
// error-ratio rule (SG-RULE-004): severity medium+ or attributes.error=true.
func (e *Event) IsErrorLike() bool {
        if SeverityRank(e.Severity) >= SeverityRank("medium") {
                return true
        }
        return e.Attr("error") == "true"
}

// Clone returns a shallow copy with a copied attributes map.
func (e *Event) Clone() *Event {
        c := *e
        if e.Attributes != nil {
                c.Attributes = make(map[string]any, len(e.Attributes))
                for k, v := range e.Attributes {
                        c.Attributes[k] = v
                }
        }
        return &c
}
