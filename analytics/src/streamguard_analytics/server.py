# Copyright © 2026 Parsa Fathi — Apache-2.0
"""Sidecar HTTP service (stdlib :mod:`http.server`, threaded).

Endpoints:
- ``GET  /health``           → ``{"ok": true, "version", "model_version"}``
- ``POST /analyze``          → body ``{"features": [[r, e, f, a, s], ...]}`` or
  ``{"events": [event dicts]}`` →
  ``{"anomaly_timeline", "baselines", "model_version", "warnings"}``
- ``POST /evaluate``         → body ``{"dataset_name": "..."}`` →
  :class:`~streamguard_analytics.schemas.EvaluationResult` dict (deterministic)

Error shape per contract: ``{"error": {"code": "MACHINE_CODE", "message": ...}}``
with proper HTTP status (400 INVALID_JSON / INVALID_REQUEST / UNKNOWN_DATASET,
413 PAYLOAD_TOO_LARGE, 404 NOT_FOUND, 405 METHOD_NOT_ALLOWED, 500 INTERNAL).
Every response carries ``X-StreamGuard-Version``.

Statelessness (documented): no state is kept between requests. The isolation
forest and EWMA trackers are created *per request* (transductive scoring on
the submitted data); nothing is cached, so results are reproducible and the
service is safe to restart at any time.

Limitations (documented):
- Request bodies are capped at 256 KiB (413 above); ``Content-Length`` is
  required (no chunked support in :mod:`http.server`).
- Requests with fewer than 5 buckets produce a warning: z-score cold start
  and the forest are unreliable at that size (results are still returned,
  never fabricated).
"""

from __future__ import annotations

import json
import os
from collections import Counter
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Mapping

import numpy as np

from . import __version__
from .anomaly import DEFAULT_SEED, THRESHOLD, MODEL_VERSION, IsolationForest
from .baselines import EWMABaselineTracker
from .evaluation import evaluate_dataset
from .schemas import (
    AnomalyPoint,
    EventRecord,
    FeatureVector,
    ValidationError,
    events_to_feature_vectors,
    iso_z,
    parse_events,
)

__all__ = ["RequestError", "analyze_payload", "evaluate_payload", "make_server", "serve"]

MAX_BODY_BYTES = 256 * 1024
#: Upper bound on how many bytes of an oversized body get drained before the
#: 413 is sent (lets well-behaved clients finish writing; bigger uploads are
#: cut off — documented limitation).
_MAX_DRAIN_BYTES = 8 * 1024 * 1024
DEFAULT_PORT = 8090
_FALLBACK_EPOCH = datetime(2026, 1, 1, tzinfo=timezone.utc)


class RequestError(Exception):
    """A request-level failure mapped to a contract JSON error."""

    def __init__(self, code: str, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


# ------------------------------------------------------------------ analysis

def _timeline_and_tracker(
    matrix: np.ndarray, bucket_starts: list[datetime]
) -> tuple[list[dict[str, Any]], list[str], EWMABaselineTracker]:
    """Score one feature matrix: EWMA z-score per bucket + isolation forest."""
    tracker = EWMABaselineTracker()
    z_results = [tracker.push(ts, float(row[0])) for ts, row in zip(bucket_starts, matrix)]
    forest = IsolationForest(seed=DEFAULT_SEED)
    scores = forest.fit(matrix).score(matrix)

    warnings: list[str] = []
    unscored = Counter(r.status for r in z_results if not r.scored)
    for status, count in sorted(unscored.items()):
        warnings.append(f"z-score: {count} bucket(s) not scored ({status}); those rows have zscore=null")
    for result in [r for r in z_results if r.note][:10]:
        warnings.append(f"bucket {iso_z(result.bucket_start)}: {result.note}")

    timeline: list[dict[str, Any]] = []
    for i, (z, score) in enumerate(zip(z_results, scores)):
        is_anomaly = bool(score > THRESHOLD or (z.scored and z.status == "anomalous"))
        point = AnomalyPoint(
            bucket_start=iso_z(bucket_starts[i]),
            features=FeatureVector.from_row(matrix[i]),
            zscore=z.zscore if z.scored else None,
            zstatus=z.status,
            iforest_score=float(score),
            is_anomaly=is_anomaly,
        )
        timeline.append(point.to_dict())
    return timeline, warnings, tracker


def _per_source_baselines(records: list[EventRecord]) -> list[dict[str, Any]]:
    """Contract ``currentBaselines`` per source: EWMA on that source's
    events-per-minute series (only minutes where the source was observed)."""
    by_source: dict[str, list[EventRecord]] = {}
    for record in records:
        by_source.setdefault(record.source_id, []).append(record)
    baselines: list[dict[str, Any]] = []
    for source_id in sorted(by_source):
        bucketed = events_to_feature_vectors(by_source[source_id])
        tracker = EWMABaselineTracker()
        for start, fv in bucketed:
            tracker.push(start, fv.rate)
        snap = tracker.snapshot()
        baselines.append(
            {
                "sourceId": source_id,
                "ewmaRate": snap["ewmaRate"],
                "stddev": snap["stddev"],
                "currentRate": snap["currentRate"],
                "zscore": snap["zscore"],
                "status": snap["status"],
            }
        )
    return baselines


def analyze_payload(payload: Mapping[str, Any]) -> dict[str, Any]:
    """Core ``POST /analyze`` logic (shared with the CLI). Raises
    :class:`RequestError` for invalid input."""
    if not isinstance(payload, Mapping):
        raise RequestError("INVALID_REQUEST", "body must be a JSON object")
    warnings: list[str] = []

    if "events" in payload:
        items = payload["events"]
        if not isinstance(items, list):
            raise RequestError("INVALID_REQUEST", "'events' must be a list of event objects")
        records, errors = parse_events(items)
        for error in errors:
            reasons = "; ".join(f"{e['field']}: {e['reason']}" for e in error["reasons"])
            warnings.append(f"event[{error['index']}]: rejected — {reasons}")
        if not records:
            raise RequestError(
                "INVALID_REQUEST",
                "no valid events provided (all rejected); see the message for reasons",
            )
        bucketed = events_to_feature_vectors(records)
        matrix = np.array([fv.to_row() for _, fv in bucketed], dtype=float)
        starts = [start for start, _ in bucketed]
        timeline, score_warnings, _tracker = _timeline_and_tracker(matrix, starts)
        warnings.extend(score_warnings)
        baselines = _per_source_baselines(records)
    elif "features" in payload:
        rows = payload["features"]
        if not isinstance(rows, list) or not rows:
            raise RequestError("INVALID_REQUEST", "'features' must be a non-empty list of 5-value rows")
        vectors: list[FeatureVector] = []
        problems: list[dict[str, str]] = []
        for index, row in enumerate(rows):
            try:
                vectors.append(FeatureVector.from_row(row))
            except ValidationError as exc:
                for e in exc.errors:
                    problems.append({"field": f"features[{index}].{e['field']}", "reason": e["reason"]})
        if problems:
            raise RequestError(
                "INVALID_REQUEST",
                "invalid feature rows: " + "; ".join(f"{p['field']}: {p['reason']}" for p in problems[:10]),
            )
        matrix = np.array([v.to_row() for v in vectors], dtype=float)
        starts = [_FALLBACK_EPOCH + timedelta(minutes=i) for i in range(len(vectors))]
        warnings.append(
            "features input carries no timestamps; assuming 60s buckets from "
            + iso_z(_FALLBACK_EPOCH)
        )
        timeline, score_warnings, tracker = _timeline_and_tracker(matrix, starts)
        warnings.extend(score_warnings)
        snap = tracker.snapshot()
        baselines = [
            {
                "sourceId": "features",
                "ewmaRate": snap["ewmaRate"],
                "stddev": snap["stddev"],
                "currentRate": snap["currentRate"],
                "zscore": snap["zscore"],
                "status": snap["status"],
            }
        ]
    else:
        raise RequestError(
            "INVALID_REQUEST",
            "provide 'features' (list of 5-value rows) or 'events' (list of event objects)",
        )

    if matrix.shape[0] < 5:
        warnings.append(
            f"only {matrix.shape[0]} bucket(s): z-score cold start and the isolation "
            "forest are unreliable at this size (documented limitation)"
        )
    return {
        "anomaly_timeline": timeline,
        "baselines": baselines,
        "model_version": MODEL_VERSION,
        "warnings": warnings,
    }


def evaluate_payload(payload: Mapping[str, Any]) -> dict[str, Any]:
    """Core ``POST /evaluate`` logic. Raises :class:`RequestError` for invalid
    input (unknown dataset → UNKNOWN_DATASET)."""
    if not isinstance(payload, Mapping):
        raise RequestError("INVALID_REQUEST", "body must be a JSON object")
    name = payload.get("dataset_name")
    if not isinstance(name, str) or not name.strip():
        raise RequestError("INVALID_REQUEST", "'dataset_name' must be a non-empty string")
    try:
        return evaluate_dataset(name.strip()).to_dict()
    except ValueError as exc:
        raise RequestError("UNKNOWN_DATASET", str(exc)) from exc


# -------------------------------------------------------------------- server

_ROUTES: dict[str, set[str]] = {
    "/health": {"GET"},
    "/analyze": {"POST"},
    "/evaluate": {"POST"},
}


class _Handler(BaseHTTPRequestHandler):
    server_version = f"StreamGuardAnalytics/{__version__}"
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 — stdlib signature
        """Quiet sidecar: per-request access logging stays off (documented)."""

    # -- helpers ---------------------------------------------------------

    def _send_json(self, status: int, body: Mapping[str, Any]) -> None:
        raw = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("X-StreamGuard-Version", __version__)
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(raw)

    def _send_error_json(self, status: int, code: str, message: str) -> None:
        self._send_json(status, {"error": {"code": code, "message": message}})

    def _read_body(self) -> bytes:
        length_header = self.headers.get("Content-Length")
        if length_header is None:
            raise RequestError("INVALID_REQUEST", "Content-Length header required", 400)
        try:
            length = int(length_header)
        except ValueError as exc:
            raise RequestError("INVALID_REQUEST", "invalid Content-Length", 400) from exc
        if length <= 0:
            return b""
        if length > MAX_BODY_BYTES:
            # Drain (bounded) so the client can finish writing, then reject and
            # close — never parse leftover bytes as a new request.
            remaining = min(length, _MAX_DRAIN_BYTES)
            while remaining > 0:
                chunk = self.rfile.read(min(remaining, 65536))
                if not chunk:
                    break
                remaining -= len(chunk)
            self.close_connection = True
            raise RequestError(
                "PAYLOAD_TOO_LARGE", f"request body exceeds {MAX_BODY_BYTES} bytes", 413
            )
        return self.rfile.read(length)

    def _json_body(self) -> Any:
        raw = self._read_body()
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise RequestError("INVALID_JSON", f"request body is not valid JSON: {exc}", 400) from exc

    # -- verbs -----------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802 — stdlib naming
        path = self.path.split("?", 1)[0]
        try:
            if path == "/health":
                self._send_json(200, {"ok": True, "version": __version__, "model_version": MODEL_VERSION})
                return
            if path in _ROUTES:
                allowed = ", ".join(sorted(_ROUTES[path]))
                self._send_error_json(405, "METHOD_NOT_ALLOWED", f"{path} supports {allowed}")
                return
            self._send_error_json(404, "NOT_FOUND", f"unknown path: {path}")
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self) -> None:  # noqa: N802 — stdlib naming
        path = self.path.split("?", 1)[0]
        try:
            if path not in _ROUTES:
                self._send_error_json(404, "NOT_FOUND", f"unknown path: {path}")
                return
            if path == "/analyze":
                body = self._json_body()
                result = analyze_payload(body)
                self._send_json(200, result)
                return
            if path == "/evaluate":
                body = self._json_body()
                result = evaluate_payload(body)
                self._send_json(200, result)
                return
            allowed = ", ".join(sorted(_ROUTES[path]))
            self._send_error_json(405, "METHOD_NOT_ALLOWED", f"{path} supports {allowed}")
        except RequestError as exc:
            self._send_error_json(exc.status, exc.code, exc.message)
        except (ValidationError, ValueError) as exc:
            self._send_error_json(400, "INVALID_REQUEST", str(exc))
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # honest 500 — never swallow
            self._send_error_json(500, "INTERNAL", f"unexpected server error: {exc}")


def make_server(host: str = "127.0.0.1", port: int | None = None) -> ThreadingHTTPServer:
    """Create (not start) the threaded server. ``port=None`` uses
    ``ANALYTICS_PORT`` env var or :data:`DEFAULT_PORT` (8090)."""
    if port is None:
        port = int(os.environ.get("ANALYTICS_PORT", DEFAULT_PORT))
    return ThreadingHTTPServer((host, port), _Handler)


def serve(host: str = "127.0.0.1", port: int | None = None) -> None:
    """Start the sidecar and block until interrupted."""
    server = make_server(host, port)
    bound_host, bound_port = server.server_address[:2]
    print(f"streamguard-analytics {__version__} listening on http://{bound_host}:{bound_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
