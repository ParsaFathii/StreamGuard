// Copyright © 2026 Parsa Fathii — Apache-2.0

// Package correlate attaches detections to open incidents (same rule +
// correlation key, updated within the correlation window) or creates new
// sequential incidents (INC-%06d). Late events are attached but flagged.
package correlate

import (
        "context"
        "fmt"
        "time"

        "github.com/ParsaFathii/StreamGuard/services/ingestor/internal/event"
        "github.com/ParsaFathii/StreamGuard/services/ingestor/internal/store"
)

// maxAttach bounds the number of events attached per detection.
const maxAttach = 200

// Engine performs detection -> incident correlation.
type Engine struct {
        st     store.Store
        now    func() time.Time
        window func() time.Duration
}

// NewEngine creates the correlation engine. window is evaluated per call so
// runtime settings changes take effect immediately.
func NewEngine(st store.Store, now func() time.Time, window func() time.Duration) *Engine {
        if now == nil {
                now = func() time.Time { return time.Now().UTC() }
        }
        if window == nil {
                window = func() time.Duration { return 600 * time.Second }
        }
        return &Engine{st: st, now: now, window: window}
}

// Correlate attaches the detection to an existing open incident or creates a
// new one. Returns the incident and whether it was newly created.
func (e *Engine) Correlate(ctx context.Context, det *store.Detection, matched []event.Event) (*store.Incident, bool, error) {
        now := e.now()
        window := e.window()
        label := correlationLabel(det)

        existing, err := e.st.FindOpenIncident(ctx, det.RuleID, det.CorrelationKey, now.Add(-window))
        if err == nil {
                if err := e.attach(ctx, existing, det, matched, now, window); err != nil {
                        return nil, false, err
                }
                return existing, false, nil
        }
        if err != store.ErrNotFound {
                return nil, false, fmt.Errorf("find open incident: %w", err)
        }

        num, err := e.st.NextIncidentNumber(ctx)
        if err != nil {
                return nil, false, fmt.Errorf("next incident number: %w", err)
        }
        inc := &store.Incident{
                ID:               fmt.Sprintf("INC-%06d", num),
                Title:            det.Title + " — " + label,
                Severity:         det.Severity,
                Status:           store.IncidentNew,
                RuleID:           det.RuleID,
                CorrelationKey:   det.CorrelationKey,
                CorrelationLabel: label,
                DetectionCount:   1,
                EventCount:       countAttached(matched),
                CreatedAt:        now,
                UpdatedAt:        now,
                StatusHistory: []store.StatusHistoryEntry{{
                        FromStatus: "",
                        ToStatus:   store.IncidentNew,
                        Actor:      "system",
                        TS:         now,
                }},
        }
        applyEventTimes(inc, matched)
        if err := e.st.InsertIncident(ctx, inc); err != nil {
                return nil, false, fmt.Errorf("insert incident: %w", err)
        }
        if _, err := e.attachEvents(ctx, inc.ID, matched, now, window); err != nil {
                return nil, false, err
        }
        if err := e.st.SetDetectionIncident(ctx, det.ID, inc.ID); err != nil {
                return nil, false, fmt.Errorf("link detection: %w", err)
        }
        det.IncidentID = inc.ID
        return inc, true, nil
}

func (e *Engine) attach(ctx context.Context, inc *store.Incident, det *store.Detection, matched []event.Event, now time.Time, window time.Duration) error {
        inc.DetectionCount++
        inc.Severity = event.MaxSeverity(inc.Severity, det.Severity)
        inc.UpdatedAt = now
        applyEventTimes(inc, matched)
        newlyAttached, err := e.attachEvents(ctx, inc.ID, matched, now, window)
        if err != nil {
                return err
        }
        inc.EventCount += newlyAttached
        if err := e.st.UpdateIncident(ctx, inc); err != nil {
                return fmt.Errorf("update incident: %w", err)
        }
        if err := e.st.SetDetectionIncident(ctx, det.ID, inc.ID); err != nil {
                return fmt.Errorf("link detection: %w", err)
        }
        det.IncidentID = inc.ID
        return nil
}

func (e *Engine) attachEvents(ctx context.Context, incidentID string, matched []event.Event, now time.Time, window time.Duration) (int, error) {
        if len(matched) == 0 {
                return 0, nil
        }
        if len(matched) > maxAttach {
                matched = matched[len(matched)-maxAttach:] // keep most recent
        }
        links := make([]store.IncidentEvent, 0, len(matched))
        for _, ev := range matched {
                links = append(links, store.IncidentEvent{
                        IncidentID: incidentID,
                        EventID:    ev.EventID,
                        Late:       ev.EventTime.Before(now.Add(-window)),
                })
        }
        n, err := e.st.AttachIncidentEvents(ctx, incidentID, links)
        if err != nil {
                return 0, fmt.Errorf("attach events: %w", err)
        }
        return n, nil
}

func countAttached(matched []event.Event) int {
        if len(matched) > maxAttach {
                return maxAttach
        }
        return len(matched)
}

func correlationLabel(det *store.Detection) string {
        switch {
        case det.Detail.Actor != "":
                return "actor: " + det.Detail.Actor
        case det.Detail.SourceID != "":
                return "source: " + det.Detail.SourceID
        default:
                return "global"
        }
}

func applyEventTimes(inc *store.Incident, matched []event.Event) {
        for _, ev := range matched {
                if inc.FirstEventTime.IsZero() || ev.EventTime.Before(inc.FirstEventTime) {
                        inc.FirstEventTime = ev.EventTime
                }
                if inc.LastEventTime.IsZero() || ev.EventTime.After(inc.LastEventTime) {
                        inc.LastEventTime = ev.EventTime
                }
        }
}
