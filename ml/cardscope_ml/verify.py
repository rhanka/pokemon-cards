"""Artifact-integrity and same-reference retrieval smoke verification."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from .inference import preprocess_onnx
from .report import write_canonical_json
from .rights import Operation, load_rights_manifest, require_training_operation


def verify_reference_retrieval(
    *,
    manifest_path: str | Path,
    asset_root: str | Path,
    model_path: str | Path,
    index_path: str | Path,
    output_path: str | Path,
    operation: Operation | str = Operation.TRAIN,
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
    model = Path(model_path)
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
    expected = [(item.card_uid, item.item_id) for item in references]
    indexed = [(entry.get("card_uid"), entry.get("item_id")) for entry in entries]
    if indexed != expected:
        raise ValueError("reference index ordering does not match the manifest")
    session = ort.InferenceSession(str(model), providers=["CPUExecutionProvider"])
    input_name = session.get_inputs()[0].name
    output_name = session.get_outputs()[0].name
    correct = 0
    for expected_offset, item in enumerate(references):
        input_image = preprocess_onnx(item, asset_root=asset_root)
        embedding = session.run([output_name], {input_name: input_image})[0][0]
        if embedding.shape != (dimension,):
            raise ValueError(
                f"model output dimension {embedding.shape} differs from index {dimension}"
            )
        predicted = int(np.argmax(vectors @ embedding))
        correct += int(predicted == expected_offset)
    result = {
        "schema_version": 1,
        "mode": "same-reference-retrieval-smoke",
        "manifest_fingerprint": manifest.fingerprint,
        "model_sha256": _sha256(model),
        "index_sha256": _sha256(binary_path),
        "training_rights_operation": training_operation.value,
        "queries": len(references),
        "correct_top1": correct,
        "top1": correct / len(references),
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


def _load_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ValueError(f"cannot read reference index metadata: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid reference index metadata: {path}") from exc
    if not isinstance(payload, dict):
        raise ValueError("reference index metadata must be a JSON object")
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
