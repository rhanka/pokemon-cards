from copy import deepcopy
import json
from pathlib import Path

import pytest

from cardscope_ml.errors import DataIntegrityError, ManifestError
from cardscope_ml.rights import Operation, load_rights_manifest, parse_rights_manifest

FIXTURE = Path(__file__).parent / "fixtures" / "rights_manifest.json"


def fixture_payload() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_should_accept_complete_explicit_provenance() -> None:
    manifest = load_rights_manifest(FIXTURE)

    manifest.assert_allowed(Operation.TRAIN)
    manifest.assert_allowed(Operation.PUBLISH_MODEL)
    manifest.assert_allowed(Operation.TRAIN_NONCOMMERCIAL_EXPERIMENT)
    manifest.assert_allowed(Operation.PUBLISH_MODEL_NONCOMMERCIAL)

    assert manifest.dataset_id == "cardscope-fixture-v1"
    assert len(manifest.fingerprint) == 64
    assert len(manifest.items) == 9


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda payload: payload["sources"][0].pop("ml_training_allowed"), "missing"),
        (lambda payload: payload["sources"][0].update({"licence_typo": "CC0"}), "unknown"),
        (
            lambda payload: payload["sources"][0].update({"commercial_use_allowed": "yes"}),
            "explicit JSON boolean",
        ),
        (
            lambda payload: payload["items"][0].update({"relative_path": "../escape.png"}),
            "normalized relative",
        ),
    ],
)
def test_should_refuse_missing_ambiguous_or_unsafe_provenance(mutate, message: str) -> None:
    payload = fixture_payload()
    mutate(payload)

    with pytest.raises(ManifestError, match=message):
        parse_rights_manifest(payload)


def test_should_refuse_model_publication_when_any_used_source_disallows_it() -> None:
    payload = fixture_payload()
    payload["sources"][0]["model_redistribution_allowed"] = False
    manifest = parse_rights_manifest(payload)

    manifest.assert_allowed(Operation.TRAIN)
    with pytest.raises(ManifestError, match="model redistribution"):
        manifest.assert_allowed(Operation.PUBLISH_MODEL)


def test_should_allow_a_noncommercial_local_experiment_without_clearing_public_release() -> None:
    payload = fixture_payload()
    source = payload["sources"][0]
    source["commercial_use_allowed"] = False
    source["model_redistribution_allowed"] = False
    source["upstream_rights_verified"] = False
    manifest = parse_rights_manifest(payload)

    manifest.assert_allowed(Operation.TRAIN_NONCOMMERCIAL_EXPERIMENT)
    with pytest.raises(ManifestError, match="commercial use"):
        manifest.assert_allowed(Operation.TRAIN)
    with pytest.raises(ManifestError, match="verified upstream rights"):
        manifest.assert_allowed(Operation.PUBLISH_MODEL_NONCOMMERCIAL)


def test_should_verify_content_hash_before_reading_asset(tmp_path: Path) -> None:
    payload = fixture_payload()
    payload["items"] = [payload["items"][0]]
    asset = tmp_path / payload["items"][0]["relative_path"]
    asset.parent.mkdir(parents=True)
    asset.write_bytes(b"not the declared content")
    manifest = parse_rights_manifest(payload)

    with pytest.raises(DataIntegrityError, match="digest mismatch"):
        manifest.verify_assets(tmp_path)
