// Copyright © 2026 Parsa Fathi — Apache-2.0

// Events, rules and detections list/detail handlers with strict filter
// validation (400 INVALID_FILTER naming the parameter).
package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/event"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/ids"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/sse"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/store"
)

// ---------------------------------------------------------------- events

// handleEventsList implements GET /api/events.
func (s *Server) handleEventsList(w http.ResponseWriter, r *http.Request, _ *store.Session, _ *store.User) {
	q := r.URL.Query()

	f := store.EventFilter{}
	if v := q.Get("q"); v != "" {
		if len(strings.TrimSpace(v)) < 2 || len(v) > 256 {
			badFilter(w, "q", "must be 2..256 characters")
			return
		}
		f.Q = v
	}
	if v := q.Get("severity"); v != "" {
		parts := strings.Split(v, ",")
		for _, p := range parts {
			if !event.ValidSeverity(strings.TrimSpace(p)) {
				badFilter(w, "severity", "must be a csv subset of "+strings.Join(event.Severities, "|"))
				return
			}
		}
		f.Severities = parts
	}
	if v := q.Get("category"); v != "" {
		if !event.ValidCategory(v) {
			badFilter(w, "category", "must be one of "+strings.Join(event.Categories, "|"))
			return
		}
		f.Category = v
	}
	if v := q.Get("sourceType"); v != "" {
		if !event.ValidSourceType(v) {
			badFilter(w, "sourceType", "must be one of "+strings.Join(event.SourceTypes, "|"))
			return
		}
		f.SourceType = v
	}
	if v := q.Get("status"); v != "" {
		if !event.ValidStatus(v) {
			badFilter(w, "status", "must be one of "+strings.Join(event.Statuses, "|"))
			return
		}
		f.Status = v
	}
	if v := q.Get("origin"); v != "" {
		if !event.ValidOrigin(v) {
			badFilter(w, "origin", "must be one of "+strings.Join(event.Origins, "|"))
			return
		}
		f.Origin = v
	}
	for name, dst := range map[string]*string{
		"sourceId":      &f.SourceID,
		"correlationId": &f.CorrelationID,
		"traceId":       &f.TraceID,
		"incidentId":    &f.IncidentID,
		"ruleId":        &f.RuleID,
	} {
		if v := q.Get(name); v != "" {
			if len(v) > 128 {
				badFilter(w, name, "must be at most 128 characters")
				return
			}
			*dst = v
		}
	}
	for name, dst := range map[string]**time.Time{"from": &f.From, "to": &f.To} {
		if v := q.Get(name); v != "" {
			t, ok := parseTimeFilter(w, name, v)
			if !ok {
				return
			}
			*dst = t
		}
	}

	page, pageSize, ok := pageParams(w, r)
	if !ok {
		return
	}

	evs, total, err := s.st.ListEvents(r.Context(), f, page, pageSize)
	if err != nil {
		s.internalError(w, r, "list events", err)
		return
	}
	out := make([]eventView, 0, len(evs))
	for i := range evs {
		out = append(out, viewEvent(evs[i]))
	}
	writeJSON(w, http.StatusOK, pageEnvelope{Data: out, Page: page, PageSize: pageSize, Total: total})
}

// handleEventDetail implements GET /api/events/{id}.
func (s *Server) handleEventDetail(w http.ResponseWriter, r *http.Request, _ *store.Session, _ *store.User) {
	id := r.PathValue("id")
	ev, err := s.st.GetEvent(r.Context(), id)
	if err == store.ErrNotFound {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "no event "+id)
		return
	}
	if err != nil {
		s.internalError(w, r, "get event", err)
		return
	}
	writeJSON(w, http.StatusOK, viewEvent(*ev))
}

// ---------------------------------------------------------------- rules

// handleRulesList implements GET /api/rules (all roles).
func (s *Server) handleRulesList(w http.ResponseWriter, r *http.Request, _ *store.Session, _ *store.User) {
	ctx := r.Context()
	now := s.Now()
	rules, err := s.st.ListRules(ctx)
	if err != nil {
		s.internalError(w, r, "list rules", err)
		return
	}
	counts, err := s.st.DetectionCountsByRuleSince(ctx, now.Add(-24*time.Hour))
	if err != nil {
		counts = map[string]int64{}
	}
	lastFired, err := s.st.LastFiredByRule(ctx)
	if err != nil {
		lastFired = map[string]time.Time{}
	}
	out := make([]ruleView, 0, len(rules))
	for _, rl := range rules {
		out = append(out, viewRule(rl, counts[rl.ID], lastFired[rl.ID]))
	}
	writeJSON(w, http.StatusOK, pageEnvelope{Data: out, Page: 1, PageSize: len(out), Total: len(out)})
}

// rulePatchBody is the PATCH /api/rules/{id} body (all optional).
type rulePatchBody struct {
	Enabled         *bool    `json:"enabled"`
	Threshold       *float64 `json:"threshold"`
	WindowSeconds   *int     `json:"windowSeconds"`
	Severity        *string  `json:"severity"`
	CooldownSeconds *int     `json:"cooldownSeconds"`
}

// handleRulePatch implements PATCH /api/rules/{id} (ANALYST+).
func (s *Server) handleRulePatch(w http.ResponseWriter, r *http.Request, _ *store.Session, user *store.User) {
	id := r.PathValue("id")
	var body rulePatchBody
	if !s.decodeJSON(w, r, &body) {
		return
	}
	ctx := r.Context()
	rule, err := s.st.GetRule(ctx, id)
	if err == store.ErrNotFound {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "no rule "+id)
		return
	}
	if err != nil {
		s.internalError(w, r, "get rule", err)
		return
	}

	// Validate every provided field against the contract ranges.
	changes := map[string]any{}
	apply := func(field string, from, to any) {
		changes[field] = map[string]any{"from": from, "to": to}
	}
	if body.Enabled != nil {
		apply("enabled", rule.Enabled, *body.Enabled)
		rule.Enabled = *body.Enabled
	}
	if body.Threshold != nil {
		if *body.Threshold < 1 || *body.Threshold > 10000 {
			badRequest(w, "INVALID_SETTINGS", "threshold must be in 1..10000")
			return
		}
		apply("threshold", rule.Condition.Threshold, *body.Threshold)
		rule.Condition.Threshold = *body.Threshold
	}
	if body.WindowSeconds != nil {
		if *body.WindowSeconds < 10 || *body.WindowSeconds > 3600 {
			badRequest(w, "INVALID_SETTINGS", "windowSeconds must be in 10..3600")
			return
		}
		apply("windowSeconds", rule.Condition.WindowSeconds, *body.WindowSeconds)
		rule.Condition.WindowSeconds = *body.WindowSeconds
	}
	if body.Severity != nil {
		if !event.ValidSeverity(*body.Severity) {
			badFilter(w, "severity", "must be one of "+strings.Join(event.Severities, "|"))
			return
		}
		apply("severity", rule.Severity, *body.Severity)
		rule.Severity = *body.Severity
	}
	if body.CooldownSeconds != nil {
		if *body.CooldownSeconds < 0 || *body.CooldownSeconds > 3600 {
			badRequest(w, "INVALID_SETTINGS", "cooldownSeconds must be in 0..3600")
			return
		}
		apply("cooldownSeconds", rule.CooldownSeconds, *body.CooldownSeconds)
		rule.CooldownSeconds = *body.CooldownSeconds
	}

	if len(changes) == 0 {
		// No-op PATCH: return the current rule unchanged (200).
		s.writeRuleWithStats(w, r, *rule)
		return
	}

	oldVersion := rule.Version
	rule.Version++
	rule.UpdatedAt = s.Now()
	apply("version", oldVersion, rule.Version)

	if err := s.st.UpdateRule(ctx, rule); err != nil {
		s.internalError(w, r, "update rule", err)
		return
	}
	ra := &store.RuleAudit{
		ID: ids.New("RA"), TS: rule.UpdatedAt, RuleID: rule.ID, Actor: user.Username, Changes: changes,
	}
	if err := s.st.InsertRuleAudit(ctx, ra); err != nil {
		s.log.Warn("rule audit write failed", "err", err.Error())
	}
	s.audit(user, "rule.update", "rule", rule.ID, map[string]any{"ruleId": rule.ID, "changes": changes})
	s.writeRuleWithStats(w, r, *rule)
}

// writeRuleWithStats renders a rule with 24h fire stats.
func (s *Server) writeRuleWithStats(w http.ResponseWriter, r *http.Request, rule store.Rule) {
	ctx := r.Context()
	counts, _ := s.st.DetectionCountsByRuleSince(ctx, s.Now().Add(-24*time.Hour))
	last, _ := s.st.LastFiredByRule(ctx)
	writeJSON(w, http.StatusOK, viewRule(rule, counts[rule.ID], last[rule.ID]))
}

// handleRuleAuditList implements GET /api/rules/{id}/audit (ADMIN).
func (s *Server) handleRuleAuditList(w http.ResponseWriter, r *http.Request, _ *store.Session, _ *store.User) {
	id := r.PathValue("id")
	page, pageSize, ok := pageParams(w, r)
	if !ok {
		return
	}
	entries, err := s.st.ListRuleAudit(r.Context(), id, 1000)
	if err != nil {
		s.internalError(w, r, "list rule audit", err)
		return
	}
	out := make([]ruleAuditView, 0, len(entries))
	for _, e := range entries {
		out = append(out, ruleAuditView{
			ID: e.ID, TS: sse.FormatTime(e.TS), RuleID: e.RuleID, Actor: e.Actor, Changes: e.Changes,
		})
	}
	// newest-first list; paginate in-memory (bounded at 1000).
	total := len(out)
	start := (page - 1) * pageSize
	if start > total {
		start = total
	}
	end := start + pageSize
	if end > total {
		end = total
	}
	writeJSON(w, http.StatusOK, pageEnvelope{Data: out[start:end], Page: page, PageSize: pageSize, Total: total})
}

// ---------------------------------------------------------------- detections

// handleDetectionsList implements GET /api/detections.
func (s *Server) handleDetectionsList(w http.ResponseWriter, r *http.Request, _ *store.Session, _ *store.User) {
	q := r.URL.Query()
	f := store.DetectionFilter{}
	if v := q.Get("ruleId"); v != "" {
		if len(v) > 64 {
			badFilter(w, "ruleId", "must be at most 64 characters")
			return
		}
		f.RuleID = v
	}
	if v := q.Get("severity"); v != "" {
		if !event.ValidSeverity(v) {
			badFilter(w, "severity", "must be one of "+strings.Join(event.Severities, "|"))
			return
		}
		f.Severity = v
	}
	if v := q.Get("incidentId"); v != "" {
		if len(v) > 64 {
			badFilter(w, "incidentId", "must be at most 64 characters")
			return
		}
		f.IncidentID = v
	}
	if v := q.Get("status"); v != "" {
		if v != store.DetectionActive && v != store.DetectionSuppressed {
			badFilter(w, "status", "must be ACTIVE or SUPPRESSED")
			return
		}
		f.Status = v
	}
	for name, dst := range map[string]**time.Time{"from": &f.From, "to": &f.To} {
		if v := q.Get(name); v != "" {
			t, ok := parseTimeFilter(w, name, v)
			if !ok {
				return
			}
			*dst = t
		}
	}
	page, pageSize, ok := pageParams(w, r)
	if !ok {
		return
	}
	dets, total, err := s.st.ListDetections(r.Context(), f, page, pageSize)
	if err != nil {
		s.internalError(w, r, "list detections", err)
		return
	}
	out := make([]detectionView, 0, len(dets))
	for _, d := range dets {
		out = append(out, viewDetection(d))
	}
	writeJSON(w, http.StatusOK, pageEnvelope{Data: out, Page: page, PageSize: pageSize, Total: total})
}

// ---------------------------------------------------------------- param helpers

// badFilter writes a 400 INVALID_FILTER naming the parameter.
func badFilter(w http.ResponseWriter, param, msg string) {
	writeError(w, http.StatusBadRequest, "INVALID_FILTER", "parameter "+param+": "+msg)
}

// badRequest writes a plain 400 with the given code.
func badRequest(w http.ResponseWriter, code, msg string) {
	writeError(w, http.StatusBadRequest, code, msg)
}

// parseTimeFilter parses an RFC3339 timestamp filter.
func parseTimeFilter(w http.ResponseWriter, name, v string) (*time.Time, bool) {
	if len(v) > 64 {
		badFilter(w, name, "must be at most 64 characters")
		return nil, false
	}
	t, err := time.Parse(time.RFC3339, v)
	if err != nil {
		badFilter(w, name, "must be an ISO-8601 timestamp (RFC3339)")
		return nil, false
	}
	return &t, true
}

// pageParams parses and validates page (>=1) and pageSize (1..100, default 25).
func pageParams(w http.ResponseWriter, r *http.Request) (int, int, bool) {
	q := r.URL.Query()
	page := 1
	if v := q.Get("page"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			badFilter(w, "page", "must be an integer >= 1")
			return 0, 0, false
		}
		if n > 100000 {
			badFilter(w, "page", "must be at most 100000")
			return 0, 0, false
		}
		page = n
	}
	pageSize := 25
	if v := q.Get("pageSize"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			badFilter(w, "pageSize", "must be an integer >= 1")
			return 0, 0, false
		}
		if n > 100 {
			badFilter(w, "pageSize", "must be at most 100 (bounded)")
			return 0, 0, false
		}
		pageSize = n
	}
	return page, pageSize, true
}

// decodeJSON decodes a JSON body (bounded), writing INVALID_JSON on failure.
func (s *Server) decodeJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	body, ok := s.readBodyRaw(w, r)
	if !ok {
		return false
	}
	if err := jsonUnmarshalStrict(body, v); err != nil {
		badRequest(w, "INVALID_JSON", "malformed JSON body: "+err.Error())
		return false
	}
	return true
}

// readBodyRaw reads a JSON request body with a generous but bounded cap.
func (s *Server) readBodyRaw(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeError(w, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "request body too large")
			return nil, false
		}
		writeError(w, http.StatusBadRequest, "INVALID_JSON", "could not read body: "+err.Error())
		return nil, false
	}
	if len(body) == 0 {
		badRequest(w, "INVALID_JSON", "request body is empty")
		return nil, false
	}
	return body, true
}

// jsonUnmarshalStrict rejects unknown fields (typo protection).
func jsonUnmarshalStrict(data []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}
