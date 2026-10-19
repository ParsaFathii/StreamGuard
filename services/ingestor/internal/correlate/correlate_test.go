// Copyright © 2026 Parsa Fathi — Apache-2.0

package correlate

import (
        "context"
        "testing"
        "time"

        "github.com/ParsaFathii/StreamGuard/services/ingestor/internal/event"
        "github.com/ParsaFathii/StreamGuard/services/ingestor/internal/store"
)

var now = time.Date(2026, 3, 1, 10, 0, 0, 0, time.UTC)

func newEngine(t *testing.T) (*Engine, store.Store, *time.Time) {
        t.Helper()
        st := store.NewMemStore()
        cur := now
        eng := NewEngine(st,
                func() time.Time { return cur },
                func() time.Duration { return 10 * time.Minute })
        return eng, st, &cur
}

// det creates AND persists a detection (the real flow always persists before
// correlating).
func det(t *testing.T, st store.Store, ruleID, key, actor string, evs ...event.Event) *store.Detection {
        d := &store.Detection{
                ID:     "DET-" + ruleID + "-" + key + "-" + time.Now().Format("150405.000000000"),
                RuleID: ruleID, CorrelationKey: key,
                Severity: "high", Title: "Test Rule", Status: store.DetectionActive,
                CreatedAt: now, Detail: store.DetectionDetail{MatchedCount: len(evs), SampleEventIDs: []string{}},
        }
        if actor != "" {
                d.Detail.Actor = actor
        } else {
                d.Detail.SourceID = key
        }
        if err := st.InsertDetection(context.Background(), d); err != nil {
                t.Fatalf("insert detection: %v", err)
        }
        return d
}

func ev(id string, ts time.Time) event.Event {
        return event.Event{EventID: id, SchemaVersion: 1, EventTime: ts, IngestTime: ts,
                SourceID: "src", SourceType: "app", Severity: "low", Category: "auth", Message: "m", Origin: "synthetic"}
}

func TestCreatesSequentialIncidents(t *testing.T) {
        eng, st, _ := newEngine(t)
        matched := []event.Event{ev("e1", now.Add(-time.Minute)), ev("e2", now)}
        inc, created, err := eng.Correlate(context.Background(), det(t, st, "SG-RULE-001", "alice", "alice", matched...), matched)
        if err != nil || !created {
                t.Fatalf("create: created=%v err=%v", created, err)
        }
        if inc.ID != "INC-000001" || inc.Status != store.IncidentNew || inc.RuleID != "SG-RULE-001" {
                t.Fatalf("bad incident: %+v", inc)
        }
        if inc.CorrelationKey != "alice" || inc.CorrelationLabel != "actor: alice" {
                t.Fatalf("bad correlation fields: %+v", inc)
        }
        if inc.EventCount != 2 || inc.DetectionCount != 1 {
                t.Fatalf("bad counts: %+v", inc)
        }
        if inc.FirstEventTime.IsZero() || inc.LastEventTime.IsZero() {
                t.Fatalf("event times not set")
        }
        if len(inc.StatusHistory) != 1 || inc.StatusHistory[0].ToStatus != store.IncidentNew {
                t.Fatalf("bad history: %+v", inc.StatusHistory)
        }
        // second incident gets next sequence
        matched2 := []event.Event{ev("e3", now)}
        inc2, created2, err := eng.Correlate(context.Background(), det(t, st, "SG-RULE-001", "bob", "bob", matched2...), matched2)
        if err != nil || !created2 {
                t.Fatalf("second create failed: %v", err)
        }
        if inc2.ID != "INC-000002" {
                t.Fatalf("second incident id = %s, want INC-000002", inc2.ID)
        }
}

func TestDedupeWithinWindow(t *testing.T) {
        eng, st, _ := newEngine(t)
        matched1 := []event.Event{ev("e1", now.Add(-time.Minute))}
        inc1, created, err := eng.Correlate(context.Background(), det(t, st, "SG-RULE-001", "alice", "alice", matched1...), matched1)
        if err != nil || !created {
                t.Fatalf("first: %v", err)
        }
        // Second detection, same rule+key, within window -> attaches.
        matched2 := []event.Event{ev("e2", now)}
        d2 := det(t, st, "SG-RULE-001", "alice", "alice", matched2...)
        inc2, created2, err := eng.Correlate(context.Background(), d2, matched2)
        if err != nil {
                t.Fatalf("second: %v", err)
        }
        if created2 {
                t.Fatalf("expected attach, got new incident")
        }
        if inc2.ID != inc1.ID {
                t.Fatalf("expected same incident, got %s vs %s", inc2.ID, inc1.ID)
        }
        if inc2.DetectionCount != 2 || inc2.EventCount != 2 {
                t.Fatalf("bad counts after attach: %+v", inc2)
        }
        if d2.IncidentID != inc1.ID {
                t.Fatalf("detection not linked: %+v", d2)
        }
}

func TestWindowExpiryCreatesNewIncident(t *testing.T) {
        eng, st, cur := newEngine(t)
        matched := []event.Event{ev("e1", now.Add(-time.Minute))}
        inc1, _, err := eng.Correlate(context.Background(), det(t, st, "SG-RULE-001", "alice", "alice", matched...), matched)
        if err != nil {
                t.Fatal(err)
        }
        // Advance clock past the 10-minute window.
        *cur = now.Add(11 * time.Minute)
        matched2 := []event.Event{ev("e2", now.Add(11 * time.Minute))}
        inc2, created, err := eng.Correlate(context.Background(), det(t, st, "SG-RULE-001", "alice", "alice", matched2...), matched2)
        if err != nil {
                t.Fatal(err)
        }
        if !created || inc2.ID == inc1.ID {
                t.Fatalf("expected new incident after window expiry, got %s (created=%v)", inc2.ID, created)
        }
}

func TestResolvedIncidentNotReused(t *testing.T) {
        eng, st, _ := newEngine(t)
        matched := []event.Event{ev("e1", now)}
        inc1, _, err := eng.Correlate(context.Background(), det(t, st, "SG-RULE-001", "alice", "alice", matched...), matched)
        if err != nil {
                t.Fatal(err)
        }
        inc1.Status = store.IncidentResolved
        if err := st.UpdateIncident(context.Background(), inc1); err != nil {
                t.Fatal(err)
        }
        matched2 := []event.Event{ev("e2", now)}
        inc2, created, err := eng.Correlate(context.Background(), det(t, st, "SG-RULE-001", "alice", "alice", matched2...), matched2)
        if err != nil {
                t.Fatal(err)
        }
        if !created || inc2.ID == inc1.ID {
                t.Fatalf("resolved incident must not be reused")
        }
}

func TestLateEventsFlagged(t *testing.T) {
        eng, st, _ := newEngine(t)
        late := ev("late-1", now.Add(-30*time.Minute)) // far outside window
        early := ev("early-1", now.Add(-time.Minute))
        if _, err := st.InsertEvent(context.Background(), &late); err != nil {
                t.Fatal(err)
        }
        if _, err := st.InsertEvent(context.Background(), &early); err != nil {
                t.Fatal(err)
        }
        inc, _, err := eng.Correlate(context.Background(), det(t, st, "SG-RULE-001", "alice", "alice", late, early), []event.Event{late, early})
        if err != nil {
                t.Fatal(err)
        }
        views, total, err := st.IncidentEvents(context.Background(), inc.ID, 1, 50)
        if err != nil {
                t.Fatal(err)
        }
        if total != 2 {
                t.Fatalf("total = %d", total)
        }
        lateFlags := map[string]bool{}
        for _, v := range views {
                lateFlags[v.Event.EventID] = v.Late
        }
        if !lateFlags["late-1"] {
                t.Fatalf("old event must be flagged late: %+v", lateFlags)
        }
        if lateFlags["early-1"] {
                t.Fatalf("recent event must not be flagged late")
        }
}

func TestSeverityBumpedOnAttach(t *testing.T) {
        eng, st, _ := newEngine(t)
        matched := []event.Event{ev("e1", now)}
        if _, _, err := eng.Correlate(context.Background(), det(t, st, "SG-RULE-001", "alice", "alice", matched...), matched); err != nil {
                t.Fatal(err)
        }
        matched2 := []event.Event{ev("e2", now)}
        d2 := det(t, st, "SG-RULE-001", "alice", "alice", matched2...)
        d2.Severity = "critical"
        inc2, _, err := eng.Correlate(context.Background(), d2, matched2)
        if err != nil {
                t.Fatal(err)
        }
        if inc2.Severity != "critical" {
                t.Fatalf("severity should bump to critical, got %s", inc2.Severity)
        }
}
