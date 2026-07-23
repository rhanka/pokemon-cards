"""Small deterministic Platt calibrator for top similarity and top-two margin."""

from __future__ import annotations

from dataclasses import asdict, dataclass
import math
from typing import Sequence


@dataclass(frozen=True, slots=True)
class ScoreCalibrator:
    intercept: float
    top_score_coefficient: float
    margin_coefficient: float
    iterations: int
    examples: int
    positives: int
    method: str = "platt-top-score-margin-v1"

    def predict(self, top_score: float, margin: float) -> float:
        logit = (
            self.intercept
            + self.top_score_coefficient * float(top_score)
            + self.margin_coefficient * float(margin)
        )
        return _sigmoid(logit)

    def predict_many(
        self, top_scores: Sequence[float], margins: Sequence[float]
    ) -> tuple[float, ...]:
        if len(top_scores) != len(margins):
            raise ValueError("top_scores and margins must have the same length")
        return tuple(
            self.predict(top, margin)
            for top, margin in zip(top_scores, margins, strict=True)
        )

    def to_dict(self) -> dict[str, float | int | str]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class ThresholdSelection:
    threshold: float
    target_far: float
    observed_far: float
    unknown_queries: int
    false_accepts: int
    known_correct_accepts: int


def fit_score_calibrator(
    top_scores: Sequence[float],
    margins: Sequence[float],
    correctness: Sequence[bool],
    *,
    l2: float = 1e-3,
    max_iterations: int = 100,
    tolerance: float = 1e-9,
) -> ScoreCalibrator:
    """Fit a regularized three-parameter logistic model with Newton updates."""

    if not (len(top_scores) == len(margins) == len(correctness)):
        raise ValueError("calibration inputs must have the same length")
    if len(top_scores) < 2:
        raise ValueError("at least two calibration examples are required")
    if l2 < 0 or not math.isfinite(l2):
        raise ValueError("l2 must be finite and non-negative")
    if max_iterations <= 0:
        raise ValueError("max_iterations must be positive")

    rows: list[tuple[float, float, float]] = []
    targets: list[float] = []
    for index, (top, margin, correct) in enumerate(
        zip(top_scores, margins, correctness, strict=True)
    ):
        top_value = float(top)
        margin_value = float(margin)
        if not math.isfinite(top_value) or not math.isfinite(margin_value):
            raise ValueError(f"calibration example {index} contains a non-finite feature")
        if type(correct) is not bool:
            raise ValueError(f"correctness[{index}] must be a boolean")
        rows.append((1.0, top_value, margin_value))
        targets.append(float(correct))
    positives = int(sum(targets))
    if positives == 0 or positives == len(targets):
        raise ValueError("calibration requires both correct and incorrect examples")

    prior = (positives + 0.5) / (len(targets) + 1.0)
    coefficients = [math.log(prior / (1.0 - prior)), 0.0, 0.0]
    completed_iterations = 0
    for iteration in range(1, max_iterations + 1):
        gradient = [0.0, 0.0, 0.0]
        hessian = [[0.0, 0.0, 0.0] for _ in range(3)]
        for features, target in zip(rows, targets, strict=True):
            probability = _sigmoid(sum(c * x for c, x in zip(coefficients, features)))
            residual = probability - target
            weight = max(probability * (1.0 - probability), 1e-12)
            for row_index in range(3):
                gradient[row_index] += residual * features[row_index]
                for column_index in range(3):
                    hessian[row_index][column_index] += (
                        weight * features[row_index] * features[column_index]
                    )
        for index in (1, 2):
            gradient[index] += l2 * coefficients[index]
            hessian[index][index] += l2
        hessian[0][0] += 1e-12
        step = _solve_3x3(hessian, gradient)
        coefficients = [value - delta for value, delta in zip(coefficients, step, strict=True)]
        completed_iterations = iteration
        if max(abs(delta) for delta in step) < tolerance:
            break

    return ScoreCalibrator(
        intercept=coefficients[0],
        top_score_coefficient=coefficients[1],
        margin_coefficient=coefficients[2],
        iterations=completed_iterations,
        examples=len(targets),
        positives=positives,
    )


def select_accept_threshold(
    confidences: Sequence[float],
    known: Sequence[bool],
    correctness: Sequence[bool],
    *,
    target_far: float = 0.005,
) -> ThresholdSelection:
    """Choose the lowest threshold satisfying empirical open-set FAR."""

    if not (len(confidences) == len(known) == len(correctness)):
        raise ValueError("threshold inputs must have the same length")
    if not confidences:
        raise ValueError("at least one threshold example is required")
    if not math.isfinite(target_far) or not 0 <= target_far <= 1:
        raise ValueError("target_far must be in [0, 1]")
    values: list[float] = []
    for index, (confidence, is_known, is_correct) in enumerate(
        zip(confidences, known, correctness, strict=True)
    ):
        value = float(confidence)
        if not math.isfinite(value) or not 0 <= value <= 1:
            raise ValueError(f"confidences[{index}] must be in [0, 1]")
        if type(is_known) is not bool or type(is_correct) is not bool:
            raise ValueError("known and correctness values must be booleans")
        values.append(value)
    unknown_count = sum(not flag for flag in known)
    if unknown_count == 0:
        raise ValueError("at least one unknown probe is required to select a FAR threshold")

    candidates = [0.0]
    candidates.extend(math.nextafter(value, math.inf) for value in sorted(set(values)))
    candidates = [min(1.0, candidate) for candidate in candidates]
    selected = 1.0
    selected_false_accepts = sum(
        1 for confidence, is_known in zip(values, known, strict=True) if not is_known and confidence >= 1
    )
    for candidate in candidates:
        false_accepts = sum(
            1
            for confidence, is_known in zip(values, known, strict=True)
            if not is_known and confidence >= candidate
        )
        if false_accepts / unknown_count <= target_far:
            selected = candidate
            selected_false_accepts = false_accepts
            break
    known_correct_accepts = sum(
        1
        for confidence, is_known, is_correct in zip(values, known, correctness, strict=True)
        if is_known and is_correct and confidence >= selected
    )
    return ThresholdSelection(
        threshold=selected,
        target_far=target_far,
        observed_far=selected_false_accepts / unknown_count,
        unknown_queries=unknown_count,
        false_accepts=selected_false_accepts,
        known_correct_accepts=known_correct_accepts,
    )


def _sigmoid(value: float) -> float:
    if value >= 0:
        exponential = math.exp(-value)
        return 1.0 / (1.0 + exponential)
    exponential = math.exp(value)
    return exponential / (1.0 + exponential)


def _solve_3x3(matrix: list[list[float]], vector: list[float]) -> list[float]:
    augmented = [row[:] + [value] for row, value in zip(matrix, vector, strict=True)]
    for column in range(3):
        pivot = max(range(column, 3), key=lambda row: abs(augmented[row][column]))
        if abs(augmented[pivot][column]) < 1e-15:
            augmented[pivot][column] = 1e-12
        augmented[column], augmented[pivot] = augmented[pivot], augmented[column]
        pivot_value = augmented[column][column]
        augmented[column] = [value / pivot_value for value in augmented[column]]
        for row in range(3):
            if row == column:
                continue
            factor = augmented[row][column]
            augmented[row] = [
                current - factor * pivot_current
                for current, pivot_current in zip(augmented[row], augmented[column], strict=True)
            ]
    return [augmented[row][3] for row in range(3)]
