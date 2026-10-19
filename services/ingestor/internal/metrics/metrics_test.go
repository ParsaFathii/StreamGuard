// Copyright © 2026 Parsa Fathii — Apache-2.0

package metrics

import (
	"fmt"
	"regexp"
	"strings"
	"testing"
)

func TestRenderFormat(t *testing.T) {
	c := NewCounters()
	c.IncReceived("synthetic")
	c.IncReceived("synthetic")
	c.IncReceived("external")
	c.IncAccepted(2)
	c.IncRejected(1)
	c.IncDuplicates(3)
	c.IncProcessed(2)
	c.IncIngestCode("202")
	c.IncIngestCode("202")
	c.IncIngestCode("429")
	c.IncLLMRequest()
	c.IncLLMFailure()

	out := c.Render(Snapshot{
		ValidationFailuresTotal: 7,
		DetectionsByRule:        map[string]int64{"SG-RULE-001": 4, "SG-RULE-002": 2},
		IncidentsByStatus:       map[string]int64{"NEW": 2, "RESOLVED": 1},
		IncidentsOpen:           2,
		LatencyAvgMs:            12.5,
		LatencyP95Ms:            40.25,
		WsConnections:           3,
		QueueDepth:              1,
		UptimeSec:               99,
	})

	lines := strings.Split(strings.TrimSpace(out), "\n")
	sampleRe := regexp.MustCompile(`^[a-z_:]+(\{[a-z_]+="[^"]*"(,[a-z_]+="[^"]*")*\})? [0-9.eE+-]+$`)
	typeRe := regexp.MustCompile(`^# TYPE [a-z_:]+ (counter|gauge|summary)$`)
	samples := 0
	for i, ln := range lines {
		switch {
		case strings.HasPrefix(ln, "# TYPE "):
			if !typeRe.MatchString(ln) {
				t.Errorf("line %d bad TYPE: %q", i, ln)
			}
		case strings.HasPrefix(ln, "# HELP "):
			// ok
		case ln == "":
			t.Errorf("line %d empty", i)
		default:
			if !sampleRe.MatchString(ln) {
				t.Errorf("line %d bad sample: %q", i, ln)
			}
			samples++
		}
	}
	if samples < 15 {
		t.Fatalf("too few samples: %d\n%s", samples, out)
	}
	for _, want := range []string{
		`streamguard_events_received_total{origin="synthetic"} 2`,
		`streamguard_events_received_total{origin="external"} 1`,
		`streamguard_events_accepted_total 2`,
		`streamguard_events_rejected_total 1`,
		`streamguard_events_duplicates_total 3`,
		`streamguard_events_processed_total 2`,
		`streamguard_validation_failures_total 7`,
		`streamguard_processing_latency_ms{quantile="0.5"} 12.5`,
		`streamguard_processing_latency_ms{quantile="0.95"} 40.25`,
		`streamguard_detections_total{rule_id="SG-RULE-001"} 4`,
		`streamguard_detections_total{rule_id="SG-RULE-002"} 2`,
		`streamguard_incidents_total{status="NEW"} 2`,
		`streamguard_incidents_open 2`,
		`streamguard_ingest_requests_total{code="202"} 2`,
		`streamguard_ingest_requests_total{code="429"} 1`,
		`streamguard_llm_requests_total 1`,
		`streamguard_llm_failures_total 1`,
		`streamguard_ws_connections 3`,
		`streamguard_queue_depth 1`,
		`streamguard_uptime_seconds 99`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing metric line: %s", want)
		}
	}
}

func TestCounterConcurrency(t *testing.T) {
	c := NewCounters()
	done := make(chan struct{})
	for g := 0; g < 8; g++ {
		go func() {
			for i := 0; i < 100; i++ {
				c.IncReceived("synthetic")
				c.IncAccepted(1)
				c.IncIngestCode("202")
			}
			done <- struct{}{}
		}()
	}
	for g := 0; g < 8; g++ {
		<-done
	}
	if c.Received()["synthetic"] != 800 || c.Accepted() != 800 || c.IngestCodes()["202"] != 800 {
		t.Fatalf("counters lost updates: %+v", c.Received())
	}
	out := c.Render(Snapshot{})
	if !strings.Contains(out, "streamguard_events_received_total{origin=\"synthetic\"} 800") {
		t.Fatalf("rendered counters wrong:\n%s", out)
	}
}

func TestZeroSnapshot(t *testing.T) {
	c := NewCounters()
	out := c.Render(Snapshot{})
	if !strings.Contains(out, "streamguard_incidents_open 0") {
		t.Fatalf("zero gauge missing:\n%s", out)
	}
	if fmt.Sprint(c.Processed()) != "0" {
		t.Fatalf("processed should be 0")
	}
}
