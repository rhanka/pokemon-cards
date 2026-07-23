"""Dependency-free deterministic pipeline proof using score fixtures, not images."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping, Sequence

from .calibration import fit_score_calibrator, select_accept_threshold
from .metrics import evaluate_retrieval, top_two_features
from .report import build_benchmark_report, write_canonical_json
from .rights import Operation, load_rights_manifest
from .split import SplitConfig, split_manifest


def run_dry_run(
    *,
    manifest_path: str | Path,
    scores_path: str | Path,
    output_path: str | Path | None = None,
    seed: int = 20260722,
    target_far: float = 0.005,
) -> dict[str, Any]:
    manifest = load_rights_manifest(manifest_path)
    manifest.assert_allowed(Operation.TRAIN)
    split = split_manifest(manifest, SplitConfig(seed=seed))
    payload = _load_scores(scores_path)
    gallery = payload["gallery_uids"]
    manifest_reference_uids = {
        item.card_uid for item in manifest.items if item.role == "reference"
    }
    undeclared_gallery_uids = sorted(set(gallery) - manifest_reference_uids)
    if undeclared_gallery_uids:
        raise ValueError(
            f"dry-run gallery UIDs are absent from the manifest: {undeclared_gallery_uids}"
        )
    calibration_rows = payload["calibration"]
    evaluation_rows = payload["evaluation"]

    calibration_scores = [row["scores"] for row in calibration_rows]
    calibration_queries = [row["query_uid"] for row in calibration_rows]
    features = [top_two_features(row) for row in calibration_scores]
    correctness = _correctness(calibration_scores, calibration_queries, gallery)
    known = [query in set(gallery) for query in calibration_queries]
    calibrator = fit_score_calibrator(
        [feature[0] for feature in features],
        [feature[1] for feature in features],
        correctness,
    )
    calibration_confidences = calibrator.predict_many(
        [feature[0] for feature in features],
        [feature[1] for feature in features],
    )
    threshold = select_accept_threshold(
        calibration_confidences, known, correctness, target_far=target_far
    )

    evaluation_scores = [row["scores"] for row in evaluation_rows]
    evaluation_queries = [row["query_uid"] for row in evaluation_rows]
    evaluation_features = [top_two_features(row) for row in evaluation_scores]
    evaluation_confidences = calibrator.predict_many(
        [feature[0] for feature in evaluation_features],
        [feature[1] for feature in evaluation_features],
    )
    metrics = evaluate_retrieval(
        evaluation_scores,
        evaluation_queries,
        gallery,
        confidences=evaluation_confidences,
        accept_threshold=threshold.threshold,
    )
    report = build_benchmark_report(
        mode="dry-run",
        created_at=manifest.created_at,
        dataset_id=manifest.dataset_id,
        manifest_fingerprint=manifest.fingerprint,
        split_fingerprint=split.fingerprint,
        seed=seed,
        metrics=metrics,
        accept_threshold=threshold.threshold,
        target_far=target_far,
        validation_unknown_queries=threshold.unknown_queries,
    )
    if output_path is not None:
        write_canonical_json(output_path, report)
    return report


def _load_scores(path: str | Path) -> dict[str, Any]:
    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot load dry-run score fixture: {exc}") from exc
    if not isinstance(payload, dict) or set(payload) != {
        "schema_version",
        "gallery_uids",
        "calibration",
        "evaluation",
    }:
        raise ValueError("dry-run scores have missing or unknown top-level fields")
    if payload["schema_version"] != 1:
        raise ValueError("dry-run score schema_version must be 1")
    gallery = payload["gallery_uids"]
    if not isinstance(gallery, list) or not gallery or not all(isinstance(uid, str) for uid in gallery):
        raise ValueError("gallery_uids must be a non-empty string array")
    if len(set(gallery)) != len(gallery):
        raise ValueError("dry-run gallery UIDs must be unique")
    for section in ("calibration", "evaluation"):
        rows = payload[section]
        if not isinstance(rows, list) or not rows:
            raise ValueError(f"{section} must be a non-empty array")
        for index, row in enumerate(rows):
            if not isinstance(row, dict) or set(row) != {"query_uid", "scores"}:
                raise ValueError(f"{section}[{index}] fields are invalid")
            if not isinstance(row["query_uid"], str) or not row["query_uid"]:
                raise ValueError(f"{section}[{index}].query_uid is invalid")
            if not isinstance(row["scores"], list) or len(row["scores"]) != len(gallery):
                raise ValueError(f"{section}[{index}].scores width does not match the gallery")
    return payload


def _correctness(
    scores: Sequence[Sequence[float]], queries: Sequence[str], gallery: Sequence[str]
) -> list[bool]:
    gallery_set = set(gallery)
    correctness: list[bool] = []
    for row, query in zip(scores, queries, strict=True):
        winner = max(range(len(row)), key=lambda index: (float(row[index]), -index))
        correctness.append(query in gallery_set and gallery[winner] == query)
    return correctness
