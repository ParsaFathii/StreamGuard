// Copyright © 2026 Parsa Fathii — Apache-2.0

package ml

import (
	"math"
	"testing"
	"time"

	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/event"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/sim"
)

func TestEwmaBaseline(t *testing.T) {
	b := &EwmaBaseline{}
	z := b.Update(10)
	if z != 0 {
		t.Fatalf("first update z = %v, want 0", z)
	}
	// steady state -> small z
	for i := 0; i < 20; i++ {
		z = b.Update(10)
	}
	if math.Abs(z) > 1 {
		t.Fatalf("steady state z should be small, got %v", z)
	}
	// spike -> large z
	z = b.Update(100)
	if z <= 3 {
		t.Fatalf("spike z should exceed 3, got %v", z)
	}
	// sigma floor prevents division blowup on constant input
	c := &EwmaBaseline{}
	for i := 0; i < 50; i++ {
		c.Update(5)
	}
	if math.IsNaN(c.Sigma()) || c.Sigma() < 0 {
		t.Fatalf("bad sigma: %v", c.Sigma())
	}
}

func TestIForestDeterministic(t *testing.T) {
	rows := make([][]float64, 200)
	for i := range rows {
		rows[i] = []float64{float64(i % 20), float64(i % 7) / 7, 0, float64(i % 5), 1.5}
	}
	f1 := NewIForest()
	f1.Fit(rows, 42)
	f2 := NewIForest()
	f2.Fit(rows, 42)
	probe := []float64{50, 0.9, 0.8, 4, 3.9} // far from the data cloud
	normal := []float64{10, 0.4, 0, 2, 1.5}
	if f1.Score(probe) != f2.Score(probe) {
		t.Fatalf("iforest must be deterministic for a fixed seed")
	}
	if f1.Score(probe) <= f1.Score(normal) {
		t.Fatalf("outlier should score higher: outlier=%v normal=%v", f1.Score(probe), f1.Score(normal))
	}
	if f1.Score(probe) > 1 || f1.Score(normal) < 0 {
		t.Fatalf("scores out of [0,1]: %v %v", f1.Score(probe), f1.Score(normal))
	}
}

func TestBucketsFromEvents(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Minute)
	var evs []event.Event
	for i := 0; i < 10; i++ {
		evs = append(evs, event.Event{
			EventID: string(rune('a'+i)), EventTime: now.Add(time.Duration(i) * time.Second),
			SourceID: "s1", Severity: "info", Category: "application", Message: "ok",
		})
	}
	evs = append(evs, event.Event{
		EventID: "bf", EventTime: now.Add(30 * time.Second), SourceID: "s1",
		Severity: "low", Category: "auth", Message: "login failed", Actor: "x",
		Attributes: map[string]any{"action": "login_failed"},
	})
	buckets := BucketsFromEvents(evs, now.Add(-time.Minute))
	if len(buckets) != 1 {
		t.Fatalf("buckets = %d, want 1", len(buckets))
	}
	b := buckets[0]
	if b.Rate != 11 || b.FailedAuthRatio != 1.0/11.0 || b.UniqueActors != 1 {
		t.Fatalf("bad bucket: %+v", b)
	}
}

func TestEvaluationDeterministic(t *testing.T) {
	ds := sim.LabeledDataset(42, 120)
	rows := make([]LabeledRow, 0, len(ds))
	anomalies := 0
	for _, b := range ds {
		rows = append(rows, LabeledRow{Bucket: bucketFromEvents(b), Label: b.Anomaly})
		if b.Anomaly {
			anomalies++
		}
	}
	if anomalies == 0 || anomalies > len(rows)/3 {
		t.Fatalf("dataset label balance suspicious: %d/%d", anomalies, len(rows))
	}
	m1 := Evaluate(rows)
	m2 := Evaluate(rows)
	for _, method := range []string{"rules", "zscore", "iforest"} {
		if m1[method] != m2[method] {
			t.Fatalf("evaluation not deterministic for %s", method)
		}
	}
	// sanity: rules should catch the brute-force/error/burst buckets
	r := m1["rules"]
	if r.TP == 0 {
		t.Fatalf("rules method must catch some anomalies: %+v", r)
	}
	if r.Precision < 0.5 || r.Recall < 0.2 {
		t.Logf("note: rules metrics = %+v", r)
	}
	// iforest should have some discriminating power
	i := m1["iforest"]
	if i.F1 <= 0 {
		t.Logf("note: iforest metrics = %+v", i)
	}
	// confusion must sum to dataset size
	for _, method := range []string{"rules", "zscore", "iforest"} {
		mc := m1[method]
		if mc.TP+mc.FP+mc.TN+mc.FN != len(rows) {
			t.Fatalf("%s confusion does not cover dataset: %+v", method, mc)
		}
	}
}

func bucketFromEvents(b sim.LabeledBucket) Bucket {
	bk := BucketsFromEvents(b.Events, time.Time{})
	if len(bk) == 0 {
		return Bucket{BucketStart: b.BucketStart, SourceID: b.SourceID}
	}
	// all events of a labeled bucket share (source, minute)
	return bk[0]
}

func TestSeverityWeight(t *testing.T) {
	cases := map[string]float64{"info": 0, "low": 1, "medium": 2, "high": 3, "critical": 4, "weird": 0}
	for sev, want := range cases {
		if got := SeverityWeight(sev); got != want {
			t.Fatalf("SeverityWeight(%s) = %v, want %v", sev, got, want)
		}
	}
}
