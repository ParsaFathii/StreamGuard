# Copyright © 2026 Parsa Fathi — Apache-2.0
"""Evaluation harness — deterministic, zero-division safe, honest.

Three methods are compared on the same labeled dataset (bucket granularity):

- ``rules`` — deterministic replica of the contract detection rules, mapped
  onto the five per-bucket features (see :func:`rules_fn` for the exact
  mapping). *Honest limitation:* exists/sequence rules (SG-RULE-003/006/007)
  need raw events and are NOT expressible in the feature vector; they are
  not evaluated here.
- ``zscore`` — the EWMA baseline engine on the ``rate`` feature only
  (per contract). Unscored buckets (cold start, gap reset, out-of-order)
  predict 0 — never counted as detections. *Honest limitation:* the z-test
  is one-sided (``z > 3``), so error-driven scenarios are invisible to it.
- ``iforest`` — the pure isolation forest (seed 42), transductive:
  fit on the dataset matrix, score the same matrix, threshold 0.61.

All metrics are computed from the confusion counts with zero-safe divisions
(missing denominators yield 0.0, never NaN). Everything is seeded: two runs
produce identical results.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Callable

import numpy as np

from .anomaly import DEFAULT_SEED, THRESHOLD, IsolationForest, MODEL_VERSION
from .baselines import BASELINE_VERSION, EWMABaselineTracker
from .datasets import Dataset, build_dataset
from .schemas import EvaluationResult, MethodMetrics

__all__ = [
    "evaluate",
    "rules_fn",
    "zscore_fn",
    "iforest_fn",
    "compare_methods",
    "evaluate_dataset",
    "evaluate_all",
]

RULES_VERSION = "sg-rules-bucket-v1"

#: Fallback bucket epoch for datasets without timestamps (never used by the
#: builders in :mod:`streamguard_analytics.datasets`, kept for custom datasets).
_FALLBACK_EPOCH = datetime(2026, 1, 1, tzinfo=timezone.utc)

MethodFn = Callable[[Dataset], np.ndarray]


# ------------------------------------------------------------------- metrics

def evaluate(method_fn: MethodFn, dataset: Dataset) -> MethodMetrics:
    """Run ``method_fn(dataset) -> predictions`` against ``dataset.labels`` and
    compute precision/recall/F1/FPR + confusion (all zero-division safe)."""
    labels = np.asarray(dataset.labels, dtype=int)
    raw = method_fn(dataset)
    preds = np.asarray(raw)
    if preds.ndim != 1 or preds.shape[0] != labels.shape[0]:
        raise ValueError(
            f"method_fn must return a 1-D array of length {labels.shape[0]}, "
            f"got shape {getattr(preds, 'shape', None)}"
        )
    if not np.isin(preds, [0, 1]).all():
        raise ValueError("method_fn must return only 0/1 (or boolean) predictions")
    preds = preds.astype(int)

    tp = int(np.sum((preds == 1) & (labels == 1)))
    fp = int(np.sum((preds == 1) & (labels == 0)))
    tn = int(np.sum((preds == 0) & (labels == 0)))
    fn = int(np.sum((preds == 0) & (labels == 1)))

    precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) > 0 else 0.0
    fpr = fp / (fp + tn) if (fp + tn) > 0 else 0.0
    return MethodMetrics(
        precision=precision,
        recall=recall,
        f1=f1,
        fpr=fpr,
        confusion={"tp": tp, "fp": fp, "tn": tn, "fn": fn},
    )


# ------------------------------------------------------------------- methods

def rules_fn(dataset: Dataset) -> np.ndarray:
    """Rules replica at bucket granularity (documented mapping):

    - SG-RULE-001 (>= 5 failed auth events): ``rate * failed_auth_ratio >= 5``
    - SG-RULE-002 (> 120 requests/min): ``rate > 120``
    - SG-RULE-004 (error ratio > 0.30, min 20 events): ``error_ratio > 0.30 AND rate >= 20``

    A bucket is flagged when *any* condition holds.
    """
    features = np.asarray(dataset.features, dtype=float)
    rate = features[:, 0]
    error_ratio = features[:, 1]
    failed_auth_ratio = features[:, 2]
    failed_auth_count = rate * failed_auth_ratio
    flag = (
        (failed_auth_count >= 5.0)
        | (rate > 120.0)
        | ((error_ratio > 0.30) & (rate >= 20.0))
    )
    return flag.astype(int)


def _bucket_datetimes(dataset: Dataset) -> list[datetime]:
    raw = dataset.metadata.get("bucket_start")
    if raw:
        parsed: list[datetime] = []
        for text in raw:
            t = str(text)
            if t.endswith(("Z", "z")):
                t = t[:-1] + "+00:00"
            parsed.append(datetime.fromisoformat(t))
        return parsed
    n = int(np.asarray(dataset.labels).shape[0])
    return [_FALLBACK_EPOCH + timedelta(minutes=i) for i in range(n)]


def zscore_fn(dataset: Dataset) -> np.ndarray:
    """EWMA z-score on the ``rate`` feature (per contract), with real bucket
    timestamps (gap handling engaged). Unscored buckets predict 0."""
    features = np.asarray(dataset.features, dtype=float)
    timestamps = _bucket_datetimes(dataset)
    tracker = EWMABaselineTracker()
    preds: list[int] = []
    for ts, rate in zip(timestamps, features[:, 0]):
        result = tracker.push(ts, float(rate))
        preds.append(1 if (result.scored and result.status == "anomalous") else 0)
    return np.array(preds, dtype=int)


def iforest_fn(dataset: Dataset) -> np.ndarray:
    """Isolation forest (seed 42), transductive: fit on the dataset, score it,
    flag ``score > 0.61``."""
    forest = IsolationForest(seed=DEFAULT_SEED)
    scores = forest.fit(dataset.features).score(dataset.features)
    return (scores > THRESHOLD).astype(int)


# ----------------------------------------------------------------- pipelines

def compare_methods(dataset: Dataset) -> dict[str, MethodMetrics]:
    """Evaluate all three methods on one dataset →
    ``{"rules": ..., "zscore": ..., "iforest": ...}`` (deterministic)."""
    return {
        "rules": evaluate(rules_fn, dataset),
        "zscore": evaluate(zscore_fn, dataset),
        "iforest": evaluate(iforest_fn, dataset),
    }


def evaluate_dataset(name: str) -> EvaluationResult:
    """Build dataset ``name`` and evaluate all methods (deterministic)."""
    dataset = build_dataset(name)
    methods = compare_methods(dataset)
    return EvaluationResult(
        dataset=name,
        size=int(np.asarray(dataset.labels).shape[0]),
        anomalous=int(np.asarray(dataset.labels).sum()),
        seed=int(dataset.metadata.get("seed", 42)),
        methods=methods,
        model_versions={
            "rules": RULES_VERSION,
            "zscore": BASELINE_VERSION,
            "iforest": MODEL_VERSION,
        },
        notes=list(dataset.metadata.get("notes", [])),
    )


def evaluate_all() -> list[EvaluationResult]:
    """Evaluate every dataset (scenarios then edge cases), deterministic."""
    from .datasets import ALL_DATASETS  # local import keeps registries authoritative

    return [evaluate_dataset(name) for name in ALL_DATASETS]
