// Copyright © 2026 Parsa Fathi — Apache-2.0

// Package rules implements the seven seeded detection rules (SG-RULE-001
// through SG-RULE-007) and the evaluation engine that runs them over Store
// queries for every processed batch.
package rules

import (
        "context"
        "fmt"
        "strings"
        "sync"
        "time"

        "github.com/ParsaFathii/StreamGuard/services/ingestor/internal/event"
        "github.com/ParsaFathii/StreamGuard/services/ingestor/internal/ids"
        "github.com/ParsaFathii/StreamGuard/services/ingestor/internal/store"
)

// maxQuery bounds the number of events inspected per rule evaluation.
const maxQuery = 5000

// maxSuppressed bounds the process-local suppression counter map.
const maxSuppressed = 4096

// Defaults returns the seven contract rules with their seeded values.
func Defaults() []store.Rule {
        base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
        mk := func(id, name, desc string, sel store.RuleSelector, cond store.RuleCondition,
                severity string, cooldown int) store.Rule {
                return store.Rule{
                        ID: id, Name: name, Description: desc, Enabled: true,
                        Selector: sel, Condition: cond, Severity: severity,
                        CooldownSeconds: cooldown, Suppression: true, Version: 1, UpdatedAt: base,
                }
        }
        return []store.Rule{
                mk("SG-RULE-001", "Repeated Authentication Failures",
                        ">=5 failed auth events for the same actor within 120s",
                        store.RuleSelector{Category: "auth", Attribute: &store.AttrKV{Key: "action", Value: "login_failed"}},
                        store.RuleCondition{Type: "count", Threshold: 5, WindowSeconds: 120, Metric: "actor"},
                        "high", 300),
                mk("SG-RULE-002", "Abnormal Request Rate",
                        ">120 request events/min from one source",
                        store.RuleSelector{Category: "network", Attribute: &store.AttrKV{Key: "kind", Value: "request"}},
                        store.RuleCondition{Type: "count", Threshold: 120, WindowSeconds: 60, Metric: "source_id", Strict: true},
                        "medium", 120),
                mk("SG-RULE-003", "Suspicious Auth Sequence",
                        ">=3 auth failures followed by a success for the same actor within 5 min",
                        store.RuleSelector{Category: "auth"},
                        store.RuleCondition{Type: "sequence", Threshold: 3, WindowSeconds: 300, Metric: "login_failed_login_success"},
                        "high", 300),
                mk("SG-RULE-004", "Error Rate Spike",
                        "error ratio >30% over 5 min per source (min 20 events)",
                        store.RuleSelector{Category: "application"},
                        store.RuleCondition{Type: "ratio", Threshold: 0.30, WindowSeconds: 300, Metric: "error_ratio", MinCount: 20},
                        "medium", 300),
                mk("SG-RULE-005", "Repeated Authorization Failures",
                        ">=3 authz failures for the same actor in 5 min",
                        store.RuleSelector{Category: "security", Attribute: &store.AttrKV{Key: "action", Value: "access_denied"}},
                        store.RuleCondition{Type: "count", Threshold: 3, WindowSeconds: 300, Metric: "actor"},
                        "medium", 300),
                mk("SG-RULE-006", "Unexpected Configuration Change",
                        "config change on source_type=infra or source_id starting with prod-",
                        store.RuleSelector{Category: "config", Attribute: &store.AttrKV{Key: "action", Value: "change"}},
                        store.RuleCondition{Type: "exists", Threshold: 1, WindowSeconds: 0, Metric: "infra_or_prod"},
                        "high", 0),
                mk("SG-RULE-007", "Ingestion Validation Failures",
                        ">=10 rejected events in 60s",
                        store.RuleSelector{},
                        store.RuleCondition{Type: "count", Threshold: 10, WindowSeconds: 60, Metric: "validation_failures"},
                        "low", 600),
        }
}

// SeedDefaults inserts the contract rules when missing (never clobbers edits).
func SeedDefaults(ctx context.Context, st store.Store) error {
        for i := range Defaults() {
                r := Defaults()[i]
                if _, err := st.InsertRuleIfAbsent(ctx, &r); err != nil {
                        return fmt.Errorf("seed rule %s: %w", r.ID, err)
                }
        }
        return nil
}

// Result is one rule firing plus the matched events (for correlation).
type Result struct {
        Detection store.Detection
        Matched   []event.Event
}

// Engine evaluates rules over Store queries.
type Engine struct {
        st  store.Store
        now func() time.Time

        mu         sync.Mutex
        suppressed map[string]int
}

// NewEngine creates a rule engine. now is injectable for tests.
func NewEngine(st store.Store, now func() time.Time) *Engine {
        if now == nil {
                now = func() time.Time { return time.Now().UTC() }
        }
        return &Engine{st: st, now: now, suppressed: make(map[string]int)}
}

// EvaluateBatch runs all enabled rules. An empty batch still evaluates
// time-window rules (e.g. validation-failure threshold) against the store.
func (e *Engine) EvaluateBatch(ctx context.Context, batch []event.Event) ([]Result, error) {
        rules, err := e.st.ListRules(ctx)
        if err != nil {
                return nil, fmt.Errorf("list rules: %w", err)
        }
        now := e.now()
        var out []Result
        for i := range rules {
                r := rules[i]
                if !r.Enabled {
                        continue
                }
                fires, err := e.evaluateRule(ctx, &r, batch, now)
                if err != nil {
                        return nil, fmt.Errorf("rule %s: %w", r.ID, err)
                }
                out = append(out, fires...)
        }
        return out, nil
}

// SuppressionCounts returns a copy of the process-local suppression counters.
func (e *Engine) SuppressionCounts() map[string]int {
        e.mu.Lock()
        defer e.mu.Unlock()
        out := make(map[string]int, len(e.suppressed))
        for k, v := range e.suppressed {
                out[k] = v
        }
        return out
}

func (e *Engine) evaluateRule(ctx context.Context, r *store.Rule, batch []event.Event, now time.Time) ([]Result, error) {
        switch r.Condition.Metric {
        case "validation_failures":
                return e.evalValidationFailures(ctx, r, now)
        case "infra_or_prod", "":
                if r.Condition.WindowSeconds == 0 {
                        return e.evalExistsBatch(ctx, r, batch, now)
                }
        }
        // Windowed evaluation over the store.
        q := store.EventQuery{
                Categories:     selectorCategories(r),
                Severities:     r.Selector.Severities,
                SourceIDPrefix: r.Selector.SourceIDPrefix,
                Since:          now.Add(-time.Duration(r.Condition.WindowSeconds) * time.Second),
                Until:          now.Add(event.MaxFutureSkew),
                Limit:          maxQuery,
        }
        if r.Selector.Attribute != nil {
                q.AttrKey = r.Selector.Attribute.Key
                q.AttrValue = r.Selector.Attribute.Value
        }
        evs, err := e.st.QueryEvents(ctx, q)
        if err != nil {
                return nil, fmt.Errorf("query events: %w", err)
        }
        if r.Condition.Metric == "infra_or_prod" {
                filtered := evs[:0]
                for _, ev := range evs {
                        if ev.SourceType == "infra" || strings.HasPrefix(ev.SourceID, "prod-") {
                                filtered = append(filtered, ev)
                        }
                }
                evs = filtered
        }
        groups := groupBy(evs, r.Condition.Metric)
        var out []Result
        for key, group := range groups {
                if !conditionMet(r, group) {
                        continue
                }
                res, err := e.maybeFire(ctx, r, key, group, now)
                if err != nil {
                        return nil, err
                }
                if res != nil {
                        out = append(out, *res)
                }
        }
        return out, nil
}

func selectorCategories(r *store.Rule) []string {
        if r.Selector.Category == "" {
                return nil
        }
        return []string{r.Selector.Category}
}

func groupBy(evs []event.Event, metric string) map[string][]event.Event {
        out := make(map[string][]event.Event)
        for _, ev := range evs {
                var key string
                switch metric {
                case "actor", "login_failed_login_success":
                        // sequence rules correlate per actor (auth semantics)
                        if ev.Actor == "" {
                                continue
                        }
                        key = ev.Actor
                case "source_id":
                        key = ev.SourceID
                default:
                        key = "global"
                }
                out[key] = append(out[key], ev)
        }
        return out
}

func conditionMet(r *store.Rule, group []event.Event) bool {
        switch r.Condition.Type {
        case "count":
                if r.Condition.Strict {
                        return float64(len(group)) > r.Condition.Threshold
                }
                return float64(len(group)) >= r.Condition.Threshold
        case "ratio":
                if len(group) < r.Condition.MinCount {
                        return false
                }
                errs := 0
                for i := range group {
                        if group[i].IsErrorLike() {
                                errs++
                        }
                }
                return float64(errs)/float64(len(group)) > r.Condition.Threshold
        case "sequence":
                return sequenceMet(group, int(r.Condition.Threshold))
        case "exists":
                return len(group) > 0
        default:
                return false
        }
}

// sequenceMet scans an actor's auth events (time-ordered) for >=threshold
// consecutive login_failed followed by a login_success.
func sequenceMet(group []event.Event, threshold int) bool {
        consecutive := 0
        for i := range group {
                switch group[i].Attr("action") {
                case "login_failed":
                        consecutive++
                case "login_success":
                        if consecutive >= threshold {
                                return true
                        }
                        consecutive = 0
                default:
                        // unrelated auth event breaks the run
                        consecutive = 0
                }
        }
        return false
}

func (e *Engine) evalExistsBatch(ctx context.Context, r *store.Rule, batch []event.Event, now time.Time) ([]Result, error) {
        var out []Result
        seen := make(map[string]bool)
        for i := range batch {
                ev := batch[i]
                if !matchesSelector(&ev, r) {
                        continue
                }
                if r.Condition.Metric == "infra_or_prod" &&
                        ev.SourceType != "infra" && !strings.HasPrefix(ev.SourceID, "prod-") {
                        continue
                }
                key := ev.SourceID
                if seen[key] {
                        continue
                }
                seen[key] = true
                res, err := e.maybeFire(ctx, r, key, []event.Event{ev}, now)
                if err != nil {
                        return nil, err
                }
                if res != nil {
                        out = append(out, *res)
                }
        }
        return out, nil
}

func (e *Engine) evalValidationFailures(ctx context.Context, r *store.Rule, now time.Time) ([]Result, error) {
        vfs, err := e.st.ListValidationFailuresSince(ctx, now.Add(-time.Duration(r.Condition.WindowSeconds)*time.Second), 50)
        if err != nil {
                return nil, fmt.Errorf("list validation failures: %w", err)
        }
        if float64(len(vfs)) < r.Condition.Threshold {
                return nil, nil
        }
        trigger := ""
        if len(vfs) > 0 {
                trigger = vfs[0].ID
        }
        group := make([]event.Event, 0) // no events attach to validation-failure incidents
        res, err := e.maybeFireWithTrigger(ctx, r, "global", group, now, trigger)
        if err != nil {
                return nil, err
        }
        if res != nil {
                return []Result{*res}, nil
        }
        return nil, nil
}

// matchesSelector applies the rule selector to a single event (used for
// window-0 rules evaluated against the current batch only).
func matchesSelector(ev *event.Event, r *store.Rule) bool {
        if r.Selector.Category != "" && ev.Category != r.Selector.Category {
                return false
        }
        if len(r.Selector.Severities) > 0 && !contains(r.Selector.Severities, ev.Severity) {
                return false
        }
        if r.Selector.SourceIDPrefix != "" && !strings.HasPrefix(ev.SourceID, r.Selector.SourceIDPrefix) {
                return false
        }
        if r.Selector.Attribute != nil && ev.Attr(r.Selector.Attribute.Key) != r.Selector.Attribute.Value {
                return false
        }
        return true
}

func contains(list []string, s string) bool {
        for _, v := range list {
                if v == s {
                        return true
                }
        }
        return false
}

func (e *Engine) maybeFire(ctx context.Context, r *store.Rule, key string, group []event.Event, now time.Time) (*Result, error) {
        trigger := ""
        if len(group) > 0 {
                trigger = group[len(group)-1].EventID
        }
        return e.maybeFireWithTrigger(ctx, r, key, group, now, trigger)
}

func (e *Engine) maybeFireWithTrigger(ctx context.Context, r *store.Rule, key string, group []event.Event, now time.Time, trigger string) (*Result, error) {
        // Cooldown check: same rule + correlation key.
        last, err := e.st.LastDetectionAtByRuleKey(ctx, r.ID)
        if err != nil {
                return nil, fmt.Errorf("cooldown query: %w", err)
        }
        if t, ok := last[key]; ok && r.CooldownSeconds > 0 && now.Sub(t) < time.Duration(r.CooldownSeconds)*time.Second {
                if r.Suppression {
                        e.mu.Lock()
                        if len(e.suppressed) < maxSuppressed {
                                e.suppressed[r.ID+"|"+key]++
                        }
                        e.mu.Unlock()
                }
                return nil, nil
        }
        det := store.Detection{
                ID:             ids.New("DET"),
                RuleID:         r.ID,
                EventID:        trigger,
                CorrelationKey: key,
                Severity:       r.Severity,
                Score:          scoreFor(r, group),
                Title:          r.Name,
                Status:         store.DetectionActive,
                CreatedAt:      now,
                Detail: store.DetectionDetail{
                        MatchedCount:  len(group),
                        WindowSeconds: r.Condition.WindowSeconds,
                        SampleEventIDs: sampleIDs(group, 10),
                },
        }
        switch r.Condition.Metric {
        case "actor":
                det.Detail.Actor = key
        case "source_id":
                det.Detail.SourceID = key
        }
        if err := e.st.InsertDetection(ctx, &det); err != nil {
                return nil, fmt.Errorf("insert detection: %w", err)
        }
        return &Result{Detection: det, Matched: group}, nil
}

func sampleIDs(group []event.Event, n int) []string {
        if len(group) == 0 {
                return []string{}
        }
        out := make([]string, 0, min(n, len(group)))
        start := 0
        if len(group) > n {
                start = len(group) - n // keep the most recent
        }
        for i := start; i < len(group); i++ {
                out = append(out, group[i].EventID)
        }
        return out
}

func scoreFor(r *store.Rule, group []event.Event) float64 {
        switch r.Condition.Type {
        case "count":
                if r.Condition.Threshold <= 0 || len(group) == 0 {
                        return 0.5
                }
                excess := float64(len(group)) - r.Condition.Threshold + 1
                return clamp01(0.5 + 0.5*excess/r.Condition.Threshold)
        case "ratio":
                if len(group) == 0 {
                        return 0.5
                }
                errs := 0
                for i := range group {
                        if group[i].IsErrorLike() {
                                errs++
                        }
                }
                return clamp01(0.5 + 0.5*float64(errs)/float64(len(group)))
        case "sequence":
                return 0.85
        default: // exists
                return 0.9
        }
}

func clamp01(v float64) float64 {
        if v < 0 {
                return 0
        }
        if v > 1 {
                return 1
        }
        return v
}

func min(a, b int) int {
        if a < b {
                return a
        }
        return b
}
