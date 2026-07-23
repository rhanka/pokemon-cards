"""MobileNetV3-Small 128D encoder construction without implicit downloads."""

from __future__ import annotations

from typing import Any

from .errors import DependencyUnavailableError

ARCHITECTURE = "mobilenet_v3_small_128d_l2"
EMBEDDING_DIMENSION = 128
INPUT_SIZE = 224


def build_model(*, embedding_dimension: int = EMBEDDING_DIMENSION) -> Any:
    if embedding_dimension != EMBEDDING_DIMENSION:
        raise ValueError(f"the product contract requires {EMBEDDING_DIMENSION} dimensions")
    torch, nn, functional, mobilenet_v3_small = _torch_stack()

    class MobileNetV3Embedding(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            # Explicitly never ask torchvision for remote weights.
            backbone = mobilenet_v3_small(weights=None)
            self.features = backbone.features
            self.avgpool = nn.AdaptiveAvgPool2d(1)
            feature_dimension = backbone.classifier[0].in_features
            self.projection = nn.Sequential(
                nn.Linear(feature_dimension, 256),
                nn.Hardswish(),
                nn.Dropout(p=0.15),
                nn.Linear(256, embedding_dimension, bias=False),
                nn.BatchNorm1d(embedding_dimension),
            )

        def forward(self, inputs: Any) -> Any:
            features = self.features(inputs)
            features = self.avgpool(features)
            features = torch.flatten(features, 1)
            embeddings = self.projection(features)
            return functional.normalize(embeddings, p=2, dim=1, eps=1e-12)

    return MobileNetV3Embedding()


def load_checkpoint(path: str, *, device: str = "cpu") -> tuple[Any, dict[str, Any]]:
    torch, _, _, _ = _torch_stack()
    checkpoint = torch.load(path, map_location=device, weights_only=False)
    if not isinstance(checkpoint, dict) or checkpoint.get("format_version") != 1:
        raise ValueError("unsupported or malformed CardScope checkpoint")
    if checkpoint.get("architecture") != ARCHITECTURE:
        raise ValueError(f"checkpoint architecture must be {ARCHITECTURE!r}")
    if checkpoint.get("embedding_dimension") != EMBEDDING_DIMENSION:
        raise ValueError("checkpoint embedding dimension does not match the product contract")
    model = build_model()
    model.load_state_dict(checkpoint["state_dict"], strict=True)
    model.to(device)
    return model, checkpoint


def _torch_stack() -> tuple[Any, Any, Any, Any]:
    try:
        import torch
        from torch import nn
        from torch.nn import functional
        from torchvision.models import mobilenet_v3_small
    except ImportError as exc:
        raise DependencyUnavailableError(
            "model construction requires Torch and torchvision; install cardscope-ml[train]"
        ) from exc
    return torch, nn, functional, mobilenet_v3_small
