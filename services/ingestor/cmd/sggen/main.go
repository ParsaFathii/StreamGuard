// Copyright © 2026 Parsa Fathi — Apache-2.0

// Command sggen is the deterministic StreamGuard event generator CLI: it
// produces events with internal/sim and POSTs them to /api/ingest using
// X-Ingest-Key. Exit codes: 0 all accepted fresh, 1 partial (duplicates or
// rejections), 2 transport/protocol error.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/sim"
)

const hardBatchCap = 100 // contract limit per request

func main() {
	scenario := flag.String("scenario", "", "scenario id (required; see --list)")
	list := flag.Bool("list", false, "list available scenarios and exit")
	count := flag.Int("count", 0, "events to generate (0 = scenario default)")
	seed := flag.Int64("seed", 42, "deterministic seed (same seed => same event ids)")
	url := flag.String("url", "http://127.0.0.1:8080", "ingestor base URL")
	key := flag.String("key", "sg-demo-ingest-key-2026", "X-Ingest-Key value")
	interval := flag.Int("interval-ms", 0, "repeat every N ms (0 = single run); seed increments per iteration")
	timeout := flag.Int("timeout-ms", 15000, "per-request timeout in ms")
	flag.Parse()

	if *list || *scenario == "" {
		fmt.Println("scenarios:")
		for _, sc := range sim.Scenarios() {
			mark := strings.Join(sc.ExpectedDetections, ",")
			if mark == "" {
				mark = "-"
			}
			fmt.Printf("  %-22s %s (expectedDetections: %s)\n", sc.ID, sc.Name, mark)
		}
		if *scenario == "" && !*list {
			fmt.Fprintln(os.Stderr, "--scenario is required (use --list to see options)")
			os.Exit(2)
		}
		return
	}
	if _, ok := sim.GetScenario(*scenario); !ok {
		fmt.Fprintf(os.Stderr, "unknown scenario %q (use --list)\n", *scenario)
		os.Exit(2)
	}

	client := &http.Client{Timeout: time.Duration(*timeout) * time.Millisecond}
	gen := newGenerator(*scenario, *count, *seed)

	total := summary{sent: 0, accepted: 0, duplicates: 0, rejected: 0}
	iterations := 1
	if *interval > 0 {
		// Repeat until interrupted; seed advances per iteration.
		for i := 0; ; i++ {
			gen.seed = *seed + int64(i)
			s, err := runOnce(client, *url, *key, gen)
			if err != nil {
				fmt.Fprintf(os.Stderr, "iteration %d failed: %v\n", i, err)
				printSummary(total, err)
			}
			total = total.add(s)
			if i%10 == 0 {
				printSummary(total, nil)
			}
			time.Sleep(time.Duration(*interval) * time.Millisecond)
			iterations++
		}
	}
	s, err := runOnce(client, *url, *key, gen)
	if err != nil {
		fmt.Fprintf(os.Stderr, "send failed: %v\n", err)
		printSummary(total, err)
		os.Exit(2)
	}
	total = total.add(s)
	_ = iterations
	printSummary(total, nil)
	switch {
	case total.rejected > 0 || total.duplicates > 0:
		os.Exit(1)
	default:
		os.Exit(0)
	}
}

type summary struct {
	sent       int
	accepted   int
	duplicates int
	rejected   int
}

func (s summary) add(o summary) summary {
	return summary{
		sent: s.sent + o.sent, accepted: s.accepted + o.accepted,
		duplicates: s.duplicates + o.duplicates, rejected: s.rejected + o.rejected,
	}
}

type generator struct {
	scenario string
	count    int
	seed     int64
}

func newGenerator(scenario string, count int, seed int64) *generator {
	if count <= 0 {
		// scenario default (mirrors the API layer's per-scenario scripts)
		count = scenarioDefault(scenario)
	}
	return &generator{scenario: scenario, count: count, seed: seed}
}

func scenarioDefault(id string) int {
	defaults := map[string]int{
		"clean_baseline": 40, "brute_force": 9, "credential_stuffing": 24, "traffic_burst": 130,
		"latency_spike": 60, "error_storm": 30, "config_change": 5, "authz_failures": 4,
		"malformed_batch": 12, "mixed_attack": 40,
	}
	if n, ok := defaults[id]; ok {
		return n
	}
	return 12
}

// runOnce generates one full scenario run and POSTs it in bounded batches.
func runOnce(client *http.Client, baseURL, key string, gen *generator) (summary, error) {
	docs, err := sim.Generate(gen.scenario, gen.seed, gen.count, time.Now().UTC())
	if err != nil {
		return summary{}, err
	}
	sum := summary{sent: len(docs)}
	for start := 0; start < len(docs); start += hardBatchCap {
		end := start + hardBatchCap
		if end > len(docs) {
			end = len(docs)
		}
		batch := docs[start:end]
		body, err := json.Marshal(map[string]any{"batch": batch})
		if err != nil {
			return sum, err
		}
		req, err := http.NewRequest(http.MethodPost, strings.TrimRight(baseURL, "/")+"/api/ingest", bytes.NewReader(body))
		if err != nil {
			return sum, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Ingest-Key", key)
		resp, err := client.Do(req)
		if err != nil {
			return sum, err
		}
		if resp.StatusCode != http.StatusAccepted {
			resp.Body.Close()
			return sum, fmt.Errorf("ingest returned %s", resp.Status)
		}
		var out struct {
			Accepted   int `json:"accepted"`
			Duplicates int `json:"duplicates"`
			Rejected   int `json:"rejected"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			resp.Body.Close()
			return sum, err
		}
		resp.Body.Close()
		sum.accepted += out.Accepted
		sum.duplicates += out.Duplicates
		sum.rejected += out.Rejected
	}
	return sum, nil
}

func printSummary(s summary, err error) {
	out := map[string]any{
		"sent":       s.sent,
		"accepted":   s.accepted,
		"duplicates": s.duplicates,
		"rejected":   s.rejected,
	}
	if err != nil {
		out["error"] = err.Error()
	}
	b, _ := json.Marshal(out)
	fmt.Println(string(b))
}
