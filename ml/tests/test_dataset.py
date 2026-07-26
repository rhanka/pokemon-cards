from cardscope_ml.dataset import UIDBatchSampler, pad_to_square
from cardscope_ml.rights import ImageItem


def _item(index: int) -> ImageItem:
    return ImageItem(
        item_id=f"item:{index}",
        card_uid=f"tcg:set-{index}",
        relative_path=f"references/{index}.png",
        sha256="0" * 64,
        source_id="fixture",
        role="reference",
        capture_group="catalogue",
        language="en",
        set_id="set",
        variant="unknown",
    )


def test_sampler_covers_every_uid_in_an_epoch() -> None:
    sampler = UIDBatchSampler([_item(index) for index in range(5)], classes_per_batch=2, samples_per_class=2)

    sampled_indexes = {entry[0] for batch in sampler for entry in batch}

    assert len(sampler) == 3
    assert sampled_indexes == {0, 1, 2, 3, 4}


def test_sampler_handles_a_pilot_smaller_than_the_requested_batch() -> None:
    sampler = UIDBatchSampler([_item(index) for index in range(3)], classes_per_batch=16, samples_per_class=2)

    batches = list(sampler)

    assert len(batches) == 1
    assert {entry[0] for entry in batches[0]} == {0, 1, 2}


def test_pad_to_square_preserves_the_full_portrait_card() -> None:
    from PIL import Image

    image = Image.new("RGB", (100, 160), (1, 2, 3))
    padded = pad_to_square(image, fill=(9, 8, 7))

    assert padded.size == (160, 160)
    assert padded.getpixel((30, 0)) == (1, 2, 3)
    assert padded.getpixel((0, 0)) == (9, 8, 7)
