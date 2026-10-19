// Copyright © 2026 Parsa Fathi — Apache-2.0

// Package pipeline implements the asynchronous processing stage: a bounded
// batch queue, a bounded worker pool, idempotent processing, rule evaluation,
// correlation, SSE fan-out and graceful draining.
package pipeline

import (
        "context"
        "errors"
        "runtime"
        "sync"
        "time"

        "github.com/ParsaFathii/StreamGuard/services/ingestor/internal/correlate"
        "github.com/ParsaFathii/StreamGuard/services/ingestor/internal/event"
        "github.com/ParsaFathii/StreamGuard/services/ingestor/internal/logging"
        "github.com/ParsaFathii/StreamGuard/services/ingestor/internal/metrics"
        "github.com/ParsaFathii/StreamGuard/services/ingestor/internal/rules"
        "github.com/ParsaFathii/StreamGuard/services/ingestor/internal/sse"
        "github.com/ParsaFathii/StreamGuard/services/ingestor/internal/store"
)

// Errors surfaced to the ingest handler.
var (
        // ErrQueueFull signals backpressure: the bounded queue is at capacity.
        ErrQueueFull = errors.New("pipeline queue full")
        // ErrShuttingDown signals the pipeline no longer accepts work.
        ErrShuttingDown = errors.New("pipeline shutting down")
)

// Config tunes the pipeline.
type Config struct {
        QueueSize int // bounded channel capacity (default 1024)
        Workers   int // bounded worker pool (default clamp(GOMAXPROCS,2,16))
}

// Pipeline is the async processing stage.
type Pipeline struct {
        st   store.Store
        eng  *rules.Engine
        corr *correlate.Engine
        hub  *sse.Hub
        mtr  *metrics.Counters
        log  *logging.Logger

        queue   chan []*event.Event
        workers int

        mu       sync.RWMutex
        stopping bool
        stopCh   chan struct{}
        baseCtx  context.Context
        cancel   context.CancelFunc
        wg       sync.WaitGroup
}

// New creates a pipeline. Call Start before enqueuing.
func New(st store.Store, eng *rules.Engine, corr *correlate.Engine, hub *sse.Hub,
        mtr *metrics.Counters, log *logging.Logger, cfg Config) *Pipeline {
        size := cfg.QueueSize
        if size <= 0 {
                size = 1024
        }
        workers := cfg.Workers
        if workers <= 0 {
                workers = runtime.GOMAXPROCS(0)
        }
        // bounded pool: min 2, max 16
        if workers < 2 {
                workers = 2
        }
        if workers > 16 {
                workers = 16
        }
        if log == nil {
                log = logging.Discard()
        }
        if hub == nil {
                hub = sse.NewHub()
        }
        return &Pipeline{
                st: st, eng: eng, corr: corr, hub: hub, mtr: mtr, log: log,
                queue:   make(chan []*event.Event, size),
                workers: workers,
                stopCh:  make(chan struct{}),
        }
}

// Workers returns the worker pool size.
func (p *Pipeline) Workers() int { return p.workers }

// Start launches the worker pool. The context governs in-flight work.
func (p *Pipeline) Start(ctx context.Context) {
        p.baseCtx, p.cancel = context.WithCancel(ctx)
        for i := 0; i < p.workers; i++ {
                p.wg.Add(1)
                go p.worker()
        }
        p.log.Info("pipeline started", "workers", p.workers, "queue_capacity", cap(p.queue))
}

// TryEnqueue adds a batch without blocking. It returns ErrQueueFull under
// backpressure (caller rejects with 429 + Retry-After) and ErrShuttingDown
// once draining has begun.
func (p *Pipeline) TryEnqueue(batch []*event.Event) error {
        p.mu.RLock()
        defer p.mu.RUnlock()
        if p.stopping {
                return ErrShuttingDown
        }
        select {
        case p.queue <- batch:
                return nil
        default:
                return ErrQueueFull
        }
}

// Depth returns the current queue depth.
func (p *Pipeline) Depth() int { return len(p.queue) }

func (p *Pipeline) worker() {
        defer p.wg.Done()
        for {
                select {
                case <-p.stopCh:
                        // drain whatever is already queued, then exit
                        for {
                                select {
                                case b := <-p.queue:
                                        p.Process(p.baseCtx, b)
                                default:
                                        return
                                }
                        }
                case b := <-p.queue:
                        p.Process(p.baseCtx, b)
                }
        }
}

// Stop stops accepting work, drains the bounded queue and waits for workers
// (bounded by ctx). A nil-safe no-op when Start was never called.
func (p *Pipeline) Stop(ctx context.Context) error {
        p.mu.Lock()
        if !p.stopping {
                p.stopping = true
                close(p.stopCh)
        }
        p.mu.Unlock()

        done := make(chan struct{})
        go func() {
                p.wg.Wait()
                close(done)
        }()
        select {
        case <-done:
                if p.cancel != nil {
                        p.cancel()
                }
                p.log.Info("pipeline drained", "queue_remaining", p.Depth())
                return nil
        case <-ctx.Done():
                if p.cancel != nil {
                        p.cancel() // force workers out of in-flight work
                }
                return ctx.Err()
        }
}

// Process runs one batch through rules -> correlation -> status updates.
// It is idempotent: events already PROCESSED are skipped. Exported for
// deterministic tests and synchronous ingestion paths.
func (p *Pipeline) Process(ctx context.Context, batch []*event.Event) error {
        if len(batch) == 0 {
                // Empty tick: still evaluate time-window rules (e.g. validation
                // failure threshold) against the store.
                if _, err := p.engage(ctx, nil); err != nil {
                        return err
                }
                return nil
        }
        live := make([]*event.Event, 0, len(batch))
        for _, ev := range batch {
                cur, err := p.st.GetEvent(ctx, ev.EventID)
                if err == store.ErrNotFound {
                        continue // deleted (e.g. retention) — nothing to do
                }
                if err != nil {
                        return err
                }
                if cur.Status == "PROCESSED" {
                        continue // idempotent skip
                }
                live = append(live, ev)
        }
        if len(live) == 0 {
                return nil
        }
        snapshot := make([]event.Event, 0, len(live))
        for _, ev := range live {
                snapshot = append(snapshot, *ev)
        }
        detections, err := p.engage(ctx, snapshot)
        if err != nil {
                return err
        }
        _ = detections
        now := time.Now().UTC()
        for _, ev := range live {
                latency := now.Sub(ev.IngestTime).Milliseconds()
                if latency < 0 {
                        latency = 0
                }
                if err := p.st.SetEventProcessed(ctx, ev.EventID, latency, now); err != nil {
                        p.log.Error("set event processed failed", "event_id", ev.EventID, "err", err.Error())
                        continue
                }
                p.mtr.IncProcessed(1)
                p.publishEvent(ev)
        }
        return nil
}

// engage evaluates rules, correlates detections and emits SSE.
func (p *Pipeline) engage(ctx context.Context, batch []event.Event) ([]store.Detection, error) {
        results, err := p.eng.EvaluateBatch(ctx, batch)
        if err != nil {
                return nil, err
        }
        var out []store.Detection
        for i := range results {
                res := results[i]
                det := res.Detection
                inc, created, err := p.corr.Correlate(ctx, &det, res.Matched)
                if err != nil {
                        p.log.Error("correlation failed", "detection_id", det.ID, "err", err.Error())
                        continue
                }
                out = append(out, det)
                p.hub.Publish(sse.ChannelDetectionNew, detectionPayload(&det))
                if created {
                        p.hub.Publish(sse.ChannelIncidentNew, incidentPayload(inc))
                } else {
                        p.hub.Publish(sse.ChannelIncidentUpdate, incidentPayload(inc))
                }
        }
        return out, nil
}

func (p *Pipeline) publishEvent(ev *event.Event) {
        actor := (*string)(nil)
        if ev.Actor != "" {
                a := ev.Actor
                actor = &a
        }
        p.hub.Publish(sse.ChannelEventNew, sse.LiveEventPayload{
                ID:        ev.EventID,
                EventTime: sse.FormatTime(ev.EventTime),
                Severity:  ev.Severity,
                Category:  ev.Category,
                SourceID:  ev.SourceID,
                Actor:     actor,
                Message:   sse.TruncateMessage(ev.Message, 140),
                Origin:    ev.Origin,
        })
}

func detectionPayload(d *store.Detection) sse.DetectionPayload {
        incidentID := (*string)(nil)
        if d.IncidentID != "" {
                s := d.IncidentID
                incidentID = &s
        }
        return sse.DetectionPayload{
                ID:         d.ID,
                RuleID:     d.RuleID,
                EventID:    d.EventID,
                IncidentID: incidentID,
                Severity:   d.Severity,
                Score:      d.Score,
                Title:      d.Title,
                CreatedAt:  sse.FormatTime(d.CreatedAt),
        }
}

func incidentPayload(inc *store.Incident) sse.IncidentPayload {
        return sse.IncidentPayload{
                ID:             inc.ID,
                Title:          inc.Title,
                Severity:       inc.Severity,
                Status:         inc.Status,
                RuleID:         inc.RuleID,
                EventCount:     inc.EventCount,
                DetectionCount: inc.DetectionCount,
                UpdatedAt:      sse.FormatTime(inc.UpdatedAt),
        }
}
