// Copyright © 2026 Parsa Fathi — Apache-2.0

// Analytics: overview counters, zero-filled timeseries, the ML view
// (anomaly timeline + baselines + last evaluation) and the reproducible
// labeled ML evaluation (seed 42).
package api

import (
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/ml"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/sim"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/sse"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/store"
)

// handleOverview implements GET /api/analytics/overview.
func (s *Server) handleOverview(w http.ResponseWriter, r *http.Request, _ *store.Session, _ *store.User) {
	ctx := r.Context()
	now := s.Now()

	events24h, _ := s.st.CountEventsSince(ctx, now.Add(-24*time.Hour))
	events7d, _ := s.st.CountEventsSince(ctx, now.Add(-7*24*time.Hour))
	byRule, _ := s.st.DetectionCountsByRuleSince(ctx, now.Add(-24*time.Hour))
	var detections24h int64
	for _, n := range byRule {
		detections24h += n
	}
	open, incidents24h, _ := s.st.IncidentCounts(ctx, now)
	vfs, _ := s.st.ListValidationFailuresSince(ctx, now.Add(-24*time.Hour), 1000000)
	rejected24h := int64(len(vfs))

	minuteBuckets, _ := s.st.MinuteCounts(ctx, "events", now.Add(-60*time.Minute))
	ratePerMin := fillMinutes(minuteBuckets, now, 60, func(t time.Time) string {
		return sse.FormatTime(t)
	})

	sevMap, _ := s.st.SeverityBreakdownSince(ctx, now.Add(-24*time.Hour))
	catMap, _ := s.st.CategoryBreakdownSince(ctx, now.Add(-24*time.Hour))
	topSources, _ := s.st.TopSourcesSince(ctx, now.Add(-24*time.Hour), 8)
	avg, p95, last, _ := s.st.LatencyStatsSince(ctx, now.Add(-24*time.Hour))

	depth := 0
	if s.pipe != nil {
		depth = s.pipe.Depth()
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"totals": map[string]any{
			"events24h":     events24h,
			"events7d":      events7d,
			"detections24h": detections24h,
			"incidentsOpen": open,
			"incidents24h":  incidents24h,
			"rejected24h":   rejected24h,
			// Process-local counter (resets on restart) — duplicates are not
			// persisted as rows; documented in README.
			"duplicates24h": s.mtr.Duplicates(),
		},
		"ingestRatePerMin":     ratePerMin,
		"severityBreakdown24h": zeroFill(sevMap, []string{"info", "low", "medium", "high", "critical"}),
		"categoryBreakdown24h": zeroFill(catMap, []string{"auth", "network", "application", "data", "system", "config", "security"}),
		"topSources24h":        topSourceViews(topSources),
		"processing": map[string]any{
			"avgLatencyMs24h": avg,
			"p95LatencyMs24h": p95,
			"lastProcessedAt": jsonTime(last),
		},
		"health": map[string]any{
			"db":         dbState(s.st.Ping(ctx)),
			"ws":         "up",
			"llm":        s.llmStatus(),
			"queueDepth": depth,
		},
	})
}

func dbState(err error) string {
	if err != nil {
		return "down"
	}
	return "up"
}

type minutePoint struct {
	Minute string `json:"minute"`
	Count  int64  `json:"count"`
}

// fillMinutes renders n buckets ending at now, zero-filled, oldest first.
func fillMinutes(counts []store.MinuteCount, now time.Time, n int, fmt func(time.Time) string) []minutePoint {
	byMin := make(map[time.Time]int64, len(counts))
	for _, mc := range counts {
		byMin[mc.Minute.UTC()] = mc.Count
	}
	base := now.Truncate(time.Minute).UTC()
	out := make([]minutePoint, 0, n)
	for i := n - 1; i >= 0; i-- {
		t := base.Add(-time.Duration(i) * time.Minute)
		out = append(out, minutePoint{Minute: fmt(t), Count: byMin[t]})
	}
	return out
}

func zeroFill(m map[string]int64, keys []string) map[string]int64 {
	out := make(map[string]int64, len(keys))
	for _, k := range keys {
		out[k] = m[k]
	}
	return out
}

type topSourceView struct {
	SourceID string `json:"sourceId"`
	Count    int64  `json:"count"`
}

func topSourceViews(srcs []store.SourceCount) []topSourceView {
	out := make([]topSourceView, 0, len(srcs))
	for _, sc := range srcs {
		out = append(out, topSourceView{SourceID: sc.SourceID, Count: sc.Count})
	}
	return out
}

// handleTimeseries implements GET /api/analytics/timeseries.
func (s *Server) handleTimeseries(w http.ResponseWriter, r *http.Request, _ *store.Session, _ *store.User) {
	q := r.URL.Query()
	metric := q.Get("metric")
	if metric == "" {
		metric = "events"
	}
	switch metric {
	case "events", "detections", "rejected":
	default:
		badFilter(w, "metric", "must be one of events|detections|rejected")
		return
	}
	bucket := q.Get("bucket")
	if bucket == "" {
		bucket = "minute"
	}
	if bucket != "minute" {
		badFilter(w, "bucket", "only minute buckets are supported")
		return
	}
	points := 60
	if v := q.Get("points"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 1440 {
			badFilter(w, "points", "must be an integer in 1..1440")
			return
		}
		points = n
	}

	now := s.Now()
	since := now.Add(-time.Duration(points) * time.Minute)
	var buckets map[time.Time]int64
	switch metric {
	case "rejected":
		// Validation failures are the durable rejection record (rejected
		// events are never stored as event rows; see README).
		vfs, err := s.st.ListValidationFailuresSince(r.Context(), since, 1000000)
		if err != nil {
			s.internalError(w, r, "rejected series", err)
			return
		}
		buckets = make(map[time.Time]int64, len(vfs))
		for _, vf := range vfs {
			buckets[vf.TS.Truncate(time.Minute).UTC()]++
		}
	default:
		mcs, err := s.st.MinuteCounts(r.Context(), metric, since)
		if err != nil {
			s.internalError(w, r, metric+" series", err)
			return
		}
		buckets = make(map[time.Time]int64, len(mcs))
		for _, mc := range mcs {
			buckets[mc.Minute.UTC()] = mc.Count
		}
	}

	base := now.Truncate(time.Minute).UTC()
	type point struct {
		BucketStart string `json:"bucketStart"`
		Value       int64  `json:"value"`
	}
	out := make([]point, 0, points)
	for i := points - 1; i >= 0; i-- {
		t := base.Add(-time.Duration(i) * time.Minute)
		out = append(out, point{BucketStart: sse.FormatTime(t), Value: buckets[t]})
	}
	writeJSON(w, http.StatusOK, out) // bare array per contract
}

// ---------------------------------------------------------------- ml view

type anomalyRow struct {
	BucketStart       string  `json:"bucketStart"`
	SourceID          string  `json:"sourceId"`
	Rate              float64 `json:"rate"`
	ErrorRatio        float64 `json:"errorRatio"`
	FailedAuthRatio   float64 `json:"failedAuthRatio"`
	UniqueActors      float64 `json:"uniqueActors"`
	AvgSeverityWeight float64 `json:"avgSeverityWeight"`
	Zscore            float64 `json:"zscore"`
	IforestScore      float64 `json:"iforestScore"`
	IsAnomaly         bool    `json:"isAnomaly"`
}

type baselineRow struct {
	SourceID    string  `json:"sourceId"`
	EwmaRate    float64 `json:"ewmaRate"`
	Stddev      float64 `json:"stddev"`
	CurrentRate float64 `json:"currentRate"`
	Zscore      float64 `json:"zscore"`
	Status      string  `json:"status"`
}

type methodMetricsView struct {
	Precision float64        `json:"precision"`
	Recall    float64        `json:"recall"`
	F1        float64        `json:"f1"`
	FPR       float64        `json:"fpr"`
	Confusion map[string]int `json:"confusion"`
}

type mlEvalView struct {
	TS          string                       `json:"ts"`
	DatasetSize int                          `json:"datasetSize"`
	Methods     map[string]methodMetricsView `json:"metrics"`
}

// handleMlView implements GET /api/analytics/ml.
func (s *Server) handleMlView(w http.ResponseWriter, r *http.Request, _ *store.Session, _ *store.User) {
	ctx := r.Context()
	now := s.Now()
	since := now.Add(-120 * time.Minute)

	evs, err := s.st.QueryEvents(ctx, store.EventQuery{Since: since, Until: now.Add(10 * time.Minute), Limit: 5000})
	if err != nil {
		s.internalError(w, r, "ml events", err)
		return
	}
	buckets := ml.BucketsFromEvents(evs, since)

	// Forest over all features (deterministic, seed 42).
	feats := make([][]float64, 0, len(buckets))
	for _, b := range buckets {
		feats = append(feats, b.Features())
	}
	forest := ml.NewIForest()
	forest.Fit(feats, ml.EvalSeed)

	// Per-source EWMA baselines (rows are time-ordered).
	bySource := make(map[string][]ml.Bucket)
	for _, b := range buckets {
		bySource[b.SourceID] = append(bySource[b.SourceID], b)
	}
	srcs := make([]string, 0, len(bySource))
	for src := range bySource {
		srcs = append(srcs, src)
	}
	sort.Strings(srcs)

	timeline := make([]anomalyRow, 0, len(buckets))
	baselines := make([]baselineRow, 0, len(srcs))
	for _, src := range srcs {
		rows := bySource[src]
		bl := &ml.EwmaBaseline{}
		var lastZ float64
		var lastBucket ml.Bucket
		for _, b := range rows {
			z := bl.Update(b.Rate)
			lastZ = z
			lastBucket = b
			score := forest.Score(b.Features())
			timeline = append(timeline, anomalyRow{
				BucketStart: sse.FormatTime(b.BucketStart), SourceID: b.SourceID,
				Rate: b.Rate, ErrorRatio: b.ErrorRatio, FailedAuthRatio: b.FailedAuthRatio,
				UniqueActors: b.UniqueActors, AvgSeverityWeight: b.AvgSeverityWeight,
				Zscore: round2(z), IforestScore: round2(score),
				IsAnomaly: score > ml.IForestThresh || z > ml.ZThreshold,
			})
		}
		status := "normal"
		switch {
		case lastZ > ml.ZThreshold:
			status = "anomalous"
		case lastZ > 2:
			status = "elevated"
		}
		baselines = append(baselines, baselineRow{
			SourceID: src, EwmaRate: round2(bl.Mean()), Stddev: round2(bl.Sigma()),
			CurrentRate: round2(lastBucket.Rate), Zscore: round2(lastZ), Status: status,
		})
	}

	// last evaluation
	var lastEval *mlEvalView
	if run, err := s.st.LastMlRun(ctx); err == nil {
		lastEval = evalView(run)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"modelVersion":     ml.ModelVersion,
		"method":           ml.Method,
		"anomalyTimeline":  timeline,
		"currentBaselines": baselines,
		"lastEvaluation":   lastEval,
	})
}

func evalView(run *store.MlRun) *mlEvalView {
	methods := make(map[string]methodMetricsView, len(run.Methods))
	for name, m := range run.Methods {
		methods[name] = methodMetricsView{
			Precision: m.Precision, Recall: m.Recall, F1: m.F1, FPR: m.FPR,
			Confusion: map[string]int{"tp": m.TP, "fp": m.FP, "tn": m.TN, "fn": m.FN},
		}
	}
	return &mlEvalView{
		TS: sse.FormatTime(run.TS), DatasetSize: run.DatasetSize, Methods: methods,
	}
}

func round2(v float64) float64 {
	if v < 0 {
		return v
	}
	return float64(int64(v*100+0.5)) / 100
}

// handleMlEvaluate implements POST /api/analytics/ml/evaluate (ANALYST+).
// Deterministic: sim.LabeledDataset seed 42, 120 minutes.
func (s *Server) handleMlEvaluate(w http.ResponseWriter, r *http.Request, _ *store.Session, _ *store.User) {
	labeled := sim.LabeledDataset(ml.EvalSeed, 120)
	rows := make([]ml.LabeledRow, 0, len(labeled))
	anomalies, normal := 0, 0
	for _, b := range labeled {
		fb := ml.BucketsFromEvents(b.Events, b.BucketStart)
		if len(fb) != 1 {
			continue
		}
		rows = append(rows, ml.LabeledRow{Bucket: fb[0], Label: b.Anomaly})
		if b.Anomaly {
			anomalies++
		} else {
			normal++
		}
	}
	methods := ml.Evaluate(rows)
	run := &store.MlRun{
		TS: s.Now(), Seed: ml.EvalSeed, DatasetSize: len(rows), Methods: methods,
	}
	run.DatasetInfo.Label = "sim.LabeledDataset seed=42 minutes=120 (3 sources, injected bursts)"
	run.DatasetInfo.Anomalies = anomalies
	run.DatasetInfo.Normal = normal
	if err := s.st.SaveMlRun(r.Context(), run); err != nil {
		s.internalError(w, r, "save ml run", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ts":          sse.FormatTime(run.TS),
		"seed":        run.Seed,
		"datasetSize": run.DatasetSize,
		"dataset": map[string]any{
			"label":     run.DatasetInfo.Label,
			"anomalies": run.DatasetInfo.Anomalies,
			"normal":    run.DatasetInfo.Normal,
		},
		"methods": evalView(run).Methods,
	})
}
