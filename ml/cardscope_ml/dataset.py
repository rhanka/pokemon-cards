"""Manifest-backed datasets with verified paths and deterministic synthetic captures."""

from __future__ import annotations

from collections import defaultdict
import math
from pathlib import Path
import random
from typing import Any, Iterable, Iterator, Sequence

from .augment import SyntheticAugmenter
from .errors import DependencyUnavailableError
from .rights import ImageItem

IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)


class ManifestTorchDataset:
    def __init__(
        self,
        items: Sequence[ImageItem],
        *,
        asset_root: str | Path,
        training: bool,
        augmenter: SyntheticAugmenter | None = None,
    ) -> None:
        if not items:
            raise ValueError("dataset must contain at least one item")
        self.items = tuple(items)
        self.asset_root = Path(asset_root).resolve()
        self.training = training
        self.augmenter = augmenter or SyntheticAugmenter()
        self.label_by_uid = {
            uid: index for index, uid in enumerate(sorted({item.card_uid for item in self.items}))
        }
        self.transform = _transform(training=False)

    def __len__(self) -> int:
        return len(self.items)

    def __getitem__(self, key: int | tuple[int, int, int, int]) -> tuple[Any, int, str]:
        if isinstance(key, tuple):
            index, epoch, batch_index, draw_index = key
        else:
            index, epoch, batch_index, draw_index = key, 0, 0, 0
        item = self.items[index]
        Image = _image()
        path = (self.asset_root / item.relative_path).resolve()
        try:
            path.relative_to(self.asset_root)
        except ValueError as exc:
            raise ValueError(f"asset path escapes root: {item.relative_path}") from exc
        with Image.open(path) as opened:
            image = opened.convert("RGB")
        if self.training:
            sample_key = f"{item.item_id}:{batch_index}:{draw_index}"
            image, _ = self.augmenter.augment(image, sample_key=sample_key, epoch=epoch)
        tensor = self.transform(image)
        return tensor, self.label_by_uid[item.card_uid], item.item_id


class UIDBatchSampler:
    """P-by-K sampler; replacement yields independent augmentations for sparse UIDs."""

    def __init__(
        self,
        items: Sequence[ImageItem],
        *,
        classes_per_batch: int = 16,
        samples_per_class: int = 4,
        seed: int = 20260722,
    ) -> None:
        if classes_per_batch < 2:
            raise ValueError("classes_per_batch must be at least two")
        if samples_per_class < 2:
            raise ValueError("samples_per_class must be at least two")
        grouped: dict[str, list[int]] = defaultdict(list)
        for index, item in enumerate(items):
            if item.role != "unknown":
                grouped[item.card_uid].append(index)
        if len(grouped) < 2:
            raise ValueError("metric training requires at least two card UIDs")
        self.grouped = {uid: tuple(indices) for uid, indices in sorted(grouped.items())}
        self.classes_per_batch = min(classes_per_batch, len(grouped))
        self.samples_per_class = samples_per_class
        self.seed = seed
        self.epoch = 0
        self.batches = max(
            1,
            math.ceil(
                sum(len(indices) for indices in self.grouped.values())
                / (self.classes_per_batch * self.samples_per_class)
            ),
        )

    def set_epoch(self, epoch: int) -> None:
        self.epoch = epoch

    def __len__(self) -> int:
        return self.batches

    def __iter__(self) -> Iterator[list[tuple[int, int, int, int]]]:
        rng = random.Random(f"cardscope-sampler-v1:{self.seed}:{self.epoch}")
        uids = tuple(self.grouped)
        for batch_index in range(self.batches):
            chosen_uids = rng.sample(uids, self.classes_per_batch)
            batch: list[tuple[int, int, int, int]] = []
            draw_index = 0
            for uid in chosen_uids:
                indices = self.grouped[uid]
                for _ in range(self.samples_per_class):
                    index = rng.choice(indices)
                    batch.append((index, self.epoch, batch_index, draw_index))
                    draw_index += 1
            rng.shuffle(batch)
            yield batch


def evaluation_transform() -> Any:
    return _transform(training=False)


def _transform(*, training: bool) -> Any:
    del training
    try:
        from torchvision import transforms
    except ImportError as exc:
        raise DependencyUnavailableError(
            "image tensors require torchvision; install cardscope-ml[train]"
        ) from exc
    return transforms.Compose(
        [
            transforms.Resize(256, antialias=True),
            transforms.CenterCrop(224),
            transforms.ToTensor(),
            transforms.Normalize(IMAGENET_MEAN, IMAGENET_STD),
        ]
    )


def _image() -> Any:
    try:
        from PIL import Image
    except ImportError as exc:
        raise DependencyUnavailableError(
            "image loading requires Pillow; install cardscope-ml[data]"
        ) from exc
    return Image
