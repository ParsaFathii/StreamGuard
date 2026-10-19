// Copyright © 2026 Parsa Fathii — Apache-2.0

// Package ml implements the deterministic anomaly detection methods:
// EWMA baselines (alpha 0.3, z > 3) and a seeded Isolation Forest
// (100 trees, subsample 64, depth 8, threshold 0.61), plus the reproducible
// labeled evaluation (seed 42) comparing rules / zscore / iforest.
package ml

import (
        "math"
        "sort"
        "time"

        "github.com/ParsaFathii/StreamGuard/services/ingestor/internal/event"
        "github.com/ParsaFathii/StreamGuard/services/ingestor/internal/store"
)

// Model constants (documented, tunable via code only).
const (
        ModelVersion    = "iforest-go-1.2.0"
        Method          = "Isolation Forest + EWMA z-score"
        Alpha           = 0.3
        ZThreshold      = 3.0
        IForestThresh   = 0.61
        NumTrees        = 100
        Subsample       = 64
        MaxDepth        = 8
        EvalSeed        = 42
        minSigma        = 0.5 // floor for EWMA sigma so constant rates don't explode
        eulerGamma      = 0.5772156649015329
)

// SeverityWeight maps severity to a numeric weight.
func SeverityWeight(s string) float64 {
        switch s {
        case "low":
                return 1
        case "medium":
                return 2
        case "high":
                return 3
        case "critical":
                return 4
        default:
                return 0
        }
}

// Bucket is one (source, minute) feature row.
type Bucket struct {
        BucketStart       time.Time
        SourceID          string
        Rate              float64 // events in the minute
        ErrorRatio        float64 // fraction error-like
        FailedAuthRatio   float64 // fraction failed auth
        UniqueActors      float64
        AvgSeverityWeight float64
}

// BucketsFromEvents groups events into (source, minute) feature buckets.
// Only events at or after `since` are considered.
func BucketsFromEvents(evs []event.Event, since time.Time) []Bucket {
        type key struct {
                src string
                min time.Time
        }
        acc := make(map[key]*struct {
                count, errors, failed int
                actors                map[string]bool
                sevSum                float64
        })
        for i := range evs {
                e := &evs[i]
                if e.EventTime.Before(since) {
                        continue
                }
                k := key{e.SourceID, e.EventTime.Truncate(time.Minute)}
                a := acc[k]
                if a == nil {
                        a = &struct {
                                count, errors, failed int
                                actors                map[string]bool
                                sevSum                float64
                        }{actors: make(map[string]bool)}
                        acc[k] = a
                }
                a.count++
                a.sevSum += SeverityWeight(e.Severity)
                if e.IsErrorLike() {
                        a.errors++
                }
                if e.Category == "auth" && e.Attr("action") == "login_failed" {
                        a.failed++
                }
                if e.Actor != "" {
                        a.actors[e.Actor] = true
                }
        }
        out := make([]Bucket, 0, len(acc))
        for k, a := range acc {
                out = append(out, Bucket{
                        BucketStart:       k.min,
                        SourceID:          k.src,
                        Rate:              float64(a.count),
                        ErrorRatio:        float64(a.errors) / float64(a.count),
                        FailedAuthRatio:   float64(a.failed) / float64(a.count),
                        UniqueActors:      float64(len(a.actors)),
                        AvgSeverityWeight: a.sevSum / float64(a.count),
                })
        }
        sort.Slice(out, func(i, j int) bool {
                if !out[i].BucketStart.Equal(out[j].BucketStart) {
                        return out[i].BucketStart.Before(out[j].BucketStart)
                }
                return out[i].SourceID < out[j].SourceID
        })
        return out
}

// Features converts a bucket to the model feature vector.
func (b Bucket) Features() []float64 {
        return []float64{b.Rate, b.ErrorRatio, b.FailedAuthRatio, b.UniqueActors, b.AvgSeverityWeight}
}

// ---- EWMA baseline ----

// EwmaBaseline tracks an exponentially weighted mean and deviation
// (sigma = EWMA of |x - mean|). Update returns the z-score of x.
type EwmaBaseline struct {
        mean  float64
        sigma float64
        init  bool
}

// Update folds x in and returns its z-score. The z-score is computed
// against the PRIOR baseline (baseline = EWMA, sigma = EWMA of |dev|),
// matching z_t = (r_t - baseline_t-1) / sigma_t-1.
func (b *EwmaBaseline) Update(x float64) float64 {
        if !b.init {
                b.mean = x
                b.sigma = minSigma
                b.init = true
                return 0
        }
        z := (x - b.mean) / b.sigma
        dev := math.Abs(x - b.mean)
        b.sigma = Alpha*dev + (1-Alpha)*b.sigma
        if b.sigma < minSigma {
                b.sigma = minSigma
        }
        b.mean = Alpha*x + (1-Alpha)*b.mean
        return z
}

// Mean returns the current EWMA mean.
func (b *EwmaBaseline) Mean() float64 { return b.mean }

// Sigma returns the current deviation estimate.
func (b *EwmaBaseline) Sigma() float64 {
        if b.sigma < minSigma {
                return minSigma
        }
        return b.sigma
}

// ---- Isolation Forest ----

type iNode struct {
        size int // points in this node (leaves only, for the c(size) adjustment)
        feature int
        thr     float64
        left    *iNode
        right   *iNode
        leaf    bool
}

// IForest is a seeded Isolation Forest.
type IForest struct {
        trees    []*iNode
        subLen   int // rows per tree actually used
        fitted   bool
}

// NewIForest creates an unfitted forest.
func NewIForest() *IForest { return &IForest{} }

func c(n int) float64 {
        if n <= 1 {
                return 1
        }
        return 2*(math.Log(float64(n-1))+eulerGamma) - 2*float64(n-1)/float64(n)
}

func buildTree(rows [][]float64, rng *randSource, depth int) *iNode {
        if depth >= MaxDepth || len(rows) <= 1 {
                return &iNode{leaf: true, size: len(rows)}
        }
        dim := 0
        if len(rows) > 0 && len(rows[0]) > 0 {
                dim = len(rows[0])
        }
        // find features with a splittable range
        for attempt := 0; attempt < dim*2; attempt++ {
                f := rng.Intn(dim)
                lo, hi := math.Inf(1), math.Inf(-1)
                for _, r := range rows {
                        if r[f] < lo {
                                lo = r[f]
                        }
                        if r[f] > hi {
                                hi = r[f]
                        }
                }
                if hi > lo {
                        thr := lo + rng.Float64()*(hi-lo)
                        var left, right [][]float64
                        for _, r := range rows {
                                if r[f] < thr {
                                        left = append(left, r)
                                } else {
                                        right = append(right, r)
                                }
                        }
                        if len(left) == 0 || len(right) == 0 {
                                continue
                        }
                        return &iNode{feature: f, thr: thr,
                                left:  buildTree(left, rng, depth+1),
                                right: buildTree(right, rng, depth+1)}
                }
        }
        return &iNode{leaf: true, size: len(rows)}
}

func pathLen(n *iNode, row []float64, depth int) float64 {
        if n.leaf {
                if n.size <= 1 {
                        return float64(depth)
                }
                // standard adjustment: an unsuccessfully isolated group of
                // size>1 contributes c(size) beyond the current depth —
                // without this, duplicate/near-duplicate points (constant
                // features) get artificially short paths and everything
                // scores "anomalous" (found by the labeled evaluation).
                return float64(depth) + c(n.size)
        }
        if row[n.feature] < n.thr {
                return pathLen(n.left, row, depth+1)
        }
        return pathLen(n.right, row, depth+1)
}

// Fit builds NumTrees trees on random subsamples (deterministic via seed).
func (f *IForest) Fit(rows [][]float64, seed int64) {
        if len(rows) == 0 {
                return
        }
        rng := newRandSource(seed)
        n := Subsample
        if len(rows) < n {
                n = len(rows)
        }
        f.subLen = n
        f.trees = make([]*iNode, 0, NumTrees)
        for t := 0; t < NumTrees; t++ {
                sample := make([][]float64, n)
                // partial Fisher-Yates on a copy of indices (without replacement)
                idx := make([]int, len(rows))
                for i := range idx {
                        idx[i] = i
                }
                for i := 0; i < n; i++ {
                        j := i + rng.Intn(len(idx)-i)
                        idx[i], idx[j] = idx[j], idx[i]
                        sample[i] = rows[idx[i]]
                }
                f.trees = append(f.trees, buildTree(sample, rng, 0))
        }
        f.fitted = true
}

// Score returns the isolation score 2^(-E(h)/c(n)); higher = more anomalous.
func (f *IForest) Score(row []float64) float64 {
        if !f.fitted || len(f.trees) == 0 {
                return 0
        }
        var sum float64
        for _, t := range f.trees {
                sum += pathLen(t, row, 0)
        }
        avg := sum / float64(len(f.trees))
        return math.Pow(2, -avg/c(f.subLen))
}

// Fitted reports whether the forest has been trained.
func (f *IForest) Fitted() bool { return f.fitted }

// ---- evaluation ----

// LabeledRow is a feature row with ground truth.
type LabeledRow struct {
        Bucket Bucket
        Label  bool
}

// MethodPredictions returns the per-method anomaly predictions for a row.
// The rules method approximates SG-RULE-001/002/004 at minute-bucket
// granularity (documented).
func rulesFire(b Bucket) bool {
        failedAuth := b.FailedAuthRatio * b.Rate
        if failedAuth >= 5 {
                return true
        }
        if b.Rate > 120 {
                return true
        }
        if b.ErrorRatio > 0.30 && b.Rate >= 20 {
                return true
        }
        return false
}

// EvaluateScores scores each labeled row with all three methods.
type Scores struct {
        Rules   bool
        ZScore  float64
        IForest float64
}

// Evaluate runs the three methods over the labeled rows and computes
// precision/recall/F1/FPR + confusion per method. Deterministic (seed 42).
func Evaluate(rows []LabeledRow) map[string]store.MlMethodMetrics {
        // z-score per source over time
        zscores := make([]float64, len(rows))
        baselines := make(map[string]*EwmaBaseline)
        for i, r := range rows {
                b := baselines[r.Bucket.SourceID]
                if b == nil {
                        b = &EwmaBaseline{}
                        baselines[r.Bucket.SourceID] = b
                }
                zscores[i] = b.Update(r.Bucket.Rate)
        }
        // isolation forest over all feature rows
        forest := NewIForest()
        feats := make([][]float64, len(rows))
        for i, r := range rows {
                feats[i] = r.Bucket.Features()
        }
        forest.Fit(feats, EvalSeed)

        methods := []string{"rules", "zscore", "iforest"}
        counts := make(map[string]*store.MlMethodMetrics)
        for _, m := range methods {
                counts[m] = &store.MlMethodMetrics{}
        }
        for i, r := range rows {
                isAnomaly := map[string]bool{
                        "rules":   rulesFire(r.Bucket),
                        "zscore":  zscores[i] > ZThreshold,
                        "iforest": forest.Score(feats[i]) > IForestThresh,
                }
                for _, m := range methods {
                        mc := counts[m]
                        switch {
                        case r.Label && isAnomaly[m]:
                                mc.TP++
                        case !r.Label && isAnomaly[m]:
                                mc.FP++
                        case !r.Label && !isAnomaly[m]:
                                mc.TN++
                        default:
                                mc.FN++
                        }
                }
        }
        out := make(map[string]store.MlMethodMetrics)
        for m, mc := range counts {
                out[m] = finalize(*mc)
        }
        return out
}

func finalize(mc store.MlMethodMetrics) store.MlMethodMetrics {
        tp, fp, tn, fn := float64(mc.TP), float64(mc.FP), float64(mc.TN), float64(mc.FN)
        precision := 0.0
        if tp+fp > 0 {
                precision = tp / (tp + fp)
        }
        recall := 0.0
        if tp+fn > 0 {
                recall = tp / (tp + fn)
        }
        f1 := 0.0
        if precision+recall > 0 {
                f1 = 2 * precision * recall / (precision + recall)
        }
        fpr := 0.0
        if fp+tn > 0 {
                fpr = fp / (fp + tn)
        }
        mc.Precision = round4(precision)
        mc.Recall = round4(recall)
        mc.F1 = round4(f1)
        mc.FPR = round4(fpr)
        return mc
}

func round4(v float64) float64 {
        if math.IsNaN(v) || math.IsInf(v, 0) {
                return 0
        }
        return math.Round(v*10000) / 10000
}
