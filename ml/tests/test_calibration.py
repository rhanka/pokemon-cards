import pytest

from cardscope_ml.calibration import fit_score_calibrator, select_accept_threshold


def test_should_fit_higher_confidence_for_clear_correct_matches() -> None:
    calibrator = fit_score_calibrator(
        [0.95, 0.90, 0.60, 0.55],
        [0.70, 0.60, 0.03, 0.01],
        [True, True, False, False],
    )

    assert calibrator.predict(0.93, 0.65) > calibrator.predict(0.58, 0.02)


def test_should_select_lowest_threshold_meeting_far_target() -> None:
    selection = select_accept_threshold(
        [0.95, 0.8, 0.7, 0.2],
        [True, True, False, False],
        [True, True, False, False],
        target_far=0.0,
    )

    assert selection.threshold > 0.7
    assert selection.observed_far == 0.0
    assert selection.known_correct_accepts == 2


def test_should_require_unknown_probes_for_far_threshold() -> None:
    with pytest.raises(ValueError, match="unknown probe"):
        select_accept_threshold([0.9], [True], [True])
