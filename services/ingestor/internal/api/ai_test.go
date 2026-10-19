// Copyright © 2026 Parsa Fathi — Apache-2.0

package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/store"
)

// stubLLM spins up an Ollama-compatible provider that returns a fixed
// report referencing the incident id set via setIncident().
func stubLLM(t *testing.T) (*httptest.Server, *atomic.Value) {
	t.Helper()
	incidentID := &atomic.Value{}
	incidentID.Store("")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/tags":
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"models":[{"name":"llama3.2"}]}`)
		case "/api/chat":
			id, _ := incidentID.Load().(string)
			if id == "" {
				id = "INC-000001"
			}
			report := fmt.Sprintf(`{
				"summary": "Multiple failed logins for one actor indicate a brute-force attempt.",
				"facts": ["5+ failed logins for the correlation actor within 120s"],
				"ruleFindings": ["SG-RULE-001 fired with matched events in window"],
				"mlFindings": ["no ML evaluation available yet"],
				"hypotheses": ["automated credential guessing"],
				"nextSteps": ["block the actor", "review auth logs"],
				"references": {"incidentId": %q, "eventIds": ["sg-brute_force-42-0000"], "ruleIds": ["SG-RULE-001"]}
			}`, id)
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{"message":{"role":"assistant","content":%s}}`, quoteJSON(report))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, incidentID
}

func quoteJSON(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		return `""`
	}
	return string(b)
}

func TestAIInvestigate(t *testing.T) {
	stub, incidentID := stubLLM(t)
	e := newTestEnv(t, stub.URL)
	analyst := e.loginClient("analyst", "analyst123")
	viewer := e.loginClient("viewer", "viewer123")
	admin := e.loginClient("admin", "admin123")

	// create an incident via the simulator
	e.runScenario("brute_force")
	waitFor(t, 8*time.Second, "incidents", func() bool {
		_, itotal, _ := e.st.ListIncidents(context.Background(), store.IncidentFilter{RuleID: "SG-RULE-001"}, "createdAt", 1, 10)
		return itotal >= 1
	})
	incs, _, _ := e.st.ListIncidents(context.Background(), store.IncidentFilter{RuleID: "SG-RULE-001"}, "createdAt", 1, 10)
	incID := incs[0].ID
	incidentID.Store(incID)

	// viewer -> 403
	resp, raw := e.do(viewer, http.MethodPost, "/api/ai/investigate", fmt.Sprintf(`{"incidentId":%q}`, incID))
	if resp.StatusCode != 403 {
		t.Fatalf("viewer ai: %d", resp.StatusCode)
	}
	// missing incidentId -> 400
	resp, raw = e.do(analyst, http.MethodPost, "/api/ai/investigate", `{}`)
	if resp.StatusCode != 400 || !strings.Contains(string(raw), "MISSING_FIELD") {
		t.Fatalf("missing incidentId: %d %s", resp.StatusCode, raw)
	}
	// unknown incident -> 404
	resp, raw = e.do(analyst, http.MethodPost, "/api/ai/investigate", `{"incidentId":"INC-999999"}`)
	if resp.StatusCode != 404 {
		t.Fatalf("unknown incident: %d", resp.StatusCode)
	}

	// happy path with the stub provider
	resp, raw = e.do(analyst, http.MethodPost, "/api/ai/investigate",
		fmt.Sprintf(`{"incidentId":%q,"question":"what happened?"}`, incID))
	var out struct {
		Report struct {
			Summary    string   `json:"summary"`
			Facts      []string `json:"facts"`
			References struct {
				IncidentID string   `json:"incidentId"`
				EventIDs   []string `json:"eventIds"`
				RuleIDs    []string `json:"ruleIds"`
			} `json:"references"`
		} `json:"report"`
		Provider struct {
			Name   string `json:"name"`
			Model  string `json:"model"`
			Status string `json:"status"`
		} `json:"provider"`
		DurationMs float64 `json:"durationMs"`
	}
	json.Unmarshal([]byte(raw), &out)
	if resp.StatusCode != 200 || out.Report.Summary == "" || out.Report.References.IncidentID != incID {
		t.Fatalf("ai investigate: %d %s", resp.StatusCode, raw)
	}
	if out.Provider.Name != "ollama" || out.Provider.Model != "llama3.2" || out.Provider.Status != "ok" {
		t.Fatalf("provider block: %v", out.Provider)
	}
	if out.DurationMs < 0 {
		t.Fatalf("durationMs: %v", out.DurationMs)
	}

	// stored AIReport visible in the incident detail
	resp, raw = e.do(analyst, http.MethodGet, "/api/incidents/"+incID, "")
	var idet struct {
		AIReports []map[string]any `json:"aiReports"`
	}
	json.Unmarshal([]byte(raw), &idet)
	if len(idet.AIReports) != 1 {
		t.Fatalf("aiReports: %s", raw)
	}
	if idet.AIReports[0]["id"] == "" || idet.AIReports[0]["ts"] == "" {
		t.Fatalf("aiReport ref shape: %v", idet.AIReports[0])
	}

	// audit + metrics
	resp, raw = e.do(admin, http.MethodGet, "/api/audit?action=ai.investigate", "")
	if !strings.Contains(string(raw), incID) {
		t.Fatalf("ai audit: %s", raw)
	}

	// disabled -> 503 AI_DISABLED
	e.do(admin, http.MethodPatch, "/api/settings", `{"aiEnabled":false}`)
	resp, raw = e.do(analyst, http.MethodPost, "/api/ai/investigate", fmt.Sprintf(`{"incidentId":%q}`, incID))
	if resp.StatusCode != 503 || !strings.Contains(string(raw), "AI_DISABLED") {
		t.Fatalf("ai disabled: %d %s", resp.StatusCode, raw)
	}
	// health reports llm=disabled now
	resp, hraw := e.doRaw(&http.Client{}, http.MethodGet, "/api/health", "", nil)
	if !strings.Contains(string(hraw), `"llm":"disabled"`) {
		t.Fatalf("health llm disabled: %s", hraw)
	}

	// re-enable with a dead provider -> 503 PROVIDER_ERROR
	e.do(admin, http.MethodPatch, "/api/settings", `{"aiEnabled":true}`)
	// point the client at an unroutable endpoint: rebuild a server-level
	// client is not possible post-hoc; instead assert via a second env.
	e2 := newTestEnv(t, "") // dead URL env
	e2.runScenario("brute_force")
	waitFor(t, 8*time.Second, "e2 incidents", func() bool {
		_, itotal, _ := e2.st.ListIncidents(context.Background(), store.IncidentFilter{RuleID: "SG-RULE-001"}, "createdAt", 1, 10)
		return itotal >= 1
	})
	incs2, _, _ := e2.st.ListIncidents(context.Background(), store.IncidentFilter{RuleID: "SG-RULE-001"}, "createdAt", 1, 10)
	analyst2 := e2.loginClient("analyst", "analyst123")
	resp, raw = e2.do(analyst2, http.MethodPost, "/api/ai/investigate", fmt.Sprintf(`{"incidentId":%q}`, incs2[0].ID))
	if resp.StatusCode != 503 || !strings.Contains(string(raw), "PROVIDER_ERROR") {
		t.Fatalf("provider error: %d %s", resp.StatusCode, raw)
	}
	// metrics counted the failure
	mresp, err := http.Get(e2.hs.URL + "/api/metrics")
	if err != nil {
		t.Fatal(err)
	}
	mbody, err := io.ReadAll(mresp.Body)
	mresp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(mbody), "streamguard_llm_failures_total 1") {
		t.Fatalf("llm failure metric: %s", mbody)
	}
}
