# Copyright © 2026 Parsa Fathi — Apache-2.0
"""Deterministic labeled dataset builders (seed 42 everywhere).

Every builder is a *pure* function: it creates a fresh
``numpy.random.RandomState(42)`` on each call, so two calls produce
bit-identical datasets regardless of call order or process restarts.

Each dataset provides per-minute-bucket feature vectors in the canonical
column order ``[rate, error_ratio, failed_auth_ratio, unique_actors,
avg_severity_weight]`` (see :mod:`streamguard_analytics.schemas`) with
**ground-truth labels** (1 = anomalous minute, 0 = normal minute) and
``metadata["bucket_start"]`` ISO timestamps (60s cadence from
2026-01-01T00:00:00Z) so time-aware methods (EWMA gap handling) behave
realistically.

Scenario datasets mirror the contract simulator scenarios; edge-case
datasets probe robustness (missing observations, noise, delayed delivery,
gradual drift, unseen combinations). Ground truth is *by construction*:
labels describe what the generator injected — they are honest about what
was actually observable (e.g. anomalous minutes hidden inside observation
gaps are dropped, never labeled).

Honesty notes:
- Feature values are generated directly (no event materialization) with
  distributions chosen to mirror the event-level semantics in
  :mod:`streamguard_analytics.schemas`; this is documented, not hidden.
- ``delayed_events`` is labeled entirely normal: delivery artifacts are not
  attacks. Methods that fire there are exhibiting a false-positive mode,
  which the evaluation reports as such.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable

import numpy as np

from .schemas import iso_z

__all__ = [
    "Dataset",
    "SCENARIOS",
    "EDGE_CASES",
    "ALL_DATASETS",
    "build_dataset",
    "build_all",
]

SEED = 42
_EPOCH = datetime(2026, 1, 1, tzinfo=timezone.utc)


@dataclass(slots=True)
class Dataset:
    """A labeled feature dataset.

    Attributes:
        features: ``(n, 5)`` float matrix, canonical column order.
        labels: ``(n,)`` int array — 1 = anomalous bucket, 0 = normal.
        metadata: name, kind, seed, bucket_start timestamps, counts, notes.
    """

    features: np.ndarray
    labels: np.ndarray
    metadata: dict


# ------------------------------------------------------------- distributions

def _u(rng: np.random.RandomState, lo: float, hi: float) -> float:
    return float(rng.uniform(lo, hi))


def _n(rng: np.random.RandomState, mu: float, sd: float) -> float:
    value = float(rng.normal(mu, sd))
    return max(value, 1.0)  # rates are clamped >= 1.0 (documented)


def _ri(rng: np.random.RandomState, lo: int, hi: int) -> int:
    return int(rng.randint(lo, hi + 1))


# kind → row generator (canonical column order)
_PROFILES: dict[str, Callable[[np.random.RandomState], list[float]]] = {
    #                    rate,              error_ratio,      failed_auth,      actors,     avg_sev
    "normal":              lambda r: [_n(r, 30, 4),   _u(r, .02, .08), _u(r, .01, .06), _ri(r, 5, 12),  _u(r, .08, .22)],
    "brute_force":         lambda r: [_n(r, 60, 8),   _u(r, .05, .15), _u(r, .70, .90), _ri(r, 1, 3),   _u(r, .50, .70)],
    "credential_stuffing": lambda r: [_u(r, 90, 130), _u(r, .05, .12), _u(r, .50, .70), _ri(r, 15, 30), _u(r, .40, .60)],
    "traffic_burst":       lambda r: [_u(r, 200, 400), _u(r, .02, .05), _u(r, .01, .03), _ri(r, 20, 40), _u(r, .10, .18)],
    "error_storm":         lambda r: [_u(r, 26, 36),  _u(r, .50, .80), _u(r, .01, .05), _ri(r, 5, 12),  _u(r, .40, .60)],
    "authz_failures":      lambda r: [_u(r, 26, 36),  _u(r, .02, .06), _u(r, .30, .50), _ri(r, 2, 5),   _u(r, .30, .50)],
    "latency_spike":       lambda r: [_u(r, 8, 15),   _u(r, .18, .30), _u(r, .02, .05), _ri(r, 4, 8),   _u(r, .20, .35)],
    "config_change":       lambda r: [_u(r, 45, 70),  _u(r, .12, .25), _u(r, .01, .04), _ri(r, 3, 6),   _u(r, .35, .55)],
    "unseen_combo":        lambda r: [_u(r, 36, 44),  _u(r, .18, .28), _u(r, .06, .10), _ri(r, 3, 6),   _u(r, .28, .40)],
    "noisy_normal":        lambda r: [_n(r, 30, 12),  _u(r, .02, .10), _u(r, .01, .08), _ri(r, 4, 14),  _u(r, .05, .30)],
    "spike":               lambda r: [_u(r, 90, 110), _u(r, .03, .10), _u(r, .02, .06), _ri(r, 5, 12),  _u(r, .10, .25)],
    "delay_undercount":    lambda r: [_u(r, 12, 20),  _u(r, .02, .08), _u(r, .01, .06), _ri(r, 5, 12),  _u(r, .08, .22)],
    "delay_catchup":       lambda r: [_u(r, 55, 75),  _u(r, .02, .08), _u(r, .01, .06), _ri(r, 5, 12),  _u(r, .08, .22)],
}

#: kinds that represent a genuine injected attack (label 1). Delivery
#: artifacts and normal baselines are label 0 — by construction.
_ATTACK_KINDS = frozenset(
    {
        "brute_force",
        "credential_stuffing",
        "traffic_burst",
        "error_storm",
        "authz_failures",
        "latency_spike",
        "config_change",
        "unseen_combo",
        "spike",
    }
)

FEATURE_NAMES = ("rate", "error_ratio", "failed_auth_ratio", "unique_actors", "avg_severity_weight")


def _timestamps(minutes: int) -> list[str]:
    return [iso_z(_EPOCH + timedelta(minutes=i)) for i in range(minutes)]


def _timeline(
    minutes: int,
    segments: list[tuple[str, int, int]],
) -> tuple[np.ndarray, np.ndarray, list[str]]:
    """Assemble rows/labels for ``segments = [(kind, start, end_exclusive)]``."""
    rng = np.random.RandomState(SEED)
    lookup: dict[int, str] = {}
    for kind, start, end in segments:
        if kind not in _PROFILES:
            raise ValueError(f"unknown profile kind: {kind!r}")
        for i in range(start, end):
            lookup[i] = kind
    rows: list[list[float]] = []
    labels: list[int] = []
    for i in range(minutes):
        kind = lookup.get(i, "normal")
        rows.append(_PROFILES[kind](rng))
        labels.append(1 if kind in _ATTACK_KINDS else 0)
    return np.array(rows, dtype=float), np.array(labels, dtype=int), _timestamps(minutes)


def _make(name: str, kind: str, minutes: int, segments: list[tuple[str, int, int]], notes: list[str]) -> Dataset:
    features, labels, bucket_start = _timeline(minutes, segments)
    anomalous = int(labels.sum())
    return Dataset(
        features=features,
        labels=labels,
        metadata={
            "name": name,
            "kind": kind,
            "seed": SEED,
            "minutes": minutes,
            "buckets": int(features.shape[0]),
            "anomalous": anomalous,
            "normal": int(features.shape[0] - anomalous),
            "features": list(FEATURE_NAMES),
            "bucket_start": bucket_start,
            "notes": list(notes),
        },
    )


# --------------------------------------------------------- scenario builders

def clean_baseline() -> Dataset:
    """Stationary normal traffic; ground truth: zero anomalies."""
    return _make(
        "clean_baseline", "scenario", 180, [("normal", 0, 180)],
        ["stationary normal traffic; no injected attacks"],
    )


def brute_force() -> Dataset:
    """Single actor hammering logins: high failed_auth_ratio, few actors,
    elevated rate and severity (SG-RULE-001 analog)."""
    return _make(
        "brute_force", "scenario", 180,
        [("normal", 0, 120), ("brute_force", 120, 146), ("normal", 146, 180)],
        ["brute-force window minutes 120..145 (26 buckets)"],
    )


def credential_stuffing() -> Dataset:
    """Distributed login attempts: many unique actors, high rate and
    failed_auth_ratio (SG-RULE-001/002 analog)."""
    return _make(
        "credential_stuffing", "scenario", 180,
        [("normal", 0, 60), ("credential_stuffing", 60, 100), ("normal", 100, 180)],
        ["credential-stuffing window minutes 60..99 (40 buckets)"],
    )


def traffic_burst() -> Dataset:
    """Request flood: very high rate, otherwise healthy features (SG-RULE-002 analog)."""
    return _make(
        "traffic_burst", "scenario", 180,
        [("normal", 0, 90), ("traffic_burst", 90, 110), ("normal", 110, 180)],
        ["traffic-burst window minutes 90..109 (20 buckets)"],
    )


def error_storm() -> Dataset:
    """Error storm at *normal* request rate (SG-RULE-004 analog): invisible
    to the rate-only z-score method by design (documented)."""
    return _make(
        "error_storm", "scenario", 180,
        [("normal", 0, 80), ("error_storm", 80, 110), ("normal", 110, 180)],
        ["error-storm window minutes 80..109 (30 buckets); rate stays normal on purpose"],
    )


def mixed_attack() -> Dataset:
    """Two attack phases: an error storm, then a brute-force burst."""
    return _make(
        "mixed_attack", "scenario", 180,
        [
            ("normal", 0, 60),
            ("error_storm", 60, 75),
            ("normal", 75, 100),
            ("brute_force", 100, 125),
            ("normal", 125, 180),
        ],
        ["error-storm phase minutes 60..74 + brute-force phase minutes 100..124 (41 buckets)"],
    )


def authz_failures() -> Dataset:
    """Repeated authorization denials: shows up as failed_auth_ratio elevation.
    The five-feature contract cannot separate authz from auth failures
    (documented in schemas.is_failed_auth_event)."""
    return _make(
        "authz_failures", "scenario", 180,
        [("normal", 0, 70), ("authz_failures", 70, 95), ("normal", 95, 180)],
        ["authz-failure window minutes 70..94 (25 buckets); rate stays normal on purpose"],
    )


def latency_spike() -> Dataset:
    """Latency proxy: throughput collapse (rate dip) + mild error elevation.
    Latency is not a contract feature; the dip is a documented proxy.
    One-sided thresholds (rules, z-score) are blind to dips by design."""
    return _make(
        "latency_spike", "scenario", 180,
        [("normal", 0, 100), ("latency_spike", 100, 120), ("normal", 120, 180)],
        ["latency-spike window minutes 100..119 (20 buckets): rate dips to 8..15"],
    )


def config_change() -> Dataset:
    """Post-config churn: moderately elevated rate, severity, and errors.
    The exists-type rule SG-RULE-006 is NOT expressible in the five-feature
    vector, so the rules replica cannot fire here (documented limitation)."""
    return _make(
        "config_change", "scenario", 180,
        [
            ("normal", 0, 50),
            ("config_change", 50, 58),
            ("normal", 58, 130),
            ("config_change", 130, 140),
            ("normal", 140, 180),
        ],
        ["config-change windows minutes 50..57 and 130..139 (18 buckets)"],
    )


# ------------------------------------------------------------- edge builders

def missing_observations() -> Dataset:
    """Brute-force timeline with ~15% of the buckets unobserved (sensor gaps).

    Buckets inside gaps are *dropped* (never labeled, never fabricated);
    ``metadata`` records how many anomalous minutes were hidden by gaps."""
    features, labels, bucket_start = _timeline(
        180,
        [("normal", 0, 120), ("brute_force", 120, 146), ("normal", 146, 180)],
    )
    rng = np.random.RandomState(SEED)
    dropped = np.sort(rng.choice(180, size=27, replace=False))
    keep = np.ones(180, dtype=bool)
    keep[dropped] = False
    hidden_anomalies = int(labels[dropped].sum())
    kept_labels = labels[keep]
    return Dataset(
        features=features[keep],
        labels=kept_labels,
        metadata={
            "name": "missing_observations",
            "kind": "edge",
            "seed": SEED,
            "minutes": 180,
            "buckets": int(kept_labels.shape[0]),
            "anomalous": int(kept_labels.sum()),
            "normal": int(kept_labels.shape[0] - kept_labels.sum()),
            "features": list(FEATURE_NAMES),
            "bucket_start": [bucket_start[i] for i in range(180) if keep[i]],
            "notes": [
                "27 of 180 minute buckets unobserved (seeded gaps); kept buckets retain true timestamps",
                f"{hidden_anomalies} anomalous minute(s) were hidden inside gaps and are honestly not labeled",
            ],
            "dropped_buckets": int(dropped.size),
            "hidden_anomalies": hidden_anomalies,
        },
    )


def noisy_measurements() -> Dataset:
    """Tripled baseline noise + 6 clear spikes. The noisy normal buckets are
    labeled 0 — any method firing on them is producing false positives."""
    segments: list[tuple[str, int, int]] = [("noisy_normal", 0, 180)]
    for minute in (40, 75, 110, 130, 160, 170):
        segments.append(("spike", minute, minute + 1))
    return _make(
        "noisy_measurements", "edge", 180, segments,
        [
            "noisy baseline (3x stddev on rate, wider feature spreads)",
            "6 single-minute spikes at minutes 40/75/110/130/160/170 labeled anomalous",
        ],
    )


def delayed_events() -> Dataset:
    """Delivery delays: minutes 60..90 undercounted (40-60% observed), then a
    catch-up flush at minutes 91..95. Entirely label 0 — a delivery artifact
    is not an attack; the evaluation shows the FP modes honestly."""
    return _make(
        "delayed_events", "edge", 180,
        [
            ("normal", 0, 60),
            ("delay_undercount", 60, 91),
            ("delay_catchup", 91, 96),
            ("normal", 96, 180),
        ],
        [
            "ground truth: all normal (no attack); delivery artifact only",
            "undercount window minutes 60..90, catch-up flush minutes 91..95",
        ],
    )


def gradual_drift() -> Dataset:
    """Rate drifts 30 → 65 over 240 minutes (no attack during drift), then a
    brute-force burst at minutes 225..235. The EWMA baseline adapts to drift;
    a burst of similar magnitude to the drifted level is then hard to see
    for the z-score (documented) — the multivariate forest still catches it."""
    minutes = 240
    rng = np.random.RandomState(SEED)
    rows: list[list[float]] = []
    labels: list[int] = []
    attack = set(range(225, 236))
    for i in range(minutes):
        if i in attack:
            rows.append(_PROFILES["brute_force"](rng))
            labels.append(1)
        else:
            rate = 30.0 + 35.0 * i / (minutes - 1) + float(rng.normal(0.0, 3.0))
            rows.append([max(rate, 1.0), _u(rng, .02, .08), _u(rng, .01, .06), _ri(rng, 5, 12), _u(rng, .08, .22)])
            labels.append(0)
    features = np.array(rows, dtype=float)
    labels_arr = np.array(labels, dtype=int)
    anomalous = int(labels_arr.sum())
    return Dataset(
        features=features,
        labels=labels_arr,
        metadata={
            "name": "gradual_drift",
            "kind": "edge",
            "seed": SEED,
            "minutes": minutes,
            "buckets": minutes,
            "anomalous": anomalous,
            "normal": minutes - anomalous,
            "features": list(FEATURE_NAMES),
            "bucket_start": _timestamps(minutes),
            "notes": [
                "rate drifts 30 -> 65 across 240 minutes (labeled normal); labels are 0 during drift",
                "brute-force burst minutes 225..235 labeled anomalous",
            ],
        },
    )


def unseen_combinations() -> Dataset:
    """Each feature only mildly elevated (all below rule thresholds), but the
    joint pattern is off-cloud: probes multivariate detection vs univariate rules."""
    return _make(
        "unseen_combinations", "edge", 180,
        [("normal", 0, 60), ("unseen_combo", 60, 90), ("normal", 90, 180)],
        [
            "unseen-combination window minutes 60..89 (30 buckets)",
            "every single feature stays below its rule threshold; only the joint pattern is unusual",
        ],
    )


# ---------------------------------------------------------------- registries

SCENARIOS: dict[str, Callable[[], Dataset]] = {
    "clean_baseline": clean_baseline,
    "brute_force": brute_force,
    "credential_stuffing": credential_stuffing,
    "traffic_burst": traffic_burst,
    "error_storm": error_storm,
    "mixed_attack": mixed_attack,
    "authz_failures": authz_failures,
    "latency_spike": latency_spike,
    "config_change": config_change,
}

EDGE_CASES: dict[str, Callable[[], Dataset]] = {
    "missing_observations": missing_observations,
    "noisy_measurements": noisy_measurements,
    "delayed_events": delayed_events,
    "gradual_drift": gradual_drift,
    "unseen_combinations": unseen_combinations,
}

ALL_DATASETS: dict[str, Callable[[], Dataset]] = {**SCENARIOS, **EDGE_CASES}


def build_dataset(name: str) -> Dataset:
    """Build one dataset by name (deterministic). Raises :class:`ValueError`
    listing available names for unknown input."""
    builder = ALL_DATASETS.get(name)
    if builder is None:
        raise ValueError(f"unknown dataset {name!r}; available: {sorted(ALL_DATASETS)}")
    return builder()


def build_all() -> dict[str, Dataset]:
    """Build every dataset (order: scenarios then edge cases)."""
    return {name: builder() for name, builder in ALL_DATASETS.items()}
