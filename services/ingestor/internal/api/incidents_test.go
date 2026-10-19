// Copyright © 2026 Parsa Fathi — Apache-2.0

package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/event"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/store"
)

// ---------------------------------------------------------------- simulator E2E

func TestSimulatorScenarioEndToEnd(t *testing.T) {
	e := newTestEnv(t, "")
	analyst := e.loginClient("analyst", "analyst123")
	viewer := e.loginClient("viewer", "viewer123")
	anon := &http.Client{Timeout: 10 * time.Second}

	// scenarios list: viewer allowed (read), anonymous 401
	resp, raw := e.do(viewer, http.MethodGet, "/api/simulator/scenarios", "")
	var scenarios []map[string]any
	json.Unmarshal([]byte(raw), &scenarios)
	if resp.StatusCode != 200 || len(scenarios) != 10 {
		t.Fatalf("scenarios: %d %s", resp.StatusCode, raw)
	}
	resp, _ = e.do(anon, http.MethodGet, "/api/simulator/scenarios", "")
	if resp.StatusCode != 401 {
		t.Fatalf("anon scenarios: %d", resp.StatusCode)
	}

	// unknown scenario -> 400
	resp, raw = e.do(analyst, http.MethodPost, "/api/simulator/scenario", `{"scenarioId":"nope"}`)
	if resp.StatusCode != 400 || !strings.Contains(string(raw), "INVALID_SCENARIO") {
		t.Fatalf("unknown scenario: %d %s", resp.StatusCode, raw)
	}

	// brute_force -> SG-RULE-001 detection + INC incident + SG-RULE-003
	out := e.runScenario("brute_force")
	if out["generated"].(float64) != 9 || out["accepted"].(float64) != 9 {
		t.Fatalf("scenario response: %v", out)
	}
	waitFor(t, 8*time.Second, "brute_force detections+incidents", func() bool {
		dets, dtotal, _ := e.st.ListDetections(context.Background(), store.DetectionFilter{RuleID: "SG-RULE-001"}, 1, 10)
		incs, itotal, _ := e.st.ListIncidents(context.Background(), store.IncidentFilter{RuleID: "SG-RULE-001"}, "createdAt", 1, 10)
		return dtotal >= 1 && len(dets) >= 1 && itotal >= 1 && len(incs) >= 1
	})

	// API view: detections filter by rule
	resp, raw = e.do(analyst, http.MethodGet, "/api/detections?ruleId=SG-RULE-001", "")
	var dlist struct {
		Data  []map[string]any `json:"data"`
		Total int              `json:"total"`
	}
	json.Unmarshal([]byte(raw), &dlist)
	if resp.StatusCode != 200 || dlist.Total < 1 {
		t.Fatalf("detections?ruleId: %s", raw)
	}
	det := dlist.Data[0]
	if det["ruleId"] != "SG-RULE-001" || det["incidentId"] == "" {
		t.Fatalf("detection shape: %v", det)
	}
	detail, _ := det["detail"].(map[string]any)
	if detail == nil || detail["matchedCount"].(float64) < 5 {
		t.Fatalf("detection detail: %v", det)
	}

	// incidents list contains the SG-RULE-001 incident (high)
	resp, raw = e.do(analyst, http.MethodGet, "/api/incidents?ruleId=SG-RULE-001", "")
	var ilist struct {
		Data  []map[string]any `json:"data"`
		Total int              `json:"total"`
	}
	json.Unmarshal([]byte(raw), &ilist)
	if resp.StatusCode != 200 || ilist.Total < 1 {
		t.Fatalf("incidents?ruleId: %s", raw)
	}
	inc := ilist.Data[0]
	if inc["severity"] != "high" || inc["status"] != "NEW" {
		t.Fatalf("incident shape: %v", inc)
	}
	incID, _ := inc["id"].(string)

	// incident detail: events + detections + statusHistory
	resp, raw = e.do(analyst, http.MethodGet, "/api/incidents/"+incID, "")
	var idet struct {
		StatusHistory []map[string]any `json:"statusHistory"`
		Events        []map[string]any `json:"events"`
		Detections    []map[string]any `json:"detections"`
		EventCount    float64          `json:"eventCount"`
	}
	json.Unmarshal([]byte(raw), &idet)
	if resp.StatusCode != 200 || len(idet.StatusHistory) < 1 || len(idet.Events) != 8 || len(idet.Detections) < 1 {
		t.Fatalf("incident detail: %d %s", resp.StatusCode, raw)
	}
	if idet.EventCount != 8 {
		t.Fatalf("eventCount: %v", idet.EventCount)
	}

	// SG-RULE-003 sequence detection also fired
	resp, raw = e.do(analyst, http.MethodGet, "/api/detections?ruleId=SG-RULE-003", "")
	json.Unmarshal([]byte(raw), &dlist)
	if dlist.Total < 1 {
		t.Fatalf("SG-RULE-003 detection: %s", raw)
	}

	// incident events endpoint paginated
	resp, raw = e.do(analyst, http.MethodGet, "/api/incidents/"+incID+"/events?pageSize=3", "")
	var ievs struct {
		Data  []map[string]any `json:"data"`
		Total int              `json:"total"`
	}
	json.Unmarshal([]byte(raw), &ievs)
	if ievs.Total != 8 || len(ievs.Data) != 3 {
		t.Fatalf("incident events page: %s", raw)
	}
	if ievs.Data[0]["late"] != false {
		t.Fatalf("late flag: %v", ievs.Data[0])
	}

	// other scenarios: traffic_burst -> 002; error_storm -> 004; authz_failures -> 005; config_change -> 006
	for _, tc := range []struct{ scenario, rule string }{
		{"traffic_burst", "SG-RULE-002"},
		{"error_storm", "SG-RULE-004"},
		{"authz_failures", "SG-RULE-005"},
		{"config_change", "SG-RULE-006"},
	} {
		e.runScenario(tc.scenario)
		waitFor(t, 8*time.Second, tc.rule+" detection", func() bool {
			_, total, _ := e.st.ListDetections(context.Background(), store.DetectionFilter{RuleID: tc.rule}, 1, 10)
			return total >= 1
		})
	}

	// malformed_batch -> SG-RULE-007 (12 rejections, >=10 in 60s)
	e.runScenario("malformed_batch")
	waitFor(t, 8*time.Second, "SG-RULE-007 detection", func() bool {
		_, total, _ := e.st.ListDetections(context.Background(), store.DetectionFilter{RuleID: "SG-RULE-007"}, 1, 10)
		return total >= 1
	})
	incs, itotal, _ := e.st.ListIncidents(context.Background(), store.IncidentFilter{RuleID: "SG-RULE-007"}, "createdAt", 1, 10)
	if itotal != 1 || incs[0].Severity != "low" {
		t.Fatalf("SG-RULE-007 incident: %d %+v", itotal, incs)
	}

	// audit trail records simulator.run
	admin := e.loginClient("admin", "admin123")
	resp, raw = e.do(admin, http.MethodGet, "/api/audit?action=simulator.run", "")
	if !strings.Contains(string(raw), "brute_force") {
		t.Fatalf("simulator audit: %s", raw)
	}
}

// ---------------------------------------------------------------- incident lifecycle

func TestIncidentLifecycleTransitions(t *testing.T) {
	e := newTestEnv(t, "")
	e.runScenario("brute_force")
	waitFor(t, 8*time.Second, "incidents", func() bool {
		_, itotal, _ := e.st.ListIncidents(context.Background(), store.IncidentFilter{}, "createdAt", 1, 10)
		return itotal >= 2 // rule 001 + rule 003
	})
	analyst := e.loginClient("analyst", "analyst123")
	viewer := e.loginClient("viewer", "viewer123")

	// pick the SG-RULE-001 incident (open)
	resp, raw := e.do(analyst, http.MethodGet, "/api/incidents?ruleId=SG-RULE-001", "")
	var ilist struct {
		Data []map[string]any `json:"data"`
	}
	json.Unmarshal([]byte(raw), &ilist)
	incID := ilist.Data[0]["id"].(string)

	patch := func(c *http.Client, body string) (*http.Response, string) {
		return e.do(c, http.MethodPatch, "/api/incidents/"+incID, body)
	}

	// viewer -> 403
	resp, raw = patch(viewer, `{"status":"TRIAGED"}`)
	if resp.StatusCode != 403 {
		t.Fatalf("viewer patch: %d %s", resp.StatusCode, raw)
	}
	// unknown incident -> 404
	resp, raw = e.do(analyst, http.MethodPatch, "/api/incidents/INC-999999", `{"status":"TRIAGED"}`)
	if resp.StatusCode != 404 {
		t.Fatalf("unknown incident: %d", resp.StatusCode)
	}
	// illegal transition NEW -> (back to) nothing invalid yet: use bogus status
	resp, raw = patch(analyst, `{"status":"WEIRD"}`)
	if resp.StatusCode != 400 || !strings.Contains(string(raw), "INVALID_STATUS") {
		t.Fatalf("bogus status: %d %s", resp.StatusCode, raw)
	}
	// same-status no-op -> 409
	resp, raw = patch(analyst, `{"status":"NEW"}`)
	if resp.StatusCode != 400 || !strings.Contains(string(raw), "INVALID_TRANSITION") {
		t.Fatalf("same status: %d %s", resp.StatusCode, raw)
	}
	// legal: NEW -> TRIAGED -> INVESTIGATING (assign)
	resp, raw = patch(analyst, `{"status":"TRIAGED"}`)
	if resp.StatusCode != 200 {
		t.Fatalf("triage: %d %s", resp.StatusCode, raw)
	}
	resp, raw = patch(analyst, `{"status":"INVESTIGATING","assignedTo":"analyst"}`)
	if resp.StatusCode != 200 || !strings.Contains(string(raw), `"assignedTo":"analyst"`) {
		t.Fatalf("investigate: %d %s", resp.StatusCode, raw)
	}
	// resolve without summary -> 400 RESOLUTION_REQUIRED
	resp, raw = patch(analyst, `{"status":"RESOLVED"}`)
	if resp.StatusCode != 400 || !strings.Contains(string(raw), "RESOLUTION_REQUIRED") {
		t.Fatalf("resolve w/o summary: %d %s", resp.StatusCode, raw)
	}
	// short summary -> 400
	resp, raw = patch(analyst, `{"status":"RESOLVED","resolutionSummary":"short"}`)
	if resp.StatusCode != 400 || !strings.Contains(string(raw), "RESOLUTION_REQUIRED") {
		t.Fatalf("short summary: %d %s", resp.StatusCode, raw)
	}
	// valid resolution -> 200
	resp, raw = patch(analyst, `{"status":"RESOLVED","resolutionSummary":"blocked the offending actor account"}`)
	if resp.StatusCode != 200 || !strings.Contains(string(raw), `"resolvedAt"`) {
		t.Fatalf("resolve: %d %s", resp.StatusCode, raw)
	}
	// closed -> reopen as analyst is allowed (RESOLVED->INVESTIGATING, ANALYST+)
	resp, raw = patch(analyst, `{"status":"CLOSED"}`)
	if resp.StatusCode != 200 {
		t.Fatalf("close: %d %s", resp.StatusCode, raw)
	}
	// CLOSED -> INVESTIGATING by ANALYST -> 403 (admin only)
	resp, raw = patch(analyst, `{"status":"INVESTIGATING"}`)
	if resp.StatusCode != 403 {
		t.Fatalf("analyst reopen: %d %s", resp.StatusCode, raw)
	}
	// by ADMIN -> 200
	admin := e.loginClient("admin", "admin123")
	resp, raw = patch(admin, `{"status":"INVESTIGATING"}`)
	if resp.StatusCode != 200 {
		t.Fatalf("admin reopen: %d %s", resp.StatusCode, raw)
	}
	// statusHistory grew accordingly
	resp, raw = e.do(analyst, http.MethodGet, "/api/incidents/"+incID, "")
	var idet struct {
		StatusHistory []map[string]any `json:"statusHistory"`
	}
	json.Unmarshal([]byte(raw), &idet)
	if len(idet.StatusHistory) != 6 {
		t.Fatalf("statusHistory: %v", idet.StatusHistory)
	}
	// audit has incident.update entries
	resp, raw = e.do(admin, http.MethodGet, "/api/audit?action=incident.update", "")
	if !strings.Contains(string(raw), incID) {
		t.Fatalf("incident audit: %s", raw)
	}

	// notes: viewer 403; analyst 200; empty 400; unknown incident 404
	resp, raw = e.do(viewer, http.MethodPost, "/api/incidents/"+incID+"/notes", `{"body":"note"}`)
	if resp.StatusCode != 403 {
		t.Fatalf("viewer note: %d", resp.StatusCode)
	}
	resp, raw = e.do(analyst, http.MethodPost, "/api/incidents/"+incID+"/notes", `{"body":"first analysis note"}`)
	if resp.StatusCode != 200 || !strings.Contains(string(raw), "first analysis note") {
		t.Fatalf("note: %d %s", resp.StatusCode, raw)
	}
	resp, raw = e.do(analyst, http.MethodPost, "/api/incidents/"+incID+"/notes", `{"body":"  "}`)
	if resp.StatusCode != 400 || !strings.Contains(string(raw), "INVALID_NOTE") {
		t.Fatalf("empty note: %d %s", resp.StatusCode, raw)
	}
	resp, raw = e.do(analyst, http.MethodPost, "/api/incidents/INC-999999/notes", `{"body":"x"}`)
	if resp.StatusCode != 404 {
		t.Fatalf("note unknown incident: %d", resp.StatusCode)
	}
	resp, raw = e.do(analyst, http.MethodGet, "/api/incidents/"+incID, "")
	if !strings.Contains(string(raw), "first analysis note") {
		t.Fatalf("note not in detail: %s", raw)
	}

	// incidents list filters + sort validation
	resp, raw = e.do(analyst, http.MethodGet, "/api/incidents?status=INVESTIGATING", "")
	if !strings.Contains(string(raw), incID) {
		t.Fatalf("status filter: %s", raw)
	}
	resp, raw = e.do(analyst, http.MethodGet, "/api/incidents?sort=bogus", "")
	if resp.StatusCode != 400 || !strings.Contains(string(raw), "sort") {
		t.Fatalf("bad sort: %d %s", resp.StatusCode, raw)
	}
	resp, raw = e.do(analyst, http.MethodGet, "/api/incidents?q=x", "")
	if resp.StatusCode != 400 {
		t.Fatalf("short q: %d", resp.StatusCode)
	}
	resp, raw = e.do(analyst, http.MethodGet, "/api/incidents/INC-999999", "")
	if resp.StatusCode != 404 {
		t.Fatalf("unknown incident detail: %d", resp.StatusCode)
	}
}

// ---------------------------------------------------------------- rules RBAC + audit

func TestRulesPatchAndAudit(t *testing.T) {
	e := newTestEnv(t, "")
	analyst := e.loginClient("analyst", "analyst123")
	viewer := e.loginClient("viewer", "viewer123")
	admin := e.loginClient("admin", "admin123")

	// list: all roles
	for _, c := range []*http.Client{viewer, analyst, admin} {
		resp, raw := e.do(c, http.MethodGet, "/api/rules", "")
		var rl struct {
			Data []map[string]any `json:"data"`
		}
		json.Unmarshal([]byte(raw), &rl)
		if resp.StatusCode != 200 || len(rl.Data) != 7 {
			t.Fatalf("rules list: %d %s", resp.StatusCode, raw)
		}
		// fire stats must be present; zero/null is correct when nothing fired yet
		_, hasCount := rl.Data[0]["fireCount24h"]
		_, hasLast := rl.Data[0]["lastFiredAt"]
		if !hasCount || !hasLast {
			t.Fatalf("rule list must carry fire stats keys: %v", rl.Data[0])
		}
	}

	// PATCH: viewer 403
	resp, raw := e.do(viewer, http.MethodPatch, "/api/rules/SG-RULE-001", `{"threshold":6}`)
	if resp.StatusCode != 403 {
		t.Fatalf("viewer rule patch: %d", resp.StatusCode)
	}
	// invalid ranges -> 400
	for _, bad := range []string{`{"threshold":0}`, `{"threshold":10001}`, `{"windowSeconds":5}`, `{"windowSeconds":3601}`, `{"cooldownSeconds":-1}`, `{"severity":"huge"}`} {
		resp, raw = e.do(analyst, http.MethodPatch, "/api/rules/SG-RULE-001", bad)
		if resp.StatusCode != 400 || !strings.Contains(string(raw), "INVALID_") {
			t.Fatalf("invalid rule patch %s: %d %s", bad, resp.StatusCode, raw)
		}
	}
	// valid patch -> version bump + RuleAudit
	resp, raw = e.do(analyst, http.MethodPatch, "/api/rules/SG-RULE-001", `{"threshold":6,"enabled":false}`)
	var r1 struct {
		Version   float64 `json:"version"`
		Enabled   bool    `json:"enabled"`
		FireCount float64 `json:"fireCount24h"`
	}
	json.Unmarshal([]byte(raw), &r1)
	if resp.StatusCode != 200 || r1.Version != 2 || r1.Enabled {
		t.Fatalf("rule patch: %d %s", resp.StatusCode, raw)
	}
	// no-op patch returns unchanged
	resp, raw = e.do(analyst, http.MethodPatch, "/api/rules/SG-RULE-002", `{}`)
	if resp.StatusCode != 200 || !strings.Contains(string(raw), `"version":1`) {
		t.Fatalf("noop patch: %d %s", resp.StatusCode, raw)
	}
	// rule audit route: analyst 403 / admin 200
	resp, raw = e.do(analyst, http.MethodGet, "/api/rules/SG-RULE-001/audit", "")
	if resp.StatusCode != 403 {
		t.Fatalf("analyst rule audit: %d", resp.StatusCode)
	}
	resp, raw = e.do(admin, http.MethodGet, "/api/rules/SG-RULE-001/audit", "")
	var ra struct {
		Data []map[string]any `json:"data"`
	}
	json.Unmarshal([]byte(raw), &ra)
	if resp.StatusCode != 200 || len(ra.Data) != 1 {
		t.Fatalf("rule audit: %d %s", resp.StatusCode, raw)
	}
	changes, _ := ra.Data[0]["changes"].(map[string]any)
	if changes == nil || changes["threshold"] == nil {
		t.Fatalf("rule audit changes: %v", ra.Data[0])
	}
	// audit trail
	resp, raw = e.do(admin, http.MethodGet, "/api/audit?action=rule.update", "")
	if !strings.Contains(string(raw), "SG-RULE-001") {
		t.Fatalf("rule audit trail: %s", raw)
	}
	// unknown rule 404
	resp, raw = e.do(analyst, http.MethodPatch, "/api/rules/SG-RULE-999", `{"threshold":5}`)
	if resp.StatusCode != 404 {
		t.Fatalf("unknown rule: %d", resp.StatusCode)
	}
}

// ---------------------------------------------------------------- audit endpoint

func TestAuditEndpointValidation(t *testing.T) {
	e := newTestEnv(t, "")
	e.runScenario("brute_force")
	admin := e.loginClient("admin", "admin123")
	analyst := e.loginClient("analyst", "analyst123")

	// RBAC
	resp, raw := e.do(analyst, http.MethodGet, "/api/audit", "")
	if resp.StatusCode != 403 {
		t.Fatalf("analyst audit: %d", resp.StatusCode)
	}
	// filters
	resp, raw = e.do(admin, http.MethodGet, "/api/audit?action=login", "")
	var a struct {
		Data []map[string]any `json:"data"`
	}
	json.Unmarshal([]byte(raw), &a)
	if resp.StatusCode != 200 || len(a.Data) < 1 {
		t.Fatalf("audit login filter: %s", raw)
	}
	// closed-set validation
	resp, raw = e.do(admin, http.MethodGet, "/api/audit?action=bogus", "")
	if resp.StatusCode != 400 || !strings.Contains(string(raw), "action") {
		t.Fatalf("bad action: %d %s", resp.StatusCode, raw)
	}
	resp, raw = e.do(admin, http.MethodGet, "/api/audit?targetType=bogus", "")
	if resp.StatusCode != 400 || !strings.Contains(string(raw), "targetType") {
		t.Fatalf("bad targetType: %d %s", resp.StatusCode, raw)
	}
	resp, raw = e.do(admin, http.MethodGet, "/api/audit?from=not-a-time", "")
	if resp.StatusCode != 400 {
		t.Fatalf("bad from: %d", resp.StatusCode)
	}
}

// ---------------------------------------------------------------- retention

func TestRetentionRunProtectsOpenIncidents(t *testing.T) {
	e := newTestEnv(t, "")
	e.runScenario("brute_force")
	waitFor(t, 8*time.Second, "incidents", func() bool {
		_, itotal, _ := e.st.ListIncidents(context.Background(), store.IncidentFilter{RuleID: "SG-RULE-001"}, "createdAt", 1, 10)
		return itotal >= 1
	})
	admin := e.loginClient("admin", "admin123")
	analyst := e.loginClient("analyst", "analyst123")

	incs, _, _ := e.st.ListIncidents(context.Background(), store.IncidentFilter{RuleID: "SG-RULE-001"}, "createdAt", 1, 10)
	incID := incs[0].ID

	// directly insert three old events (48h ago); attach e0 to the open incident
	now := time.Now().UTC()
	ctx := context.Background()
	old := func(id string) *event.Event {
		// beyond the 72h retention cutoff (events at -48h would be kept)
		return &event.Event{
			EventID: id, SchemaVersion: 1, EventTime: now.Add(-80 * time.Hour), IngestTime: now.Add(-80 * time.Hour),
			SourceType: "app", SourceID: "old-src", Severity: "info", Category: "system",
			Message: "old event " + id, Origin: "synthetic", Status: "PROCESSED",
		}
	}
	for _, id := range []string{"old-e0", "old-e1", "old-e2"} {
		if _, err := e.st.InsertEvent(ctx, old(id)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := e.st.AttachIncidentEvents(ctx, incID, []store.IncidentEvent{{IncidentID: incID, EventID: "old-e0"}}); err != nil {
		t.Fatal(err)
	}

	// RBAC + run
	resp, raw := e.do(analyst, http.MethodPost, "/api/system/retention-run", "")
	if resp.StatusCode != 403 {
		t.Fatalf("analyst retention: %d", resp.StatusCode)
	}
	resp, raw = e.do(admin, http.MethodPost, "/api/system/retention-run", "")
	var rr struct {
		DeletedCount float64 `json:"deletedCount"`
	}
	json.Unmarshal([]byte(raw), &rr)
	if resp.StatusCode != 200 || rr.DeletedCount != 2 {
		t.Fatalf("retention run: %d %s", resp.StatusCode, raw)
	}
	// protected event survives; unprotected gone
	if _, err := e.st.GetEvent(ctx, "old-e0"); err != nil {
		t.Fatalf("protected event deleted: %v", err)
	}
	if _, err := e.st.GetEvent(ctx, "old-e1"); err != store.ErrNotFound {
		t.Fatalf("unprotected event not deleted: %v", err)
	}
	// audit
	resp, raw = e.do(admin, http.MethodGet, "/api/audit?action=retention.run", "")
	if !strings.Contains(string(raw), `"deletedCount":2`) {
		t.Fatalf("retention audit: %s", raw)
	}
	// metrics carry the durable aggregate
	resp, raw = e.doRaw(&http.Client{}, http.MethodGet, "/api/metrics", "", nil)
	if !strings.Contains(raw, "streamguard_validation_failures_total") {
		t.Fatalf("metrics: %s", raw)
	}
}

// ---------------------------------------------------------------- simulator tick/reset

func TestSimulatorTickAndReset(t *testing.T) {
	e := newTestEnv(t, "")
	analyst := e.loginClient("analyst", "analyst123")
	admin := e.loginClient("admin", "admin123")

	// tick: default count 12; >50 -> 400
	resp, raw := e.do(analyst, http.MethodPost, "/api/simulator/tick", `{}`)
	var tk struct {
		Generated float64  `json:"generated"`
		EventIDs  []string `json:"eventIds"`
	}
	json.Unmarshal([]byte(raw), &tk)
	if resp.StatusCode != 200 || tk.Generated != 12 || len(tk.EventIDs) != 12 {
		t.Fatalf("tick: %d %s", resp.StatusCode, raw)
	}
	resp, raw = e.do(analyst, http.MethodPost, "/api/simulator/tick", `{"count":51}`)
	if resp.StatusCode != 400 {
		t.Fatalf("tick 51: %d", resp.StatusCode)
	}
	// second tick: distinct event ids (seed increments)
	resp, raw = e.do(analyst, http.MethodPost, "/api/simulator/tick", `{"count":5}`)
	json.Unmarshal([]byte(raw), &tk)
	if tk.Generated != 5 || len(tk.EventIDs) != 5 {
		t.Fatalf("tick 2: %s", raw)
	}
	seen := map[string]bool{}
	for _, id := range tk.EventIDs {
		if seen[id] {
			t.Fatalf("duplicate tick id %s", id)
		}
		seen[id] = true
	}

	// reset: analyst 403, admin 200 + re-seeded baseline
	resp, raw = e.do(analyst, http.MethodPost, "/api/simulator/reset", "")
	if resp.StatusCode != 403 {
		t.Fatalf("analyst reset: %d", resp.StatusCode)
	}
	resp, raw = e.do(admin, http.MethodPost, "/api/simulator/reset", "")
	var rs struct {
		OK               bool    `json:"ok"`
		BaselineIngested float64 `json:"baselineIngested"`
	}
	json.Unmarshal([]byte(raw), &rs)
	if resp.StatusCode != 200 || !rs.OK || rs.BaselineIngested != 12 {
		t.Fatalf("reset: %d %s", resp.StatusCode, raw)
	}
	// rules survived; events were wiped then re-seeded
	rl, _ := e.st.ListRules(context.Background())
	if len(rl) != 7 {
		t.Fatalf("rules after reset: %d", len(rl))
	}
	// users kept
	if _, err := e.st.GetUser(context.Background(), "admin"); err != nil {
		t.Fatalf("users after reset: %v", err)
	}
	// audit has demo.reset
	resp, raw = e.do(admin, http.MethodGet, "/api/audit?action=demo.reset", "")
	if !strings.Contains(string(raw), "demo.reset") {
		t.Fatalf("reset audit: %s", raw)
	}

	// duplicate scenario run: same seed -> all duplicates (idempotent, no re-store)
	first := e.runScenario("brute_force")
	_ = first
	waitFor(t, 8*time.Second, "first run processed", func() bool {
		dets, dtotal, _ := e.st.ListDetections(context.Background(), store.DetectionFilter{RuleID: "SG-RULE-001"}, 1, 10)
		return dtotal >= 1 && len(dets) >= 1
	})
	second := e.runScenario("brute_force")
	if second["duplicates"].(float64) != 9 || second["accepted"].(float64) != 0 {
		t.Fatalf("re-run must be idempotent: %v", second)
	}
	// no duplicate detections were created
	_, dtotal, _ := e.st.ListDetections(context.Background(), store.DetectionFilter{RuleID: "SG-RULE-001"}, 1, 10)
	if dtotal != 1 {
		t.Fatalf("detection re-run on duplicates: total=%d", dtotal)
	}
	// rate limited ingest (429) events are visible in metrics
	resp, raw = e.doRaw(&http.Client{}, http.MethodGet, "/api/metrics", "", nil)
	if !strings.Contains(raw, "streamguard_ingest_requests_total") {
		t.Fatalf("metrics ingest codes: %s", raw)
	}
}
