// Copyright © 2026 Parsa Fathi — Apache-2.0

// System endpoints: sources (derived), health, prometheus metrics, audit
// trail, settings (GET/PATCH), retention-run; plus the non-fatal audit
// helper used by every handler.
package api

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/audit"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/metrics"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/sse"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/store"
)

// audit writes a non-fatal audit entry for an authenticated user.
func (s *Server) audit(user *store.User, action, targetType, targetID string, details map[string]any) {
	if details == nil {
		details = map[string]any{}
	}
	if err := audit.Log(context.WithoutCancel(context.Background()), s.st,
		user.Username, user.Role, action, targetType, targetID, details); err != nil {
		s.log.Warn("audit write failed", "err", err.Error())
	}
}

// auditRaw writes a non-fatal audit entry with explicit actor/role.
func (s *Server) auditRaw(actor, role, action, targetType, targetID string, details map[string]any) {
	if err := audit.Log(context.WithoutCancel(context.Background()), s.st,
		actor, role, action, targetType, targetID, details); err != nil {
		s.log.Warn("audit write failed", "err", err.Error())
	}
}

// internalError logs the cause and writes an honest 500.
func (s *Server) internalError(w http.ResponseWriter, r *http.Request, what string, err error) {
	s.log.Error(what+" failed", "err", err.Error(), "path", r.URL.Path)
	writeError(w, http.StatusInternalServerError, "INTERNAL", what+" failed")
}

// ---------------------------------------------------------------- sources

// handleSources implements GET /api/sources (derived from real events only).
func (s *Server) handleSources(w http.ResponseWriter, r *http.Request, _ *store.Session, _ *store.User) {
	now := s.Now()
	stats, err := s.st.SourcesSince(r.Context(), now.Add(-24*time.Hour))
	if err != nil {
		s.internalError(w, r, "sources", err)
		return
	}
	type sourceView struct {
		ID          string `json:"id"`
		Name        string `json:"name"`
		Type        string `json:"type"`
		Origin      string `json:"origin"`
		Events24h   int64  `json:"events24h"`
		LastEventAt any    `json:"lastEventAt"`
		Status      string `json:"status"`
		Description string `json:"description"`
	}
	out := make([]sourceView, 0, len(stats))
	for _, st := range stats {
		status := "active"
		switch {
		case st.LastEventAt.IsZero():
			status = "idle"
		case st.LastStatus == "REJECTED":
			status = "error"
		}
		out = append(out, sourceView{
			ID: st.ID, Name: st.ID, Type: st.Type, Origin: st.Origin,
			Events24h: st.Events24h, LastEventAt: jsonTime(st.LastEventAt), Status: status,
			Description: st.Type + " source, origin " + st.Origin + " (derived from real events)",
		})
	}
	writeJSON(w, http.StatusOK, out) // bare array per contract
}

// ---------------------------------------------------------------- health

// handleHealth implements GET /api/health.
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	now := s.Now()

	db := "up"
	if err := s.st.Ping(ctx); err != nil {
		db = "down"
	}
	llm := s.llmStatus()
	status := "ok"
	if db != "up" || llm == "error" {
		status = "degraded"
	}

	vfs, _ := s.st.ListValidationFailuresSince(ctx, now.Add(-24*time.Hour), 1000000)
	depth := 0
	if s.pipe != nil {
		depth = s.pipe.Depth()
	}

	s.retMu.Lock()
	lastRun := s.retLastRun
	deleted := s.retDeleted
	s.retMu.Unlock()
	sv := s.settings()

	writeJSON(w, http.StatusOK, map[string]any{
		"status":    status,
		"version":   s.cfg.Version,
		"uptimeSec": s.UptimeSec(),
		"checks": map[string]any{
			"db":  db,
			"ws":  "up", // in-process SSE hub; connections tracked via /api/metrics
			"llm": llm,
		},
		"queue": map[string]any{
			"depth":        depth,
			"processed24h": s.mtr.Processed(), // process-local (resets on restart), documented
			"rejected24h":  len(vfs),
		},
		"retention": map[string]any{
			"policy":       sv.RetentionHours,
			"lastRunAt":    jsonTime(lastRun),
			"deletedCount": deleted,
		},
	})
}

// ---------------------------------------------------------------- metrics

// handleMetrics implements GET /api/metrics (Prometheus text format).
func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	now := s.Now()
	vfs, _ := s.st.ListValidationFailuresSince(ctx, time.Time{}, 1000000)
	detCounts, _ := s.st.DetectionCountsByRuleSince(ctx, time.Time{})
	incs, _, _ := s.st.ListIncidents(ctx, store.IncidentFilter{}, "createdAt", 1, 100000)
	byStatus := map[string]int64{}
	for _, inc := range incs {
		byStatus[inc.Status]++
	}
	open, _, _ := s.st.IncidentCounts(ctx, now)
	avg, p95, _, _ := s.st.LatencyStatsSince(ctx, time.Time{})
	snap := metricsSnapshot(int64(len(vfs)), detCounts, byStatus, open, avg, p95, s.hub.Clients(), s.pipeDepth(), s.UptimeSec())
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(s.mtr.Render(snap)))
}

func metricsSnapshot(vfs int64, detCounts, byStatus map[string]int64, open int64,
	avg, p95 float64, wsConn, depth int, uptime int64) metrics.Snapshot {
	return metrics.Snapshot{
		ValidationFailuresTotal: vfs,
		DetectionsByRule:        detCounts,
		IncidentsByStatus:       byStatus,
		IncidentsOpen:           open,
		LatencyAvgMs:            avg,
		LatencyP95Ms:            p95,
		WsConnections:           wsConn,
		QueueDepth:              depth,
		UptimeSec:               uptime,
	}
}

func (s *Server) pipeDepth() int {
	if s.pipe == nil {
		return 0
	}
	return s.pipe.Depth()
}

// ---------------------------------------------------------------- audit trail

// handleAuditList implements GET /api/audit (ADMIN).
func (s *Server) handleAuditList(w http.ResponseWriter, r *http.Request, _ *store.Session, _ *store.User) {
	q := r.URL.Query()
	f := store.AuditFilter{}
	if v := q.Get("actor"); v != "" {
		if len(v) > 64 {
			badFilter(w, "actor", "must be at most 64 characters")
			return
		}
		f.Actor = v
	}
	if v := q.Get("action"); v != "" {
		if !audit.ValidAction(v) {
			badFilter(w, "action", "must be one of "+strings.Join(audit.Actions, "|"))
			return
		}
		f.Action = v
	}
	if v := q.Get("targetType"); v != "" {
		if !audit.ValidTargetType(v) {
			badFilter(w, "targetType", "must be one of "+strings.Join(audit.TargetTypes, "|"))
			return
		}
		f.TargetType = v
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
	entries, total, err := s.st.ListAudit(r.Context(), f, page, pageSize)
	if err != nil {
		s.internalError(w, r, "list audit", err)
		return
	}
	out := make([]auditView, 0, len(entries))
	for _, e := range entries {
		out = append(out, auditView{
			ID: e.ID, TS: sse.FormatTime(e.TS), Actor: e.Actor, Role: e.Role,
			Action: e.Action, TargetType: e.TargetType, TargetID: e.TargetID, Details: e.Details,
		})
	}
	writeJSON(w, http.StatusOK, pageEnvelope{Data: out, Page: page, PageSize: pageSize, Total: total})
}

// ---------------------------------------------------------------- settings

// handleSettingsGet implements GET /api/settings (all roles; no secrets).
func (s *Server) handleSettingsGet(w http.ResponseWriter, r *http.Request, _ *store.Session, _ *store.User) {
	sv := s.settings()
	writeJSON(w, http.StatusOK, settingsView(sv))
}

func settingsView(sv store.Settings) map[string]any {
	return map[string]any{
		"aiEnabled":                sv.AIEnabled,
		"aiProvider":               sv.AIProvider,
		"correlationWindowSeconds": sv.CorrelationWindowSeconds,
		"retentionHours":           sv.RetentionHours,
		"maxBatchSize":             sv.MaxBatchSize,
		"rateLimitPerMin":          sv.RateLimitPerMin,
		"languageDefault":          sv.LanguageDefault,
	}
}

// handleSettingsPatch implements PATCH /api/settings (ADMIN).
func (s *Server) handleSettingsPatch(w http.ResponseWriter, r *http.Request, _ *store.Session, user *store.User) {
	var body struct {
		AIEnabled                *bool   `json:"aiEnabled"`
		AIProvider               *string `json:"aiProvider"`
		CorrelationWindowSeconds *int    `json:"correlationWindowSeconds"`
		RetentionHours           *int    `json:"retentionHours"`
		MaxBatchSize             *int    `json:"maxBatchSize"`
		RateLimitPerMin          *int    `json:"rateLimitPerMin"`
		LanguageDefault          *string `json:"languageDefault"`
	}
	if !s.decodeJSON(w, r, &body) {
		return
	}
	sv := s.settings()
	changes := map[string]any{}
	set := func(field string, from, to any) {
		changes[field] = map[string]any{"from": from, "to": to}
	}
	if body.AIEnabled != nil {
		set("aiEnabled", sv.AIEnabled, *body.AIEnabled)
		sv.AIEnabled = *body.AIEnabled
	}
	if body.AIProvider != nil {
		v := strings.TrimSpace(*body.AIProvider)
		if v == "" || len(v) > 64 {
			badRequest(w, "INVALID_SETTINGS", "aiProvider must be 1..64 characters")
			return
		}
		set("aiProvider", sv.AIProvider, v)
		sv.AIProvider = v
	}
	if body.CorrelationWindowSeconds != nil {
		if *body.CorrelationWindowSeconds < 10 || *body.CorrelationWindowSeconds > 86400 {
			badRequest(w, "INVALID_SETTINGS", "correlationWindowSeconds must be in 10..86400")
			return
		}
		set("correlationWindowSeconds", sv.CorrelationWindowSeconds, *body.CorrelationWindowSeconds)
		sv.CorrelationWindowSeconds = *body.CorrelationWindowSeconds
	}
	if body.RetentionHours != nil {
		if *body.RetentionHours < 1 || *body.RetentionHours > 8760 {
			badRequest(w, "INVALID_SETTINGS", "retentionHours must be in 1..8760")
			return
		}
		set("retentionHours", sv.RetentionHours, *body.RetentionHours)
		sv.RetentionHours = *body.RetentionHours
	}
	if body.MaxBatchSize != nil {
		if *body.MaxBatchSize < 1 || *body.MaxBatchSize > 1000 {
			badRequest(w, "INVALID_SETTINGS", "maxBatchSize must be in 1..1000 (ingest additionally caps at the contract limit of 100)")
			return
		}
		set("maxBatchSize", sv.MaxBatchSize, *body.MaxBatchSize)
		sv.MaxBatchSize = *body.MaxBatchSize
	}
	if body.RateLimitPerMin != nil {
		if *body.RateLimitPerMin < 1 || *body.RateLimitPerMin > 100000 {
			badRequest(w, "INVALID_SETTINGS", "rateLimitPerMin must be in 1..100000")
			return
		}
		set("rateLimitPerMin", sv.RateLimitPerMin, *body.RateLimitPerMin)
		sv.RateLimitPerMin = *body.RateLimitPerMin
	}
	if body.LanguageDefault != nil {
		if *body.LanguageDefault != "en" && *body.LanguageDefault != "fa" {
			badRequest(w, "INVALID_SETTINGS", "languageDefault must be \"en\" or \"fa\"")
			return
		}
		set("languageDefault", sv.LanguageDefault, *body.LanguageDefault)
		sv.LanguageDefault = *body.LanguageDefault
	}

	if len(changes) == 0 {
		writeJSON(w, http.StatusOK, settingsView(sv))
		return
	}
	if err := s.st.SaveSettings(r.Context(), sv); err != nil {
		s.internalError(w, r, "save settings", err)
		return
	}
	s.audit(user, "settings.update", "settings", "settings", map[string]any{"changes": changes})
	writeJSON(w, http.StatusOK, settingsView(sv))
}

// ---------------------------------------------------------------- retention

// handleRetentionRun implements POST /api/system/retention-run (ADMIN).
func (s *Server) handleRetentionRun(w http.ResponseWriter, r *http.Request, _ *store.Session, user *store.User) {
	now := s.Now()
	sv := s.settings()
	deleted := s.runRetention(now, false, user.Username, user.Role)
	s.retMu.Lock()
	total := s.retDeleted
	s.retMu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{
		"deletedCount": deleted,
		"deleted":      deleted, // legacy alias kept for the frontend client
		"cutoff":       now.Add(-time.Duration(sv.RetentionHours) * time.Hour).UTC().Format(time.RFC3339),
		"policyHours":  sv.RetentionHours,
		"totalDeleted": total,
		"protected":    "events attached to non-CLOSED incidents are never deleted",
	})
}
