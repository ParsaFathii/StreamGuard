# Copyright © 2026 Parsa Fathi — Apache-2.0
"""Schema validation tests: valid parses, every invalid field shape, missing
fields, extra-field rejection, batch skip-with-reason, feature vectors, and
the canonical event-level feature definitions."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from streamguard_analytics.schemas import (
    SEVERITY_WEIGHTS,
    EventRecord,
    FeatureVector,
    ValidationError,
    events_to_feature_vectors,
    feature_vector_from_bucket,
    is_error_event,
    is_failed_auth_event,
    parse_events,
)


def _fields(exc: ValidationError) -> set[str]:
    return {e["field"] for e in exc.errors}


# ------------------------------------------------------------------- events

def test_valid_event_full(valid_event) -> None:
    record = EventRecord.from_dict(valid_event)
    assert record.event_id == valid_event["event_id"]
    assert record.schema_version == 1
    assert record.event_time == datetime(2026, 1, 1, 0, 0, 17, tzinfo=timezone.utc)
    assert record.source_id == "app-01"
    assert record.severity == "info"
    assert record.category == "auth"
    assert record.actor == "user-1"
    assert record.origin == "synthetic"


def test_valid_event_minimal(make_event) -> None:
    event = make_event()
    for optional in ("correlation_id", "trace_id", "actor", "origin", "attributes"):
        event.pop(optional)
    record = EventRecord.from_dict(event)
    assert record.correlation_id is None
    assert record.trace_id is None
    assert record.actor is None
    assert record.origin is None
    assert record.attributes == {}
    assert record.to_dict()["event_time"].endswith("Z")


def test_invalid_event_id_not_uuid(make_event) -> None:
    event = make_event()
    event["event_id"] = "not-a-uuid"
    with pytest.raises(ValidationError) as info:
        EventRecord.from_dict(event)
    assert "event_id" in _fields(info.value)


def test_invalid_event_id_wrong_version(make_event) -> None:
    event = make_event()
    event["event_id"] = str(uuid.uuid5(uuid.NAMESPACE_DNS, "streamguard"))  # v5
    with pytest.raises(ValidationError) as info:
        EventRecord.from_dict(event)
    assert "event_id" in _fields(info.value)
    assert any("v4" in e["reason"] for e in info.value.errors)


@pytest.mark.parametrize("version", [2, "1", True, None])
def test_invalid_schema_version(make_event, version) -> None:
    event = make_event()
    event["schema_version"] = version
    with pytest.raises(ValidationError) as info:
        EventRecord.from_dict(event)
    assert "schema_version" in _fields(info.value)


@pytest.mark.parametrize(
    "event_time",
    ["not a date", "2026-01-01T12:00:00", "2026-01-01T12:00:00+02:00", 123, None],
)
def test_invalid_event_time(make_event, event_time) -> None:
    event = make_event()
    event["event_time"] = event_time
    with pytest.raises(ValidationError) as info:
        EventRecord.from_dict(event)
    assert "event_time" in _fields(info.value)


@pytest.mark.parametrize("source_id", ["has space!", "x" * 65, "", 5, None])
def test_invalid_source_id(make_event, source_id) -> None:
    event = make_event()
    event["source_id"] = source_id
    with pytest.raises(ValidationError) as info:
        EventRecord.from_dict(event)
    assert "source_id" in _fields(info.value)


@pytest.mark.parametrize("source_type", ["web", "APP", None])
def test_invalid_source_type(make_event, source_type) -> None:
    event = make_event()
    event["source_type"] = source_type
    with pytest.raises(ValidationError) as info:
        EventRecord.from_dict(event)
    assert "source_type" in _fields(info.value)


@pytest.mark.parametrize("severity", ["extreme", "INFO", None])
def test_invalid_severity(make_event, severity) -> None:
    event = make_event()
    event["severity"] = severity
    with pytest.raises(ValidationError) as info:
        EventRecord.from_dict(event)
    assert "severity" in _fields(info.value)


@pytest.mark.parametrize("category", ["authz", "networking", None])
def test_invalid_category(make_event, category) -> None:
    event = make_event()
    event["category"] = category
    with pytest.raises(ValidationError) as info:
        EventRecord.from_dict(event)
    assert "category" in _fields(info.value)


@pytest.mark.parametrize("message", ["", "x" * 513, None])
def test_invalid_message(make_event, message) -> None:
    event = make_event()
    event["message"] = message
    with pytest.raises(ValidationError) as info:
        EventRecord.from_dict(event)
    assert "message" in _fields(info.value)


def test_invalid_attributes_type_and_size(make_event) -> None:
    event = make_event()
    event["attributes"] = ["not", "an", "object"]
    with pytest.raises(ValidationError) as info:
        EventRecord.from_dict(event)
    assert "attributes" in _fields(info.value)

    event = make_event()
    event["attributes"] = {"blob": "y" * 5000}  # > 4KB stringified
    with pytest.raises(ValidationError) as info:
        EventRecord.from_dict(event)
    assert "attributes" in _fields(info.value)
    assert any("4096" in e["reason"] for e in info.value.errors)


@pytest.mark.parametrize(
    "field, value",
    [("correlation_id", "c" * 129), ("trace_id", "t" * 129), ("actor", 123), ("origin", "alien")],
)
def test_invalid_optional_fields(make_event, field, value) -> None:
    event = make_event()
    event[field] = value
    with pytest.raises(ValidationError) as info:
        EventRecord.from_dict(event)
    assert field in _fields(info.value)


def test_extra_field_rejected(make_event) -> None:
    event = make_event()
    event["foo"] = 1
    with pytest.raises(ValidationError) as info:
        EventRecord.from_dict(event)
    assert "foo" in _fields(info.value)
    assert any("unknown field" in e["reason"] for e in info.value.errors)


def test_missing_required_fields_listed_together(make_event) -> None:
    event = make_event()
    for required in ("event_id", "schema_version", "event_time", "source_id", "message", "severity"):
        event.pop(required)
    with pytest.raises(ValidationError) as info:
        EventRecord.from_dict(event)
    fields = _fields(info.value)
    assert {"event_id", "schema_version", "event_time", "source_id", "message", "severity"} <= fields


def test_non_dict_input_rejected() -> None:
    with pytest.raises(ValidationError) as info:
        EventRecord.from_dict("not an object")  # type: ignore[arg-type]
    assert "$event" in _fields(info.value)


def test_all_problems_reported_not_just_first(make_event) -> None:
    event = make_event()
    event["severity"] = "extreme"
    event["extra"] = True
    with pytest.raises(ValidationError) as info:
        EventRecord.from_dict(event)
    assert _fields(info.value) == {"severity", "extra"}


def test_parse_events_skip_with_reason(make_event) -> None:
    good = [make_event(minute=i) for i in range(3)]
    bad1 = make_event()
    bad1["severity"] = "nope"
    bad2 = "not a dict"
    records, errors = parse_events([good[0], bad1, good[1], bad2, good[2]])
    assert len(records) == 3
    assert [e["index"] for e in errors] == [1, 3]
    assert all("reasons" in e and e["reasons"] for e in errors)
    assert errors[0]["reasons"][0]["field"] == "severity"


# ------------------------------------------------- canonical feature rules

def test_is_error_event() -> None:
    def ev(severity="info", error=None):
        attrs = {} if error is None else {"error": error}
        return EventRecord(
            event_id="x", schema_version=1, event_time=datetime(2026, 1, 1, tzinfo=timezone.utc),
            source_id="s", source_type="app", severity=severity, category="auth",
            message="m", attributes=attrs,
        )

    assert is_error_event(ev("medium"))
    assert is_error_event(ev("high"))
    assert is_error_event(ev("critical"))
    assert is_error_event(ev("info", error=True))
    assert not is_error_event(ev("info"))
    assert not is_error_event(ev("low"))


def test_is_failed_auth_event() -> None:
    def ev(category, action):
        return EventRecord(
            event_id="x", schema_version=1, event_time=datetime(2026, 1, 1, tzinfo=timezone.utc),
            source_id="s", source_type="app", severity="info", category=category,
            message="m", attributes={"action": action},
        )

    assert is_failed_auth_event(ev("auth", "login_failed"))
    assert is_failed_auth_event(ev("auth", "auth_failed"))
    assert is_failed_auth_event(ev("security", "access_denied"))
    assert not is_failed_auth_event(ev("auth", "login_success"))
    assert not is_failed_auth_event(ev("application", "login_failed"))
    assert not is_failed_auth_event(ev("security", "access_granted"))


def test_feature_vector_from_bucket(make_event) -> None:
    events = [
        make_event(minute=0, category="auth", action="login_failed", severity="info", actor="u1"),
        make_event(minute=0, category="auth", action="login_failed", severity="info", actor="u2"),
        make_event(minute=0, category="application", severity="high", actor=None, message="db timeout"),
        make_event(minute=0, category="network", severity="info", actor="u1", message="request"),
        make_event(minute=0, category="security", severity="medium", action="access_denied", actor="u3"),
    ]
    fv = feature_vector_from_bucket([EventRecord.from_dict(e) for e in events])
    assert fv.rate == 5.0
    assert fv.failed_auth_ratio == pytest.approx(3 / 5)  # 2 login_failed + 1 access_denied
    assert fv.error_ratio == pytest.approx(2 / 5)  # high severity + medium severity
    assert fv.unique_actors == 3  # u1, u2, u3 (None actor not counted)
    expected_sev = (0.0 + 0.0 + SEVERITY_WEIGHTS["high"] + 0.0 + SEVERITY_WEIGHTS["medium"]) / 5
    assert fv.avg_severity_weight == pytest.approx(expected_sev)


def test_events_to_feature_vectors_buckets_by_minute(make_event) -> None:
    events = [EventRecord.from_dict(e) for e in [make_event(minute=0) for _ in range(2)] + [make_event(minute=3)]]
    bucketed = events_to_feature_vectors(events)
    assert [b[1].rate for b in bucketed] == [2.0, 1.0]
    assert bucketed[0][0] < bucketed[1][0]


def test_feature_vector_from_empty_bucket_raises() -> None:
    with pytest.raises(ValidationError):
        feature_vector_from_bucket([])


# ------------------------------------------------------------ FeatureVector

def test_feature_vector_valid_and_to_row() -> None:
    fv = FeatureVector(rate=30.0, error_ratio=0.05, failed_auth_ratio=0.03, unique_actors=7, avg_severity_weight=0.15)
    fv.validate()
    assert fv.to_row() == [30.0, 0.05, 0.03, 7, 0.15]


@pytest.mark.parametrize(
    "kwargs, field",
    [
        (dict(rate=-1.0), "rate"),
        (dict(error_ratio=1.5), "error_ratio"),
        (dict(failed_auth_ratio=-0.1), "failed_auth_ratio"),
        (dict(unique_actors=-2), "unique_actors"),
        (dict(avg_severity_weight=1.2), "avg_severity_weight"),
    ],
)
def test_feature_vector_invalid_ranges(kwargs, field) -> None:
    base = dict(rate=30.0, error_ratio=0.05, failed_auth_ratio=0.03, unique_actors=7, avg_severity_weight=0.15)
    fv = FeatureVector(**{**base, **kwargs})
    with pytest.raises(ValidationError) as info:
        fv.validate()
    assert field in _fields(info.value)


def test_feature_vector_non_finite() -> None:
    fv = FeatureVector(rate=float("nan"), error_ratio=0.05, failed_auth_ratio=0.03, unique_actors=7, avg_severity_weight=0.15)
    with pytest.raises(ValidationError) as info:
        fv.validate()
    assert "rate" in _fields(info.value)


def test_feature_vector_from_row_errors() -> None:
    with pytest.raises(ValidationError) as info:
        FeatureVector.from_row([30, 0.05, 0.03, 7])  # wrong length
    assert "$row" in _fields(info.value)
    with pytest.raises(ValidationError) as info:
        FeatureVector.from_row([30, 0.05, 0.03, 7.5, 0.15])  # non-integer actors
    assert "$row[3]" in _fields(info.value)
    with pytest.raises(ValidationError) as info:
        FeatureVector.from_row([30, 0.05, 0.03, 7, float("inf")])
    assert "$row[4]" in _fields(info.value)
    with pytest.raises(ValidationError) as info:
        FeatureVector.from_row([30, -0.2, 0.03, 7, 0.15])
    assert "error_ratio" in _fields(info.value)
