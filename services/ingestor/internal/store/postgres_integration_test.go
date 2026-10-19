// Copyright © 2026 Parsa Fathi — Apache-2.0

//go:build integration

// Postgres integration tests. Run with:
//
//      go test -tags integration ./internal/store/ -run TestPostgres -v
//
// They SKIP unless POSTGRES_DSN is set (CI provides a real PostgreSQL).
package store

import (
        "context"
        "fmt"
        "os"
        "testing"
        "time"

        "github.com/ParsaFathii/StreamGuard/services/ingestor/internal/event"
)

func pgStore(t *testing.T) *PostgresStore {
        t.Helper()
        dsn := os.Getenv("POSTGRES_DSN")
        if dsn == "" {
                t.Skip("POSTGRES_DSN not set; skipping postgres integration test")
        }
        st, err := NewPostgresStore(context.Background(), dsn)
        if err != nil {
                t.Fatalf("NewPostgresStore: %v", err)
        }
        t.Cleanup(func() {
                ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
                defer cancel()
                _ = st.ResetDemoData(ctx)
                _ = st.Close()
        })
        if err := st.ResetDemoData(context.Background()); err != nil {
                t.Fatalf("reset: %v", err)
        }
        return st
}

func mkEv(id string, ts time.Time) *event.Event {
        return &event.Event{
                EventID: id, SchemaVersion: 1, EventTime: ts, IngestTime: ts,
                SourceType: "app", SourceID: "src-" + id, Severity: "info", Category: "system",
                Message: "integration event " + id, Origin: "synthetic", Status: "VALIDATED",
                Attributes: map[string]any{"action": "login_failed", "n": 7},
        }
}

// TestPostgresEventCRUD exercises the event surface: insert/duplicate/get/
// process/list/filter/paginate/query/aggregates/retention.
func TestPostgresEventCRUD(t *testing.T) {
        st := pgStore(t)
        ctx := context.Background()
        now := time.Now().UTC().Truncate(time.Microsecond)

        for i := 0; i < 12; i++ {
                e := mkEv(fmt.Sprintf("pg-e-%02d", i), now.Add(-time.Duration(i)*time.Minute))
                if i%3 == 0 {
                        e.Severity = "high"
                        e.Category = "auth"
                        e.Actor = "actor-a"
                }
                inserted, err := st.InsertEvent(ctx, e)
                if err != nil || !inserted {
                        t.Fatalf("insert %d: inserted=%v err=%v", i, inserted, err)
                }
        }
        // duplicate
        inserted, err := st.InsertEvent(ctx, mkEv("pg-e-00", now))
        if err != nil || inserted {
                t.Fatalf("duplicate insert must be a no-op: inserted=%v err=%v", inserted, err)
        }
        // get
        got, err := st.GetEvent(ctx, "pg-e-00")
        if err != nil || got.Message == "" {
                t.Fatalf("get: %v", err)
        }
        if got.Attributes["action"] != "login_failed" {
                t.Fatalf("attributes must round-trip: %+v", got.Attributes)
        }
        if _, err := st.GetEvent(ctx, "missing"); err != ErrNotFound {
                t.Fatalf("want ErrNotFound, got %v", err)
        }
        // process + latency
        if err := st.SetEventProcessed(ctx, "pg-e-00", 12, now); err != nil {
                t.Fatalf("processed: %v", err)
        }
        // list + filters + pagination
        evs, total, err := st.ListEvents(ctx, EventFilter{Severities: []string{"high"}}, 1, 5)
        if err != nil || total != 4 || len(evs) != 4 {
                t.Fatalf("list high: total=%d len=%d err=%v", total, len(evs), err)
        }
        evs, total, err = st.ListEvents(ctx, EventFilter{Q: "integration"}, 2, 3)
        if err != nil || total != 12 || len(evs) != 3 {
                t.Fatalf("list q page2: total=%d len=%d err=%v", total, len(evs), err)
        }
        from := now.Add(-5 * time.Minute)
        to := now
        evs, total, err = st.ListEvents(ctx, EventFilter{From: &from, To: &to}, 1, 25)
        if err != nil || total != 6 || len(evs) != 6 {
                t.Fatalf("list window: total=%d err=%v", total, err)
        }
        // query (selector)
        qe, err := st.QueryEvents(ctx, EventQuery{
                Categories: []string{"auth"}, AttrKey: "action", AttrValue: "login_failed",
                Since: now.Add(-30 * time.Minute), Limit: 100,
        })
        if err != nil || len(qe) != 4 {
                t.Fatalf("query: len=%d err=%v", len(qe), err)
        }
        // aggregates
        n, err := st.CountEventsSince(ctx, now.Add(-30*time.Minute))
        if err != nil || n != 12 {
                t.Fatalf("count since: %d err=%v", n, err)
        }
        sev, err := st.SeverityBreakdownSince(ctx, now.Add(-30*time.Minute))
        if err != nil || sev["high"] != 4 || sev["info"] != 8 {
                t.Fatalf("severity breakdown: %+v err=%v", sev, err)
        }
        mc, err := st.MinuteCounts(ctx, "events", now.Add(-30*time.Minute))
        if err != nil || len(mc) != 12 {
                t.Fatalf("minute counts: len=%d err=%v", len(mc), err)
        }
        avg, p95, last, err := st.LatencyStatsSince(ctx, now.Add(-30*time.Minute))
        if err != nil || avg != 12 || p95 != 12 || last.IsZero() {
                t.Fatalf("latency: avg=%v p95=%v last=%v err=%v", avg, p95, last, err)
        }
        // sources derived from real events
        srcs, err := st.SourcesSince(ctx, now.Add(-30*time.Minute))
        if err != nil || len(srcs) != 12 {
                t.Fatalf("sources: len=%d err=%v", len(srcs), err)
        }
        // delete
        deleted, err := st.DeleteEvents(ctx, []string{"pg-e-00", "pg-e-01"})
        if err != nil || deleted != 2 {
                t.Fatalf("delete: n=%d err=%v", deleted, err)
        }
}

// TestPostgresRulesDetectionsIncidents exercises rules, rule audit,
// detections, correlation-relevant incident lookups and attachments.
func TestPostgresRulesDetectionsIncidents(t *testing.T) {
        st := pgStore(t)
        ctx := context.Background()

        // rules
        r := Rule{ID: "SG-RULE-001", Name: "Repeated Authentication Failures", Enabled: true,
                Selector:  RuleSelector{Category: "auth", Attribute: &AttrKV{Key: "action", Value: "login_failed"}},
                Condition: RuleCondition{Type: "count", Threshold: 5, WindowSeconds: 120, Metric: "actor"},
                Severity:  "high", CooldownSeconds: 300, Suppression: true, Version: 1, UpdatedAt: time.Now().UTC()}
        ins, err := st.InsertRuleIfAbsent(ctx, &r)
        if err != nil || !ins {
                t.Fatalf("insert rule: ins=%v err=%v", ins, err)
        }
        ins, err = st.InsertRuleIfAbsent(ctx, &r)
        if err != nil || ins {
                t.Fatalf("re-insert must be no-op: ins=%v err=%v", ins, err)
        }
        r2, err := st.GetRule(ctx, "SG-RULE-001")
        if err != nil || r2.Selector.Attribute.Value != "login_failed" || r2.Condition.Threshold != 5 {
                t.Fatalf("get rule: %+v err=%v", r2, err)
        }
        r.Version++
        if err := st.UpdateRule(ctx, &r); err != nil {
                t.Fatalf("update rule: %v", err)
        }
        if err := st.InsertRuleAudit(ctx, &RuleAudit{ID: "RA-1", TS: time.Now().UTC(), RuleID: "SG-RULE-001",
                Actor: "admin", Changes: map[string]any{"version": 2}}); err != nil {
                t.Fatalf("rule audit: %v", err)
        }
        aud, err := st.ListRuleAudit(ctx, "SG-RULE-001", 10)
        if err != nil || len(aud) != 1 || aud[0].Changes["version"] != float64(2) {
                t.Fatalf("list rule audit: %+v err=%v", aud, err)
        }

        // detections
        now := time.Now().UTC().Truncate(time.Microsecond)
        det := Detection{ID: "DET-1", RuleID: "SG-RULE-001", CorrelationKey: "actor-a", Severity: "high",
                Score: 0.9, Title: "Repeated Authentication Failures", Status: DetectionActive, CreatedAt: now,
                EventID: "pg-e-00",
                Detail:  DetectionDetail{MatchedCount: 5, WindowSeconds: 120, Actor: "actor-a", SampleEventIDs: []string{"a", "b"}}}
        if err := st.InsertDetection(ctx, &det); err != nil {
                t.Fatalf("insert detection: %v", err)
        }
        dets, total, err := st.ListDetections(ctx, DetectionFilter{RuleID: "SG-RULE-001"}, 1, 10)
        if err != nil || total != 1 || dets[0].Detail.Actor != "actor-a" || len(dets[0].Detail.SampleEventIDs) != 2 {
                t.Fatalf("list detections: %+v err=%v", dets, err)
        }
        byRule, err := st.DetectionCountsByRuleSince(ctx, now.Add(-time.Minute))
        if err != nil || byRule["SG-RULE-001"] != 1 {
                t.Fatalf("detection counts: %+v err=%v", byRule, err)
        }
        lastKey, err := st.LastDetectionAtByRuleKey(ctx, "SG-RULE-001")
        if err != nil || lastKey["actor-a"].IsZero() {
                t.Fatalf("last detection by key: %+v err=%v", lastKey, err)
        }

        // incidents
        num, err := st.NextIncidentNumber(ctx)
        if err != nil || num != 1 {
                t.Fatalf("next incident number: %d err=%v", num, err)
        }
        inc := Incident{ID: "INC-000001", Title: "Repeated Authentication Failures — actor: actor-a",
                Severity: "high", Status: IncidentNew, RuleID: "SG-RULE-001", CorrelationKey: "actor-a",
                CorrelationLabel: "actor: actor-a", EventCount: 5, DetectionCount: 1,
                FirstEventTime: now.Add(-2 * time.Minute), LastEventTime: now,
                CreatedAt: now, UpdatedAt: now,
                StatusHistory: []StatusHistoryEntry{{FromStatus: "", ToStatus: IncidentNew, Actor: "system", TS: now}}}
        if err := st.InsertIncident(ctx, &inc); err != nil {
                t.Fatalf("insert incident: %v", err)
        }
        if err := st.InsertIncident(ctx, &inc); err == nil {
                t.Fatalf("duplicate incident must fail")
        }
        got, err := st.GetIncident(ctx, "INC-000001")
        if err != nil || len(got.StatusHistory) != 1 || got.FirstEventTime.IsZero() || got.StatusHistory[0].Actor != "system" {
                t.Fatalf("get incident: %+v err=%v", got, err)
        }
        found, err := st.FindOpenIncident(ctx, "SG-RULE-001", "actor-a", now.Add(-10*time.Minute))
        if err != nil || found.ID != "INC-000001" {
                t.Fatalf("find open: %+v err=%v", found, err)
        }
        // attach events (needs real events)
        for i := 0; i < 3; i++ {
                if _, err := st.InsertEvent(ctx, mkEv(fmt.Sprintf("pg-inc-%02d", i), now)); err != nil {
                        t.Fatalf("insert event: %v", err)
                }
        }
        n, err := st.AttachIncidentEvents(ctx, "INC-000001", []IncidentEvent{
                {IncidentID: "INC-000001", EventID: "pg-inc-00", Late: false},
                {IncidentID: "INC-000001", EventID: "pg-inc-01", Late: true},
        })
        if err != nil || n != 2 {
                t.Fatalf("attach: n=%d err=%v", n, err)
        }
        n, err = st.AttachIncidentEvents(ctx, "INC-000001", []IncidentEvent{
                {IncidentID: "INC-000001", EventID: "pg-inc-00"},
                {IncidentID: "INC-000001", EventID: "pg-inc-02"},
        })
        if err != nil || n != 1 {
                t.Fatalf("attach idempotent: n=%d err=%v", n, err)
        }
        views, total, err := st.IncidentEvents(ctx, "INC-000001", 1, 10)
        if err != nil || total != 3 || !views[1].Late {
                t.Fatalf("incident events: total=%d err=%v", total, err)
        }
        // list incidents + filter + sort
        inc2 := inc
        inc2.ID = "INC-000002"
        inc2.Severity = "medium"
        inc2.CorrelationKey = "actor-b"
        if _, err := st.NextIncidentNumber(ctx); err != nil {
                t.Fatal(err)
        }
        if err := st.InsertIncident(ctx, &inc2); err != nil {
                t.Fatal(err)
        }
        incs, total, err := st.ListIncidents(ctx, IncidentFilter{Severity: "high"}, "createdAt", 1, 10)
        if err != nil || total != 1 || len(incs) != 1 {
                t.Fatalf("list incidents: total=%d err=%v", total, err)
        }
        incs, _, err = st.ListIncidents(ctx, IncidentFilter{}, "severity", 1, 10)
        if err != nil || incs[0].ID != "INC-000001" {
                t.Fatalf("sort by severity: %+v err=%v", incs, err)
        }
        openCnt, last24c, err := st.IncidentCounts(ctx, now)
        if err != nil || openCnt != 2 || last24c != 2 {
                t.Fatalf("incident counts: open=%d last24=%d err=%v", openCnt, last24c, err)
        }
        if err := st.SetDetectionIncident(ctx, "DET-1", "INC-000001"); err != nil {
                t.Fatalf("link detection: %v", err)
        }
        dets, _, _ = st.ListDetections(ctx, DetectionFilter{IncidentID: "INC-000001"}, 1, 10)
        if len(dets) != 1 {
                t.Fatalf("detection link lost: %+v", dets)
        }

        // lifecycle update
        got.Status = IncidentResolved
        got.ResolvedAt = now
        got.ResolutionSummary = "blocked the actor"
        got.StatusHistory = append(got.StatusHistory, StatusHistoryEntry{FromStatus: IncidentNew, ToStatus: IncidentResolved, Actor: "admin", TS: now})
        if err := st.UpdateIncident(ctx, got); err != nil {
                t.Fatalf("update incident: %v", err)
        }
        got, _ = st.GetIncident(ctx, "INC-000001")
        if got.Status != IncidentResolved || got.ResolvedAt.IsZero() || len(got.StatusHistory) != 2 {
                t.Fatalf("resolved round-trip: %+v", got)
        }
        if _, err := st.FindOpenIncident(ctx, "SG-RULE-001", "actor-a", now.Add(-10*time.Minute)); err != ErrNotFound {
                t.Fatalf("resolved incident must not be found open: %v", err)
        }

        // notes + ai reports
        if err := st.InsertNote(ctx, &Note{ID: "N-1", IncidentID: "INC-000001", Author: "admin", Body: "note", CreatedAt: now}); err != nil {
                t.Fatal(err)
        }
        notes, err := st.ListNotes(ctx, "INC-000001")
        if err != nil || len(notes) != 1 {
                t.Fatalf("notes: %+v err=%v", notes, err)
        }
        if err := st.InsertAIReport(ctx, &AIReport{ID: "AI-1", IncidentID: "INC-000001", ProviderStatus: "ok", TS: now, Report: []byte(`{"summary":"s"}`)}); err != nil {
                t.Fatal(err)
        }
        reports, err := st.ListAIReports(ctx, "INC-000001")
        if err != nil || len(reports) != 1 || string(reports[0].Report) != `{"summary":"s"}` {
                t.Fatalf("ai reports: %+v err=%v", reports, err)
        }
}

// TestPostgresUsersSessionsKeysSettingsAuditMl exercises the remaining
// surfaces plus the retention protection rule.
func TestPostgresUsersSessionsKeysSettingsAuditMl(t *testing.T) {
        st := pgStore(t)
        ctx := context.Background()

        // users
        if err := st.UpsertUser(ctx, &User{Username: "admin", PasswordHash: "h", Role: "ADMIN", DisplayName: "A"}); err != nil {
                t.Fatal(err)
        }
        u, err := st.GetUser(ctx, "admin")
        if err != nil || u.Role != "ADMIN" {
                t.Fatalf("get user: %+v err=%v", u, err)
        }
        if _, err := st.GetUser(ctx, "ghost"); err != ErrNotFound {
                t.Fatalf("want ErrNotFound, got %v", err)
        }
        // sessions
        sess := Session{Token: "tok-1", Username: "admin", ExpiresAt: time.Now().UTC().Add(time.Hour)}
        if err := st.InsertSession(ctx, &sess); err != nil {
                t.Fatal(err)
        }
        got, err := st.GetSession(ctx, "tok-1")
        if err != nil || got.Username != "admin" {
                t.Fatalf("get session: %+v err=%v", got, err)
        }
        expired := Session{Token: "tok-2", Username: "admin", ExpiresAt: time.Now().UTC().Add(-time.Hour)}
        _ = st.InsertSession(ctx, &expired)
        if _, err := st.GetSession(ctx, "tok-2"); err != ErrNotFound {
                t.Fatalf("expired session must be missing: %v", err)
        }
        if err := st.DeleteSession(ctx, "tok-1"); err != nil {
                t.Fatal(err)
        }
        if _, err := st.GetSession(ctx, "tok-1"); err != ErrNotFound {
                t.Fatalf("deleted session must be missing: %v", err)
        }
        // ingest keys
        if err := st.UpsertIngestKey(ctx, &IngestKey{ID: "demo-key-01", Value: "k-1", Label: "demo", Active: true}); err != nil {
                t.Fatal(err)
        }
        k, err := st.GetIngestKey(ctx, "k-1")
        if err != nil || k.ID != "demo-key-01" {
                t.Fatalf("get key: %+v err=%v", k, err)
        }
        if _, err := st.GetIngestKey(ctx, "nope"); err != ErrNotFound {
                t.Fatalf("unknown key: %v", err)
        }
        // settings
        if err := st.InitSettingsIfAbsent(ctx, Settings{AIEnabled: true, AIProvider: "ollama", CorrelationWindowSeconds: 600,
                RetentionHours: 72, MaxBatchSize: 100, RateLimitPerMin: 60, LanguageDefault: "en"}); err != nil {
                t.Fatal(err)
        }
        s, err := st.GetSettings(ctx)
        if err != nil || !s.AIEnabled || s.RateLimitPerMin != 60 {
                t.Fatalf("settings: %+v err=%v", s, err)
        }
        s.RateLimitPerMin = 120
        if err := st.SaveSettings(ctx, s); err != nil {
                t.Fatal(err)
        }
        s, _ = st.GetSettings(ctx)
        if s.RateLimitPerMin != 120 {
                t.Fatalf("settings save lost: %+v", s)
        }
        // audit
        if err := st.InsertAudit(ctx, &AuditEntry{ID: "AUD-1", TS: time.Now().UTC(), Actor: "admin", Role: "ADMIN",
                Action: "login", TargetType: "session", TargetID: "admin", Details: map[string]any{"ok": true}}); err != nil {
                t.Fatal(err)
        }
        entries, total, err := st.ListAudit(ctx, AuditFilter{Action: "login"}, 1, 10)
        if err != nil || total != 1 || entries[0].Details["ok"] != true {
                t.Fatalf("audit: %+v err=%v", entries, err)
        }
        // ml runs
        run := MlRun{TS: time.Now().UTC(), Seed: 42, DatasetSize: 10, Methods: map[string]MlMethodMetrics{
                "iforest": {Precision: 1, Recall: 0.5, F1: 0.66, FPR: 0, TP: 5, FP: 0, TN: 5, FN: 5},
        }}
        run.DatasetInfo.Label = "labeled"
        run.DatasetInfo.Anomalies = 5
        run.DatasetInfo.Normal = 5
        if err := st.SaveMlRun(ctx, &run); err != nil {
                t.Fatal(err)
        }
        last, err := st.LastMlRun(ctx)
        if err != nil || last.Seed != 42 || last.Methods["iforest"].TP != 5 || last.DatasetInfo.Anomalies != 5 {
                t.Fatalf("ml run: %+v err=%v", last, err)
        }

        // validation failures
        if err := st.InsertValidationFailure(ctx, &ValidationFailure{ID: "VF-1", TS: time.Now().UTC(), Reason: "BAD_SEVERITY", Detail: "boom"}); err != nil {
                t.Fatal(err)
        }
        vfs, err := st.ListValidationFailuresSince(ctx, time.Now().UTC().Add(-time.Minute), 10)
        if err != nil || len(vfs) != 1 || vfs[0].Reason != "BAD_SEVERITY" {
                t.Fatalf("validation failures: %+v err=%v", vfs, err)
        }

        // retention: events attached to non-CLOSED incidents are protected
        now := time.Now().UTC()
        old := now.Add(-48 * time.Hour)
        for i := 0; i < 4; i++ {
                e := mkEv(fmt.Sprintf("pg-ret-%02d", i), old)
                e.SourceID = "ret-src"
                if _, err := st.InsertEvent(ctx, e); err != nil {
                        t.Fatal(err)
                }
        }
        num, _ := st.NextIncidentNumber(ctx)
        inc := Incident{ID: fmt.Sprintf("INC-%06d", num), Title: "ret", Severity: "low", Status: IncidentNew,
                RuleID: "SG-RULE-001", CorrelationKey: "k", CreatedAt: old, UpdatedAt: old}
        if err := st.InsertIncident(ctx, &inc); err != nil {
                t.Fatal(err)
        }
        if _, err := st.AttachIncidentEvents(ctx, inc.ID, []IncidentEvent{{IncidentID: inc.ID, EventID: "pg-ret-00"}}); err != nil {
                t.Fatal(err)
        }
        n, err := st.DeleteEventsBefore(ctx, now.Add(-24*time.Hour))
        if err != nil || n != 3 {
                t.Fatalf("retention: deleted=%d want 3 (protected event kept) err=%v", n, err)
        }
        if _, err := st.GetEvent(ctx, "pg-ret-00"); err != nil {
                t.Fatalf("protected event must survive: %v", err)
        }
        if _, err := st.GetEvent(ctx, "pg-ret-01"); err != ErrNotFound {
                t.Fatalf("unprotected event must be gone: %v", err)
        }
        // close the incident -> protection lifts
        inc.Status = IncidentClosed
        inc.ClosedAt = now
        if err := st.UpdateIncident(ctx, &inc); err != nil {
                t.Fatal(err)
        }
        n, err = st.DeleteEventsBefore(ctx, now.Add(-24*time.Hour))
        if err != nil || n != 1 {
                t.Fatalf("retention after close: deleted=%d want 1 err=%v", n, err)
        }

        // reset keeps rules/users/settings
        if err := st.UpsertUser(ctx, &User{Username: "u1", PasswordHash: "h", Role: "VIEWER", DisplayName: "V"}); err != nil {
                t.Fatal(err)
        }
        if err := st.ResetDemoData(ctx); err != nil {
                t.Fatalf("reset: %v", err)
        }
        if _, err := st.GetUser(ctx, "u1"); err != nil {
                t.Fatalf("reset must keep users: %v", err)
        }
        if _, err := st.GetEvent(ctx, "pg-ret-00"); err != ErrNotFound {
                t.Fatalf("reset must wipe events: %v", err)
        }
}
