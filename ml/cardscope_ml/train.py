"""Reproducible batch-hard metric-learning entry point."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import random
from typing import Any

from .augment import SyntheticAugmenter
from .dataset import ManifestTorchDataset, UIDBatchSampler
from .errors import DependencyUnavailableError, ManifestError
from .hard_negatives import batch_hard_triplet_loss
from .model import ARCHITECTURE, EMBEDDING_DIMENSION, INPUT_SIZE, build_model
from .report import write_canonical_json
from .rights import Operation, load_rights_manifest, require_training_operation
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
    checkpoint_every_epochs: int = 1
    resume_checkpoint: str | None = None
    pretrained_backbone: bool = False
    freeze_backbone_epochs: int = 0


def train(
    *,
    manifest_path: str | Path,
    asset_root: str | Path,
    output_dir: str | Path,
    config: TrainingConfig = TrainingConfig(),
    operation: Operation | str = Operation.TRAIN,
) -> dict[str, Any]:
    torch = _torch()
    _validate_config(config)
    training_operation = require_training_operation(operation)
    manifest = load_rights_manifest(manifest_path)
    manifest.assert_allowed(training_operation)
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
    model = build_model(pretrained_backbone=config.pretrained_backbone).to(device)
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=config.learning_rate, weight_decay=config.weight_decay
    )

    destination = Path(output_dir)
    destination.mkdir(parents=True, exist_ok=True)
    history: list[dict[str, float | int]] = []
    start_epoch = 0
    if config.resume_checkpoint:
        resume = torch.load(config.resume_checkpoint, map_location=device, weights_only=False)
        _validate_resume_checkpoint(
            resume,
            manifest_fingerprint=manifest.fingerprint,
            split_fingerprint=partitions.fingerprint,
            seed=config.seed,
            operation=training_operation,
        )
        model.load_state_dict(resume["state_dict"], strict=True)
        optimizer.load_state_dict(resume["optimizer_state_dict"])
        start_epoch = int(resume["completed_epochs"])
        history = list(resume["history"])
        if start_epoch >= config.epochs:
            raise ValueError("resume checkpoint already completed the requested epoch count")

    for epoch in range(start_epoch, config.epochs):
        sampler.set_epoch(epoch)
        model.train()
        backbone_trainable = epoch >= config.freeze_backbone_epochs
        _set_backbone_trainable(model, backbone_trainable)
        if not backbone_trainable:
            model.features.eval()
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
        if (epoch + 1) % config.checkpoint_every_epochs == 0:
            _save_checkpoint_atomically(
                torch,
                _checkpoint(
                    model=model,
                    optimizer=optimizer,
                    manifest_fingerprint=manifest.fingerprint,
                    split_fingerprint=partitions.fingerprint,
                    config=config,
                    training_operation=training_operation,
                    completed_epochs=epoch + 1,
                    history=history,
                ),
                destination / "model.last.pt",
            )

    checkpoint_path = destination / "model.pt"
    checkpoint = _checkpoint(
        model=model,
        optimizer=optimizer,
        manifest_fingerprint=manifest.fingerprint,
        split_fingerprint=partitions.fingerprint,
        config=config,
        training_operation=training_operation,
        completed_epochs=config.epochs,
        history=history,
    )
    _save_checkpoint_atomically(torch, checkpoint, checkpoint_path)
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
        "training_rights_operation": training_operation.value,
        "local_only": training_operation is Operation.TRAIN_NONCOMMERCIAL_EXPERIMENT,
        "completed_epochs": config.epochs,
        "resume_checkpoint": config.resume_checkpoint,
        "publish_model_rights_allowed": publish_allowed,
        "weights_origin": (
            "torchvision-mobilenet-v3-small-imagenet1k-v1"
            if config.pretrained_backbone
            else "random-initialization-no-pretrained-weights"
        ),
        "history": history,
    }
    write_canonical_json(destination / "training-metadata.json", metadata)
    return metadata


def _validate_config(config: TrainingConfig) -> None:
    if config.epochs <= 0:
        raise ValueError("epochs must be positive")
    if config.workers < 0:
        raise ValueError("workers must be non-negative")
    if config.checkpoint_every_epochs <= 0:
        raise ValueError("checkpoint_every_epochs must be positive")
    if config.freeze_backbone_epochs < 0 or config.freeze_backbone_epochs > config.epochs:
        raise ValueError("freeze_backbone_epochs must be between 0 and epochs")
    if config.freeze_backbone_epochs > 0 and not config.pretrained_backbone:
        raise ValueError("freeze_backbone_epochs requires pretrained_backbone")
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


def _checkpoint(
    *,
    model: Any,
    optimizer: Any,
    manifest_fingerprint: str,
    split_fingerprint: str,
    config: TrainingConfig,
    training_operation: Operation,
    completed_epochs: int,
    history: list[dict[str, float | int]],
) -> dict[str, Any]:
    return {
        "format_version": 1,
        "architecture": ARCHITECTURE,
        "embedding_dimension": EMBEDDING_DIMENSION,
        "input_size": INPUT_SIZE,
        "manifest_fingerprint": manifest_fingerprint,
        "split_fingerprint": split_fingerprint,
        "seed": config.seed,
        "training_config": asdict(config),
        "training_rights_operation": training_operation.value,
        "completed_epochs": completed_epochs,
        "history": history,
        "state_dict": _cpu_state_dict(model),
        "optimizer_state_dict": optimizer.state_dict(),
    }


def _cpu_state_dict(model: Any) -> dict[str, Any]:
    return {
        name: value.detach().cpu().clone() if hasattr(value, "detach") else value
        for name, value in model.state_dict().items()
    }


def _save_checkpoint_atomically(torch: Any, checkpoint: dict[str, Any], path: Path) -> None:
    temporary = path.with_suffix(f"{path.suffix}.{os.getpid()}.partial")
    torch.save(checkpoint, temporary)
    temporary.replace(path)


def _set_backbone_trainable(model: Any, trainable: bool) -> None:
    for parameter in model.features.parameters():
        parameter.requires_grad = trainable


def _validate_resume_checkpoint(
    checkpoint: Any,
    *,
    manifest_fingerprint: str,
    split_fingerprint: str,
    seed: int,
    operation: Operation,
) -> None:
    if not isinstance(checkpoint, dict) or checkpoint.get("format_version") != 1:
        raise ValueError("resume checkpoint is malformed")
    for field, expected in (
        ("manifest_fingerprint", manifest_fingerprint),
        ("split_fingerprint", split_fingerprint),
        ("seed", seed),
        ("training_rights_operation", operation.value),
    ):
        if checkpoint.get(field) != expected:
            raise ValueError(f"resume checkpoint {field} differs from this training run")
    if not isinstance(checkpoint.get("completed_epochs"), int) or checkpoint["completed_epochs"] < 0:
        raise ValueError("resume checkpoint completed_epochs is invalid")
    if not isinstance(checkpoint.get("history"), list):
        raise ValueError("resume checkpoint history is invalid")
    if "optimizer_state_dict" not in checkpoint:
        raise ValueError("resume checkpoint has no optimizer state")


def _torch() -> Any:
    try:
        import torch
    except ImportError as exc:
        raise DependencyUnavailableError(
            "training requires Torch; install cardscope-ml[train]"
        ) from exc
    return torch
