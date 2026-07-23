import pytest

Image = pytest.importorskip("PIL.Image", reason="Pillow is an optional data dependency")

from cardscope_ml.augment import SyntheticAugmenter


def test_should_apply_every_named_capture_simulation_deterministically() -> None:
    source = Image.new("RGB", (96, 132), (120, 80, 40))
    augmenter = SyntheticAugmenter(seed=42)

    first, first_trace = augmenter.augment(
        source, sample_key="fixture:a", epoch=3, force_all=True
    )
    second, second_trace = augmenter.augment(
        source, sample_key="fixture:a", epoch=3, force_all=True
    )

    assert first.tobytes() == second.tobytes()
    assert first_trace == second_trace
    assert first_trace.operations == (
        "perspective",
        "glare",
        "sleeve",
        "blur",
        "shadow",
        "white-balance",
        "jpeg",
        "occlusion",
    )
