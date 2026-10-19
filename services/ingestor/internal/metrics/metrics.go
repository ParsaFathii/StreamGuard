// Copyright © 2026 Parsa Fathii — Apache-2.0

// Package metrics holds process-local counters and renders the Prometheus
// text format for /api/metrics. Durable aggregates come from the store
// (see Snapshot); process counters reset on restart (documented).
package metrics

import (
        "fmt"
        "sort"
        "strings"
        "sync"
        "sync/atomic"
)

// Counters are process-local, race-free counters for the ingest hot path.
type Counters struct {
        mu          sync.Mutex
        received    map[string]int64 // origin -> count
        ingestCodes map[string]int64 // http code -> count

        accepted   atomic.Int64
        rejected   atomic.Int64
        duplicates atomic.Int64
        processed  atomic.Int64
        llmReqs    atomic.Int64
        llmFails   atomic.Int64
}

// NewCounters creates zeroed counters.
func NewCounters() *Counters {
        return &Counters{
                received:    make(map[string]int64),
                ingestCodes: make(map[string]int64),
        }
}

// IncReceived counts a received event by origin (synthetic|external).
func (c *Counters) IncReceived(origin string) {
        c.mu.Lock()
        c.received[origin]++
        c.mu.Unlock()
}

// IncAccepted counts accepted events.
func (c *Counters) IncAccepted(n int) { c.accepted.Add(int64(n)) }

// IncRejected counts rejected events.
func (c *Counters) IncRejected(n int) { c.rejected.Add(int64(n)) }

// IncDuplicates counts duplicate events.
func (c *Counters) IncDuplicates(n int) { c.duplicates.Add(int64(n)) }

// IncProcessed counts processed events.
func (c *Counters) IncProcessed(n int) { c.processed.Add(int64(n)) }

// IncIngestCode counts one ingest request by response code.
func (c *Counters) IncIngestCode(code string) {
        c.mu.Lock()
        c.ingestCodes[code]++
        c.mu.Unlock()
}

// IncLLMRequest counts an LLM call.
func (c *Counters) IncLLMRequest() { c.llmReqs.Add(1) }

// IncLLMFailure counts a failed LLM call.
func (c *Counters) IncLLMFailure() { c.llmFails.Add(1) }

// Received returns a copy of the received-by-origin counters.
func (c *Counters) Received() map[string]int64 {
        c.mu.Lock()
        defer c.mu.Unlock()
        out := make(map[string]int64, len(c.received))
        for k, v := range c.received {
                out[k] = v
        }
        return out
}

// IngestCodes returns a copy of ingest request counters by code.
func (c *Counters) IngestCodes() map[string]int64 {
        c.mu.Lock()
        defer c.mu.Unlock()
        out := make(map[string]int64, len(c.ingestCodes))
        for k, v := range c.ingestCodes {
                out[k] = v
        }
        return out
}

// Accepted returns accepted events count.
func (c *Counters) Accepted() int64 { return c.accepted.Load() }

// Rejected returns rejected events count.
func (c *Counters) Rejected() int64 { return c.rejected.Load() }

// Duplicates returns duplicates count.
func (c *Counters) Duplicates() int64 { return c.duplicates.Load() }

// Processed returns processed events count.
func (c *Counters) Processed() int64 { return c.processed.Load() }

// LLMRequests returns LLM request count.
func (c *Counters) LLMRequests() int64 { return c.llmReqs.Load() }

// LLMFailures returns LLM failure count.
func (c *Counters) LLMFailures() int64 { return c.llmFails.Load() }

// Snapshot carries store-backed (durable) aggregates for rendering.
type Snapshot struct {
        ValidationFailuresTotal int64
        DetectionsByRule        map[string]int64 // all-time, by rule
        IncidentsByStatus       map[string]int64
        IncidentsOpen           int64
        LatencyAvgMs            float64
        LatencyP95Ms            float64
        WsConnections           int
        QueueDepth              int
        UptimeSec               int64
}

// Render produces the Prometheus text exposition format.
func (c *Counters) Render(s Snapshot) string {
        var b strings.Builder
        writeFamily := func(name, help, typ string) {
                fmt.Fprintf(&b, "# HELP %s %s\n# TYPE %s %s\n", name, help, name, typ)
        }

        writeFamily("streamguard_events_received_total", "Events received by origin (process counter, resets on restart).", "counter")
        for _, origin := range sortedKeys(c.Received()) {
                fmt.Fprintf(&b, "streamguard_events_received_total{origin=%q} %d\n", origin, c.Received()[origin])
        }
        writeFamily("streamguard_events_accepted_total", "Events accepted by validation (process counter).", "counter")
        fmt.Fprintf(&b, "streamguard_events_accepted_total %d\n", c.Accepted())
        writeFamily("streamguard_events_rejected_total", "Events rejected by validation (process counter).", "counter")
        fmt.Fprintf(&b, "streamguard_events_rejected_total %d\n", c.Rejected())
        writeFamily("streamguard_events_duplicates_total", "Duplicate event ids observed (process counter).", "counter")
        fmt.Fprintf(&b, "streamguard_events_duplicates_total %d\n", c.Duplicates())
        writeFamily("streamguard_events_processed_total", "Events fully processed by the pipeline (process counter).", "counter")
        fmt.Fprintf(&b, "streamguard_events_processed_total %d\n", c.Processed())
        writeFamily("streamguard_validation_failures_total", "Recorded validation failures (store aggregate, durable).", "counter")
        fmt.Fprintf(&b, "streamguard_validation_failures_total %d\n", s.ValidationFailuresTotal)
        writeFamily("streamguard_processing_latency_ms", "Pipeline processing latency in ms (24h store aggregate; 0.5 quantile is the average).", "summary")
        fmt.Fprintf(&b, "streamguard_processing_latency_ms{quantile=\"0.5\"} %s\n", num(s.LatencyAvgMs))
        fmt.Fprintf(&b, "streamguard_processing_latency_ms{quantile=\"0.95\"} %s\n", num(s.LatencyP95Ms))
        writeFamily("streamguard_detections_total", "Detections by rule (store aggregate, durable).", "counter")
        for _, rule := range sortedKeysInt64(s.DetectionsByRule) {
                fmt.Fprintf(&b, "streamguard_detections_total{rule_id=%q} %d\n", rule, s.DetectionsByRule[rule])
        }
        writeFamily("streamguard_incidents_total", "Incidents by status (store aggregate, durable).", "counter")
        for _, st := range sortedKeysInt64(s.IncidentsByStatus) {
                fmt.Fprintf(&b, "streamguard_incidents_total{status=%q} %d\n", st, s.IncidentsByStatus[st])
        }
        writeFamily("streamguard_incidents_open", "Currently open incidents (gauge).", "gauge")
        fmt.Fprintf(&b, "streamguard_incidents_open %d\n", s.IncidentsOpen)
        writeFamily("streamguard_ingest_requests_total", "Ingest requests by response code (process counter).", "counter")
        for _, code := range sortedKeys(c.IngestCodes()) {
                fmt.Fprintf(&b, "streamguard_ingest_requests_total{code=%q} %d\n", code, c.IngestCodes()[code])
        }
        writeFamily("streamguard_llm_requests_total", "AI investigation requests (process counter).", "counter")
        fmt.Fprintf(&b, "streamguard_llm_requests_total %d\n", c.LLMRequests())
        writeFamily("streamguard_llm_failures_total", "Failed AI investigation requests (process counter).", "counter")
        fmt.Fprintf(&b, "streamguard_llm_failures_total %d\n", c.LLMFailures())
        writeFamily("streamguard_ws_connections", "Connected SSE clients (gauge).", "gauge")
        fmt.Fprintf(&b, "streamguard_ws_connections %d\n", s.WsConnections)
        writeFamily("streamguard_queue_depth", "Pipeline queue depth (gauge).", "gauge")
        fmt.Fprintf(&b, "streamguard_queue_depth %d\n", s.QueueDepth)
        writeFamily("streamguard_uptime_seconds", "Process uptime in seconds (gauge).", "gauge")
        fmt.Fprintf(&b, "streamguard_uptime_seconds %d\n", s.UptimeSec)
        return b.String()
}

func num(v float64) string {
        return fmt.Sprintf("%g", v)
}

func sortedKeys(m map[string]int64) []string {
        out := make([]string, 0, len(m))
        for k := range m {
                out = append(out, k)
        }
        sort.Strings(out)
        return out
}

func sortedKeysInt64(m map[string]int64) []string { return sortedKeys(m) }
