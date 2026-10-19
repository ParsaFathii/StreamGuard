# Copyright © 2026 Parsa Fathi — Apache-2.0
"""EWMA baseline engine tests: cold start, normal series, injected spike at
the right bucket, gap reset, zero variance, one-sided statuses, determinism."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from streamguard_analytics.baselines import (
    BaselineResult,
    EWMABaselineTracker,
    classify_status,
    ewma_update,
    score_series,
    zscore,
)

_T0 = datetime(2026, 1, 1, tzinfo=timezone.utc)


def _ts(minutes: int) -> datetime:
    return _T0 + timedelta(minutes=minutes)


def _normal_series(n: int, seed: int, mean: float = 30.0, sd: float = 2.0) -> list[float]:
    """Deterministic, verified-to-be-quiet normal series (see test docstrings)."""
    rng = np.random.RandomState(seed)
    return [float(v) for v in rng.normal(mean, sd, n)]


# ------------------------------------------------------------ pure functions

def test_ewma_update_math() -> None:
    assert ewma_update(10.0, 20.0, alpha=0.3) == pytest.approx(13.0)
    assert ewma_update(0.0, 1.0, alpha=0.3) == pytest.approx(0.3)
    assert ewma_update(5.0, 5.0) == pytest.approx(5.0)


def test_zscore_zero_division_is_zero() -> None:
    assert zscore(50.0, 30.0, 0.0) == 0.0  # contract: zero variance => z = 0
    assert zscore(30.0, 30.0, 0.0) == 0.0
    assert zscore(50.0, 30.0, 4.0) == pytest.approx(5.0)


def test_classify_status_one_sided_boundaries() -> None:
    assert classify_status(0.0) == "normal"
    assert classify_status(-5.0) == "normal"  # one-sided: dips are normal by contract
    assert classify_status(1.99) == "normal"
    assert classify_status(2.0) == "elevated"
    assert classify_status(2.5) == "elevated"
    assert classify_status(3.0) == "elevated"  # 3.0 exactly is NOT anomalous (strict >)
    assert classify_status(3.01) == "anomalous"


def test_tracker_rejects_non_finite() -> None:
    tracker = EWMABaselineTracker()
    with pytest.raises(ValueError):
        tracker.push(_ts(0), float("nan"))
    with pytest.raises(ValueError):
        tracker.push(_ts(0), float("inf"))


# ---------------------------------------------------------------- cold start

def test_cold_start_min_five_points() -> None:
    tracker = EWMABaselineTracker()
    for i in range(4):
        result = tracker.push(_ts(i), 30.0)
        assert result.scored is False
        assert result.status == "warming_up"
        assert result.zscore is None
    fifth = tracker.push(_ts(4), 30.5)
    assert fifth.scored is True  # 5th point is the first scored one
    assert fifth.status == "normal"
    assert fifth.zscore is not None


def test_cold_start_counter_shows_progress() -> None:
    tracker = EWMABaselineTracker()
    tracker.push(_ts(0), 30.0)
    tracker.push(_ts(1), 31.0)
    assert tracker.count == 2
    result = tracker.push(_ts(2), 30.0)
    assert result.status == "warming_up"
    assert "3/5" in (result.note or "")


# ------------------------------------------------------------- normal series

def test_normal_series_no_anomalies() -> None:
    """Seed-7 series (mean 30, sd 2, 40 pts): deterministic, verified to
    produce no z > 3 — see module docstring for the choice of seed."""
    values = _normal_series(40, seed=7)
    results = score_series([(_ts(i), v) for i, v in enumerate(values)])
    scored = [r for r in results if r.scored]
    assert len(scored) == 36  # 40 - 4 warming-up
    assert all(r.status in ("normal", "elevated") for r in scored)
    assert not any(r.status == "anomalous" for r in scored)
    assert max(r.zscore for r in scored) < 3.0


def test_injected_spike_anomaly_at_right_bucket() -> None:
    values = _normal_series(20, seed=7) + [65.0] + _normal_series(9, seed=8)
    results = score_series([(_ts(i), v) for i, v in enumerate(values)])
    spike = results[20]
    assert spike.scored is True
    assert spike.status == "anomalous"
    assert spike.zscore is not None and spike.zscore > 3.0
    assert spike.baseline is not None and 28.0 < spike.baseline < 32.0
    # no other bucket is anomalous
    others = [r for i, r in enumerate(results) if i != 20]
    assert not any(r.status == "anomalous" for r in others if r.scored)


def test_ewma_absorbs_sustained_shift_after_onset() -> None:
    """Documented behavior: alpha=0.3 detects the *onset*; a sustained shift
    is absorbed into the baseline within a few buckets (honest limitation)."""
    values = _normal_series(20, seed=7) + [60.0] * 10
    results = score_series([(_ts(i), v) for i, v in enumerate(values)])
    flagged = [i for i, r in enumerate(results) if r.scored and r.status == "anomalous"]
    assert flagged[0] == 20  # onset flagged
    assert len(flagged) < 4  # ...but not the whole sustained window


# ------------------------------------------------------------------- gaps

def test_gap_resets_and_rewarms() -> None:
    values = _normal_series(20, seed=7)
    results = score_series([(_ts(i), v) for i, v in enumerate(values)])
    assert results[-1].status == "normal"
    tracker = EWMABaselineTracker()
    for i, v in enumerate(values):
        tracker.push(_ts(i), v)
    gap = tracker.push(_ts(23), 31.0)  # 3 minutes after bucket 19 => missing buckets
    assert gap.scored is False
    assert gap.status == "gap_reset"
    assert gap.note is not None and "reset" in gap.note
    # after the gap the tracker re-warms from scratch (3 more pushes to count 4)
    assert tracker.count == 1
    for i in range(3):
        after = tracker.push(_ts(24 + i), 30.0)
        assert after.status == "warming_up"
        assert after.scored is False
    fifth = tracker.push(_ts(27), 30.0)
    assert fifth.scored is True


def test_small_jitter_is_not_a_gap() -> None:
    tracker = EWMABaselineTracker()
    for i in range(6):
        tracker.push(_ts(i), 30.0)
    # 90s late (less than 2 * interval): still scored, not a reset
    late = tracker.push(_ts(6) + timedelta(seconds=30), 30.0)
    assert late.scored is True
    assert late.status == "normal"


def test_out_of_order_skipped() -> None:
    tracker = EWMABaselineTracker()
    for i in range(6):
        tracker.push(_ts(i), 30.0)
    dup = tracker.push(_ts(4), 45.0)  # older than last: skipped, never scored
    assert dup.scored is False
    assert dup.status == "out_of_order"
    assert dup.zscore is None


# ------------------------------------------------------------ zero variance

def test_constant_series_zero_variance() -> None:
    results = score_series([(_ts(i), 30.0) for i in range(30)])
    scored = [r for r in results if r.scored]
    assert len(scored) == 26
    assert all(r.zscore == 0.0 for r in scored)
    assert all(r.status == "normal" for r in scored)


def test_first_deviation_after_constant_history_is_z_zero_with_note() -> None:
    """Contract: σ̂=0 forces z=0 even when the value deviates; a note makes the
    limitation visible instead of hiding it."""
    tracker = EWMABaselineTracker()
    for i in range(10):
        tracker.push(_ts(i), 30.0)
    deviating = tracker.push(_ts(10), 50.0)
    assert deviating.scored is True
    assert deviating.zscore == 0.0
    assert deviating.status == "normal"
    assert deviating.note is not None and "zero_sigma" in deviating.note
    # σ̂ builds up from the first deviation onward: baseline=36, sigma=6 now,
    # so a further jump to 80 is a genuine z=(80-36)/6 > 3 anomaly
    followup = tracker.push(_ts(11), 80.0)
    assert followup.scored is True
    assert followup.zscore is not None and followup.zscore > 3.0
    assert followup.status == "anomalous"


# -------------------------------------------------------------- determinism

def test_score_series_deterministic() -> None:
    values = _normal_series(30, seed=3) + [80.0, 12.0]
    observations = [(_ts(i), v) for i, v in enumerate(values)]
    first = score_series(observations)
    second = score_series(observations)
    assert first == second  # dataclass equality: identical fields
    assert isinstance(first[0], BaselineResult)


def test_snapshot_shape_and_values() -> None:
    tracker = EWMABaselineTracker()
    for i, v in enumerate([30.0, 31.0, 29.0, 30.0, 30.5, 31.0]):
        tracker.push(_ts(i), v)
    snap = tracker.snapshot()
    assert set(snap) == {"ewmaRate", "stddev", "currentRate", "zscore", "status"}
    assert snap["ewmaRate"] is not None and 29.0 < snap["ewmaRate"] < 32.0
    assert snap["stddev"] > 0.0
    assert snap["currentRate"] == 31.0
    assert snap["status"] in ("normal", "elevated", "anomalous")


def test_two_trackers_on_same_series_agree() -> None:
    values = _normal_series(25, seed=11) + [70.0]
    observations = [(_ts(i), v) for i, v in enumerate(values)]
    a = score_series(observations)
    b = EWMABaselineTracker()
    manual = [b.push(ts, v) for ts, v in observations]
    assert a == manual
