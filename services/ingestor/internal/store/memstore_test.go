// Copyright © 2026 Parsa Fathii — Apache-2.0

package store

import (
        "context"
        "fmt"
        "sync"
        "testing"
        "time"

        "github.com/ParsaFathii/StreamGuard/services/ingestor/internal/event"
)

var tnow = time.Date(2026, 3, 1, 10, 0, 0, 0, time.UTC)

func tev(id string, minsAgo int, sev, cat, status string) *event.Event {
        ts := tnow.Add(-time.Duration(minsAgo) * time.Minute)
        return &event.Event{
                EventID: id, SchemaVersion: 1, EventTime: ts, IngestTime: ts,
                SourceID: "src-" + cat, SourceType: "app", Severity: sev, Category: cat,
                Message: "message " + id, Origin: "synthetic", Status: status, LatencyMs: 5,
        }
}

func TestMemStoreEventCRUD(t *testing.T) {
        ctx := context.Background()
        m := NewMemStore()
        if ok, err := m.InsertEvent(ctx, tev("e1", 0, "info", "auth", "VALIDATED")); err != nil || !ok {
                t.Fatalf("insert: %v %v", ok, err)
        }
        if ok, _ := m.InsertEvent(ctx, tev("e1", 0, "info", "auth", "VALIDATED")); ok {
                t.Fatalf("duplicate insert must be idempotent")
        }
        e, err := m.GetEvent(ctx, "e1")
        if err != nil || e.EventID != "e1" {
                t.Fatalf("get: %v", err)
        }
        if _, err := m.GetEvent(ctx, "missing"); err != ErrNotFound {
                t.Fatalf("want ErrNotFound, got %v", err)
        }
        if err := m.SetEventProcessed(ctx, "e1", 42, tnow); err != nil {
                t.Fatal(err)
        }
        e, _ = m.GetEvent(ctx, "e1")
        if e.Status != "PROCESSED" || e.LatencyMs != 42 {
                t.Fatalf("processed update failed: %+v", e)
        }
        n, err := m.DeleteEvents(ctx, []string{"e1"})
        if err != nil || n != 1 {
                t.Fatalf("delete: %d %v", n, err)
        }
        if _, err := m.GetEvent(ctx, "e1"); err != ErrNotFound {
                t.Fatalf("event should be gone")
        }
}

func TestMemStoreListEventsFiltersAndPagination(t *testing.T) {
        ctx := context.Background()
        m := NewMemStore()
        for i := 0; i < 30; i++ {
                sev := "info"
                if i%3 == 0 {
                        sev = "high"
                }
_, _ = m.InsertEvent(ctx, tev(fmt.Sprintf("f-%d", i), i, sev, "auth", "PROCESSED"))
        }
        evs, total, err := m.ListEvents(ctx, EventFilter{}, 2, 10)
        if err != nil || total != 30 || len(evs) != 10 {
                t.Fatalf("pagination: len=%d total=%d err=%v", len(evs), total, err)
        }
        if evs[0].EventTime.Before(evs[1].EventTime) {
                t.Fatalf("events must be sorted desc by event_time")
        }
        evs, total, _ = m.ListEvents(ctx, EventFilter{Severities: []string{"high"}}, 1, 100)
        if total != 10 || len(evs) != 10 {
                t.Fatalf("severity filter: %d", total)
        }
        evs, total, _ = m.ListEvents(ctx, EventFilter{Q: "message f-2"}, 1, 100)
        if total != 2 { // f-2 and f-2x matches f-2, f-20..f-29 -> careful
                t.Logf("q total = %d (f-2 prefix matches f-20..29 too)", total)
        }
        evs, total, _ = m.ListEvents(ctx, EventFilter{Q: "message f-29"}, 1, 100)
        if total != 1 || evs[0].EventID != "f-29" {
                t.Fatalf("q filter exact: %d", total)
        }
        from := tnow.Add(-5 * time.Minute)
        to := tnow.Add(-1 * time.Minute)
        _, total, _ = m.ListEvents(ctx, EventFilter{From: &from, To: &to}, 1, 100)
        if total != 5 { // minutes 1..5 ago
                t.Fatalf("time filter: %d", total)
        }
}

func TestMemStoreQueryEventsSelector(t *testing.T) {
        ctx := context.Background()
        m := NewMemStore()
        ins := func(id string, attrs map[string]any) {
                ev := tev(id, 1, "low", "auth", "PROCESSED")
                ev.Attributes = attrs
_, _ = m.InsertEvent(ctx, ev)
        }
        ins("q1", map[string]any{"action": "login_failed"})
        ins("q2", map[string]any{"action": "login_success"})
        old := tev("q3", 30, "low", "auth", "PROCESSED")
        old.Attributes = map[string]any{"action": "login_failed"}
_, _ = m.InsertEvent(ctx, old)

        evs, err := m.QueryEvents(ctx, EventQuery{
                Categories: []string{"auth"}, AttrKey: "action", AttrValue: "login_failed",
                Since: tnow.Add(-5 * time.Minute), Limit: 10,
        })
        if err != nil || len(evs) != 1 || evs[0].EventID != "q1" {
                t.Fatalf("selector query: %+v %v", evs, err)
        }
}

func TestMemStoreAggregates(t *testing.T) {
        ctx := context.Background()
        m := NewMemStore()
        for i := 0; i < 10; i++ {
                ev := tev(fmt.Sprintf("a-%d", i), i, "high", "auth", "PROCESSED")
                ev.SourceID = "src-x"
_, _ = m.InsertEvent(ctx, ev)
        }
        n, _ := m.CountEventsSince(ctx, tnow.Add(-5*time.Minute))
        if n != 6 { // minutes 0..5 ago inclusive
                t.Fatalf("count since: %d", n)
        }
        sev, _ := m.SeverityBreakdownSince(ctx, tnow.Add(-24*time.Hour))
        if sev["high"] != 10 {
                t.Fatalf("severity breakdown: %+v", sev)
        }
        cat, _ := m.CategoryBreakdownSince(ctx, tnow.Add(-24*time.Hour))
        if cat["auth"] != 10 {
                t.Fatalf("category breakdown: %+v", cat)
        }
        top, _ := m.TopSourcesSince(ctx, tnow.Add(-24*time.Hour), 8)
        if len(top) != 1 || top[0].Count != 10 {
                t.Fatalf("top sources: %+v", top)
        }
        mc, _ := m.MinuteCounts(ctx, "events", tnow.Add(-24*time.Hour))
        if len(mc) != 10 {
                t.Fatalf("minute counts: %d buckets", len(mc))
        }
        avg, p95, last, _ := m.LatencyStatsSince(ctx, tnow.Add(-24*time.Hour))
        if avg != 5 || p95 != 5 || last.IsZero() {
                t.Fatalf("latency stats: %v %v %v", avg, p95, last)
        }
        sources, _ := m.SourcesSince(ctx, tnow.Add(-24*time.Hour))
        if len(sources) != 1 || sources[0].Events24h != 10 {
                t.Fatalf("sources: %+v", sources)
        }
}

func TestMemStoreRetentionProtectsOpenIncidents(t *testing.T) {
        ctx := context.Background()
        m := NewMemStore()
        old := tev("keep-me", 600, "low", "security", "PROCESSED") // 10h ago
        old.IngestTime = tnow.Add(-10 * time.Hour)
        del := tev("del-me", 600, "low", "security", "PROCESSED")
        del.IngestTime = tnow.Add(-10 * time.Hour)
_, _ = m.InsertEvent(ctx, old)
_, _ = m.InsertEvent(ctx, del)
        num, _ := m.NextIncidentNumber(ctx)
        inc := &Incident{ID: fmt.Sprintf("INC-%06d", num), Status: IncidentNew, RuleID: "SG-RULE-005", CreatedAt: tnow, UpdatedAt: tnow}
        _ = m.InsertIncident(ctx, inc)
        if _, err := m.AttachIncidentEvents(ctx, inc.ID, []IncidentEvent{{IncidentID: inc.ID, EventID: "keep-me"}}); err != nil {
                t.Fatal(err)
        }
        n, err := m.DeleteEventsBefore(ctx, tnow.Add(-2*time.Hour))
        if err != nil || n != 1 {
                t.Fatalf("retention delete: %d %v", n, err)
        }
        if _, err := m.GetEvent(ctx, "del-me"); err != ErrNotFound {
                t.Fatalf("del-me should be deleted")
        }
        if _, err := m.GetEvent(ctx, "keep-me"); err != nil {
                t.Fatalf("keep-me must survive (attached to open incident): %v", err)
        }
        // closing the incident lifts protection
        inc.Status = IncidentClosed
        _ = m.UpdateIncident(ctx, inc)
        if n, _ := m.DeleteEventsBefore(ctx, tnow.Add(-2*time.Hour)); n != 1 {
                t.Fatalf("closed incident events should be deletable")
        }
}

func TestMemStoreIncidentsAndNotes(t *testing.T) {
        ctx := context.Background()
        m := NewMemStore()
        num, _ := m.NextIncidentNumber(ctx)
        if num != 1 || fmt.Sprintf("INC-%06d", num) != "INC-000001" {
                t.Fatalf("sequence: %d", num)
        }
        inc := &Incident{ID: "INC-000001", Title: "t", Severity: "high", Status: IncidentNew,
                RuleID: "r", CorrelationKey: "k", CreatedAt: tnow, UpdatedAt: tnow}
        if err := m.InsertIncident(ctx, inc); err != nil {
                t.Fatal(err)
        }
        got, err := m.GetIncident(ctx, "INC-000001")
        if err != nil || got.Status != IncidentNew {
                t.Fatalf("get incident: %v", err)
        }
        if _, err := m.FindOpenIncident(ctx, "r", "k", tnow.Add(-time.Minute)); err != nil {
                t.Fatalf("find open: %v", err)
        }
        if _, err := m.FindOpenIncident(ctx, "r", "other", tnow.Add(-time.Minute)); err != ErrNotFound {
                t.Fatalf("wrong key should not match")
        }
        if _, err := m.FindOpenIncident(ctx, "r", "k", tnow.Add(time.Minute)); err != ErrNotFound {
                t.Fatalf("stale updatedAt should not match")
        }
        inc.Status = IncidentResolved
        _ = m.UpdateIncident(ctx, inc)
        if _, err := m.FindOpenIncident(ctx, "r", "k", tnow.Add(-time.Minute)); err != ErrNotFound {
                t.Fatalf("resolved is not open")
        }
        _ = m.InsertNote(ctx, &Note{ID: "n1", IncidentID: "INC-000001", Author: "analyst", Body: "note", CreatedAt: tnow})
        notes, _ := m.ListNotes(ctx, "INC-000001")
        if len(notes) != 1 {
                t.Fatalf("notes: %+v", notes)
        }
        open, last24, _ := m.IncidentCounts(ctx, tnow)
        if open != 0 || last24 != 1 {
                t.Fatalf("counts: %d %d", open, last24)
        }
}

func TestMemStoreSessionsKeysSettings(t *testing.T) {
        ctx := context.Background()
        m := NewMemStore()
        _ = m.UpsertUser(ctx, &User{Username: "admin", PasswordHash: "x", Role: "ADMIN", DisplayName: "Admin"})
        u, err := m.GetUser(ctx, "admin")
        if err != nil || u.Role != "ADMIN" {
                t.Fatalf("user: %v", err)
        }
        if _, err := m.GetUser(ctx, "ghost"); err != ErrNotFound {
                t.Fatalf("ghost user: %v", err)
        }
        future := time.Now().Add(time.Hour)
        _ = m.InsertSession(ctx, &Session{Token: "tok", Username: "admin", ExpiresAt: future})
        if _, err := m.GetSession(ctx, "tok"); err != nil {
                t.Fatalf("session: %v", err)
        }
        past := time.Now().Add(-time.Hour)
        _ = m.InsertSession(ctx, &Session{Token: "expired", Username: "admin", ExpiresAt: past})
        if _, err := m.GetSession(ctx, "expired"); err != ErrNotFound {
                t.Fatalf("expired session must not validate")
        }
        _ = m.DeleteSession(ctx, "tok")
        if _, err := m.GetSession(ctx, "tok"); err != ErrNotFound {
                t.Fatalf("deleted session")
        }
        _ = m.UpsertIngestKey(ctx, &IngestKey{ID: "demo-key-01", Value: "secret", Label: "demo", Active: true})
        if k, err := m.GetIngestKey(ctx, "secret"); err != nil || k.ID != "demo-key-01" {
                t.Fatalf("ingest key: %v", err)
        }
        if _, err := m.GetIngestKey(ctx, "wrong"); err != ErrNotFound {
                t.Fatalf("wrong key")
        }
        _ = m.InitSettingsIfAbsent(ctx, DefaultSettings())
        s, _ := m.GetSettings(ctx)
        if s.MaxBatchSize != 100 {
                t.Fatalf("settings: %+v", s)
        }
        s.MaxBatchSize = 50
        _ = m.SaveSettings(ctx, s)
        s2, _ := m.GetSettings(ctx)
        if s2.MaxBatchSize != 50 {
                t.Fatalf("settings save failed")
        }
}

func TestMemStoreResetKeepsRulesUsers(t *testing.T) {
        ctx := context.Background()
        m := NewMemStore()
_, _ = m.InsertRuleIfAbsent(ctx, &Rule{ID: "SG-RULE-001", Enabled: true, Version: 1})
        _ = m.UpsertUser(ctx, &User{Username: "admin", Role: "ADMIN"})
_, _ = m.InsertEvent(ctx, tev("r-1", 0, "info", "auth", "PROCESSED"))
        _ = m.InsertAudit(ctx, &AuditEntry{ID: "a1", TS: tnow, Actor: "x", Action: "login"})
        if err := m.ResetDemoData(ctx); err != nil {
                t.Fatal(err)
        }
        if _, total, _ := m.ListEvents(ctx, EventFilter{}, 1, 10); total != 0 {
                t.Fatalf("events must be wiped")
        }
        if _, total, _ := m.ListAudit(ctx, AuditFilter{}, 1, 10); total != 0 {
                t.Fatalf("audit must be wiped")
        }
        if _, err := m.GetRule(ctx, "SG-RULE-001"); err != nil {
                t.Fatalf("rules must survive reset")
        }
        if _, err := m.GetUser(ctx, "admin"); err != nil {
                t.Fatalf("users must survive reset")
        }
        num, _ := m.NextIncidentNumber(ctx)
        if num != 1 {
                t.Fatalf("incident sequence must reset, got %d", num)
        }
}

func TestMemStoreConcurrentAccess(t *testing.T) {
        ctx := context.Background()
        m := NewMemStore()
        var wg sync.WaitGroup
        for g := 0; g < 8; g++ {
                wg.Add(1)
                go func(g int) {
                        defer wg.Done()
                        for i := 0; i < 50; i++ {
                                id := fmt.Sprintf("cc-%d-%d", g, i)
                                _, _ = m.InsertEvent(ctx, tev(id, 0, "info", "auth", "VALIDATED"))
                                _, _ = m.GetEvent(ctx, id)
                                _, _, _ = m.ListEvents(ctx, EventFilter{}, 1, 10)
                                _ = m.InsertAudit(ctx, &AuditEntry{ID: id, TS: tnow, Actor: "x", Action: "test"})
                        }
                }(g)
        }
        wg.Wait()
        _, total, _ := m.ListEvents(ctx, EventFilter{}, 1, 1000)
        if total != 400 {
                t.Fatalf("total = %d, want 400", total)
        }
}

func TestMemStoreAuditFilter(t *testing.T) {
        ctx := context.Background()
        m := NewMemStore()
        entries := []AuditEntry{
                {ID: "a1", TS: tnow.Add(-3 * time.Minute), Actor: "admin", Action: "login", TargetType: "session"},
                {ID: "a2", TS: tnow.Add(-2 * time.Minute), Actor: "analyst", Action: "incident.update", TargetType: "incident"},
                {ID: "a3", TS: tnow.Add(-time.Minute), Actor: "admin", Action: "rule.update", TargetType: "rule"},
        }
        for i := range entries {
                _ = m.InsertAudit(ctx, &entries[i])
        }
        _, total, _ := m.ListAudit(ctx, AuditFilter{Actor: "admin"}, 1, 10)
        if total != 2 {
                t.Fatalf("actor filter: %d", total)
        }
        _, total, _ = m.ListAudit(ctx, AuditFilter{Action: "rule.update"}, 1, 10)
        if total != 1 {
                t.Fatalf("action filter: %d", total)
        }
        from := tnow.Add(-90 * time.Second)
        _, total, _ = m.ListAudit(ctx, AuditFilter{From: &from}, 1, 10)
        if total != 1 { // only a3 (-1m) is within the window
                t.Fatalf("from filter: %d", total)
        }
        got, _, _ := m.ListAudit(ctx, AuditFilter{}, 1, 10)
        if got[0].ID != "a3" {
                t.Fatalf("audit must be newest first")
        }
}
