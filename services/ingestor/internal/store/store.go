// Copyright © 2026 Parsa Fathi — Apache-2.0

// Package store defines the persistence interface for StreamGuard plus two
// implementations: an in-memory store (default, used in all unit tests) and
// a PostgreSQL store (pgx) for durable deployments. All SQL is
// parameterized; the schema is applied at startup under an advisory lock.
package store

import (
        "context"
        "errors"
        "time"

        "github.com/ParsaFathii/StreamGuard/services/ingestor/internal/event"
)

// ErrNotFound is returned by getters when the entity does not exist.
var ErrNotFound = errors.New("not found")

// EventFilter carries the validated /api/events list filters.
type EventFilter struct {
        Q            string   // message/actor search, min 2 chars
        Severities   []string // csv multi-value
        Category     string
        SourceID     string
        SourceType   string
        CorrelationID string
        TraceID      string
        Status       string
        Origin       string
        From, To     *time.Time
        IncidentID   string // events attached to incident
        RuleID       string // events referenced by detections of rule
}

// EventQuery is the rule-engine selector query over stored events.
type EventQuery struct {
        Categories     []string
        Severities     []string
        SourceIDPrefix string
        AttrKey        string
        AttrValue      string
        Since          time.Time
        Until          time.Time
        Limit          int
}

// AttrKV is a single attribute key/value selector.
type AttrKV struct {
        Key   string `json:"key"`
        Value string `json:"value"`
}

// RuleSelector narrows which events a rule inspects.
type RuleSelector struct {
        Category       string   `json:"category,omitempty"`
        Severities     []string `json:"severity,omitempty"`
        SourceIDPrefix string   `json:"sourceIdPrefix,omitempty"`
        Attribute      *AttrKV  `json:"attribute,omitempty"`
}

// RuleCondition describes how a rule fires.
type RuleCondition struct {
        Type          string  `json:"type"` // count | ratio | sequence | exists
        Threshold     float64 `json:"threshold"`
        WindowSeconds int     `json:"windowSeconds"`
        Metric        string  `json:"metric"` // actor | source_id | error_ratio | login_failed_login_success | infra_or_prod | validation_failures
        MinCount      int     `json:"minCount,omitempty"`
        Strict        bool    `json:"strict,omitempty"` // count must be strictly > threshold (SG-RULE-002 uses ">120")
}

// Rule is a detection rule (SG-RULE-001..007 seeded).
type Rule struct {
        ID              string
        Name            string
        Description     string
        Enabled         bool
        Selector        RuleSelector
        Condition       RuleCondition
        Severity        string
        CooldownSeconds int
        Suppression     bool
        Version         int
        UpdatedAt       time.Time
}

// RuleAudit records a rule change (who changed what, when).
type RuleAudit struct {
        ID      string
        TS      time.Time
        RuleID  string
        Actor   string
        Changes map[string]any
}

// DetectionDetail carries match context for a detection.
type DetectionDetail struct {
        MatchedCount   int      `json:"matchedCount"`
        WindowSeconds  int      `json:"windowSeconds"`
        Actor          string   `json:"actor,omitempty"`
        SourceID       string   `json:"sourceId,omitempty"`
        SampleEventIDs []string `json:"sampleEventIds"`
}

// Detection is a rule firing (one per rule+key+cooldown window).
type Detection struct {
        ID             string
        RuleID         string
        EventID        string // triggering event ("" for internal rules)
        IncidentID     string
        CorrelationKey string `json:"-"` // internal, not part of the API shape
        Severity       string
        Score          float64
        Title          string
        Detail         DetectionDetail
        Status         string // ACTIVE | SUPPRESSED
        CreatedAt      time.Time
}

// Detection statuses.
const (
        DetectionActive     = "ACTIVE"
        DetectionSuppressed = "SUPPRESSED"
)

// Incident statuses.
const (
        IncidentNew           = "NEW"
        IncidentTriaged       = "TRIAGED"
        IncidentInvestigating = "INVESTIGATING"
        IncidentResolved      = "RESOLVED"
        IncidentClosed        = "CLOSED"
)

// IncidentStatuses is the closed set of incident statuses.
var IncidentStatuses = []string{IncidentNew, IncidentTriaged, IncidentInvestigating, IncidentResolved, IncidentClosed}

// StatusHistoryEntry is one transition record.
type StatusHistoryEntry struct {
        FromStatus string
        ToStatus   string
        Actor      string
        Note       string
        TS         time.Time
}

// Incident is a correlated group of detections/events.
type Incident struct {
        ID                string
        Title             string
        Severity          string
        Status            string
        RuleID            string
        CorrelationKey    string
        CorrelationLabel  string
        EventCount        int
        DetectionCount    int
        FirstEventTime    time.Time // zero = null
        LastEventTime     time.Time
        AssignedTo        string
        ResolutionSummary string
        CreatedAt         time.Time
        UpdatedAt         time.Time
        ResolvedAt        time.Time
        ClosedAt          time.Time
        StatusHistory     []StatusHistoryEntry
}

// IncidentEvent links an event to an incident (with late flag).
type IncidentEvent struct {
        IncidentID string
        EventID    string
        Late       bool
        AttachedAt time.Time
}

// IncidentEventView is an incident-attached event plus its late flag.
type IncidentEventView struct {
        Event event.Event
        Late  bool
}

// Note is an analyst note on an incident.
type Note struct {
        ID         string
        IncidentID string
        Author     string
        Body       string
        CreatedAt  time.Time
}

// AIReport is a stored AI investigation report (id/ts surfaced in detail).
type AIReport struct {
        ID             string
        IncidentID     string
        ProviderStatus string
        TS             time.Time
        Report         []byte // full report JSON (read-only record)
}

// AuditEntry is an immutable audit record.
type AuditEntry struct {
        ID         string
        TS         time.Time
        Actor      string
        Role       string
        Action     string
        TargetType string
        TargetID   string
        Details    map[string]any
}

// User is a console user (bcrypt password hash).
type User struct {
        Username     string
        PasswordHash string
        Role         string // ADMIN | ANALYST | VIEWER
        DisplayName  string
}

// Session is a logged-in session (token looked up on each request).
type Session struct {
        Token     string
        Username  string
        ExpiresAt time.Time
}

// IngestKey is a machine ingest credential (X-Ingest-Key).
type IngestKey struct {
        ID     string
        Value  string
        Label  string
        Active bool
}

// ValidationFailure records a rejected event (never silently discarded).
type ValidationFailure struct {
        ID     string
        TS     time.Time
        Reason string
        Detail string
}

// MlMethodMetrics holds evaluation metrics for one method.
type MlMethodMetrics struct {
        Precision float64
        Recall    float64
        F1        float64
        FPR       float64
        TP, FP, TN, FN int
}

// MlRun is a stored, reproducible ML evaluation.
type MlRun struct {
        TS          time.Time
        Seed        int
        DatasetSize int
        Methods     map[string]MlMethodMetrics
        DatasetInfo struct {
                Label    string
                Anomalies int
                Normal    int
        }
}

// Settings are the mutable system settings (ADMIN).
type Settings struct {
        AIEnabled                bool
        AIProvider               string
        CorrelationWindowSeconds int
        RetentionHours           int
        MaxBatchSize             int
        RateLimitPerMin          int
        LanguageDefault          string // "en" | "fa"
}

// DefaultSettings returns the contract defaults.
func DefaultSettings() Settings {
        return Settings{
                AIEnabled:                true,
                AIProvider:               "ollama",
                CorrelationWindowSeconds: 600,
                RetentionHours:           72,
                MaxBatchSize:             100,
                RateLimitPerMin:          60,
                LanguageDefault:          "en",
        }
}

// SourceCount is a (source, event count) aggregate.
type SourceCount struct {
        SourceID string
        Count    int64
}

// SourceStat describes one event source derived from real data.
type SourceStat struct {
        ID          string
        Type        string
        Origin      string
        Events24h   int64
        LastEventAt time.Time
        LastStatus  string
}

// MinuteCount is a per-minute aggregate bucket.
type MinuteCount struct {
        Minute time.Time
        Count  int64
}

// IncidentFilter carries /api/incidents filters.
type IncidentFilter struct {
        Status     string
        Severity   string
        RuleID     string
        AssignedTo string
        Q          string
        Since      *time.Time
}

// DetectionFilter carries /api/detections filters.
type DetectionFilter struct {
        RuleID     string
        Severity   string
        IncidentID string
        Status     string
        From, To   *time.Time
}

// AuditFilter carries /api/audit filters.
type AuditFilter struct {
        Actor      string
        Action     string
        TargetType string
        From, To   *time.Time
}

// Store is the full persistence surface of the service.
type Store interface {
        Close() error
        Ping(ctx context.Context) error

        // Events
        InsertEvent(ctx context.Context, e *event.Event) (inserted bool, err error)
        GetEvent(ctx context.Context, id string) (*event.Event, error)
        SetEventProcessed(ctx context.Context, id string, latencyMs int64, at time.Time) error
        DeleteEvents(ctx context.Context, ids []string) (int, error)
        ListEvents(ctx context.Context, f EventFilter, page, pageSize int) ([]event.Event, int, error)
        QueryEvents(ctx context.Context, q EventQuery) ([]event.Event, error)
        CountEventsSince(ctx context.Context, since time.Time) (int64, error)
        SeverityBreakdownSince(ctx context.Context, since time.Time) (map[string]int64, error)
        CategoryBreakdownSince(ctx context.Context, since time.Time) (map[string]int64, error)
        TopSourcesSince(ctx context.Context, since time.Time, n int) ([]SourceCount, error)
        MinuteCounts(ctx context.Context, kind string, since time.Time) ([]MinuteCount, error) // kind: events|detections|rejected
        LatencyStatsSince(ctx context.Context, since time.Time) (avgMs, p95Ms float64, last time.Time, err error)
        SourcesSince(ctx context.Context, since time.Time) ([]SourceStat, error)
        DeleteEventsBefore(ctx context.Context, cutoff time.Time) (int, error) // never deletes events attached to non-CLOSED incidents

        // Validation failures
        InsertValidationFailure(ctx context.Context, vf *ValidationFailure) error
        ListValidationFailuresSince(ctx context.Context, since time.Time, limit int) ([]ValidationFailure, error)

        // Rules
        ListRules(ctx context.Context) ([]Rule, error)
        GetRule(ctx context.Context, id string) (*Rule, error)
        InsertRuleIfAbsent(ctx context.Context, r *Rule) (bool, error)
        UpdateRule(ctx context.Context, r *Rule) error
        InsertRuleAudit(ctx context.Context, ra *RuleAudit) error
        ListRuleAudit(ctx context.Context, ruleID string, limit int) ([]RuleAudit, error)

        // Detections
        InsertDetection(ctx context.Context, d *Detection) error
        ListDetections(ctx context.Context, f DetectionFilter, page, pageSize int) ([]Detection, int, error)
        DetectionCountsByRuleSince(ctx context.Context, since time.Time) (map[string]int64, error)
        LastFiredByRule(ctx context.Context) (map[string]time.Time, error)
        LastDetectionAtByRuleKey(ctx context.Context, ruleID string) (map[string]time.Time, error)

        // Incidents
        NextIncidentNumber(ctx context.Context) (int, error)
        InsertIncident(ctx context.Context, inc *Incident) error
        GetIncident(ctx context.Context, id string) (*Incident, error)
        UpdateIncident(ctx context.Context, inc *Incident) error
        ListIncidents(ctx context.Context, f IncidentFilter, sort string, page, pageSize int) ([]Incident, int, error)
        FindOpenIncident(ctx context.Context, ruleID, correlationKey string, updatedSince time.Time) (*Incident, error)
        AttachIncidentEvents(ctx context.Context, incidentID string, evs []IncidentEvent) (attached int, err error)
        IncidentEvents(ctx context.Context, incidentID string, page, pageSize int) ([]IncidentEventView, int, error)
        IncidentCounts(ctx context.Context, now time.Time) (open, last24h int64, err error)
        SetDetectionIncident(ctx context.Context, detectionID, incidentID string) error

        // Notes
        InsertNote(ctx context.Context, n *Note) error
        ListNotes(ctx context.Context, incidentID string) ([]Note, error)

        // AI reports
        InsertAIReport(ctx context.Context, ar *AIReport) error
        ListAIReports(ctx context.Context, incidentID string) ([]AIReport, error)

        // Audit
        InsertAudit(ctx context.Context, a *AuditEntry) error
        ListAudit(ctx context.Context, f AuditFilter, page, pageSize int) ([]AuditEntry, int, error)

        // Users / sessions / ingest keys
        UpsertUser(ctx context.Context, u *User) error
        GetUser(ctx context.Context, username string) (*User, error)
        InsertSession(ctx context.Context, s *Session) error
        GetSession(ctx context.Context, token string) (*Session, error)
        DeleteSession(ctx context.Context, token string) error
        UpsertIngestKey(ctx context.Context, k *IngestKey) error
        GetIngestKey(ctx context.Context, value string) (*IngestKey, error)

        // Settings & ML
        InitSettingsIfAbsent(ctx context.Context, s Settings) error
        GetSettings(ctx context.Context) (Settings, error)
        SaveSettings(ctx context.Context, s Settings) error
        SaveMlRun(ctx context.Context, run *MlRun) error
        LastMlRun(ctx context.Context) (*MlRun, error)

        // Demo reset (keeps users, rules, settings, ingest keys)
        ResetDemoData(ctx context.Context) error
}
