// Copyright © 2026 Parsa Fathii — Apache-2.0

package ml

import "math/rand"

// randSource is a deterministic, self-owned RNG (math/rand seeded locally so
// results are reproducible across runs and processes).
type randSource struct {
	rng *rand.Rand
}

func newRandSource(seed int64) *randSource {
	return &randSource{rng: rand.New(rand.NewSource(seed))}
}

func (r *randSource) Intn(n int) int {
	if n <= 0 {
		return 0
	}
	return r.rng.Intn(n)
}

func (r *randSource) Float64() float64 { return r.rng.Float64() }
