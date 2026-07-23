"""Online batch-hard metric loss and deterministic nearest-impostor inspection."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Sequence

from .errors import DependencyUnavailableError


@dataclass(frozen=True, slots=True)
class HardNegativePair:
    anchor_index: int
    negative_index: int
    similarity: float


def batch_hard_triplet_loss(
    embeddings: Any, labels: Any, *, margin: float = 0.2
) -> tuple[Any, dict[str, float]]:
    """Use the hardest positive and closest negative for every valid anchor."""

    torch = _torch()
    if embeddings.ndim != 2 or labels.ndim != 1 or embeddings.shape[0] != labels.shape[0]:
        raise ValueError("embeddings must be [batch, dim] and labels must be [batch]")
    if embeddings.shape[0] < 3:
        raise ValueError("batch-hard loss requires at least three samples")
    if margin <= 0:
        raise ValueError("triplet margin must be positive")

    similarities = embeddings @ embeddings.transpose(0, 1)
    distances = 1.0 - similarities
    same_uid = labels[:, None].eq(labels[None, :])
    diagonal = torch.eye(labels.shape[0], dtype=torch.bool, device=labels.device)
    positive_mask = same_uid & ~diagonal
    negative_mask = ~same_uid
    valid = positive_mask.any(dim=1) & negative_mask.any(dim=1)
    if not bool(valid.any()):
        raise ValueError("every batch needs at least two UIDs and one positive pair")

    negative_infinity = torch.tensor(float("-inf"), device=embeddings.device)
    positive_infinity = torch.tensor(float("inf"), device=embeddings.device)
    hardest_positive = torch.where(positive_mask, distances, negative_infinity).max(dim=1).values
    hardest_negative = torch.where(negative_mask, distances, positive_infinity).min(dim=1).values
    losses = torch.relu(hardest_positive[valid] - hardest_negative[valid] + margin)
    loss = losses.mean()
    stats = {
        "loss": float(loss.detach().cpu()),
        "hardest_positive_distance": float(hardest_positive[valid].mean().detach().cpu()),
        "hardest_negative_distance": float(hardest_negative[valid].mean().detach().cpu()),
        "active_triplet_fraction": float((losses > 0).float().mean().detach().cpu()),
    }
    return loss, stats


def mine_hard_negative_pairs(
    embeddings: Any, labels: Sequence[str], *, negatives_per_anchor: int = 5
) -> tuple[HardNegativePair, ...]:
    """Return nearest different-UID vectors without retaining image content."""

    torch = _torch()
    if embeddings.ndim != 2 or embeddings.shape[0] != len(labels):
        raise ValueError("embeddings and labels have inconsistent shapes")
    if negatives_per_anchor <= 0:
        raise ValueError("negatives_per_anchor must be positive")
    similarities = (embeddings @ embeddings.transpose(0, 1)).detach().cpu()
    pairs: list[HardNegativePair] = []
    for anchor_index, anchor_label in enumerate(labels):
        candidates = [
            (float(similarities[anchor_index, index]), index)
            for index, label in enumerate(labels)
            if label != anchor_label
        ]
        candidates.sort(key=lambda candidate: (-candidate[0], candidate[1]))
        for similarity, negative_index in candidates[:negatives_per_anchor]:
            pairs.append(
                HardNegativePair(
                    anchor_index=anchor_index,
                    negative_index=negative_index,
                    similarity=similarity,
                )
            )
    return tuple(pairs)


def _torch() -> Any:
    try:
        import torch
    except ImportError as exc:
        raise DependencyUnavailableError(
            "hard-negative mining requires Torch; install cardscope-ml[train]"
        ) from exc
    return torch
