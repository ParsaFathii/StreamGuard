// Copyright © 2026 Parsa Fathi — Apache-2.0

// Response rendering: the contract error shape, JSON envelopes, pagination
// and the view types (server-side event/rule/detection/incident shapes).
package api

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/event"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/sse"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/store"
)

// errorBody is the contract error shape.
type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type errorEnvelope struct {
	Error errorBody `json:"error"`
}

// writeError emits {"error":{"code","message"}} with the given status.
func writeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(errorEnvelope{Error: errorBody{Code: code, Message: message}})
}

// writeJSON emits v with the given status.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// jsonTime renders a time in contract ISO form; zero renders null.
func jsonTime(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return sse.FormatTime(t)
}

// pageEnvelope is the standard list response.
type pageEnvelope struct {
	Data     any `json:"data"`
	Page     int `json:"page"`
	PageSize int `json:"pageSize"`
	Total    int `json:"total"`
}

// ---------------------------------------------------------------- event views

// eventView is the full server-side event shape (all fields, snake_case).
type eventView struct {
	EventID         string         `json:"event_id"`
	SchemaVersion   int            `json:"schema_version"`
	EventTime       string         `json:"event_time"`
	SourceID        string         `json:"source_id"`
	SourceType      string         `json:"source_type"`
	Severity        string         `json:"severity"`
	Category        string         `json:"category"`
	Message         string         `json:"message"`
	Attributes      map[string]any `json:"attributes,omitempty"`
	CorrelationID   string         `json:"correlation_id,omitempty"`
	TraceID         string         `json:"trace_id,omitempty"`
	Actor           string         `json:"actor,omitempty"`
	Origin          string         `json:"origin"`
	IngestTime      string         `json:"ingest_time"`
	Status          string         `json:"status"`
	RejectionReason string         `json:"rejection_reason,omitempty"`
	LatencyMs       int64          `json:"latency_ms,omitempty"`
}

// incidentEventView is a full event plus its late flag (incident attachment).
type incidentEventView struct {
	eventView
	Late bool `json:"late"`
}

// viewEvent converts a stored event into the full view.
func viewEvent(e event.Event) eventView {
	return eventView{
		EventID:       e.EventID,
		SchemaVersion: e.SchemaVersion,
		EventTime:     sse.FormatTime(e.EventTime),
		SourceID:      e.SourceID,
		SourceType:    e.SourceType,
		Severity:      e.Severity,
		Category:      e.Category,
		Message:       e.Message,
		Attributes:    e.Attributes,
		CorrelationID: e.CorrelationID,
		TraceID:       e.TraceID,
		Actor:         e.Actor,
		Origin:        e.Origin,
		IngestTime:    sse.FormatTime(e.IngestTime),
		Status:        e.Status,
		LatencyMs:     e.LatencyMs,
	}
}

// compactEvent is the incident-detail event summary (id + summary + late).
type compactEvent struct {
	ID        string `json:"id"`
	EventTime string `json:"eventTime"`
	Severity  string `json:"severity"`
	Category  string `json:"category"`
	SourceID  string `json:"sourceId"`
	Message   string `json:"message"`
	Late      bool   `json:"late"`
}

// ---------------------------------------------------------------- rule views

// ruleView is the API rule shape (contract rule model + fire stats).
type ruleView struct {
	ID              string               `json:"id"`
	Name            string               `json:"name"`
	Description     string               `json:"description"`
	Enabled         bool                 `json:"enabled"`
	Selector        *store.RuleSelector  `json:"selector,omitempty"`
	Condition       *store.RuleCondition `json:"condition,omitempty"`
	Severity        string               `json:"severity"`
	CooldownSeconds int                  `json:"cooldownSeconds"`
	Suppression     bool                 `json:"suppression"`
	Version         int                  `json:"version"`
	UpdatedAt       string               `json:"updatedAt"`
	FireCount24h    int64                `json:"fireCount24h"`
	LastFiredAt     any                  `json:"lastFiredAt"`
}

func viewRule(r store.Rule, fireCount24h int64, lastFired time.Time) ruleView {
	sel := r.Selector
	cond := r.Condition
	return ruleView{
		ID: r.ID, Name: r.Name, Description: r.Description, Enabled: r.Enabled,
		Selector: &sel, Condition: &cond,
		Severity: r.Severity, CooldownSeconds: r.CooldownSeconds, Suppression: r.Suppression,
		Version: r.Version, UpdatedAt: sse.FormatTime(r.UpdatedAt),
		FireCount24h: fireCount24h, LastFiredAt: jsonTime(lastFired),
	}
}

// ruleAuditView is a rule change history entry.
type ruleAuditView struct {
	ID      string         `json:"id"`
	TS      string         `json:"ts"`
	RuleID  string         `json:"ruleId"`
	Actor   string         `json:"actor"`
	Changes map[string]any `json:"changes"`
}

// ---------------------------------------------------------------- detection views

// detectionView is the API detection shape.
type detectionView struct {
	ID         string                `json:"id"`
	RuleID     string                `json:"ruleId"`
	EventID    string                `json:"eventId"`
	IncidentID string                `json:"incidentId,omitempty"`
	Severity   string                `json:"severity"`
	Score      float64               `json:"score"`
	Title      string                `json:"title"`
	Detail     store.DetectionDetail `json:"detail"`
	Status     string                `json:"status"`
	CreatedAt  string                `json:"createdAt"`
}

func viewDetection(d store.Detection) detectionView {
	return detectionView{
		ID: d.ID, RuleID: d.RuleID, EventID: d.EventID, IncidentID: d.IncidentID,
		Severity: d.Severity, Score: d.Score, Title: d.Title, Detail: d.Detail,
		Status: d.Status, CreatedAt: sse.FormatTime(d.CreatedAt),
	}
}

// ---------------------------------------------------------------- incident views

// incidentView is the list shape (no heavy joins).
type incidentView struct {
	ID                string `json:"id"`
	Title             string `json:"title"`
	Severity          string `json:"severity"`
	Status            string `json:"status"`
	RuleID            string `json:"ruleId"`
	CorrelationKey    string `json:"correlationKey"`
	CorrelationLabel  string `json:"correlationKeyLabel"`
	EventCount        int    `json:"eventCount"`
	DetectionCount    int    `json:"detectionCount"`
	FirstEventTime    any    `json:"firstEventTime"`
	LastEventTime     any    `json:"lastEventTime"`
	AssignedTo        string `json:"assignedTo,omitempty"`
	ResolutionSummary string `json:"resolutionSummary,omitempty"`
	CreatedAt         string `json:"createdAt"`
	UpdatedAt         string `json:"updatedAt"`
	ResolvedAt        any    `json:"resolvedAt"`
	ClosedAt          any    `json:"closedAt"`
}

func viewIncident(inc store.Incident) incidentView {
	return incidentView{
		ID: inc.ID, Title: inc.Title, Severity: inc.Severity, Status: inc.Status,
		RuleID: inc.RuleID, CorrelationKey: inc.CorrelationKey, CorrelationLabel: inc.CorrelationLabel,
		EventCount: inc.EventCount, DetectionCount: inc.DetectionCount,
		FirstEventTime: jsonTime(inc.FirstEventTime), LastEventTime: jsonTime(inc.LastEventTime),
		AssignedTo: inc.AssignedTo, ResolutionSummary: inc.ResolutionSummary,
		CreatedAt: sse.FormatTime(inc.CreatedAt), UpdatedAt: sse.FormatTime(inc.UpdatedAt),
		ResolvedAt: jsonTime(inc.ResolvedAt), ClosedAt: jsonTime(inc.ClosedAt),
	}
}

// statusHistoryView is one lifecycle entry.
type statusHistoryView struct {
	From  string `json:"from"`
	To    string `json:"to"`
	At    string `json:"at"`
	Actor string `json:"actor"`
	Note  string `json:"note,omitempty"`
}

// noteView is an incident note.
type noteView struct {
	ID         string `json:"id"`
	IncidentID string `json:"incidentId"`
	Author     string `json:"author"`
	Body       string `json:"body"`
	CreatedAt  string `json:"createdAt"`
}

// aiReportRefView is the id/ts-only AI report reference.
type aiReportRefView struct {
	ID string `json:"id"`
	TS string `json:"ts"`
}

// incidentDetailView is the full detail (events + detections + notes + ai).
type incidentDetailView struct {
	incidentView
	StatusHistory []statusHistoryView `json:"statusHistory"`
	Events        []compactEvent      `json:"events"`
	Detections    []detectionView     `json:"detections"`
	Notes         []noteView          `json:"notes"`
	AIReports     []aiReportRefView   `json:"aiReports"`
}

// ---------------------------------------------------------------- audit view

// auditView is one audit entry.
type auditView struct {
	ID         string         `json:"id"`
	TS         string         `json:"ts"`
	Actor      string         `json:"actor"`
	Role       string         `json:"role"`
	Action     string         `json:"action"`
	TargetType string         `json:"targetType"`
	TargetID   string         `json:"targetId"`
	Details    map[string]any `json:"details"`
}
