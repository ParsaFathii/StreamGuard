// Copyright © 2026 Parsa Fathi — Apache-2.0

package sse

import "time"

// Live channel names (identical to the socket.io demo channels).
const (
        ChannelEventNew       = "event:new"
        ChannelDetectionNew   = "detection:new"
        ChannelIncidentNew    = "incident:new"
        ChannelIncidentUpdate = "incident:update"
        ChannelStats          = "stats"
        ChannelSimulator      = "simulator"
)

// LiveEventPayload is the compact event payload for event:new.
type LiveEventPayload struct {
        ID        string  `json:"id"`
        EventTime string  `json:"eventTime"`
        Severity  string  `json:"severity"`
        Category  string  `json:"category"`
        SourceID  string  `json:"sourceId"`
        Actor     *string `json:"actor"`
        Message   string  `json:"message"` // truncated to 140 chars
        Origin    string  `json:"origin"`
}

// DetectionPayload is the detection summary for detection:new.
type DetectionPayload struct {
        ID         string  `json:"id"`
        RuleID     string  `json:"ruleId"`
        EventID    string  `json:"eventId"`
        IncidentID *string `json:"incidentId"`
        Severity   string  `json:"severity"`
        Score      float64 `json:"score"`
        Title      string  `json:"title"`
        CreatedAt  string  `json:"createdAt"`
}

// IncidentPayload is the incident summary for incident:new / incident:update.
type IncidentPayload struct {
        ID             string `json:"id"`
        Title          string `json:"title"`
        Severity       string `json:"severity"`
        Status         string `json:"status"`
        RuleID         string `json:"ruleId"`
        EventCount     int    `json:"eventCount"`
        DetectionCount int    `json:"detectionCount"`
        UpdatedAt      string `json:"updatedAt"`
}

// StatsPayload is the periodic overview counters payload for stats.
type StatsPayload struct {
        Events24h     int64 `json:"events24h"`
        Detections24h int64 `json:"detections24h"`
        IncidentsOpen int64 `json:"incidentsOpen"`
        QueueDepth    int   `json:"queueDepth"`
        UpdatedAt     string `json:"updatedAt"`
}

// SimulatorPayload is emitted when a simulator run finishes.
type SimulatorPayload struct {
        RunID      string `json:"runId"`
        ScenarioID string `json:"scenarioId"`
        Phase      string `json:"phase"`
}

// TruncateMessage cuts a message to at most 140 runes.
func TruncateMessage(s string, max int) string {
        if max <= 0 {
                max = 140
        }
        r := []rune(s)
        if len(r) <= max {
                return s
        }
        return string(r[:max])
}

// FormatTime renders a timestamp in contract ISO-8601 UTC form.
func FormatTime(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }
