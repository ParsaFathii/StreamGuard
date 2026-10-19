# Copyright © 2026 Parsa Fathi — Apache-2.0
"""Isolation Forest tests: seeded determinism, sanity separation (not
fabricated accuracy), degenerate inputs, NaN/inf guards, threshold boundary."""

from __future__ import annotations

import numpy as np
import pytest

from streamguard_analytics.anomaly import (
    DEFAULT_SEED,
    THRESHOLD,
    IsolationForest,
    anomaly_score,
    average_path_length,
    is_anomaly,
)


def _cloud(rng: np.random.RandomState, n: int, center: float, sd: float) -> np.ndarray:
    return rng.normal(center, sd, size=(n, 5))


def _crafted() -> tuple[np.ndarray, np.ndarray]:
    """Deterministic sanity dataset: compact normal cloud + far outliers."""
    rng = np.random.RandomState(42)
    normal = _cloud(rng, 120, 10.0, 0.5)
    outliers = _cloud(rng, 12, 25.0, 2.0)
    matrix = np.vstack([normal, outliers])
    labels = np.zeros(matrix.shape[0], dtype=int)
    labels[120:] = 1
    return matrix, labels


# ------------------------------------------------------------- determinism

def test_same_seed_identical_scores() -> None:
    matrix, _ = _crafted()
    a = IsolationForest(seed=42).fit(matrix).score(matrix)
    b = IsolationForest(seed=42).fit(matrix).score(matrix)
    c = IsolationForest(seed=DEFAULT_SEED).fit_score(matrix)
    assert np.array_equal(a, b)
    assert np.array_equal(a, c)


def test_refit_same_instance_identical() -> None:
    matrix, _ = _crafted()
    forest = IsolationForest()
    first = forest.fit(matrix).score(matrix)
    second = forest.fit(matrix).score(matrix)
    assert np.array_equal(first, second)


def test_different_seed_changes_scores() -> None:
    matrix, _ = _crafted()
    a = IsolationForest(seed=42).fit_score(matrix)
    b = IsolationForest(seed=7).fit_score(matrix)
    assert not np.array_equal(a, b)


def test_model_version_and_defaults() -> None:
    forest = IsolationForest()
    assert forest.model_version == "iforest-py-1.2.0"
    assert forest.n_trees == 100
    assert forest.subsample == 64
    assert forest.max_depth == 8  # ceil(log2(64))
    assert forest.threshold == 0.61


# ------------------------------------------------------------------- sanity

def test_outliers_score_higher_than_normal() -> None:
    """Sanity check only — this is crafted, clearly-separated data; it is NOT
    an accuracy claim (see evaluation tests for labeled-scenario results)."""
    matrix, labels = _crafted()
    forest = IsolationForest(seed=42)
    scores = forest.fit(matrix).score(matrix)
    outlier_scores = scores[labels == 1]
    normal_scores = scores[labels == 0]
    assert outlier_scores.mean() > normal_scores.mean()
    assert outlier_scores.mean() > THRESHOLD
    assert normal_scores.mean() < THRESHOLD
    assert normal_scores.max() < THRESHOLD  # clean precision on this crafted set


def test_scores_bounded() -> None:
    matrix, _ = _crafted()
    scores = IsolationForest().fit(matrix).score(matrix)
    assert (scores > 0.0).all() and (scores <= 1.0).all()


# ----------------------------------------------------------- degenerate input

def test_empty_matrix_rejected() -> None:
    with pytest.raises(ValueError, match="empty"):
        IsolationForest().fit(np.empty((0, 5)))


def test_single_sample_degenerate_but_deterministic() -> None:
    """A forest fit on one row is degenerate by construction: every point
    terminates at the root leaf, h=0, score=1.0 (documented limitation)."""
    matrix = np.array([[30.0, 0.05, 0.03, 7.0, 0.15]])
    forest = IsolationForest(seed=42)
    scores = forest.fit(matrix).score(matrix)
    assert scores.shape == (1,)
    assert scores[0] == pytest.approx(1.0)
    again = IsolationForest(seed=42).fit_score(matrix)
    assert np.array_equal(scores, again)


def test_constant_matrix_scores_exactly_half() -> None:
    """All-constant matrix: every tree is a root leaf of size ψ=64, so
    h = c(64) for every point and s = 2^(-c/c) = 0.5 exactly."""
    matrix = np.tile([[30.0, 0.05, 0.03, 7.0, 0.15]], (100, 1))
    scores = IsolationForest(seed=42).fit(matrix).score(matrix)
    assert np.allclose(scores, 0.5)


def test_constant_columns_do_not_crash() -> None:
    rng = np.random.RandomState(42)
    matrix = np.column_stack(
        [
            np.full(80, 5.0),  # constant
            rng.normal(10, 1, 80),
            rng.normal(10, 1, 80),
            np.full(80, 3.0),  # constant
            rng.normal(10, 1, 80),
        ]
    )
    scores = IsolationForest(seed=42).fit(matrix).score(matrix)
    assert scores.shape == (80,)
    assert np.isfinite(scores).all()


def test_nan_and_inf_rejected_in_fit() -> None:
    matrix = _crafted()[0]
    matrix[3, 1] = np.nan
    with pytest.raises(ValueError, match="NaN/inf"):
        IsolationForest().fit(matrix)
    matrix[3, 1] = np.inf
    with pytest.raises(ValueError, match="NaN/inf"):
        IsolationForest().fit(matrix)


def test_nan_rejected_in_score() -> None:
    matrix, _ = _crafted()
    forest = IsolationForest(seed=42).fit(matrix)
    bad = matrix.copy()
    bad[0, 0] = np.nan
    with pytest.raises(ValueError, match="NaN/inf"):
        forest.score(bad)


def test_score_before_fit_rejected() -> None:
    with pytest.raises(ValueError, match="before fit"):
        IsolationForest().score(_crafted()[0])


def test_score_column_mismatch_rejected() -> None:
    matrix, _ = _crafted()
    forest = IsolationForest(seed=42).fit(matrix)
    with pytest.raises(ValueError, match="5 feature"):
        forest.score(matrix[:, :4])


def test_constructor_validation() -> None:
    with pytest.raises(ValueError):
        IsolationForest(n_trees=0)
    with pytest.raises(ValueError):
        IsolationForest(subsample=0)
    with pytest.raises(ValueError):
        IsolationForest(max_depth=0)
    with pytest.raises(ValueError):
        IsolationForest(threshold=1.5)


# --------------------------------------------------------- math and boundary

def test_average_path_length_values() -> None:
    assert average_path_length(1) == 0.0
    assert average_path_length(2) == pytest.approx(0.1544313298)  # 2γ - 1
    assert average_path_length(64) == pytest.approx(7.4719508)  # c(ψ) for ψ=64
    with pytest.raises(ValueError):
        average_path_length(0)


def test_anomaly_score_formula() -> None:
    assert anomaly_score(0.0, 7.4719508) == pytest.approx(1.0)
    assert anomaly_score(7.4719508, 7.4719508) == pytest.approx(0.5)
    assert anomaly_score(14.9439016, 7.4719508) == pytest.approx(0.25)


def test_threshold_boundary_strictly_greater() -> None:
    assert is_anomaly(0.61) is False  # exactly at threshold: NOT anomalous
    assert is_anomaly(0.6100000001) is True
    assert is_anomaly(0.6099) is False
    assert is_anomaly(0.0) is False
    assert is_anomaly(1.0) is True


def test_predict_matches_score_threshold() -> None:
    matrix, _ = _crafted()
    forest = IsolationForest(seed=42).fit(matrix)
    scores = forest.score(matrix)
    preds = forest.predict(matrix)
    assert np.array_equal(preds, scores > 0.61)
