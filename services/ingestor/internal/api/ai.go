// Copyright © 2026 Parsa Fathi — Apache-2.0

// AI investigation assistant: grounded evidence bundle, untrusted-data
// wrapping, strict report validation, honest 503s, stored AIReports.
package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/ids"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/llm"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/sse"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/store"
)

type aiBody struct {
	IncidentID string `json:"incidentId"`
	Question   string `json:"question"`
}

// handleAIInvestigate implements POST /api/ai/investigate (ANALYST+).
func (s *Server) handleAIInvestigate(w http.ResponseWriter, r *http.Request, _ *store.Session, user *store.User) {
	var body aiBody
	if !s.decodeJSON(w, r, &body) {
		return
	}
	body.IncidentID = strings.TrimSpace(body.IncidentID)
	if body.IncidentID == "" {
		badRequest(w, "MISSING_FIELD", "incidentId is required")
		return
	}
	if len(body.Question) > 500 {
		badRequest(w, "INVALID_SETTINGS", "question must be at most 500 characters")
		return
	}
	ctx := r.Context()
	inc, err := s.st.GetIncident(ctx, body.IncidentID)
	if err == store.ErrNotFound {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "no incident "+body.IncidentID)
		return
	}
	if err != nil {
		s.internalError(w, r, "get incident", err)
		return
	}

	sv := s.settings()
	details := map[string]any{"incidentId": inc.ID, "ok": false}

	fail := func(status int, code, msg string) {
		details["providerStatus"] = code
		s.audit(user, "ai.investigate", "incident", inc.ID, details)
		writeError(w, status, code, msg)
	}

	if !sv.AIEnabled {
		fail(http.StatusServiceUnavailable, "AI_DISABLED", "AI investigation is disabled in settings")
		return
	}
	if s.llm == nil {
		fail(http.StatusServiceUnavailable, "AI_DISABLED", "no AI provider configured")
		return
	}

	// --- assemble the grounded evidence bundle.
	views, _, err := s.st.IncidentEvents(ctx, inc.ID, 1, 50)
	if err != nil {
		s.internalError(w, r, "incident events", err)
		return
	}
	lines := make([]llm.EventLine, 0, len(views))
	for _, v := range views {
		lines = append(lines, llm.EventLine{
			ID: v.Event.EventID, Time: sse.FormatTime(v.Event.EventTime),
			Severity: v.Event.Severity, Category: v.Event.Category, SourceID: v.Event.SourceID,
			Actor: v.Event.Actor, Message: v.Event.Message,
		})
	}
	ruleDefs := []string{}
	if rl, err := s.st.GetRule(ctx, inc.RuleID); err == nil {
		ruleDefs = append(ruleDefs, fmt.Sprintf("%s %s: %s (enabled=%v, threshold=%v, window=%ds, cooldown=%ds)",
			rl.ID, rl.Name, rl.Description, rl.Enabled, rl.Condition.Threshold, rl.Condition.WindowSeconds, rl.CooldownSeconds))
	}
	mlCtx := "no ML evaluation available yet"
	if run, err := s.st.LastMlRun(ctx); err == nil {
		mlCtx = fmt.Sprintf("last ML evaluation (seed %d, dataset %d rows): iforest P=%.2f R=%.2f F1=%.2f; zscore P=%.2f R=%.2f; rules P=%.2f R=%.2f",
			run.Seed, run.DatasetSize,
			run.Methods["iforest"].Precision, run.Methods["iforest"].Recall, run.Methods["iforest"].F1,
			run.Methods["zscore"].Precision, run.Methods["zscore"].Recall,
			run.Methods["rules"].Precision, run.Methods["rules"].Recall)
	}

	ev := &llm.Evidence{
		IncidentID: inc.ID, IncidentTitle: inc.Title, Status: inc.Status, Severity: inc.Severity,
		CorrelationLabel: inc.CorrelationLabel,
		CreatedAt:        sse.FormatTime(inc.CreatedAt), UpdatedAt: sse.FormatTime(inc.UpdatedAt),
		EventCount: inc.EventCount, DetectionCount: inc.DetectionCount,
		Events: lines, Rules: ruleDefs, MlContext: mlCtx, Question: body.Question,
	}

	s.mtr.IncLLMRequest()
	start := time.Now()
	report, ierr := s.llm.Investigate(ctx, ev)
	dur := time.Since(start).Milliseconds()
	if ierr != nil {
		s.mtr.IncLLMFailure()
		details["providerStatus"] = "error"
		details["durationMs"] = dur
		details["ok"] = false
		s.audit(user, "ai.investigate", "incident", inc.ID, details)
		s.log.Warn("ai investigate failed", "err", ierr.Error())
		code := "PROVIDER_ERROR"
		switch {
		case errors.Is(ierr, llm.ErrTimeout):
			code = "PROVIDER_TIMEOUT"
		case errors.Is(ierr, llm.ErrBadResponse):
			code = "PROVIDER_BAD_RESPONSE"
		}
		writeError(w, http.StatusServiceUnavailable, code, "AI provider failed: "+ierr.Error())
		return
	}

	// Store the report (read-only record; AI never changes anything).
	repJSON, merr := json.Marshal(report)
	if merr != nil {
		repJSON = []byte("{}")
	}
	ar := &store.AIReport{
		ID: ids.New("AI"), IncidentID: inc.ID, ProviderStatus: "ok", TS: s.Now(), Report: repJSON,
	}
	if err := s.st.InsertAIReport(ctx, ar); err != nil {
		s.log.Warn("ai report insert failed", "err", err.Error())
	}

	details["providerStatus"] = "ok"
	details["durationMs"] = dur
	details["ok"] = true
	s.audit(user, "ai.investigate", "incident", inc.ID, details)

	writeJSON(w, http.StatusOK, map[string]any{
		"report": report,
		"provider": map[string]any{
			"name":   s.llm.Name(),
			"model":  s.llm.Model(),
			"status": "ok",
		},
		"durationMs": dur,
	})
}
