"""Canonical benchmark report construction and deterministic JSON output."""

from __future__ import annotations

from datetime import datetime
import json
import math
from pathlib import Path
from typing import Any, Mapping

from .metrics import RetrievalMetrics

REPORT_SCHEMA_VERSION = 2
MIN_KNOWN_RELEASE_QUERIES = 1_000
MIN_UNKNOWN_RELEASE_QUERIES = 600


def build_benchmark_report(
    *,
    mode: str,
    created_at: str,
    dataset_id: str,
    manifest_fingerprint: str,
    split_fingerprint: str,
    seed: int,
    metrics: RetrievalMetrics,
    accept_threshold: float,
    target_far: float,
    validation_unknown_queries: int,
    checkpoint_sha256: str | None = None,
    float_onnx_bytes: int = 0,
    int8_onnx_bytes: int = 0,
    reference_index_bytes: int = 0,
    device_benchmarks: list[dict[str, Any]] | None = None,
    high_value_recall_at_5: float | None = None,
    correction_rate: float | None = None,
    rights_approved_for_model: bool = False,
    environment_lock_sha256: str | None = None,
) -> dict[str, Any]:
    if mode not in {"dry-run", "benchmark"}:
        raise ValueError("mode must be 'dry-run' or 'benchmark'")
    _validate_timestamp(created_at)
    for name, digest in (
        ("manifest_fingerprint", manifest_fingerprint),
        ("split_fingerprint", split_fingerprint),
    ):
        if len(digest) != 64 or any(character not in "0123456789abcdef" for character in digest):
            raise ValueError(f"{name} must be a lowercase SHA-256 digest")
    if checkpoint_sha256 is not None and (
        len(checkpoint_sha256) != 64
        or any(character not in "0123456789abcdef" for character in checkpoint_sha256)
    ):
        raise ValueError("checkpoint_sha256 must be null or a lowercase SHA-256 digest")
    if environment_lock_sha256 is not None and (
        len(environment_lock_sha256) != 64
        or any(character not in "0123456789abcdef" for character in environment_lock_sha256)
    ):
        raise ValueError("environment_lock_sha256 must be null or a lowercase SHA-256 digest")

    metric_values = metrics.to_dict()
    int8_size_gate = int8_onnx_bytes > 0 and int8_onnx_bytes <= 5 * 1024 * 1024
    latency_rows = device_benchmarks or []
    phone_rows = [
        row
        for row in latency_rows
        if row.get("target_phone") is True and "onnxruntime-web" in str(row.get("runtime", ""))
    ]
    latency_gate = len(phone_rows) >= 2 and all(row["p95_ms"] < 250 for row in phone_rows)
    gates = {
        "top1_beta_at_least_0_95": metrics.top1 >= 0.95,
        "top1_product_at_least_0_98": metrics.top1 >= 0.98,
        "recall_at_5_at_least_0_99": metrics.recall_at_5 >= 0.99,
        "known_test_queries_at_least_1000": metrics.known_queries >= MIN_KNOWN_RELEASE_QUERIES,
        "validation_unknown_queries_at_least_600": validation_unknown_queries
        >= MIN_UNKNOWN_RELEASE_QUERIES,
        "test_unknown_queries_at_least_600": metrics.unknown_queries
        >= MIN_UNKNOWN_RELEASE_QUERIES,
        "far_below_0_005": metrics.false_accept_rate < 0.005,
        "calibration_target_far_at_most_0_005": target_far <= 0.005,
        "ece_at_most_0_05": metrics.expected_calibration_error <= 0.05,
        "high_value_recall_at_5_at_least_0_995": high_value_recall_at_5 is not None
        and high_value_recall_at_5 >= 0.995,
        "correction_rate_below_0_05": correction_rate is not None and correction_rate < 0.05,
        "int8_model_at_most_5_mib": int8_size_gate,
        "reference_index_present": reference_index_bytes > 0,
        "two_target_phones_p95_below_250_ms": latency_gate,
        "publish_model_rights_approved": rights_approved_for_model,
        "environment_lock_recorded": environment_lock_sha256 is not None,
    }
    eligible = mode == "benchmark" and all(gates.values())
    return {
        "schema_version": REPORT_SCHEMA_VERSION,
        "mode": mode,
        "created_at": created_at,
        "dataset_id": dataset_id,
        "manifest_fingerprint": manifest_fingerprint,
        "split_fingerprint": split_fingerprint,
        "seed": seed,
        "model": {
            "architecture": "mobilenet_v3_small_128d_l2",
            "embedding_dimension": 128,
            "input_size": 224,
            "checkpoint_sha256": checkpoint_sha256,
        },
        "metrics": metric_values,
        "calibration": {
            "accept_threshold": accept_threshold,
            "target_far": target_far,
            "validation_unknown_queries": validation_unknown_queries,
            "method": "platt-top-score-margin-v1",
        },
        "artifacts": {
            "float_onnx_bytes": float_onnx_bytes,
            "int8_onnx_bytes": int8_onnx_bytes,
            "reference_index_bytes": reference_index_bytes,
        },
        "device_benchmarks": latency_rows,
        "release_evidence": {
            "high_value_recall_at_5": high_value_recall_at_5,
            "correction_rate": correction_rate,
            "rights_approved_for_model": rights_approved_for_model,
            "environment_lock_sha256": environment_lock_sha256,
        },
        "gates": gates,
        "eligible_for_release": eligible,
    }


def write_canonical_json(path: str | Path, payload: Mapping[str, Any]) -> None:
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, sort_keys=True, indent=2, ensure_ascii=False, allow_nan=False) + "\n"
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_text(text, encoding="utf-8")
    temporary.replace(destination)


def _validate_timestamp(value: str) -> None:
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except (TypeError, ValueError) as exc:
        raise ValueError("created_at must be an RFC 3339 timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("created_at must include a timezone")
