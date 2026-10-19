# Copyright © 2026 Parsa Fathi — Apache-2.0
"""Dataset builder tests: reproducibility, label sanity, registry, shapes,
timestamps, and edge-case guarantees."""

from __future__ import annotations

from datetime import datetime

import numpy as np
import pytest

from streamguard_analytics.datasets import (
    ALL_DATASETS,
    EDGE_CASES,
    SCENARIOS,
    build_all,
    build_dataset,
)

_ATTACK_SCENARIOS = [
    "brute_force",
    "credential_stuffing",
    "traffic_burst",
    "error_storm",
    "mixed_attack",
    "authz_failures",
    "latency_spike",
    "config_change",
]


def test_registry_sizes() -> None:
    assert len(SCENARIOS) == 9
    assert len(EDGE_CASES) == 5
    assert len(ALL_DATASETS) == 14
    assert set(SCENARIOS) & set(EDGE_CASES) == set()


def test_unknown_dataset_lists_available() -> None:
    with pytest.raises(ValueError, match="available"):
        build_dataset("nope")


@pytest.mark.parametrize("name", sorted(ALL_DATASETS))
def test_reproducibility_two_calls_identical(name) -> None:
    first = build_dataset(name)
    second = build_dataset(name)
    assert np.array_equal(first.features, second.features)
    assert np.array_equal(first.labels, second.labels)
    assert first.metadata == second.metadata


def test_reproducibility_independent_of_call_order() -> None:
    """Fresh RandomState per call: interleaving builders cannot change output."""
    a = build_dataset("brute_force")
    build_all()  # perturb nothing
    build_dataset("clean_baseline")
    b = build_dataset("brute_force")
    assert np.array_equal(a.features, b.features)


@pytest.mark.parametrize("name", sorted(ALL_DATASETS))
def test_shapes_finite_and_labels_binary(name) -> None:
    ds = build_dataset(name)
    assert ds.features.ndim == 2 and ds.features.shape[1] == 5
    assert np.isfinite(ds.features).all()
    assert ds.features.shape[0] == ds.labels.shape[0]
    assert set(np.unique(ds.labels)) <= {0, 1}
    assert ds.features[:, 0].min() >= 0.0  # rates non-negative
    ts = ds.metadata["bucket_start"]
    assert len(ts) == ds.features.shape[0]
    parsed = [datetime.fromisoformat(t.replace("Z", "+00:00")) for t in ts]
    assert parsed == sorted(parsed)


def test_clean_baseline_has_zero_anomalies() -> None:
    ds = build_dataset("clean_baseline")
    assert int(ds.labels.sum()) == 0
    assert ds.metadata["anomalous"] == 0


@pytest.mark.parametrize("name", _ATTACK_SCENARIOS)
def test_attack_scenarios_have_positive_anomalies(name) -> None:
    ds = build_dataset(name)
    anomalous = int(ds.labels.sum())
    normal = int(ds.labels.shape[0] - anomalous)
    assert anomalous > 0
    assert normal > 0
    assert ds.metadata["anomalous"] == anomalous


def test_build_all_returns_every_dataset() -> None:
    everything = build_all()
    assert set(everything) == set(ALL_DATASETS)
    assert all(np.isfinite(ds.features).all() for ds in everything.values())


# ------------------------------------------------------------------- edges

def test_missing_observations_drops_buckets_honestly() -> None:
    ds = build_dataset("missing_observations")
    dropped = ds.metadata["dropped_buckets"]
    hidden = ds.metadata["hidden_anomalies"]
    assert dropped == 27
    assert ds.features.shape[0] == 180 - dropped
    assert ds.metadata["buckets"] == ds.features.shape[0]
    assert len(ds.metadata["bucket_start"]) == ds.features.shape[0]
    # hidden anomalies were dropped, never labeled
    assert ds.metadata["anomalous"] == 26 - hidden
    assert any("honestly not labeled" in note for note in ds.metadata["notes"])


def test_delayed_events_all_normal_by_construction() -> None:
    ds = build_dataset("delayed_events")
    assert int(ds.labels.sum()) == 0
    assert ds.metadata["anomalous"] == 0
    # the artifact is visible in the data (undercount + catch-up rates)
    rates = ds.features[:, 0]
    assert 12.0 <= rates[60:91].max() <= 20.0
    assert 55.0 <= rates[91:96].min() <= 75.0


def test_gradual_drift_labels() -> None:
    ds = build_dataset("gradual_drift")
    assert ds.features.shape[0] == 240
    assert ds.labels[225:236].all() == 1
    assert ds.labels[:225].sum() == 0  # drift itself is not an attack
    assert int(ds.labels.sum()) == 11
    first_rate = ds.features[0, 0]
    last_drift_rate = ds.features[224, 0]
    assert first_rate < 35.0 < last_drift_rate  # the drift is real in the data


def test_noisy_measurements_exact_spikes() -> None:
    ds = build_dataset("noisy_measurements")
    assert int(ds.labels.sum()) == 6
    for minute in (40, 75, 110, 130, 160, 170):
        assert ds.labels[minute] == 1
    # noisy normal buckets are wider than the standard baseline
    assert ds.features[:, 0][ds.labels == 0].std() > 8.0


def test_unseen_combinations_every_feature_below_rule_thresholds() -> None:
    ds = build_dataset("unseen_combinations")
    attack = ds.features[ds.labels == 1]
    assert attack.shape[0] == 30
    assert (attack[:, 0] <= 120.0).all()  # rate below SG-RULE-002
    assert (attack[:, 1] <= 0.30).all()  # error ratio below SG-RULE-004
    assert (attack[:, 0] * attack[:, 2] < 5.0).all()  # failed-auth count below SG-RULE-001


def test_edge_datasets_carry_notes() -> None:
    for name in EDGE_CASES:
        ds = build_dataset(name)
        assert ds.metadata["notes"], f"{name} must document its construction"
        assert ds.metadata["kind"] == "edge"
