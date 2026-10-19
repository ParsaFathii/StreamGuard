// Copyright © 2026 Parsa Fathi — Apache-2.0

package api

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

// sseFrame is one parsed SSE frame.
type sseFrame struct {
	ID    string
	Event string
	Data  string
}

// openStream subscribes to /api/stream with the given client and returns a
// frame channel plus a cancel function.
func openStream(t *testing.T, e *testEnv, c *http.Client) (chan sseFrame, func()) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, e.hs.URL+"/api/stream", nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	req = req.WithContext(ctx)
	resp, err := c.Do(req)
	if err != nil {
		cancel()
		t.Fatalf("open stream: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		cancel()
		t.Fatalf("stream status: %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		resp.Body.Close()
		cancel()
		t.Fatalf("stream content-type: %q", ct)
	}
	frames := make(chan sseFrame, 256)
	go func() {
		defer close(frames)
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 64*1024), 64*1024)
		cur := sseFrame{}
		for sc.Scan() {
			line := sc.Text()
			switch {
			case line == "":
				if cur.Event != "" || cur.Data != "" {
					frames <- cur
				}
				cur = sseFrame{}
			case strings.HasPrefix(line, "id: "):
				cur.ID = strings.TrimPrefix(line, "id: ")
			case strings.HasPrefix(line, "event: "):
				cur.Event = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				cur.Data = strings.TrimPrefix(line, "data: ")
			case strings.HasPrefix(line, ":"):
				// keepalive comment
			}
		}
	}()
	stop := func() {
		cancel()
		resp.Body.Close()
	}
	return frames, stop
}

// nextFrame reads one frame with a deadline.
func nextFrame(t *testing.T, frames chan sseFrame, timeout time.Duration) sseFrame {
	t.Helper()
	select {
	case f, ok := <-frames:
		if !ok {
			t.Fatalf("stream closed")
		}
		return f
	case <-time.After(timeout):
		t.Fatalf("timed out waiting for an SSE frame")
		return sseFrame{}
	}
}

// waitForEvent reads frames until one with the wanted event name arrives.
func waitForEvent(t *testing.T, frames chan sseFrame, name string, timeout time.Duration) sseFrame {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case f, ok := <-frames:
			if !ok {
				t.Fatalf("stream closed while waiting for %s", name)
			}
			if f.Event == name {
				return f
			}
		case <-deadline:
			t.Fatalf("timed out waiting for SSE event %s", name)
		}
	}
}

func TestSSEStream(t *testing.T) {
	e := newTestEnv(t, "")
	analyst := e.loginClient("analyst", "analyst123")

	// unauthenticated stream -> 401
	req, _ := http.NewRequest(http.MethodGet, e.hs.URL+"/api/stream", nil)
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anon stream: %d", resp.StatusCode)
	}

	frames, stop := openStream(t, e, analyst)
	defer stop()

	// trigger a scenario; expect batched event:new + detection:new + incident:new
	e.runScenario("brute_force")

	var eventFrame, detFrame, incFrame sseFrame
	deadline := time.Now().Add(10 * time.Second)
	gotEvent, gotDet, gotInc := false, false, false
	for !(gotEvent && gotDet && gotInc) {
		if time.Now().After(deadline) {
			t.Fatalf("sse timeout: event=%v det=%v inc=%v", gotEvent, gotDet, gotInc)
		}
		f := nextFrame(t, frames, 8*time.Second)
		switch f.Event {
		case "event:new":
			eventFrame = f
			gotEvent = true
		case "detection:new":
			detFrame = f
			gotDet = true
		case "incident:new":
			incFrame = f
			gotInc = true
		case "stats":
			// periodic; ignore
		}
	}

	// event:new frames carry the batched shape {events, count, ts}
	var evPayload struct {
		Events []map[string]any `json:"events"`
		Count  int              `json:"count"`
		Ts     string           `json:"ts"`
	}
	if err := json.Unmarshal([]byte(eventFrame.Data), &evPayload); err != nil {
		t.Fatalf("event:new payload: %v (%s)", err, eventFrame.Data)
	}
	if evPayload.Count != len(evPayload.Events) || evPayload.Count < 1 {
		t.Fatalf("event:new batch shape: %+v", evPayload)
	}
	if evPayload.Events[0]["id"] == "" || evPayload.Events[0]["message"] == "" {
		t.Fatalf("event:new rows must be compact events: %v", evPayload.Events[0])
	}
	if eventFrame.ID == "" {
		t.Fatalf("event frames must carry an id")
	}

	// detection payload references a rule expected from brute_force
	// (SG-RULE-001 count and/or SG-RULE-003 sequence — either may arrive first)
	var detPayload struct {
		RuleID string `json:"ruleId"`
		Title  string `json:"title"`
	}
	json.Unmarshal([]byte(detFrame.Data), &detPayload)
	if detPayload.RuleID != "SG-RULE-001" && detPayload.RuleID != "SG-RULE-003" {
		t.Fatalf("detection:new payload: %s", detFrame.Data)
	}
	var incPayload struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	json.Unmarshal([]byte(incFrame.Data), &incPayload)
	if !strings.HasPrefix(incPayload.ID, "INC-") || incPayload.Status != "NEW" {
		t.Fatalf("incident:new payload: %s", incFrame.Data)
	}

	// incident PATCH emits incident:update
	resp2, raw2 := e.do(analyst, http.MethodPatch, "/api/incidents/"+incPayload.ID, `{"status":"TRIAGED"}`)
	if resp2.StatusCode != 200 {
		t.Fatalf("patch: %d %s", resp2.StatusCode, raw2)
	}
	upd := waitForEvent(t, frames, "incident:update", 5*time.Second)
	if !strings.Contains(upd.Data, `"status":"TRIAGED"`) {
		t.Fatalf("incident:update payload: %s", upd.Data)
	}

	// Last-Event-ID replay: reconnect from just before the detection id
	lastID := detFrame.ID
	stop()
	req2, _ := http.NewRequest(http.MethodGet, e.hs.URL+"/api/stream", nil)
	req2.Header.Set("Last-Event-ID", lastID)
	// reuse the analyst cookie via a fresh request through the client
	// (openStream cannot set headers; do it manually here)
	ctx2, cancel2 := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel2()
	req2 = req2.WithContext(ctx2)
	// copy cookies from the jar by performing through the client
	resp3, err := analyst.Do(req2)
	if err != nil {
		t.Fatalf("replay stream: %v", err)
	}
	defer resp3.Body.Close()
	if resp3.StatusCode != http.StatusOK {
		t.Fatalf("replay status: %d", resp3.StatusCode)
	}
	sc := bufio.NewScanner(resp3.Body)
	sc.Buffer(make([]byte, 64*1024), 64*1024)
	replayed := map[string]int{}
	cur := sseFrame{}
	readFrame := func(f sseFrame) {
		if f.Event != "" {
			replayed[f.Event]++
		}
	}
	for sc.Scan() {
		line := sc.Text()
		switch {
		case line == "":
			if cur.Event != "" || cur.Data != "" {
				readFrame(cur)
			}
			cur = sseFrame{}
		case strings.HasPrefix(line, "id: "):
			cur.ID = strings.TrimPrefix(line, "id: ")
		case strings.HasPrefix(line, "event: "):
			cur.Event = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "data: "):
			cur.Data = strings.TrimPrefix(line, "data: ")
		}
		if replayed["incident:update"] >= 1 || replayed["detection:new"] >= 1 {
			break
		}
	}
	if replayed["incident:update"] < 1 {
		t.Fatalf("Last-Event-ID replay must re-deliver messages after %s; got %v", lastID, replayed)
	}

	// keepalive: not easily observable under 15s; verified by the timeout-based
	// design (see stream.go) and exercised by the E2E smoke test.
}
