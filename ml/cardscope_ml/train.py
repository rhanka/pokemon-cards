"""Reproducible batch-hard metric-learning entry point."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import random
from typing import Any

from .augment import SyntheticAugmenter
from .dataset import ManifestTorchDataset, UIDBatchSampler
from .errors import DependencyUnavailableError, ManifestError
from .hard_negatives import batch_hard_triplet_loss
from .model import ARCHITECTURE, EMBEDDING_DIMENSION, INPUT_SIZE, build_model
from .report import write_canonical_json
from .rights import Operation, load_rights_manifest
from .split import SplitConfig, split_manifest


@dataclass(frozen=True, slots=True)
class TrainingConfig:
    seed: int = 20260722
    epochs: int = 20
    classes_per_batch: int = 16
    samples_per_class: int = 4
    learning_rate: float = 3e-4
    weight_decay: float = 1e-4
    triplet_margin: float = 0.2
    workers: int = 0
    device: str = "auto"


def train(
    *,
    manifest_path: str | Path,
    asset_root: str | Path,
    output_dir: str | Path,
    config: TrainingConfig = TrainingConfig(),
) -> dict[str, Any]:
    torch = _torch()
    _validate_config(config)
    manifest = load_rights_manifest(manifest_path)
    manifest.assert_allowed(Operation.TRAIN)
    manifest.verify_assets(asset_root, roles={"reference", "capture"})
    split_config = SplitConfig(seed=config.seed)
    partitions = split_manifest(manifest, split_config)
    train_items = tuple(item for item in partitions.train if item.role != "unknown")
    if len({item.card_uid for item in train_items}) < 2:
        raise ManifestError("training split needs at least two distinct card UIDs")

    _set_reproducible_seed(torch, config.seed)
    device = _resolve_device(torch, config.device)
    augmenter = SyntheticAugmenter(seed=config.seed)
    dataset = ManifestTorchDataset(
        train_items, asset_root=asset_root, training=True, augmenter=augmenter
    )
    sampler = UIDBatchSampler(
        train_items,
        classes_per_batch=config.classes_per_batch,
        samples_per_class=config.samples_per_class,
        seed=config.seed,
    )
    loader = torch.utils.data.DataLoader(
        dataset,
        batch_sampler=sampler,
        num_workers=config.workers,
        pin_memory=device.startswith("cuda"),
    )
    model = build_model().to(device)
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=config.learning_rate, weight_decay=config.weight_decay
    )

    history: list[dict[str, float | int]] = []
    for epoch in range(config.epochs):
        sampler.set_epoch(epoch)
        model.train()
        aggregates: dict[str, float] = {}
        batch_count = 0
        for images, labels, _item_ids in loader:
            images = images.to(device, non_blocking=True)
            labels = labels.to(device, non_blocking=True)
            optimizer.zero_grad(set_to_none=True)
            embeddings = model(images)
            loss, stats = batch_hard_triplet_loss(
                embeddings, labels, margin=config.triplet_margin
            )
            loss.backward()
            optimizer.step()
            batch_count += 1
            for name, value in stats.items():
                aggregates[name] = aggregates.get(name, 0.0) + value
        history.append(
            {
                "epoch": epoch + 1,
                "batches": batch_count,
                **{name: value / batch_count for name, value in sorted(aggregates.items())},
            }
        )

    destination = Path(output_dir)
    destination.mkdir(parents=True, exist_ok=True)
    checkpoint_path = destination / "model.pt"
    checkpoint = {
        "format_version": 1,
        "architecture": ARCHITECTURE,
        "embedding_dimension": EMBEDDING_DIMENSION,
        "input_size": INPUT_SIZE,
        "manifest_fingerprint": manifest.fingerprint,
        "split_fingerprint": partitions.fingerprint,
        "seed": config.seed,
        "training_config": asdict(config),
        "state_dict": model.cpu().state_dict(),
    }
    torch.save(checkpoint, checkpoint_path)
    checkpoint_hash = _sha256(checkpoint_path)
    publish_allowed = True
    try:
        manifest.assert_allowed(Operation.PUBLISH_MODEL)
    except ManifestError:
        publish_allowed = False
    metadata = {
        "schema_version": 1,
        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "architecture": ARCHITECTURE,
        "embedding_dimension": EMBEDDING_DIMENSION,
        "input_size": INPUT_SIZE,
        "checkpoint_sha256": checkpoint_hash,
        "manifest_fingerprint": manifest.fingerprint,
        "split_fingerprint": partitions.fingerprint,
        "publish_model_rights_allowed": publish_allowed,
        "weights_origin": "random-initialization-no-pretrained-weights",
        "history": history,
    }
    write_canonical_json(destination / "training-metadata.json", metadata)
    return metadata


def _validate_config(config: TrainingConfig) -> None:
    if config.epochs <= 0:
        raise ValueError("epochs must be positive")
    if config.workers < 0:
        raise ValueError("workers must be non-negative")
    if config.learning_rate <= 0 or config.weight_decay < 0 or config.triplet_margin <= 0:
        raise ValueError("optimizer values and triplet margin are invalid")


def _resolve_device(torch: Any, requested: str) -> str:
    if requested == "auto":
        return "cuda" if torch.cuda.is_available() else "cpu"
    if requested.startswith("cuda") and not torch.cuda.is_available():
        raise ValueError("CUDA was requested but is unavailable")
    return requested


def _set_reproducible_seed(torch: Any, seed: int) -> None:
    random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    torch.use_deterministic_algorithms(True, warn_only=True)
    if hasattr(torch.backends, "cudnn"):
        torch.backends.cudnn.benchmark = False


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _torch() -> Any:
    try:
        import torch
    except ImportError as exc:
        raise DependencyUnavailableError(
            "training requires Torch; install cardscope-ml[train]"
        ) from exc
    return torch
