from dataclasses import replace
from pathlib import Path

import pytest

from cardscope_ml.rights import load_rights_manifest
from cardscope_ml.split import SplitConfig, assign_uid, assert_uid_separation, split_items

FIXTURE = Path(__file__).parent / "fixtures" / "rights_manifest.json"


def test_should_assign_every_image_of_a_card_uid_to_one_split() -> None:
    manifest = load_rights_manifest(FIXTURE)
    split = split_items(reversed(manifest.items), SplitConfig(seed=42))

    assert_uid_separation(split)
    observed = {}
    for split_name in ("train", "validation", "test"):
        for item in split.items(split_name):
            observed.setdefault(item.card_uid, set()).add(split_name)
    assert all(len(names) == 1 for names in observed.values())


def test_should_be_deterministic_and_independent_of_input_order() -> None:
    manifest = load_rights_manifest(FIXTURE)
    config = SplitConfig(seed=99)

    forward = split_items(manifest.items, config)
    backward = split_items(reversed(manifest.items), config)

    assert forward.uid_assignments == backward.uid_assignments
    assert forward.fingerprint == backward.fingerprint
    assert forward.train == backward.train


def test_should_populate_all_partitions_for_a_representative_uid_set() -> None:
    manifest = load_rights_manifest(FIXTURE)
    template = manifest.items[0]
    items = [
        replace(template, item_id=f"ref-{index}", card_uid=f"fixture:uid-{index}")
        for index in range(500)
    ]

    split = split_items(items, SplitConfig(seed=20260722))

    assert len(split.train) > len(split.validation) > 0
    assert len(split.train) > len(split.test) > 0


def test_should_reject_invalid_ratios() -> None:
    with pytest.raises(ValueError, match="sum"):
        SplitConfig(train=0.8, validation=0.15, test=0.1)


def test_should_keep_a_phone_capture_group_in_one_partition() -> None:
    manifest = load_rights_manifest(FIXTURE)
    template = manifest.items[0]
    first = replace(
        template,
        item_id="capture-a",
        card_uid="fixture:uid-a",
        role="capture",
        capture_group="phone-session-1",
    )
    second = replace(
        template,
        item_id="capture-b",
        card_uid="fixture:uid-b",
        role="capture",
        capture_group="phone-session-1",
    )
    seed = next(
        candidate
        for candidate in range(10_000)
        if assign_uid(first.card_uid, SplitConfig(seed=candidate))
        != assign_uid(second.card_uid, SplitConfig(seed=candidate))
    )

    with pytest.raises(ValueError, match="capture group.*leaks"):
        split_items((first, second), SplitConfig(seed=seed))


def test_should_not_allow_a_capture_session_to_cross_roles_or_partitions() -> None:
    manifest = load_rights_manifest(FIXTURE)
    template = manifest.items[0]
    capture = replace(
        template,
        item_id="capture-a",
        card_uid="fixture:uid-a",
        role="capture",
        capture_group="phone-session-1",
    )
    unknown = replace(
        template,
        item_id="unknown-b",
        card_uid="fixture:uid-b",
        role="unknown",
        capture_group="phone-session-1",
    )
    seed = next(
        candidate
        for candidate in range(10_000)
        if assign_uid(capture.card_uid, SplitConfig(seed=candidate))
        != assign_uid(unknown.card_uid, SplitConfig(seed=candidate))
    )

    with pytest.raises(ValueError, match="capture group.*leaks"):
        split_items((capture, unknown), SplitConfig(seed=seed))


def test_should_change_assignments_when_seed_changes() -> None:
    assignments_a = [assign_uid(f"fixture:{index}", SplitConfig(seed=1)) for index in range(100)]
    assignments_b = [assign_uid(f"fixture:{index}", SplitConfig(seed=2)) for index in range(100)]

    assert assignments_a != assignments_b
