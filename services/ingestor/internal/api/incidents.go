// Copyright © 2026 Parsa Fathi — Apache-2.0

// Incidents: list/detail/PATCH (validated lifecycle transitions), notes and
// the paginated incident-events endpoint.
package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/event"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/ids"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/incident"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/sse"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/store"
)

// handleIncidentsList implements GET /api/incidents.
func (s *Server) handleIncidentsList(w http.ResponseWriter, r *http.Request, _ *store.Session, _ *store.User) {
	q := r.URL.Query()
	f := store.IncidentFilter{}
	if v := q.Get("status"); v != "" {
		if !incident.ValidStatus(v) {
			badFilter(w, "status", "must be one of "+strings.Join(store.IncidentStatuses, "|"))
			return
		}
		f.Status = v
	}
	if v := q.Get("severity"); v != "" {
		if !event.ValidSeverity(v) {
			badFilter(w, "severity", "must be one of "+strings.Join(event.Severities, "|"))
			return
		}
		f.Severity = v
	}
	if v := q.Get("ruleId"); v != "" {
		if len(v) > 64 {
			badFilter(w, "ruleId", "must be at most 64 characters")
			return
		}
		f.RuleID = v
	}
	if v := q.Get("assignedTo"); v != "" {
		if len(v) > 64 {
			badFilter(w, "assignedTo", "must be at most 64 characters")
			return
		}
		f.AssignedTo = v
	}
	if v := q.Get("q"); v != "" {
		if len(strings.TrimSpace(v)) < 2 || len(v) > 256 {
			badFilter(w, "q", "must be 2..256 characters")
			return
		}
		f.Q = v
	}
	sortKey := "createdAt"
	if v := q.Get("sort"); v != "" {
		switch v {
		case "createdAt", "severity", "updatedAt":
			sortKey = v
		default:
			badFilter(w, "sort", "must be one of createdAt|severity|updatedAt")
			return
		}
	}
	page, pageSize, ok := pageParams(w, r)
	if !ok {
		return
	}
	incs, total, err := s.st.ListIncidents(r.Context(), f, sortKey, page, pageSize)
	if err != nil {
		s.internalError(w, r, "list incidents", err)
		return
	}
	out := make([]incidentView, 0, len(incs))
	for _, inc := range incs {
		out = append(out, viewIncident(inc))
	}
	writeJSON(w, http.StatusOK, pageEnvelope{Data: out, Page: page, PageSize: pageSize, Total: total})
}

// handleIncidentDetail implements GET /api/incidents/{id}.
func (s *Server) handleIncidentDetail(w http.ResponseWriter, r *http.Request, _ *store.Session, _ *store.User) {
	id := r.PathValue("id")
	ctx := r.Context()
	inc, err := s.st.GetIncident(ctx, id)
	if err == store.ErrNotFound {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "no incident "+id)
		return
	}
	if err != nil {
		s.internalError(w, r, "get incident", err)
		return
	}

	views, _, err := s.st.IncidentEvents(ctx, id, 1, 200)
	if err != nil {
		s.internalError(w, r, "incident events", err)
		return
	}
	events := make([]compactEvent, 0, len(views))
	for _, v := range views {
		events = append(events, compactEvent{
			ID: v.Event.EventID, EventTime: sse.FormatTime(v.Event.EventTime),
			Severity: v.Event.Severity, Category: v.Event.Category, SourceID: v.Event.SourceID,
			Message: sse.TruncateMessage(v.Event.Message, 140), Late: v.Late,
		})
	}
	dets, _, err := s.st.ListDetections(ctx, store.DetectionFilter{IncidentID: id}, 1, 100)
	if err != nil {
		s.internalError(w, r, "incident detections", err)
		return
	}
	detViews := make([]detectionView, 0, len(dets))
	for _, d := range dets {
		detViews = append(detViews, viewDetection(d))
	}
	notes, err := s.st.ListNotes(ctx, id)
	if err != nil {
		s.internalError(w, r, "incident notes", err)
		return
	}
	noteViews := make([]noteView, 0, len(notes))
	for _, n := range notes {
		noteViews = append(noteViews, noteView{
			ID: n.ID, IncidentID: n.IncidentID, Author: n.Author, Body: n.Body,
			CreatedAt: sse.FormatTime(n.CreatedAt),
		})
	}
	reports, err := s.st.ListAIReports(ctx, id)
	if err != nil {
		s.internalError(w, r, "incident ai reports", err)
		return
	}
	aiRefs := make([]aiReportRefView, 0, len(reports))
	for _, rp := range reports {
		aiRefs = append(aiRefs, aiReportRefView{ID: rp.ID, TS: sse.FormatTime(rp.TS)})
	}
	history := make([]statusHistoryView, 0, len(inc.StatusHistory))
	for _, h := range inc.StatusHistory {
		history = append(history, statusHistoryView{
			From: h.FromStatus, To: h.ToStatus, At: sse.FormatTime(h.TS), Actor: h.Actor, Note: h.Note,
		})
	}
	writeJSON(w, http.StatusOK, incidentDetailView{
		incidentView:  viewIncident(*inc),
		StatusHistory: history, Events: events, Detections: detViews,
		Notes: noteViews, AIReports: aiRefs,
	})
}

// incidentPatchBody is the PATCH /api/incidents/{id} body.
type incidentPatchBody struct {
	Status            *string `json:"status"`
	AssignedTo        *string `json:"assignedTo"`
	ResolutionSummary *string `json:"resolutionSummary"`
}

// handleIncidentPatch implements PATCH /api/incidents/{id} (ANALYST+).
func (s *Server) handleIncidentPatch(w http.ResponseWriter, r *http.Request, _ *store.Session, user *store.User) {
	id := r.PathValue("id")
	var body incidentPatchBody
	if !s.decodeJSON(w, r, &body) {
		return
	}
	ctx := r.Context()
	inc, err := s.st.GetIncident(ctx, id)
	if err == store.ErrNotFound {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "no incident "+id)
		return
	}
	if err != nil {
		s.internalError(w, r, "get incident", err)
		return
	}

	now := s.Now()
	details := map[string]any{"incidentId": inc.ID}

	if body.AssignedTo != nil {
		v := strings.TrimSpace(*body.AssignedTo)
		if len(v) > 64 {
			badRequest(w, "INVALID_SETTINGS", "assignedTo must be at most 64 characters")
			return
		}
		details["assignedTo"] = v
		inc.AssignedTo = v
	}
	if body.ResolutionSummary != nil {
		v := *body.ResolutionSummary
		if len(v) > 4000 {
			badRequest(w, "INVALID_SETTINGS", "resolutionSummary must be at most 4000 characters")
			return
		}
		details["resolutionSummary"] = v
		inc.ResolutionSummary = v
	}

	if body.Status != nil {
		target := strings.TrimSpace(*body.Status)
		if target == "" {
			badRequest(w, "INVALID_STATUS", "status must not be empty")
			return
		}
		if !incident.ValidStatus(target) {
			badRequest(w, "INVALID_STATUS", "status must be one of "+strings.Join(store.IncidentStatuses, "|"))
			return
		}
		if terr := incident.ValidateTransition(inc.Status, target); terr != nil {
			var same *incident.SameStatusError
			var illegal *incident.IllegalTransitionError
			switch {
			case errors.As(terr, &same):
				// 400 per the platform contract (demo edition returns 400 for
				// both same-status and illegal transitions — unified contract)
				writeError(w, http.StatusBadRequest, "INVALID_TRANSITION", same.Error())
				return
			case errors.As(terr, &illegal):
				writeError(w, http.StatusBadRequest, "INVALID_TRANSITION", illegal.Error()+" (validated transitions only)")
				return
			default:
				s.internalError(w, r, "validate transition", terr)
				return
			}
		}
		if incident.RequiresAdmin(inc.Status, target) && user.Role != "ADMIN" {
			writeError(w, http.StatusForbidden, "FORBIDDEN", "reopening a CLOSED incident requires ADMIN")
			return
		}
		if target == store.IncidentResolved && !incident.ValidateResolutionSummary(inc.ResolutionSummary) {
			writeError(w, http.StatusBadRequest, "RESOLUTION_REQUIRED",
				"resolving requires a resolutionSummary of at least 10 characters")
			return
		}
		from := inc.Status
		inc.Status = target
		inc.StatusHistory = append(inc.StatusHistory, store.StatusHistoryEntry{
			FromStatus: from, ToStatus: target, Actor: user.Username, TS: now,
		})
		switch target {
		case store.IncidentResolved:
			inc.ResolvedAt = now
		case store.IncidentClosed:
			inc.ClosedAt = now
		}
		details["from"] = from
		details["to"] = target
	}

	inc.UpdatedAt = now
	if err := s.st.UpdateIncident(ctx, inc); err != nil {
		s.internalError(w, r, "update incident", err)
		return
	}

	s.audit(user, "incident.update", "incident", inc.ID, details)
	s.hub.Publish(sse.ChannelIncidentUpdate, sse.IncidentPayload{
		ID: inc.ID, Title: inc.Title, Severity: inc.Severity, Status: inc.Status,
		RuleID: inc.RuleID, EventCount: inc.EventCount, DetectionCount: inc.DetectionCount,
		UpdatedAt: sse.FormatTime(inc.UpdatedAt),
	})

	// Render the full detail (richer than the list view).
	s.renderIncidentDetail(w, r, inc)
}

// renderIncidentDetail re-reads and renders the full incident detail.
func (s *Server) renderIncidentDetail(w http.ResponseWriter, r *http.Request, inc *store.Incident) {
	// Reuse the detail handler logic by faking a request path value is not
	// possible; do a direct read instead.
	ctx := r.Context()
	views, _, err := s.st.IncidentEvents(ctx, inc.ID, 1, 200)
	if err != nil {
		s.internalError(w, r, "incident events", err)
		return
	}
	events := make([]compactEvent, 0, len(views))
	for _, v := range views {
		events = append(events, compactEvent{
			ID: v.Event.EventID, EventTime: sse.FormatTime(v.Event.EventTime),
			Severity: v.Event.Severity, Category: v.Event.Category, SourceID: v.Event.SourceID,
			Message: sse.TruncateMessage(v.Event.Message, 140), Late: v.Late,
		})
	}
	dets, _, _ := s.st.ListDetections(ctx, store.DetectionFilter{IncidentID: inc.ID}, 1, 100)
	detViews := make([]detectionView, 0, len(dets))
	for _, d := range dets {
		detViews = append(detViews, viewDetection(d))
	}
	notes, _ := s.st.ListNotes(ctx, inc.ID)
	noteViews := make([]noteView, 0, len(notes))
	for _, n := range notes {
		noteViews = append(noteViews, noteView{ID: n.ID, IncidentID: n.IncidentID, Author: n.Author, Body: n.Body, CreatedAt: sse.FormatTime(n.CreatedAt)})
	}
	reports, _ := s.st.ListAIReports(ctx, inc.ID)
	aiRefs := make([]aiReportRefView, 0, len(reports))
	for _, rp := range reports {
		aiRefs = append(aiRefs, aiReportRefView{ID: rp.ID, TS: sse.FormatTime(rp.TS)})
	}
	history := make([]statusHistoryView, 0, len(inc.StatusHistory))
	for _, h := range inc.StatusHistory {
		history = append(history, statusHistoryView{From: h.FromStatus, To: h.ToStatus, At: sse.FormatTime(h.TS), Actor: h.Actor, Note: h.Note})
	}
	writeJSON(w, http.StatusOK, incidentDetailView{
		incidentView:  viewIncident(*inc),
		StatusHistory: history, Events: events, Detections: detViews,
		Notes: noteViews, AIReports: aiRefs,
	})
}

// handleIncidentNote implements POST /api/incidents/{id}/notes (ANALYST+).
func (s *Server) handleIncidentNote(w http.ResponseWriter, r *http.Request, _ *store.Session, user *store.User) {
	id := r.PathValue("id")
	var body struct {
		Body string `json:"body"`
	}
	if !s.decodeJSON(w, r, &body) {
		return
	}
	b := strings.TrimSpace(body.Body)
	if len(b) < 1 {
		badRequest(w, "INVALID_NOTE", "note body must not be empty")
		return
	}
	if len(b) > 4000 {
		badRequest(w, "INVALID_NOTE", "note body must be at most 4000 characters")
		return
	}
	ctx := r.Context()
	if _, err := s.st.GetIncident(ctx, id); err == store.ErrNotFound {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "no incident "+id)
		return
	} else if err != nil {
		s.internalError(w, r, "get incident", err)
		return
	}
	now := s.Now()
	n := &store.Note{
		ID: ids.New("NOTE"), IncidentID: id, Author: user.Username,
		Body: b, CreatedAt: now,
	}
	if err := s.st.InsertNote(ctx, n); err != nil {
		s.internalError(w, r, "insert note", err)
		return
	}
	s.audit(user, "incident.note", "incident", id, map[string]any{"incidentId": id, "noteId": n.ID, "chars": len(b)})
	writeJSON(w, http.StatusOK, noteView{
		ID: n.ID, IncidentID: n.IncidentID, Author: n.Author, Body: n.Body, CreatedAt: sse.FormatTime(n.CreatedAt),
	})
}

// handleIncidentEvents implements GET /api/incidents/{id}/events.
func (s *Server) handleIncidentEvents(w http.ResponseWriter, r *http.Request, _ *store.Session, _ *store.User) {
	id := r.PathValue("id")
	page, pageSize, ok := pageParams(w, r)
	if !ok {
		return
	}
	if _, err := s.st.GetIncident(r.Context(), id); err == store.ErrNotFound {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "no incident "+id)
		return
	} else if err != nil {
		s.internalError(w, r, "get incident", err)
		return
	}
	views, total, err := s.st.IncidentEvents(r.Context(), id, page, pageSize)
	if err != nil {
		s.internalError(w, r, "incident events", err)
		return
	}
	out := make([]incidentEventView, 0, len(views))
	for _, v := range views {
		out = append(out, incidentEventView{eventView: viewEvent(v.Event), Late: v.Late})
	}
	writeJSON(w, http.StatusOK, pageEnvelope{Data: out, Page: page, PageSize: pageSize, Total: total})
}
