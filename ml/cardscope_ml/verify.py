"""Artifact-integrity and same-reference retrieval smoke verification."""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from typing import Any

from .augment import SyntheticAugmenter
from .inference import preprocess_onnx_batch, preprocess_onnx_image
from .report import write_canonical_json
from .rights import Operation, load_rights_manifest, require_training_operation
from .split import SplitConfig, split_manifest


def verify_reference_retrieval(
    *,
    manifest_path: str | Path,
    asset_root: str | Path,
    checkpoint_path: str | Path,
    model_path: str | Path,
    index_path: str | Path,
    output_path: str | Path,
    operation: Operation | str = Operation.TRAIN,
    seed: int = 20260722,
    held_out_only: bool = False,
) -> dict[str, Any]:
    """Verify every catalog reference retrieves itself from a built local index.

    This is intentionally an artifact smoke test, not an accuracy benchmark:
    the same canonical image appears on both sides, so it cannot establish
    performance on user photographs or unknown cards.
    """

    np, ort = _stack()
    training_operation = require_training_operation(operation)
    manifest = load_rights_manifest(manifest_path)
    manifest.assert_allowed(training_operation)
    manifest.verify_assets(asset_root, roles={"reference"})
    partitions = split_manifest(manifest, SplitConfig(seed=seed))
    checkpoint_sha256 = _assert_checkpoint_split(
        checkpoint_path,
        manifest_fingerprint=manifest.fingerprint,
        split_fingerprint=partitions.fingerprint,
        seed=seed,
        operation=training_operation,
    )
    model = Path(model_path)
    export_metadata_sha256 = _assert_export_binding(
        model,
        checkpoint_sha256=checkpoint_sha256,
        manifest_fingerprint=manifest.fingerprint,
        operation=training_operation,
    )
    index = Path(index_path)
    metadata = _load_json(index)
    binary_path = index.parent / "reference-index.int8.bin"
    _assert_equal(
        metadata.get("manifest_fingerprint"), manifest.fingerprint, "manifest fingerprint"
    )
    _assert_equal(metadata.get("model_sha256"), _sha256(model), "model hash")
    _assert_equal(metadata.get("binary_sha256"), _sha256(binary_path), "index binary hash")
    _assert_equal(
        metadata.get("training_rights_operation", Operation.TRAIN.value),
        training_operation.value,
        "training rights operation",
    )
    entries = metadata.get("entries")
    if not isinstance(entries, list) or not entries:
        raise ValueError("reference index has no entries")
    dimension = metadata.get("dimension")
    if not isinstance(dimension, int) or dimension <= 0:
        raise ValueError("reference index dimension is invalid")
    matrix = np.frombuffer(binary_path.read_bytes(), dtype=np.int8)
    expected_values = len(entries) * dimension
    if matrix.size != expected_values:
        raise ValueError("reference index binary length does not match its metadata")
    vectors = matrix.reshape((len(entries), dimension)).astype(np.float32)
    vectors *= float(metadata.get("scale", 0.0))

    references = sorted(
        (item for item in manifest.items if item.role == "reference"),
        key=lambda item: (item.card_uid, item.item_id),
    )
    partition_by_item_id = {
        item.item_id: split_name
        for split_name in ("train", "validation", "test")
        for item in partitions.items(split_name)
        if item.role == "reference"
    }
    if set(partition_by_item_id) != {item.item_id for item in references}:
        raise ValueError("split does not assign every reference exactly once")
    train_uids = {item.card_uid for item in partitions.train if item.role == "reference"}
    held_out_uids = {
        item.card_uid
        for split_name in ("validation", "test")
        for item in partitions.items(split_name)
        if item.role == "reference"
    }
    if train_uids.intersection(held_out_uids):
        raise ValueError("held-out reference UIDs overlap the training partition")
    query_references = [
        item
        for item in references
        if not held_out_only or partition_by_item_id[item.item_id] in {"validation", "test"}
    ]
    if not query_references:
        raise ValueError("requested verification set has no reference queries")
    expected = [(item.card_uid, item.item_id) for item in references]
    indexed = [(entry.get("card_uid"), entry.get("item_id")) for entry in entries]
    if indexed != expected:
        raise ValueError("reference index ordering does not match the manifest")
    session = ort.InferenceSession(str(model), providers=["CPUExecutionProvider"])
    input_name = session.get_inputs()[0].name
    output_name = session.get_outputs()[0].name
    correct = 0
    split_counts = {
        split_name: {"correct_top1": 0, "queries": 0}
        for split_name in ("train", "validation", "test")
    }
    index_offset_by_item_id = {
        item.item_id: offset for offset, item in enumerate(references)
    }
    for start in range(0, len(query_references), 64):
        batch = query_references[start : start + 64]
        inputs = preprocess_onnx_batch(batch, asset_root=asset_root)
        embeddings = session.run([output_name], {input_name: inputs})[0]
        if embeddings.shape != (len(batch), dimension):
            raise ValueError(
                f"model output shape {embeddings.shape} differs from expected "
                f"({len(batch)}, {dimension})"
            )
        predictions = np.argmax(embeddings @ vectors.T, axis=1)
        for item, predicted in zip(batch, predictions, strict=True):
            expected_offset = index_offset_by_item_id[item.item_id]
            correct += int(int(predicted) == expected_offset)
            split_name = partition_by_item_id[item.item_id]
            split_counts[split_name]["correct_top1"] += int(
                int(predicted) == expected_offset
            )
            split_counts[split_name]["queries"] += 1
    held_out_correct = sum(
        split_counts[split_name]["correct_top1"] for split_name in ("validation", "test")
    )
    held_out_queries = sum(
        split_counts[split_name]["queries"] for split_name in ("validation", "test")
    )
    result = {
        "schema_version": 1,
        "mode": "held-out-reference-retrieval" if held_out_only else "same-reference-retrieval-smoke",
        "manifest_fingerprint": manifest.fingerprint,
        "model_sha256": _sha256(model),
        "checkpoint_sha256": checkpoint_sha256,
        "export_metadata_sha256": export_metadata_sha256,
        "index_sha256": _sha256(binary_path),
        "training_rights_operation": training_operation.value,
        "queries": len(query_references),
        "correct_top1": correct,
        "top1": _rate(correct, len(query_references)),
        "split": {
            "seed": seed,
            "partitions": {
                split_name: {
                    **counts,
                    "top1": _rate(counts["correct_top1"], counts["queries"]),
                }
                for split_name, counts in split_counts.items()
            },
        },
        "held_out_from_training": {
            "correct_top1": held_out_correct,
            "queries": held_out_queries,
            "top1": _rate(held_out_correct, held_out_queries),
            "available": held_out_queries > 0,
            "training_uid_count": len(train_uids),
            "held_out_uid_count": len(held_out_uids),
            "uid_overlap_with_training": 0,
            "query_mode": "canonical-reference-self-retrieval",
            "query_partitions": ["validation", "test"],
            "scope": "catalogue generalization to UIDs excluded from training; not phone-capture performance",
        },
        "deployment_eligible": False,
        "limitation": "Canonical references were used as queries; camera, unknown-card, and calibration performance remain unmeasured.",
    }
    write_canonical_json(output_path, result)
    return result


def _stack() -> tuple[Any, Any]:
    try:
        import numpy as np
        import onnxruntime as ort
    except ImportError as exc:
        raise RuntimeError("artifact verification requires NumPy and ONNX Runtime") from exc
    return np, ort


def _load_json(path: Path, *, label: str = "reference index metadata") -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ValueError(f"cannot read {label}: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid {label}: {path}") from exc
    if not isinstance(payload, dict):
        raise ValueError(f"{label} must be a JSON object")
    return payload


def _assert_equal(actual: object, expected: object, label: str) -> None:
    if actual != expected:
        raise ValueError(f"{label} differs from the supplied artifact")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_synthetic_holdout_retrieval(
    *,
    manifest_path: str | Path,
    asset_root: str | Path,
    checkpoint_path: str | Path,
    model_path: str | Path,
    index_path: str | Path,
    output_path: str | Path,
    seed: int = 20260722,
    variants_per_reference: int = 1,
    operation: Operation | str = Operation.TRAIN,
) -> dict[str, Any]:
    """Measure controlled image robustness only on UIDs excluded from training.

    Synthetic captures are derived in memory from held-out references.  They
    are useful as a fast regression signal, but they are not passed off as a
    substitute for independent camera photos or open-set probes.
    """

    if variants_per_reference < 1 or variants_per_reference > 8:
        raise ValueError("variants_per_reference must be between 1 and 8")
    np, ort = _stack()
    training_operation = require_training_operation(operation)
    manifest = load_rights_manifest(manifest_path)
    manifest.assert_allowed(training_operation)
    manifest.verify_assets(asset_root, roles={"reference"})
    partitions = split_manifest(manifest, SplitConfig(seed=seed))
    checkpoint_sha256 = _assert_checkpoint_split(
        checkpoint_path,
        manifest_fingerprint=manifest.fingerprint,
        split_fingerprint=partitions.fingerprint,
        seed=seed,
        operation=training_operation,
    )
    train_uids = {item.card_uid for item in partitions.train if item.role == "reference"}
    probes = sorted(
        (item for item in partitions.test if item.role == "reference"),
        key=lambda item: (item.card_uid, item.item_id),
    )
    probe_uids = {item.card_uid for item in probes}
    if not probes:
        raise ValueError("test partition has no reference probes")
    if train_uids.intersection(probe_uids):
        raise ValueError("synthetic holdout UIDs overlap the training partition")

    model = Path(model_path)
    export_metadata_sha256 = _assert_export_binding(
        model,
        checkpoint_sha256=checkpoint_sha256,
        manifest_fingerprint=manifest.fingerprint,
        operation=training_operation,
    )
    index = Path(index_path)
    metadata = _load_json(index)
    binary_path = index.parent / "reference-index.int8.bin"
    _assert_equal(
        metadata.get("manifest_fingerprint"), manifest.fingerprint, "manifest fingerprint"
    )
    _assert_equal(metadata.get("model_sha256"), _sha256(model), "model hash")
    _assert_equal(metadata.get("binary_sha256"), _sha256(binary_path), "index binary hash")
    _assert_equal(
        metadata.get("training_rights_operation", Operation.TRAIN.value),
        training_operation.value,
        "training rights operation",
    )
    entries = metadata.get("entries")
    if not isinstance(entries, list) or not entries:
        raise ValueError("reference index has no entries")
    dimension = metadata.get("dimension")
    if not isinstance(dimension, int) or dimension <= 0:
        raise ValueError("reference index dimension is invalid")
    vectors = np.frombuffer(binary_path.read_bytes(), dtype=np.int8)
    if vectors.size != len(entries) * dimension:
        raise ValueError("reference index binary length does not match its metadata")
    vectors = vectors.reshape((len(entries), dimension)).astype(np.float32)
    vectors *= float(metadata.get("scale", 0.0))
    expected_offsets = {
        (entry.get("card_uid"), entry.get("item_id")): offset
        for offset, entry in enumerate(entries)
    }
    expected_entries = [
        (item.card_uid, item.item_id)
        for item in sorted(
            (item for item in manifest.items if item.role == "reference"),
            key=lambda item: (item.card_uid, item.item_id),
        )
    ]
    indexed_entries = [(entry.get("card_uid"), entry.get("item_id")) for entry in entries]
    if indexed_entries != expected_entries:
        raise ValueError("reference index ordering does not match the manifest")
    session = ort.InferenceSession(str(model), providers=["CPUExecutionProvider"])
    input_name = session.get_inputs()[0].name
    output_name = session.get_outputs()[0].name
    augmenter = SyntheticAugmenter(seed=seed)
    root = Path(asset_root).resolve()
    _, Image, _ = _image_stack()
    correct_top1 = 0
    recall_at_5 = 0
    operation_counts: Counter[str] = Counter()
    queries = 0
    for item in probes:
        expected = expected_offsets.get((item.card_uid, item.item_id))
        if expected is None:
            raise ValueError(f"test reference {item.item_id!r} is missing from the index")
        path = (root / item.relative_path).resolve()
        path.relative_to(root)
        with Image.open(path) as opened:
            original = opened.convert("RGB")
        for variant in range(variants_per_reference):
            image, trace = augmenter.augment(
                original,
                sample_key=f"synthetic-holdout:{item.item_id}:{variant}",
                epoch=variant,
            )
            operation_counts.update(trace.operations)
            embedding = session.run(
                [output_name], {input_name: preprocess_onnx_image(image)}
            )[0][0]
            scores = vectors @ embedding
            limit = min(5, len(entries))
            top_five = np.argpartition(scores, len(scores) - limit)[-limit:]
            top_five = top_five[np.argsort(scores[top_five])[::-1]]
            correct_top1 += int(int(top_five[0]) == expected)
            recall_at_5 += int(expected in {int(value) for value in top_five})
            queries += 1
    result = {
        "schema_version": 1,
        "mode": "held-out-synthetic-capture-retrieval",
        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "manifest_fingerprint": manifest.fingerprint,
        "model_sha256": _sha256(model),
        "checkpoint_sha256": checkpoint_sha256,
        "export_metadata_sha256": export_metadata_sha256,
        "index_sha256": _sha256(binary_path),
        "seed": seed,
        "training_rights_operation": training_operation.value,
        "training_uid_count": len(train_uids),
        "held_out_test_uid_count": len(probe_uids),
        "uid_overlap_with_training": 0,
        "variants_per_reference": variants_per_reference,
        "queries": queries,
        "correct_top1": correct_top1,
        "top1": correct_top1 / queries,
        "recall_at_5": recall_at_5 / queries,
        "applied_operation_counts": dict(sorted(operation_counts.items())),
        "deployment_eligible": False,
        "limitation": "Synthetic variants are derived only from held-out canonical references. This is a controlled robustness diagnostic, not independent camera or open-set performance.",
    }
    write_canonical_json(output_path, result)
    return result


def _image_stack() -> tuple[Any, Any, Any]:
    try:
        import numpy as np
        from PIL import Image
        import onnxruntime as ort
    except ImportError as exc:
        raise RuntimeError("synthetic holdout verification requires Pillow, NumPy, and ONNX Runtime") from exc
    return np, Image, ort


def _assert_checkpoint_split(
    checkpoint_path: str | Path,
    *,
    manifest_fingerprint: str,
    split_fingerprint: str,
    seed: int,
    operation: Operation,
) -> str:
    """Bind a reported holdout to the actual training split, not a CLI claim."""

    try:
        import torch
    except ImportError as exc:
        raise RuntimeError("holdout verification requires Torch to inspect the checkpoint") from exc
    checkpoint = Path(checkpoint_path)
    payload = torch.load(checkpoint, map_location="cpu", weights_only=False)
    if not isinstance(payload, dict):
        raise ValueError("checkpoint is malformed")
    for field, expected in (
        ("manifest_fingerprint", manifest_fingerprint),
        ("split_fingerprint", split_fingerprint),
        ("seed", seed),
        ("training_rights_operation", operation.value),
    ):
        if payload.get(field) != expected:
            raise ValueError(f"checkpoint {field} differs from the requested holdout split")
    return _sha256(checkpoint)


def _assert_export_binding(
    model_path: Path,
    *,
    checkpoint_sha256: str,
    manifest_fingerprint: str,
    operation: Operation,
) -> str:
    """Prove the evaluated ONNX runtime model was exported from this checkpoint."""

    metadata_path = model_path.parent / "export-metadata.json"
    metadata = _load_json(metadata_path, label="export metadata")
    model_sha256 = _sha256(model_path)
    _assert_equal(
        metadata.get("checkpoint_sha256"), checkpoint_sha256, "export checkpoint hash"
    )
    _assert_equal(
        metadata.get("manifest_fingerprint"), manifest_fingerprint, "export manifest fingerprint"
    )
    _assert_equal(
        metadata.get("training_rights_operation"),
        operation.value,
        "export training rights operation",
    )
    _assert_equal(
        metadata.get("runtime_model_sha256"), model_sha256, "export runtime model hash"
    )
    _assert_equal(metadata.get("float_onnx_sha256"), model_sha256, "export float ONNX hash")
    return _sha256(metadata_path)


def _rate(numerator: int, denominator: int) -> float | None:
    """Return an explicit unavailable metric for an empty partition."""

    return numerator / denominator if denominator else None
