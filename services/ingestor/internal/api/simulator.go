// Copyright © 2026 Parsa Fathi — Apache-2.0

// Simulator: deterministic seeded scenarios via internal/sim, ingested
// through the same internal validation path as /api/ingest (origin
// synthetic), tick generation, demo reset. Audited + SSE "simulator" phase
// events.
package api

import (
	"net/http"
	"strconv"

	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/ids"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/sim"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/sse"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/store"
)

// scenarioDefaultCount is the per-scenario event count that reproduces the
// full scripted behavior (documented in the sim package).
var scenarioDefaultCount = map[string]int{
	"clean_baseline":      40,
	"brute_force":         9,  // 8 failures + 1 success
	"credential_stuffing": 24, // 4 actors x 6 failures
	"traffic_burst":       130,
	"latency_spike":       60,
	"error_storm":         30,
	"config_change":       5, // 1 change + 4 heartbeats
	"authz_failures":      4,
	"malformed_batch":     12,
	"mixed_attack":        40,
}

// handleScenarios implements GET /api/simulator/scenarios.
func (s *Server) handleScenarios(w http.ResponseWriter, r *http.Request, _ *store.Session, _ *store.User) {
	scenarios := sim.Scenarios()
	out := make([]sim.Scenario, 0, len(scenarios))
	out = append(out, scenarios...)
	writeJSON(w, http.StatusOK, out) // bare array per contract
}

// handleScenarioRun implements POST /api/simulator/scenario (ANALYST+).
func (s *Server) handleScenarioRun(w http.ResponseWriter, r *http.Request, _ *store.Session, user *store.User) {
	var body struct {
		ScenarioID string `json:"scenarioId"`
		Seed       *int64 `json:"seed"`
	}
	if !s.decodeJSON(w, r, &body) {
		return
	}
	sc, ok := sim.GetScenario(body.ScenarioID)
	if !ok {
		badRequest(w, "INVALID_SCENARIO", "unknown scenarioId "+strconv.Quote(body.ScenarioID))
		return
	}
	seed := int64(42)
	if body.Seed != nil {
		if *body.Seed < 0 || *body.Seed > 1<<40 {
			badRequest(w, "INVALID_SETTINGS", "seed must be in 0..2^40")
			return
		}
		seed = *body.Seed
	}
	count := scenarioDefaultCount[sc.ID]
	now := s.Now()
	runID := ids.New("RUN")

	s.hub.Publish(sse.ChannelSimulator, sse.SimulatorPayload{RunID: runID, ScenarioID: sc.ID, Phase: "started"})

	docs, err := sim.Generate(sc.ID, seed, count, now)
	if err != nil {
		s.internalError(w, r, "generate scenario", err)
		return
	}
	res := s.ingestInternal(docs, now)

	s.hub.Publish(sse.ChannelSimulator, sse.SimulatorPayload{RunID: runID, ScenarioID: sc.ID, Phase: "completed"})

	s.audit(user, "simulator.run", "simulator", sc.ID, map[string]any{
		"scenarioId": sc.ID, "runId": runID, "seed": seed,
		"generated": len(docs), "accepted": res.Accepted, "duplicates": res.Duplicates, "rejected": res.Rejected,
	})

	res.ensure()
	writeJSON(w, http.StatusOK, map[string]any{
		"runId":                    runID,
		"scenarioId":               sc.ID,
		"seed":                     seed,
		"generated":                len(docs),
		"accepted":                 res.Accepted,
		"duplicates":               res.Duplicates,
		"rejected":                 res.Rejected,
		"eventIds":                 res.EventIDs,
		"duplicateIds":             res.DuplicateIDs,
		"rejectedItems":            res.RejectedItems,
		"expectedDetections":       sc.ExpectedDetections,
		"expectedIncidentSeverity": sc.ExpectedIncidentSeverity,
		"note":                     "scenario ingested through the internal validation path (origin synthetic); rejected items are recorded as validation failures",
	})
}

// handleTick implements POST /api/simulator/tick (ANALYST+).
func (s *Server) handleTick(w http.ResponseWriter, r *http.Request, _ *store.Session, user *store.User) {
	var body struct {
		Count *int `json:"count"`
	}
	if !s.decodeJSON(w, r, &body) {
		return
	}
	count := 12
	if body.Count != nil {
		if *body.Count < 1 || *body.Count > 50 {
			badRequest(w, "INVALID_SETTINGS", "count must be in 1..50")
			return
		}
		count = *body.Count
	}
	seed := 42 + s.tickSeq.Add(1) - 1 // deterministic per process: 42, 43, ...
	now := s.Now()
	docs := sim.GenerateNormal(seed, count, now)
	res := s.ingestInternal(docs, now)
	res.ensure()
	s.audit(user, "simulator.run", "simulator", "tick", map[string]any{
		"scenarioId": "tick", "seed": seed, "generated": len(docs),
		"accepted": res.Accepted, "duplicates": res.Duplicates, "rejected": res.Rejected,
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"generated":  len(docs),
		"accepted":   res.Accepted,
		"duplicates": res.Duplicates,
		"rejected":   res.Rejected,
		"eventIds":   res.EventIDs,
		"note":       "normal activity via internal/sim GenerateNormal (origin synthetic)",
	})
}

// handleSimulatorReset implements POST /api/simulator/reset (ADMIN).
func (s *Server) handleSimulatorReset(w http.ResponseWriter, r *http.Request, _ *store.Session, user *store.User) {
	ctx := r.Context()
	if err := s.st.ResetDemoData(ctx); err != nil {
		s.internalError(w, r, "reset demo data", err)
		return
	}
	// Re-seed a small clean baseline so the demo is not empty after reset.
	now := s.Now()
	docs, err := sim.Generate("clean_baseline", 42, 12, now)
	if err != nil {
		s.internalError(w, r, "reset baseline", err)
		return
	}
	res := s.ingestInternal(docs, now)
	res.ensure()
	s.audit(user, "demo.reset", "system", "demo", map[string]any{
		"ok": true, "baselineIngested": res.Accepted,
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":               true,
		"reset":            true,
		"baselineIngested": res.Accepted,
		"note":             "events, detections, incidents, notes, ai reports, validation failures and audit wiped; users, rules, settings and ingest keys kept",
	})
}
