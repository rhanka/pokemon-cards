"""Deterministic image-free INT8 reference embedding index."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
from pathlib import Path
from typing import Any

from .errors import DependencyUnavailableError
from .inference import preprocess_onnx
from .report import write_canonical_json
from .rights import Operation, load_rights_manifest


def build_reference_index(
    *,
    manifest_path: str | Path,
    asset_root: str | Path,
    model_path: str | Path,
    output_dir: str | Path,
    release: bool = False,
) -> dict[str, Any]:
    np, ort = _index_stack()
    manifest = load_rights_manifest(manifest_path)
    manifest.assert_allowed(Operation.PUBLISH_MODEL if release else Operation.TRAIN)
    manifest.verify_assets(asset_root, roles={"reference"})
    references = sorted(
        (item for item in manifest.items if item.role == "reference"),
        key=lambda item: (item.card_uid, item.item_id),
    )
    session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    input_name = session.get_inputs()[0].name
    output_name = session.get_outputs()[0].name
    quantized_rows: list[Any] = []
    entries: list[dict[str, Any]] = []
    for offset, item in enumerate(references):
        inputs = preprocess_onnx(item, asset_root=asset_root)
        embedding = session.run([output_name], {input_name: inputs})[0][0]
        if embedding.shape != (128,):
            raise ValueError(f"model output must be 128D, got {embedding.shape}")
        norm = float(np.linalg.norm(embedding))
        if not 0.98 <= norm <= 1.02:
            raise ValueError(f"model output is not L2-normalized (norm={norm:.6f})")
        quantized = np.clip(np.rint(embedding * 127.0), -127, 127).astype(np.int8)
        quantized_rows.append(quantized)
        entries.append(
            {
                "card_uid": item.card_uid,
                "item_id": item.item_id,
                "source_id": item.source_id,
                "offset": offset * 128,
                "length": 128,
            }
        )

    destination = Path(output_dir)
    destination.mkdir(parents=True, exist_ok=True)
    binary_path = destination / "reference-index.int8.bin"
    matrix = np.stack(quantized_rows, axis=0)
    binary_path.write_bytes(matrix.tobytes(order="C"))
    metadata = {
        "schema_version": 1,
        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "manifest_fingerprint": manifest.fingerprint,
        "model_sha256": _sha256(Path(model_path)),
        "binary_sha256": _sha256(binary_path),
        "dtype": "int8",
        "scale": 0.007874015748031496,
        "dimension": 128,
        "count": len(entries),
        "bytes": binary_path.stat().st_size,
        "release_rights_checked": release,
        "entries": entries,
    }
    write_canonical_json(destination / "reference-index.json", metadata)
    return metadata


def _index_stack() -> tuple[Any, Any]:
    try:
        import numpy as np
        import onnxruntime as ort
    except ImportError as exc:
        raise DependencyUnavailableError(
            "reference indexing requires NumPy and ONNX Runtime; install cardscope-ml[export]"
        ) from exc
    return np, ort


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
