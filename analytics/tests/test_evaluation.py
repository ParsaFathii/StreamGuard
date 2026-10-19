# Copyright © 2026 Parsa Fathi — Apache-2.0
"""Evaluation harness tests: hand-computed metric math, zero-division safety,
rule mapping, z-score onset behavior, determinism across runs."""

from __future__ import annotations

import numpy as np
import pytest

from streamguard_analytics.datasets import Dataset, build_dataset
from streamguard_analytics.evaluation import (
    compare_methods,
    evaluate,
    evaluate_all,
    evaluate_dataset,
    iforest_fn,
    rules_fn,
    zscore_fn,
)


def _fake_dataset(labels: list[int], features: np.ndarray | None = None) -> Dataset:
    n = len(labels)
    if features is None:
        features = np.zeros((n, 5), dtype=float)
    return Dataset(features=features, labels=np.array(labels, dtype=int), metadata={})


# ------------------------------------------------------------ metric math

def test_metrics_hand_computed_case() -> None:
    """labels=[1,1,0,0,1], preds=[1,0,1,0,0] =>
    tp=1 fp=1 tn=1 fn=2; P=0.5 R=1/3 F1=0.4 FPR=0.5."""
    labels = [1, 1, 0, 0, 1]
    preds = [1, 0, 1, 0, 0]
    metrics = evaluate(lambda ds: np.array(preds), _fake_dataset(labels))
    assert metrics.confusion == {"tp": 1, "fp": 1, "tn": 1, "fn": 2}
    assert metrics.precision == pytest.approx(0.5)
    assert metrics.recall == pytest.approx(1 / 3)
    assert metrics.f1 == pytest.approx(0.4)
    assert metrics.fpr == pytest.approx(0.5)


def test_zero_division_all_normal_all_predicted_normal() -> None:
    metrics = evaluate(lambda ds: np.zeros(5, dtype=int), _fake_dataset([0] * 5))
    assert metrics.precision == 0.0
    assert metrics.recall == 0.0
    assert metrics.f1 == 0.0
    assert metrics.fpr == 0.0
    assert metrics.confusion == {"tp": 0, "fp": 0, "tn": 5, "fn": 0}


def test_zero_division_no_positives_all_predicted_anomaly() -> None:
    metrics = evaluate(lambda ds: np.ones(4, dtype=int), _fake_dataset([0] * 4))
    assert metrics.precision == 0.0  # 0/0 -> 0.0, never NaN
    assert metrics.recall == 0.0
    assert metrics.f1 == 0.0
    assert metrics.fpr == pytest.approx(1.0)
    assert metrics.confusion == {"tp": 0, "fp": 4, "tn": 0, "fn": 0}


def test_perfect_prediction() -> None:
    labels = [1, 0, 1, 1, 0]
    metrics = evaluate(lambda ds: np.array(labels), _fake_dataset(labels))
    assert metrics.precision == 1.0
    assert metrics.recall == 1.0
    assert metrics.f1 == 1.0
    assert metrics.fpr == 0.0
    assert metrics.confusion == {"tp": 3, "fp": 0, "tn": 2, "fn": 0}


def test_method_fn_length_mismatch_rejected() -> None:
    with pytest.raises(ValueError, match="1-D array"):
        evaluate(lambda ds: np.zeros(3, dtype=int), _fake_dataset([0, 0, 0, 0, 0]))


def test_method_fn_invalid_values_rejected() -> None:
    with pytest.raises(ValueError, match="0/1"):
        evaluate(lambda ds: np.array([2, 0, 0]), _fake_dataset([1, 0, 0]))


# -------------------------------------------------------------- rules_fn

def test_rules_fn_conditions() -> None:
    rows = np.array(
        [
            [130.0, 0.05, 0.01, 5, 0.1],  # rate > 120 (SG-RULE-002)
            [30.0, 0.31, 0.01, 5, 0.1],   # error_ratio > 0.30 with rate >= 20 (SG-RULE-004)
            [50.0, 0.05, 0.20, 5, 0.1],   # failed-auth count 10 >= 5 (SG-RULE-001)
            [30.0, 0.05, 0.03, 7, 0.15],  # quiet bucket
            [15.0, 0.35, 0.01, 5, 0.1],   # error high but rate < 20 (min-events rule)
            [110.0, 0.29, 0.04, 5, 0.1],  # everything just under every threshold
        ],
        dtype=float,
    )
    ds = _fake_dataset([1] * 6, features=rows)
    preds = rules_fn(ds)
    assert preds.tolist() == [1, 1, 1, 0, 0, 0]


def test_rules_fn_on_clean_baseline_never_fires() -> None:
    ds = build_dataset("clean_baseline")
    assert int(rules_fn(ds).sum()) == 0


def test_rules_fn_on_brute_force_full_recall() -> None:
    """brute_force buckets: failed-auth count is far above 5 (verified real
    numbers, not a claim — deterministic seed 42)."""
    ds = build_dataset("brute_force")
    preds = rules_fn(ds)
    assert int(preds.sum()) == 26
    assert (preds[ds.labels == 1] == 1).all()


# -------------------------------------------------------------- zscore_fn

def test_zscore_fn_cold_start_prefix_not_flagged() -> None:
    ds = build_dataset("brute_force")
    preds = zscore_fn(ds)
    assert preds[:4].tolist() == [0, 0, 0, 0]  # first 4 buckets: no score => no claim


def test_zscore_fn_flags_attack_onset_not_duration() -> None:
    """Verified real behavior (deterministic): the EWMA z-score detects the
    onset at buckets 120/121 and then absorbs the sustained shift — an
    honest, documented property of alpha=0.3, not a bug."""
    ds = build_dataset("brute_force")
    preds = zscore_fn(ds)
    attack = np.where(ds.labels == 1)[0]
    assert attack[0] == 120
    assert preds[120] == 1 and preds[121] == 1  # onset flagged
    assert preds[125:146].sum() == 0  # sustained part absorbed


def test_zscore_fn_gap_handling_engages() -> None:
    ds = build_dataset("missing_observations")
    preds = zscore_fn(ds)
    assert preds.shape[0] == ds.features.shape[0]
    # the first bucket after each >2min gap is a reset (never a detection claim)
    timestamps = [
        __import__("datetime").datetime.fromisoformat(t.replace("Z", "+00:00"))
        for t in ds.metadata["bucket_start"]
    ]
    resets = 0
    for i in range(1, len(timestamps)):
        if (timestamps[i] - timestamps[i - 1]).total_seconds() > 120:
            resets += 1
            assert preds[i] == 0


# -------------------------------------------------------------- iforest_fn

def test_iforest_fn_on_brute_force_exact_confusion() -> None:
    """Deterministic pin (seed 42): verified numbers, recorded to catch
    accidental algorithm changes."""
    ds = build_dataset("brute_force")
    metrics = evaluate(iforest_fn, ds)
    assert metrics.confusion == {"tp": 26, "fp": 0, "tn": 154, "fn": 0}
    assert metrics.precision == 1.0
    assert metrics.recall == 1.0


def test_iforest_fn_on_clean_baseline_low_fpr() -> None:
    ds = build_dataset("clean_baseline")
    metrics = evaluate(iforest_fn, ds)
    assert metrics.fpr <= 0.02  # 2/180 on seed 42
    assert metrics.confusion["fp"] == 2


# ---------------------------------------------------------- pipelines

def test_compare_methods_returns_all_three() -> None:
    ds = build_dataset("clean_baseline")
    results = compare_methods(ds)
    assert set(results) == {"rules", "zscore", "iforest"}
    for metrics in results.values():
        assert isinstance(metrics.confusion, dict)
        assert set(metrics.confusion) == {"tp", "fp", "tn", "fn"}


def test_compare_methods_deterministic_across_runs() -> None:
    ds = build_dataset("error_storm")
    first = {m: mm.to_dict() for m, mm in compare_methods(ds).items()}
    second = {m: mm.to_dict() for m, mm in compare_methods(ds).items()}
    assert first == second


def test_evaluate_dataset_shape_and_determinism() -> None:
    first = evaluate_dataset("brute_force").to_dict()
    second = evaluate_dataset("brute_force").to_dict()
    assert first == second
    assert first["dataset"] == "brute_force"
    assert first["size"] == 180
    assert first["anomalous"] == 26
    assert set(first["methods"]) == {"rules", "zscore", "iforest"}
    assert first["modelVersions"] == {
        "rules": "sg-rules-bucket-v1",
        "zscore": "ewma-alpha0.3",
        "iforest": "iforest-py-1.2.0",
    }
    assert first["seed"] == 42
    assert first["notes"]


def test_evaluate_all_fourteen_deterministic() -> None:
    first = evaluate_all()
    second = evaluate_all()
    assert len(first) == 14
    assert [r.to_dict() for r in first] == [r.to_dict() for r in second]


def test_metrics_to_dict_roundtrip() -> None:
    result = evaluate_dataset("traffic_burst")
    body = result.to_dict()
    assert body["methods"]["rules"]["confusion"]["tp"] == 20
    assert body["methods"]["rules"]["precision"] == 1.0
