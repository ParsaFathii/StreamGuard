// Copyright © 2026 Parsa Fathii — Apache-2.0

package pipeline

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/correlate"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/event"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/metrics"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/rules"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/sse"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/store"
)

func newPipeline(t *testing.T, cfg Config) (*Pipeline, store.Store, *metrics.Counters, *sse.Hub) {
	t.Helper()
	st := store.NewMemStore()
	if err := rules.SeedDefaults(context.Background(), st); err != nil {
		t.Fatal(err)
	}
	eng := rules.NewEngine(st, nil)
	corr := correlate.NewEngine(st, nil, nil)
	hub := sse.NewHub()
	mtr := metrics.NewCounters()
	return New(st, eng, corr, hub, mtr, nil, cfg), st, mtr, hub
}

func mkEvent(id string, offset time.Duration) *event.Event {
	return &event.Event{
		EventID: id, SchemaVersion: 1,
		EventTime: time.Now().UTC().Add(-offset), IngestTime: time.Now().UTC(),
		SourceType: "app", SourceID: "src-1", Severity: "info", Category: "system",
		Message: "m", Origin: "external", Status: "VALIDATED",
	}
}

func bruteForceBatch(prefix string, n int) []*event.Event {
	out := make([]*event.Event, 0, n)
	for i := 0; i < n; i++ {
		ev := &event.Event{
			EventID: fmt.Sprintf("%s-%d", prefix, i), SchemaVersion: 1,
			EventTime: time.Now().UTC(), IngestTime: time.Now().UTC(),
			SourceType: "app", SourceID: "prod-app-1", Severity: "low", Category: "auth",
			Message: "login failed", Actor: "attacker",
			Attributes: map[string]any{"action": "login_failed"},
			Origin: "external", Status: "VALIDATED",
		}
		out = append(out, ev)
	}
	return out
}

func waitProcessed(t *testing.T, st store.Store, n int, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		evs, total, err := st.ListEvents(context.Background(), store.EventFilter{Status: "PROCESSED"}, 1, 1000)
		_ = evs
		if err == nil && total >= n {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %d processed events", n)
}

func TestProcessMarksProcessedAndEmitsSSE(t *testing.T) {
	p, st, mtr, hub := newPipeline(t, Config{})
	p.Start(context.Background())
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = p.Stop(ctx)
	}()

	batch := bruteForceBatch("bf", 5)
	for _, ev := range batch {
		if _, err := st.InsertEvent(context.Background(), ev); err != nil {
			t.Fatal(err)
		}
	}
	sub := hub.Subscribe()
	if err := p.TryEnqueue(batch); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	waitProcessed(t, st, 5, 3*time.Second)

	// detection + incident must exist
	dets, total, err := st.ListDetections(context.Background(), store.DetectionFilter{}, 1, 10)
	if err != nil || total == 0 {
		t.Fatalf("detections: total=%d err=%v", total, err)
	}
	if dets[0].RuleID != "SG-RULE-001" {
		t.Fatalf("wrong rule: %s", dets[0].RuleID)
	}
	incidents, itotal, err := st.ListIncidents(context.Background(), store.IncidentFilter{}, "createdAt", 1, 10)
	if err != nil || itotal != 1 {
		t.Fatalf("incidents: total=%d err=%v", itotal, err)
	}
	if incidents[0].DetectionCount != 1 || incidents[0].EventCount != 5 {
		t.Fatalf("bad incident counts: %+v", incidents[0])
	}

	// SSE: expect 5 event:new + 1 detection:new + 1 incident:new
	var gotEvent, gotDetection, gotIncident bool
	deadline := time.After(2 * time.Second)
	for !(gotEvent && gotDetection && gotIncident) {
		select {
		case m := <-sub.Chan():
			switch m.Channel {
			case "event:new":
				gotEvent = true
			case "detection:new":
				gotDetection = true
			case "incident:new":
				gotIncident = true
			}
		case <-deadline:
			t.Fatalf("sse timeout: event=%v detection=%v incident=%v", gotEvent, gotDetection, gotIncident)
		}
	}
	if mtr.Processed() < 5 {
		t.Fatalf("processed counter = %d", mtr.Processed())
	}
	sub.Unsubscribe()
}

func TestDuplicateProcessingIsIdempotent(t *testing.T) {
	p, st, _, _ := newPipeline(t, Config{})
	p.Start(context.Background())
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = p.Stop(ctx)
	}()
	batch := bruteForceBatch("dup", 5)
	for _, ev := range batch {
		if _, err := st.InsertEvent(context.Background(), ev); err != nil {
			t.Fatal(err)
		}
	}
	// Same batch delivered twice (e.g. client retry after enqueue).
	if err := p.TryEnqueue(batch); err != nil {
		t.Fatal(err)
	}
	if err := p.TryEnqueue(batch); err != nil {
		t.Fatal(err)
	}
	waitProcessed(t, st, 5, 3*time.Second)
	time.Sleep(100 * time.Millisecond) // allow any duplicate work to settle
	dets, total, err := st.ListDetections(context.Background(), store.DetectionFilter{}, 1, 50)
	if err != nil {
		t.Fatal(err)
	}
	rule1 := 0
	for _, d := range dets {
		if d.RuleID == "SG-RULE-001" {
			rule1++
		}
	}
	if rule1 != 1 {
		t.Fatalf("duplicate batch re-ran detection: SG-RULE-001 count=%d (total=%d)", rule1, total)
	}
}

func TestConcurrency(t *testing.T) {
	p, st, _, _ := newPipeline(t, Config{Workers: 4})
	p.Start(context.Background())
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = p.Stop(ctx)
	}()
	const goroutines = 8
	const batchesPer = 25
	const eventsPerBatch = 5
	totalEvents := goroutines * batchesPer * eventsPerBatch
	var wg sync.WaitGroup
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for b := 0; b < batchesPer; b++ {
				batch := make([]*event.Event, 0, eventsPerBatch)
				for i := 0; i < eventsPerBatch; i++ {
					ev := mkEvent(fmt.Sprintf("c-%d-%d-%d", g, b, i), 0)
					if _, err := st.InsertEvent(context.Background(), ev); err != nil {
						t.Errorf("insert: %v", err)
						return
					}
					batch = append(batch, ev)
				}
				if err := p.TryEnqueue(batch); err != nil {
					t.Errorf("enqueue: %v", err)
					return
				}
			}
		}(g)
	}
	wg.Wait()
	waitProcessed(t, st, totalEvents, 10*time.Second)
}

func TestOverloadRejectsWhenQueueFull(t *testing.T) {
	// No Start(): nothing drains the queue, capacity 4 is deterministic.
	p, _, _, _ := newPipeline(t, Config{QueueSize: 4, Workers: 1})
	for i := 0; i < 4; i++ {
		if err := p.TryEnqueue([]*event.Event{mkEvent(fmt.Sprintf("q-%d", i), 0)}); err != nil {
			t.Fatalf("enqueue %d should succeed: %v", i, err)
		}
	}
	if err := p.TryEnqueue([]*event.Event{mkEvent("q-overflow", 0)}); err != ErrQueueFull {
		t.Fatalf("want ErrQueueFull, got %v", err)
	}
	if p.Depth() != 4 {
		t.Fatalf("depth = %d", p.Depth())
	}
}

func TestCancellationMidFlight(t *testing.T) {
	p, st, _, _ := newPipeline(t, Config{Workers: 2})
	ctx, cancel := context.WithCancel(context.Background())
	p.Start(ctx)
	// enqueue a burst then cancel immediately
	for i := 0; i < 10; i++ {
		batch := make([]*event.Event, 0, 10)
		for j := 0; j < 10; j++ {
			ev := mkEvent(fmt.Sprintf("cancel-%d-%d", i, j), 0)
			_, _ = st.InsertEvent(context.Background(), ev)
			batch = append(batch, ev)
		}
		_ = p.TryEnqueue(batch)
	}
	cancel()
	stopCtx, stopCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer stopCancel()
	if err := p.Stop(stopCtx); err != nil {
		t.Fatalf("stop after cancel: %v", err)
	}
	// Stop must be idempotent-ish (no panic, quick return).
	if err := p.Stop(stopCtx); err != nil {
		t.Logf("second stop: %v", err)
	}
	// After stopping, enqueue reports shutdown.
	if err := p.TryEnqueue([]*event.Event{mkEvent("after-stop", 0)}); err != ErrShuttingDown {
		t.Fatalf("want ErrShuttingDown, got %v", err)
	}
}

func TestGracefulDrain(t *testing.T) {
	p, st, _, _ := newPipeline(t, Config{Workers: 2})
	p.Start(context.Background())
	var enqueued atomic.Int64
	for i := 0; i < 20; i++ {
		batch := make([]*event.Event, 0, 10)
		for j := 0; j < 10; j++ {
			ev := mkEvent(fmt.Sprintf("drain-%d-%d", i, j), 0)
			if _, err := st.InsertEvent(context.Background(), ev); err != nil {
				t.Fatal(err)
			}
			batch = append(batch, ev)
		}
		if err := p.TryEnqueue(batch); err == nil {
			enqueued.Add(int64(len(batch)))
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := p.Stop(ctx); err != nil {
		t.Fatalf("drain: %v", err)
	}
	// Everything enqueued before Stop must be processed.
	_, total, _ := st.ListEvents(context.Background(), store.EventFilter{Status: "PROCESSED"}, 1, 1000)
	if int64(total) < enqueued.Load() {
		t.Fatalf("drain lost events: processed=%d enqueued=%d", total, enqueued.Load())
	}
}

func TestWorkersBounded(t *testing.T) {
	p, _, _, _ := newPipeline(t, Config{})
	if p.Workers() < 2 || p.Workers() > 16 {
		t.Fatalf("workers out of bounds: %d", p.Workers())
	}
	p2, _, _, _ := newPipeline(t, Config{Workers: 64})
	if p2.Workers() != 16 {
		t.Fatalf("workers should clamp to 16, got %d", p2.Workers())
	}
	p3, _, _, _ := newPipeline(t, Config{Workers: 1})
	if p3.Workers() != 2 {
		t.Fatalf("workers should clamp to min 2, got %d", p3.Workers())
	}
}
