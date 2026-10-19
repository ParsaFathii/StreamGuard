# Copyright © 2026 Parsa Fathi — Apache-2.0
"""StreamGuard analytics & ML package.

Deterministic, dependency-light (stdlib + numpy) analytics for StreamGuard:
EWMA baselines, a pure-Python Isolation Forest, labeled scenario datasets,
a reproducible evaluation harness, an Ollama-compatible AI investigation
adapter, and a stateless sidecar HTTP server.

All randomness is seeded (42). Same seed ⇒ identical results across runs,
machines, and restarts — verified by the test-suite.
"""

from .anomaly import (
    DEFAULT_SEED,
    MAX_DEPTH,
    MODEL_VERSION,
    N_TREES,
    SUBSAMPLE,
    THRESHOLD,
    IsolationForest,
)
from .baselines import (
    ANOMALY_Z,
    BASELINE_VERSION,
    DEFAULT_ALPHA,
    ELEVATED_Z,
    MIN_POINTS,
    BaselineResult,
    EWMABaselineTracker,
    classify_status,
    score_series,
)
from .evaluation import compare_methods, evaluate, evaluate_dataset, evaluate_all
from .schemas import (
    AnomalyPoint,
    EventRecord,
    EvaluationResult,
    FeatureVector,
    MethodMetrics,
    ValidationError,
    parse_events,
)

__version__ = "10.3.2"
VERSION = __version__

__all__ = [
    "__version__",
    "VERSION",
    "MODEL_VERSION",
    "BASELINE_VERSION",
    "IsolationForest",
    "EWMABaselineTracker",
    "EventRecord",
    "FeatureVector",
    "AnomalyPoint",
    "MethodMetrics",
    "EvaluationResult",
    "ValidationError",
    "parse_events",
    "evaluate",
    "compare_methods",
    "evaluate_dataset",
    "evaluate_all",
    "classify_status",
    "score_series",
    "DEFAULT_SEED",
    "DEFAULT_ALPHA",
    "THRESHOLD",
    "ANOMALY_Z",
    "ELEVATED_Z",
    "MIN_POINTS",
    "N_TREES",
    "SUBSAMPLE",
    "MAX_DEPTH",
]
