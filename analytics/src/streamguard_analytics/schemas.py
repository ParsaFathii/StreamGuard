# Copyright © 2026 Parsa Fathi — Apache-2.0
"""Typed schemas, validation, and canonical feature definitions.

This module is the single source of truth (mirroring ``CONTRACT.md``) for:

- :class:`EventRecord` — strict parsing of event JSON dicts with *explicit*
  per-field errors (:class:`ValidationError` carries a list of
  ``{"field": ..., "reason": ...}`` dicts). Unknown fields are rejected;
  enum violations, size limits, and UUID/ISO-8601 formats are enforced.
- :func:`parse_events` — batch parsing that *skips malformed items with a
  recorded reason* (honest handling: nothing is silently dropped; the caller
  receives ``(records, errors)``).
- :class:`FeatureVector` — the five per-minute-bucket contract features:
  ``rate, error_ratio, failed_auth_ratio, unique_actors, avg_severity_weight``,
  plus the canonical event-level definitions used to derive them
  (:func:`is_error_event`, :func:`is_failed_auth_event`).
- Report types: :class:`AnomalyPoint` (timeline row), :class:`MethodMetrics`
  and :class:`EvaluationResult` (evaluation outputs).

Honesty notes (documented limitations):
- "no nested secrets" in ``attributes`` is a human/ingest policy; it is NOT
  machine-checkable here and is not validated by this module.
- Future-skew (<=10 min) policy belongs to the ingest services, not to this
  package; only the ISO-8601 UTC *format* is validated here.
- ``avg_severity_weight`` maps severities to
  ``{info: 0.0, low: 0.25, medium: 0.5, high: 0.75, critical: 1.0}``.
"""

from __future__ import annotations

import json
import math
import re
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

import numpy as np

__all__ = [
    "ValidationError",
    "EventRecord",
    "FeatureVector",
    "AnomalyPoint",
    "MethodMetrics",
    "EvaluationResult",
    "SEVERITY_LEVELS",
    "SEVERITY_WEIGHTS",
    "SOURCE_TYPES",
    "CATEGORIES",
    "ORIGINS",
    "parse_events",
    "is_error_event",
    "is_failed_auth_event",
    "bucket_events_by_minute",
    "feature_vector_from_bucket",
    "events_to_feature_vectors",
    "iso_z",
]

# ---------------------------------------------------------------- constants

SEVERITY_LEVELS = ("info", "low", "medium", "high", "critical")
#: Canonical severity → weight mapping for ``avg_severity_weight``.
SEVERITY_WEIGHTS = {
    "info": 0.0,
    "low": 0.25,
    "medium": 0.5,
    "high": 0.75,
    "critical": 1.0,
}
#: Severities that mark an event as an "error event" (plus ``attributes.error``).
ERROR_SEVERITIES = ("medium", "high", "critical")
SOURCE_TYPES = ("app", "infra", "system", "security", "synthetic")
CATEGORIES = ("auth", "network", "application", "data", "system", "config", "security")
ORIGINS = ("synthetic", "external")

MAX_MESSAGE_CHARS = 512
MAX_ATTRIBUTES_BYTES = 4096  # "stringified <= 4KB" per contract
MAX_OPTIONAL_CHARS = 128

_SOURCE_ID_RE = re.compile(r"^[a-zA-Z0-9._-]{1,64}$")
_EVENT_FIELDS = frozenset(
    {
        "event_id",
        "schema_version",
        "event_time",
        "source_id",
        "source_type",
        "severity",
        "category",
        "message",
        "attributes",
        "correlation_id",
        "trace_id",
        "actor",
        "origin",
    }
)


# ------------------------------------------------------------------- errors

class ValidationError(ValueError):
    """Explicit validation failure.

    Attributes:
        errors: list of ``{"field": str, "reason": str}`` dicts, one per problem
            found. Empty only when raised outside field validation.
    """

    def __init__(self, message: str, errors: list[dict[str, str]] | None = None) -> None:
        super().__init__(message)
        self.errors: list[dict[str, str]] = list(errors or [])


def _err(field: str, reason: str) -> dict[str, str]:
    return {"field": field, "reason": reason}


# ------------------------------------------------------------------ helpers

def iso_z(dt: datetime) -> str:
    """Format an aware UTC datetime as contract ISO-8601 (``...Z``, ms precision)."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S") + f".{dt.microsecond // 1000:03d}Z"


def _parse_event_time(value: Any, errors: list[dict[str, str]]) -> datetime | None:
    if not isinstance(value, str):
        errors.append(_err("event_time", "must be an ISO-8601 UTC string"))
        return None
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        errors.append(_err("event_time", f"invalid ISO-8601 timestamp: {value!r}"))
        return None
    if dt.tzinfo is None:
        errors.append(_err("event_time", "timestamp must carry a UTC offset (e.g. Z or +00:00)"))
        return None
    if dt.utcoffset() != timedelta(0):
        errors.append(_err("event_time", "timestamp must be UTC (offset must be zero)"))
        return None
    return dt


def _check_attributes(value: Any, errors: list[dict[str, str]]) -> dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        errors.append(_err("attributes", "must be a JSON object"))
        return {}
    serialized = json.dumps(value, separators=(",", ":"), default=str, ensure_ascii=False)
    size = len(serialized.encode("utf-8"))
    if size > MAX_ATTRIBUTES_BYTES:
        errors.append(
            _err("attributes", f"stringified size {size} bytes exceeds {MAX_ATTRIBUTES_BYTES}")
        )
    return dict(value)


def _check_optional_str(
    value: Any, name: str, errors: list[dict[str, str]], max_len: int = MAX_OPTIONAL_CHARS
) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        errors.append(_err(name, "must be a string"))
        return None
    if not (1 <= len(value) <= max_len):
        errors.append(_err(name, f"must be 1..{max_len} chars, got length {len(value)}"))
        return None
    return value


# ------------------------------------------------------------- EventRecord

@dataclass(slots=True)
class EventRecord:
    """A validated StreamGuard event (contract ``schema_version = 1``)."""

    event_id: str
    schema_version: int
    event_time: datetime
    source_id: str
    source_type: str
    severity: str
    category: str
    message: str
    attributes: dict[str, Any] = field(default_factory=dict)
    correlation_id: str | None = None
    trace_id: str | None = None
    actor: str | None = None
    origin: str | None = None

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "EventRecord":
        """Strictly validate one event dict. Raises :class:`ValidationError` listing
        *every* problem (never just the first)."""
        if not isinstance(data, Mapping):
            raise ValidationError(
                "event must be a JSON object",
                [_err("$event", "expected a JSON object")],
            )
        errors: list[dict[str, str]] = []
        for key in data:
            if key not in _EVENT_FIELDS:
                errors.append(_err(str(key), "unknown field (extra fields are rejected)"))

        # event_id — UUID v4
        event_id = data.get("event_id")
        if not isinstance(event_id, str):
            errors.append(_err("event_id", "required, must be a string"))
        else:
            try:
                parsed = uuid.UUID(event_id)
            except (ValueError, AttributeError):
                errors.append(_err("event_id", f"not a valid UUID: {event_id!r}"))
            else:
                if parsed.version != 4:
                    errors.append(_err("event_id", "must be a UUID v4"))

        # schema_version
        version = data.get("schema_version")
        if isinstance(version, bool) or not isinstance(version, int):
            errors.append(_err("schema_version", "required, must be the integer 1"))
        elif version != 1:
            errors.append(_err("schema_version", f"must be 1, got {version!r}"))

        # event_time
        event_time = _parse_event_time(data.get("event_time"), errors)

        # source_id
        source_id = data.get("source_id")
        if not isinstance(source_id, str) or not _SOURCE_ID_RE.fullmatch(source_id):
            errors.append(
                _err("source_id", "required, 1..64 chars matching [a-zA-Z0-9._-]")
            )

        # enums
        source_type = data.get("source_type")
        if source_type not in SOURCE_TYPES:
            errors.append(_err("source_type", f"must be one of {list(SOURCE_TYPES)}"))
        severity = data.get("severity")
        if severity not in SEVERITY_LEVELS:
            errors.append(_err("severity", f"must be one of {list(SEVERITY_LEVELS)}"))
        category = data.get("category")
        if category not in CATEGORIES:
            errors.append(_err("category", f"must be one of {list(CATEGORIES)}"))

        # message
        message = data.get("message")
        if not isinstance(message, str) or not (1 <= len(message) <= MAX_MESSAGE_CHARS):
            errors.append(_err("message", f"required, 1..{MAX_MESSAGE_CHARS} chars"))

        # attributes / optionals / origin
        attributes = _check_attributes(data.get("attributes"), errors)
        correlation_id = _check_optional_str(data.get("correlation_id"), "correlation_id", errors)
        trace_id = _check_optional_str(data.get("trace_id"), "trace_id", errors)
        actor = _check_optional_str(data.get("actor"), "actor", errors)
        origin = data.get("origin")
        if origin is not None and origin not in ORIGINS:
            errors.append(_err("origin", f"must be one of {list(ORIGINS)} (or absent)"))

        if errors:
            raise ValidationError(f"invalid event: {len(errors)} problem(s)", errors)

        assert event_time is not None  # validated above; keeps type-checkers happy
        return cls(
            event_id=str(event_id),
            schema_version=1,
            event_time=event_time,
            source_id=str(source_id),
            source_type=str(source_type),
            severity=str(severity),
            category=str(category),
            message=str(message),
            attributes=attributes,
            correlation_id=correlation_id,
            trace_id=trace_id,
            actor=actor,
            origin=str(origin) if origin is not None else None,
        )

    def to_dict(self) -> dict[str, Any]:
        """JSON-friendly dict (contract field names, ISO-8601 ``event_time``)."""
        return {
            "event_id": self.event_id,
            "schema_version": self.schema_version,
            "event_time": iso_z(self.event_time),
            "source_id": self.source_id,
            "source_type": self.source_type,
            "severity": self.severity,
            "category": self.category,
            "message": self.message,
            "attributes": dict(self.attributes),
            "correlation_id": self.correlation_id,
            "trace_id": self.trace_id,
            "actor": self.actor,
            "origin": self.origin,
        }


def parse_events(items: Sequence[Any]) -> tuple[list[EventRecord], list[dict[str, Any]]]:
    """Parse a batch of raw event dicts.

    Malformed items are *skipped with a recorded reason* — never silently
    dropped and never aborting the whole batch (documented honest handling).

    Returns:
        ``(records, errors)`` where each error entry is
        ``{"index": int, "reasons": [{"field", "reason"}, ...]}``.
    """
    records: list[EventRecord] = []
    errors: list[dict[str, Any]] = []
    for index, item in enumerate(items):
        try:
            records.append(EventRecord.from_dict(item))
        except ValidationError as exc:
            errors.append({"index": index, "reasons": exc.errors})
    return records, errors


# ---------------------------------------------------- canonical event rules

def is_error_event(event: EventRecord) -> bool:
    """Error event := ``severity in {medium, high, critical}`` OR ``attributes.error is True``.

    Note: contract rule SG-RULE-004 applies this condition to ``category=application``
    events only; the *bucket feature* uses the same condition across all categories
    (documented difference — see README)."""
    if event.severity in ERROR_SEVERITIES:
        return True
    return event.attributes.get("error") is True


def is_failed_auth_event(event: EventRecord) -> bool:
    """Failed auth/authz event := (``category=auth`` AND ``attributes.action`` in
    ``{login_failed, auth_failed}``) OR (``category=security`` AND
    ``attributes.action == access_denied``).

    Auth *and* authz failures are counted together: the five-feature contract
    has a single ``failed_auth_ratio`` and cannot separate them (documented)."""
    action = event.attributes.get("action")
    if event.category == "auth" and action in ("login_failed", "auth_failed"):
        return True
    return event.category == "security" and action == "access_denied"


# ------------------------------------------------------------ FeatureVector

@dataclass(slots=True)
class FeatureVector:
    """The five per-minute-bucket contract features.

    Fields:
        rate: events per minute in the bucket (>= 0).
        error_ratio: fraction of error events (see :func:`is_error_event`), [0, 1].
        failed_auth_ratio: fraction of failed auth/authz events, [0, 1].
        unique_actors: count of distinct non-empty ``actor`` values (>= 0);
            0 means "no actor information in this bucket" (documented).
        avg_severity_weight: mean of :data:`SEVERITY_WEIGHTS`, [0, 1].
    """

    rate: float
    error_ratio: float
    failed_auth_ratio: float
    unique_actors: int
    avg_severity_weight: float

    def validate(self) -> None:
        """Raise :class:`ValidationError` listing every constraint violation."""
        errors: list[dict[str, str]] = []
        checks: list[tuple[str, float, float]] = [
            ("rate", self.rate, math.inf),  # non-negative, no upper bound
            ("error_ratio", self.error_ratio, 1.0),
            ("failed_auth_ratio", self.failed_auth_ratio, 1.0),
            ("avg_severity_weight", self.avg_severity_weight, 1.0),
        ]
        for name, value, upper in checks:
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                errors.append(_err(name, "must be a number"))
                continue
            if not math.isfinite(value):
                errors.append(_err(name, "must be finite (no NaN/inf)"))
                continue
            if value < 0.0:
                errors.append(_err(name, "must be >= 0"))
            elif value > upper:
                errors.append(_err(name, f"must be <= {upper}"))
        if isinstance(self.unique_actors, bool) or not isinstance(self.unique_actors, int):
            errors.append(_err("unique_actors", "must be an integer"))
        elif self.unique_actors < 0:
            errors.append(_err("unique_actors", "must be >= 0"))
        if errors:
            raise ValidationError(f"invalid feature vector: {len(errors)} problem(s)", errors)

    @classmethod
    def from_row(cls, row: Sequence[Any] | np.ndarray) -> "FeatureVector":
        """Build from a raw 5-value row (``[rate, error_ratio, failed_auth_ratio,
        unique_actors, avg_severity_weight]``); accepts list/tuple/ndarray rows.
        Explicit errors on wrong length, non-numeric values, booleans, NaN/inf,
        and out-of-range values."""
        if isinstance(row, (str, bytes)) or not isinstance(row, (Sequence, np.ndarray)):
            raise ValidationError("feature row must be a sequence", [_err("$row", "expected a sequence of 5 numbers")])
        if len(row) != 5:
            raise ValidationError(
                "feature row must have exactly 5 values",
                [_err("$row", f"expected 5 values, got {len(row)}")],
            )
        errors: list[dict[str, str]] = []
        values: list[float] = []
        for i, value in enumerate(row):
            if isinstance(value, bool) or not isinstance(value, (int, float, np.integer, np.floating)):
                errors.append(_err(f"$row[{i}]", "must be a number"))
                values.append(0.0)
                continue
            value = float(value)
            if not math.isfinite(value):
                errors.append(_err(f"$row[{i}]", "must be finite (no NaN/inf)"))
            values.append(value)
        actors = values[3]
        if actors != int(actors):
            errors.append(_err("$row[3]", "unique_actors must be an integer count"))
        vector = cls(values[0], values[1], values[2], int(actors) if actors >= 0 else -1, values[4])
        try:
            vector.validate()
        except ValidationError as exc:
            errors.extend(exc.errors)
        if errors:
            raise ValidationError(f"invalid feature row: {len(errors)} problem(s)", errors)
        return vector

    def to_row(self) -> list[float]:
        """Matrix row in canonical column order (validates first)."""
        self.validate()
        return [float(self.rate), float(self.error_ratio), float(self.failed_auth_ratio), int(self.unique_actors), float(self.avg_severity_weight)]


# --------------------------------------------------------------- bucketing

def bucket_events_by_minute(events: Sequence[EventRecord]) -> dict[datetime, list[EventRecord]]:
    """Group validated events into per-minute buckets (sorted by bucket start)."""
    buckets: dict[datetime, list[EventRecord]] = {}
    for event in events:
        key = event.event_time.replace(second=0, microsecond=0)
        buckets.setdefault(key, []).append(event)
    return dict(sorted(buckets.items()))


def feature_vector_from_bucket(events: Sequence[EventRecord]) -> FeatureVector:
    """Compute the five contract features for one non-empty bucket."""
    if not events:
        raise ValidationError("empty bucket", [_err("$bucket", "bucket must contain at least one event")])
    total = len(events)
    error_count = sum(1 for e in events if is_error_event(e))
    failed_count = sum(1 for e in events if is_failed_auth_event(e))
    actors = {e.actor for e in events if e.actor}
    severity_weight = sum(SEVERITY_WEIGHTS[e.severity] for e in events) / total
    return FeatureVector(
        rate=float(total),
        error_ratio=error_count / total,
        failed_auth_ratio=failed_count / total,
        unique_actors=len(actors),
        avg_severity_weight=severity_weight,
    )


def events_to_feature_vectors(
    events: Sequence[EventRecord],
) -> list[tuple[datetime, FeatureVector]]:
    """Full pipeline: events → sorted per-minute buckets → feature vectors."""
    return [
        (start, feature_vector_from_bucket(bucket))
        for start, bucket in bucket_events_by_minute(events).items()
    ]


# ------------------------------------------------------------ report types

@dataclass(slots=True)
class AnomalyPoint:
    """One timeline row: per-minute features + both method scores.

    ``zscore``/``zstatus`` describe the EWMA z-score method (``zscore`` is
    ``None`` for buckets the tracker could not score: cold start, gap reset,
    out-of-order). ``is_anomaly`` is the *combined* decision:
    ``iforest_score > 0.61 OR zstatus == "anomalous"``.
    """

    bucket_start: str
    features: FeatureVector
    zscore: float | None
    zstatus: str
    iforest_score: float | None
    is_anomaly: bool

    def to_dict(self) -> dict[str, Any]:
        """Contract timeline keys: bucketStart, rate, errorRatio, failedAuthRatio,
        uniqueActors, zscore, iforestScore, isAnomaly (+ ``zstatus``)."""
        return {
            "bucketStart": self.bucket_start,
            "rate": self.features.rate,
            "errorRatio": self.features.error_ratio,
            "failedAuthRatio": self.features.failed_auth_ratio,
            "uniqueActors": self.features.unique_actors,
            "zscore": self.zscore,
            "iforestScore": self.iforest_score,
            "isAnomaly": self.is_anomaly,
            "zstatus": self.zstatus,
        }


@dataclass(slots=True)
class MethodMetrics:
    """Precision/recall/F1/FPR + confusion counts. All divisions are zero-safe
    (a missing denominator yields 0.0 — documented, never NaN)."""

    precision: float
    recall: float
    f1: float
    fpr: float
    confusion: dict[str, int]

    def to_dict(self) -> dict[str, Any]:
        return {
            "precision": self.precision,
            "recall": self.recall,
            "f1": self.f1,
            "fpr": self.fpr,
            "confusion": dict(self.confusion),
        }


@dataclass(slots=True)
class EvaluationResult:
    """Deterministic evaluation output for one dataset across all methods."""

    dataset: str
    size: int
    anomalous: int
    seed: int
    methods: dict[str, MethodMetrics]
    model_versions: dict[str, str]
    notes: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "dataset": self.dataset,
            "size": self.size,
            "anomalous": self.anomalous,
            "seed": self.seed,
            "methods": {name: m.to_dict() for name, m in self.methods.items()},
            "modelVersions": dict(self.model_versions),
            "notes": list(self.notes),
        }
