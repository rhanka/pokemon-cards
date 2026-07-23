"""Shared optional-dependency helpers for embedding cleared manifest assets."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Sequence

from .dataset import evaluation_transform
from .errors import DependencyUnavailableError
from .rights import ImageItem


def embed_with_torch(
    model: Any,
    items: Sequence[ImageItem],
    *,
    asset_root: str | Path,
    device: str,
    batch_size: int = 64,
) -> Any:
    torch, Image, np = _stack()
    transform = evaluation_transform()
    root = Path(asset_root).resolve()
    outputs: list[Any] = []
    model.eval()
    with torch.inference_mode():
        for start in range(0, len(items), batch_size):
            tensors = []
            for item in items[start : start + batch_size]:
                path = (root / item.relative_path).resolve()
                path.relative_to(root)
                with Image.open(path) as opened:
                    tensors.append(transform(opened.convert("RGB")))
            batch = torch.stack(tensors).to(device)
            outputs.append(model(batch).detach().cpu().numpy())
    if not outputs:
        return np.empty((0, 128), dtype=np.float32)
    return np.concatenate(outputs, axis=0).astype(np.float32, copy=False)


def cosine_scores(probes: Any, gallery: Any) -> list[list[float]]:
    _, _, np = _stack()
    if probes.ndim != 2 or gallery.ndim != 2 or probes.shape[1] != gallery.shape[1]:
        raise ValueError("probe and gallery embeddings must have matching 2D shapes")
    return np.matmul(probes, gallery.T).astype(float).tolist()


def preprocess_onnx(item: ImageItem, *, asset_root: str | Path) -> Any:
    torch, Image, _ = _stack()
    transform = evaluation_transform()
    root = Path(asset_root).resolve()
    path = (root / item.relative_path).resolve()
    path.relative_to(root)
    with Image.open(path) as opened:
        tensor = transform(opened.convert("RGB"))
    return tensor.unsqueeze(0).numpy()


def _stack() -> tuple[Any, Any, Any]:
    try:
        import numpy as np
        import torch
        from PIL import Image
    except ImportError as exc:
        raise DependencyUnavailableError(
            "embedding images requires Pillow, NumPy, and Torch; install cardscope-ml[train]"
        ) from exc
    return torch, Image, np
