// Copyright © 2026 Parsa Fathi — Apache-2.0

package store

import (
        "context"
        "sort"
        "strings"
        "sync"
        "time"

        "github.com/ParsaFathii/StreamGuard/services/ingestor/internal/event"
)

// MemStore is a thread-safe in-memory Store. It is the default runtime store
// (when POSTGRES_DSN is unset) and backs every unit test. Data is not durable.
type MemStore struct {
        mu sync.RWMutex

        events      []*event.Event
        eventsByID  map[string]*event.Event
        valFailures []ValidationFailure

        rules     map[string]*Rule
        ruleOrder []string
        ruleAudit []RuleAudit

        detections []*Detection

        incidents        map[string]*Incident
        incidentSeq      int
        incidentOrder    []string
        incidentEvents   map[string][]IncidentEvent // incidentID -> attached
        incidentEventSet map[string]map[string]bool // incidentID -> eventID set
        notes            map[string][]Note
        aiReports        map[string][]AIReport

        audit []AuditEntry

        users      map[string]*User
        sessions   map[string]*Session
        ingestKeys map[string]*IngestKey // value -> key

        settings *Settings
        mlRuns   []MlRun
}

// NewMemStore creates an empty in-memory store.
func NewMemStore() *MemStore {
        return &MemStore{
                eventsByID:       make(map[string]*event.Event),
                rules:            make(map[string]*Rule),
                incidents:        make(map[string]*Incident),
                incidentEvents:   make(map[string][]IncidentEvent),
                incidentEventSet: make(map[string]map[string]bool),
                notes:            make(map[string][]Note),
                aiReports:        make(map[string][]AIReport),
                users:            make(map[string]*User),
                sessions:         make(map[string]*Session),
                ingestKeys:       make(map[string]*IngestKey),
        }
}

// Close implements Store (no-op).
func (m *MemStore) Close() error { return nil }

// Ping implements Store.
func (m *MemStore) Ping(ctx context.Context) error { return ctx.Err() }

func copyEvent(e *event.Event) *event.Event { return e.Clone() }

func copyDetection(d *Detection) *Detection {
        c := *d
        c.Detail.SampleEventIDs = append([]string(nil), d.Detail.SampleEventIDs...)
        return &c
}

func copyIncident(i *Incident) *Incident {
        c := *i
        c.StatusHistory = append([]StatusHistoryEntry(nil), i.StatusHistory...)
        return &c
}

// ---- events ----

// InsertEvent implements Store with idempotent semantics on event id.
func (m *MemStore) InsertEvent(ctx context.Context, e *event.Event) (bool, error) {
        if err := ctx.Err(); err != nil {
                return false, err
        }
        m.mu.Lock()
        defer m.mu.Unlock()
        if _, ok := m.eventsByID[e.EventID]; ok {
                return false, nil
        }
        m.events = append(m.events, e)
        m.eventsByID[e.EventID] = e
        return true, nil
}

// GetEvent implements Store.
func (m *MemStore) GetEvent(ctx context.Context, id string) (*event.Event, error) {
        if err := ctx.Err(); err != nil {
                return nil, err
        }
        m.mu.RLock()
        defer m.mu.RUnlock()
        e, ok := m.eventsByID[id]
        if !ok {
                return nil, ErrNotFound
        }
        return copyEvent(e), nil
}

// SetEventProcessed implements Store.
func (m *MemStore) SetEventProcessed(ctx context.Context, id string, latencyMs int64, at time.Time) error {
        if err := ctx.Err(); err != nil {
                return err
        }
        m.mu.Lock()
        defer m.mu.Unlock()
        e, ok := m.eventsByID[id]
        if !ok {
                return ErrNotFound
        }
        e.Status = "PROCESSED"
        e.LatencyMs = latencyMs
        return nil
}

// DeleteEvents implements Store (used for backpressure rollback).
func (m *MemStore) DeleteEvents(ctx context.Context, ids []string) (int, error) {
        if err := ctx.Err(); err != nil {
                return 0, err
        }
        m.mu.Lock()
        defer m.mu.Unlock()
        del := make(map[string]bool, len(ids))
        for _, id := range ids {
                del[id] = true
        }
        kept := m.events[:0]
        n := 0
        for _, e := range m.events {
                if del[e.EventID] {
                        delete(m.eventsByID, e.EventID)
                        n++
                        continue
                }
                kept = append(kept, e)
        }
        m.events = kept
        return n, nil
}

func eventMatchesFilter(e *event.Event, f EventFilter) bool {
        if len(f.Severities) > 0 && !inList(f.Severities, e.Severity) {
                return false
        }
        if f.Category != "" && e.Category != f.Category {
                return false
        }
        if f.SourceID != "" && e.SourceID != f.SourceID {
                return false
        }
        if f.SourceType != "" && e.SourceType != f.SourceType {
                return false
        }
        if f.CorrelationID != "" && e.CorrelationID != f.CorrelationID {
                return false
        }
        if f.TraceID != "" && e.TraceID != f.TraceID {
                return false
        }
        if f.Status != "" && e.Status != f.Status {
                return false
        }
        if f.Origin != "" && e.Origin != f.Origin {
                return false
        }
        if f.From != nil && e.EventTime.Before(*f.From) {
                return false
        }
        if f.To != nil && e.EventTime.After(*f.To) {
                return false
        }
        if f.Q != "" {
                q := strings.ToLower(f.Q)
                if !strings.Contains(strings.ToLower(e.Message), q) &&
                        !strings.Contains(strings.ToLower(e.Actor), q) {
                        return false
                }
        }
        return true
}

func inList(list []string, s string) bool {
        for _, v := range list {
                if v == s {
                        return true
                }
        }
        return false
}

// ListEvents implements Store (ordered by event_time desc, then ingest desc).
func (m *MemStore) ListEvents(ctx context.Context, f EventFilter, page, pageSize int) ([]event.Event, int, error) {
        if err := ctx.Err(); err != nil {
                return nil, 0, err
        }
        m.mu.RLock()
        defer m.mu.RUnlock()

        var incidentSet map[string]bool
        if f.IncidentID != "" {
                incidentSet = m.incidentEventSet[f.IncidentID]
                if incidentSet == nil {
                        incidentSet = map[string]bool{}
                }
        }
        var ruleEvents map[string]bool
        if f.RuleID != "" {
                ruleEvents = make(map[string]bool)
                for _, d := range m.detections {
                        if d.RuleID == f.RuleID && d.EventID != "" {
                                ruleEvents[d.EventID] = true
                        }
                }
        }

        filtered := make([]*event.Event, 0, len(m.events))
        for _, e := range m.events {
                if incidentSet != nil && !incidentSet[e.EventID] {
                        continue
                }
                if ruleEvents != nil && !ruleEvents[e.EventID] {
                        continue
                }
                if !eventMatchesFilter(e, f) {
                        continue
                }
                filtered = append(filtered, e)
        }
        sort.SliceStable(filtered, func(i, j int) bool {
                a, b := filtered[i], filtered[j]
                if !a.EventTime.Equal(b.EventTime) {
                        return a.EventTime.After(b.EventTime)
                }
                return a.IngestTime.After(b.IngestTime)
        })
        total := len(filtered)
        out := make([]event.Event, 0, min(pageSize, total))
        for _, e := range pageSlice(len(filtered), page, pageSize) {
                out = append(out, *copyEvent(filtered[e]))
        }
        return out, total, nil
}

// QueryEvents implements Store (rule-engine selector query, time-ordered asc).
func (m *MemStore) QueryEvents(ctx context.Context, q EventQuery) ([]event.Event, error) {
        if err := ctx.Err(); err != nil {
                return nil, err
        }
        m.mu.RLock()
        defer m.mu.RUnlock()
        var out []event.Event
        for _, e := range m.events {
                if len(q.Categories) > 0 && !inList(q.Categories, e.Category) {
                        continue
                }
                if len(q.Severities) > 0 && !inList(q.Severities, e.Severity) {
                        continue
                }
                if q.SourceIDPrefix != "" && !strings.HasPrefix(e.SourceID, q.SourceIDPrefix) {
                        continue
                }
                if q.AttrKey != "" && e.Attr(q.AttrKey) != q.AttrValue {
                        continue
                }
                if !q.Since.IsZero() && e.EventTime.Before(q.Since) {
                        continue
                }
                if !q.Until.IsZero() && e.EventTime.After(q.Until) {
                        continue
                }
                out = append(out, *copyEvent(e))
                if q.Limit > 0 && len(out) >= q.Limit {
                        break
                }
        }
        sort.SliceStable(out, func(i, j int) bool { return out[i].EventTime.Before(out[j].EventTime) })
        return out, nil
}

// CountEventsSince implements Store.
func (m *MemStore) CountEventsSince(ctx context.Context, since time.Time) (int64, error) {
        if err := ctx.Err(); err != nil {
                return 0, err
        }
        m.mu.RLock()
        defer m.mu.RUnlock()
        var n int64
        for _, e := range m.events {
                if e.IngestTime.After(since) || e.IngestTime.Equal(since) {
                        n++
                }
        }
        return n, nil
}

// SeverityBreakdownSince implements Store.
func (m *MemStore) SeverityBreakdownSince(ctx context.Context, since time.Time) (map[string]int64, error) {
        return m.breakdownSince(ctx, since, func(e *event.Event) string { return e.Severity })
}

// CategoryBreakdownSince implements Store.
func (m *MemStore) CategoryBreakdownSince(ctx context.Context, since time.Time) (map[string]int64, error) {
        return m.breakdownSince(ctx, since, func(e *event.Event) string { return e.Category })
}

func (m *MemStore) breakdownSince(ctx context.Context, since time.Time, key func(*event.Event) string) (map[string]int64, error) {
        if err := ctx.Err(); err != nil {
                return nil, err
        }
        m.mu.RLock()
        defer m.mu.RUnlock()
        out := make(map[string]int64)
        for _, e := range m.events {
                if e.IngestTime.Before(since) {
                        continue
                }
                out[key(e)]++
        }
        return out, nil
}

// TopSourcesSince implements Store.
func (m *MemStore) TopSourcesSince(ctx context.Context, since time.Time, n int) ([]SourceCount, error) {
        if err := ctx.Err(); err != nil {
                return nil, err
        }
        m.mu.RLock()
        defer m.mu.RUnlock()
        counts := make(map[string]int64)
        for _, e := range m.events {
                if e.IngestTime.Before(since) {
                        continue
                }
                counts[e.SourceID]++
        }
        out := make([]SourceCount, 0, len(counts))
        for id, c := range counts {
                out = append(out, SourceCount{SourceID: id, Count: c})
        }
        sort.Slice(out, func(i, j int) bool {
                if out[i].Count != out[j].Count {
                        return out[i].Count > out[j].Count
                }
                return out[i].SourceID < out[j].SourceID
        })
        if len(out) > n {
                out = out[:n]
        }
        return out, nil
}

// MinuteCounts implements Store (kind: events|detections|rejected).
func (m *MemStore) MinuteCounts(ctx context.Context, kind string, since time.Time) ([]MinuteCount, error) {
        if err := ctx.Err(); err != nil {
                return nil, err
        }
        m.mu.RLock()
        defer m.mu.RUnlock()
        buckets := make(map[time.Time]int64)
        switch kind {
        case "events":
                for _, e := range m.events {
                        if e.IngestTime.Before(since) {
                                continue
                        }
                        buckets[e.IngestTime.Truncate(time.Minute)]++
                }
        case "rejected":
                for _, e := range m.events {
                        if e.Status != "REJECTED" || e.IngestTime.Before(since) {
                                continue
                        }
                        buckets[e.IngestTime.Truncate(time.Minute)]++
                }
        case "detections":
                for _, d := range m.detections {
                        if d.CreatedAt.Before(since) {
                                continue
                        }
                        buckets[d.CreatedAt.Truncate(time.Minute)]++
                }
        default:
                return nil, ErrNotFound
        }
        out := make([]MinuteCount, 0, len(buckets))
        for k, v := range buckets {
                out = append(out, MinuteCount{Minute: k.UTC(), Count: v})
        }
        sort.Slice(out, func(i, j int) bool { return out[i].Minute.Before(out[j].Minute) })
        return out, nil
}

// LatencyStatsSince implements Store.
func (m *MemStore) LatencyStatsSince(ctx context.Context, since time.Time) (float64, float64, time.Time, error) {
        if err := ctx.Err(); err != nil {
                return 0, 0, time.Time{}, err
        }
        m.mu.RLock()
        defer m.mu.RUnlock()
        var latencies []int64
        var last time.Time
        for _, e := range m.events {
                if e.Status != "PROCESSED" || e.IngestTime.Before(since) {
                        continue
                }
                latencies = append(latencies, e.LatencyMs)
                if e.IngestTime.After(last) {
                        last = e.IngestTime
                }
        }
        if len(latencies) == 0 {
                return 0, 0, time.Time{}, nil
        }
        sorted := append([]int64(nil), latencies...)
        sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
        var sum int64
        for _, v := range sorted {
                sum += v
        }
        avg := float64(sum) / float64(len(sorted))
        p95 := percentile(sorted, 0.95)
        return avg, p95, last, nil
}

func percentile(sorted []int64, p float64) float64 {
        if len(sorted) == 0 {
                return 0
        }
        idx := int(float64(len(sorted)-1) * p)
        return float64(sorted[idx])
}

// SourcesSince implements Store (derived from real events only).
func (m *MemStore) SourcesSince(ctx context.Context, since time.Time) ([]SourceStat, error) {
        if err := ctx.Err(); err != nil {
                return nil, err
        }
        m.mu.RLock()
        defer m.mu.RUnlock()
        type acc struct {
                typ, origin string
                count       int64
                last        time.Time
                lastStatus  string
        }
        byID := make(map[string]*acc)
        for _, e := range m.events {
                a, ok := byID[e.SourceID]
                if !ok {
                        a = &acc{typ: e.SourceType, origin: e.Origin}
                        byID[e.SourceID] = a
                }
                if e.IngestTime.After(since) || e.IngestTime.Equal(since) {
                        a.count++
                }
                if e.IngestTime.After(a.last) {
                        a.last = e.IngestTime
                        a.lastStatus = e.Status
                }
        }
        out := make([]SourceStat, 0, len(byID))
        for id, a := range byID {
                out = append(out, SourceStat{ID: id, Type: a.typ, Origin: a.origin, Events24h: a.count, LastEventAt: a.last, LastStatus: a.lastStatus})
        }
        sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
        return out, nil
}

// DeleteEventsBefore implements Store; events attached to incidents that are
// not CLOSED are never deleted.
func (m *MemStore) DeleteEventsBefore(ctx context.Context, cutoff time.Time) (int, error) {
        if err := ctx.Err(); err != nil {
                return 0, err
        }
        m.mu.Lock()
        defer m.mu.Unlock()
        protected := make(map[string]bool)
        for incID, evs := range m.incidentEvents {
                inc := m.incidents[incID]
                if inc == nil || inc.Status == IncidentClosed {
                        continue
                }
                for _, ie := range evs {
                        protected[ie.EventID] = true
                }
        }
        kept := m.events[:0]
        n := 0
        for _, e := range m.events {
                if e.IngestTime.Before(cutoff) && !protected[e.EventID] {
                        delete(m.eventsByID, e.EventID)
                        n++
                        continue
                }
                kept = append(kept, e)
        }
        m.events = kept
        return n, nil
}

// ---- validation failures ----

// InsertValidationFailure implements Store.
func (m *MemStore) InsertValidationFailure(ctx context.Context, vf *ValidationFailure) error {
        if err := ctx.Err(); err != nil {
                return err
        }
        m.mu.Lock()
        defer m.mu.Unlock()
        m.valFailures = append(m.valFailures, *vf)
        return nil
}

// ListValidationFailuresSince implements Store (newest first, bounded).
func (m *MemStore) ListValidationFailuresSince(ctx context.Context, since time.Time, limit int) ([]ValidationFailure, error) {
        if err := ctx.Err(); err != nil {
                return nil, err
        }
        m.mu.RLock()
        defer m.mu.RUnlock()
        var out []ValidationFailure
        for i := len(m.valFailures) - 1; i >= 0 && len(out) < limit; i-- {
                if m.valFailures[i].TS.After(since) || m.valFailures[i].TS.Equal(since) {
                        out = append(out, m.valFailures[i])
                }
        }
        return out, nil
}

// ---- rules ----

// ListRules implements Store (stable, ordered by id).
func (m *MemStore) ListRules(ctx context.Context) ([]Rule, error) {
        if err := ctx.Err(); err != nil {
                return nil, err
        }
        m.mu.RLock()
        defer m.mu.RUnlock()
        out := make([]Rule, 0, len(m.rules))
        ids := append([]string(nil), m.ruleOrder...)
        sort.Strings(ids)
        for _, id := range ids {
                r := m.rules[id]
                if r != nil {
                        out = append(out, *r)
                }
        }
        return out, nil
}

// GetRule implements Store.
func (m *MemStore) GetRule(ctx context.Context, id string) (*Rule, error) {
        if err := ctx.Err(); err != nil {
                return nil, err
        }
        m.mu.RLock()
        defer m.mu.RUnlock()
        r, ok := m.rules[id]
        if !ok {
                return nil, ErrNotFound
        }
        c := *r
        return &c, nil
}

// InsertRuleIfAbsent implements Store (seeding must not clobber edits).
func (m *MemStore) InsertRuleIfAbsent(ctx context.Context, r *Rule) (bool, error) {
        if err := ctx.Err(); err != nil {
                return false, err
        }
        m.mu.Lock()
        defer m.mu.Unlock()
        if _, ok := m.rules[r.ID]; ok {
                return false, nil
        }
        c := *r
        m.rules[r.ID] = &c
        m.ruleOrder = append(m.ruleOrder, r.ID)
        return true, nil
}

// UpdateRule implements Store.
func (m *MemStore) UpdateRule(ctx context.Context, r *Rule) error {
        if err := ctx.Err(); err != nil {
                return err
        }
        m.mu.Lock()
        defer m.mu.Unlock()
        if _, ok := m.rules[r.ID]; !ok {
                return ErrNotFound
        }
        c := *r
        m.rules[r.ID] = &c
        return nil
}

// InsertRuleAudit implements Store.
func (m *MemStore) InsertRuleAudit(ctx context.Context, ra *RuleAudit) error {
        if err := ctx.Err(); err != nil {
                return err
        }
        m.mu.Lock()
        defer m.mu.Unlock()
        m.ruleAudit = append(m.ruleAudit, *ra)
        return nil
}

// ListRuleAudit implements Store (newest first).
func (m *MemStore) ListRuleAudit(ctx context.Context, ruleID string, limit int) ([]RuleAudit, error) {
        if err := ctx.Err(); err != nil {
                return nil, err
        }
        m.mu.RLock()
        defer m.mu.RUnlock()
        out := make([]RuleAudit, 0, limit)
        for i := len(m.ruleAudit) - 1; i >= 0 && len(out) < limit; i-- {
                if m.ruleAudit[i].RuleID == ruleID {
                        out = append(out, m.ruleAudit[i])
                }
        }
        return out, nil
}

// ---- detections ----

// InsertDetection implements Store.
func (m *MemStore) InsertDetection(ctx context.Context, d *Detection) error {
        if err := ctx.Err(); err != nil {
                return err
        }
        m.mu.Lock()
        defer m.mu.Unlock()
        m.detections = append(m.detections, copyDetection(d))
        return nil
}

// ListDetections implements Store (newest first).
func (m *MemStore) ListDetections(ctx context.Context, f DetectionFilter, page, pageSize int) ([]Detection, int, error) {
        if err := ctx.Err(); err != nil {
                return nil, 0, err
        }
        m.mu.RLock()
        defer m.mu.RUnlock()
        filtered := make([]*Detection, 0, len(m.detections))
        for _, d := range m.detections {
                if f.RuleID != "" && d.RuleID != f.RuleID {
                        continue
                }
                if f.Severity != "" && d.Severity != f.Severity {
                        continue
                }
                if f.IncidentID != "" && d.IncidentID != f.IncidentID {
                        continue
                }
                if f.Status != "" && d.Status != f.Status {
                        continue
                }
                if f.From != nil && d.CreatedAt.Before(*f.From) {
                        continue
                }
                if f.To != nil && d.CreatedAt.After(*f.To) {
                        continue
                }
                filtered = append(filtered, d)
        }
        sort.SliceStable(filtered, func(i, j int) bool { return filtered[i].CreatedAt.After(filtered[j].CreatedAt) })
        total := len(filtered)
        out := make([]Detection, 0, min(pageSize, total))
        for _, i := range pageSlice(total, page, pageSize) {
                out = append(out, *copyDetection(filtered[i]))
        }
        return out, total, nil
}

// DetectionCountsByRuleSince implements Store.
func (m *MemStore) DetectionCountsByRuleSince(ctx context.Context, since time.Time) (map[string]int64, error) {
        if err := ctx.Err(); err != nil {
                return nil, err
        }
        m.mu.RLock()
        defer m.mu.RUnlock()
        out := make(map[string]int64)
        for _, d := range m.detections {
                if d.CreatedAt.After(since) || d.CreatedAt.Equal(since) {
                        out[d.RuleID]++
                }
        }
        return out, nil
}

// LastFiredByRule implements Store.
func (m *MemStore) LastFiredByRule(ctx context.Context) (map[string]time.Time, error) {
        if err := ctx.Err(); err != nil {
                return nil, err
        }
        m.mu.RLock()
        defer m.mu.RUnlock()
        out := make(map[string]time.Time)
        for _, d := range m.detections {
                if t, ok := out[d.RuleID]; !ok || d.CreatedAt.After(t) {
                        out[d.RuleID] = d.CreatedAt
                }
        }
        return out, nil
}

// LastDetectionAtByRuleKey implements Store (cooldown check).
func (m *MemStore) LastDetectionAtByRuleKey(ctx context.Context, ruleID string) (map[string]time.Time, error) {
        if err := ctx.Err(); err != nil {
                return nil, err
        }
        m.mu.RLock()
        defer m.mu.RUnlock()
        out := make(map[string]time.Time)
        for _, d := range m.detections {
                if d.RuleID != ruleID {
                        continue
                }
                if t, ok := out[d.CorrelationKey]; !ok || d.CreatedAt.After(t) {
                        out[d.CorrelationKey] = d.CreatedAt
                }
        }
        return out, nil
}

// ---- incidents ----

// NextIncidentNumber implements Store (sequential INC-%06d).
func (m *MemStore) NextIncidentNumber(ctx context.Context) (int, error) {
        if err := ctx.Err(); err != nil {
                return 0, err
        }
        m.mu.Lock()
        defer m.mu.Unlock()
        m.incidentSeq++
        return m.incidentSeq, nil
}

// InsertIncident implements Store.
func (m *MemStore) InsertIncident(ctx context.Context, inc *Incident) error {
        if err := ctx.Err(); err != nil {
                return err
        }
        m.mu.Lock()
        defer m.mu.Unlock()
        if _, ok := m.incidents[inc.ID]; ok {
                return ErrDuplicate
        }
        m.incidents[inc.ID] = copyIncident(inc)
        m.incidentOrder = append(m.incidentOrder, inc.ID)
        return nil
}

// ErrDuplicate signals a uniqueness violation.
var ErrDuplicate = errDuplicate{}

type errDuplicate struct{}

func (errDuplicate) Error() string { return "duplicate entity" }

// GetIncident implements Store.
func (m *MemStore) GetIncident(ctx context.Context, id string) (*Incident, error) {
        if err := ctx.Err(); err != nil {
                return nil, err
        }
        m.mu.RLock()
        defer m.mu.RUnlock()
        inc, ok := m.incidents[id]
        if !ok {
                return nil, ErrNotFound
        }
        return copyIncident(inc), nil
}

// UpdateIncident implements Store.
func (m *MemStore) UpdateIncident(ctx context.Context, inc *Incident) error {
        if err := ctx.Err(); err != nil {
                return err
        }
        m.mu.Lock()
        defer m.mu.Unlock()
        if _, ok := m.incidents[inc.ID]; !ok {
                return ErrNotFound
        }
        m.incidents[inc.ID] = copyIncident(inc)
        return nil
}

// ListIncidents implements Store; sort: createdAt|severity|updatedAt (desc).
func (m *MemStore) ListIncidents(ctx context.Context, f IncidentFilter, sortKey string, page, pageSize int) ([]Incident, int, error) {
        if err := ctx.Err(); err != nil {
                return nil, 0, err
        }
        m.mu.RLock()
        defer m.mu.RUnlock()
        filtered := make([]*Incident, 0, len(m.incidents))
        for _, inc := range m.incidents {
                if f.Status != "" && inc.Status != f.Status {
                        continue
                }
                if f.Severity != "" && inc.Severity != f.Severity {
                        continue
                }
                if f.RuleID != "" && inc.RuleID != f.RuleID {
                        continue
                }
                if f.AssignedTo != "" && inc.AssignedTo != f.AssignedTo {
                        continue
                }
                if f.Since != nil && inc.CreatedAt.Before(*f.Since) {
                        continue
                }
                if f.Q != "" {
                        q := strings.ToLower(f.Q)
                        if !strings.Contains(strings.ToLower(inc.Title), q) &&
                                !strings.Contains(strings.ToLower(inc.CorrelationKey), q) &&
                                !strings.Contains(strings.ToLower(inc.ID), q) {
                                continue
                        }
                }
                filtered = append(filtered, inc)
        }
        sevRank := map[string]int{"info": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}
        sort.SliceStable(filtered, func(i, j int) bool {
                a, b := filtered[i], filtered[j]
                switch sortKey {
                case "severity":
                        if sevRank[a.Severity] != sevRank[b.Severity] {
                                return sevRank[a.Severity] > sevRank[b.Severity]
                        }
                        return a.CreatedAt.After(b.CreatedAt)
                case "updatedAt":
                        return a.UpdatedAt.After(b.UpdatedAt)
                default: // createdAt
                        return a.CreatedAt.After(b.CreatedAt)
                }
        })
        total := len(filtered)
        out := make([]Incident, 0, min(pageSize, total))
        for _, i := range pageSlice(total, page, pageSize) {
                out = append(out, *copyIncident(filtered[i]))
        }
        return out, total, nil
}

// FindOpenIncident implements Store (open = not RESOLVED/CLOSED).
func (m *MemStore) FindOpenIncident(ctx context.Context, ruleID, correlationKey string, updatedSince time.Time) (*Incident, error) {
        if err := ctx.Err(); err != nil {
                return nil, err
        }
        m.mu.RLock()
        defer m.mu.RUnlock()
        var best *Incident
        for _, inc := range m.incidents {
                if inc.RuleID != ruleID || inc.CorrelationKey != correlationKey {
                        continue
                }
                if inc.Status == IncidentResolved || inc.Status == IncidentClosed {
                        continue
                }
                if inc.UpdatedAt.Before(updatedSince) {
                        continue
                }
                if best == nil || inc.UpdatedAt.After(best.UpdatedAt) {
                        best = inc
                }
        }
        if best == nil {
                return nil, ErrNotFound
        }
        return copyIncident(best), nil
}

// AttachIncidentEvents implements Store (idempotent per (incident,event)).
func (m *MemStore) AttachIncidentEvents(ctx context.Context, incidentID string, evs []IncidentEvent) (int, error) {
        if err := ctx.Err(); err != nil {
                return 0, err
        }
        m.mu.Lock()
        defer m.mu.Unlock()
        if _, ok := m.incidents[incidentID]; !ok {
                return 0, ErrNotFound
        }
        set := m.incidentEventSet[incidentID]
        if set == nil {
                set = make(map[string]bool)
                m.incidentEventSet[incidentID] = set
        }
        n := 0
        for _, ie := range evs {
                if set[ie.EventID] {
                        continue
                }
                set[ie.EventID] = true
                ie.AttachedAt = time.Now().UTC()
                m.incidentEvents[incidentID] = append(m.incidentEvents[incidentID], ie)
                n++
        }
        return n, nil
}

// IncidentEvents implements Store (event_time asc, paginated, with late flag).
func (m *MemStore) IncidentEvents(ctx context.Context, incidentID string, page, pageSize int) ([]IncidentEventView, int, error) {
        if err := ctx.Err(); err != nil {
                return nil, 0, err
        }
        m.mu.RLock()
        defer m.mu.RUnlock()
        links := m.incidentEvents[incidentID]
        type pair struct {
                ev  *event.Event
                lat bool
        }
        pairs := make([]pair, 0, len(links))
        for _, l := range links {
                if e, ok := m.eventsByID[l.EventID]; ok {
                        pairs = append(pairs, pair{e, l.Late})
                }
        }
        sort.SliceStable(pairs, func(i, j int) bool { return pairs[i].ev.EventTime.Before(pairs[j].ev.EventTime) })
        total := len(pairs)
        out := make([]IncidentEventView, 0, min(pageSize, total))
        for _, i := range pageSlice(total, page, pageSize) {
                out = append(out, IncidentEventView{Event: *copyEvent(pairs[i].ev), Late: pairs[i].lat})
        }
        return out, total, nil
}

// IncidentCounts implements Store.
func (m *MemStore) IncidentCounts(ctx context.Context, now time.Time) (int64, int64, error) {
        if err := ctx.Err(); err != nil {
                return 0, 0, err
        }
        m.mu.RLock()
        defer m.mu.RUnlock()
        var open, last24 int64
        for _, inc := range m.incidents {
                if inc.Status != IncidentResolved && inc.Status != IncidentClosed {
                        open++
                }
                if inc.CreatedAt.After(now.Add(-24 * time.Hour)) {
                        last24++
                }
        }
        return open, last24, nil
}

// SetDetectionIncident implements Store.
func (m *MemStore) SetDetectionIncident(ctx context.Context, detectionID, incidentID string) error {
        if err := ctx.Err(); err != nil {
                return err
        }
        m.mu.Lock()
        defer m.mu.Unlock()
        for _, d := range m.detections {
                if d.ID == detectionID {
                        d.IncidentID = incidentID
                        return nil
                }
        }
        return ErrNotFound
}

// ---- notes ----

// InsertNote implements Store.
func (m *MemStore) InsertNote(ctx context.Context, n *Note) error {
        if err := ctx.Err(); err != nil {
                return err
        }
        m.mu.Lock()
        defer m.mu.Unlock()
        m.notes[n.IncidentID] = append(m.notes[n.IncidentID], *n)
        return nil
}

// ListNotes implements Store (oldest first).
func (m *MemStore) ListNotes(ctx context.Context, incidentID string) ([]Note, error) {
        if err := ctx.Err(); err != nil {
                return nil, err
        }
        m.mu.RLock()
        defer m.mu.RUnlock()
        return append([]Note(nil), m.notes[incidentID]...), nil
}

// ---- ai reports ----

// InsertAIReport implements Store.
func (m *MemStore) InsertAIReport(ctx context.Context, ar *AIReport) error {
        if err := ctx.Err(); err != nil {
                return err
        }
        m.mu.Lock()
        defer m.mu.Unlock()
        c := *ar
        m.aiReports[ar.IncidentID] = append(m.aiReports[ar.IncidentID], c)
        return nil
}

// ListAIReports implements Store (oldest first).
func (m *MemStore) ListAIReports(ctx context.Context, incidentID string) ([]AIReport, error) {
        if err := ctx.Err(); err != nil {
                return nil, err
        }
        m.mu.RLock()
        defer m.mu.RUnlock()
        return append([]AIReport(nil), m.aiReports[incidentID]...), nil
}

// ---- audit ----

// InsertAudit implements Store.
func (m *MemStore) InsertAudit(ctx context.Context, a *AuditEntry) error {
        if err := ctx.Err(); err != nil {
                return err
        }
        m.mu.Lock()
        defer m.mu.Unlock()
        m.audit = append(m.audit, *a)
        return nil
}

// ListAudit implements Store (newest first).
func (m *MemStore) ListAudit(ctx context.Context, f AuditFilter, page, pageSize int) ([]AuditEntry, int, error) {
        if err := ctx.Err(); err != nil {
                return nil, 0, err
        }
        m.mu.RLock()
        defer m.mu.RUnlock()
        filtered := make([]AuditEntry, 0)
        for i := len(m.audit) - 1; i >= 0; i-- {
                a := m.audit[i]
                if f.Actor != "" && a.Actor != f.Actor {
                        continue
                }
                if f.Action != "" && a.Action != f.Action {
                        continue
                }
                if f.TargetType != "" && a.TargetType != f.TargetType {
                        continue
                }
                if f.From != nil && a.TS.Before(*f.From) {
                        continue
                }
                if f.To != nil && a.TS.After(*f.To) {
                        continue
                }
                filtered = append(filtered, a)
        }
        total := len(filtered)
        out := make([]AuditEntry, 0, min(pageSize, total))
        for _, i := range pageSlice(total, page, pageSize) {
                out = append(out, filtered[i])
        }
        return out, total, nil
}

// ---- users / sessions / ingest keys ----

// UpsertUser implements Store.
func (m *MemStore) UpsertUser(ctx context.Context, u *User) error {
        if err := ctx.Err(); err != nil {
                return err
        }
        m.mu.Lock()
        defer m.mu.Unlock()
        c := *u
        m.users[u.Username] = &c
        return nil
}

// GetUser implements Store.
func (m *MemStore) GetUser(ctx context.Context, username string) (*User, error) {
        if err := ctx.Err(); err != nil {
                return nil, err
        }
        m.mu.RLock()
        defer m.mu.RUnlock()
        u, ok := m.users[username]
        if !ok {
                return nil, ErrNotFound
        }
        c := *u
        return &c, nil
}

// InsertSession implements Store.
func (m *MemStore) InsertSession(ctx context.Context, s *Session) error {
        if err := ctx.Err(); err != nil {
                return err
        }
        m.mu.Lock()
        defer m.mu.Unlock()
        c := *s
        m.sessions[s.Token] = &c
        return nil
}

// GetSession implements Store (expired sessions are treated as missing).
func (m *MemStore) GetSession(ctx context.Context, token string) (*Session, error) {
        if err := ctx.Err(); err != nil {
                return nil, err
        }
        m.mu.RLock()
        defer m.mu.RUnlock()
        s, ok := m.sessions[token]
        if !ok || time.Now().After(s.ExpiresAt) {
                return nil, ErrNotFound
        }
        c := *s
        return &c, nil
}

// DeleteSession implements Store.
func (m *MemStore) DeleteSession(ctx context.Context, token string) error {
        if err := ctx.Err(); err != nil {
                return err
        }
        m.mu.Lock()
        defer m.mu.Unlock()
        delete(m.sessions, token)
        return nil
}

// UpsertIngestKey implements Store.
func (m *MemStore) UpsertIngestKey(ctx context.Context, k *IngestKey) error {
        if err := ctx.Err(); err != nil {
                return err
        }
        m.mu.Lock()
        defer m.mu.Unlock()
        c := *k
        m.ingestKeys[k.Value] = &c
        return nil
}

// GetIngestKey implements Store (lookup by secret value).
func (m *MemStore) GetIngestKey(ctx context.Context, value string) (*IngestKey, error) {
        if err := ctx.Err(); err != nil {
                return nil, err
        }
        m.mu.RLock()
        defer m.mu.RUnlock()
        k, ok := m.ingestKeys[value]
        if !ok || !k.Active {
                return nil, ErrNotFound
        }
        c := *k
        return &c, nil
}

// ---- settings & ml ----

// InitSettingsIfAbsent implements Store.
func (m *MemStore) InitSettingsIfAbsent(ctx context.Context, s Settings) error {
        if err := ctx.Err(); err != nil {
                return err
        }
        m.mu.Lock()
        defer m.mu.Unlock()
        if m.settings == nil {
                c := s
                m.settings = &c
        }
        return nil
}

// GetSettings implements Store.
func (m *MemStore) GetSettings(ctx context.Context) (Settings, error) {
        if err := ctx.Err(); err != nil {
                return Settings{}, err
        }
        m.mu.RLock()
        defer m.mu.RUnlock()
        if m.settings == nil {
                return DefaultSettings(), nil
        }
        return *m.settings, nil
}

// SaveSettings implements Store.
func (m *MemStore) SaveSettings(ctx context.Context, s Settings) error {
        if err := ctx.Err(); err != nil {
                return err
        }
        m.mu.Lock()
        defer m.mu.Unlock()
        c := s
        m.settings = &c
        return nil
}

// SaveMlRun implements Store.
func (m *MemStore) SaveMlRun(ctx context.Context, run *MlRun) error {
        if err := ctx.Err(); err != nil {
                return err
        }
        m.mu.Lock()
        defer m.mu.Unlock()
        m.mlRuns = append(m.mlRuns, *run)
        return nil
}

// LastMlRun implements Store.
func (m *MemStore) LastMlRun(ctx context.Context) (*MlRun, error) {
        if err := ctx.Err(); err != nil {
                return nil, err
        }
        m.mu.RLock()
        defer m.mu.RUnlock()
        if len(m.mlRuns) == 0 {
                return nil, ErrNotFound
        }
        c := m.mlRuns[len(m.mlRuns)-1]
        return &c, nil
}

// ---- demo reset ----

// ResetDemoData implements Store: wipes events, detections, incidents,
// notes, ai reports, validation failures and the audit trail; keeps users,
// rules, settings and ingest keys.
func (m *MemStore) ResetDemoData(ctx context.Context) error {
        if err := ctx.Err(); err != nil {
                return err
        }
        m.mu.Lock()
        defer m.mu.Unlock()
        m.events = nil
        m.eventsByID = make(map[string]*event.Event)
        m.valFailures = nil
        m.detections = nil
        m.incidents = make(map[string]*Incident)
        m.incidentSeq = 0
        m.incidentOrder = nil
        m.incidentEvents = make(map[string][]IncidentEvent)
        m.incidentEventSet = make(map[string]map[string]bool)
        m.notes = make(map[string][]Note)
        m.aiReports = make(map[string][]AIReport)
        m.audit = nil
        m.mlRuns = nil
        return nil
}

func pageSlice(total, page, pageSize int) []int {
        if page < 1 {
                page = 1
        }
        if pageSize < 1 {
                pageSize = 25
        }
        start := (page - 1) * pageSize
        if start >= total {
                return nil
        }
        end := start + pageSize
        if end > total {
                end = total
        }
        out := make([]int, 0, end-start)
        for i := start; i < end; i++ {
                out = append(out, i)
        }
        return out
}

func min(a, b int) int {
        if a < b {
                return a
        }
        return b
}
