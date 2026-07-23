import pytest

from cardscope_ml.metrics import evaluate_retrieval, expected_calibration_error


def test_should_compute_top1_recall5_far_and_counts() -> None:
    gallery = ["a", "b", "c", "d", "e", "f"]
    queries = ["a", "b", "unknown-1", "unknown-2"]
    scores = [
        [0.9, 0.2, 0.1, 0.0, -0.1, -0.2],
        [0.8, 0.7, 0.6, 0.5, 0.4, 0.3],
        [0.6, 0.5, 0.4, 0.3, 0.2, 0.1],
        [0.3, 0.2, 0.1, 0.0, -0.1, -0.2],
    ]
    confidences = [0.95, 0.85, 0.9, 0.2]

    metrics = evaluate_retrieval(
        scores,
        queries,
        gallery,
        confidences=confidences,
        accept_threshold=0.8,
    )

    assert metrics.top1 == pytest.approx(0.5)
    assert metrics.recall_at_5 == pytest.approx(1.0)
    assert metrics.false_accept_rate == pytest.approx(0.5)
    assert metrics.known_queries == 2
    assert metrics.unknown_queries == 2
    assert metrics.accepted_queries == 3
    assert metrics.false_accepts == 1
    assert metrics.accepted_wrong_known == 1


def test_should_compute_standard_equal_width_ece() -> None:
    value = expected_calibration_error([0.9, 0.8, 0.4, 0.2], [True, False, True, False], bins=2)

    assert value == pytest.approx(0.275)


def test_should_break_score_ties_by_stable_gallery_order() -> None:
    metrics = evaluate_retrieval(
        [[0.7, 0.7]], ["first"], ["first", "second"], confidences=[0.9]
    )

    assert metrics.top1 == 1.0


def test_should_reject_non_finite_scores() -> None:
    with pytest.raises(ValueError, match="non-finite"):
        evaluate_retrieval([[float("nan")]], ["a"], ["a"])
