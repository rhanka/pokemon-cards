"""Dependency-free retrieval, open-set, and calibration metrics."""

from __future__ import annotations

from dataclasses import asdict, dataclass
import math
from typing import Sequence


@dataclass(frozen=True, slots=True)
class RetrievalMetrics:
    top1: float
    recall_at_5: float
    false_accept_rate: float
    expected_calibration_error: float
    known_queries: int
    unknown_queries: int
    accepted_queries: int
    false_accepts: int
    accepted_wrong_known: int

    def to_dict(self) -> dict[str, float | int]:
        return asdict(self)


def evaluate_retrieval(
    scores: Sequence[Sequence[float]],
    query_uids: Sequence[str],
    gallery_uids: Sequence[str],
    *,
    confidences: Sequence[float] | None = None,
    accept_threshold: float = 0.5,
    recall_k: int = 5,
    calibration_bins: int = 10,
) -> RetrievalMetrics:
    """Evaluate exact-printing retrieval and open-set abstention.

    Top-1 and Recall@K use known queries only. FAR is the fraction of unknown probes whose best
    candidate is accepted. ECE uses candidate correctness for every probe, so an accepted-looking
    unknown contributes a negative calibration example.
    """

    if not gallery_uids:
        raise ValueError("gallery_uids must not be empty")
    if len(scores) != len(query_uids):
        raise ValueError("scores and query_uids must have the same length")
    if not query_uids:
        raise ValueError("at least one query is required")
    if recall_k <= 0:
        raise ValueError("recall_k must be positive")
    _probability(accept_threshold, "accept_threshold")

    rows: list[tuple[float, ...]] = []
    for row_index, raw_row in enumerate(scores):
        row = tuple(float(value) for value in raw_row)
        if len(row) != len(gallery_uids):
            raise ValueError(
                f"scores[{row_index}] has {len(row)} columns; expected {len(gallery_uids)}"
            )
        if any(not math.isfinite(value) for value in row):
            raise ValueError(f"scores[{row_index}] contains a non-finite value")
        rows.append(row)

    if confidences is None:
        confidence_values = tuple(_clamp01(max(row)) for row in rows)
    else:
        if len(confidences) != len(query_uids):
            raise ValueError("confidences and query_uids must have the same length")
        confidence_values = tuple(
            _probability(float(value), f"confidences[{index}]")
            for index, value in enumerate(confidences)
        )

    gallery_set = set(gallery_uids)
    known = 0
    top1_hits = 0
    recall_hits = 0
    unknown = 0
    false_accepts = 0
    accepted = 0
    accepted_wrong_known = 0
    candidate_correctness: list[bool] = []

    for row, query_uid, confidence in zip(rows, query_uids, confidence_values, strict=True):
        ranking = sorted(range(len(row)), key=lambda index: (-row[index], index))
        predicted_uid = gallery_uids[ranking[0]]
        is_known = query_uid in gallery_set
        is_correct = is_known and predicted_uid == query_uid
        candidate_correctness.append(is_correct)
        is_accepted = confidence >= accept_threshold
        if is_accepted:
            accepted += 1
        if is_known:
            known += 1
            if is_correct:
                top1_hits += 1
            top_uids = {gallery_uids[index] for index in ranking[:recall_k]}
            if query_uid in top_uids:
                recall_hits += 1
            if is_accepted and not is_correct:
                accepted_wrong_known += 1
        else:
            unknown += 1
            if is_accepted:
                false_accepts += 1

    return RetrievalMetrics(
        top1=_safe_ratio(top1_hits, known),
        recall_at_5=_safe_ratio(recall_hits, known),
        false_accept_rate=_safe_ratio(false_accepts, unknown),
        expected_calibration_error=expected_calibration_error(
            confidence_values, candidate_correctness, bins=calibration_bins
        ),
        known_queries=known,
        unknown_queries=unknown,
        accepted_queries=accepted,
        false_accepts=false_accepts,
        accepted_wrong_known=accepted_wrong_known,
    )


def expected_calibration_error(
    confidences: Sequence[float], correctness: Sequence[bool], *, bins: int = 10
) -> float:
    if len(confidences) != len(correctness):
        raise ValueError("confidences and correctness must have the same length")
    if not confidences:
        raise ValueError("at least one confidence is required")
    if isinstance(bins, bool) or not isinstance(bins, int) or bins <= 0:
        raise ValueError("bins must be a positive integer")
    counts = [0] * bins
    confidence_sums = [0.0] * bins
    correct_sums = [0] * bins
    for index, (raw_confidence, raw_correct) in enumerate(
        zip(confidences, correctness, strict=True)
    ):
        confidence = _probability(float(raw_confidence), f"confidences[{index}]")
        if type(raw_correct) is not bool:
            raise ValueError(f"correctness[{index}] must be a boolean")
        bin_index = min(int(confidence * bins), bins - 1)
        counts[bin_index] += 1
        confidence_sums[bin_index] += confidence
        correct_sums[bin_index] += int(raw_correct)

    total = len(confidences)
    error = 0.0
    for count, confidence_sum, correct_sum in zip(
        counts, confidence_sums, correct_sums, strict=True
    ):
        if count:
            average_confidence = confidence_sum / count
            accuracy = correct_sum / count
            error += (count / total) * abs(accuracy - average_confidence)
    return error


def top_two_features(row: Sequence[float]) -> tuple[float, float]:
    if not row:
        raise ValueError("score row must not be empty")
    values = sorted((float(value) for value in row), reverse=True)
    if any(not math.isfinite(value) for value in values):
        raise ValueError("score row contains a non-finite value")
    top = values[0]
    second = values[1] if len(values) > 1 else top
    return top, top - second


def _probability(value: float, name: str) -> float:
    if not math.isfinite(value) or not 0.0 <= value <= 1.0:
        raise ValueError(f"{name} must be a finite probability in [0, 1]")
    return value


def _clamp01(value: float) -> float:
    return min(1.0, max(0.0, value))


def _safe_ratio(numerator: int, denominator: int) -> float:
    return numerator / denominator if denominator else 0.0
