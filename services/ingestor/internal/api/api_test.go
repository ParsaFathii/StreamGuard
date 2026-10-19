// Copyright © 2026 Parsa Fathi — Apache-2.0

package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/auth"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/correlate"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/llm"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/logging"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/metrics"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/pipeline"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/rules"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/sse"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/store"
)

const testIngestKey = "test-key-1234"

// testEnv is a fully wired in-memory server under httptest.
type testEnv struct {
	t    *testing.T
	st   *store.MemStore
	as   *auth.Service
	hub  *sse.Hub
	pipe *pipeline.Pipeline
	srv  *Server
	hs   *httptest.Server

	llmStubURL    string
	llmIncidentID atomic.Value // string; used by the optional stub provider
}

// newTestEnv builds a seeded server. llmURL "" -> unroutable provider
// (connection refused => honest PROVIDER_ERROR paths).
func newTestEnv(t *testing.T, llmURL string) *testEnv {
	t.Helper()
	st := store.NewMemStore()
	as := auth.NewService(st, []byte("test-secret-0123456789abcdef"), func() int {
		sv, err := st.GetSettings(context.Background())
		if err != nil || sv.RateLimitPerMin < 1 {
			return 60
		}
		return sv.RateLimitPerMin
	})
	hub := sse.NewHub()
	engine := rules.NewEngine(st, nil)
	corr := correlate.NewEngine(st, nil, func() time.Duration { return 600 * time.Second })
	mtr := metrics.NewCounters()
	logger := logging.Discard()
	pipe := pipeline.New(st, engine, corr, hub, mtr, logger, pipeline.Config{Workers: 2, QueueSize: 512})
	pipe.Start(context.Background())
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = pipe.Stop(ctx)
	})
	if llmURL == "" {
		llmURL = "http://127.0.0.1:1" // nothing listens here: refused instantly
	}
	lc := llm.NewClient(llmURL, "llama3.2", 3*time.Second)
	srv := NewServer(Config{}, st, as, hub, pipe, lc, mtr, logger)
	if err := Seed(context.Background(), st, as, testIngestKey, store.DefaultSettings()); err != nil {
		t.Fatalf("seed: %v", err)
	}
	hs := httptest.NewServer(srv.Handler())
	t.Cleanup(hs.Close)
	return &testEnv{t: t, st: st, as: as, hub: hub, pipe: pipe, srv: srv, hs: hs, llmStubURL: llmURL}
}

// loginClient returns an authenticated client (cookie jar) for the user.
func (e *testEnv) loginClient(user, pass string) *http.Client {
	e.t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		e.t.Fatal(err)
	}
	c := &http.Client{Jar: jar, Timeout: 10 * time.Second}
	resp, body := e.do(c, http.MethodPost, "/api/auth/login", fmt.Sprintf(`{"username":%q,"password":%q}`, user, pass))
	if resp.StatusCode != http.StatusOK {
		e.t.Fatalf("login %s: status=%d body=%s", user, resp.StatusCode, body)
	}
	return c
}

// do performs one request; body may be empty.
func (e *testEnv) do(c *http.Client, method, path, body string) (*http.Response, string) {
	e.t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, e.hs.URL+path, rd)
	if err != nil {
		e.t.Fatalf("new request: %v", err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.Do(req)
	if err != nil {
		e.t.Fatalf("%s %s: %v", method, path, err)
	}
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		e.t.Fatalf("read body: %v", err)
	}
	resp.Body.Close()
	return resp, string(b)
}

// doRaw performs a request with a raw body and extra headers.
func (e *testEnv) doRaw(c *http.Client, method, path, body string, hdr map[string]string) (*http.Response, string) {
	e.t.Helper()
	req, err := http.NewRequest(method, e.hs.URL+path, strings.NewReader(body))
	if err != nil {
		e.t.Fatalf("new request: %v", err)
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := c.Do(req)
	if err != nil {
		e.t.Fatalf("%s %s: %v", method, path, err)
	}
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		e.t.Fatalf("read body: %v", err)
	}
	resp.Body.Close()
	return resp, string(b)
}

// ingestKey posts a batch with the demo ingest key.
func (e *testEnv) ingestKey(batch string) (*http.Response, map[string]any) {
	e.t.Helper()
	resp, body := e.doRaw(&http.Client{Timeout: 10 * time.Second}, http.MethodPost, "/api/ingest", batch,
		map[string]string{"X-Ingest-Key": testIngestKey, "Content-Type": "application/json"})
	var out map[string]any
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		e.t.Fatalf("ingest response not JSON: %s", body)
	}
	return resp, out
}

// waitFor polls cond until it holds or the timeout elapses.
func waitFor(t *testing.T, timeout time.Duration, msg string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(15 * time.Millisecond)
	}
	t.Fatalf("timeout after %s: %s", timeout, msg)
}

// runScenario triggers a simulator scenario as the analyst.
func (e *testEnv) runScenario(id string) map[string]any {
	e.t.Helper()
	c := e.loginClient("analyst", "analyst123")
	resp, body := e.do(c, http.MethodPost, "/api/simulator/scenario", fmt.Sprintf(`{"scenarioId":%q}`, id))
	if resp.StatusCode != http.StatusOK {
		e.t.Fatalf("scenario %s: status=%d body=%s", id, resp.StatusCode, body)
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		e.t.Fatalf("scenario response: %v", err)
	}
	return out
}

// ---------------------------------------------------------------- auth matrix

func TestAuthMatrix(t *testing.T) {
	e := newTestEnv(t, "")

	// version header on every response
	resp, _ := e.doRaw(&http.Client{}, http.MethodGet, "/api/health", "", nil)
	if got := resp.Header.Get("X-StreamGuard-Version"); got != "10.4.0" {
		t.Fatalf("X-StreamGuard-Version = %q", got)
	}

	// login: three roles
	for _, u := range [][2]string{{"admin", "admin123"}, {"analyst", "analyst123"}, {"viewer", "viewer123"}} {
		c := e.loginClient(u[0], u[1])
		resp, body := e.do(c, http.MethodGet, "/api/auth/session", "")
		if resp.StatusCode != http.StatusOK || !strings.Contains(body, `"role"`) {
			t.Fatalf("session %s: %d %s", u[0], resp.StatusCode, body)
		}
	}

	// wrong password / unknown user
	c := &http.Client{Timeout: 10 * time.Second}
	resp, body := e.do(c, http.MethodPost, "/api/auth/login", `{"username":"admin","password":"nope"}`)
	if resp.StatusCode != 401 || !strings.Contains(body, "INVALID_CREDENTIALS") {
		t.Fatalf("wrong password: %d %s", resp.StatusCode, body)
	}
	resp, body = e.do(c, http.MethodPost, "/api/auth/login", `{"username":"ghost","password":"x"}`)
	if resp.StatusCode != 401 {
		t.Fatalf("unknown user: %d %s", resp.StatusCode, body)
	}
	// missing field
	resp, body = e.do(c, http.MethodPost, "/api/auth/login", `{"username":"admin"}`)
	if resp.StatusCode != 400 || !strings.Contains(body, "MISSING_FIELD") {
		t.Fatalf("missing password: %d %s", resp.StatusCode, body)
	}
	// malformed json
	resp, body = e.do(c, http.MethodPost, "/api/auth/login", `{`)
	if resp.StatusCode != 400 || !strings.Contains(body, "INVALID_JSON") {
		t.Fatalf("malformed login: %d %s", resp.StatusCode, body)
	}

	// unauthenticated access to protected endpoints -> 401
	for _, path := range []string{"/api/events", "/api/incidents", "/api/rules", "/api/detections", "/api/settings", "/api/stream", "/api/analytics/overview"} {
		resp, body = e.do(c, http.MethodGet, path, "")
		if resp.StatusCode != 401 || !strings.Contains(body, "UNAUTHORIZED") {
			t.Fatalf("unauthenticated %s: %d %s", path, resp.StatusCode, body)
		}
	}

	// logout kills the session
	admin := e.loginClient("admin", "admin123")
	resp, body = e.do(admin, http.MethodPost, "/api/auth/logout", "")
	if resp.StatusCode != 200 || !strings.Contains(body, `"ok":true`) {
		t.Fatalf("logout: %d %s", resp.StatusCode, body)
	}
	resp, body = e.do(admin, http.MethodGet, "/api/auth/session", "")
	if resp.StatusCode != 401 {
		t.Fatalf("session after logout: %d %s", resp.StatusCode, body)
	}

	// audit contains the login+logout trail (admin)
	admin2 := e.loginClient("admin", "admin123")
	resp, body = e.do(admin2, http.MethodGet, "/api/audit?action=login", "")
	if resp.StatusCode != 200 || !strings.Contains(body, `"login"`) {
		t.Fatalf("audit login: %d %s", resp.StatusCode, body)
	}

	// 404 shape + version header
	resp, nbody := e.doRaw(&http.Client{}, http.MethodGet, "/api/nope", "", nil)
	if resp.StatusCode != 404 || !strings.Contains(string(nbody), "NOT_FOUND") {
		t.Fatalf("404 shape: %d %s", resp.StatusCode, nbody)
	}
	if got := resp.Header.Get("X-StreamGuard-Version"); got == "" {
		t.Fatalf("version header missing on 404")
	}
	// wrong method falls through to the JSON 404
	resp, dbody := e.doRaw(&http.Client{}, http.MethodDelete, "/api/events", "", nil)
	if resp.StatusCode != 404 {
		t.Fatalf("DELETE /api/events should be 404, got %d %s", resp.StatusCode, dbody)
	}
}

// ---------------------------------------------------------------- ingest paths

func TestIngestValidationPaths(t *testing.T) {
	e := newTestEnv(t, "")
	analyst := e.loginClient("analyst", "analyst123")
	viewer := e.loginClient("viewer", "viewer123")
	anon := &http.Client{Timeout: 10 * time.Second}

	single := func(id string) string {
		return fmt.Sprintf(`{"event_id":%q,"schema_version":1,"event_time":"2026-02-01T10:00:00.000Z","source_id":"src-1","source_type":"app","severity":"info","category":"application","message":"generated by test","actor":"tester","attributes":{"action":"ok"}}`, id)
	}

	// unauthenticated -> 401
	resp, body := e.do(anon, http.MethodPost, "/api/ingest", single("e-unauth"))
	if resp.StatusCode != 401 {
		t.Fatalf("unauth ingest: %d %s", resp.StatusCode, body)
	}
	// viewer session -> 403
	resp, body = e.do(viewer, http.MethodPost, "/api/ingest", single("e-viewer"))
	if resp.StatusCode != 403 || !strings.Contains(body, "FORBIDDEN") {
		t.Fatalf("viewer ingest: %d %s", resp.StatusCode, body)
	}
	// wrong ingest key -> 401
	resp, body = e.doRaw(anon, http.MethodPost, "/api/ingest", single("e-badkey"),
		map[string]string{"X-Ingest-Key": "wrong-key"})
	if resp.StatusCode != 401 {
		t.Fatalf("wrong key: %d %s", resp.StatusCode, body)
	}

	// single event via session -> 202 accepted=1, origin synthetic
	resp, raw := e.doRaw(analyst, http.MethodPost, "/api/ingest", single("e-single-1"), nil)
	if resp.StatusCode != 202 {
		t.Fatalf("single ingest: %d %s", resp.StatusCode, raw)
	}
	var out map[string]any
	json.Unmarshal([]byte(raw), &out)
	if out["accepted"].(float64) != 1 || out["rejected"].(float64) != 0 {
		t.Fatalf("single counts: %s", raw)
	}

	// duplicate of the same id (key path) -> duplicates=1, not re-stored
	batch := `{"batch":[` + single("e-single-1") + `,` + single("e-dup-2") + `]}`
	resp, raw = e.doRaw(anon, http.MethodPost, "/api/ingest", batch, map[string]string{"X-Ingest-Key": testIngestKey})
	if resp.StatusCode != 202 {
		t.Fatalf("batch ingest: %d %s", resp.StatusCode, raw)
	}
	json.Unmarshal([]byte(raw), &out)
	if out["accepted"].(float64) != 1 || out["duplicates"].(float64) != 1 {
		t.Fatalf("dup counts: %s", raw)
	}

	// mixed batch: 2 valid + 1 dup + 2 rejected with per-index reasons
	mixed := `{"batch":[` +
		single("m-1") + "," +
		single("m-2") + "," +
		single("m-1") + "," +
		`{"event_id":"bad-sev","schema_version":1,"event_time":"2026-02-01T10:00:00.000Z","source_id":"s","source_type":"app","severity":"extreme","category":"auth","message":"bad severity"},` +
		`{"schema_version":1,"event_time":"2026-02-01T10:00:00.000Z","source_id":"s","source_type":"app","severity":"info","category":"auth","message":"no id"}` +
		`]}`
	resp, raw = e.doRaw(anon, http.MethodPost, "/api/ingest", mixed, map[string]string{"X-Ingest-Key": testIngestKey})
	if resp.StatusCode != 202 {
		t.Fatalf("mixed batch: %d %s", resp.StatusCode, raw)
	}
	json.Unmarshal([]byte(raw), &out)
	if out["accepted"].(float64) != 2 || out["duplicates"].(float64) != 1 || out["rejected"].(float64) != 2 {
		t.Fatalf("mixed counts: %s", raw)
	}
	rejectedItems := out["rejectedItems"].([]any)
	if len(rejectedItems) != 2 {
		t.Fatalf("rejectedItems: %v", rejectedItems)
	}
	first := rejectedItems[0].(map[string]any)
	if first["index"].(float64) != 3 || !strings.Contains(first["reason"].(string), "BAD_SEVERITY") {
		t.Fatalf("rejectedItems[0]: %v", first)
	}

	// invalid JSON body -> 400
	resp, raw = e.doRaw(anon, http.MethodPost, "/api/ingest", `{"batch":`, map[string]string{"X-Ingest-Key": testIngestKey})
	if resp.StatusCode != 400 || !strings.Contains(string(raw), "INVALID_JSON") {
		t.Fatalf("invalid json: %d %s", resp.StatusCode, raw)
	}
	// empty batch -> 400
	resp, raw = e.doRaw(anon, http.MethodPost, "/api/ingest", `{"batch":[]}`, map[string]string{"X-Ingest-Key": testIngestKey})
	if resp.StatusCode != 400 {
		t.Fatalf("empty batch: %d %s", resp.StatusCode, raw)
	}

	// batch over the cap -> 413 (settings cap 100 clamped to contract 100)
	var sb strings.Builder
	sb.WriteString(`{"batch":[`)
	for i := 0; i < 101; i++ {
		if i > 0 {
			sb.WriteByte(',')
		}
		sb.WriteString(single(fmt.Sprintf("cap-%d", i)))
	}
	sb.WriteString(`]}`)
	resp, raw = e.doRaw(anon, http.MethodPost, "/api/ingest", sb.String(), map[string]string{"X-Ingest-Key": testIngestKey})
	if resp.StatusCode != 413 || !strings.Contains(string(raw), "PAYLOAD_TOO_LARGE") {
		t.Fatalf("over cap: %d %s", resp.StatusCode, raw)
	}

	// oversized body -> 413 via http.MaxBytesReader
	big := `{"batch":["` + strings.Repeat("x", 300*1024) + `"]}`
	resp, raw = e.doRaw(anon, http.MethodPost, "/api/ingest", big, map[string]string{"X-Ingest-Key": testIngestKey, "Content-Type": "application/json"})
	if resp.StatusCode != 413 {
		t.Fatalf("oversized body: %d %s", resp.StatusCode, raw)
	}

	// origin markers: session path -> synthetic; key path -> external
	resp, raw = e.do(analyst, http.MethodGet, "/api/events?sourceId=src-1&pageSize=100", "")
	var list struct {
		Data []map[string]any `json:"data"`
	}
	json.Unmarshal([]byte(raw), &list)
	if len(list.Data) == 0 {
		t.Fatalf("no events: %s", raw)
	}
	origins := map[string]int{}
	for _, ev := range list.Data {
		origins[ev["origin"].(string)]++
	}
	// m-1 came twice through key (dup) — external; e-single-1 second time via key dup
	if origins["external"] == 0 {
		t.Fatalf("expected external origin events, got %v", origins)
	}

	// rate limit: lower the limit, then exceed it via the key
	admin := e.loginClient("admin", "admin123")
	e.do(admin, http.MethodPatch, "/api/settings", `{"rateLimitPerMin":2}`)
	// flush the window: the limiter is per-minute; wait for it to drain is
	// slow — instead verify the 429 fires after 2 more key requests.
	e.ingestKey(`{"batch":[` + single("rl-1") + `]}`)
	e.ingestKey(`{"batch":[` + single("rl-2") + `]}`)
	resp, raw = e.doRaw(anon, http.MethodPost, "/api/ingest", `{"batch":[`+single("rl-3")+`]}`,
		map[string]string{"X-Ingest-Key": testIngestKey})
	if resp.StatusCode != 429 || !strings.Contains(string(raw), "RATE_LIMITED") {
		t.Fatalf("rate limit: %d %s", resp.StatusCode, raw)
	}
	if resp.Header.Get("Retry-After") == "" {
		t.Fatalf("Retry-After header missing")
	}

	// validation failure rows were recorded for the rejected items (SG-RULE-007 fodder)
	vfs, _ := e.st.ListValidationFailuresSince(context.Background(), time.Now().Add(-time.Hour), 50)
	if len(vfs) < 2 {
		t.Fatalf("expected >=2 validation failures, got %d", len(vfs))
	}
}

// ---------------------------------------------------------------- events filters

func TestEventsFiltersAndPagination(t *testing.T) {
	e := newTestEnv(t, "")
	e.runScenario("brute_force") // 8 low/auth + 1 info/auth success
	analyst := e.loginClient("analyst", "analyst123")
	waitFor(t, 5*time.Second, "events processed", func() bool {
		evs, total, _ := e.st.ListEvents(context.Background(), store.EventFilter{Status: "PROCESSED"}, 1, 100)
		return total == 9 && len(evs) == 9
	})

	// severity+category filter
	resp, raw := e.do(analyst, http.MethodGet, "/api/events?severity=low&category=auth", "")
	var list struct {
		Data  []map[string]any `json:"data"`
		Total int              `json:"total"`
	}
	json.Unmarshal([]byte(raw), &list)
	if resp.StatusCode != 200 || list.Total != 8 || len(list.Data) != 8 {
		t.Fatalf("low+auth: %s", raw)
	}
	for _, ev := range list.Data {
		attrs, _ := ev["attributes"].(map[string]any)
		if attrs == nil || attrs["action"] != "login_failed" {
			t.Fatalf("attributes must be an object: %v", ev["attributes"])
		}
		if ev["origin"] != "synthetic" {
			t.Fatalf("simulator events must be origin synthetic: %v", ev)
		}
	}

	// q search (case-insensitive substring over message + actor)
	resp, raw = e.do(analyst, http.MethodGet, "/api/events?q=LOGIN", "")
	json.Unmarshal([]byte(raw), &list)
	if resp.StatusCode != 200 || list.Total != 9 {
		t.Fatalf("q=LOGIN (case-insensitive substring, 9 auth events): %s", raw)
	}
	resp, raw = e.do(analyst, http.MethodGet, "/api/events?q=failed", "")
	json.Unmarshal([]byte(raw), &list)
	if list.Total != 8 {
		t.Fatalf("q=failed: %s", raw)
	}
	resp, raw = e.do(analyst, http.MethodGet, "/api/events?q=attacker", "")
	json.Unmarshal([]byte(raw), &list)
	if list.Total != 9 {
		t.Fatalf("q=attacker (actor search): %s", raw)
	}

	// pagination
	resp, raw = e.do(analyst, http.MethodGet, "/api/events?pageSize=3&page=2", "")
	json.Unmarshal([]byte(raw), &list)
	if list.Total != 9 || len(list.Data) != 3 {
		t.Fatalf("page 2 of 3: %s", raw)
	}

	// invalid filters -> 400 INVALID_FILTER naming the param
	for _, tc := range [][2]string{
		{"severity", "severity=highx"},
		{"category", "category=bogus"},
		{"sourceType", "sourceType=weird"},
		{"status", "status=BOGUS"},
		{"origin", "origin=alien"},
		{"q", "q=x"},
		{"page", "page=0"},
		{"page", "page=abc"},
		{"pageSize", "pageSize=101"},
		{"pageSize", "pageSize=0"},
		{"from", "from=not-a-time"},
		{"to", "to=not-a-time"},
	} {
		resp, raw = e.do(analyst, http.MethodGet, "/api/events?"+tc[1], "")
		if resp.StatusCode != 400 || !strings.Contains(string(raw), "INVALID_FILTER") || !strings.Contains(string(raw), tc[0]) {
			t.Fatalf("invalid filter %s: %d %s", tc[1], resp.StatusCode, raw)
		}
	}

	// detail + 404
	resp, raw = e.do(analyst, http.MethodGet, "/api/events/sg-brute_force-42-0000", "")
	if resp.StatusCode != 200 || !strings.Contains(string(raw), `"attributes"`) {
		t.Fatalf("event detail: %d %s", resp.StatusCode, raw)
	}
	resp, raw = e.do(analyst, http.MethodGet, "/api/events/does-not-exist", "")
	if resp.StatusCode != 404 || !strings.Contains(string(raw), "NOT_FOUND") {
		t.Fatalf("event 404: %d %s", resp.StatusCode, raw)
	}
}

// ---------------------------------------------------------------- health & metrics

func TestHealthAndMetrics(t *testing.T) {
	e := newTestEnv(t, "")
	e.runScenario("brute_force")
	waitFor(t, 5*time.Second, "processing", func() bool {
		_, total, _ := e.st.ListEvents(context.Background(), store.EventFilter{Status: "PROCESSED"}, 1, 100)
		return total == 9
	})

	resp, raw := e.doRaw(&http.Client{}, http.MethodGet, "/api/health", "", nil)
	var h struct {
		Status  string `json:"status"`
		Version string `json:"version"`
		Checks  struct {
			DB  string `json:"db"`
			WS  string `json:"ws"`
			LLM string `json:"llm"`
		} `json:"checks"`
		Queue struct {
			Depth int64 `json:"depth"`
		} `json:"queue"`
		Retention struct {
			Policy int `json:"policy"`
		} `json:"retention"`
	}
	json.Unmarshal([]byte(raw), &h)
	if resp.StatusCode != 200 || h.Version != "10.4.0" || h.Checks.DB != "up" || h.Checks.WS != "up" {
		t.Fatalf("health: %d %s", resp.StatusCode, raw)
	}
	// provider is at an unroutable URL: honest degraded state
	if h.Status != "degraded" || h.Checks.LLM != "error" {
		t.Fatalf("health with dead llm should be degraded: %s", raw)
	}
	if h.Retention.Policy != 72 {
		t.Fatalf("retention policy: %d", h.Retention.Policy)
	}

	resp, raw = e.doRaw(&http.Client{}, http.MethodGet, "/api/metrics", "", nil)
	body := raw
	if resp.StatusCode != 200 {
		t.Fatalf("metrics: %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Fatalf("metrics content-type: %q", ct)
	}
	for _, want := range []string{
		"# TYPE streamguard_events_received_total counter",
		"streamguard_events_received_total{origin=\"synthetic\"} 9",
		"streamguard_detections_total{rule_id=\"SG-RULE-001\"} 1",
		"streamguard_uptime_seconds",
		"streamguard_ws_connections",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("metrics missing %q:\n%s", want, body)
		}
	}
}

// ---------------------------------------------------------------- settings & RBAC

func TestSettingsRBACAndValidation(t *testing.T) {
	e := newTestEnv(t, "")
	admin := e.loginClient("admin", "admin123")
	analyst := e.loginClient("analyst", "analyst123")
	viewer := e.loginClient("viewer", "viewer123")

	// GET: all roles
	for _, c := range []*http.Client{admin, analyst, viewer} {
		resp, raw := e.do(c, http.MethodGet, "/api/settings", "")
		if resp.StatusCode != 200 || !strings.Contains(string(raw), `"aiEnabled"`) {
			t.Fatalf("settings get: %d %s", resp.StatusCode, raw)
		}
	}

	// PATCH: analyst -> 403
	resp, raw := e.do(analyst, http.MethodPatch, "/api/settings", `{"retentionHours":48}`)
	if resp.StatusCode != 403 {
		t.Fatalf("analyst settings patch: %d %s", resp.StatusCode, raw)
	}
	// invalid values -> 400
	for _, bad := range []string{
		`{"retentionHours":0}`, `{"correlationWindowSeconds":5}`, `{"maxBatchSize":5000}`,
		`{"rateLimitPerMin":0}`, `{"languageDefault":"fr"}`, `{"aiProvider":""}`,
	} {
		resp, raw = e.do(admin, http.MethodPatch, "/api/settings", bad)
		if resp.StatusCode != 400 || !strings.Contains(string(raw), "INVALID_SETTINGS") {
			t.Fatalf("invalid settings %s: %d %s", bad, resp.StatusCode, raw)
		}
	}
	// valid patch -> applied + audited
	resp, raw = e.do(admin, http.MethodPatch, "/api/settings", `{"retentionHours":48,"languageDefault":"fa"}`)
	if resp.StatusCode != 200 || !strings.Contains(string(raw), `"retentionHours":48`) || !strings.Contains(string(raw), `"languageDefault":"fa"`) {
		t.Fatalf("valid patch: %d %s", resp.StatusCode, raw)
	}
	sv, _ := e.st.GetSettings(context.Background())
	if sv.RetentionHours != 48 || sv.LanguageDefault != "fa" {
		t.Fatalf("settings not persisted: %+v", sv)
	}
	resp, raw = e.do(admin, http.MethodGet, "/api/audit?action=settings.update", "")
	if !strings.Contains(string(raw), "settings.update") {
		t.Fatalf("settings audit missing: %s", raw)
	}
}

// ---------------------------------------------------------------- sources

func TestSourcesDerived(t *testing.T) {
	e := newTestEnv(t, "")
	e.runScenario("config_change") // db-01 infra + sys-01 + heartbeats
	waitFor(t, 5*time.Second, "processing", func() bool {
		_, total, _ := e.st.ListEvents(context.Background(), store.EventFilter{Status: "PROCESSED"}, 1, 100)
		return total == 5
	})
	analyst := e.loginClient("analyst", "analyst123")
	resp, raw := e.do(analyst, http.MethodGet, "/api/sources", "")
	var srcs []map[string]any
	json.Unmarshal([]byte(raw), &srcs)
	if resp.StatusCode != 200 || len(srcs) != 2 {
		t.Fatalf("sources: %d %s", resp.StatusCode, raw)
	}
	byID := map[string]map[string]any{}
	for _, s := range srcs {
		byID[s["id"].(string)] = s
	}
	if byID["db-01"]["type"] != "infra" || byID["db-01"]["origin"] != "synthetic" {
		t.Fatalf("db-01 derived wrong: %v", byID["db-01"])
	}
	if byID["sys-01"]["status"] != "active" {
		t.Fatalf("sys-01 status: %v", byID["sys-01"])
	}
}

// ---------------------------------------------------------------- analytics

func TestAnalyticsEndpoints(t *testing.T) {
	e := newTestEnv(t, "")
	now := time.Now().UTC().Truncate(time.Second)
	e.runScenario("brute_force")
	waitFor(t, 5*time.Second, "processing", func() bool {
		_, total, _ := e.st.ListEvents(context.Background(), store.EventFilter{Status: "PROCESSED"}, 1, 100)
		return total == 9
	})
	analyst := e.loginClient("analyst", "analyst123")
	viewer := e.loginClient("viewer", "viewer123")

	// overview
	resp, raw := e.do(analyst, http.MethodGet, "/api/analytics/overview", "")
	var ov struct {
		Totals struct {
			Events24h     int64 `json:"events24h"`
			Detections24h int64 `json:"detections24h"`
			IncidentsOpen int64 `json:"incidentsOpen"`
			Rejected24h   int64 `json:"rejected24h"`
		} `json:"totals"`
		IngestRatePerMin     []map[string]any `json:"ingestRatePerMin"`
		SeverityBreakdown24h map[string]int64 `json:"severityBreakdown24h"`
		TopSources24h        []map[string]any `json:"topSources24h"`
		Processing           struct {
			LastProcessedAt any `json:"lastProcessedAt"`
		} `json:"processing"`
	}
	json.Unmarshal([]byte(raw), &ov)
	if resp.StatusCode != 200 || ov.Totals.Events24h != 9 || ov.Totals.Detections24h < 1 || ov.Totals.IncidentsOpen < 1 {
		t.Fatalf("overview: %d %s", resp.StatusCode, raw)
	}
	if len(ov.IngestRatePerMin) != 60 {
		t.Fatalf("ingestRatePerMin buckets: %d", len(ov.IngestRatePerMin))
	}
	if ov.SeverityBreakdown24h["low"] != 8 || ov.SeverityBreakdown24h["info"] != 1 {
		t.Fatalf("severity breakdown: %v", ov.SeverityBreakdown24h)
	}
	if ov.Processing.LastProcessedAt == nil {
		t.Fatalf("lastProcessedAt should not be null: %s", raw)
	}

	// timeseries + invalid metric
	resp, raw = e.do(analyst, http.MethodGet, "/api/analytics/timeseries?metric=events&points=10", "")
	var pts []map[string]any
	json.Unmarshal([]byte(raw), &pts)
	if resp.StatusCode != 200 || len(pts) != 10 {
		t.Fatalf("timeseries: %d %s", resp.StatusCode, raw)
	}
	resp, raw = e.do(analyst, http.MethodGet, "/api/analytics/timeseries?metric=bogus", "")
	if resp.StatusCode != 400 || !strings.Contains(string(raw), "metric") {
		t.Fatalf("invalid metric: %d %s", resp.StatusCode, raw)
	}
	// rejected series: run malformed_batch then check the bucket > 0
	e.runScenario("malformed_batch")
	waitFor(t, 5*time.Second, "rule 007 fired", func() bool {
		dets, total, _ := e.st.ListDetections(context.Background(), store.DetectionFilter{RuleID: "SG-RULE-007"}, 1, 10)
		return total >= 1 && len(dets) >= 1
	})
	resp, raw = e.do(analyst, http.MethodGet, "/api/analytics/timeseries?metric=rejected&points=60", "")
	var rpts []map[string]any
	json.Unmarshal([]byte(raw), &rpts)
	sum := int64(0)
	for _, p := range rpts {
		sum += int64(p["value"].(float64))
	}
	if sum != 12 {
		t.Fatalf("rejected series should count 12 validation failures: %d (%s)", sum, raw)
	}

	// ml view — seed a second source in the previous minute so per-source
	// bucketing has 2 sources across 2 minute-buckets (brute_force alone is a
	// single-source, single-minute dataset).
	probeBatch := `[{"event_id":"ml-probe-1","schema_version":1,"event_time":"` + now.Format(time.RFC3339) + `","source_id":"analytics-probe","source_type":"app","severity":"info","category":"application","message":"probe a"},
{"event_id":"ml-probe-2","schema_version":1,"event_time":"` + now.Add(-70*time.Second).Format(time.RFC3339) + `","source_id":"analytics-probe","source_type":"app","severity":"info","category":"application","message":"probe b"},
{"event_id":"ml-probe-3","schema_version":1,"event_time":"` + now.Add(-70*time.Second).Format(time.RFC3339) + `","source_id":"analytics-probe","source_type":"app","severity":"info","category":"application","message":"probe c"}]`
	resp, raw = e.do(analyst, http.MethodPost, "/api/ingest", `{"batch":`+probeBatch+`}`)
	if resp.StatusCode != 202 {
		t.Fatalf("probe ingest: %d %s", resp.StatusCode, raw)
	}
	waitFor(t, 5*time.Second, "probe processing", func() bool {
		ev, err := e.st.GetEvent(context.Background(), "ml-probe-3")
		return err == nil && ev.Status == "PROCESSED"
	})
	resp, raw = e.do(viewer, http.MethodGet, "/api/analytics/ml", "")
	var mlv struct {
		ModelVersion     string           `json:"modelVersion"`
		Method           string           `json:"method"`
		AnomalyTimeline  []map[string]any `json:"anomalyTimeline"`
		CurrentBaselines []map[string]any `json:"currentBaselines"`
		LastEvaluation   any              `json:"lastEvaluation"`
	}
	json.Unmarshal([]byte(raw), &mlv)
	if resp.StatusCode != 200 || mlv.ModelVersion != "iforest-go-1.2.0" || !strings.Contains(mlv.Method, "Isolation Forest") {
		t.Fatalf("ml view: %d %s", resp.StatusCode, raw)
	}
	if len(mlv.AnomalyTimeline) < 2 || len(mlv.CurrentBaselines) != 2 {
		t.Fatalf("ml timeline: %d baselines: %d (%s)", len(mlv.AnomalyTimeline), len(mlv.CurrentBaselines), raw)
	}
	srcSeen := map[string]bool{}
	for _, row := range mlv.AnomalyTimeline {
		srcSeen[row["sourceId"].(string)] = true
	}
	if !srcSeen["prod-app-1"] || !srcSeen["analytics-probe"] {
		t.Fatalf("ml timeline must cover both sources: %v", srcSeen)
	}
	for _, row := range mlv.AnomalyTimeline {
		if row["sourceId"] == nil || row["zscore"] == nil || row["iforestScore"] == nil {
			t.Fatalf("ml timeline row missing fields: %v", row)
		}
	}

	// evaluate: viewer 403, analyst 200 deterministic
	resp, raw = e.do(viewer, http.MethodPost, "/api/analytics/ml/evaluate", "")
	if resp.StatusCode != 403 {
		t.Fatalf("viewer evaluate: %d", resp.StatusCode)
	}
	resp, raw = e.do(analyst, http.MethodPost, "/api/analytics/ml/evaluate", "")
	if resp.StatusCode != 200 {
		t.Fatalf("evaluate: %d %s", resp.StatusCode, raw)
	}
	var ev1 struct {
		Methods map[string]struct {
			Precision float64        `json:"precision"`
			Recall    float64        `json:"recall"`
			F1        float64        `json:"f1"`
			Confusion map[string]int `json:"confusion"`
		} `json:"methods"`
	}
	json.Unmarshal([]byte(raw), &ev1)
	if len(ev1.Methods) != 3 {
		t.Fatalf("methods: %s", raw)
	}
	if ev1.Methods["iforest"].Precision != 1 || ev1.Methods["iforest"].Recall != 1 || ev1.Methods["iforest"].F1 != 1 {
		t.Fatalf("iforest metrics on labeled bursts (all 5 anomalies are strong): %v", ev1.Methods["iforest"])
	}
	// determinism: second run must produce identical method metrics
	_, raw2 := e.do(analyst, http.MethodPost, "/api/analytics/ml/evaluate", "")
	extractMethods := func(s string) json.RawMessage {
		var probe struct {
			Methods json.RawMessage `json:"methods"`
		}
		if err := json.Unmarshal([]byte(s), &probe); err != nil {
			t.Fatalf("unmarshal evaluate: %v", err)
		}
		return probe.Methods
	}
	b1, _ := json.Marshal(extractMethods(raw))
	b2, _ := json.Marshal(extractMethods(raw2))
	if string(b1) != string(b2) {
		t.Fatalf("evaluate not deterministic:\n%s\n%s", b1, b2)
	}
}
