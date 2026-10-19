// Copyright © 2026 Parsa Fathi — Apache-2.0

// Package sim implements the deterministic, seeded event generator shared by
// the simulator API endpoints and the sggen CLI, plus the labeled dataset
// used for reproducible ML evaluation.
package sim

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"sort"
	"time"

	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/event"
)

// Scenario describes a demo scenario.
type Scenario struct {
	ID                     string   `json:"id"`
	Name                   string   `json:"name"`
	Description            string   `json:"description"`
	ExpectedDetections     []string `json:"expectedDetections"`
	ExpectedIncidentSeverity string `json:"expectedIncidentSeverity"` // "" = none
}

// Scenarios returns all demo scenarios (contract list).
func Scenarios() []Scenario {
	return []Scenario{
		{ID: "clean_baseline", Name: "Clean Baseline", Description: "Normal logins, requests and heartbeats with no anomalies.",
			ExpectedDetections: []string{}, ExpectedIncidentSeverity: ""},
		{ID: "brute_force", Name: "Brute Force", Description: "Eight failed logins for one actor followed by a success.",
			ExpectedDetections: []string{"SG-RULE-001", "SG-RULE-003"}, ExpectedIncidentSeverity: "high"},
		{ID: "credential_stuffing", Name: "Credential Stuffing", Description: "Four actors each trying six stolen credentials.",
			ExpectedDetections: []string{"SG-RULE-001"}, ExpectedIncidentSeverity: "high"},
		{ID: "traffic_burst", Name: "Traffic Burst", Description: "130 requests within a minute from one web source.",
			ExpectedDetections: []string{"SG-RULE-002"}, ExpectedIncidentSeverity: "medium"},
		{ID: "latency_spike", Name: "Latency Spike", Description: "Slow responses without errors (no rule fires; ML only).",
			ExpectedDetections: []string{}, ExpectedIncidentSeverity: ""},
		{ID: "error_storm", Name: "Error Storm", Description: "Application errors above 30% with at least 20 events.",
			ExpectedDetections: []string{"SG-RULE-004"}, ExpectedIncidentSeverity: "medium"},
		{ID: "config_change", Name: "Config Change", Description: "A configuration change on an infra source.",
			ExpectedDetections: []string{"SG-RULE-006"}, ExpectedIncidentSeverity: "high"},
		{ID: "authz_failures", Name: "Authorization Failures", Description: "Repeated access-denied decisions for one actor.",
			ExpectedDetections: []string{"SG-RULE-005"}, ExpectedIncidentSeverity: "medium"},
		{ID: "malformed_batch", Name: "Malformed Batch", Description: "Twelve invalid events rejected by validation (fires SG-RULE-007).",
			ExpectedDetections: []string{"SG-RULE-007"}, ExpectedIncidentSeverity: "low"},
		{ID: "mixed_attack", Name: "Mixed Attack", Description: "Brute force + error storm + config change combined.",
			ExpectedDetections: []string{"SG-RULE-001", "SG-RULE-003", "SG-RULE-004", "SG-RULE-006"}, ExpectedIncidentSeverity: "high"},
	}
}

// GetScenario finds a scenario by id.
func GetScenario(id string) (Scenario, bool) {
	for _, s := range Scenarios() {
		if s.ID == id {
			return s, true
		}
	}
	return Scenario{}, false
}

// rawEvent marshals an event into the client ingest shape.
func rawEvent(e event.Event) json.RawMessage {
	b, err := json.Marshal(&e)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return b
}

func ev(id string, ts time.Time, srcType, srcID, sev, cat, msg, actor string, attrs map[string]any) event.Event {
	return event.Event{
		EventID: id, SchemaVersion: 1, EventTime: ts,
		SourceType: srcType, SourceID: srcID, Severity: sev, Category: cat,
		Message: msg, Actor: actor, Attributes: attrs,
	}
}

// Generate produces count raw event JSON documents for the scenario,
// deterministically from (seed, count, now). Event ids are stable:
// sg-<scenario>-<seed>-<n>.
func Generate(scenarioID string, seed int64, count int, now time.Time) ([]json.RawMessage, error) {
	if _, ok := GetScenario(scenarioIDID(scenarioID)); !ok && scenarioID != "" {
		return nil, fmt.Errorf("unknown scenario %q", scenarioID)
	}
	if count < 1 {
		count = 1
	}
	if count > 10000 {
		count = 10000
	}
	rng := rand.New(rand.NewSource(seed))
	id := func(n int) string { return fmt.Sprintf("sg-%s-%d-%04d", scenarioID, seed, n) }
	ts := func(i int) time.Time { return now.Add(-time.Duration(i%60) * time.Second) }

	var evs []event.Event
	switch scenarioID {
	case "clean_baseline":
		for i := 0; i < count; i++ {
			switch i % 4 {
			case 0:
				evs = append(evs, ev(id(i), ts(i), "app", "prod-app-1", "info", "auth", "login ok", fmt.Sprintf("user-%d", rng.Intn(5)), map[string]any{"action": "login_success"}))
			case 1:
				evs = append(evs, ev(id(i), ts(i), "app", "prod-web-1", "info", "network", "GET /api/health", "", map[string]any{"kind": "request", "status": "200"}))
			case 2:
				evs = append(evs, ev(id(i), ts(i), "app", "prod-app-1", "info", "application", "request handled", "", map[string]any{"status": "200"}))
			default:
				evs = append(evs, ev(id(i), ts(i), "system", "sys-01", "info", "system", "heartbeat ok", "", nil))
			}
		}
	case "brute_force":
		// Chronology matters for SG-RULE-003 (fails THEN success): failures
		// get the older timestamps, the success is the most recent event.
		n := 8
		if count < n {
			n = count
		}
		for i := 0; i < n; i++ {
			evs = append(evs, ev(id(i), now.Add(-time.Duration(n-i)*time.Second), "app", "prod-app-1", "low", "auth", "login failed", "attacker@synthetic.local", map[string]any{"action": "login_failed"}))
		}
		if count > n {
			evs = append(evs, ev(id(n), now, "app", "prod-app-1", "info", "auth", "login succeeded after failures", "attacker@synthetic.local", map[string]any{"action": "login_success"}))
		}
	case "credential_stuffing":
		actors := 4
		per := 6
		if count < actors*per {
			per = count/actors + 1
		}
		n := 0
		for a := 0; a < actors; a++ {
			for j := 0; j < per && n < count; j++ {
				evs = append(evs, ev(id(n), ts(n), "app", "prod-app-1", "low", "auth",
					fmt.Sprintf("login failed for stuffed credential %d", j),
					fmt.Sprintf("stuffed-%d@synthetic.local", a),
					map[string]any{"action": "login_failed"}))
				n++
			}
		}
	case "traffic_burst":
		n := 130
		if count > n {
			n = count
		}
		for i := 0; i < n; i++ {
			evs = append(evs, ev(id(i), ts(i), "app", "prod-web-1", "info", "network", fmt.Sprintf("GET /api/items?page=%d", i%20), "", map[string]any{"kind": "request", "status": "200"}))
		}
	case "latency_spike":
		for i := 0; i < count; i++ {
			lat := 800 + rng.Intn(2200)
			evs = append(evs, ev(id(i), ts(i), "app", "prod-app-1", "info", "application", "slow response", "", map[string]any{"status": "200", "latency_ms": lat}))
		}
	case "error_storm":
		n := 30
		if count > n {
			n = count
		}
		for i := 0; i < n; i++ {
			sev, msg := "info", "request handled"
			if i%5 < 3 { // 60% errors
				sev, msg = "high", "internal server error"
			}
			evs = append(evs, ev(id(i), ts(i), "app", "prod-app-2", sev, "application", msg, "", map[string]any{"status": "500"}))
		}
	case "config_change":
		evs = append(evs, ev(id(0), now, "infra", "db-01", "high", "config", "firewall allow-list changed by ops-bot", "ops-bot", map[string]any{"action": "change", "setting": "firewall.rules"}))
		for i := 1; i < count; i++ {
			evs = append(evs, ev(id(i), ts(i), "system", "sys-01", "info", "system", "heartbeat ok", "", nil))
		}
	case "authz_failures":
		n := 4
		if count < n {
			n = count
		}
		for i := 0; i < n; i++ {
			evs = append(evs, ev(id(i), ts(i), "security", "sec-gateway-1", "medium", "security", "access denied: missing role", "intruder@synthetic.local", map[string]any{"action": "access_denied"}))
		}
	case "malformed_batch":
		// Deliberately invalid documents (each fails a different check).
		malformed := []string{
			`{"event_id":"bad-1","schema_version":2,"event_time":"2026-01-01T00:00:00Z","source_id":"s","source_type":"app","severity":"info","category":"auth","message":"wrong schema"}`,
			`{"schema_version":1,"event_time":"2026-01-01T00:00:00Z","source_id":"s","source_type":"app","severity":"info","category":"auth","message":"no id"}`,
			`{"event_id":"bad-3","schema_version":1,"event_time":"not-a-time","source_id":"s","source_type":"app","severity":"info","category":"auth","message":"bad time"}`,
			`{"event_id":"bad-4","schema_version":1,"event_time":"2026-01-01T00:00:00Z","source_id":"has space!","source_type":"app","severity":"info","category":"auth","message":"bad source"}`,
			`{"event_id":"bad-5","schema_version":1,"event_time":"2026-01-01T00:00:00Z","source_id":"s","source_type":"app","severity":"extreme","category":"auth","message":"bad severity"}`,
			`{"event_id":"bad-6","schema_version":1,"event_time":"2026-01-01T00:00:00Z","source_id":"s","source_type":"app","severity":"info","category":"nonsense","message":"bad category"}`,
			`{"event_id":"bad-7","schema_version":1,"event_time":"2026-01-01T00:00:00Z","source_id":"s","source_type":"app","severity":"info","category":"auth"}`,
			`{"event_id":"bad-8","schema_version":1,"event_time":"2026-01-01T00:00:00Z","source_id":"s","source_type":"app","severity":"info","category":"auth","message":"ok","unknown_field":1}`,
			`{"event_id":"bad-9","schema_version":1,"event_time":"2099-01-01T00:00:00Z","source_id":"s","source_type":"app","severity":"info","category":"auth","message":"future"}`,
			`{"event_id":"bad-10","schema_version":1,"event_time":"2026-01-01T00:00:00Z","source_id":"s","source_type":"app","severity":"info","category":"auth","message":"attrs not object","attributes":"nope"}`,
			`{"event_id":"bad-11","schema_version":1,"event_time":"2026-01-01T00:00:00Z","source_id":"s","source_type":"app","severity":"info","category":"auth","message":"msg too long","correlation_id":"` + repeat("c", 129) + `"}`,
			`{"event_id":"bad-12","schema_version":1,"event_time":"2026-01-01T00:00:00Z","source_id":"s","source_type":"iot","severity":"info","category":"auth","message":"bad source type"}`,
		}
		out := make([]json.RawMessage, 0, count)
		for i := 0; i < count; i++ {
			out = append(out, json.RawMessage(malformed[i%len(malformed)]))
		}
		return out, nil
	case "mixed_attack":
		// brute force (8 fails THEN success — success is the newest event)
		for i := 0; i < 8; i++ {
			evs = append(evs, ev(id(i), now.Add(-time.Duration(8-i)*time.Second), "app", "prod-app-1", "low", "auth", "login failed", "attacker@synthetic.local", map[string]any{"action": "login_failed"}))
		}
		evs = append(evs, ev(id(8), now, "app", "prod-app-1", "info", "auth", "login succeeded after failures", "attacker@synthetic.local", map[string]any{"action": "login_success"}))
		// error storm on another source
		for i := 0; i < 20; i++ {
			sev, msg := "info", "request handled"
			if i < 14 {
				sev, msg = "high", "internal server error"
			}
			evs = append(evs, ev(id(9+i), ts(i), "app", "prod-app-2", sev, "application", msg, "", map[string]any{"status": "500"}))
		}
		// config change
		evs = append(evs, ev(id(29), now, "infra", "db-01", "high", "config", "firewall allow-list changed by ops-bot", "ops-bot", map[string]any{"action": "change"}))
		// pad with noise up to count
		for i := 30; i < count; i++ {
			evs = append(evs, ev(id(i), ts(i), "system", "sys-01", "info", "system", "heartbeat ok", "", nil))
		}
	default:
		return nil, fmt.Errorf("unknown scenario %q", scenarioID)
	}
	out := make([]json.RawMessage, 0, len(evs))
	for _, e := range evs {
		out = append(out, rawEvent(e))
	}
	return out, nil
}

func scenarioIDID(s string) string { return s }

func repeat(s string, n int) string {
	out := ""
	for i := 0; i < n; i++ {
		out += s
	}
	return out
}

// GenerateNormal produces normal-activity events for /api/simulator/tick.
func GenerateNormal(seed int64, count int, now time.Time) []json.RawMessage {
	if count < 1 {
		count = 12
	}
	rng := rand.New(rand.NewSource(seed))
	out := make([]json.RawMessage, 0, count)
	for i := 0; i < count; i++ {
		id := fmt.Sprintf("sg-tick-%d-%04d", seed, i)
		ts := now.Add(-time.Duration(i) * time.Second)
		var e event.Event
		switch rng.Intn(4) {
		case 0:
			e = ev(id, ts, "app", "prod-app-1", "info", "auth", "login ok", fmt.Sprintf("user-%d", rng.Intn(8)), map[string]any{"action": "login_success"})
		case 1:
			e = ev(id, ts, "app", "prod-web-1", "info", "network", "GET /api/items", "", map[string]any{"kind": "request", "status": "200"})
		case 2:
			e = ev(id, ts, "app", "prod-app-1", "info", "application", "request handled", "", map[string]any{"status": "200"})
		default:
			e = ev(id, ts, "system", "sys-01", "info", "system", "heartbeat ok", "", nil)
		}
		out = append(out, rawEvent(e))
	}
	return out
}

// LabeledBucket is a minute-bucket of events with ground-truth label for the
// reproducible ML evaluation.
type LabeledBucket struct {
	BucketStart time.Time
	SourceID    string
	Events      []event.Event
	Anomaly     bool
}

// LabeledDataset generates the deterministic labeled evaluation dataset
// (fixed seed): 3 sources x minutes of normal traffic with injected attack
// bursts at known positions.
func LabeledDataset(seed int64, minutes int) []LabeledBucket {
	if minutes < 60 {
		minutes = 120
	}
	rng := rand.New(rand.NewSource(seed))
	now := time.Now().UTC().Truncate(time.Minute)
	sources := []string{"prod-app-1", "prod-web-1", "prod-db-1"}
	srcType := map[string]string{"prod-app-1": "app", "prod-web-1": "app", "prod-db-1": "infra"}

	// anomalies: (source index, minute index) pairs
	anomalies := map[string]bool{}
	mark := func(srcIdx, minute int) {
		anomalies[fmt.Sprintf("%s|%d", sources[srcIdx], minute)] = true
	}
	// brute force on app at minutes 30..32
	for m := 30; m <= 32; m++ {
		mark(0, m)
	}
	// error storm on web at minutes 60..61
	for m := 60; m <= 61; m++ {
		mark(1, m)
	}
	// traffic burst on db at minute 90
	mark(2, 90)

	buckets := make([]LabeledBucket, 0, minutes*len(sources))
	for mIdx := 0; mIdx < minutes; mIdx++ {
		bucketStart := now.Add(time.Duration(mIdx-minutes) * time.Minute)
		for sIdx, src := range sources {
			b := LabeledBucket{BucketStart: bucketStart, SourceID: src, Anomaly: anomalies[fmt.Sprintf("%s|%d", src, mIdx)]}
			base := 8 + rng.Intn(10) // 8..17 events/minute
			for i := 0; i < base; i++ {
				ts := bucketStart.Add(time.Duration(i) * time.Second)
				e := ev(fmt.Sprintf("ds-%d-%s-%d-%d", seed, src, mIdx, i), ts, srcType[src], src, "info", "application", "request handled", "", map[string]any{"status": "200"})
				b.Events = append(b.Events, e)
			}
			// normal auth noise
			if rng.Intn(3) == 0 {
				ts := bucketStart.Add(30 * time.Second)
				b.Events = append(b.Events, ev(fmt.Sprintf("ds-%d-%s-%d-auth", seed, src, mIdx), ts, srcType[src], src, "info", "auth", "login ok", "user-1", map[string]any{"action": "login_success"}))
			}
			switch {
			case sIdx == 0 && mIdx >= 30 && mIdx <= 32:
				// brute force: 6 failed logins
				for i := 0; i < 6; i++ {
					ts := bucketStart.Add(time.Duration(i*5) * time.Second)
					b.Events = append(b.Events, ev(fmt.Sprintf("ds-%d-%s-%d-bf-%d", seed, src, mIdx, i), ts, srcType[src], src, "low", "auth", "login failed", "attacker@synthetic.local", map[string]any{"action": "login_failed"}))
				}
			case sIdx == 1 && mIdx >= 60 && mIdx <= 61:
				// error storm: 60% errors
				for i := 0; i < 20; i++ {
					ts := bucketStart.Add(time.Duration(i) * time.Second)
					sev, msg := "info", "request handled"
					if i < 13 {
						sev, msg = "high", "internal server error"
					}
					b.Events = append(b.Events, ev(fmt.Sprintf("ds-%d-%s-%d-es-%d", seed, src, mIdx, i), ts, srcType[src], src, sev, "application", msg, "", map[string]any{"status": "500"}))
				}
			case sIdx == 2 && mIdx == 90:
				// traffic burst: 130 requests
				for i := 0; i < 130; i++ {
					ts := bucketStart.Add(time.Duration(i%60) * time.Second)
					b.Events = append(b.Events, ev(fmt.Sprintf("ds-%d-%s-%d-tb-%d", seed, src, mIdx, i), ts, srcType[src], src, "info", "network", "GET /api", "", map[string]any{"kind": "request"}))
				}
			}
			buckets = append(buckets, b)
		}
	}
	sort.Slice(buckets, func(i, j int) bool {
		if !buckets[i].BucketStart.Equal(buckets[j].BucketStart) {
			return buckets[i].BucketStart.Before(buckets[j].BucketStart)
		}
		return buckets[i].SourceID < buckets[j].SourceID
	})
	return buckets
}
