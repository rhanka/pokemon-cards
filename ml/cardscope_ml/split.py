"""Stable UID-level partitions that cannot leak a printing between splits."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
from typing import Iterable

from .errors import ManifestError
from .rights import ImageItem, RightsManifest

SPLIT_NAMES = ("train", "validation", "test")


@dataclass(frozen=True, slots=True)
class SplitConfig:
    train: float = 0.8
    validation: float = 0.1
    test: float = 0.1
    seed: int = 20260722

    def __post_init__(self) -> None:
        ratios = (self.train, self.validation, self.test)
        if isinstance(self.seed, bool) or not isinstance(self.seed, int) or self.seed < 0:
            raise ValueError("split seed must be a non-negative integer")
        if any(not math.isfinite(value) or value <= 0 for value in ratios):
            raise ValueError("all split ratios must be finite and greater than zero")
        if not math.isclose(sum(ratios), 1.0, rel_tol=0.0, abs_tol=1e-12):
            raise ValueError("split ratios must sum to exactly 1.0")


@dataclass(frozen=True, slots=True)
class ManifestSplit:
    train: tuple[ImageItem, ...]
    validation: tuple[ImageItem, ...]
    test: tuple[ImageItem, ...]
    uid_assignments: tuple[tuple[str, str], ...]
    fingerprint: str

    def items(self, split_name: str) -> tuple[ImageItem, ...]:
        if split_name not in SPLIT_NAMES:
            raise KeyError(f"unknown split {split_name!r}")
        return getattr(self, split_name)


def assign_uid(card_uid: str, config: SplitConfig = SplitConfig()) -> str:
    if not isinstance(card_uid, str) or not card_uid:
        raise ValueError("card_uid must be a non-empty string")
    payload = f"cardscope-split-v1\0{config.seed}\0{card_uid}".encode("utf-8")
    bucket = int.from_bytes(hashlib.sha256(payload).digest()[:8], "big") / 2**64
    if bucket < config.train:
        return "train"
    if bucket < config.train + config.validation:
        return "validation"
    return "test"


def split_items(
    items: Iterable[ImageItem], config: SplitConfig = SplitConfig()
) -> ManifestSplit:
    materialized = tuple(items)
    assignments = {item.card_uid: assign_uid(item.card_uid, config) for item in materialized}
    partitions: dict[str, list[ImageItem]] = {name: [] for name in SPLIT_NAMES}
    for item in materialized:
        partitions[assignments[item.card_uid]].append(item)
    for values in partitions.values():
        values.sort(key=lambda item: (item.card_uid, item.role, item.item_id))

    sorted_assignments = tuple(sorted(assignments.items()))
    fingerprint_payload = {
        "algorithm": "sha256-uid-v1",
        "ratios": [config.train, config.validation, config.test],
        "seed": config.seed,
        "uid_assignments": sorted_assignments,
    }
    canonical = json.dumps(fingerprint_payload, sort_keys=True, separators=(",", ":"))
    fingerprint = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    result = ManifestSplit(
        train=tuple(partitions["train"]),
        validation=tuple(partitions["validation"]),
        test=tuple(partitions["test"]),
        uid_assignments=sorted_assignments,
        fingerprint=fingerprint,
    )
    assert_uid_separation(result)
    return result


def split_manifest(
    manifest: RightsManifest, config: SplitConfig = SplitConfig()
) -> ManifestSplit:
    return split_items(manifest.items, config)


def assert_uid_separation(split: ManifestSplit) -> None:
    seen: dict[str, str] = {}
    for split_name in SPLIT_NAMES:
        for item in split.items(split_name):
            previous = seen.setdefault(item.card_uid, split_name)
            if previous != split_name:
                raise ManifestError(
                    f"card UID {item.card_uid!r} leaks between {previous} and {split_name}"
                )
