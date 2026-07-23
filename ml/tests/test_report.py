from cardscope_ml.metrics import RetrievalMetrics
from cardscope_ml.report import build_benchmark_report


def _metrics(*, known: int = 1_000, unknown: int = 600) -> RetrievalMetrics:
    return RetrievalMetrics(
        top1=0.99,
        recall_at_5=1.0,
        false_accept_rate=0.0,
        expected_calibration_error=0.01,
        known_queries=known,
        unknown_queries=unknown,
        accepted_queries=known,
        false_accepts=0,
        accepted_wrong_known=0,
    )


def _report(**overrides: object) -> dict[str, object]:
    values = {
        "mode": "benchmark",
        "created_at": "2026-07-22T00:00:00Z",
        "dataset_id": "rights-cleared-pilot",
        "manifest_fingerprint": "a" * 64,
        "split_fingerprint": "b" * 64,
        "seed": 20260722,
        "metrics": _metrics(),
        "accept_threshold": 0.9,
        "target_far": 0.005,
        "validation_unknown_queries": 600,
        "checkpoint_sha256": "c" * 64,
        "float_onnx_bytes": 8_000_000,
        "int8_onnx_bytes": 4_000_000,
        "reference_index_bytes": 2_700_000,
        "device_benchmarks": [
            {
                "device": "Phone A",
                "runtime": "onnxruntime-web-1.20-wasm",
                "target_phone": True,
                "samples": 100,
                "p50_ms": 80.0,
                "p95_ms": 140.0,
                "cold_start_ms": 300.0,
            },
            {
                "device": "Phone B",
                "runtime": "onnxruntime-web-1.20-webgpu",
                "target_phone": True,
                "samples": 100,
                "p50_ms": 60.0,
                "p95_ms": 120.0,
                "cold_start_ms": 250.0,
            },
        ],
        "high_value_recall_at_5": 0.999,
        "correction_rate": 0.02,
        "rights_approved_for_model": True,
        "environment_lock_sha256": "d" * 64,
    }
    values.update(overrides)
    return build_benchmark_report(**values)  # type: ignore[arg-type]


def test_release_eligibility_requires_complete_product_evidence() -> None:
    report = _report()

    assert report["eligible_for_release"] is True
    assert all(report["gates"].values())


def test_release_eligibility_fails_closed_without_external_evidence() -> None:
    report = _report(
        high_value_recall_at_5=None,
        correction_rate=None,
        rights_approved_for_model=False,
        environment_lock_sha256=None,
        device_benchmarks=[],
        int8_onnx_bytes=0,
        reference_index_bytes=0,
    )

    assert report["eligible_for_release"] is False
    assert report["gates"]["publish_model_rights_approved"] is False
    assert report["gates"]["two_target_phones_p95_below_250_ms"] is False


def test_release_eligibility_rejects_small_open_set_samples() -> None:
    report = _report(metrics=_metrics(unknown=599), validation_unknown_queries=599)

    assert report["eligible_for_release"] is False
    assert report["gates"]["validation_unknown_queries_at_least_600"] is False
    assert report["gates"]["test_unknown_queries_at_least_600"] is False
