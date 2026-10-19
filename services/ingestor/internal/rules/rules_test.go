// Copyright © 2026 Parsa Fathii — Apache-2.0

package rules

import (
        "context"
        "fmt"
        "testing"
        "time"

        "github.com/ParsaFathii/StreamGuard/services/ingestor/internal/event"
        "github.com/ParsaFathii/StreamGuard/services/ingestor/internal/store"
)

var testNow = time.Date(2026, 3, 1, 10, 0, 0, 0, time.UTC)

func newEngine(t *testing.T) (*Engine, store.Store) {
        t.Helper()
        st := store.NewMemStore()
        if err := SeedDefaults(context.Background(), st); err != nil {
                t.Fatalf("seed: %v", err)
        }
        return NewEngine(st, func() time.Time { return testNow }), st
}

func mkEvent(id, srcType, srcID, sev, cat, msg, actor string, attrs map[string]any, ts time.Time) event.Event {
        return event.Event{
                EventID: id, SchemaVersion: 1, EventTime: ts, IngestTime: testNow,
                SourceType: srcType, SourceID: srcID, Severity: sev, Category: cat,
                Message: msg, Actor: actor, Attributes: attrs, Origin: "synthetic",
        }
}

func loginFailed(id, actor string, ts time.Time) event.Event {
        return mkEvent(id, "app", "prod-app-1", "low", "auth", "login failed", actor,
                map[string]any{"action": "login_failed"}, ts)
}

func insertAll(t *testing.T, st store.Store, evs []event.Event) {
        t.Helper()
        for i := range evs {
                if _, err := st.InsertEvent(context.Background(), &evs[i]); err != nil {
                        t.Fatalf("insert %s: %v", evs[i].EventID, err)
                }
        }
}

func ruleIDs(res []Result) []string {
        out := make([]string, 0, len(res))
        for _, r := range res {
                out = append(out, r.Detection.RuleID)
        }
        return out
}

func hasRule(res []Result, id string) bool {
        for _, r := range res {
                if r.Detection.RuleID == id {
                        return true
                }
        }
        return false
}

// TestRuleTable drives every rule with its synthetic attack scenario and
// with normal traffic. Each rule must fire on its scenario and stay silent
// on normal traffic.
func TestRuleTable(t *testing.T) {
        t.Run("SG-RULE-001 brute force", func(t *testing.T) {
                eng, st := newEngine(t)
                var evs []event.Event
                for i := 0; i < 5; i++ {
                        evs = append(evs, loginFailed(fmt.Sprintf("bf-%d", i), "alice", testNow.Add(-time.Duration(i)*time.Second)))
                }
                insertAll(t, st, evs)
                res, err := eng.EvaluateBatch(context.Background(), evs)
                if err != nil {
                        t.Fatalf("eval: %v", err)
                }
                if !hasRule(res, "SG-RULE-001") {
                        t.Fatalf("expected SG-RULE-001 to fire, got %v", ruleIDs(res))
                }
                for _, r := range res {
                        if r.Detection.RuleID == "SG-RULE-001" {
                                if r.Detection.CorrelationKey != "alice" || r.Detection.Detail.MatchedCount != 5 {
                                        t.Fatalf("bad detection detail: %+v", r.Detection)
                                }
                                if r.Detection.Severity != "high" || r.Detection.Status != "ACTIVE" {
                                        t.Fatalf("bad detection: %+v", r.Detection)
                                }
                                if r.Detection.Score < 0.5 || r.Detection.Score > 1 {
                                        t.Fatalf("score out of range: %f", r.Detection.Score)
                                }
                        }
                }
        })

        t.Run("SG-RULE-001 below threshold", func(t *testing.T) {
                eng, st := newEngine(t)
                var evs []event.Event
                for i := 0; i < 4; i++ {
                        evs = append(evs, loginFailed(fmt.Sprintf("b4-%d", i), "bob", testNow.Add(-time.Duration(i)*time.Second)))
                }
                insertAll(t, st, evs)
                res, _ := eng.EvaluateBatch(context.Background(), evs)
                if hasRule(res, "SG-RULE-001") {
                        t.Fatalf("SG-RULE-001 must not fire on 4 failures")
                }
        })

        t.Run("SG-RULE-001 normal logins", func(t *testing.T) {
                eng, st := newEngine(t)
                evs := []event.Event{
                        loginFailed("n1", "carol", testNow.Add(-time.Minute)),
                        mkEvent("n2", "app", "prod-app-1", "info", "auth", "login ok", "carol", map[string]any{"action": "login_success"}, testNow),
                        mkEvent("n3", "app", "prod-app-1", "info", "auth", "logout", "carol", map[string]any{"action": "logout"}, testNow),
                }
                insertAll(t, st, evs)
                res, _ := eng.EvaluateBatch(context.Background(), evs)
                if hasRule(res, "SG-RULE-001") {
                        t.Fatalf("SG-RULE-001 must not fire on normal traffic")
                }
        })

        t.Run("SG-RULE-002 traffic burst", func(t *testing.T) {
                eng, st := newEngine(t)
                var evs []event.Event
                for i := 0; i < 121; i++ {
                        evs = append(evs, mkEvent(fmt.Sprintf("req-%d", i), "app", "prod-web-1", "info", "network", "GET /api",
                                "", map[string]any{"kind": "request"}, testNow.Add(-time.Duration(i%50)*time.Second)))
                }
                insertAll(t, st, evs)
                res, _ := eng.EvaluateBatch(context.Background(), evs)
                if !hasRule(res, "SG-RULE-002") {
                        t.Fatalf("expected SG-RULE-002 with 121 requests, got %v", ruleIDs(res))
                }
        })

        t.Run("SG-RULE-002 exactly 120 must not fire", func(t *testing.T) {
                eng, st := newEngine(t)
                var evs []event.Event
                for i := 0; i < 120; i++ {
                        evs = append(evs, mkEvent(fmt.Sprintf("req120-%d", i), "app", "prod-web-2", "info", "network", "GET /api",
                                "", map[string]any{"kind": "request"}, testNow.Add(-time.Duration(i%50)*time.Second)))
                }
                insertAll(t, st, evs)
                res, _ := eng.EvaluateBatch(context.Background(), evs)
                if hasRule(res, "SG-RULE-002") {
                        t.Fatalf("SG-RULE-002 must not fire at exactly 120 (>120 required)")
                }
        })

        t.Run("SG-RULE-003 suspicious sequence", func(t *testing.T) {
                eng, st := newEngine(t)
                evs := []event.Event{
                        loginFailed("s1", "dave", testNow.Add(-4*time.Minute)),
                        loginFailed("s2", "dave", testNow.Add(-3*time.Minute)),
                        loginFailed("s3", "dave", testNow.Add(-2*time.Minute)),
                        mkEvent("s4", "app", "prod-app-1", "info", "auth", "login ok", "dave", map[string]any{"action": "login_success"}, testNow.Add(-time.Minute)),
                }
                insertAll(t, st, evs)
                res, _ := eng.EvaluateBatch(context.Background(), evs)
                if !hasRule(res, "SG-RULE-003") {
                        t.Fatalf("expected SG-RULE-003, got %v", ruleIDs(res))
                }
        })

        t.Run("SG-RULE-003 two failures then success must not fire", func(t *testing.T) {
                eng, st := newEngine(t)
                evs := []event.Event{
                        loginFailed("t1", "erin", testNow.Add(-3*time.Minute)),
                        loginFailed("t2", "erin", testNow.Add(-2*time.Minute)),
                        mkEvent("t3", "app", "prod-app-1", "info", "auth", "login ok", "erin", map[string]any{"action": "login_success"}, testNow.Add(-time.Minute)),
                }
                insertAll(t, st, evs)
                res, _ := eng.EvaluateBatch(context.Background(), evs)
                if hasRule(res, "SG-RULE-003") {
                        t.Fatalf("SG-RULE-003 must not fire on 2 failures")
                }
        })

        t.Run("SG-RULE-004 error storm", func(t *testing.T) {
                eng, st := newEngine(t)
                var evs []event.Event
                for i := 0; i < 25; i++ {
                        sev := "info"
                        if i < 15 { // 60% errors
                                sev = "high"
                        }
                        evs = append(evs, mkEvent(fmt.Sprintf("err-%d", i), "app", "prod-app-2", sev, "application",
                                "handler failed", "", map[string]any{"status": "500"}, testNow.Add(-time.Duration(i)*time.Second)))
                }
                insertAll(t, st, evs)
                res, _ := eng.EvaluateBatch(context.Background(), evs)
                if !hasRule(res, "SG-RULE-004") {
                        t.Fatalf("expected SG-RULE-004, got %v", ruleIDs(res))
                }
        })

        t.Run("SG-RULE-004 below min count", func(t *testing.T) {
                eng, st := newEngine(t)
                var evs []event.Event
                for i := 0; i < 19; i++ { // 19 < min 20
                        sev := "critical"
                        evs = append(evs, mkEvent(fmt.Sprintf("err19-%d", i), "app", "prod-app-3", sev, "application",
                                "boom", "", nil, testNow.Add(-time.Duration(i)*time.Second)))
                }
                insertAll(t, st, evs)
                res, _ := eng.EvaluateBatch(context.Background(), evs)
                if hasRule(res, "SG-RULE-004") {
                        t.Fatalf("SG-RULE-004 must not fire below min count")
                }
        })

        t.Run("SG-RULE-004 low error ratio", func(t *testing.T) {
                eng, st := newEngine(t)
                var evs []event.Event
                for i := 0; i < 30; i++ {
                        sev := "info"
                        if i < 5 { // ~17% < 30%
                                sev = "medium"
                        }
                        evs = append(evs, mkEvent(fmt.Sprintf("ok30-%d", i), "app", "prod-app-4", sev, "application",
                                "ok", "", nil, testNow.Add(-time.Duration(i)*time.Second)))
                }
                insertAll(t, st, evs)
                res, _ := eng.EvaluateBatch(context.Background(), evs)
                if hasRule(res, "SG-RULE-004") {
                        t.Fatalf("SG-RULE-004 must not fire at low error ratio")
                }
        })

        t.Run("SG-RULE-005 authz failures", func(t *testing.T) {
                eng, st := newEngine(t)
                evs := []event.Event{
                        mkEvent("z1", "security", "sec-01", "medium", "security", "access denied", "frank", map[string]any{"action": "access_denied"}, testNow.Add(-2*time.Minute)),
                        mkEvent("z2", "security", "sec-01", "medium", "security", "access denied", "frank", map[string]any{"action": "access_denied"}, testNow.Add(-time.Minute)),
                        mkEvent("z3", "security", "sec-01", "medium", "security", "access denied", "frank", map[string]any{"action": "access_denied"}, testNow),
                }
                insertAll(t, st, evs)
                res, _ := eng.EvaluateBatch(context.Background(), evs)
                if !hasRule(res, "SG-RULE-005") {
                        t.Fatalf("expected SG-RULE-005, got %v", ruleIDs(res))
                }
        })

        t.Run("SG-RULE-006 config change on infra", func(t *testing.T) {
                eng, st := newEngine(t)
                evs := []event.Event{
                        mkEvent("cfg-1", "infra", "db-01", "high", "config", "firewall rule changed", "ops-bot",
                                map[string]any{"action": "change"}, testNow),
                }
                insertAll(t, st, evs)
                res, _ := eng.EvaluateBatch(context.Background(), evs)
                if !hasRule(res, "SG-RULE-006") {
                        t.Fatalf("expected SG-RULE-006 on infra config change, got %v", ruleIDs(res))
                }
        })

        t.Run("SG-RULE-006 config change on prod- app source", func(t *testing.T) {
                eng, st := newEngine(t)
                evs := []event.Event{
                        mkEvent("cfg-2", "app", "prod-app-9", "high", "config", "feature flag changed", "dev",
                                map[string]any{"action": "change"}, testNow),
                }
                insertAll(t, st, evs)
                res, _ := eng.EvaluateBatch(context.Background(), evs)
                if !hasRule(res, "SG-RULE-006") {
                        t.Fatalf("expected SG-RULE-006 on prod- prefix config change, got %v", ruleIDs(res))
                }
        })

        t.Run("SG-RULE-006 must not fire on non-prod app config", func(t *testing.T) {
                eng, st := newEngine(t)
                evs := []event.Event{
                        mkEvent("cfg-3", "app", "dev-app-1", "info", "config", "dev flag changed", "dev",
                                map[string]any{"action": "change"}, testNow),
                }
                insertAll(t, st, evs)
                res, _ := eng.EvaluateBatch(context.Background(), evs)
                if hasRule(res, "SG-RULE-006") {
                        t.Fatalf("SG-RULE-006 must not fire on dev app config change")
                }
        })

        t.Run("SG-RULE-007 validation failures", func(t *testing.T) {
                eng, st := newEngine(t)
                for i := 0; i < 10; i++ {
                        vf := &store.ValidationFailure{ID: fmt.Sprintf("vf-%d", i), TS: testNow.Add(-time.Duration(i) * time.Second), Reason: "BAD_SEVERITY", Detail: "x"}
                        if err := st.InsertValidationFailure(context.Background(), vf); err != nil {
                                t.Fatal(err)
                        }
                }
                res, err := eng.EvaluateBatch(context.Background(), nil)
                if err != nil {
                        t.Fatalf("eval: %v", err)
                }
                if !hasRule(res, "SG-RULE-007") {
                        t.Fatalf("expected SG-RULE-007 with 10 validation failures, got %v", ruleIDs(res))
                }
        })

        t.Run("SG-RULE-007 below threshold", func(t *testing.T) {
                eng, st := newEngine(t)
                for i := 0; i < 9; i++ {
                        vf := &store.ValidationFailure{ID: fmt.Sprintf("vf9-%d", i), TS: testNow, Reason: "BAD_SEVERITY", Detail: "x"}
                        _ = st.InsertValidationFailure(context.Background(), vf)
                }
                res, _ := eng.EvaluateBatch(context.Background(), nil)
                if hasRule(res, "SG-RULE-007") {
                        t.Fatalf("SG-RULE-007 must not fire below 10 failures")
                }
        })
}

func TestCooldownSuppression(t *testing.T) {
        eng, st := newEngine(t)
        var evs []event.Event
        for i := 0; i < 5; i++ {
                evs = append(evs, loginFailed(fmt.Sprintf("cd-%d", i), "grace", testNow))
        }
        insertAll(t, st, evs)
        res1, _ := eng.EvaluateBatch(context.Background(), evs)
        if !hasRule(res1, "SG-RULE-001") {
                t.Fatalf("first eval must fire")
        }
        // Same actor fires again within 300s cooldown -> suppressed.
        res2, _ := eng.EvaluateBatch(context.Background(), evs)
        if hasRule(res2, "SG-RULE-001") {
                t.Fatalf("cooldown must suppress second firing for same key")
        }
        if got := eng.SuppressionCounts()["SG-RULE-001|grace"]; got != 1 {
                t.Fatalf("suppression count = %d, want 1", got)
        }
        // Different actor -> fires (different correlation key).
        var evs2 []event.Event
        for i := 0; i < 5; i++ {
                evs2 = append(evs2, loginFailed(fmt.Sprintf("cd2-%d", i), "heidi", testNow))
        }
        insertAll(t, st, evs2)
        res3, _ := eng.EvaluateBatch(context.Background(), evs2)
        if !hasRule(res3, "SG-RULE-001") {
                t.Fatalf("different key must fire")
        }
}

func TestDisabledRuleDoesNotFire(t *testing.T) {
        eng, st := newEngine(t)
        r, err := st.GetRule(context.Background(), "SG-RULE-001")
        if err != nil {
                t.Fatal(err)
        }
        r.Enabled = false
        if err := st.UpdateRule(context.Background(), r); err != nil {
                t.Fatal(err)
        }
        var evs []event.Event
        for i := 0; i < 6; i++ {
                evs = append(evs, loginFailed(fmt.Sprintf("dis-%d", i), "ivan", testNow))
        }
        insertAll(t, st, evs)
        res, _ := eng.EvaluateBatch(context.Background(), evs)
        if hasRule(res, "SG-RULE-001") {
                t.Fatalf("disabled rule must not fire")
        }
}

func TestSeedDoesNotClobberEdits(t *testing.T) {
        st := store.NewMemStore()
        if err := SeedDefaults(context.Background(), st); err != nil {
                t.Fatal(err)
        }
        r, _ := st.GetRule(context.Background(), "SG-RULE-001")
        r.Condition.Threshold = 50
        r.Version = 2
        if err := st.UpdateRule(context.Background(), r); err != nil {
                t.Fatal(err)
        }
        // Re-seeding (e.g. process restart) must not reset the edit.
        if err := SeedDefaults(context.Background(), st); err != nil {
                t.Fatal(err)
        }
        r2, _ := st.GetRule(context.Background(), "SG-RULE-001")
        if r2.Condition.Threshold != 50 || r2.Version != 2 {
                t.Fatalf("re-seed clobbered edit: threshold=%v version=%d", r2.Condition.Threshold, r2.Version)
        }
}

func TestCleanBaselineNoRulesFire(t *testing.T) {
        eng, st := newEngine(t)
        var evs []event.Event
        for i := 0; i < 40; i++ {
                ts := testNow.Add(-time.Duration(i) * time.Second)
                switch i % 4 {
                case 0:
                        evs = append(evs, mkEvent(fmt.Sprintf("cb-%d", i), "app", "prod-app-1", "info", "auth", "login ok", "user-a", map[string]any{"action": "login_success"}, ts))
                case 1:
                        evs = append(evs, mkEvent(fmt.Sprintf("cb-%d", i), "app", "prod-web-1", "info", "network", "GET /api", "", map[string]any{"kind": "request"}, ts))
                case 2:
                        evs = append(evs, mkEvent(fmt.Sprintf("cb-%d", i), "app", "prod-app-1", "info", "application", "ok", "", map[string]any{"status": "200"}, ts))
                default:
                        evs = append(evs, mkEvent(fmt.Sprintf("cb-%d", i), "system", "sys-01", "info", "system", "heartbeat", "", nil, ts))
                }
        }
        insertAll(t, st, evs)
        res, err := eng.EvaluateBatch(context.Background(), evs)
        if err != nil {
                t.Fatalf("eval: %v", err)
        }
        if len(res) != 0 {
                t.Fatalf("no rule must fire on clean baseline, got %v", ruleIDs(res))
        }
}
