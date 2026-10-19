# Copyright © 2026 Parsa Fathi — Apache-2.0
"""Shared test fixtures (no package state is mutated by any test)."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

import pytest

from streamguard_analytics.schemas import iso_z

_EPOCH = datetime(2026, 1, 1, tzinfo=timezone.utc)


@pytest.fixture
def make_event() -> Callable[..., dict[str, Any]]:
    """Factory for valid contract event dicts (one per call, fresh uuid4)."""

    def _make(
        minute: int = 0,
        *,
        source_id: str = "app-01",
        source_type: str = "app",
        severity: str = "info",
        category: str = "auth",
        message: str = "normalized text",
        action: str | None = None,
        error: bool | None = None,
        actor: str | None = "user-1",
        attributes: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        attrs: dict[str, Any] = dict(attributes or {})
        if action is not None:
            attrs["action"] = action
        if error is not None:
            attrs["error"] = error
        return {
            "event_id": str(uuid.uuid4()),
            "schema_version": 1,
            "event_time": iso_z(_EPOCH + timedelta(minutes=minute, seconds=17)),
            "source_id": source_id,
            "source_type": source_type,
            "severity": severity,
            "category": category,
            "message": message,
            "attributes": attrs,
            "correlation_id": "corr-1",
            "trace_id": "trace-1",
            "actor": actor,
            "origin": "synthetic",
        }

    return _make


@pytest.fixture
def valid_event(make_event: Callable[..., dict[str, Any]]) -> dict[str, Any]:
    """One ready-made valid event."""
    return make_event()
