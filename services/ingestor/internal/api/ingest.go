// Copyright © 2026 Parsa Fathi — Apache-2.0

// Ingestion: POST /api/ingest (session ADMIN/ANALYST or X-Ingest-Key), strict
// validation via internal/event, idempotency on event_id, ValidationFailure
// rows for every rejection (never silently discarded), rate limiting, the
// shared internal ingest path used by the simulator, and pipeline handoff.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/audit"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/event"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/ids"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/pipeline"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/store"
)

// rejectedItem is one per-index rejection in the ingest response.
type rejectedItem struct {
	Index  int    `json:"index"`
	Reason string `json:"reason"`
}

// ingestResult carries the outcome of one internal ingest pass.
type ingestResult struct {
	Accepted      int            `json:"accepted"`
	Duplicates    int            `json:"duplicates"`
	Rejected      int            `json:"rejected"`
	EventIDs      []string       `json:"eventIds"`
	DuplicateIDs  []string       `json:"duplicateIds"`
	RejectedItems []rejectedItem `json:"rejectedItems"`
}

func (r *ingestResult) ensure() {
	if r.EventIDs == nil {
		r.EventIDs = []string{}
	}
	if r.DuplicateIDs == nil {
		r.DuplicateIDs = []string{}
	}
	if r.RejectedItems == nil {
		r.RejectedItems = []rejectedItem{}
	}
}

// handleIngest implements POST /api/ingest.
func (s *Server) handleIngest(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	now := s.Now()

	// --- authentication: session (ADMIN/ANALYST) OR X-Ingest-Key.
	principal := ""
	origin := ""
	if key, err := s.auth.AuthenticateIngestKey(ctx, r); err == nil {
		principal = "key:" + key.ID
		origin = "external"
	} else if _, user, err := s.auth.Authenticate(ctx, r); err == nil {
		if user.Role != "ADMIN" && user.Role != "ANALYST" {
			s.mtr.IncIngestCode("403")
			writeError(w, http.StatusForbidden, "FORBIDDEN", "ingest requires ADMIN or ANALYST role, or a valid X-Ingest-Key header")
			return
		}
		principal = "user:" + user.Username
		origin = "synthetic"
	} else {
		s.mtr.IncIngestCode("401")
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "ingest requires a session (ADMIN/ANALYST) or X-Ingest-Key header")
		return
	}

	// --- rate limit (sliding window, per principal; settings-driven).
	if ok, retry := s.auth.AllowIngest(principal); !ok {
		s.mtr.IncIngestCode("429")
		w.Header().Set("Retry-After", strconv.Itoa(int(retry.Seconds())))
		writeError(w, http.StatusTooManyRequests, "RATE_LIMITED",
			"ingest rate limit exceeded; retry after "+retry.Truncate(time.Second).String())
		return
	}

	// --- body: bounded by the contract (256KB).
	body, ok := s.readBody(w, r)
	if !ok {
		return
	}

	docs, ok := parseIngestBody(w, body)
	if !ok {
		s.mtr.IncIngestCode("400")
		return
	}

	sv := s.settings()
	cap := sv.MaxBatchSize
	if cap < 1 {
		cap = 1
	}
	if cap > event.MaxBatchSize {
		cap = event.MaxBatchSize // contract hard limit: 100 events
	}
	if len(docs) > cap {
		s.mtr.IncIngestCode("413")
		writeError(w, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE",
			"batch of "+strconv.Itoa(len(docs))+" events exceeds the maximum of "+strconv.Itoa(cap))
		return
	}

	res, err := s.ingestDocs(ctx, docs, origin, now)
	if err != nil {
		s.ingestError(w, err)
		return
	}
	res.ensure()

	s.mtr.IncIngestCode("202")
	writeJSON(w, http.StatusAccepted, res)
	s.maybeAutoRetention(now)
}

// readBody reads the request body with the contract cap (413 on overflow).
func (s *Server) readBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, event.MaxBodyBytes)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			s.mtr.IncIngestCode("413")
			writeError(w, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE",
				"request body exceeds "+strconv.Itoa(event.MaxBodyBytes)+" bytes")
			return nil, false
		}
		s.mtr.IncIngestCode("400")
		writeError(w, http.StatusBadRequest, "INVALID_JSON", "could not read request body: "+err.Error())
		return nil, false
	}
	if len(body) == 0 {
		s.mtr.IncIngestCode("400")
		writeError(w, http.StatusBadRequest, "INVALID_JSON", "request body is empty")
		return nil, false
	}
	return body, true
}

// parseIngestBody accepts a single event object or {"batch":[...]} and
// returns the raw per-event documents.
func parseIngestBody(w http.ResponseWriter, body []byte) ([]json.RawMessage, bool) {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(body, &top); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", "malformed JSON body: "+err.Error())
		return nil, false
	}
	if raw, ok := top["batch"]; ok {
		var docs []json.RawMessage
		if err := json.Unmarshal(raw, &docs); err != nil {
			writeError(w, http.StatusBadRequest, "INVALID_JSON", `"batch" must be an array of events: `+err.Error())
			return nil, false
		}
		if len(docs) == 0 {
			writeError(w, http.StatusBadRequest, "INVALID_JSON", `"batch" must not be empty`)
			return nil, false
		}
		return docs, true
	}
	return []json.RawMessage{json.RawMessage(body)}, true
}

// ingestDocs validates, persists (idempotently), records rejections and hands
// the accepted batch to the pipeline. Used by the HTTP path and the
// simulator. origin is "synthetic" or "external".
func (s *Server) ingestDocs(ctx context.Context, docs []json.RawMessage, origin string, now time.Time) (*ingestResult, error) {
	res := &ingestResult{}
	var toProcess []*event.Event
	var acceptedIDs []string

	for i, doc := range docs {
		ev, rej := event.Decode(doc, now)
		s.mtr.IncReceived(origin)
		if rej != nil {
			reason := rej.Code + ": " + rej.Message
			if len(reason) > 200 {
				reason = reason[:200]
			}
			res.Rejected++
			res.RejectedItems = append(res.RejectedItems, rejectedItem{Index: i, Reason: reason})
			vf := &store.ValidationFailure{
				ID: ids.New("VF"), TS: now, Reason: rej.Code, Detail: rej.Message,
			}
			if err := s.st.InsertValidationFailure(ctx, vf); err != nil {
				s.log.Error("validation failure insert failed", "err", err.Error())
			}
			s.mtr.IncRejected(1)
			continue
		}
		ev.Origin = origin
		ev.IngestTime = now
		ev.Status = "VALIDATED"
		inserted, err := s.st.InsertEvent(ctx, ev)
		if err != nil {
			return nil, err
		}
		if !inserted {
			res.Duplicates++
			res.DuplicateIDs = append(res.DuplicateIDs, ev.EventID)
			s.mtr.IncDuplicates(1)
			continue
		}
		res.Accepted++
		res.EventIDs = append(res.EventIDs, ev.EventID)
		acceptedIDs = append(acceptedIDs, ev.EventID)
		toProcess = append(toProcess, ev)
		s.mtr.IncAccepted(1)
	}

	// Hand off to the pipeline. An empty tick still evaluates time-window
	// rules (validation-failure threshold) when rejections occurred.
	if len(toProcess) > 0 || res.Rejected > 0 {
		if s.pipe == nil {
			// Tests / embedded use without a pipeline: process synchronously is
			// not available; keep events VALIDATED and log honestly.
			s.log.Warn("no pipeline configured; events remain VALIDATED", "count", len(toProcess))
			return res, nil
		}
		if err := s.pipe.TryEnqueue(toProcess); err != nil {
			if errors.Is(err, pipeline.ErrQueueFull) && len(acceptedIDs) > 0 {
				// Backpressure: roll back this request's inserts.
				if n, derr := s.st.DeleteEvents(ctx, acceptedIDs); derr != nil {
					s.log.Error("backpressure rollback failed", "err", derr.Error())
				} else {
					s.log.Warn("ingest rolled back under backpressure", "deleted", n)
				}
			}
			return nil, err
		}
	}
	return res, nil
}

// ingestError maps pipeline handoff errors to honest 503s.
func (s *Server) ingestError(w http.ResponseWriter, err error) {
	if errors.Is(err, pipeline.ErrQueueFull) {
		s.mtr.IncIngestCode("503")
		writeError(w, http.StatusServiceUnavailable, "BACKPRESSURE",
			"processing queue is full; request rolled back, retry shortly")
		return
	}
	if errors.Is(err, pipeline.ErrShuttingDown) {
		s.mtr.IncIngestCode("503")
		writeError(w, http.StatusServiceUnavailable, "SHUTTING_DOWN",
			"service is shutting down; not accepting new events")
		return
	}
	s.mtr.IncIngestCode("500")
	s.log.Error("ingest failed", "err", err.Error())
	writeError(w, http.StatusInternalServerError, "INTERNAL", "ingest failed")
}

// ingestInternal is the simulator path: no rate limit, origin synthetic.
// Never fails the enclosing request; errors are logged.
func (s *Server) ingestInternal(docs []json.RawMessage, now time.Time) *ingestResult {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(context.Background()), 15*time.Second)
	defer cancel()
	res, err := s.ingestDocs(ctx, docs, "synthetic", now)
	if err != nil {
		s.log.Error("internal ingest failed", "err", err.Error())
		return &ingestResult{}
	}
	return res
}

// maybeAutoRetention runs the retention sweep at most every 5 minutes,
// triggered by ingest (cheap check, contract §Retention).
func (s *Server) maybeAutoRetention(now time.Time) {
	s.retMu.Lock()
	due := now.Sub(s.retAutoCheck) >= 5*time.Minute
	if due {
		s.retAutoCheck = now
	}
	s.retMu.Unlock()
	if !due {
		return
	}
	s.runRetention(now, true, "system", "SYSTEM")
}

// runRetention deletes events older than the policy, protecting events of
// non-CLOSED incidents. Audited (retention.run) on every run.
func (s *Server) runRetention(now time.Time, auto bool, actor, role string) int64 {
	sv := s.settings()
	cutoff := now.Add(-time.Duration(sv.RetentionHours) * time.Hour)
	ctx, cancel := context.WithTimeout(context.WithoutCancel(context.Background()), 20*time.Second)
	defer cancel()
	deleted, err := s.st.DeleteEventsBefore(ctx, cutoff)
	if err != nil {
		s.log.Error("retention sweep failed", "err", err.Error())
		return 0
	}
	s.retMu.Lock()
	s.retLastRun = now
	s.retDeleted += int64(deleted)
	total := s.retDeleted
	s.retMu.Unlock()
	if aerr := audit.Log(context.WithoutCancel(context.Background()), s.st, actor, role,
		"retention.run", "system", "events",
		map[string]any{"auto": auto, "deletedCount": deleted, "cutoff": cutoff.UTC().Format(time.RFC3339)}); aerr != nil {
		s.log.Warn("audit write failed", "err", aerr.Error())
	}
	if deleted > 0 {
		s.log.Info("retention sweep", "deleted", deleted, "cutoff", cutoff.UTC().Format(time.RFC3339), "auto", auto)
	}
	return total
}
