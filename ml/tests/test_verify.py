import hashlib
import json

import pytest

from cardscope_ml.rights import Operation
from cardscope_ml.verify import _assert_checkpoint_split, _assert_export_binding, _rate


torch = pytest.importorskip("torch", reason="Torch is an optional training dependency")


def _checkpoint(*, seed: int = 20260722) -> dict[str, object]:
    return {
        "manifest_fingerprint": "a" * 64,
        "split_fingerprint": "b" * 64,
        "seed": seed,
        "training_rights_operation": Operation.TRAIN_NONCOMMERCIAL_EXPERIMENT.value,
    }


def test_should_bind_a_holdout_report_to_the_checkpoint_training_split(tmp_path) -> None:
    path = tmp_path / "model.pt"
    torch.save(_checkpoint(), path)

    digest = _assert_checkpoint_split(
        path,
        manifest_fingerprint="a" * 64,
        split_fingerprint="b" * 64,
        seed=20260722,
        operation=Operation.TRAIN_NONCOMMERCIAL_EXPERIMENT,
    )

    assert digest == hashlib.sha256(path.read_bytes()).hexdigest()


def test_should_reject_a_holdout_seed_that_differs_from_training(tmp_path) -> None:
    path = tmp_path / "model.pt"
    torch.save(_checkpoint(seed=7), path)

    with pytest.raises(ValueError, match="checkpoint seed differs"):
        _assert_checkpoint_split(
            path,
            manifest_fingerprint="a" * 64,
            split_fingerprint="b" * 64,
            seed=20260722,
            operation=Operation.TRAIN_NONCOMMERCIAL_EXPERIMENT,
        )


def test_should_bind_the_onnx_runtime_model_to_the_verified_checkpoint(tmp_path) -> None:
    model = tmp_path / "model.float.onnx"
    model.write_bytes(b"onnx-bytes")
    checkpoint_sha256 = "c" * 64
    metadata = {
        "checkpoint_sha256": checkpoint_sha256,
        "manifest_fingerprint": "a" * 64,
        "training_rights_operation": Operation.TRAIN_NONCOMMERCIAL_EXPERIMENT.value,
        "runtime_model_sha256": hashlib.sha256(model.read_bytes()).hexdigest(),
        "float_onnx_sha256": hashlib.sha256(model.read_bytes()).hexdigest(),
    }
    metadata_path = tmp_path / "export-metadata.json"
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")

    digest = _assert_export_binding(
        model,
        checkpoint_sha256=checkpoint_sha256,
        manifest_fingerprint="a" * 64,
        operation=Operation.TRAIN_NONCOMMERCIAL_EXPERIMENT,
    )

    assert digest == hashlib.sha256(metadata_path.read_bytes()).hexdigest()


def test_should_reject_an_onnx_model_exported_from_another_checkpoint(tmp_path) -> None:
    model = tmp_path / "model.float.onnx"
    model.write_bytes(b"onnx-bytes")
    (tmp_path / "export-metadata.json").write_text(
        json.dumps(
            {
                "checkpoint_sha256": "wrong",
                "manifest_fingerprint": "a" * 64,
                "training_rights_operation": Operation.TRAIN_NONCOMMERCIAL_EXPERIMENT.value,
                "runtime_model_sha256": hashlib.sha256(model.read_bytes()).hexdigest(),
                "float_onnx_sha256": hashlib.sha256(model.read_bytes()).hexdigest(),
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="export checkpoint hash differs"):
        _assert_export_binding(
            model,
            checkpoint_sha256="c" * 64,
            manifest_fingerprint="a" * 64,
            operation=Operation.TRAIN_NONCOMMERCIAL_EXPERIMENT,
        )


def test_should_report_an_empty_partition_metric_as_unavailable() -> None:
    assert _rate(0, 0) is None
