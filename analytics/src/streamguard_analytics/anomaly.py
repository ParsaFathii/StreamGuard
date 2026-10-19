# Copyright © 2026 Parsa Fathi — Apache-2.0
"""Isolation Forest — pure stdlib+numpy implementation (contract §ML Methods).

Standard formulation (Liu et al. 2008), no scipy/sklearn dependency:

- ``n_trees = 100``, subsample ``ψ = 64``, ``max_depth = ceil(log2(64)) = 8``.
- Trees split on a uniformly random *splittable* feature with a threshold
  uniform in the node's ``(min, max)`` on that feature; a node with no
  splittable feature becomes a leaf (this is how constant / zero-variance
  columns are handled — no crash, deterministic output).
- Path length: ``h(x) = edges + c(leaf_size)`` where
  ``c(n) = 2·(ln(n−1) + γ) − 2·(n−1)/n`` and ``c(1) = 0``.
- Anomaly score ``s(x) = 2^(−E(h(x)) / c(ψ))``; anomaly if ``s > 0.61``.

Determinism: a forest built with a given ``seed`` produces **bit-identical**
scores on any run (single ``numpy.random.RandomState(seed)`` drives all
subsampling and thresholds in construction order).

Honest limitations (documented):
- Scoring is **transductive** in the evaluation/server flows: the model is
  fit on the matrix it scores. There is no train/test split — results on the
  labeled synthetic datasets are *not* production accuracy claims.
- A forest fit on a single row (or on perfectly constant rows) is degenerate:
  every point scores exactly 1.0 (single row) or 0.5 (constant matrix).
  Callers should warn when ``n < 5`` (the server does).
- Non-finite input (NaN/inf) is rejected with an explicit :class:`ValueError`.
"""

from __future__ import annotations

import math
from typing import Sequence

import numpy as np

__all__ = [
    "IsolationForest",
    "MODEL_VERSION",
    "DEFAULT_SEED",
    "N_TREES",
    "SUBSAMPLE",
    "MAX_DEPTH",
    "THRESHOLD",
    "average_path_length",
    "anomaly_score",
    "is_anomaly",
]

MODEL_VERSION = "iforest-py-1.2.0"
DEFAULT_SEED = 42
N_TREES = 100
SUBSAMPLE = 64
MAX_DEPTH = 8  # ceil(log2(64)) — contract
THRESHOLD = 0.61

_EULER_GAMMA = 0.5772156649015329
# tree node: (feature, threshold, left, right, size); leaf → feature = -1
_LEAF = -1


def average_path_length(n: int) -> float:
    """``c(n) = 2·(ln(n−1) + γ) − 2·(n−1)/n``; ``c(1) = 0``.

    Raises :class:`ValueError` for ``n < 1``.
    """
    if n < 1:
        raise ValueError(f"n must be >= 1, got {n}")
    if n == 1:
        return 0.0
    return 2.0 * (math.log(n - 1) + _EULER_GAMMA) - 2.0 * (n - 1) / n


def anomaly_score(mean_path_length: float, c_value: float) -> float:
    """``s = 2^(−E(h)/c)`` — the standard isolation-forest score in (0, 1]."""
    if c_value <= 0.0:
        raise ValueError("c_value must be positive")
    return 2.0 ** (-mean_path_length / c_value)


def is_anomaly(score: float, threshold: float = THRESHOLD) -> bool:
    """Anomaly decision: strictly ``score > threshold`` (0.61 itself is *not*
    anomalous — documented boundary)."""
    return score > threshold


def _as_matrix(matrix: Sequence[Sequence[float]], name: str) -> np.ndarray:
    """Validate and convert input to a finite 2-D float matrix."""
    try:
        data = np.asarray(matrix, dtype=float)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name}: cannot be converted to a numeric matrix ({exc})") from exc
    if data.ndim != 2:
        raise ValueError(f"{name}: expected a 2-D matrix, got {data.ndim}-D")
    if data.shape[0] < 1:
        raise ValueError(f"{name}: matrix is empty")
    if data.shape[1] < 1:
        raise ValueError(f"{name}: matrix has no columns")
    if not np.isfinite(data).all():
        bad = np.argwhere(~np.isfinite(data))
        rows = sorted({int(r) for r, _ in bad})[:5]
        raise ValueError(
            f"{name}: matrix contains NaN/inf (first offending rows: {rows}) — "
            "clean or drop those rows before scoring"
        )
    return data


def _build_tree(rng: np.random.RandomState, data: np.ndarray, depth: int, max_depth: int) -> tuple:
    """Recursively build one iTree on ``data`` (consumes ``rng`` deterministically)."""
    n = data.shape[0]
    if depth >= max_depth or n <= 1:
        return (_LEAF, 0.0, None, None, n)
    mins = data.min(axis=0)
    maxs = data.max(axis=0)
    splittable = np.nonzero(maxs > mins)[0]
    if splittable.size == 0:  # all features constant in this node → leaf
        return (_LEAF, 0.0, None, None, n)
    feature = int(splittable[rng.randint(splittable.size)])
    lo = float(mins[feature])
    hi = float(maxs[feature])
    threshold = float(rng.uniform(lo, hi))
    if not lo < threshold < hi:  # degenerate draw (guards empty children)
        threshold = (lo + hi) / 2.0
    mask = data[:, feature] < threshold
    left = _build_tree(rng, data[mask], depth + 1, max_depth)
    right = _build_tree(rng, data[~mask], depth + 1, max_depth)
    return (feature, threshold, left, right, n)


def _path_length(node: tuple, x: np.ndarray, depth: int) -> float:
    """Path length of one point in one tree (edges + leaf-size adjustment)."""
    feature, threshold, left, right, size = node
    if left is None:  # leaf
        adjustment = average_path_length(size) if size > 1 else 0.0
        return depth + adjustment
    if x[feature] < threshold:
        return _path_length(left, x, depth + 1)
    return _path_length(right, x, depth + 1)


class IsolationForest:
    """Deterministic isolation forest (see module docstring for the math).

    Args:
        seed: RNG seed (default 42). Same seed ⇒ identical forests and scores.
        n_trees: number of iTrees (default 100).
        subsample: points per tree (default 64; effectively
            ``min(subsample, n_rows)`` when fitting smaller matrices).
        max_depth: tree depth cap (default ``ceil(log2(subsample)) = 8``).
        threshold: anomaly score threshold (default 0.61, strict ``>``).
    """

    def __init__(
        self,
        seed: int = DEFAULT_SEED,
        n_trees: int = N_TREES,
        subsample: int = SUBSAMPLE,
        max_depth: int = MAX_DEPTH,
        threshold: float = THRESHOLD,
    ) -> None:
        if n_trees < 1:
            raise ValueError("n_trees must be >= 1")
        if subsample < 1:
            raise ValueError("subsample must be >= 1")
        if max_depth < 1:
            raise ValueError("max_depth must be >= 1")
        if not 0.0 < threshold < 1.0:
            raise ValueError("threshold must be in (0, 1)")
        self.seed = int(seed)
        self.n_trees = int(n_trees)
        self.subsample = int(subsample)
        self.max_depth = int(max_depth)
        self.threshold = float(threshold)
        self._trees: list[tuple] = []
        self._n_features = 0
        self._denominator = 1.0

    @property
    def model_version(self) -> str:
        """Version recorded with every run/finding that uses this model."""
        return MODEL_VERSION

    @property
    def fitted(self) -> bool:
        """Whether :meth:`fit` has produced a forest."""
        return bool(self._trees)

    def fit(self, matrix: Sequence[Sequence[float]]) -> "IsolationForest":
        """Build the forest from a 2-D matrix (rows = points, cols = features)."""
        data = _as_matrix(matrix, "fit")
        n_rows, n_features = data.shape
        self._n_features = n_features
        effective = min(self.subsample, n_rows)
        # denominator c(ψ); guard for the degenerate single-point case
        self._denominator = average_path_length(effective) if effective > 1 else 1.0
        rng = np.random.RandomState(self.seed)
        trees: list[tuple] = []
        for _ in range(self.n_trees):
            if n_rows > effective:
                indices = rng.choice(n_rows, size=effective, replace=False)
            else:
                indices = np.arange(n_rows)
            trees.append(_build_tree(rng, data[indices], 0, self.max_depth))
        self._trees = trees
        return self

    def score(self, matrix: Sequence[Sequence[float]]) -> np.ndarray:
        """Anomaly scores in (0, 1] for each row (requires :meth:`fit` first)."""
        if not self._trees:
            raise ValueError("score() called before fit()")
        data = _as_matrix(matrix, "score")
        if data.shape[1] != self._n_features:
            raise ValueError(
                f"score: expected {self._n_features} feature column(s), got {data.shape[1]}"
            )
        scores = np.empty(data.shape[0], dtype=float)
        for i in range(data.shape[0]):
            row = data[i]
            total = 0.0
            for tree in self._trees:
                total += _path_length(tree, row, 0)
            mean_path = total / len(self._trees)
            scores[i] = anomaly_score(mean_path, self._denominator)
        return scores

    def predict(self, matrix: Sequence[Sequence[float]]) -> np.ndarray:
        """Boolean anomaly decisions: ``score > threshold`` (strict)."""
        return self.score(matrix) > self.threshold

    def fit_score(self, matrix: Sequence[Sequence[float]]) -> np.ndarray:
        """Convenience: fit on ``matrix`` and score the same matrix (transductive)."""
        return self.fit(matrix).score(matrix)
