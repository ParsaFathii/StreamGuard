<!-- Copyright © 2026 Parsa Fathi — Apache-2.0 -->

# StreamGuard Analytics (`streamguard-analytics`)

Deterministic, dependency-light (stdlib + numpy) analytics & ML package for StreamGuard:
EWMA baselines, a pure-Python Isolation Forest, labeled scenario datasets with ground
truth, a reproducible evaluation harness, an Ollama-compatible AI-investigation
provider adapter, and a stateless sidecar HTTP server.

- **Version:** 10.3.2 — **Author:** Parsa Fathi — **License:** Apache-2.0
- **Runtime deps:** `numpy>=1.26` only (no scipy/sklearn — the Isolation Forest is
  implemented from scratch; keeps the package CI-friendly and auditable)
- **Determinism:** every source of randomness is seeded (42). Same seed ⇒ bit-identical
  results across runs, machines, and process restarts (verified in CI-style repeated
  runs; see *Verification* below).

---

## 1. Package layout

| Module | Purpose |
|---|---|
| `schemas.py` | `EventRecord` (strict contract parsing, explicit `ValidationError` with per-field reasons), `FeatureVector` (the five contract features), `AnomalyPoint`, `MethodMetrics`, `EvaluationResult`, batch `parse_events` (skip-with-reason, never silent), canonical event-level feature rules |
| `baselines.py` | EWMA baseline engine (α=0.3, σ̂ = EWMA of \|dev\|, z > 3), `EWMABaselineTracker` (cold start ≥ 5 points, gap ⇒ reset + note, zero-variance ⇒ z = 0), pure `score_series` |
| `anomaly.py` | Isolation Forest: `iforest-py-1.2.0`, seed 42, 100 trees, subsample 64, depth `ceil(log2(64)) = 8`, score `2^(−E(h)/c(ψ))`, threshold **0.61** (strict `>`); deterministic bit-identical scoring |
| `datasets.py` | 9 scenario builders + 5 edge-case builders, all seeded (42), each returning `Dataset(features, labels, metadata)` with per-minute ground truth and real bucket timestamps |
| `evaluation.py` | `evaluate(method_fn, dataset)` (zero-division-safe precision/recall/F1/FPR + confusion), `compare_methods`, `evaluate_dataset`, `evaluate_all`; rules replica + z-score + iforest |
| `provider.py` | `ProviderAdapter` (Ollama-compatible, stdlib urllib): strict grounding prompt, `UNTRUSTED DATA` wrapping of event text, JSON-validated reports, honest `ProviderError` |
| `server.py` | Threaded stdlib HTTP sidecar: `/health`, `/analyze`, `/evaluate`; contract error shape; 256 KiB body cap; stateless per request |
| `__main__.py` | CLI: `evaluate` / `serve` / `analyze` |

## 2. Install

```bash
# from the repo root
python3 -m pip install -e ./analytics        # editable (dev)
python3 -m pip install ./analytics           # regular
# or run without installing:
PYTHONPATH=analytics/src python3 -m streamguard_analytics --help
```

Requires Python ≥ 3.12 and `numpy>=1.26`. No other runtime dependencies.

## 3. CLI usage

```bash
python3 -m streamguard_analytics evaluate --dataset all          # metrics table (all 14 datasets)
python3 -m streamguard_analytics evaluate --dataset brute_force --json
python3 -m streamguard_analytics serve --host 127.0.0.1 --port 8090
python3 -m streamguard_analytics analyze --json-file payload.json
# installed console script equivalent:
streamguard-analytics evaluate --dataset all
```

`payload.json` for `analyze` is either `{"features": [[rate, error_ratio, failed_auth_ratio, unique_actors, avg_severity_weight], ...]}`
or `{"events": [<contract event objects>, ...]}`.

## 4. Server endpoints (sidecar)

Bind address/port: `--host` (default `127.0.0.1`) and `--port` (default: env
`ANALYTICS_PORT`, else **8090**). Threaded; **no state between requests** — the
forest and EWMA trackers are created per request (transductive scoring on the
submitted data only). Safe to restart at any time.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/health` | — | `{ok: true, version, model_version}` |
| POST | `/analyze` | `{"features": rows}` or `{"events": [events]}` | `{anomaly_timeline, baselines, model_version, warnings}` |
| POST | `/evaluate` | `{"dataset_name": "..."}` | `EvaluationResult` (deterministic; see §7) |

- `anomaly_timeline` rows: `{bucketStart, rate, errorRatio, failedAuthRatio, uniqueActors, zscore, iforestScore, isAnomaly, zstatus}`. `zscore` is `null` for buckets the tracker could not score (cold start, gap reset, out-of-order) — never a guess.
- `isAnomaly = iforestScore > 0.61 OR zstatus == "anomalous"` (combined decision; documented).
- `baselines` per source: `{sourceId, ewmaRate, stddev, currentRate, zscore, status}` (`status` may be `warming_up` — honest, not an alarm).
- Malformed events are skipped with a recorded reason in `warnings`; nothing is silently dropped.
- Errors use the contract shape `{"error": {"code": "MACHINE_CODE", "message": ...}}`:
  `INVALID_JSON` 400, `INVALID_REQUEST` 400, `UNKNOWN_DATASET` 400, `PAYLOAD_TOO_LARGE` 413
  (bodies > 256 KiB; oversized uploads are drained up to 8 MiB then closed),
  `NOT_FOUND` 404, `METHOD_NOT_ALLOWED` 405, `INTERNAL` 500. Every response carries
  `X-StreamGuard-Version`.

## 5. Method documentation

### 5.1 EWMA baseline (`ewma-alpha0.3`)

Per-source events-per-minute series `r_t`:

- baseline: `EWMA(α = 0.3)`; deviation update `σ̂_t = EWMA(α = 0.3)` of `|r_t − baseline|`.
- `z = (r_t − baseline) / σ̂`; **anomalous if z > 3**, elevated if `2 ≤ z ≤ 3`, else normal.
- **One-sided by contract**: negative z (throughput dips) is classified `normal` — a documented blind spot of this method.
- **Zero variance** (`σ̂ ≤ 0`) ⇒ `z = 0` by contract; the first deviation after a perfectly flat history carries a `zero_sigma` note instead of an alarm.
- Cold start: **5 points** before the first score; gaps > 2× the expected interval (120 s for minute buckets) reset the tracker (`gap_reset`), which then re-warms — a reset is never an anomaly claim. Out-of-order/duplicate timestamps are skipped with a note.
- Honest properties (measured, see §7): α=0.3 detects attack *onsets* — a sustained shift is absorbed into the baseline within 1–3 buckets; σ̂ (EWMA of |dev|) under-estimates σ by ≈20 % on stationary data, so z > 3 fires on ≈2.4σ events ⇒ ≈1–4 % FPR on stationary normal data.

### 5.2 Isolation Forest (`iforest-py-1.2.0`)

Standard formulation (Liu et al. 2008), from scratch:

- 100 iTrees; subsample ψ = 64 per tree; max depth `ceil(log2(64)) = 8`.
- Splits: uniform random *splittable* feature, threshold uniform in the node's (min, max); nodes with no splittable feature (constant columns) become leaves — no crash, deterministic.
- Path length `h(x) = edges + c(leaf_size)`, `c(n) = 2(ln(n−1) + γ) − 2(n−1)/n`, `c(1) = 0` (`c(64) ≈ 7.4719`).
- Score `s(x) = 2^(−E(h)/c(ψ))`; anomaly if `s > 0.61` (0.61 itself is **not** anomalous).
- Seeded `numpy.random.RandomState(42)`: same seed ⇒ bit-identical scores (verified across processes).
- Scoring in `/analyze` and evaluation is **transductive** (fit on the matrix it scores) — documented, no train/test split.
- Degenerate guards (documented): constant matrices score exactly 0.5; a forest fit on a single row scores 1.0; the server warns when a request has < 5 buckets.

### 5.3 Rules replica at bucket granularity (`sg-rules-bucket-v1`)

Deterministic mapping of contract rules onto the five per-bucket features — a bucket
is flagged when **any** holds:

| Contract rule | Bucket-granularity condition |
|---|---|
| SG-RULE-001 (≥ 5 failed auth events / 120 s) | `rate × failed_auth_ratio ≥ 5` |
| SG-RULE-002 (> 120 requests/min) | `rate > 120` |
| SG-RULE-004 (error ratio > 0.30, min 20 events) | `error_ratio > 0.30 AND rate ≥ 20` |

**Honest limitation:** exists/sequence rules (SG-RULE-003, 006, 007) need raw events
and are *not expressible* in the five-feature vector — they are not evaluated here
(and SG-RULE-006 is why `config_change` shows rules recall 0 in §7).

### 5.4 Feature definitions (canonical, `schemas.py`)

Per minute bucket: `rate` = events; `error_ratio` = fraction of events with
`severity ∈ {medium, high, critical}` or `attributes.error` (across categories —
SG-RULE-004 applies the same condition to `category=application` only; documented
difference); `failed_auth_ratio` = fraction of `(auth, login_failed|auth_failed)` or
`(security, access_denied)` events (auth and authz failures share one feature —
documented); `unique_actors` = distinct non-empty actors (0 = no actor info);
`avg_severity_weight` = mean of `{info: 0, low: .25, medium: .5, high: .75, critical: 1}`.

## 6. Datasets (all seeded 42, fully reproducible)

Scenario datasets mirror the contract simulator scenarios; edge-case datasets probe
robustness. Ground truth is by construction (labels describe what the generator
injected; anomalous minutes hidden inside observation gaps are dropped and *not*
labeled — never fabricated).

| Scenario | Injected window (minutes) | Anomalous buckets |
|---|---|---|
| `clean_baseline` | none | 0 |
| `brute_force` | 120–145 | 26 |
| `credential_stuffing` | 60–99 | 40 |
| `traffic_burst` | 90–109 | 20 |
| `error_storm` (rate stays normal) | 80–109 | 30 |
| `mixed_attack` (error storm + brute force) | 60–74, 100–124 | 41 |
| `authz_failures` (rate stays normal) | 70–94 | 25 |
| `latency_spike` (throughput dip proxy) | 100–119 | 20 |
| `config_change` | 50–57, 130–139 | 18 |

| Edge case | Construction | Labels |
|---|---|---|
| `missing_observations` | brute-force timeline, 27/180 buckets unobserved (seeded gaps) | 21 kept anomalies; 5 hidden by gaps, honestly unlabeled |
| `noisy_measurements` | 3× noise baseline + 6 one-minute spikes (90–110 rate) | 6 anomalous |
| `delayed_events` | minutes 60–90 undercounted (40–60 %), 91–95 catch-up flush | **all normal** (delivery artifact ≠ attack; probes FP modes) |
| `gradual_drift` | rate drifts 30→65 over 240 min, then brute-force burst 225–235 | drift normal, burst anomalous (11) |
| `unseen_combinations` | every feature below its rule threshold, off-cloud joint pattern | 30 anomalous |

## 7. Honest evaluation results

> **These are synthetic labeled scenarios — NOT production claims.** The numbers
> below are the *actual* output of `python3 -m streamguard_analytics evaluate
> --dataset all` (seed 42, model versions `sg-rules-bucket-v1` / `ewma-alpha0.3` /
> `iforest-py-1.2.0`). They describe these generated datasets only. Real attack
> traffic was never used; no field data, no production deployment, no train/test
> split (transductive scoring).

```
dataset                method     prec    rec     f1    fpr    tp    fp    tn    fn
-----------------------------------------------------------------------------------
clean_baseline         rules     0.000  0.000  0.000  0.000     0     0   180     0
clean_baseline         zscore    0.000  0.000  0.000  0.033     0     6   174     0
clean_baseline         iforest   0.000  0.000  0.000  0.011     0     2   178     0
brute_force            rules     1.000  1.000  1.000  0.000    26     0   154     0
brute_force            zscore    0.333  0.077  0.125  0.026     2     4   150    24
brute_force            iforest   1.000  1.000  1.000  0.000    26     0   154     0
credential_stuffing    rules     1.000  1.000  1.000  0.000    40     0   140     0
credential_stuffing    zscore    0.167  0.025  0.043  0.036     1     5   135    39
credential_stuffing    iforest   1.000  0.425  0.596  0.000    17     0   140    23
traffic_burst          rules     1.000  1.000  1.000  0.000    20     0   160     0
traffic_burst          zscore    0.286  0.100  0.148  0.031     2     5   155    18
traffic_burst          iforest   1.000  0.700  0.824  0.000    14     0   160     6
error_storm            rules     1.000  1.000  1.000  0.000    30     0   150     0
error_storm            zscore    0.000  0.000  0.000  0.040     0     6   144    30
error_storm            iforest   1.000  0.300  0.462  0.000     9     0   150    21
mixed_attack           rules     1.000  1.000  1.000  0.000    40     0   140     0
mixed_attack           zscore    0.167  0.025  0.043  0.036     1     5   135    39
mixed_attack           iforest   1.000  0.800  0.889  0.000    32     0   140     8
authz_failures         rules     1.000  1.000  1.000  0.000    25     0   155     0
authz_failures         zscore    0.000  0.000  0.000  0.013     0     2   153    25
authz_failures         iforest   1.000  0.640  0.780  0.000    16     0   155     9
latency_spike          rules     0.000  0.000  0.000  0.000     0     0   160    20
latency_spike          zscore    0.000  0.000  0.000  0.044     0     7   153    20
latency_spike          iforest   1.000  0.950  0.974  0.000    19     0   160     1
config_change          rules     0.000  0.000  0.000  0.000     0     0   162    18
config_change          zscore    0.429  0.167  0.240  0.025     3     4   158    15
config_change          iforest   1.000  1.000  1.000  0.000    18     0   162     0
missing_observations   rules     1.000  1.000  1.000  0.000    21     0   132     0
missing_observations   zscore    0.250  0.048  0.080  0.023     1     3   129    20
missing_observations   iforest   1.000  0.952  0.976  0.000    20     0   132     1
noisy_measurements     rules     0.000  0.000  0.000  0.000     0     0   174     6
noisy_measurements     zscore    0.750  1.000  0.857  0.011     6     2   172     0
noisy_measurements     iforest   0.000  0.000  0.000  0.000     0     0   174     6
delayed_events         rules     0.000  0.000  0.000  0.000     0     0   180     0
delayed_events         zscore    0.000  0.000  0.000  0.033     0     6   174     0
delayed_events         iforest   0.000  0.000  0.000  0.000     0     0   180     0
gradual_drift          rules     1.000  1.000  1.000  0.000    11     0   229     0
gradual_drift          zscore    0.111  0.091  0.100  0.035     1     8   221    10
gradual_drift          iforest   1.000  1.000  1.000  0.000    11     0   229     0
unseen_combinations    rules     0.000  0.000  0.000  0.000     0     0   150    30
unseen_combinations    zscore    0.000  0.000  0.000  0.033     0     5   145    30
unseen_combinations    iforest   1.000  0.200  0.333  0.000     6     0   150    24
```

**Reading the table honestly (what the numbers actually say):**

- **Rules** are the strongest method on *rate/auth-count-driven* scenarios (precision 1.0, recall 1.0) because the replica thresholds are matched to the generators by construction — this says the mapping is consistent, not that rules are superior in production.
- **Rules are blind** to dips (`latency_spike` recall 0: thresholds are one-sided) and to exists-type events (`config_change` recall 0: SG-RULE-006 is inexpressible in the five features).
- **z-score (rate-only, one-sided)** detects *onsets* (α=0.3 absorbs sustained shifts within 1–3 buckets — hence low recall on long attack windows) and shows a ≈1–4 % FPR on stationary data (σ̂ under-estimation). It is invisible to error/authz-driven scenarios *by contract design*.
- **Isolation Forest** has 1.0 precision everywhere on these sets (threshold 0.61 favors precision) with recall depending on how many of the five features separate: 1.0 with four separating axes (`brute_force`), 0.30 with two (`error_storm`), 0.20 for mild off-cloud patterns (`unseen_combinations`).
- **Different methods win in different regimes** — on `noisy_measurements` the z-score finds all 6 injected spikes (recall 1.0, precision 0.75) while the forest misses them (recall 0): a wide normal cloud pushes anomaly scores below 0.61.
- **False-positive modes are visible, not hidden**: `delayed_events` (labeled all-normal) shows 6 z-score FPs and the iforest stays silent; delivery artifacts remain a real FP risk for rate-based methods.

## 8. Integration contract with the Go service (sidecar)

The Go reference service (and the Next.js demo backend) may optionally use this
package as a sidecar. Recommended wiring:

```
services/ingestor ──(HTTP)──> streamguard-analytics sidecar
   env: ANALYTICS_URL=http://127.0.0.1:8090
   calls: POST /analyze   (events or features)   → timeline + baselines for /api/analytics/ml
          POST /evaluate  (dataset_name)         → deterministic metrics for MlRun
          GET  /health                          → liveness (llm/analytics checks)
```

- The sidecar is **read-only**: it never writes to the ingestor's database, never
  mutates rules or incidents, and holds no state between requests.
- The sidecar's `/evaluate` is deterministic (fixed seed 42) — safe to call from CI
  or the demo's `POST /api/analytics/ml/evaluate`.
- AI investigation: the Go service assembles the evidence bundle (incident + up to
  50 events + rules + ML context) and calls a local Ollama endpoint through
  `ProviderAdapter` (`provider.py`); grounding rules, `UNTRUSTED DATA` wrapping of
  event text, JSON validation, and honest `ProviderError`s are enforced in the
  adapter. The provider is *advisory only* — it can never change rules, incidents,
  or any state.

## 9. What is NOT claimed

- **No production accuracy claims.** All metrics in §7 are from synthetic,
  seeded, labeled scenarios generated by this package. They are reproducible
  (identical across runs and processes) but say nothing about real traffic.
- **No real-attack validation.** No field data was used anywhere.
- **No train/test split.** `/analyze` and evaluation scoring are transductive
  (fit on the data being scored) — standard for unsupervised anomaly detection,
  documented here instead of hidden.
- **No claim of prompt-injection immunity.** The provider adapter wraps event
  text in `UNTRUSTED DATA` blocks and the system prompt forbids following
  instructions found in event text (tested) — resistance is *by construction and
  best effort*, not a proof.
- **No NaN tolerance.** Non-finite inputs raise explicit errors; nothing is
  silently imputed.
- **Latency is not a contract feature.** `latency_spike` uses a throughput-dip
  proxy (documented); one-sided thresholds cannot see dips.
- The rules replica covers SG-RULE-001/002/004 only; exists/sequence rules are
  inexpressible at bucket granularity (documented, §5.3).

## 10. Verification

- `python3 -m pytest tests/` — **190 tests**, run 3 consecutive times with
  identical results (determinism proof). Includes cross-run equality of
  `compare_methods`, dataset builders, and iforest scores.
- `python3 -m streamguard_analytics evaluate --dataset all` — produces the table
  in §7; byte-identical output across processes (verified with `--json` + `cmp`).
- Server smoke: `/health`, `/analyze` (features + events, incl. one malformed
  event → rejected with reason), `/evaluate`, `INVALID_JSON` 400, `NOT_FOUND` 404,
  `PAYLOAD_TOO_LARGE` 413 (300 KB body), `UNKNOWN_DATASET` 400 — all observed on
  a live instance.
