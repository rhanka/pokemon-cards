"""ONNX opset-17 export and manifest-backed static QDQ INT8 calibration."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
from pathlib import Path
from typing import Any, Sequence

from .errors import DependencyUnavailableError
from .inference import preprocess_onnx
from .model import load_checkpoint
from .report import write_canonical_json
from .rights import ImageItem, Operation, load_rights_manifest


def export_onnx_int8(
    *,
    manifest_path: str | Path,
    asset_root: str | Path,
    checkpoint_path: str | Path,
    output_dir: str | Path,
    calibration_samples: int = 128,
    release: bool = False,
) -> dict[str, Any]:
    torch, np, onnx, ort, quantization = _export_stack()
    manifest = load_rights_manifest(manifest_path)
    manifest.assert_allowed(Operation.PUBLISH_MODEL if release else Operation.TRAIN)
    candidates = sorted(
        (item for item in manifest.items if item.role in {"reference", "capture"}),
        key=lambda item: (item.card_uid, item.item_id),
    )[:calibration_samples]
    if not candidates:
        raise ValueError("at least one cleared calibration image is required")
    manifest.verify_assets(asset_root, roles={"reference", "capture"})
    model, checkpoint = load_checkpoint(str(checkpoint_path), device="cpu")
    if checkpoint["manifest_fingerprint"] != manifest.fingerprint:
        raise ValueError("checkpoint and rights manifest fingerprints differ")
    model.eval()

    destination = Path(output_dir)
    destination.mkdir(parents=True, exist_ok=True)
    float_path = destination / "model.float.onnx"
    int8_path = destination / "model.int8.onnx"
    dummy = torch.zeros((1, 3, 224, 224), dtype=torch.float32)
    torch.onnx.export(
        model,
        dummy,
        float_path,
        input_names=["image"],
        output_names=["embedding"],
        dynamic_axes={"image": {0: "batch"}, "embedding": {0: "batch"}},
        opset_version=17,
        do_constant_folding=True,
    )
    onnx.checker.check_model(onnx.load(str(float_path)))

    class Reader(quantization.CalibrationDataReader):
        def __init__(self, items: Sequence[ImageItem]) -> None:
            self.rows = [
                {"image": preprocess_onnx(item, asset_root=asset_root)} for item in items
            ]
            self.iterator = iter(self.rows)

        def get_next(self) -> dict[str, Any] | None:
            return next(self.iterator, None)

        def rewind(self) -> None:
            self.iterator = iter(self.rows)

    quantization.quantize_static(
        str(float_path),
        str(int8_path),
        Reader(candidates),
        quant_format=quantization.QuantFormat.QDQ,
        activation_type=quantization.QuantType.QUInt8,
        weight_type=quantization.QuantType.QInt8,
        per_channel=True,
        calibrate_method=quantization.CalibrationMethod.MinMax,
    )
    onnx.checker.check_model(onnx.load(str(int8_path)))

    float_session = ort.InferenceSession(str(float_path), providers=["CPUExecutionProvider"])
    int8_session = ort.InferenceSession(str(int8_path), providers=["CPUExecutionProvider"])
    similarities: list[float] = []
    for item in candidates[: min(16, len(candidates))]:
        inputs = preprocess_onnx(item, asset_root=asset_root)
        float_embedding = float_session.run(["embedding"], {"image": inputs})[0][0]
        int8_embedding = int8_session.run(["embedding"], {"image": inputs})[0][0]
        denominator = np.linalg.norm(float_embedding) * np.linalg.norm(int8_embedding)
        similarities.append(float(np.dot(float_embedding, int8_embedding) / max(denominator, 1e-12)))

    metadata = {
        "schema_version": 1,
        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "manifest_fingerprint": manifest.fingerprint,
        "checkpoint_sha256": _sha256(Path(checkpoint_path)),
        "float_onnx_sha256": _sha256(float_path),
        "int8_onnx_sha256": _sha256(int8_path),
        "float_onnx_bytes": float_path.stat().st_size,
        "int8_onnx_bytes": int8_path.stat().st_size,
        "int8_at_most_5_mib": int8_path.stat().st_size <= 5 * 1024 * 1024,
        "calibration_items": len(candidates),
        "mean_float_int8_cosine": sum(similarities) / len(similarities),
        "release_rights_checked": release,
        "quantization": "onnxruntime-static-qdq-uint8-activation-int8-weight",
    }
    write_canonical_json(destination / "export-metadata.json", metadata)
    return metadata


def _export_stack() -> tuple[Any, Any, Any, Any, Any]:
    try:
        import numpy as np
        import onnx
        import onnxruntime as ort
        import torch
        from onnxruntime import quantization
    except ImportError as exc:
        raise DependencyUnavailableError(
            "INT8 export requires Torch, NumPy, ONNX, and ONNX Runtime; "
            "install cardscope-ml[export]"
        ) from exc
    return torch, np, onnx, ort, quantization


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
