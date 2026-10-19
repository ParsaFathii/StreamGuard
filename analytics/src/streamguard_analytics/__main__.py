# Copyright © 2026 Parsa Fathi — Apache-2.0
"""CLI: ``python -m streamguard_analytics <command>``.

Commands:
- ``evaluate [--dataset all|NAME] [--json]`` — run the deterministic labeled
  evaluation and print a metrics table (or JSON).
- ``serve [--host H] [--port P]`` — start the sidecar HTTP server
  (port from ``--port`` or ``ANALYTICS_PORT`` env var, default 8090).
- ``analyze --json-file PATH`` — analyze a ``{"features": ...}`` or
  ``{"events": ...}`` payload from a file and print the JSON result.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Sequence

from . import __version__
from .anomaly import MODEL_VERSION
from .baselines import BASELINE_VERSION
from .evaluation import RULES_VERSION, EvaluationResult, evaluate_dataset
from .server import RequestError, analyze_payload, serve

_TABLE_HEADER = (
    f"{'dataset':<22} {'method':<8} {'prec':>6} {'rec':>6} {'f1':>6} {'fpr':>6}"
    f" {'tp':>5} {'fp':>5} {'tn':>5} {'fn':>5}"
)


def _print_table(results: Sequence[EvaluationResult]) -> None:
    print(_TABLE_HEADER)
    print("-" * len(_TABLE_HEADER))
    for result in results:
        for method, metrics in result.methods.items():
            print(
                f"{result.dataset:<22} {method:<8} {metrics.precision:>6.3f} "
                f"{metrics.recall:>6.3f} {metrics.f1:>6.3f} {metrics.fpr:>6.3f} "
                f"{metrics.confusion['tp']:>5} {metrics.confusion['fp']:>5} "
                f"{metrics.confusion['tn']:>5} {metrics.confusion['fn']:>5}"
            )


def _cmd_evaluate(args: argparse.Namespace) -> int:
    from .datasets import ALL_DATASETS

    if args.dataset == "all":
        names = list(ALL_DATASETS)
    elif args.dataset in ALL_DATASETS:
        names = [args.dataset]
    else:
        print(
            f"error: unknown dataset {args.dataset!r}; available: {sorted(ALL_DATASETS)}",
            file=sys.stderr,
        )
        return 2
    results = [evaluate_dataset(name) for name in names]
    if args.json:
        print(json.dumps([r.to_dict() for r in results], indent=2))
        return 0
    print(
        "StreamGuard Analytics — evaluation on synthetic labeled scenarios "
        "(seed 42). NOT production claims; see analytics/README.md."
    )
    print(f"model versions: rules={RULES_VERSION}, zscore={BASELINE_VERSION}, iforest={MODEL_VERSION}")
    print()
    _print_table(results)
    return 0


def _cmd_serve(args: argparse.Namespace) -> int:
    serve(host=args.host, port=args.port)
    return 0


def _cmd_analyze(args: argparse.Namespace) -> int:
    try:
        with open(args.json_file, "r", encoding="utf-8") as handle:
            payload: Any = json.load(handle)
    except OSError as exc:
        print(f"error: cannot read {args.json_file}: {exc}", file=sys.stderr)
        return 2
    except json.JSONDecodeError as exc:
        print(f"error: {args.json_file} is not valid JSON: {exc}", file=sys.stderr)
        return 2
    try:
        result = analyze_payload(payload)
    except RequestError as exc:
        print(json.dumps({"error": {"code": exc.code, "message": exc.message}}), file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2))
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entry point (console script ``streamguard-analytics``)."""
    parser = argparse.ArgumentParser(
        prog="streamguard-analytics",
        description="StreamGuard analytics & ML package (deterministic, seeded)",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    p_evaluate = sub.add_parser("evaluate", help="run labeled evaluation and print metrics")
    p_evaluate.add_argument("--dataset", default="all", help="dataset name or 'all' (default)")
    p_evaluate.add_argument("--json", action="store_true", help="print JSON instead of a table")
    p_evaluate.set_defaults(func=_cmd_evaluate)

    p_serve = sub.add_parser("serve", help="start the sidecar HTTP server")
    p_serve.add_argument("--host", default="127.0.0.1", help="bind address (default 127.0.0.1)")
    p_serve.add_argument("--port", type=int, default=None, help="port (default: ANALYTICS_PORT env or 8090)")
    p_serve.set_defaults(func=_cmd_serve)

    p_analyze = sub.add_parser("analyze", help="analyze a features/events payload from a JSON file")
    p_analyze.add_argument("--json-file", required=True, help="path to a JSON payload file")
    p_analyze.set_defaults(func=_cmd_analyze)

    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
