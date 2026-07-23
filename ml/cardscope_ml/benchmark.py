"""UID-separated retrieval benchmark with fitted confidence and abstention."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
from pathlib import Path
import platform
import time
from typing import Any, Sequence

from .calibration import fit_score_calibrator, select_accept_threshold
from .inference import cosine_scores, embed_with_torch
from .metrics import evaluate_retrieval, top_two_features
from .model import load_checkpoint
from .report import build_benchmark_report, write_canonical_json
from .rights import ImageItem, Operation, load_rights_manifest
from .split import SplitConfig, split_manifest


def benchmark(
    *,
    manifest_path: str | Path,
    asset_root: str | Path,
    checkpoint_path: str | Path,
    output_path: str | Path,
    target_far: float = 0.005,
    device: str = "cpu",
    batch_size: int = 64,
) -> dict[str, Any]:
    manifest = load_rights_manifest(manifest_path)
    manifest.assert_allowed(Operation.TRAIN)
    manifest.verify_assets(asset_root)
    model, checkpoint = load_checkpoint(str(checkpoint_path), device=device)
    if checkpoint["manifest_fingerprint"] != manifest.fingerprint:
        raise ValueError("checkpoint and rights manifest fingerprints differ")
    seed = int(checkpoint["seed"])
    partitions = split_manifest(manifest, SplitConfig(seed=seed))
    if checkpoint["split_fingerprint"] != partitions.fingerprint:
        raise ValueError("checkpoint and current UID split fingerprints differ")

    validation_data = _score_partition(
        model, partitions.validation, asset_root=asset_root, device=device, batch_size=batch_size
    )
    test_data = _score_partition(
        model, partitions.test, asset_root=asset_root, device=device, batch_size=batch_size
    )
    validation_features = [top_two_features(row) for row in validation_data["scores"]]
    validation_known = [
        uid in set(validation_data["gallery_uids"]) for uid in validation_data["query_uids"]
    ]
    validation_correct = _correctness(
        validation_data["scores"],
        validation_data["query_uids"],
        validation_data["gallery_uids"],
    )
    calibrator = fit_score_calibrator(
        [feature[0] for feature in validation_features],
        [feature[1] for feature in validation_features],
        validation_correct,
    )
    validation_confidences = calibrator.predict_many(
        [feature[0] for feature in validation_features],
        [feature[1] for feature in validation_features],
    )
    threshold = select_accept_threshold(
        validation_confidences,
        validation_known,
        validation_correct,
        target_far=target_far,
    )

    test_features = [top_two_features(row) for row in test_data["scores"]]
    test_confidences = calibrator.predict_many(
        [feature[0] for feature in test_features],
        [feature[1] for feature in test_features],
    )
    metrics = evaluate_retrieval(
        test_data["scores"],
        test_data["query_uids"],
        test_data["gallery_uids"],
        confidences=test_confidences,
        accept_threshold=threshold.threshold,
    )
    latencies = _measure_model_latency(model, device=device)
    checkpoint_hash = _sha256(Path(checkpoint_path))
    report = build_benchmark_report(
        mode="benchmark",
        created_at=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        dataset_id=manifest.dataset_id,
        manifest_fingerprint=manifest.fingerprint,
        split_fingerprint=partitions.fingerprint,
        seed=seed,
        metrics=metrics,
        accept_threshold=threshold.threshold,
        target_far=target_far,
        validation_unknown_queries=threshold.unknown_queries,
        checkpoint_sha256=checkpoint_hash,
        device_benchmarks=[latencies],
    )
    report["calibration_model"] = calibrator.to_dict()
    # The public schema intentionally excludes fit coefficients. Keep the auditable sidecar separate.
    calibration_sidecar = report.pop("calibration_model")
    write_canonical_json(output_path, report)
    write_canonical_json(Path(output_path).with_suffix(".calibration.json"), calibration_sidecar)
    return report


def _score_partition(
    model: Any,
    items: Sequence[ImageItem],
    *,
    asset_root: str | Path,
    device: str,
    batch_size: int,
) -> dict[str, Any]:
    gallery = sorted(
        (item for item in items if item.role == "reference"),
        key=lambda item: (item.card_uid, item.item_id),
    )
    probes = sorted(
        (item for item in items if item.role in {"capture", "unknown"}),
        key=lambda item: (item.card_uid, item.item_id),
    )
    if not gallery or not probes:
        raise ValueError("each benchmark partition needs references and capture/unknown probes")
    if not any(item.role == "unknown" for item in probes):
        raise ValueError("each benchmark partition needs unknown probes for FAR")
    gallery_embeddings = embed_with_torch(
        model, gallery, asset_root=asset_root, device=device, batch_size=batch_size
    )
    probe_embeddings = embed_with_torch(
        model, probes, asset_root=asset_root, device=device, batch_size=batch_size
    )
    return {
        "scores": cosine_scores(probe_embeddings, gallery_embeddings),
        "query_uids": [item.card_uid for item in probes],
        "gallery_uids": [item.card_uid for item in gallery],
    }


def _correctness(
    scores: Sequence[Sequence[float]], query_uids: Sequence[str], gallery_uids: Sequence[str]
) -> list[bool]:
    gallery_set = set(gallery_uids)
    result: list[bool] = []
    for row, query_uid in zip(scores, query_uids, strict=True):
        best = max(range(len(row)), key=lambda index: (row[index], -index))
        result.append(query_uid in gallery_set and gallery_uids[best] == query_uid)
    return result


def _measure_model_latency(model: Any, *, device: str) -> dict[str, Any]:
    import torch

    model.eval()
    sample = torch.zeros((1, 3, 224, 224), device=device)
    if device.startswith("cuda"):
        torch.cuda.synchronize()
    started = time.perf_counter()
    with torch.inference_mode():
        model(sample)
    if device.startswith("cuda"):
        torch.cuda.synchronize()
    cold = (time.perf_counter() - started) * 1000
    timings: list[float] = []
    with torch.inference_mode():
        for _ in range(30):
            started = time.perf_counter()
            model(sample)
            if device.startswith("cuda"):
                torch.cuda.synchronize()
            timings.append((time.perf_counter() - started) * 1000)
    timings.sort()
    return {
        "device": platform.platform(),
        "runtime": f"torch-{torch.__version__}-{device}",
        "target_phone": False,
        "samples": len(timings),
        "p50_ms": _percentile(timings, 0.50),
        "p95_ms": _percentile(timings, 0.95),
        "cold_start_ms": cold,
    }


def _percentile(values: Sequence[float], quantile: float) -> float:
    index = (len(values) - 1) * quantile
    lower = int(index)
    upper = min(lower + 1, len(values) - 1)
    fraction = index - lower
    return values[lower] * (1 - fraction) + values[upper] * fraction


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
