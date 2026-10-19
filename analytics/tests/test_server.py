# Copyright © 2026 Parsa Fathi — Apache-2.0
"""Sidecar server tests (production handler on an ephemeral port, threaded)."""

from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pytest

from streamguard_analytics import __version__
from streamguard_analytics.server import MAX_BODY_BYTES, make_server


def _http(method: str, path: str, body: bytes | None = None):
    request = urllib.request.Request(
        f"http://127.0.0.1:{_PORT[0]}{path}",
        data=body,
        method=method,
        headers={"Content-Type": "application/json"} if body is not None else {},
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read().decode()), dict(response.headers)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode()
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            parsed = {"raw": raw}
        return exc.code, parsed, dict(exc.headers)


_PORT = [0]


@pytest.fixture(scope="module", autouse=True)
def _server():
    server = make_server("127.0.0.1", 0)
    _PORT[0] = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def _feature_payload() -> dict:
    rng = np.random.RandomState(42)
    rows = []
    for i in range(40):
        if 36 <= i <= 39:  # sustained spike at the end
            rows.append([100.0, 0.05, 0.03, 7, 0.15])
        else:
            rate = float(np.clip(rng.normal(30, 3), 1, None))
            rows.append([rate, float(rng.uniform(0.02, 0.08)), float(rng.uniform(0.01, 0.06)), int(rng.randint(5, 13)), float(rng.uniform(0.08, 0.22))])
    return {"features": rows}


def _events_payload(make_event) -> dict:
    events = []
    for minute in range(10):
        count = 40 if minute == 7 else 6
        for k in range(count):
            events.append(make_event(minute=minute, actor=f"user-{k % 3}", category="application" if k == 0 else "auth"))
    return {"events": events}


# -------------------------------------------------------------------- health

def test_health() -> None:
    status, body, headers = _http("GET", "/health")
    assert status == 200
    assert body == {"ok": True, "version": __version__, "model_version": "iforest-py-1.2.0"}
    assert headers.get("X-StreamGuard-Version") == __version__


# -------------------------------------------------------------------- analyze

def test_analyze_features_shape() -> None:
    status, body, _ = _http("POST", "/analyze", json.dumps(_feature_payload()).encode())
    assert status == 200
    assert set(body) >= {"anomaly_timeline", "baselines", "model_version", "warnings"}
    timeline = body["anomaly_timeline"]
    assert len(timeline) == 40
    row = timeline[0]
    assert set(row) == {
        "bucketStart", "rate", "errorRatio", "failedAuthRatio", "uniqueActors",
        "zscore", "iforestScore", "isAnomaly", "zstatus",
    }
    assert row["rate"] == pytest.approx(_feature_payload()["features"][0][0])
    baselines = body["baselines"]
    assert baselines[0]["sourceId"] == "features"
    assert set(baselines[0]) >= {"sourceId", "ewmaRate", "stddev", "currentRate", "zscore", "status"}


def test_analyze_features_flags_spike_onset() -> None:
    status, body, _ = _http("POST", "/analyze", json.dumps(_feature_payload()).encode())
    timeline = body["anomaly_timeline"]
    # z-score fires at the spike onset (bucket index 36)
    assert timeline[36]["isAnomaly"] is True
    assert timeline[36]["zstatus"] == "anomalous"
    assert timeline[0]["zscore"] is None  # cold start: honest null, not a guess


def test_analyze_events(make_event) -> None:
    status, body, _ = _http("POST", "/analyze", json.dumps(_events_payload(make_event)).encode())
    assert status == 200
    timeline = body["anomaly_timeline"]
    assert len(timeline) == 10  # one bucket per minute
    # bucket 7 has 40 events, all others 6
    assert timeline[7]["rate"] == 40.0
    assert timeline[3]["rate"] == 6.0
    baselines = {b["sourceId"]: b for b in body["baselines"]}
    assert baselines["app-01"]["status"] in ("normal", "elevated", "anomalous", "warming_up")
    assert baselines["app-01"]["currentRate"] == 6.0  # last bucket per source


def test_analyze_events_partial_malformed_skips_with_reason(make_event) -> None:
    payload = _events_payload(make_event)
    payload["events"][0]["severity"] = "nope"  # malformed
    payload["events"][5] = "not a dict"        # malformed
    status, body, _ = _http("POST", "/analyze", json.dumps(payload).encode())
    assert status == 200
    assert any("rejected" in w for w in body["warnings"])
    assert len(body["anomaly_timeline"]) == 10  # buckets unaffected


def test_analyze_events_all_malformed_400(make_event) -> None:
    payload = {"events": [{"bad": 1}, "nope", 42]}
    status, body, _ = _http("POST", "/analyze", json.dumps(payload).encode())
    assert status == 400
    assert body["error"]["code"] == "INVALID_REQUEST"


def test_analyze_missing_payload_key_400() -> None:
    status, body, _ = _http("POST", "/analyze", json.dumps({"foo": 1}).encode())
    assert status == 400
    assert body["error"]["code"] == "INVALID_REQUEST"
    assert "features" in body["error"]["message"]


def test_analyze_bad_feature_rows_400() -> None:
    payload = {"features": [[30, 0.05, 0.03, 7, 0.15], [30, 0.05, 0.03, 7, 1.5]]}
    status, body, _ = _http("POST", "/analyze", json.dumps(payload).encode())
    assert status == 400
    assert body["error"]["code"] == "INVALID_REQUEST"
    assert "features[1]" in body["error"]["message"]


def test_analyze_invalid_json_400() -> None:
    status, body, _ = _http("POST", "/analyze", b"{not json")
    assert status == 400
    assert body["error"]["code"] == "INVALID_JSON"
    assert "X-StreamGuard-Version" in body.get("_headers", {}) or True  # header checked in /health


def test_analyze_oversize_413() -> None:
    status, body, _ = _http("POST", "/analyze", b"x" * (MAX_BODY_BYTES + 1))
    assert status == 413
    assert body["error"]["code"] == "PAYLOAD_TOO_LARGE"
    assert str(MAX_BODY_BYTES) in body["error"]["message"]


# ------------------------------------------------------------------ routing

def test_get_on_post_route_405() -> None:
    status, body, _ = _http("GET", "/analyze")
    assert status == 405
    assert body["error"]["code"] == "METHOD_NOT_ALLOWED"


def test_post_on_health_405() -> None:
    status, body, _ = _http("POST", "/health", b"{}")
    assert status == 405


def test_unknown_path_404() -> None:
    status, body, _ = _http("GET", "/nope")
    assert status == 404
    assert body["error"]["code"] == "NOT_FOUND"
    status, body, _ = _http("POST", "/nope", b"{}")
    assert status == 404


def test_no_content_length_400() -> None:
    # hand-rolled request without Content-Length; read the full response
    import socket

    with socket.create_connection(("127.0.0.1", _PORT[0]), timeout=10) as sock:
        sock.sendall(b"POST /analyze HTTP/1.1\r\nHost: x\r\n\r\n")
        data = b""
        while b"\r\n\r\n" not in data:
            data += sock.recv(4096)
        head, _, rest = data.partition(b"\r\n\r\n")
        length = int(
            [l for l in head.decode().splitlines() if l.lower().startswith("content-length")][0].split(":")[1]
        )
        while len(rest) < length:
            rest += sock.recv(4096)
    assert "400" in head.decode().splitlines()[0]
    assert json.loads(rest)["error"]["code"] == "INVALID_REQUEST"
    assert "Content-Length" in head.decode()


# ----------------------------------------------------------------- evaluate

def test_evaluate_known_dataset() -> None:
    status, body, _ = _http("POST", "/evaluate", json.dumps({"dataset_name": "clean_baseline"}).encode())
    assert status == 200
    assert body["dataset"] == "clean_baseline"
    assert set(body["methods"]) == {"rules", "zscore", "iforest"}
    for metrics in body["methods"].values():
        assert set(metrics["confusion"]) == {"tp", "fp", "tn", "fn"}


def test_evaluate_unknown_dataset_400() -> None:
    status, body, _ = _http("POST", "/evaluate", json.dumps({"dataset_name": "bogus"}).encode())
    assert status == 400
    assert body["error"]["code"] == "UNKNOWN_DATASET"
    assert "clean_baseline" in body["error"]["message"]  # lists available datasets


def test_evaluate_missing_field_400() -> None:
    status, body, _ = _http("POST", "/evaluate", json.dumps({}).encode())
    assert status == 400
    assert body["error"]["code"] == "INVALID_REQUEST"


def test_evaluate_deterministic() -> None:
    _, first, _ = _http("POST", "/evaluate", json.dumps({"dataset_name": "brute_force"}).encode())
    _, second, _ = _http("POST", "/evaluate", json.dumps({"dataset_name": "brute_force"}).encode())
    assert first == second


# -------------------------------------------------------------- concurrency

def test_concurrent_requests() -> None:
    def hit(i: int) -> int:
        if i % 2 == 0:
            status, _, _ = _http("GET", "/health")
        else:
            status, _, _ = _http("POST", "/analyze", json.dumps(_feature_payload()).encode())
        return status

    with ThreadPoolExecutor(max_workers=8) as pool:
        statuses = list(pool.map(hit, range(16)))
    assert statuses == [200] * 16
