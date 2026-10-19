# Copyright © 2026 Parsa Fathi — Apache-2.0
"""EWMA baseline engine (contract §ML Methods).

Per source (or any scalar series): baseline = EWMA(α=0.3) of the value;
σ̂ = EWMA(α=0.3) of |deviation|; z = (r_t − baseline)/σ̂; a bucket is
anomalous when z > 3 and elevated when 2 ≤ z ≤ 3 (see :func:`classify_status`).

Contract-faithful details (documented honestly):
- The z-test is **one-sided** (``z > 3``): *drops* below the baseline are
  classified ``normal`` by design. Dips are a documented blind spot of this
  method (the isolation forest can still see them).
- Zero variance (σ̂ ≤ 0) ⇒ z = 0 by contract, even if the value differs from
  the baseline (a note is attached; σ̂ builds up from the next deviation on).
- Cold start: a tracker needs **5 points** before it scores anything
  (``min_points``); earlier pushes return ``scored=False`` with
  ``status="warming_up"``.
- Missing buckets: a gap of more than two expected intervals resets the
  tracker (status ``"gap_reset"``) and it re-warms — the reset is *not* an
  anomaly claim.
- Out-of-order / duplicate timestamps are skipped with a note
  (``status="out_of_order"``); they never fabricate a score.

Pure functions (:func:`ewma_update`, :func:`zscore`, :func:`classify_status`)
plus the stateful :class:`EWMABaselineTracker` and the pure
:func:`score_series` helper.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable

__all__ = [
    "BaselineResult",
    "EWMABaselineTracker",
    "BASELINE_VERSION",
    "DEFAULT_ALPHA",
    "ANOMALY_Z",
    "ELEVATED_Z",
    "MIN_POINTS",
    "DEFAULT_INTERVAL",
    "ewma_update",
    "zscore",
    "classify_status",
    "score_series",
]

#: Version recorded with every evaluation run that uses this method.
BASELINE_VERSION = "ewma-alpha0.3"
DEFAULT_ALPHA = 0.3
ANOMALY_Z = 3.0
ELEVATED_Z = 2.0
MIN_POINTS = 5
DEFAULT_INTERVAL = 60.0  # seconds between per-minute buckets


# ----------------------------------------------------------- pure functions

def ewma_update(prev: float, value: float, alpha: float = DEFAULT_ALPHA) -> float:
    """One EWMA step: ``alpha * value + (1 - alpha) * prev``."""
    return alpha * value + (1.0 - alpha) * prev


def zscore(value: float, baseline: float, sigma: float) -> float:
    """z = (value − baseline)/σ̂; if σ̂ ≤ 0 the result is **0.0** by contract
    (zero variance ⇒ z = 0), never a division by zero."""
    if sigma <= 0.0:
        return 0.0
    return (value - baseline) / sigma


def classify_status(z: float) -> str:
    """Status classes (one-sided, per contract): ``z > 3`` → ``"anomalous"``;
    ``2 ≤ z ≤ 3`` → ``"elevated"``; otherwise (including all negative z)
    → ``"normal"``."""
    if z > ANOMALY_Z:
        return "anomalous"
    if z >= ELEVATED_Z:
        return "elevated"
    return "normal"


# ------------------------------------------------------------------ results

@dataclass(slots=True)
class BaselineResult:
    """Outcome of one ``push``.

    ``baseline``/``sigma`` are the *pre-observation* state actually used to
    compute ``zscore`` (``None`` before the first observation ever).
    ``scored=False`` rows carry an explanatory ``status``:
    ``warming_up`` | ``gap_reset`` | ``out_of_order``.
    """

    bucket_start: datetime
    value: float
    baseline: float | None
    sigma: float | None
    zscore: float | None
    status: str
    note: str | None
    scored: bool


# ------------------------------------------------------------------ tracker

class EWMABaselineTracker:
    """Stateful EWMA tracker for one scalar series (typically events-per-minute
    for one source). Deterministic: no randomness anywhere.

    Args:
        alpha: EWMA decay (contract 0.3).
        interval: expected seconds between observations (60 for minute buckets).
        min_points: points required before scoring starts (contract 5).
        z_anomaly: anomalous threshold (contract 3).
        z_elevated: elevated threshold (contract 2).
    """

    def __init__(
        self,
        alpha: float = DEFAULT_ALPHA,
        interval: float = DEFAULT_INTERVAL,
        min_points: int = MIN_POINTS,
        z_anomaly: float = ANOMALY_Z,
        z_elevated: float = ELEVATED_Z,
    ) -> None:
        if not 0.0 < alpha <= 1.0:
            raise ValueError(f"alpha must be in (0, 1], got {alpha!r}")
        if interval <= 0:
            raise ValueError("interval must be positive")
        if min_points < 1:
            raise ValueError("min_points must be >= 1")
        self._alpha = float(alpha)
        self._interval = float(interval)
        self._min_points = int(min_points)
        self._z_anomaly = float(z_anomaly)
        self._z_elevated = float(z_elevated)
        # state
        self._baseline: float | None = None
        self._sigma = 0.0
        self._count = 0
        self._last_ts: datetime | None = None
        self._last_value: float | None = None
        self._last_z: float | None = None
        self._last_status = "warming_up"

    # -- public API ---------------------------------------------------------

    @property
    def count(self) -> int:
        """Observations ingested since the last (re)start."""
        return self._count

    def push(self, ts: datetime, value: float) -> BaselineResult:
        """Ingest one observation; returns a :class:`BaselineResult`.

        Raises :class:`ValueError` for non-finite values.
        """
        if not math.isfinite(value):
            raise ValueError(f"value must be finite, got {value!r}")
        if ts.tzinfo is None:  # documented: naive timestamps are read as UTC
            ts = ts.replace(tzinfo=timezone.utc)

        if self._last_ts is not None:
            delta = (ts - self._last_ts).total_seconds()
            if delta <= 0:
                return self._unscored(ts, value, "out_of_order",
                                      "observation is not newer than the previous one; skipped")
            if delta > self._interval * 2:
                note = (
                    f"gap of {delta:.0f}s detected (expected <= {self._interval:.0f}s); "
                    "baseline reset, re-warming"
                )
                self._initialize(ts, value)
                return self._unscored(ts, value, "gap_reset", note)
        return self._ingest(ts, value)

    def snapshot(self) -> dict[str, float | str | None]:
        """Current state for ``currentBaselines``-style reporting
        (keys per contract: ewmaRate, stddev, currentRate, zscore, status)."""
        return {
            "ewmaRate": self._baseline,
            "stddev": self._sigma,
            "currentRate": self._last_value,
            "zscore": self._last_z,
            "status": self._last_status,
        }

    # -- internals ----------------------------------------------------------

    def _initialize(self, ts: datetime, value: float) -> None:
        self._baseline = value
        self._sigma = 0.0
        self._count = 1
        self._last_ts = ts
        self._last_value = value
        self._last_z = None
        self._last_status = "warming_up"

    def _ingest(self, ts: datetime, value: float) -> BaselineResult:
        if self._baseline is None or self._last_ts is None:  # very first observation
            self._initialize(ts, value)
            return self._unscored(ts, value, "warming_up", "cold start: 1 point ingested; no score yet")

        pre_baseline = self._baseline
        pre_sigma = self._sigma
        z = zscore(value, pre_baseline, pre_sigma)
        zero_note = None
        if pre_sigma <= 0.0 and value != pre_baseline:
            zero_note = (
                "zero_sigma: deviation observed while σ̂=0; contract forces z=0 "
                "(σ̂ builds up from this deviation on)"
            )

        # state updates (EWMA of value; EWMA of |deviation|)
        self._baseline = ewma_update(pre_baseline, value, self._alpha)
        self._sigma = ewma_update(pre_sigma, abs(value - pre_baseline), self._alpha)
        self._count += 1
        self._last_ts = ts
        self._last_value = value

        if self._count < self._min_points:
            note = zero_note or f"cold start: {self._count}/{self._min_points} points"
            return self._unscored(ts, value, "warming_up", note, pre_baseline, pre_sigma)

        status = classify_status(z)
        self._last_z = z
        self._last_status = status
        return BaselineResult(
            bucket_start=ts,
            value=value,
            baseline=pre_baseline,
            sigma=pre_sigma,
            zscore=z,
            status=status,
            note=zero_note,
            scored=True,
        )

    def _unscored(
        self,
        ts: datetime,
        value: float,
        status: str,
        note: str,
        baseline: float | None = None,
        sigma: float | None = None,
    ) -> BaselineResult:
        self._last_value = value
        self._last_z = None
        self._last_status = status
        return BaselineResult(
            bucket_start=ts,
            value=value,
            baseline=baseline,
            sigma=sigma,
            zscore=None,
            status=status,
            note=note,
            scored=False,
        )


def score_series(
    observations: Iterable[tuple[datetime, float]],
    alpha: float = DEFAULT_ALPHA,
    interval: float = DEFAULT_INTERVAL,
    min_points: int = MIN_POINTS,
    z_anomaly: float = ANOMALY_Z,
    z_elevated: float = ELEVATED_Z,
) -> list[BaselineResult]:
    """Pure helper: run a fresh tracker over ``(timestamp, value)`` pairs."""
    tracker = EWMABaselineTracker(
        alpha=alpha, interval=interval, min_points=min_points,
        z_anomaly=z_anomaly, z_elevated=z_elevated,
    )
    return [tracker.push(ts, value) for ts, value in observations]
